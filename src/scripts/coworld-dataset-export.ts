import { createHash, randomUUID } from "node:crypto";
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
  type CoworldShadowCouncilAgreement,
  type CoworldShadowCouncilDecisionTelemetry,
  type CoworldShadowCouncilHealth,
  type CoworldShadowCouncilSource,
  type CoworldShadowCouncilTier,
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
  episodeIdentityKeys: string[];
  sourcePaths: string[];
  runID?: string | null;
  platformCompletedAt?: string | null;
  runtimeCompletedAt?: string | null;
  map?: string;
  mapSize?: string | null;
  scores?: number[];
  outrightWinnerSlot?: number | null;
  roster: CoworldEvaluationRosterSeat[];
  decisions: CoworldEvaluationDecision[];
  snapshots: CoworldEvaluationSnapshot[];
  episodeReportedTelemetry: {
    result: Partial<CoworldEpisodeReportedTelemetry["result"]>;
    summary: Partial<CoworldEpisodeReportedTelemetry["summary"]>;
  };
}

export interface CoworldEvaluationLoadStats {
  skippedNonCompletedEntries: number;
  skippedByStatus: Record<string, number>;
}

export interface LoadedCoworldEvaluationEpisodes {
  episodes: CoworldEvaluationEpisode[];
  warnings: string[];
  stats: CoworldEvaluationLoadStats;
}

const usage =
  "Usage: npm run league:dataset-export -- <artifact-path>... " +
  "[--policy-version-id ID | --player-name NAME | --seat N] " +
  "[--treatment-marker ID=TEXT] [--spawn-phase-turns N] " +
  "[--spawn-settle-threshold 0..1] [--output FILE]";

const SHADOW_COUNCIL_MAX_BYTES = 300;
const shadowCouncilCompactKeys = new Set([
  "v",
  "o",
  "g",
  "x",
  "h",
  "p",
  "e",
  "j",
  "w",
  "r",
  "d",
  "m",
  "a",
  "s",
  "k",
  "u",
]);
const shadowCouncilHealthCodes: Readonly<
  Record<string, CoworldShadowCouncilHealth>
> = Object.freeze({
  h: "healthy",
  p: "partial",
  f: "failed",
  u: "unavailable",
});
const shadowCouncilAgreementCodes: Readonly<
  Record<string, CoworldShadowCouncilAgreement>
> = Object.freeze({
  a: "agree",
  d: "disagree",
  b: "abstain",
  u: "unavailable",
});
const shadowCouncilSourceCodes: Readonly<
  Record<number, CoworldShadowCouncilSource>
> = Object.freeze({
  0: "-",
  1: "expansion",
  2: "economy",
  3: "conquest",
  4: "politics",
  5: "spawn",
  6: "survival",
  7: "binding_directive",
  8: "fallback",
});
const shadowSourceTier: Readonly<
  Record<CoworldShadowCouncilSource, CoworldShadowCouncilTier>
> = Object.freeze({
  "-": "-",
  expansion: "expert_auction",
  economy: "expert_auction",
  conquest: "expert_auction",
  politics: "expert_auction",
  spawn: "spawn",
  survival: "survival",
  binding_directive: "binding_directive",
  fallback: "hold",
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
  sourcePath: string,
  context: string,
): string | null {
  if (!Object.hasOwn(record, key)) return null;
  const value = asString(record[key]);
  if (value === null) {
    throw new Error(`${sourcePath} has invalid ${context}.${key}`);
  }
  return value;
}

function consistentString(
  sourcePath: string,
  field: string,
  ...values: unknown[]
): string | null {
  const present = [
    ...new Set(values.map(asString).filter((value) => value !== null)),
  ];
  if (present.length > 1) {
    throw new Error(`${sourcePath} has conflicting ${field}`);
  }
  return present[0] ?? null;
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

function optionalCountField(
  record: Record<string, unknown> | null,
  key: string,
  sourcePath: string,
  context: string,
): number | null | undefined {
  if (record === null || !Object.hasOwn(record, key)) return undefined;
  if (record[key] === null) return null;
  const value = asCount(record[key]);
  if (value === null) {
    throw new Error(`${sourcePath} has invalid ${context}.${key}`);
  }
  return value;
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
    .map(({ record, index, position }) => {
      const context = `participant ${index + 1}`;
      return {
        seat: (position ?? index) - positionBase,
        policyVersionId: optionalStringField(
          record,
          "policy_version_id",
          sourcePath,
          context,
        ),
        playerName: optionalStringField(
          record,
          "player_name",
          sourcePath,
          context,
        ),
        label: optionalStringField(record, "label", sourcePath, context),
        agentID: null,
      };
    })
    .sort((left, right) => left.seat - right.seat);
}

interface PolicyVersionOrder {
  explicit: boolean;
  ids: Array<string | null>;
}

function policyVersionOrder(
  entry: Record<string, unknown>,
  participants: readonly CoworldEvaluationRosterSeat[],
  sourcePath: string,
): PolicyVersionOrder {
  const sources: Array<{ label: string; ids: Array<string | null> }> = [];
  if (
    Object.hasOwn(entry, "policy_version_ids") &&
    (!Array.isArray(entry.policy_version_ids) ||
      entry.policy_version_ids.length === 0 ||
      entry.policy_version_ids.some((value) => asString(value) === null))
  ) {
    throw new Error(`${sourcePath} has invalid policy_version_ids`);
  }
  if (Object.hasOwn(entry, "policy_version_ids")) {
    sources.push({
      label: "policy_version_ids",
      ids: asStringArray(entry.policy_version_ids),
    });
  }
  if (
    Object.hasOwn(entry, "policy_versions") &&
    !Array.isArray(entry.policy_versions)
  ) {
    throw new Error(`${sourcePath} has invalid policy_versions`);
  }
  if (Array.isArray(entry.policy_versions)) {
    const values = entry.policy_versions.map((value, index) => {
      const record = asRecord(value);
      if (record === null) {
        throw new Error(
          `${sourcePath} policy_versions entry ${index + 1} is not an object`,
        );
      }
      const context = `policy_versions entry ${index + 1}`;
      const policyVersionId = optionalStringField(
        record,
        "policy_version_id",
        sourcePath,
        context,
      );
      const id = optionalStringField(record, "id", sourcePath, context);
      const resolved = consistentString(
        sourcePath,
        `${context} policy ID`,
        policyVersionId,
        id,
      );
      if (resolved === null) {
        throw new Error(`${sourcePath} ${context} has no policy ID`);
      }
      return resolved;
    });
    sources.push({ label: "policy_versions", ids: values });
  }
  if (Object.hasOwn(entry, "roster") && !Array.isArray(entry.roster)) {
    throw new Error(`${sourcePath} has invalid roster`);
  }
  if (Array.isArray(entry.roster)) {
    const values = entry.roster.map((value, index) => {
      const record = asRecord(value);
      if (record === null) {
        throw new Error(
          `${sourcePath} roster entry ${index + 1} is not an object`,
        );
      }
      const context = `roster entry ${index + 1}`;
      const rawPlayer = record.player;
      const player = asRecord(rawPlayer);
      if (Object.hasOwn(record, "player") && player === null) {
        throw new Error(`${sourcePath} has invalid ${context}.player`);
      }
      for (const key of [
        "player_name",
        "name",
        "username",
        "label",
        "agentID",
        "agent_id",
      ]) {
        optionalStringField(record, key, sourcePath, context);
      }
      if (player !== null) {
        for (const key of [
          "player_name",
          "name",
          "username",
          "label",
          "agentID",
          "agent_id",
        ]) {
          optionalStringField(player, key, sourcePath, `${context}.player`);
        }
      }
      const values = [
        optionalStringField(record, "policy_version_id", sourcePath, context),
        optionalStringField(record, "policy_ref", sourcePath, context),
        ...(player === null
          ? []
          : [
              optionalStringField(
                player,
                "policy_version_id",
                sourcePath,
                `${context}.player`,
              ),
              optionalStringField(
                player,
                "policy_ref",
                sourcePath,
                `${context}.player`,
              ),
            ]),
      ];
      return consistentString(sourcePath, `${context} policy ID`, ...values);
    });
    sources.push({ label: "roster", ids: values });
  }
  if (Object.hasOwn(entry, "participants")) {
    sources.push({
      label: "participants",
      ids: participants.map((entry) => entry.policyVersionId),
    });
  }
  if (sources.length === 0) {
    return { explicit: false, ids: [] };
  }
  const cardinalities = new Set(sources.map((source) => source.ids.length));
  if (cardinalities.size > 1) {
    throw new Error(
      `${sourcePath} has conflicting policy/seat order cardinality`,
    );
  }
  const seatCount = sources[0].ids.length;
  return {
    explicit: true,
    ids: Array.from({ length: seatCount }, (_, seat) => {
      const values = sources
        .map((source) => source.ids[seat])
        .filter((value): value is string => value !== null);
      return consistentString(
        sourcePath,
        `policy ID for seat ${seat}`,
        ...values,
      );
    }),
  };
}

interface ParsedScores {
  scores: number[] | undefined;
  policyVersionIds: string[];
}

function parseScores(
  raw: unknown,
  entry: Record<string, unknown>,
  participants: readonly CoworldEvaluationRosterSeat[],
  sourcePath: string,
): ParsedScores {
  const order = policyVersionOrder(entry, participants, sourcePath);
  if (raw === undefined) {
    return { scores: undefined, policyVersionIds: [] };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${sourcePath} has invalid scores`);
  }
  if (order.explicit && order.ids.length !== raw.length) {
    throw new Error(`${sourcePath} has score/order cardinality mismatch`);
  }
  if (raw.every((score) => asNumber(score) !== null)) {
    return { scores: raw as number[], policyVersionIds: [] };
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
  if (!order.explicit) {
    return {
      scores: pairs.map((pair) => pair.score),
      policyVersionIds: pairs.map((pair) => pair.policyVersionId),
    };
  }
  if (order.ids.some((policyVersionId) => policyVersionId === null)) {
    throw new Error(
      `${sourcePath} has incomplete explicit policy order for pair scores`,
    );
  }
  const byPolicy = new Map<string, number[]>();
  for (const pair of pairs) {
    const scores = byPolicy.get(pair.policyVersionId) ?? [];
    scores.push(pair.score);
    byPolicy.set(pair.policyVersionId, scores);
  }
  const alignedScores = order.ids.map((policyVersionId) => {
    if (policyVersionId === null) {
      throw new Error(`${sourcePath} has incomplete policy order`);
    }
    const score = byPolicy.get(policyVersionId)?.shift();
    if (score === undefined) {
      throw new Error(`${sourcePath} is missing a repeated-policy seat score`);
    }
    return score;
  });
  return {
    scores: alignedScores,
    policyVersionIds: order.ids as string[],
  };
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
  const rows: Record<string, unknown>[] = [];
  if (Array.isArray(entry.decisions)) {
    rows.push(
      ...entry.decisions.map((value, index) => {
        const record = asRecord(value);
        if (record === null) {
          throw new Error(
            `${sourcePath} decision ${index + 1} is not an object`,
          );
        }
        return record;
      }),
    );
  } else if (
    Object.hasOwn(entry, "decisions") &&
    typeof entry.decisions !== "string"
  ) {
    throw new Error(`${sourcePath} has invalid decisions`);
  }
  const inline = asRecord(entry.inlineRunArtifacts);
  const jsonlSources = [
    ...(typeof entry.decisions === "string"
      ? [{ label: "decisions", value: entry.decisions }]
      : []),
    ...(inline !== null && Object.hasOwn(inline, "decisions.jsonl")
      ? [{ label: "inline decisions.jsonl", value: inline["decisions.jsonl"] }]
      : []),
  ];
  for (const source of jsonlSources) {
    if (typeof source.value !== "string") {
      throw new Error(`${sourcePath} has invalid ${source.label}`);
    }
    for (const [index, line] of source.value.split("\n").entries()) {
      if (line.trim() === "") {
        continue;
      }
      try {
        const record = asRecord(JSON.parse(line));
        if (record === null) {
          throw new Error(
            `${sourcePath} ${source.label} line ${index + 1} is not an object`,
          );
        }
        rows.push(record);
      } catch {
        throw new Error(
          `${sourcePath} contains invalid ${source.label} line ${index + 1}`,
        );
      }
    }
  }
  return rows;
}

function orderedResultPlayers(
  values: readonly unknown[],
  sourcePath: string,
): Record<string, unknown>[] {
  const players = values.map((value, index) => {
    const player = asRecord(value);
    if (player === null) {
      throw new Error(
        `${sourcePath} results.players entry ${index + 1} is not an object`,
      );
    }
    return player;
  });
  const slots = players.map((player, index) => {
    if (!Object.hasOwn(player, "slot") || player.slot === null) {
      return null;
    }
    const slot = asSeat(player.slot);
    if (slot === null) {
      throw new Error(
        `${sourcePath} results.players entry ${index + 1} has invalid slot`,
      );
    }
    return slot;
  });
  const slottedCount = slots.filter((slot) => slot !== null).length;
  if (slottedCount === 0) {
    return players;
  }
  if (slottedCount !== players.length) {
    throw new Error(
      `${sourcePath} results.players mix slotted and ordered entries`,
    );
  }
  if (
    new Set(slots).size !== players.length ||
    slots.some((slot) => slot === null || slot >= players.length)
  ) {
    throw new Error(
      `${sourcePath} results.players slots must be unique, contiguous, and zero-based`,
    );
  }
  const ordered = new Array<Record<string, unknown>>(players.length);
  for (let index = 0; index < players.length; index += 1) {
    ordered[slots[index] as number] = players[index];
  }
  return ordered;
}

function rosterSeats(input: {
  entry: Record<string, unknown>;
  results: Record<string, unknown> | null;
  spectator: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  scores: readonly number[] | undefined;
  scorePolicyVersionIds: readonly string[];
  participants: readonly CoworldEvaluationRosterSeat[];
  sourcePath: string;
}): CoworldEvaluationRosterSeat[] {
  const versionOrder = policyVersionOrder(
    input.entry,
    input.participants,
    input.sourcePath,
  );
  const versionIds = versionOrder.ids;
  if (
    input.results !== null &&
    Object.hasOwn(input.results, "players") &&
    !Array.isArray(input.results.players)
  ) {
    throw new Error(`${input.sourcePath} has invalid results.players`);
  }
  const resultPlayers = orderedResultPlayers(
    Array.isArray(input.results?.players) ? input.results.players : [],
    input.sourcePath,
  );
  const config = asRecord(input.entry.config);
  if (Object.hasOwn(input.entry, "config") && config === null) {
    throw new Error(`${input.sourcePath} has invalid config`);
  }
  if (
    config !== null &&
    Object.hasOwn(config, "players") &&
    !Array.isArray(config.players)
  ) {
    throw new Error(`${input.sourcePath} has invalid config.players`);
  }
  const configPlayers = Array.isArray(config?.players) ? config.players : [];
  if (
    input.spectator !== null &&
    Object.hasOwn(input.spectator, "roster") &&
    !Array.isArray(input.spectator.roster)
  ) {
    throw new Error(`${input.sourcePath} has invalid spectator roster`);
  }
  const spectatorRoster = Array.isArray(input.spectator?.roster)
    ? input.spectator.roster
    : [];
  if (
    input.summary !== null &&
    Object.hasOwn(input.summary, "roster") &&
    !Array.isArray(input.summary.roster)
  ) {
    throw new Error(`${input.sourcePath} has invalid summary roster`);
  }
  const summaryRoster = Array.isArray(input.summary?.roster)
    ? input.summary.roster
    : [];
  const explicitOrders = [
    ...(versionOrder.explicit
      ? [{ label: "policy order", length: versionIds.length }]
      : []),
    ...(input.results !== null && Object.hasOwn(input.results, "players")
      ? [{ label: "results.players", length: resultPlayers.length }]
      : []),
    ...(config !== null && Object.hasOwn(config, "players")
      ? [{ label: "config.players", length: configPlayers.length }]
      : []),
    ...(input.spectator !== null && Object.hasOwn(input.spectator, "roster")
      ? [{ label: "spectator roster", length: spectatorRoster.length }]
      : []),
    ...(input.summary !== null && Object.hasOwn(input.summary, "roster")
      ? [{ label: "summary roster", length: summaryRoster.length }]
      : []),
  ];
  const expectedSeatCount = input.scores?.length;
  if (
    expectedSeatCount !== undefined &&
    explicitOrders.some((order) => order.length !== expectedSeatCount)
  ) {
    throw new Error(`${input.sourcePath} has score/order cardinality mismatch`);
  }
  if (new Set(explicitOrders.map((order) => order.length)).size > 1) {
    throw new Error(
      `${input.sourcePath} has conflicting seat order cardinality`,
    );
  }
  const seatCount = Math.max(
    input.scores?.length ?? 0,
    versionIds.length,
    input.scorePolicyVersionIds.length,
    resultPlayers.length,
    configPlayers.length,
    spectatorRoster.length,
    summaryRoster.length,
    input.participants.length,
  );
  return Array.from({ length: seatCount }, (_, seat) => {
    const slottedResult = resultPlayers[seat] ?? null;
    const configPlayer = asRecord(configPlayers[seat]);
    const spectatorPlayer = asRecord(spectatorRoster[seat]);
    const summaryPlayer = asRecord(summaryRoster[seat]);
    if (seat < configPlayers.length && configPlayer === null) {
      throw new Error(
        `${input.sourcePath} config.players entry ${seat + 1} is not an object`,
      );
    }
    if (seat < spectatorRoster.length && spectatorPlayer === null) {
      throw new Error(
        `${input.sourcePath} spectator roster entry ${seat + 1} is not an object`,
      );
    }
    if (seat < summaryRoster.length && summaryPlayer === null) {
      throw new Error(
        `${input.sourcePath} summary roster entry ${seat + 1} is not an object`,
      );
    }
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
        input.scorePolicyVersionIds[seat] ?? null,
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
  runID: string | null,
  fallbackId: string,
): { id: string; explicit: boolean } {
  const explicit = firstString(
    entry.episode_request_id,
    entry.episodeRequestId,
    entry.id,
  );
  if (explicit !== null) {
    return { id: explicit, explicit: true };
  }
  return { id: runID ?? fallbackId, explicit: false };
}

function episodeIdentityKeys(input: {
  entry: Record<string, unknown>;
  runID: string | null;
  fallbackId: string;
  aliases: readonly string[];
}): string[] {
  const explicit = firstString(
    input.entry.episode_request_id,
    input.entry.episodeRequestId,
    input.entry.id,
  );
  return [
    ...(explicit === null ? [] : [`episode:${explicit}`]),
    ...(input.runID === null ? [] : [`run:${input.runID}`]),
    `source:${input.fallbackId}`,
    ...input.aliases.map((alias) => `episode:${alias}`),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

const explicitlyNonCompletedStatuses = new Set([
  "failed",
  "running",
  "submitted",
]);

function recordSkippedStatus(
  stats: CoworldEvaluationLoadStats,
  status: string,
): void {
  stats.skippedNonCompletedEntries += 1;
  stats.skippedByStatus[status] = (stats.skippedByStatus[status] ?? 0) + 1;
}

function parseEpisodeFragment(input: {
  value: unknown;
  sourcePath: string;
  fallbackId: string;
  identityAliases: readonly string[];
  allowFallbackIdentity: boolean;
  warnings: string[];
  stats: CoworldEvaluationLoadStats;
}): EpisodeFragment | null {
  const entry = asRecord(input.value);
  if (entry === null) {
    return null;
  }
  let explicitStatus: string | null = null;
  if (Object.hasOwn(entry, "status")) {
    const rawStatus = asString(entry.status);
    if (rawStatus === null) {
      throw new Error(`${input.sourcePath} has invalid episode status`);
    }
    const status = rawStatus.toLowerCase();
    explicitStatus = status;
    if (status !== "completed") {
      if (!explicitlyNonCompletedStatuses.has(status)) {
        throw new Error(
          `${input.sourcePath} has unknown episode status ${rawStatus}`,
        );
      }
      recordSkippedStatus(input.stats, status);
      return null;
    }
  }
  const participants = participantRoster(entry, input.sourcePath);
  const results =
    asRecord(entry.results) ?? (Array.isArray(entry.scores) ? entry : null);
  if (Object.hasOwn(entry, "results") && asRecord(entry.results) === null) {
    throw new Error(`${input.sourcePath} has invalid results`);
  }
  const parsedScores = parseScores(
    results?.scores,
    entry,
    participants,
    input.sourcePath,
  );
  const scores = parsedScores.scores;
  if (explicitStatus === "completed" && scores === undefined) {
    throw new Error(`${input.sourcePath} completed episode has no scores`);
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
  const runID = consistentString(
    input.sourcePath,
    "runID",
    entry.runID,
    summary?.runID,
  );
  const episodeIdentifierResult = episodeIdentifier(
    entry,
    runID,
    input.fallbackId,
  );
  const episodeId = episodeIdentifierResult.id;
  const hasEpisodeIdentity =
    firstString(entry.episode_request_id, entry.episodeRequestId, entry.id) !==
      null ||
    scores !== undefined ||
    runID !== null ||
    input.allowFallbackIdentity;
  if (!hasEpisodeIdentity) {
    return null;
  }
  const spectator = asRecord(entry.spectatorReplay);
  if (Object.hasOwn(entry, "spectatorReplay") && spectator === null) {
    throw new Error(`${input.sourcePath} has invalid spectatorReplay`);
  }
  const gameConfigSnake = asRecord(entry.game_config);
  const gameConfigCamel = asRecord(entry.gameConfig);
  if (Object.hasOwn(entry, "game_config") && gameConfigSnake === null) {
    throw new Error(`${input.sourcePath} has invalid game_config`);
  }
  if (Object.hasOwn(entry, "gameConfig") && gameConfigCamel === null) {
    throw new Error(`${input.sourcePath} has invalid gameConfig`);
  }
  const config = asRecord(entry.config);
  if (Object.hasOwn(entry, "config") && config === null) {
    throw new Error(`${input.sourcePath} has invalid config`);
  }
  const spectatorMap = asRecord(spectator?.map);
  if (
    spectator !== null &&
    Object.hasOwn(spectator, "map") &&
    spectatorMap === null
  ) {
    throw new Error(`${input.sourcePath} has invalid spectator map`);
  }
  const runnerConfig = asRecord(summary?.runnerConfig);
  if (
    summary !== null &&
    Object.hasOwn(summary, "runnerConfig") &&
    runnerConfig === null
  ) {
    throw new Error(`${input.sourcePath} has invalid summary runnerConfig`);
  }
  const map = consistentString(
    input.sourcePath,
    "map",
    entry.map,
    gameConfigSnake?.map,
    gameConfigCamel?.map,
    config?.map,
    spectatorMap?.gameMap,
    runnerConfig?.map,
  );
  const mapSize = consistentString(
    input.sourcePath,
    "mapSize",
    entry.map_size,
    entry.mapSize,
    gameConfigSnake?.map_size,
    gameConfigSnake?.mapSize,
    gameConfigCamel?.map_size,
    gameConfigCamel?.mapSize,
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
    (winnerSlot === null ||
      (scores !== undefined && winnerSlot >= scores.length))
  ) {
    throw new Error(`${input.sourcePath} has an invalid winner_slot`);
  }
  const roster = rosterSeats({
    entry,
    results,
    spectator,
    summary,
    scores,
    scorePolicyVersionIds: parsedScores.policyVersionIds,
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
  const normalizedDecisions = mergeDecisions(
    episodeId,
    roster,
    [],
    rawDecisions.map((record) => normalizeDecision(record, roster)),
  );
  const platformCompletedAt = optionalStringField(
    entry,
    "completed_at",
    input.sourcePath,
    "episode",
  );
  const entryRuntimeCompletedAt = optionalStringField(
    entry,
    "completedAt",
    input.sourcePath,
    "episode",
  );
  const summaryRuntimeCompletedAt =
    summary === null
      ? null
      : optionalStringField(
          summary,
          "completedAt",
          input.sourcePath,
          "match-summary",
        );
  const runtimeCompletedAt = consistentString(
    input.sourcePath,
    "runtime completedAt",
    entryRuntimeCompletedAt,
    summaryRuntimeCompletedAt,
  );
  return {
    episodeId,
    episodeIdIsExplicit: episodeIdentifierResult.explicit,
    episodeIdentityKeys: episodeIdentityKeys({
      entry,
      runID,
      fallbackId: input.fallbackId,
      aliases: input.identityAliases,
    }),
    sourcePaths: [input.sourcePath],
    runID,
    platformCompletedAt,
    runtimeCompletedAt,
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
    decisions: normalizedDecisions,
    snapshots: rawSnapshots.map((record) => normalizeSnapshot(record, roster)),
    episodeReportedTelemetry: {
      result: {
        decisionCount: optionalCountField(
          results,
          "decision_count",
          input.sourcePath,
          "results",
        ),
        fallbackCount: optionalCountField(
          results,
          "fallback_count",
          input.sourcePath,
          "results",
        ),
        degradedCount: optionalCountField(
          results,
          "degraded_count",
          input.sourcePath,
          "results",
        ),
        parseFailureCount: optionalCountField(
          results,
          "parse_failure_count",
          input.sourcePath,
          "results",
        ),
      },
      summary: {
        decisionCount: optionalCountField(
          summary,
          "decisionCount",
          input.sourcePath,
          "match-summary",
        ),
        fallbackCount: optionalCountField(
          summary,
          "fallbackCount",
          input.sourcePath,
          "match-summary",
        ),
        degradedCount: optionalCountField(
          summary,
          "degradedCount",
          input.sourcePath,
          "match-summary",
        ),
        parseFailureCount: optionalCountField(
          summary,
          "parseFailureCount",
          input.sourcePath,
          "match-summary",
        ),
      },
    },
  };
}

export function parseCoworldEvaluationDocument(input: {
  value: unknown;
  sourcePath: string;
  fallbackId: string;
  identityAliases?: readonly string[];
  allowFallbackIdentity?: boolean;
  warnings?: string[];
  stats?: CoworldEvaluationLoadStats;
}): EpisodeFragment[] {
  const warnings = input.warnings ?? [];
  const stats = input.stats ?? {
    skippedNonCompletedEntries: 0,
    skippedByStatus: {},
  };
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
      identityAliases: (input.identityAliases ?? []).map((alias) =>
        entries.length === 1 ? alias : `${alias}:${index}`,
      ),
      allowFallbackIdentity: input.allowFallbackIdentity ?? false,
      warnings,
      stats,
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

interface MergeIdentity {
  seat: number | null;
  playerName: string | null;
  agentID: string | null;
}

type CoworldSeatProvenance = "explicit" | "identity" | "ordered";
type CoworldAuthoritativeSeatProvenance = Exclude<
  CoworldSeatProvenance,
  "identity"
>;

interface ResolvedMergeIdentity extends MergeIdentity {
  seatProvenance: CoworldSeatProvenance | null;
}

// Keep merge-only provenance out of the persisted episode and dataset schemas.
// Every evidence-record constructor below re-registers provenance after copying.
const seatProvenanceByEvidence = new WeakMap<object, CoworldSeatProvenance>();

function evidenceSeatProvenance(
  evidence: MergeIdentity,
): CoworldSeatProvenance | null {
  return (
    seatProvenanceByEvidence.get(evidence) ??
    (evidence.seat === null ? null : "explicit")
  );
}

function rememberSeatProvenance<T extends MergeIdentity>(
  evidence: T,
  provenance: CoworldSeatProvenance | null,
): T {
  if (provenance === null) {
    seatProvenanceByEvidence.delete(evidence);
  } else {
    seatProvenanceByEvidence.set(evidence, provenance);
  }
  return evidence;
}

function mergedSeatProvenance(
  left: MergeIdentity,
  right: MergeIdentity,
  seat: number | null,
): CoworldSeatProvenance | null {
  if (seat === null) return null;
  const rank: Record<CoworldSeatProvenance, number> = {
    explicit: 3,
    ordered: 2,
    identity: 1,
  };
  return (
    [left, right]
      .filter((evidence) => evidence.seat === seat)
      .map(evidenceSeatProvenance)
      .filter(
        (provenance): provenance is CoworldSeatProvenance =>
          provenance !== null,
      )
      .sort(
        (leftProvenance, rightProvenance) =>
          rank[rightProvenance] - rank[leftProvenance],
      )[0] ?? "explicit"
  );
}

function rosterSeatForIdentity(
  identity: MergeIdentity,
  roster: readonly CoworldEvaluationRosterSeat[],
): number | null {
  if (identity.seat !== null) {
    return identity.seat;
  }
  if (identity.agentID !== null) {
    const matches = roster.filter(
      (entry) => entry.agentID === identity.agentID,
    );
    return matches.length === 1 ? matches[0].seat : null;
  }
  if (identity.playerName !== null) {
    const matches = roster.filter(
      (entry) => entry.playerName === identity.playerName,
    );
    return matches.length === 1 ? matches[0].seat : null;
  }
  return null;
}

function mergeIdentitiesMatch(
  left: MergeIdentity,
  right: MergeIdentity,
  roster: readonly CoworldEvaluationRosterSeat[],
): boolean {
  if (left.seat !== null && right.seat !== null) {
    return left.seat === right.seat;
  }
  const leftSeat = rosterSeatForIdentity(left, roster);
  const rightSeat = rosterSeatForIdentity(right, roster);
  if (leftSeat !== null || rightSeat !== null) {
    return leftSeat !== null && rightSeat !== null && leftSeat === rightSeat;
  }
  if (left.agentID !== null || right.agentID !== null) {
    return (
      left.agentID !== null &&
      right.agentID !== null &&
      left.agentID === right.agentID
    );
  }
  if (left.playerName === null || right.playerName === null) {
    return false;
  }
  if (left.playerName !== right.playerName) {
    return false;
  }
  const nameMatches = roster.filter(
    (entry) => entry.playerName === left.playerName,
  );
  return nameMatches.length === 1;
}

function decisionsMatch(
  left: CoworldEvaluationDecision,
  right: CoworldEvaluationDecision,
  roster: readonly CoworldEvaluationRosterSeat[],
): boolean {
  if (isDeepStrictEqual(left, right)) return true;
  if (left.turnNumber === null || left.turnNumber !== right.turnNumber) {
    return false;
  }
  return mergeIdentitiesMatch(left, right, roster);
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
  const seat = mergeNullable(
    episodeId,
    `decision turn ${left.turnNumber ?? "unknown"} seat`,
    left.seat,
    right.seat,
  );
  const merged: CoworldEvaluationDecision = {
    seat,
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
    decisionResponseAvailable: mergeNullable(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} decisionResponseAvailable`,
      left.decisionResponseAvailable,
      right.decisionResponseAvailable,
    ),
    shadowCouncil: mergeNullable(
      episodeId,
      `decision turn ${left.turnNumber ?? "unknown"} shadowCouncil`,
      left.shadowCouncil,
      right.shadowCouncil,
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
  return rememberSeatProvenance(
    merged,
    mergedSeatProvenance(left, right, seat),
  );
}

function mergeDecisions(
  episodeId: string,
  roster: readonly CoworldEvaluationRosterSeat[],
  current: readonly CoworldEvaluationDecision[],
  incoming: readonly CoworldEvaluationDecision[],
): CoworldEvaluationDecision[] {
  const merged = [...current];
  for (const decision of incoming) {
    const matchingIndexes = merged.flatMap((candidate, index) =>
      decisionsMatch(candidate, decision, roster) ? [index] : [],
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
  roster: readonly CoworldEvaluationRosterSeat[],
): boolean {
  if (isDeepStrictEqual(left, right)) return true;
  return mergeIdentitiesMatch(left, right, roster);
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
  const seat = merge("seat", left.seat, right.seat);
  const merged: CoworldEvaluationSnapshotPlayer = {
    seat,
    playerName: merge("playerName", left.playerName, right.playerName),
    agentID: merge("agentID", left.agentID, right.agentID),
    tilesOwned: merge("tilesOwned", left.tilesOwned, right.tilesOwned),
    troops: merge("troops", left.troops, right.troops),
    gold: merge("gold", left.gold, right.gold),
    isAlive: merge("isAlive", left.isAlive, right.isAlive),
    hasSpawned: merge("hasSpawned", left.hasSpawned, right.hasSpawned),
  };
  return rememberSeatProvenance(
    merged,
    mergedSeatProvenance(left, right, seat),
  );
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
  roster: readonly CoworldEvaluationRosterSeat[],
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
        snapshotPlayersMatch(candidate, player, roster) ? [index] : [],
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
  const identityContext = current.episodeIdIsExplicit
    ? current.episodeId
    : incoming.episodeIdIsExplicit
      ? incoming.episodeId
      : [current.episodeId, incoming.episodeId].sort()[0];
  const runID = mergeNullable(
    identityContext,
    "runID",
    current.runID,
    incoming.runID,
  );
  const episodeId = current.episodeIdIsExplicit
    ? current.episodeId
    : incoming.episodeIdIsExplicit
      ? incoming.episodeId
      : (runID ?? identityContext);
  const currentMap = current.map === "Unknown map" ? undefined : current.map;
  const incomingMap = incoming.map === "Unknown map" ? undefined : incoming.map;
  const roster = mergeRoster(current.roster, incoming.roster, episodeId);
  const decisions = revalidateDecisionsForRoster(
    mergeDecisions(
      episodeId,
      roster,
      revalidateDecisionsForRoster(current.decisions, roster),
      revalidateDecisionsForRoster(incoming.decisions, roster),
    ),
    roster,
  );
  const snapshots = revalidateSnapshotsForRoster(
    mergeSnapshots(
      episodeId,
      roster,
      revalidateSnapshotsForRoster(current.snapshots, roster, episodeId),
      revalidateSnapshotsForRoster(incoming.snapshots, roster, episodeId),
    ),
    roster,
    episodeId,
  );
  return {
    episodeId,
    episodeIdIsExplicit:
      current.episodeIdIsExplicit || incoming.episodeIdIsExplicit,
    episodeIdentityKeys: [
      ...new Set([
        ...current.episodeIdentityKeys,
        ...incoming.episodeIdentityKeys,
      ]),
    ],
    sourcePaths: [
      ...new Set([...current.sourcePaths, ...incoming.sourcePaths]),
    ],
    runID,
    platformCompletedAt: mergeNullable(
      episodeId,
      "platformCompletedAt",
      current.platformCompletedAt,
      incoming.platformCompletedAt,
    ),
    runtimeCompletedAt: mergeNullable(
      episodeId,
      "runtimeCompletedAt",
      current.runtimeCompletedAt,
      incoming.runtimeCompletedAt,
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
    roster,
    decisions,
    snapshots,
    episodeReportedTelemetry: {
      result: mergeReportedTelemetry(
        episodeId,
        "result",
        current.episodeReportedTelemetry.result,
        incoming.episodeReportedTelemetry.result,
      ),
      summary: mergeReportedTelemetry(
        episodeId,
        "summary",
        current.episodeReportedTelemetry.summary,
        incoming.episodeReportedTelemetry.summary,
      ),
    },
  };
}

function mergeReportedTelemetry(
  episodeId: string,
  provenance: string,
  current: Partial<CoworldEpisodeReportedTelemetry["result"]>,
  incoming: Partial<CoworldEpisodeReportedTelemetry["result"]>,
): Partial<CoworldEpisodeReportedTelemetry["result"]> {
  return {
    decisionCount: mergeOptional(
      episodeId,
      `${provenance}-reported decisionCount`,
      current.decisionCount ?? undefined,
      incoming.decisionCount ?? undefined,
    ),
    fallbackCount: mergeOptional(
      episodeId,
      `${provenance}-reported fallbackCount`,
      current.fallbackCount ?? undefined,
      incoming.fallbackCount ?? undefined,
    ),
    degradedCount: mergeOptional(
      episodeId,
      `${provenance}-reported degradedCount`,
      current.degradedCount ?? undefined,
      incoming.degradedCount ?? undefined,
    ),
    parseFailureCount: mergeOptional(
      episodeId,
      `${provenance}-reported parseFailureCount`,
      current.parseFailureCount ?? undefined,
      incoming.parseFailureCount ?? undefined,
    ),
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

interface ParsedDecisionResponseTelemetry {
  available: boolean | null;
  shadowCouncil: CoworldShadowCouncilDecisionTelemetry | null;
}

function shadowInteger(
  record: Record<string, unknown>,
  key: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error(`Invalid decision_response.shadowCouncil.${key}`);
  }
  return value;
}

function shadowFingerprint(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    (value !== "-" && !/^[0-9a-f]{16}$/.test(value))
  ) {
    throw new Error(`Invalid decision_response.shadowCouncil.${key}`);
  }
  return value;
}

function shadowCouncilDecisionTelemetry(
  value: unknown,
): CoworldShadowCouncilDecisionTelemetry {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > SHADOW_COUNCIL_MAX_BYTES
  ) {
    throw new Error("Invalid decision_response.shadowCouncil compact payload");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("Invalid decision_response.shadowCouncil JSON");
  }
  const record = asRecord(decoded);
  const keys = record === null ? [] : Object.keys(record);
  if (
    record === null ||
    keys.length !== shadowCouncilCompactKeys.size ||
    keys.some((key) => !shadowCouncilCompactKeys.has(key))
  ) {
    throw new Error("Invalid decision_response.shadowCouncil keys");
  }
  if (record.v !== 1) {
    throw new Error("Invalid decision_response.shadowCouncil.v");
  }
  const ordinal = shadowInteger(record, "o");
  const resetOrdinal = shadowInteger(record, "g");
  const resetCode = shadowInteger(record, "x", 1);
  const health =
    typeof record.h === "string"
      ? shadowCouncilHealthCodes[record.h]
      : undefined;
  if (health === undefined) {
    throw new Error("Invalid decision_response.shadowCouncil.h");
  }
  const proposalMask = shadowInteger(record, "p", 63);
  const errorMask = shadowInteger(record, "e", 63);
  const rejectionMask = shadowInteger(record, "j", 2_047);
  const diagnosticWinnerFingerprint = shadowFingerprint(record, "w");
  const runnerUpFingerprint = shadowFingerprint(record, "r");
  const authoritativeFingerprint = shadowFingerprint(record, "d");
  const bidMarginBP = record.m === null ? null : shadowInteger(record, "m");
  const agreement =
    typeof record.a === "string"
      ? shadowCouncilAgreementCodes[record.a]
      : undefined;
  if (agreement === undefined) {
    throw new Error("Invalid decision_response.shadowCouncil.a");
  }
  const sourceCode = shadowInteger(record, "s", 8);
  const diagnosticWinnerSource = shadowCouncilSourceCodes[sourceCode];
  if (diagnosticWinnerSource === undefined) {
    throw new Error("Invalid decision_response.shadowCouncil.s");
  }
  const enabledExpertMask = shadowInteger(record, "k", 15);
  const elapsedUs = shadowInteger(record, "u");
  return {
    version: 1,
    ordinal,
    resetOrdinal,
    reset: resetCode === 1,
    health,
    proposalMask,
    errorMask,
    rejectionMask,
    diagnosticWinnerFingerprint,
    runnerUpFingerprint,
    authoritativeFingerprint,
    bidMarginBP,
    agreement,
    diagnosticWinnerSource,
    diagnosticWinnerTier: shadowSourceTier[diagnosticWinnerSource],
    enabledExpertMask,
    elapsedUs,
  };
}

function decisionResponseTelemetry(
  record: Record<string, unknown>,
): ParsedDecisionResponseTelemetry {
  if (!Object.hasOwn(record, "rawLlmOutput")) {
    return { available: null, shadowCouncil: null };
  }
  const raw = record.rawLlmOutput;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { available: false, shadowCouncil: null };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { available: false, shadowCouncil: null };
  }
  const response = asRecord(decoded);
  if (response?.type !== "decision_response") {
    if (response !== null && Object.hasOwn(response, "shadowCouncil")) {
      throw new Error(
        "Invalid shadowCouncil outside a decision_response payload",
      );
    }
    return { available: null, shadowCouncil: null };
  }
  return {
    available: true,
    shadowCouncil: Object.hasOwn(response, "shadowCouncil")
      ? shadowCouncilDecisionTelemetry(response.shadowCouncil)
      : null,
  };
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

function identityString(
  record: Record<string, unknown>,
  keys: readonly string[],
  context: string,
  field: string,
): string | null {
  const values = keys.flatMap((key) => {
    if (!Object.hasOwn(record, key) || record[key] === null) {
      return [];
    }
    const value = asString(record[key]);
    if (value === null) {
      throw new Error(`Invalid ${context} ${field}`);
    }
    return [value];
  });
  const unique = [...new Set(values)];
  if (unique.length > 1) {
    throw new Error(`Conflicting ${context} identity`);
  }
  return unique[0] ?? null;
}

function identitySeat(
  record: Record<string, unknown>,
  keys: readonly string[],
  context: string,
): number | null {
  const values = keys.flatMap((key) => {
    if (!Object.hasOwn(record, key) || record[key] === null) {
      return [];
    }
    const value = asSeat(record[key]);
    if (value === null) {
      throw new Error(`Invalid ${context} seat`);
    }
    return [value];
  });
  const unique = [...new Set(values)];
  if (unique.length > 1) {
    throw new Error(`Conflicting ${context} identity`);
  }
  return unique[0] ?? null;
}

function resolveIdentityAgainstRoster(input: {
  identity: MergeIdentity;
  roster: readonly CoworldEvaluationRosterSeat[];
  context: string;
  fallbackSeat?: number | null;
  directSeatProvenance?: CoworldAuthoritativeSeatProvenance;
}): ResolvedMergeIdentity {
  const directSeat = input.identity.seat;
  const playerName = input.identity.playerName;
  const agentID = input.identity.agentID;
  const agentMatches =
    agentID === null
      ? []
      : input.roster.filter((entry) => entry.agentID === agentID);
  const nameMatches =
    playerName === null
      ? []
      : input.roster.filter((entry) => entry.playerName === playerName);
  const conflictsWithSeat = (seat: number): boolean => {
    const rosterSeat = input.roster.find((entry) => entry.seat === seat);
    if (input.roster.length > 0 && rosterSeat === undefined) {
      return true;
    }
    if (
      playerName !== null &&
      rosterSeat?.playerName !== null &&
      rosterSeat?.playerName !== undefined &&
      rosterSeat.playerName !== playerName
    ) {
      return true;
    }
    if (
      agentID !== null &&
      rosterSeat?.agentID !== null &&
      rosterSeat?.agentID !== undefined &&
      rosterSeat.agentID !== agentID
    ) {
      return true;
    }
    if (
      agentMatches.length > 0 &&
      !agentMatches.some((entry) => entry.seat === seat)
    ) {
      return true;
    }
    return (
      nameMatches.length > 0 &&
      !nameMatches.some((entry) => entry.seat === seat)
    );
  };
  if (directSeat !== null) {
    if (conflictsWithSeat(directSeat)) {
      throw new Error(`Conflicting ${input.context} identity`);
    }
    return {
      seat: directSeat,
      playerName,
      agentID,
      seatProvenance: input.directSeatProvenance ?? "explicit",
    };
  }
  const uniqueAgentSeat =
    agentMatches.length === 1 ? agentMatches[0].seat : null;
  const uniqueNameSeat = nameMatches.length === 1 ? nameMatches[0].seat : null;
  if (
    uniqueAgentSeat !== null &&
    uniqueNameSeat !== null &&
    uniqueAgentSeat !== uniqueNameSeat
  ) {
    throw new Error(`Conflicting ${input.context} identity`);
  }
  if (uniqueAgentSeat !== null) {
    if (conflictsWithSeat(uniqueAgentSeat)) {
      throw new Error(`Conflicting ${input.context} identity`);
    }
    return {
      seat: uniqueAgentSeat,
      playerName,
      agentID,
      seatProvenance: "identity",
    };
  }
  if (agentID !== null) {
    if (uniqueNameSeat !== null && conflictsWithSeat(uniqueNameSeat)) {
      throw new Error(`Conflicting ${input.context} identity`);
    }
    return { seat: null, playerName, agentID, seatProvenance: null };
  }
  if (uniqueNameSeat !== null) {
    return {
      seat: uniqueNameSeat,
      playerName,
      agentID,
      seatProvenance: "identity",
    };
  }
  const fallbackSeat =
    playerName === null && agentID === null
      ? (input.fallbackSeat ?? null)
      : null;
  return {
    seat: fallbackSeat,
    playerName,
    agentID,
    seatProvenance: fallbackSeat === null ? null : "ordered",
  };
}

function resolveRecordIdentity(input: {
  record: Record<string, unknown>;
  roster: readonly CoworldEvaluationRosterSeat[];
  context: string;
  seatKeys: readonly string[];
  playerNameKeys: readonly string[];
  agentIDKeys: readonly string[];
  fallbackSeat?: number | null;
}): ResolvedMergeIdentity {
  return resolveIdentityAgainstRoster({
    identity: {
      seat: identitySeat(input.record, input.seatKeys, input.context),
      playerName: identityString(
        input.record,
        input.playerNameKeys,
        input.context,
        "player name",
      ),
      agentID: identityString(
        input.record,
        input.agentIDKeys,
        input.context,
        "agent ID",
      ),
    },
    roster: input.roster,
    context: input.context,
    fallbackSeat: input.fallbackSeat,
  });
}

function normalizeDecision(
  record: Record<string, unknown>,
  roster: readonly CoworldEvaluationRosterSeat[],
): CoworldEvaluationDecision {
  const identity = resolveRecordIdentity({
    record,
    roster,
    context: "decision",
    seatKeys: ["seat", "slot", "policy_slot"],
    playerNameKeys: ["username", "playerName", "name"],
    agentIDKeys: ["agentID", "agent_id"],
  });
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
  const responseTelemetry = decisionResponseTelemetry(record);
  const decision: CoworldEvaluationDecision = {
    seat: identity.seat,
    playerName: identity.playerName,
    agentID: identity.agentID,
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
    decisionResponseAvailable: responseTelemetry.available,
    shadowCouncil: responseTelemetry.shadowCouncil,
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
  return rememberSeatProvenance(decision, identity.seatProvenance);
}

function revalidateDecisionsForRoster(
  decisions: readonly CoworldEvaluationDecision[],
  roster: readonly CoworldEvaluationRosterSeat[],
): CoworldEvaluationDecision[] {
  return decisions.map((decision) => {
    const priorProvenance = evidenceSeatProvenance(decision);
    const identity = resolveIdentityAgainstRoster({
      identity: {
        seat: priorProvenance === "identity" ? null : decision.seat,
        playerName: decision.playerName,
        agentID: decision.agentID,
      },
      roster,
      context: "decision",
      directSeatProvenance:
        priorProvenance === "ordered" ? "ordered" : "explicit",
    });
    const revalidated: CoworldEvaluationDecision = {
      ...decision,
      seat: identity.seat,
      playerName: identity.playerName,
      agentID: identity.agentID,
    };
    return rememberSeatProvenance(revalidated, identity.seatProvenance);
  });
}

function validateUniqueSnapshotSeats(
  players: readonly CoworldEvaluationSnapshotPlayer[],
  context: string,
): void {
  const seen = new Set<number>();
  for (const player of players) {
    if (player.seat === null) {
      continue;
    }
    if (seen.has(player.seat)) {
      throw new Error(`Ambiguous snapshot player seat in ${context}`);
    }
    seen.add(player.seat);
  }
}

function revalidateSnapshotsForRoster(
  snapshots: readonly CoworldEvaluationSnapshot[],
  roster: readonly CoworldEvaluationRosterSeat[],
  episodeId: string,
): CoworldEvaluationSnapshot[] {
  return snapshots.map((snapshot) => {
    const players = snapshot.players.map((player) => {
      const priorProvenance = evidenceSeatProvenance(player);
      const identity = resolveIdentityAgainstRoster({
        identity: {
          seat: priorProvenance === "identity" ? null : player.seat,
          playerName: player.playerName,
          agentID: player.agentID,
        },
        roster,
        context: "snapshot player",
        directSeatProvenance:
          priorProvenance === "ordered" ? "ordered" : "explicit",
      });
      const revalidated: CoworldEvaluationSnapshotPlayer = {
        ...player,
        seat: identity.seat,
        playerName: identity.playerName,
        agentID: identity.agentID,
      };
      return rememberSeatProvenance(revalidated, identity.seatProvenance);
    });
    validateUniqueSnapshotSeats(
      players,
      `episode ${episodeId} snapshot ${snapshot.label}`,
    );
    return { ...snapshot, players };
  });
}

function normalizeSnapshotPlayer(input: {
  value: unknown;
  index: number;
  roster: readonly CoworldEvaluationRosterSeat[];
  allowIndexFallback: boolean;
}): CoworldEvaluationSnapshotPlayer {
  const player = asRecord(input.value);
  if (player === null) {
    throw new Error("Invalid snapshot player");
  }
  const identity = resolveRecordIdentity({
    record: player,
    roster: input.roster,
    context: "snapshot player",
    seatKeys: ["seat", "slot"],
    playerNameKeys: ["username", "name"],
    agentIDKeys: ["agentID", "agent_id"],
    fallbackSeat: input.allowIndexFallback ? input.index : null,
  });
  const gold = player.gold;
  const normalized: CoworldEvaluationSnapshotPlayer = {
    seat: identity.seat,
    playerName: identity.playerName,
    agentID: identity.agentID,
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
  return rememberSeatProvenance(normalized, identity.seatProvenance);
}

function hasExplicitSnapshotIdentity(value: unknown): boolean {
  const player = asRecord(value);
  if (player === null) {
    throw new Error("Invalid snapshot player");
  }
  return ["seat", "slot", "username", "name", "agentID", "agent_id"].some(
    (key) => Object.hasOwn(player, key),
  );
}

function normalizeSnapshot(
  record: Record<string, unknown>,
  roster: readonly CoworldEvaluationRosterSeat[],
): CoworldEvaluationSnapshot {
  if (Object.hasOwn(record, "players") && !Array.isArray(record.players)) {
    throw new Error("Invalid snapshot players");
  }
  const players = Array.isArray(record.players) ? record.players : [];
  const allowIndexFallback =
    players.length > 0 &&
    players.length === roster.length &&
    players.every((player) => !hasExplicitSnapshotIdentity(player));
  const normalizedPlayers = players.map((value, index) =>
    normalizeSnapshotPlayer({
      value,
      index,
      roster,
      allowIndexFallback,
    }),
  );
  validateUniqueSnapshotSeats(normalizedPlayers, "snapshot");
  return {
    label: asString(record.label) ?? "snapshot",
    turnNumber: asCount(record.turnNumber ?? record.turn_number),
    tick: asCount(record.tick),
    phase: asString(record.phase) ?? "unknown",
    players: normalizedPlayers,
  };
}

function normalizeEpisode(fragment: EpisodeFragment): CoworldEvaluationEpisode {
  if (fragment.scores === undefined || fragment.scores.length === 0) {
    throw new Error(`Episode ${fragment.episodeId} has no scores`);
  }
  if (!fragment.scores.every((score) => Number.isFinite(score))) {
    throw new Error(`Episode ${fragment.episodeId} has non-finite scores`);
  }
  if (
    fragment.outrightWinnerSlot !== undefined &&
    fragment.outrightWinnerSlot !== null &&
    fragment.outrightWinnerSlot >= fragment.scores.length
  ) {
    throw new Error(`Episode ${fragment.episodeId} has an invalid winner_slot`);
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
  const decisions = revalidateDecisionsForRoster(fragment.decisions, roster);
  const snapshots = revalidateSnapshotsForRoster(
    fragment.snapshots,
    roster,
    fragment.episodeId,
  );
  return {
    episodeId: fragment.episodeId,
    sourcePaths: fragment.sourcePaths,
    runID: fragment.runID ?? null,
    platformCompletedAt: fragment.platformCompletedAt ?? null,
    runtimeCompletedAt: fragment.runtimeCompletedAt ?? null,
    map: fragment.map ?? "Unknown map",
    mapSize: fragment.mapSize ?? null,
    scores: fragment.scores,
    outrightWinnerSlot: fragment.outrightWinnerSlot ?? null,
    roster,
    decisions,
    snapshots,
    episodeReportedTelemetry: {
      result: normalizeReportedTelemetry(
        fragment.episodeReportedTelemetry.result,
      ),
      summary: normalizeReportedTelemetry(
        fragment.episodeReportedTelemetry.summary,
      ),
    },
  };
}

function normalizeReportedTelemetry(
  telemetry: Partial<CoworldEpisodeReportedTelemetry["result"]>,
): CoworldEpisodeReportedTelemetry["result"] {
  return {
    decisionCount: telemetry.decisionCount ?? null,
    fallbackCount: telemetry.fallbackCount ?? null,
    degradedCount: telemetry.degradedCount ?? null,
    parseFailureCount: telemetry.parseFailureCount ?? null,
  };
}

interface FallbackEpisodeIdentity {
  id: string;
  aliases: string[];
}

function artifactSourceRoot(filePath: string): string {
  const resolved = path.resolve(filePath);
  const base = path.basename(resolved);
  if (base === "replay" || base === "results.json") {
    return path.dirname(resolved);
  }
  if (base === "match-summary.json") {
    const segments = resolved.split(path.sep);
    const proxyWarRunsIndex = segments.lastIndexOf("proxywar-runs");
    if (proxyWarRunsIndex > 0) {
      return segments.slice(0, proxyWarRunsIndex).join(path.sep) || path.sep;
    }
    return path.dirname(resolved);
  }
  return resolved;
}

async function fallbackEpisodeIdentity(
  filePath: string,
): Promise<FallbackEpisodeIdentity> {
  const canonicalFilePath = await fs.realpath(path.resolve(filePath));
  const sourceRoot = artifactSourceRoot(canonicalFilePath);
  const label =
    path
      .basename(sourceRoot)
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .slice(0, 48) || "root";
  const digest = createHash("sha256").update(sourceRoot).digest("hex");
  const base = path.basename(canonicalFilePath);
  const replayAlias = base.endsWith(".replay")
    ? base.replace(/\.replay$/i, "")
    : null;
  return {
    id: `source_${label}_${digest}`,
    aliases:
      replayAlias === null || !/^ereq_/i.test(replayAlias) ? [] : [replayAlias],
  };
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
  fallbackIdentity: FallbackEpisodeIdentity,
  warnings: string[],
  stats: CoworldEvaluationLoadStats,
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
  const runID = asString(summary.runID);
  const bundleIdentity = runID ?? path.basename(directory);
  if (summary.scenario !== "coworld" && !/coworld/i.test(bundleIdentity)) {
    return [];
  }
  const fragments = parseCoworldEvaluationDocument({
    value: {
      ...(runID === null ? {} : { runID }),
      completedAt: summary.completedAt,
      config: asRecord(summary.runnerConfig),
      ...(spectatorReplay === undefined ? {} : { spectatorReplay }),
      inlineRunArtifacts: {
        "match-summary.json": summaryText,
        ...(decisions === null ? {} : { "decisions.jsonl": decisions }),
      },
    },
    sourcePath: summaryPath,
    fallbackId: fallbackIdentity.id,
    identityAliases: fallbackIdentity.aliases,
    allowFallbackIdentity: true,
    warnings,
    stats,
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
  const rightKeys = new Set(right.episodeIdentityKeys);
  return left.episodeIdentityKeys.some((key) => rightKeys.has(key));
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
  const stats: CoworldEvaluationLoadStats = {
    skippedNonCompletedEntries: 0,
    skippedByStatus: {},
  };
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
    const skippedBefore = stats.skippedNonCompletedEntries;
    const fallbackIdentity = await fallbackEpisodeIdentity(filePath);
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
        ? await parseSidecarBundle(filePath, fallbackIdentity, warnings, stats)
        : parseCoworldEvaluationDocument({
            value: parsed,
            sourcePath: filePath,
            fallbackId: fallbackIdentity.id,
            identityAliases: fallbackIdentity.aliases,
            warnings,
            stats,
          });
    if (fragments.length === 0) {
      if (stats.skippedNonCompletedEntries > skippedBefore) {
        continue;
      }
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
  if (stats.skippedNonCompletedEntries > 0) {
    const statusSummary = Object.entries(stats.skippedByStatus)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `${status}=${count}`)
      .join(", ");
    warnings.push(
      `Skipped ${stats.skippedNonCompletedEntries} explicitly non-completed episode entr${stats.skippedNonCompletedEntries === 1 ? "y" : "ies"} (${statusSummary})`,
    );
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
  return { episodes, warnings, stats };
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
    skippedNonCompletedEntries: loaded.stats.skippedNonCompletedEntries,
    skippedByStatus: loaded.stats.skippedByStatus,
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
