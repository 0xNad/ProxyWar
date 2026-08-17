import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/configuration/ConfigLoader", () => ({
  getServerConfigFromServer: () => ({
    otelEnabled: () => false,
    otelAuthHeader: () => "",
    otelEndpoint: () => "",
    env: () => 0, // GameEnv.Dev
  }),
  getServerConfig: () => ({
    otelEnabled: () => false,
  }),
}));

import { GameEnv } from "../../src/core/configuration/Config";
import { GameManager } from "../../src/server/GameManager";
import { GamePhase } from "../../src/server/GameServer";

/**
 * The PRODUCTION start path, which a direct `GameServer.start()` test cannot cover.
 *
 * `GameManager.tick()` calls `prestart()` and only then schedules `start()` two
 * seconds later. `prestart()` sets `_hasPrestarted`, and `hasStarted()` returns
 * `_hasStarted || _hasPrestarted` - so once prestart has run, the guard in `tick()`
 * never considers this game again. If the delayed `start()` fails and the manager
 * only logs it, the game is stuck forever: clients were told to start loading, the
 * entry stays in the map, and nothing retries or ends it.
 *
 * Deliberately NOT mocking `GameStartInfoSchema`. `GameLifecycle.test.ts` stubs it to
 * always succeed, which is exactly why an invalid game id never mattered there.
 */
describe("GameManager: a game that cannot start", () => {
  let logger: {
    child: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let config: { turnIntervalMs: () => number; env: () => GameEnv };

  beforeEach(() => {
    vi.useFakeTimers();
    logger = {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    config = { turnIntervalMs: () => 100, env: () => GameEnv.Dev };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function managerWithGame(gameID: string) {
    const manager = new GameManager(config as never, logger as never);
    // Default config is a PRIVATE game, whose phase is Lobby until it starts, so the
    // phase is stubbed to Active rather than reconstructed from ping/client internals.
    // Everything the test actually exercises stays real: tick() calls the real
    // prestart(), schedules the real start(), and the real GameStartInfoSchema decides.
    const game = manager.createGame(gameID, undefined);
    expect(game).not.toBeNull();
    vi.spyOn(game!, "phase").mockReturnValue(GamePhase.Active);
    return { manager, game: game! };
  }

  it("ends the game and drops it, instead of leaving clients waiting forever", () => {
    // 20 characters: fails GAME_ID_REGEX, so GameStartInfoSchema rejects the start
    // info and start() throws.
    const gameID = "MANAGER_UNSTARTABLE1";
    const { manager, game } = managerWithGame(gameID);
    const endSpy = vi.spyOn(game, "end").mockResolvedValue(undefined);

    manager.tick();
    // prestart ran, so nothing will ever retry this game.
    expect(game.hasStarted()).toBe(true);
    expect(manager.activeGames()).toBe(1);

    vi.advanceTimersByTime(2_000);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`error starting game ${gameID}`),
    );
    // Ended with archiving skipped: it never produced a turn.
    expect(endSpy).toHaveBeenCalledWith({ archive: false });
    // And removed, so the map does not leak and no later tick sees a zombie.
    expect(manager.game(gameID)).toBeNull();
    expect(manager.activeGames()).toBe(0);
  });

  it("leaves a startable game alone", () => {
    // The same path with a valid id must still start and stay.
    const gameID = "MANAGER1";
    const { manager, game } = managerWithGame(gameID);
    const endSpy = vi.spyOn(game, "end").mockResolvedValue(undefined);

    manager.tick();
    vi.advanceTimersByTime(2_000);

    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining("error starting game"),
    );
    expect(endSpy).not.toHaveBeenCalled();
    expect(manager.game(gameID)).not.toBeNull();
  });
});
