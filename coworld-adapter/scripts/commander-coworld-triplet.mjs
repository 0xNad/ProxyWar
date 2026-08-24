#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COWORLD_VERSION = "0.1.42";
const VARIANT_ID = "tournament-4p-pangaea";
const MAX_DECISION_MS = 25_000;
const SAFE_ID = /^[A-Za-z0-9._/-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARM_NAMES = ["A", "B", "C"];

export function buildRequests(input) {
  const { coworldID, policies, opponentPolicy, seeds, subjectSeats, runID } =
    input;
  assertUUID(coworldID, "coworld-id", "cow_");
  for (const arm of ARM_NAMES)
    assertUUID(policies[arm], `policy-${arm.toLowerCase()}`);
  assertUUID(opponentPolicy, "opponent-policy");
  if (!SAFE_ID.test(runID) || runID.includes("/") || runID.length > 80) {
    throw new Error("--run-id must contain only safe non-slash characters");
  }
  if (seeds.length === 0 || seeds.length !== subjectSeats.length) {
    throw new Error(
      "--seeds and --subject-seats must have equal nonzero lengths",
    );
  }

  return seeds.flatMap((seed, tripletIndex) => {
    const subjectSeat = subjectSeats[tripletIndex];
    if (!Number.isInteger(seed) || seed < 0 || seed >= 11_881_376) {
      throw new Error(`Invalid seed ${seed}`);
    }
    if (!Number.isInteger(subjectSeat) || subjectSeat < 0 || subjectSeat > 3) {
      throw new Error(`Invalid subject seat ${subjectSeat}`);
    }
    return ARM_NAMES.map((arm) => {
      const runKey = `commander-xp-v2/${runID}/canary/r${String(tripletIndex).padStart(2, "0")}/${arm}`;
      const roster = Array.from({ length: 4 }, (_, slot) => ({
        player: {
          policy_ref: slot === subjectSeat ? policies[arm] : opponentPolicy,
        },
        slot,
      }));
      return {
        arm,
        tripletIndex,
        subjectSeat,
        seed,
        runKey,
        body: {
          idempotency_key: runKey,
          target: { coworld_id: coworldID, variant_id: VARIANT_ID },
          roster,
          num_episodes: 1,
          game_config_overrides: {
            commander_xp_phase: "canary",
            commander_xp_run_key: runKey,
            max_decision_steps: 360,
            turns_per_decision_step: 100,
            max_decision_ms: MAX_DECISION_MS,
            map: "Pangaea",
            map_size: "Compact",
            difficulty: "Easy",
            seed,
            episodeIndex: tripletIndex,
            replay_tail_turns: 500,
            num_agents: 4,
            episode_timeout_seconds: 6_000,
          },
          execution_backend: "k8s",
          notes: `commander-functional/${runID}/r${String(tripletIndex).padStart(2, "0")}/${arm}`,
        },
      };
    });
  });
}

export function summarizeTrace(text) {
  const records = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const providers = records.filter(
    (record) => record.recordType === "provider",
  );
  const decisions = records.filter(
    (record) => record.recordType === "decision",
  );
  const stages = Object.fromEntries(
    ["preflight", "planner", "selector"].map((stage) => {
      const selected = providers.filter((record) => record.stage === stage);
      return [
        stage,
        {
          count: selected.length,
          succeeded: selected.filter((record) => record.succeeded === true)
            .length,
          failed: selected.filter((record) => record.succeeded !== true).length,
        },
      ];
    }),
  );
  const countCommander = (key, expected) =>
    decisions.filter((record) => record.commander?.[key] === expected).length;
  const commanderDecisions = decisions.filter(
    (record) => record.commander?.plannerSource === "strategic-commander-v0",
  );
  const familyCounts = Object.fromEntries(
    ["expand", "develop_economy", "pressure_rival", "survive"].map((family) => [
      family,
      commanderDecisions.filter(
        (record) => record.commander?.commanderSelectedOptionFamily === family,
      ).length,
    ]),
  );
  return {
    recordCount: records.length,
    decisionCount: decisions.length,
    providerCalls: stages,
    providerFailures: providers.filter((record) => record.succeeded !== true)
      .length,
    fallbackCount: decisions.filter((record) => record.fallbackUsed === true)
      .length,
    degradedCount: decisions.filter(
      (record) => record.llmPlannerDegraded === true,
    ).length,
    externalPlannerCalls: countCommander("externalPlannerCall", true),
    deterministicSelectorDecisions: countCommander(
      "commanderSelectorSource",
      "deterministic",
    ),
    llmSelectorDecisions: countCommander("commanderSelectorSource", "llm"),
    alignedPrimaryDecisions: countCommander(
      "commanderFidelity",
      "aligned_primary",
    ),
    commanderFamilyCounts: familyCounts,
    activeNonHoldDecisions: commanderDecisions.filter(
      (record) => record.selectedLegalActionID !== "hold",
    ).length,
    activeNonSurviveDecisions: commanderDecisions.filter(
      (record) => record.commander?.commanderSelectedOptionFamily !== "survive",
    ).length,
  };
}

export function summarizeRuns(runs) {
  const byArm = Object.fromEntries(
    ARM_NAMES.map((arm) => {
      const selected = runs.filter((run) => run.arm === arm);
      return [
        arm,
        {
          runs: selected.length,
          subjectWins: selected.filter((run) => run.subjectWon).length,
          decisions: selected.reduce(
            (sum, run) => sum + run.trace.decisionCount,
            0,
          ),
          providerCalls: {
            preflight: selected.reduce(
              (sum, run) => sum + run.trace.providerCalls.preflight.count,
              0,
            ),
            planner: selected.reduce(
              (sum, run) => sum + run.trace.providerCalls.planner.count,
              0,
            ),
            selector: selected.reduce(
              (sum, run) => sum + run.trace.providerCalls.selector.count,
              0,
            ),
          },
          providerFailures: selected.reduce(
            (sum, run) => sum + run.trace.providerFailures,
            0,
          ),
          fallbacks: selected.reduce(
            (sum, run) => sum + run.trace.fallbackCount,
            0,
          ),
          degradedDecisions: selected.reduce(
            (sum, run) => sum + run.trace.degradedCount,
            0,
          ),
          costUsd: selected.reduce((sum, run) => sum + run.costUsd, 0),
        },
      ];
    }),
  );
  const tripletIndexes = [...new Set(runs.map((run) => run.tripletIndex))].sort(
    (left, right) => left - right,
  );
  const pairedBC = tripletIndexes.map((tripletIndex) => {
    const b = runs.find(
      (run) => run.tripletIndex === tripletIndex && run.arm === "B",
    );
    const c = runs.find(
      (run) => run.tripletIndex === tripletIndex && run.arm === "C",
    );
    if (!b || !c) throw new Error(`Triplet ${tripletIndex} omitted B or C`);
    return {
      tripletIndex,
      seed: b.seed,
      subjectSeat: b.subjectSeat,
      bSubjectWon: b.subjectWon,
      cSubjectWon: c.subjectWon,
      winnerAgreement: b.winnerSlot === c.winnerSlot,
    };
  });
  return {
    tripletCount: tripletIndexes.length,
    runCount: runs.length,
    byArm,
    pairedBC: {
      pairs: pairedBC.length,
      bWins: pairedBC.filter((pair) => pair.bSubjectWon).length,
      cWins: pairedBC.filter((pair) => pair.cSubjectWon).length,
      cMinusBWinRate:
        pairedBC.length === 0
          ? null
          : (pairedBC.filter((pair) => pair.cSubjectWon).length -
              pairedBC.filter((pair) => pair.bSubjectWon).length) /
            pairedBC.length,
      sameWinnerSlot: pairedBC.filter((pair) => pair.winnerAgreement).length,
      outcomes: pairedBC,
    },
  };
}

export function bindResumedRequests(requests, persisted) {
  if (!Array.isArray(persisted) || persisted.length !== requests.length) {
    throw new Error("Resume manifest request count mismatch");
  }
  const byRunKey = new Map(persisted.map((entry) => [entry.runKey, entry]));
  if (byRunKey.size !== persisted.length) {
    throw new Error("Resume manifest contains duplicate run keys");
  }
  return requests.map((request) => {
    const entry = byRunKey.get(request.runKey);
    if (
      !entry ||
      typeof entry.xreqID !== "string" ||
      !entry.xreqID.startsWith("xreq_") ||
      JSON.stringify(entry.body) !== JSON.stringify(request.body) ||
      entry.arm !== request.arm ||
      entry.tripletIndex !== request.tripletIndex ||
      entry.subjectSeat !== request.subjectSeat ||
      entry.seed !== request.seed
    ) {
      throw new Error(`Resume manifest mismatch for ${request.runKey}`);
    }
    return { ...request, xreqID: entry.xreqID };
  });
}

export function renderMarkdown(report) {
  const lines = [
    `# Commander Coworld matched run — ${report.runID}`,
    "",
    `Status: **${report.status.toUpperCase()}**. ${report.claimBoundary}`,
    "",
    `Triplets: ${report.summary.tripletCount}; runs: ${report.summary.runCount}; subject wins A/B/C: ${report.summary.byArm.A.subjectWins}/${report.summary.byArm.B.subjectWins}/${report.summary.byArm.C.subjectWins}.`,
    `Matched B/C win-rate delta (C-B): ${report.summary.pairedBC.cMinusBWinRate}; identical B/C winner slots: ${report.summary.pairedBC.sameWinnerSlot}/${report.summary.pairedBC.pairs}.`,
    `Coworld episode cost USD A/B/C: ${report.summary.byArm.A.costUsd.toFixed(6)}/${report.summary.byArm.B.costUsd.toFixed(6)}/${report.summary.byArm.C.costUsd.toFixed(6)}.`,
    "",
    "| Triplet | Arm | Subject seat | Winner | Subject won | Decisions | Provider calls | Integrity |",
    "| ---: | --- | ---: | ---: | --- | ---: | --- | --- |",
  ];
  for (const run of report.runs) {
    const calls = Object.entries(run.trace.providerCalls)
      .filter(([, value]) => value.count > 0)
      .map(([stage, value]) => `${stage}:${value.succeeded}/${value.count}`)
      .join(", ");
    lines.push(
      `| ${run.tripletIndex} | ${run.arm} | ${run.subjectSeat} | ${run.winnerSlot} | ${run.subjectWon} | ${run.trace.decisionCount} | ${calls || "none"} | failures=${run.trace.providerFailures}, fallback=${run.trace.fallbackCount}, degraded=${run.trace.degradedCount} |`,
    );
  }
  lines.push(
    "",
    "## Boundaries",
    "",
    "- Every triplet uses one seed, one subject seat, one opponent policy, and the same game configuration across A/B/C.",
    "- Subject losses are retained as valid outcomes.",
    "- This functional report does not by itself authorize a statistical performance claim.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const requests = buildRequests(options);
  await assertMissing(options.output);
  await mkdir(path.join(options.output, "requests"), { recursive: true });
  await mkdir(path.join(options.output, "artifacts"), { recursive: true });
  await mkdir(path.join(options.output, "replays"), { recursive: true });

  let created;
  if (options.resumeCreated) {
    created = bindResumedRequests(
      requests,
      parseJson(
        await readFile(options.resumeCreated, "utf8"),
        "resume manifest",
      ),
    );
    process.stdout.write(
      `resumed ${created.length} existing requests from ${options.resumeCreated}\n`,
    );
  } else {
    created = [];
    for (const request of requests) {
      const name = runName(request);
      const requestPath = path.join(options.output, "requests", `${name}.json`);
      await writeJson(requestPath, request.body);
      const response = await coworld([
        "xp-request",
        "create",
        requestPath,
        "--json",
      ]);
      const payload = parseJson(response.stdout, `create ${name}`);
      if (typeof payload.id !== "string" || !payload.id.startsWith("xreq_")) {
        throw new Error(`Coworld create ${name} returned no xreq id`);
      }
      created.push({ ...request, xreqID: payload.id });
      process.stdout.write(`${name} created ${payload.id}\n`);
    }
  }
  for (const request of requests) {
    await writeJson(
      path.join(options.output, "requests", `${runName(request)}.json`),
      request.body,
    );
  }
  await writeJson(path.join(options.output, "created.json"), created);

  const deadline = Date.now() + options.timeoutSeconds * 1_000;
  let terminal = [];
  while (Date.now() < deadline) {
    terminal = await Promise.all(
      created.map(async (request) => {
        const response = await coworld([
          "xp-request",
          "get",
          request.xreqID,
          "--json",
        ]);
        return {
          request,
          payload: parseJson(response.stdout, `get ${request.xreqID}`),
        };
      }),
    );
    const summary = terminal.map(
      ({ request, payload }) => `${runName(request)}=${payload.status}`,
    );
    process.stdout.write(`${new Date().toISOString()} ${summary.join(" ")}\n`);
    if (
      terminal.every(({ payload }) =>
        ["completed", "failed"].includes(payload.status),
      )
    ) {
      break;
    }
    await delay(options.pollSeconds * 1_000);
  }
  if (
    terminal.length !== created.length ||
    terminal.some(({ payload }) => payload.status !== "completed")
  ) {
    throw new Error(
      "One or more Coworld requests did not complete successfully",
    );
  }

  const runs = [];
  for (const { request, payload } of terminal) {
    const episode = exactEpisode(payload, request.xreqID);
    const name = runName(request);
    const artifactPath = path.join(options.output, "artifacts", `${name}.zip`);
    await coworld([
      "episode-logs",
      episode.id,
      "--agent",
      String(request.subjectSeat),
      "--artifact",
      "--output",
      artifactPath,
    ]);
    const replayBytes = new Uint8Array(
      await (await fetchRequired(episode.replay_url)).arrayBuffer(),
    );
    const replayPath = path.join(options.output, "replays", `${name}.replay`);
    await writeFile(replayPath, replayBytes);
    const artifactBytes = await readFile(artifactPath);
    const manifest = parseJson(
      await unzipText(artifactPath, "runtime-manifest.json"),
      `${name} runtime manifest`,
    );
    const traceText = await unzipText(artifactPath, "trace.jsonl");
    assertArtifactIdentity(manifest, request);
    const participantScores = episode.participant_scores;
    if (!Array.isArray(participantScores) || participantScores.length !== 4) {
      throw new Error(`${name} has no complete participant scores`);
    }
    const winner = [...participantScores].sort((a, b) => b.score - a.score)[0];
    if (!winner || !Number.isInteger(winner.position)) {
      throw new Error(`${name} has no valid winner`);
    }
    runs.push({
      tripletIndex: request.tripletIndex,
      arm: request.arm,
      seed: request.seed,
      gameID: manifest.gameID,
      runKey: request.runKey,
      subjectSeat: request.subjectSeat,
      winnerSlot: winner.position,
      subjectWon: winner.position === request.subjectSeat,
      participantScores,
      xreqID: request.xreqID,
      episodeRequestID: episode.id,
      jobID: episode.job_id,
      episodeID: episode.episode_id,
      runningAt: episode.running_at,
      completedAt: episode.completed_at,
      costUsd: episode.cost_usd,
      replayURL: episode.replay_url,
      replaySha256: sha256(replayBytes),
      artifactSha256: sha256(artifactBytes),
      traceSha256: sha256(traceText),
      runtimeManifest: manifest,
      trace: summarizeTrace(traceText),
    });
  }
  assertMatchedTriplets(runs, options.seeds.length);
  for (const run of runs) assertRunRuntime(run);
  const summary = summarizeRuns(runs);
  const report = {
    schemaVersion: 1,
    reportKind: "commander-coworld-functional-triplets",
    runID: options.runID,
    generatedAt: new Date().toISOString(),
    status: "passed",
    claimBoundary:
      "Matched Coworld functional evidence; statistical claims require an explicit analysis decision rule.",
    coworldID: options.coworldID,
    variantID: VARIANT_ID,
    policies: options.policies,
    opponentPolicy: options.opponentPolicy,
    config: {
      maxDecisionSteps: 360,
      turnsPerDecisionStep: 100,
      maxDecisionMs: MAX_DECISION_MS,
      episodeTimeoutSeconds: 6_000,
    },
    summary,
    runs,
  };
  await writeJson(path.join(options.output, "functional-report.json"), report);
  await writeFile(
    path.join(options.output, "functional-report.md"),
    renderMarkdown(report),
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ status: report.status, output: options.output })}\n`,
  );
}

function parseOptions(args) {
  const values = Object.fromEntries(
    args.map((arg) => {
      const match = /^--([^=]+)=(.*)$/.exec(arg);
      if (!match) throw new Error(`Expected --key=value, received ${arg}`);
      return [match[1], match[2]];
    }),
  );
  const required = (key) => {
    if (!values[key]) throw new Error(`Missing --${key}`);
    return values[key];
  };
  return {
    coworldID: required("coworld-id"),
    policies: {
      A: required("policy-a"),
      B: required("policy-b"),
      C: required("policy-c"),
    },
    opponentPolicy: required("opponent-policy"),
    seeds: csvIntegers(required("seeds")),
    subjectSeats: csvIntegers(required("subject-seats")),
    runID: required("run-id"),
    output: path.resolve(required("output")),
    pollSeconds: Number(values["poll-seconds"] ?? 20),
    timeoutSeconds: Number(values["timeout-seconds"] ?? 6_000),
    resumeCreated: values["resume-created"]
      ? path.resolve(values["resume-created"])
      : null,
  };
}

function csvIntegers(value) {
  return value.split(",").map((entry) => {
    const parsed = Number(entry);
    if (!Number.isInteger(parsed))
      throw new Error(`Expected integer, received ${entry}`);
    return parsed;
  });
}

async function coworld(args) {
  return execFileAsync(
    "uvx",
    ["--from", `coworld==${COWORLD_VERSION}`, "coworld", ...args],
    {
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    },
  );
}

async function unzipText(archivePath, member) {
  const { stdout } = await execFileAsync("unzip", ["-p", archivePath, member], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  if (stdout.length === 0) throw new Error(`${archivePath} omitted ${member}`);
  return stdout;
}

function exactEpisode(payload, xreqID) {
  if (
    payload.status !== "completed" ||
    payload.completed_count !== 1 ||
    payload.failed_count !== 0 ||
    !Array.isArray(payload.episodes) ||
    payload.episodes.length !== 1
  ) {
    throw new Error(`${xreqID} is not one clean completed episode`);
  }
  const episode = payload.episodes[0];
  if (
    episode.status !== "completed" ||
    typeof episode.id !== "string" ||
    typeof episode.job_id !== "string" ||
    typeof episode.episode_id !== "string" ||
    typeof episode.replay_url !== "string" ||
    !Number.isFinite(episode.cost_usd) ||
    episode.error !== null ||
    episode.error_type !== null
  ) {
    throw new Error(`${xreqID} episode is incomplete or errored`);
  }
  return episode;
}

function assertArtifactIdentity(manifest, request) {
  if (
    manifest.arm !== request.arm ||
    manifest.runKey !== request.runKey ||
    manifest.gameID !== coworldGameIDForSeed(request.seed) ||
    manifest.providerPreflight?.status !== "succeeded"
  ) {
    throw new Error(`${runName(request)} artifact identity mismatch`);
  }
}

function assertRunRuntime(run) {
  const trace = run.trace;
  if (
    trace.providerFailures !== 0 ||
    trace.fallbackCount !== 0 ||
    trace.degradedCount !== 0 ||
    trace.providerCalls.preflight.count !== 1 ||
    trace.providerCalls.preflight.succeeded !== 1
  ) {
    throw new Error(`${run.runKey} failed runtime integrity checks`);
  }
  const armValid =
    (run.arm === "A" &&
      trace.providerCalls.planner.count > 0 &&
      trace.externalPlannerCalls > 0 &&
      trace.providerCalls.selector.count === 0) ||
    (run.arm === "B" &&
      trace.providerCalls.planner.count === 0 &&
      trace.providerCalls.selector.count === 0 &&
      trace.deterministicSelectorDecisions > 0 &&
      trace.activeNonHoldDecisions > 0 &&
      trace.activeNonSurviveDecisions > 0) ||
    (run.arm === "C" &&
      trace.providerCalls.planner.count === 0 &&
      trace.providerCalls.selector.count > 0 &&
      trace.llmSelectorDecisions > 0 &&
      trace.activeNonHoldDecisions > 0 &&
      trace.activeNonSurviveDecisions > 0);
  if (!armValid)
    throw new Error(`${run.runKey} does not prove its declared arm`);
}

function assertMatchedTriplets(runs, count) {
  for (let tripletIndex = 0; tripletIndex < count; tripletIndex += 1) {
    const triplet = runs.filter((run) => run.tripletIndex === tripletIndex);
    if (
      triplet.length !== 3 ||
      triplet
        .map((run) => run.arm)
        .sort()
        .join("") !== "ABC" ||
      new Set(triplet.map((run) => run.seed)).size !== 1 ||
      new Set(triplet.map((run) => run.subjectSeat)).size !== 1 ||
      new Set(triplet.map((run) => run.gameID)).size !== 1
    ) {
      throw new Error(`Triplet ${tripletIndex} is not matched`);
    }
  }
}

async function fetchRequired(url) {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok)
    throw new Error(`Replay download returned HTTP ${response.status}`);
  return response;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned malformed JSON`, { cause: error });
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runName(request) {
  return `r${String(request.tripletIndex).padStart(2, "0")}-${request.arm}`;
}

function assertUUID(value, label, prefix = "") {
  const candidate =
    prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (!UUID.test(candidate)) throw new Error(`Invalid ${label}`);
}

function coworldGameIDForSeed(seed) {
  let remaining = seed;
  let encoded = "";
  for (let index = 0; index < 5; index += 1) {
    encoded = String.fromCharCode(65 + (remaining % 26)) + encoded;
    remaining = Math.floor(remaining / 26);
  }
  return `PWS${encoded}`;
}

async function assertMissing(target) {
  try {
    await access(target);
    throw new Error(`Output already exists: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function writeJson(target, value) {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
