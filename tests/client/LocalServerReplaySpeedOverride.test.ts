import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LobbyConfig } from "../../src/client/ClientGameRunner";
import {
  mountDirectorCutController,
  type DirectorCutPlan,
  type DirectorCutSegment,
} from "../../src/client/DirectorCutController";
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
import { GameRecord, GameStartInfo, ServerMessage } from "../../src/core/Schemas";

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

  it("applies an auto-sourced speed change (Director Cut, archived default) when the user has never touched speed", () => {
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

    // Director Cut (or any other automatic pacing decision) tries to pin a
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

function segment(overrides: Partial<DirectorCutSegment>): DirectorCutSegment {
  return {
    startTurn: 0,
    endTurn: 49,
    speed: "fast",
    eventReason: "quiet_interval",
    importance: 0,
    participatingAgents: [],
    ...overrides,
  };
}

function plan(segments: DirectorCutSegment[]): DirectorCutPlan {
  return {
    schemaVersion: 1,
    reportKind: "director-cut-plan",
    runID: "test-run",
    matchID: "test-match",
    generatedAt: new Date(0).toISOString(),
    totalTurns: segments.at(-1)?.endTurn ?? 0,
    segments,
    importantTurnCount: 0,
    estimatedDurationSeconds: 0,
    degraded: false,
    notes: [],
  };
}

function dispatchFrame(tick: number) {
  document.dispatchEvent(
    new CustomEvent("ai-league-replay-frame", { detail: { tick } }),
  );
}

describe("P0 regression (deploy 2B): a user speed pick during the auto-skipped opening segment must survive every later Director Cut segment transition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays at the user's pick across 30s of virtual time and 5 segment transitions, covering the ~5-6s window the bug actually reproduced at", () => {
    // 6 segments, each 50 turns wide, opening auto-forced to fastest by
    // directorCutSpeedForSegment regardless of its own authored "normal".
    // Reproduces the real shape: an opening segment plus several later
    // narrative beats a viewer would cross while watching.
    const sixSegmentPlan = plan([
      segment({ startTurn: 0, endTurn: 49, speed: "normal", eventReason: "opening" }),
      segment({ startTurn: 50, endTurn: 99, speed: "fast", eventReason: "quiet_interval" }),
      segment({ startTurn: 100, endTurn: 149, speed: "slow", eventReason: "reversal" }),
      segment({ startTurn: 150, endTurn: 199, speed: "normal", eventReason: "war_declaration" }),
      segment({ startTurn: 200, endTurn: 249, speed: "fast", eventReason: "quiet_interval" }),
      segment({ startTurn: 250, endTurn: 299, speed: "slow", eventReason: "alliance" }),
    ]);

    const { server, eventBus, tickAt, turnCount } =
      startServerWithManualPacingTimer(lobbyConfig(10_000, 1000));

    // Mirrors Main.ts's openAiLeagueReplay wiring exactly: a one-way latch
    // gates the Director-Cut-to-eventBus bridge so NO "auto" event ever
    // reaches the bus (engine OR any display listener) once the viewer has
    // picked a speed themselves.
    let userOverrodeReplaySpeed = false;
    eventBus.on(ReplaySpeedChangeEvent, (event) => {
      if (event.source === "user") userOverrodeReplaySpeed = true;
    });
    const autoEmissions: ReplaySpeedMultiplier[] = [];
    const dcHandle = mountDirectorCutController({
      plan: sixSegmentPlan,
      enabledByDefault: true,
      onSpeedChange: (speed) => {
        if (userOverrodeReplaySpeed) return;
        autoEmissions.push(speed);
        eventBus.emit(new ReplaySpeedChangeEvent(speed, "auto"));
      },
      documentRef: document,
    });
    // Opening segment auto-forced to fastest at mount (0-delay dispatch).
    tickAt(0);
    expect(turnCount()).toBe(1);

    // The viewer picks 1x DURING the opening segment (turn 10 -- well
    // before the opening segment's own turn-49 boundary).
    dispatchFrame(10);
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.normal, "user"),
    );
    server.turnsComplete(1);

    // Advance 30s of virtual wall-clock time in 1s steps (turnIntervalMs=
    // 1000 -> exactly one dispatched turn per second at "normal"/1x), while
    // ALSO crossing every one of the plan's 5 remaining segment boundaries
    // (turns 50/100/150/200/250) via simulated frame ticks -- the real
    // shape of a viewer watching for 30s while Director Cut narrates
    // through several beats. The observed bug reverted the label (and, per
    // this test's stricter check, would have reverted engine pacing too)
    // at ~5-6s -- sampled explicitly at t=5000/6000 below, not just at the
    // end.
    const frameTicksBySecond = [50, 100, 150, 200, 250, 250, 250, 250, 250, 250];
    for (let second = 1; second <= 30; second++) {
      dispatchFrame(frameTicksBySecond[Math.min(second - 1, frameTicksBySecond.length - 1)] ?? 250);
      tickAt(second * 1000);
      server.turnsComplete(1);
      if (second === 5 || second === 6) {
        // The exact window the bug reproduced in live QA.
        expect(turnCount()).toBe(second + 1);
      }
    }

    // Engine pacing: exactly one turn per second the whole 30s, i.e. still
    // running at the user's own 1x pick (fastest/Max would have dispatched
    // far more than 31 turns by t=30000; a reverted-to-slow/normal-with-DC-
    // override would show a different, non-1:1 count).
    expect(turnCount()).toBe(31);
    // No "auto" speed change ever reached the bus after the user's pick --
    // the one-way latch, not just a same-value coincidence.
    expect(autoEmissions).toEqual([ReplaySpeedMultiplier.fastest]);

    dcHandle.dispose();
  });
});
