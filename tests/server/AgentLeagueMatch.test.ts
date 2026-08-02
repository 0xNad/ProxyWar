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
  Game,
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
import { externalBrainCleanlinessReport } from "../../src/server/agents/AgentExternalBrainCleanliness";
import {
  AgentLeagueMatchRunner,
  AgentSpec,
  agentStrategyProfiles,
  buildAttackScenarioSpawnPlan,
  buildSpawnCandidates,
  createAgentParticipants,
  createDefaultAgentSpecs,
} from "../../src/server/agents/AgentLeagueMatch";
import { AgentLocalGameMirror } from "../../src/server/agents/AgentLocalGameMirror";
import { SPAWN_CONVERGE_PROGRESS } from "../../src/server/agents/AgentSpawnExplorer";
import { runAgentStepLockedLeague } from "../../src/server/agents/AgentStepLockedLeague";
import { LlmAgentBrain } from "../../src/server/agents/LlmAgentBrain";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import { MockLlmProvider } from "../../src/server/agents/MockLlmProvider";
import {
  AgentDecision,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
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

function deferredDecision(
  actionID: string,
  reason: string,
): {
  promise: Promise<AgentDecision>;
  resolve: () => void;
} {
  let resolvePromise: (decision: AgentDecision) => void = () => {};
  return {
    promise: new Promise((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: () => resolvePromise({ actionID, reason }),
  };
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
      expect(
        records.every((record) => (record.reason?.length ?? 0) > 0),
      ).toBe(true);
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

  it("requests all participant decisions in parallel before applying them in roster order", async () => {
    const log = makeLogger();
    const legalActions: LegalAction[] = [
      {
        id: "hold",
        kind: "hold",
        label: "Hold",
        intent: null,
        risk: { level: "none", score: 0 },
      },
    ];
    const calls: string[] = [];
    const deferred = [
      deferredDecision("hold", "first held"),
      deferredDecision("hold", "second held"),
    ];
    const participants = createAgentParticipants(
      [
        { username: "Slow Agent", profile: "opportunistic" },
        { username: "Other Agent", profile: "aggressive" },
      ],
      log,
      {
        brainFactory: (spec, index) => ({
          brainType: "rule",
          decide: () => {
            calls.push(spec.username);
            return deferred[index].promise;
          },
        }),
      },
    );
    const game = new GameServer(
      "AGENT_PARALLEL",
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
      const recordsPromise = match.runDecisionTurn({ turnNumber: 2 });
      await Promise.resolve();

      expect(calls).toEqual(["Slow Agent", "Other Agent"]);

      deferred[1].resolve();
      await Promise.resolve();
      deferred[0].resolve();
      const records = await recordsPromise;

      expect(records.map((record) => record.username)).toEqual([
        "Slow Agent",
        "Other Agent",
      ]);
      expect(records.map((record) => record.chosenActionID)).toEqual([
        "hold",
        "hold",
      ]);
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

  it("drives the spawn phase deterministically with zero brain calls (runSpawnPhase)", async () => {
    const log = makeLogger();
    const mapLoader = new StaticMapLoader();
    const config = { ...gameConfig, gameMapSize: GameMapSize.Compact };
    const terrain = await loadTerrainMap(
      config.gameMap,
      config.gameMapSize,
      mapLoader,
    );
    const specs = createDefaultAgentSpecs(4);
    // The spy proves the LLM Commander is fully bypassed during spawn: any call
    // to brain.decide while runSpawnPhase drives the phase is a regression.
    const decideSpy = vi.fn(async () => ({
      actionID: "hold",
      reason: "the brain must not be consulted during the spawn phase",
    }));
    const participants = createAgentParticipants(specs, log, {
      brainFactory: () => ({ brainType: "mock-llm", decide: decideSpy }),
    });
    const game = new GameServer(
      "AGENT012",
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
      const spawnRecords = await match.runSpawnPhase({
        mirror,
        messages: () => participants[0]?.runner.serverMessages() ?? [],
        turnsPerSpawnTick: 25,
      });

      // No LLM during spawn.
      expect(decideSpy).not.toHaveBeenCalled();

      // Every spawn record is the synthetic deterministic-explorer decision: a
      // legal spawn tile (accepted) flagged as non-LLM output so the aliveness
      // (rawProviderOutputRecordCount) and cleanliness (rejectedIntents) reports
      // stay uncorrupted.
      expect(spawnRecords.length).toBeGreaterThan(0);
      expect(
        spawnRecords.every((record) => record.chosenActionKind === "spawn"),
      ).toBe(true);
      expect(spawnRecords.every((record) => record.result.accepted)).toBe(true);
      expect(
        spawnRecords.every(
          (record) =>
            record.decisionMetadata?.rawProviderOutputPresent === false &&
            record.decisionMetadata?.actionSelectionSource ===
              "deterministic-spawn" &&
            record.decisionMetadata?.spawnExploration === true,
        ),
      ).toBe(true);
      expect(
        externalBrainCleanlinessReport({
          brainMode: "mock-llm",
          records: spawnRecords,
        }).rejectedIntents,
      ).toBe(0);

      // Jumps around: each agent visits >= 2 distinct spawn tiles over the phase.
      const agentIDs = [...new Set(spawnRecords.map((record) => record.agentID))];
      expect(agentIDs).toHaveLength(4);
      for (const agentID of agentIDs) {
        const tiles = new Set(
          spawnRecords
            .filter((record) => record.agentID === agentID)
            .map((record) => spawnIntent(record).tile),
        );
        expect(tiles.size).toBeGreaterThanOrEqual(2);
      }

      // The loop returns because the spawn phase actually ended...
      const mirrorGame = mirror.gameState();
      if (mirrorGame === null) {
        throw new Error("expected mirror game state after the spawn phase");
      }
      expect(mirrorGame.inSpawnPhase()).toBe(false);

      // ...and the LAST recorded spawn per agent is the tile the player actually
      // spawned on (each re-issued SpawnExecution relocates; the final one wins),
      // so the decision log's settle tile matches the replay.
      for (const agentID of agentIDs) {
        const agentRecords = spawnRecords.filter(
          (record) => record.agentID === agentID,
        );
        const lastRecord = agentRecords[agentRecords.length - 1];
        expect(
          mirrorGame.playerByClientID(lastRecord.clientID!)?.spawnTile(),
        ).toBe(spawnIntent(lastRecord).tile);
      }
    } finally {
      await game.end({ archive: false });
    }
  }, 600_000);

  it("runs the mirror's game on the episode's own map dataset (preloadedTerrain)", async () => {
    const log = makeLogger();
    const mapLoader = new StaticMapLoader();
    const config = { ...gameConfig, gameMapSize: GameMapSize.Compact };
    // cache:false + preloadedTerrain is the coworld episode wiring: one parsed
    // map dataset serves the spawn scan and the game itself.
    const terrain = await loadTerrainMap(
      config.gameMap,
      config.gameMapSize,
      mapLoader,
      { cache: false },
    );
    const specs = createDefaultAgentSpecs(2);
    const participants = createAgentParticipants(specs, log, {
      brainFactory: () => ({
        brainType: "mock-llm",
        decide: async () => ({ actionID: "hold", reason: "unused in spawn" }),
      }),
    });
    const game = new GameServer(
      "AGENT013",
      log,
      Date.now(),
      steppedServerConfig,
      config,
    );
    const match = new AgentLeagueMatchRunner({
      game,
      participants,
      spawnCandidates: buildSpawnCandidates(terrain.gameMap, {
        maxCandidates: 200,
        stride: 2,
      }),
      log,
    });
    const mirror = new AgentLocalGameMirror(mapLoader, log, terrain);

    try {
      match.attachAgents();
      match.startGame();
      const spawnRecords = await match.runSpawnPhase({
        mirror,
        messages: () => participants[0]?.runner.serverMessages() ?? [],
        turnsPerSpawnTick: 25,
      });
      expect(spawnRecords.length).toBeGreaterThan(0);
      const mirrorGame = mirror.gameState();
      if (mirrorGame === null) {
        throw new Error("expected mirror game state after the spawn phase");
      }
      // The proof of single-copy sharing: the game's map IS the instance the
      // spawn scan ran on, not a second load.
      expect(mirrorGame.map()).toBe(terrain.gameMap);
    } finally {
      await game.end({ archive: false });
    }
  }, 600_000);

  it("returns isolated datasets when the terrain cache is bypassed", async () => {
    const mapLoader = new StaticMapLoader();
    const config = { ...gameConfig, gameMapSize: GameMapSize.Compact };
    const a = await loadTerrainMap(config.gameMap, config.gameMapSize, mapLoader, {
      cache: false,
    });
    const b = await loadTerrainMap(config.gameMap, config.gameMapSize, mapLoader, {
      cache: false,
    });
    expect(a.gameMap).not.toBe(b.gameMap);
    // Mutating one uncached dataset must not leak into the other, and must not
    // poison the cached path either.
    const tile = a.gameMap.ref(1, 1);
    a.gameMap.setOwnerID(tile, 9);
    expect(b.gameMap.hasOwner(tile)).toBe(false);
    const cached = await loadTerrainMap(
      config.gameMap,
      config.gameMapSize,
      mapLoader,
    );
    expect(cached.gameMap.hasOwner(tile)).toBe(false);
  });

  it("retains the turn stream on the primary seat only when asked", async () => {
    const log = makeLogger();
    const mapLoader = new StaticMapLoader();
    const config = { ...gameConfig, gameMapSize: GameMapSize.Compact };
    const terrain = await loadTerrainMap(
      config.gameMap,
      config.gameMapSize,
      mapLoader,
      { cache: false },
    );
    const specs = createDefaultAgentSpecs(3);
    const participants = createAgentParticipants(specs, log, {
      brainFactory: () => ({
        brainType: "mock-llm",
        decide: async () => ({ actionID: "hold", reason: "unused in spawn" }),
      }),
      retainTurnMessagesPrimaryOnly: true,
    });
    const game = new GameServer(
      "AGENT014",
      log,
      Date.now(),
      steppedServerConfig,
      config,
    );
    const match = new AgentLeagueMatchRunner({
      game,
      participants,
      spawnCandidates: buildSpawnCandidates(terrain.gameMap, {
        maxCandidates: 200,
        stride: 2,
      }),
      log,
    });
    const mirror = new AgentLocalGameMirror(mapLoader, log, terrain);

    try {
      match.attachAgents();
      match.startGame();
      const spawnRecords = await match.runSpawnPhase({
        mirror,
        messages: () => participants[0]?.runner.serverMessages() ?? [],
        turnsPerSpawnTick: 25,
      });
      // The mirror-driven flow works end to end off the primary stream...
      expect(spawnRecords.length).toBeGreaterThan(0);
      const primaryTurns = participants[0].runner
        .serverMessages()
        .filter((message) => message.type === "turn");
      expect(primaryTurns.length).toBeGreaterThan(0);
      // ...while non-primary seats retain the handshake but zero turn bulk,
      // and their intent submissions were still acknowledged (spawn records
      // exist for every seat, which requires the error-scan path to work).
      for (const participant of participants.slice(1)) {
        const messages = participant.runner.serverMessages();
        expect(messages.length).toBeGreaterThan(0);
        expect(
          messages.filter((message) => message.type === "turn"),
        ).toHaveLength(0);
      }
      const seatsWithRecords = new Set(
        spawnRecords.map((record) => record.agentID),
      );
      expect(seatsWithRecords.size).toBe(3);
    } finally {
      await game.end({ archive: false });
    }
  }, 600_000);

  it("stops spawn submissions at the phase boundary so the final record is the real spawn", async () => {
    const log = makeLogger();
    const mapLoader = new StaticMapLoader();
    const config = { ...gameConfig, gameMapSize: GameMapSize.Compact };
    const terrain = await loadTerrainMap(
      config.gameMap,
      config.gameMapSize,
      mapLoader,
    );
    const specs = createDefaultAgentSpecs(1);
    const decideSpy = vi.fn(async () => ({
      actionID: "hold",
      reason: "the brain must not be consulted during the spawn phase",
    }));
    const participants = createAgentParticipants(specs, log, {
      brainFactory: () => ({ brainType: "mock-llm", decide: decideSpy }),
    });
    const game = new GameServer(
      "AGENT013",
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
      // Default minSpawnDistance on purpose: stake-based reservation only
      // excludes OTHER agents' current stakes, and this run has a single agent,
      // so the candidate pool stays alive through the WHOLE spawn phase and the
      // loop still has legal spawn tiles at the boundary tick
      // (ticks === numSpawnPhaseTurns). A submission there would be recorded as
      // accepted but land one server turn AFTER the phase closes and silently
      // never execute — a dead record whose tile contradicts the player's
      // actual spawn.
    });
    const mirror = new AgentLocalGameMirror(mapLoader, log);

    try {
      match.attachAgents();
      match.startGame();
      const spawnRecords = await match.runSpawnPhase({
        mirror,
        messages: () => participants[0]?.runner.serverMessages() ?? [],
        turnsPerSpawnTick: 25,
      });

      expect(decideSpy).not.toHaveBeenCalled();
      const mirrorGame = mirror.gameState();
      if (mirrorGame === null) {
        throw new Error("expected mirror game state after the spawn phase");
      }
      expect(mirrorGame.inSpawnPhase()).toBe(false);
      expect(spawnRecords.length).toBeGreaterThanOrEqual(2);
      // No submission at or past the boundary tick: a spawn intent submitted at
      // ticks >= numSpawnPhaseTurns cannot execute anymore (dead record).
      expect(
        Math.max(...spawnRecords.map((record) => record.turnNumber)),
      ).toBeLessThan(mirrorGame.config().numSpawnPhaseTurns());
      // Last-wins relocation: the final recorded spawn tile is where the player
      // actually spawned.
      const lastRecord = spawnRecords[spawnRecords.length - 1];
      expect(
        mirrorGame.playerByClientID(lastRecord.clientID!)?.spawnTile(),
      ).toBe(spawnIntent(lastRecord).tile);
    } finally {
      await game.end({ archive: false });
    }
  }, 600_000);

  it("releases vacated spawn stakes so relocation survives to the converge window (no pool exhaustion)", async () => {
    const log = makeLogger();
    const mapLoader = new StaticMapLoader();
    const config = { ...gameConfig, gameMapSize: GameMapSize.Compact };
    const terrain = await loadTerrainMap(
      config.gameMap,
      config.gameMapSize,
      mapLoader,
    );
    const specs = createDefaultAgentSpecs(4);
    const decideSpy = vi.fn(async () => ({
      actionID: "hold",
      reason: "the brain must not be consulted during the spawn phase",
    }));
    const participants = createAgentParticipants(specs, log, {
      brainFactory: () => ({ brainType: "mock-llm", decide: decideSpy }),
    });
    const game = new GameServer(
      "AGENT014",
      log,
      Date.now(),
      steppedServerConfig,
      config,
    );
    const spawnCandidates = buildSpawnCandidates(terrain.gameMap, {
      maxCandidates: 500,
      stride: 2,
    });
    // DEFAULT minSpawnDistance on purpose: the regression this guards is the
    // shared pool exhausting under the real pruning radius. Cumulative pruning
    // burned every submission's neighborhood forever — including the submitting
    // agent's own vacated picks — emptying a 500-candidate pool mid-phase, so
    // relocation froze around 40-60% progress and the converge-to-anchor settle
    // never ran on a live pool (watched run ab-ffa4p-spawnwatch-r1: submissions
    // stopped at turn 125 of 300).
    const match = new AgentLeagueMatchRunner({
      game,
      participants,
      spawnCandidates,
      log,
    });
    const mirror = new AgentLocalGameMirror(mapLoader, log);

    try {
      match.attachAgents();
      match.startGame();
      const spawnRecords = await match.runSpawnPhase({
        mirror,
        messages: () => participants[0]?.runner.serverMessages() ?? [],
        turnsPerSpawnTick: 25,
      });

      expect(decideSpy).not.toHaveBeenCalled();
      const mirrorGame = mirror.gameState();
      if (mirrorGame === null) {
        throw new Error("expected mirror game state after the spawn phase");
      }
      expect(mirrorGame.inSpawnPhase()).toBe(false);
      expect(spawnRecords.every((record) => record.result.accepted)).toBe(true);
      const spawnPhaseTurns = mirrorGame.config().numSpawnPhaseTurns();
      const agentIDs = [...new Set(spawnRecords.map((record) => record.agentID))];
      expect(agentIDs).toHaveLength(4);

      const lateThreshold = Math.floor(spawnPhaseTurns * 0.6);
      const convergeThreshold = Math.ceil(
        spawnPhaseTurns * SPAWN_CONVERGE_PROGRESS,
      );
      for (const agentID of agentIDs) {
        const agentRecords = spawnRecords.filter(
          (record) => record.agentID === agentID,
        );
        // Pool alive late: under cumulative pruning the pool emptied mid-phase
        // and submissions stopped before 60% progress; with stake release every
        // agent still relocates in the last 40% of the phase.
        expect(
          agentRecords.some((record) => record.turnNumber >= lateThreshold),
        ).toBe(true);
        // The final settle happens IN the converge window (>= 80% progress) and
        // before the boundary tick — the converge-to-anchor logic runs on a live
        // pool instead of the tile being locked in mid-phase.
        const last = agentRecords[agentRecords.length - 1]!;
        expect(last.turnNumber).toBeGreaterThanOrEqual(convergeThreshold);
        expect(last.turnNumber).toBeLessThan(spawnPhaseTurns);
        // Last-wins relocation: the settle tile is where the player actually
        // spawned.
        expect(
          mirrorGame.playerByClientID(last.clientID!)?.spawnTile(),
        ).toBe(spawnIntent(last).tile);
      }

      // Reservation invariant preserved: replaying submissions in order, no agent
      // ever picks a tile inside ANOTHER agent's CURRENT (most recent accepted)
      // stake neighborhood. Own previous stakes are released — relocating near
      // one's own vacated pick is legal.
      const candidateByTile = new Map(
        spawnCandidates.map((candidate) => [candidate.tile, candidate]),
      );
      const minDistance = match.effectiveMinSpawnDistance();
      expect(minDistance).toBeGreaterThan(1);
      const stakes = new Map<
        string,
        { x?: number; y?: number; tile: number }
      >();
      for (const record of spawnRecords) {
        const tile = spawnIntent(record).tile;
        const chosen = candidateByTile.get(tile);
        expect(chosen).toBeDefined();
        for (const [otherAgentID, stake] of stakes) {
          if (otherAgentID === record.agentID) {
            continue;
          }
          const distance =
            chosen!.x !== undefined &&
            chosen!.y !== undefined &&
            stake.x !== undefined &&
            stake.y !== undefined
              ? Math.hypot(chosen!.x - stake.x, chosen!.y - stake.y)
              : chosen!.tile === stake.tile
                ? 0
                : Number.POSITIVE_INFINITY;
          expect(distance).toBeGreaterThanOrEqual(minDistance);
        }
        stakes.set(record.agentID, chosen!);
      }
    } finally {
      await game.end({ archive: false });
    }
  }, 600_000);

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

  it("stops polling a seat once its player is eliminated and resumes on revival", async () => {
    const log = makeLogger();
    const candidateGame = await setup("big_plains", { nations: "disabled" });
    const spawnCandidates = buildSpawnCandidates(candidateGame.map(), {
      maxCandidates: 500,
    });
    const specs = createDefaultAgentSpecs(4);
    const participants = createAgentParticipants(specs, log);
    const game = new GameServer(
      "AGENTELM",
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
      const executor = new Executor(coreGame, "AGENTELM", undefined);

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

      const victimRecord = openingRecords[0];
      const victim = coreGame.playerByClientID(victimRecord.clientID!)!;
      const attacker = coreGame.playerByClientID(openingRecords[1].clientID!)!;
      expect(victim.isAlive()).toBe(true);
      const victimTiles = [...victim.tiles()];
      for (const tile of victimTiles) {
        attacker.conquer(tile);
      }
      // The core elimination rule this feature keys off: dead = zero tiles.
      expect(victim.isAlive()).toBe(false);
      expect(victim.hasSpawned()).toBe(true);

      const firstStep = await match.runDecisionTurn({
        turnNumber: 2,
        gameState: coreGame,
      });
      expect(firstStep).toHaveLength(3);
      expect(firstStep.map((record) => record.agentID)).not.toContain(
        victimRecord.agentID,
      );

      const secondStep = await match.runDecisionTurn({
        turnNumber: 3,
        gameState: coreGame,
      });
      expect(secondStep).toHaveLength(3);
      expect(secondStep.map((record) => record.agentID)).not.toContain(
        victimRecord.agentID,
      );

      // No post-elimination decision records exist for the dead seat, while
      // its pre-elimination (spawn) records are preserved.
      const victimRecords = match
        .decisionRecords()
        .filter((record) => record.agentID === victimRecord.agentID);
      expect(victimRecords.length).toBeGreaterThan(0);
      expect(victimRecords.every((record) => record.turnNumber < 2)).toBe(true);

      // The elimination is announced exactly once, not once per step.
      const infoMock = log.info as unknown as ReturnType<typeof vi.fn>;
      expect(
        infoMock.mock.calls.filter(
          ([message]) =>
            message === "league seat eliminated; decision polling stopped",
        ),
      ).toHaveLength(1);

      // Liveness is recomputed per step, never latched: a revived player
      // (e.g. a transport boat landing after total tile loss) is polled again.
      victim.conquer(victimTiles[0]);
      expect(victim.isAlive()).toBe(true);
      const revivedStep = await match.runDecisionTurn({
        turnNumber: 4,
        gameState: coreGame,
      });
      expect(revivedStep).toHaveLength(4);
      expect(revivedStep.map((record) => record.agentID)).toContain(
        victimRecord.agentID,
      );
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

      // Built-in-style spawn: runSpawnPhase emits one deterministic (non-LLM) spawn
      // record per agent PER spawn tick (the agent jumps around), not one per agent.
      const spawnRecords = result.openingRecords;
      expect(new Set(spawnRecords.map((record) => record.agentID)).size).toBe(4);
      expect(
        spawnRecords.every((record) => record.chosenActionKind === "spawn"),
      ).toBe(true);
      // Deterministic, no LLM: every spawn record is the synthetic explorer decision,
      // never an LLM call (keeps it out of the aliveness count) and always accepted.
      expect(
        spawnRecords.every(
          (record) => record.decisionMetadata?.spawnExploration === true,
        ),
      ).toBe(true);
      expect(
        spawnRecords.every(
          (record) => record.decisionMetadata?.rawProviderOutputPresent !== true,
        ),
      ).toBe(true);
      expect(spawnRecords.every((record) => record.result.accepted)).toBe(true);
      // Jumps around: each agent visits >= 2 distinct spawn tiles over the phase.
      for (const agentID of new Set(spawnRecords.map((r) => r.agentID))) {
        const tiles = new Set(
          spawnRecords
            .filter((record) => record.agentID === agentID)
            .map((record) => record.chosenActionID),
        );
        expect(tiles.size).toBeGreaterThanOrEqual(2);
      }
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

      // Spawn is deterministic now (no brain), so a timing-out brain does NOT affect it:
      // every spawn record is the synthetic explorer decision and is accepted.
      expect(
        result.openingRecords.every(
          (record) => record.decisionMetadata?.spawnExploration === true,
        ),
      ).toBe(true);
      expect(result.openingRecords.every((record) => record.result.accepted)).toBe(
        true,
      );
      // The ACTIVE phase hits the timing-out brain and falls back safely.
      expect(result.postSpawnRecords).toHaveLength(4);
      expect(
        result.postSpawnRecords.every(
          (record) => record.decisionMetadata?.fallbackUsed === true,
        ),
      ).toBe(true);
      expect(
        result.postSpawnRecords.every((record) => record.result.accepted),
      ).toBe(true);
      // P0 fix: `decideWithSafetyFallback`'s own catch (a brain timing out,
      // not LlmAgentBrain's internal fallback) must ALSO record no stated
      // reason rather than folding "Agent brain failed (...); fallback: ..."
      // into the public reason field — the failure text lives only in the
      // distinct `brainErrorReason` field, and the substituted rule brain's
      // own genuine reason lives only in `fallbackReason`. `reason` is
      // either null (the common case) or the canonical Validator's own
      // honest substitution message (when the rule brain's proposed action
      // also lost a same-turn conflict and the Validator itself swapped in
      // hold) — NEVER the old "Agent brain failed (...)" contamination.
      expect(
        result.postSpawnRecords.every(
          (record) =>
            record.reason === null ||
            record.reason.startsWith("decision selected unknown action id:"),
        ),
      ).toBe(true);
      expect(
        result.postSpawnRecords.every(
          (record) =>
            !record.reason?.includes("Agent brain failed") &&
            !record.reason?.includes("timed out after"),
        ),
      ).toBe(true);
      expect(
        result.postSpawnRecords.every(
          (record) =>
            typeof record.decisionMetadata?.brainErrorReason === "string" &&
            (record.decisionMetadata!.brainErrorReason as string).includes(
              "timed out",
            ),
        ),
      ).toBe(true);
      expect(
        result.postSpawnRecords.every(
          (record) => typeof record.decisionMetadata?.fallbackReason === "string",
        ),
      ).toBe(true);
    } finally {
      await game.end({ archive: false });
    }
  }, 600_000);

  it("fails winner-required step-locked runs that hit the fail-safe without a winner", async () => {
    const log = makeLogger();
    const activeGame = {
      inSpawnPhase: () => false,
      getWinner: () => null,
      ticks: () => 10,
    } as unknown as Game;
    const game = {
      advanceTurnsForTesting: vi.fn(),
    } as unknown as GameServer;
    const mirror = {
      ingest: vi.fn(async () => 0),
      gameState: vi.fn(() => activeGame),
      turnCount: vi.fn(() => 1),
      pendingTurns: vi.fn(() => 0),
    } as unknown as AgentLocalGameMirror;
    const league = {
      runOpeningTurn: vi.fn(async () => []),
      runSpawnPhase: vi.fn(async () => []),
      runDecisionTurn: vi.fn(async () => []),
    } as unknown as AgentLeagueMatchRunner;

    await expect(
      runAgentStepLockedLeague({
        league,
        game,
        mirror,
        messages: () => [],
        config: {
          turnsPerDecisionStep: 25,
          turnsPerDecisionSchedule: [25],
          maxSteps: 1,
          maxSpawnAdvanceTurns: 2_000,
          maxDecisionMs: 100,
          requireWinner: true,
          waitForMirrorCatchup: true,
        },
        log,
      }),
    ).rejects.toThrow(/without a winner/);
  });

  it("engages the labeled autopilot endgame at the step cap and completes once autopilot finds a winner", async () => {
    const log = makeLogger();
    let autopilotEngaged = false;
    const activeGame = {
      inSpawnPhase: () => false,
      // Winner appears only after the autopilot brain switch, so the run must
      // cross the step cap to finish.
      getWinner: () => (autopilotEngaged ? "winner" : null),
      ticks: () => 10,
    } as unknown as Game;
    const game = {
      advanceTurnsForTesting: vi.fn(),
    } as unknown as GameServer;
    const mirror = {
      ingest: vi.fn(async () => 0),
      gameState: vi.fn(() => activeGame),
      turnCount: vi.fn(() => 1),
      pendingTurns: vi.fn(() => 0),
    } as unknown as AgentLocalGameMirror;
    const league = {
      runOpeningTurn: vi.fn(async () => []),
      runSpawnPhase: vi.fn(async () => []),
      runDecisionTurn: vi.fn(async () => []),
    } as unknown as AgentLeagueMatchRunner;
    const onAutopilotEngage = vi.fn(({ step }: { step: number }) => {
      expect(step).toBe(2);
      autopilotEngaged = true;
    });

    const result = await runAgentStepLockedLeague({
      league,
      game,
      mirror,
      messages: () => [],
      config: {
        turnsPerDecisionStep: 25,
        maxSteps: 2,
        maxSpawnAdvanceTurns: 2_000,
        maxDecisionMs: 100,
        requireWinner: true,
        waitForMirrorCatchup: true,
        autopilotExtraSteps: 3,
      },
      onAutopilotEngage,
      log,
    });

    expect(onAutopilotEngage).toHaveBeenCalledTimes(1);
    expect(result.autopilotEngagedAtStep).toBe(2);
    expect(result.stepsCompleted).toBe(3);
  });

  it("fails loud when even the autopilot endgame finds no winner", async () => {
    const log = makeLogger();
    const activeGame = {
      inSpawnPhase: () => false,
      getWinner: () => null,
      ticks: () => 10,
    } as unknown as Game;
    const game = {
      advanceTurnsForTesting: vi.fn(),
    } as unknown as GameServer;
    const mirror = {
      ingest: vi.fn(async () => 0),
      gameState: vi.fn(() => activeGame),
      turnCount: vi.fn(() => 1),
      pendingTurns: vi.fn(() => 0),
    } as unknown as AgentLocalGameMirror;
    const league = {
      runOpeningTurn: vi.fn(async () => []),
      runSpawnPhase: vi.fn(async () => []),
      runDecisionTurn: vi.fn(async () => []),
    } as unknown as AgentLeagueMatchRunner;
    const onAutopilotEngage = vi.fn();

    await expect(
      runAgentStepLockedLeague({
        league,
        game,
        mirror,
        messages: () => [],
        config: {
          turnsPerDecisionStep: 25,
          maxSteps: 1,
          maxSpawnAdvanceTurns: 2_000,
          maxDecisionMs: 100,
          requireWinner: true,
          waitForMirrorCatchup: true,
          autopilotExtraSteps: 2,
        },
        onAutopilotEngage,
        log,
      }),
    ).rejects.toThrow(/autopilot endgame engaged at step 1 and also failed/);
    expect(onAutopilotEngage).toHaveBeenCalledTimes(1);
  });

  it("never arms autopilot extra steps without an onAutopilotEngage brain switch", async () => {
    const log = makeLogger();
    const activeGame = {
      inSpawnPhase: () => false,
      getWinner: () => null,
      ticks: () => 10,
    } as unknown as Game;
    const game = {
      advanceTurnsForTesting: vi.fn(),
    } as unknown as GameServer;
    const mirror = {
      ingest: vi.fn(async () => 0),
      gameState: vi.fn(() => activeGame),
      turnCount: vi.fn(() => 1),
      pendingTurns: vi.fn(() => 0),
    } as unknown as AgentLocalGameMirror;
    const runDecisionTurn = vi.fn(async () => []);
    const league = {
      runOpeningTurn: vi.fn(async () => []),
      runSpawnPhase: vi.fn(async () => []),
      runDecisionTurn,
    } as unknown as AgentLeagueMatchRunner;

    await expect(
      runAgentStepLockedLeague({
        league,
        game,
        mirror,
        messages: () => [],
        config: {
          turnsPerDecisionStep: 25,
          maxSteps: 1,
          maxSpawnAdvanceTurns: 2_000,
          maxDecisionMs: 100,
          requireWinner: true,
          waitForMirrorCatchup: true,
          // No onAutopilotEngage callback: the extra budget must stay inert so
          // a silent deterministic continuation is impossible.
          autopilotExtraSteps: 5,
        },
        log,
      }),
    ).rejects.toThrow(/reached 1 decision steps without a winner/);
    expect(runDecisionTurn).toHaveBeenCalledTimes(1);
  });
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

// Regression guard for benchmark/league non-determinism. Root cause: GameServer
// detects client disconnects on a wall-clock timeout and injects a
// `mark_disconnected` intent into the (otherwise deterministic) turn stream.
// Manual-tick harnesses advance turns far faster than wall-clock, so the timeout
// fired at a load-dependent turn number, diverging same-seed runs. The fix:
// the agent league runner starts the game with realtimeClock:false, which skips
// both the real-time endTurn interval and the wall-clock disconnect detection.
describe("AgentLeagueMatchRunner manual-clock determinism", () => {
  const FIXED_SPECS: AgentSpec[] = [
    {
      username: "Aggressive Agent 1",
      profile: "aggressive",
      clientID: "DTM00001",
      persistentID: "determ-agent-1",
    },
    {
      username: "Defensive Agent 2",
      profile: "defensive",
      clientID: "DTM00002",
      persistentID: "determ-agent-2",
    },
    {
      username: "Diplomatic Agent 3",
      profile: "diplomatic",
      clientID: "DTM00003",
      persistentID: "determ-agent-3",
    },
  ];

  function makeParticipants(log: Logger) {
    return createAgentParticipants(FIXED_SPECS, log, {
      brainFactory: (spec) =>
        new LlmAgentBrain({
          provider: new MockLlmProvider({ mode: "valid" }),
          profile: spec.profile,
          brainType: "mock-llm",
          providerTimeoutMs: 100,
        }),
    });
  }

  function forceStaleLastPing(game: GameServer): void {
    // Simulate "no ping for longer than disconnectedTimeout" without waiting in
    // wall-clock: this is exactly the condition that injected mark_disconnected.
    for (const client of (
      game as unknown as { allClients: Map<string, { lastPing: number }> }
    ).allClients.values()) {
      client.lastPing = 0;
    }
  }

  function injectedWallClockDisconnect(
    messages: ReturnType<
      ReturnType<typeof makeParticipants>[number]["runner"]["serverMessages"]
    >,
  ): boolean {
    // Only the wall-clock disconnect (isDisconnected: true) is the
    // load-dependent, non-deterministic one. The isDisconnected:false marker
    // injected at join time is deterministic and expected.
    return messages.some(
      (message) =>
        message.type === "turn" &&
        message.turn.intents.some(
          (intent) =>
            intent.type === "mark_disconnected" &&
            intent.isDisconnected === true,
        ),
    );
  }

  it("does not inject wall-clock mark_disconnected intents in manual-clock mode", async () => {
    const log = makeLogger();
    const mapLoader = new StaticMapLoader();
    const config = { ...gameConfig, gameMapSize: GameMapSize.Compact };
    const terrain = await loadTerrainMap(
      config.gameMap,
      config.gameMapSize,
      mapLoader,
    );
    const participants = makeParticipants(log);
    const game = new GameServer(
      "DETERMCLK1",
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
    try {
      match.attachAgents();
      match.startGame(); // realtimeClock:false
      forceStaleLastPing(game);
      game.advanceTurnsForTesting(20); // crosses several %5 disconnect checks
      expect(
        injectedWallClockDisconnect(participants[0]!.runner.serverMessages()),
      ).toBe(false);
    } finally {
      await game.end({ archive: false });
    }
    // 600s like the other heavy league-match sims in this file: these two
    // full-runner tests exceed 120s on slow shared CI runners under coverage
    // instrumentation while passing quickly locally.
  }, 600_000);

  it("still injects mark_disconnected when the real-time clock is enabled (production behavior preserved)", async () => {
    const log = makeLogger();
    const mapLoader = new StaticMapLoader();
    const config = { ...gameConfig, gameMapSize: GameMapSize.Compact };
    const terrain = await loadTerrainMap(
      config.gameMap,
      config.gameMapSize,
      mapLoader,
    );
    const participants = makeParticipants(log);
    const game = new GameServer(
      "DETERMCLK2",
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
    try {
      match.attachAgents();
      game.start(); // default realtimeClock:true (production path)
      forceStaleLastPing(game);
      game.advanceTurnsForTesting(20);
      expect(
        injectedWallClockDisconnect(participants[0]!.runner.serverMessages()),
      ).toBe(true);
    } finally {
      await game.end({ archive: false });
    }
  }, 600_000);

  it("produces an identical server turn stream for two same-seed manual-clock runs", async () => {
    // The turn stream (turnNumber -> intents broadcast by the GameServer) is the
    // exact artifact that diverged in the original bug: a wall-clock
    // mark_disconnected intent landed on a load-dependent turn. With the fix it
    // is purely agent-driven, so two same-seed manual-clock runs are identical.
    const runOnce = async (): Promise<{ opening: string[]; turns: string[] }> => {
      const log = makeLogger();
      const mapLoader = new StaticMapLoader();
      const config = { ...gameConfig, gameMapSize: GameMapSize.Compact };
      const terrain = await loadTerrainMap(
        config.gameMap,
        config.gameMapSize,
        mapLoader,
      );
      const participants = makeParticipants(log);
      // Identical gameID across both runs => identical core PRNG seed.
      const game = new GameServer(
        "DETERMSEED",
        log,
        1_000_003,
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
      try {
        match.attachAgents();
        match.startGame();
        const opening = await match.runOpeningTurn(0, { maxDecisionMs: 100 });
        // Advance well past the 30s wall-clock disconnect window (in turns).
        game.advanceTurnsForTesting(1_500);
        const turns = participants[0]!.runner
          .serverMessages()
          .filter((message) => message.type === "turn")
          .map(
            (message) =>
              `${message.turn.turnNumber}:${JSON.stringify(message.turn.intents)}`,
          );
        return {
          opening: opening.map(
            (record) => `${record.agentID}:${record.chosenActionID}`,
          ),
          turns,
        };
      } finally {
        await game.end({ archive: false });
      }
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(first.opening.length).toBeGreaterThan(0);
    expect(first.turns.length).toBeGreaterThan(0);
    expect(second.opening).toEqual(first.opening);
    expect(second.turns).toEqual(first.turns);
    // And no wall-clock disconnect intent should appear at all in manual mode.
    expect(
      first.turns.some((turn) => turn.includes('"isDisconnected":true')),
    ).toBe(false);
  }, 600_000);
});
