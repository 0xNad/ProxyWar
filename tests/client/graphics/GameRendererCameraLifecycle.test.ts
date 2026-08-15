import { afterEach, describe, expect, it, vi } from "vitest";
import { GameRenderer } from "../../../src/client/graphics/GameRenderer";
import type { PerformanceOverlay } from "../../../src/client/graphics/layers/PerformanceOverlay";
import type { TransformHandler } from "../../../src/client/graphics/TransformHandler";
import type { UIState } from "../../../src/client/graphics/UIState";
import { EventBus } from "../../../src/core/EventBus";
import type { GameView } from "../../../src/core/game/GameView";

function makeRenderer(intentEpoch: number) {
  const canvas = document.createElement("canvas");
  canvas.getContext = vi.fn(() => ({})) as never;
  const transform = {
    userCameraIntentEpoch: vi.fn(() => intentEpoch),
    updateBroadcastLayout: vi.fn(),
    centerAll: vi.fn(),
    updateCanvasBoundingRect: vi.fn(),
    dispose: vi.fn(),
  } as unknown as TransformHandler;
  const renderer = new GameRenderer(
    {} as GameView,
    new EventBus(),
    canvas,
    transform,
    {} as UIState,
    [],
    {} as PerformanceOverlay,
  );
  return { renderer, transform };
}

type RendererHooks = {
  refitBoardToViewport(): void;
  onFullscreenChange(): void;
};

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__;
  vi.unstubAllGlobals();
});

describe("GameRenderer replay camera resize lifecycle", () => {
  it("preserves a manually altered camera while still refreshing broadcast layout", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    const { renderer, transform } = makeRenderer(2);
    const hooks = renderer as unknown as RendererHooks;

    hooks.refitBoardToViewport();

    expect(transform.centerAll).not.toHaveBeenCalled();
    expect(transform.updateBroadcastLayout).toHaveBeenCalledWith(0.9);
  });

  it("still refits an untouched replay camera", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    const { renderer, transform } = makeRenderer(0);
    const hooks = renderer as unknown as RendererHooks;

    hooks.refitBoardToViewport();

    expect(transform.centerAll).toHaveBeenCalledWith(0.9);
    expect(transform.updateBroadcastLayout).not.toHaveBeenCalled();
  });

  it("makes the second deferred fullscreen frame a no-op after dispose", () => {
    (window as unknown as Record<string, unknown>).__PROXYWAR_AI_REPLAY__ =
      true;
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    const { renderer, transform } = makeRenderer(0);
    const hooks = renderer as unknown as RendererHooks;

    hooks.onFullscreenChange();
    callbacks.get(1)?.(0); // schedules the second frame
    renderer.dispose();
    callbacks.get(2)?.(0); // emulate a callback already dequeued by the browser

    expect(transform.updateCanvasBoundingRect).not.toHaveBeenCalled();
    expect(transform.centerAll).not.toHaveBeenCalled();
  });
});
