import {
  computeAllianceIntervals,
  type AllianceInterval,
  type MatchStateSeries,
  type MatchStateSeriesAgentSample,
  type MatchStateSeriesSample,
} from "./AgentMatchStateSeries";
import type { SpectatorEvent } from "./AgentSpectatorTelemetry";

/**
 * Everything the sampled match-state series (`AgentMatchStateSeries.ts`)
 * unlocks, per the Season Zero Phase 2 spec's "Sampled match-state series"
 * section: lead changes, major reversals, elimination timing, alliance
 * durations, and decisive territorial swings. Every threshold below is a
 * documented, exported constant — never a bare magic number — so a future
 * tune has a reasoned starting point.
 *
 * All functions here are pure and operate only on a `MatchStateSeries`
 * (plus, for alliance durations, the same telemetry events the series
 * itself derived `activeAlliancePairs` from) — no IO, no simulation.
 */

/** `1st`/`2nd`/`3rd`/`4th`... — shared by `AgentMatchRecap.ts` and `AgentDecisiveMoments.ts` so a reversal/decisive-moment headline never disagrees on how a rank is spoken. */
export function ordinalLabel(rank: number): string {
  const remainder10 = rank % 10;
  const remainder100 = rank % 100;
  if (remainder10 === 1 && remainder100 !== 11) return `${rank}st`;
  if (remainder10 === 2 && remainder100 !== 12) return `${rank}nd`;
  if (remainder10 === 3 && remainder100 !== 13) return `${rank}rd`;
  return `${rank}th`;
}

/** Fraction/cap defining the "final stretch" window a `final_confrontation` beat looks for a genuine attack/nuke event within — shared by `AgentMatchRecap.ts` and `AgentDecisiveMoments.ts` so both agree on one tuned definition of "the final stretch of the match", never two that could silently drift apart. */
export const FINAL_CONFLICT_TURN_FRACTION = 0.05;
export const FINAL_CONFLICT_TURN_CAP = 400;

// ---------------------------------------------------------------------------
// Lead changes
// ---------------------------------------------------------------------------

export interface LeadChange {
  turn: number;
  fromAgentID: string | null;
  fromPlayerID: string;
  fromUsername: string;
  fromShare: number;
  toAgentID: string | null;
  toPlayerID: string;
  toUsername: string;
  toShare: number;
  /** `toShare` minus the outgoing leader's share AT THE TRANSITION TURN — always `>= LEAD_CHANGE_MARGIN`. */
  marginShare: number;
}

/** New leader must hold at least this much MORE total-map territory share than the outgoing leader for the swap to count as a genuine overtake rather than noise between two agents with near-equal territory. 0.03 = 3 percentage points of the whole map. */
export const LEAD_CHANGE_MARGIN_SHARE = 0.03;

export const LEAD_CHANGE_METHODOLOGY = `A lead change is recorded when the territory-share leader among alive agents switches to a different agent by at least ${Math.round(LEAD_CHANGE_MARGIN_SHARE * 100)} percentage points of total map territory, AND the new leader is still leading at the NEXT sampled point (filters a single-sample flicker between two near-equal territories from being reported as a real change of lead). Samples before anyone has claimed territory (pre-spawn) are excluded from leader tracking.`;

function leaderOf(sample: MatchStateSeriesSample): MatchStateSeriesAgentSample {
  const alive = sample.agents.filter((agent) => agent.alive);
  const pool = alive.length > 0 ? alive : sample.agents;
  return [...pool].sort(
    (a, b) =>
      b.territoryShare - a.territoryShare ||
      b.troops - a.troops ||
      a.playerID.localeCompare(b.playerID),
  )[0];
}

export function computeLeadChanges(series: MatchStateSeries): LeadChange[] {
  const samples = series.samples.filter((sample) =>
    sample.agents.some((agent) => agent.tilesOwned > 0),
  );
  if (samples.length === 0) {
    return [];
  }

  const changes: LeadChange[] = [];
  let confirmedLeader = leaderOf(samples[0]);
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index];
    const candidate = leaderOf(sample);
    if (candidate.playerID === confirmedLeader.playerID) {
      continue;
    }
    const confirmedShareNow =
      sample.agents.find((agent) => agent.playerID === confirmedLeader.playerID)
        ?.territoryShare ?? 0;
    const marginShare = candidate.territoryShare - confirmedShareNow;
    if (marginShare < LEAD_CHANGE_MARGIN_SHARE) {
      continue;
    }
    const nextSample = samples[index + 1];
    if (
      nextSample !== undefined &&
      leaderOf(nextSample).playerID !== candidate.playerID
    ) {
      // Single-sample flicker — the "lead" reverted at the very next point.
      continue;
    }
    changes.push({
      turn: sample.turn,
      fromAgentID: confirmedLeader.agentID,
      fromPlayerID: confirmedLeader.playerID,
      fromUsername: confirmedLeader.username,
      fromShare: confirmedShareNow,
      toAgentID: candidate.agentID,
      toPlayerID: candidate.playerID,
      toUsername: candidate.username,
      toShare: candidate.territoryShare,
      marginShare,
    });
    confirmedLeader = candidate;
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Major reversals (rank swings)
// ---------------------------------------------------------------------------

export interface MajorReversal {
  agentID: string | null;
  playerID: string;
  username: string;
  fromTurn: number;
  toTurn: number;
  fromRank: number;
  toRank: number;
  /** `fromRank - toRank`: positive = climbed toward first place, negative = collapsed toward last. `abs(placesChanged) >= REVERSAL_MIN_PLACES`. */
  placesChanged: number;
}

/** Minimum rank swing, in places, to count as a "major" reversal rather than ordinary jockeying. */
export const REVERSAL_MIN_PLACES = 3;
/** Maximum number of SAMPLED points a qualifying swing may span — bounds "major reversal" to a rapid rise/collapse, not a slow multi-hour drift that happens to cross the place threshold eventually. */
export const REVERSAL_MAX_SAMPLE_GAP = 4;

export const REVERSAL_METHODOLOGY = `A major reversal is recorded for an agent whose rank (by tilesOwned among every agent, ties broken by troops then playerID) changes by at least ${REVERSAL_MIN_PLACES} places within ${REVERSAL_MAX_SAMPLE_GAP} or fewer sampled points — a rapid rise or collapse, not a slow drift. Per agent, the detector scans left to right and reports the single largest qualifying swing starting at each unclaimed sample, then skips ahead past it, so overlapping windows never produce duplicate reversals for the same climb or collapse.`;

export function computeMajorReversals(
  series: MatchStateSeries,
): MajorReversal[] {
  const samples = series.samples;
  if (samples.length < 2) {
    return [];
  }
  const playerIDs = [
    ...new Set(samples[0].agents.map((agent) => agent.playerID)),
  ];
  const results: MajorReversal[] = [];

  for (const playerID of playerIDs) {
    let index = 0;
    while (index < samples.length - 1) {
      const rankAtIndex = samples[index].agents.find(
        (agent) => agent.playerID === playerID,
      )?.rank;
      if (rankAtIndex === undefined) {
        index += 1;
        continue;
      }
      let bestEndIndex = -1;
      let bestDelta = 0;
      const lastCandidateIndex = Math.min(
        index + REVERSAL_MAX_SAMPLE_GAP,
        samples.length - 1,
      );
      for (
        let endIndex = index + 1;
        endIndex <= lastCandidateIndex;
        endIndex += 1
      ) {
        const rankAtEnd = samples[endIndex].agents.find(
          (agent) => agent.playerID === playerID,
        )?.rank;
        if (rankAtEnd === undefined) continue;
        const delta = rankAtIndex - rankAtEnd;
        if (Math.abs(delta) > Math.abs(bestDelta)) {
          bestDelta = delta;
          bestEndIndex = endIndex;
        }
      }
      if (bestEndIndex === -1 || Math.abs(bestDelta) < REVERSAL_MIN_PLACES) {
        index += 1;
        continue;
      }
      const startAgent = samples[index].agents.find(
        (agent) => agent.playerID === playerID,
      )!;
      const endAgent = samples[bestEndIndex].agents.find(
        (agent) => agent.playerID === playerID,
      )!;
      results.push({
        agentID: startAgent.agentID,
        playerID,
        username: startAgent.username,
        fromTurn: samples[index].turn,
        toTurn: samples[bestEndIndex].turn,
        fromRank: rankAtIndex,
        toRank: endAgent.rank,
        placesChanged: bestDelta,
      });
      index = bestEndIndex;
    }
  }

  return results.sort(
    (a, b) =>
      Math.abs(b.placesChanged) - Math.abs(a.placesChanged) ||
      a.fromTurn - b.fromTurn,
  );
}

// ---------------------------------------------------------------------------
// Elimination timing
// ---------------------------------------------------------------------------

export interface EliminationTiming {
  agentID: string | null;
  playerID: string;
  username: string;
  /** Last sample where this agent was still observed alive, or `null` when the agent was already dead in the FIRST sample (eliminated before the earliest sampled point — no lower bound available). */
  lastAliveTurn: number | null;
  /** First sample where this agent is observed dead. The true elimination turn is somewhere in `(lastAliveTurn, firstDeadTurn]` — the tightest bound the sampled series can support (samples are capped, see `AgentMatchStateSeries.ts`), never claimed as exact. */
  firstDeadTurn: number;
}

/**
 * Series-only derivation, deliberately NOT cross-referenced against
 * `SpectatorEvent` kind `"elimination"`: that telemetry event is stamped at
 * the MATCH'S FINAL turn for every eliminated agent (see
 * `AgentSpectatorTelemetry.ts`'s `addEliminationEvents` — `turnNumber:
 * lastTurn` unconditionally), not the agent's actual elimination turn, so it
 * carries zero real timing signal despite superficially having a
 * `turnNumber` field. The alive-flag transition in the sampled series is the
 * only genuinely turn-accurate signal this pipeline has for "when".
 */
export function computeEliminationTimings(
  series: MatchStateSeries,
): EliminationTiming[] {
  const samples = series.samples;
  if (samples.length === 0) {
    return [];
  }
  const playerIDs = [
    ...new Set(samples[0].agents.map((agent) => agent.playerID)),
  ];
  const results: EliminationTiming[] = [];
  for (const playerID of playerIDs) {
    let lastAliveTurn: number | null = null;
    let firstDeadTurn: number | null = null;
    let lastAgentSnapshot: MatchStateSeriesAgentSample | null = null;
    for (const sample of samples) {
      const agent = sample.agents.find((entry) => entry.playerID === playerID);
      if (agent === undefined) continue;
      lastAgentSnapshot = agent;
      if (agent.alive) {
        lastAliveTurn = sample.turn;
      } else if (firstDeadTurn === null) {
        firstDeadTurn = sample.turn;
      }
    }
    if (firstDeadTurn === null || lastAgentSnapshot === null) {
      continue;
    }
    results.push({
      agentID: lastAgentSnapshot.agentID,
      playerID,
      username: lastAgentSnapshot.username,
      lastAliveTurn,
      firstDeadTurn,
    });
  }
  return results.sort((a, b) => a.firstDeadTurn - b.firstDeadTurn);
}

// ---------------------------------------------------------------------------
// Alliance durations
// ---------------------------------------------------------------------------

export interface AllianceDuration extends AllianceInterval {
  agentAUsername: string;
  agentBUsername: string;
  durationTurns: number;
  /** `true` when telemetry never recorded a break — the alliance held all the way to `totalTurns` (or the match ended before it could break). */
  ongoing: boolean;
}

function usernameForAgentID(series: MatchStateSeries, agentID: string): string {
  for (const sample of series.samples) {
    const match = sample.agents.find((agent) => agent.agentID === agentID);
    if (match !== undefined) return match.username;
  }
  return agentID;
}

/**
 * Reuses `computeAllianceIntervals` from `AgentMatchStateSeries.ts` (the
 * SAME derivation the series' own `activeAlliancePairs` field is built
 * from) rather than re-deriving alliance lifespans a second way — one
 * definition of "how long did this alliance last", not two that could
 * silently disagree.
 */
export function computeAllianceDurations(
  series: MatchStateSeries,
  telemetryEvents: readonly SpectatorEvent[],
): AllianceDuration[] {
  const intervals = computeAllianceIntervals(telemetryEvents);
  return intervals
    .map((interval) => ({
      ...interval,
      agentAUsername: usernameForAgentID(series, interval.agentIDs[0]),
      agentBUsername: usernameForAgentID(series, interval.agentIDs[1]),
      durationTurns:
        (interval.brokenTurn ?? series.totalTurns) - interval.formedTurn,
      ongoing: interval.brokenTurn === null,
    }))
    .sort(
      (a, b) =>
        b.durationTurns - a.durationTurns || a.formedTurn - b.formedTurn,
    );
}

// ---------------------------------------------------------------------------
// Decisive territorial swings
// ---------------------------------------------------------------------------

export interface TerritorialSwing {
  agentID: string | null;
  playerID: string;
  username: string;
  fromTurn: number;
  toTurn: number;
  fromShare: number;
  toShare: number;
  /** `toShare - fromShare`, signed: positive = sudden expansion, negative = sudden collapse. `abs(deltaShare) >= TERRITORIAL_SWING_MIN_DELTA_SHARE`. */
  deltaShare: number;
}

/** Minimum territory-share change between two CONSECUTIVE sampled points, for one agent, to count as a "decisive" swing (a conquest wave or a collapse) rather than gradual attrition. 0.10 = 10 percentage points of the whole map moving in one sampled interval. */
export const TERRITORIAL_SWING_MIN_DELTA_SHARE = 0.1;

export const TERRITORIAL_SWING_METHODOLOGY = `A decisive territorial swing is recorded when one agent's territory share changes by at least ${Math.round(TERRITORIAL_SWING_MIN_DELTA_SHARE * 100)} percentage points of total map territory between two CONSECUTIVE sampled points — a sudden conquest wave or collapse, never gradual attrition spread across many samples.`;

export function computeTerritorialSwings(
  series: MatchStateSeries,
): TerritorialSwing[] {
  const swings: TerritorialSwing[] = [];
  for (let index = 1; index < series.samples.length; index += 1) {
    const previous = series.samples[index - 1];
    const current = series.samples[index];
    for (const agent of current.agents) {
      const previousAgent = previous.agents.find(
        (entry) => entry.playerID === agent.playerID,
      );
      if (previousAgent === undefined) continue;
      const deltaShare = agent.territoryShare - previousAgent.territoryShare;
      if (Math.abs(deltaShare) < TERRITORIAL_SWING_MIN_DELTA_SHARE) continue;
      swings.push({
        agentID: agent.agentID,
        playerID: agent.playerID,
        username: agent.username,
        fromTurn: previous.turn,
        toTurn: current.turn,
        fromShare: previousAgent.territoryShare,
        toShare: agent.territoryShare,
        deltaShare,
      });
    }
  }
  return swings.sort(
    (a, b) =>
      Math.abs(b.deltaShare) - Math.abs(a.deltaShare) ||
      a.fromTurn - b.fromTurn,
  );
}
