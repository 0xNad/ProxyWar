import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientGameRunner } from "../../src/client/ClientGameRunner";
import { REPLAY_RENDER_FAST_FORWARD_PARAM } from "../../src/client/ReplayRenderFastForward";
import { GameUpdateType } from "../../src/core/game/GameUpdates";

function emptyUpdates() {
  return Object.fromEntries(
    Object.values(GameUpdateType)
      .filter((value) => typeof value === "number")
      .map((type) => [type, []]),
  );
}

function gameUpdate(tick: number) {
  return {
    tick,
    updates: emptyUpdates(),
    packedTileUpdates: new Uint32Array(),
    playerNameViewData: {},
    tickExecutionDuration: 1,
  };
}

interface Harness {
  updateCallback: (update: never) => void;
  renderer: { tick: ReturnType<typeof vi.fn> };
  transport: { turnComplete: ReturnType<typeof vi.fn> };
  gameView: { update: ReturnType<typeof vi.fn> };
}

function mountRunner(lobby: Record<string, unknown>): Harness {
  let updateCallback: (update: never) => void = () => {
    throw new Error("worker callback was not registered");
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
  const worker = {
    start: vi.fn((callback: (update: never) => void) => {
      updateCallback = callback;
    }),
    cleanup: vi.fn(),
  };
  const gameView = {
    update: vi.fn(),
    inSpawnPhase: () => false,
    players: () => [],
  };
  const runner = new ClientGameRunner(
    lobby as never,
    undefined,
    eventBus as never,
    renderer as never,
    input as never,
    transport as never,
    worker as never,
    gameView as never,
  );
  runner.start();
  return {
    updateCallback: (update) => updateCallback(update),
    renderer,
    transport,
    gameView,
  };
}

describe("ClientGameRunner render fast-forward gating", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    history.replaceState(null, "", "/");
  });

  it("coalesces presentation below the target on a plain replay, then resumes the full pipeline", () => {
    history.replaceState(
      null,
      "",
      `/ai-league-replay/league-ffwd?${REPLAY_RENDER_FAST_FORWARD_PARAM}=1000`,
    );
    const harness = mountRunner({
      gameID: "FFWD0001",
      gameStartInfo: { gameID: "FFWD0001" },
      gameRecord: {},
    });

    // Below the target: consumed by the fast-forward lane. State application
    // and turn accounting stay exact; the renderer is NOT invoked per turn.
    for (let tick = 1; tick <= 5; tick++) {
      harness.updateCallback(gameUpdate(tick) as never);
    }
    expect(harness.transport.turnComplete).toHaveBeenCalledTimes(5);
    expect(harness.renderer.tick).not.toHaveBeenCalled();
    expect(harness.gameView.update).not.toHaveBeenCalled();

    // The boundary update flushes the coalesced prefix (one render pass) and
    // then runs the ordinary pipeline for itself (a second render pass).
    harness.updateCallback(gameUpdate(1000) as never);
    expect(harness.gameView.update).toHaveBeenCalledTimes(2);
    expect(harness.renderer.tick).toHaveBeenCalledTimes(2);
    expect(harness.transport.turnComplete).toHaveBeenCalledTimes(6);
    // The coalesced flush carries the buffered span's final tick.
    const flushed = harness.gameView.update.mock.calls[0][0] as {
      tick: number;
    };
    expect(flushed.tick).toBe(5);
  });

  it("ignores the parameter entirely without a plain gameRecord (premiere pages unaffected)", () => {
    history.replaceState(
      null,
      "",
      `/premiere/prem_0123456789abcdef?${REPLAY_RENDER_FAST_FORWARD_PARAM}=1000`,
    );
    const harness = mountRunner({
      gameID: "PREM0001",
      gameStartInfo: { gameID: "PREM0001" },
      progressiveReplay: {},
      gameRecord: undefined,
    });
    harness.updateCallback(gameUpdate(3) as never);
    // Full pipeline ran: the sealed premiere presentation is untouched by the
    // pacing parameter (it can only ever exist on plain-record replays).
    expect(harness.gameView.update).toHaveBeenCalledTimes(1);
    expect(harness.renderer.tick).toHaveBeenCalledTimes(1);
  });

  it("runs the ordinary per-turn pipeline when the parameter is absent", () => {
    history.replaceState(null, "", "/ai-league-replay/league-normal");
    const harness = mountRunner({
      gameID: "PLAIN001",
      gameStartInfo: { gameID: "PLAIN001" },
      gameRecord: {},
    });
    harness.updateCallback(gameUpdate(1) as never);
    harness.updateCallback(gameUpdate(2) as never);
    expect(harness.gameView.update).toHaveBeenCalledTimes(2);
    expect(harness.renderer.tick).toHaveBeenCalledTimes(2);
  });
});
