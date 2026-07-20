import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientGameRunner } from "../../src/client/ClientGameRunner";

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
    let updateCallback: ((update: never) => void) | null = null;
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
    const soundManager = {
      playBackgroundMusic: vi.fn(),
      dispose: vi.fn(),
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
      soundManager as never,
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
      {} as never,
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
});
