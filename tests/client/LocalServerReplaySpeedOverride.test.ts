import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LobbyConfig } from "../../src/client/ClientGameRunner";
import { ReplaySpeedChangeEvent } from "../../src/client/InputHandler";
import { LocalServer } from "../../src/client/LocalServer";
import { ReplaySpeedMultiplier } from "../../src/client/utilities/ReplaySpeedMultiplier";
import { EventBus } from "../../src/core/EventBus";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import {
  GameRecord,
  GameStartInfo,
  ServerMessage,
} from "../../src/core/Schemas";

function gameStartInfo(): GameStartInfo {
  return {
    gameID: "REPLAY001",
    lobbyCreatedAt: 10,
    config: {
      gameMap: GameMapType.Asia,
      gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA,
      gameType: GameType.Singleplayer,
      difficulty: Difficulty.Medium,
      nations: "disabled",
      donateGold: false,
      donateTroops: false,
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    },
    players: [{ clientID: "SEAT0001", username: "Alpha", clanTag: null }],
  } as unknown as GameStartInfo;
}

// Mirrors LocalServerReplayCatchUp.test.ts's own helper: an empty `turns`
// array with `num_turns: N` decompresses to N empty-intent turns.
function archivedGameRecord(numTurns: number): GameRecord {
  return {
    info: { num_turns: numTurns },
    turns: [],
  } as unknown as GameRecord;
}

function lobbyConfig(numTurns: number, turnIntervalMs = 1000): LobbyConfig {
  return {
    serverConfig: {
      turnIntervalMs: () => turnIntervalMs,
      workerPath: () => "worker",
    },
    cosmetics: {},
    playerName: "spectator",
    playerClanTag: null,
    playerRole: null,
    gameID: "REPLAY001",
    turnstileToken: null,
    gameStartInfo: gameStartInfo(),
    gameRecord: archivedGameRecord(numTurns),
  } as unknown as LobbyConfig;
}

// Mirrors LocalServerReplayCatchUp.test.ts's own helper: captures the pacing
// `setInterval` callback so the test drives it turn-by-turn instead of
// racing a real timer.
function startServerWithManualPacingTimer(config: LobbyConfig) {
  const messages: ServerMessage[] = [];
  const eventBus = new EventBus();
  const fakeSetInterval = globalThis.setInterval;
  let pacingTick: (() => void) | undefined;
  const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
    callback: TimerHandler,
    delay?: number,
  ) => {
    if (typeof callback !== "function") {
      throw new Error("expected a function pacing callback");
    }
    pacingTick = callback as () => void;
    return fakeSetInterval(() => {}, delay);
  }) as unknown as typeof setInterval);
  const server = new LocalServer(config, true, eventBus);
  server.updateCallback(
    () => {},
    (message) => messages.push(message),
  );
  server.start();
  intervalSpy.mockRestore();
  if (pacingTick === undefined) {
    throw new Error("missing LocalServer pacing callback");
  }
  const tick = pacingTick;
  return {
    server,
    eventBus,
    tickAt(nowMs: number) {
      vi.setSystemTime(nowMs);
      tick();
    },
    turnCount() {
      return messages.filter((m) => m.type === "turn").length;
    },
  };
}

describe("LocalServer replay-speed user override (P0 incident, 2026-08-03)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies an auto-sourced speed change (archived default) when the user has never touched speed", () => {
    // turnIntervalMs=1000: at the field-initializer default (`normal`, 1x)
    // a tick at t=0 and t=1 dispatches only the first turn (the pacing gate
    // starves until t=1000). An "auto" ReplaySpeedChangeEvent(fastest) must
    // still apply normally with no prior user interaction.
    const { eventBus, tickAt, turnCount } = startServerWithManualPacingTimer(
      lobbyConfig(10, 1000),
    );
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.fastest, "auto"),
    );
    tickAt(0);
    tickAt(1);
    expect(turnCount()).toBe(2);
  });

  it("house rule: once the user manually picks a speed, a later auto-sourced speed change must never revert it", () => {
    const { server, eventBus, tickAt, turnCount } =
      startServerWithManualPacingTimer(lobbyConfig(10, 1000));
    // User picks fastest (0-delay) themselves.
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.fastest, "user"),
    );
    tickAt(0);
    server.turnsComplete(1);
    tickAt(1);
    server.turnsComplete(1);
    expect(turnCount()).toBe(2);

    // A later automatic pacing decision tries to pin a
    // slower pace back down -- e.g. the exact "opening segment mounts and
    // re-asserts normal" race from the P0 incident. This must be a no-op:
    // dispatch keeps running at the user's own fastest choice.
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.normal, "auto"),
    );
    tickAt(2);
    server.turnsComplete(1);
    tickAt(3);
    server.turnsComplete(1);
    expect(turnCount()).toBe(4);
  });

  it("a later user-sourced change still applies on top of an earlier user override", () => {
    const { server, eventBus, tickAt, turnCount } =
      startServerWithManualPacingTimer(lobbyConfig(10, 1000));
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.fastest, "user"),
    );
    tickAt(0);
    server.turnsComplete(1);
    expect(turnCount()).toBe(1);

    // The user changes their mind to a slower speed -- this is still a
    // "user" source and must take effect (the gate only blocks "auto").
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.slow, "user"),
    );
    // slow => turnIntervalMs * 2 == 2000ms; not due yet at t=1.
    tickAt(1);
    expect(turnCount()).toBe(1);
    tickAt(2000);
    expect(turnCount()).toBe(2);
  });
});
