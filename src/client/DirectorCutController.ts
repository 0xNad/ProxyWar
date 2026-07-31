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
  return SEGMENT_SPEED_TO_CLIENT_SPEED[segment.speed];
}

export interface DirectorCutControllerHandle {
  /**
   * Toggling OFF hands playback speed control fully back to the viewer's
   * own choice (resetting to `normal`, the same baseline Full Replay
   * starts at) and stops reacting to frames — "Full Replay unaffected"
   * (spec Stage 5 acceptance) means this controller must never touch
   * `ReplaySpeedChangeEvent` again once disabled.
   */
  setEnabled(enabled: boolean): void;
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
    applySegmentAt(0);
  }

  return {
    setEnabled(next: boolean) {
      if (next === enabled) return;
      enabled = next;
      if (enabled) {
        lastSegmentIndex = -1;
        applySegmentAt(0);
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
