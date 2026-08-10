import { EventBus, GameEvent } from "../../core/EventBus";
import { Cell } from "../../core/game/Game";
import { GameView, PlayerView, UnitView } from "../../core/game/GameView";
import { isAiLeagueReplayRoute } from "../AiLeagueReplayMode";
import { CenterCameraEvent, DragEvent, ZoomEvent } from "../InputHandler";

/**
 * Replay / spectator surfaces (the `/ai-league-replay/...`, `/proxywar-replay/...`,
 * legacy `/openfront-replay/...`, and Coworld `/client/{global,replay,player}` routes)
 * have no local human player, so the spectator should see the whole territorial board
 * rather than being slammed into a single player at high zoom. `index.html` sets
 * `window.__PROXYWAR_AI_REPLAY__` for exactly these routes before the bundle runs;
 * `isAiLeagueReplayRoute()` is the matching pathname check. Either signal alone is
 * sufficient (they are redundant by design — both derive from the same replay routes);
 * normal live play sets NEITHER, so live play is byte-for-byte unchanged.
 */
export function isReplaySpectatorView(): boolean {
  const replayWindow = window as typeof window & {
    __PROXYWAR_AI_REPLAY__?: boolean;
  };
  return replayWindow.__PROXYWAR_AI_REPLAY__ === true || isAiLeagueReplayRoute();
}

export class GoToPlayerEvent implements GameEvent {
  constructor(
    public player: PlayerView,
    public zoom?: number,
  ) {}
}

export class GoToPositionEvent implements GameEvent {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

/**
 * Explicit "show the whole map" request — the one-gesture way back to a full
 * board view from the portrait/landscape spectator overzoom default (see
 * SPECTATOR_OVERZOOM_TARGET_FILL) or from any deliberate zoom-in. Currently
 * dispatched automatically by `WinModal` at match end. Handled by forcing
 * centerAll()'s literal whole-map "contain" landing regardless of viewport
 * aspect.
 */
export class FitWholeMapEvent implements GameEvent {
  constructor() {}
}

export class GoToUnitEvent implements GameEvent {
  constructor(public unit: UnitView) {}
}

export const GOTO_INTERVAL_MS = 16;
export const CAMERA_MAX_SPEED = 15;
export const CAMERA_SMOOTHING = 0.03;
// How far below the exact "whole map visible" (contain) scale a spectator's
// deliberate zoom-out is allowed to land: <1 leaves a small margin around
// the board instead of stopping exactly at its edge.
const SPECTATOR_ZOOM_OUT_MARGIN = 0.85;
// Portrait OR landscape spectator viewports far from square (phone/tablet
// either orientation) land outside the `cover` aspect-ratio band in
// computeSpectatorFitScale(): e.g. a portrait viewport's aspect (~0.4-0.6)
// or a landscape phone's (~2.0-2.2) is far from virtually every OpenFront
// map's aspect (roughly square to 2:1 landscape), so plain "contain" there
// fits the map to the viewport's narrower dimension and wastes the rest of
// the longer dimension as letterbox bands (P2-F10 portrait; the landscape
// counterpart found live 2026-08-02 on an 844x390 viewport — the map
// landed in barely half the available width). SPECTATOR_OVERZOOM_TARGET_FILL
// is the fraction of the viewport's LIMITING dimension (height in
// portrait, width in landscape) the map should occupy instead: enough to
// read as "filling the screen", short of a true `cover` landing (which
// would crop most maps down to a narrow sliver and lose spectator
// context). See computeSpectatorFitScale() for the full derivation.
const SPECTATOR_OVERZOOM_TARGET_FILL = 0.75;

export interface SpectatorFitInput {
  readonly vpWidth: number;
  readonly vpHeight: number;
  readonly mapWidth: number;
  readonly mapHeight: number;
  /** Extra margin factor applied on top of the landing scale (e.g. 0.95 leaves a touch of breathing room; `Math.max(fit, 1)` for `cover` so this never shrinks a crop-to-fill landing back into letterboxing). */
  readonly fit: number;
  /** `!options.forceWholeMap && isReplaySpectatorView()` at the call site — `false` collapses straight to whole-map "contain", matching live play and `FitWholeMapEvent`. */
  readonly spectator: boolean;
  /** Embedded replay frames prioritize full-board context over filling every pixel; standalone replay pages keep the richer crop-to-fill framing. */
  readonly embedded: boolean;
}

export interface SpectatorFitResult {
  readonly scale: number;
  readonly fillScale: number;
  readonly zoomFloor: number;
}

/**
 * Pure landing-scale computation for `centerAll()`, split out (same
 * pure-computation/thin-caller split as `StatTimeSeriesChart.ts`'s
 * `computeChartGeometry`) so this orientation-branching logic is
 * unit-testable without constructing a `TransformHandler` (which needs a
 * real `GameView`/`HTMLCanvasElement`).
 *
 * Three landing shapes, checked in order:
 * 1. `cover` — standalone spectator AND the viewport/map aspect ratios are close
 *    enough (`aspectRatioDeviation` in `(0.5, 2)`) that filling the frame
 *    with zero letterboxing only crops a plausible amount off the far
 *    edges.
 * 2. Portrait/landscape overzoom — standalone spectator AND `cover` was rejected AND
 *    the viewport is meaningfully non-square in EITHER orientation: land
 *    at whichever scale renders the map at `SPECTATOR_OVERZOOM_TARGET_FILL`
 *    of the viewport's limiting dimension (height in portrait, width in
 *    landscape) — `rawScVer * FILL` (or `rawScHor * FILL`) always yields
 *    exactly that fraction, independent of the map's own aspect ratio.
 *    Clamped so this never zooms in LESS than a whole-map contain fit
 *    (rare near-square maps already exceed the target) or MORE than a
 *    true cover fit (never crop tighter than cover would).
 * 3. Plain "contain" — live play, `forceWholeMap`, an embedded replay, or
 *    a spectator viewport close enough to square that neither overzoom
 *    branch is needed.
 */
export function computeSpectatorFitScale(
  input: SpectatorFitInput,
): SpectatorFitResult {
  const { vpWidth, vpHeight, mapWidth, mapHeight, fit, spectator, embedded } =
    input;
  const fillFrame = spectator && !embedded;
  const aspectRatioDeviation = vpWidth / vpHeight / (mapWidth / mapHeight);
  const cover =
    fillFrame && aspectRatioDeviation > 0.5 && aspectRatioDeviation < 2;

  const rawScHor = vpWidth / mapWidth;
  const rawScVer = vpHeight / mapHeight;
  const containScale = Math.min(rawScHor, rawScVer);
  const coverScale = Math.max(rawScHor, rawScVer);

  let scale: number;
  if (cover) {
    scale = coverScale * Math.max(fit, 1);
  } else if (fillFrame && vpHeight > vpWidth) {
    const portraitTarget = rawScVer * SPECTATOR_OVERZOOM_TARGET_FILL;
    scale = Math.min(
      Math.max(containScale * fit, portraitTarget),
      coverScale,
    );
  } else if (fillFrame && vpWidth > vpHeight) {
    // P2 fix (found live 2026-08-02): a landscape phone viewport (e.g.
    // 844x390, aspect ~2.16) against a map NOT wide enough to fall inside
    // the `cover` band (e.g. a roughly square map, aspect ~1.0 ->
    // deviation ~2.16, just outside the 2.0 cutoff) fell all the way
    // through to plain "contain" below — no orientation-aware handling
    // existed for landscape at all, only portrait. "Contain" there fits
    // to the viewport's HEIGHT (the binding constraint) and wastes most
    // of its WIDTH as side letterbox bands — confirmed live at roughly
    // half the available width wasted. Symmetric fix to the portrait
    // branch above: overzoom to fill SPECTATOR_OVERZOOM_TARGET_FILL of
    // the viewport's WIDTH instead.
    const landscapeTarget = rawScHor * SPECTATOR_OVERZOOM_TARGET_FILL;
    scale = Math.min(
      Math.max(containScale * fit, landscapeTarget),
      coverScale,
    );
  } else {
    scale = containScale * fit;
  }

  return {
    scale,
    fillScale: coverScale,
    zoomFloor: containScale * SPECTATOR_ZOOM_OUT_MARGIN,
  };
}

export interface CenterOnCellInput {
  targetX: number;
  targetY: number;
  scale: number;
  gameWidth: number;
  gameHeight: number;
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * Pure destination-offset math for a spectator/replay ONE-SHOT camera
 * locate (see `TransformHandler.onGoToPlayer`'s spectator branch): the
 * offset that puts `(targetX, targetY)` under the exact geometric center of
 * the canvas at the CURRENT scale — no scale change, no iteration, no
 * possibility of stalling. Same derivation as `centerAll()`'s `oHor`/`oVer`
 * (inverting `screenToWorldCoordinates` at the canvas's own center point),
 * generalized from "center of the whole map" to "center on any world
 * point". The caller still runs the result through `clampOffsets()` once —
 * a target near a map edge/corner legitimately can't be centered exactly
 * without panning past the viewport, same as any other pan/zoom.
 */
export function computeCenterOnCellOffset(input: CenterOnCellInput): {
  offsetX: number;
  offsetY: number;
} {
  const {
    targetX,
    targetY,
    scale,
    gameWidth,
    gameHeight,
    canvasWidth,
    canvasHeight,
  } = input;
  return {
    offsetX:
      targetX - gameWidth / 2 + (gameWidth / 2 - canvasWidth / 2) / scale,
    offsetY:
      targetY - gameHeight / 2 + (gameHeight / 2 - canvasHeight / 2) / scale,
  };
}

/**
 * Spectator/replay-only clamp continuity — see clampOffsets(). Below
 * spectatorZoomFloor the pan bound is the generic half-viewport-slack
 * formula (background may show); at/above spectatorFillScale it's the
 * zero-slack "never reveal background" formula (see centerAll()'s and
 * clampOffsets()'s own docs for what each of those means). Those two
 * formulas are NOT the same function of scale, so switching between them
 * with a hard `scale >= fillScale` boolean produced a one-frame
 * discontinuity: an offset reached via the generous formula (e.g. the
 * "zoom out, pan to a corner" flow centerAll()'s own zoom-out-to-whole-
 * board feature exists to support) can land outside the tight formula's
 * range, so clampOffsets() slams it back to the tight formula's own
 * value the instant a zoom crosses the threshold — visually, the camera
 * re-centering on the map instead of continuing to track the cursor/
 * pinch point mid-gesture. Reproduced on both off-center wheel zoom
 * (zoom-out-then-pan-then-zoom-in) and mobile pinch (any portrait/
 * landscape spectator viewport lands below fillScale on load by design,
 * so the very first pinch-in crosses the threshold).
 *
 * spectatorZoomBlendT() turns `scale` into a 0..1 weight — exactly 0 at
 * or below spectatorZoomFloor, exactly 1 at or above spectatorFillScale,
 * linear in between — and spectatorAxisMinOffset()/spectatorAxisMaxOffset()
 * use it to blend the two per-axis bound formulas continuously. At the
 * clamped endpoints (t<=0 / t>=1) they return the original formula's
 * value directly with no interpolation arithmetic, so the bounds used
 * today at/below the floor and at/above fill scale are byte-for-byte
 * unchanged; only scales strictly between the two now transition
 * smoothly instead of jumping.
 *
 * Scalar in, scalar out, by design: clampOffsets() runs on every
 * wheel/pinch/drag tick, so these avoid allocating an intermediate
 * {min, max} object per axis per call.
 */
export function spectatorZoomBlendT(
  scale: number,
  zoomFloor: number,
  fillScale: number,
): number {
  if (fillScale <= zoomFloor) return 1;
  if (scale <= zoomFloor) return 0;
  if (scale >= fillScale) return 1;
  return (scale - zoomFloor) / (fillScale - zoomFloor);
}

export function spectatorAxisMinOffset(
  dim: number,
  viewport: number,
  scale: number,
  t: number,
): number {
  if (t <= 0) return -dim / 2 + (dim - viewport) / (2 * scale);
  const tight = dim / (2 * scale) - dim / 2;
  if (t >= 1) return tight;
  const generic = -dim / 2 + (dim - viewport) / (2 * scale);
  return generic + (tight - generic) * t;
}

export function spectatorAxisMaxOffset(
  dim: number,
  viewport: number,
  scale: number,
  t: number,
): number {
  if (t <= 0) return dim / 2 + (dim - viewport) / (2 * scale);
  const tight = dim / 2 - (viewport - dim / 2) / scale;
  if (t >= 1) return tight;
  const generic = dim / 2 + (dim - viewport) / (2 * scale);
  return generic + (tight - generic) * t;
}

export class TransformHandler {
  public scale: number = 1.8;
  private _boundingRect: DOMRect;
  private offsetX: number = -350;
  private offsetY: number = -200;
  private lastGoToCallTime: number | null = null;

  private target: Cell | null;
  private targetScale: number | null = null;
  private intervalID: NodeJS.Timeout | null = null;
  private changed = false;
  // spectatorFillScale: the scale at which the map exactly fills the
  // viewport on both axes — the point past which any pan would have to
  // reveal background. spectatorZoomFloor: how far a spectator is allowed
  // to deliberately scroll out past that — down to the whole map (plus a
  // small margin) instead of being stuck at fill-viewport. Both are
  // recomputed by centerAll() from the current map/viewport dimensions;
  // onZoom()/clampOffsets() gate their use on isReplaySpectatorView() so
  // live play is untouched. See centerAll() for the full picture.
  private spectatorFillScale = 0;
  private spectatorZoomFloor = 0;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private canvas: HTMLCanvasElement,
  ) {
    this._boundingRect = this.canvas.getBoundingClientRect();
    this.eventBus.on(ZoomEvent, (e) => this.onZoom(e));
    this.eventBus.on(DragEvent, (e) => this.onMove(e));
    this.eventBus.on(GoToPlayerEvent, (e) => this.onGoToPlayer(e));
    this.eventBus.on(GoToPositionEvent, (e) => this.onGoToPosition(e));
    this.eventBus.on(GoToUnitEvent, (e) => this.onGoToUnit(e));
    this.eventBus.on(CenterCameraEvent, () => this.centerCamera());
    this.eventBus.on(FitWholeMapEvent, () =>
      this.centerAll(0.95, { forceWholeMap: true }),
    );

    // Replay/spectator: start fit-to-map (whole board centered) from t=0.
    // GameRenderer.initialize() also calls centerAll() shortly after, but
    // initializing here guarantees the very first paint is fit-to-map and makes
    // the intent explicit. Live play keeps the hand-tuned zoomed-in defaults
    // above (scale 1.8 / offsets -350,-200) untouched.
    if (isReplaySpectatorView()) {
      this.centerAll(0.95);
    }
  }

  public updateCanvasBoundingRect() {
    this._boundingRect = this.canvas.getBoundingClientRect();
    // A resize/orientation-change can invalidate the CURRENT offset against
    // the NEW viewport (e.g. spectator "filling" mode's tight pan bound
    // moves to a different axis on a portrait<->landscape flip) — without
    // this, the stale, now out-of-bounds offset renders as-is and is only
    // corrected the next time an unrelated onZoom()/onMove()/goTo() tick
    // happens to call clampOffsets(), producing a jump that reads as
    // caused by that gesture instead of the resize that actually invalidated
    // it. Re-clamping here fixes the timing only — same bound math
    // clampOffsets() always used, no recentering, no pointer/anchor logic.
    this.clampOffsets();
  }

  boundingRect(): DOMRect {
    return this._boundingRect;
  }

  width(): number {
    return this.boundingRect().width;
  }
  hasChanged(): boolean {
    return this.changed;
  }
  resetChanged() {
    this.changed = false;
  }

  handleTransform(context: CanvasRenderingContext2D) {
    // Disable image smoothing for pixelated effect
    context.imageSmoothingEnabled = false;

    // Apply zoom and pan
    context.setTransform(
      this.scale,
      0,
      0,
      this.scale,
      this.game.width() / 2 - this.offsetX * this.scale,
      this.game.height() / 2 - this.offsetY * this.scale,
    );
  }

  worldToCanvasCoordinates(cell: Cell): { x: number; y: number } {
    // Step 1: Convert from Cell coordinates to game coordinates
    // (reverse of Math.floor operation - we'll use the exact values)
    const gameX = cell.x;
    const gameY = cell.y;

    // Step 2: Reverse the game center offset calculation
    // Original: gameX = centerX + this.game.width() / 2
    // Therefore: centerX = gameX - this.game.width() / 2
    const centerX = gameX - this.game.width() / 2;
    const centerY = gameY - this.game.height() / 2;

    // Step 3: Reverse the world point calculation
    // Original: centerX = (canvasX - this.game.width() / 2) / this.scale + this.offsetX
    // Therefore: canvasX = (centerX - this.offsetX) * this.scale + this.game.width() / 2
    const canvasX =
      (centerX - this.offsetX) * this.scale + this.game.width() / 2;
    const canvasY =
      (centerY - this.offsetY) * this.scale + this.game.height() / 2;

    return { x: canvasX, y: canvasY };
  }

  worldToScreenCoordinates(cell: Cell): { x: number; y: number } {
    // Step 1-3: Convert world coordinates to canvas coordinates in worldToCanvasCoordinates
    // Step 4 only where needed: Convert canvas coordinates back to screen coordinates
    const canvasCoords = this.worldToCanvasCoordinates(cell);
    return this.canvasToScreenCoordinates(canvasCoords.x, canvasCoords.y);
  }

  screenToWorldCoordinates(screenX: number, screenY: number): Cell {
    const canvasCoords = this.screenToCanvasCoordinates(screenX, screenY);

    const centerX =
      (canvasCoords.x - this.game.width() / 2) / this.scale + this.offsetX;
    const centerY =
      (canvasCoords.y - this.game.height() / 2) / this.scale + this.offsetY;

    const gameX = centerX + this.game.width() / 2;
    const gameY = centerY + this.game.height() / 2;

    return new Cell(Math.floor(gameX), Math.floor(gameY));
  }

  canvasToScreenCoordinates(
    canvasX: number,
    canvasY: number,
  ): { x: number; y: number } {
    const canvasRect = this.boundingRect();
    return {
      x: canvasX + canvasRect.left,
      y: canvasY + canvasRect.top,
    };
  }

  screenToCanvasCoordinates(
    screenX: number,
    screenY: number,
  ): { x: number; y: number } {
    const canvasRect = this.boundingRect();
    return { x: screenX - canvasRect.left, y: screenY - canvasRect.top };
  }

  screenBoundingRect(): [Cell, Cell] {
    const canvasRect = this.boundingRect();
    const canvasWidth = canvasRect.width;
    const canvasHeight = canvasRect.height;

    const LeftX = -this.game.width() / 2 / this.scale + this.offsetX;
    const TopY = -this.game.height() / 2 / this.scale + this.offsetY;

    const gameLeftX = LeftX + this.game.width() / 2;
    const gameTopY = TopY + this.game.height() / 2;

    const rightX =
      (canvasWidth - this.game.width() / 2) / this.scale + this.offsetX;
    const bottomY =
      (canvasHeight - this.game.height() / 2) / this.scale + this.offsetY;

    const gameRightX = rightX + this.game.width() / 2;
    const gameBottomY = bottomY + this.game.height() / 2;

    return [
      new Cell(Math.floor(gameLeftX), Math.floor(gameTopY)),
      new Cell(Math.floor(gameRightX), Math.floor(gameBottomY)),
    ];
  }

  isOnScreen(cell: Cell): boolean {
    const [topLeft, bottomRight] = this.screenBoundingRect();
    return (
      cell.x > topLeft.x &&
      cell.x < bottomRight.x &&
      cell.y > topLeft.y &&
      cell.y < bottomRight.y
    );
  }

  screenCenter(): { screenX: number; screenY: number } {
    const [upperLeft, bottomRight] = this.screenBoundingRect();
    return {
      screenX: upperLeft.x + Math.floor((bottomRight.x - upperLeft.x) / 2),
      screenY: upperLeft.y + Math.floor((bottomRight.y - upperLeft.y) / 2),
    };
  }

  onGoToPlayer(event: GoToPlayerEvent) {
    this.clearTarget();
    const nameLocation = event.player.nameLocation();
    if (!nameLocation) {
      return;
    }
    if (isReplaySpectatorView()) {
      // Replay/spectator: a competitor rail click (or any other
      // GoToPlayerEvent — leaderboard row, event feed) is a ONE-SHOT,
      // clamp-bounded camera locate, never a multi-tick eased chase. The
      // old eased `goTo()` chase (still used below for live play) had no
      // reachability check: whenever the target's exact-center placement
      // needed panning past clampOffsets()'s tight spectator "filling"
      // bound — true for essentially any agent not already dead-center,
      // e.g. one near a map edge/corner — `positionClose` could never be
      // satisfied and the interval ran forever, fighting the clamp every
      // 16ms tick with zero net progress until the viewer's own zoom/pan
      // happened to cancel it (`clearTarget()` above). Computing the
      // destination directly and clamping once can't stall: it either
      // reaches the target exactly or lands at the same legitimate
      // clamp-bounded position `clampOffsets()` would already impose on a
      // manual pan there, and then genuinely stops.
      const { width: canvasWidth, height: canvasHeight } = this.boundingRect();
      const { offsetX, offsetY } = computeCenterOnCellOffset({
        targetX: nameLocation.x,
        targetY: nameLocation.y,
        scale: this.scale,
        gameWidth: this.game.width(),
        gameHeight: this.game.height(),
        canvasWidth,
        canvasHeight,
      });
      this.offsetX = offsetX;
      this.offsetY = offsetY;
      this.clampOffsets();
      this.changed = true;
      return;
    }
    // Live play: unchanged eased multi-tick chase, own targets always stay
    // reachable under live play's generous, always-satisfiable clamp bound
    // (see clampOffsets()'s non-spectator branch), so the stall above
    // cannot happen here.
    this.target = new Cell(nameLocation.x, nameLocation.y);
    this.targetScale = event.zoom ?? null;
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  onGoToPosition(event: GoToPositionEvent) {
    this.clearTarget();
    this.target = new Cell(event.x, event.y);
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  onGoToUnit(event: GoToUnitEvent) {
    this.clearTarget();
    this.target = new Cell(
      this.game.x(event.unit.lastTile()),
      this.game.y(event.unit.lastTile()),
    );
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  centerCamera() {
    this.clearTarget();
    const player = this.game.myPlayer();
    if (!player || !player.nameLocation()) return;
    this.target = new Cell(player.nameLocation().x, player.nameLocation().y);
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  private goTo() {
    const { screenX, screenY } = this.screenCenter();

    if (this.target === null) throw new Error("null target");

    const positionClose =
      Math.abs(this.target.x - screenX) + Math.abs(this.target.y - screenY) < 2;
    const scaleClose =
      this.targetScale === null ||
      Math.abs(this.scale - this.targetScale) < 0.01;
    if (positionClose && scaleClose) {
      this.clearTarget();
      return;
    }

    let dt: number;
    const now = window.performance.now();
    if (this.lastGoToCallTime === null) {
      dt = GOTO_INTERVAL_MS;
    } else {
      dt = now - this.lastGoToCallTime;
    }
    this.lastGoToCallTime = now;

    const r = 1 - Math.pow(CAMERA_SMOOTHING, dt / 1000);

    this.offsetX += Math.max(
      Math.min((this.target.x - screenX) * r, CAMERA_MAX_SPEED),
      -CAMERA_MAX_SPEED,
    );
    this.offsetY += Math.max(
      Math.min((this.target.y - screenY) * r, CAMERA_MAX_SPEED),
      -CAMERA_MAX_SPEED,
    );

    if (this.targetScale !== null) {
      const oldScale = this.scale;
      const zoomSmoothing = 0.7;
      const zoomR = 1 - Math.pow(zoomSmoothing, dt / 1000);
      const diff = this.targetScale - this.scale;
      const smoothStep = diff * zoomR;
      const minStep =
        Math.sign(diff) * Math.min(Math.abs(diff), (6.0 * dt) / 1000);
      this.scale +=
        Math.abs(smoothStep) >= Math.abs(minStep) ? smoothStep : minStep;
      // Keep screen center pinned as scale changes: (canvasSize - mapSize) / (2 * scale)
      // shifts the apparent center when canvas != map dimensions (always on mobile).
      const { width: canvasWidth, height: canvasHeight } = this.boundingRect();
      this.offsetX +=
        (canvasWidth - this.game.width()) *
        (1 / (2 * oldScale) - 1 / (2 * this.scale));
      this.offsetY +=
        (canvasHeight - this.game.height()) *
        (1 / (2 * oldScale) - 1 / (2 * this.scale));
    }

    // Spectator/replay auto-pans (onGoToPlayer's pan-only chase; a
    // leaderboard/event "go to" click) must stay bounded the same way a
    // drag or scroll would — clampOffsets() itself decides whether that
    // means the tight fill-viewport band or the generous background-visible
    // one. Live play never calls this (isReplaySpectatorView() false), so
    // it's untouched.
    if (isReplaySpectatorView()) {
      this.clampOffsets();
    }

    this.changed = true;
  }

  onZoom(event: ZoomEvent) {
    this.clearTarget();
    const oldScale = this.scale;
    const zoomFactor = 1 + event.delta / 600;
    this.scale /= zoomFactor;

    // Clamp the scale to prevent extreme zooming. Spectator/replay routes
    // additionally floor zoom-out at spectatorZoomFloor (see centerAll) —
    // the whole-map scale plus a small margin — so scrolling out always
    // reaches the full board; the absolute 0.2 floor still stops it going
    // further into an unusably tiny map.
    const spectatorFloor = isReplaySpectatorView()
      ? this.spectatorZoomFloor
      : 0.2;
    this.scale = Math.max(0.2, spectatorFloor, Math.min(20, this.scale));

    const canvasCoords = this.screenToCanvasCoordinates(event.x, event.y);

    // Calculate the world point we want to zoom towards
    const zoomPointX =
      (canvasCoords.x - this.game.width() / 2) / oldScale + this.offsetX;
    const zoomPointY =
      (canvasCoords.y - this.game.height() / 2) / oldScale + this.offsetY;

    // Adjust the offset
    this.offsetX =
      zoomPointX - (canvasCoords.x - this.game.width() / 2) / this.scale;
    this.offsetY =
      zoomPointY - (canvasCoords.y - this.game.height() / 2) / this.scale;
    this.clampOffsets();
    this.changed = true;
  }

  private clampOffsets() {
    const canvasRect = this.boundingRect();
    const canvasWidth = canvasRect.width;
    const canvasHeight = canvasRect.height;
    const gameWidth = this.game.width();
    const gameH = this.game.height();
    const scale = this.scale;

    let minOffsetX: number;
    let maxOffsetX: number;
    let minOffsetY: number;
    let maxOffsetY: number;
    if (isReplaySpectatorView()) {
      // Spectator/replay routes land cover-fit, or get zoomed back in to
      // spectatorFillScale (see centerAll): at that scale or above, the map
      // can fill the viewport with zero background. Below spectatorZoomFloor,
      // background is visible on purpose — the spectator scrolled out past
      // the fill point deliberately to see the whole board. See
      // spectatorZoomBlendT()/spectatorAxis*Offset() above: this blends
      // continuously between those two bounds instead of switching between
      // them at a hard scale threshold, which used to snap the camera to
      // the tight bound's position the instant a zoom crossed it.
      const t = spectatorZoomBlendT(
        scale,
        this.spectatorZoomFloor,
        this.spectatorFillScale,
      );
      minOffsetX = spectatorAxisMinOffset(gameWidth, canvasWidth, scale, t);
      maxOffsetX = spectatorAxisMaxOffset(gameWidth, canvasWidth, scale, t);
      minOffsetY = spectatorAxisMinOffset(gameH, canvasHeight, scale, t);
      maxOffsetY = spectatorAxisMaxOffset(gameH, canvasHeight, scale, t);
    } else {
      // Live play: unchanged.
      // Allow panning so that up to half of the viewport can be outside the map on each side.
      // This lets a map corner be placed at the screen center, but no further.
      // Derivation (X axis):
      //   gameLeftX = -gameWidth/(2*scale) + offsetX + gameWidth/2 >= -vw/2
      //   gameRightX = (canvasWidth - gameWidth/2)/scale + offsetX + gameWidth/2 <= gameWidth + vw/2
      // Solving gives:
      //   minOffsetX = -gameWidth/2 + (gameWidth - canvasWidth) / (2*scale)
      //   maxOffsetX =  gameWidth/2 + (gameWidth - canvasWidth) / (2*scale)
      minOffsetX = -gameWidth / 2 + (gameWidth - canvasWidth) / (2 * scale);
      maxOffsetX = gameWidth / 2 + (gameWidth - canvasWidth) / (2 * scale);
      minOffsetY = -gameH / 2 + (gameH - canvasHeight) / (2 * scale);
      maxOffsetY = gameH / 2 + (gameH - canvasHeight) / (2 * scale);
    }

    // Clamp offsets within computed bounds on each axis
    if (this.offsetX < minOffsetX) {
      this.offsetX = minOffsetX;
    } else if (this.offsetX > maxOffsetX) {
      this.offsetX = maxOffsetX;
    }

    if (this.offsetY < minOffsetY) {
      this.offsetY = minOffsetY;
    } else if (this.offsetY > maxOffsetY) {
      this.offsetY = maxOffsetY;
    }
  }

  onMove(event: DragEvent) {
    this.clearTarget();
    this.offsetX -= event.deltaX / this.scale;
    this.offsetY -= event.deltaY / this.scale;
    this.clampOffsets();
    this.changed = true;
  }

  private clearTarget() {
    if (this.intervalID !== null) {
      clearInterval(this.intervalID);
      this.intervalID = null;
    }
    this.target = null;
    this.targetScale = null;
  }

  override(x: number = 0, y: number = 0, s: number = 1) {
    //hardset view position
    this.clearTarget();
    this.offsetX = x;
    this.offsetY = y;
    this.scale = s;
    this.changed = true;
  }

  centerAll(fit: number = 1, options: { forceWholeMap?: boolean } = {}) {
    //position entire map centered on the screen.
    //
    //Standalone replay/spectator surfaces use a "cover" fit instead of
    //"contain": the map fills the viewport with no letterboxing, cropping a
    //little of the far edges instead. Embedded replay frames need the opposite
    //tradeoff: their smaller Twitch-style boxes must retain the whole-board
    //context, so they use the existing "contain" fit. Live play is unaffected:
    //it never reaches here with isReplaySpectatorView() true, and even when
    //this fires during its own transient startup call, it's immediately
    //superseded by the real spawn/goToPlayer zoom.
    //
    //`options.forceWholeMap` (FitWholeMapEvent, currently dispatched
    //automatically by WinModal at match end) bypasses `cover` AND the
    //portrait/landscape
    //overzoom branches entirely, landing the literal whole-map "contain"
    //fit no matter the viewport shape — the one-gesture way back to the
    //full board. See computeSpectatorFitScale() for the full landing-scale
    //derivation (all three shapes: cover, portrait/landscape overzoom,
    //plain contain).
    const vpWidth = this.boundingRect().width;
    const vpHeight = this.boundingRect().height;
    const mapWidth = this.game.width();
    const mapHeight = this.game.height();
    const spectator = !options.forceWholeMap && isReplaySpectatorView();

    const { scale: tScale, fillScale, zoomFloor } = computeSpectatorFitScale({
      vpWidth,
      vpHeight,
      mapWidth,
      mapHeight,
      fit,
      spectator,
      embedded: window.self !== window.top,
    });

    const oHor = (mapWidth - vpWidth) / 2 / tScale;
    const oVer = (mapHeight - vpHeight) / 2 / tScale;

    // See computeSpectatorFitScale()'s own doc for fillScale/zoomFloor's
    // meaning. onZoom()/clampOffsets() gate their use on
    // isReplaySpectatorView() at each call site, so live play (which never
    // sets that) is unaffected by these being set unconditionally here.
    this.spectatorFillScale = fillScale;
    this.spectatorZoomFloor = zoomFloor;

    this.override(oHor, oVer, tScale);
  }
}
