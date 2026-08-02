import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReplaySpeedChangeEvent } from "../../../src/client/InputHandler";
import { ReplayPresentationCadenceEvent } from "../../../src/client/graphics/ReplayPresentationSmoothing";
import { TransformHandler } from "../../../src/client/graphics/TransformHandler";
import { UnitLayer } from "../../../src/client/graphics/layers/UnitLayer";
import { ReplaySpeedMultiplier } from "../../../src/client/utilities/ReplaySpeedMultiplier";
import { EventBus } from "../../../src/core/EventBus";
import { Config, Theme } from "../../../src/core/configuration/Config";
import { GameUpdates, UnitType } from "../../../src/core/game/Game";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import { GameView, UnitView } from "../../../src/core/game/GameView";

const spriteLoaderMocks = vi.hoisted(() => ({
  getColoredSprite: vi.fn(),
  isSpriteReady: vi.fn(() => true),
  loadAllSprites: vi.fn(async () => undefined),
}));

vi.mock("../../../src/client/graphics/SpriteLoader", () => spriteLoaderMocks);

interface UnitLayerInternals {
  context: CanvasRenderingContext2D;
  replayUnitTransitionMs: number;
}

function createHarness(isReplay: boolean) {
  let catchingUp = false;
  let units: UnitView[] = [];
  const positions = new Map([
    [1, { x: 10, y: 20 }],
    [2, { x: 20, y: 20 }],
  ]);
  const sprite = document.createElement("canvas");
  sprite.width = 4;
  sprite.height = 4;
  spriteLoaderMocks.getColoredSprite.mockReturnValue(sprite);

  const unit = {
    id: () => 7,
    isActive: () => true,
    lastTile: () => 1,
    targetable: () => true,
    tile: () => 2,
    type: () => UnitType.TradeShip,
  } as unknown as UnitView;
  const theme = {} as Theme;
  const config = {
    isReplay: () => isReplay,
    theme: () => theme,
  } as Config;
  const updates = {
    [GameUpdateType.Unit]: [{ id: unit.id() }],
  } as unknown as GameUpdates;
  const game = {
    config: () => config,
    height: () => 100,
    isCatchingUp: () => catchingUp,
    motionPlannedUnitIds: () => [],
    unit: (id: number) => units.find((candidate) => candidate.id() === id),
    units: () => units,
    updatesSinceLastTick: () => updates,
    width: () => 100,
    x: (tile: number) => positions.get(tile)?.x ?? 0,
    y: (tile: number) => positions.get(tile)?.y ?? 0,
  } as unknown as GameView;
  const eventBus = new EventBus();
  const layer = new UnitLayer(game, eventBus, {} as TransformHandler);

  // Initialize blank canvases and event subscriptions first, then introduce
  // the unit through the same tick path used after an authoritative update.
  layer.init();
  units = [unit];
  layer.tick();

  return {
    layer,
    eventBus,
    setCatchingUp(value: boolean) {
      catchingUp = value;
    },
    sprite,
  };
}

function spriteDrawCall(
  spy: ReturnType<typeof vi.spyOn>,
  sprite: HTMLCanvasElement,
) {
  return (spy.mock.calls as unknown[][]).find((call) => call[0] === sprite);
}

describe("UnitLayer replay presentation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    spriteLoaderMocks.getColoredSprite.mockReset();
    spriteLoaderMocks.isSpriteReady.mockReset();
    spriteLoaderMocks.isSpriteReady.mockReturnValue(true);
  });

  it("draws replay sprites between turns and snaps while catching up", () => {
    let nowMs = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const { layer, setCatchingUp, sprite } = createHarness(true);
    const context = document.createElement("canvas").getContext("2d")!;
    const drawImage = vi.spyOn(context, "drawImage");

    layer.renderLayer(context);
    // Source x=10, centered world x=-40, sprite half-width=2.
    expect(spriteDrawCall(drawImage, sprite)?.[1]).toBeCloseTo(-42);

    drawImage.mockClear();
    nowMs += 45;
    layer.renderLayer(context);
    // Halfway through the 90ms 1x presentation window.
    expect(spriteDrawCall(drawImage, sprite)?.[1]).toBeCloseTo(-37);

    drawImage.mockClear();
    setCatchingUp(true);
    nowMs += 1;
    layer.renderLayer(context);
    // Catch-up never animates a backlog: snap to authoritative target x=20.
    expect(spriteDrawCall(drawImage, sprite)?.[1]).toBeCloseTo(-32);
  });

  it("seeds redraws at the authoritative target instead of replaying the last step", () => {
    let nowMs = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const { layer, sprite } = createHarness(true);
    const context = document.createElement("canvas").getContext("2d")!;
    const drawImage = vi.spyOn(context, "drawImage");

    layer.renderLayer(context);
    drawImage.mockClear();
    nowMs += 45;
    layer.renderLayer(context);
    expect(spriteDrawCall(drawImage, sprite)?.[1]).toBeCloseTo(-37);

    drawImage.mockClear();
    layer.redraw();
    layer.renderLayer(context);

    // A redraw is a presentation discontinuity. Seed at current x=20 rather
    // than briefly jumping back toward lastTile x=10.
    expect(spriteDrawCall(drawImage, sprite)?.[1]).toBeCloseTo(-32);
  });

  it("retimes units below fixed Premiere 2x and 4x presentation intervals", () => {
    let nowMs = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const { eventBus, layer, sprite } = createHarness(true);
    const internal = layer as unknown as UnitLayerInternals;
    const context = document.createElement("canvas").getContext("2d")!;
    const drawImage = vi.spyOn(context, "drawImage");

    eventBus.emit(new ReplayPresentationCadenceEvent(50));
    expect(internal.replayUnitTransitionMs).toBe(45);
    expect(internal.replayUnitTransitionMs).toBeLessThan(50);
    layer.renderLayer(context);
    drawImage.mockClear();
    nowMs += 22.5;
    layer.renderLayer(context);
    expect(spriteDrawCall(drawImage, sprite)?.[1]).toBeCloseTo(-37);

    eventBus.emit(new ReplayPresentationCadenceEvent(25));
    expect(internal.replayUnitTransitionMs).toBe(23);
    expect(internal.replayUnitTransitionMs).toBeLessThan(25);

    // Live Premiere pacing is immutable even if a viewer speed event leaks
    // through the shared event bus.
    eventBus.emit(new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.normal));
    expect(internal.replayUnitTransitionMs).toBe(23);
  });

  it("keeps ordinary play on the existing tick-rendered canvas path", () => {
    const { layer, sprite } = createHarness(false);
    const internalContext = (layer as unknown as UnitLayerInternals).context;
    const staticDrawImage = vi.spyOn(internalContext, "drawImage");

    layer.tick();
    const staticSpriteCall = spriteDrawCall(staticDrawImage, sprite);
    expect(staticSpriteCall?.[1]).toBe(18);
    expect(staticSpriteCall?.[2]).toBe(18);

    const frameContext = document.createElement("canvas").getContext("2d")!;
    const frameDrawImage = vi.spyOn(frameContext, "drawImage");
    layer.renderLayer(frameContext);
    expect(spriteDrawCall(frameDrawImage, sprite)).toBeUndefined();
  });
});
