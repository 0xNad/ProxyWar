import type {
  AgentSpectatorPlayerState,
  AgentSpectatorReplay,
  AgentSpectatorSnapshot,
} from "./AgentSpectatorReplay";
import type {
  SpectatorEvent,
  SpectatorTelemetry,
} from "./AgentSpectatorTelemetry";

/**
 * Season Zero Phase 2 gap closure: the sampled match-state series the
 * recap/cut/broadcast systems have been documenting as infeasible
 * ("no territory series" — see `AgentMatchRecap.ts`'s own module doc).
 *
 * SOURCE DECISION (investigated before writing a single line here): a full
 * headless re-simulation of `game-record.json` was NOT needed.
 * `spectator-replay.json` (`AgentSpectatorReplay.ts`) already carries, for
 * up to 80 sampled turns per match (`maxReplaySnapshotsForArtifact`), a
 * `players[]` array per snapshot with `tilesOwned`/`troops`/`isAlive` —
 * exactly the per-agent territory/troop/alive state this artifact needs,
 * captured directly off the live `Game` object at build time
 * (`buildAgentSpectatorSnapshot`), zero simulation involved. This module is
 * therefore a PURE re-projection of two already-written, already-public
 * artifacts (`spectator-replay.json` + `spectator-telemetry.json`) — never
 * a new simulation, never a new expensive computation, safely runnable at
 * mirror-sync cadence exactly like every other backfill in this file family.
 *
 * `activeAlliancePairs` per sample is reconstructed from
 * `spectator-telemetry.json`'s real `alliance_formed`/`alliance_break`
 * events (`computeAllianceIntervals`), replayed in chronological order up
 * to each sample's turn — a genuine derivation from recorded events, never
 * an invented state. "Wars" (a formal war/peace flag) is deliberately NOT
 * included: neither `AgentSpectatorSnapshot` nor `SpectatorTelemetry` ever
 * captures the core `Game` engine's actual war/peace relation (only
 * alliance formation/break and individual attack events survive into the
 * spectator artifacts), so a per-sample "at war" boolean would have to be
 * inferred from attack recency — not a real recorded state, and this
 * module refuses to fabricate one. Attack-derived conflict
 * signal is available to derivations that want it (`AgentMatchStateDerivations.ts`)
 * straight off `SpectatorTelemetry.events`, honestly labeled as "attack
 * events", never relabeled "war".
 */

export const MATCH_STATE_SERIES_SCHEMA_VERSION = 1;

/** Bound inherited directly from `spectator-replay.json`'s own cap (`maxReplaySnapshotsForArtifact` in `AgentSpectatorReplay.ts`) — this module never samples further, it re-projects whatever that artifact already retained. */
export const MATCH_STATE_SERIES_MAX_SAMPLES = 80;

export interface MatchStateSeriesAgentSample {
  agentID: string | null;
  playerID: string;
  username: string;
  alive: boolean;
  tilesOwned: number;
  troops: number;
  /** `tilesOwned / (sum of every player's tilesOwned in this sample)`, 0..1. `0` when nobody has claimed any territory yet (pre-spawn), never `NaN`. */
  territoryShare: number;
  /** 1-based rank by `tilesOwned` desc among every player in this sample (alive or dead); ties broken by `troops` desc, then `playerID` asc for a fully deterministic order. */
  rank: number;
}

export interface MatchStateSeriesSample {
  turn: number;
  tick: number;
  phase: AgentSpectatorSnapshot["phase"];
  agents: MatchStateSeriesAgentSample[];
  /** Unordered `[agentID, agentID]` pairs (lexicographically sorted within the pair) with an alliance formed and not yet broken as of this sample's turn. Empty is a real "no active alliances right now" fact, not "unknown" — see the module doc. */
  activeAlliancePairs: ReadonlyArray<readonly [string, string]>;
}

export interface MatchStateSeries {
  schemaVersion: typeof MATCH_STATE_SERIES_SCHEMA_VERSION;
  runID: string;
  matchID: string;
  generatedAt: string;
  /** The only source this module currently implements — see the module doc's "source decision". */
  source: "spectator-replay-snapshots";
  totalTurns: number;
  samples: MatchStateSeriesSample[];
  notes: readonly string[];
}

/** One alliance's real lifespan, derived purely from telemetry events — never inferred beyond what `alliance_formed`/`alliance_break` actually recorded. Exported so `AgentMatchStateDerivations.ts` reuses this SAME derivation for alliance-duration reporting rather than re-scanning events a second time with a subtly different rule. */
export interface AllianceInterval {
  /** Lexicographically sorted so the same pair always produces the same key regardless of who proposed. */
  agentIDs: readonly [string, string];
  formedTurn: number;
  /** `null` when telemetry never recorded a break for this formation — either it held until match end, or the match ended before it could break. `ongoing` disambiguates the two only insofar as `AgentMatchStateDerivations.ts`'s duration math treats "no break" as "held to `totalTurns`", the honest reading of the same telemetry every other consumer of `alliance_formed`/`alliance_break` already uses. */
  brokenTurn: number | null;
  /** `true` only when the break event's `tone === "betrayal"` (an active alliance broken, not a mutual/`target_call` lapse) — mirrors `AgentMatchRecap.ts`'s own betrayal criterion. `null` when `brokenTurn` is `null` (never broken, so betrayal is moot). */
  brokenByBetrayal: boolean | null;
}

function sortedPairKey(a: string, b: string): readonly [string, string] {
  return a <= b ? [a, b] : [b, a];
}

function pairKeyString(pair: readonly [string, string]): string {
  return `${pair[0]}|${pair[1]}`;
}

/**
 * Replays every `alliance_formed`/`alliance_break` event in chronological
 * (`turnNumber`, then `sequence`) order and returns one interval per
 * formation — including every re-formation of the same pair as its own
 * separate interval (an alliance that formed, broke, and re-formed is two
 * real intervals, never merged into one that would misstate its true
 * duration). A `alliance_break` with no currently-open interval for that
 * pair is ignored (defensive — telemetry should never emit one, but this
 * derivation never throws on a malformed/partial event stream).
 */
export function computeAllianceIntervals(
  events: readonly SpectatorEvent[],
): AllianceInterval[] {
  const ordered = [...events]
    .filter(
      (event) =>
        (event.kind === "alliance_formed" || event.kind === "alliance_break") &&
        event.targetAgentID !== null,
    )
    .sort((a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence);

  const open = new Map<string, AllianceInterval>();
  const closed: AllianceInterval[] = [];
  for (const event of ordered) {
    const targetAgentID = event.targetAgentID;
    if (targetAgentID === null) continue;
    const pair = sortedPairKey(event.actorAgentID, targetAgentID);
    const key = pairKeyString(pair);
    if (event.kind === "alliance_formed") {
      // A formation while one is already open for this pair (a duplicate
      // request event, not a real second alliance) never opens a second
      // interval — real re-formation always follows a real break first.
      if (open.has(key)) continue;
      open.set(key, {
        agentIDs: pair,
        formedTurn: event.turnNumber,
        brokenTurn: null,
        brokenByBetrayal: null,
      });
      continue;
    }
    // alliance_break
    const interval = open.get(key);
    if (interval === undefined) continue;
    interval.brokenTurn = event.turnNumber;
    interval.brokenByBetrayal = event.tone === "betrayal";
    closed.push(interval);
    open.delete(key);
  }
  return [...closed, ...open.values()].sort(
    (a, b) =>
      a.formedTurn - b.formedTurn ||
      pairKeyString(a.agentIDs).localeCompare(pairKeyString(b.agentIDs)),
  );
}

function activeAlliancePairsAtTurn(
  intervals: readonly AllianceInterval[],
  turn: number,
): ReadonlyArray<readonly [string, string]> {
  return intervals
    .filter(
      (interval) =>
        interval.formedTurn <= turn &&
        (interval.brokenTurn === null || interval.brokenTurn > turn),
    )
    .map((interval) => interval.agentIDs);
}

function rankedAgents(
  players: readonly AgentSpectatorPlayerState[],
): MatchStateSeriesAgentSample[] {
  const totalTiles = players.reduce(
    (sum, player) => sum + player.tilesOwned,
    0,
  );
  const ordered = [...players].sort(
    (a, b) =>
      b.tilesOwned - a.tilesOwned ||
      b.troops - a.troops ||
      a.playerID.localeCompare(b.playerID),
  );
  const rankByPlayerID = new Map<string, number>();
  ordered.forEach((player, index) =>
    rankByPlayerID.set(player.playerID, index + 1),
  );
  return players.map((player) => ({
    agentID: player.agentID,
    playerID: player.playerID,
    username: player.username,
    alive: player.isAlive,
    tilesOwned: player.tilesOwned,
    troops: player.troops,
    territoryShare: totalTiles > 0 ? player.tilesOwned / totalTiles : 0,
    rank: rankByPlayerID.get(player.playerID) ?? players.length,
  }));
}

export interface BuildAgentMatchStateSeriesInput {
  runID: string;
  matchID: string;
  /** The already-written (and already 80-snapshot-capped) `spectator-replay.json` payload — this module never re-samples further. */
  replay: Pick<AgentSpectatorReplay, "snapshots">;
  /** `null` degrades `activeAlliancePairs` to always-empty with an explanatory note — never a silent/ambiguous empty result mistaken for "no alliances formed". */
  telemetry: SpectatorTelemetry | null;
}

/**
 * `null` only when the source replay has zero snapshots — a genuinely
 * unusable input (no rendered spectator replay at all), never a fabricated
 * empty series. Every other shape of thin input (e.g. one snapshot, no
 * telemetry) still produces a real, honestly-labeled series.
 */
export function buildAgentMatchStateSeries(
  input: BuildAgentMatchStateSeriesInput,
): MatchStateSeries | null {
  if (input.replay.snapshots.length === 0) {
    return null;
  }
  const notes: string[] = [];
  const intervals =
    input.telemetry === null
      ? []
      : computeAllianceIntervals(input.telemetry.events);
  if (input.telemetry === null) {
    notes.push(
      "spectator-telemetry.json was unavailable when this series was generated: every sample's activeAlliancePairs is reported empty as a placeholder, not a verified 'no alliances formed' fact.",
    );
  }

  const samples: MatchStateSeriesSample[] = [...input.replay.snapshots]
    .sort((a, b) => a.turnNumber - b.turnNumber)
    .map((snapshot) => ({
      turn: snapshot.turnNumber,
      tick: snapshot.tick,
      phase: snapshot.phase,
      agents: rankedAgents(snapshot.players),
      activeAlliancePairs: activeAlliancePairsAtTurn(
        intervals,
        snapshot.turnNumber,
      ),
    }));

  const totalTurns = samples.reduce(
    (max, sample) => Math.max(max, sample.turn),
    0,
  );

  return {
    schemaVersion: MATCH_STATE_SERIES_SCHEMA_VERSION,
    runID: input.runID,
    matchID: input.matchID,
    generatedAt: new Date().toISOString(),
    source: "spectator-replay-snapshots",
    totalTurns,
    samples,
    notes,
  };
}
