/**
 * Bounded retention for the spectator replay's snapshot array, with an ACTUALLY
 * even temporal spread.
 *
 * The previous inline rule halved the array whenever it exceeded the cap, keeping
 * indices 0,2,4,… and describing itself as "preserving an even temporal spread".
 * It does not. Halving thins everything retained SO FAR, while new snapshots keep
 * arriving at the raw cadence, so every overflow doubles the stride of the older
 * regions and leaves the newest at stride 1. The result is geometric grading:
 * coarse at the start, fine at the end.
 *
 * Measured on live league episodes (2026-08-17, served `spectator.html`):
 *
 *   36,400-turn match: 25 snapshots, first at 400, second at 25,200 — a
 *                      24,800-turn hole, 68% of the match with no frame at all
 *   20,100-turn match: 30 snapshots, 8,000-turn hole (40%)
 *   17,000-turn match: 47 snapshots, 3,200-turn hole (19%)
 *
 * The hole grows with match length, and the scrub control presents the timeline
 * as uniform, so dragging one notch can silently jump most of the match.
 *
 * The fix keeps the same O(1) memory bound and the same cap, and adds one rule:
 * when the array halves, thin INCOMING snapshots by the same factor, so new
 * arrivals land on the same spacing as the retained ones. Spacing then stays
 * uniform across the whole match at every point in the episode.
 *
 * This only governs the retained ARTIFACT array. The live protocol stream is
 * untouched — every snapshot is still handed to the protocol server.
 */

/** Retention state for one episode. Create with `createSnapshotRetention`. */
export interface SnapshotRetention<T> {
  /** Snapshots kept for the artifact, oldest first, evenly spaced. */
  readonly retained: T[];
  /** Keep every `stride`-th offered snapshot; doubles on each halving. */
  stride: number;
  /** Count of snapshots offered so far, including skipped ones. */
  offered: number;
  /**
   * The most recent snapshot offered, on-stride or not. `finalize` guarantees it
   * ends up retained: `buildAgentSpectatorReplay` passes `snapshots` through
   * verbatim and reads `finalGameState` for map metadata ONLY, so a dropped last
   * frame means the artifact has no end-of-match state — no winner, no final
   * territory. That is the end-of-match surface, so it is reserved explicitly.
   */
  latest: T | undefined;
  readonly cap: number;
}

export function createSnapshotRetention<T>(cap: number): SnapshotRetention<T> {
  if (!Number.isInteger(cap) || cap < 2) {
    throw new Error(
      `createSnapshotRetention: cap must be an integer >= 2, got ${cap}`,
    );
  }
  return { retained: [], stride: 1, offered: 0, latest: undefined, cap };
}

/**
 * Offers one snapshot to the retained artifact set. Returns true when it was
 * kept. Always call this for every snapshot — the skipping is what keeps the
 * spacing even.
 */
export function offerSnapshot<T>(
  state: SnapshotRetention<T>,
  snapshot: T,
): boolean {
  const index = state.offered;
  state.offered += 1;
  state.latest = snapshot;
  // Thin at the current stride. Index 0 is always on-stride, so the opening
  // snapshot is never dropped.
  if (index % state.stride !== 0) {
    return false;
  }
  state.retained.push(snapshot);
  if (state.retained.length > state.cap) {
    // Halve in place, keeping indices 0,2,4,… — same as before, so the first
    // snapshot survives every halving.
    let write = 0;
    for (let read = 0; read < state.retained.length; read += 2) {
      state.retained[write] = state.retained[read];
      write += 1;
    }
    state.retained.length = write;
    // The retained set now sits at twice the spacing, so incoming snapshots
    // must be thinned to match. Without this line the tail refines while the
    // head stays coarse, which is the defect this module exists to fix.
    state.stride *= 2;
  }
  return true;
}

/**
 * Guarantees the terminal snapshot is retained, then returns the artifact array.
 * Call once after the episode's last snapshot and before building the replay.
 * Idempotent.
 *
 * An episode almost never ends on a stride boundary, so without this the last
 * kept frame can sit a full stride short of the end (measured: a 20,100-turn
 * episode ended at 19,400, losing its final 600 turns including the result).
 * When the extra frame would exceed the cap, the SECOND-TO-LAST frame is dropped
 * instead: the opening frame, the even spine and the terminal frame all survive,
 * at the cost of one slightly short gap at the very end.
 */
export function finalizeSnapshotRetention<T>(state: SnapshotRetention<T>): T[] {
  const latest = state.latest;
  if (latest === undefined) {
    return state.retained;
  }
  if (state.retained[state.retained.length - 1] === latest) {
    return state.retained;
  }
  if (state.retained.length >= state.cap) {
    state.retained.splice(state.retained.length - 1, 1);
  }
  state.retained.push(latest);
  return state.retained;
}
