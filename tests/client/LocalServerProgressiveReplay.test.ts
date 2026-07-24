import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LobbyConfig } from "../../src/client/ClientGameRunner";
import { ReplayJumpToTurnEvent } from "../../src/client/InputHandler";
import {
  LocalServer,
  MAX_PROGRESSIVE_CATCH_UP_IN_FLIGHT_TURNS,
} from "../../src/client/LocalServer";
import {
  ReplayPremiereFinalizationSignal,
  ReplayPremierePlaybackController,
  VerifiedReplayPremiereBatch,
} from "../../src/client/ReplayPremierePlayback";
import { ReplayPremiereWorkerClient } from "../../src/client/ReplayPremiereWorkerClient";
import {
  REPLAY_PREMIERE_MAX_TICKS_PER_CATCH_UP_UPDATE,
  REPLAY_PREMIERE_MAX_TICKS_PER_WORKER_SLICE,
} from "../../src/client/ReplayPremiereWorkerProtocol";
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
  Turn,
} from "../../src/core/Schemas";

const HASH_0 = "0".repeat(64);
const HASH_1 = "1".repeat(64);

class DeterministicCatchUpWorker {
  readonly posted: unknown[] = [];
  readonly terminate = vi.fn();
  taskCount = 0;
  updateCount = 0;
  processedTurns = 0;

  private listener:
    | ((event: MessageEvent<Record<string, unknown>>) => void)
    | null = null;
  private pendingTurns: Turn[] = [];
  private taskScheduled = false;
  private catchUpDelivery = false;
  private catchUpCompletedTurns = 0;

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<Record<string, unknown>>) => void,
  ): void {
    this.listener = listener;
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
    const command = message as {
      type: string;
      turns?: Turn[];
      delivery?: "live" | "catch_up";
    };
    if (command.type !== "turn_batch" || command.turns === undefined) return;
    this.pendingTurns.push(...command.turns);
    this.catchUpDelivery ||= command.delivery === "catch_up";
    this.taskScheduled = true;
  }

  initialize(): void {
    const init = this.posted[0] as { id: string };
    this.emit({ type: "initialized", id: init.id });
  }

  runNextTask(): boolean {
    if (!this.taskScheduled) return false;
    this.taskScheduled = false;
    this.taskCount += 1;
    const completedTurns = Math.min(
      REPLAY_PREMIERE_MAX_TICKS_PER_WORKER_SLICE,
      this.pendingTurns.length,
    );
    this.pendingTurns.splice(0, completedTurns);
    this.processedTurns += completedTurns;
    this.catchUpCompletedTurns += completedTurns;
    const flush =
      !this.catchUpDelivery ||
      this.catchUpCompletedTurns >=
        REPLAY_PREMIERE_MAX_TICKS_PER_CATCH_UP_UPDATE ||
      this.pendingTurns.length === 0;
    if (flush && this.catchUpCompletedTurns > 0) {
      const coalescedTurns = this.catchUpCompletedTurns;
      this.catchUpCompletedTurns = 0;
      this.updateCount += 1;
      this.emit({
        type: "game_update_batch",
        gameUpdates: [{}],
        completedTurns: coalescedTurns,
        tickExecutionDurations: Array(coalescedTurns).fill(0),
      });
    }
    if (this.pendingTurns.length > 0) {
      this.taskScheduled = true;
    } else if (this.catchUpCompletedTurns === 0) {
      this.catchUpDelivery = false;
    }
    return true;
  }

  private emit(message: Record<string, unknown>): void {
    this.listener?.({ data: message } as MessageEvent<Record<string, unknown>>);
  }
}

function gameStartInfo(): GameStartInfo {
  return {
    gameID: "PREM0001",
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
    players: [
      {
        clientID: "SEAT0001",
        username: "Alpha",
        clanTag: null,
      },
    ],
  };
}

function lobbyConfig(
  controller?: ReplayPremierePlaybackController,
): LobbyConfig {
  return {
    serverConfig: {
      turnIntervalMs: () => 10,
      workerPath: () => "worker",
    },
    cosmetics: {},
    playerName: "spectator",
    playerClanTag: null,
    playerRole: null,
    gameID: "PREM0001",
    turnstileToken: null,
    gameStartInfo: gameStartInfo(),
    progressiveReplay: controller ? { controller, playbackRate: 1 } : undefined,
  } as unknown as LobbyConfig;
}

function batch(
  turns: Turn[],
  presentationOffsets = turns.map((_, sequence) => sequence * 10),
): VerifiedReplayPremiereBatch {
  return {
    premiereId: "prem_0123456789abcdef",
    chunkIndex: 0,
    chunkHash: HASH_1,
    previousChunkHash: null,
    payloadHash: HASH_0,
    startSequence: 0,
    endSequence: turns.length - 1,
    verification: {
      payloadHashVerified: true,
      chunkHashVerified: true,
    },
    records: turns.map((turn, sequence) => ({
      sequence,
      presentationOffsetMs: presentationOffsets[sequence],
      turn,
    })),
  };
}

function finalization(
  finalSequence: number,
  finalChunkHash = HASH_1,
): ReplayPremiereFinalizationSignal {
  return {
    premiereId: "prem_0123456789abcdef",
    finalSequence,
    finalChunkHash,
    revealedAt: 1_000,
    verification: {
      releaseChainVerified: true,
      publicationCommitmentVerified: true,
      publicationDraftManifestVerified: true,
      provenanceVerified: true,
      eligibilityCommitmentVerified: true,
      sourceReplayIntegrityScope: "declared_hash_only",
      sourceReplayCommitmentMatched: true,
      authoritativeResultBytesVerified: true,
      resultCommitmentMatched: true,
      revealCommitmentVerified: true,
    },
  };
}

function appendProductionLengthReplay(
  controller: ReplayPremierePlaybackController,
): string {
  const totalTurns = 59_100;
  const chunkCount = 120;
  let nextSequence = 0;
  let previousChunkHash: string | null = null;
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const remainingChunks = chunkCount - chunkIndex;
    const chunkLength = Math.ceil(
      (totalTurns - nextSequence) / remainingChunks,
    );
    const startSequence = nextSequence;
    const endSequence = startSequence + chunkLength - 1;
    const chunkHash = (chunkIndex + 1).toString(16).padStart(64, "0");
    controller.appendVerifiedBatch({
      premiereId: "prem_0123456789abcdef",
      chunkIndex,
      chunkHash,
      previousChunkHash,
      payloadHash: HASH_0,
      startSequence,
      endSequence,
      verification: {
        payloadHashVerified: true,
        chunkHashVerified: true,
      },
      records: Array.from({ length: chunkLength }, (_, offset) => {
        const sequence = startSequence + offset;
        return {
          sequence,
          presentationOffsetMs: sequence * 25,
          turn: { turnNumber: sequence, intents: [] },
        };
      }),
    });
    nextSequence = endSequence + 1;
    previousChunkHash = chunkHash;
  }
  expect(nextSequence).toBe(totalTurns);
  return previousChunkHash!;
}

function startServer(config: LobbyConfig, isReplay = true) {
  const messages: ServerMessage[] = [];
  const eventBus = new EventBus();
  const server = new LocalServer(config, isReplay, eventBus);
  server.updateCallback(
    () => {},
    (message) => messages.push(message),
  );
  server.start();
  return { server, messages, eventBus };
}

function startServerWithManualPacingTimer(config: LobbyConfig) {
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
    // Give LocalServer a real fake-timer handle so endGame can clear it,
    // while the test controls exactly when the captured callback runs.
    return fakeSetInterval(() => {}, delay);
  }) as unknown as typeof setInterval);
  const started = startServer(config);
  intervalSpy.mockRestore();
  if (pacingTick === undefined) {
    throw new Error("missing LocalServer pacing callback");
  }
  const tick = pacingTick;
  return {
    ...started,
    tickAt(nowMs: number) {
      vi.setSystemTime(nowMs);
      tick();
    },
  };
}

function turnMessages(messages: ServerMessage[]): Turn[] {
  return messages.flatMap((message) =>
    message.type === "turn" ? [message.turn] : [],
  );
}

describe("LocalServer progressive replay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits at an unreleased/checkpoint boundary without emitting an extra turn", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const { server, messages } = startServer(lobbyConfig(controller));
    controller.appendVerifiedBatch(
      batch([
        { turnNumber: 0, intents: [] },
        { turnNumber: 1, intents: [] },
      ]),
    );

    vi.advanceTimersByTime(15);
    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([0]);

    // Backpressure prevents a second queued turn until the worker completes 0.
    vi.advanceTimersByTime(100);
    expect(turnMessages(messages)).toHaveLength(1);
    server.turnComplete();
    vi.advanceTimersByTime(15);
    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([
      0, 1,
    ]);
    server.turnComplete();

    // No next released record means a stable wait, not end-of-replay or a
    // synthetic pause turn.
    server.onMessage({
      type: "intent",
      intent: { type: "toggle_pause", paused: true },
    });
    vi.advanceTimersByTime(1_000);
    expect(turnMessages(messages)).toHaveLength(2);
    expect(controller.state()).toMatchObject({
      finalized: false,
      playbackComplete: false,
      lastDispatchedSequence: 1,
    });
    server.endGame();
  });

  it("reports dispatcher starvation as a visible buffering state, then auto-resumes", () => {
    // A frontier stall must never be a silently frozen canvas: while the
    // dispatcher has exhausted released content the controller reports
    // buffering (the overlay renders "Buffering live…"), and the next
    // released batch resumes dispatch and clears it automatically.
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const bufferingEvents: boolean[] = [];
    controller.subscribe((event) => {
      if (event.type === "buffering") bufferingEvents.push(event.buffering);
    });
    const { server, messages } = startServer(lobbyConfig(controller));
    controller.appendVerifiedBatch(batch([{ turnNumber: 0, intents: [] }]));

    vi.advanceTimersByTime(15);
    server.turnComplete();
    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([0]);

    // Released content exhausted, not finalized -> starved.
    vi.advanceTimersByTime(200);
    expect(controller.state().buffering).toBe(true);
    expect(bufferingEvents.at(-1)).toBe(true);

    // A fresh release resumes dispatch and clears the state.
    controller.appendVerifiedBatch({
      premiereId: "prem_0123456789abcdef",
      chunkIndex: 1,
      chunkHash: "2".repeat(64),
      previousChunkHash: HASH_1,
      payloadHash: HASH_0,
      startSequence: 1,
      endSequence: 1,
      verification: {
        payloadHashVerified: true,
        chunkHashVerified: true,
      },
      records: [
        {
          sequence: 1,
          presentationOffsetMs: 10,
          turn: { turnNumber: 1, intents: [] },
        },
      ],
    });
    vi.advanceTimersByTime(200);
    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([
      0, 1,
    ]);
    // Full cycle: starved -> resumed (buffering cleared while dispatching the
    // fresh release) -> starved again at the NEW frontier once it too is
    // consumed. The chip therefore tracks the dispatcher truthfully.
    expect(bufferingEvents).toEqual([true, false, true]);
    server.endGame();
  });

  it("catches up only to an explicitly requested released sequence", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const { server, messages } = startServer(lobbyConfig(controller));
    controller.appendVerifiedBatch(
      batch([
        { turnNumber: 0, intents: [] },
        { turnNumber: 1, intents: [] },
        { turnNumber: 2, intents: [] },
      ]),
    );

    controller.requestForwardCatchUp(1);
    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([
      0, 1,
    ]);
    expect(controller.state().lastDispatchedSequence).toBe(1);
    expect(() => controller.requestForwardCatchUp(0)).toThrow();
    expect(() => controller.requestForwardCatchUp(3)).toThrow();
    server.endGame();
  });

  it("bounds late-join catch-up by worker acknowledgement backpressure", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const { server, messages } = startServer(lobbyConfig(controller));
    const totalTurns = MAX_PROGRESSIVE_CATCH_UP_IN_FLIGHT_TURNS + 66;
    const turns = Array.from({ length: totalTurns }, (_, turnNumber) => ({
      turnNumber,
      intents: [],
    }));
    controller.appendVerifiedBatch(batch(turns));

    controller.requestForwardCatchUp(totalTurns - 1);
    expect(turnMessages(messages)).toHaveLength(
      MAX_PROGRESSIVE_CATCH_UP_IN_FLIGHT_TURNS,
    );
    expect(controller.state().lastDispatchedSequence).toBe(
      MAX_PROGRESSIVE_CATCH_UP_IN_FLIGHT_TURNS - 1,
    );

    // One validated worker batch opens the exact number of slots without 66
    // repeated completion/refill control-path traversals.
    server.turnsComplete(66);
    expect(turnMessages(messages)).toHaveLength(totalTurns);
    expect(controller.state().lastDispatchedSequence).toBe(totalTurns - 1);
    expect(() => server.turnsComplete(0)).toThrow(
      "invalid completed replay turn count",
    );
    expect(() =>
      server.turnsComplete(MAX_PROGRESSIVE_CATCH_UP_IN_FLIGHT_TURNS + 1),
    ).toThrow("invalid completed replay turn count");
    expect(() => server.turnsComplete(totalTurns)).toThrow(
      "invalid completed replay turn count",
    );
    server.endGame();
  });

  it("schedules from verified per-record offsets instead of the host interval", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const config = lobbyConfig(controller);
    config.serverConfig.turnIntervalMs = () => 9_999;
    const { server, messages } = startServer(config);
    controller.appendVerifiedBatch(
      batch(
        [
          { turnNumber: 0, intents: [] },
          { turnNumber: 1, intents: [] },
          { turnNumber: 2, intents: [] },
        ],
        [0, 30, 95],
      ),
    );

    vi.advanceTimersByTime(5);
    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([0]);
    server.turnComplete();
    vi.advanceTimersByTime(29);
    expect(turnMessages(messages)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([
      0, 1,
    ]);
    server.turnComplete();
    vi.advanceTimersByTime(64);
    expect(turnMessages(messages)).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([
      0, 1, 2,
    ]);
    expect(controller.state().lastAcceptedPresentationOffsetMs).toBe(95);
    server.endGame();
  });

  it("does not accumulate repeated timer callback overshoot", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const { server, messages, tickAt } = startServerWithManualPacingTimer(
      lobbyConfig(controller),
    );
    controller.appendVerifiedBatch(
      batch(
        Array.from({ length: 11 }, (_, turnNumber) => ({
          turnNumber,
          intents: [],
        })),
        Array.from({ length: 11 }, (_, sequence) => sequence * 50),
      ),
    );

    // A congested 5 ms poll arrives every 7 ms. Resetting the schedule to
    // Date.now() on every dispatch permanently compounds that overshoot and
    // emits only ten turns by 511 ms. A cumulative deadline emits all eleven.
    let completedTurns = 0;
    for (let nowMs = 7; nowMs <= 511; nowMs += 7) {
      tickAt(nowMs);
      const dispatchedTurns = turnMessages(messages).length;
      if (dispatchedTurns > completedTurns) {
        expect(dispatchedTurns).toBe(completedTurns + 1);
        server.turnComplete();
        completedTurns += 1;
      }
    }

    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual(
      Array.from({ length: 11 }, (_, turnNumber) => turnNumber),
    );
    server.endGame();
  });

  it("rebases after a long stall instead of bursting overdue turns", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const { server, messages, tickAt } = startServerWithManualPacingTimer(
      lobbyConfig(controller),
    );
    controller.appendVerifiedBatch(
      batch(
        Array.from({ length: 5 }, (_, turnNumber) => ({
          turnNumber,
          intents: [],
        })),
        [0, 50, 100, 150, 200],
      ),
    );

    tickAt(5);
    server.turnComplete();
    tickAt(55);
    server.turnComplete();

    tickAt(1_000);
    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([
      0, 1, 2,
    ]);
    server.turnComplete();

    // The next turn waits for its verified 50 ms interval. The stall does not
    // drain hundreds of milliseconds of schedule debt at the 5 ms poll rate.
    tickAt(1_005);
    tickAt(1_049);
    expect(turnMessages(messages)).toHaveLength(3);
    tickAt(1_050);
    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([
      0, 1, 2, 3,
    ]);
    server.endGame();
  });

  it("hydrates a 10,000-chunk late join in linear time", () => {
    vi.useRealTimers();
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    let previousChunkHash: string | null = null;
    for (let index = 0; index < 10_000; index += 1) {
      const chunkHash = index.toString(16).padStart(64, "0");
      controller.appendVerifiedBatch({
        premiereId: "prem_0123456789abcdef",
        chunkIndex: index,
        chunkHash,
        previousChunkHash,
        payloadHash: HASH_0,
        startSequence: index,
        endSequence: index,
        verification: {
          payloadHashVerified: true,
          chunkHashVerified: true,
        },
        records: [
          {
            sequence: index,
            presentationOffsetMs: index,
            turn: { turnNumber: index, intents: [] },
          },
        ],
      });
      previousChunkHash = chunkHash;
    }

    const startedAt = performance.now();
    const { server, messages } = startServer(lobbyConfig(controller));
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(5_000);
    controller.requestForwardCatchUp(9_999);
    expect(turnMessages(messages)).toHaveLength(
      MAX_PROGRESSIVE_CATCH_UP_IN_FLIGHT_TURNS,
    );
    server.endGame();
  }, 10_000);

  it.each([34_212, 49_437])(
    "catches a 59,100-sequence client from the observed %i prefix through reveal in under five seconds",
    (observedPrefix) => {
      vi.useRealTimers();
      const controller = new ReplayPremierePlaybackController(
        "prem_0123456789abcdef",
      );
      const finalChunkHash = appendProductionLengthReplay(controller);
      const { server, messages } = startServer(lobbyConfig(controller));
      controller.requestForwardCatchUp(observedPrefix);

      let completedTurns = 0;
      while (controller.state().lastDispatchedSequence! < observedPrefix) {
        server.turnComplete();
        completedTurns += 1;
      }
      expect(controller.state().lastDispatchedSequence).toBe(observedPrefix);

      controller.finalize(finalization(59_099, finalChunkHash));
      const startedAt = performance.now();
      controller.requestForwardCatchUp(59_099);
      while (completedTurns < 59_100) {
        server.turnComplete();
        completedTurns += 1;
      }
      const elapsedMs = performance.now() - startedAt;

      expect(turnMessages(messages)).toHaveLength(59_100);
      expect(controller.state()).toMatchObject({
        lastDispatchedSequence: 59_099,
        finalized: true,
        playbackComplete: true,
      });
      expect(elapsedMs).toBeLessThan(5_000);
      server.endGame();
    },
    20_000,
  );

  it("integrates 59,100 verified records through worker/client backpressure within the five-second reload budget", async () => {
    vi.useRealTimers();
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const finalChunkHash = appendProductionLengthReplay(controller);
    const worker = new DeterministicCatchUpWorker();
    const mainTasks: Array<() => void> = [];
    const client = new ReplayPremiereWorkerClient({} as never, undefined, {
      workerFactory: () => worker as never,
      enqueueMicrotask: (callback) => mainTasks.push(callback),
    });
    const initialized = client.initialize();
    worker.initialize();
    await initialized;

    const server = new LocalServer(
      lobbyConfig(controller),
      true,
      new EventBus(),
    );
    const renderedSequences: number[] = [];
    client.start(() => {
      renderedSequences.push(client.processedSequence());
      const completedTurns = client.completedTurnsForCurrentUpdate();
      server.turnsComplete(completedTurns);
    });
    server.updateCallback(
      () => {},
      (message) => {
        if (message.type === "turn") client.sendTurn(message.turn);
      },
    );
    server.start();

    const reloadTarget = 49_999;
    const startedAt = performance.now();
    controller.requestForwardCatchUp(reloadTarget);
    let guard = 0;
    while (client.processedSequence() < reloadTarget) {
      while (mainTasks.length > 0) mainTasks.shift()?.();
      if (!worker.runNextTask()) {
        throw new Error("catch-up worker starved before the released target");
      }
      guard += 1;
      if (guard > 10_000) throw new Error("catch-up worker did not converge");
    }
    const reloadElapsedMs = performance.now() - startedAt;

    expect(client.processedSequence()).toBe(reloadTarget);
    expect(renderedSequences.at(-1)).toBe(reloadTarget);
    expect(reloadElapsedMs).toBeLessThan(5_000);
    expect(worker.updateCount).toBeLessThanOrEqual(
      Math.ceil(
        (reloadTarget + 1) / REPLAY_PREMIERE_MAX_TICKS_PER_CATCH_UP_UPDATE,
      ),
    );

    controller.finalize(finalization(59_099, finalChunkHash));
    controller.requestForwardCatchUp(59_099);
    while (client.processedSequence() < 59_099) {
      while (mainTasks.length > 0) mainTasks.shift()?.();
      if (!worker.runNextTask()) {
        throw new Error("catch-up worker starved before reveal completion");
      }
      guard += 1;
      if (guard > 10_000) throw new Error("catch-up worker did not converge");
    }

    expect(client.processedSequence()).toBe(59_099);
    expect(controller.state()).toMatchObject({
      lastDispatchedSequence: 59_099,
      finalized: true,
      playbackComplete: true,
    });
    expect(worker.taskCount).toBe(
      Math.ceil(
        (reloadTarget + 1) / REPLAY_PREMIERE_MAX_TICKS_PER_WORKER_SLICE,
      ) +
        Math.ceil(
          (59_100 - (reloadTarget + 1)) /
            REPLAY_PREMIERE_MAX_TICKS_PER_WORKER_SLICE,
        ),
    );
    expect(worker.updateCount).toBe(
      Math.ceil(
        (reloadTarget + 1) / REPLAY_PREMIERE_MAX_TICKS_PER_CATCH_UP_UPDATE,
      ) +
        Math.ceil(
          (59_100 - (reloadTarget + 1)) /
            REPLAY_PREMIERE_MAX_TICKS_PER_CATCH_UP_UPDATE,
        ),
    );
    server.endGame();
    client.cleanup();
  }, 20_000);

  it("verifies released archived hashes when present", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const { server, messages } = startServer(lobbyConfig(controller));
    controller.appendVerifiedBatch(
      batch([{ turnNumber: 0, intents: [], hash: 123 }]),
    );

    server.onMessage({ type: "hash", turnNumber: 0, hash: 456 });
    expect(messages.at(-1)).toEqual({
      type: "desync",
      turn: 0,
      correctHash: 123,
      clientsWithCorrectHash: 0,
      totalActiveClients: 1,
      yourHash: 456,
    });
    server.endGame();
  });

  it("stops only after an integrity-checked finalization and final worker ack", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const events: string[] = [];
    controller.subscribe((event) => events.push(event.type));
    const { server, messages } = startServer(lobbyConfig(controller));
    controller.appendVerifiedBatch(
      batch([{ turnNumber: 0, intents: [], hash: 123 }]),
    );

    vi.advanceTimersByTime(15);
    expect(turnMessages(messages)).toHaveLength(1);
    expect(controller.state().playbackComplete).toBe(false);

    controller.finalize(finalization(0));
    expect(controller.state()).toMatchObject({
      finalized: true,
      playbackComplete: false,
    });
    server.turnComplete();
    expect(controller.state().playbackComplete).toBe(true);
    expect(events).toContain("playback-complete");

    vi.advanceTimersByTime(1_000);
    expect(turnMessages(messages)).toHaveLength(1);
    server.endGame();
  });

  it("enables ordinary forward seeking only after reveal integrity is verified", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const { server, messages, eventBus } = startServer(lobbyConfig(controller));
    controller.appendVerifiedBatch(
      batch([
        { turnNumber: 0, intents: [] },
        { turnNumber: 1, intents: [] },
        { turnNumber: 2, intents: [] },
      ]),
    );

    eventBus.emit(new ReplayJumpToTurnEvent(3));
    expect(turnMessages(messages)).toHaveLength(0);

    controller.finalize(finalization(2));
    eventBus.emit(new ReplayJumpToTurnEvent(3));
    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([
      0, 1, 2,
    ]);
    expect(controller.state().lastDispatchedSequence).toBe(2);
    server.endGame();
  });

  it("rejects outcome-bearing GameStartInfo before starting playback", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const config = lobbyConfig(controller);
    config.gameStartInfo = {
      ...gameStartInfo(),
      winner: ["player", "secret-seat"],
    } as never;
    const server = new LocalServer(config, true, new EventBus());
    server.updateCallback(
      () => {},
      () => {},
    );

    expect(() => server.start()).toThrow(
      "invalid progressive replay gameStartInfo",
    );
  });

  it("preserves the existing archived replay path", () => {
    const config = lobbyConfig();
    config.gameRecord = {
      info: { num_turns: 2 },
      turns: [
        { turnNumber: 0, intents: [] },
        { turnNumber: 1, intents: [] },
      ],
    } as unknown as GameRecord;
    const { server, messages } = startServer(config);

    vi.advanceTimersByTime(15);
    server.turnComplete();
    vi.advanceTimersByTime(15);
    server.turnComplete();
    vi.advanceTimersByTime(15);

    expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([
      0, 1,
    ]);
    expect(messages.find((message) => message.type === "start")).toMatchObject({
      type: "start",
      myClientID: undefined,
    });
    server.endGame();
  });

  it.each([55, 605])(
    "pre-stages Clip Preview turn %i before pacing and holds the exact anchor until unpause",
    (target) => {
      const config = lobbyConfig();
      config.gameRecord = {
        info: { num_turns: 700 },
        turns: Array.from({ length: 700 }, (_, turnNumber) => ({
          turnNumber,
          intents: [],
        })),
      } as unknown as GameRecord;
      config.replayClipPreviewTarget = target;

      const { server, messages, tickAt } =
        startServerWithManualPacingTimer(config);
      const initialStart = messages.find((message) => message.type === "start");
      if (initialStart?.type !== "start") {
        throw new Error("missing initial replay start message");
      }
      expect(initialStart.turns).toHaveLength(target);
      expect(initialStart.turns.at(-1)?.turnNumber).toBe(target - 1);

      // Even a massively overdue pacing callback cannot queue the next turn:
      // Preview was paused before this interval existed.
      tickAt(100_000);
      expect(turnMessages(messages)).toHaveLength(0);

      server.onMessage({
        type: "rejoin",
        gameID: "PREM0001",
        lastTurn: 0,
        token: "00000000-0000-4000-8000-000000000000",
      });
      const rejoinStart = messages.at(-1);
      if (rejoinStart?.type !== "start") {
        throw new Error("missing replay rejoin start message");
      }
      expect(rejoinStart.turns).toHaveLength(target);
      expect(rejoinStart.turns.at(-1)?.turnNumber).toBe(target - 1);

      tickAt(200_000);
      expect(turnMessages(messages)).toHaveLength(0);

      // Explicit playback is the only operation allowed to move beyond the
      // selected visible tick. Record turn `target` produces tick target + 1.
      server.onMessage({
        type: "intent",
        intent: { type: "toggle_pause", paused: false },
      });
      expect(turnMessages(messages).map((turn) => turn.turnNumber)).toEqual([
        target,
      ]);
      server.endGame();
    },
  );

  it("rejects Clip Preview targets outside the retained plain replay", () => {
    const config = lobbyConfig();
    config.gameRecord = {
      info: { num_turns: 54 },
      turns: [],
    } as unknown as GameRecord;
    config.replayClipPreviewTarget = 55;
    const server = new LocalServer(config, true, new EventBus());
    server.updateCallback(
      () => {},
      () => {},
    );

    expect(() => server.start()).toThrow("invalid replay clip preview target");
  });
});
