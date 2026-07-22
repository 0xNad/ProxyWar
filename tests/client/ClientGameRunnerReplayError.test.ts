import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientGameRunner } from "../../src/client/ClientGameRunner";
import { TickMetricsEvent } from "../../src/client/InputHandler";
import { ReplayPremiereWorkerClient } from "../../src/client/ReplayPremiereWorkerClient";
import { GameUpdateType } from "../../src/core/game/GameUpdates";

describe("ClientGameRunner replay startup errors", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    history.replaceState(null, "", "/ai-league-replay/league-test");
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("signals the loading screen when a game update throws before a frame", () => {
    let updateCallback: (update: never) => void = () => {
      throw new Error("Replay worker callback was not registered");
    };
    const eventBus = { on: vi.fn(), emit: vi.fn() };
    const renderer = { initialize: vi.fn() };
    const input = { initialize: vi.fn() };
    const transport = {
      updateCallback: vi.fn(),
      rejoinGame: vi.fn(),
      leaveGame: vi.fn(),
    };
    const worker = {
      start: vi.fn((callback: (update: never) => void) => {
        updateCallback = callback;
      }),
      cleanup: vi.fn(),
    };
    const replayLoadError = vi.fn();
    document.addEventListener("ai-league-replay-load-error", replayLoadError, {
      once: true,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const runner = new ClientGameRunner(
      { gameID: "REPLAY01" } as never,
      undefined,
      eventBus as never,
      renderer as never,
      input as never,
      transport as never,
      worker as never,
      {} as never,
    );
    runner.start();

    expect(updateCallback).not.toBeNull();
    expect(() => updateCallback?.({} as never)).not.toThrow();
    expect(replayLoadError).toHaveBeenCalledOnce();
    expect(document.getElementById("error-modal")?.textContent).toContain(
      "missing gameStartInfo",
    );
    expect(worker.cleanup).toHaveBeenCalledOnce();
    expect(transport.leaveGame).toHaveBeenCalledOnce();
  });

  it("skips spawned players whose replay name location is not ready", () => {
    const replayFrame = vi.fn();
    document.addEventListener("ai-league-replay-frame", replayFrame, {
      once: true,
    });
    const missingLocationPlayer = {
      isAlive: () => true,
      hasSpawned: () => true,
      nameLocation: () => undefined,
    };
    const readyPlayer = {
      isAlive: () => true,
      hasSpawned: () => true,
      nameLocation: () => ({ x: 12, y: 34 }),
      id: () => "player-ready",
      smallID: () => 7,
      clientID: () => "client-ready",
      name: () => "Ready Agent",
      displayName: () => "Ready Agent",
      territoryColor: () => ({ toRgbString: () => "rgb(1, 2, 3)" }),
      numTilesOwned: () => 42,
      allies: () => [],
      targets: () => [],
      alliances: () => [],
      data: { embargoes: new Set<number>() },
    };
    const renderer = {
      transformHandler: {
        worldToScreenCoordinates: vi.fn(() => ({ x: 120, y: 340 })),
      },
    };
    const runner = new ClientGameRunner(
      { gameID: "REPLAY02", gameRecord: {} } as never,
      undefined,
      {} as never,
      renderer as never,
      {} as never,
      {} as never,
      {} as never,
      {
        players: () => [missingLocationPlayer, readyPlayer],
      } as never,
    );

    expect(() =>
      (
        runner as unknown as {
          dispatchAiLeagueReplayFrame(update: { tick: number }): void;
        }
      ).dispatchAiLeagueReplayFrame({ tick: 9 }),
    ).not.toThrow();
    expect(replayFrame).toHaveBeenCalledOnce();
    expect(
      (replayFrame.mock.calls[0]?.[0] as CustomEvent).detail,
    ).toMatchObject({
      tick: 9,
      players: [
        {
          playerID: "player-ready",
          username: "Ready Agent",
          x: 120,
          y: 340,
        },
      ],
    });
  });

  it("renders a coalesced premiere update once and acknowledges every logical turn", () => {
    history.replaceState(null, "", "/premiere/prem_0123456789abcdef");
    const replayFrame = vi.fn();
    document.addEventListener("ai-league-replay-frame", replayFrame, {
      once: true,
    });
    let updateCallback: (update: never) => void = () => {
      throw new Error("Replay worker callback was not registered");
    };
    const eventBus = { on: vi.fn(), emit: vi.fn() };
    const renderer = {
      initialize: vi.fn(),
      tick: vi.fn(),
      transformHandler: { centerAll: vi.fn() },
    };
    const input = { initialize: vi.fn() };
    const transport = {
      updateCallback: vi.fn(),
      rejoinGame: vi.fn(),
      leaveGame: vi.fn(),
      turnComplete: vi.fn(),
      turnsComplete: vi.fn(),
    };
    const worker = Object.assign(
      Object.create(ReplayPremiereWorkerClient.prototype),
      {
        start: vi.fn((callback: (update: never) => void) => {
          updateCallback = callback;
        }),
        cleanup: vi.fn(),
        completedTurnsForCurrentUpdate: () => 128,
        tickExecutionDurationsForCurrentUpdate: () => [4, 8, 12],
        processedSequence: () => 127,
      },
    );
    const gameView = {
      update: vi.fn(),
      inSpawnPhase: () => false,
      players: () => [],
    };
    const updates = Object.fromEntries(
      Object.values(GameUpdateType)
        .filter((value) => typeof value === "number")
        .map((type) => [type, []]),
    );
    const runner = new ClientGameRunner(
      {
        gameID: "PREM0001",
        gameStartInfo: { gameID: "PREM0001" },
        progressiveReplay: {},
      } as never,
      undefined,
      eventBus as never,
      renderer as never,
      input as never,
      transport as never,
      worker as never,
      gameView as never,
    );
    runner.start();

    updateCallback({
      tick: 128,
      updates,
      packedTileUpdates: new Uint32Array(),
      playerNameViewData: {},
      tickExecutionDuration: 12,
    } as never);

    expect(transport.turnComplete).not.toHaveBeenCalled();
    expect(transport.turnsComplete).toHaveBeenCalledOnce();
    expect(transport.turnsComplete).toHaveBeenCalledWith(128);
    expect(gameView.update).toHaveBeenCalledOnce();
    expect(renderer.tick).toHaveBeenCalledOnce();
    expect(renderer.tick.mock.invocationCallOrder[0]).toBeLessThan(
      transport.turnsComplete.mock.invocationCallOrder[0],
    );
    expect(
      (replayFrame.mock.calls[0]?.[0] as CustomEvent).detail,
    ).toMatchObject({ sequence: 127, turnNumber: 128 });
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining<TickMetricsEvent>({
        completedTicks: 128,
        tickExecutionDurations: [4, 8, 12],
      }),
    );
    runner.stop();
  });
});
