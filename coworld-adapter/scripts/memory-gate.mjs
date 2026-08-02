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
//   2. SLOPE    — least-squares RSS growth per 1,000 turns (turns >= warmup)
//                 must stay under the threshold. The 2026-07 World 12P OOM
//                 class grew +8.6 MB/1k turns; the fixed pipeline measures
//                 well under 2.
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
//   PROXYWAR_MEMORY_GATE_MAX_SLOPE=<n>     MB per 1k turns (default 4)
//   PROXYWAR_MEMORY_GATE_TIMEOUT_MS=<n>    hard timeout (default 1,800,000)

import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
// The asserted slope fits ONLY the final window of the episode. Territorial
// expansion legitimately grows the live set for as long as it runs, and how
// long it runs scales with the map (World saturates ~turn 5k; Britannia's
// islands push past 6k) — a full-run fit flags big maps for being big. A
// leak, by definition, is still growing at the END; the 2026-07 leak class
// (+8.6 MB/1k) fails a late-window fit just as loudly. Qualification data,
// all maps, forced-GC series: late-3k slopes -9.9..+3.4 for healthy runs.
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

const manifestPath = path.join(
  adapterRoot,
  "coworld",
  "coworld_manifest.json",
);
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
const memSamples = []; // {turn, rssMB}
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
    const m = line.match(
      /\[MEM\] \S+ turn=(\d+) rssMB=(\d+) heapUsedMB=(\d+)/,
    );
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

  // Least-squares slope in MB per 1k turns over a sample window.
  const fitSlope = (samples) => {
    if (samples.length < 3) {
      return 0;
    }
    const n = samples.length;
    const meanTurn = samples.reduce((a, s) => a + s.turn, 0) / n;
    const meanRss = samples.reduce((a, s) => a + s.rssMB, 0) / n;
    let num = 0;
    let den = 0;
    for (const s of samples) {
      num += (s.turn - meanTurn) * (s.rssMB - meanRss);
      den += (s.turn - meanTurn) * (s.turn - meanTurn);
    }
    return den === 0 ? 0 : (num / den) * 1000;
  };
  const lastTurn = memSamples[memSamples.length - 1].turn;
  // Asserted: post-GC heapUsed over the FINAL window. With FORCE_GC each
  // sample is the true live set; RSS additionally swings +-40 MB with the
  // game's war-economy cycles even when nothing is retained (committed-page
  // noise), so an RSS window fit is phase-sensitive — one run fit +17.6
  // MB/1k on a bounded 292-376 oscillation with a 378 peak. Heap does not
  // oscillate like that: a positive late heap slope is retention. The RSS
  // ceiling above stays as the absolute guard.
  const lateWindow = memSamples.filter(
    (s) => s.turn >= lastTurn - SLOPE_WINDOW_TURNS,
  );
  const slope = fitSlope(
    lateWindow.map((s) => ({ turn: s.turn, rssMB: s.heapUsedMB })),
  );
  const lateRssSlope = fitSlope(lateWindow);
  const fullRunSlope = fitSlope(memSamples);

  const turnCount = results?.turn_count ?? "?";
  console.error(
    `[memory-gate] episode complete: turns=${turnCount} samples=${memSamples.length} ` +
      `maxRss=${maxRss}MB@turn=${maxRssTurn} lateHeapSlope=${slope.toFixed(2)}MB/1k ` +
      `(lateRss ${lateRssSlope.toFixed(2)}, full-run ${fullRunSlope.toFixed(2)})`,
  );

  const evidence = {
    variant: VARIANT_ID,
    steps: STEPS,
    turnCount,
    samples: memSamples,
    maxRssMB: maxRss,
    maxRssTurn,
    slopeMBPer1k: Number(slope.toFixed(3)),
    slopeMetric: "heapUsedMB",
    lateRssSlopeMBPer1k: Number(lateRssSlope.toFixed(3)),
    slopeWindowTurns: SLOPE_WINDOW_TURNS,
    fullRunSlopeMBPer1k: Number(fullRunSlope.toFixed(3)),
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
      `post-GC heap slope ${slope.toFixed(2)}MB/1k turns exceeds ${MAX_SLOPE}MB/1k — ` +
        `turn-linear retention is back; find the new per-turn allocation ` +
        `before shipping`,
      evidence,
    );
  }
  writeReport({ verdict: "PASS", ...evidence });
  console.error("[memory-gate] PASS");
  process.exit(0);
});
