/**
 * Name locations are produced by the 10 TPS simulation. Keep the compositor
 * transition just below the next normal-speed update so labels move between
 * authoritative positions instead of jumping after each turn.
 */
export const REPLAY_NAME_POSITION_REFRESH_MS = 100;
export const REPLAY_NAME_MAX_TRANSITION_MS = 90;
export const REPLAY_UNIT_MAX_INTERPOLATION_TILES = 16;
const REPLAY_PRESENTATION_TRANSITION_FILL_RATIO = 0.9;

/**
 * Progressive Premiere records already carry their fixed public playback
 * rate in their presentation offsets. The renderer receives that rate through
 * the lobby config and publishes this cadence after its layers initialize.
 */
export class ReplayPresentationCadenceEvent {
  constructor(public readonly presentationIntervalMs: number) {}
}

export function replayPresentationIntervalMsForPlaybackRate(
  playbackRate: number,
): number {
  if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
    return 0;
  }

  return REPLAY_NAME_POSITION_REFRESH_MS / playbackRate;
}

export function replayPresentationTransitionDurationForIntervalMs(
  presentationIntervalMs: number,
): number {
  if (!Number.isFinite(presentationIntervalMs) || presentationIntervalMs <= 0) {
    return 0;
  }

  return Math.min(
    REPLAY_NAME_MAX_TRANSITION_MS,
    Math.round(
      presentationIntervalMs * REPLAY_PRESENTATION_TRANSITION_FILL_RATIO,
    ),
  );
}

export function replayPresentationTransitionDurationMs(
  speedMultiplier: number,
): number {
  if (!Number.isFinite(speedMultiplier) || speedMultiplier <= 0) {
    return 0;
  }

  return replayPresentationTransitionDurationForIntervalMs(
    REPLAY_NAME_POSITION_REFRESH_MS * speedMultiplier,
  );
}

export interface ReplayPresentationPoint {
  readonly x: number;
  readonly y: number;
}

export interface ReplayUnitPresentationMotion {
  readonly source: ReplayPresentationPoint;
  readonly target: ReplayPresentationPoint;
  readonly startedAtMs: number;
  readonly durationMs: number;
}

export function sampleReplayUnitPresentationMotion(
  motion: ReplayUnitPresentationMotion,
  nowMs: number,
): ReplayPresentationPoint {
  if (motion.durationMs <= 0 || !Number.isFinite(nowMs)) {
    return motion.target;
  }

  const elapsedMs = Math.max(0, nowMs - motion.startedAtMs);
  const progress = Math.min(1, elapsedMs / motion.durationMs);
  return {
    x: motion.source.x + (motion.target.x - motion.source.x) * progress,
    y: motion.source.y + (motion.target.y - motion.source.y) * progress,
  };
}

/**
 * Retarget from the currently displayed position, never by predicting the
 * next simulation state. Large discontinuities (spawn, seek, catch-up) snap
 * instead of drawing an invented path across the map.
 */
export function retargetReplayUnitPresentationMotion(
  motion: ReplayUnitPresentationMotion | null,
  authoritativePrevious: ReplayPresentationPoint,
  authoritativeTarget: ReplayPresentationPoint,
  nowMs: number,
  durationMs: number,
): ReplayUnitPresentationMotion {
  if (
    motion !== null &&
    motion.target.x === authoritativeTarget.x &&
    motion.target.y === authoritativeTarget.y
  ) {
    return motion;
  }

  const safeDurationMs =
    Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const stepDistance = Math.hypot(
    authoritativeTarget.x - authoritativePrevious.x,
    authoritativeTarget.y - authoritativePrevious.y,
  );
  const shouldSnap =
    safeDurationMs === 0 ||
    !Number.isFinite(stepDistance) ||
    stepDistance > REPLAY_UNIT_MAX_INTERPOLATION_TILES;
  const source =
    shouldSnap || motion === null
      ? shouldSnap
        ? authoritativeTarget
        : authoritativePrevious
      : sampleReplayUnitPresentationMotion(motion, nowMs);

  return {
    source,
    target: authoritativeTarget,
    startedAtMs: nowMs,
    durationMs: shouldSnap ? 0 : safeDurationMs,
  };
}

export function retimeReplayUnitPresentationMotion(
  motion: ReplayUnitPresentationMotion,
  nowMs: number,
  durationMs: number,
): ReplayUnitPresentationMotion {
  const safeDurationMs =
    Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  if (safeDurationMs === 0) {
    return {
      source: motion.target,
      target: motion.target,
      startedAtMs: nowMs,
      durationMs: 0,
    };
  }

  return {
    source: sampleReplayUnitPresentationMotion(motion, nowMs),
    target: motion.target,
    startedAtMs: nowMs,
    durationMs: safeDurationMs,
  };
}
