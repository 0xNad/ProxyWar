#!/usr/bin/env node
/**
 * Agent-strength A/B sweep driver (deterministic, same-seed controlled experiment).
 *
 * Runs the deterministic `--brain=planner` (mock-policy-planner) frontier benchmark
 * over a matrix of difficulty cells x run indices for a single named config (a set of
 * `PROXYWAR_TUNE_*` env overrides). The realtimeClock determinism fix means every run
 * is byte-identical per (config, index, difficulty, nations, bots) seed, so comparing
 * a DEFAULT config vs a CANDIDATE config on the same indices is a controlled A/B.
 *
 * Metrics collected per run from frontier-summary.json + run-N.records.json:
 *   won, survived, termination, winner, profile, turns (survival), tileShare (final),
 *   peakTiles, finalTiles, retention (final/peak), buildCount, hostileAttackCount,
 *   neutralExpansionAttackCount, attackSafetyHoldCount.
 *
 * Usage:
 *   node src/scripts/agent-strength-sweep.mjs \
 *     --config-name=baseline \
 *     --cells=hard,easy \
 *     --start-index=1 --runs=6 \
 *     --concurrency=4 \
 *     [--tune KEY=VAL ...] \
 *     [--out=artifacts/strength-sweep/baseline.json]
 *
 * Cells: hard => --nations=5 --bots=0 --difficulty=Hard
 *        easy => --nations=5 --bots=5 --difficulty=Easy
 * Profile cycles through all 4 by run index (matches benchmark --profile=all).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BENCH = "src/scripts/ai-agent-frontier-benchmark.ts";
const MAX_DECISION_MS = 600_000;

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function tunesFromArgs() {
  const tunes = {};
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--tune" && argv[i + 1]) {
      const [k, v] = argv[i + 1].split("=");
      tunes[k] = v;
      i += 1;
    }
  }
  return tunes;
}

const CELLS = {
  hard: { nations: 5, bots: 0, difficulty: "Hard" },
  easy: { nations: 5, bots: 5, difficulty: "Easy" },
  medium: { nations: 5, bots: 5, difficulty: "Medium" },
};

const configName = arg("config-name", "config");
const cells = arg("cells", "hard,easy")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
const startIndex = Number(arg("start-index", "1"));
const runs = Number(arg("runs", "6"));
const concurrency = Number(arg("concurrency", "4"));
const tunes = tunesFromArgs();
const outPath = arg(
  "out",
  `artifacts/strength-sweep/${configName}.json`,
);

const PROFILES = ["aggressive", "defensive", "diplomatic", "opportunistic"];

function runIDFor(cell, index) {
  return `sweep-${configName}-${cell}-i${index}`;
}

function summaryPath(runID) {
  return path.join(
    ROOT,
    "artifacts/ai-league-benchmarks",
    runID,
    "frontier-summary.json",
  );
}
function recordsPath(runID, index) {
  return path.join(
    ROOT,
    "artifacts/ai-league-benchmarks",
    runID,
    `run-${index}.records.json`,
  );
}

function extractTilesFromSummary(text) {
  // observationSummary carries "own=NNNN tiles"
  const m = text.match(/own=(\d+)\s+tiles/);
  return m ? Number(m[1]) : null;
}

function peakAndFinalTiles(runID, index) {
  const f = recordsPath(runID, index);
  if (!fs.existsSync(f)) return { peakTiles: null, finalTiles: null };
  let recs;
  try {
    recs = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return { peakTiles: null, finalTiles: null };
  }
  let peak = 0;
  let last = 0;
  for (const r of recs) {
    const s =
      typeof r.observationSummary === "string"
        ? r.observationSummary
        : JSON.stringify(r.observationSummary ?? "");
    const t = extractTilesFromSummary(s);
    if (t !== null) {
      if (t > peak) peak = t;
      last = t;
    }
  }
  return { peakTiles: peak || null, finalTiles: last || null };
}

function runOne(cell, index) {
  return new Promise((resolve) => {
    const c = CELLS[cell];
    if (!c) {
      resolve({ cell, index, error: `unknown cell ${cell}` });
      return;
    }
    const runID = runIDFor(cell, index);
    const env = { ...process.env };
    for (const [k, v] of Object.entries(tunes)) {
      env[`PROXYWAR_TUNE_${k}`] = v;
    }
    const profile = PROFILES[(index - 1) % PROFILES.length];
    const args = [
      BENCH,
      "--brain=planner",
      "--runs=1",
      `--start-index=${index}`,
      `--nations=${c.nations}`,
      `--bots=${c.bots}`,
      `--difficulty=${c.difficulty}`,
      `--profile=${profile}`,
      `--max-decision-ms=${MAX_DECISION_MS}`,
      `--run-id=${runID}`,
    ];
    const child = spawn("npx", ["tsx", ...args], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        resolve({ cell, index, profile, error: `exit ${code}` });
        return;
      }
      try {
        const summary = JSON.parse(
          fs.readFileSync(summaryPath(runID), "utf8"),
        ).runs[0];
        const { peakTiles, finalTiles } = peakAndFinalTiles(runID, index);
        const retention =
          peakTiles && finalTiles ? finalTiles / peakTiles : null;
        resolve({
          cell,
          index,
          profile: summary.profile,
          won: summary.won,
          survived: summary.survived,
          termination: summary.termination,
          winner: summary.winner,
          turns: summary.turns,
          tileShare: summary.tileShare,
          peakTiles,
          finalTiles,
          retention,
          buildCount: summary.actionCounts?.build ?? 0,
          hostileAttackCount: summary.hostileAttackCount ?? 0,
          neutralExpansionAttackCount:
            summary.neutralExpansionAttackCount ?? 0,
          attackSafetyHoldCount: summary.attackSafetyHoldCount ?? 0,
        });
      } catch (e) {
        resolve({ cell, index, error: String(e) });
      }
    });
  });
}

async function main() {
  fs.mkdirSync(path.dirname(path.join(ROOT, outPath)), { recursive: true });
  const jobs = [];
  for (const cell of cells) {
    for (let i = startIndex; i < startIndex + runs; i += 1) {
      jobs.push({ cell, index: i });
    }
  }
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const j = jobs[cursor];
      cursor += 1;
      const t0 = Date.now();
      const r = await runOne(j.cell, j.index);
      r.wallMs = Date.now() - t0;
      results.push(r);
      const tag = r.error
        ? `ERROR ${r.error}`
        : `${r.won ? "WIN " : "loss"} ts=${(r.tileShare ?? 0).toFixed(3)} ret=${
            r.retention === null ? "n/a" : r.retention.toFixed(2)
          } peak=${r.peakTiles} fin=${r.finalTiles} blds=${r.buildCount} turns=${r.turns}`;
      process.stderr.write(
        `[${results.length}/${jobs.length}] ${j.cell} i${j.index} ${r.profile ?? ""} ${tag}\n`,
      );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, worker),
  );

  results.sort((a, b) =>
    a.cell === b.cell ? a.index - b.index : a.cell.localeCompare(b.cell),
  );

  const byCell = {};
  for (const cell of cells) {
    const cr = results.filter((r) => r.cell === cell && !r.error);
    const wins = cr.filter((r) => r.won).length;
    const avgTileShare = cr.length
      ? cr.reduce((s, r) => s + (r.tileShare ?? 0), 0) / cr.length
      : 0;
    const avgRetention = (() => {
      const v = cr.filter((r) => r.retention !== null);
      return v.length
        ? v.reduce((s, r) => s + r.retention, 0) / v.length
        : null;
    })();
    const avgTurns = cr.length
      ? cr.reduce((s, r) => s + (r.turns ?? 0), 0) / cr.length
      : 0;
    const avgBuilds = cr.length
      ? cr.reduce((s, r) => s + (r.buildCount ?? 0), 0) / cr.length
      : 0;
    const avgPeak = cr.length
      ? cr.reduce((s, r) => s + (r.peakTiles ?? 0), 0) / cr.length
      : 0;
    byCell[cell] = {
      runs: cr.length,
      wins,
      winRate: cr.length ? wins / cr.length : 0,
      avgTileShare,
      avgRetention,
      avgTurns,
      avgBuilds,
      avgPeakTiles: avgPeak,
    };
  }

  const payload = {
    configName,
    tunes,
    startIndex,
    runs,
    cells,
    byCell,
    results,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(ROOT, outPath),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  process.stderr.write(`\nWrote ${outPath}\n`);
  for (const cell of cells) {
    const b = byCell[cell];
    process.stderr.write(
      `${cell}: winRate=${(b.winRate * 100).toFixed(0)}% (${b.wins}/${b.runs}) avgTileShare=${b.avgTileShare.toFixed(3)} avgRetention=${b.avgRetention === null ? "n/a" : b.avgRetention.toFixed(2)} avgBuilds=${b.avgBuilds.toFixed(1)} avgPeak=${Math.round(b.avgPeakTiles)} avgTurns=${Math.round(b.avgTurns)}\n`,
    );
  }
}

main().catch((e) => {
  process.stderr.write(`sweep failed: ${e}\n`);
  process.exit(1);
});
