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
});
