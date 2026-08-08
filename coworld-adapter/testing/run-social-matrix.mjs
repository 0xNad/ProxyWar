#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SOCIAL_MATRIX_ARMS,
  SOCIAL_MATRIX_PROFILES,
  aggregateSocialMatrix,
  parseJsonLines,
  sha256,
  socialPlayerName,
  summarizeSocialRun,
} from "./social-matrix-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const PLAYER_FILE = path.join(SCRIPT_DIR, "social-control-player.mjs");
const GAME_FILE = path.join(
  REPO_ROOT,
  "coworld-adapter",
  "src",
  "no-docker-coworld-episode.ts",
);

export async function runSocialMatrix(options = {}) {
  const seeds =
    options.seeds ??
    integerList("PROXYWAR_SOCIAL_MATRIX_SEEDS", [173205, 223607, 424242]);
  const maps =
    options.maps ??
    stringList("PROXYWAR_SOCIAL_MATRIX_MAPS", ["Pangaea", "Europe"]);
  const episodeIndices =
    options.episodeIndices ??
    integerList("PROXYWAR_SOCIAL_MATRIX_EPISODES", [0, 1, 2, 3]);
  const arms =
    options.arms ??
    stringList("PROXYWAR_SOCIAL_MATRIX_ARMS", [...SOCIAL_MATRIX_ARMS]);
  const maxDecisionSteps =
    options.maxDecisionSteps ??
    integerValue("PROXYWAR_SOCIAL_MATRIX_STEPS", 30, 1);
  const turnsPerDecisionStep =
    options.turnsPerDecisionStep ??
    integerValue("PROXYWAR_SOCIAL_MATRIX_TURNS", 25, 1);
  const outputRoot = path.resolve(
    options.outputRoot ??
      process.env.PROXYWAR_SOCIAL_MATRIX_OUTPUT ??
      path.join(
        REPO_ROOT,
        "coworld-adapter",
        "artifacts",
        "social-matrix",
        timestamp(),
      ),
  );

  validateMatrixInputs({ seeds, maps, episodeIndices, arms });
  await fs.mkdir(outputRoot, { recursive: true });
  const plan = [];
  for (const seed of seeds) {
    for (const map of maps) {
      for (const episodeIndex of episodeIndices) {
        for (const arm of arms) {
          plan.push({ seed, map, episodeIndex, arm });
        }
      }
    }
  }
  await fs.writeFile(
    path.join(outputRoot, "matrix-plan.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        seeds,
        maps,
        episodeIndices,
        arms,
        maxDecisionSteps,
        turnsPerDecisionStep,
        runCount: plan.length,
      },
      null,
      2,
    )}\n`,
  );

  const runs = [];
  for (let index = 0; index < plan.length; index += 1) {
    const cell = plan[index];
    const runDir = path.join(
      outputRoot,
      `seed-${cell.seed}`,
      slug(cell.map),
      `episode-${cell.episodeIndex}`,
      cell.arm,
    );
    const cached = await readJsonIfPresent(
      path.join(runDir, "run-summary.json"),
    );
    if (cached !== null) {
      runs.push(cached);
      console.log(
        `[social-matrix ${index + 1}/${plan.length}] cached ${cellLabel(cell)}`,
      );
      continue;
    }
    console.log(
      `[social-matrix ${index + 1}/${plan.length}] start ${cellLabel(cell)}`,
    );
    const run = await runSocialCell({
      ...cell,
      runDir,
      maxDecisionSteps,
      turnsPerDecisionStep,
    });
    runs.push(run);
    console.log(
      `[social-matrix ${index + 1}/${plan.length}] done ${cellLabel(cell)} game=${run.gameID} decisions=${run.decisionCount}`,
    );
    await writeMatrixReports(outputRoot, runs, plan.length);
  }
  const aggregate = await writeMatrixReports(outputRoot, runs, plan.length);
  console.log(
    JSON.stringify(
      {
        ok: true,
        outputRoot,
        runCount: aggregate.runCount,
        nonInterference: aggregate.nonInterference,
        byProfile: aggregate.byProfile,
      },
      null,
      2,
    ),
  );
  return { outputRoot, runs, aggregate };
}

async function runSocialCell(input) {
  await fs.mkdir(input.runDir, { recursive: true });
  const configPath = path.join(input.runDir, "config.json");
  const resultsPath = path.join(input.runDir, "results.json");
  const replayPath = path.join(input.runDir, "replay.json");
  const tokens = SOCIAL_MATRIX_PROFILES.map(
    (profile, slot) =>
      `social-${profile}-${input.seed}-${input.episodeIndex}-${slot}`,
  );
  const config = {
    tokens,
    players: SOCIAL_MATRIX_PROFILES.map((profile) => ({
      name: socialPlayerName(profile),
    })),
    max_decision_steps: input.maxDecisionSteps,
    turns_per_decision_step: input.turnsPerDecisionStep,
    max_decision_ms: 15_000,
    map: input.map,
    map_size: "Compact",
    difficulty: "Easy",
    seed: input.seed,
    episodeIndex: input.episodeIndex,
    replay_tail_turns: 0,
    player_connect_timeout_seconds: 30,
  };
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(configPath, configText);

  const port = await reservePort();
  const baseEnv = {
    ...process.env,
    PROXYWAR_REPO: REPO_ROOT,
    GAME_ENV: process.env.GAME_ENV ?? "dev",
    // Plain absolute paths deliberately avoid URL-percent-encoding workspace
    // spaces; the Coworld contract accepts both paths and URIs.
    COGAME_CONFIG_URI: configPath,
    COGAME_RESULTS_URI: resultsPath,
    COGAME_SAVE_REPLAY_URI: replayPath,
    COGAME_HOST: "127.0.0.1",
    COGAME_PORT: String(port),
    PROXYWAR_SKIP_ROUTE_CHECKS: "1",
    COWORLD_POSTGAME_SERVER_MS: "0",
  };
  if (input.arm === "off") {
    delete baseEnv.PROXYWAR_TUNE_STRUCTURED_DEALS;
  } else {
    baseEnv.PROXYWAR_TUNE_STRUCTURED_DEALS = "1";
  }

  const children = [];
  const game = capturedSpawn(
    process.execPath,
    ["--import", "tsx/esm", GAME_FILE],
    { cwd: REPO_ROOT, env: baseEnv, label: "game" },
  );
  children.push(game);
  try {
    await waitForHealth(port, game, 30_000);
    for (let slot = 0; slot < SOCIAL_MATRIX_PROFILES.length; slot += 1) {
      const profile = SOCIAL_MATRIX_PROFILES[slot];
      const player = capturedSpawn(
        process.execPath,
        [PLAYER_FILE, profile, input.arm],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            PROXYWAR_REPO: REPO_ROOT,
            COWORLD_PLAYER_WS_URL: `ws://127.0.0.1:${port}/player?slot=${slot}&token=${encodeURIComponent(tokens[slot])}`,
          },
          label: `player-${slot}-${profile}`,
        },
      );
      children.push(player);
    }
    await withTimeout(
      Promise.all(children.map((child) => child.done)),
      5 * 60_000,
      `timed out ${cellLabel(input)}`,
    );
    const failed = children.find((child) => child.exitCode !== 0);
    if (failed !== undefined) {
      throw new Error(`${failed.label} exited ${failed.exitCode}`);
    }
  } catch (error) {
    for (const child of children) child.kill();
    await writeChildLogs(input.runDir, children);
    throw error;
  }
  await writeChildLogs(input.runDir, children);

  const [resultsText, replayText] = await Promise.all([
    fs.readFile(resultsPath, "utf8"),
    fs.readFile(replayPath, "utf8"),
  ]);
  const results = JSON.parse(resultsText);
  const replay = JSON.parse(replayText);
  if (results.seed !== input.seed || replay.results?.seed !== input.seed) {
    throw new Error(`seed provenance mismatch for ${cellLabel(input)}`);
  }
  if (
    results.game_id !== replay.matchID ||
    results.game_id !== replay.results?.game_id
  ) {
    throw new Error(`game identity mismatch for ${cellLabel(input)}`);
  }
  const artifactPaths = replay.proxyWarArtifacts ?? {};
  const decisionsText = await fs.readFile(artifactPaths.decisionsPath, "utf8");
  const telemetryText = await fs.readFile(
    artifactPaths.spectatorTelemetryPath,
    "utf8",
  );
  const ledgerText =
    typeof artifactPaths.dealLedgerPath === "string"
      ? await fs.readFile(artifactPaths.dealLedgerPath, "utf8")
      : null;
  const summary = summarizeSocialRun({
    arm: input.arm,
    seed: input.seed,
    map: input.map,
    episodeIndex: input.episodeIndex,
    decisions: parseJsonLines(decisionsText),
    results,
    ledger: ledgerText === null ? null : JSON.parse(ledgerText),
  });
  const withEvidence = {
    ...summary,
    maxDecisionSteps: input.maxDecisionSteps,
    turnsPerDecisionStep: input.turnsPerDecisionStep,
    artifactPaths: {
      runDirectory: artifactPaths.directory,
      decisions: artifactPaths.decisionsPath,
      telemetry: artifactPaths.spectatorTelemetryPath,
      dealLedger: artifactPaths.dealLedgerPath ?? null,
      results: resultsPath,
      replay: replayPath,
      config: configPath,
    },
    sha256: {
      config: sha256(configText),
      results: sha256(resultsText),
      replay: sha256(replayText),
      decisions: sha256(decisionsText),
      telemetry: sha256(telemetryText),
      dealLedger: ledgerText === null ? null : sha256(ledgerText),
    },
  };
  await fs.writeFile(
    path.join(input.runDir, "run-summary.json"),
    `${JSON.stringify(withEvidence, null, 2)}\n`,
  );
  return withEvidence;
}

async function writeMatrixReports(outputRoot, runs, plannedRunCount) {
  const aggregate = aggregateSocialMatrix(runs);
  const report = {
    ...aggregate,
    generatedAt: new Date().toISOString(),
    plannedRunCount,
    complete: runs.length === plannedRunCount,
    runs,
  };
  await fs.writeFile(
    path.join(outputRoot, "matrix-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(outputRoot, "matrix-report.md"),
    matrixMarkdown(report),
  );
  return aggregate;
}

function matrixMarkdown(report) {
  const lines = [
    "# ProxyWar social measurement matrix",
    "",
    `Generated: ${report.generatedAt}`,
    `Runs: ${report.runCount}/${report.plannedRunCount}`,
    `Seeds: ${report.seeds.join(", ")}`,
    `Maps: ${report.maps.join(", ")}`,
    `Episode/spawn rotations: ${report.episodeIndices.join(", ")}`,
    `Arms: ${report.arms.join(", ")}`,
    "",
    "## Non-interference control",
    "",
    `OFF vs ignored identical matched cells: ${report.nonInterference.identicalCells}/${report.nonInterference.completeCells}; pass=${report.nonInterference.passed}.`,
    "",
    "## Active-arm commitment evidence",
    "",
    "| Profile | Active runs | Proposals selected / windows | Responses selected / windows | Deal slot requested / valid / applied | Fulfilled | Violated | Expired unfulfilled | Moot | Unverified | Verified reliability | Fallbacks |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const profile of SOCIAL_MATRIX_PROFILES) {
    const value = report.byProfile[profile];
    const responses =
      value.dealSelections.deal_accept + value.dealSelections.deal_reject;
    const responseWindows = Math.max(
      value.dealOpportunityWindows.deal_accept,
      value.dealOpportunityWindows.deal_reject,
    );
    lines.push(
      `| ${profile} | ${value.activeRuns} | ${value.dealSelections.deal_propose}/${value.dealOpportunityWindows.deal_propose} | ${responses}/${responseWindows} | ${value.dealSlotEvidence.requested}/${value.dealSlotEvidence.validationAccepted}/${value.dealSlotEvidence.applicationAccepted} | ${value.obligations.fulfilled} | ${value.obligations.violated} | ${value.obligations.expired_unfulfilled} | ${value.obligations.moot} | ${value.obligations.unverified} | ${formatRate(value.commitmentReliability)} | ${value.fallbackDecisions} |`,
    );
  }
  lines.push(
    "",
    "Reliability is fulfilled / (fulfilled + violated + expired_unfulfilled). Moot and unverified obligations are reported but excluded. A profile with no verified terminal obligations has no reliability estimate; abstention is not perfect trustworthiness.",
    "",
    "Accepted deal counterparties:",
    "",
    ...SOCIAL_MATRIX_PROFILES.map((profile) => {
      const entries = Object.entries(
        report.byProfile[profile].acceptedDealsWith,
      ).sort(([left], [right]) => left.localeCompare(right));
      const counterparties =
        entries.length === 0
          ? "none"
          : entries.map(([name, count]) => `${name}=${count}`).join(", ");
      return `- ${profile}: ${counterparties}`;
    }),
    "",
    "## Construct gate",
    "",
    `Status: ${report.commitmentConstruct.status}; pass=${report.commitmentConstruct.passed}.`,
    `Complete matrix=${report.commitmentConstruct.completeMatrix}; healthy decisions=${report.commitmentConstruct.healthyRuns}; seed/game provenance=${report.commitmentConstruct.provenanceComplete}; non-interference=${report.commitmentConstruct.nonInterferencePass}; abstention not rewarded=${report.commitmentConstruct.abstentionNotRewarded}.`,
    "",
  );
  for (const profile of ["keeper", "defector"]) {
    const value = report.commitmentConstruct.policies[profile];
    lines.push(
      `- ${profile}: held-out reliability ${formatRate(value.heldOut.commitmentReliability)}, verified-cell coverage ${formatRate(value.heldOut.verifiedCoverageRate)}, reliability pass=${value.reliabilityPass}, coverage pass=${value.coveragePass}, both maps pass=${value.mapBalancePass}, all spawn rotations pass=${value.spawnRotationPass}.`,
    );
  }
  lines.push("", report.commitmentConstruct.claimBoundary, "");
  return `${lines.join("\n")}\n`;
}

function capturedSpawn(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = appendBounded(stdout, String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, String(chunk));
  });
  const wrapped = {
    label: options.label,
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exitCode: null,
    kill: () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
  wrapped.done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      wrapped.exitCode = code ?? (signal === null ? 0 : 1);
      resolve();
    });
  });
  return wrapped;
}

async function writeChildLogs(directory, children) {
  await Promise.all(
    children.map((child) =>
      fs.writeFile(
        path.join(directory, `${child.label}.log`),
        `stdout:\n${child.stdout()}\n\nstderr:\n${child.stderr()}\n`,
      ),
    ),
  );
}

async function waitForHealth(port, game, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (game.exitCode !== null) {
      throw new Error(`game exited ${game.exitCode} before health check`);
    }
    if (await httpOk(`http://127.0.0.1:${port}/healthz`)) return;
    await delay(100);
  }
  throw new Error(`game did not become healthy on port ${port}`);
}

function httpOk(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(500, () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error("failed to reserve port"));
        else resolve(port);
      });
    });
  });
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref();
    }),
  ]);
}

function appendBounded(current, chunk) {
  const combined = current + chunk;
  return combined.length <= 2_000_000
    ? combined
    : combined.slice(combined.length - 2_000_000);
}

function integerValue(name, fallback, minimum) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function integerList(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.split(",").map((part) => {
    const value = Number(part.trim());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must contain non-negative safe integers`);
    }
    return value;
  });
}

function stringList(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === ""
    ? fallback
    : raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
}

function validateMatrixInputs(input) {
  if (
    input.seeds.length === 0 ||
    input.maps.length === 0 ||
    input.episodeIndices.length === 0 ||
    input.arms.length === 0
  ) {
    throw new Error("social matrix axes must be non-empty");
  }
  for (const arm of input.arms) {
    if (!SOCIAL_MATRIX_ARMS.includes(arm)) {
      throw new Error(`unknown social arm: ${arm}`);
    }
  }
}

function readJsonIfPresent(file) {
  return fs
    .readFile(file, "utf8")
    .then((value) => JSON.parse(value))
    .catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
}

function cellLabel(cell) {
  return `seed=${cell.seed} map=${cell.map} episode=${cell.episodeIndex} arm=${cell.arm}`;
}

function formatRate(value) {
  return value === null ? "n/a" : value.toFixed(3);
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await runSocialMatrix();
}
