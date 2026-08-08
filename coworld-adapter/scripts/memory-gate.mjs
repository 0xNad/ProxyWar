#!/usr/bin/env node
// Memory regression gate for the Coworld game image.
//
// Runs the EXACT hosted episode code path (no-docker standalone mode of
// src/no-docker-coworld-episode.ts) natively under the hosted memory posture
// (--max-old-space-size=640) on the manifest's own 12P World variant, capped
// at 80 decision steps (~8,000 turns — past the historical crash window), and
// asserts on the [MEM] stderr telemetry the episode already emits:
//
//   1. CEILING  — max observed rssMB must stay under the threshold.
//   2. SLOPE    — least-squares heapUsedMB growth per 1,000 turns, fit over
//                 the final window (see SLOPE_WINDOW_TURNS below), must
//                 stay under the threshold. heapUsedMB (sampled
//                 post-forced-GC) tracks the live JS heap, not noisy RSS;
//                 the fixed pipeline measures ~1.8-2.8 MB/1k late-window,
//                 well under the 4 MB/1k default. The full-run fit is also
//                 computed and reported for context (see below).
//   3. OUTCOME  — the episode must complete and write results.json.
//
// Certification smokes (2 steps x 25 turns) can never see turn-linear growth;
// this gate is the check that catches it BEFORE an image ships. It runs as
// the first step of `npm run build:image`.
//
// Env knobs:
//   PROXYWAR_SKIP_MEMORY_GATE=1            skip (loud) — emergencies only
//   PROXYWAR_MEMORY_GATE_VARIANT=<id>      manifest variant (default
//                                          tournament-12p-world)
//   PROXYWAR_MEMORY_GATE_STEPS=<n>         decision steps (default 80)
//   PROXYWAR_MEMORY_GATE_MAX_RSS_MB=<n>    ceiling (default 600)
//   PROXYWAR_MEMORY_GATE_MAX_SLOPE=<n>     MB per 1k turns on heapUsedMB (default 4)
//   PROXYWAR_MEMORY_GATE_TIMEOUT_MS=<n>    hard timeout (default 1,800,000)

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const adapterRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(adapterRoot, "..");

const SKIP = process.env.PROXYWAR_SKIP_MEMORY_GATE === "1";
const VARIANT_ID =
  process.env.PROXYWAR_MEMORY_GATE_VARIANT ?? "tournament-12p-world";
const STEPS = Number(process.env.PROXYWAR_MEMORY_GATE_STEPS ?? 80);
const MAX_RSS_MB = Number(process.env.PROXYWAR_MEMORY_GATE_MAX_RSS_MB ?? 600);
const MAX_SLOPE = Number(process.env.PROXYWAR_MEMORY_GATE_MAX_SLOPE ?? 4);
const TIMEOUT_MS = Number(
  process.env.PROXYWAR_MEMORY_GATE_TIMEOUT_MS ?? 1_800_000,
);
// heapUsedMB (post-forced-GC, see PROXYWAR_MEM_TELEMETRY_FORCE_GC below) is
// the gating series, not RSS: on the SAME shipped SHA, RSS slope swung
// -11..+34 MB/1k between runs (allocator/OS noise), while the post-GC
// heapUsedMB slope stayed ~1.84-2.79 MB/1k across those identical runs; RSS
// alone flipped between pass and fail, falsely asserting a leak.
// Only the FINAL window is gated, same as the original RSS design. Initial
// world/colonization setup legitimately grows the live heap for as long as
// it runs: this pipeline's own qualification run measured heapUsedMB
// climbing 37->67MB over the first 4,000 turns, then a near-flat 67->76MB
// over the last 4,400 — a full-run fit of 4.22 MB/1k (which would false-fail
// at the same threshold) vs a late-window fit of 1.90. A leak, by
// definition, is still growing at the END; the full-run fit is computed and
// reported (fullRunSlopeMBPer1k) for context but does not gate.
const SLOPE_WINDOW_TURNS = Number(
  process.env.PROXYWAR_MEMORY_GATE_SLOPE_WINDOW ?? 3_000,
);

const reportDir = path.join(adapterRoot, "artifacts", "memory-gate");
mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(
  reportDir,
  `${new Date().toISOString().replace(/[:.]/g, "-")}-report.json`,
);

function writeReport(report) {
  // Durable evidence, independent of whoever captures our stdio.
  try {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`[memory-gate] report: ${reportPath}`);
  } catch (error) {
    console.error(`[memory-gate] report write failed: ${error}`);
  }
}

function fail(reason, extra = {}) {
  writeReport({ verdict: "FAIL", reason, ...extra });
  console.error(`[memory-gate] FAIL: ${reason}`);
  process.exit(1);
}

if (SKIP) {
  console.error(
    "[memory-gate] SKIPPED via PROXYWAR_SKIP_MEMORY_GATE=1 — the image will " +
      "NOT be memory-regression-checked. Do not ship this image unless the " +
      "skip was deliberate and recorded.",
  );
  process.exit(0);
}

const manifestPath = path.join(adapterRoot, "coworld", "coworld_manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const variant = (manifest.variants ?? []).find((v) => v?.id === VARIANT_ID);
if (variant === undefined || variant.game_config === undefined) {
  fail(
    `variant "${VARIANT_ID}" with a game_config was not found in ` +
      `${manifestPath} — the gate must exercise a real shipped variant`,
  );
}

const gameConfig = structuredClone(variant.game_config);
gameConfig.max_decision_steps = STEPS;
const seatCount = Array.isArray(gameConfig.players)
  ? gameConfig.players.length
  : 0;
if (seatCount === 0) {
  fail(`variant "${VARIANT_ID}" declares no players`);
}
gameConfig.tokens = Array.from(
  { length: seatCount },
  (_, i) => `memory-gate-token-${i + 1}`,
);

const workDir = mkdtempSync(path.join(tmpdir(), "proxywar-memory-gate-"));
const configPath = path.join(workDir, "config.json");
writeFileSync(configPath, `${JSON.stringify(gameConfig, null, 2)}\n`);

const turnsPerStep = Number(gameConfig.turns_per_decision_step ?? 100);
// Baseline env the manifest declares for the real hosted container
// (game.runnable.env in coworld_manifest.json, e.g.
// PROXYWAR_TUNE_STRUCTURED_DEALS) -- the gate spawns the episode script
// directly, bypassing the image/host that would otherwise apply this, so
// without it the gate silently never exercises whatever runtime behavior
// that env activates. process.env below still takes precedence, so an
// explicit override in the invoking shell is always possible.
const runnableEnv = manifest.game?.runnable?.env ?? {};
console.error(
  `[memory-gate] manifest game.runnable.env baseline: ${JSON.stringify(runnableEnv)}`,
);
console.error(
  `[memory-gate] variant=${VARIANT_ID} map=${gameConfig.map}/${gameConfig.map_size} ` +
    `seats=${seatCount} steps=${STEPS} (~${STEPS * turnsPerStep} turns) ` +
    `ceiling=${MAX_RSS_MB}MB slope<=${MAX_SLOPE}MB/1k`,
);

const child = spawn(
  process.execPath,
  [
    "--max-old-space-size=640",
    // --expose-gc + PROXYWAR_MEM_TELEMETRY_FORCE_GC: every [MEM] sample is
    // taken after a full collection, so the slope fit measures the live set.
    // Raw (sawtooth) sampling made the fit flip between 2.1 and 13.4 MB/1k
    // on identical code depending on where GC landed in the run.
    "--expose-gc",
    "--import",
    "tsx/esm",
    path.join(adapterRoot, "src", "no-docker-coworld-episode.ts"),
  ],
  {
    cwd: repoRoot,
    env: {
      ...runnableEnv,
      ...process.env,
      GAME_ENV: "dev",
      PROXYWAR_REPO: repoRoot,
      COGAME_CONFIG_URI: pathToFileURL(configPath).href,
      COGAME_HOST: "127.0.0.1",
      COGAME_PORT: process.env.PROXYWAR_MEMORY_GATE_PORT ?? "18923",
      // Per-decision-step [MEM] cadence (~one sample per 100 turns) — the
      // slope fit needs a dense curve, not the sparse hosted default.
      PROXYWAR_MEM_TELEMETRY_EVERY: "1",
      PROXYWAR_MEM_TELEMETRY_FORCE_GC: "1",
      // The app-shell/replay route checks need a built client bundle; this
      // gate measures episode memory, and certify covers the full container
      // contract (including the built client) on the actual image.
      PROXYWAR_SKIP_ROUTE_CHECKS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderrTail = [];
const memSamples = []; // {turn, rssMB, heapUsedMB}
let maxRss = 0;
let maxRssTurn = 0;

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (line.length === 0) {
      continue;
    }
    stderrTail.push(line);
    if (stderrTail.length > 200) {
      stderrTail = stderrTail.slice(-100);
    }
    const m = line.match(/\[MEM\] \S+ turn=(\d+) rssMB=(\d+) heapUsedMB=(\d+)/);
    if (m !== null) {
      const turn = Number(m[1]);
      const rssMB = Number(m[2]);
      const heapUsedMB = Number(m[3]);
      memSamples.push({ turn, rssMB, heapUsedMB });
      if (rssMB > maxRss) {
        maxRss = rssMB;
        maxRssTurn = turn;
      }
    }
  }
});

const timeout = setTimeout(() => {
  console.error(
    `[memory-gate] timed out after ${TIMEOUT_MS}ms — killing episode`,
  );
  child.kill("SIGKILL");
}, TIMEOUT_MS);

child.on("close", (code) => {
  clearTimeout(timeout);

  if (code !== 0) {
    console.error(stderrTail.slice(-40).join("\n"));
    fail(
      `episode process exited ${code} — a crash under the hosted memory ` +
        `posture is exactly what this gate exists to catch`,
    );
  }

  // The completion proof is the last pretty-printed JSON object on stdout;
  // other log lines may contain braces, so parse candidate objects from the
  // last line-leading "{" backwards instead of trusting one greedy regex.
  let proof = null;
  const lines = stdout.split("\n");
  for (let start = lines.length - 1; start >= 0; start--) {
    if (lines[start] !== "{") {
      continue;
    }
    for (let end = start; end < lines.length; end++) {
      if (lines[end] !== "}") {
        continue;
      }
      try {
        const candidate = JSON.parse(lines.slice(start, end + 1).join("\n"));
        if (candidate?.ok === true && candidate?.resultsPath !== undefined) {
          proof = candidate;
        }
      } catch {
        // keep scanning
      }
      break;
    }
    if (proof !== null) {
      break;
    }
  }
  if (proof === null) {
    console.error(stderrTail.slice(-40).join("\n"));
    fail("episode did not print its ok:true completion proof");
  }
  let results;
  try {
    results = JSON.parse(readFileSync(proof.resultsPath, "utf8"));
  } catch {
    fail(`results.json missing or unreadable at ${proof.resultsPath}`);
  }

  if (memSamples.length < 5) {
    fail(
      `only ${memSamples.length} [MEM] samples captured — telemetry is the ` +
        `gate's evidence and must be present`,
    );
  }

  // Least-squares slope in MB per 1k turns over a sample window, for a
  // given [MEM] field.
  const fitSlope = (samples, valueOf) => {
    if (samples.length < 3) {
      return 0;
    }
    const n = samples.length;
    const meanTurn = samples.reduce((a, s) => a + s.turn, 0) / n;
    const meanValue = samples.reduce((a, s) => a + valueOf(s), 0) / n;
    let num = 0;
    let den = 0;
    for (const s of samples) {
      num += (s.turn - meanTurn) * (valueOf(s) - meanValue);
      den += (s.turn - meanTurn) * (s.turn - meanTurn);
    }
    return den === 0 ? 0 : (num / den) * 1000;
  };
  const lastTurn = memSamples[memSamples.length - 1].turn;
  const lateWindowSamples = memSamples.filter(
    (s) => s.turn >= lastTurn - SLOPE_WINDOW_TURNS,
  );
  // Gated: the late-window post-forced-GC heapUsedMB fit (see the
  // SLOPE_WINDOW_TURNS comment above for why the full run and RSS aren't
  // used for gating).
  const slope = fitSlope(lateWindowSamples, (s) => s.heapUsedMB);
  // Context only, not gated — reported so early-game heap growth and RSS
  // behavior both stay visible in the evidence.
  const fullRunSlope = fitSlope(memSamples, (s) => s.heapUsedMB);
  const rssSlope = fitSlope(lateWindowSamples, (s) => s.rssMB);
  const rssFullRunSlope = fitSlope(memSamples, (s) => s.rssMB);

  const turnCount = results?.turn_count ?? "?";
  console.error(
    `[memory-gate] episode complete: turns=${turnCount} samples=${memSamples.length} ` +
      `maxRss=${maxRss}MB@turn=${maxRssTurn} heapUsed lateSlope=${slope.toFixed(2)}MB/1k ` +
      `(gated; full-run ${fullRunSlope.toFixed(2)}, context) rss lateSlope=${rssSlope.toFixed(2)}MB/1k ` +
      `(full-run ${rssFullRunSlope.toFixed(2)}, context)`,
  );

  const evidence = {
    variant: VARIANT_ID,
    steps: STEPS,
    turnCount,
    samples: memSamples,
    maxRssMB: maxRss,
    maxRssTurn,
    slopeMetric: "heapUsedMB",
    slopeMBPer1k: Number(slope.toFixed(3)),
    slopeWindowTurns: SLOPE_WINDOW_TURNS,
    fullRunSlopeMBPer1k: Number(fullRunSlope.toFixed(3)),
    rssSlopeMBPer1k: Number(rssSlope.toFixed(3)),
    rssFullRunSlopeMBPer1k: Number(rssFullRunSlope.toFixed(3)),
    ceilingMB: MAX_RSS_MB,
    maxSlopeMBPer1k: MAX_SLOPE,
  };
  if (maxRss > MAX_RSS_MB) {
    fail(
      `max RSS ${maxRss}MB at turn ${maxRssTurn} exceeds the ${MAX_RSS_MB}MB ` +
        `ceiling`,
      evidence,
    );
  }
  if (slope > MAX_SLOPE) {
    fail(
      `heapUsedMB late-window slope ${slope.toFixed(2)}MB/1k turns exceeds ` +
        `${MAX_SLOPE}MB/1k — turn-linear retention is back; find the new ` +
        `per-turn allocation before shipping`,
      evidence,
    );
  }
  writeReport({ verdict: "PASS", ...evidence });
  console.error("[memory-gate] PASS");
  process.exit(0);
});
