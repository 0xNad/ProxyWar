/**
 * Coverage for `computeSpectatorFitScale` — `TransformHandler.centerAll`'s
 * extracted, pure landing-scale computation (same pure-computation/thin-
 * caller split as `StatTimeSeriesChart.ts`'s `computeChartGeometry`),
 * unit-testable without constructing a real `TransformHandler` (which
 * needs a `GameView`/`HTMLCanvasElement`).
 *
 * P2 fix (found live 2026-08-02, an 844x390 landscape viewport): only a
 * PORTRAIT overzoom branch existed for a spectator viewport too far from
 * square for `cover` to apply — a landscape viewport in the same
 * situation fell all the way through to plain "contain", fitting to its
 * HEIGHT and wasting roughly half its WIDTH as side letterbox bands. The
 * fix adds a symmetric landscape branch; these tests pin both the
 * regression (a wasted-width scenario now overzooms) and that every
 * other landing shape (cover, portrait, live play) is unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeCenterOnCellOffset,
  computeSpectatorFitScale,
  GoToPlayerEvent,
  isEmbeddedSpectatorFrame,
  spectatorAxisMaxOffset,
  spectatorAxisMinOffset,
  spectatorZoomBlendT,
  TransformHandler,
} from "../../../src/client/graphics/TransformHandler";
import { ZoomEvent } from "../../../src/client/InputHandler";
import { EventBus } from "../../../src/core/EventBus";
import type { GameView, PlayerView } from "../../../src/core/game/GameView";

describe("computeSpectatorFitScale", () => {
  it("lands 'cover' (fills the viewport, no letterboxing) when the viewport and map aspect ratios are close — a typical desktop/tablet spectator viewport", () => {
    // Viewport 1200x800 (aspect 1.5), map 1000x700 (aspect ~1.43) —
    // deviation ~1.05, well inside the (0.5, 2) cover band.
    const result = computeSpectatorFitScale({
      vpWidth: 1200,
      vpHeight: 800,
      mapWidth: 1000,
      mapHeight: 700,
      fit: 1,
      spectator: true,
    });
    const rawScHor = 1200 / 1000;
    const rawScVer = 800 / 700;
    const coverScale = Math.max(rawScHor, rawScVer);
    expect(result.scale).toBeCloseTo(coverScale, 5);
    // Rendered map fills (or exceeds) the viewport on both axes.
    expect(1000 * result.scale).toBeGreaterThanOrEqual(1200 - 0.01);
    expect(700 * result.scale).toBeGreaterThanOrEqual(800 - 0.01);
  });

  it("REGRESSION (P2, 2026-08-02): an 844x390 landscape viewport against a roughly square map now overzooms to fill most of the width, instead of wasting ~55% of it on plain contain", () => {
    const vpWidth = 844;
    const vpHeight = 390;
    const mapWidth = 1000;
    const mapHeight = 1000; // square map: aspect deviation ~2.16, outside the (0.5,2) cover band
    const aspectRatioDeviation =
      vpWidth / vpHeight / (mapWidth / mapHeight);
    expect(aspectRatioDeviation).toBeGreaterThan(2); // confirms this case is NOT eligible for `cover`

    const result = computeSpectatorFitScale({
      vpWidth,
      vpHeight,
      mapWidth,
      mapHeight,
      fit: 0.95,
      spectator: true,
    });

    const renderedWidth = mapWidth * result.scale;
    const wastedWidthFraction = 1 - Math.min(renderedWidth, vpWidth) / vpWidth;
    // Before the fix: plain "contain" landed at containScale = vpHeight/mapHeight
    // = 0.39, rendering 390/844 ≈ 46% of the viewport's width (~54% wasted).
    // After the fix: the map now fills at least 70% of the viewport's width.
    expect(wastedWidthFraction).toBeLessThan(0.3);
    expect(renderedWidth / vpWidth).toBeGreaterThan(0.7);
  });

  it("never overzooms landscape past a true cover fit — clamped at coverScale", () => {
    // A very wide viewport (e.g. an ultrawide monitor) against a modest
    // map: cover would already be a huge zoom; the overzoom target must
    // never exceed it.
    const result = computeSpectatorFitScale({
      vpWidth: 3000,
      vpHeight: 400,
      mapWidth: 1000,
      mapHeight: 1000,
      fit: 1,
      spectator: true,
    });
    const coverScale = Math.max(3000 / 1000, 400 / 1000);
    expect(result.scale).toBeLessThanOrEqual(coverScale + 1e-9);
  });

  it("never overzooms landscape below a whole-map contain fit — clamped at containScale * fit", () => {
    // A landscape viewport barely wider than tall, against a map that's
    // ALREADY wider than the overzoom target would produce — contain
    // itself already exceeds the 0.75 fill target.
    const result = computeSpectatorFitScale({
      vpWidth: 850,
      vpHeight: 800,
      mapWidth: 400,
      mapHeight: 1000,
      fit: 1,
      spectator: true,
    });
    const containScale = Math.min(850 / 400, 800 / 1000);
    expect(result.scale).toBeGreaterThanOrEqual(containScale - 1e-9);
  });

  it("preserves the existing portrait overzoom behavior unchanged (P2-F10)", () => {
    // Viewport 390x844 (portrait phone), map 1000x700 (landscape map) —
    // deviation is far outside cover; the map would otherwise be fit to
    // the narrower WIDTH and waste most of the HEIGHT.
    const vpWidth = 390;
    const vpHeight = 844;
    const mapWidth = 1000;
    const mapHeight = 700;
    const result = computeSpectatorFitScale({
      vpWidth,
      vpHeight,
      mapWidth,
      mapHeight,
      fit: 0.95,
      spectator: true,
    });
    const rawScVer = vpHeight / mapHeight;
    const portraitTarget = rawScVer * 0.75;
    const containScale = Math.min(vpWidth / mapWidth, vpHeight / mapHeight);
    const coverScale = Math.max(vpWidth / mapWidth, vpHeight / mapHeight);
    const expected = Math.min(
      Math.max(containScale * 0.95, portraitTarget),
      coverScale,
    );
    expect(result.scale).toBeCloseTo(expected, 5);
  });

  it("lands plain 'contain' (never overzooms) when spectator is false — live play is untouched", () => {
    // Same wasteful-landscape shape as the regression case above, but with
    // spectator: false (live play) — must land at the plain whole-map
    // contain scale, no overzoom at all.
    const result = computeSpectatorFitScale({
      vpWidth: 844,
      vpHeight: 390,
      mapWidth: 1000,
      mapHeight: 1000,
      fit: 1,
      spectator: false,
    });
    const containScale = Math.min(844 / 1000, 390 / 1000);
    expect(result.scale).toBeCloseTo(containScale, 5);
  });

  it("returns fillScale (coverScale) and zoomFloor (containScale * 0.85) independent of the landing-shape branch taken", () => {
    const vpWidth = 844;
    const vpHeight = 390;
    const mapWidth = 1000;
    const mapHeight = 1000;
    const result = computeSpectatorFitScale({
      vpWidth,
      vpHeight,
      mapWidth,
      mapHeight,
      fit: 0.95,
      spectator: true,
    });
    const containScale = Math.min(vpWidth / mapWidth, vpHeight / mapHeight);
    const coverScale = Math.max(vpWidth / mapWidth, vpHeight / mapHeight);
    expect(result.fillScale).toBeCloseTo(coverScale, 5);
    expect(result.zoomFloor).toBeCloseTo(containScale * 0.85, 5);
  });
});

/**
 * Regression coverage for the spectator/replay camera-zoom re-centering
 * jump: `clampOffsets()` used to switch between two structurally
 * different offset-bound formulas the instant `scale` crossed
 * `spectatorFillScale`, discarding whatever anchor-preserving offset
 * `onZoom()` had just computed and slamming the camera to the tight
 * formula's own (near map-center) value. See `spectatorZoomBlendT()` /
 * `spectatorAxisMinOffset()` / `spectatorAxisMaxOffset()` for the fix:
 * a continuous blend between the two bounds instead of a hard switch.
 */
describe("spectator clamp blend (spectatorZoomBlendT / spectatorAxisMinOffset / spectatorAxisMaxOffset)", () => {
  it("t is exactly 0 at/below zoomFloor and exactly 1 at/above fillScale (no floating-point drift at the endpoints)", () => {
    const zoomFloor = 0.68;
    const fillScale = 0.9;
    expect(spectatorZoomBlendT(zoomFloor, zoomFloor, fillScale)).toBe(0);
    expect(spectatorZoomBlendT(0.2, zoomFloor, fillScale)).toBe(0);
    expect(spectatorZoomBlendT(fillScale, zoomFloor, fillScale)).toBe(1);
    expect(spectatorZoomBlendT(5, zoomFloor, fillScale)).toBe(1);
    // Strictly between: linear, strictly inside (0, 1).
    const mid = spectatorZoomBlendT(
      (zoomFloor + fillScale) / 2,
      zoomFloor,
      fillScale,
    );
    expect(mid).toBeCloseTo(0.5, 10);
  });

  it("degenerate zoomFloor>=fillScale never divides by zero — always reports 'fully tight' (1)", () => {
    expect(spectatorZoomBlendT(1, 1, 1)).toBe(1);
    expect(spectatorZoomBlendT(1, 1.2, 0.9)).toBe(1);
  });

  it("endpoint bounds are byte-for-byte identical to the original (pre-blend) formulas", () => {
    const dim = 2000;
    const viewport = 1600;
    const zoomFloor = 0.68;
    const fillScale = 0.9;

    // At/below zoomFloor: must equal the generic half-viewport-slack formula.
    for (const scale of [0.2, 0.5, zoomFloor]) {
      const t = spectatorZoomBlendT(scale, zoomFloor, fillScale);
      const genericMin = -dim / 2 + (dim - viewport) / (2 * scale);
      const genericMax = dim / 2 + (dim - viewport) / (2 * scale);
      expect(spectatorAxisMinOffset(dim, viewport, scale, t)).toBe(genericMin);
      expect(spectatorAxisMaxOffset(dim, viewport, scale, t)).toBe(genericMax);
    }

    // At/above fillScale: must equal the zero-slack "cover" formula.
    for (const scale of [fillScale, 1.2, 3]) {
      const t = spectatorZoomBlendT(scale, zoomFloor, fillScale);
      const tightMin = dim / (2 * scale) - dim / 2;
      const tightMax = dim / 2 - (viewport - dim / 2) / scale;
      expect(spectatorAxisMinOffset(dim, viewport, scale, t)).toBe(tightMin);
      expect(spectatorAxisMaxOffset(dim, viewport, scale, t)).toBe(tightMax);
    }
  });

  it("is continuous exactly at the zoomFloor and fillScale boundaries — an infinitesimal scale change never produces a discontinuous bound jump", () => {
    // The bug was specifically a discontinuity AT the two boundaries (the
    // hard `scale >= fillScale` switch): a scale change of epsilon used to
    // be able to flip the bound formula entirely. Assert the bound value
    // changes by ~epsilon-scaled amounts, not O(1), when scale crosses each
    // boundary by an infinitesimal step. (Away from the boundaries the
    // underlying 1/scale formulas are naturally steeper at small scale —
    // that steepness predates this fix and isn't what's under test here.)
    const dim = 1000;
    const viewport = 844;
    const zoomFloor = 0.3315;
    const fillScale = 0.844;
    const epsilon = 1e-6;

    for (const boundary of [zoomFloor, fillScale]) {
      const below = boundary - epsilon;
      const above = boundary + epsilon;
      const tBelow = spectatorZoomBlendT(below, zoomFloor, fillScale);
      const tAt = spectatorZoomBlendT(boundary, zoomFloor, fillScale);
      const tAbove = spectatorZoomBlendT(above, zoomFloor, fillScale);

      const minBelow = spectatorAxisMinOffset(dim, viewport, below, tBelow);
      const minAt = spectatorAxisMinOffset(dim, viewport, boundary, tAt);
      const minAbove = spectatorAxisMinOffset(dim, viewport, above, tAbove);
      const maxBelow = spectatorAxisMaxOffset(dim, viewport, below, tBelow);
      const maxAt = spectatorAxisMaxOffset(dim, viewport, boundary, tAt);
      const maxAbove = spectatorAxisMaxOffset(dim, viewport, above, tAbove);

      // A genuinely continuous function moves by well under 1 world unit for
      // a 1e-6 change in scale on these fixture magnitudes; the pre-fix
      // discontinuity moved by tens of units for an arbitrarily small
      // change right at the threshold.
      expect(Math.abs(minAt - minBelow)).toBeLessThan(0.01);
      expect(Math.abs(minAbove - minAt)).toBeLessThan(0.01);
      expect(Math.abs(maxAt - maxBelow)).toBeLessThan(0.01);
      expect(Math.abs(maxAbove - maxAt)).toBeLessThan(0.01);
    }
  });
});

function makeCanvas(vpWidth: number, vpHeight: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () =>
    ({
      width: vpWidth,
      height: vpHeight,
      left: 0,
      top: 0,
      right: vpWidth,
      bottom: vpHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return canvas;
}

function makeGameView(mapWidth: number, mapHeight: number): GameView {
  return {
    width: () => mapWidth,
    height: () => mapHeight,
  } as unknown as GameView;
}

/** World-space point currently under a screen coordinate (canvas left/top are 0 in these fixtures, so screen === canvas space). */
function worldUnderCursor(
  transform: TransformHandler,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  const cell = transform.screenToWorldCoordinates(screenX, screenY);
  return { x: cell.x, y: cell.y };
}

describe("TransformHandler onZoom/clampOffsets — spectator zoom no longer re-centers mid-gesture", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)
      .__PROXYWAR_AI_REPLAY__;
  });

  it("REGRESSION: mobile pinch-zoom-in from a vanilla load on a landscape spectator viewport tracks the pinch centroid smoothly across the fillScale crossing, instead of a one-frame snap", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    // Same 844x390-viewport/1000x1000-map fixture as the existing
    // computeSpectatorFitScale REGRESSION (P2) test above: this landscape
    // aspect ratio is NOT cover-eligible, so centerAll() lands the initial
    // scale (0.633) intentionally BELOW spectatorFillScale (0.844) — every
    // pinch-zoom-in from load crosses the threshold.
    const transform = new TransformHandler(
      makeGameView(1000, 1000),
      new EventBus(),
      makeCanvas(844, 390),
    );
    const px = 250;
    const py = 100; // off-center pinch centroid
    let prevWorld = worldUnderCursor(transform, px, py);
    const jumps: number[] = [];
    for (let i = 0; i < 15; i++) {
      // Mirrors InputHandler's pinch emission: ZoomEvent(centroid, -pinchDelta*2).
      transform.onZoom(new ZoomEvent(px, py, -16));
      const world = worldUnderCursor(transform, px, py);
      jumps.push(Math.hypot(world.x - prevWorld.x, world.y - prevWorld.y));
      prevWorld = world;
    }
    const total = jumps.reduce((sum, j) => sum + j, 0);
    const max = Math.max(...jumps);
    // The map must fully cover the viewport at/above spectatorFillScale, so
    // *some* net repositioning here is mathematically required — this is
    // not asserting zero displacement. The pre-fix bug concentrated that
    // entire net correction (~65 world units) into a single frame the
    // instant scale crossed the threshold (max === total, a one-frame
    // teleport). The fix spreads the same unavoidable correction smoothly
    // across several frames: no single frame should carry more than half
    // of the total.
    expect(total).toBeGreaterThan(1); // sanity: a crossing (and correction) actually happened
    expect(max / total).toBeLessThan(0.5);
  });

  it("REGRESSION: desktop off-center wheel zoom-in, after zooming out and panning toward a corner, tracks the cursor smoothly across the fillScale crossing, instead of a one-frame snap", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    const transform = new TransformHandler(
      makeGameView(2000, 1000),
      new EventBus(),
      makeCanvas(1600, 900),
    );
    // Zoom out toward spectatorZoomFloor at the map center (ordinary "see
    // more of the board" scrolling).
    for (let i = 0; i < 8; i++) {
      transform.onZoom(new ZoomEvent(800, 450, 40));
    }
    // Pan toward a corner — the exact "look around the whole board" flow
    // commit 43a7a4571 added deliberate zoom-out-past-cover-fit to support.
    transform.onMove({ deltaX: -2000, deltaY: -1200 } as never);

    const px = 1000;
    const py = 600;
    let prevWorld = worldUnderCursor(transform, px, py);
    const jumps: number[] = [];
    // Realistic single-wheel-notch magnitude, repeated — not one giant
    // delta collapsing the whole floor-to-fill band into one event (that
    // would require a genuinely large net move even with a perfectly
    // continuous clamp, which is not what's under test here).
    for (let i = 0; i < 20; i++) {
      transform.onZoom(new ZoomEvent(px, py, -20));
      const world = worldUnderCursor(transform, px, py);
      jumps.push(Math.hypot(world.x - prevWorld.x, world.y - prevWorld.y));
      prevWorld = world;
    }
    const total = jumps.reduce((sum, j) => sum + j, 0);
    const max = Math.max(...jumps);
    expect(total).toBeGreaterThan(1);
    expect(max / total).toBeLessThan(0.5);
  });

  it("does not incorrectly demand exact anchoring when the map edge mathematically requires clamping (zooming in at a viewport corner while already pinned against that edge)", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    // Cover-eligible desktop viewport: at the initial (fillScale) landing
    // there is zero slack on the limiting axis by design (see clampOffsets'
    // own "filling" doc) — a corner zoom there is EXPECTED to still clamp,
    // this just isn't the discontinuous multi-hundred-unit jump case.
    const transform = new TransformHandler(
      makeGameView(2000, 1000),
      new EventBus(),
      makeCanvas(1600, 900),
    );
    // Zooming in at the extreme corner from the pinned landing position
    // legitimately can't perfectly track the cursor once the map edge is
    // reached — only assert it stays bounded (no runaway explosion), not
    // that it's pixel-exact.
    transform.onZoom(new ZoomEvent(1599, 899, -400));
    expect(transform.scale).toBeGreaterThan(0.9);
    expect(Number.isFinite(transform.scale)).toBe(true);
  });

  it("live play (non-spectator) clamp bounds are unaffected — byte-for-byte the original generic formula", () => {
    // __PROXYWAR_AI_REPLAY__ deliberately left unset: isReplaySpectatorView() is false.
    const transform = new TransformHandler(
      makeGameView(2000, 1000),
      new EventBus(),
      makeCanvas(1600, 900),
    );
    // Live play starts at the hand-tuned defaults (scale 1.8, offsets
    // -350/-200), not centerAll() — drag far enough in both directions to
    // force a clamp on both axes, then compare against the unconditional
    // generic formula (unchanged for live play; dragging never touches
    // scale).
    transform.onMove({ deltaX: -100000, deltaY: -100000 } as never);
    const scale = transform.scale;
    expect(scale).toBe(1.8);

    const gameWidth = 2000;
    const gameH = 1000;
    const canvasWidth = 1600;
    const canvasHeight = 900;
    const expectedMaxOffsetX =
      gameWidth / 2 + (gameWidth - canvasWidth) / (2 * scale);
    const expectedMaxOffsetY = gameH / 2 + (gameH - canvasHeight) / (2 * scale);
    // screenBoundingRect() exposes the top-left world cell derived from the
    // (private) internal offset — invert its formula to recover offsetX/Y
    // and compare against the expected clamped value. floor() inside
    // screenBoundingRect() contributes at most 1 unit of rounding noise.
    const expectedGameLeftX =
      expectedMaxOffsetX - gameWidth / (2 * scale) + gameWidth / 2;
    const expectedGameTopY =
      expectedMaxOffsetY - gameH / (2 * scale) + gameH / 2;
    const [topLeft] = transform.screenBoundingRect();
    expect(Math.abs(topLeft.x - expectedGameLeftX)).toBeLessThanOrEqual(1);
    expect(Math.abs(topLeft.y - expectedGameTopY)).toBeLessThanOrEqual(1);
  });
});

/**
 * Regression coverage for the deferred post-resize correction: `resizeCanvas()`
 * (GameRenderer.ts) calls `TransformHandler.updateCanvasBoundingRect()` on
 * every window resize/orientation-change, but that method used to only
 * refresh `_boundingRect` — it never re-clamped the (possibly now stale,
 * out-of-bounds) offset against the new viewport. The stale offset rendered
 * as-is until the NEXT unrelated zoom/pan/goTo tick happened to call
 * clampOffsets(), bundling a resize-caused correction into that gesture and
 * reading as a camera jump caused by the zoom/pan itself. The fix makes
 * updateCanvasBoundingRect() clamp immediately, using the exact same bound
 * math clampOffsets() always used — no recentering, no pointer/anchor logic.
 */
describe("TransformHandler.updateCanvasBoundingRect — resize immediately re-clamps stale offsets", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)
      .__PROXYWAR_AI_REPLAY__;
  });

  it("REGRESSION: a portrait->landscape resize (orientation change) re-clamps the offset immediately, with no subsequent zoom/pan/goTo call", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    // Same 1000x1000 map as the existing 844x390 landscape fixtures above;
    // starting orientation is portrait (390x844) — fillScale=0.844 either
    // way (a square map), but the BINDING axis flips: Y in portrait, X in
    // landscape. This is exactly the live orientation-change scenario.
    const mapWidth = 1000;
    const mapHeight = 1000;
    const canvas = makeCanvas(390, 844); // portrait
    const transform = new TransformHandler(
      makeGameView(mapWidth, mapHeight),
      new EventBus(),
      canvas,
    );

    // Establish a valid, off-center portrait camera: zoom in off-center so
    // the offset lands pinned against the portrait Y-axis tight bound
    // (verified: scale ≈0.8257, well inside the [zoomFloor,fillScale] band).
    transform.onZoom(new ZoomEvent(195, 700, -140));
    const scaleAfterZoom = transform.scale;

    // Switch the mocked canvas rect to landscape — the only thing a real
    // orientation change does to the DOM — then call ONLY the public method
    // GameRenderer.resizeCanvas() calls. No subsequent zoom/pan/goTo.
    canvas.getBoundingClientRect = () =>
      ({
        width: 844,
        height: 390,
        left: 0,
        top: 0,
        right: 844,
        bottom: 390,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    transform.updateCanvasBoundingRect();

    // Immediately after resize, the offset must already satisfy the NEW
    // (landscape) clamp bounds — derived from the same exported pure
    // formulas clampOffsets() itself uses, not hardcoded literals.
    const fillScale = 0.844; // coverScale: max(844/1000, 390/1000)
    const zoomFloor = 0.3315; // containScale(0.39) * 0.85
    const t = spectatorZoomBlendT(scaleAfterZoom, zoomFloor, fillScale);
    const expectedMinOffsetX = spectatorAxisMinOffset(
      mapWidth,
      844,
      scaleAfterZoom,
      t,
    );
    const expectedMaxOffsetX = spectatorAxisMaxOffset(
      mapWidth,
      844,
      scaleAfterZoom,
      t,
    );

    // screenBoundingRect() exposes the world-space left edge derived
    // directly from the (private) internal offset at the current
    // scale/boundingRect — invert to recover the effective offsetX (same
    // technique the existing live-play test above uses for offsetY).
    const [topLeft] = transform.screenBoundingRect();
    const impliedOffsetX =
      topLeft.x + mapWidth / (2 * scaleAfterZoom) - mapWidth / 2;

    expect(impliedOffsetX).toBeLessThanOrEqual(expectedMaxOffsetX + 1);
    expect(impliedOffsetX).toBeGreaterThanOrEqual(expectedMinOffsetX - 1);
  });
});

/** Minimal PlayerView mock: `onGoToPlayer` only ever reads `nameLocation()`. */
function makePlayer(x: number, y: number): PlayerView {
  return { nameLocation: () => ({ x, y }) } as unknown as PlayerView;
}

describe("computeCenterOnCellOffset", () => {
  it("matches centerAll()'s own oHor/oVer derivation when the target is the exact map center", () => {
    const mapWidth = 2000;
    const mapHeight = 1000;
    const canvasWidth = 1600;
    const canvasHeight = 900;
    const scale = 0.8;
    const { offsetX, offsetY } = computeCenterOnCellOffset({
      targetX: mapWidth / 2,
      targetY: mapHeight / 2,
      scale,
      gameWidth: mapWidth,
      gameHeight: mapHeight,
      canvasWidth,
      canvasHeight,
    });
    expect(offsetX).toBeCloseTo((mapWidth - canvasWidth) / 2 / scale, 6);
    expect(offsetY).toBeCloseTo((mapHeight - canvasHeight) / 2 / scale, 6);
  });
});

describe("TransformHandler.onGoToPlayer — replay/spectator camera-locate is a synchronous one-shot, never a continuous chase", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)
      .__PROXYWAR_AI_REPLAY__;
  });

  it("REGRESSION: a spectator target whose exact centering would require panning past the tight fillScale clamp bound leaves no interval/target alive — the old eased chase ran forever here", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    // Cover-fit desktop viewport landing exactly at spectatorFillScale on
    // load (near-zero pan slack by design) — a target near a map corner,
    // same shape as the live repro (djizus near a map edge/corner).
    const transform = new TransformHandler(
      makeGameView(2000, 1000),
      new EventBus(),
      makeCanvas(1600, 900),
    );
    const cornerPlayer = makePlayer(1950, 950);
    const scaleBefore = transform.scale;
    transform.onGoToPlayer(new GoToPlayerEvent(cornerPlayer));

    const hooks = transform as unknown as {
      intervalID: NodeJS.Timeout | null;
      target: unknown;
      targetScale: unknown;
    };
    expect(hooks.intervalID).toBeNull();
    expect(hooks.target).toBeNull();
    expect(hooks.targetScale).toBeNull();
    // Scale never changes for a spectator locate (matches the old
    // targetScale=null gate) — only offset moves.
    expect(transform.scale).toBe(scaleBefore);
  });

  it("locates a reachable (near-center) spectator target exactly, at the current scale, in one synchronous call", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    const transform = new TransformHandler(
      makeGameView(2000, 1000),
      new EventBus(),
      makeCanvas(1600, 900),
    );
    const centerish = makePlayer(1000, 500); // exact map center: always reachable regardless of clamp
    transform.onGoToPlayer(new GoToPlayerEvent(centerish));
    const world = worldUnderCursor(transform, 800, 450); // canvas center
    expect(world.x).toBeCloseTo(1000, 0);
    expect(world.y).toBeCloseTo(500, 0);
  });

  it("a zoom immediately after a spectator locate stays pointer-anchored — no leftover interval to fight it", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    const transform = new TransformHandler(
      makeGameView(2000, 1000),
      new EventBus(),
      makeCanvas(1600, 900),
    );
    transform.onGoToPlayer(new GoToPlayerEvent(makePlayer(1200, 600)));
    const px = 1000;
    const py = 550;
    const before = worldUnderCursor(transform, px, py);
    transform.onZoom(new ZoomEvent(px, py, -100));
    const after = worldUnderCursor(transform, px, py);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1);
  });

  it("live play (non-spectator) GoToPlayerEvent is byte-for-byte unchanged: still the eased multi-tick chase, still uses event.zoom", () => {
    // __PROXYWAR_AI_REPLAY__ deliberately left unset.
    const transform = new TransformHandler(
      makeGameView(2000, 1000),
      new EventBus(),
      makeCanvas(1600, 900),
    );
    transform.onGoToPlayer(new GoToPlayerEvent(makePlayer(900, 400), 3));
    const hooks = transform as unknown as {
      intervalID: NodeJS.Timeout | null;
      target: { x: number; y: number } | null;
      targetScale: number | null;
    };
    // A live-play locate schedules the eased chase (still running right
    // after the call, unlike the spectator one-shot above) targeting the
    // requested zoom.
    expect(hooks.intervalID).not.toBeNull();
    expect(hooks.target).toMatchObject({ x: 900, y: 400 });
    expect(hooks.targetScale).toBe(3);
    clearInterval(hooks.intervalID ?? undefined);
  });
});

/**
 * Regression coverage for the 2026-08-10 fullscreen "zoom back in twitches"
 * report. Two independent defects compounded:
 *
 * 1. The tight (zero-background) per-axis bound formulas assumed the scaled
 *    map covers the viewport on that axis; when it doesn't, they INVERT
 *    (min > max) and per-tick clamping oscillates the camera between the
 *    two conflicting values.
 * 2. spectatorFillScale/spectatorZoomFloor were only computed by
 *    centerAll(), so after a resize (fullscreen enter being the drastic
 *    case) clampOffsets() kept blending toward bounds derived from the OLD
 *    viewport — which is exactly what made state 1 reachable: a stale, too-
 *    low fillScale engaged the tight bound while the map was still far
 *    smaller than the real (fullscreen) viewport.
 */
describe("spectator tight clamp bounds on a non-covering axis (fullscreen twitch, 2026-08-10)", () => {
  it("REGRESSION: when the scaled map cannot cover the viewport, both tight bounds degenerate to the single centered offset instead of inverting (min > max)", () => {
    // Map 1000 wide at scale 0.918 spans 918px against a 1920px fullscreen
    // viewport — the exact live shape. The raw tight formulas here give
    // min≈+44.7 and max≈-501: an EMPTY range.
    const dim = 1000;
    const viewport = 1920;
    const scale = 0.918;
    const centered = (dim - viewport) / (2 * scale);
    expect(spectatorAxisMinOffset(dim, viewport, scale, 1)).toBeCloseTo(
      centered,
      10,
    );
    expect(spectatorAxisMaxOffset(dim, viewport, scale, 1)).toBeCloseTo(
      centered,
      10,
    );
    // The blend interior must be a valid (min <= max) range at every t.
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(
        spectatorAxisMinOffset(dim, viewport, scale, t),
      ).toBeLessThanOrEqual(
        spectatorAxisMaxOffset(dim, viewport, scale, t) + 1e-9,
      );
    }
  });

  it("is continuous at the exact dim*scale === viewport boundary — the guard changes nothing where the original formulas already agreed", () => {
    const dim = 1000;
    const viewport = 800;
    const scale = viewport / dim;
    const centered = (dim - viewport) / (2 * scale);
    // Both ORIGINAL tight formulas independently equal the centered offset
    // at the boundary, so the guarded versions introduce no jump.
    expect(dim / (2 * scale) - dim / 2).toBeCloseTo(centered, 10);
    expect(dim / 2 - (viewport - dim / 2) / scale).toBeCloseTo(centered, 10);
    expect(spectatorAxisMinOffset(dim, viewport, scale, 1)).toBeCloseTo(
      centered,
      10,
    );
    expect(spectatorAxisMaxOffset(dim, viewport, scale, 1)).toBeCloseTo(
      centered,
      10,
    );
  });

  it("covering axes are byte-for-byte unchanged by the guard", () => {
    const dim = 2000;
    const viewport = 1600;
    const scale = 0.9; // dim*scale = 1800 > 1600: the normal covering case
    expect(spectatorAxisMinOffset(dim, viewport, scale, 1)).toBe(
      dim / (2 * scale) - dim / 2,
    );
    expect(spectatorAxisMaxOffset(dim, viewport, scale, 1)).toBe(
      dim / 2 - (viewport - dim / 2) / scale,
    );
  });
});

describe("TransformHandler.updateCanvasBoundingRect — resize refreshes spectator fill/floor (fullscreen twitch, 2026-08-10)", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)
      .__PROXYWAR_AI_REPLAY__;
  });

  it("REGRESSION: after entering fullscreen, zoom-out floors at the NEW viewport's whole-map scale, not the stale pre-fullscreen floor", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    const mapWidth = 1000;
    const mapHeight = 1000;
    const canvas = makeCanvas(800, 600); // small pre-fullscreen window
    const transform = new TransformHandler(
      makeGameView(mapWidth, mapHeight),
      new EventBus(),
      canvas,
    );

    // "Enter fullscreen": the only DOM consequence is a new bounding rect,
    // then GameRenderer.resizeCanvas() calls updateCanvasBoundingRect().
    canvas.getBoundingClientRect = () =>
      ({
        width: 1920,
        height: 1080,
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    transform.updateCanvasBoundingRect();

    // A hard zoom-out must stop at the REFRESHED floor:
    // containScale(min(1920,1080)/1000 = 1.08) * 0.85 = 0.918 — not the
    // stale pre-fullscreen floor (600/1000)*0.85 = 0.51.
    transform.onZoom(new ZoomEvent(960, 540, 1e9));
    expect(transform.scale).toBeCloseTo(1.08 * 0.85, 6);
  });

  it("REGRESSION: zooming back in from the fullscreen whole-board view keeps the (smaller-than-viewport) map centered — no per-tick clamp oscillation", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    const mapWidth = 1000;
    const mapHeight = 1000;
    const canvas = makeCanvas(800, 600);
    const transform = new TransformHandler(
      makeGameView(mapWidth, mapHeight),
      new EventBus(),
      canvas,
    );
    canvas.getBoundingClientRect = () =>
      ({
        width: 1920,
        height: 1080,
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    transform.updateCanvasBoundingRect();
    transform.onZoom(new ZoomEvent(960, 540, 1e9)); // out to the floor

    // Zoom back in at the viewport center in many small steps, crossing
    // the whole formerly-twitching band. The pre-fix inverted bounds
    // clamped the offset to ~+44.7 (tight min) and ~-501 (tight max) on
    // ALTERNATING ticks — a ~500-world-unit slam per wheel step. A smooth
    // center-anchored zoom moves the implied offset only a few units per
    // step (mid-blend drift included), so a generous 100-unit per-tick
    // ceiling separates the two behaviors by almost an order of magnitude.
    let previousImpliedOffsetX: number | null = null;
    for (let i = 0; i < 40; i++) {
      transform.onZoom(new ZoomEvent(960, 540, -60));
      const scale = transform.scale;
      const [topLeft] = transform.screenBoundingRect();
      const impliedOffsetX =
        topLeft.x + mapWidth / (2 * scale) - mapWidth / 2;
      if (previousImpliedOffsetX !== null) {
        expect(
          Math.abs(impliedOffsetX - previousImpliedOffsetX),
        ).toBeLessThanOrEqual(100);
      }
      previousImpliedOffsetX = impliedOffsetX;
    }
    // The loop must actually have crossed into covering territory, or the
    // assertion above never exercised the transition.
    expect(transform.scale * mapWidth).toBeGreaterThan(1920);
  });
});

describe("embedded spectator frames land the whole-map contain fit (Softmax Observatory embeds, 2026-08-10)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>)
      .__PROXYWAR_AI_REPLAY__;
  });

  it("isEmbeddedSpectatorFrame() is false for a top-level window and true when window.top is a different window", () => {
    expect(isEmbeddedSpectatorFrame()).toBe(false);
    vi.stubGlobal("top", {} as Window);
    expect(isEmbeddedSpectatorFrame()).toBe(true);
  });

  it("REGRESSION: a framed cover-eligible spectator viewport lands contain*fit (whole map visible), not the cover crop", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    // 1600x900 viewport vs 2000x1000 map: aspect deviation 0.889 — inside
    // the cover band, so an UNframed spectator page lands coverScale 0.9.
    // Framed, the whole board must be visible: containScale 0.8 * 0.95.
    vi.stubGlobal("top", {} as Window);
    const transform = new TransformHandler(
      makeGameView(2000, 1000),
      new EventBus(),
      makeCanvas(1600, 900),
    );
    expect(transform.scale).toBeCloseTo(0.8 * 0.95, 6);
  });

  it("the same viewport UNframed still lands the cover fit — our own full-page spectator surfaces are unchanged", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    const transform = new TransformHandler(
      makeGameView(2000, 1000),
      new EventBus(),
      makeCanvas(1600, 900),
    );
    expect(transform.scale).toBeCloseTo(0.9, 6);
  });

  it("the Coworld /client/replay route (the Observatory-facing surface) lands contain even when opened TOP-LEVEL — Softmax controls its presentation, not us", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    window.history.pushState({}, "", "/client/replay");
    try {
      const transform = new TransformHandler(
        makeGameView(2000, 1000),
        new EventBus(),
        makeCanvas(1600, 900),
      );
      expect(transform.scale).toBeCloseTo(0.8 * 0.95, 6);
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("the standalone static replay viewer (window.__PROXYWAR_STATIC_REPLAY__ — the bundle Observatory opens for finished replays) lands contain even top-level", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    (window as unknown as Record<string, unknown>).__PROXYWAR_STATIC_REPLAY__ =
      true;
    try {
      const transform = new TransformHandler(
        makeGameView(2000, 1000),
        new EventBus(),
        makeCanvas(1600, 900),
      );
      expect(transform.scale).toBeCloseTo(0.8 * 0.95, 6);
    } finally {
      delete (window as unknown as Record<string, unknown>)
        .__PROXYWAR_STATIC_REPLAY__;
    }
  });
});
