import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import winston from "winston";
import { GameEnv, ServerConfig } from "../core/configuration/Config";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../core/game/Game";
import { GameMapLoader, MapData } from "../core/game/GameMapLoader";
import { loadTerrainMap, MapManifest } from "../core/game/TerrainMapLoader";
import { GameConfig, ServerMessage } from "../core/Schemas";
import { auditDecisionEffects } from "../server/agents/AgentActionAuditor";
import {
  AgentRunRosterEntry,
  AgentRunFinalState,
  writeAgentLeagueRunArtifacts,
} from "../server/agents/AgentDecisionLogWriter";
import { writeAgentDemoIndex } from "../server/agents/AgentDemoIndexWriter";
import {
  AgentSpectatorSnapshot,
  buildAgentSpectatorReplay,
  buildAgentSpectatorSnapshot,
  buildGameRecordFromServerMessages,
} from "../server/agents/AgentSpectatorReplay";
import {
  CodexCliLlmProvider,
  loadCodexCliLlmProviderConfig,
} from "../server/agents/CodexCliLlmProvider";
import {
  AgentLeagueMatchRunner,
  AgentSpec,
  buildAttackScenarioSpawnPlan,
  buildSpawnCandidates,
  createAgentParticipants,
  createDefaultAgentSpecs,
} from "../server/agents/AgentLeagueMatch";
import type { SpawnCandidate } from "../server/agents/AgentLeagueMatch";
import { externalBrainCleanlinessReport } from "../server/agents/AgentExternalBrainCleanliness";
import {
  AgentLocalGameMirror,
  waitForMirrorState,
} from "../server/agents/AgentLocalGameMirror";
import {
  AgentStepLockedLeagueConfig,
  runAgentStepLockedLeague,
} from "../server/agents/AgentStepLockedLeague";
import { LlmAgentBrain } from "../server/agents/LlmAgentBrain";
import { LlmProvider } from "../server/agents/LlmProvider";
import { MockLlmProvider } from "../server/agents/MockLlmProvider";
import {
  LlmAgentPlanner,
  MockLlmPlanner,
  PlannerExecutorAgentBrain,
  FrontierPolicyExecutor,
} from "../server/agents/AgentPlannerExecutor";
import {
  agentManifestToSpec,
  loadAgentManifestsFromDirectory,
} from "../server/agents/AgentManifest";
import type { AgentManifest } from "../server/agents/AgentManifest";
import { resolveExternalAgentToken } from "../server/agents/ExternalAgentSecrets";
import { ExternalHttpAgentBrain } from "../server/agents/ExternalHttpAgentBrain";
import { ExternalRelayAgentBrain } from "../server/agents/ExternalRelayAgentBrain";
import type {
  AgentBrain,
  AgentBrainType,
  AgentDecisionRecord,
  LegalActionKind,
} from "../server/agents/AgentTypes";
import {
  LlmProviderConfigError,
  OpenAiLlmProvider,
  loadOpenAiLlmProviderConfig,
} from "../server/agents/OpenAiLlmProvider";
import { RuleAgentBrain } from "../server/agents/RuleAgentBrain";
import { GameServer } from "../server/GameServer";

const log = winston.createLogger({
  level: "info",
  format: winston.format.simple(),
  transports: [new winston.transports.Console()],
});

const gameConfig: GameConfig = {
  gameMap: GameMapType.Asia,
  gameMapSize: GameMapSize.Compact,
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

async function run() {
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const scenario = scenarioFromArgs(args);
  const brainMode = brainModeFromArgs(args, scenario);
  const runnerMode = runnerModeFromArgs(args);
  const stepLockedConfig = stepLockedConfigFromArgs(args);
  const externalAgentMaxDecisionMs = positiveIntegerArg(
    args,
    "--external-agent-max-decision-ms=",
    Math.min(stepLockedConfig.maxDecisionMs, 15_000),
  );
  const disabledActionKinds = disabledActionKindsFromArgs(args);
  const botCount = nonNegativeIntegerArg(args, "--bots=", 0);
  const nationCount = nationsArg(args, "disabled");
  const explicitAgentCount = args.some((arg) => arg.startsWith("--agents="));
  const agentCount = positiveIntegerArg(args, "--agents=", 4);
  const replayTailTurns = nonNegativeIntegerArg(args, "--replay-tail-turns=", 0);
  const manifestDir =
    args
      .find((arg) => arg.startsWith("--agent-manifest-dir="))
      ?.slice("--agent-manifest-dir=".length) ?? null;
  const runID =
    runIDFromArgs(args) ?? defaultRunID(scenario, brainMode, runnerMode);
  const realLlmConfig =
    brainMode === "real-llm" ? loadOpenAiLlmProviderConfig() : null;
  const realLlmProvider =
    realLlmConfig === null ? null : new OpenAiLlmProvider(realLlmConfig);
  const codexCliConfig =
    brainMode === "codex-cli" || brainMode === "planner-codex-cli"
      ? loadCodexCliLlmProviderConfig()
      : null;
  const codexCliProvider =
    codexCliConfig === null
      ? null
      : new CodexCliLlmProvider({
          ...codexCliConfig,
          outputSchema: brainMode === "planner-codex-cli" ? "planner" : "decision",
        });
  const decisionTimeoutMs =
    runnerMode === "step-locked"
      ? stepLockedConfig.maxDecisionMs
      : brainMode === "codex-cli" || brainMode === "planner-codex-cli"
        ? codexCliConfig?.timeoutMs
        : realLlmConfig?.timeoutMs;
  const manifests =
    manifestDir === null
      ? null
      : await loadAgentManifestsFromDirectory(manifestDir, {
          minAgents: explicitAgentCount ? 1 : 3,
          maxAgents: explicitAgentCount ? Math.max(1, 8 - agentCount) : 8,
        });
  const manifestSpecs = manifests?.map(agentManifestToSpec) ?? [];
  const houseSpecs =
    manifests === null || explicitAgentCount ? createDefaultAgentSpecs(agentCount) : [];
  const specs = manifests === null ? houseSpecs : [...manifestSpecs, ...houseSpecs];
  if (specs.length > 8) {
    throw new Error("AI league matches support 1 to 8 agent participants");
  }
  const baseGameConfig = gameConfigForScenario(scenario, args);
  const selectedGameConfig = {
    ...baseGameConfig,
    bots: botCount,
    nations: nationCount,
    maxPlayers: Math.max(baseGameConfig.maxPlayers ?? 4, specs.length),
  };
  const game = new GameServer(
    "AGENT002",
    log,
    Date.now(),
    serverConfigForRunnerMode(runnerMode),
    selectedGameConfig,
  );
  const mapLoader = new StaticMapLoader();
  const terrain = await loadTerrainMap(
    selectedGameConfig.gameMap,
    selectedGameConfig.gameMapSize,
    mapLoader,
  );
  const hasManifestBrainOverride =
    manifests?.some((manifest) => manifestHasBrainOverride(manifest)) ?? false;
  const manifestCount = manifests?.length ?? 0;
  const spawnPlan =
    scenario === "attack"
      ? buildAttackScenarioSpawnPlan(terrain.gameMap, {
          agentCount: specs.length,
          stride: 2,
        })
      : null;
  const spawnCandidates =
    spawnPlan?.spawnCandidates ??
    spawnCandidatesForRun({
      candidates: buildSpawnCandidates(terrain.gameMap, {
        maxCandidates: 1_000,
        stride: 2,
      }),
      runID,
      varySpawns: args.includes("--vary-spawns"),
    });
  const participants = createAgentParticipants(specs, log, {
    brainFactory:
      brainMode === "rule" && !hasManifestBrainOverride
        ? undefined
        : (spec, index) =>
            createBrainForManifestOrMode(
              index < manifestCount ? manifests?.[index] : undefined,
              spec,
              scenario,
              brainMode,
              brainMode === "codex-cli" || brainMode === "planner-codex-cli"
                ? codexCliProvider
                : realLlmProvider,
              decisionTimeoutMs,
              externalAgentMaxDecisionMs,
            ),
  });
  const roster = agentRunRoster(participants);
  const spectatorSnapshots: AgentSpectatorSnapshot[] = [];
  const mirror = new AgentLocalGameMirror(mapLoader, log);
  const mirrorMessages = () => participants[0]?.runner.serverMessages() ?? [];
  const league = new AgentLeagueMatchRunner({
    game,
    participants,
    spawnCandidates,
    log,
    minSpawnDistance: scenario === "attack" ? 1 : undefined,
    disabledActionKinds,
  });

  try {
    league.attachAgents();
    league.startGame();
    if (runnerMode === "step-locked") {
      const stepResult = await runAgentStepLockedLeague({
        league,
        game,
        mirror,
        messages: mirrorMessages,
        config: stepLockedConfig,
        onSnapshot: (snapshot) => {
          spectatorSnapshots.push(
            buildAgentSpectatorSnapshot({
              ...snapshot,
              roster,
            }),
          );
        },
        log,
      });

      if (scenario === "attack") {
        assertAttackSmokeSucceeded(
          stepResult.postSpawnRecords,
          stepResult.finalGameState,
        );
      }
      if (scenario === "actions") {
        assertActionDiversitySmokeSucceeded(
          stepResult.postSpawnRecords,
          stepResult.finalGameState,
        );
      }

      const artifactFinalGameState = await advanceReplayTail({
        game,
        mirror,
        messages: mirrorMessages,
        turns: replayTailTurns,
      });
      const finalGameState =
        artifactFinalGameState ?? stepResult.finalGameState;
      if (artifactFinalGameState) {
        spectatorSnapshots.push(
          buildAgentSpectatorSnapshot({
            label: "Replay tail",
            turnNumber: mirror.turnCount(),
            gameState: artifactFinalGameState,
            records: [],
            roster,
          }),
        );
      }

      const finalState = finalKnownState({
        participants,
        gameState: finalGameState,
        turnCount: mirror.turnCount(),
      });
      const completedAt = Date.now();
      const gameRecord = buildGameRecordFromServerMessages({
        messages: mirrorMessages(),
        startedAt,
        completedAt,
      });
      const spectatorReplay = buildAgentSpectatorReplay({
        runID,
        matchID: game.id,
        scenario,
        brainMode: artifactBrainMode(brainMode),
        runnerMode,
        finalGameState,
        roster,
        snapshots: spectatorSnapshots,
        notes: artifactNotes(scenario, brainMode, runnerMode),
      });
      const artifacts = await writeAgentLeagueRunArtifacts({
        runID,
        matchID: game.id,
        scenario,
        brainMode: artifactBrainMode(brainMode),
        runnerMode,
        runnerConfig: {
          turnsPerDecisionStep: stepResult.turnsPerDecisionStep,
          turnsPerDecisionSchedule: stepResult.turnsPerDecisionSchedule,
          maxDecisionMs: stepResult.maxDecisionMs,
          maxSteps: stepLockedConfig.maxSteps,
          stepsCompleted: stepResult.stepsCompleted,
          mirrorCatchupSucceeded: stepResult.mirrorCatchupSucceeded,
          onlyHoldReason: stepResult.onlyHoldReason,
          replayTailTurns,
          agents: specs.length,
          bots: botCount,
          nations: nationCount,
          map: selectedGameConfig.gameMap,
          mapSize: selectedGameConfig.gameMapSize,
          difficulty: selectedGameConfig.difficulty,
          variedSpawns: args.includes("--vary-spawns"),
        },
        startedAt,
        completedAt,
        records: league.decisionRecords(),
        roster,
        finalState,
        spectatorReplay,
        gameRecord,
        notes: artifactNotes(scenario, brainMode, runnerMode),
      });
      // Skip the global demo-index rebuild by default: writeAgentDemoIndex()
      // readdir+reads every historical run in artifacts/ai-league-runs (tens of
      // thousands of files / tens of GB), which is wasteful on automated
      // smoke/dry-run matches. The live beta server writes its index elsewhere,
      // so only rebuild here when explicitly requested.
      if (process.env.PROXYWAR_WRITE_DEMO_INDEX === "1") {
        await writeAgentDemoIndex();
      }

      const allRecords = league.decisionRecords();
      assertRequiredExternalBrainSucceeded({
        brainMode,
        records: allRecords,
      });
      console.log("Proxy War multi-agent smoke result", {
        scenario,
        runnerMode,
        mirror: {
          brainMode,
          turns: mirror.turnCount(),
          tick: finalGameState.ticks(),
          phase: finalGameState.inSpawnPhase() ? "spawn" : "active",
        },
        stepLocked: {
          runID,
          bots: botCount,
          turnsPerDecisionStep: stepResult.turnsPerDecisionStep,
          stepsCompleted: stepResult.stepsCompleted,
          maxDecisionMs: stepResult.maxDecisionMs,
          replayTailTurns,
          actionCountsByKind: actionCountsByKind(allRecords),
          postSpawnNonHoldActionCount:
            stepResult.postSpawnNonHoldActionCount,
          fallbackCount: fallbackCount(allRecords),
          onlyHoldReason: stepResult.onlyHoldReason,
        },
        opening: summarizeRecords(stepResult.openingRecords),
        postSpawn: summarizeRecords(stepResult.postSpawnRecords),
        artifacts,
        openFrontReplayUrl: `http://localhost:9000/ai-league-replay/${encodeURIComponent(runID)}`,
      });
      return;
    }

    const openingRecords = await league.runOpeningTurn();
    const postSpawnGame = await waitForMirrorState({
      mirror,
      messages: mirrorMessages,
      until: (state) => !state.inSpawnPhase(),
      timeoutMs: 10_000,
    });
    auditDecisionEffects({
      records: openingRecords,
      beforeGame: null,
      afterGame: postSpawnGame,
    });
    spectatorSnapshots.push(
      buildAgentSpectatorSnapshot({
        label: "After spawn",
        turnNumber: mirror.turnCount(),
        gameState: postSpawnGame,
        records: openingRecords,
        roster,
      }),
    );
    const postSpawnRecords = await league.runDecisionTurn({
      turnNumber: mirror.turnCount(),
      gameState: postSpawnGame,
    });
    const postSpawnTurnCount = mirror.turnCount();
    const afterPostSpawnGame = await waitForMirrorState({
      mirror,
      messages: mirrorMessages,
      until: (_state, currentMirror) =>
        currentMirror.turnCount() > postSpawnTurnCount,
      timeoutMs: 2_000,
    });
    auditDecisionEffects({
      records: postSpawnRecords,
      beforeGame: postSpawnGame,
      afterGame: afterPostSpawnGame,
    });
    spectatorSnapshots.push(
      buildAgentSpectatorSnapshot({
        label: "Post-spawn cycle 1",
        turnNumber: mirror.turnCount(),
        gameState: afterPostSpawnGame,
        records: postSpawnRecords,
        roster,
      }),
    );

    if (scenario === "attack") {
      assertAttackSmokeSucceeded(postSpawnRecords, afterPostSpawnGame);
    }
    if (scenario === "actions") {
      assertActionDiversitySmokeSucceeded(
        postSpawnRecords,
        afterPostSpawnGame,
      );
    }

    const artifactFinalGameState = await advanceReplayTail({
      game,
      mirror,
      messages: mirrorMessages,
      turns: replayTailTurns,
    });
    const finalGameState = artifactFinalGameState ?? afterPostSpawnGame;
    if (artifactFinalGameState) {
      spectatorSnapshots.push(
        buildAgentSpectatorSnapshot({
          label: "Replay tail",
          turnNumber: mirror.turnCount(),
          gameState: artifactFinalGameState,
          records: [],
          roster,
        }),
      );
    }

    const finalState = finalKnownState({
      participants,
      gameState: finalGameState,
      turnCount: mirror.turnCount(),
    });
    const completedAt = Date.now();
    const gameRecord = buildGameRecordFromServerMessages({
      messages: mirrorMessages(),
      startedAt,
      completedAt,
    });
    const spectatorReplay = buildAgentSpectatorReplay({
      runID,
      matchID: game.id,
      scenario,
      brainMode: artifactBrainMode(brainMode),
      runnerMode,
      finalGameState,
      roster,
      snapshots: spectatorSnapshots,
      notes: artifactNotes(scenario, brainMode, runnerMode),
    });
    const artifacts = await writeAgentLeagueRunArtifacts({
      runID,
      matchID: game.id,
      scenario,
      brainMode: artifactBrainMode(brainMode),
      runnerMode,
      runnerConfig: {
        ...(replayTailTurns > 0 ? { replayTailTurns } : {}),
        agents: specs.length,
        bots: botCount,
        nations: nationCount,
        map: selectedGameConfig.gameMap,
        mapSize: selectedGameConfig.gameMapSize,
        difficulty: selectedGameConfig.difficulty,
        variedSpawns: args.includes("--vary-spawns"),
      },
      startedAt,
      completedAt,
      records: league.decisionRecords(),
      roster,
      finalState,
      spectatorReplay,
      gameRecord,
      notes: artifactNotes(scenario, brainMode, runnerMode),
    });
    // Skip the global demo-index rebuild by default: writeAgentDemoIndex()
    // readdir+reads every historical run in artifacts/ai-league-runs (tens of
    // thousands of files / tens of GB), which is wasteful on automated
    // smoke/dry-run matches. The live beta server writes its index elsewhere,
    // so only rebuild here when explicitly requested.
    if (process.env.PROXYWAR_WRITE_DEMO_INDEX === "1") {
      await writeAgentDemoIndex();
    }
    assertRequiredExternalBrainSucceeded({
      brainMode,
      records: league.decisionRecords(),
    });

    console.log("Proxy War multi-agent smoke result", {
      scenario,
      runnerMode,
      mirror: {
        brainMode,
        turns: mirror.turnCount(),
        tick: finalGameState.ticks(),
        phase: finalGameState.inSpawnPhase() ? "spawn" : "active",
      },
      attackPlan: spawnPlan
        ? {
            attackerTile: spawnPlan.attackerTile,
            targetTile: spawnPlan.targetTile,
            notes: spawnPlan.notes,
          }
        : null,
      opening: summarizeRecords(openingRecords),
      postSpawn: summarizeRecords(postSpawnRecords),
      artifacts,
      replayTailTurns,
      openFrontReplayUrl: `http://localhost:9000/ai-league-replay/${encodeURIComponent(runID)}`,
    });
  } finally {
    codexCliProvider?.close();
    await game.end({ archive: false });
  }
}

async function advanceReplayTail(input: {
  game: GameServer;
  mirror: AgentLocalGameMirror;
  messages: () => ServerMessage[];
  turns: number;
}): Promise<Game | null> {
  if (input.turns <= 0) {
    return null;
  }
  const beforeTailTurnCount = input.mirror.turnCount();
  input.game.advanceTurnsForTesting(input.turns);
  return waitForMirrorState({
    mirror: input.mirror,
    messages: input.messages,
    until: (_state, mirror) =>
      mirror.turnCount() >= beforeTailTurnCount + input.turns &&
      mirror.pendingTurns() === 0,
    timeoutMs: Math.max(2_000, input.turns * 25),
  });
}

function summarizeRecords(
  records: Awaited<ReturnType<AgentLeagueMatchRunner["runDecisionTurn"]>>,
) {
  return records.map((record) => ({
    sequence: record.sequence,
    username: record.username,
    profile: record.profile,
    clientID: record.clientID,
    observationSummary: record.observationSummary,
    legalActionIDs: record.legalActionIDs,
    legalActionIDsByKind: record.legalActionIDsByKind,
    attackActionIDs: record.attackActionIDs,
    chosenActionID: record.chosenActionID,
    chosenActionKind: record.chosenActionKind,
    chosenActionMetadata: record.chosenActionMetadata,
    intent: record.intent,
    accepted: record.result.accepted,
    reason: record.result.reason,
    decisionReason: record.reason,
    decisionMetadata: compactDecisionMetadata(record.decisionMetadata),
  }));
}

function serverConfigForRunnerMode(mode: SmokeRunnerMode): ServerConfig {
  return {
    turnIntervalMs: () => (mode === "step-locked" ? 60 * 60 * 1_000 : 1),
    env: () => GameEnv.Dev,
  } as ServerConfig;
}

function runnerModeFromArgs(args: string[]): SmokeRunnerMode {
  if (
    args.includes("--runner=step-locked") ||
    args.includes("--mode=step-locked") ||
    args.includes("--step-locked")
  ) {
    return "step-locked";
  }
  return "realtime";
}

function stepLockedConfigFromArgs(
  args: string[],
): AgentStepLockedLeagueConfig {
  return {
    turnsPerDecisionStep: positiveIntegerArg(
      args,
      "--turns-per-decision-step=",
      25,
    ),
    turnsPerDecisionSchedule: turnsPerDecisionScheduleFromArgs(args),
    maxSteps: positiveIntegerArg(args, "--max-steps=", 1),
    maxSpawnAdvanceTurns: positiveIntegerArg(
      args,
      "--max-spawn-advance-turns=",
      2_000,
    ),
    maxDecisionMs: positiveIntegerArg(args, "--max-decision-ms=", 120_000),
    requireWinner: args.includes("--require-winner"),
    waitForMirrorCatchup: !args.includes("--no-mirror-catchup"),
  };
}

function turnsPerDecisionScheduleFromArgs(args: string[]): number[] | undefined {
  const prefix = "--turns-per-decision-schedule=";
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const schedule: number[] = [];
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    const match = trimmed.match(/^(\d+)(?:x(\d+))?$/);
    if (match === null) {
      throw new Error(
        `${prefix}${raw} must use comma-separated steps like 50x12,300x20,900x80`,
      );
    }
    const turns = Number(match[1]);
    const repeat = match[2] === undefined ? 1 : Number(match[2]);
    if (
      !Number.isInteger(turns) ||
      turns <= 0 ||
      !Number.isInteger(repeat) ||
      repeat <= 0
    ) {
      throw new Error(`${prefix}${raw} contains a non-positive step`);
    }
    if (schedule.length + repeat > 5_000) {
      throw new Error(`${prefix}${raw} expands to more than 5000 steps`);
    }
    for (let index = 0; index < repeat; index += 1) {
      schedule.push(turns);
    }
  }
  return schedule;
}

function positiveIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
): number {
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix}${raw} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
): number {
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${prefix}${raw} must be a non-negative integer`);
  }
  return value;
}

function nationsArg(args: string[], defaultValue: GameConfig["nations"]): GameConfig["nations"] {
  const raw = args.find((arg) => arg.startsWith("--nations="))?.slice("--nations=".length);
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  if (raw === "disabled" || raw === "default") {
    return raw;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 400) {
    throw new Error(`--nations=${raw} must be a positive integer, default, or disabled`);
  }
  return value;
}

function brainModeFromArgs(
  args: string[],
  scenario: SmokeScenario,
): SmokeBrainMode {
  if (args.includes("--brain=real-llm")) {
    return "real-llm";
  }
  if (args.includes("--brain=codex-cli")) {
    return "codex-cli";
  }
  if (args.includes("--brain=planner")) {
    return "planner";
  }
  if (args.includes("--brain=planner-codex-cli")) {
    return "planner-codex-cli";
  }
  if (args.includes("--brain=mock-llm")) {
    return "mock-llm";
  }
  return scenario === "attack" || scenario === "actions" ? "mock-llm" : "rule";
}

function scenarioFromArgs(args: string[]): SmokeScenario {
  if (args.includes("--scenario=attack")) {
    return "attack";
  }
  if (args.includes("--scenario=actions")) {
    return "actions";
  }
  return "league";
}

function runIDFromArgs(args: string[]): string | null {
  const prefix = "--run-id=";
  return (
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function disabledActionKindsFromArgs(args: string[]): LegalActionKind[] {
  return args.includes("--disable-alliance-actions")
    ? ["alliance_request"]
    : [];
}

function gameConfigForScenario(
  scenario: SmokeScenario,
  args: string[] = [],
): GameConfig {
  const baseConfig = {
    ...gameConfig,
    gameMap: enumArg(args, "--map=", GameMapType, gameConfig.gameMap),
    gameMapSize: enumArg(
      args,
      "--map-size=",
      GameMapSize,
      gameConfig.gameMapSize,
    ),
    difficulty: enumArg(args, "--difficulty=", Difficulty, gameConfig.difficulty),
  };
  if (scenario === "attack") {
    return { ...baseConfig, spawnImmunityDuration: 0 };
  }
  if (scenario === "actions") {
    const config: GameConfig = {
      ...baseConfig,
      startingGold: 200_000,
      donateGold: true,
      donateTroops: true,
    };
    const startingGold = nonNegativeIntegerArg(
      args,
      "--starting-gold=",
      Number(config.startingGold ?? 0),
    );
    return {
      ...config,
      startingGold,
      infiniteGold: args.includes("--infinite-gold")
        ? true
        : config.infiniteGold,
      instantBuild: args.includes("--instant-build")
        ? true
        : config.instantBuild,
    };
  }
  return baseConfig;
}

function enumArg<T extends Record<string, string | number>>(
  args: string[],
  prefix: string,
  values: T,
  defaultValue: T[keyof T],
): T[keyof T] {
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const entries = Object.entries(values).filter(([, value]) =>
    typeof value === "string"
  );
  const match = entries.find(
    ([key, value]) => key === raw || String(value) === raw,
  );
  if (match === undefined) {
    throw new Error(
      `${prefix}${raw} must be one of ${entries.map(([key]) => key).join(", ")}`,
    );
  }
  return match[1] as T[keyof T];
}

function spawnCandidatesForRun(input: {
  candidates: SpawnCandidate[];
  runID: string;
  varySpawns: boolean;
}): SpawnCandidate[] {
  if (!input.varySpawns) {
    return input.candidates;
  }
  const highQualityPool = input.candidates.slice(0, 512);
  const tail = input.candidates.slice(512);
  return [
    ...highQualityPool
      .map((candidate) => ({
        candidate,
        score:
          candidate.opportunityScore * 0.7 +
          seededFraction(`${input.runID}:${candidate.tile}`) * 0.3,
      }))
      .sort((a, b) => b.score - a.score)
      .map(({ candidate }) => candidate),
    ...tail,
  ];
}

function seededFraction(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function createMockLlmBrain(
  spec: AgentSpec,
  scenario: SmokeScenario,
  providerTimeoutMs?: number,
): LlmAgentBrain {
  const attackScenarioMode =
    spec.profile === "aggressive" ? "attack" : "spawn_then_hold";
  const actionScenarioMode =
    spec.profile === "diplomatic" ? "support" : "build";

  return new LlmAgentBrain({
    provider: new MockLlmProvider({
      mode:
        scenario === "attack"
          ? attackScenarioMode
          : scenario === "actions"
            ? actionScenarioMode
            : "valid",
      preferKind:
        spec.profile === "diplomatic" ? "alliance_request" : undefined,
    }),
    profile: spec.profile,
    brainType: "mock-llm",
    providerTimeoutMs,
    includePromptInMetadata: true,
  });
}

function createBrainForManifestOrMode(
  manifest: AgentManifest | undefined,
  spec: AgentSpec,
  scenario: SmokeScenario,
  brainMode: SmokeBrainMode,
  provider: LlmProvider | null,
  providerTimeoutMs: number | undefined,
  externalAgentMaxDecisionMs: number,
): AgentBrain {
  if (manifest?.provider?.provider === "external-http") {
    return new ExternalHttpAgentBrain({
      endpointUrl: manifest.provider.endpointUrl,
      token: resolveExternalAgentToken(manifest.provider),
      timeoutMs: externalAgentTimeoutMs({
        manifestTimeoutMs: manifest.provider.timeoutMs,
        providerTimeoutMs,
        externalAgentMaxDecisionMs,
      }),
      profile: spec.profile,
    });
  }
  if (manifest?.provider?.provider === "external-relay") {
    return new ExternalRelayAgentBrain({
      relayBaseUrl: manifest.provider.relayBaseUrl,
      sessionID: manifest.provider.sessionID,
      token: resolveExternalAgentToken(manifest.provider),
      timeoutMs: externalAgentTimeoutMs({
        manifestTimeoutMs: manifest.provider.timeoutMs,
        providerTimeoutMs,
        externalAgentMaxDecisionMs,
      }),
      profile: spec.profile,
    });
  }
  if (
    manifest?.brainType === "external-http" ||
    manifest?.brainType === "external-relay"
  ) {
    throw new Error(
      `${manifest.agentName} uses ${manifest.brainType} brainType but has no matching provider`,
    );
  }
  if (brainMode === "rule") {
    return new RuleAgentBrain(spec.profile);
  }
  return createBrainForMode(spec, scenario, brainMode, provider, providerTimeoutMs);
}

function externalAgentTimeoutMs(input: {
  manifestTimeoutMs: number | undefined;
  providerTimeoutMs: number | undefined;
  externalAgentMaxDecisionMs: number;
}): number {
  const requested =
    input.manifestTimeoutMs ?? input.providerTimeoutMs ?? input.externalAgentMaxDecisionMs;
  return Math.max(
    250,
    Math.min(requested, input.externalAgentMaxDecisionMs),
  );
}

function manifestHasBrainOverride(manifest: AgentManifest): boolean {
  return (
    manifest.brainType === "external-http" ||
    manifest.brainType === "external-relay" ||
    manifest.provider?.provider === "external-http" ||
    manifest.provider?.provider === "external-relay"
  );
}

function createBrainForMode(
  spec: AgentSpec,
  scenario: SmokeScenario,
  brainMode: Exclude<SmokeBrainMode, "rule">,
  provider: LlmProvider | null,
  providerTimeoutMs: number | undefined,
): AgentBrain {
  if (brainMode === "mock-llm") {
    return createMockLlmBrain(spec, scenario, providerTimeoutMs);
  }
  if (brainMode === "planner") {
    return new PlannerExecutorAgentBrain({
      profile: spec.profile,
      planner: new MockLlmPlanner(spec.profile),
      executor: new FrontierPolicyExecutor(spec.profile, {
        settings: {
          territoryFirstNeutralLandEnabled: true,
          maxActionsPerDecision: 5,
          siloTileShareRatio: 0.14,
          samTileShareRatio: 0.14,
        },
      }),
      planEveryDecisionSteps: 3,
    });
  }
  if (brainMode === "planner-codex-cli") {
    if (provider === null) {
      throw new LlmProviderConfigError(
        "planner-codex-cli smoke requested but no provider was configured.",
      );
    }
    return new PlannerExecutorAgentBrain({
      profile: spec.profile,
      planner: new LlmAgentPlanner({
        provider,
        profile: spec.profile,
        providerTimeoutMs,
        plannerType: "codex-cli",
      }),
      executor: new FrontierPolicyExecutor(spec.profile, {
        settings: {
          territoryFirstNeutralLandEnabled: true,
          maxActionsPerDecision: 5,
          siloTileShareRatio: 0.14,
          samTileShareRatio: 0.14,
        },
      }),
      planEveryDecisionSteps: 3,
    });
  }
  if (brainMode === "real-llm" || brainMode === "codex-cli") {
    if (provider === null) {
      throw new LlmProviderConfigError(
        `${brainMode} smoke requested but no provider was configured.`,
      );
    }
    return new LlmAgentBrain({
      provider,
      profile: spec.profile,
      brainType: brainMode,
      providerTimeoutMs,
      includePromptInMetadata: true,
    });
  }
  throw new Error(`Unsupported brain mode: ${brainMode}`);
}

function assertAttackSmokeSucceeded(
  records: Awaited<ReturnType<AgentLeagueMatchRunner["runDecisionTurn"]>>,
  gameState: Game,
): void {
  const acceptedAttack = records.find(
    (record) => record.intent?.type === "attack" && record.result.accepted,
  );

  if (acceptedAttack?.intent?.type !== "attack") {
    throw new Error(
      "attack smoke failed: no accepted attack intent was submitted",
    );
  }

  const targetID = acceptedAttack.intent.targetID;
  const attacker = gameState.playerByClientID(acceptedAttack.clientID ?? "");
  const hasOutgoingAttack = attacker
    ?.outgoingAttacks()
    .some((attack) => attack.target().id() === targetID);
  const attacksSent =
    attacker === undefined || attacker === null
      ? undefined
      : gameState.stats().getPlayerStats(attacker)?.attacks?.[0];
  const hasRecordedAttack =
    typeof attacksSent === "bigint"
      ? attacksSent > 0n
      : Number(attacksSent ?? 0) > 0;

  if (!hasOutgoingAttack && !hasRecordedAttack) {
    throw new Error(
      "attack smoke failed: submitted attack was not reflected in mirrored core state or stats",
    );
  }
}

function assertActionDiversitySmokeSucceeded(
  records: Awaited<ReturnType<AgentLeagueMatchRunner["runDecisionTurn"]>>,
  gameState: Game,
): void {
  const selected = records.find(
    (record) =>
      record.chosenActionKind !== "hold" &&
      record.chosenActionKind !== "spawn" &&
      record.result.accepted,
  );

  if (selected === undefined) {
    throw new Error(
      `action smoke failed: only hold/spawn actions selected: ${JSON.stringify(
        summarizeRecords(records),
      )}`,
    );
  }

  if (selected.intent?.type !== "build_unit") {
    return;
  }

  const player = gameState.playerByClientID(selected.clientID ?? "");
  const built = player
    ?.units(selected.intent.unit)
    .some((unit) => unit.tile() === selected.chosenActionMetadata?.buildTile);
  if (!built) {
    throw new Error(
      "action smoke failed: accepted build intent was not reflected in mirrored core state",
    );
  }
}

type SmokeScenario = "league" | "attack" | "actions";
type SmokeBrainMode =
  | "rule"
  | "mock-llm"
  | "real-llm"
  | "codex-cli"
  | "planner"
  | "planner-codex-cli";
type SmokeRunnerMode = "realtime" | "step-locked";

function defaultRunID(
  scenario: SmokeScenario,
  brainMode: SmokeBrainMode,
  runnerMode: SmokeRunnerMode,
) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${scenario}-${brainMode}-${runnerMode}-${randomUUID().slice(
    0,
    8,
  )}`;
}

function artifactBrainMode(brainMode: SmokeBrainMode): AgentBrainType {
  return brainMode === "planner" || brainMode === "planner-codex-cli"
    ? "planner-executor"
    : brainMode;
}

function compactDecisionMetadata(
  metadata: Record<string, string | number | boolean | null> | undefined,
) {
  if (metadata?.llmPrompt === undefined) {
    return metadata;
  }
  return {
    ...metadata,
    llmPrompt: "[stored in artifacts]",
    llmPromptLength:
      typeof metadata.llmPrompt === "string" ? metadata.llmPrompt.length : null,
  };
}

function agentRunRoster(
  participants: ReturnType<typeof createAgentParticipants>,
): AgentRunRosterEntry[] {
  return participants.map((participant) => ({
    agentID: participant.runner.agentID,
    username: participant.spec.username,
    profile: participant.spec.profile,
    clientID: participant.runner.clientID(),
    brainType: participant.brain.brainType ?? "rule",
  }));
}

function finalKnownState(input: {
  participants: ReturnType<typeof createAgentParticipants>;
  gameState: Game;
  turnCount: number;
}): AgentRunFinalState {
  const participantClientIDs = new Set(
    input.participants
      .map((participant) => participant.runner.clientID())
      .filter((clientID): clientID is string => clientID !== null),
  );
  const participantNames = new Set(
    input.participants.map((participant) => participant.spec.username),
  );
  const opponentStates = input.gameState
    .players()
    .filter((player) => {
      const clientID = player.clientID();
      return (
        (clientID === null || !participantClientIDs.has(clientID)) &&
        !participantNames.has(player.name())
      );
    })
    .map((player) => ({
      agentID: "builtin-opponent",
      username: player.name(),
      profile: "opportunistic" as const,
      type: player.type(),
      playerID: player.id(),
      isAlive: player.isAlive(),
      tilesOwned: player.numTilesOwned(),
      troops: player.troops(),
      gold: player.gold().toString(),
    }));
  return {
    phase: input.gameState.inSpawnPhase() ? "spawn" : "active",
    tick: input.gameState.ticks(),
    turnCount: input.turnCount,
    players: input.participants.map((participant) => {
      const player = input.gameState.playerByClientID(
        participant.runner.clientID() ?? "",
      );
      return {
        agentID: participant.runner.agentID,
        username: participant.spec.username,
        profile: participant.spec.profile,
        type: player?.type() ?? null,
        playerID: player?.id() ?? null,
        isAlive: player?.isAlive() ?? null,
        tilesOwned: player?.numTilesOwned() ?? null,
        troops: player?.troops() ?? null,
        gold: player?.gold().toString() ?? null,
      };
    }),
    opponents: opponentStates,
  };
}

function artifactNotes(
  scenario: SmokeScenario,
  brainMode: SmokeBrainMode,
  runnerMode: SmokeRunnerMode,
): string[] {
  return [
    `Scenario ${scenario} uses the in-process smoke runner, not a distributed worker match.`,
    `Brain mode ${brainMode} still selects only existing LegalAction.id values.`,
    `Runner mode ${runnerMode} controls whether turns advance on a timer or through explicit smoke steps.`,
    "Artifacts may include raw prompts and model responses; API keys are never included in prompts or written by the provider.",
  ];
}

function actionCountsByKind(
  records: Awaited<ReturnType<AgentLeagueMatchRunner["runDecisionTurn"]>>,
) {
  return records.reduce<Record<string, number>>((counts, record) => {
    counts[record.chosenActionKind] =
      (counts[record.chosenActionKind] ?? 0) + 1;
    return counts;
  }, {});
}

function fallbackCount(
  records: Awaited<ReturnType<AgentLeagueMatchRunner["runDecisionTurn"]>>,
) {
  return records.filter(
    (record) =>
      record.decisionMetadata?.fallbackUsed === true ||
      record.decisionMetadata?.plannerFallbackUsed === true,
  ).length;
}

function assertRequiredExternalBrainSucceeded(input: {
  brainMode: SmokeBrainMode;
  records: AgentDecisionRecord[];
}): void {
  if (!requiresExternalBrainSuccess(input.brainMode)) {
    return;
  }

  const report = externalBrainCleanlinessReport(input);
  if (report.ok) {
    return;
  }

  throw new Error(
    [
      `Required ${input.brainMode} run was not clean, so this is not a real Codex-controlled match.`,
      `externalCalls=${report.externalCalls}`,
      `cleanExternalCalls=${report.cleanExternalCalls}`,
      `parserFailures=${report.parserFailures}`,
      `fallbacks=${report.fallbacks}`,
      `rejectedIntents=${report.rejectedIntents}`,
      `firstFailure=${report.firstFailureReason}`,
    ].join(" "),
  );
}

function requiresExternalBrainSuccess(brainMode: SmokeBrainMode): boolean {
  if (process.env.AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS === "true") {
    return true;
  }
  if (brainMode !== "codex-cli" && brainMode !== "planner-codex-cli") {
    return false;
  }
  return (
    process.env.AI_LEAGUE_REQUIRE_CODEX_SUCCESS === "true"
  );
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
      mapBin: () => this.loadBinary(path.join(mapDir, "map.bin")),
      map4xBin: () => this.loadBinary(path.join(mapDir, "map4x.bin")),
      map16xBin: () => this.loadBinary(path.join(mapDir, "map16x.bin")),
      manifest: () => this.loadJson(path.join(mapDir, "manifest.json")),
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

  private async loadBinary(filePath: string): Promise<Uint8Array> {
    return fs.promises.readFile(filePath);
  }

  private async loadJson(filePath: string): Promise<MapManifest> {
    return JSON.parse(
      await fs.promises.readFile(filePath, "utf8"),
    ) as MapManifest;
  }
}

try {
  await run();
} catch (error) {
  if (error instanceof LlmProviderConfigError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
