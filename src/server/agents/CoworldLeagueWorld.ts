import { promises as fs } from "node:fs";
import { computeProvisionalIdentities } from "../identity/ProvisionalIdentity";
import type { PublicAgent } from "../ProxyWarPublicReadModel";
import type { CoworldLeagueMirrorData } from "./CoworldLeagueSiteWriter";

/**
 * The persistent world map over the hosted league (`/world`).
 *
 * League battles are finite, fixed-roster episodes; nothing inside a match
 * carries over to the next one. The world is a layer ABOVE them: every
 * battle is fought on a real map (East Asia, Oceania, the Black Sea, ...),
 * each map belongs to one theatre of a persistent Earth map, and a
 * theatre is held by whichever agent won the most of its last
 * `WORLD_FRONT_WINDOW` battles. Ties keep the current holder, so a
 * challenger must win strictly more of the window to take a front; a tie
 * is a siege (one more win flips it). The whole-world maps (Pangaea, World,
 * Giant World Map) decide the Crown instead of a region.
 *
 * Why a rolling window rather than "the last winner takes it": league
 * battles are 16-player free-for-alls, so a holder wins only a small share
 * of any single battle. Replayed over the archived league history
 * (14,475 battles, 2026-07-17..09-29) a 12-battle window moves each active
 * front roughly once or twice a day and leaves a third of fronts contested
 * at any moment; per-battle rules flipped fronts every other battle.
 *
 * Same pure-core split as `CoworldLeagueStandingsHistory.ts`:
 * `CoworldLeagueSiteWriter.ts` owns reading/writing `world-ledger.json`
 * (private, append-only battle results) and publishing `world.json` (the
 * public read model) inside its existing write lock; everything here is
 * deterministic and unit-testable. The ledger is the single source of
 * truth: `reduceWorld` rebuilds the entire world from it, so no derived
 * world state is ever stored.
 */

export const WORLD_FRONT_WINDOW = 12;
export const WORLD_PUBLIC_EVENT_LIMIT = 80;
export const WORLD_PUBLIC_TIMELINE_DAYS = 120;
const WORLD_REIGN_LIMIT = 6;
const WORLD_TALLY_LIMIT = 6;

export type WorldTheatreId =
  | "north_america"
  | "south_america"
  | "britannia"
  | "europe"
  | "black_sea"
  | "middle_east"
  | "africa"
  | "asia"
  | "east_asia"
  | "oceania"
  | "crown";

export interface WorldTheatreDefinition {
  readonly id: WorldTheatreId;
  /** Normalised league map keys (`normaliseWorldMapKey`) whose battles decide this theatre. */
  readonly mapKeys: readonly string[];
}

/**
 * Catalog order is display order. A map key appears in exactly one
 * theatre. Theatres with no battles yet are still published (as
 * `unclaimed`) so the page can show where the war has not reached — the
 * league's map rotation decides which fronts light up, with no code change.
 */
export const WORLD_THEATRES: readonly WorldTheatreDefinition[] = [
  { id: "north_america", mapKeys: ["northamerica"] },
  { id: "south_america", mapKeys: ["southamerica", "amazonriver"] },
  { id: "britannia", mapKeys: ["britannia", "britanniaclassic"] },
  {
    id: "europe",
    mapKeys: ["europe", "europeclassic", "italia", "iceland", "alps"],
  },
  { id: "black_sea", mapKeys: ["blacksea", "bosphorusstraits", "caucasus"] },
  { id: "middle_east", mapKeys: ["mena", "middleeast", "straitofhormuz"] },
  { id: "africa", mapKeys: ["africa", "niledelta"] },
  { id: "asia", mapKeys: ["asia", "yenisei", "baikal"] },
  { id: "east_asia", mapKeys: ["eastasia", "japan"] },
  {
    id: "oceania",
    mapKeys: ["oceania", "australia", "straitofmalacca"],
  },
  { id: "crown", mapKeys: ["pangaea", "world", "giantworldmap"] },
];

const THEATRE_BY_MAP_KEY: ReadonlyMap<string, WorldTheatreId> = new Map(
  WORLD_THEATRES.flatMap((theatre) =>
    theatre.mapKeys.map((key) => [key, theatre.id] as const),
  ),
);

/** `"Black Sea"`, `"BlackSea"` and `"blacksea"` all name the same battlefield. */
export function normaliseWorldMapKey(map: string): string {
  return map.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function worldTheatreForMap(map: string): WorldTheatreId | null {
  return THEATRE_BY_MAP_KEY.get(normaliseWorldMapKey(map)) ?? null;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface WorldLedgerBattle {
  /** Coworld's own episode-request id — the dedupe key and the `/match/:id` link. */
  readonly episodeRequestId: string;
  /** Battlefield exactly as the league reported it (e.g. `EastAsia`). */
  readonly map: string;
  /** `null` when the battle ended without a winner (timeout); it still ages the window. */
  readonly winnerName: string | null;
  readonly playerCount: number;
  readonly roundNumber: number | null;
  /** Best-known completion instant (ISO). */
  readonly battleAt: string;
}

export interface WorldLedgerStore {
  readonly schemaVersion: 1;
  readonly battles: readonly WorldLedgerBattle[];
}

export const EMPTY_WORLD_LEDGER: WorldLedgerStore = {
  schemaVersion: 1,
  battles: [],
};

const EPISODE_REQUEST_ID_PATTERN = /^ereq_[A-Za-z0-9_-]{1,160}$/;
const RUN_KEY_TIMESTAMP_PATTERN =
  /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/;

/** `league-coworld-2026-09-29T21-32-22-101Z-db392769` → `2026-09-29T21:32:22.101Z`. */
export function timestampFromRunKey(value: string | null): string | null {
  if (value === null) return null;
  const match = RUN_KEY_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return null;
  return canonicalInstant(
    `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`,
  );
}

function canonicalInstant(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * Battles a fresh mirror publish can contribute. A stale republish (no new
 * sync this cycle) contributes nothing: its rows were already recorded when
 * they were fresh, and re-reading them could only misdate them.
 *
 * `completedAt` is often absent on hosted episode rows; the mirror's run key
 * (`league-coworld-<instant>-<hash>`) is the next-best completion time, and
 * the sync instant is the last resort.
 */
export function battlesFromMirrorData(
  data: CoworldLeagueMirrorData,
): WorldLedgerBattle[] {
  if (data.stale) return [];
  const fallbackInstant = canonicalInstant(data.generatedAt);
  const battles: WorldLedgerBattle[] = [];
  for (const episode of data.episodes) {
    if (!EPISODE_REQUEST_ID_PATTERN.test(episode.episodeRequestId)) continue;
    if (typeof episode.map !== "string" || episode.map.trim() === "") continue;
    const battleAt =
      canonicalInstant(episode.completedAt) ??
      timestampFromRunKey(episode.fullRenderHref) ??
      timestampFromRunKey(episode.watchHref) ??
      fallbackInstant;
    if (battleAt === null) continue;
    const winnerName =
      typeof episode.winnerName === "string" && episode.winnerName.trim() !== ""
        ? episode.winnerName
        : null;
    battles.push({
      episodeRequestId: episode.episodeRequestId,
      map: episode.map,
      winnerName,
      playerCount: Array.isArray(episode.players) ? episode.players.length : 0,
      roundNumber:
        typeof episode.roundNumber === "number" &&
        Number.isFinite(episode.roundNumber)
          ? episode.roundNumber
          : null,
      battleAt,
    });
  }
  return battles;
}

/**
 * One battle from the mirror's durable compact archive
 * (`<summaryArchiveDir>/ereq_<id>.replay-summary.json.gz`, already gunzipped
 * and parsed) — the backfill source for history recorded before the world
 * existed. The archive carries no round number or completion time; the run
 * id's own timestamp (`coworld-<instant>-<hash>`) is the completion proxy,
 * the same one `battlesFromMirrorData` falls back to for live rows.
 */
export function battleFromArchivedReplaySummary(
  summary: unknown,
): WorldLedgerBattle | null {
  if (!isRecord(summary)) return null;
  const episodeRequestId = summary.episodeRequestId;
  if (
    typeof episodeRequestId !== "string" ||
    !EPISODE_REQUEST_ID_PATTERN.test(episodeRequestId)
  ) {
    return null;
  }
  const config = isRecord(summary.config) ? summary.config : null;
  const map = typeof config?.map === "string" ? config.map.trim() : "";
  if (map === "") return null;
  const battleAt = timestampFromRunKey(
    typeof summary.runID === "string" ? summary.runID : null,
  );
  if (battleAt === null) return null;
  const results = isRecord(summary.results) ? summary.results : null;
  const players = Array.isArray(results?.players) ? results.players : [];
  let winnerName: string | null = null;
  if (typeof results?.winner_slot === "number") {
    for (const player of players) {
      if (
        isRecord(player) &&
        player.slot === results.winner_slot &&
        typeof player.name === "string" &&
        player.name.trim() !== ""
      ) {
        winnerName = player.name;
        break;
      }
    }
  }
  if (winnerName === null) {
    const finalState = isRecord(summary.finalState) ? summary.finalState : null;
    const phase = typeof finalState?.phase === "string" ? finalState.phase : "";
    if (phase.startsWith("winner:") && phase.length > "winner:".length) {
      winnerName = phase.slice("winner:".length);
    }
  }
  return {
    episodeRequestId,
    map,
    winnerName,
    playerCount: players.length,
    roundNumber: null,
    battleAt,
  };
}

function compareBattles(a: WorldLedgerBattle, b: WorldLedgerBattle): number {
  if (a.battleAt !== b.battleAt) return a.battleAt < b.battleAt ? -1 : 1;
  return a.episodeRequestId < b.episodeRequestId
    ? -1
    : a.episodeRequestId > b.episodeRequestId
      ? 1
      : 0;
}

/**
 * Idempotent merge keyed by `episodeRequestId`. A battle seen again only
 * ever gains facts it was missing (a winner, a round number) — a recorded
 * winner is never overwritten, so a later partial row cannot rewrite
 * history. Returns the SAME store reference when nothing changed, so the
 * caller skips a no-op write (the common case between new battles).
 */
export function mergeWorldLedger(
  store: WorldLedgerStore,
  incoming: readonly WorldLedgerBattle[],
): WorldLedgerStore {
  if (incoming.length === 0) return store;
  const byId = new Map(
    store.battles.map((battle) => [battle.episodeRequestId, battle]),
  );
  let changed = false;
  for (const battle of incoming) {
    const existing = byId.get(battle.episodeRequestId);
    if (existing === undefined) {
      byId.set(battle.episodeRequestId, battle);
      changed = true;
      continue;
    }
    const winnerName = existing.winnerName ?? battle.winnerName;
    const roundNumber = existing.roundNumber ?? battle.roundNumber;
    if (
      winnerName !== existing.winnerName ||
      roundNumber !== existing.roundNumber
    ) {
      byId.set(battle.episodeRequestId, {
        ...existing,
        winnerName,
        roundNumber,
      });
      changed = true;
    }
  }
  if (!changed) return store;
  return {
    schemaVersion: 1,
    battles: [...byId.values()].sort(compareBattles),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLedgerBattle(value: unknown): value is WorldLedgerBattle {
  if (!isRecord(value)) return false;
  return (
    typeof value.episodeRequestId === "string" &&
    EPISODE_REQUEST_ID_PATTERN.test(value.episodeRequestId) &&
    typeof value.map === "string" &&
    (value.winnerName === null || typeof value.winnerName === "string") &&
    typeof value.playerCount === "number" &&
    (value.roundNumber === null || typeof value.roundNumber === "number") &&
    typeof value.battleAt === "string" &&
    canonicalInstant(value.battleAt) !== null
  );
}

/**
 * Tolerant parse with the same contract as `parseStandingsHistoryStore`:
 * `"corrupt"` (never a silent reset to empty, never a throw) for anything
 * that isn't a well-formed store, so the writer can leave a possibly
 * recoverable file untouched instead of overwriting real history.
 */
export function parseWorldLedgerStore(
  raw: string,
): WorldLedgerStore | "corrupt" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "corrupt";
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.battles) ||
    !parsed.battles.every(isLedgerBattle)
  ) {
    return "corrupt";
  }
  return {
    schemaVersion: 1,
    battles: [...(parsed.battles as WorldLedgerBattle[])].sort(compareBattles),
  };
}

/** Missing file → empty ledger (cold start); unreadable content → `"corrupt"`. */
export async function readWorldLedgerStore(
  filePath: string,
): Promise<WorldLedgerStore | "corrupt"> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? error.code
        : null;
    if (code === "ENOENT") return EMPTY_WORLD_LEDGER;
    throw error;
  }
  return parseWorldLedgerStore(raw);
}

export function serialiseWorldLedgerStore(store: WorldLedgerStore): string {
  // One battle per line keeps an ever-growing file diffable and cheap to
  // inspect without a JSON viewer.
  const lines = store.battles.map((battle) => `    ${JSON.stringify(battle)}`);
  return `{\n  "schemaVersion": 1,\n  "battles": [\n${lines.join(",\n")}${
    lines.length > 0 ? "\n" : ""
  }  ]\n}\n`;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export type WorldTheatreStatus = "unclaimed" | "held" | "contested";

export interface WorldWindowEntry {
  readonly episodeRequestId: string;
  readonly map: string;
  readonly winnerName: string | null;
  readonly battleAt: string;
}

export interface WorldTally {
  readonly name: string;
  readonly wins: number;
}

export interface WorldReign {
  readonly holder: string;
  readonly from: string;
  /** `null` for the reign still in progress. */
  readonly to: string | null;
  readonly battles: number;
  readonly wins: number;
}

export interface WorldTheatreState {
  readonly id: WorldTheatreId;
  readonly status: WorldTheatreStatus;
  readonly holder: string | null;
  readonly heldSince: string | null;
  readonly holderWins: number;
  /** Strongest non-holder in the current window, or the leader of an unclaimed front. */
  readonly challenger: string | null;
  readonly challengerWins: number;
  readonly battleCount: number;
  readonly lastBattleAt: string | null;
  /** Oldest first, at most `windowSize` long. */
  readonly window: readonly WorldWindowEntry[];
  readonly tallies: readonly WorldTally[];
  /** Battlefields this theatre has been fought on, most used first. */
  readonly maps: readonly { readonly map: string; readonly battles: number }[];
  /** Newest first. */
  readonly reigns: readonly WorldReign[];
}

export type WorldEventKind = "claim" | "conquest" | "siege" | "held";

export interface WorldEvent {
  readonly kind: WorldEventKind;
  readonly theatreId: WorldTheatreId;
  readonly at: string;
  readonly episodeRequestId: string;
  readonly map: string;
  /** Claimer, conqueror, besieger, or the holder who held the line. */
  readonly agent: string;
  /** Previous holder, besieged holder, or the challenger beaten back. */
  readonly rival: string | null;
  readonly agentWins: number;
  readonly rivalWins: number;
}

export interface WorldAgentState {
  readonly name: string;
  readonly theatres: readonly WorldTheatreId[];
  readonly conquests: number;
  readonly battlesWon: number;
}

export interface WorldDaySnapshot {
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly holders: Readonly<Record<WorldTheatreId, string | null>>;
}

export interface WorldState {
  readonly windowSize: number;
  readonly battleCount: number;
  readonly firstBattleAt: string | null;
  readonly lastBattleAt: string | null;
  readonly theatres: readonly WorldTheatreState[];
  /** Newest first. */
  readonly events: readonly WorldEvent[];
  readonly agents: readonly WorldAgentState[];
  /** Oldest first, one entry per UTC day from the first battle to the last. */
  readonly timeline: readonly WorldDaySnapshot[];
}

interface MutableTheatre {
  readonly id: WorldTheatreId;
  status: WorldTheatreStatus;
  holder: string | null;
  heldSince: string | null;
  battleCount: number;
  lastBattleAt: string | null;
  window: WorldWindowEntry[];
  /** Wins per agent inside `window`. */
  tallies: Map<string, number>;
  /** Battles per battlefield, all time. */
  maps: Map<string, number>;
  reigns: WorldReign[];
  reignBattles: number;
  reignWins: number;
}

function emptyHolders(): Record<WorldTheatreId, string | null> {
  const holders = {} as Record<WorldTheatreId, string | null>;
  for (const theatre of WORLD_THEATRES) holders[theatre.id] = null;
  return holders;
}

/**
 * Window winners ranked by most wins, then the holder (a tie keeps the
 * front), then the most recent win (momentum), then name — fully
 * deterministic. The published tallies use this order too, so the named
 * challenger is always the first non-holder listed.
 */
function rankedTallies(theatre: MutableTheatre): WorldTally[] {
  const lastWinIndex = new Map<string, number>();
  theatre.window.forEach((entry, index) => {
    if (entry.winnerName !== null) lastWinIndex.set(entry.winnerName, index);
  });
  const isHolder = (name: string) => (name === theatre.holder ? 1 : 0);
  return [...theatre.tallies.entries()]
    .filter(([, wins]) => wins > 0)
    .map(([name, wins]) => ({ name, wins }))
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        isHolder(b.name) - isHolder(a.name) ||
        (lastWinIndex.get(b.name) ?? -1) - (lastWinIndex.get(a.name) ?? -1) ||
        a.name.localeCompare(b.name),
    );
}

/** Strongest non-holder in the window, by `rankedTallies` order. */
function strongestChallenger(
  theatre: MutableTheatre,
): { name: string; wins: number } | null {
  return (
    rankedTallies(theatre).find((tally) => tally.name !== theatre.holder) ??
    null
  );
}

function closeReign(theatre: MutableTheatre, endedAt: string): void {
  if (theatre.holder === null || theatre.heldSince === null) return;
  theatre.reigns.unshift({
    holder: theatre.holder,
    from: theatre.heldSince,
    to: endedAt,
    battles: theatre.reignBattles,
    wins: theatre.reignWins,
  });
}

/**
 * Replays the ledger from the first battle and returns the world as of the
 * last one. Deterministic: the same ledger always produces the same world,
 * which is what makes the world reconstructible from the ledger alone.
 */
export function reduceWorld(
  ledger: WorldLedgerStore,
  windowSize = WORLD_FRONT_WINDOW,
): WorldState {
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new Error("world window size must be a positive integer");
  }
  const theatres = new Map<WorldTheatreId, MutableTheatre>(
    WORLD_THEATRES.map((definition) => [
      definition.id,
      {
        id: definition.id,
        status: "unclaimed",
        holder: null,
        heldSince: null,
        battleCount: 0,
        lastBattleAt: null,
        window: [],
        tallies: new Map(),
        maps: new Map(),
        reigns: [],
        reignBattles: 0,
        reignWins: 0,
      } satisfies MutableTheatre,
    ]),
  );
  const events: WorldEvent[] = [];
  const conquests = new Map<string, number>();
  const battlesWon = new Map<string, number>();
  const timeline: WorldDaySnapshot[] = [];
  let firstBattleAt: string | null = null;
  let lastBattleAt: string | null = null;
  let battleCount = 0;
  let currentDay: string | null = null;

  const snapshotHolders = (): Record<WorldTheatreId, string | null> => {
    const holders = emptyHolders();
    for (const theatre of theatres.values())
      holders[theatre.id] = theatre.holder;
    return holders;
  };
  const closeDay = (day: string): void => {
    timeline.push({ day, holders: snapshotHolders() });
  };

  for (const battle of ledger.battles) {
    const theatreId = worldTheatreForMap(battle.map);
    if (theatreId === null) continue;
    const theatre = theatres.get(theatreId);
    if (theatre === undefined) continue;
    const day = battle.battleAt.slice(0, 10);
    if (currentDay !== null && day !== currentDay) {
      closeDay(currentDay);
      // Empty days repeat the previous snapshot so the history reads as
      // continuous time rather than a sequence of battle days.
      let gap = nextDay(currentDay);
      while (gap < day) {
        closeDay(gap);
        gap = nextDay(gap);
      }
    }
    currentDay = day;
    battleCount += 1;
    firstBattleAt ??= battle.battleAt;
    lastBattleAt = battle.battleAt;

    theatre.battleCount += 1;
    theatre.lastBattleAt = battle.battleAt;
    theatre.maps.set(battle.map, (theatre.maps.get(battle.map) ?? 0) + 1);
    const entry: WorldWindowEntry = {
      episodeRequestId: battle.episodeRequestId,
      map: battle.map,
      winnerName: battle.winnerName,
      battleAt: battle.battleAt,
    };
    theatre.window.push(entry);
    if (battle.winnerName !== null) {
      theatre.tallies.set(
        battle.winnerName,
        (theatre.tallies.get(battle.winnerName) ?? 0) + 1,
      );
      battlesWon.set(
        battle.winnerName,
        (battlesWon.get(battle.winnerName) ?? 0) + 1,
      );
    }
    while (theatre.window.length > windowSize) {
      const expired = theatre.window.shift();
      if (expired !== undefined && expired.winnerName !== null) {
        const remaining = (theatre.tallies.get(expired.winnerName) ?? 0) - 1;
        if (remaining > 0) theatre.tallies.set(expired.winnerName, remaining);
        else theatre.tallies.delete(expired.winnerName);
      }
    }

    const previousStatus = theatre.status;
    let changedHands = false;
    if (theatre.holder === null) {
      if (battle.winnerName !== null) {
        changedHands = true;
        theatre.holder = battle.winnerName;
        theatre.heldSince = battle.battleAt;
        theatre.reignBattles = 0;
        theatre.reignWins = 0;
        events.push({
          kind: "claim",
          theatreId,
          at: battle.battleAt,
          episodeRequestId: battle.episodeRequestId,
          map: battle.map,
          agent: battle.winnerName,
          rival: null,
          agentWins: theatre.tallies.get(battle.winnerName) ?? 0,
          rivalWins: 0,
        });
      }
    } else {
      const holderWins = theatre.tallies.get(theatre.holder) ?? 0;
      const challenger = strongestChallenger(theatre);
      if (challenger !== null && challenger.wins > holderWins) {
        changedHands = true;
        const previousHolder = theatre.holder;
        closeReign(theatre, battle.battleAt);
        theatre.holder = challenger.name;
        theatre.heldSince = battle.battleAt;
        theatre.reignBattles = 0;
        theatre.reignWins = 0;
        conquests.set(
          challenger.name,
          (conquests.get(challenger.name) ?? 0) + 1,
        );
        events.push({
          kind: "conquest",
          theatreId,
          at: battle.battleAt,
          episodeRequestId: battle.episodeRequestId,
          map: battle.map,
          agent: challenger.name,
          rival: previousHolder,
          agentWins: challenger.wins,
          rivalWins: holderWins,
        });
      }
    }

    if (theatre.holder !== null) {
      theatre.reignBattles += 1;
      if (battle.winnerName === theatre.holder) theatre.reignWins += 1;
      const holderWins = theatre.tallies.get(theatre.holder) ?? 0;
      const challenger = strongestChallenger(theatre);
      // A challenger can never be AHEAD here — that was a conquest above —
      // so the only contested case is a tie: one more win flips the front.
      theatre.status =
        challenger !== null && challenger.wins >= holderWins
          ? "contested"
          : "held";
      if (
        !changedHands &&
        previousStatus === "held" &&
        theatre.status === "contested" &&
        challenger !== null
      ) {
        events.push({
          kind: "siege",
          theatreId,
          at: battle.battleAt,
          episodeRequestId: battle.episodeRequestId,
          map: battle.map,
          agent: challenger.name,
          rival: theatre.holder,
          agentWins: challenger.wins,
          rivalWins: holderWins,
        });
      } else if (
        !changedHands &&
        previousStatus === "contested" &&
        theatre.status === "held" &&
        battle.winnerName === theatre.holder
      ) {
        events.push({
          kind: "held",
          theatreId,
          at: battle.battleAt,
          episodeRequestId: battle.episodeRequestId,
          map: battle.map,
          agent: theatre.holder,
          rival: challenger?.name ?? null,
          agentWins: holderWins,
          rivalWins: challenger?.wins ?? 0,
        });
      }
    }
  }
  if (currentDay !== null) closeDay(currentDay);

  const theatreStates: WorldTheatreState[] = WORLD_THEATRES.map(
    (definition) => {
      const theatre = theatres.get(definition.id) as MutableTheatre;
      const holderWins =
        theatre.holder === null
          ? 0
          : (theatre.tallies.get(theatre.holder) ?? 0);
      const challenger = strongestChallenger(theatre);
      const reigns: WorldReign[] = [];
      if (theatre.holder !== null && theatre.heldSince !== null) {
        reigns.push({
          holder: theatre.holder,
          from: theatre.heldSince,
          to: null,
          battles: theatre.reignBattles,
          wins: theatre.reignWins,
        });
      }
      reigns.push(...theatre.reigns);
      return {
        id: definition.id,
        status: theatre.status,
        holder: theatre.holder,
        heldSince: theatre.heldSince,
        holderWins,
        challenger: challenger?.name ?? null,
        challengerWins: challenger?.wins ?? 0,
        battleCount: theatre.battleCount,
        lastBattleAt: theatre.lastBattleAt,
        window: [...theatre.window],
        tallies: rankedTallies(theatre),
        maps: [...theatre.maps.entries()]
          .map(([map, battles]) => ({ map, battles }))
          .sort((a, b) => b.battles - a.battles || a.map.localeCompare(b.map)),
        reigns: reigns.slice(0, WORLD_REIGN_LIMIT),
      };
    },
  );

  const agentNames = new Set<string>([
    ...battlesWon.keys(),
    ...theatreStates.flatMap((theatre) =>
      theatre.holder === null ? [] : [theatre.holder],
    ),
  ]);
  const agents: WorldAgentState[] = [...agentNames]
    .map((name) => ({
      name,
      theatres: theatreStates
        .filter((theatre) => theatre.holder === name)
        .map((theatre) => theatre.id),
      conquests: conquests.get(name) ?? 0,
      battlesWon: battlesWon.get(name) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.theatres.length - a.theatres.length ||
        b.conquests - a.conquests ||
        b.battlesWon - a.battlesWon ||
        a.name.localeCompare(b.name),
    );

  return {
    windowSize,
    battleCount,
    firstBattleAt,
    lastBattleAt,
    theatres: theatreStates,
    events: events.reverse(),
    agents,
    timeline,
  };
}

function nextDay(day: string): string {
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Public read model (`world.json`)
// ---------------------------------------------------------------------------

export interface PublicWorldAgent {
  /** Raw league player name — the key every other field of this model refers to. */
  readonly name: string;
  readonly label: string;
  /** `/agent/<slug>` exists for this slug; `null` for a past winner the league no longer lists. */
  readonly slug: string | null;
  readonly color: string;
  readonly secondaryColor: string;
  readonly emblemSvg: string | null;
  readonly isHouse: boolean;
  readonly theatres: readonly WorldTheatreId[];
  readonly conquests: number;
  readonly battlesWon: number;
}

export interface PublicWorldBattle {
  readonly episodeRequestId: string;
  readonly map: string;
  readonly winner: string | null;
  readonly at: string;
  readonly href: string;
}

export interface PublicWorldTheatre {
  readonly id: WorldTheatreId;
  /** Normalised league map keys that decide this front (catalog order). */
  readonly battlefields: readonly string[];
  readonly status: WorldTheatreStatus;
  readonly holder: string | null;
  readonly heldSince: string | null;
  readonly holderWins: number;
  readonly challenger: string | null;
  readonly challengerWins: number;
  readonly battleCount: number;
  readonly lastBattleAt: string | null;
  readonly window: readonly PublicWorldBattle[];
  readonly tallies: readonly WorldTally[];
  readonly maps: readonly { readonly map: string; readonly battles: number }[];
  readonly reigns: readonly WorldReign[];
}

export interface PublicWorldEvent extends WorldEvent {
  readonly href: string;
}

export interface PublicWorldModel {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly windowSize: number;
  readonly battleCount: number;
  readonly battlesLast24h: number;
  readonly firstBattleAt: string | null;
  readonly lastBattleAt: string | null;
  readonly feed: {
    readonly stale: boolean;
    readonly lastGoodSyncAt: string;
    readonly currentRoundNumber: number | null;
    readonly roundIntervalMinutes: number | null;
  };
  readonly theatres: readonly PublicWorldTheatre[];
  readonly events: readonly PublicWorldEvent[];
  readonly timeline: readonly WorldDaySnapshot[];
  readonly agents: readonly PublicWorldAgent[];
  /**
   * The read model's entry points, so the front page can link to accounts
   * and the starter without fetching the whole read model.
   */
  readonly links: PublicWorldLinks | null;
}

export interface PublicWorldLinks {
  readonly accountUrl: string;
  readonly enterTheLeagueUrl: string;
}

const FALLBACK_AGENT_COLOR = "#94a3b8";
const FALLBACK_AGENT_SECONDARY = "#1e293b";

function matchHref(episodeRequestId: string): string {
  return `/match/${encodeURIComponent(episodeRequestId)}`;
}

/**
 * Identity for every agent the world mentions, resolved the same way every
 * public page already does: a registered profile's own colours/emblem, a
 * listed-but-unregistered participant's provisional identity, and — for a
 * past winner the league no longer lists at all — a generated provisional
 * identity with no profile link (there is no `/agent/:slug` page for them).
 */
function resolveWorldAgentIdentities(
  names: readonly string[],
  readModelAgents: readonly PublicAgent[],
): Map<
  string,
  Omit<PublicWorldAgent, "theatres" | "conquests" | "battlesWon">
> {
  const byPlayerName = new Map(
    readModelAgents.map((agent) => [agent.playerName, agent]),
  );
  const reservedSlugs = new Set<string>();
  for (const agent of readModelAgents) {
    if (agent.slug !== null) reservedSlugs.add(agent.slug);
    if (agent.provisionalSlug !== null)
      reservedSlugs.add(agent.provisionalSlug);
  }
  const unknownNames = names.filter((name) => !byPlayerName.has(name));
  const provisional = computeProvisionalIdentities(unknownNames, reservedSlugs);
  const result = new Map<
    string,
    Omit<PublicWorldAgent, "theatres" | "conquests" | "battlesWon">
  >();
  for (const name of names) {
    const agent = byPlayerName.get(name);
    if (agent !== undefined) {
      result.set(name, {
        name,
        label: agent.registered ? agent.displayName : agent.playerName,
        slug: agent.registered ? agent.slug : agent.provisionalSlug,
        color:
          (agent.registered
            ? agent.primaryColor
            : agent.provisionalPrimaryColor) ??
          agent.provisionalPrimaryColor ??
          FALLBACK_AGENT_COLOR,
        secondaryColor:
          (agent.registered
            ? agent.secondaryColor
            : agent.provisionalSecondaryColor) ??
          agent.provisionalSecondaryColor ??
          FALLBACK_AGENT_SECONDARY,
        emblemSvg:
          (agent.registered ? agent.emblemSvg : agent.provisionalEmblemSvg) ??
          agent.provisionalEmblemSvg,
        isHouse: agent.status === "house",
      });
      continue;
    }
    const generated = provisional.get(name);
    result.set(name, {
      name,
      label: name,
      slug: null,
      color: generated?.primaryColor ?? FALLBACK_AGENT_COLOR,
      secondaryColor: generated?.secondaryColor ?? FALLBACK_AGENT_SECONDARY,
      emblemSvg: generated?.emblemSvg ?? null,
      isHouse: false,
    });
  }
  return result;
}

function publicBattle(entry: WorldWindowEntry): PublicWorldBattle {
  return {
    episodeRequestId: entry.episodeRequestId,
    map: entry.map,
    winner: entry.winnerName,
    at: entry.battleAt,
    href: matchHref(entry.episodeRequestId),
  };
}

export function buildPublicWorldModel(args: {
  readonly state: WorldState;
  readonly ledger: WorldLedgerStore;
  readonly data: CoworldLeagueMirrorData;
  readonly readModelAgents: readonly PublicAgent[];
  readonly links?: PublicWorldLinks | null;
  readonly generatedAt?: string;
}): PublicWorldModel {
  const { state, ledger, data } = args;
  const generatedAt = args.generatedAt ?? data.generatedAt;
  const events = state.events
    .slice(0, WORLD_PUBLIC_EVENT_LIMIT)
    .map((event) => ({ ...event, href: matchHref(event.episodeRequestId) }));
  const battlefieldsById = new Map(
    WORLD_THEATRES.map((definition) => [definition.id, definition.mapKeys]),
  );
  const theatres: PublicWorldTheatre[] = state.theatres.map((theatre) => ({
    id: theatre.id,
    battlefields: battlefieldsById.get(theatre.id) ?? [],
    status: theatre.status,
    holder: theatre.holder,
    heldSince: theatre.heldSince,
    holderWins: theatre.holderWins,
    challenger: theatre.challenger,
    challengerWins: theatre.challengerWins,
    battleCount: theatre.battleCount,
    lastBattleAt: theatre.lastBattleAt,
    window: theatre.window.map(publicBattle),
    tallies: theatre.tallies.slice(0, WORLD_TALLY_LIMIT),
    maps: theatre.maps,
    reigns: theatre.reigns,
  }));
  const timeline = state.timeline.slice(-WORLD_PUBLIC_TIMELINE_DAYS);

  // Every name the published model can mention needs an identity.
  const mentioned = new Set<string>();
  for (const theatre of theatres) {
    if (theatre.holder !== null) mentioned.add(theatre.holder);
    if (theatre.challenger !== null) mentioned.add(theatre.challenger);
    for (const battle of theatre.window) {
      if (battle.winner !== null) mentioned.add(battle.winner);
    }
    for (const tally of theatre.tallies) mentioned.add(tally.name);
    for (const reign of theatre.reigns) mentioned.add(reign.holder);
  }
  for (const event of events) {
    mentioned.add(event.agent);
    if (event.rival !== null) mentioned.add(event.rival);
  }
  for (const snapshot of timeline) {
    for (const holder of Object.values(snapshot.holders)) {
      if (holder !== null) mentioned.add(holder);
    }
  }
  const byName = new Map(state.agents.map((agent) => [agent.name, agent]));
  const names = [...mentioned].sort((a, b) => a.localeCompare(b));
  const identities = resolveWorldAgentIdentities(names, args.readModelAgents);
  const agents: PublicWorldAgent[] = names
    .map((name) => {
      const identity = identities.get(name);
      const agentState = byName.get(name);
      return {
        name,
        label: identity?.label ?? name,
        slug: identity?.slug ?? null,
        color: identity?.color ?? FALLBACK_AGENT_COLOR,
        secondaryColor: identity?.secondaryColor ?? FALLBACK_AGENT_SECONDARY,
        emblemSvg: identity?.emblemSvg ?? null,
        isHouse: identity?.isHouse ?? false,
        theatres: agentState?.theatres ?? [],
        conquests: agentState?.conquests ?? 0,
        battlesWon: agentState?.battlesWon ?? 0,
      };
    })
    .sort(
      (a, b) =>
        b.theatres.length - a.theatres.length ||
        b.conquests - a.conquests ||
        b.battlesWon - a.battlesWon ||
        a.name.localeCompare(b.name),
    );

  const generatedTime = Date.parse(generatedAt);
  const dayAgo = Number.isFinite(generatedTime)
    ? new Date(generatedTime - 24 * 60 * 60 * 1000).toISOString()
    : null;
  const battlesLast24h =
    dayAgo === null
      ? 0
      : ledger.battles.filter(
          (battle) =>
            battle.battleAt > dayAgo && worldTheatreForMap(battle.map) !== null,
        ).length;

  return {
    schemaVersion: 1,
    generatedAt,
    windowSize: state.windowSize,
    battleCount: state.battleCount,
    battlesLast24h,
    firstBattleAt: state.firstBattleAt,
    lastBattleAt: state.lastBattleAt,
    feed: {
      stale: data.stale,
      lastGoodSyncAt: data.lastGoodSyncAt,
      currentRoundNumber: data.league.currentRoundNumber,
      roundIntervalMinutes: data.league.roundIntervalMinutes,
    },
    theatres,
    events,
    timeline,
    agents,
    links:
      args.links === undefined || args.links === null
        ? null
        : {
            accountUrl: args.links.accountUrl,
            enterTheLeagueUrl: args.links.enterTheLeagueUrl,
          },
  };
}
