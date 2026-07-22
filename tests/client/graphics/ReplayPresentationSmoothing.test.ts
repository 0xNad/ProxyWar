import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplaySpeedChangeEvent } from "../../../src/client/InputHandler";
import {
  REPLAY_NAME_MAX_TRANSITION_MS,
  REPLAY_NAME_POSITION_REFRESH_MS,
  REPLAY_UNIT_MAX_INTERPOLATION_TILES,
  ReplayPresentationCadenceEvent,
  replayPresentationIntervalMsForPlaybackRate,
  replayPresentationTransitionDurationForIntervalMs,
  replayPresentationTransitionDurationMs,
  retargetReplayUnitPresentationMotion,
  retimeReplayUnitPresentationMotion,
  sampleReplayUnitPresentationMotion,
} from "../../../src/client/graphics/ReplayPresentationSmoothing";
import { TransformHandler } from "../../../src/client/graphics/TransformHandler";
import { NameLayer } from "../../../src/client/graphics/layers/NameLayer";
import { ReplaySpeedMultiplier } from "../../../src/client/utilities/ReplaySpeedMultiplier";
import { EventBus } from "../../../src/core/EventBus";
import { Config, Theme } from "../../../src/core/configuration/Config";
import { GameView, PlayerView } from "../../../src/core/game/GameView";

describe("replayPresentationTransitionDurationMs", () => {
  it("fills normal-speed turn gaps without running into the next target", () => {
    const duration = replayPresentationTransitionDurationMs(
      ReplaySpeedMultiplier.normal,
    );

    expect(duration).toBe(90);
    expect(duration).toBeLessThan(REPLAY_NAME_POSITION_REFRESH_MS);
  });

  it("shortens at 2x and disables smoothing at max speed", () => {
    expect(
      replayPresentationTransitionDurationMs(ReplaySpeedMultiplier.fast),
    ).toBe(45);
    expect(
      replayPresentationTransitionDurationMs(ReplaySpeedMultiplier.fastest),
    ).toBe(0);
  });

  it("binds Premiere 2x and 4x smoothing below their committed cadence", () => {
    const twoTimesCadenceMs = replayPresentationIntervalMsForPlaybackRate(2);
    const fourTimesCadenceMs = replayPresentationIntervalMsForPlaybackRate(4);

    expect(twoTimesCadenceMs).toBe(50);
    expect(fourTimesCadenceMs).toBe(25);
    expect(
      replayPresentationTransitionDurationForIntervalMs(twoTimesCadenceMs),
    ).toBe(45);
    expect(
      replayPresentationTransitionDurationForIntervalMs(fourTimesCadenceMs),
    ).toBe(23);
    expect(
      replayPresentationTransitionDurationForIntervalMs(twoTimesCadenceMs),
    ).toBeLessThan(twoTimesCadenceMs);
    expect(
      replayPresentationTransitionDurationForIntervalMs(fourTimesCadenceMs),
    ).toBeLessThan(fourTimesCadenceMs);
  });

  it("caps slow playback and rejects invalid multipliers", () => {
    expect(
      replayPresentationTransitionDurationMs(ReplaySpeedMultiplier.slow),
    ).toBe(REPLAY_NAME_MAX_TRANSITION_MS);
    expect(replayPresentationTransitionDurationMs(Number.NaN)).toBe(0);
    expect(replayPresentationTransitionDurationMs(-1)).toBe(0);
  });
});

describe("replay unit presentation motion", () => {
  it("linearly fills the frames between two authoritative positions", () => {
    const motion = retargetReplayUnitPresentationMotion(
      null,
      { x: 0, y: 0 },
      { x: 10, y: 8 },
      1_000,
      100,
    );

    expect(sampleReplayUnitPresentationMotion(motion, 1_050)).toEqual({
      x: 5,
      y: 4,
    });
    expect(sampleReplayUnitPresentationMotion(motion, 1_100)).toEqual({
      x: 10,
      y: 8,
    });
  });

  it("retargets from the displayed point without jumping or predicting", () => {
    const first = retargetReplayUnitPresentationMotion(
      null,
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      0,
      100,
    );
    const second = retargetReplayUnitPresentationMotion(
      first,
      { x: 10, y: 0 },
      { x: 14, y: 0 },
      50,
      100,
    );

    expect(sampleReplayUnitPresentationMotion(second, 50)).toEqual({
      x: 5,
      y: 0,
    });
    expect(sampleReplayUnitPresentationMotion(second, 100)).toEqual({
      x: 9.5,
      y: 0,
    });
  });

  it("snaps seeks, catch-up jumps, and max-speed playback", () => {
    const discontinuity = retargetReplayUnitPresentationMotion(
      null,
      { x: 0, y: 0 },
      { x: REPLAY_UNIT_MAX_INTERPOLATION_TILES + 1, y: 0 },
      0,
      90,
    );
    expect(discontinuity.durationMs).toBe(0);
    expect(sampleReplayUnitPresentationMotion(discontinuity, 45)).toEqual(
      discontinuity.target,
    );

    const moving = retargetReplayUnitPresentationMotion(
      null,
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      0,
      90,
    );
    const maxSpeed = retimeReplayUnitPresentationMotion(moving, 20, 0);
    expect(maxSpeed.durationMs).toBe(0);
    expect(sampleReplayUnitPresentationMotion(maxSpeed, 20)).toEqual({
      x: 8,
      y: 0,
    });
  });
});

describe("NameLayer replay presentation", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("moves labels every 100ms and lets the compositor fill normal-speed gaps", () => {
    let nowMs = 1_000;
    let nameLocation = { x: 10, y: 20, size: 8 };
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    const player = {
      cosmetics: {},
      isAlive: () => true,
      nameLocation: () => nameLocation,
      numTilesOwned: () => 1,
    } as unknown as PlayerView;
    const theme = { font: () => "sans-serif" } as unknown as Theme;
    const config = {
      allianceDuration: () => 100,
      disableAlliances: () => false,
      isReplay: () => true,
      theme: () => theme,
    } as unknown as Config;
    const game = {
      config: () => config,
      myPlayer: () => null,
      playerViews: () => [player],
    } as unknown as GameView;
    const transform = {
      isOnScreen: () => false,
      scale: 1,
      worldToScreenCoordinates: () => ({ x: 0, y: 0 }),
    } as unknown as TransformHandler;
    const eventBus = new EventBus();
    const layer = new NameLayer(game, transform, eventBus);

    layer.init();
    layer.tick();
    layer.renderLayer();

    const element =
      document.querySelector<HTMLElement>(".player-name")?.parentElement;
    expect(element).not.toBeNull();
    expect(element?.style.transform).toContain("translate(10px, 20px)");
    expect(element?.style.transition).toBe("transform 90ms linear");

    nameLocation = { x: 30, y: 40, size: 8 };
    nowMs += REPLAY_NAME_POSITION_REFRESH_MS + 1;
    layer.renderLayer();

    expect(element?.style.transform).toContain("translate(30px, 40px)");

    eventBus.emit(new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.fast));
    expect(element?.style.transition).toBe("transform 45ms linear");
    eventBus.emit(new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.fastest));
    expect(element?.style.transition).toBe("none");
  });

  it("tracks fixed Premiere 2x and 4x cadence and ignores viewer speed events", () => {
    let nowMs = 1_000;
    let nameLocation = { x: 10, y: 20, size: 8 };
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    const player = {
      cosmetics: {},
      isAlive: () => true,
      nameLocation: () => nameLocation,
      numTilesOwned: () => 1,
    } as unknown as PlayerView;
    const theme = { font: () => "sans-serif" } as unknown as Theme;
    const config = {
      allianceDuration: () => 100,
      disableAlliances: () => false,
      isReplay: () => true,
      theme: () => theme,
    } as unknown as Config;
    const game = {
      config: () => config,
      myPlayer: () => null,
      playerViews: () => [player],
    } as unknown as GameView;
    const transform = {
      isOnScreen: () => false,
      scale: 1,
      worldToScreenCoordinates: () => ({ x: 0, y: 0 }),
    } as unknown as TransformHandler;
    const eventBus = new EventBus();
    const layer = new NameLayer(game, transform, eventBus);

    layer.init();
    layer.tick();
    eventBus.emit(new ReplayPresentationCadenceEvent(50));
    layer.renderLayer();

    const element =
      document.querySelector<HTMLElement>(".player-name")?.parentElement;
    expect(element?.style.transition).toBe("transform 45ms linear");

    nameLocation = { x: 30, y: 40, size: 8 };
    nowMs += 50;
    layer.renderLayer();
    expect(element?.style.transform).toContain("translate(30px, 40px)");

    eventBus.emit(new ReplayPresentationCadenceEvent(25));
    expect(element?.style.transition).toBe("transform 23ms linear");
    nameLocation = { x: 50, y: 60, size: 8 };
    nowMs += 25;
    layer.renderLayer();
    expect(element?.style.transform).toContain("translate(50px, 60px)");

    eventBus.emit(new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.normal));
    expect(element?.style.transition).toBe("transform 23ms linear");
  });

  it("keeps ordinary-play label transforms on the original content throttle", () => {
    let nowMs = 1_000;
    let nameLocation = { x: 10, y: 20, size: 8 };
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    const player = {
      cosmetics: {},
      displayName: () => "Player",
      id: () => 1,
      isDisconnected: () => false,
      isAlive: () => true,
      isTraitor: () => false,
      nameLocation: () => nameLocation,
      numTilesOwned: () => 1,
      troops: () => 100,
      units: () => [],
    } as unknown as PlayerView;
    const theme = {
      font: () => "sans-serif",
      textColor: () => "rgb(255, 255, 255)",
    } as unknown as Theme;
    const config = {
      allianceDuration: () => 100,
      disableAlliances: () => false,
      isReplay: () => false,
      theme: () => theme,
      userSettings: () => undefined,
    } as unknown as Config;
    const game = {
      config: () => config,
      myPlayer: () => null,
      playerViews: () => [player],
    } as unknown as GameView;
    const transform = {
      isOnScreen: () => true,
      scale: 1,
      worldToScreenCoordinates: () => ({ x: 0, y: 0 }),
    } as unknown as TransformHandler;
    const layer = new NameLayer(game, transform, new EventBus());

    layer.init();
    layer.tick();
    layer.renderLayer();
    const element =
      document.querySelector<HTMLElement>(".player-name")?.parentElement;
    expect(element?.style.transform).toContain("translate(10px, 20px)");
    expect(element?.style.transition).toBe("");

    nameLocation = { x: 30, y: 40, size: 8 };
    nowMs += REPLAY_NAME_POSITION_REFRESH_MS + 1;
    layer.renderLayer();
    expect(element?.style.transform).toContain("translate(10px, 20px)");

    nowMs += 500;
    layer.renderLayer();
    expect(element?.style.transform).toContain("translate(30px, 40px)");
  });
});
