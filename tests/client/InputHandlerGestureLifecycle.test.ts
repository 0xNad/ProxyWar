import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DragEvent,
  InputHandler,
  TouchEvent,
  ZOOM_DELTA_DIVISOR,
  ZoomEvent,
} from "../../src/client/InputHandler";
import type { UIState } from "../../src/client/graphics/UIState";
import { EventBus } from "../../src/core/EventBus";
import { UnitType } from "../../src/core/game/Game";
import type { GameView } from "../../src/core/game/GameView";

function fakePointer(
  pointerId: number,
  x: number,
  y: number,
  type = "pointermove",
): PointerEvent {
  const event = new Event(type, { cancelable: true }) as PointerEvent;
  Object.assign(event, {
    pointerId,
    pointerType: "touch",
    button: 0,
    clientX: x,
    clientY: y,
    x,
    y,
  });
  return event;
}

function dispatchGesture(
  canvas: HTMLCanvasElement,
  type: string,
  scale: number,
  x = 0,
  y = 0,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { scale, clientX: x, clientY: y });
  canvas.dispatchEvent(event);
  return event;
}

function setup() {
  const eventBus = new EventBus();
  const gameView = {
    config: () => ({
      isUnitDisabled: (unit: UnitType) => unit === UnitType.Warship,
    }),
    inSpawnPhase: () => false,
    myPlayer: () => null,
  } as unknown as GameView;
  const canvas = document.createElement("canvas");
  const captures = new Set<number>();
  canvas.setPointerCapture = vi.fn((id: number) => captures.add(id));
  canvas.hasPointerCapture = vi.fn((id: number) => captures.has(id));
  canvas.releasePointerCapture = vi.fn((id: number) => captures.delete(id));
  const handler = new InputHandler(gameView, {} as UIState, canvas, eventBus);
  handler.initialize();
  return { handler, canvas, eventBus };
}

type InputHooks = {
  onPointerDown(event: PointerEvent): void;
  onPointerMove(event: PointerEvent): void;
  onPointerUp(event: PointerEvent): void;
  onPointerCancel(event: PointerEvent): void;
  onLostPointerCapture(event: PointerEvent): void;
};

const liveHandlers: InputHandler[] = [];

afterEach(() => {
  for (const handler of liveHandlers.splice(0)) handler.dispose();
});

describe("InputHandler multi-pointer lifecycle", () => {
  it("captures both pointers, suppresses pinch-release taps, and preserves the remaining pointer for one-finger pan", () => {
    const { handler, canvas, eventBus } = setup();
    liveHandlers.push(handler);
    const hooks = handler as unknown as InputHooks;
    const drags: DragEvent[] = [];
    const taps: TouchEvent[] = [];
    eventBus.on(DragEvent, (event) => drags.push(event));
    eventBus.on(TouchEvent, (event) => taps.push(event));

    hooks.onPointerDown(fakePointer(1, 100, 100, "pointerdown"));
    hooks.onPointerDown(fakePointer(2, 200, 100, "pointerdown"));
    expect(canvas.setPointerCapture).toHaveBeenCalledTimes(2);

    hooks.onPointerUp(fakePointer(2, 200, 100, "pointerup"));
    hooks.onPointerMove(fakePointer(1, 107, 104));
    expect(drags.at(-1)).toMatchObject({ deltaX: 7, deltaY: 4 });

    hooks.onPointerUp(fakePointer(1, 107, 104, "pointerup"));
    expect(taps).toHaveLength(0);
    expect(canvas.releasePointerCapture).toHaveBeenCalledTimes(2);
  });

  it("treats pointercancel and unexpected lost capture as cleanup, never as taps", () => {
    const { handler, eventBus } = setup();
    liveHandlers.push(handler);
    const hooks = handler as unknown as InputHooks;
    const taps: TouchEvent[] = [];
    eventBus.on(TouchEvent, (event) => taps.push(event));

    hooks.onPointerDown(fakePointer(1, 20, 20, "pointerdown"));
    hooks.onPointerCancel(fakePointer(1, 20, 20, "pointercancel"));
    hooks.onPointerDown(fakePointer(2, 30, 30, "pointerdown"));
    hooks.onLostPointerCapture(fakePointer(2, 30, 30, "lostpointercapture"));

    expect(taps).toHaveLength(0);
  });
});

describe("InputHandler Safari gesture zoom", () => {
  it("converts cumulative Safari pinch scale into exponential zoom deltas at the gesture focal point", () => {
    const { handler, canvas, eventBus } = setup();
    liveHandlers.push(handler);
    const zooms: ZoomEvent[] = [];
    eventBus.on(ZoomEvent, (event) => zooms.push(event));

    dispatchGesture(canvas, "gesturestart", 1);
    dispatchGesture(canvas, "gesturechange", 1.2, 321, 123);
    dispatchGesture(canvas, "gesturechange", 1.44, 321, 123);

    expect(zooms).toHaveLength(2);
    expect(zooms[0]).toMatchObject({ x: 321, y: 123 });
    expect(zooms[0].delta).toBeLessThan(0);
    expect(zooms[1].delta).toBeCloseTo(zooms[0].delta, 10);
    expect(Math.exp(-zooms[0].delta / ZOOM_DELTA_DIVISOR)).toBeCloseTo(1.2, 10);
  });

  it("prevents page zoom, resets at gestureend, and defers to an active pointer pinch", () => {
    const { handler, canvas, eventBus } = setup();
    liveHandlers.push(handler);
    const hooks = handler as unknown as InputHooks;
    const zooms: ZoomEvent[] = [];
    eventBus.on(ZoomEvent, (event) => zooms.push(event));

    const start = dispatchGesture(canvas, "gesturestart", 1);
    hooks.onPointerDown(fakePointer(1, 100, 100, "pointerdown"));
    hooks.onPointerDown(fakePointer(2, 200, 100, "pointerdown"));
    const change = dispatchGesture(canvas, "gesturechange", 2);
    const end = dispatchGesture(canvas, "gestureend", 2);

    expect(zooms).toHaveLength(0);
    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(end.defaultPrevented).toBe(true);

    hooks.onPointerUp(fakePointer(1, 100, 100, "pointerup"));
    hooks.onPointerUp(fakePointer(2, 200, 100, "pointerup"));
    dispatchGesture(canvas, "gesturechange", 2.2);
    expect(zooms).toHaveLength(0);
  });
});
