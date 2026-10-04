import fs from "node:fs/promises";
import path from "node:path";
import {
  COWORLD_LEAGUE_WORLD_FILE,
  COWORLD_LEAGUE_WORLD_SOURCE_FILE,
  writeFileAtomic,
  type CoworldLeagueEpisodeRow,
  type CoworldLeagueMirrorData,
} from "./CoworldLeagueSiteWriter";
import {
  buildPublicWorldModel,
  EMPTY_WORLD_LEDGER,
  mergeWorldLedger,
  reduceWorld,
  type PublicWorldLinks,
  type WorldAgentIdentity,
  type WorldLedgerBattle,
} from "./CoworldLeagueWorld";

/**
 * The Frontier Four: four teams of three nations, each team one frontier
 * model, fighting over the fronts of the world map in hosted team games
 * that our own scheduler creates. This module turns the scheduler's game
 * records into the same world the league feeds, publishes `world.json`
 * from them, and marks the site so the league mirror leaves the world
 * alone while the Frontier Four holds it.
 *
 * A game record is one completed hosted episode. The scheduler appends one
 * JSON line per game to `frontier-four-games.jsonl`; this module never
 * writes that file, only reads it, so the records are the ledger.
 */

export const FRONTIER_FOUR_GAMES_FILE = "frontier-four-games.jsonl";
/** `/match/<id>` rows for Frontier Four games, read by the demo server. */
export const FRONTIER_FOUR_EPISODES_FILE = "frontier-episodes.json";

export interface FrontierFourTeam {
  /** The team's name on the map: the model's name. */
  readonly label: string;
  /** The canonical OpenRouter slug the team's three seats run on. */
  readonly model: string;
  readonly color: string;
  readonly secondaryColor: string;
  readonly emblemSvg: string;
}

function emblem(letter: string, color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="4" fill="${color}"/>` +
    `<text x="16" y="22" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="18" font-weight="700" fill="#0b1220">${letter}</text>` +
    `</svg>`
  );
}

export const FRONTIER_FOUR_TEAMS: readonly FrontierFourTeam[] = [
  {
    label: "Astra",
    model: "openai/gpt-6-astra",
    color: "#60a5fa",
    secondaryColor: "#1e3a8a",
    emblemSvg: emblem("A", "#60a5fa"),
  },
  {
    label: "Fable",
    model: "anthropic/claude-fable-5.1",
    color: "#f59e0b",
    secondaryColor: "#78350f",
    emblemSvg: emblem("F", "#f59e0b"),
  },
  {
    label: "Gemini",
    model: "google/gemini-3.1-pro-preview",
    color: "#a78bfa",
    secondaryColor: "#4c1d95",
    emblemSvg: emblem("G", "#a78bfa"),
  },
  {
    label: "Grok",
    model: "x-ai/grok-4.7",
    color: "#34d399",
    secondaryColor: "#064e3b",
    emblemSvg: emblem("X", "#34d399"),
  },
];

export interface FrontierFourGameTeam {
  readonly label: string;
  readonly model: string;
  /** The engine's team name for this side (`Red`, `Blue`, …), once known. */
  readonly team: string | null;
  readonly slots: readonly number[];
}

export interface FrontierFourGamePlayer {
  readonly slot: number;
  readonly name: string;
  readonly team: string | null;
  readonly tilesOwned: number | null;
  readonly isAlive: boolean | null;
}

export interface FrontierFourGameRecord {
  readonly schemaVersion: 1;
  readonly experienceRequestId: string;
  readonly episodeRequestId: string;
  readonly variantId: string;
  readonly map: string;
  readonly mapSize: string;
  readonly completedAt: string;
  readonly replayUrl: string | null;
  readonly costUsd: number | null;
  /** The scheduler's cycle through the fronts; stands in for a round number. */
  readonly cycle: number;
  readonly teams: readonly FrontierFourGameTeam[];
  readonly winnerTeam: string | null;
  readonly scores: readonly number[];
  readonly players: readonly FrontierFourGamePlayer[];
  readonly turnCount: number | null;
  readonly decisionCount: number | null;
  readonly degradedCount: number | null;
}

const EPISODE_REQUEST_ID_PATTERN = /^ereq_[A-Za-z0-9_-]{1,160}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** One line of the games file, or `null` when it is not a usable record. */
export function parseFrontierFourGameRecord(
  value: unknown,
): FrontierFourGameRecord | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const episodeRequestId = optionalString(value.episodeRequestId);
  if (
    episodeRequestId === null ||
    !EPISODE_REQUEST_ID_PATTERN.test(episodeRequestId)
  ) {
    return null;
  }
  const map = optionalString(value.map);
  const completedAt = optionalString(value.completedAt);
  if (map === null || completedAt === null) return null;
  if (!Number.isFinite(Date.parse(completedAt))) return null;
  const cycle = optionalNumber(value.cycle);
  if (cycle === null || !Number.isInteger(cycle) || cycle < 1) return null;
  const teams = Array.isArray(value.teams) ? value.teams : [];
  const parsedTeams: FrontierFourGameTeam[] = [];
  for (const entry of teams) {
    if (!isRecord(entry)) return null;
    const label = optionalString(entry.label);
    const model = optionalString(entry.model);
    const slots = Array.isArray(entry.slots)
      ? entry.slots.filter(
          (slot): slot is number =>
            typeof slot === "number" && Number.isInteger(slot) && slot >= 0,
        )
      : [];
    if (label === null || model === null || slots.length === 0) return null;
    parsedTeams.push({
      label,
      model,
      team: optionalString(entry.team),
      slots,
    });
  }
  if (parsedTeams.length < 2) return null;
  const players = Array.isArray(value.players) ? value.players : [];
  const parsedPlayers: FrontierFourGamePlayer[] = [];
  for (const entry of players) {
    if (!isRecord(entry)) continue;
    const slot = optionalNumber(entry.slot);
    const name = optionalString(entry.name);
    if (slot === null || name === null) continue;
    parsedPlayers.push({
      slot,
      name,
      team: optionalString(entry.team),
      tilesOwned: optionalNumber(entry.tilesOwned),
      isAlive: typeof entry.isAlive === "boolean" ? entry.isAlive : null,
    });
  }
  return {
    schemaVersion: 1,
    experienceRequestId: optionalString(value.experienceRequestId) ?? "",
    episodeRequestId,
    variantId: optionalString(value.variantId) ?? "",
    map,
    mapSize: optionalString(value.mapSize) ?? "",
    completedAt: new Date(Date.parse(completedAt)).toISOString(),
    replayUrl: optionalString(value.replayUrl),
    costUsd: optionalNumber(value.costUsd),
    cycle,
    teams: parsedTeams,
    winnerTeam: optionalString(value.winnerTeam),
    scores: Array.isArray(value.scores)
      ? value.scores.filter(
          (score): score is number => typeof score === "number",
        )
      : [],
    players: parsedPlayers,
    turnCount: optionalNumber(value.turnCount),
    decisionCount: optionalNumber(value.decisionCount),
    degradedCount: optionalNumber(value.degradedCount),
  };
}

/** Every usable record in the games file, in file order; a missing file is no games. */
export async function readFrontierFourGames(
  gamesPath: string,
): Promise<FrontierFourGameRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(gamesPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: FrontierFourGameRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parseFrontierFourGameRecord(value);
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * The winning team's label: by the engine team name the scheduler recorded,
 * else by which side the winning players' slots belong to.
 */
export function frontierFourWinnerLabel(
  record: FrontierFourGameRecord,
): string | null {
  if (record.winnerTeam === null) return null;
  const byTeam = record.teams.find((team) => team.team === record.winnerTeam);
  if (byTeam !== undefined) return byTeam.label;
  const winningSlots = new Set(
    record.players
      .filter((player) => player.team === record.winnerTeam)
      .map((player) => player.slot),
  );
  const bySlot = record.teams.find((team) =>
    team.slots.some((slot) => winningSlots.has(slot)),
  );
  return bySlot?.label ?? null;
}

function teamOfSlot(
  record: FrontierFourGameRecord,
  slot: number,
): FrontierFourGameTeam | null {
  return record.teams.find((team) => team.slots.includes(slot)) ?? null;
}

/** One game as a world battle: the team, not the seat, holds the front. */
export function frontierFourBattle(
  record: FrontierFourGameRecord,
): WorldLedgerBattle {
  return {
    episodeRequestId: record.episodeRequestId,
    map: record.map,
    winnerName: frontierFourWinnerLabel(record),
    playerCount: record.players.length,
    roundNumber: record.cycle,
    battleAt: record.completedAt,
  };
}

/** The `/match/<id>` row for a game, in the league's own row shape. */
export function frontierFourEpisodeRow(
  record: FrontierFourGameRecord,
  teams: readonly FrontierFourTeam[] = FRONTIER_FOUR_TEAMS,
): CoworldLeagueEpisodeRow {
  const winnerLabel = frontierFourWinnerLabel(record);
  const colorOf = (label: string | null) =>
    teams.find((team) => team.label === label)?.color ?? "#94a3b8";
  return {
    episodeRequestId: record.episodeRequestId,
    shortId: record.episodeRequestId.replace(/^ereq_/, "").slice(0, 8),
    roundNumber: record.cycle,
    completedAt: record.completedAt,
    map: record.map,
    mapSize: record.mapSize,
    turnCount: record.turnCount,
    decisionCount: record.decisionCount,
    degradedCount: record.degradedCount,
    winnerName: winnerLabel,
    players: record.players.map((player) => {
      const side = teamOfSlot(record, player.slot);
      return {
        slot: player.slot,
        name: player.name,
        tilesOwned: player.tilesOwned ?? 0,
        isAlive: player.isAlive ?? false,
        isWinner:
          winnerLabel !== null && side !== null && side.label === winnerLabel,
        color: colorOf(side?.label ?? null),
      };
    }),
    watchHref: record.replayUrl,
    fullRenderHref: null,
  };
}

/** The four teams as page identities, keyed by label. */
export function frontierFourIdentities(
  teams: readonly FrontierFourTeam[] = FRONTIER_FOUR_TEAMS,
): Map<string, WorldAgentIdentity> {
  return new Map(
    teams.map((team) => [
      team.label,
      {
        name: team.label,
        label: team.label,
        slug: null,
        color: team.color,
        secondaryColor: team.secondaryColor,
        emblemSvg: team.emblemSvg,
        isHouse: false,
      },
    ]),
  );
}

/** The feed facts the world builder reads, for a world the league did not play. */
export function frontierFourMirrorData(
  records: readonly FrontierFourGameRecord[],
  now: string,
): CoworldLeagueMirrorData {
  const latestCycle = records.reduce(
    (best, record) => Math.max(best, record.cycle),
    0,
  );
  return {
    generatedAt: now,
    lastGoodSyncAt: now,
    stale: false,
    league: {
      id: "frontier-four",
      name: "Frontier Four",
      description:
        "Four teams of three nations, each team one frontier model, fight over the fronts of the world map.",
      divisionName: "Frontier Four",
      roundIntervalMinutes: null,
      episodesPerRound: null,
      currentRoundNumber: latestCycle > 0 ? latestCycle : null,
      currentRoundStatus: latestCycle > 0 ? "running" : null,
      scoreLabel: "Wins",
    },
    standings: [],
    rounds: [],
    episodes: [],
    links: {
      enterTheLeagueUrl: "https://github.com/0xNad/proxywar-coworld-starter",
      platformLabel: "Softmax Observatory",
    },
  };
}

export interface FrontierFourPublication {
  readonly worldPath: string;
  readonly episodesPath: string;
  readonly games: number;
  readonly battles: number;
}

/**
 * Publishes `world.json`, the `/match/<id>` rows and the source marker into
 * the league site directory from the games file. Idempotent: the same games
 * produce the same files, and nothing is written when nothing changed.
 */
export async function publishFrontierFourWorld(args: {
  readonly siteDir: string;
  readonly gamesPath?: string;
  readonly now?: string;
  readonly links?: PublicWorldLinks | null;
  readonly teams?: readonly FrontierFourTeam[];
}): Promise<FrontierFourPublication> {
  const gamesPath =
    args.gamesPath ?? path.join(args.siteDir, FRONTIER_FOUR_GAMES_FILE);
  const now = args.now ?? new Date().toISOString();
  const teams = args.teams ?? FRONTIER_FOUR_TEAMS;
  const records = await readFrontierFourGames(gamesPath);
  const ledger = mergeWorldLedger(
    EMPTY_WORLD_LEDGER,
    records.map(frontierFourBattle),
  );
  const world = buildPublicWorldModel({
    state: reduceWorld(ledger),
    ledger,
    data: frontierFourMirrorData(records, now),
    readModelAgents: [],
    identities: frontierFourIdentities(teams),
    links: args.links ?? null,
    generatedAt: now,
  });
  const worldPath = path.join(args.siteDir, COWORLD_LEAGUE_WORLD_FILE);
  const episodesPath = path.join(args.siteDir, FRONTIER_FOUR_EPISODES_FILE);
  await fs.mkdir(args.siteDir, { recursive: true });
  // The marker first, so a mirror publish racing this one already yields.
  await writeFileAtomic(
    path.join(args.siteDir, COWORLD_LEAGUE_WORLD_SOURCE_FILE),
    `${JSON.stringify({ source: "frontier-four" })}\n`,
  );
  await writeFileAtomic(
    episodesPath,
    `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: now,
      episodes: records.map((record) => frontierFourEpisodeRow(record, teams)),
    })}\n`,
  );
  await writeFileAtomic(
    worldPath,
    `${JSON.stringify({
      ...world,
      mode: "frontier-four",
      teams: teams.map((team) => ({ label: team.label, model: team.model })),
    })}\n`,
  );
  return {
    worldPath,
    episodesPath,
    games: records.length,
    battles: ledger.battles.length,
  };
}

/** Hands `world.json` back to the league mirror; the next mirror publish rebuilds it. */
export async function restoreLeagueWorldSource(siteDir: string): Promise<void> {
  await writeFileAtomic(
    path.join(siteDir, COWORLD_LEAGUE_WORLD_SOURCE_FILE),
    `${JSON.stringify({ source: "league" })}\n`,
  );
}
