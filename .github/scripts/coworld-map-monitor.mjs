#!/usr/bin/env node

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const SHA = /^[0-9a-f]{40}$/;
const COWORLD_ID =
  /^cow_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ROUND_STATUS = new Set(["pending", "running", "completed", "failed"]);
const EPISODE_STATUS = new Set(["pending", "running", "completed", "failed"]);
const TERMINAL_STATUS = new Set(["completed", "failed"]);
const MONITORING_FIELDS = [
  "minimumTerminalRoundsPerMap",
  "minimumCompletionRate",
  "minimumScoreBearingCoverage",
  "minimumSpawnValidityCoverage",
  "minimumTelemetryCoverage",
  "minimumReplayIntegrityCoverage",
  "minimumArtifactIntegrityCoverage",
  "warnAtEpisodeTimeoutFraction",
];

export const MAP_MONITOR_LIMITS = Object.freeze({
  contractBytes: 64 * 1024,
  evidenceBytes: 4 * 1024 * 1024,
  objectMembers: 32,
  comparisonSeatCounts: 16,
  rungs: 16,
  variantsPerRung: 32,
  totalVariants: 256,
  rounds: 128,
  episodesPerRound: 128,
  totalEpisodes: 4_096,
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  invariant(
    Object.keys(value).length <= MAP_MONITOR_LIMITS.objectMembers,
    `${label} exceeds the object member limit`,
  );
  invariant(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    `${label} has unexpected fields`,
  );
}

function boundedArray(value, label, maximum, minimum = 0) {
  invariant(Array.isArray(value), `${label} must be an array`);
  invariant(
    value.length >= minimum && value.length <= maximum,
    `${label} length must be between ${minimum} and ${maximum}`,
  );
  return value;
}

function boundedInteger(value, label, minimum = 0) {
  invariant(
    Number.isSafeInteger(value) && value >= minimum,
    `${label} must be an integer >= ${minimum}`,
  );
  return value;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function timestamp(value, label) {
  invariant(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    `${label} must be an ISO UTC timestamp`,
  );
  return Date.parse(value);
}

function sameFileIdentity(left, right) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
    (field) => left[field] === right[field],
  );
}

export function readBoundedJsonFile(path, maximumBytes, label) {
  invariant(
    typeof path === "string" && path.length > 0 && !path.includes("\0"),
    `${label} path is invalid`,
  );
  boundedInteger(maximumBytes, `${label} maximumBytes`, 1);
  invariant(
    Number.isSafeInteger(fsConstants.O_NOFOLLOW) &&
      Number.isSafeInteger(fsConstants.O_NONBLOCK),
    "this platform does not support safe no-follow file reads",
  );

  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    invariant(before.isFile(), `${label} must be a regular file`);
    invariant(before.size > 0n, `${label} must not be empty`);
    invariant(
      before.size <= BigInt(maximumBytes),
      `${label} exceeds the ${maximumBytes}-byte limit`,
    );

    const size = Number(before.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(descriptor, bytes, offset, size - offset, null);
      invariant(read > 0, `${label} changed or truncated while being read`);
      offset += read;
    }
    const trailingByte = Buffer.allocUnsafe(1);
    invariant(
      readSync(descriptor, trailingByte, 0, 1, null) === 0,
      `${label} grew while being read`,
    );
    const after = fstatSync(descriptor, { bigint: true });
    invariant(
      sameFileIdentity(before, after),
      `${label} identity changed while being read`,
    );

    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`${label} is not valid JSON`, { cause: error });
    }
  } finally {
    closeSync(descriptor);
  }
}

function contractIndex(contract) {
  exactKeys(
    contract,
    [
      "schemaVersion",
      "comparisonPoolSeatCounts",
      "competitionRungs",
      "postReleaseMonitoring",
    ],
    "map contract",
  );
  invariant(
    contract.schemaVersion === 1,
    "map contract schemaVersion must be 1",
  );
  boundedArray(
    contract.comparisonPoolSeatCounts,
    "map contract comparisonPoolSeatCounts",
    MAP_MONITOR_LIMITS.comparisonSeatCounts,
    2,
  );
  boundedArray(
    contract.competitionRungs,
    "map contract competitionRungs",
    MAP_MONITOR_LIMITS.rungs,
    1,
  );
  exactKeys(
    contract.postReleaseMonitoring,
    MONITORING_FIELDS,
    "map monitoring thresholds",
  );
  boundedInteger(
    contract.postReleaseMonitoring.minimumTerminalRoundsPerMap,
    "minimumTerminalRoundsPerMap",
    1,
  );
  for (const field of MONITORING_FIELDS.slice(1)) {
    const value = contract.postReleaseMonitoring[field];
    invariant(
      typeof value === "number" &&
        Number.isFinite(value) &&
        value > 0 &&
        value <= 1,
      `${field} must be in (0, 1]`,
    );
  }

  const byVariant = new Map();
  const poolsBySeats = new Map();
  let previousSeats = 0;
  for (const rung of contract.competitionRungs) {
    exactKeys(rung, ["seats", "variants"], "map contract rung");
    boundedInteger(rung.seats, "map contract seats", 1);
    invariant(
      rung.seats > previousSeats,
      "map contract seat counts must be strictly increasing",
    );
    previousSeats = rung.seats;
    boundedArray(
      rung.variants,
      `map contract rung ${rung.seats} variants`,
      MAP_MONITOR_LIMITS.variantsPerRung,
      1,
    );
    const maps = [];
    for (let index = 0; index < rung.variants.length; index += 1) {
      const variant = rung.variants[index];
      exactKeys(
        variant,
        [
          "id",
          "map",
          "mapSize",
          "maxDecisionSteps",
          "turnsPerDecisionStep",
          "episodeTimeoutSeconds",
        ],
        `map contract rung ${rung.seats} variant`,
      );
      invariant(
        typeof variant.id === "string" &&
          variant.id.startsWith(`tournament-${rung.seats}p-`) &&
          /^tournament-[1-9]\d*p-[a-z0-9-]+$/.test(variant.id) &&
          !byVariant.has(variant.id),
        "map contract variant ids must be unique and match their rung",
      );
      invariant(
        typeof variant.map === "string" && /^[A-Za-z0-9]+$/.test(variant.map),
        `${variant.id} must declare a map`,
      );
      invariant(
        typeof variant.mapSize === "string" &&
          /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(variant.mapSize),
        `${variant.id} mapSize is invalid`,
      );
      boundedInteger(
        variant.maxDecisionSteps,
        `${variant.id} maxDecisionSteps`,
        1,
      );
      boundedInteger(
        variant.turnsPerDecisionStep,
        `${variant.id} turnsPerDecisionStep`,
        1,
      );
      boundedInteger(
        variant.episodeTimeoutSeconds,
        `${variant.id} episodeTimeoutSeconds`,
        1,
      );
      invariant(
        byVariant.size < MAP_MONITOR_LIMITS.totalVariants,
        "map contract exceeds total variant limit",
      );
      byVariant.set(variant.id, {
        id: variant.id,
        map: variant.map,
        seats: rung.seats,
        poolIndex: index,
        episodeTimeoutSeconds: variant.episodeTimeoutSeconds,
      });
      maps.push(variant.map);
    }
    invariant(
      new Set(maps).size === maps.length,
      `map contract rung ${rung.seats} contains duplicate maps`,
    );
    poolsBySeats.set(rung.seats, maps);
  }

  const comparisonPools = contract.comparisonPoolSeatCounts.map((seats) => {
    boundedInteger(seats, "comparison pool seat count", 1);
    invariant(
      poolsBySeats.has(seats),
      `comparison pool references unknown ${seats}-seat rung`,
    );
    return poolsBySeats.get(seats);
  });
  invariant(
    new Set(contract.comparisonPoolSeatCounts).size ===
      contract.comparisonPoolSeatCounts.length,
    "comparison pool seat counts must be unique",
  );
  for (const pool of comparisonPools.slice(1)) {
    invariant(
      JSON.stringify(pool) === JSON.stringify(comparisonPools[0]),
      "comparison rungs must use the same ordered map pool",
    );
  }
  return byVariant;
}

function initialSummary(variant) {
  return {
    variantId: variant.id,
    map: variant.map,
    seats: variant.seats,
    rounds: { scheduled: 0, completed: 0, failed: 0, pending: 0, running: 0 },
    episodes: { scheduled: 0, completed: 0, failed: 0, pending: 0, running: 0 },
    scoreBearingEpisodes: 0,
    spawnEvidenceEpisodes: 0,
    spawnValidEpisodes: 0,
    telemetryEvidenceEpisodes: 0,
    decisions: 0,
    fallbackDecisions: 0,
    degradedDecisions: 0,
    replayIntegrityEpisodes: 0,
    artifactIntegrityEpisodes: 0,
    durationsSeconds: [],
  };
}

function validateEpisode(episode, variant) {
  exactKeys(
    episode,
    [
      "episodeRequestId",
      "status",
      "participantCount",
      "scoreCount",
      "spawnEvidencePresent",
      "spawnValid",
      "telemetryEvidencePresent",
      "decisionCount",
      "fallbackCount",
      "degradedCount",
      "replayPresent",
      "replayIntegrityVerified",
      "artifactIntegrityVerified",
      "startedAt",
      "completedAt",
    ],
    "map monitoring episode",
  );
  invariant(
    typeof episode.episodeRequestId === "string" &&
      /^ereq_[0-9a-f-]{36}$/.test(episode.episodeRequestId),
    "episodeRequestId is invalid",
  );
  invariant(EPISODE_STATUS.has(episode.status), "episode status is invalid");
  boundedInteger(episode.participantCount, "participantCount", 1);
  invariant(
    episode.participantCount === variant.seats,
    "episode participant count does not match variant seats",
  );
  boundedInteger(episode.scoreCount, "scoreCount");
  for (const field of [
    "spawnEvidencePresent",
    "spawnValid",
    "telemetryEvidencePresent",
    "replayPresent",
    "replayIntegrityVerified",
    "artifactIntegrityVerified",
  ]) {
    invariant(typeof episode[field] === "boolean", `${field} must be boolean`);
  }
  boundedInteger(episode.decisionCount, "decisionCount");
  boundedInteger(episode.fallbackCount, "fallbackCount");
  boundedInteger(episode.degradedCount, "degradedCount");
  invariant(
    episode.fallbackCount <= episode.decisionCount &&
      episode.degradedCount <= episode.decisionCount,
    "fallback/degraded counts cannot exceed decisionCount",
  );
  invariant(
    episode.spawnEvidencePresent || !episode.spawnValid,
    "spawnValid cannot be true without spawn evidence",
  );
  invariant(
    episode.telemetryEvidencePresent ||
      (episode.decisionCount === 0 &&
        episode.fallbackCount === 0 &&
        episode.degradedCount === 0),
    "decision telemetry cannot be reported without telemetry evidence",
  );
  invariant(
    episode.replayPresent || !episode.replayIntegrityVerified,
    "replay integrity cannot be verified without a replay",
  );
  if (["completed", "failed"].includes(episode.status)) {
    const started = timestamp(episode.startedAt, "episode startedAt");
    const completed = timestamp(episode.completedAt, "episode completedAt");
    invariant(completed >= started, "episode completion precedes start");
    return (completed - started) / 1000;
  }
  invariant(
    episode.startedAt === null || typeof episode.startedAt === "string",
    "non-terminal episode startedAt is invalid",
  );
  invariant(
    episode.completedAt === null,
    "non-terminal episode cannot have completedAt",
  );
  return null;
}

export function buildMapMonitoringReport(contract, evidence) {
  const variants = contractIndex(contract);
  exactKeys(
    evidence,
    [
      "schemaVersion",
      "sourceSha",
      "coworldId",
      "commissionerMigrationVersion",
      "rounds",
    ],
    "map monitoring evidence",
  );
  invariant(evidence.schemaVersion === 1, "evidence schemaVersion must be 1");
  invariant(SHA.test(evidence.sourceSha), "evidence sourceSha is invalid");
  invariant(
    COWORLD_ID.test(evidence.coworldId),
    "evidence coworldId is invalid",
  );
  invariant(
    DIGEST.test(evidence.commissionerMigrationVersion),
    "evidence commissionerMigrationVersion is invalid",
  );
  boundedArray(evidence.rounds, "evidence rounds", MAP_MONITOR_LIMITS.rounds);

  const summaries = new Map();
  const observedSeatCounts = new Set();
  const roundIds = new Set();
  let totalEpisodes = 0;
  for (const round of evidence.rounds) {
    exactKeys(
      round,
      ["roundId", "roundNumber", "variantId", "map", "status", "episodes"],
      "map monitoring round",
    );
    invariant(
      typeof round.roundId === "string" &&
        /^round_[0-9a-f-]{36}$/.test(round.roundId),
      "roundId is invalid",
    );
    invariant(
      !roundIds.has(round.roundId),
      "evidence contains duplicate roundId",
    );
    roundIds.add(round.roundId);
    boundedInteger(round.roundNumber, "roundNumber", 1);
    invariant(ROUND_STATUS.has(round.status), "round status is invalid");
    boundedArray(
      round.episodes,
      "round episodes",
      MAP_MONITOR_LIMITS.episodesPerRound,
    );
    totalEpisodes += round.episodes.length;
    invariant(
      totalEpisodes <= MAP_MONITOR_LIMITS.totalEpisodes,
      "evidence exceeds total episode limit",
    );
    const variant = variants.get(round.variantId);
    invariant(
      variant !== undefined,
      `unsupported map variant: ${round.variantId}`,
    );
    invariant(
      round.map === variant.map,
      `${round.variantId} map identity mismatch`,
    );
    observedSeatCounts.add(variant.seats);
    const summary = summaries.get(variant.id) ?? initialSummary(variant);
    summaries.set(variant.id, summary);
    summary.rounds.scheduled += 1;
    summary.rounds[round.status] += 1;

    const requestIds = new Set();
    for (const episode of round.episodes) {
      invariant(
        !requestIds.has(episode?.episodeRequestId),
        "round contains duplicate episodeRequestId",
      );
      requestIds.add(episode?.episodeRequestId);
      const durationSeconds = validateEpisode(episode, variant);
      invariant(
        !TERMINAL_STATUS.has(round.status) ||
          TERMINAL_STATUS.has(episode.status),
        "terminal round contains nonterminal episode",
      );
      summary.episodes.scheduled += 1;
      summary.episodes[episode.status] += 1;
      if (episode.status !== "completed") continue;
      if (episode.scoreCount === episode.participantCount) {
        summary.scoreBearingEpisodes += 1;
      }
      if (episode.spawnEvidencePresent) summary.spawnEvidenceEpisodes += 1;
      if (episode.spawnEvidencePresent && episode.spawnValid) {
        summary.spawnValidEpisodes += 1;
      }
      if (episode.telemetryEvidencePresent) {
        summary.telemetryEvidenceEpisodes += 1;
        summary.decisions += episode.decisionCount;
        summary.fallbackDecisions += episode.fallbackCount;
        summary.degradedDecisions += episode.degradedCount;
      }
      if (episode.replayPresent && episode.replayIntegrityVerified) {
        summary.replayIntegrityEpisodes += 1;
      }
      if (episode.artifactIntegrityVerified) {
        summary.artifactIntegrityEpisodes += 1;
      }
      summary.durationsSeconds.push(durationSeconds);
    }
  }

  // Once a comparison rung appears in the observation window, emit every map
  // in that rung. Absent maps then remain explicit insufficient evidence
  // instead of disappearing from an apparently healthy report.
  const comparisonSeatCounts = new Set(contract.comparisonPoolSeatCounts);
  for (const variant of variants.values()) {
    if (
      comparisonSeatCounts.has(variant.seats) &&
      observedSeatCounts.has(variant.seats) &&
      !summaries.has(variant.id)
    ) {
      summaries.set(variant.id, initialSummary(variant));
    }
  }

  const thresholds = contract.postReleaseMonitoring;
  const rows = [...summaries.values()]
    .sort(
      (left, right) =>
        left.seats - right.seats ||
        variants.get(left.variantId).poolIndex -
          variants.get(right.variantId).poolIndex,
    )
    .map((summary) => {
      const completed = summary.episodes.completed;
      const terminal = completed + summary.episodes.failed;
      const completionRate = ratio(completed, terminal);
      const scoreBearingCoverage = ratio(
        summary.scoreBearingEpisodes,
        completed,
      );
      const spawnValidityCoverage = ratio(
        summary.spawnValidEpisodes,
        completed,
      );
      const telemetryCoverage = ratio(
        summary.telemetryEvidenceEpisodes,
        completed,
      );
      const replayIntegrityCoverage = ratio(
        summary.replayIntegrityEpisodes,
        completed,
      );
      const artifactIntegrityCoverage = ratio(
        summary.artifactIntegrityEpisodes,
        completed,
      );
      const fallbackRate = ratio(summary.fallbackDecisions, summary.decisions);
      const degradedRate = ratio(summary.degradedDecisions, summary.decisions);
      const p95 = percentile(summary.durationsSeconds, 0.95);
      const timeout = variants.get(summary.variantId).episodeTimeoutSeconds;
      const terminalRounds = summary.rounds.completed + summary.rounds.failed;
      const sufficientEvidence =
        terminalRounds >= thresholds.minimumTerminalRoundsPerMap;
      const integrityHealthy =
        sufficientEvidence &&
        completionRate >= thresholds.minimumCompletionRate &&
        scoreBearingCoverage >= thresholds.minimumScoreBearingCoverage &&
        spawnValidityCoverage >= thresholds.minimumSpawnValidityCoverage &&
        telemetryCoverage >= thresholds.minimumTelemetryCoverage &&
        replayIntegrityCoverage >= thresholds.minimumReplayIntegrityCoverage &&
        artifactIntegrityCoverage >=
          thresholds.minimumArtifactIntegrityCoverage;
      const performanceWarning =
        p95 !== null &&
        p95 >= timeout * thresholds.warnAtEpisodeTimeoutFraction;
      return {
        variantId: summary.variantId,
        map: summary.map,
        seats: summary.seats,
        status: !sufficientEvidence
          ? "insufficient_evidence"
          : !integrityHealthy
            ? "degraded"
            : performanceWarning
              ? "warning"
              : "healthy",
        rounds: summary.rounds,
        episodes: summary.episodes,
        coverage: {
          completionRate,
          scoreBearingCoverage,
          spawnValidityCoverage,
          telemetryCoverage,
          replayIntegrityCoverage,
          artifactIntegrityCoverage,
        },
        decisions: {
          observed: summary.decisions,
          fallback: summary.fallbackDecisions,
          degraded: summary.degradedDecisions,
          fallbackRate,
          degradedRate,
        },
        performanceSeconds: {
          p50: percentile(summary.durationsSeconds, 0.5),
          p95,
          max:
            summary.durationsSeconds.length === 0
              ? null
              : Math.max(...summary.durationsSeconds),
          timeout,
          warningAt: timeout * thresholds.warnAtEpisodeTimeoutFraction,
        },
      };
    });

  return {
    schemaVersion: 1,
    sourceSha: evidence.sourceSha,
    coworldId: evidence.coworldId,
    commissionerMigrationVersion: evidence.commissionerMigrationVersion,
    status:
      rows.length === 0 ||
      rows.some((row) => row.status === "insufficient_evidence")
        ? "insufficient_evidence"
        : rows.some((row) => row.status === "degraded")
          ? "degraded"
          : rows.some((row) => row.status === "warning")
            ? "warning"
            : "healthy",
    maps: rows,
  };
}

function main(args) {
  invariant(
    args.length === 2,
    "usage: coworld-map-monitor.mjs <map-contract.json> <evidence.json>",
  );
  const [contractPath, evidencePath] = args;
  const contract = readBoundedJsonFile(
    contractPath,
    MAP_MONITOR_LIMITS.contractBytes,
    "map contract",
  );
  const evidence = readBoundedJsonFile(
    evidencePath,
    MAP_MONITOR_LIMITS.evidenceBytes,
    "map evidence",
  );
  process.stdout.write(
    `${JSON.stringify(buildMapMonitoringReport(contract, evidence), null, 2)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
