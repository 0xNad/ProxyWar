import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

function policyVersionIds(entry: Record<string, unknown>): string[] {
  const direct = asStringArray(entry.policy_version_ids);
  if (direct.length > 0) {
    return direct;
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
  return [];
}

function parseScores(
  raw: unknown,
  entry: Record<string, unknown>,
  sourcePath: string,
): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
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
  const order = policyVersionIds(entry);
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
  warnings: string[],
): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    warnings.push(`${sourcePath}: ignored invalid ${artifactName}`);
    return null;
  }
}

function parseDecisionRows(
  entry: Record<string, unknown>,
  sourcePath: string,
  warnings: string[],
): Record<string, unknown>[] {
  if (Array.isArray(entry.decisions)) {
    return entry.decisions.flatMap((value) => {
      const record = asRecord(value);
      return record === null ? [] : [record];
    });
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
        warnings.push(
          `${sourcePath}: decision line ${index + 1} is not an object`,
        );
      } else {
        rows.push(record);
      }
    } catch {
      warnings.push(
        `${sourcePath}: ignored invalid decision line ${index + 1}`,
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
}): CoworldEvaluationRosterSeat[] {
  const versionIds = policyVersionIds(input.entry);
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
    return {
      seat,
      policyVersionId: versionIds[seat] ?? null,
      playerName: firstString(
        slottedResult?.name,
        slottedResult?.username,
        configPlayer?.name,
        configPlayer?.username,
        spectatorPlayer?.username,
        spectatorPlayer?.name,
        summaryPlayer?.username,
        summaryPlayer?.name,
      ),
      agentID: firstString(spectatorPlayer?.agentID, summaryPlayer?.agentID),
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
  const results =
    asRecord(entry.results) ?? (Array.isArray(entry.scores) ? entry : null);
  const scores = parseScores(results?.scores, entry, input.sourcePath);
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
  const summary = parseJsonArtifact(
    inline?.["match-summary.json"],
    input.sourcePath,
    "match-summary.json",
    input.warnings,
  );
  const spectator = asRecord(entry.spectatorReplay);
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
  const roster = rosterSeats({ entry, results, spectator, summary, scores });
  const rawDecisions = parseDecisionRows(
    entry,
    input.sourcePath,
    input.warnings,
  );
  const rawSnapshots = Array.isArray(spectator?.snapshots)
    ? spectator.snapshots.flatMap((value) => {
        const record = asRecord(value);
        return record === null ? [] : [record];
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
  const entries = Array.isArray(input.value)
    ? input.value
    : Array.isArray(root?.episodes)
      ? root.episodes
      : Array.isArray(root?.entries)
        ? root.entries
        : [input.value];
  return entries.flatMap((value, index) => {
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
): CoworldEvaluationRosterSeat[] {
  const seatCount = Math.max(current.length, incoming.length);
  return Array.from({ length: seatCount }, (_, seat) => {
    const left = current.find((entry) => entry.seat === seat);
    const right = incoming.find((entry) => entry.seat === seat);
    return {
      seat,
      policyVersionId: left?.policyVersionId ?? right?.policyVersionId ?? null,
      playerName: left?.playerName ?? right?.playerName ?? null,
      agentID: left?.agentID ?? right?.agentID ?? null,
    };
  });
}

function equalNumbers(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function mergeFragment(
  current: EpisodeFragment,
  incoming: EpisodeFragment,
): EpisodeFragment {
  if (
    current.scores !== undefined &&
    incoming.scores !== undefined &&
    !equalNumbers(current.scores, incoming.scores)
  ) {
    throw new Error(`Conflicting scores for episode ${current.episodeId}`);
  }
  return {
    episodeId: current.episodeIdIsExplicit
      ? current.episodeId
      : incoming.episodeId,
    episodeIdIsExplicit:
      current.episodeIdIsExplicit || incoming.episodeIdIsExplicit,
    sourcePaths: [
      ...new Set([...current.sourcePaths, ...incoming.sourcePaths]),
    ],
    runID: current.runID ?? incoming.runID,
    completedAt: current.completedAt ?? incoming.completedAt,
    map:
      current.map !== undefined && current.map !== "Unknown map"
        ? current.map
        : incoming.map,
    mapSize: current.mapSize ?? incoming.mapSize,
    scores: current.scores ?? incoming.scores,
    outrightWinnerSlot:
      current.outrightWinnerSlot !== undefined
        ? current.outrightWinnerSlot
        : incoming.outrightWinnerSlot,
    roster: mergeRoster(current.roster, incoming.roster),
    decisions:
      current.decisions.length > 0 ? current.decisions : incoming.decisions,
    snapshots:
      current.snapshots.length > 0 ? current.snapshots : incoming.snapshots,
    episodeReportedTelemetry: {
      decisionCount: maxCount(
        current.episodeReportedTelemetry.decisionCount,
        incoming.episodeReportedTelemetry.decisionCount,
      ),
      fallbackCount: maxCount(
        current.episodeReportedTelemetry.fallbackCount,
        incoming.episodeReportedTelemetry.fallbackCount,
      ),
      degradedCount: maxCount(
        current.episodeReportedTelemetry.degradedCount,
        incoming.episodeReportedTelemetry.degradedCount,
      ),
      parseFailureCount: maxCount(
        current.episodeReportedTelemetry.parseFailureCount,
        incoming.episodeReportedTelemetry.parseFailureCount,
      ),
    },
  };
}

function maxCount(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null | undefined {
  if (left === undefined && right === undefined) return undefined;
  if (left === null && right === null) return null;
  return Math.max(left ?? 0, right ?? 0);
}

function embeddedDegraded(record: Record<string, unknown>): boolean {
  const direct =
    record.llmPlannerDegraded === true ||
    record.llm_planner_degraded === true ||
    record.degraded === true;
  if (direct) {
    return true;
  }
  const metadata = asRecord(record.decisionMetadata);
  if (metadata?.llmPlannerDegraded === true) {
    return true;
  }
  const raw = record.rawLlmOutput;
  if (typeof raw !== "string" || raw.trim() === "") {
    return false;
  }
  try {
    const parsed = asRecord(JSON.parse(raw));
    return parsed?.llmPlannerDegraded === true;
  } catch {
    return false;
  }
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
    targetID === null ||
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

function wireDroppedFollowupCount(record: Record<string, unknown>): number {
  const metadata = asRecord(record.selectedActionMetadata);
  const explicit = asCount(
    record.wireDroppedFollowupCount ??
      record.wire_dropped_followup_count ??
      record.droppedFollowupCount ??
      metadata?.wireDroppedFollowupCount,
  );
  if (explicit !== null) {
    return explicit;
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
    return 0;
  }
  const queueMarker = reason.match(/\bqueued\s+(\d+)\s+action\(s\)/i);
  return queueMarker === null ? 0 : Math.max(0, Number(queueMarker[1]) - 1);
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
    fallback: record.fallbackUsed === true || record.fallback_used === true,
    degraded: embeddedDegraded(record),
    parseFailure:
      record.parseSuccess === false ||
      record.plannerParseSuccess === false ||
      record.parse_failure === true,
    wireDroppedFollowupCount: droppedFollowups,
    multiAction:
      record.multiAction === true ||
      record.multi_action === true ||
      droppedFollowups > 0 ||
      (Array.isArray(record.batchActionIDs) &&
        record.batchActionIDs.length > 1),
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
      agentID: null,
    })),
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
      warnings.push(`${spectatorPath}: ignored invalid spectator replay`);
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
  const files = await discoverInputFiles(inputPaths);
  if (files.length === 0) {
    throw new Error("No Coworld episode artifacts were discovered");
  }
  const merged: EpisodeFragment[] = [];
  for (const filePath of files) {
    try {
      const fragments =
        path.basename(filePath) === "match-summary.json"
          ? await parseSidecarBundle(filePath, warnings)
          : parseCoworldEvaluationDocument({
              value: JSON.parse(await fs.readFile(filePath, "utf8")) as unknown,
              sourcePath: filePath,
              fallbackId: fallbackEpisodeId(filePath),
              warnings,
            });
      for (const fragment of fragments) {
        addMergedFragment(merged, fragment);
      }
    } catch (error) {
      warnings.push(
        `${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const episodes: CoworldEvaluationEpisode[] = [];
  for (const fragment of merged) {
    if (fragment.scores === undefined) {
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
    const outputPath = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, output);
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
