#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OWNER_PREFIX = "PROXYWAR_OWNER_CAPABILITY_EVIDENCE ";
const USAGE_PREFIX = "PROXYWAR_LLM_USAGE ";
const ARMS = ["off", "structured"];

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sum(values) {
  return values.reduce((total, value) => total + (finite(value) ?? 0), 0);
}

function mean(values) {
  const selected = values.map(finite).filter((value) => value !== null);
  return selected.length > 0 ? sum(selected) / selected.length : null;
}

function rounded(value, digits = 6) {
  return value === null ? null : Number(value.toFixed(digits));
}

function sampleStandardDeviation(values) {
  const selected = values.map(finite).filter((value) => value !== null);
  if (selected.length < 2) return null;
  const average = mean(selected);
  return Math.sqrt(
    selected.reduce((total, value) => total + (value - average) ** 2, 0) /
      (selected.length - 1),
  );
}

export function pairedSummary(values) {
  const selected = values.map(finite).filter((value) => value !== null);
  const average = mean(selected);
  const standardDeviation = sampleStandardDeviation(selected);
  const tCritical =
    selected.length >= 120
      ? 1.98
      : selected.length >= 60
        ? 2
        : selected.length >= 40
          ? 2.011
          : selected.length >= 30
            ? 2.045
            : selected.length >= 24
              ? 2.069
              : selected.length >= 20
                ? 2.093
                : selected.length >= 10
                  ? 2.262
                  : selected.length >= 8
                    ? 2.365
                    : selected.length >= 5
                      ? 2.776
                      : selected.length >= 4
                        ? 3.182
                        : selected.length >= 3
                          ? 4.303
                          : 12.706;
  const halfWidth =
    standardDeviation === null
      ? null
      : (tCritical * standardDeviation) / Math.sqrt(selected.length);
  return {
    count: selected.length,
    meanDifference: rounded(average),
    confidenceInterval95:
      average === null || halfWidth === null
        ? null
        : [rounded(average - halfWidth), rounded(average + halfWidth)],
    positive: selected.filter((value) => value > 0).length,
    tied: selected.filter((value) => value === 0).length,
    negative: selected.filter((value) => value < 0).length,
  };
}

function parsePrefixedJSONLines(text, prefix) {
  const values = [];
  for (const [lineIndex, line] of text.split(/\r?\n/u).entries()) {
    const marker = line.indexOf(prefix);
    if (marker < 0) continue;
    try {
      values.push(JSON.parse(line.slice(marker + prefix.length)));
    } catch (error) {
      throw new Error(
        `invalid ${prefix.trim()} JSON on line ${lineIndex + 1}`,
        {
          cause: error,
        },
      );
    }
  }
  return values;
}

export function selectedActionUtilization(ownerEvents) {
  const selectedByRequest = new Map();
  for (const event of ownerEvents) {
    if (
      typeof event.requestID !== "string" ||
      typeof event.selectedLegalActionID !== "string"
    ) {
      continue;
    }
    const previous = selectedByRequest.get(event.requestID);
    if (previous !== undefined && previous !== event.selectedLegalActionID) {
      throw new Error(
        `${event.requestID} has conflicting selected legal-action evidence`,
      );
    }
    selectedByRequest.set(event.requestID, event.selectedLegalActionID);
  }

  const selectedIDs = [...selectedByRequest.values()];
  const actionKindCounts = {};
  for (const actionID of selectedIDs) {
    const actionKind = actionID.split(":", 1)[0];
    actionKindCounts[actionKind] = (actionKindCounts[actionKind] ?? 0) + 1;
  }
  const decisions = selectedIDs.length;
  const rate = (...kinds) =>
    decisions === 0
      ? null
      : sum(kinds.map((kind) => actionKindCounts[kind] ?? 0)) / decisions;
  return {
    decisions,
    actionKindCounts: Object.fromEntries(
      Object.entries(actionKindCounts).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    nonHoldRate:
      decisions === 0
        ? null
        : (decisions - (actionKindCounts.hold ?? 0)) / decisions,
    expandRate: rate("expand"),
    attackRate: rate("attack"),
    economyBuildRate: rate("build", "upgrade"),
    boatRate: rate("boat"),
  };
}

async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function replaySummary(replay) {
  const raw = replay.inlineRunArtifacts?.["match-summary.json"];
  if (typeof raw !== "string") {
    throw new Error("replay lacks inline match-summary.json");
  }
  return JSON.parse(raw);
}

async function readRun(root, entry) {
  const directory = path.join(root, "evidence", entry.setID, entry.arm);
  const [status, results, logText, replay] = await Promise.all([
    readJSON(path.join(root, "status", entry.filename)),
    readJSON(path.join(directory, "results.json")),
    fs.readFile(
      path.join(directory, `subject-seat-${entry.subjectSlot}.log`),
      "utf8",
    ),
    readJSON(path.join(directory, "episode.replay")),
  ]);
  const episode = status.episodes?.[0];
  if (!episode || status.episodes.length !== 1) {
    throw new Error(`${entry.setID}/${entry.arm} does not have one episode`);
  }
  const player = results.players?.find(
    (candidate) => candidate.slot === entry.subjectSlot,
  );
  if (!player) {
    throw new Error(`${entry.setID}/${entry.arm} lacks subject result`);
  }
  const ownerEvents = parsePrefixedJSONLines(logText, OWNER_PREFIX);
  const usageEvents = parsePrefixedJSONLines(logText, USAGE_PREFIX);
  const responseEvents = usageEvents.filter(
    (event) => event.event === "response",
  );
  const usageSummary = usageEvents.findLast(
    (event) => event.event === "summary",
  );
  const spatialEvents = ownerEvents.filter(
    (event) => event.kind === "spatial_observation",
  );
  const selectedEvents = ownerEvents.filter(
    (event) => typeof event.selectedLegalActionID === "string",
  );
  const actionUtilization = selectedActionUtilization(ownerEvents);
  const summary = replaySummary(replay);
  return {
    setIndex: entry.setIndex,
    setID: entry.setID,
    map: entry.setID.split("-r")[0],
    arm: entry.arm,
    subjectSlot: entry.subjectSlot,
    xreqID: status.id,
    episodeRequestID: episode.id,
    jobID: episode.job_id,
    replayURL: episode.replay_url,
    costUSD: finite(episode.cost_usd),
    score: finite(player.score),
    won: results.winner_slot === entry.subjectSlot,
    tiles: finite(player.tiles_owned),
    survived: player.is_alive === true,
    turnCount: finite(results.turn_count),
    decisions: finite(results.decision_count),
    acceptedDecisions: finite(results.accepted_decision_count),
    degradedDecisions: finite(results.degraded_count),
    degradedCauses: results.degraded_causes ?? {},
    ownerEvidenceEvents: ownerEvents.length,
    selectedEvidenceEvents: selectedEvents.length,
    selectedOfferedEvents: selectedEvents.filter(
      (event) => event.selectedLegalActionOffered === true,
    ).length,
    selectedUniqueDecisions: actionUtilization.decisions,
    selectedActionKindCounts: actionUtilization.actionKindCounts,
    selectedNonHoldRate: actionUtilization.nonHoldRate,
    selectedExpandRate: actionUtilization.expandRate,
    selectedAttackRate: actionUtilization.attackRate,
    selectedEconomyBuildRate: actionUtilization.economyBuildRate,
    selectedBoatRate: actionUtilization.boatRate,
    actionFidelity:
      selectedEvents.length > 0 &&
      selectedEvents.every(
        (event) => event.selectedLegalActionOffered === true,
      ),
    spatialEvidenceEvents: spatialEvents.length,
    spatialContract:
      entry.arm === "off"
        ? spatialEvents.length > 0 &&
          spatialEvents.every((event) => event.present === false)
        : spatialEvents.length > 0 &&
          spatialEvents.every(
            (event) =>
              event.present === true &&
              event.schemaVersion === 5 &&
              event.minimapPresent === false,
          ),
    providerResponses: responseEvents.length,
    providerErrors: finite(usageSummary?.errors) ?? 0,
    usageComplete: usageSummary?.usageComplete === true,
    inFlightRequests: finite(usageSummary?.inFlightRequests) ?? 0,
    inputTokens: sum(responseEvents.map((event) => event.inputTokens)),
    outputTokens: sum(responseEvents.map((event) => event.outputTokens)),
    firstInputTokens: finite(responseEvents[0]?.inputTokens),
    meanLatencyMs: mean(responseEvents.map((event) => event.latencyMs)),
    entertainmentScore: finite(summary.matchStory?.entertainmentScore),
    actionDiversity: finite(summary.matchStory?.actionDiversityCount),
    majorEvents: finite(summary.spectatorTelemetry?.majorEventCount),
    behaviorQualityScore: finite(summary.behaviorQuality?.score),
    behaviorQualityGrade: summary.behaviorQuality?.grade ?? null,
    replayFallbackCount: finite(summary.fallbackCount),
    replayRejectedCount: finite(summary.rejectedCount),
    replayParseFailureCount: finite(summary.parseFailureCount),
  };
}

function armSummary(runs, arm) {
  const rows = runs.filter((run) => run.arm === arm);
  const selectedActionKindCounts = {};
  for (const row of rows) {
    for (const [kind, count] of Object.entries(row.selectedActionKindCounts)) {
      selectedActionKindCounts[kind] =
        (selectedActionKindCounts[kind] ?? 0) + count;
    }
  }
  const selectedUniqueDecisions = sum(
    rows.map((run) => run.selectedUniqueDecisions),
  );
  const selectedRate = (...kinds) =>
    selectedUniqueDecisions === 0
      ? null
      : sum(kinds.map((kind) => selectedActionKindCounts[kind] ?? 0)) /
        selectedUniqueDecisions;
  return {
    runs: rows.length,
    wins: rows.filter((run) => run.won).length,
    meanScore: rounded(mean(rows.map((run) => run.score))),
    meanTiles: rounded(mean(rows.map((run) => run.tiles))),
    survivalRate: rounded(mean(rows.map((run) => (run.survived ? 1 : 0)))),
    totalCostUSD: rounded(sum(rows.map((run) => run.costUSD))),
    meanCostUSD: rounded(mean(rows.map((run) => run.costUSD))),
    totalInputTokens: sum(rows.map((run) => run.inputTokens)),
    totalOutputTokens: sum(rows.map((run) => run.outputTokens)),
    meanFirstInputTokens: rounded(
      mean(rows.map((run) => run.firstInputTokens)),
    ),
    meanLatencyMs: rounded(mean(rows.map((run) => run.meanLatencyMs))),
    providerResponses: sum(rows.map((run) => run.providerResponses)),
    providerErrors: sum(rows.map((run) => run.providerErrors)),
    incompleteUsageSummaries: rows.filter((run) => !run.usageComplete).length,
    inFlightAtFinal: sum(rows.map((run) => run.inFlightRequests)),
    degradedDecisions: sum(rows.map((run) => run.degradedDecisions)),
    decisions: sum(rows.map((run) => run.decisions)),
    degradationRate: rounded(
      sum(rows.map((run) => run.degradedDecisions)) /
        sum(rows.map((run) => run.decisions)),
    ),
    actionFidelityPass: rows.every((run) => run.actionFidelity),
    spatialContractPass: rows.every((run) => run.spatialContract),
    selectedEvidenceEvents: sum(rows.map((run) => run.selectedEvidenceEvents)),
    selectedOfferedEvents: sum(rows.map((run) => run.selectedOfferedEvents)),
    selectedUniqueDecisions,
    selectedActionKindCounts: Object.fromEntries(
      Object.entries(selectedActionKindCounts).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    selectedNonHoldRate: rounded(
      selectedUniqueDecisions === 0
        ? null
        : 1 - (selectedActionKindCounts.hold ?? 0) / selectedUniqueDecisions,
    ),
    selectedExpandRate: rounded(selectedRate("expand")),
    selectedAttackRate: rounded(selectedRate("attack")),
    selectedEconomyBuildRate: rounded(selectedRate("build", "upgrade")),
    selectedBoatRate: rounded(selectedRate("boat")),
    meanEntertainmentScore: rounded(
      mean(rows.map((run) => run.entertainmentScore)),
    ),
    meanActionDiversity: rounded(mean(rows.map((run) => run.actionDiversity))),
    meanMajorEvents: rounded(mean(rows.map((run) => run.majorEvents))),
    meanBehaviorQualityScore: rounded(
      mean(rows.map((run) => run.behaviorQualityScore)),
    ),
    replayRejectedDecisions: sum(rows.map((run) => run.replayRejectedCount)),
    replayParseFailures: sum(rows.map((run) => run.replayParseFailureCount)),
  };
}

function pairedReport(runs, options = {}) {
  const rows = [];
  const incompleteSetIDs = [];
  const bySet = Map.groupBy(runs, (run) => run.setID);
  for (const [setID, pair] of bySet) {
    const off = pair.find((run) => run.arm === "off");
    const structured = pair.find((run) => run.arm === "structured");
    if (!off || !structured) {
      if (options.allowPartial === true) {
        incompleteSetIDs.push(setID);
        continue;
      }
      throw new Error(`${setID} is not a complete pair`);
    }
    rows.push({
      setID,
      map: off.map,
      score: structured.score - off.score,
      win: Number(structured.won) - Number(off.won),
      tiles: structured.tiles - off.tiles,
      survival: Number(structured.survived) - Number(off.survived),
      costUSD: structured.costUSD - off.costUSD,
      inputTokens: structured.inputTokens - off.inputTokens,
      firstInputTokens: structured.firstInputTokens - off.firstInputTokens,
      meanLatencyMs: structured.meanLatencyMs - off.meanLatencyMs,
      entertainmentScore:
        structured.entertainmentScore - off.entertainmentScore,
      actionDiversity: structured.actionDiversity - off.actionDiversity,
      behaviorQualityScore:
        structured.behaviorQualityScore - off.behaviorQualityScore,
      selectedNonHoldRate:
        structured.selectedNonHoldRate - off.selectedNonHoldRate,
      selectedExpandRate:
        structured.selectedExpandRate - off.selectedExpandRate,
      selectedAttackRate:
        structured.selectedAttackRate - off.selectedAttackRate,
      selectedEconomyBuildRate:
        structured.selectedEconomyBuildRate - off.selectedEconomyBuildRate,
      selectedBoatRate: structured.selectedBoatRate - off.selectedBoatRate,
    });
  }
  const metric = (name) => pairedSummary(rows.map((row) => row[name]));
  return {
    rows,
    incompleteSetIDs,
    score: metric("score"),
    win: metric("win"),
    tiles: metric("tiles"),
    survival: metric("survival"),
    costUSD: metric("costUSD"),
    inputTokens: metric("inputTokens"),
    firstInputTokens: metric("firstInputTokens"),
    meanLatencyMs: metric("meanLatencyMs"),
    entertainmentScore: metric("entertainmentScore"),
    actionDiversity: metric("actionDiversity"),
    behaviorQualityScore: metric("behaviorQualityScore"),
    selectedNonHoldRate: metric("selectedNonHoldRate"),
    selectedExpandRate: metric("selectedExpandRate"),
    selectedAttackRate: metric("selectedAttackRate"),
    selectedEconomyBuildRate: metric("selectedEconomyBuildRate"),
    selectedBoatRate: metric("selectedBoatRate"),
    byMap: Object.fromEntries(
      [...new Set(rows.map((row) => row.map))].map((map) => [
        map,
        {
          score: pairedSummary(
            rows.filter((row) => row.map === map).map((row) => row.score),
          ),
          entertainmentScore: pairedSummary(
            rows
              .filter((row) => row.map === map)
              .map((row) => row.entertainmentScore),
          ),
        },
      ]),
    ),
  };
}

export async function analyze(root, options = {}) {
  const resolved = path.resolve(root);
  const index = await readJSON(path.join(resolved, "gate3-index.json"));
  const phase = index.phase ?? "canary";
  const expectedSets =
    phase === "canary" ? 24 : phase === "confirmatory" ? 48 : null;
  const expectedRequests = expectedSets === null ? null : expectedSets * 2;
  if (
    expectedRequests === null ||
    index.validation?.setCount !== expectedSets ||
    index.validation?.requestCount !== expectedRequests ||
    index.entries?.length !== expectedRequests
  ) {
    throw new Error(`Gate 3 ${phase} index has invalid cardinality`);
  }
  const runs = [];
  for (const entry of index.entries) {
    try {
      runs.push(await readRun(resolved, entry));
    } catch (error) {
      if (options.allowPartial === true && error.code === "ENOENT") continue;
      throw error;
    }
  }
  const arms = Object.fromEntries(
    ARMS.map((arm) => [arm, armSummary(runs, arm)]),
  );
  const paired = pairedReport(runs, options);
  const phaseReliabilityPass = ARMS.every(
    (arm) =>
      arms[arm].runs === expectedSets &&
      arms[arm].actionFidelityPass &&
      arms[arm].spatialContractPass &&
      arms[arm].providerErrors === 0,
  );
  const runtimeEnablementReliabilityPass =
    phaseReliabilityPass &&
    arms.structured.degradationRate <= arms.off.degradationRate &&
    arms.structured.replayRejectedDecisions <=
      arms.off.replayRejectedDecisions &&
    arms.structured.replayParseFailures <= arms.off.replayParseFailures;
  const complete = runs.length === expectedRequests;
  const scoreLowerBound = paired.score.confidenceInterval95?.[0] ?? null;
  const entertainmentLowerBound =
    paired.entertainmentScore.confidenceInterval95?.[0] ?? null;
  const gameplaySuperiorityPass =
    phase === "confirmatory" &&
    complete &&
    phaseReliabilityPass &&
    scoreLowerBound !== null &&
    scoreLowerBound > 0;
  const gameplayNonInferiorityPass =
    phase === "confirmatory" &&
    complete &&
    phaseReliabilityPass &&
    scoreLowerBound !== null &&
    scoreLowerBound >= -0.05;
  const entertainmentNonInferiorityPass =
    phase === "confirmatory" &&
    complete &&
    entertainmentLowerBound !== null &&
    entertainmentLowerBound >= -2;
  const watchabilityEvidence = {
    automatedProxyAvailable: true,
    automatedNonInferiorityMargin: -2,
    automatedNonInferiorityPass: entertainmentNonInferiorityPass,
    blindedHumanReviewComplete: false,
  };
  return {
    schemaVersion: 1,
    phase,
    sourceCommit: index.sourceCommit,
    generatedAt: new Date().toISOString(),
    complete,
    expectedRequests,
    expectedSets,
    arms,
    paired,
    phaseReliabilityPass,
    runtimeEnablementReliabilityPass,
    canaryAdvances:
      phase === "canary" &&
      complete &&
      phaseReliabilityPass &&
      paired.score.meanDifference !== null &&
      paired.score.meanDifference > 0,
    gameplaySuperiorityPass,
    gameplayNonInferiorityMargin: -0.05,
    gameplayNonInferiorityPass,
    watchabilityEvidence,
    runtimeEnablementEligible:
      gameplayNonInferiorityPass &&
      runtimeEnablementReliabilityPass &&
      entertainmentNonInferiorityPass &&
      watchabilityEvidence.blindedHumanReviewComplete,
    limitations: [
      "Replay entertainment and behavior-quality scores are automated proxies, not blinded spectator judgments.",
      "Aggregate token totals are lower bounds when a planner request remained in flight at episode final.",
      "Gate 3 retained evidence proves exact offered-action fidelity but does not reconstruct a counterfactual spatial-consistency score for each selected action.",
      "Selected-action utilization rates are post-hoc diagnostics, not preregistered gameplay endpoints.",
    ],
    runs,
  };
}

async function main(argv) {
  const positional = argv.filter((argument) => !argument.startsWith("--"));
  const unknownOptions = argv.filter(
    (argument) => argument.startsWith("--") && argument !== "--partial",
  );
  const [root, output] = positional;
  if (
    !root ||
    !output ||
    positional.length !== 2 ||
    unknownOptions.length > 0
  ) {
    throw new Error(
      "usage: node analyze-spatial-gate3.mjs EVIDENCE_ROOT OUTPUT_JSON [--partial]",
    );
  }
  const report = await analyze(root, {
    allowPartial: argv.includes("--partial"),
  });
  await fs.writeFile(
    path.resolve(output),
    `${JSON.stringify(report, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
  process.stdout.write(
    `${JSON.stringify({ output: path.resolve(output), phase: report.phase, complete: report.complete, phaseReliabilityPass: report.phaseReliabilityPass, runtimeEnablementReliabilityPass: report.runtimeEnablementReliabilityPass, canaryAdvances: report.canaryAdvances, gameplaySuperiorityPass: report.gameplaySuperiorityPass, gameplayNonInferiorityPass: report.gameplayNonInferiorityPass, runtimeEnablementEligible: report.runtimeEnablementEligible })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
