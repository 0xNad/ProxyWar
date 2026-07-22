/**
 * Render-mode fast-forward for replay clip capture.
 *
 * PRODUCTION INCIDENT (2026-07-22): every premiere auto-clip render timed out.
 * The clip worker parks the replay page at `anchor - lead` via the jump event,
 * which force-queues every skipped turn — but the page then runs the FULL
 * per-turn presentation pipeline (GameView update + renderer tick + frame
 * dispatch + hash log) for each of the 17k-50k skipped turns. On World-scale
 * records the page main thread saturates for far longer than the 6-minute
 * render SIGKILL (measured: CDP evaluate stalls outright after ~700 applied
 * ticks), so end-anchor renders can never park in time.
 *
 * Fix: while fast-forwarding toward the park turn, updates are BUFFERED and
 * coalesced through the premiere catch-up coalescer (final tile/unit/player
 * states, ordered events) so the renderer pays one presentation pass per
 * `coalesceTurns` instead of one per turn. At the park boundary the buffer is
 * flushed and every later update — the captured clip window — flows through
 * the ordinary 1x pipeline, so the recorded video itself stays real-speed.
 *
 * SPOILER / PACING GATE: this is a pacing-only affordance and deliberately
 * cannot touch content access:
 *  - it activates ONLY for plain `gameRecord` replays (the render worker's
 *    loopback page and the public league replay viewer, whose full record is
 *    already public). Premiere pages (`progressiveReplay`) NEVER construct it,
 *    so the sealed 1x premiere experience and its release stream are
 *    untouched;
 *  - even on a plain replay page it only changes how fast already-loaded
 *    record turns render — exactly the power the existing jump-to-turn event
 *    already grants every viewer. No unreleased or non-public turn can be
 *    reached through it.
 */

import type { GameUpdateViewData } from "../core/game/GameUpdates";
import { coalesceReplayPremiereGameUpdates } from "./ReplayPremiereUpdateBatch";

/** Query parameter the clip worker appends to the replay page URL. */
export const REPLAY_RENDER_FAST_FORWARD_PARAM = "renderFastForwardUntilTurn";

/** Sanity ceiling; matches the clip service's anchor bound. */
export const REPLAY_RENDER_FAST_FORWARD_MAX_TURN = 1_000_000;

/**
 * Turns coalesced into one renderer pass while fast-forwarding. 240 turns
 * (24s of game time) keeps per-flush event batches small while cutting the
 * presentation-pipeline invocations by ~two orders of magnitude.
 */
export const REPLAY_RENDER_FAST_FORWARD_COALESCE_TURNS = 240;

/**
 * Parses the fast-forward target from a location search string. Fail-closed:
 * anything malformed, non-positive, or absurd is null (no fast-forward).
 */
export function parseReplayRenderFastForwardUntilTurn(
  search: string,
): number | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get(REPLAY_RENDER_FAST_FORWARD_PARAM);
  } catch {
    return null;
  }
  if (raw === null || !/^[1-9][0-9]{0,6}$/.test(raw)) return null;
  const turn = Number(raw);
  return turn <= REPLAY_RENDER_FAST_FORWARD_MAX_TURN ? turn : null;
}

export interface ReplayRenderFastForwardSink {
  /** Applies one coalesced update through the presentation pipeline. */
  applyCoalesced(update: GameUpdateViewData, completedTurns: number): void;
}

/**
 * Buffers per-turn updates below `untilTurn` and releases them as coalesced
 * presentation passes. Pure client-side sequencing: simulation state (the
 * core worker) is never touched, and update order is preserved.
 */
export class ReplayRenderFastForward {
  private buffer: GameUpdateViewData[] = [];

  constructor(
    private readonly untilTurn: number,
    private readonly sink: ReplayRenderFastForwardSink,
    private readonly coalesceTurns = REPLAY_RENDER_FAST_FORWARD_COALESCE_TURNS,
  ) {
    if (!Number.isSafeInteger(untilTurn) || untilTurn <= 0) {
      throw new Error("invalid fast-forward target turn");
    }
    if (!Number.isSafeInteger(coalesceTurns) || coalesceTurns <= 0) {
      throw new Error("invalid fast-forward coalesce size");
    }
  }

  /**
   * Offers an update to the fast-forward lane. Returns true when consumed
   * (buffered/coalesced); false when the update has reached the target — any
   * buffered prefix is flushed first so the caller can run its ordinary
   * pipeline for this and every later update.
   */
  offer(update: GameUpdateViewData): boolean {
    if (update.tick >= this.untilTurn) {
      this.flush();
      return false;
    }
    this.buffer.push(update);
    if (this.buffer.length >= this.coalesceTurns) this.flush();
    return true;
  }

  /** Applies any buffered turns as one coalesced presentation pass. */
  flush(): void {
    if (this.buffer.length === 0) return;
    const coalesced = coalesceReplayPremiereGameUpdates(this.buffer);
    this.buffer = [];
    this.sink.applyCoalesced(coalesced.update, coalesced.completedTurns);
  }

  bufferedTurns(): number {
    return this.buffer.length;
  }
}
