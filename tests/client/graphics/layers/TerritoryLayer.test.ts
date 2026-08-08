import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { TerritoryLayer } from "../../../../src/client/graphics/layers/TerritoryLayer";
import type { TransformHandler } from "../../../../src/client/graphics/TransformHandler";
import { DragEvent } from "../../../../src/client/InputHandler";
import { EventBus } from "../../../../src/core/EventBus";
import type { GameView } from "../../../../src/core/game/GameView";

/** Minimal GameView mock: only what TerritoryLayer's constructor/init()/
 * renderLayer() actually read for this test (no tiles, no spawn phase, no
 * pending updates -- the drag-gating behavior under test doesn't depend on
 * any of that). */
function makeGameView(width: number, height: number): GameView {
  return {
    config: () => ({ theme: () => ({}) }),
    width: () => width,
    height: () => height,
    forEachTile: () => {},
    inSpawnPhase: () => false,
  } as unknown as GameView;
}

/** Minimal TransformHandler mock: renderLayer() only reads
 * screenBoundingRect() to size the putImageData region; the real pan/zoom
 * math is TransformHandler's own concern (see TransformHandler.test.ts). */
function makeTransformHandler(width: number, height: number): TransformHandler {
  return {
    screenBoundingRect: () => [
      { x: 0, y: 0 },
      { x: width - 1, y: height - 1 },
    ],
  } as unknown as TransformHandler;
}

/**
 * A `DragEvent` must suppress the territory-bitmap refresh
 * (`renderTerritory()` + `context.putImageData(...)`) for
 * `nodrawDragDuration` (200ms), falling back to the cheap `drawImage`
 * re-composite only; the refresh resumes on the next render once that
 * window elapses with no further `DragEvent`.
 */
describe("TerritoryLayer drag-pause territory refresh", () => {
  let putImageDataSpy: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    putImageDataSpy = vi.spyOn(
      CanvasRenderingContext2D.prototype,
      "putImageData",
    );
  });

  afterEach(() => {
    putImageDataSpy.mockRestore();
    vi.useRealTimers();
  });

  it("suppresses the territory refresh while a drag is in progress, then resumes once it settles", () => {
    const eventBus = new EventBus();
    const game = makeGameView(64, 64);
    const transformHandler = makeTransformHandler(64, 64);
    const layer = new TerritoryLayer(game, eventBus, transformHandler);
    layer.init(); // constructs the internal canvas/imageData and may putImageData once itself

    const screenCanvas = document.createElement("canvas");
    const screenContext = screenCanvas.getContext("2d")!;
    putImageDataSpy.mockClear();

    // A held, moving pointer emits DragEvent (see InputHandler.onPointerMove) --
    // this is what the report calls "drags to pan (not drop)".
    eventBus.emit(new DragEvent(-10, 0));

    layer.renderLayer(screenContext);
    expect(putImageDataSpy).not.toHaveBeenCalled();

    // Still mid-drag, well inside the 200ms window: still suppressed.
    vi.advanceTimersByTime(150);
    layer.renderLayer(screenContext);
    expect(putImageDataSpy).not.toHaveBeenCalled();

    // Drag has settled (no further DragEvent) and nodrawDragDuration elapsed:
    // the refresh must resume on the very next render.
    vi.advanceTimersByTime(51);
    layer.renderLayer(screenContext);
    expect(putImageDataSpy).toHaveBeenCalledTimes(1);
  });

  it("resets the suppression window on every new DragEvent (a continuous drag never lets the refresh through)", () => {
    const eventBus = new EventBus();
    const game = makeGameView(64, 64);
    const transformHandler = makeTransformHandler(64, 64);
    const layer = new TerritoryLayer(game, eventBus, transformHandler);
    layer.init();

    const screenCanvas = document.createElement("canvas");
    const screenContext = screenCanvas.getContext("2d")!;
    putImageDataSpy.mockClear();

    eventBus.emit(new DragEvent(-10, 0));
    vi.advanceTimersByTime(150);
    eventBus.emit(new DragEvent(-10, 0)); // pointer still moving: re-arms the 200ms window
    vi.advanceTimersByTime(150);

    layer.renderLayer(screenContext);
    expect(putImageDataSpy).not.toHaveBeenCalled();
  });
});
