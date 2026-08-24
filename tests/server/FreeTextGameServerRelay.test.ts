import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "winston";

vi.mock("../../src/core/configuration/ConfigLoader", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/core/configuration/ConfigLoader")
    >();
  return {
    ...actual,
    getServerConfigFromServer: () => ({
      otelEnabled: () => false,
      otelAuthHeader: () => "",
      otelEndpoint: () => "",
      env: () => 0,
    }),
    getServerConfig: () => ({
      otelEnabled: () => false,
    }),
  };
});

import { GameEnv, ServerConfig } from "../../src/core/configuration/Config";
import { Executor } from "../../src/core/execution/ExecutionManager";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
} from "../../src/core/game/Game";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import { GameConfig, StampedIntent, Turn } from "../../src/core/Schemas";
import { AgentRunner } from "../../src/server/agents/AgentRunner";
import { Client } from "../../src/server/Client";
import { GameServer } from "../../src/server/GameServer";
import { setup } from "../util/Setup";

/**
 * The REAL server-side relay gate for free-text negotiation
 * (PROXYWAR_TUNE_FREETEXT_MESSAGES) — blocker 3 of the 2026-08-16 fleet
 * audit. The unit suites pin the flag PREDICATE and the wire SCHEMA; nothing
 * pinned the handler between them: GameServer's websocket switch, where the
 * refusal actually happens and where a bare `break` once meant "silently
 * swallow every message the moment the feature turns on".
 *
 * Everything here is the production path, unmocked: the real
 * `ClientMessageSchema` parse, the real switch arm, real `Client`s (one
 * driven by the real `AgentRunner` in-process socket — the intended producer
 * — and one hand-crafted, the threat model the gate exists for), the real
 * turn bundling, and the real core `Executor` mapping the relayed intent to
 * `AgentMessageExecution`. The live demo evidence this pins against
 * regression: artifacts run 2026-08-16T18-45-36-743Z relayed 150
 * `agent_message` intents into game-record.json through exactly this path.
 */

const FLAG = "PROXYWAR_TUNE_FREETEXT_MESSAGES";

const serverConfig = {
  turnIntervalMs: () => 100,
  env: () => GameEnv.Dev,
} as ServerConfig;

const gameConfig: GameConfig = {
  gameMap: GameMapType.Asia,
  gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA,
  gameType: GameType.Private,
  difficulty: Difficulty.Medium,
  nations: "disabled",
  donateGold: false,
  donateTroops: false,
  bots: 0,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
  disabledUnits: [],
  maxPlayers: 4,
};

/** The recipient's PlayerID — a core-game id, 8 chars to satisfy the wire ID bound. */
const RECIPIENT_PLAYER_ID = "MRCV0001";
const MESSAGE_TEXT = "Truce on the north border until turn 200?";

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

/** Hand-crafted websocket: the "hostile client" the refusal comment names. */
function makeMockWs() {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const sent: string[] = [];
  return {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler;
    },
    removeAllListeners: (_event: string) => {},
    send: (data: unknown) => {
      sent.push(String(data));
    },
    close: vi.fn(),
    readyState: 1,
    trigger: (event: string, ...args: unknown[]) => handlers[event]?.(...args),
    sent,
  };
}

function makeHandClient(clientID: string) {
  const ws = makeMockWs();
  const client = new Client(
    clientID,
    `pid-${clientID}`,
    null,
    null,
    undefined,
    "127.0.0.1",
    "HandCrafted",
    null,
    ws as never,
    undefined,
  );
  return { client, ws };
}

/** Every turn broadcast to this websocket, parsed off the real wire bytes. */
function turnsSeenBy(ws: ReturnType<typeof makeMockWs>): Turn[] {
  return ws.sent
    .map((raw) => JSON.parse(raw) as { type: string; turn?: Turn })
    .filter((msg) => msg.type === "turn")
    .map((msg) => msg.turn!);
}

function agentMessageIntents(turns: Turn[]): StampedIntent[] {
  return turns
    .flatMap((turn) => turn.intents)
    .filter((intent) => intent.type === "agent_message");
}

describe("GameServer agent_message relay (real socket path)", () => {
  let log: ReturnType<typeof makeLogger>;
  let game: GameServer;

  beforeEach(() => {
    log = makeLogger();
    game = new GameServer(
      "FRETEXT1",
      log as never,
      Date.now(),
      serverConfig,
      gameConfig,
    );
  });

  afterEach(async () => {
    delete process.env[FLAG];
    await game.end({ archive: false });
  });

  /** Attach the intended producer plus a plain observer, and start manual-tick. */
  function startWithRunnerAndObserver() {
    const runner = new AgentRunner({
      username: "Messenger",
      log: log as never,
    });
    const joined = runner.attachToGame(game);
    expect(joined.status).toBe("joined");

    const observer = makeHandClient("OBSRV001");
    expect(game.joinClient(observer.client)).toBe("joined");

    game.start({ realtimeClock: false });
    expect(game.hasStarted()).toBe(true);
    return { runner, observer };
  }

  it("flag OFF: the refusal happens at the server, and nothing reaches any turn", () => {
    const { runner, observer } = startWithRunnerAndObserver();

    const result = runner.submitAgentMessage({
      recipient: RECIPIENT_PLAYER_ID,
      text: MESSAGE_TEXT,
    });
    // The wire is fire-and-forget: the sender gets no synchronous error back.
    // The refusal is the SERVER dropping the intent, not the client failing —
    // which is exactly why only a turn-stream assertion can prove the gate.
    expect(result.accepted).toBe(true);

    expect(log.warn).toHaveBeenCalledWith(
      "agent_message intent refused: feature is off",
      expect.objectContaining({ gameID: "FRETEXT1" }),
    );

    game.advanceTurnsForTesting(3);

    // Neither the broadcast wire nor the record path carries it. The private
    // `turns` array is the exact array `end()` hands to
    // createPartialGameRecord, so this is the game-record assertion.
    const broadcast = turnsSeenBy(observer.ws);
    expect(broadcast.length).toBeGreaterThanOrEqual(3);
    expect(agentMessageIntents(broadcast)).toHaveLength(0);
    expect(
      agentMessageIntents((game as unknown as { turns: Turn[] }).turns),
    ).toHaveLength(0);
  });

  it("flag ON: the runner's message relays into the turn stream, server-stamped", () => {
    process.env[FLAG] = "1";
    const { runner, observer } = startWithRunnerAndObserver();

    const result = runner.submitAgentMessage({
      recipient: RECIPIENT_PLAYER_ID,
      text: MESSAGE_TEXT,
    });
    expect(result.accepted).toBe(true);
    expect(log.warn).not.toHaveBeenCalledWith(
      "agent_message intent refused: feature is off",
      expect.anything(),
    );

    game.advanceTurnsForTesting(1);

    const expected = {
      type: "agent_message",
      recipient: RECIPIENT_PLAYER_ID,
      text: MESSAGE_TEXT,
      // Stamped from the authenticated connection by the server, never
      // supplied by the client.
      clientID: runner.clientID()!,
    };
    // On the wire every OTHER client receives…
    expect(agentMessageIntents(turnsSeenBy(observer.ws))).toEqual([expected]);
    // …and on the record path end() archives.
    expect(
      agentMessageIntents((game as unknown as { turns: Turn[] }).turns),
    ).toEqual([expected]);
  });

  it("flag ON: the relayed turn produces the AgentMessageEvent in the real core", async () => {
    process.env[FLAG] = "1";
    const { runner } = startWithRunnerAndObserver();

    runner.submitAgentMessage({
      recipient: RECIPIENT_PLAYER_ID,
      text: MESSAGE_TEXT,
    });
    game.advanceTurnsForTesting(1);
    const relayed = agentMessageIntents(
      (game as unknown as { turns: Turn[] }).turns,
    );
    expect(relayed).toHaveLength(1);

    // Replay the EXACT server-stamped turn content through the real core:
    // Executor maps the intent to AgentMessageExecution by the stamped
    // clientID, and the tick emits the display update the viewer renders.
    const coreGame = await setup("ocean_and_land", {}, [
      new PlayerInfo(
        "Messenger",
        PlayerType.Human,
        runner.clientID()!,
        "MSND0001",
      ),
      new PlayerInfo("Receiver", PlayerType.Human, null, RECIPIENT_PLAYER_ID),
    ]);
    while (coreGame.inSpawnPhase()) {
      coreGame.executeNextTick();
    }
    const executor = new Executor(coreGame, "FRETEXT1", undefined);
    coreGame.addExecution(
      ...executor.createExecs({
        turnNumber: 0,
        intents: relayed,
      }),
    );
    coreGame.executeNextTick();
    const updates = coreGame.executeNextTick();

    const events = updates[GameUpdateType.AgentMessageEvent] ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      senderID: coreGame.playerByClientID(runner.clientID()!)!.smallID(),
      recipientID: coreGame.player(RECIPIENT_PLAYER_ID).smallID(),
      text: MESSAGE_TEXT,
    });
  });

  it("flag OFF: a hand-crafted client is refused identically", async () => {
    const { observer } = startWithRunnerAndObserver();
    const hand = makeHandClient("HAND0001");
    expect(game.joinClient(hand.client)).toBe("joined");

    // No AgentRunner, no validator, no league — the raw wire bytes a hostile
    // client on a public server would send. The schema bounds the LENGTH of
    // the text, not the right to send it; this gate is that right.
    await hand.ws.trigger(
      "message",
      JSON.stringify({
        type: "intent",
        intent: {
          type: "agent_message",
          recipient: RECIPIENT_PLAYER_ID,
          text: "unmoderated text on a public server",
        },
      }),
    );

    expect(log.warn).toHaveBeenCalledWith(
      "agent_message intent refused: feature is off",
      expect.objectContaining({ clientID: "HAND0001" }),
    );
    game.advanceTurnsForTesting(2);
    expect(agentMessageIntents(turnsSeenBy(observer.ws))).toHaveLength(0);
  });

  it("flag ON: a hand-crafted client cannot bypass the offered-id validator", async () => {
    process.env[FLAG] = "1";
    const { observer } = startWithRunnerAndObserver();
    const hand = makeHandClient("HAND0001");
    expect(game.joinClient(hand.client)).toBe("joined");

    await hand.ws.trigger(
      "message",
      JSON.stringify({
        type: "intent",
        intent: {
          type: "agent_message",
          recipient: RECIPIENT_PLAYER_ID,
          text: "who said this?",
          // Impersonation attempt: schema strips it, and the server stamp
          // spreads AFTER the intent, so it could never survive anyway.
          clientID: "EVIL0001",
        },
      }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      "agent_message intent refused: client lacks agent message capability",
      expect.objectContaining({ clientID: "HAND0001" }),
    );
    game.advanceTurnsForTesting(1);
    expect(agentMessageIntents(turnsSeenBy(observer.ws))).toHaveLength(0);
  });

  it("flag ON: the server re-applies reject-don't-rewrite text validation", () => {
    process.env[FLAG] = "1";
    const { runner, observer } = startWithRunnerAndObserver();

    const result = runner.submitAgentMessage({
      recipient: RECIPIENT_PLAYER_ID,
      text: "fake\u202E attribution",
    });
    expect(result).toMatchObject({
      accepted: false,
      reason: "invalid-agent-message-text",
    });
    expect(log.warn).toHaveBeenCalledWith(
      "agent_message intent refused: invalid text",
      expect.objectContaining({
        clientID: runner.clientID(),
        reason:
          "messageText contained invisible formatting or bidi-override characters",
      }),
    );
    game.advanceTurnsForTesting(1);
    expect(agentMessageIntents(turnsSeenBy(observer.ws))).toHaveLength(0);
  });

  it("flag ON: the real wire schema still kicks over-cap hand-crafted text", async () => {
    process.env[FLAG] = "1";
    startWithRunnerAndObserver();
    const hand = makeHandClient("HAND0001");
    expect(game.joinClient(hand.client)).toBe("joined");
    const kick = vi.spyOn(game, "kickClient");

    // 281 chars: the validator never saw this (no runner involved), so the
    // ClientMessageSchema parse in the socket handler is the bound that must
    // hold on its own.
    await hand.ws.trigger(
      "message",
      JSON.stringify({
        type: "intent",
        intent: {
          type: "agent_message",
          recipient: RECIPIENT_PLAYER_ID,
          text: "x".repeat(281),
        },
      }),
    );

    expect(kick).toHaveBeenCalledWith("HAND0001", expect.any(String));
    game.advanceTurnsForTesting(1);
    expect(
      agentMessageIntents((game as unknown as { turns: Turn[] }).turns),
    ).toHaveLength(0);
  });
});
