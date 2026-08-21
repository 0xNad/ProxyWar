import fs from "node:fs/promises";
import type {
  AgentMetric,
  AgentStatsSlice,
  NamedCount,
  TerritoryShareResult,
} from "./AgentStatsPipeline";

/**
 * Shared type + reader for the cached artifact `compute-agent-stats.ts`
 * writes and both stats consumers (`CoworldLeagueSiteWriter.ts`'s
 * `/agent/:slug` read-model projection, `LeaguePlayerProfile.ts`'s
 * `/api/players/:name`) read — "one computation source, two views, never
 * divergent numbers" (spec Stage 6 item 6) holds by construction: neither
 * consumer recomputes, both parse this exact file.
 *
 * Lives under `src/server/agents/` (not the `src/scripts/` script that
 * writes it) so consumers never import a script module — matching this
 * repo's existing script/core split (e.g. `CoworldLeagueMirrorCore.ts` vs.
 * `coworld-league-mirror.ts`).
 */

export interface PlayerAgentStats {
  playerName: string;
  career: AgentStatsSlice;
  currentVersion: (AgentStatsSlice & { versionLabel: string }) | null;
}

export interface AgentStatsArtifact {
  schemaVersion: 1;
  generatedAt: string;
  episodesScanned: number;
  players: readonly PlayerAgentStats[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAgentMetric(value: unknown): value is AgentMetric {
  return (
    isRecord(value) &&
    isFiniteNumber(value.value) &&
    isFiniteNumber(value.sampleSize) &&
    isFiniteNumber(value.threshold) &&
    typeof value.methodology === "string"
  );
}

function isOptionalAgentMetric(value: unknown): value is AgentMetric | null {
  return value === null || isAgentMetric(value);
}

function isSampleMean(
  value: unknown,
): value is { mean: number; sampleSize: number } {
  return (
    isRecord(value) &&
    isFiniteNumber(value.mean) &&
    isFiniteNumber(value.sampleSize)
  );
}

function isRankMean(
  value: unknown,
): value is { value: number; sampleSize: number } {
  return (
    isRecord(value) &&
    isFiniteNumber(value.value) &&
    isFiniteNumber(value.sampleSize)
  );
}

function isTerritoryShare(value: unknown): value is TerritoryShareResult {
  return (
    isRecord(value) &&
    isOptionalAgentMetric(value.share) &&
    (value.absoluteTiles === null || isSampleMean(value.absoluteTiles)) &&
    (value.meanRank === null || isRankMean(value.meanRank))
  );
}

function isNamedCount(value: unknown): value is NamedCount {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isFiniteNumber(value.count)
  );
}

function isAgentStatsSlice(value: unknown): value is AgentStatsSlice {
  if (!isRecord(value) || !isFiniteNumber(value.episodeCount)) return false;
  const fingerprint = value.fingerprint;
  const social = value.social;
  return (
    isRecord(fingerprint) &&
    isOptionalAgentMetric(fingerprint.aggression) &&
    isOptionalAgentMetric(fingerprint.diplomacyInitiated) &&
    isOptionalAgentMetric(fingerprint.economicFocus) &&
    isTerritoryShare(fingerprint.territory) &&
    isOptionalAgentMetric(fingerprint.armyStrength) &&
    isOptionalAgentMetric(fingerprint.reliability) &&
    isRecord(social) &&
    isOptionalAgentMetric(social.alliancesInitiated) &&
    isOptionalAgentMetric(social.allianceAcceptanceRate) &&
    isOptionalAgentMetric(social.betrayalCount) &&
    Array.isArray(social.frequentAllies) &&
    social.frequentAllies.every(isNamedCount) &&
    Array.isArray(social.primaryAdversaries) &&
    social.primaryAdversaries.every(isNamedCount) &&
    isOptionalAgentMetric(social.treatyDuration)
  );
}

function isPlayerAgentStats(value: unknown): value is PlayerAgentStats {
  if (
    !isRecord(value) ||
    typeof value.playerName !== "string" ||
    !isAgentStatsSlice(value.career)
  ) {
    return false;
  }
  if (value.currentVersion === null) return true;
  return (
    isRecord(value.currentVersion) &&
    typeof value.currentVersion.versionLabel === "string" &&
    isAgentStatsSlice(value.currentVersion)
  );
}

/**
 * Reads and parses the cached artifact. Tolerant of absence (the batch job
 * hasn't run yet — a genuinely normal cold-start state, same as every
 * other optional-artifact read in this mirror) or corruption: any failure
 * resolves to `null` rather than throwing, so a missing/malformed stats
 * file degrades every consumer to "no stats yet" instead of failing a
 * league publish or a profile request.
 */
export async function readAgentStatsArtifact(
  filePath: string,
): Promise<AgentStatsArtifact | null> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (
      !isRecord(raw) ||
      raw.schemaVersion !== 1 ||
      typeof raw.generatedAt !== "string" ||
      !isFiniteNumber(raw.episodesScanned) ||
      !Array.isArray(raw.players) ||
      !raw.players.every(isPlayerAgentStats)
    ) {
      return null;
    }
    return raw as unknown as AgentStatsArtifact;
  } catch {
    return null;
  }
}

/** Finds one player's stats by exact playerName match — the same join key `LeaguePlayerProfile.ts`'s `buildLeaguePlayerSection` already uses against the mirror's standings/episodes. */
export function findPlayerStats(
  artifact: AgentStatsArtifact | null,
  playerName: string,
): PlayerAgentStats | null {
  if (artifact === null) return null;
  return artifact.players.find((p) => p.playerName === playerName) ?? null;
}
