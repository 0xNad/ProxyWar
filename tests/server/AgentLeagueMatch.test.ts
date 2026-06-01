import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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
  UnitType,
} from "../../src/core/game/Game";
import { GameMapLoader, MapData } from "../../src/core/game/GameMapLoader";
import {
  loadTerrainMap,
  MapManifest,
} from "../../src/core/game/TerrainMapLoader";
import { GameConfig, StampedIntent } from "../../src/core/Schemas";
import {
  AgentLeagueMatchRunner,
  agentStrategyProfiles,
  buildAttackScenarioSpawnPlan,
  buildSpawnCandidates,
  createAgentParticipants,
  createDefaultAgentSpecs,
} from "../../src/server/agents/AgentLeagueMatch";
import { AgentLocalGameMirror } from "../../src/server/agents/AgentLocalGameMirror";
import { runAgentStepLockedLeague } from "../../src/server/agents/AgentStepLockedLeague";
import { LlmAgentBrain } from "../../src/server/agents/LlmAgentBrain";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import { MockLlmProvider } from "../../src/server/agents/MockLlmProvider";
import { LegalAction } from "../../src/server/agents/AgentTypes";
import { GameServer } from "../../src/server/GameServer";
import { setup } from "../util/Setup";

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

const steppedServerConfig = {
  turnIntervalMs: () => 60 * 60 * 1_000,
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

describe("AgentLeagueMatchRunner", () => {
  it("runs four strategy profiles and records accepted opening decisions", async () => {
    const log = makeLogger();
    const candidateGame = await setup("big_plains", { nations: "disabled" });
    const spawnCandidates = buildSpawnCandidates(candidateGame.map(), {
      maxCandidates: 500,
    });
    const specs = createDefaultAgentSpecs(4);
    const participants = createAgentParticipants(specs, log);
    const game = new GameServer(
      "AGENT002",
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
      const records = await match.runOpeningTurn();

      expect(records).toHaveLength(4);
      expect(records.map((record) => record.profile)).toEqual([
        ...agentStrategyProfiles,
      ]);
      expect(records.every((record) => record.result.accepted)).toBe(true);
      expect(records.every((record) => record.reason.length > 0)).toBe(true);
      expect(records.every((record) => record.legalActionIDs.length > 0)).toBe(
        true,
      );
      expect(
        records.every((record) =>
          record.legalActionIDs.includes(record.chosenActionID),
        ),
      ).toBe(true);
      expect(
        records.every((record) => record.observationSummary.length > 0),
      ).toBe(true);
      expect(new Set(records.map((record) => record.sequence)).size).toBe(4);
      expect(
        new Set(
          records.map((record) =>
            record.intent?.type === "spawn" ? record.intent.tile : undefined,
          ),
        ).size,
      ).toBe(4);
      expect(minSpawnDistance(records)).toBeGreaterThanOrEqual(24);
    } finally {
      await game.end({ archive: false });
    }
  });

  it("runs opening decisions through mock LLM brains", async () => {
    const log = makeLogger();
    const candidateGame = await setup("big_plains", { nations: "disabled" });
    const spawnCandidates = buildSpawnCandidates(candidateGame.map(), {
      maxCandidates: 500,
    });
    const specs = createDefaultAgentSpecs(4);
    const participants = createAgentParticipants(specs, log, {
      brainFactory: (spec) =>
        new LlmAgentBrain({
          provider: new MockLlmProvider({ mode: "valid" }),
          profile: spec.profile,
        }),
    });
    const game = new GameServer(
      "AGENT005",
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
      const records = await match.runOpeningTurn();

      expect(records).toHaveLength(4);
      expect(records.every((record) => record.result.accepted)).toBe(true);
      expect(
        records.every((record) => record.decisionMetadata?.brain === "llm"),
      ).toBe(true);
      expect(
        records.every((record) => record.decisionMetadata?.llmParseOk === true),
      ).toBe(true);
      expect(records.every((record) => record.intent?.type === "spawn")).toBe(
        true,
      );
    } finally {
      await game.end({ archive: false });
    }
  });

  it("records a multi-action planner/executor batch from one brain decision", async () => {
    const log = makeLogger();
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand",
        intent: null,
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true },
      },
      {
        id: "build:City:100",
        kind: "build",
        label: "Build City",
        intent: null,
        risk: { level: "low", score: 0.1 },
        metadata: { role: "economic", unit: UnitType.City },
      },
      {
        id: "alliance:request:RIVAL001",
        kind: "alliance_request",
        label: "Request Alliance",
        intent: null,
        risk: { level: "low", score: 0.1 },
        metadata: { recipientID: "RIVAL001" },
      },
      {
        id: "hold",
        kind: "hold",
        label: "Hold",
        intent: null,
        risk: { level: "none", score: 0 },
      },
    ];
    const participants = createAgentParticipants(
      [{ username: "Batch Agent", profile: "opportunistic" }],
      log,
      {
        brainFactory: () => ({
          brainType: "planner-executor",
          decide: () => ({
            actionID: "expand:terra-nullius:10",
            actionIDs: [
              "expand:terra-nullius:10",
              "build:City:100",
              "invented:admin:kick",
              "alliance:request:RIVAL001",
            ],
            reason: "run compatible modules",
            metadata: {
              plannerRan: true,
              plannerLatencyMs: 12,
              plannerPromptLength: 1000,
              planPlannerSource: "codex-cli",
            },
          }),
        }),
      },
    );
    const game = new GameServer(
      "AGENT_BATCH",
      log,
      Date.now(),
      serverConfig,
      gameConfig,
    );
    const match = new AgentLeagueMatchRunner({
      game,
      participants,
      spawnCandidates: [],
      log,
      legalActionBuilder: {
        build: () => legalActions,
      } as unknown as LegalActionBuilder,
    });

    try {
      const records = await match.runDecisionTurn({ turnNumber: 2 });

      expect(records.map((record) => record.chosenActionID)).toEqual([
        "expand:terra-nullius:10",
        "build:City:100",
        "alliance:request:RIVAL001",
      ]);
      expect(records.map((record) => record.decisionMetadata?.batchIndex)).toEqual([
        0,
        1,
        2,
      ]);
      expect(records[0].decisionMetadata).toMatchObject({
        batchSize: 3,
        batchRejectedActionIDs: "invented:admin:kick",
        plannerRan: true,
      });
      expect(records[1].decisionMetadata).toMatchObject({
        plannerRan: false,
        plannerLatencyMs: 0,
        plannerPromptLength: 0,
      });
    } finally {
      await game.end({ archive: false });
    }
  });

  it("proves chosen multi-agent spawn decisions execute legally in core", async () => {
    const log = makeLogger();
    const candidateGame = await setup("big_plains", { nations: "disabled" });
    const spawnCandidates = buildSpawnCandidates(candidateGame.map(), {
      maxCandidates: 500,
    });
    const specs = createDefaultAgentSpecs(4);
    const participants = createAgentParticipants(specs, log);
    const game = new GameServer(
      "AGENT003",
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
      const records = await match.runOpeningTurn();
      const playerInfos = records.map(
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
      const executor = new Executor(coreGame, "AGENT003", undefined);
      const intents = records.map((record) => ({
        ...spawnIntent(record),
        clientID: record.clientID!,
      })) as StampedIntent[];

      coreGame.addExecution(
        ...executor.createExecs({
          turnNumber: 0,
          intents,
        }),
      );

      let ticks = 0;
      while (coreGame.inSpawnPhase() && ticks < 1000) {
        coreGame.executeNextTick();
        ticks++;
      }

      expect(ticks).toBeLessThan(1000);
      for (const record of records) {
        const intent = spawnIntent(record);
        expect(coreGame.playerByClientID(record.clientID!)?.spawnTile()).toBe(
          intent.tile,
        );
      }
    } finally {
      await game.end({ archive: false });
    }
  });

  it("runs a real post-spawn decision turn from live core state", async () => {
    const log = makeLogger();
    const candidateGame = await setup("big_plains", { nations: "disabled" });
    const spawnCandidates = buildSpawnCandidates(candidateGame.map(), {
      maxCandidates: 500,
    });
    const specs = createDefaultAgentSpecs(4);
    const participants = createAgentParticipants(specs, log);
    const game = new GameServer(
      "AGENT004",
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
      const executor = new Executor(coreGame, "AGENT004", undefined);

      coreGame.addExecution(
        ...executor.createExecs({
          turnNumber: 0,
          intents: openingRecords.map((record) => ({
            ...spawnIntent(record),
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

      const postSpawnRecords = await match.runDecisionTurn({
        turnNumber: 1,
        gameState: coreGame,
      });

      expect(postSpawnRecords).toHaveLength(4);
      expect(
        postSpawnRecords.every((record) =>
          record.legalActionIDs.includes("hold"),
        ),
      ).toBe(true);
      expect(
        postSpawnRecords.every((record) =>
          record.legalActionIDs.includes(record.chosenActionID),
        ),
      ).toBe(true);
      expect(
        postSpawnRecords.some(
          (record) => record.chosenActionKind === "alliance_request",
        ),
      ).toBe(true);

      const submittedIntents = postSpawnRecords
        .filter((record) => record.intent !== null)
        .map((record) => ({
          ...record.intent!,
          clientID: record.clientID!,
        })) as StampedIntent[];

      expect(submittedIntents.length).toBeGreaterThan(0);

      coreGame.addExecution(
        ...executor.createExecs({
          turnNumber: 1,
          intents: submittedIntents,
        }),
      );
      coreGame.executeNextTick();

      const allianceRecord = postSpawnRecords.find(
        (record) => record.intent?.type === "allianceRequest",
      );
      if (allianceRecord?.intent?.type !== "allianceRequest") {
        throw new Error("expected at least one alliance request");
      }
      const allianceIntent = allianceRecord.intent;
      const requestor = coreGame.playerByClientID(allianceRecord.clientID!);
      expect(
        requestor
          ?.outgoingAllianceRequests()
          .some(
            (request) => request.recipient().id() === allianceIntent.recipient,
          ),
      ).toBe(true);
    } finally {
      await game.end({ archive: false });
    }
  });

  it("allows reciprocal same-turn alliance requests without unrelated diplomacy collisions", async () => {
    const log = makeLogger();
    const candidateGame = await setup("big_plains", { nations: "disabled" });
    const spawnCandidates = buildSpawnCandidates(candidateGame.map(), {
      maxCandidates: 500,
    });
    const specs = createDefaultAgentSpecs(4);
    const participants = createAgentParticipants(specs, log, {
      brainFactory: () => ({
        brainType: "rule",
        decide: ({ observation, legalActions }) => {
          const allianceSenderID =
            observation.recentCommunications?.find(
              (signal) => signal.intent === "propose_alliance",
            )?.senderPlayerID ?? null;
          const reciprocal =
            allianceSenderID === null
              ? undefined
              : legalActions.find(
                  (action) =>
                    action.kind === "alliance_request" &&
                    action.metadata?.recipientID === allianceSenderID,
                );
          const selected =
            reciprocal ??
            legalActions.find((action) => action.kind === "alliance_request") ??
            legalActions.find((action) => action.kind === "spawn") ??
            legalActions[0];
          return {
            actionID: selected.id,
            reason: "prefer alliance when available",
          };
        },
      }),
    });
    const game = new GameServer(
      "AGENT011",
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
      const executor = new Executor(coreGame, "AGENT011", undefined);

      coreGame.addExecution(
        ...executor.createExecs({
          turnNumber: 0,
          intents: openingRecords.map((record) => ({
            ...spawnIntent(record),
            clientID: record.clientID!,
          })) as StampedIntent[],
        }),
      );

      let ticks = 0;
      while (coreGame.inSpawnPhase() && ticks < 1000) {
        coreGame.executeNextTick();
        ticks++;
      }

      const postSpawnRecords = await match.runDecisionTurn({
        turnNumber: 1,
        gameState: coreGame,
      });
      const allianceRecords = postSpawnRecords.filter(
        (record) => record.intent?.type === "allianceRequest",
      );

      expect(allianceRecords.length).toBeGreaterThan(0);
      const seenPairs = new Set<string>();
      let reciprocalPair: { requestorID: string; recipientID: string } | null =
        null;
      for (const record of allianceRecords) {
        if (record.intent?.type !== "allianceRequest") {
          throw new Error("expected alliance request intent");
        }
        const requestor = coreGame.playerByClientID(record.clientID!);
        expect(requestor).toBeDefined();
        const pair = `${requestor!.id()}->${record.intent.recipient}`;
        const reversePair = `${record.intent.recipient}->${requestor!.id()}`;
        if (seenPairs.has(reversePair)) {
          reciprocalPair = {
            requestorID: requestor!.id(),
            recipientID: record.intent.recipient,
          };
        }
        seenPairs.add(pair);
      }
      expect(reciprocalPair).not.toBeNull();

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        coreGame.addExecution(
          ...executor.createExecs({
            turnNumber: 1,
            intents: allianceRecords.map((record) => ({
              ...record.intent!,
              clientID: record.clientID!,
            })) as StampedIntent[],
          }),
        );
        coreGame.executeNextTick();
        if (reciprocalPair === null) {
          throw new Error("expected a reciprocal alliance request pair");
        }
        const requestor = coreGame.player(reciprocalPair.requestorID);
        const recipient = coreGame.player(reciprocalPair.recipientID);
        expect(requestor.isAlliedWith(recipient)).toBe(true);
        expect(
          warnSpy.mock.calls.some(([message]) =>
            String(message).includes("cannot send alliance request"),
          ),
        ).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      await game.end({ archive: false });
    }
  });

  it("submits a deterministic post-spawn attack through GameServer and core execution", async () => {
    const log = makeLogger();
    const candidateGame = await setup("big_plains", { nations: "disabled" });
    const attackPlan = buildAttackScenarioSpawnPlan(candidateGame.map(), {
      agentCount: 4,
    });
    const specs = createDefaultAgentSpecs(4);
    const participants = createAgentParticipants(specs, log, {
      brainFactory: (spec) =>
        new LlmAgentBrain({
          provider: new MockLlmProvider({
            mode:
              spec.profile === "aggressive" ? "attack" : "spawn_then_hold",
          }),
          profile: spec.profile,
        }),
    });
    const game = new GameServer(
      "AGENT006",
      log,
      Date.now(),
      serverConfig,
      { ...gameConfig, spawnImmunityDuration: 0 },
    );
    const match = new AgentLeagueMatchRunner({
      game,
      participants,
      spawnCandidates: attackPlan.spawnCandidates,
      log,
      minSpawnDistance: 1,
    });

    try {
      match.attachAgents();
      match.startGame();
      const openingRecords = await match.runOpeningTurn();
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
        { nations: "disabled", spawnImmunityDuration: 0 },
        playerInfos,
      );
      const executor = new Executor(coreGame, "AGENT006", undefined);

      coreGame.addExecution(
        ...executor.createExecs({
          turnNumber: 0,
          intents: openingRecords.map((record) => ({
            ...spawnIntent(record),
            clientID: record.clientID!,
          })) as StampedIntent[],
        }),
      );

      let ticks = 0;
      while (coreGame.inSpawnPhase() && ticks < 1000) {
        coreGame.executeNextTick();
        ticks++;
      }

      const attacker = coreGame.playerByClientID(openingRecords[0].clientID!);
      const target = coreGame.playerByClientID(openingRecords[1].clientID!);
      expect(attacker?.spawnTile()).toBe(attackPlan.attackerTile);
      expect(target?.spawnTile()).toBe(attackPlan.targetTile);
      expect(attacker?.sharesBorderWith(target!)).toBe(true);
      expect(attacker?.canAttackPlayer(target!)).toBe(true);

      const postSpawnRecords = await match.runDecisionTurn({
        turnNumber: 1,
        gameState: coreGame,
      });
      const attackRecord = postSpawnRecords.find(
        (record) => record.intent?.type === "attack" && record.result.accepted,
      );

      expect(attackRecord).toBeDefined();
      expect(attackRecord?.chosenActionKind).toBe("attack");
      expect(attackRecord?.attackActionIDs.length).toBeGreaterThan(0);
      expect(attackRecord?.chosenActionMetadata).toMatchObject({
        targetID: expect.any(String),
        troopPercent: expect.any(Number),
        legalReason: expect.any(String),
      });

      coreGame.addExecution(
        ...executor.createExecs({
          turnNumber: 1,
          intents: postSpawnRecords
            .filter((record) => record.intent !== null)
            .map((record) => ({
              ...record.intent!,
              clientID: record.clientID!,
            })) as StampedIntent[],
        }),
      );
      coreGame.executeNextTick();
      coreGame.executeNextTick();

      if (attackRecord?.intent?.type !== "attack") {
        throw new Error("expected accepted attack intent");
      }
      const targetID = attackRecord.intent.targetID;
      const coreAttacker = coreGame.playerByClientID(attackRecord.clientID!);
      const hasOutgoingAttack =
        coreAttacker
          ?.outgoingAttacks()
          .some((attack) => attack.target().id() === targetID) ?? false;
      const attacksSent =
        coreAttacker === null
          ? undefined
          : coreGame.stats().getPlayerStats(coreAttacker)?.attacks?.[0];
      const hasRecordedAttack =
        typeof attacksSent === "bigint"
          ? attacksSent > 0n
          : Number(attacksSent ?? 0) > 0;

      expect(hasOutgoingAttack || hasRecordedAttack).toBe(true);
    } finally {
      await game.end({ archive: false });
    }
  });

  it("submits normal-map post-spawn build actions through GameServer and core execution", async () => {
    const log = makeLogger();
    const candidateGame = await setup("big_plains", { nations: "disabled" });
    const spawnCandidates = buildSpawnCandidates(candidateGame.map(), {
      maxCandidates: 500,
    });
    const specs = createDefaultAgentSpecs(4);
    const participants = createAgentParticipants(specs, log, {
      brainFactory: (spec) =>
        new LlmAgentBrain({
          provider: new MockLlmProvider({
            mode: spec.profile === "diplomatic" ? "support" : "build",
          }),
          profile: spec.profile,
        }),
    });
    const game = new GameServer(
      "AGENT007",
      log,
      Date.now(),
      serverConfig,
      { ...gameConfig, startingGold: 200_000 },
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
        { nations: "disabled", startingGold: 200_000 },
        playerInfos,
      );
      const executor = new Executor(coreGame, "AGENT007", undefined);

      coreGame.addExecution(
        ...executor.createExecs({
          turnNumber: 0,
          intents: openingRecords.map((record) => ({
            ...spawnIntent(record),
            clientID: record.clientID!,
          })) as StampedIntent[],
        }),
      );

      let ticks = 0;
      while (coreGame.inSpawnPhase() && ticks < 1000) {
        coreGame.executeNextTick();
        ticks++;
      }

      const postSpawnRecords = await match.runDecisionTurn({
        turnNumber: 1,
        gameState: coreGame,
      });
      const buildRecord = postSpawnRecords.find(
        (record) =>
          record.intent?.type === "build_unit" && record.result.accepted,
      );

      expect(buildRecord).toBeDefined();
      expect(buildRecord?.chosenActionKind).toBe("build");
      expect(buildRecord?.legalActionIDsByKind.build?.length).toBeGreaterThan(
        0,
      );
      expect(
        [
          UnitType.City,
          UnitType.Factory,
          UnitType.DefensePost,
          UnitType.Port,
          UnitType.SAMLauncher,
        ].includes(buildRecord?.chosenActionMetadata?.unit as UnitType),
      ).toBe(true);
      expect(buildRecord?.chosenActionMetadata).toMatchObject({
        buildTile: expect.any(Number),
        legalReason: expect.stringContaining("core canBuild"),
        buildPlacementReason: expect.any(String),
      });

      coreGame.addExecution(
        ...executor.createExecs({
          turnNumber: 1,
          intents: postSpawnRecords
            .filter((record) => record.intent !== null)
            .map((record) => ({
              ...record.intent!,
              clientID: record.clientID!,
            })) as StampedIntent[],
        }),
      );
      coreGame.executeNextTick();
      coreGame.executeNextTick();

      if (buildRecord?.intent?.type !== "build_unit") {
        throw new Error("expected accepted build intent");
      }
      const builder = coreGame.playerByClientID(buildRecord.clientID!);
      expect(builder?.units(buildRecord.intent.unit).length).toBeGreaterThan(0);
    } finally {
      await game.end({ archive: false });
    }
  });

  it("runs step-locked mock LLM decisions before excessive turn advancement", async () => {
    const log = makeLogger();
    const mapLoader = new StaticMapLoader();
    const config = { ...gameConfig, gameMapSize: GameMapSize.Compact };
    const terrain = await loadTerrainMap(
      config.gameMap,
      config.gameMapSize,
      mapLoader,
    );
    const specs = createDefaultAgentSpecs(4);
    const participants = createAgentParticipants(specs, log, {
      brainFactory: (spec) =>
        new LlmAgentBrain({
          provider: new MockLlmProvider({
            mode: "valid",
            preferKind:
              spec.profile === "diplomatic" ? "alliance_request" : undefined,
          }),
          profile: spec.profile,
          brainType: "mock-llm",
          providerTimeoutMs: 100,
        }),
    });
    const game = new GameServer(
      "AGENT008",
      log,
      Date.now(),
      steppedServerConfig,
      config,
    );
    const match = new AgentLeagueMatchRunner({
      game,
      participants,
      spawnCandidates: buildSpawnCandidates(terrain.gameMap, {
        maxCandidates: 500,
        stride: 2,
      }),
      log,
    });
    const mirror = new AgentLocalGameMirror(mapLoader, log);

    try {
      match.attachAgents();
      match.startGame();
      const result = await runAgentStepLockedLeague({
        league: match,
        game,
        mirror,
        messages: () => participants[0]?.runner.serverMessages() ?? [],
        config: {
          turnsPerDecisionStep: 25,
          turnsPerDecisionSchedule: [25],
          maxSteps: 1,
          maxSpawnAdvanceTurns: 2_000,
          maxDecisionMs: 100,
          waitForMirrorCatchup: true,
        },
        log,
      });

      expect(result.openingRecords).toHaveLength(4);
      expect(result.postSpawnRecords).toHaveLength(4);
      expect(result.finalGameState.inSpawnPhase()).toBe(false);
      expect(result.mirrorCatchupSucceeded).toBe(true);
      expect(result.turnsPerDecisionSchedule).toEqual([25]);
      expect(
        Math.max(...result.postSpawnRecords.map((record) => record.turnNumber)),
      ).toBeLessThan(2_000);
      expect(
        result.postSpawnRecords.some(
          (record) =>
            record.chosenActionKind !== "hold" &&
            record.chosenActionKind !== "spawn",
        ),
      ).toBe(true);
      expect(
        result.postSpawnRecords.every(
          (record) => record.decisionLatencyMs >= 0,
        ),
      ).toBe(true);
    } finally {
      await game.end({ archive: false });
    }
  }, 600_000);

  it("falls back safely when a step-locked custom brain times out", async () => {
    const log = makeLogger();
    const mapLoader = new StaticMapLoader();
    const config = { ...gameConfig, gameMapSize: GameMapSize.Compact };
    const terrain = await loadTerrainMap(
      config.gameMap,
      config.gameMapSize,
      mapLoader,
    );
    const specs = createDefaultAgentSpecs(4);
    const participants = createAgentParticipants(specs, log, {
      brainFactory: () => ({
        brainType: "mock-llm",
        decide: () => new Promise(() => undefined),
      }),
    });
    const game = new GameServer(
      "AGENT009",
      log,
      Date.now(),
      steppedServerConfig,
      config,
    );
    const match = new AgentLeagueMatchRunner({
      game,
      participants,
      spawnCandidates: buildSpawnCandidates(terrain.gameMap, {
        maxCandidates: 500,
        stride: 2,
      }),
      log,
    });
    const mirror = new AgentLocalGameMirror(mapLoader, log);

    try {
      match.attachAgents();
      match.startGame();
      const result = await runAgentStepLockedLeague({
        league: match,
        game,
        mirror,
        messages: () => participants[0]?.runner.serverMessages() ?? [],
        config: {
          turnsPerDecisionStep: 25,
          maxSteps: 1,
          maxSpawnAdvanceTurns: 2_000,
          maxDecisionMs: 1,
          waitForMirrorCatchup: true,
        },
        log,
      });

      const records = [...result.openingRecords, ...result.postSpawnRecords];
      expect(records).toHaveLength(8);
      expect(
        records.every(
          (record) => record.decisionMetadata?.fallbackUsed === true,
        ),
      ).toBe(true);
      expect(records.every((record) => record.result.accepted)).toBe(true);
    } finally {
      await game.end({ archive: false });
    }
  }, 600_000);
});

function spawnIntent(record: { intent: AgentLeagueMatchIntent }) {
  if (record.intent?.type !== "spawn") {
    throw new Error("expected spawn intent");
  }
  return record.intent;
}

function minSpawnDistance(
  records: Awaited<ReturnType<AgentLeagueMatchRunner["runOpeningTurn"]>>,
): number {
  const points = records
    .map((record) => record.chosenActionMetadata)
    .filter(
      (metadata): metadata is { x: number; y: number } =>
        typeof metadata?.x === "number" && typeof metadata?.y === "number",
    );
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      min = Math.min(
        min,
        Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y),
      );
    }
  }
  return min;
}

type AgentLeagueMatchIntent = Awaited<
  ReturnType<AgentLeagueMatchRunner["decisionRecords"]>
>[number]["intent"];

function agentPlayerID(index: number): string {
  return `AGP${String(index).padStart(5, "0")}`;
}

class StaticMapLoader implements GameMapLoader {
  private readonly maps = new Map<GameMapType, MapData>();
  private readonly rootDir: string;

  constructor() {
    const currentFile = fileURLToPath(import.meta.url);
    this.rootDir = path.resolve(path.dirname(currentFile), "../../resources/maps");
  }

  getMapData(map: GameMapType): MapData {
    const cached = this.maps.get(map);
    if (cached !== undefined) {
      return cached;
    }

    const mapDir = path.join(this.rootDir, this.mapDirectoryName(map));
    const mapData = {
      mapBin: () => fs.promises.readFile(path.join(mapDir, "map.bin")),
      map4xBin: () => fs.promises.readFile(path.join(mapDir, "map4x.bin")),
      map16xBin: () => fs.promises.readFile(path.join(mapDir, "map16x.bin")),
      manifest: () =>
        fs.promises
          .readFile(path.join(mapDir, "manifest.json"), "utf8")
          .then((text) => JSON.parse(text) as MapManifest),
      webpPath: path.join(mapDir, "thumbnail.webp"),
    } satisfies MapData;

    this.maps.set(map, mapData);
    return mapData;
  }

  private mapDirectoryName(map: GameMapType): string {
    const enumKey = Object.keys(GameMapType).find(
      (key) => GameMapType[key as keyof typeof GameMapType] === map,
    );
    if (enumKey === undefined) {
      throw new Error(`Unknown map: ${map}`);
    }
    return enumKey.toLowerCase();
  }
}
