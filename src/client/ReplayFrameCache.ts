/**
 * ============================================================================
 * REPLAY FRAME CACHE — downscaled board frames, so scrubbing has pictures.
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ----------------
 * The engine cannot jump to an arbitrary turn. Forward seeking REPLAYS turns
 * (`LocalServer.jumpReplayForward`), backward seeking rebuilds the match from
 * turn 0 (`Main.ts`'s `rewindReplayInPlace`, ~0.6ms/turn — a few seconds of
 * real, already-optimised work). Both are correct and neither can be made
 * instant. What CAN be instant is what the viewer SEES while asking: sibling
 * products (PaintBot) show a frame under the pointer the whole time you drag,
 * and next to that our silent drag reads as broken — the owner's verbatim
 * complaint. So this module keeps a sparse, temporally-uniform cache of small
 * board frames, captured opportunistically as playback happens to pass turns,
 * and the scrubber / rewind curtain paint from it. The fix is PERCEPTUAL; the
 * engine is untouched.
 *
 * WHAT A FRAME COSTS (the budget arithmetic)
 * -------------------------------------------
 * Capture is: one `drawImage` of the board canvas into a ~1/3-linear scratch
 * canvas (capped at 480px wide — a 3200x1800 DPR-2 backing store lands at
 * 480x270), one async `toBlob("image/webp", 0.7)` encode (~15-40KB for a
 * territory map at this size; Safari cannot encode webp and silently hands
 * back PNG, ~40-120KB, which only changes the reporting number), and one
 * `createImageBitmap` decode. The pixel copy + encode kickoff is well under a
 * millisecond of main-thread time at 480px; the encode itself is off-thread.
 *
 * The number that actually pins memory is NOT the encoded blob — it is the
 * decoded ImageBitmap we keep: width x height x 4 bytes (~518KB at 480x270).
 * The hard byte budget below is therefore accounted in DECODED raster bytes,
 * because that is the memory that exists; the encoded size is kept per frame
 * purely so coverage reporting can state the honest "equivalent" cost. At
 * 480x270 the 50MB raster budget binds first (~96 frames); on a small canvas
 * the 200-frame count cap binds first. Either way eviction below keeps the
 * SPREAD, not the newest frames.
 *
 * CAPTURE CADENCE AND THE CATCH-UP TRADE-OFF
 * -------------------------------------------
 * A capture is considered every time playback crosses the next multiple of
 * CAPTURE_EVERY_TURNS (100 turns = 10s of match time at the ten-ticks-a-second
 * clock contract). The actual pixel copy is deferred to a
 * `requestAnimationFrame` AFTER the `ai-league-replay-frame` event: the event
 * fires from the runner's tick, while the renderer paints in its own rAF loop
 * that was scheduled in the PREVIOUS frame — so within the next animation
 * frame the renderer's callback runs first (registered earlier) and ours runs
 * after it, reading a canvas that has genuinely been painted with the newest
 * tick. Capturing synchronously in the event would read whatever the canvas
 * held BEFORE this tick rendered.
 *
 * A forward catch-up (seek, or the post-rewind resimulation) races through
 * turns far faster than 1x, crossing many 100-turn boundaries per second.
 * That is exactly when dense coverage is cheapest to acquire — but also when
 * per-frame cost would multiply, so a wall-clock throttle allows at most one
 * capture per MIN_CAPTURE_INTERVAL_MS (250ms). The trade-off, deliberately:
 * during a fast catch-up some crossed boundaries are skipped (at ~4 captures/s
 * a catch-up running 1,000 turns/s yields one frame per ~250 turns instead of
 * per 100), and ordinary 1x playback — which crosses a boundary every 10s —
 * is never throttled at all. First full watch of a 14,200-turn match at
 * mixed speeds therefore lands on the order of 60-142 frames: full-timeline
 * coverage at 10-25s granularity, which is exactly scrubbing granularity.
 *
 * WHY THE CACHE SURVIVES AN IN-PLACE REWIND (module scope, keyed by turn)
 * ------------------------------------------------------------------------
 * A rewind replays the SAME deterministic match, so a frame captured at turn
 * 4,700 on the first pass is pixel-for-pixel the truth about turn 4,700
 * forever. State here is module-level precisely so `rewindReplayInPlace`'s
 * teardown/rebuild of the game (which destroys every renderer and layer)
 * cannot destroy the frames. When playback restarts below where it was, the
 * boundary tracker re-arms, and recrossed boundaries that are ALREADY covered
 * are skipped instead of re-encoded — the resimulation only fills real gaps.
 *
 * EVICTION: WIDEST-GAP THINNING, NEVER FIFO
 * ------------------------------------------
 * FIFO would hollow out the start of the match — the exact region a viewer
 * rewinds to. Over budget, the frame removed is the INTERIOR frame whose
 * removal creates the SMALLEST resulting gap between its neighbours (i.e. the
 * most redundant frame in the densest cluster); the first and last frames are
 * never evicted. Repeated, this converges on uniform temporal coverage of
 * everything ever watched, which is the property a scrubber preview needs.
 */

import { isAiLeagueReplayRoute } from "./AiLeagueReplayMode";

export interface ReplayCachedFrame {
  /** The engine turn the pixels show (the newest turn the runner had reported when the canvas was copied). */
  turn: number;
  bitmap: ImageBitmap;
}

interface StoredFrame extends ReplayCachedFrame {
  /** Decoded raster bytes (w*h*4) — the memory this frame actually pins; the eviction budget's unit. */
  rasterBytes: number;
  /** Encoded blob bytes — the "equivalent" transfer/storage cost, kept for honest coverage reporting. */
  encodedBytes: number;
}

/** Capture cadence in turns: 100 turns = 10s of match time at the ten-ticks-a-second clock contract. */
const CAPTURE_EVERY_TURNS = 100;
/** Wall-clock throttle — see the catch-up trade-off in the header doc. */
const MIN_CAPTURE_INTERVAL_MS = 250;
/** Downscale target: ~1/3 linear of the DPR-sized backing store, never wider than this. */
const MAX_FRAME_WIDTH = 480;
const WEBP_QUALITY = 0.7;
/** Count cap — binds first on small canvases. */
const MAX_FRAMES = 200;
/** Hard byte cap on DECODED raster memory — binds first at 480px-wide frames (~96 of them). */
const MAX_RASTER_BYTES = 50 * 1024 * 1024;

/** Sorted ascending by turn — nearestFrameAtOrBefore is a binary search. */
let frames: StoredFrame[] = [];
let totalRasterBytes = 0;

let installed = false;
let lastSeenTurn = -1;
/** Highest crossed multiple-of-CAPTURE_EVERY_TURNS; re-armed downward when a rewind restarts playback. */
let lastBoundaryCrossed = -1;
let lastCaptureStartedMs = -Infinity;
let capturePending = false;
/** One reusable scratch canvas — toBlob snapshots the bitmap at call time, so reuse across async encodes is safe. */
let scratchCanvas: HTMLCanvasElement | null = null;

/**
 * The cached frame showing the latest moment at or before `turn`, or null
 * when nothing that early has ever been captured (a drag to before the first
 * frame must show "no frame yet", never a later frame lying about the past).
 */
export function nearestFrameAtOrBefore(turn: number): ReplayCachedFrame | null {
  let lo = 0;
  let hi = frames.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].turn <= turn) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best >= 0 ? frames[best] : null;
}

/**
 * Coverage summary for diagnostics and callers deciding whether a preview is
 * worth raising at all. `encodedBytes` is the webp-equivalent cost; the real
 * pinned memory is `rasterBytes` (see the header doc's budget arithmetic).
 */
export function frameCoverage(): {
  count: number;
  minTurn: number | null;
  maxTurn: number | null;
  rasterBytes: number;
  encodedBytes: number;
} {
  let encoded = 0;
  for (const f of frames) encoded += f.encodedBytes;
  return {
    count: frames.length,
    minTurn: frames.length > 0 ? frames[0].turn : null,
    maxTurn: frames.length > 0 ? frames[frames.length - 1].turn : null,
    rasterBytes: totalRasterBytes,
    encodedBytes: encoded,
  };
}

/**
 * Arms the document-level capture listener. Idempotent — `openAiLeagueReplay`
 * re-runs on every in-place rewind and must not stack listeners — and gated
 * on the replay routes: live play must never pay for frame captures.
 */
export function installReplayFrameCapture(): void {
  if (installed) return;
  if (!isAiLeagueReplayRoute()) return;
  installed = true;
  document.addEventListener("ai-league-replay-frame", onReplayFrame);
}

/**
 * Full teardown, for completeness/tests: the product intentionally never
 * calls this mid-session — the frames outliving a rewind is the entire point.
 * `ImageBitmap.close()` releases the decoded rasters eagerly rather than
 * waiting on GC.
 */
export function disposeReplayFrameCache(): void {
  if (installed) {
    document.removeEventListener("ai-league-replay-frame", onReplayFrame);
    installed = false;
  }
  for (const f of frames) f.bitmap.close();
  frames = [];
  totalRasterBytes = 0;
  lastSeenTurn = -1;
  lastBoundaryCrossed = -1;
  lastCaptureStartedMs = -Infinity;
  capturePending = false;
  scratchCanvas = null;
}

function onReplayFrame(event: Event): void {
  const turnNumber = (event as CustomEvent<{ turnNumber?: unknown }>).detail
    ?.turnNumber;
  if (typeof turnNumber !== "number" || !Number.isSafeInteger(turnNumber)) {
    return;
  }
  const boundary = Math.floor(turnNumber / CAPTURE_EVERY_TURNS);
  if (turnNumber < lastSeenTurn) {
    // Playback moved BACKWARD: an in-place rewind restarted the match below
    // us. Re-arm the boundary tracker at the current position so recrossed
    // multiples become eligible again; the already-covered check below keeps
    // the resimulation from re-encoding turns the first pass already holds.
    lastBoundaryCrossed = boundary;
    lastSeenTurn = turnNumber;
    return;
  }
  lastSeenTurn = turnNumber;
  if (boundary <= lastBoundaryCrossed) return;
  lastBoundaryCrossed = boundary;

  // Deterministic replay: a boundary whose neighbourhood is already covered
  // (a frame within one cadence at or before us) has nothing new to say.
  const existing = nearestFrameAtOrBefore(turnNumber);
  if (existing !== null && turnNumber - existing.turn < CAPTURE_EVERY_TURNS) {
    return;
  }

  const now = performance.now();
  if (capturePending || now - lastCaptureStartedMs < MIN_CAPTURE_INTERVAL_MS) {
    // The wall-clock throttle. During a catch-up this deliberately skips some
    // crossed boundaries — see the header doc's trade-off note.
    return;
  }
  lastCaptureStartedMs = now;
  capturePending = true;
  // rAF, not synchronous: the renderer's own rAF (scheduled last frame) runs
  // before this one, so by the time this fires the canvas holds the newest
  // painted tick. See the header doc's cadence section.
  requestAnimationFrame(runCapture);
}

// A BACKGROUNDED TAB NEVER FIRES rAF. The flag above is cleared inside
// runCapture, so a capture scheduled just as the viewer switched tabs left
// `capturePending` latched true forever — and every later capture bailed on
// it, silently killing the rewind preview cache for the rest of the session
// with nothing visible to explain why. Clearing on the way back is safe: the
// pending frame is stale by definition once the tab has been away, and the
// next crossed boundary schedules a fresh one.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      capturePending = false;
    }
  });
}

function runCapture(): void {
  capturePending = false;
  // Label the pixels with the NEWEST turn the runner has reported, not the
  // turn that scheduled this capture: a catch-up can tick several turns
  // between the event and this rAF, and the canvas shows the latest one.
  const turn = lastSeenTurn;
  if (turn < 0) return;
  // The board canvas is the ONE canvas mounted as a DIRECT child of body
  // (GameRenderer.initialize's appendChild — verified every other canvas in
  // the client, RewindCurtain's and the scrubber drag preview's, lives
  // nested inside its own overlay div).
  // "body > canvas" matters here, not just "canvas": during a post-rewind
  // resimulation the curtain root precedes the rebuilt board canvas in
  // document order, so a bare querySelector("canvas") would capture the
  // curtain's FROZEN frame and file it under live resim turns — silent cache
  // poisoning. The backing store is DPR-sized. Only board layers draw on it:
  // the HUD (scrubber, dossier, toasts) is DOM, so a whole-canvas copy IS
  // the board.
  const src = document.querySelector("body > canvas");
  if (!(src instanceof HTMLCanvasElement) || src.width < 2 || src.height < 2) {
    return;
  }
  const targetW = Math.min(
    MAX_FRAME_WIDTH,
    Math.max(1, Math.round(src.width / 3)),
  );
  const targetH = Math.max(1, Math.round(src.height * (targetW / src.width)));
  scratchCanvas ??= document.createElement("canvas");
  const scratch = scratchCanvas;
  scratch.width = targetW;
  scratch.height = targetH;
  const ctx = scratch.getContext("2d");
  if (ctx === null) return;
  ctx.drawImage(src, 0, 0, targetW, targetH);
  scratch.toBlob(
    (blob) => {
      if (blob === null) return; // encoder refused (tainted/zero canvas) — skip, never throw
      void storeEncodedFrame(turn, blob);
    },
    "image/webp",
    WEBP_QUALITY,
  );
}

async function storeEncodedFrame(turn: number, blob: Blob): Promise<void> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return; // decode failure — a missing frame is a shrug, never a crash
  }
  insertFrame({
    turn,
    bitmap,
    rasterBytes: bitmap.width * bitmap.height * 4,
    encodedBytes: blob.size,
  });
  evictToBudget();
}

/** Sorted insert; an exact-turn duplicate (rewind race) replaces in place. */
function insertFrame(frame: StoredFrame): void {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].turn < frame.turn) lo = mid + 1;
    else hi = mid;
  }
  if (lo < frames.length && frames[lo].turn === frame.turn) {
    totalRasterBytes -= frames[lo].rasterBytes;
    frames[lo].bitmap.close();
    frames[lo] = frame;
  } else {
    frames.splice(lo, 0, frame);
  }
  totalRasterBytes += frame.rasterBytes;
}

/**
 * Widest-gap thinning (see header doc): while over either budget, remove the
 * interior frame whose removal leaves the smallest gap — the most redundant
 * frame — keeping the endpoints so coverage never retreats from either edge.
 */
function evictToBudget(): void {
  while (
    (frames.length > MAX_FRAMES || totalRasterBytes > MAX_RASTER_BYTES) &&
    frames.length > 2
  ) {
    let evictIndex = 1;
    let smallestResultingGap = Infinity;
    for (let i = 1; i < frames.length - 1; i++) {
      const resultingGap = frames[i + 1].turn - frames[i - 1].turn;
      if (resultingGap < smallestResultingGap) {
        smallestResultingGap = resultingGap;
        evictIndex = i;
      }
    }
    const [removed] = frames.splice(evictIndex, 1);
    totalRasterBytes -= removed.rasterBytes;
    removed.bitmap.close();
  }
}
