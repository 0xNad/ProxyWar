import type { AgentDecisionRecord } from "./AgentTypes";
import type {
  AgentRunFinalState,
  AgentRunRosterEntry,
} from "./AgentDecisionLogWriter";
import {
  buildAgentSpectatorTelemetry,
  type SpectatorEvent,
  type SpectatorTelemetry,
} from "./AgentSpectatorTelemetry";

/**
 * Product overhaul spec Stage 5: a deterministic, inspectable "telemetry-
 * driven replay edit" for long matches (today's 10k-50k turns) — NOT a
 * rendered video (clips V3, `ReplayPremiereClips.ts`, already covers short
 * shareable MP4s via its own bucket-density selection; this module reuses
 * that THINKING — cluster by density, pick what matters — but produces a
 * turn-range SPEED SCHEDULE for the existing live player, never a rendered
 * artifact, and never duplicates clips V3's own bucket/reaction machinery).
 *
 * Input is exactly the same shape `AgentDramaReport.ts`/`AgentMatchStory.ts`
 * already consume (`records`/`roster`/`finalState`) — this module is a pure
 * function of the recorded match, like those two. Callers that already built
 * `SpectatorTelemetry` (every current caller does — see
 * `AgentDecisionLogWriter.ts`'s `writeAgentLeagueRunArtifacts`) SHOULD pass
 * it in via `spectatorTelemetry` to avoid recomputing it and to guarantee
 * this plan's segments are consistent with the SAME event stream the drama
 * report and public read-model events derive from.
 *
 * Honest degradation, never fabrication: a segment's `eventReason`/
 * `importance`/`participatingAgents` always trace back to a REAL
 * `SpectatorEvent` this module observed. When `finalState` is absent (no
 * verified match-end snapshot), the "final conflict" segment and any
 * elimination-anchored segment lose their outcome context but are still
 * derived from real mid-match events, never invented; `plan.degraded`
 * records this and `plan.notes` explains exactly what was unavailable.
 *
 * Genuinely infeasible without fabrication, so deliberately NOT attempted:
 * "lead change" as a segment trigger (spec Stage 5 item 1 lists it
 * alongside the others). No per-turn territory-ownership series exists
 * anywhere in this artifact-writing pipeline — `SpectatorAgent` only ever
 * carries `finalTilesOwned` (the match's LAST tile count, not a turn-by-turn
 * curve — confirmed via `AgentSpectatorTelemetry.ts`'s own schema), and the
 * only place a turn-by-turn territory curve could be reconstructed is a full
 * headless re-simulation of the raw `GameRecord.turns[]` through the core
 * engine, a heavyweight operation out of proportion to "generated alongside
 * the other lightweight per-match artifacts". "Major attacks" (real,
 * telemetry-derived, high-importance `attack` events) covers the same
 * narrative territory — a large attack is the closest honestly-derivable
 * proxy for "the standings shifted here" without inventing a curve this
 * pipeline does not have.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Coarse pacing tier a client player maps to its own concrete speed control (see `ReplaySpeedMultiplier` in `src/client/utilities/ReplaySpeedMultiplier.ts`) — this module never assumes a specific turns/second rate for "slow"/"normal"; only `estimatedDurationSeconds` bakes in that assumption, clearly as an ESTIMATE. */
export type DirectorCutSegmentSpeed = "slow" | "normal" | "fast";

export type DirectorCutEventReason =
  | "opening"
  | "expansion_milestone"
  | "alliance"
  | "war_declaration"
  | "first_strike"
  | "major_attack"
  | "treaty_break"
  | "nuke"
  | "elimination"
  | "final_conflict"
  /** No underlying event cleared the importance floor in this window — a real gap, not an omission. Always `speed: "fast"`, `importance: 0`. */
  | "quiet_interval";

/**
 * One contiguous turn range. `segments` fully partitions `[0, totalTurns]` —
 * no gaps, no overlaps — so a player can walk the array in order with
 * nothing left to separately interpolate. `startTurn`/`endTurn` are
 * inclusive-inclusive; consecutive segments share a boundary
 * (`segments[i].endTurn === segments[i+1].startTurn - 1` or the two are
 * adjacent by construction from the merge/gap-fill pass — verified by the
 * `partitions the whole match with no gaps or overlaps` test).
 */
export interface DirectorCutSegment {
  startTurn: number;
  endTurn: number;
  speed: DirectorCutSegmentSpeed;
  eventReason: DirectorCutEventReason;
  /** 0-100. The MAX `SpectatorEvent.importance` among events this segment was built from; 0 for `quiet_interval`. */
  importance: number;
  /** Display names of every distinct agent (actor/target/secondary) involved in an event this segment covers. Empty for `quiet_interval`. */
  participatingAgents: readonly string[];
}

export interface DirectorCutPlan {
  schemaVersion: 1;
  reportKind: "director-cut-plan";
  runID: string;
  matchID: string;
  generatedAt: string;
  totalTurns: number;
  segments: readonly DirectorCutSegment[];
  /** Sum of every non-quiet segment's turn span — the part of the match Director Cut treats as narratively load-bearing. */
  importantTurnCount: number;
  /** Best-effort real-time estimate (see the module doc's turns/second assumptions) — a client SHOULD still measure its own actual pace; this is a planning/display number, not a contract. */
  estimatedDurationSeconds: number;
  /** True when an input this module could have used (`finalState`) was unavailable, so some segments trace to fewer/weaker signals than a fully-populated match would produce. Never means "fabricated". */
  degraded: boolean;
  notes: readonly string[];
}

export interface DirectorCutPlanInput {
  runID: string;
  matchID: string;
  records: readonly AgentDecisionRecord[];
  roster: readonly AgentRunRosterEntry[];
  finalState?: AgentRunFinalState;
  /** Pass the ALREADY-BUILT telemetry when the caller has it (every production caller does) to avoid recomputation and guarantee consistency with the rest of that match's artifacts. Recomputed internally from `records`/`roster`/`finalState` only when absent (e.g. in isolated unit tests). */
  spectatorTelemetry?: SpectatorTelemetry;
}

// ---------------------------------------------------------------------------
// Tunable constants — every one documented with WHY, so a future tune has a
// reasoned starting point instead of a bare magic number.
// ---------------------------------------------------------------------------

/** A `SpectatorEvent` below this importance never anchors a segment on its own — matches `AgentSpectatorTelemetry.ts`'s own "hold" events sitting at 8-36 and routine builds at 26-58, so the floor cleanly excludes background noise while including every alliance/attack/nuke/elimination/betrayal (all >= 62 in that module's own scoring — see its `case` blocks). */
const IMPORTANCE_FLOOR = 60;
/** A segment plays at `slow` (the spec's "readable speed" for major events) once its peak importance reaches this — betrayals (100), nukes (95), eliminations (90), and formed alliances (92) all clear it; plain attacks (70) and early expansion (65) stay at `normal`. */
const MAJOR_IMPORTANCE = 85;
/**
 * Fraction of the target runtime reserved for "important" (non-quiet)
 * segments before `selectWindowsWithinBudget` stops admitting more
 * candidates. Quiet turns are cheap (up to `MAX_QUIET_TURNS_PER_SECOND`),
 * so the remaining share still comfortably covers pacing through the rest
 * of even a 50k-turn match — this exists to bound worst-case duration
 * (see `selectWindowsWithinBudget`'s own doc for why no importance tier is
 * exempt from it), not to starve quiet-interval screen time.
 */
const IMPORTANT_SECONDS_BUDGET_FRACTION = 0.7;

const OPENING_TURN_FRACTION = 0.03;
const OPENING_TURN_CAP = 250;
const FINAL_CONFLICT_TURN_FRACTION = 0.05;
const FINAL_CONFLICT_TURN_CAP = 400;

/** Readable real-time pace assumptions for `estimatedDurationSeconds` — independent of match length, since a viewer needs roughly the same wall-clock time to read one alliance regardless of whether it lands at turn 500 of a 10k-turn match or turn 40000 of a 50k-turn one. */
const SLOW_TURNS_PER_SECOND = 6;
const NORMAL_TURNS_PER_SECOND = 15;
/** Hard ceiling on the derived quiet-interval pace (see `deriveQuietTurnsPerSecond`) — protects a near-eventless match from an absurd "turns/second" number; such a match simply finishes well under the target duration, which is honest, not a defect. */
const MAX_QUIET_TURNS_PER_SECOND = 600;

/** Target total runtime interpolates linearly between these two anchor points (turn count -> seconds) and is otherwise left uncapped in either direction — "derive speeds from real turn counts, don't hardcode to one match size": a genuinely short match is allowed a genuinely short cut; a match past 50k turns keeps extrapolating past 12 minutes rather than being clamped to a number that would demand physically-impossible compression. */
const TARGET_DURATION_ANCHORS: readonly [turns: number, seconds: number][] = [
  [10_000, 300],
  [50_000, 720],
];

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function buildDirectorCutPlan(
  input: DirectorCutPlanInput,
): DirectorCutPlan {
  const notes: string[] = [];
  const degraded = input.finalState === undefined;
  if (degraded) {
    notes.push(
      "finalState was unavailable: the final-conflict segment and any elimination segment near match end trace only to mid-match events, not a verified end-of-match snapshot.",
    );
  }

  const telemetry =
    input.spectatorTelemetry ??
    buildAgentSpectatorTelemetry({
      runID: input.runID,
      records: input.records as AgentDecisionRecord[],
      roster: input.roster as AgentRunRosterEntry[],
      finalState: input.finalState,
    });

  const totalTurns = resolveTotalTurns(input, telemetry);

  if (totalTurns <= 0) {
    return {
      schemaVersion: 1,
      reportKind: "director-cut-plan",
      runID: input.runID,
      matchID: input.matchID,
      generatedAt: new Date().toISOString(),
      totalTurns: 0,
      segments: [],
      importantTurnCount: 0,
      estimatedDurationSeconds: 0,
      degraded: true,
      notes: [...notes, "No turns recorded for this match — empty plan."],
    };
  }

  const openingEnd = Math.min(
    totalTurns,
    Math.max(1, Math.round(totalTurns * OPENING_TURN_FRACTION)),
    OPENING_TURN_CAP,
  );
  const finalConflictStart = Math.max(
    openingEnd,
    totalTurns -
      Math.min(
        totalTurns,
        Math.max(1, Math.round(totalTurns * FINAL_CONFLICT_TURN_FRACTION)),
        FINAL_CONFLICT_TURN_CAP,
      ),
  );

  const bucketWidth = Math.max(10, Math.round(totalTurns / 300));
  const leadInTurns = bucketWidth;
  const mergeGapTurns = bucketWidth * 2;

  const candidates = buildCandidateWindows(telemetry.events, bucketWidth);
  const anchored = anchorAlwaysIncludedEvents(telemetry.events, candidates);
  const withFirstStrikeTagging = tagFirstStrikes(telemetry.events, anchored);
  const withLeadIn = applyLeadIn(
    withFirstStrikeTagging,
    leadInTurns,
    openingEnd,
  );
  const budgetedWindows = selectWindowsWithinBudget(withLeadIn, totalTurns);
  const merged = mergeOverlapping(budgetedWindows, mergeGapTurns);
  const clamped = merged
    .map((segment) => clampToBounds(segment, openingEnd, totalTurns))
    .filter((segment): segment is DirectorCutSegment => segment !== null);

  const openingSegment: DirectorCutSegment = {
    startTurn: 0,
    endTurn: openingEnd,
    speed: "normal",
    eventReason: "opening",
    importance: 100,
    participatingAgents: dedupedNames(
      input.roster.map((entry) => entry.username),
    ),
  };

  const finalConflictSegment = buildFinalConflictSegment(
    telemetry.events,
    finalConflictStart,
    totalTurns,
    input.roster,
  );

  const named = [openingSegment, ...clamped, finalConflictSegment].sort(
    (a, b) => a.startTurn - b.startTurn,
  );
  const partitioned = fillQuietGaps(named, totalTurns);

  const importantTurnCount = partitioned
    .filter((segment) => segment.eventReason !== "quiet_interval")
    .reduce(
      (sum, segment) => sum + (segment.endTurn - segment.startTurn + 1),
      0,
    );

  const estimatedDurationSeconds = estimateDurationSeconds(
    partitioned,
    totalTurns,
  );

  if (clamped.length === 0) {
    notes.push(
      "No event in this match reached the importance floor: only the opening and final-conflict segments are backed by narrative signal, everything between them is one quiet interval. A flat/uneventful match, not a generation defect.",
    );
  }

  return {
    schemaVersion: 1,
    reportKind: "director-cut-plan",
    runID: input.runID,
    matchID: input.matchID,
    generatedAt: new Date().toISOString(),
    totalTurns,
    segments: partitioned,
    importantTurnCount,
    estimatedDurationSeconds,
    degraded,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveTotalTurns(
  input: DirectorCutPlanInput,
  telemetry: SpectatorTelemetry,
): number {
  const fromFinalState = input.finalState?.turnCount ?? null;
  if (fromFinalState !== null && fromFinalState > 0) return fromFinalState;
  const fromEvents = telemetry.events.reduce(
    (max, event) => Math.max(max, event.turnNumber),
    0,
  );
  const fromRecords = input.records.reduce(
    (max, record) => Math.max(max, record.turnNumber),
    0,
  );
  return Math.max(fromEvents, fromRecords);
}

function dedupedNames(names: readonly (string | null)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (name === null || name === "") continue;
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

interface CandidateWindow {
  startTurn: number;
  endTurn: number;
  peakEvent: SpectatorEvent;
  events: SpectatorEvent[];
}

/** Buckets every event >= IMPORTANCE_FLOOR into fixed-width turn windows, keeping each window's peak (highest-importance) event and every event it covers (for `participatingAgents`). */
function buildCandidateWindows(
  events: readonly SpectatorEvent[],
  bucketWidth: number,
): CandidateWindow[] {
  const byBucket = new Map<number, SpectatorEvent[]>();
  for (const event of events) {
    if (event.importance < IMPORTANCE_FLOOR) continue;
    const bucket = Math.floor(event.turnNumber / bucketWidth);
    const list = byBucket.get(bucket);
    if (list === undefined) byBucket.set(bucket, [event]);
    else list.push(event);
  }
  const windows: CandidateWindow[] = [];
  for (const [bucket, bucketEvents] of byBucket) {
    const peakEvent = [...bucketEvents].sort(
      (a, b) => b.importance - a.importance || a.turnNumber - b.turnNumber,
    )[0];
    windows.push({
      startTurn: bucket * bucketWidth,
      endTurn: bucket * bucketWidth + bucketWidth - 1,
      peakEvent,
      events: bucketEvents,
    });
  }
  return windows.sort((a, b) => a.startTurn - b.startTurn);
}

/** Guarantees elimination/nuke/treaty-break events always anchor a window even if bucket-level clustering somehow missed one (defensive — these kinds are always >= IMPORTANCE_FLOOR already, so this mainly protects against a future importance-scoring change). */
function anchorAlwaysIncludedEvents(
  events: readonly SpectatorEvent[],
  windows: CandidateWindow[],
): CandidateWindow[] {
  const covered = (turn: number): boolean =>
    windows.some((w) => turn >= w.startTurn && turn <= w.endTurn);
  const extra: CandidateWindow[] = [];
  for (const event of events) {
    const mustInclude =
      event.kind === "elimination" ||
      event.kind === "nuke" ||
      (event.kind === "alliance_break" && event.tone === "betrayal");
    if (!mustInclude || covered(event.turnNumber)) continue;
    extra.push({
      startTurn: event.turnNumber,
      endTurn: event.turnNumber,
      peakEvent: event,
      events: [event],
    });
  }
  return [...windows, ...extra].sort((a, b) => a.startTurn - b.startTurn);
}

function eventReasonForKind(
  event: SpectatorEvent,
  isFirstStrike: boolean,
): DirectorCutEventReason {
  switch (event.kind) {
    case "neutral_expansion":
      return "expansion_milestone";
    case "alliance_formed":
      return "alliance";
    case "alliance_break":
      return event.tone === "betrayal" ? "treaty_break" : "war_declaration";
    case "target_call":
      return "war_declaration";
    case "attack":
      return isFirstStrike ? "first_strike" : "major_attack";
    case "nuke":
      return "nuke";
    case "elimination":
      return "elimination";
    default:
      return "major_attack";
  }
}

interface TaggedWindow extends CandidateWindow {
  reason: DirectorCutEventReason;
}

/** First attack per ordered actor/target pair, in turn order, gets `first_strike`; every later attack between the same pair stays `major_attack` — mirrors the SAME first-per-pair rule the Stage 4 War Room curation already established for this exact distinction. */
function tagFirstStrikes(
  events: readonly SpectatorEvent[],
  windows: CandidateWindow[],
): TaggedWindow[] {
  const ordered = [...events].sort(
    (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
  );
  const firstStrikeEventIds = new Set<string>();
  const seenPairs = new Set<string>();
  for (const event of ordered) {
    if (event.kind !== "attack" || event.targetAgentID === null) continue;
    const pairKey = `${event.actorAgentID}|${event.targetAgentID}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    firstStrikeEventIds.add(event.id);
  }
  return windows.map((window) => ({
    ...window,
    reason: eventReasonForKind(
      window.peakEvent,
      firstStrikeEventIds.has(window.peakEvent.id),
    ),
  }));
}

interface LeadInWindow extends TaggedWindow {
  leadInStart: number;
}

/** "Slow lead-ins to important events" (spec item 2): extends each window's effective start backward by `leadInTurns`, clamped to never precede the opening segment. */
function applyLeadIn(
  windows: TaggedWindow[],
  leadInTurns: number,
  openingEnd: number,
): LeadInWindow[] {
  return windows.map((window) => ({
    ...window,
    leadInStart: Math.max(openingEnd, window.startTurn - leadInTurns),
  }));
}

/** "Merge overlapping windows" (spec item 1): sorts by lead-in start and folds any window whose lead-in start falls within `mergeGapTurns` of the previous window's end into one segment, taking the higher peak importance/reason and the union of participating agents. */
function mergeOverlapping(
  windows: LeadInWindow[],
  mergeGapTurns: number,
): DirectorCutSegment[] {
  const ordered = [...windows].sort(
    (a, b) => a.leadInStart - b.leadInStart || a.endTurn - b.endTurn,
  );
  const merged: {
    startTurn: number;
    endTurn: number;
    peakEvent: SpectatorEvent;
    reason: DirectorCutEventReason;
    events: SpectatorEvent[];
  }[] = [];
  for (const window of ordered) {
    const last = merged[merged.length - 1];
    if (last !== undefined && window.leadInStart <= last.endTurn + mergeGapTurns) {
      last.endTurn = Math.max(last.endTurn, window.endTurn);
      last.events.push(...window.events);
      if (window.peakEvent.importance > last.peakEvent.importance) {
        last.peakEvent = window.peakEvent;
        last.reason = window.reason;
      }
      continue;
    }
    merged.push({
      startTurn: window.leadInStart,
      endTurn: window.endTurn,
      peakEvent: window.peakEvent,
      reason: window.reason,
      events: [...window.events],
    });
  }
  return merged.map((group) => ({
    startTurn: group.startTurn,
    endTurn: group.endTurn,
    speed: group.peakEvent.importance >= MAJOR_IMPORTANCE ? "slow" : "normal",
    eventReason: group.reason,
    importance: group.peakEvent.importance,
    participatingAgents: dedupedNames(
      group.events.flatMap((event) => [
        event.actorName,
        event.targetName,
        event.secondaryName ?? null,
      ]),
    ),
  }));
}

/**
 * Bounds worst-case duration on a high-agent-count/high-density match, where
 * `mergeOverlapping` alone can chain nearly every bucket together (drama is
 * near-continuous with e.g. 12 concurrent agents, so turn-adjacency stops
 * meaning "one continuous beat"). Runs BEFORE `mergeOverlapping`, on
 * individual candidate windows — running it after merge doesn't work: a
 * single blob spanning most of the match, formed because SOME window
 * inside it cleared any "always keep" bar, would report that whole blob's
 * importance as the qualifying peak and keep the entire thing regardless
 * of budget. Selecting per-window first means a dropped window can no
 * longer act as connective tissue gluing two distant major windows into
 * one, AND an outlier match with an extreme count of individually-major
 * events (e.g. 300+ nukes in one real 12-agent match — verified against
 * spectator telemetry, not a hypothetical) cannot blow the budget by
 * count alone: every window, however important, competes for the same
 * fixed budget.
 *
 * No importance tier is unconditionally exempt from the budget — an
 * "always keep regardless of cost" carve-out re-creates exactly the
 * runaway-duration bug this function exists to prevent, just gated on a
 * narrower kind list instead of a wider importance floor (verified: even
 * restricting to elimination/nuke/betrayal-break alone reproduces a
 * 40,000+-turn merged blob on the same real match, because THAT specific
 * match alone has 302 nuke events). Windows are ranked by importance —
 * betrayals (100), nukes (95), eliminations (90), and formed alliances
 * (92) naturally sort first — and kept greedily, highest importance
 * first, until the
 * important-seconds budget derived from `targetDurationSeconds` is spent.
 * Whatever doesn't fit becomes `quiet_interval` via `fillQuietGaps` — an
 * honest downgrade, not a silent omission: Director Cut fast-forwards
 * through a quiet interval, it never cuts the turns inside one from
 * playback, so a below-the-cutoff event still passes in front of the
 * viewer, just without an individual readable-speed dwell.
 */
function selectWindowsWithinBudget(
  windows: readonly LeadInWindow[],
  totalTurns: number,
): LeadInWindow[] {
  const windowSeconds = (window: LeadInWindow): number =>
    (window.endTurn - window.leadInStart + 1) /
    (window.peakEvent.importance >= MAJOR_IMPORTANCE
      ? SLOW_TURNS_PER_SECOND
      : NORMAL_TURNS_PER_SECOND);

  const ranked = [...windows].sort(
    (a, b) =>
      b.peakEvent.importance - a.peakEvent.importance ||
      a.startTurn - b.startTurn,
  );

  const importantSecondsBudget =
    targetDurationSeconds(totalTurns) * IMPORTANT_SECONDS_BUDGET_FRACTION;
  let cumulativeSeconds = 0;
  const selected: LeadInWindow[] = [];
  for (const candidate of ranked) {
    const cost = windowSeconds(candidate);
    if (cumulativeSeconds + cost > importantSecondsBudget) continue;
    selected.push(candidate);
    cumulativeSeconds += cost;
  }
  return selected.sort((a, b) => a.leadInStart - b.leadInStart);
}

function clampToBounds(
  segment: DirectorCutSegment,
  openingEnd: number,
  totalTurns: number,
): DirectorCutSegment | null {
  const startTurn = Math.max(openingEnd, segment.startTurn);
  const endTurn = Math.min(totalTurns, segment.endTurn);
  if (startTurn > endTurn) return null;
  return { ...segment, startTurn, endTurn };
}

function buildFinalConflictSegment(
  events: readonly SpectatorEvent[],
  finalConflictStart: number,
  totalTurns: number,
  roster: readonly AgentRunRosterEntry[],
): DirectorCutSegment {
  const eventsInWindow = events.filter(
    (event) =>
      event.turnNumber >= finalConflictStart && event.turnNumber <= totalTurns,
  );
  const peakImportance = eventsInWindow.reduce(
    (max, event) => Math.max(max, event.importance),
    0,
  );
  const participants =
    eventsInWindow.length > 0
      ? dedupedNames(
          eventsInWindow.flatMap((event) => [
            event.actorName,
            event.targetName,
            event.secondaryName ?? null,
          ]),
        )
      : dedupedNames(roster.map((entry) => entry.username));
  return {
    startTurn: finalConflictStart,
    endTurn: totalTurns,
    speed: "slow",
    eventReason: "final_conflict",
    importance: Math.max(peakImportance, 50),
    participatingAgents: participants,
  };
}

/** Sorts named segments, merges any that now overlap after `final_conflict`/`opening` clamping absorbed part of a candidate window, then fills every remaining gap in `[0, totalTurns]` with an explicit `quiet_interval` segment so `segments` is a complete, gapless partition. */
function fillQuietGaps(
  named: DirectorCutSegment[],
  totalTurns: number,
): DirectorCutSegment[] {
  const merged: DirectorCutSegment[] = [];
  for (const segment of named) {
    const last = merged[merged.length - 1];
    if (last !== undefined && segment.startTurn <= last.endTurn) {
      if (segment.endTurn <= last.endTurn) continue;
      merged[merged.length - 1] = {
        ...last,
        endTurn: segment.endTurn,
        importance: Math.max(last.importance, segment.importance),
        eventReason:
          segment.importance > last.importance
            ? segment.eventReason
            : last.eventReason,
        participatingAgents: dedupedNames([
          ...last.participatingAgents,
          ...segment.participatingAgents,
        ]),
      };
      continue;
    }
    merged.push(segment);
  }

  const partitioned: DirectorCutSegment[] = [];
  let cursor = 0;
  for (const segment of merged) {
    if (segment.startTurn > cursor) {
      partitioned.push({
        startTurn: cursor,
        endTurn: segment.startTurn - 1,
        speed: "fast",
        eventReason: "quiet_interval",
        importance: 0,
        participatingAgents: [],
      });
    }
    partitioned.push(segment);
    cursor = segment.endTurn + 1;
  }
  if (cursor <= totalTurns) {
    partitioned.push({
      startTurn: cursor,
      endTurn: totalTurns,
      speed: "fast",
      eventReason: "quiet_interval",
      importance: 0,
      participatingAgents: [],
    });
  }
  return partitioned;
}

function deriveQuietTurnsPerSecond(
  quietTurnCount: number,
  importantSeconds: number,
  targetSeconds: number,
): number {
  if (quietTurnCount <= 0) return MAX_QUIET_TURNS_PER_SECOND;
  const remainingSeconds = Math.max(1, targetSeconds - importantSeconds);
  return Math.min(
    MAX_QUIET_TURNS_PER_SECOND,
    quietTurnCount / remainingSeconds,
  );
}

function targetDurationSeconds(totalTurns: number): number {
  const [[turnsA, secondsA], [turnsB, secondsB]] = TARGET_DURATION_ANCHORS;
  const slope = (secondsB - secondsA) / (turnsB - turnsA);
  return Math.max(1, secondsA + (totalTurns - turnsA) * slope);
}

function estimateDurationSeconds(
  segments: readonly DirectorCutSegment[],
  totalTurns: number,
): number {
  let importantSeconds = 0;
  let quietTurnCount = 0;
  for (const segment of segments) {
    const span = segment.endTurn - segment.startTurn + 1;
    if (segment.eventReason === "quiet_interval") {
      quietTurnCount += span;
      continue;
    }
    const rate =
      segment.speed === "slow" ? SLOW_TURNS_PER_SECOND : NORMAL_TURNS_PER_SECOND;
    importantSeconds += span / rate;
  }
  const target = targetDurationSeconds(totalTurns);
  const quietTurnsPerSecond = deriveQuietTurnsPerSecond(
    quietTurnCount,
    importantSeconds,
    target,
  );
  const quietSeconds =
    quietTurnCount > 0 ? quietTurnCount / quietTurnsPerSecond : 0;
  return Math.round(importantSeconds + quietSeconds);
}
