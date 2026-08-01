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
 * board view from the portrait spectator default (see
 * PORTRAIT_TARGET_VERTICAL_FILL) or from any deliberate zoom-in. Dispatched
 * by the PoV selector's "Whole board" pick/crosshair (PointOfViewSelector),
 * never by anything automatic. Handled by forcing centerAll()'s literal
 * whole-map "contain" landing regardless of viewport aspect.
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
// Portrait spectator viewports (phone/tablet held upright) land outside the
// `cover` aspect-ratio band in centerAll(): a portrait viewport's aspect
// (~0.4-0.6) is far from virtually every OpenFront map's aspect (roughly
// square to 2:1 landscape), so plain "contain" there fits the map to the
// viewport's narrower dimension (width) and wastes the rest of the taller
// dimension as letterbox bands (P2-F10). PORTRAIT_TARGET_VERTICAL_FILL is
// the fraction of the portrait viewport's HEIGHT the map should occupy
// instead: enough to read as "filling the screen", short of a true `cover`
// landing (which would crop most maps down to a narrow vertical sliver and
// lose spectator context). See centerAll() for the full derivation.
const PORTRAIT_TARGET_VERTICAL_FILL = 0.75;

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
    this.target = new Cell(nameLocation.x, nameLocation.y);
    // In replay/spectator mode keep the full-map fit (set by
    // GameRenderer.initialize -> centerAll) and never auto-zoom onto a single
    // player. The replay spectator-focus path (ClientGameRunner) and any
    // leaderboard/event "go to player" click would otherwise slam the camera to
    // a high zoom on one nation and hide the rest of the board. We still PAN to
    // the player so click-to-focus works; we just drop the zoom component.
    // Guarded so live play is unchanged.
    this.targetScale = isReplaySpectatorView() ? null : (event.zoom ?? null);
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
    const spectatorFilling =
      isReplaySpectatorView() && scale >= this.spectatorFillScale;
    if (spectatorFilling) {
      // Spectator/replay routes land cover-fit, or get zoomed back in to
      // spectatorFillScale (see centerAll): at that scale or above, the map
      // can fill the viewport with zero background, so pin it there with
      // zero-or-thin slack on one axis. Any pan at this zoom — a drag, the
      // initial spectator auto-focus, a leaderboard/event "go to" click —
      // must stay within whatever slack exists, or it drags the map's edge
      // past the canvas and reveals background.
      minOffsetX = gameWidth / (2 * scale) - gameWidth / 2;
      maxOffsetX = gameWidth / 2 - (canvasWidth - gameWidth / 2) / scale;
      minOffsetY = gameH / (2 * scale) - gameH / 2;
      maxOffsetY = gameH / 2 - (canvasHeight - gameH / 2) / scale;
    } else {
      // Below spectatorFillScale, background is visible on purpose — either
      // this is live play, or a spectator scrolled out past the fill point
      // deliberately (floored at spectatorZoomFloor in onZoom) to see the
      // whole board. Same generous bound either way:
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
    //Replay/spectator surfaces (bet/premiere/ai-league-replay routes) use a
    //"cover" fit instead of "contain": the map fills the viewport with no
    //letterboxing, cropping a little of the far edges instead. The whole
    //appeal of watching is territory filling the frame, so dead grey bands
    //(which "contain" produces whenever the viewport aspect ratio doesn't
    //match the map's) read as a broken layout, not a deliberate one. Live
    //play is unaffected: it never reaches here with isReplaySpectatorView()
    //true, and even when this fires during its own transient startup call,
    //it's immediately superseded by the real spawn/goToPlayer zoom.
    //
    //Cropping is skipped back to "contain" outside a plausible desktop
    //aspect-ratio band (mirrors GameModeSelector's object-contain fallback
    //for extreme map aspect ratios) so a landscape/tablet viewport doesn't
    //get most of the map cropped away.
    //
    //`options.forceWholeMap` (FitWholeMapEvent, the PoV selector's "Whole
    //board" pick/crosshair) bypasses `cover` AND the portrait branch below
    //entirely, landing the literal whole-map "contain" fit no matter the
    //viewport shape — the one-gesture way back to the full board.
    const vpWidth = this.boundingRect().width;
    const vpHeight = this.boundingRect().height;
    const mapWidth = this.game.width();
    const mapHeight = this.game.height();

    const aspectRatioDeviation = vpWidth / vpHeight / (mapWidth / mapHeight);
    const spectator = !options.forceWholeMap && isReplaySpectatorView();
    const cover =
      spectator && aspectRatioDeviation > 0.5 && aspectRatioDeviation < 2;

    const rawScHor = vpWidth / mapWidth;
    const rawScVer = vpHeight / mapHeight;
    const containScale = Math.min(rawScHor, rawScVer);
    const coverScale = Math.max(rawScHor, rawScVer);

    let tScale: number;
    if (cover) {
      tScale = coverScale * Math.max(fit, 1);
    } else if (spectator && vpHeight > vpWidth) {
      // Portrait spectator viewport (P2-F10): `cover` above excludes it for
      // virtually every real map (portrait's ~0.4-0.6 aspect vs. maps
      // running roughly square to 2:1 landscape), so plain "contain" would
      // fit the map to the viewport's WIDTH and waste most of its HEIGHT as
      // letterbox bands. Overzoom instead: land at whichever scale renders
      // the map at PORTRAIT_TARGET_VERTICAL_FILL of the viewport's height —
      // `rawScVer * FILL` always yields exactly that fraction, independent
      // of the map's own aspect ratio (rendered height = mapHeight * scale
      // = mapHeight * rawScVer * FILL = vpHeight * FILL). Clamped so this
      // never zooms in LESS than a whole-map contain fit (rare near-square
      // maps already exceed the target) or MORE than a true cover fit
      // (never crop tighter than cover would). Horizontal panning reaches
      // whatever this overzoom crops off the sides; the PoV selector's
      // "Whole board" control (FitWholeMapEvent, forceWholeMap above) and
      // pinch-zoom-out (spectatorZoomFloor below) both reach the true
      // whole-map fit in one gesture.
      const portraitTarget = rawScVer * PORTRAIT_TARGET_VERTICAL_FILL;
      tScale = Math.min(
        Math.max(containScale * fit, portraitTarget),
        coverScale,
      );
    } else {
      tScale = containScale * fit;
    }

    const oHor = (mapWidth - vpWidth) / 2 / tScale;
    const oVer = (mapHeight - vpHeight) / 2 / tScale;

    // fillScale: the scale at which the map exactly fills the viewport on
    // both axes — clampOffsets()'s zero-slack threshold. zoomFloor: the
    // "whole map visible" (plain contain) scale, backed off by
    // SPECTATOR_ZOOM_OUT_MARGIN so a deliberate scroll-out lands a touch
    // past a snug fit rather than exactly on its edge. Both are independent
    // of `cover`/the landing-framing branches above (which only pick the
    // *landing* scale) — onZoom()/clampOffsets() gate their use on
    // isReplaySpectatorView() at each call site, so live play (which never
    // sets that) is unaffected by these being set unconditionally here.
    // Reuses the raw containScale/coverScale computed above (identical
    // formulas — recomputing under new names here would just shadow them).
    this.spectatorFillScale = coverScale;
    this.spectatorZoomFloor = containScale * SPECTATOR_ZOOM_OUT_MARGIN;

    this.override(oHor, oVer, tScale);
  }
}
