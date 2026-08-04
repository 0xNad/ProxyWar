import { ReplaySpeedMultiplier } from "./utilities/ReplaySpeedMultiplier";

/**
 * Client-local mirror of `src/server/agents/DirectorCutPlan.ts`'s public
 * shape (product overhaul spec Stage 5). Client code never imports server
 * modules — this module re-declares the artifact's JSON shape and validates
 * it defensively at runtime, the same pattern
 * `AiLeagueReplayOverlay.ts`'s `normalizeSpectatorTelemetry` already uses
 * for `spectator-telemetry.json`.
 */
export type DirectorCutSegmentSpeed = "slow" | "normal" | "fast";

export interface DirectorCutSegment {
  startTurn: number;
  endTurn: number;
  speed: DirectorCutSegmentSpeed;
  eventReason: string;
  importance: number;
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
  importantTurnCount: number;
  estimatedDurationSeconds: number;
  degraded: boolean;
  notes: readonly string[];
}

export function normalizeDirectorCutPlan(value: unknown): DirectorCutPlan | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<DirectorCutPlan>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.reportKind !== "director-cut-plan" ||
    typeof candidate.totalTurns !== "number" ||
    !Array.isArray(candidate.segments) ||
    candidate.segments.length === 0
  ) {
    return null;
  }
  for (const segment of candidate.segments) {
    if (
      typeof segment !== "object" ||
      segment === null ||
      typeof (segment as Partial<DirectorCutSegment>).startTurn !== "number" ||
      typeof (segment as Partial<DirectorCutSegment>).endTurn !== "number" ||
      !["slow", "normal", "fast"].includes(
        (segment as Partial<DirectorCutSegment>).speed as string,
      )
    ) {
      return null;
    }
  }
  return candidate as DirectorCutPlan;
}

/**
 * `segments` is a sorted, gapless, non-overlapping partition of
 * `[0, totalTurns]` (guaranteed by the server-side generator — see
 * `DirectorCutPlan.ts`'s own doc on `DirectorCutSegment`), so a binary
 * search is exact and O(log n) per frame.
 */
export function segmentForTurn(
  plan: Pick<DirectorCutPlan, "segments">,
  turn: number,
): { segment: DirectorCutSegment; index: number } | null {
  const segments = plan.segments;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const segment = segments[mid];
    if (turn < segment.startTurn) {
      hi = mid - 1;
    } else if (turn > segment.endTurn) {
      lo = mid + 1;
    } else {
      return { segment, index: mid };
    }
  }
  // Past `totalTurns` (a late/trailing frame) or before turn 0 — neither
  // should happen with a well-formed plan, but a stale frame during a mode
  // switch is possible; the caller simply skips the speed change that turn.
  return null;
}

/**
 * Director Cut's 3 semantic tiers ("slow"/"normal"/"fast") map onto the
 * client's 4 concrete `ReplaySpeedMultiplier` levels. `fast` — Director
 * Cut's "get through this quickly" tier for `quiet_interval` segments —
 * maps to `fastest` (zero artificial per-turn delay), not the client's own
 * `fast` (a 2x-speed, still-delayed tier): `DirectorCutPlan.ts`'s duration
 * estimate assumes quiet stretches can run up to 600 turns/second, a rate
 * only zero added delay can approach. `slow`/`normal` map directly — those
 * tiers are already named for the exact same reason on both sides (a
 * segment `DirectorCutPlan.ts` calls "readable speed for major events" is
 * the same experience the client's own `normal`/`slow` buttons describe).
 */
const SEGMENT_SPEED_TO_CLIENT_SPEED: Record<
  DirectorCutSegmentSpeed,
  ReplaySpeedMultiplier
> = {
  slow: ReplaySpeedMultiplier.slow,
  normal: ReplaySpeedMultiplier.normal,
  fast: ReplaySpeedMultiplier.fastest,
};

export function directorCutSpeedForSegment(
  segment: DirectorCutSegment,
): ReplaySpeedMultiplier {
  // Quick fix (P0 incident, 2026-08-03): the SPAWN phase (the "opening"
  // segment, plan-authored as "normal" for an establishing-shot feel) has
  // zero strategic content -- nothing to actually watch, just territory
  // assignment. At "normal" (1x) a typical several-hundred-turn opening
  // took ~25-30s of real time to clear, reading as a frozen/broken page on
  // first load (the big homepage button was the first thing a new visitor
  // hit). Client-side override, keyed on `eventReason` alone -- never
  // `segment.speed` -- so every ALREADY-BAKED director-cut-plan.json
  // benefits immediately, with no server-side regeneration pass required.
  // The opening segment now always plays at the same catch-up ("fastest"/
  // 0-delay) pace archived replays already default to before Director
  // Cut's own plan even loads (see LocalServer.ts's
  // applyArchivedReplayDefaultSpeed) -- a viewer reaches the plan's own
  // real pacing the instant spawn ends (the next segment's own
  // `applySegmentAt` boundary crossing below), never slower than they'd
  // have gotten with Director Cut disabled entirely. Follow-up (not done
  // here): teach the server-side generator (`DirectorCutPlan.ts`) to bake
  // this directly into new plans' `speed` field instead of overriding it
  // client-side forever.
  if (segment.eventReason === "opening") {
    return ReplaySpeedMultiplier.fastest;
  }
  return SEGMENT_SPEED_TO_CLIENT_SPEED[segment.speed];
}

export interface DirectorCutControllerHandle {
  /**
   * Toggling OFF hands playback speed control fully back to the viewer's
   * own choice (resetting to `normal`, the same baseline Full Replay
   * starts at) and stops reacting to frames — "Full Replay unaffected"
   * (spec Stage 5 acceptance) means this controller must never touch
   * `ReplaySpeedChangeEvent` again once disabled.
   *
   * `currentTurn` (default 0) is the segment to resync to when turning
   * back ON. Toggling back on mid-match without it would always reapply
   * the OPENING segment's speed at whatever nonzero turn playback is
   * actually at, correcting itself only at the next frame tick boundary
   * — a real, found bug. Callers own tracking "what turn is the viewer
   * at" (`AiLeagueReplayOverlay.ts`'s `currentInput.currentTurn`, already
   * fed by the same `ai-league-replay-frame` event this controller
   * itself listens to) and must pass it here.
   */
  setEnabled(enabled: boolean, currentTurn?: number): void;
  isEnabled(): boolean;
  dispose(): void;
}

/**
 * Drives `onSpeedChange` from a `DirectorCutPlan` by listening to the same
 * per-frame `"ai-league-replay-frame"` DOM CustomEvent every other AI
 * League replay subsystem (lower-thirds, diplomacy strip, social bubbles)
 * already reacts to (dispatched by `ClientGameRunner.dispatchAiLeagueReplayFrame`
 * with `detail.tick` = the turn just rendered) — never a bespoke Layer, so
 * this needs no `GameView`/canvas access of its own.
 */
export function mountDirectorCutController(options: {
  plan: DirectorCutPlan;
  enabledByDefault: boolean;
  onSpeedChange: (speed: ReplaySpeedMultiplier) => void;
  onSegmentChange?: (segment: DirectorCutSegment | null) => void;
  documentRef?: Document;
  /**
   * The turn playback is actually at when this controller mounts (default
   * 0). Plan JSON hydrates asynchronously, same timing as spectator
   * telemetry (see `AiLeagueReplayOverlay.ts`'s `syncDirectorCutController`
   * doc) — playback can already be well past turn 0 by the time this runs,
   * and mounting enabled must apply the segment covering THAT turn, never
   * unconditionally the opening one.
   */
  currentTurn?: number;
}): DirectorCutControllerHandle {
  const doc = options.documentRef ?? document;
  let enabled = options.enabledByDefault;
  let lastSegmentIndex = -1;

  const applySegmentAt = (tick: number) => {
    const found = segmentForTurn(options.plan, tick);
    if (found === null || found.index === lastSegmentIndex) {
      return;
    }
    lastSegmentIndex = found.index;
    options.onSpeedChange(directorCutSpeedForSegment(found.segment));
    options.onSegmentChange?.(found.segment);
  };

  const onFrame = (event: Event) => {
    if (!enabled) return;
    const tick = (event as CustomEvent<{ tick?: number }>).detail?.tick;
    if (typeof tick !== "number" || !Number.isFinite(tick)) return;
    applySegmentAt(tick);
  };
  doc.addEventListener("ai-league-replay-frame", onFrame);

  if (enabled) {
    applySegmentAt(options.currentTurn ?? 0);
  }

  return {
    setEnabled(next: boolean, currentTurn?: number) {
      if (next === enabled) return;
      enabled = next;
      if (enabled) {
        lastSegmentIndex = -1;
        applySegmentAt(currentTurn ?? 0);
      } else {
        lastSegmentIndex = -1;
        options.onSegmentChange?.(null);
        options.onSpeedChange(ReplaySpeedMultiplier.normal);
      }
    },
    isEnabled() {
      return enabled;
    },
    dispose() {
      doc.removeEventListener("ai-league-replay-frame", onFrame);
    },
  };
}
