import { describe, expect, it, vi } from "vitest";
import { Logger } from "winston";

vi.mock(
  "../../src/core/configuration/ConfigLoader",
  async (importOriginal) => {
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
  },
);

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
import { GameConfig, StampedIntent } from "../../src/core/Schemas";
import {
  AgentLeagueMatchRunner,
  buildSpawnCandidates,
  createAgentParticipants,
} from "../../src/server/agents/AgentLeagueMatch";
import { AgentBrainInput, LegalAction } from "../../src/server/agents/AgentTypes";
import { GameServer } from "../../src/server/GameServer";
import { setup } from "../util/Setup";

/**
 * End-to-end coverage for agent decisions that carry REAL game intents into
 * the core simulation — the gap the fixture-based batch test (intent: null)
 * deliberately does not cover.
 *
 * The scalar test below is a behavior PIN authored against the
 * participant-major submission pass: the batch-layer round-robin rewrite must
 * keep it green unchanged. Batched-decision E2E cases extend this file once
 * the wire carries `actionIDs`.
 */

function makeLogger(): Logger {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

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

function agentPlayerID(index: number): string {
  return `e2ep${index + 1}`.padEnd(8, "0");
}

/**
 * Picks a real action from the live menu at decide-time: the first offering
 * with a concrete intent (spawn during the opening turn, then attack/build/
 * boat once the game is running), falling back to hold. This is what a
 * well-behaved external policy does — the test never hardcodes action ids.
 */
function menuAwareBrain() {
  return {
    brainType: "rule" as const,
    decide: (input: AgentBrainInput) => {
      const withIntent = input.legalActions.find(
        (action: LegalAction) => action.intent !== null,
      );
      const hold = input.legalActions.find(
        (action: LegalAction) => action.kind === "hold",
      );
      const chosen = withIntent ?? hold ?? input.legalActions[0];
      return {
        actionID: chosen.id,
        reason: `picked ${chosen.kind} from the live menu`,
      };
    },
  };
}

describe("AgentLeagueMatchBatchE2E", () => {
  it("pins scalar decisions submitting real intents that execute in core", async () => {
    const log = makeLogger();
    const candidateGame = await setup("big_plains", { nations: "disabled" });
    const spawnCandidates = buildSpawnCandidates(candidateGame.map(), {
      maxCandidates: 500,
    });
    const participants = createAgentParticipants(
      [
        { username: "Real Intent One", profile: "opportunistic" },
        { username: "Real Intent Two", profile: "aggressive" },
      ],
      log,
      { brainFactory: () => menuAwareBrain() },
    );
    const game = new GameServer(
      "AGENT_E2E_SCALAR",
      log,
      Date.now(),
      serverConfig,
      gameConfig,
    );
    const match = new AgentLeagueMatchRunner({
      game,
      participants,
      spawnCandidates,
      log,
    });

    try {
      match.attachAgents();
      match.startGame();
      const openingRecords = await match.runOpeningTurn();
      expect(openingRecords).toHaveLength(2);
      expect(
        openingRecords.every((record) => record.intent !== null),
      ).toBe(true);

      const playerInfos = openingRecords.map(
        (record, index) =>
          new PlayerInfo(
            record.username,
            PlayerType.Human,
            record.clientID,
            agentPlayerID(index),
          ),
      );
      const coreGame = await setup(
        "big_plains",
        { nations: "disabled" },
        playerInfos,
      );
      const executor = new Executor(coreGame, "AGENT_E2E_SCALAR", undefined);
      coreGame.addExecution(
        ...executor.createExecs({
          turnNumber: 0,
          intents: openingRecords.map((record) => ({
            ...record.intent!,
            clientID: record.clientID!,
          })) as StampedIntent[],
        }),
      );
      let ticks = 0;
      while (coreGame.inSpawnPhase() && ticks < 1000) {
        coreGame.executeNextTick();
        ticks++;
      }
      expect(coreGame.inSpawnPhase()).toBe(false);

      const records = await match.runDecisionTurn({
        turnNumber: 1,
        gameState: coreGame,
      });

      // Roster order and one record per scalar decision (behavior pin).
      expect(records.map((record) => record.username)).toEqual([
        "Real Intent One",
        "Real Intent Two",
      ]);
      expect(records.map((record) => record.decisionMetadata?.batchIndex))
        .toEqual([0, 0]);
      expect(records.map((record) => record.decisionMetadata?.batchSize))
        .toEqual([1, 1]);
      // Every choice came from the menu that was actually offered.
      expect(
        records.every((record) =>
          record.legalActionIDs.includes(record.chosenActionID),
        ),
      ).toBe(true);

      // Real intents crossed the runner and execute in core without error.
      const submitted = records
        .filter((record) => record.intent !== null && record.result.accepted)
        .map((record) => ({
          ...record.intent!,
          clientID: record.clientID!,
        })) as StampedIntent[];
      expect(submitted.length).toBeGreaterThan(0);

      coreGame.addExecution(
        ...executor.createExecs({ turnNumber: 1, intents: submitted }),
      );
      for (let i = 0; i < 5; i++) {
        coreGame.executeNextTick();
      }

      // A second decision turn still works against the advanced game.
      const secondRecords = await match.runDecisionTurn({
        turnNumber: 2,
        gameState: coreGame,
      });
      expect(secondRecords).toHaveLength(2);
      expect(
        secondRecords.every((record) =>
          record.legalActionIDs.includes(record.chosenActionID),
        ),
      ).toBe(true);
    } finally {
      await game.end({ archive: false });
    }
  });
});
