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
import {
  computeLeadChanges,
  computeMajorReversals,
  LEAD_CHANGE_MARGIN_SHARE,
  REVERSAL_MIN_PLACES,
  type LeadChange,
  type MajorReversal,
} from "./AgentMatchStateDerivations";
import type { MatchStateSeries } from "./AgentMatchStateSeries";

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
 * Season Zero Phase 2 gap closure: "lead change"/"reversal" segments ARE
 * now attempted (spec Stage 5 item 1 listed lead change alongside the
 * others as a future addition) — but ONLY when the caller passes a real
 * `matchStateSeries` (`AgentMatchStateSeries.ts`). Without one (the
 * default until the mirror's series backfill reaches a given run, or a
 * source replay with zero snapshots), this module degrades EXACTLY as
 * before this fix: "major attacks" remains the closest honestly-derivable
 * proxy for "the standings shifted here". Lead-change/reversal segments
 * are built directly as `DirectorCutSegment`s from
 * `AgentMatchStateDerivations.ts`'s own derivations (see
 * `buildSeriesDerivedSegments`) — they do NOT flow through the
 * `SpectatorEvent`-keyed candidate-window/budget pipeline below (that
 * pipeline is keyed on real `SpectatorEvent`s; a lead change is not one),
 * and are bounded by their OWN small fixed count
 * (`MAX_LEAD_CHANGE_SEGMENTS`/`MAX_REVERSAL_SEGMENTS`) rather than
 * competing in `selectWindowsWithinBudget`'s shared important-seconds
 * budget — the same "guaranteed inclusion, small and bounded" treatment
 * `openingSegment`/`finalConflictSegment` already get, chosen because
 * honest lead-change/reversal data is inherently rare (bounded by the
 * series' own <=80 samples) and always narratively load-bearing per the
 * spec, unlike the potentially-hundreds of attack/nuke events the shared
 * budget exists to ration.
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
  /** Anchored on a confirmed `LeadChange` from `AgentMatchStateDerivations.ts` — see the module doc. */
  | "lead_change"
  /** Anchored on a `MajorReversal` (a >=3-place rank swing) from `AgentMatchStateDerivations.ts` — see the module doc. */
  | "reversal"
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
  /** Season Zero Phase 2: the sampled match-state series (`AgentMatchStateSeries.ts`), when already generated for this run — unlocks `lead_change`/`reversal` segments (see the module doc). `null`/absent degrades exactly as before this fix. */
  matchStateSeries?: MatchStateSeries | null;
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
/** Exported so `AgentMatchRecap.ts`'s "final confrontation" beat uses the SAME endgame window this module's own `final_conflict` segment does — one tuned definition of "the final stretch of the match", not two that could silently drift apart. */
export const FINAL_CONFLICT_TURN_FRACTION = 0.05;
export const FINAL_CONFLICT_TURN_CAP = 400;

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

/**
 * `lead_change`/`reversal` segments are guaranteed-inclusion and bounded by
 * a small fixed COUNT (not the shared important-seconds budget — see the
 * module doc). Ranked by `marginShare`/`abs(placesChanged)` respectively
 * before truncating, so the MOST decisive swings survive when a match
 * (rare, given the series' own <=80-sample cap) produces more than the cap.
 */
const MAX_LEAD_CHANGE_SEGMENTS = 6;
const MAX_REVERSAL_SEGMENTS = 6;
/** A lead change/reversal's segment `importance` interpolates from `IMPORTANCE_FLOOR` (the weakest still-qualifying swing) up toward this ceiling as its margin/place-count grows — capped here, never above `MAJOR_IMPORTANCE`'s neighborhood, so a lead-change segment competes fairly with real high-drama events for `speed: "slow"` without a small overtake accidentally outranking a betrayal. */
const SERIES_SEGMENT_IMPORTANCE_CEILING = 95;

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
  const seriesDerivedSegments = buildSeriesDerivedSegments(
    input.matchStateSeries ?? null,
    leadInTurns,
    openingEnd,
    totalTurns,
  );
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

  const named = [
    openingSegment,
    ...clamped,
    ...seriesDerivedSegments,
    finalConflictSegment,
  ].sort((a, b) => a.startTurn - b.startTurn);
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

/** Strength=0 at exactly the qualification threshold (`LEAD_CHANGE_MARGIN_SHARE`/`REVERSAL_MIN_PLACES`), strength=1 at this "very decisive" reference point and beyond (clamped) — `seriesSegmentImportance` maps `[0, 1]` onto `[IMPORTANCE_FLOOR, SERIES_SEGMENT_IMPORTANCE_CEILING]`. 0.30 = a 30-percentage-point overtake counts as maximally decisive. */
const LEAD_CHANGE_STRENGTH_REFERENCE_MARGIN = 0.3;
/** See `LEAD_CHANGE_STRENGTH_REFERENCE_MARGIN` — 8 places counts as a maximally decisive reversal (the largest possible in a 9-agent match, comfortably above the game's typical roster size). */
const REVERSAL_STRENGTH_REFERENCE_PLACES = 8;

/** Linearly maps `value` from `[threshold, reference]` onto importance `[IMPORTANCE_FLOOR, SERIES_SEGMENT_IMPORTANCE_CEILING]`, clamped at both ends — `value === threshold` (the weakest swing that still qualified as a lead change/reversal at all) lands exactly at the floor. */
function seriesSegmentImportance(
  value: number,
  threshold: number,
  reference: number,
): number {
  const strength = Math.min(1, Math.max(0, (value - threshold) / (reference - threshold)));
  return Math.round(
    IMPORTANCE_FLOOR + strength * (SERIES_SEGMENT_IMPORTANCE_CEILING - IMPORTANCE_FLOOR),
  );
}

function leadChangeSegment(
  change: LeadChange,
  leadInTurns: number,
  openingEnd: number,
  totalTurns: number,
): DirectorCutSegment {
  const importance = seriesSegmentImportance(
    change.marginShare,
    LEAD_CHANGE_MARGIN_SHARE,
    LEAD_CHANGE_STRENGTH_REFERENCE_MARGIN,
  );
  return {
    startTurn: Math.max(openingEnd, change.turn - leadInTurns),
    endTurn: Math.min(totalTurns, change.turn + leadInTurns),
    speed: importance >= MAJOR_IMPORTANCE ? "slow" : "normal",
    eventReason: "lead_change",
    importance,
    participatingAgents: dedupedNames([change.fromUsername, change.toUsername]),
  };
}

/**
 * Windowed on `toTurn` (leadInTurns either side), NOT the reversal's full
 * `[fromTurn, toTurn]` climb — `REVERSAL_MAX_SAMPLE_GAP` bounds a reversal
 * by SAMPLE count, not turn count, so on a sparsely-sampled late-match
 * reversal that raw span can legitimately run to thousands of turns; a
 * segment that wide would dominate the cut at merely `normal` pace instead
 * of behaving like the other short, readable-speed highlight windows this
 * planner otherwise produces. `fromTurn`/`toTurn` stay on `MajorReversal`
 * itself for recap/decisive-moment consumers that DO want the real span.
 */
function reversalSegment(
  reversal: MajorReversal,
  leadInTurns: number,
  openingEnd: number,
  totalTurns: number,
): DirectorCutSegment {
  const importance = seriesSegmentImportance(
    Math.abs(reversal.placesChanged),
    REVERSAL_MIN_PLACES,
    REVERSAL_STRENGTH_REFERENCE_PLACES,
  );
  return {
    startTurn: Math.max(openingEnd, reversal.toTurn - leadInTurns),
    endTurn: Math.min(totalTurns, reversal.toTurn + leadInTurns),
    speed: importance >= MAJOR_IMPORTANCE ? "slow" : "normal",
    eventReason: "reversal",
    importance,
    participatingAgents: dedupedNames([reversal.username]),
  };
}

/**
 * Builds the guaranteed-inclusion `lead_change`/`reversal` segments (see the
 * module doc) directly from `AgentMatchStateDerivations.ts` — `[]` when
 * `series` is `null` (no series generated for this run yet), never a
 * fabricated segment. Ranked by swing strength and truncated to
 * `MAX_LEAD_CHANGE_SEGMENTS`/`MAX_REVERSAL_SEGMENTS` before being handed to
 * the caller, which sorts everything by `startTurn` and lets
 * `fillQuietGaps` resolve any overlap with a higher-importance
 * telemetry-derived segment (see that function's own doc).
 */
function buildSeriesDerivedSegments(
  series: MatchStateSeries | null,
  leadInTurns: number,
  openingEnd: number,
  totalTurns: number,
): DirectorCutSegment[] {
  if (series === null) return [];
  const leadChanges = [...computeLeadChanges(series)]
    .sort((a, b) => b.marginShare - a.marginShare)
    .slice(0, MAX_LEAD_CHANGE_SEGMENTS)
    .map((change) => leadChangeSegment(change, leadInTurns, openingEnd, totalTurns));
  const reversals = [...computeMajorReversals(series)]
    .sort((a, b) => Math.abs(b.placesChanged) - Math.abs(a.placesChanged))
    .slice(0, MAX_REVERSAL_SEGMENTS)
    .map((reversal) => reversalSegment(reversal, leadInTurns, openingEnd, totalTurns));
  return [...leadChanges, ...reversals];
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

/**
 * A turn span's simplified pacing bucket for {@link estimateDurationFromSpans}
 * — the same three buckets `estimateDurationSeconds` already reads off a
 * real `DirectorCutSegment` (`quiet_interval` -> `"quiet"`, `speed: "slow"`
 * -> `"slow"`, everything else -> `"normal"`), factored out so a caller
 * with real turn SPANS but no full `DirectorCutSegment[]` (no `SpectatorEvent`
 * evidence to build one from — see `estimatePreRevealDirectorCutSeconds`
 * below) can reuse the exact SAME rate/target math without fabricating a
 * `DirectorCutEventReason` it has no evidence for.
 */
export type DirectorCutPacingSpan = { turns: number; pace: "slow" | "normal" | "quiet" };

function estimateDurationFromSpans(
  spans: readonly DirectorCutPacingSpan[],
  totalTurns: number,
): number {
  let importantSeconds = 0;
  let quietTurnCount = 0;
  for (const span of spans) {
    if (span.pace === "quiet") {
      quietTurnCount += span.turns;
      continue;
    }
    const rate = span.pace === "slow" ? SLOW_TURNS_PER_SECOND : NORMAL_TURNS_PER_SECOND;
    importantSeconds += span.turns / rate;
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

function estimateDurationSeconds(
  segments: readonly DirectorCutSegment[],
  totalTurns: number,
): number {
  return estimateDurationFromSpans(
    segments.map((segment) => ({
      turns: segment.endTurn - segment.startTurn + 1,
      pace:
        segment.eventReason === "quiet_interval"
          ? "quiet"
          : segment.speed === "slow"
            ? "slow"
            : "normal",
    })),
    totalTurns,
  );
}

/**
 * Runbook §"Known gaps": a premiere-lane `EventPackage`'s Director Cut
 * estimate is structurally unavailable pre-reveal — `premiere-package.ts`'s
 * mirror-row lookup can never resolve for a freshly scheduled sealed
 * premiere (its `episodeRequestId` cannot yet appear in the public league
 * mirror; `premiere:schedule` itself refuses a candidate whose id already
 * does). This is the fix: reuses {@link estimateDurationFromSpans} — the
 * SAME rate/anchor math `buildDirectorCutPlan`'s own `estimateDurationSeconds`
 * runs on real segments — fed a STRUCTURAL (never narrative) turn-span
 * partition built ONLY from the sealed bundle's own `meta.json` fields
 * (`turnCount`/`checkpointTurns`) — the one signal a pre-reveal bundle
 * actually carries about where meaningful post-spawn play concentrates
 * (`PremiereWageringCheckpoints.checkpointTurnsForEpisode` places the two
 * checkpoints at ~35%/65% of the POST-SPAWN window specifically so a
 * wagering market resolves against real gameplay, never the spawn phase).
 *
 * Honest by construction: the checkpoint window paces `"normal"` (never
 * `"slow"` — that tier requires a confirmed high-importance
 * `SpectatorEvent`, which is exactly the evidence sealed bundles never
 * retain); everything outside the window degrades to `"quiet"`, the same
 * default `buildDirectorCutPlan` itself falls back to for a match with no
 * qualifying events. Malformed/missing checkpoints degrade to a single
 * quiet span covering the whole match (equivalent to
 * `targetDurationSeconds(totalTurns)` alone) rather than throwing —
 * matching every other tolerant-degradation path in this module.
 */
export function estimatePreRevealDirectorCutSeconds(input: {
  totalTurns: number;
  checkpointTurns: readonly number[];
}): number {
  const totalTurns = Math.max(0, Math.round(input.totalTurns));
  if (totalTurns <= 0) return 0;
  const finiteCheckpoints = input.checkpointTurns.filter((turn) => Number.isFinite(turn));
  const clampTurn = (turn: number) => Math.min(totalTurns, Math.max(0, Math.round(turn)));
  const windowStart = finiteCheckpoints.length > 0 ? clampTurn(Math.min(...finiteCheckpoints)) : 0;
  const windowEnd =
    finiteCheckpoints.length > 0
      ? Math.max(windowStart, clampTurn(Math.max(...finiteCheckpoints)))
      : 0;
  const spans: DirectorCutPacingSpan[] = [];
  if (windowStart > 0) spans.push({ turns: windowStart, pace: "quiet" });
  if (windowEnd > windowStart) spans.push({ turns: windowEnd - windowStart, pace: "normal" });
  if (totalTurns > windowEnd) spans.push({ turns: totalTurns - windowEnd, pace: "quiet" });
  return estimateDurationFromSpans(spans, totalTurns);
}
