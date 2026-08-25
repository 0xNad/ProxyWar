#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const COWORLD_ID =
  /^cow_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ROUND_STATUS = new Set(["pending", "running", "completed", "failed"]);
const EPISODE_STATUS = new Set(["pending", "running", "completed", "failed"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  invariant(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    `${label} has unexpected fields`,
  );
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

function contractIndex(contract) {
  invariant(
    contract?.schemaVersion === 1,
    "map contract schemaVersion must be 1",
  );
  invariant(
    Array.isArray(contract.competitionRungs),
    "map contract competitionRungs must be an array",
  );
  const byVariant = new Map();
  for (const rung of contract.competitionRungs) {
    boundedInteger(rung?.seats, "map contract seats", 1);
    invariant(
      Array.isArray(rung.variants) && rung.variants.length > 0,
      `map contract rung ${rung.seats} must contain variants`,
    );
    for (let index = 0; index < rung.variants.length; index += 1) {
      const variant = rung.variants[index];
      invariant(
        typeof variant?.id === "string" && !byVariant.has(variant.id),
        "map contract variant ids must be unique strings",
      );
      invariant(
        typeof variant.map === "string" && variant.map.length > 0,
        `${variant.id} must declare a map`,
      );
      boundedInteger(
        variant.episodeTimeoutSeconds,
        `${variant.id} episodeTimeoutSeconds`,
        1,
      );
      byVariant.set(variant.id, {
        id: variant.id,
        map: variant.map,
        seats: rung.seats,
        poolIndex: index,
        episodeTimeoutSeconds: variant.episodeTimeoutSeconds,
      });
    }
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
  invariant(Array.isArray(evidence.rounds), "evidence rounds must be an array");

  const summaries = new Map();
  const observedSeatCounts = new Set();
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
    boundedInteger(round.roundNumber, "roundNumber", 1);
    invariant(ROUND_STATUS.has(round.status), "round status is invalid");
    invariant(Array.isArray(round.episodes), "round episodes must be an array");
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
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  process.stdout.write(
    `${JSON.stringify(buildMapMonitoringReport(contract, evidence), null, 2)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
