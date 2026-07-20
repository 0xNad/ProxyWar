import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LobbyConfig } from "../../src/client/ClientGameRunner";
import { ReplayJumpToTurnEvent } from "../../src/client/InputHandler";
import { LocalServer } from "../../src/client/LocalServer";
import {
  ReplayPremiereFinalizationSignal,
  ReplayPremierePlaybackController,
  VerifiedReplayPremiereBatch,
} from "../../src/client/ReplayPremierePlayback";
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

function finalization(finalSequence: number): ReplayPremiereFinalizationSignal {
  return {
    premiereId: "prem_0123456789abcdef",
    finalSequence,
    finalChunkHash: HASH_1,
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
    const turns = Array.from({ length: 130 }, (_, turnNumber) => ({
      turnNumber,
      intents: [],
    }));
    controller.appendVerifiedBatch(batch(turns));

    controller.requestForwardCatchUp(129);
    expect(turnMessages(messages)).toHaveLength(64);
    expect(controller.state().lastDispatchedSequence).toBe(63);

    // Each worker acknowledgement opens one slot. The main thread never emits
    // the remaining 66 turns in one unbounded loop.
    for (let completed = 0; completed < 66; completed += 1) {
      server.turnComplete();
    }
    expect(turnMessages(messages)).toHaveLength(130);
    expect(controller.state().lastDispatchedSequence).toBe(129);
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
    expect(turnMessages(messages)).toHaveLength(64);
    server.endGame();
  }, 10_000);

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
});
