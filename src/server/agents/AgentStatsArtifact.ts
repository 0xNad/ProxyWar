import fs from "node:fs/promises";
import type { AgentStatsSlice } from "./AgentStatsPipeline";

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
      typeof raw !== "object" ||
      raw === null ||
      (raw as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !Array.isArray((raw as { players?: unknown }).players)
    ) {
      return null;
    }
    return raw as AgentStatsArtifact;
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
