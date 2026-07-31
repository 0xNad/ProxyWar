/**
 * Server-side reader + per-player aggregation over the public league mirror
 * output (`artifacts/ai-league-runs/league/data.json`, written by
 * `CoworldLeagueSiteWriter`/`coworld-league-mirror.ts`). Feeds the platform
 * player-profile page (`GET /api/players/:name`) — the league half only;
 * betting stats are joined separately in the HTTP route from the points
 * ledger, which this module never touches or even knows about.
 *
 * Reads the file directly off disk rather than importing the client-side
 * `leagueData.ts` parser: that module is browser-oriented (its module-level
 * cache and `fetch` call assume a page load), and server code stays out of
 * `src/client` by convention — this mirrors `CoworldLeagueSiteWriter`'s own
 * parallel `CoworldLeagueStandingRow`/`CoworldLeagueEpisodeRow` types rather
 * than reusing anything from the client tree.
 *
 * Parsing is defensive, never throwing on a malformed or half-written file:
 * this is written by a separate process on its own cadence (every
 * `COWORLD_LEAGUE_POLL_INTERVAL_MS`), so a profile request landing mid-write
 * must degrade to "no league data for this player" rather than 500.
 *
 * PUBLIC DATA ONLY: every field here comes straight from the public mirror
 * file. This module has no access to (and must never gain access to) the
 * private league-claim store or the GitHub identity link store — the
 * profile route joins betting separately, keyed by a VERIFIED GitHub login,
 * never by anything from here.
 */
import { promises as fs } from "node:fs";
import {
  findPlayerStats,
  type AgentStatsArtifact,
} from "./AgentStatsArtifact";
import type { PublicAgentStats } from "../ProxyWarPublicReadModel";

export interface PlayerProfileStanding {
  readonly rank: number;
  readonly ratingPolicyLabel: string | null;
  readonly activeChampionPolicyLabel: string | null;
  readonly score: number | null;
  readonly roundsPlayed: number | null;
  readonly isHouse: boolean;
}

export interface PlayerProfileEpisode {
  readonly roundNumber: number | null;
  readonly completedAt: string | null;
  readonly map: string | null;
  readonly turnCount: number | null;
  readonly tilesOwned: number | null;
  readonly isAlive: boolean;
  readonly isWinner: boolean;
  readonly watchHref: string | null;
  readonly fullRenderHref: string | null;
}

export interface PlayerProfileLeagueSection {
  readonly generatedAt: string | null;
  readonly lastGoodSyncAt: string | null;
  readonly stale: boolean;
  /** `null` when this name never appears in the retained standings — the player may still have episode history below (e.g. a house seat retired from ranking). */
  readonly standing: PlayerProfileStanding | null;
  /**
   * Human-readable note for when the rating feed lags the live champion
   * policy — the exact "someone shipped a new version" moment this page
   * exists to surface. `null` when they match, or either is unknown.
   */
  readonly policyLineageNote: string | null;
  /** Newest-first. Only the episodes retained in the mirror (12-16 typically) — never a longer history than the source actually keeps. */
  readonly episodes: readonly PlayerProfileEpisode[];
  /** Record over `episodes` ONLY — never extrapolated past the retained window. `null` with no retained episodes for this player. */
  readonly recentRecord: { readonly wins: number; readonly played: number } | null;
  /**
   * Product overhaul spec Stage 6: the SAME `career`/`currentVersion`
   * fingerprint+social object the public read model's `PublicAgent.stats`
   * carries for this exact `playerName` — "one computation source, two
   * views, never divergent numbers" (spec item 6) holds because both read
   * the SAME `agent-stats.json` artifact, neither recomputes. `null` when
   * the stats batch job hasn't produced a row for this player yet.
   */
  readonly stats: PublicAgentStats | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface ParsedStandingRow {
  rank: number;
  playerName: string;
  ratingPolicyLabel: string | null;
  activeChampionPolicyLabel: string | null;
  score: number | null;
  roundsPlayed: number | null;
  isHouse: boolean;
}

function parseStandingRow(value: unknown): ParsedStandingRow | null {
  if (!isRecord(value)) return null;
  const rank = asNumber(value.rank);
  const playerName = asString(value.playerName);
  if (rank === null || playerName === null) return null;
  // Old snapshots used `policyLabel` for the rating row — same fallback
  // `CoworldLeagueSiteWriter.standingsTable` applies.
  const ratingPolicyLabel =
    asString(value.ratingPolicyLabel) ?? asString(value.policyLabel);
  return {
    rank,
    playerName,
    ratingPolicyLabel,
    activeChampionPolicyLabel: asString(value.activeChampionPolicyLabel),
    score: asNumber(value.score),
    roundsPlayed: asNumber(value.roundsPlayed),
    isHouse: asBoolean(value.isHouse, false),
  };
}

interface ParsedEpisodePlayerRow {
  name: string;
  tilesOwned: number | null;
  isAlive: boolean;
  isWinner: boolean;
}

function parseEpisodePlayerRow(value: unknown): ParsedEpisodePlayerRow | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  if (name === null) return null;
  return {
    name,
    tilesOwned: asNumber(value.tilesOwned),
    isAlive: asBoolean(value.isAlive, false),
    isWinner: asBoolean(value.isWinner, false),
  };
}

interface ParsedEpisodeRow {
  roundNumber: number | null;
  completedAt: string | null;
  map: string | null;
  turnCount: number | null;
  watchHref: string | null;
  fullRenderHref: string | null;
  players: ParsedEpisodePlayerRow[];
}

function parseEpisodeRow(value: unknown): ParsedEpisodeRow | null {
  if (!isRecord(value)) return null;
  const rawPlayers = Array.isArray(value.players) ? value.players : [];
  const players = rawPlayers
    .map(parseEpisodePlayerRow)
    .filter((row): row is ParsedEpisodePlayerRow => row !== null);
  return {
    roundNumber: asNumber(value.roundNumber),
    completedAt: asString(value.completedAt),
    map: asString(value.map),
    turnCount: asNumber(value.turnCount),
    watchHref: asString(value.watchHref),
    fullRenderHref: asString(value.fullRenderHref),
    players,
  };
}

export interface ParsedLeagueMirrorData {
  generatedAt: string | null;
  lastGoodSyncAt: string | null;
  stale: boolean;
  standings: readonly ParsedStandingRow[];
  episodes: readonly ParsedEpisodeRow[];
}

/**
 * Reads and parses the mirror file. `null` for anything short of "a JSON
 * object with the fields we need" — missing file, malformed JSON, wrong
 * top-level shape — so the caller renders "league data unavailable" for
 * this player instead of a 500.
 */
export async function readLeagueMirrorData(
  dataJsonPath: string,
): Promise<ParsedLeagueMirrorData | null> {
  let raw: unknown;
  try {
    const text = await fs.readFile(dataJsonPath, "utf8");
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const standings = Array.isArray(raw.standings)
    ? raw.standings
        .map(parseStandingRow)
        .filter((row): row is ParsedStandingRow => row !== null)
    : [];
  const episodes = Array.isArray(raw.episodes)
    ? raw.episodes
        .map(parseEpisodeRow)
        .filter((row): row is ParsedEpisodeRow => row !== null)
    : [];
  return {
    generatedAt: asString(raw.generatedAt),
    lastGoodSyncAt: asString(raw.lastGoodSyncAt),
    stale: asBoolean(raw.stale, false),
    standings,
    episodes,
  };
}

function episodeSortKey(episode: ParsedEpisodeRow): number {
  if (episode.completedAt !== null) {
    const parsed = Date.parse(episode.completedAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return episode.roundNumber ?? -Infinity;
}

/**
 * Builds the league half of one player's profile. `null` only when the name
 * appears NOWHERE — no standings row, no episode roster — across the whole
 * retained mirror; the caller then falls back to the betting section (or a
 * genuine 404 if that is empty too).
 */
export function buildLeaguePlayerSection(
  data: ParsedLeagueMirrorData,
  playerName: string,
  statsArtifact: AgentStatsArtifact | null = null,
): PlayerProfileLeagueSection | null {
  const standingRow =
    data.standings.find((row) => row.playerName === playerName) ?? null;
  const episodes = data.episodes
    .filter((episode) =>
      episode.players.some((player) => player.name === playerName),
    )
    .slice()
    .sort((a, b) => episodeSortKey(b) - episodeSortKey(a));
  if (standingRow === null && episodes.length === 0) return null;

  const policyLineageNote =
    standingRow !== null &&
    standingRow.activeChampionPolicyLabel !== null &&
    standingRow.ratingPolicyLabel !== null &&
    standingRow.activeChampionPolicyLabel !== standingRow.ratingPolicyLabel
      ? `Now playing as "${standingRow.activeChampionPolicyLabel}" — the rank and rating above still reflect the previous "${standingRow.ratingPolicyLabel}", pending the next rating pass.`
      : null;

  const episodeViews: PlayerProfileEpisode[] = episodes.map((episode) => {
    const self =
      episode.players.find((player) => player.name === playerName) ?? null;
    return {
      roundNumber: episode.roundNumber,
      completedAt: episode.completedAt,
      map: episode.map,
      turnCount: episode.turnCount,
      tilesOwned: self?.tilesOwned ?? null,
      isAlive: self?.isAlive ?? false,
      isWinner: self?.isWinner ?? false,
      watchHref: episode.watchHref,
      fullRenderHref: episode.fullRenderHref,
    };
  });

  const recentRecord =
    episodeViews.length === 0
      ? null
      : {
          wins: episodeViews.filter((episode) => episode.isWinner).length,
          played: episodeViews.length,
        };

  const playerStats = findPlayerStats(statsArtifact, playerName);
  return {
    generatedAt: data.generatedAt,
    lastGoodSyncAt: data.lastGoodSyncAt,
    stale: data.stale,
    standing:
      standingRow === null
        ? null
        : {
            rank: standingRow.rank,
            ratingPolicyLabel: standingRow.ratingPolicyLabel,
            activeChampionPolicyLabel: standingRow.activeChampionPolicyLabel,
            score: standingRow.score,
            roundsPlayed: standingRow.roundsPlayed,
            isHouse: standingRow.isHouse,
          },
    policyLineageNote,
    episodes: episodeViews,
    recentRecord,
    stats: playerStats === null
      ? null
      : { career: playerStats.career, currentVersion: playerStats.currentVersion },
  };
}
