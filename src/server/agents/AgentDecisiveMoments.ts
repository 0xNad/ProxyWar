import {
  FINAL_CONFLICT_TURN_CAP,
  FINAL_CONFLICT_TURN_FRACTION,
} from "./DirectorCutPlan";
import {
  computeAllianceDurations,
  computeEliminationTimings,
  computeLeadChanges,
  computeMajorReversals,
  computeTerritorialSwings,
  ordinalLabel,
} from "./AgentMatchStateDerivations";
import type { MatchStateSeries, MatchStateSeriesSample } from "./AgentMatchStateSeries";
import type { AgentSpectatorSnapshot } from "./AgentSpectatorReplay";
import type { SpectatorEvent } from "./AgentSpectatorTelemetry";

/**
 * Season Zero Phase 2 "Decisive moments": exactly 3-5 per match where
 * supported (spec ~941-953), each with turn/time, event type, a concise
 * factual headline, involved agents, before/after state, a jump-to-replay
 * turn, and — where genuinely available — the agent's OWN stated reason,
 * clearly labeled as stated (not verified reasoning).
 *
 * Candidates are drawn from every derivation `AgentMatchStateDerivations.ts`
 * makes available (lead changes, major reversals, elimination timing,
 * betrayed alliance durations, decisive territorial swings) plus one
 * telemetry-only addition (`final_confrontation`, mirroring
 * `AgentMatchRecap.ts`'s own beat of the same name and the SAME endgame
 * window `DirectorCutPlan.ts`'s `final_conflict` segment uses — imported,
 * never duplicated). Every headline is either a `SpectatorEvent.message`
 * the telemetry builder already vetted, or a small factual template built
 * only from real usernames/shares/ranks/turns — never an inferred or
 * embellished claim, matching `AgentMatchRecap.ts`'s own convention.
 *
 * Ranked by a shared `importance` score, deduplicated by turn PROXIMITY
 * (two candidates anchored within the same small window collapse to the
 * single higher-importance one — the same real swing should not produce
 * two near-identical "moments"), then truncated to `MAX_DECISIVE_MOMENTS`.
 * `buildAgentDecisiveMoments` returns `null` when fewer than
 * `MIN_DECISIVE_MOMENTS` genuine candidates survive — a quiet or
 * series-less match legitimately has none, never padded with a manufactured
 * "moment" (same "never a fabricated placeholder" rule `AgentMatchRecap.ts`
 * already follows).
 */

export const DECISIVE_MOMENTS_SCHEMA_VERSION = 1;
/** Spec-mandated bounds — "exactly three to five... where supported". Fewer than the floor and the whole artifact is omitted (see the module doc); more than the ceiling and only the most important survive. */
export const MIN_DECISIVE_MOMENTS = 3;
export const MAX_DECISIVE_MOMENTS = 5;

export type DecisiveMomentType =
  | "lead_change"
  | "reversal"
  | "elimination"
  | "alliance_betrayal"
  | "territorial_swing"
  | "final_confrontation";

export interface DecisiveMomentAgentState {
  username: string;
  tilesOwned: number;
  troops: number;
  territoryShare: number;
  rank: number;
  alive: boolean;
}

export interface DecisiveMomentState {
  turn: number;
  agents: readonly DecisiveMomentAgentState[];
}

export interface DecisiveMoment {
  turn: number;
  type: DecisiveMomentType;
  headline: string;
  involvedAgents: readonly string[];
  /** `null` only when no series sample exists before this moment's turn (e.g. the moment lands at or before the series' very first sample). */
  beforeState: DecisiveMomentState | null;
  /** `null` only when no series sample exists at or after this moment's turn (should not happen in practice — the moment's own turn is always drawn from real data at or before `totalTurns`). */
  afterState: DecisiveMomentState | null;
  jumpToReplayTurn: number;
  /**
   * The involved agent's own stated reason for a nearby decision, sourced
   * from `spectator-replay.json`'s per-snapshot decision log
   * (`AgentSpectatorSnapshot.decisions[].reason`/`.intentSummary`) —
   * genuinely the agent's stated rationale, not a verified account of why
   * the outcome occurred. `null` when no decision by an involved agent
   * falls within the lookup window (the per-snapshot decision log is
   * sparse — only the turns a snapshot happened to be taken at carry any
   * decisions at all).
   */
  statedReason: string | null;
}

export interface AgentDecisiveMomentsArtifact {
  schemaVersion: typeof DECISIVE_MOMENTS_SCHEMA_VERSION;
  runID: string;
  generatedAt: string;
  moments: readonly DecisiveMoment[];
}

export interface AgentDecisiveMomentsInput {
  runID: string;
  series: MatchStateSeries;
  telemetryEvents: readonly SpectatorEvent[];
  /** Authoritative turn count when known, else the series' own `totalTurns` (see `AgentMatchStateSeries.ts`). */
  totalTurns: number;
  /** The full (already-written) spectator replay snapshots, WITH their per-snapshot `decisions[]` — used only for `statedReason` lookups. `null` skips stated-reason enrichment entirely (every moment's `statedReason` is `null`), never a throw. */
  replaySnapshots: readonly AgentSpectatorSnapshot[] | null;
}

/** A candidate's turn window collapses into an already-selected candidate's window when the two turns fall within this many turns of each other — the SAME "one real swing, one moment" rule `DirectorCutPlan.ts`'s `mergeGapTurns` embodies for its own segments, sized the same way (a fraction of the total match). */
function dedupeWindowTurns(totalTurns: number): number {
  return Math.max(10, Math.round(totalTurns / 100));
}

interface Candidate {
  turn: number;
  type: DecisiveMomentType;
  headline: string;
  involvedAgents: readonly string[];
  importance: number;
}

function sampleAtOrBefore(
  series: MatchStateSeries,
  turn: number,
): MatchStateSeriesSample | null {
  let best: MatchStateSeriesSample | null = null;
  for (const sample of series.samples) {
    if (sample.turn > turn) break;
    best = sample;
  }
  return best;
}

function sampleAtOrAfter(
  series: MatchStateSeries,
  turn: number,
): MatchStateSeriesSample | null {
  for (const sample of series.samples) {
    if (sample.turn >= turn) return sample;
  }
  return null;
}

function momentState(sample: MatchStateSeriesSample | null): DecisiveMomentState | null {
  if (sample === null) return null;
  return {
    turn: sample.turn,
    agents: sample.agents.map((agent) => ({
      username: agent.username,
      tilesOwned: agent.tilesOwned,
      troops: agent.troops,
      territoryShare: agent.territoryShare,
      rank: agent.rank,
      alive: agent.alive,
    })),
  };
}

/** Nearest decision (by absolute turn distance) any involved agent made, within `dedupeWindowTurns(totalTurns)` of `turn` — see `AgentDecisiveMomentsInput.replaySnapshots`' doc. */
function findStatedReason(
  snapshots: readonly AgentSpectatorSnapshot[] | null,
  involvedAgentIDs: ReadonlySet<string>,
  turn: number,
  windowTurns: number,
): string | null {
  if (snapshots === null) return null;
  let best: { text: string; distance: number } | null = null;
  for (const snapshot of snapshots) {
    const distance = Math.abs(snapshot.turnNumber - turn);
    if (distance > windowTurns) continue;
    for (const decision of Array.isArray(snapshot.decisions) ? snapshot.decisions : []) {
      if (
        decision === null ||
        typeof decision !== "object" ||
        typeof decision.agentID !== "string" ||
        typeof decision.reason !== "string" ||
        typeof decision.intentSummary !== "string"
      ) {
        continue;
      }
      if (!involvedAgentIDs.has(decision.agentID)) continue;
      const text = decision.reason.trim().length > 0 ? decision.reason : decision.intentSummary;
      if (text.trim().length === 0) continue;
      if (best === null || distance < best.distance) {
        best = { text, distance };
      }
    }
  }
  return best?.text ?? null;
}

function finalConfrontationCandidate(
  events: readonly SpectatorEvent[],
  totalTurns: number,
): Candidate | null {
  if (totalTurns <= 0) return null;
  const windowStart = Math.max(
    0,
    totalTurns -
      Math.min(
        totalTurns,
        Math.max(1, Math.round(totalTurns * FINAL_CONFLICT_TURN_FRACTION)),
        FINAL_CONFLICT_TURN_CAP,
      ),
  );
  const candidates = events.filter(
    (event) =>
      event.turnNumber >= windowStart &&
      event.targetAgentID !== null &&
      (event.kind === "attack" || event.kind === "nuke"),
  );
  if (candidates.length === 0) return null;
  const top = candidates.reduce((best, event) =>
    event.importance > best.importance ? event : best,
  );
  return {
    turn: top.turnNumber,
    type: "final_confrontation",
    headline: `Final clash: ${top.message}`,
    involvedAgents: [top.actorName, top.targetName ?? ""].filter((name) => name.length > 0),
    importance: Math.max(top.importance, 80),
  };
}

/**
 * Real-production-data quality pass (Season Zero Phase 2 polish): read as
 * an editor against ~10 real retained matches, `reversal` candidates were
 * systematically winning slots over `lead_change`/`territorial_swing`
 * purely because the opening spawn/expansion phase produces the LARGEST
 * rank-place swings of any match (a player landing a strong start jumps
 * from rank 12 to rank 1 in the first few hundred turns almost every
 * game — big in PLACES, rarely the actual story), while a genuinely
 * decisive LATE lead change or conquest wave scored lower purely for
 * having a smaller place-count or share-delta. Two changes: (1)
 * `lead_change`'s floor/ceiling are raised (70-95, was 60-90) — a
 * CONFIRMED lead change (already past `computeLeadChanges`'s own margin
 * + hysteresis filter) is "who is actually winning changed", the single
 * most decisive fact a match-state series can report, and now
 * consistently outranks an ordinary early reversal. (2) `reversal` and
 * `territorial_swing` both gain an explicit RECENCY term
 * (`turn / series.totalTurns`, 0..1) added on top of their magnitude
 * term: two swings of the same size no longer score identically — the
 * one happening later, when standings should be more settled and a big
 * move is more surprising, outranks the earlier one. `reversal`'s
 * magnitude term is also stretched (divisor 10 places instead of 8) so
 * magnitude alone caps lower, leaving room for recency to matter.
 */
function candidatesFromSeries(series: MatchStateSeries): Candidate[] {
  const candidates: Candidate[] = [];
  const totalTurns = series.totalTurns;

  for (const change of computeLeadChanges(series)) {
    candidates.push({
      turn: change.turn,
      type: "lead_change",
      headline: `${change.toUsername} overtakes ${change.fromUsername} for the territory lead.`,
      involvedAgents: [change.fromUsername, change.toUsername],
      importance: Math.round(70 + Math.min(1, change.marginShare / 0.25) * 25),
    });
  }

  for (const reversal of computeMajorReversals(series)) {
    const climbed = reversal.placesChanged > 0;
    const recency = totalTurns > 0 ? reversal.toTurn / totalTurns : 0;
    candidates.push({
      turn: reversal.toTurn,
      type: "reversal",
      headline: climbed
        ? `${reversal.username} claws back to ${ordinalLabel(reversal.toRank)} place from ${ordinalLabel(reversal.fromRank)}.`
        : `${reversal.username} collapses to ${ordinalLabel(reversal.toRank)} place from ${ordinalLabel(reversal.fromRank)}.`,
      involvedAgents: [reversal.username],
      importance: Math.round(
        45 +
          Math.min(1, Math.abs(reversal.placesChanged) / 10) * 25 +
          recency * 15,
      ),
    });
  }

  for (const elimination of computeEliminationTimings(series)) {
    candidates.push({
      turn: elimination.firstDeadTurn,
      type: "elimination",
      headline: `${elimination.username} is eliminated.`,
      involvedAgents: [elimination.username],
      importance: 85,
    });
  }

  for (const swing of computeTerritorialSwings(series)) {
    const expanding = swing.deltaShare > 0;
    const recency = totalTurns > 0 ? swing.toTurn / totalTurns : 0;
    candidates.push({
      turn: swing.toTurn,
      type: "territorial_swing",
      headline: expanding
        ? `${swing.username} seizes ${Math.round(swing.deltaShare * 100)}% of the map's territory in a single wave.`
        : `${swing.username} loses ${Math.round(Math.abs(swing.deltaShare) * 100)}% of the map's territory in a single wave.`,
      involvedAgents: [swing.username],
      importance: Math.round(
        50 + Math.min(1, Math.abs(swing.deltaShare) / 0.25) * 25 + recency * 10,
      ),
    });
  }

  return candidates;
}

function candidatesFromTelemetry(
  series: MatchStateSeries,
  events: readonly SpectatorEvent[],
  totalTurns: number,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const alliance of computeAllianceDurations(series, events)) {
    if (alliance.brokenByBetrayal !== true || alliance.brokenTurn === null) continue;
    candidates.push({
      turn: alliance.brokenTurn,
      type: "alliance_betrayal",
      headline: `${alliance.agentAUsername} and ${alliance.agentBUsername}'s alliance ends in betrayal after ${alliance.durationTurns} turns.`,
      involvedAgents: [alliance.agentAUsername, alliance.agentBUsername],
      importance: 95,
    });
  }
  const finalConfrontation = finalConfrontationCandidate(events, totalTurns);
  if (finalConfrontation !== null) {
    candidates.push(finalConfrontation);
  }
  return candidates;
}

/** Greedy highest-importance-first selection with turn-proximity dedup — see the module doc. */
function selectCandidates(
  candidates: readonly Candidate[],
  totalTurns: number,
): Candidate[] {
  const window = dedupeWindowTurns(totalTurns);
  const ranked = [...candidates].sort(
    (a, b) => b.importance - a.importance || a.turn - b.turn,
  );
  const selected: Candidate[] = [];
  for (const candidate of ranked) {
    if (selected.length >= MAX_DECISIVE_MOMENTS) break;
    if (selected.some((chosen) => Math.abs(chosen.turn - candidate.turn) <= window)) continue;
    selected.push(candidate);
  }
  return selected;
}

/** `null` when fewer than `MIN_DECISIVE_MOMENTS` genuine candidates survive selection — see the module doc's "never padded" rule. */
export function buildAgentDecisiveMoments(
  input: AgentDecisiveMomentsInput,
): AgentDecisiveMomentsArtifact | null {
  const candidates = [
    ...candidatesFromSeries(input.series),
    ...candidatesFromTelemetry(input.series, input.telemetryEvents, input.totalTurns),
  ];
  const selected = selectCandidates(candidates, input.totalTurns);
  if (selected.length < MIN_DECISIVE_MOMENTS) {
    return null;
  }

  const agentIDByUsername = new Map<string, string>();
  for (const sample of input.series.samples) {
    for (const agent of sample.agents) {
      if (agent.agentID !== null) agentIDByUsername.set(agent.username, agent.agentID);
    }
  }
  const window = dedupeWindowTurns(input.totalTurns);

  const moments: DecisiveMoment[] = selected
    .map((candidate) => {
      const involvedAgentIDs = new Set(
        candidate.involvedAgents
          .map((username) => agentIDByUsername.get(username))
          .filter((id): id is string => id !== undefined),
      );
      const beforeSample = sampleAtOrBefore(input.series, candidate.turn - 1);
      const afterSample = sampleAtOrAfter(input.series, candidate.turn);
      return {
        turn: candidate.turn,
        type: candidate.type,
        headline: candidate.headline,
        involvedAgents: candidate.involvedAgents,
        beforeState: momentState(beforeSample),
        afterState: momentState(afterSample),
        jumpToReplayTurn: candidate.turn,
        statedReason: findStatedReason(
          input.replaySnapshots,
          involvedAgentIDs,
          candidate.turn,
          window,
        ),
      };
    })
    .sort((a, b) => a.turn - b.turn);

  return {
    schemaVersion: DECISIVE_MOMENTS_SCHEMA_VERSION,
    runID: input.runID,
    generatedAt: new Date().toISOString(),
    moments,
  };
}
