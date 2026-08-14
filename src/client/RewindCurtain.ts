/**
 * ============================================================================
 * REWIND CURTAIN — the in-place-rewind loading treatment ("dimmed hold").
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ----------------
 * `Main.ts`'s `rewindReplayInPlace` used to raise the same cold-boot cover a
 * fresh page load uses (`ReplayLoadingScreen.ts`'s spinner-and-message veil).
 * An audit called that accidental-looking: a rewind is not a boot, it is a
 * viewer already mid-broadcast asking to see an earlier moment again, and the
 * spinner reads as "the app just crashed and restarted." The alternative the
 * product owner rejected outright was leaving the OLD map running and racing
 * it through the resimulation — that is a re-simulation from turn 0 rendering
 * at whatever multiplier the engine can manage, and it looks like the game
 * glitching, not like a deliberate seek.
 *
 * The chosen treatment, verbatim: "Dimmed hold — keep the last frame, dim
 * it, overlay REWINDING TO 13:50 with a real progress bar (turn N of M).
 * Never the boot screen, never the racing map." This module is that overlay.
 * It owns no simulation state and drives nothing; `Main.ts` calls
 * `raiseRewindCurtain` once with the frozen frame and the seek target, then
 * feeds it turn numbers as the resimulation's `ai-league-replay-frame`
 * events arrive, and calls `drop()` once the target turn is reached (or the
 * rewind fails outright).
 *
 * THE FROZEN FRAME, NOT A SCREENSHOT LIBRARY
 * -------------------------------------------
 * The board canvas is captured by reference and blitted into this module's
 * OWN canvas with a single `drawImage` the instant the curtain is built.
 * That has to happen before the caller stops the outgoing game: once the
 * renderer is torn down its canvas's backing store is zeroed (a fresh
 * `width`/`height` reset, which browsers use as the idiomatic
 * "clear the bitmap" — see `Main.ts`'s own capture-before-stop ordering),
 * so a reference held onto but drawn from AFTER teardown paints a blank
 * rectangle instead of the last frame. This module never re-reads the
 * source canvas after that first blit; it owns a plain raster copy from
 * that point on, which is also why the source can be torn down a moment
 * later without this overlay flickering.
 *
 * The source canvas is intrinsically device-pixel sized (`.width`/`.height`
 * are the backing-store dimensions, not the CSS box); this curtain's own
 * canvas is sized the same way against the CURRENT viewport, and the one
 * `drawImage` call stretches the full source rect into the full
 * destination rect. A rewind's frozen frame is on screen for a couple of
 * seconds behind a dim wash and a text plate, not held up for pixel-perfect
 * inspection, so a stretch across whatever DPR/viewport mismatch exists
 * between capture and display is not worth a second code path.
 *
 * TRAP: NO BACKTICK MAY EVER APPEAR IN THE CSS BLOCK BELOW
 * -----------------------------------------------------------
 * The stylesheet text is authored as a single JS template literal. A
 * backtick anywhere inside it -- including inside a CSS comment -- closes
 * the string early and breaks the build with a syntax error some distance
 * away, which is a miserable thing to bisect. If you need to reference a
 * code identifier from inside that block's own comments, use single or
 * double quotes, never backticks.
 */

/** Nothing to freeze onto for a fresh page load or a failed rewind: never shown without a raise. */
let activeCurtainRemove: (() => void) | null = null;

export interface RewindCurtainOptions {
  /** The turn the rewind is seeking to -- the "TO mm:ss" clock and the progress bar's denominator. */
  targetTurn: number;
  /**
   * The whole match's turn count (`document.body.dataset.pwReplayTotalTurns`
   * at the caller). Distinct from `targetTurn`: the progress bar tracks how
   * far the resimulation has gotten toward the seek target, while the "TURN
   * N OF M" caption below it grounds that in the full match so a rewind to
   * turn 40 of a 4,000-turn match doesn't read as "nearly done."
   */
  totalTurns: number;
  /**
   * The live board canvas, captured by the caller BEFORE tearing down the
   * outgoing game (see this file's header doc). `null` -- or a canvas with
   * no pixels yet, which happens if a rewind is fired before the very first
   * frame of a freshly-opened replay has rendered -- falls back to the warm
   * stage colour. Never the boot screen on this path, so there is no
   * secondary fallback beyond the flat fill.
   */
  lastFrame: HTMLCanvasElement | null;
  /**
   * OPTIONAL, ADDITIVE (2026-08-13): the DESTINATION of the seek — the
   * ReplayFrameCache's nearest cached frame at or before `targetTurn`, when
   * one exists. A rewind holds this curtain up for the ~3s the resimulation
   * takes, and freezing the OUTGOING frame shows the viewer where they came
   * FROM the whole time; painting the destination instead makes the same
   * three seconds read as ARRIVING somewhere. `turn` is the frame's own
   * engine turn (it can trail `targetTurn` by up to the cache's capture
   * cadence), shown on a corner tag so the image is honestly labelled.
   * Absent/undefined keeps the original behaviour exactly — every existing
   * caller compiles and behaves unchanged.
   */
  destination?: { bitmap: ImageBitmap; turn: number } | null;
}

export interface RewindCurtainHandle {
  /** Feed the resimulation's current turn as it advances. Safe to call after `drop()`; becomes a no-op. */
  updateProgress(turn: number): void;
  /** Fades the curtain out over ~240ms and removes it. Idempotent -- a second call is a no-op. */
  drop(): void;
}

/** How long a stalled resimulation is allowed to sit under the curtain before it self-clears rather than staying up forever. */
const SAFETY_TIMEOUT_MS = 90_000;

/** Matches the CSS transition duration on `.pw-rewind-curtain--out` below -- the node is removed once the fade has actually finished, not before. */
const FADE_OUT_MS = 240;

/** The warm stage colour used when there is no frame to freeze onto (see `RewindCurtainOptions.lastFrame`). Matches the stage's own resting background, not a generic black, so the fallback never reads as an error state. */
const WARM_STAGE_FALLBACK = "#14110f";

/**
 * Raises the dimmed-hold curtain: freezes the outgoing frame (or the warm
 * fallback fill), dims it, and shows the "REWINDING TO mm:ss" plate with a
 * progress bar that starts at turn 0. Returns a handle the caller drives
 * with turn updates until the seek lands.
 *
 * IDEMPOTENT BY DESIGN: raising a second curtain while one is already up
 * (a double-fired rewind, or a defensive re-raise) tears the stale one down
 * immediately -- no fade, since a fade on top of a fade would just read as a
 * flicker, and the stale one was never actually seen finishing on its own.
 */
export function raiseRewindCurtain(
  opts: RewindCurtainOptions,
): RewindCurtainHandle {
  activeCurtainRemove?.();
  ensureRewindCurtainStyles();

  const root = document.createElement("div");
  root.className = "pw-rewind-curtain";
  // Decorative over a board that is not moving, but the headline text is
  // real status ("rewinding to mm:ss") -- announced the same way the boot
  // veil announces its own messages, so a screen-reader user mid-rewind
  // gets the same information a sighted viewer reads off the plate.
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");

  const canvas = document.createElement("canvas");
  canvas.className = "pw-rewind-canvas";
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
  canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
  // Destination-first: when the frame cache holds a picture of (near) where
  // this seek is GOING, the curtain shows that — arriving, not leaving. The
  // outgoing frame stays the fallback so a cold cache behaves exactly as
  // before. Both sources go through the same blit path: an ImageBitmap and a
  // canvas are both CanvasImageSource with .width/.height, and the same
  // full-rect stretch trade (header doc) applies — the destination still is
  // ~1/3-res, and it sits behind a 0.62 wash for a couple of seconds.
  const destination = opts.destination ?? null;
  paintFrozenFrame(canvas, destination?.bitmap ?? opts.lastFrame);

  const wash = document.createElement("div");
  wash.className = "pw-rewind-wash";

  const plate = document.createElement("div");
  plate.className = "pw-rewind-plate";

  const eyebrow = document.createElement("div");
  eyebrow.className = "pw-rewind-eyebrow";
  eyebrow.textContent = "REWINDING";

  const clock = document.createElement("div");
  clock.className = "pw-rewind-clock";
  clock.textContent = `TO ${formatClock(opts.targetTurn)}`;

  const track = document.createElement("div");
  track.className = "pw-rewind-track";
  const fill = document.createElement("div");
  fill.className = "pw-rewind-fill";
  track.appendChild(fill);

  const caption = document.createElement("div");
  caption.className = "pw-rewind-caption";

  plate.append(eyebrow, clock, track, caption);
  root.append(canvas, wash, plate);
  // The destination image gets its own honest label: the frame's OWN clock,
  // which can trail the "TO mm:ss" target above by up to a capture cadence.
  // Only when a destination frame is actually painted — the outgoing-frame
  // fallback needs no tag, it is the same picture the viewer just left.
  if (destination !== null) {
    const destTag = document.createElement("div");
    destTag.className = "pw-rewind-desttag";
    destTag.textContent = `DESTINATION — ${formatClock(destination.turn)}`;
    root.appendChild(destTag);
  }
  document.body.appendChild(root);

  const targetTurn = opts.targetTurn > 0 ? opts.targetTurn : 1;
  const totalTurns = opts.totalTurns > 0 ? opts.totalTurns : targetTurn;

  const applyProgress = (turn: number) => {
    const clampedTurn = Math.min(Math.max(0, Math.round(turn)), totalTurns);
    const fraction = Math.min(1, Math.max(0, clampedTurn / targetTurn));
    fill.style.width = `${(fraction * 100).toFixed(2)}%`;
    caption.textContent = `TURN ${clampedTurn} OF ${totalTurns} — RESIMULATING`;
  };
  applyProgress(0);

  let removed = false;
  let droppedOnce = false;
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;

  const removeNow = () => {
    if (removed) return;
    removed = true;
    if (safetyTimer !== null) clearTimeout(safetyTimer);
    root.remove();
    if (activeCurtainRemove === removeNow) activeCurtainRemove = null;
  };
  activeCurtainRemove = removeNow;

  const drop = () => {
    if (droppedOnce) return;
    droppedOnce = true;
    if (safetyTimer !== null) clearTimeout(safetyTimer);
    root.classList.add("pw-rewind-curtain--out");
    setTimeout(removeNow, FADE_OUT_MS);
  };

  // If the caller never calls drop() -- a resimulation that stalls, or a
  // frame-listener wiring bug -- this is the one thing standing between a
  // failed rewind and a dimmed board staring at the viewer indefinitely.
  safetyTimer = setTimeout(drop, SAFETY_TIMEOUT_MS);

  return {
    updateProgress(turn: number) {
      if (removed || droppedOnce) return;
      applyProgress(turn);
    },
    drop,
  };
}

/**
 * Blits the outgoing board into the curtain's own canvas, or fills the warm
 * stage colour when there is nothing to freeze onto. One `drawImage` call,
 * full source rect to full destination rect -- see this file's header doc
 * for why a stretch across any DPR/viewport mismatch is an acceptable
 * trade here.
 */
function paintFrozenFrame(
  canvas: HTMLCanvasElement,
  lastFrame: HTMLCanvasElement | ImageBitmap | null,
): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const hasFrame =
    lastFrame !== null && lastFrame.width > 0 && lastFrame.height > 0;
  if (!hasFrame) {
    ctx.fillStyle = WARM_STAGE_FALLBACK;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  ctx.drawImage(
    lastFrame,
    0,
    0,
    lastFrame.width,
    lastFrame.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

/**
 * "TO mm:ss" from an engine turn count. Ten engine ticks a second, matching
 * the match-clock convention the broadcast transport already uses elsewhere
 * on this stage (`BroadcastScrubber.ts`'s own `formatClock`) -- this module
 * cannot import that one (see the strict file boundary this was built
 * under), so it is a small, deliberate duplicate rather than a shared util
 * pulled in for one function.
 */
function formatClock(turn: number): string {
  const seconds = Math.max(0, Math.round(turn / 10));
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(
    remainderSeconds,
  ).padStart(2, "0")}`;
}

let stylesMounted = false;

function ensureRewindCurtainStyles(): void {
  if (stylesMounted) return;
  stylesMounted = true;
  const style = document.createElement("style");
  style.id = "pw-rewind-curtain-styles";
  style.textContent = `
    .pw-rewind-curtain {
      position: fixed;
      inset: 0;
      z-index: 50045;
      pointer-events: none;
      opacity: 1;
      transition: opacity 240ms ease;
    }
    .pw-rewind-curtain--out {
      opacity: 0;
    }

    /* The frozen board. Sized to the CSS box, not its own backing-store
       pixels -- the backing store is set once in device pixels at raise
       time and never touched again, only ever stretched to fill here. */
    .pw-rewind-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }

    /* The dim wash over the frozen board. 0.62 alpha reads clearly as
       "paused, not live" without losing the board underneath entirely --
       a viewer should still recognise the shape of the map they left. */
    .pw-rewind-wash {
      position: absolute;
      inset: 0;
      background: rgba(20, 17, 15, 0.62);
    }

    /* Deliberately no forced nowrap here: this stage runs down to narrow
       embed widths (see recent HUD-budget work on the same board), and the
       caption line ("TURN 1234 OF 12345 -- RESIMULATING") can genuinely
       outgrow a 260px plate on a long match. Wrapping is the graceful
       outcome; a forced single line running off the viewport edge is not. */
    .pw-rewind-plate {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      text-align: center;
      max-width: min(92vw, 340px);
    }

    /* Amber is this stage's only chrome accent (see FollowedCompetitor's
       and the dossier's own eyebrows) -- kept identical here so the
       curtain reads as part of the same broadcast, not a separate system. */
    .pw-rewind-eyebrow {
      font: 600 10px/1 var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif);
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--pw-accent, #ffc24a);
    }

    .pw-rewind-clock {
      font-family: var(--pw-num, ui-monospace, "SF Mono", Menlo, monospace);
      font-size: 28px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--pw-ink, #f2ece2);
    }

    /* A hairline, not a trough -- matching the broadcast scrubber's own
       progress rail so the vocabulary is consistent across this stage's
       two "how far along" indicators. */
    .pw-rewind-track {
      position: relative;
      width: 260px;
      height: 2px;
      background: rgba(242, 236, 226, 0.16);
    }
    .pw-rewind-fill {
      position: absolute;
      left: 0;
      top: 0;
      height: 100%;
      width: 0%;
      background: var(--pw-accent, #ffc24a);
      transition: width 120ms linear;
    }

    .pw-rewind-caption {
      font-family: var(--pw-num, ui-monospace, "SF Mono", Menlo, monospace);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.04em;
      color: var(--pw-ink-faint, #6f675d);
    }

    /* Destination-frame label (only present when the frame cache supplied
     * the seek target's picture): the scrubber drag preview's exact chip
     * recipe -- same glass, same hairline, same amber mono -- so "held
     * moment with a clock on it" is one vocabulary across both surfaces. */
    .pw-rewind-desttag {
      position: absolute;
      left: 10px;
      top: 10px;
      padding: 5px 9px;
      background: var(--pw-glass-strong, rgba(24, 20, 17, 0.93));
      border: 1px solid var(--pw-hairline, rgba(242, 236, 226, 0.11));
      font: 600 10px/1 var(--pw-num, ui-monospace, "SF Mono", Menlo, monospace);
      letter-spacing: 0.08em;
      font-variant-numeric: tabular-nums;
      color: var(--pw-accent, #ffc24a);
    }
  `;
  document.head.appendChild(style);
}
