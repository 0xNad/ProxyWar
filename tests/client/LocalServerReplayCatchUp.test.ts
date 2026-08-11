import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LobbyConfig } from "../../src/client/ClientGameRunner";
import {
  AI_LEAGUE_REPLAY_CATCHUP_DEBOUNCE_MS,
  AI_LEAGUE_REPLAY_CATCHUP_EVENT,
  AI_LEAGUE_REPLAY_PROGRESS_EVENT,
  LocalServer,
} from "../../src/client/LocalServer";
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

type CatchUpDetail = { turnsRendered: number; turnsTotal: number } | null;
type ProgressDetail = { turnsRendered: number; turnsTotal: number };

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

// `decompressGameRecord` only ever reads `.turns` (sparse, filled forward)
// and `.info.num_turns` (the archived match's real total tick count) — an
// empty `turns` array with `num_turns: N` decompresses to exactly N
// empty-intent turns, letting each test dial in a specific archived-replay
// length without a real recorded match.
function archivedGameRecord(numTurns: number): GameRecord {
  return {
    info: { num_turns: numTurns },
    turns: [],
  } as unknown as GameRecord;
}

function lobbyConfig(numTurns: number, turnIntervalMs = 100): LobbyConfig {
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

// Mirrors LocalServerProgressiveReplay.test.ts's own helper: captures the
// pacing `setInterval` callback so the test drives it turn-by-turn instead
// of racing a real timer.
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
    messages,
    tickAt(nowMs: number) {
      vi.setSystemTime(nowMs);
      tick();
    },
  };
}

function captureCatchUpEvents(): CatchUpDetail[] {
  const captured: CatchUpDetail[] = [];
  const onEvent = (e: Event) => {
    // A DOM CustomEvent we dispatch ourselves in LocalServer.ts -- the
    // detail shape is ours, not external/untrusted input.
    const customEvent = e as CustomEvent<CatchUpDetail>;
    captured.push(customEvent.detail);
  };
  document.addEventListener(AI_LEAGUE_REPLAY_CATCHUP_EVENT, onEvent);
  return captured;
}

function captureProgressEvents(): ProgressDetail[] {
  const captured: ProgressDetail[] = [];
  const onEvent = (e: Event) => {
    // Same in-house CustomEvent contract as the catch-up event above.
    const customEvent = e as CustomEvent<ProgressDetail>;
    captured.push(customEvent.detail);
  };
  document.addEventListener(AI_LEAGUE_REPLAY_PROGRESS_EVENT, onEvent);
  return captured;
}

describe("LocalServer archived-replay catch-up", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults archived Full Replay to fastest speed without depending on ReplaySpeedChangeEvent", () => {
    // turnIntervalMs=1000 makes `normal` (1x, the pre-fix default) starve
    // the pacing gate for a full second: `Date.now() >= turnStartTime +
    // 1000` is false at t=0 and t=1. `fastest` (turnIntervalMs * 0 === 0)
    // has no such gate and dispatches on every tick regardless.
    const { messages, tickAt } = startServerWithManualPacingTimer(
      lobbyConfig(10, 1000),
    );
    tickAt(0);
    tickAt(1);
    const turnCount = messages.filter((m) => m.type === "turn").length;
    expect(turnCount).toBe(2);
  });

  it("reports real, debounced catch-up progress for a synthetic heavy replay", () => {
    const captured = captureCatchUpEvents();
    const { tickAt } = startServerWithManualPacingTimer(lobbyConfig(5_000));
    for (let i = 0; i < 5; i++) {
      tickAt(i);
    }
    // Five dispatched, zero rendered (turnsComplete never called) — a real
    // gap, but still inside the debounce window.
    expect(captured).toEqual([]);

    tickAt(AI_LEAGUE_REPLAY_CATCHUP_DEBOUNCE_MS + 1);
    expect(captured.length).toBeGreaterThan(0);
    const progress = captured.at(-1);
    expect(progress).not.toBeNull();
    expect(progress?.turnsTotal).toBe(5_000);
    expect(progress?.turnsRendered).toBe(0);
  });

  it("clears the instant the playhead moves (first turnsComplete)", () => {
    const captured = captureCatchUpEvents();
    const { server, tickAt } = startServerWithManualPacingTimer(
      lobbyConfig(5_000),
    );
    for (let i = 0; i < 3; i++) tickAt(i);
    tickAt(AI_LEAGUE_REPLAY_CATCHUP_DEBOUNCE_MS + 1);
    expect(captured.some((detail) => detail !== null)).toBe(true);

    server.turnsComplete(1);
    expect(captured.at(-1)).toBeNull();
  });

  it("never appears for a replay that catches up within one worker round-trip", () => {
    const captured = captureCatchUpEvents();
    const { server, tickAt } = startServerWithManualPacingTimer(lobbyConfig(3));
    tickAt(0);
    server.turnsComplete(1);
    tickAt(1);
    server.turnsComplete(1);
    tickAt(2);
    server.turnsComplete(1);
    expect(captured).toEqual([]);
  });

  it("never fires for a live (non-archived) game", () => {
    const captured = captureCatchUpEvents();
    const config = lobbyConfig(10);
    delete config.gameRecord;
    const { tickAt } = startServerWithManualPacingTimer(config);
    for (let i = 0; i < 5; i++) tickAt(i);
    tickAt(AI_LEAGUE_REPLAY_CATCHUP_DEBOUNCE_MS + 1);
    expect(captured).toEqual([]);
  });
});

describe("LocalServer archived-replay progress counter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is on screen from start(), before the first turn renders", () => {
    const captured = captureProgressEvents();
    startServerWithManualPacingTimer(lobbyConfig(5_000));
    expect(captured).toEqual([{ turnsRendered: 0, turnsTotal: 5_000 }]);
  });

  it("advances per rendered turn and lands on total / total at the end", () => {
    const captured = captureProgressEvents();
    const { server, tickAt } = startServerWithManualPacingTimer(lobbyConfig(3));
    for (let i = 0; i < 3; i++) {
      tickAt(i);
      server.turnsComplete(1);
    }
    expect(captured.at(-1)).toEqual({ turnsRendered: 3, turnsTotal: 3 });
    expect(captured.map((detail) => detail.turnsRendered)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("never fires for a live (non-archived) game", () => {
    const captured = captureProgressEvents();
    const config = lobbyConfig(10);
    delete config.gameRecord;
    const { server, tickAt } = startServerWithManualPacingTimer(config);
    // Live games pace at turnIntervalMs (100ms here), so tick past each
    // deadline to actually dispatch a turn before acknowledging it.
    for (let i = 1; i <= 3; i++) {
      tickAt(i * 100);
      server.turnsComplete(1);
    }
    expect(captured).toEqual([]);
  });
});
