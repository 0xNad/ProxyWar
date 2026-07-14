import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  buildCoworldEvaluationDataset,
  conciseCoworldDatasetSummary,
  type CoworldDatasetSelector,
  type CoworldEpisodeReportedTelemetry,
  type CoworldEvaluationDecision,
  type CoworldEvaluationEpisode,
  type CoworldEvaluationRosterSeat,
  type CoworldEvaluationSnapshot,
  type CoworldEvaluationSnapshotPlayer,
  type CoworldTelemetryPrimitive,
  type CoworldTreatmentMarker,
} from "../server/agents/CoworldEvaluationDataset";

export interface CoworldDatasetExporterOptions {
  inputPaths: string[];
  outputPath: string | null;
  selector: CoworldDatasetSelector;
  treatmentMarkers: CoworldTreatmentMarker[];
  spawnPhaseTurns: number | null;
  spawnSettleThreshold: number;
}

interface EpisodeFragment {
  episodeId: string;
  episodeIdIsExplicit: boolean;
  sourcePaths: string[];
  runID?: string | null;
  completedAt?: string | null;
  map?: string;
  mapSize?: string | null;
  scores?: number[];
  outrightWinnerSlot?: number | null;
  roster: CoworldEvaluationRosterSeat[];
  decisions: CoworldEvaluationDecision[];
  snapshots: CoworldEvaluationSnapshot[];
  episodeReportedTelemetry: Partial<CoworldEpisodeReportedTelemetry>;
}

export interface LoadedCoworldEvaluationEpisodes {
  episodes: CoworldEvaluationEpisode[];
  warnings: string[];
}

const usage =
  "Usage: npm run league:dataset-export -- <artifact-path>... " +
  "[--policy-version-id ID | --player-name NAME | --seat N] " +
  "[--treatment-marker ID=TEXT] [--spawn-phase-turns N] " +
  "[--spawn-settle-threshold 0..1] [--output FILE]";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asCount(value: unknown): number | null {
  const number = asNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0
    ? number
    : null;
}

function asSeat(value: unknown): number | null {
  return asCount(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const strings = value.map(asString);
  return strings.every((entry) => entry !== null) ? (strings as string[]) : [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const string = asString(value);
    if (string !== null) {
      return string;
    }
  }
  return null;
}

function primitiveRecord(
  value: unknown,
): Record<string, string | number | boolean | null> {
  const record = asRecord(value);
  if (record === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string | number | boolean | null] =>
        entry[1] === null ||
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    ),
  );
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} needs a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(
  value: string | undefined,
  flag: string,
): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} needs a non-negative integer`);
  }
  return parsed;
}

function parseUnitInterval(value: string | undefined, flag: string): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} needs a number from 0 through 1`);
  }
  return parsed;
}

function parseTreatmentMarker(
  argument: string | undefined,
): CoworldTreatmentMarker {
  const separator = argument?.indexOf("=") ?? -1;
  const id = separator < 1 ? "" : argument?.slice(0, separator).trim();
  const needle = separator < 1 ? "" : argument?.slice(separator + 1);
  if (!id || !needle || !/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error("--treatment-marker needs ID=TEXT with a safe ID");
  }
  return { id, needle };
}

export function parseCoworldDatasetExporterOptions(
  argv: string[],
): CoworldDatasetExporterOptions {
  const inputPaths: string[] = [];
  let outputPath: string | null = null;
  let seat: number | null = null;
  let policyVersionId: string | null = null;
  let playerName: string | null = null;
  let spawnPhaseTurns: number | null = null;
  let spawnSettleThreshold = 0.8;
  const treatmentMarkers: CoworldTreatmentMarker[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--output") {
      if (!value) throw new Error("--output needs a path");
      outputPath = value;
      index += 1;
    } else if (argument === "--seat") {
      seat = parseNonNegativeInteger(value, "--seat");
      index += 1;
    } else if (argument === "--policy-version-id") {
      if (!value) throw new Error("--policy-version-id needs a value");
      policyVersionId = value;
      index += 1;
    } else if (argument === "--player-name") {
      if (!value) throw new Error("--player-name needs a value");
      playerName = value;
      index += 1;
    } else if (argument === "--treatment-marker") {
      treatmentMarkers.push(parseTreatmentMarker(value));
      index += 1;
    } else if (argument === "--spawn-phase-turns") {
      spawnPhaseTurns = parsePositiveInteger(value, "--spawn-phase-turns");
      index += 1;
    } else if (argument === "--spawn-settle-threshold") {
      spawnSettleThreshold = parseUnitInterval(
        value,
        "--spawn-settle-threshold",
      );
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage);
      process.exit(0);
    } else if (argument.startsWith("-")) {
      throw new Error(usage);
    } else {
      inputPaths.push(argument);
    }
  }
  if (inputPaths.length === 0) {
    throw new Error(usage);
  }
  const selectorCount = [seat, policyVersionId, playerName].filter(
    (value) => value !== null,
  ).length;
  if (selectorCount > 1) {
    throw new Error(
      "--seat, --policy-version-id, and --player-name are mutually exclusive",
    );
  }
  if (
    new Set(treatmentMarkers.map((marker) => marker.id)).size !==
    treatmentMarkers.length
  ) {
    throw new Error("Treatment marker IDs must be unique");
  }
  return {
    inputPaths,
    outputPath,
    selector: { seat, policyVersionId, playerName },
    treatmentMarkers,
    spawnPhaseTurns,
    spawnSettleThreshold,
  };
}

function oneHotWinnerSlot(scores: readonly number[]): number | null {
  const winners = scores.flatMap((score, slot) => (score === 1 ? [slot] : []));
  return winners.length === 1 &&
    scores.every((score) => score === 0 || score === 1)
    ? winners[0]
    : null;
}

function participantRoster(
  entry: Record<string, unknown>,
  sourcePath: string,
): CoworldEvaluationRosterSeat[] {
  if (!Object.hasOwn(entry, "participants")) {
    return [];
  }
  if (!Array.isArray(entry.participants)) {
    throw new Error(`${sourcePath} has invalid participants`);
  }
  const participants = entry.participants.map((value, index) => {
    const record = asRecord(value);
    if (record === null) {
      throw new Error(
        `${sourcePath} participant ${index + 1} is not an object`,
      );
    }
    const rawPosition = record.position;
    const position = rawPosition === undefined ? null : asSeat(rawPosition);
    if (rawPosition !== undefined && position === null) {
      throw new Error(
        `${sourcePath} participant ${index + 1} has invalid position`,
      );
    }
    return { record, index, position };
  });
  const positioned = participants.filter(({ position }) => position !== null);
  if (positioned.length !== 0 && positioned.length !== participants.length) {
    throw new Error(
      `${sourcePath} participants mix positioned and unpositioned entries`,
    );
  }
  let positionBase = 0;
  if (positioned.length > 0) {
    const positions = positioned
      .map(({ position }) => position as number)
      .sort((left, right) => left - right);
    const zeroBased = positions.every((position, index) => position === index);
    const oneBased = positions.every(
      (position, index) => position === index + 1,
    );
    if (!zeroBased && !oneBased) {
      throw new Error(
        `${sourcePath} participant positions must be contiguous and zero- or one-based`,
      );
    }
    positionBase = oneBased ? 1 : 0;
  }
  return participants
    .map(({ record, index, position }) => ({
      seat: (position ?? index) - positionBase,
      policyVersionId: asString(record.policy_version_id),
      playerName: asString(record.player_name),
      label: asString(record.label),
      agentID: null,
    }))
    .sort((left, right) => left.seat - right.seat);
}

function policyVersionIds(
  entry: Record<string, unknown>,
  participants: readonly CoworldEvaluationRosterSeat[],
  sourcePath: string,
): string[] {
  if (
    Object.hasOwn(entry, "policy_version_ids") &&
    (!Array.isArray(entry.policy_version_ids) ||
      entry.policy_version_ids.length === 0 ||
      entry.policy_version_ids.some((value) => asString(value) === null))
  ) {
    throw new Error(`${sourcePath} has invalid policy_version_ids`);
  }
  const direct = asStringArray(entry.policy_version_ids);
  if (direct.length > 0) {
    for (const participant of participants) {
      const directPolicy = direct[participant.seat];
      if (
        directPolicy !== undefined &&
        participant.policyVersionId !== null &&
        directPolicy !== participant.policyVersionId
      ) {
        throw new Error(
          `${sourcePath} has conflicting policy IDs for seat ${participant.seat}`,
        );
      }
    }
    return direct;
  }
  if (
    Object.hasOwn(entry, "policy_versions") &&
    !Array.isArray(entry.policy_versions)
  ) {
    throw new Error(`${sourcePath} has invalid policy_versions`);
  }
  if (Array.isArray(entry.policy_versions)) {
    const values = entry.policy_versions.map((value) => {
      const record = asRecord(value);
      return firstString(record?.policy_version_id, record?.id);
    });
    if (values.every((value) => value !== null)) {
      return values as string[];
    }
  }
  if (Object.hasOwn(entry, "roster") && !Array.isArray(entry.roster)) {
    throw new Error(`${sourcePath} has invalid roster`);
  }
  if (Array.isArray(entry.roster)) {
    const values = entry.roster.map((value) => {
      const record = asRecord(value);
      const player = asRecord(record?.player);
      return firstString(
        record?.policy_version_id,
        record?.policy_ref,
        player?.policy_version_id,
        player?.policy_ref,
      );
    });
    if (values.length > 0 && values.every((value) => value !== null)) {
      return values as string[];
    }
  }
  if (
    participants.length > 0 &&
    participants.every((entry) => entry.policyVersionId !== null)
  ) {
    return participants.map((entry) => entry.policyVersionId as string);
  }
  return [];
}

function parseScores(
  raw: unknown,
  entry: Record<string, unknown>,
  participants: readonly CoworldEvaluationRosterSeat[],
  sourcePath: string,
): number[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${sourcePath} has invalid scores`);
  }
  if (raw.every((score) => asNumber(score) !== null)) {
    return raw as number[];
  }
  const pairs = raw.map((value) => {
    const record = asRecord(value);
    const policyVersionId = asString(record?.policy_version_id);
    const score = asNumber(record?.score);
    if (policyVersionId === null || score === null) {
      throw new Error(`${sourcePath} contains an invalid score entry`);
    }
    return { policyVersionId, score };
  });
  const order = policyVersionIds(entry, participants, sourcePath);
  if (order.length !== pairs.length) {
    return pairs.map((pair) => pair.score);
  }
  const byPolicy = new Map<string, number[]>();
  for (const pair of pairs) {
    const scores = byPolicy.get(pair.policyVersionId) ?? [];
    scores.push(pair.score);
    byPolicy.set(pair.policyVersionId, scores);
  }
  return order.map((policyVersionId) => {
    const score = byPolicy.get(policyVersionId)?.shift();
    if (score === undefined) {
      throw new Error(`${sourcePath} is missing a repeated-policy seat score`);
    }
    return score;
  });
}

function parseJsonArtifact(
  value: unknown,
  sourcePath: string,
  artifactName: string,
): Record<string, unknown> | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${sourcePath} contains invalid ${artifactName}`);
  }
  try {
    const parsed = asRecord(JSON.parse(value));
    if (parsed === null) {
      throw new Error(`${sourcePath} contains non-object ${artifactName}`);
    }
    return parsed;
  } catch {
    throw new Error(`${sourcePath} contains invalid ${artifactName}`);
  }
}

function parseDecisionRows(
  entry: Record<string, unknown>,
  sourcePath: string,
): Record<string, unknown>[] {
  if (Array.isArray(entry.decisions)) {
    return entry.decisions.map((value, index) => {
      const record = asRecord(value);
      if (record === null) {
        throw new Error(`${sourcePath} decision ${index + 1} is not an object`);
      }
      return record;
    });
  }
  if (
    Object.hasOwn(entry, "decisions") &&
    typeof entry.decisions !== "string"
  ) {
    throw new Error(`${sourcePath} has invalid decisions`);
  }
  const inline = asRecord(entry.inlineRunArtifacts);
  const raw =
    typeof entry.decisions === "string"
      ? entry.decisions
      : inline?.["decisions.jsonl"];
  if (typeof raw !== "string" || raw.trim() === "") {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const record = asRecord(JSON.parse(line));
      if (record === null) {
        throw new Error(
          `${sourcePath} decision line ${index + 1} is not an object`,
        );
      }
      rows.push(record);
    } catch {
      throw new Error(
        `${sourcePath} contains invalid decision line ${index + 1}`,
      );
    }
  }
  return rows;
}

function rosterSeats(input: {
  entry: Record<string, unknown>;
  results: Record<string, unknown> | null;
  spectator: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  scores: readonly number[] | undefined;
  participants: readonly CoworldEvaluationRosterSeat[];
  sourcePath: string;
}): CoworldEvaluationRosterSeat[] {
  const versionIds = policyVersionIds(
    input.entry,
    input.participants,
    input.sourcePath,
  );
  const resultPlayers = Array.isArray(input.results?.players)
    ? input.results.players
    : [];
  const config = asRecord(input.entry.config);
  const configPlayers = Array.isArray(config?.players) ? config.players : [];
  const spectatorRoster = Array.isArray(input.spectator?.roster)
    ? input.spectator.roster
    : [];
  const summaryRoster = Array.isArray(input.summary?.roster)
    ? input.summary.roster
    : [];
  const seatCount = Math.max(
    input.scores?.length ?? 0,
    versionIds.length,
    resultPlayers.length,
    configPlayers.length,
    spectatorRoster.length,
    summaryRoster.length,
    input.participants.length,
  );
  return Array.from({ length: seatCount }, (_, seat) => {
    const resultPlayer = asRecord(resultPlayers[seat]);
    const resultSlot = asSeat(resultPlayer?.slot);
    const slottedResult =
      resultSlot === null
        ? resultPlayer
        : asRecord(
            resultPlayers.find(
              (value) => asSeat(asRecord(value)?.slot) === seat,
            ),
          );
    const configPlayer = asRecord(configPlayers[seat]);
    const spectatorPlayer = asRecord(spectatorRoster[seat]);
    const summaryPlayer = asRecord(summaryRoster[seat]);
    const participant = input.participants.find((entry) => entry.seat === seat);
    const mergeIdentity = (
      field: string,
      values: Array<string | null>,
    ): string | null => {
      const present = [...new Set(values.filter((value) => value !== null))];
      if (present.length > 1) {
        throw new Error(
          `${input.sourcePath} has conflicting roster ${field} for seat ${seat}`,
        );
      }
      return present[0] ?? null;
    };
    return {
      seat,
      policyVersionId: mergeIdentity("policyVersionId", [
        versionIds[seat] ?? null,
        participant?.policyVersionId ?? null,
      ]),
      playerName: mergeIdentity("playerName", [
        participant?.playerName ?? null,
        firstString(slottedResult?.name, slottedResult?.username),
        firstString(configPlayer?.name, configPlayer?.username),
        firstString(spectatorPlayer?.username, spectatorPlayer?.name),
        firstString(summaryPlayer?.username, summaryPlayer?.name),
      ]),
      label: participant?.label ?? null,
      agentID: mergeIdentity("agentID", [
        firstString(spectatorPlayer?.agentID, spectatorPlayer?.agent_id),
        firstString(summaryPlayer?.agentID, summaryPlayer?.agent_id),
      ]),
    };
  });
}

function episodeIdentifier(
  entry: Record<string, unknown>,
  fallbackId: string,
): { id: string; explicit: boolean } {
  const explicit = firstString(
    entry.episode_request_id,
    entry.episodeRequestId,
    entry.id,
  );
  return explicit === null
    ? { id: fallbackId, explicit: fallbackId.startsWith("ereq_") }
    : { id: explicit, explicit: true };
}

function parseEpisodeFragment(input: {
  value: unknown;
  sourcePath: string;
  fallbackId: string;
  warnings: string[];
}): EpisodeFragment | null {
  const entry = asRecord(input.value);
  if (entry === null) {
    return null;
  }
  const participants = participantRoster(entry, input.sourcePath);
  const results =
    asRecord(entry.results) ?? (Array.isArray(entry.scores) ? entry : null);
  if (Object.hasOwn(entry, "results") && asRecord(entry.results) === null) {
    throw new Error(`${input.sourcePath} has invalid results`);
  }
  const scores = parseScores(
    results?.scores,
    entry,
    participants,
    input.sourcePath,
  );
  const episodeIdentifierResult = episodeIdentifier(entry, input.fallbackId);
  const episodeId = episodeIdentifierResult.id;
  const hasEpisodeIdentity =
    firstString(entry.episode_request_id, entry.episodeRequestId, entry.id) !==
      null ||
    scores !== undefined ||
    asString(entry.runID) !== null;
  if (!hasEpisodeIdentity) {
    return null;
  }
  const inline = asRecord(entry.inlineRunArtifacts);
  if (Object.hasOwn(entry, "inlineRunArtifacts") && inline === null) {
    throw new Error(`${input.sourcePath} has invalid inlineRunArtifacts`);
  }
  const summary = parseJsonArtifact(
    inline?.["match-summary.json"],
    input.sourcePath,
    "match-summary.json",
  );
  const spectator = asRecord(entry.spectatorReplay);
  if (Object.hasOwn(entry, "spectatorReplay") && spectator === null) {
    throw new Error(`${input.sourcePath} has invalid spectatorReplay`);
  }
  const gameConfig = asRecord(entry.game_config) ?? asRecord(entry.gameConfig);
  const config = asRecord(entry.config);
  const spectatorMap = asRecord(spectator?.map);
  const runnerConfig = asRecord(summary?.runnerConfig);
  const map = firstString(
    entry.map,
    gameConfig?.map,
    config?.map,
    spectatorMap?.gameMap,
    runnerConfig?.map,
  );
  const mapSize = firstString(
    entry.map_size,
    gameConfig?.map_size,
    config?.map_size,
    config?.mapSize,
    spectatorMap?.gameMapSize,
    runnerConfig?.mapSize,
  );
  const winnerSlotPresent =
    results !== null && Object.hasOwn(results, "winner_slot");
  const winnerSlot = asSeat(results?.winner_slot);
  if (
    winnerSlotPresent &&
    results?.winner_slot !== null &&
    winnerSlot === null
  ) {
    throw new Error(`${input.sourcePath} has an invalid winner_slot`);
  }
  const roster = rosterSeats({
    entry,
    results,
    spectator,
    summary,
    scores,
    participants,
    sourcePath: input.sourcePath,
  });
  const rawDecisions = parseDecisionRows(entry, input.sourcePath);
  if (
    spectator !== null &&
    Object.hasOwn(spectator, "snapshots") &&
    !Array.isArray(spectator.snapshots)
  ) {
    throw new Error(`${input.sourcePath} has invalid spectator snapshots`);
  }
  const rawSnapshots = Array.isArray(spectator?.snapshots)
    ? spectator.snapshots.map((value, index) => {
        const record = asRecord(value);
        if (record === null) {
          throw new Error(
            `${input.sourcePath} snapshot ${index + 1} is not an object`,
          );
        }
        return record;
      })
    : [];
  return {
    episodeId,
    episodeIdIsExplicit: episodeIdentifierResult.explicit,
    sourcePaths: [input.sourcePath],
    runID: firstString(entry.runID, summary?.runID),
    completedAt: firstString(
      entry.completed_at,
      entry.completedAt,
      summary?.completedAt,
    ),
    map: map ?? "Unknown map",
    mapSize,
    scores,
    outrightWinnerSlot:
      scores === undefined
        ? undefined
        : winnerSlotPresent
          ? winnerSlot
          : oneHotWinnerSlot(scores),
    roster,
    decisions: rawDecisions.map((record) => normalizeDecision(record, roster)),
    snapshots: rawSnapshots.map((record) => normalizeSnapshot(record, roster)),
    episodeReportedTelemetry: {
      decisionCount:
        asCount(results?.decision_count) ?? asCount(summary?.decisionCount),
      fallbackCount:
        asCount(results?.fallback_count) ?? asCount(summary?.fallbackCount),
      degradedCount:
        asCount(results?.degraded_count) ?? asCount(summary?.degradedCount),
      parseFailureCount: asCount(summary?.parseFailureCount),
    },
  };
}

export function parseCoworldEvaluationDocument(input: {
  value: unknown;
  sourcePath: string;
  fallbackId: string;
  warnings?: string[];
}): EpisodeFragment[] {
  const warnings = input.warnings ?? [];
  const root = asRecord(input.value);
  if (!Array.isArray(input.value) && root === null) {
    throw new Error(`${input.sourcePath} is not a JSON object or array`);
  }
  if (
    root !== null &&
    Object.hasOwn(root, "episodes") &&
    !Array.isArray(root.episodes)
  ) {
    throw new Error(`${input.sourcePath} has invalid episodes`);
  }
  if (
    root !== null &&
    Object.hasOwn(root, "entries") &&
    !Array.isArray(root.entries)
  ) {
    throw new Error(`${input.sourcePath} has invalid entries`);
  }
  const entries = Array.isArray(input.value)
    ? input.value
    : Array.isArray(root?.episodes)
      ? root.episodes
      : Array.isArray(root?.entries)
        ? root.entries
        : [input.value];
  return entries.flatMap((value, index) => {
    if (asRecord(value) === null) {
      throw new Error(
        `${input.sourcePath} entry ${index + 1} is not an object`,
      );
    }
    const fragment = parseEpisodeFragment({
      value,
      sourcePath: input.sourcePath,
      fallbackId:
        entries.length === 1
          ? input.fallbackId
          : `${input.fallbackId}:${index}`,
      warnings,
    });
    return fragment === null ? [] : [fragment];
  });
}

function mergeRoster(
  current: readonly CoworldEvaluationRosterSeat[],
  incoming: readonly CoworldEvaluationRosterSeat[],
  episodeId: string,
): CoworldEvaluationRosterSeat[] {
  const seatCount = Math.max(current.length, incoming.length);
  return Array.from({ length: seatCount }, (_, seat) => {
    const left = current.find((entry) => entry.seat === seat);
    const right = incoming.find((entry) => entry.seat === seat);
    return {
      seat,
      policyVersionId: mergeNullable(
        episodeId,
        `roster seat ${seat} policyVersionId`,
        left?.policyVersionId,
        right?.policyVersionId,
      ),
      playerName: mergeNullable(
        episodeId,
        `roster seat ${seat} playerName`,
        left?.playerName,
        right?.playerName,
      ),
      label: mergeNullable(
        episodeId,
        `roster seat ${seat} label`,
        left?.label,
        right?.label,
      ),
      agentID: mergeNullable(
        episodeId,
        `roster seat ${seat} agentID`,
        left?.agentID,
        right?.agentID,
      ),
    };
  });
}

function mergeOptional<T>(
  episodeId: string,
  field: string,
  left: T | undefined,
  right: T | undefined,
): T | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (!isDeepStrictEqual(left, right)) {
    throw new Error(`Conflicting ${field} for episode ${episodeId}`);
  }
  return left;
}

function mergeNullable<T>(
  episodeId: string,
  field: string,
  left: T | null | undefined,
  right: T | null | undefined,
): T | null {
  const merged = mergeOptional(
    episodeId,
    field,
    left ?? undefined,
    right ?? undefined,
  );
  return merged ?? null;
}

function mergePrimitiveRecord(
  episodeId: string,
  field: string,
  left: Readonly<Record<string, CoworldTelemetryPrimitive>>,
  right: Readonly<Record<string, CoworldTelemetryPrimitive>>,
): Record<string, CoworldTelemetryPrimitive> {
  const merged: Record<string, CoworldTelemetryPrimitive> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (Object.hasOwn(merged, key) && merged[key] !== value) {
      throw new Error(`Conflicting ${field}.${key} for episode ${episodeId}`);
    }
    merged[key] = value;
  }
  return merged;
}

function decisionsMatch(
  left: CoworldEvaluationDecision,
  right: CoworldEvaluationDecision,
): boolean {
  if (isDeepStrictEqual(left, right)) return true;
  if (left.turnNumber === null || left.turnNumber !== right.turnNumber) {
    return false;
  }
  if (left.seat !== null && right.seat !== null) {
    return left.seat === right.seat;
  }
  if (left.agentID !== null && right.agentID !== null) {
    return left.agentID === right.agentID;
  }
  if (left.playerName !== null && right.playerName !== null) {
    return left.playerName === right.playerName;
  }
  return false;
}

function mergeDecision(
  episodeId: string,
  left: CoworldEvaluationDecision,
  right: CoworldEvaluationDecision,
): CoworldEvaluationDecision {
  const actionKind = mergeNullable(
    episodeId,
    `decision turn ${left.turnNumber ?? "unknown"} actionKind`,
    left.actionKind === "unknown" ? null : left.actionKind,
    right.actionKind === "unknown" ? null : right.actionKind,
  );
  const reason = mergeNullable(
    episodeId,
    `decision turn ${left.turnNumber ?? "unknown"} reason`,
    left.reason === "" ? null : left.reason,
    right.reason === "" ? null : right.reason,
  );
  return {
    seat: mergeNullable(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} seat`,
      left.seat,
      right.seat,
    ),
    playerName: mergeNullable(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} playerName`,
      left.playerName,
      right.playerName,
    ),
    agentID: mergeNullable(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} agentID`,
      left.agentID,
      right.agentID,
    ),
    turnNumber: mergeNullable(
      episodeId,
      "decision turnNumber",
      left.turnNumber,
      right.turnNumber,
    ),
    selectedLegalActionId: mergeNullable(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} selectedLegalActionId`,
      left.selectedLegalActionId,
      right.selectedLegalActionId,
    ),
    actionKind: actionKind ?? "unknown",
    attackTargetType: mergeNullable(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} attackTargetType`,
      left.attackTargetType,
      right.attackTargetType,
    ),
    reason: reason ?? "",
    selectedActionMetadata: mergePrimitiveRecord(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} selectedActionMetadata`,
      left.selectedActionMetadata,
      right.selectedActionMetadata,
    ),
    fallback: mergeNullable(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} fallback`,
      left.fallback,
      right.fallback,
    ),
    degraded: mergeNullable(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} degraded`,
      left.degraded,
      right.degraded,
    ),
    parseFailure: mergeNullable(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} parseFailure`,
      left.parseFailure,
      right.parseFailure,
    ),
    wireDroppedFollowupCount: mergeNullable(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} wireDroppedFollowupCount`,
      left.wireDroppedFollowupCount,
      right.wireDroppedFollowupCount,
    ),
    multiAction: mergeNullable(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} multiAction`,
      left.multiAction,
      right.multiAction,
    ),
    commanderTelemetry: mergePrimitiveRecord(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} commanderTelemetry`,
      left.commanderTelemetry,
      right.commanderTelemetry,
    ),
    explicitTreatmentMarkers: [
      ...new Set([
        ...left.explicitTreatmentMarkers,
        ...right.explicitTreatmentMarkers,
      ]),
    ].sort(),
    searchableText:
      left.searchableText === right.searchableText
        ? left.searchableText
        : `${left.searchableText}\n${right.searchableText}`,
  };
}

function mergeDecisions(
  episodeId: string,
  current: readonly CoworldEvaluationDecision[],
  incoming: readonly CoworldEvaluationDecision[],
): CoworldEvaluationDecision[] {
  const merged = [...current];
  for (const decision of incoming) {
    const matchingIndexes = merged.flatMap((candidate, index) =>
      decisionsMatch(candidate, decision) ? [index] : [],
    );
    if (matchingIndexes.length > 1) {
      throw new Error(`Ambiguous decision identity for episode ${episodeId}`);
    }
    if (matchingIndexes.length === 0) {
      merged.push(decision);
    } else {
      merged[matchingIndexes[0]] = mergeDecision(
        episodeId,
        merged[matchingIndexes[0]],
        decision,
      );
    }
  }
  return merged.sort(
    (left, right) =>
      (left.turnNumber ?? Number.MAX_SAFE_INTEGER) -
        (right.turnNumber ?? Number.MAX_SAFE_INTEGER) ||
      (left.seat ?? Number.MAX_SAFE_INTEGER) -
        (right.seat ?? Number.MAX_SAFE_INTEGER),
  );
}

function snapshotPlayersMatch(
  left: CoworldEvaluationSnapshotPlayer,
  right: CoworldEvaluationSnapshotPlayer,
): boolean {
  if (isDeepStrictEqual(left, right)) return true;
  if (left.seat !== null && right.seat !== null)
    return left.seat === right.seat;
  if (left.agentID !== null && right.agentID !== null) {
    return left.agentID === right.agentID;
  }
  return (
    left.playerName !== null &&
    right.playerName !== null &&
    left.playerName === right.playerName
  );
}

function mergeSnapshotPlayer(
  episodeId: string,
  label: string,
  left: CoworldEvaluationSnapshotPlayer,
  right: CoworldEvaluationSnapshotPlayer,
): CoworldEvaluationSnapshotPlayer {
  const merge = <T>(
    field: string,
    leftValue: T | null,
    rightValue: T | null,
  ): T | null =>
    mergeNullable(
      episodeId,
      `snapshot ${label} player ${field}`,
      leftValue,
      rightValue,
    );
  return {
    seat: merge("seat", left.seat, right.seat),
    playerName: merge("playerName", left.playerName, right.playerName),
    agentID: merge("agentID", left.agentID, right.agentID),
    tilesOwned: merge("tilesOwned", left.tilesOwned, right.tilesOwned),
    troops: merge("troops", left.troops, right.troops),
    gold: merge("gold", left.gold, right.gold),
    isAlive: merge("isAlive", left.isAlive, right.isAlive),
    hasSpawned: merge("hasSpawned", left.hasSpawned, right.hasSpawned),
  };
}

function snapshotsMatch(
  left: CoworldEvaluationSnapshot,
  right: CoworldEvaluationSnapshot,
): boolean {
  if (isDeepStrictEqual(left, right)) return true;
  const sharedTurn =
    left.turnNumber !== null && left.turnNumber === right.turnNumber;
  const sharedTick = left.tick !== null && left.tick === right.tick;
  if (sharedTurn || sharedTick) return true;
  return (
    left.turnNumber === null &&
    right.turnNumber === null &&
    left.tick === null &&
    right.tick === null &&
    left.label === right.label &&
    left.phase === right.phase
  );
}

function mergeSnapshots(
  episodeId: string,
  current: readonly CoworldEvaluationSnapshot[],
  incoming: readonly CoworldEvaluationSnapshot[],
): CoworldEvaluationSnapshot[] {
  const merged = current.map((snapshot) => ({
    ...snapshot,
    players: [...snapshot.players],
  }));
  for (const snapshot of incoming) {
    const existingIndex = merged.findIndex((candidate) =>
      snapshotsMatch(candidate, snapshot),
    );
    if (existingIndex < 0) {
      merged.push(snapshot);
      continue;
    }
    const existing = merged[existingIndex];
    const label = mergeNullable(
      episodeId,
      "snapshot label",
      existing.label === "snapshot" ? null : existing.label,
      snapshot.label === "snapshot" ? null : snapshot.label,
    );
    const phase = mergeNullable(
      episodeId,
      `snapshot ${label ?? "snapshot"} phase`,
      existing.phase === "unknown" ? null : existing.phase,
      snapshot.phase === "unknown" ? null : snapshot.phase,
    );
    existing.label = label ?? "snapshot";
    existing.phase = phase ?? "unknown";
    existing.turnNumber = mergeNullable(
      episodeId,
      `snapshot ${existing.label} turnNumber`,
      existing.turnNumber,
      snapshot.turnNumber,
    );
    existing.tick = mergeNullable(
      episodeId,
      `snapshot ${existing.label} tick`,
      existing.tick,
      snapshot.tick,
    );
    for (const player of snapshot.players) {
      const playerIndexes = existing.players.flatMap((candidate, index) =>
        snapshotPlayersMatch(candidate, player) ? [index] : [],
      );
      if (playerIndexes.length > 1) {
        throw new Error(`Ambiguous snapshot player for episode ${episodeId}`);
      }
      if (playerIndexes.length === 0) {
        existing.players.push(player);
      } else {
        existing.players[playerIndexes[0]] = mergeSnapshotPlayer(
          episodeId,
          snapshot.label,
          existing.players[playerIndexes[0]],
          player,
        );
      }
    }
  }
  return merged.sort(
    (left, right) =>
      (left.turnNumber ?? Number.MAX_SAFE_INTEGER) -
        (right.turnNumber ?? Number.MAX_SAFE_INTEGER) ||
      (left.tick ?? Number.MAX_SAFE_INTEGER) -
        (right.tick ?? Number.MAX_SAFE_INTEGER) ||
      left.label.localeCompare(right.label),
  );
}

function mergeFragment(
  current: EpisodeFragment,
  incoming: EpisodeFragment,
): EpisodeFragment {
  if (
    current.episodeIdIsExplicit &&
    incoming.episodeIdIsExplicit &&
    current.episodeId !== incoming.episodeId
  ) {
    throw new Error(
      `Conflicting episode IDs ${current.episodeId} and ${incoming.episodeId}`,
    );
  }
  const episodeId = current.episodeIdIsExplicit
    ? current.episodeId
    : incoming.episodeId;
  const currentMap = current.map === "Unknown map" ? undefined : current.map;
  const incomingMap = incoming.map === "Unknown map" ? undefined : incoming.map;
  return {
    episodeId,
    episodeIdIsExplicit:
      current.episodeIdIsExplicit || incoming.episodeIdIsExplicit,
    sourcePaths: [
      ...new Set([...current.sourcePaths, ...incoming.sourcePaths]),
    ],
    runID: mergeNullable(episodeId, "runID", current.runID, incoming.runID),
    completedAt: mergeNullable(
      episodeId,
      "completedAt",
      current.completedAt,
      incoming.completedAt,
    ),
    map:
      mergeOptional(episodeId, "map", currentMap, incomingMap) ?? "Unknown map",
    mapSize: mergeNullable(
      episodeId,
      "mapSize",
      current.mapSize,
      incoming.mapSize,
    ),
    scores: mergeOptional(episodeId, "scores", current.scores, incoming.scores),
    outrightWinnerSlot: mergeOptional(
      episodeId,
      "outrightWinnerSlot",
      current.outrightWinnerSlot,
      incoming.outrightWinnerSlot,
    ),
    roster: mergeRoster(current.roster, incoming.roster, episodeId),
    decisions: mergeDecisions(episodeId, current.decisions, incoming.decisions),
    snapshots: mergeSnapshots(episodeId, current.snapshots, incoming.snapshots),
    episodeReportedTelemetry: {
      decisionCount: mergeOptional(
        episodeId,
        "reported decisionCount",
        current.episodeReportedTelemetry.decisionCount ?? undefined,
        incoming.episodeReportedTelemetry.decisionCount ?? undefined,
      ),
      fallbackCount: mergeOptional(
        episodeId,
        "reported fallbackCount",
        current.episodeReportedTelemetry.fallbackCount ?? undefined,
        incoming.episodeReportedTelemetry.fallbackCount ?? undefined,
      ),
      degradedCount: mergeOptional(
        episodeId,
        "reported degradedCount",
        current.episodeReportedTelemetry.degradedCount ?? undefined,
        incoming.episodeReportedTelemetry.degradedCount ?? undefined,
      ),
      parseFailureCount: mergeOptional(
        episodeId,
        "reported parseFailureCount",
        current.episodeReportedTelemetry.parseFailureCount ?? undefined,
        incoming.episodeReportedTelemetry.parseFailureCount ?? undefined,
      ),
    },
  };
}

function consistentBoolean(
  field: string,
  values: readonly boolean[],
): boolean | null {
  if (values.length === 0) return null;
  if (values.some((value) => value !== values[0])) {
    throw new Error(`Conflicting ${field} decision telemetry`);
  }
  return values[0];
}

function booleanFields(
  record: Record<string, unknown>,
  field: string,
  keys: readonly string[],
): boolean[] {
  return keys.flatMap((key) => {
    if (!Object.hasOwn(record, key)) return [];
    const value = record[key];
    if (typeof value !== "boolean") {
      throw new Error(`Invalid ${field} decision telemetry`);
    }
    return [value];
  });
}

function embeddedDegraded(record: Record<string, unknown>): boolean | null {
  const values = booleanFields(record, "degraded", [
    "llmPlannerDegraded",
    "llm_planner_degraded",
    "degraded",
  ]);
  const metadata = asRecord(record.decisionMetadata);
  if (metadata !== null) {
    values.push(...booleanFields(metadata, "degraded", ["llmPlannerDegraded"]));
  }
  const raw = record.rawLlmOutput;
  if (typeof raw !== "string" || raw.trim() === "") {
    return consistentBoolean("degraded", values);
  }
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (parsed !== null) {
      values.push(...booleanFields(parsed, "degraded", ["llmPlannerDegraded"]));
    }
  } catch {
    // A malformed provider payload says nothing about the degradation signal.
  }
  return consistentBoolean("degraded", values);
}

function isTelemetryPrimitive(
  value: unknown,
): value is CoworldTelemetryPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function commanderTelemetry(
  record: Record<string, unknown>,
): Record<string, CoworldTelemetryPrimitive> {
  const telemetry: Record<string, CoworldTelemetryPrimitive> = {};
  const capture = (source: Record<string, unknown> | null): void => {
    if (source === null) {
      return;
    }
    const nested = asRecord(source.commanderTelemetry);
    for (const [key, value] of Object.entries(nested ?? {})) {
      if (isTelemetryPrimitive(value)) {
        telemetry[key] = value;
      }
    }
    for (const [key, value] of Object.entries(source)) {
      if (/^commander/i.test(key) && isTelemetryPrimitive(value)) {
        telemetry[key] = value;
      }
    }
  };
  const raw = record.rawLlmOutput;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      capture(asRecord(JSON.parse(raw)));
    } catch {
      // Parse health is reported separately; malformed output has no telemetry.
    }
  }
  capture(record);
  return Object.fromEntries(
    Object.entries(telemetry).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function attackTargetType(
  actionKind: string,
  record: Record<string, unknown>,
): CoworldEvaluationDecision["attackTargetType"] {
  if (actionKind !== "attack") {
    return null;
  }
  const metadata = asRecord(record.selectedActionMetadata);
  const targetID = metadata?.targetID;
  const targetName = asString(metadata?.targetName);
  if (
    metadata?.expansion === true ||
    metadata?.isNeutral === true ||
    metadata?.targetType === "neutral" ||
    (targetName !== null && /terra nullius/i.test(targetName))
  ) {
    return "neutral";
  }
  if (asString(targetID) !== null || targetName !== null) {
    return "hostile";
  }
  return "unknown";
}

function explicitTreatmentMarkers(record: Record<string, unknown>): string[] {
  const metadata = asRecord(record.selectedActionMetadata);
  return [
    ...asStringArray(record.treatmentMarkers),
    ...asStringArray(metadata?.treatmentMarkers),
    firstString(record.treatmentMarker),
    firstString(metadata?.treatmentMarker),
  ].filter((value): value is string => value !== null);
}

function wireDroppedFollowupCount(
  record: Record<string, unknown>,
): number | null {
  const metadata = asRecord(record.selectedActionMetadata);
  const explicitSources: Array<[Record<string, unknown> | null, string]> = [
    [record, "wireDroppedFollowupCount"],
    [record, "wire_dropped_followup_count"],
    [record, "droppedFollowupCount"],
    [metadata, "wireDroppedFollowupCount"],
  ];
  const explicitValues = explicitSources.flatMap(([source, key]) => {
    if (source === null || !Object.hasOwn(source, key)) return [];
    const value = asCount(source[key]);
    if (value === null) {
      throw new Error("Invalid wireDroppedFollowupCount decision telemetry");
    }
    return [value];
  });
  if (explicitValues.some((value) => value !== explicitValues[0])) {
    throw new Error("Conflicting wireDroppedFollowupCount decision telemetry");
  }
  if (explicitValues.length > 0) {
    return explicitValues[0];
  }
  const hasBatchActionIDs = Object.hasOwn(record, "batchActionIDs");
  if (hasBatchActionIDs && !Array.isArray(record.batchActionIDs)) {
    throw new Error("Invalid batchActionIDs decision telemetry");
  }
  if (
    Array.isArray(record.batchActionIDs) &&
    record.batchActionIDs.length > 1
  ) {
    return record.batchActionIDs.length - 1;
  }
  const reason = asString(record.reason) ?? "";
  const wireMarker = reason.match(
    /\b(\d+)\s+batched follow-up\(s\) not executed\b/i,
  );
  if (wireMarker !== null) {
    return Number(wireMarker[1]);
  }
  if (!/wire carries primary only/i.test(reason)) {
    return null;
  }
  const queueMarker = reason.match(/\bqueued\s+(\d+)\s+action\(s\)/i);
  if (queueMarker !== null) {
    return Math.max(0, Number(queueMarker[1]) - 1);
  }
  return hasBatchActionIDs ? 0 : null;
}

function matchingSeat(
  record: Record<string, unknown>,
  roster: readonly CoworldEvaluationRosterSeat[],
): number | null {
  const direct =
    asSeat(record.seat) ?? asSeat(record.slot) ?? asSeat(record.policy_slot);
  if (direct !== null) {
    return direct;
  }
  const playerName = firstString(
    record.username,
    record.playerName,
    record.name,
  );
  const agentID = firstString(record.agentID, record.agent_id);
  const matches = roster.filter(
    (entry) =>
      (agentID !== null && entry.agentID === agentID) ||
      (playerName !== null && entry.playerName === playerName),
  );
  return matches.length === 1 ? matches[0].seat : null;
}

function normalizeDecision(
  record: Record<string, unknown>,
  roster: readonly CoworldEvaluationRosterSeat[],
): CoworldEvaluationDecision {
  const playerName = firstString(
    record.username,
    record.playerName,
    record.name,
  );
  const agentID = firstString(record.agentID, record.agent_id);
  const droppedFollowups = wireDroppedFollowupCount(record);
  const actionKind =
    firstString(record.selectedActionKind, record.selected_action_kind) ??
    "unknown";
  const fallback = consistentBoolean(
    "fallback",
    booleanFields(record, "fallback", ["fallbackUsed", "fallback_used"]),
  );
  const parseFailureValues = booleanFields(record, "parse failure", [
    "parse_failure",
  ]);
  parseFailureValues.push(
    ...booleanFields(record, "parse success", [
      "parseSuccess",
      "plannerParseSuccess",
    ]).map((value) => !value),
  );
  const explicitMultiAction = consistentBoolean(
    "multiAction",
    booleanFields(record, "multiAction", ["multiAction", "multi_action"]),
  );
  const inferredMultiAction =
    droppedFollowups !== null && droppedFollowups > 0
      ? true
      : Array.isArray(record.batchActionIDs)
        ? record.batchActionIDs.length > 1
        : null;
  const multiAction = consistentBoolean(
    "multiAction",
    [explicitMultiAction, inferredMultiAction].filter(
      (value): value is boolean => value !== null,
    ),
  );
  return {
    seat: matchingSeat(record, roster),
    playerName,
    agentID,
    turnNumber: asCount(record.turnNumber ?? record.turn_number),
    selectedLegalActionId: firstString(
      record.selectedLegalActionId,
      record.selected_legal_action_id,
    ),
    actionKind,
    attackTargetType: attackTargetType(actionKind, record),
    reason: asString(record.reason) ?? "",
    selectedActionMetadata: primitiveRecord(record.selectedActionMetadata),
    fallback,
    degraded: embeddedDegraded(record),
    parseFailure: consistentBoolean("parse failure", parseFailureValues),
    wireDroppedFollowupCount: droppedFollowups,
    multiAction,
    commanderTelemetry: commanderTelemetry(record),
    explicitTreatmentMarkers: explicitTreatmentMarkers(record),
    searchableText: JSON.stringify({
      selectedLegalActionId: record.selectedLegalActionId,
      selectedActionKind: record.selectedActionKind,
      selectedActionMetadata: record.selectedActionMetadata,
      reason: record.reason,
      treatmentMarker: record.treatmentMarker,
      treatmentMarkers: record.treatmentMarkers,
    }),
  };
}

function normalizeSnapshotPlayer(input: {
  value: unknown;
  index: number;
  roster: readonly CoworldEvaluationRosterSeat[];
}): CoworldEvaluationSnapshotPlayer | null {
  const player = asRecord(input.value);
  if (player === null) {
    return null;
  }
  const playerName = firstString(player.username, player.name);
  const agentID = firstString(player.agentID, player.agent_id);
  const directSeat = asSeat(player.seat ?? player.slot);
  const matches = input.roster.filter(
    (entry) =>
      (agentID !== null && entry.agentID === agentID) ||
      (playerName !== null && entry.playerName === playerName),
  );
  const seat =
    directSeat ??
    (matches.length === 1
      ? matches[0].seat
      : input.index < input.roster.length
        ? input.index
        : null);
  const gold = player.gold;
  return {
    seat,
    playerName,
    agentID,
    tilesOwned: asNumber(player.tilesOwned ?? player.tiles_owned),
    troops: asNumber(player.troops),
    gold:
      typeof gold === "string" || typeof gold === "number"
        ? String(gold)
        : null,
    isAlive:
      typeof player.isAlive === "boolean"
        ? player.isAlive
        : typeof player.is_alive === "boolean"
          ? player.is_alive
          : null,
    hasSpawned:
      typeof player.hasSpawned === "boolean" ? player.hasSpawned : null,
  };
}

function normalizeSnapshot(
  record: Record<string, unknown>,
  roster: readonly CoworldEvaluationRosterSeat[],
): CoworldEvaluationSnapshot {
  return {
    label: asString(record.label) ?? "snapshot",
    turnNumber: asCount(record.turnNumber ?? record.turn_number),
    tick: asCount(record.tick),
    phase: asString(record.phase) ?? "unknown",
    players: Array.isArray(record.players)
      ? record.players.flatMap((value, index) => {
          const player = normalizeSnapshotPlayer({ value, index, roster });
          return player === null ? [] : [player];
        })
      : [],
  };
}

function normalizeEpisode(fragment: EpisodeFragment): CoworldEvaluationEpisode {
  if (fragment.scores === undefined || fragment.scores.length === 0) {
    throw new Error(`Episode ${fragment.episodeId} has no scores`);
  }
  if (!fragment.scores.every((score) => Number.isFinite(score))) {
    throw new Error(`Episode ${fragment.episodeId} has non-finite scores`);
  }
  const roster = mergeRoster(
    fragment.roster,
    fragment.scores.map((_, seat) => ({
      seat,
      policyVersionId: null,
      playerName: null,
      label: null,
      agentID: null,
    })),
    fragment.episodeId,
  );
  return {
    episodeId: fragment.episodeId,
    sourcePaths: fragment.sourcePaths,
    runID: fragment.runID ?? null,
    completedAt: fragment.completedAt ?? null,
    map: fragment.map ?? "Unknown map",
    mapSize: fragment.mapSize ?? null,
    scores: fragment.scores,
    outrightWinnerSlot: fragment.outrightWinnerSlot ?? null,
    roster,
    decisions: fragment.decisions,
    snapshots: fragment.snapshots,
    episodeReportedTelemetry: {
      decisionCount: fragment.episodeReportedTelemetry.decisionCount ?? null,
      fallbackCount: fragment.episodeReportedTelemetry.fallbackCount ?? null,
      degradedCount: fragment.episodeReportedTelemetry.degradedCount ?? null,
      parseFailureCount:
        fragment.episodeReportedTelemetry.parseFailureCount ?? null,
    },
  };
}

function fallbackEpisodeId(filePath: string): string {
  const base = path.basename(filePath);
  if (base === "replay" || base === "results.json") {
    return path.basename(path.dirname(filePath));
  }
  return base.replace(/\.replay$/i, "").replace(/\.json$/i, "");
}

function isDirectoryJsonCandidate(fileName: string): boolean {
  return (
    /^episodes?(?:[-_.].*)?\.json$/i.test(fileName) ||
    /^league[-_.]episodes\.json$/i.test(fileName) ||
    /^(?:league[-_.])?episode[-_.].*\.json$/i.test(fileName) ||
    /^metadata\.json$/i.test(fileName)
  );
}

async function discoverInDirectory(directory: string): Promise<string[]> {
  const discovered: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".replay") ||
          entry.name === "replay" ||
          (entry.name === "results.json" && !names.has("replay")) ||
          entry.name === "match-summary.json" ||
          isDirectoryJsonCandidate(entry.name))
      ) {
        discovered.push(child);
      }
    }
  };
  await visit(directory);
  return discovered;
}

async function discoverInputFiles(
  inputPaths: readonly string[],
): Promise<string[]> {
  const files: string[] = [];
  for (const inputPath of inputPaths) {
    const resolved = path.resolve(inputPath);
    if (path.basename(resolved).startsWith(".env")) {
      throw new Error("Refusing to read an environment file");
    }
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      files.push(...(await discoverInDirectory(resolved)));
    } else if (stat.isFile()) {
      files.push(resolved);
    } else {
      throw new Error(`${resolved} is not a regular file or directory`);
    }
  }
  return [...new Set(files)].sort();
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function parseSidecarBundle(
  summaryPath: string,
  warnings: string[],
): Promise<EpisodeFragment[]> {
  const directory = path.dirname(summaryPath);
  const summaryText = await fs.readFile(summaryPath, "utf8");
  const summary = asRecord(JSON.parse(summaryText));
  if (summary === null) {
    throw new Error(`${summaryPath} is not a JSON object`);
  }
  const decisionsPath = path.join(directory, "decisions.jsonl");
  const spectatorPath = path.join(directory, "spectator-replay.json");
  const decisions = await readOptionalText(decisionsPath);
  const spectatorText = await readOptionalText(spectatorPath);
  let spectatorReplay: unknown = undefined;
  if (spectatorText !== null) {
    try {
      spectatorReplay = JSON.parse(spectatorText) as unknown;
    } catch {
      throw new Error(`${spectatorPath} contains invalid JSON`);
    }
  }
  const runID = asString(summary.runID) ?? path.basename(directory);
  if (summary.scenario !== "coworld" && !/coworld/i.test(runID)) {
    return [];
  }
  const fragments = parseCoworldEvaluationDocument({
    value: {
      runID,
      completedAt: summary.completedAt,
      config: asRecord(summary.runnerConfig),
      spectatorReplay,
      inlineRunArtifacts: {
        "match-summary.json": summaryText,
        ...(decisions === null ? {} : { "decisions.jsonl": decisions }),
      },
    },
    sourcePath: summaryPath,
    fallbackId: runID,
    warnings,
  });
  const sourcePaths = [
    summaryPath,
    ...(decisions === null ? [] : [decisionsPath]),
    ...(spectatorText === null ? [] : [spectatorPath]),
  ];
  return fragments.map((fragment) => ({ ...fragment, sourcePaths }));
}

function fragmentsMatch(
  left: EpisodeFragment,
  right: EpisodeFragment,
): boolean {
  if (
    left.runID !== null &&
    left.runID !== undefined &&
    right.runID === left.runID
  ) {
    return true;
  }
  return (
    left.episodeIdIsExplicit &&
    right.episodeIdIsExplicit &&
    left.episodeId === right.episodeId
  );
}

function addMergedFragment(
  groups: EpisodeFragment[],
  fragment: EpisodeFragment,
): void {
  const matchingIndexes = groups.flatMap((group, index) =>
    fragmentsMatch(group, fragment) ? [index] : [],
  );
  if (matchingIndexes.length === 0) {
    groups.push(fragment);
    return;
  }
  let merged = fragment;
  for (const index of matchingIndexes) {
    merged = mergeFragment(groups[index], merged);
  }
  for (const index of matchingIndexes.sort((left, right) => right - left)) {
    groups.splice(index, 1);
  }
  groups.push(merged);
}

export async function loadCoworldEvaluationEpisodes(
  inputPaths: readonly string[],
): Promise<LoadedCoworldEvaluationEpisodes> {
  const warnings: string[] = [];
  const explicitFiles = new Set<string>();
  for (const inputPath of inputPaths) {
    const resolved = path.resolve(inputPath);
    if ((await fs.stat(resolved)).isFile()) {
      explicitFiles.add(resolved);
    }
  }
  const files = await discoverInputFiles(inputPaths);
  if (files.length === 0) {
    throw new Error("No Coworld episode artifacts were discovered");
  }
  const merged: EpisodeFragment[] = [];
  for (const filePath of files) {
    let parsed: unknown;
    if (path.basename(filePath) !== "match-summary.json") {
      try {
        parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      } catch {
        throw new Error(`${filePath} contains invalid JSON`);
      }
    }
    const fragments =
      path.basename(filePath) === "match-summary.json"
        ? await parseSidecarBundle(filePath, warnings)
        : parseCoworldEvaluationDocument({
            value: parsed,
            sourcePath: filePath,
            fallbackId: fallbackEpisodeId(filePath),
            warnings,
          });
    if (fragments.length === 0) {
      if (explicitFiles.has(filePath)) {
        throw new Error(`${filePath} contains no Coworld episode evidence`);
      }
      warnings.push(`${filePath}: ignored unrelated discovered file`);
      continue;
    }
    for (const fragment of fragments) {
      addMergedFragment(merged, fragment);
    }
  }
  const episodes: CoworldEvaluationEpisode[] = [];
  for (const fragment of merged) {
    if (fragment.scores === undefined) {
      if (
        fragment.sourcePaths.some((sourcePath) => explicitFiles.has(sourcePath))
      ) {
        throw new Error(
          `${fragment.episodeId}: explicit input had no matching scored artifact`,
        );
      }
      warnings.push(
        `${fragment.episodeId}: metadata had no matching result/replay artifact`,
      );
      continue;
    }
    episodes.push(normalizeEpisode(fragment));
  }
  episodes.sort((left, right) => left.episodeId.localeCompare(right.episodeId));
  if (episodes.length === 0) {
    throw new Error("No completed Coworld episodes with scores were loaded");
  }
  return { episodes, warnings };
}

export async function writeCoworldEvaluationDatasetFile(input: {
  outputPath: string;
  output: string;
  sourcePaths: readonly string[];
}): Promise<void> {
  const outputPath = path.resolve(input.outputPath);
  const sourcePaths = new Set(
    input.sourcePaths.map((value) => path.resolve(value)),
  );
  if (sourcePaths.has(outputPath)) {
    throw new Error(`Refusing to replace source artifact ${outputPath}`);
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await fs.lstat(outputPath);
    throw new Error(`Refusing to overwrite existing output ${outputPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;
  try {
    const handle = await fs.open(temporaryPath, "wx");
    temporaryCreated = true;
    try {
      await handle.writeFile(input.output);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporaryPath, outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to overwrite existing output ${outputPath}`, {
          cause: error,
        });
      }
      throw error;
    }
  } finally {
    if (temporaryCreated) {
      await fs.unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

async function main(): Promise<void> {
  const options = parseCoworldDatasetExporterOptions(process.argv.slice(2));
  const loaded = await loadCoworldEvaluationEpisodes(options.inputPaths);
  const dataset = buildCoworldEvaluationDataset({
    episodes: loaded.episodes,
    selector: options.selector,
    treatmentMarkers: options.treatmentMarkers,
    spawnPhaseTurns: options.spawnPhaseTurns,
    spawnSettleThreshold: options.spawnSettleThreshold,
    warnings: loaded.warnings,
  });
  if (dataset.rows.length === 0) {
    throw new Error(
      "The explicit selector matched no policy seats; use metadata with policy IDs, --player-name, or --seat",
    );
  }
  const output = `${JSON.stringify(dataset, null, 2)}\n`;
  if (options.outputPath === null) {
    process.stdout.write(output);
  } else {
    await writeCoworldEvaluationDatasetFile({
      outputPath: options.outputPath,
      output,
      sourcePaths: loaded.episodes.flatMap((episode) => episode.sourcePaths),
    });
  }
  console.error(conciseCoworldDatasetSummary(dataset));
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
