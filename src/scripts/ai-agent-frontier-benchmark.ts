import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import winston from "winston";
import { GameEnv, ServerConfig } from "../core/configuration/Config";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerType,
  Relation,
  UnitType,
} from "../core/game/Game";
import { GameMapLoader, MapData } from "../core/game/GameMapLoader";
import { loadTerrainMap, MapManifest } from "../core/game/TerrainMapLoader";
import { GameConfig, ServerMessage } from "../core/Schemas";
import { auditDecisionEffects } from "../server/agents/AgentActionAuditor";
import {
  AgentRunFinalState,
  AgentRunRosterEntry,
  writeAgentLeagueRunArtifacts,
} from "../server/agents/AgentDecisionLogWriter";
import {
  AgentLeagueMatchRunner,
  AgentSpec,
  buildSpawnCandidates,
  createAgentParticipants,
} from "../server/agents/AgentLeagueMatch";
import { writeAgentLearningArtifacts } from "../server/agents/AgentLearningArtifacts";
import { createClaudeCliLlmProviderFromEnv } from "../server/agents/ClaudeCliLlmProvider";
import {
  buildAgentMatchStory,
  type AgentProfileDifferentiationGate,
} from "../server/agents/AgentMatchStory";
import {
  AgentLocalGameMirror,
  waitForMirrorState,
} from "../server/agents/AgentLocalGameMirror";
import { AgentObservationBuilder } from "../server/agents/AgentObservationBuilder";
import { StrategyAgentBrain } from "../server/agents/StrategyAgentBrain";
import {
  AgentSettings,
  FrontierPolicyExecutor,
  LlmAgentPlanner,
  MockLlmPlanner,
  PlannerExecutorAgentBrain,
  RuleAgentPlanner,
} from "../server/agents/AgentPlannerExecutor";
import {
  AgentSpectatorSnapshot,
  buildAgentSpectatorReplay,
  buildAgentSpectatorSnapshot,
  buildGameRecordFromServerMessages,
} from "../server/agents/AgentSpectatorReplay";
import {
  AgentBrain,
  AgentBrainType,
  AgentDecisionRecord,
  AgentObjectiveKind,
  AgentObservation,
  AgentRuntimeMode,
  AgentStrategyProfile,
  AgentVisiblePlayer,
  LegalAction,
  LegalActionKind,
  agentStrategyProfiles,
  legalActionKinds,
} from "../server/agents/AgentTypes";
import {
  CodexCliLlmProvider,
  CodexCliLlmProviderConfig,
  loadCodexCliLlmProviderConfig,
} from "../server/agents/CodexCliLlmProvider";
import { ExternalHttpAgentBrain } from "../server/agents/ExternalHttpAgentBrain";
import {
  LegalActionBuilder,
  SpawnCandidate,
} from "../server/agents/LegalActionBuilder";
import { LlmAgentBrain } from "../server/agents/LlmAgentBrain";
import { LlmProviderConfigError } from "../server/agents/LlmProvider";
import { GameServer } from "../server/GameServer";

type FrontierBrainMode =
  | AgentRuntimeMode
  | "planner"
  | "planner-codex-cli"
  | "planner-claude-cli"
  | "action-claude-cli"
  | "rule-planner"
  | "strategy"
  | "codex-cli"
  | "external-http";

type FrontierBenchmarkProfile = AgentStrategyProfile | "all";

interface FrontierBenchmarkConfig {
  runID: string;
  runs: number;
  startIndex: number;
  targetWins: number;
  nations: number;
  bots: number;
  map: GameMapType;
  mapSize: GameMapSize;
  difficulty: Difficulty;
  turnsPerDecision: number;
  maxTurns: number;
  maxDecisionMs: number;
  planEveryDecisionSteps: number;
  frontierFinishPressure: boolean;
  navalControl: boolean;
  lateGameStrikeTargeting: boolean;
  personalityDiplomacyPressure: boolean;
  openingExpansionTempo: boolean;
  transportTroopBanking: boolean;
  humanReplayEconomyCadence: boolean;
  profileRepairReRank: boolean;
  writeReplay: boolean;
  fullMatch: boolean;
  brainMode: FrontierBrainMode;
  runtimeMode: AgentRuntimeMode;
  profile: FrontierBenchmarkProfile;
  forceSpawnTile: number | null;
  externalAgentEndpointUrl: string | null;
  externalAgentTimeoutMs: number;
}

interface FrontierRunSummary {
  index: number;
  gameID: string;
  won: boolean;
  survived: boolean;
  termination: "winner" | "agent_eliminated" | "max_turns";
  winner: string | null;
  winnerType: string | null;
  profile: AgentStrategyProfile;
  turns: number;
  ticks: number;
  tileShare: number;
  actionCounts: Partial<Record<LegalActionKind, number>>;
  offeredActionCounts: Partial<Record<LegalActionKind, number>>;
  neutralExpansionAttackCount: number;
  hostileAttackCount: number;
  offeredNeutralExpansionCount: number;
  offeredHostileAttackCount: number;
  pressureOnlyActionCount: number;
  pressureWithHostileAttackOfferedCount: number;
  pressureWithUnblockedHostileAttackCount: number;
  socialActionCount: number;
  transportWaitHoldCount: number;
  attackSafetyHoldCount: number;
  supportCooldownHoldCount: number;
  unexplainedHoldCount: number;
  acceptedIntentCount: number;
  rejectedIntentCount: number;
  auditCounts: Record<string, number>;
  fallbacks: number;
  parseFailures: number;
  averageDecisionLatencyMs: number;
  runtimeMode: AgentRuntimeMode;
  profileDifferentiation: AgentProfileDifferentiationGate;
  plannerSources: Record<string, number>;
  executorSources: Record<string, number>;
  actionSelectionSources: Record<string, number>;
  externalPlannerCallCount: number;
  externalActionCallCount: number;
  rawProviderOutputRecordCount: number;
  localExecutorActionCount: number;
  llmActionSelectionCount: number;
  replayRunID: string | null;
  openFrontReplayUrl: string | null;
  records: AgentDecisionRecord[];
}

type ClosableAgentBrain = AgentBrain & { close?: () => void };

const autonomousActionKinds = legalActionKinds.filter(
  (kind) => kind !== "hold",
);

const log = winston.createLogger({
  level: process.env.AI_LEAGUE_FRONTIER_LOG_LEVEL ?? "warn",
  format: winston.format.simple(),
  transports: [new winston.transports.Console()],
});

async function run() {
  process.env.GAME_ENV ??= "dev";
  const startedAt = Date.now();
  const config = configFromArgs(process.argv.slice(2));
  const artifactDir = path.resolve(
    process.cwd(),
    "artifacts/ai-league-benchmarks",
    config.runID,
  );
  await fs.promises.mkdir(artifactDir, { recursive: true });

  const terrain = await loadTerrainMap(
    config.map,
    config.mapSize,
    new StaticMapLoader(),
  );
  const spawnCandidates = buildSpawnCandidates(terrain.gameMap, {
    maxCandidates: 1_000,
    stride: 2,
  });

  const runSummaries: FrontierRunSummary[] = [];
  const finalRunIndex = config.startIndex + config.runs - 1;
  for (let index = config.startIndex; index <= finalRunIndex; index += 1) {
    const summary = await runSingleMatch({
      config,
      index,
      spawnCandidates,
    });
    runSummaries.push(summary);
    await fs.promises.writeFile(
      path.join(artifactDir, `run-${index}.records.json`),
      `${JSON.stringify(summary.records, null, 2)}\n`,
    );
    assertRequiredExternalBrainSucceeded({
      brainMode: config.brainMode,
      summary,
    });
  }

  const targetedCoverage = await runTargetedCoverageScenarios(
    config.profile === "all" ? "aggressive" : config.profile,
  );
  const cost = estimateCost(runSummaries);
  const diagnosis = performanceDiagnosis(runSummaries, config);
  const report = frontierReport({
    config,
    startedAt,
    completedAt: Date.now(),
    runSummaries,
    targetedCoverage,
    cost,
    diagnosis,
  });
  await Promise.all([
    fs.promises.writeFile(path.join(artifactDir, "frontier-report.md"), report),
    fs.promises.writeFile(
      path.join(artifactDir, "benchmark-report.md"),
      report,
    ),
    fs.promises.writeFile(
      path.join(artifactDir, "performance-diagnosis.md"),
      diagnosis,
    ),
  ]);
  const learningPaths = await writeAgentLearningArtifacts({
    benchmarkID: config.runID,
    runs: runSummaries.map((summary) => ({
      runID: summary.replayRunID ?? `${config.runID}-run-${summary.index}`,
      benchmarkRunIndex: summary.index,
      won: summary.won,
      survived: summary.survived,
      tileShare: summary.tileShare,
      turns: summary.turns,
      records: summary.records,
    })),
    directory: artifactDir,
  });
  const summaryPayload = {
    config,
    pass:
      runSummaries.filter((summary) => summary.won).length >= config.targetWins,
    requiredWins: config.targetWins,
    wins: runSummaries.filter((summary) => summary.won).length,
    runs: runSummaries.map(({ records: _records, ...summary }) => summary),
    targetedCoverage,
    cost,
    diagnosisPath: path.join(artifactDir, "performance-diagnosis.md"),
    learningReportPath: learningPaths.markdownPath,
  };
  await fs.promises.writeFile(
    path.join(artifactDir, "frontier-summary.json"),
    `${JSON.stringify(summaryPayload, null, 2)}\n`,
  );
  await fs.promises.writeFile(
    path.join(artifactDir, "benchmark-summary.json"),
    `${JSON.stringify(summaryPayload, null, 2)}\n`,
  );

  console.log("Frontier benchmark complete", {
    runID: config.runID,
    wins: runSummaries.filter((summary) => summary.won).length,
    runs: config.runs,
    targetWins: config.targetWins,
    pass: summaryPayload.pass,
    report: path.join(artifactDir, "benchmark-report.md"),
    diagnosis: path.join(artifactDir, "performance-diagnosis.md"),
    learning: learningPaths.markdownPath,
  });
}

async function runSingleMatch(input: {
  config: FrontierBenchmarkConfig;
  index: number;
  spawnCandidates: SpawnCandidate[];
}): Promise<FrontierRunSummary> {
  const startedAt = Date.now();
  const gameID = `FRNT${String(input.index).padStart(4, "0")}`;
  const game = new GameServer(
    gameID,
    log,
    benchmarkSeed(input.config, input.index),
    serverConfig(),
    gameConfig(input.config),
  );
  disableIntentRateLimitForBenchmark(game);
  const profile = profileForRun(input.config, input.index);
  const spec: AgentSpec = {
    username: "Frontier Agent",
    profile,
    clientID: `FRT${String(input.index).padStart(5, "0")}`,
    persistentID: `frontier-agent-${input.index}`,
  };
  const participants = createAgentParticipants([spec], log, {
    brainFactory: () => createBrain(input.config, profile),
  });
  const mirror = new AgentLocalGameMirror(new StaticMapLoader(), log);
  const messages = () => participants[0].runner.serverMessages();
  const spectatorSnapshots: AgentSpectatorSnapshot[] = [];
  const league = new AgentLeagueMatchRunner({
    game,
    participants,
    spawnCandidates: spawnCandidatesForRun(
      input.spawnCandidates,
      input.index,
      input.config.forceSpawnTile,
    ),
    log,
  });

  try {
    league.attachAgents();
    const roster = frontierRoster(participants);
    league.startGame();
    const openingRecords = await league.runOpeningTurn(0, {
      maxDecisionMs: input.config.maxDecisionMs,
    });
    game.advanceTurnsForTesting(1);
    await mirror.ingest(messages());
    let currentGame = await advanceUntil({
      game,
      mirror,
      messages,
      turnsPerStep: input.config.turnsPerDecision,
      maxAdvanceTurns: 2_000,
      until: (state) => !state.inSpawnPhase(),
    });
    auditDecisionEffects({
      records: openingRecords,
      beforeGame: null,
      afterGame: currentGame,
    });
    spectatorSnapshots.push(
      buildAgentSpectatorSnapshot({
        label: "After spawn",
        turnNumber: mirror.turnCount(),
        gameState: currentGame,
        records: openingRecords,
        roster,
      }),
    );

    let termination: FrontierRunSummary["termination"] = "max_turns";
    while (mirror.turnCount() < input.config.maxTurns) {
      const winner = currentGame.getWinner();
      const player = currentGame.playerByClientID(
        participants[0].runner.clientID() ?? "",
      );
      if (winner !== null) {
        termination = "winner";
        break;
      }
      if (player === null || !player.isAlive()) {
        termination = "agent_eliminated";
        break;
      }

      const before = currentGame;
      const records = await league.runDecisionTurn({
        turnNumber: mirror.turnCount(),
        gameState: currentGame,
        maxDecisionMs: input.config.maxDecisionMs,
      });
      game.advanceTurnsForTesting(input.config.turnsPerDecision);
      currentGame = await waitForMirrorState({
        mirror,
        messages,
        until: (_state, currentMirror) => currentMirror.pendingTurns() === 0,
        timeoutMs: Math.max(1_000, input.config.turnsPerDecision * 30),
      });
      auditDecisionEffects({
        records,
        beforeGame: before,
        afterGame: currentGame,
      });
      spectatorSnapshots.push(
        buildAgentSpectatorSnapshot({
          label: `Decision cycle ${spectatorSnapshots.length}`,
          turnNumber: mirror.turnCount(),
          gameState: currentGame,
          records,
          roster,
        }),
      );
    }

    const player = currentGame.playerByClientID(
      participants[0].runner.clientID() ?? "",
    );
    const winner = currentGame.getWinner();
    const won =
      winner !== null && typeof winner !== "string" && winner === player;
    const records = league.decisionRecords();
    const attribution = runtimeAttribution(records, input.config.runtimeMode);
    const behaviorCounts = benchmarkBehaviorCounts(records);
    const matchStory = buildAgentMatchStory({
      runID:
        input.config.runs === 1
          ? input.config.runID
          : `${input.config.runID}-run-${input.index}`,
      matchID: gameID,
      scenario: "frontier",
      brainMode: artifactBrainType(input.config),
      records,
    });
    const replay = input.config.writeReplay
      ? await writeFrontierReplayArtifacts({
          config: input.config,
          runIndex: input.index,
          game,
          finalGameState: currentGame,
          mirrorTurnCount: mirror.turnCount(),
          participants,
          roster,
          records,
          spectatorSnapshots,
          messages: messages(),
          startedAt,
          completedAt: Date.now(),
        })
      : null;
    return {
      index: input.index,
      gameID,
      won,
      survived: player?.isAlive() ?? false,
      termination,
      winner: winnerName(winner),
      winnerType:
        winner === null
          ? null
          : typeof winner === "string"
            ? "team"
            : winner.type(),
      profile,
      turns: mirror.turnCount(),
      ticks: currentGame.ticks(),
      tileShare:
        player === null
          ? 0
          : round(
              player.numTilesOwned() / Math.max(currentGame.numLandTiles(), 1),
            ),
      actionCounts: actionCounts(records),
      offeredActionCounts: offeredActionCounts(records),
      ...behaviorCounts,
      acceptedIntentCount: records.filter((record) => record.result.accepted)
        .length,
      rejectedIntentCount: records.filter((record) => !record.result.accepted)
        .length,
      auditCounts: auditCounts(records),
      fallbacks: records.filter(
        (record) =>
          record.decisionMetadata?.fallbackUsed === true ||
          record.decisionMetadata?.plannerFallbackUsed === true,
      ).length,
      parseFailures: records.filter(
        (record) =>
          record.decisionMetadata?.plannerParseOk === false ||
          record.decisionMetadata?.llmParseOk === false,
      ).length,
      averageDecisionLatencyMs: average(
        records.map((record) => record.decisionLatencyMs),
      ),
      profileDifferentiation: matchStory.profileDifferentiation,
      ...attribution,
      replayRunID: replay?.runID ?? null,
      openFrontReplayUrl: replay?.openFrontReplayUrl ?? null,
      records,
    };
  } finally {
    closeParticipantBrains(participants);
    await game.end({ archive: false });
  }
}

function benchmarkSeed(config: FrontierBenchmarkConfig, index: number): number {
  const difficultyOffset =
    Object.values(Difficulty).indexOf(config.difficulty) + 1;
  const mapOffset = Object.values(GameMapType).indexOf(config.map) + 1;
  const sizeOffset = Object.values(GameMapSize).indexOf(config.mapSize) + 1;
  return (
    1_000_003 +
    index * 10_007 +
    config.nations * 503 +
    config.bots * 211 +
    difficultyOffset * 97 +
    mapOffset * 53 +
    sizeOffset * 31
  );
}

function disableIntentRateLimitForBenchmark(game: GameServer): void {
  (
    game as unknown as {
      intentRateLimiter: { check: () => "ok" };
    }
  ).intentRateLimiter = { check: () => "ok" };
}

function spawnCandidatesForRun(
  candidates: SpawnCandidate[],
  runIndex: number,
  forceSpawnTile: number | null = null,
): SpawnCandidate[] {
  if (candidates.length === 0) {
    return candidates;
  }
  const windowSize = Math.min(96, candidates.length);
  const offset = ((runIndex - 1) * 73) % candidates.length;
  const rotated = [...candidates.slice(offset), ...candidates.slice(0, offset)];
  const window = rotated.slice(0, windowSize);
  if (forceSpawnTile === null) {
    return window;
  }
  const forced =
    candidates.find((candidate) => candidate.tile === forceSpawnTile) ??
    window.find((candidate) => candidate.tile === forceSpawnTile);
  return forced === undefined ? window : [forced];
}

function profileForRun(
  config: FrontierBenchmarkConfig,
  runIndex: number,
): AgentStrategyProfile {
  if (config.profile !== "all") {
    return config.profile;
  }
  return agentStrategyProfiles[(runIndex - 1) % agentStrategyProfiles.length]!;
}

function createBrain(
  config: FrontierBenchmarkConfig,
  profile: AgentStrategyProfile,
): AgentBrain {
  const executor = () =>
    new FrontierPolicyExecutor(profile, {
      settings: frontierExecutorSettings(config),
    });
  if (config.brainMode === "strategy") {
    return new StrategyAgentBrain(profile);
  }
  if (config.brainMode === "external-http") {
    if (config.externalAgentEndpointUrl === null) {
      throw new Error(
        "--brain=external-http requires --external-agent-endpoint-url=<url>",
      );
    }
    return new ExternalHttpAgentBrain({
      endpointUrl: config.externalAgentEndpointUrl,
      timeoutMs: config.externalAgentTimeoutMs,
      profile,
    });
  }
  if (config.brainMode === "planner-claude-cli") {
    // Run the Claude CLI from an empty dir OUTSIDE the repo so each per-decision
    // call does not reload this project's large CLAUDE.md / .claude settings / MCP
    // servers (measured ~1s+ cold-start saved per decision).
    const cleanCwd = path.join(os.tmpdir(), "proxywar-claude-cli-cwd");
    fs.mkdirSync(cleanCwd, { recursive: true });
    const provider = createClaudeCliLlmProviderFromEnv(process.env, cleanCwd);
    return new PlannerExecutorAgentBrain({
      profile,
      planner: new LlmAgentPlanner({
        provider,
        profile,
        providerTimeoutMs: config.maxDecisionMs,
        plannerType: "real-llm",
      }),
      executor: executor(),
      planEveryDecisionSteps: config.planEveryDecisionSteps,
      runtimeMode: "llm-policy-planner",
      executorSource: "frontier-policy-executor",
    });
  }
  if (config.brainMode === "action-claude-cli") {
    // LLM-FIRST agent: Claude picks the LegalAction.id directly (action-selector),
    // choosing from the ranked shortlist LlmPromptBuilder supplies. The executor is
    // NOT the decision-maker here; it only ranks/advises + provides a safe fallback.
    const cleanCwd = path.join(os.tmpdir(), "proxywar-claude-cli-cwd");
    fs.mkdirSync(cleanCwd, { recursive: true });
    const provider = createClaudeCliLlmProviderFromEnv(process.env, cleanCwd);
    return new LlmAgentBrain({
      provider,
      profile,
      providerTimeoutMs: config.maxDecisionMs,
      runtimeMode: "llm-action-selector",
    });
  }
  if (config.runtimeMode === "llm-policy-planner") {
    const providerConfig = codexCliConfig(config);
    const provider = new CodexCliLlmProvider({
      ...providerConfig,
      outputSchema: "planner",
    });
    return withBrainClose(
      new PlannerExecutorAgentBrain({
        profile,
        planner: new LlmAgentPlanner({
          provider,
          profile,
          providerTimeoutMs: config.maxDecisionMs,
          plannerType: "codex-cli",
        }),
        executor: executor(),
        planEveryDecisionSteps: config.planEveryDecisionSteps,
        runtimeMode: "llm-policy-planner",
        executorSource: "frontier-policy-executor",
      }),
      () => provider.close(),
    );
  }
  if (config.runtimeMode === "llm-action-selector") {
    const providerConfig = codexCliConfig(config);
    const provider = new CodexCliLlmProvider({
      ...providerConfig,
      outputSchema: "decision",
    });
    return withBrainClose(
      new LlmAgentBrain({
        provider,
        profile,
        providerTimeoutMs: config.maxDecisionMs,
        runtimeMode: "llm-action-selector",
      }),
      () => provider.close(),
    );
  }
  if (config.runtimeMode === "local-policy-baseline") {
    return new PlannerExecutorAgentBrain({
      profile,
      planner: new RuleAgentPlanner(profile),
      executor: executor(),
      planEveryDecisionSteps: config.planEveryDecisionSteps,
      runtimeMode: "local-policy-baseline",
      executorSource: "frontier-policy-executor",
    });
  }
  return new PlannerExecutorAgentBrain({
    profile,
    planner: new MockLlmPlanner(profile),
    executor: executor(),
    planEveryDecisionSteps: config.planEveryDecisionSteps,
    runtimeMode: "mock-policy-planner",
    executorSource: "frontier-policy-executor",
  });
}

function withBrainClose<T extends AgentBrain>(
  brain: T,
  close: () => void,
): T {
  (brain as ClosableAgentBrain).close = close;
  return brain;
}

function closeParticipantBrains(
  participants: Array<{ brain: AgentBrain }>,
): void {
  for (const participant of participants) {
    (participant.brain as ClosableAgentBrain).close?.();
  }
}

function frontierExecutorSettings(
  config: FrontierBenchmarkConfig,
): Partial<AgentSettings> {
  return {
    frontierFinishPressureEnabled: config.frontierFinishPressure,
    navalControlEnabled: config.navalControl,
    lateGameStrikeTargetingEnabled: config.lateGameStrikeTargeting,
    personalityDiplomacyPressureEnabled: config.personalityDiplomacyPressure,
    openingExpansionTempoEnabled: config.openingExpansionTempo,
    transportTroopBankingEnabled: config.transportTroopBanking,
    territoryFirstNeutralLandEnabled: true,
    humanReplayEconomyCadenceEnabled: config.humanReplayEconomyCadence,
    profileRepairReRankEnabled: config.profileRepairReRank,
  };
}

function frontierRoster(
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

async function writeFrontierReplayArtifacts(input: {
  config: FrontierBenchmarkConfig;
  runIndex: number;
  game: GameServer;
  finalGameState: Game;
  mirrorTurnCount: number;
  participants: ReturnType<typeof createAgentParticipants>;
  roster: AgentRunRosterEntry[];
  records: AgentDecisionRecord[];
  spectatorSnapshots: AgentSpectatorSnapshot[];
  messages: ServerMessage[];
  startedAt: number;
  completedAt: number;
}): Promise<{ runID: string; openFrontReplayUrl: string }> {
  const runID =
    input.config.runs === 1
      ? input.config.runID
      : `${input.config.runID}-run-${input.runIndex}`;
  const finalState = frontierFinalKnownState({
    participants: input.participants,
    gameState: input.finalGameState,
    turnCount: input.mirrorTurnCount,
  });
  const gameRecord = buildGameRecordFromServerMessages({
    messages: input.messages,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
  const spectatorReplay = buildAgentSpectatorReplay({
    runID,
    matchID: input.game.id,
    scenario: "frontier",
    brainMode: artifactBrainType(input.config),
    runnerMode: "step-locked",
    finalGameState: input.finalGameState,
    roster: input.roster,
    snapshots: input.spectatorSnapshots,
    notes: [
      `Frontier benchmark runtimeMode=${input.config.runtimeMode}.`,
      `One Frontier agent vs ${input.config.nations} official PlayerType.Nation opponent(s) and ${input.config.bots} built-in tribe/bot opponent(s).`,
      "Native Proxy War replay uses the saved game-record.json and read-only replay path.",
    ],
  });
  await writeAgentLeagueRunArtifacts({
    runID,
    matchID: input.game.id,
    scenario: "frontier",
    brainMode: artifactBrainType(input.config),
    runnerMode: "step-locked",
    runnerConfig: {
      turnsPerDecisionStep: input.config.turnsPerDecision,
      maxDecisionMs: input.config.maxDecisionMs,
      maxSteps: Math.ceil(
        input.config.maxTurns / input.config.turnsPerDecision,
      ),
      stepsCompleted: input.records.length,
      replayTailTurns: 0,
      agents: input.participants.length,
      bots: input.config.bots,
      nations: input.config.nations,
      map: input.config.map,
      mapSize: input.config.mapSize,
      difficulty: input.config.difficulty,
    },
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    records: input.records,
    roster: input.roster,
    finalState,
    spectatorReplay,
    gameRecord,
    notes: [
      `Frontier benchmark report lives under artifacts/ai-league-benchmarks/${input.config.runID}.`,
      `Runtime mode ${input.config.runtimeMode}; provider-call counts are in match-summary and frontier-summary.`,
    ],
  });
  return {
    runID,
    openFrontReplayUrl: `http://127.0.0.1:9000/ai-league-replay/${encodeURIComponent(runID)}`,
  };
}

function artifactBrainType(config: FrontierBenchmarkConfig): AgentBrainType {
  if (config.brainMode === "external-http") {
    return "external-http";
  }
  return config.runtimeMode === "llm-action-selector"
    ? "codex-cli"
    : "planner-executor";
}

function frontierFinalKnownState(input: {
  participants: ReturnType<typeof createAgentParticipants>;
  gameState: Game;
  turnCount: number;
}): AgentRunFinalState {
  return {
    phase: input.gameState.getWinner()
      ? "finished"
      : input.gameState.inSpawnPhase()
        ? "spawn"
        : "active",
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
        playerID: player?.id() ?? null,
        isAlive: player?.isAlive() ?? null,
        tilesOwned: player?.numTilesOwned() ?? null,
        troops: player?.troops() ?? null,
        gold: player?.gold().toString() ?? null,
      };
    }),
  };
}

function codexCliConfig(
  config: FrontierBenchmarkConfig,
): CodexCliLlmProviderConfig {
  try {
    return loadCodexCliLlmProviderConfig(process.env, process.cwd());
  } catch (error) {
    if (
      error instanceof LlmProviderConfigError &&
      process.env.AI_LEAGUE_LLM_PROVIDER === undefined
    ) {
      return {
        command: process.env.AI_LEAGUE_CODEX_COMMAND ?? "codex",
        cwd: process.cwd(),
        timeoutMs: config.maxDecisionMs,
        model:
          process.env.AI_LEAGUE_CODEX_MODEL ?? process.env.AI_LEAGUE_LLM_MODEL,
        reasoningEffort:
          process.env.AI_LEAGUE_CODEX_REASONING_EFFORT ??
          process.env.AI_LEAGUE_LLM_REASONING_EFFORT,
        profile: process.env.AI_LEAGUE_CODEX_PROFILE,
      };
    }
    throw error;
  }
}

async function runTargetedCoverageScenarios(profile: AgentSpec["profile"]) {
  const executor = new FrontierPolicyExecutor(profile);
  const builder = new LegalActionBuilder();
  const scenarios = targetedScenarioObservations();
  return scenarios.map((scenario) => {
    const legalActions = builder.build({
      observation: scenario.observation,
      spawnCandidates: scenario.spawnCandidates,
      maxPostSpawnActions: 80,
    });
    const wantedAction = legalActions.find(
      (action) => action.kind === scenario.expectedKind,
    );
    const executorLegalActions =
      scenario.useAllLegalActions || wantedAction === undefined
        ? legalActions
        : [wantedAction, holdAction()];
    const decision = executor.decide(
      {
        observation: scenario.observation,
        legalActions: executorLegalActions,
      },
      {
        planID: `targeted:${scenario.name}`,
        objective: scenario.objective,
        targetPlayerId: scenario.targetPlayerId ?? null,
        rationale: scenario.name,
        startedAtTick: scenario.observation.tick,
        maxDecisionCycles: 1,
        successCriteria: ["targeted scenario selects the expected action kind"],
        failureCriteria: ["expected action kind is not offered"],
        preferredActionKinds: [scenario.expectedKind],
        forbiddenActionKinds: [],
        plannerSource: "mock-llm",
      },
    );
    const selected = legalActions.find(
      (action) => action.id === decision.actionID,
    );
    return {
      name: scenario.name,
      expectedKind: scenario.expectedKind,
      offered: wantedAction !== undefined,
      selectedKind: selected?.kind ?? null,
      selectedExpected: selected?.kind === scenario.expectedKind,
      legalActionIDs: legalActions.map((action) => action.id),
      reason: decision.reason,
    };
  });
}

function targetedScenarioObservations(): Array<{
  name: string;
  expectedKind: LegalActionKind;
  objective: AgentObjectiveKind;
  targetPlayerId?: string;
  spawnCandidates?: SpawnCandidate[];
  useAllLegalActions?: boolean;
  observation: AgentObservation;
}> {
  const base = baseObservation();
  const rival = visiblePlayer("rival-1", {
    name: "Rival",
    troops: 4_000,
    tilesOwned: 200,
    tileShare: 0.18,
    sharesBorder: true,
    canAttack: true,
    canEmbargo: true,
    canTarget: true,
    relativeTroopRatio: 1.8,
  });
  const ally = visiblePlayer("ally-1", {
    name: "Ally",
    isAllied: true,
    isFriendly: true,
    canDonateGold: true,
    canDonateTroops: true,
    canExtendAlliance: true,
  });
  const requester = visiblePlayer("requester-1", {
    name: "Requester",
    canRejectAlliance: true,
    hasIncomingAllianceRequest: true,
  });
  return [
    {
      name: "spawn opening",
      expectedKind: "spawn",
      objective: "choose_spawn",
      spawnCandidates: [
        {
          tile: 10,
          x: 5,
          y: 5,
          pressureScore: 0.2,
          safetyScore: 0.9,
          diplomacyScore: 0.6,
          opportunityScore: 0.8,
        },
      ],
      observation: { ...base, phase: "spawn" },
    },
    scenario("retreat bad attack", "retreat", "survive", {
      visiblePlayers: [rival],
      combat: {
        outgoingAttacks: [
          {
            attackID: "atk-1",
            targetID: "rival-1",
            targetName: "Rival",
            troops: 2_000,
            retreating: false,
            sourceTile: 22,
            borderSize: 4,
          },
        ],
      },
    }),
    scenario("neutral transport", "boat", "expand_territory", {
      nonCombat: {
        boatOptions: [
          {
            targetTile: 444,
            sourceTile: 111,
            targetID: null,
            targetName: "Terra Nullius",
            troops: 900,
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("transport troop banking", "boat", "pressure_rival", {
      ownState: {
        troops: 190_000,
        maxTroops: 200_000,
        troopRatio: 0.95,
        tilesOwned: 2_000,
        tileShare: 0.35,
      },
      combat: {
        ownTroops: 190_000,
        maxTroops: 200_000,
        troopRatio: 0.95,
        canExpandIntoNeutral: false,
        attackablePlayerIDs: [],
        borderedPlayerIDs: [],
      },
      visiblePlayers: [
        visiblePlayer("banking-rival", {
          name: "Banking Rival",
          troops: 60_000,
          maxTroops: 120_000,
          troopRatio: 0.5,
          tilesOwned: 600,
          tileShare: 0.1,
          sharesBorder: false,
          canAttack: false,
          canTarget: true,
          relativeTroopRatio: 3.1,
        }),
      ],
      targetPlayerId: "banking-rival",
      useAllLegalActions: true,
      nonCombat: {
        boatOptions: [
          {
            targetTile: 555,
            sourceTile: 111,
            targetID: "banking-rival",
            targetName: "Banking Rival",
            troops: 15_200,
            legalReason: "targeted troop-banking scenario",
          },
        ],
      },
    }),
    scenario("transport retreat", "boat_retreat", "survive", {
      nonCombat: {
        boatRetreatOptions: [
          {
            unitID: 7,
            tile: 30,
            targetTile: 444,
            troops: 700,
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("border attack", "attack", "pressure_rival", {
      visiblePlayers: [rival],
      combat: {
        borderedPlayerIDs: ["rival-1"],
        attackablePlayerIDs: ["rival-1"],
        weakestAttackableTargetID: "rival-1",
        strongestAttackableTargetID: "rival-1",
      },
      targetPlayerId: "rival-1",
    }),
    scenario("alliance request", "alliance_request", "build_alliance", {
      visiblePlayers: [visiblePlayer("friend-1", { canRequestAlliance: true })],
    }),
    scenario("alliance reject", "alliance_reject", "pressure_rival", {
      visiblePlayers: [requester],
      nonCombat: {
        allianceOptions: [
          {
            playerID: "requester-1",
            playerName: "Requester",
            action: "reject",
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("alliance extend", "alliance_extend", "build_alliance", {
      visiblePlayers: [ally],
      nonCombat: {
        allianceOptions: [
          {
            playerID: "ally-1",
            playerName: "Ally",
            action: "extend",
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("break leader alliance", "break_alliance", "pressure_rival", {
      visiblePlayers: [
        visiblePlayer("leader-1", {
          name: "Leader",
          isAllied: true,
          isFriendly: true,
          canBreakAlliance: true,
          tilesOwned: 500,
          tileShare: 0.42,
        }),
      ],
      targetPlayerId: "leader-1",
      endgame: {
        leaderID: "leader-1",
        leaderName: "Leader",
        leaderTileShare: 0.42,
      },
      nonCombat: {
        allianceOptions: [
          {
            playerID: "leader-1",
            playerName: "Leader",
            action: "break",
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("target rival", "target_player", "pressure_rival", {
      visiblePlayers: [rival],
      targetPlayerId: "rival-1",
      nonCombat: {
        targetOptions: [
          {
            targetID: "rival-1",
            targetName: "Rival",
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("emoji signal", "emoji", "build_alliance", {
      visiblePlayers: [ally],
      nonCombat: {
        emojiOptions: [
          {
            recipientID: "ally-1",
            recipientName: "Ally",
            emoji: 0,
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("quick chat signal", "quick_chat", "build_alliance", {
      visiblePlayers: [ally],
      nonCombat: {
        quickChatOptions: [
          {
            recipientID: "ally-1",
            recipientName: "Ally",
            quickChatKey: "help.troops",
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("city build", "build", "secure_economy", {
      nonCombat: {
        buildOptions: [
          {
            unit: UnitType.City,
            role: "economic",
            targetTile: 20,
            buildTile: 20,
            cost: "1000",
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("upgrade city", "upgrade_structure", "secure_economy", {
      nonCombat: {
        upgradeOptions: [
          {
            unitID: 3,
            unit: UnitType.City,
            tile: 20,
            level: 1,
            cost: "2000",
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("delete misplaced structure", "delete_unit", "survive", {
      nonCombat: {
        deleteUnitOptions: [
          {
            unitID: 9,
            unit: UnitType.DefensePost,
            tile: 88,
            level: 1,
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("move warship", "move_warship", "fortify_border", {
      nonCombat: {
        warshipMoveOptions: [
          {
            unitIDs: [5],
            targetTile: 700,
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("build warship", "warship", "fortify_border", {
      nonCombat: {
        buildOptions: [
          {
            unit: UnitType.Warship,
            role: "defensive",
            targetTile: 300,
            buildTile: 300,
            cost: "5000",
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("build nuke", "nuke", "pressure_rival", {
      visiblePlayers: [rival],
      targetPlayerId: "rival-1",
      endgame: {
        leaderID: "rival-1",
        leaderName: "Rival",
        leaderTileShare: 0.38,
      },
      nonCombat: {
        buildOptions: [
          {
            unit: UnitType.MIRV,
            role: "infrastructure",
            targetTile: 77,
            buildTile: 77,
            cost: "100000",
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("donate gold", "donate_gold", "build_alliance", {
      visiblePlayers: [ally],
      nonCombat: {
        supportOptions: [
          {
            recipientID: "ally-1",
            recipientName: "Ally",
            canDonateGold: true,
            canDonateTroops: false,
            suggestedGold: 1_000,
            suggestedTroops: null,
            legalReasons: ["targeted scenario"],
          },
        ],
      },
    }),
    scenario("donate troops", "donate_troops", "build_alliance", {
      visiblePlayers: [ally],
      nonCombat: {
        supportOptions: [
          {
            recipientID: "ally-1",
            recipientName: "Ally",
            canDonateGold: false,
            canDonateTroops: true,
            suggestedGold: null,
            suggestedTroops: 500,
            legalReasons: ["targeted scenario"],
          },
        ],
      },
    }),
    scenario("embargo rival", "embargo", "pressure_rival", {
      visiblePlayers: [rival],
      nonCombat: {
        embargoOptions: [
          {
            targetID: "rival-1",
            targetName: "Rival",
            action: "start",
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("stop embargo", "embargo_stop", "build_alliance", {
      visiblePlayers: [
        visiblePlayer("rival-2", {
          name: "Former Rival",
          canEmbargo: false,
          canStopEmbargo: true,
          hasEmbargoAgainst: true,
        }),
      ],
      nonCombat: {
        embargoOptions: [
          {
            targetID: "rival-2",
            targetName: "Former Rival",
            action: "stop",
            legalReason: "targeted scenario",
          },
        ],
      },
    }),
    scenario("embargo all", "embargo_all", "pressure_rival", {
      nonCombat: { canEmbargoAll: true },
    }),
  ];
}

function scenario(
  name: string,
  expectedKind: LegalActionKind,
  objective: AgentObjectiveKind,
  overrides: {
    ownState?: Partial<NonNullable<AgentObservation["ownState"]>>;
    visiblePlayers?: AgentVisiblePlayer[];
    combat?: Partial<AgentObservation["combat"]>;
    nonCombat?: Partial<AgentObservation["nonCombat"]>;
    endgame?: Partial<NonNullable<AgentObservation["endgame"]>>;
    targetPlayerId?: string;
    useAllLegalActions?: boolean;
  },
) {
  const base = baseObservation();
  return {
    name,
    expectedKind,
    objective,
    targetPlayerId: overrides.targetPlayerId,
    useAllLegalActions: overrides.useAllLegalActions,
    observation: {
      ...base,
      ownState:
        overrides.ownState === undefined || base.ownState === null
          ? base.ownState
          : { ...base.ownState, ...overrides.ownState },
      visiblePlayers: overrides.visiblePlayers ?? base.visiblePlayers,
      combat: { ...base.combat, ...overrides.combat },
      nonCombat: { ...base.nonCombat, ...overrides.nonCombat },
      endgame: { ...defaultEndgame(), ...base.endgame, ...overrides.endgame },
    },
  };
}

function baseObservation(): AgentObservation {
  const base = new AgentObservationBuilder().build({
    agentID: "frontier-targeted",
    clientID: null,
    username: "Frontier Targeted",
    profile: "opportunistic",
    gameID: "TARGET01",
    turnNumber: 40,
    phaseOverride: "active",
  });
  return {
    ...base,
    ownState: {
      playerID: "agent-player",
      clientID: "agent-client",
      smallID: 1,
      name: "Frontier",
      type: PlayerType.Human,
      isAlive: true,
      isDisconnected: false,
      isTraitor: false,
      hasSpawned: true,
      troops: 10_000,
      maxTroops: 18_000,
      troopRatio: 0.56,
      gold: "250000",
      tilesOwned: 320,
      tileShare: 0.22,
      borderTiles: 80,
      outgoingAttacks: 0,
      incomingAttacks: 0,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
      spawnTile: 12,
    },
    combat: {
      ownTroops: 10_000,
      maxTroops: 18_000,
      troopRatio: 0.56,
      borderedPlayerIDs: [],
      attackablePlayerIDs: [],
      canExpandIntoNeutral: false,
      neutralExpansionLegalReason: null,
      incomingAttackPlayerIDs: [],
      outgoingAttackPlayerIDs: [],
      outgoingAttacks: [],
      incomingAttacks: [],
      weakestAttackableTargetID: null,
      strongestAttackableTargetID: null,
      blockerNotes: [],
    },
    nonCombat: {
      buildOptions: [],
      upgradeOptions: [],
      deleteUnitOptions: [],
      boatOptions: [],
      boatRetreatOptions: [],
      warshipMoveOptions: [],
      allianceOptions: [],
      targetOptions: [],
      emojiOptions: [],
      quickChatOptions: [],
      supportOptions: [],
      embargoOptions: [],
      canEmbargoAll: false,
      blockerNotes: [],
    },
    endgame: defaultEndgame(),
  };
}

function defaultEndgame(): NonNullable<AgentObservation["endgame"]> {
  return {
    winner: null,
    leaderID: null,
    leaderName: null,
    leaderTileShare: 0.22,
    ownTileShare: 0.22,
    turnsToTimer: 9_000,
  };
}

function visiblePlayer(
  id: string,
  overrides: Partial<AgentVisiblePlayer> = {},
): AgentVisiblePlayer {
  return {
    playerID: id,
    clientID: `${id}-client`,
    smallID: 2,
    name: overrides.name ?? id,
    type: PlayerType.Nation,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 3_000,
    maxTroops: 8_000,
    troopRatio: 0.38,
    gold: "10000",
    tilesOwned: 80,
    tileShare: 0.08,
    sharesBorder: false,
    isAllied: false,
    isFriendly: false,
    relation: Relation.Neutral,
    canAttack: false,
    canRequestAlliance: false,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: false,
    canStopEmbargo: false,
    canTarget: false,
    canBreakAlliance: false,
    canExtendAlliance: false,
    canRejectAlliance: false,
    hasEmbargoAgainst: false,
    outgoingAttack: false,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    ...overrides,
  };
}

async function advanceUntil(input: {
  game: GameServer;
  mirror: AgentLocalGameMirror;
  messages: () => ServerMessage[];
  turnsPerStep: number;
  maxAdvanceTurns: number;
  until: (game: Game) => boolean;
}): Promise<Game> {
  let advancedTurns = 0;
  while (advancedTurns <= input.maxAdvanceTurns) {
    await input.mirror.ingest(input.messages());
    const state = input.mirror.gameState();
    if (state !== null && input.until(state)) {
      return state;
    }
    input.game.advanceTurnsForTesting(input.turnsPerStep);
    advancedTurns += input.turnsPerStep;
  }
  throw new Error(
    `frontier benchmark could not reach requested state after ${input.maxAdvanceTurns} turns`,
  );
}

function gameConfig(config: FrontierBenchmarkConfig): GameConfig {
  return {
    gameMap: config.map,
    gameMapSize: config.mapSize,
    gameMode: GameMode.FFA,
    gameType: GameType.Private,
    difficulty: config.difficulty,
    nations: config.nations,
    donateGold: false,
    donateTroops: false,
    bots: config.bots,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
    disabledUnits: [],
    maxPlayers: 1,
    maxTimerValue: 25,
  };
}

function serverConfig(): ServerConfig {
  return {
    turnIntervalMs: () => 60 * 60 * 1_000,
    env: () => GameEnv.Dev,
  } as ServerConfig;
}

function configFromArgs(args: string[]): FrontierBenchmarkConfig {
  const brainMode = stringArg(
    args,
    "--brain=",
    "llm-policy-planner",
  ) as FrontierBrainMode;
  if (!supportedBrainModes.includes(brainMode)) {
    throw new Error(`unsupported --brain=${brainMode}`);
  }
  const runtimeMode = normalizeRuntimeMode(brainMode);
  const fullMatch = booleanArg(args, "--full-match", false);
  const runs = positiveIntegerArg(args, "--runs=", fullMatch ? 10 : 5);
  const targetWins = positiveIntegerArg(
    args,
    "--require-wins=",
    positiveIntegerArg(
      args,
      "--target-wins=",
      fullMatch ? runs : Math.min(3, runs),
    ),
  );
  if (targetWins > runs) {
    throw new Error(
      `--require-wins=${targetWins} cannot exceed --runs=${runs}`,
    );
  }
  return {
    runID: stringArg(args, "--run-id=", defaultRunID(runtimeMode)),
    runs,
    startIndex: positiveIntegerArg(args, "--start-index=", 1),
    targetWins,
    nations: positiveIntegerArg(args, "--nations=", 3),
    bots: botsArg(args, 0),
    map: enumArg(args, "--map=", GameMapType, GameMapType.Pangaea),
    mapSize: enumArg(args, "--map-size=", GameMapSize, GameMapSize.Compact),
    difficulty: enumArg(args, "--difficulty=", Difficulty, Difficulty.Medium),
    turnsPerDecision: positiveIntegerArg(args, "--turns-per-decision=", 25),
    maxTurns: positiveIntegerArg(
      args,
      "--max-turns=",
      fullMatch ? 90_000 : 24_000,
    ),
    maxDecisionMs: positiveIntegerArg(args, "--max-decision-ms=", 120_000),
    planEveryDecisionSteps: positiveIntegerArg(
      args,
      "--plan-every-decision-steps=",
      3,
    ),
    frontierFinishPressure:
      !args.includes("--disable-frontier-finish-pressure") &&
      booleanArg(args, "--frontier-finish-pressure", true),
    navalControl:
      !args.includes("--disable-naval-control") &&
      booleanArg(args, "--naval-control", true),
    lateGameStrikeTargeting:
      !args.includes("--disable-late-game-strike-targeting") &&
      booleanArg(args, "--late-game-strike-targeting", true),
    personalityDiplomacyPressure:
      !args.includes("--disable-personality-diplomacy-pressure") &&
      booleanArg(args, "--personality-diplomacy-pressure", true),
    openingExpansionTempo:
      !args.includes("--disable-opening-expansion-tempo") &&
      booleanArg(args, "--opening-expansion-tempo", true),
    transportTroopBanking:
      !args.includes("--disable-transport-troop-banking") &&
      booleanArg(args, "--transport-troop-banking", true),
    humanReplayEconomyCadence:
      !args.includes("--disable-human-replay-economy-cadence") &&
      booleanArg(args, "--human-replay-economy-cadence", true),
    profileRepairReRank:
      !args.includes("--disable-profile-repair-rerank") &&
      booleanArg(args, "--profile-repair-rerank", true),
    writeReplay: args.includes("--write-replay"),
    fullMatch,
    brainMode,
    runtimeMode,
    profile: profileArg(args),
    forceSpawnTile: optionalPositiveIntegerArg(args, "--force-spawn-tile="),
    externalAgentEndpointUrl:
      stringArg(args, "--external-agent-endpoint-url=", "").trim() || null,
    externalAgentTimeoutMs: positiveIntegerArg(
      args,
      "--external-agent-timeout-ms=",
      positiveIntegerArg(args, "--max-decision-ms=", 120_000),
    ),
  };
}

const supportedBrainModes: readonly FrontierBrainMode[] = [
  "local-policy-baseline",
  "mock-policy-planner",
  "llm-policy-planner",
  "llm-action-selector",
  "rule-planner",
  "strategy",
  "planner",
  "planner-codex-cli",
  "planner-claude-cli",
  "action-claude-cli",
  "codex-cli",
  "external-http",
];

function normalizeRuntimeMode(brainMode: FrontierBrainMode): AgentRuntimeMode {
  switch (brainMode) {
    case "rule-planner":
      return "local-policy-baseline";
    case "strategy":
      return "local-policy-baseline";
    case "planner":
      return "mock-policy-planner";
    case "planner-codex-cli":
      return "llm-policy-planner";
    case "planner-claude-cli":
      return "llm-policy-planner";
    case "action-claude-cli":
      return "llm-action-selector";
    case "codex-cli":
      return "llm-action-selector";
    case "external-http":
      return "llm-action-selector";
    default:
      return brainMode;
  }
}

function profileArg(args: string[]): FrontierBenchmarkProfile {
  const value = stringArg(args, "--profile=", "aggressive");
  if (value === "all") {
    return "all";
  }
  if (agentStrategyProfiles.includes(value as AgentStrategyProfile)) {
    return value as AgentStrategyProfile;
  }
  throw new Error(
    `unsupported --profile=${value}; expected all, ${agentStrategyProfiles.join(", ")}`,
  );
}

function assertRequiredExternalBrainSucceeded(input: {
  brainMode: FrontierBrainMode;
  summary: FrontierRunSummary;
}): void {
  if (!requiresExternalBrainSuccess(input.brainMode)) {
    return;
  }

  const externalCalls =
    input.summary.externalPlannerCallCount +
    input.summary.externalActionCallCount;
  if (
    externalCalls > 0 &&
    input.summary.parseFailures === 0 &&
    input.summary.fallbacks === 0 &&
    input.summary.rejectedIntentCount === 0
  ) {
    return;
  }

  const firstFailure = input.summary.records.find(
    (record) =>
      record.decisionMetadata?.parseSuccess === false ||
      record.decisionMetadata?.plannerParseOk === false ||
      record.decisionMetadata?.fallbackUsed === true ||
      record.decisionMetadata?.plannerFallbackUsed === true ||
      !record.result.accepted,
  );
  const failureReason =
    firstFailure?.decisionMetadata?.plannerParseFailureReason ??
    firstFailure?.decisionMetadata?.parseFailureReason ??
    firstFailure?.decisionMetadata?.brainErrorReason ??
    firstFailure?.result.reason ??
    "external brain did not produce a clean accepted decision";

  throw new Error(
    [
      `Required ${input.brainMode} run was not clean, so this is not a real external-brain benchmark.`,
      `externalCalls=${externalCalls}`,
      `parseFailures=${input.summary.parseFailures}`,
      `fallbacks=${input.summary.fallbacks}`,
      `rejectedIntents=${input.summary.rejectedIntentCount}`,
      `firstFailure=${String(failureReason)}`,
    ].join(" "),
  );
}

function requiresExternalBrainSuccess(brainMode: FrontierBrainMode): boolean {
  if (brainMode === "external-http") {
    return true;
  }
  if (brainMode !== "codex-cli" && brainMode !== "planner-codex-cli") {
    return false;
  }
  return (
    process.env.AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS === "true" ||
    process.env.AI_LEAGUE_REQUIRE_CODEX_SUCCESS === "true"
  );
}

function frontierReport(input: {
  config: FrontierBenchmarkConfig;
  startedAt: number;
  completedAt: number;
  runSummaries: FrontierRunSummary[];
  targetedCoverage: Awaited<ReturnType<typeof runTargetedCoverageScenarios>>;
  cost: ReturnType<typeof estimateCost>;
  diagnosis: string;
}): string {
  const wins = input.runSummaries.filter((summary) => summary.won).length;
  const coverage = coverageMatrix(input.runSummaries, input.targetedCoverage);
  const durationMs = input.completedAt - input.startedAt;
  const passed = wins >= input.config.targetWins;
  return [
    `# Proxy War Agent-vs-Nation Benchmark Report`,
    "",
    `Benchmark id: \`${input.config.runID}\``,
    `Config: one Frontier agent vs ${input.config.nations} PlayerType.Nation opponent(s) and ${input.config.bots} built-in tribe/bot opponent(s), profile=${input.config.profile}, ${input.config.map} ${input.config.mapSize}, ${input.config.difficulty}, turnsPerDecision=${input.config.turnsPerDecision}, planEveryDecisionSteps=${input.config.planEveryDecisionSteps}, maxTurns=${input.config.maxTurns}, fullMatch=${input.config.fullMatch}, frontierFinishPressure=${input.config.frontierFinishPressure}, navalControl=${input.config.navalControl}, lateGameStrikeTargeting=${input.config.lateGameStrikeTargeting}, personalityDiplomacyPressure=${input.config.personalityDiplomacyPressure}, openingExpansionTempo=${input.config.openingExpansionTempo}, transportTroopBanking=${input.config.transportTroopBanking}, profileRepairReRank=${input.config.profileRepairReRank}.`,
    `Runtime mode: \`${input.config.runtimeMode}\` (requested \`--brain=${input.config.brainMode}\`).`,
    `Result: ${wins}/${input.config.runs} wins (target ${input.config.targetWins}/${input.config.runs}) in ${Math.round(durationMs / 1000)}s. PASS=${passed ? "yes" : "no"}.`,
    "",
    "## Runtime attribution",
    ...runtimeAttributionReport(input.runSummaries),
    "",
    "## Per-run summaries",
    ...input.runSummaries.map(
      (summary) =>
        `- Run ${summary.index}: ${summary.won ? "WIN" : "loss"}, profile=${summary.profile}, mode=${summary.runtimeMode}, survived=${summary.survived}, termination=${summary.termination}, winner=${summary.winner ?? "none"}, turns=${summary.turns}, tileShare=${percent(summary.tileShare)}, profileGate=${summary.profileDifferentiation.distinctEnough ? "distinct" : "review"}, profileStall=${summary.profileDifferentiation.stallRisk}, avgDecisionMs=${Math.round(summary.averageDecisionLatencyMs)}, externalPlannerCalls=${summary.externalPlannerCallCount}, externalActionCalls=${summary.externalActionCallCount}, fallbacks=${summary.fallbacks}, parseFailures=${summary.parseFailures}${summary.openFrontReplayUrl ? `, replay=${summary.openFrontReplayUrl}` : ""}.`,
    ),
    "",
    "## Profile differentiation metrics",
    ...profileDifferentiationBenchmarkReport(input.runSummaries),
    "",
    "## Combat conversion metrics",
    `- Neutral expansion attacks selected: ${sum(input.runSummaries.map((summary) => summary.neutralExpansionAttackCount))}`,
    `- Hostile attacks selected: ${sum(input.runSummaries.map((summary) => summary.hostileAttackCount))}`,
    `- Hostile attacks offered: ${sum(input.runSummaries.map((summary) => summary.offeredHostileAttackCount))}`,
    `- Pressure-only actions selected: ${sum(input.runSummaries.map((summary) => summary.pressureOnlyActionCount))}`,
    `- Pressure-only selected while hostile attacks were offered: ${sum(input.runSummaries.map((summary) => summary.pressureWithHostileAttackOfferedCount))}`,
    `- Pressure-only selected without logged hostile-attack blockers: ${sum(input.runSummaries.map((summary) => summary.pressureWithUnblockedHostileAttackCount))}`,
    `- Transport-wait holds: ${sum(input.runSummaries.map((summary) => summary.transportWaitHoldCount))}`,
    `- Attack-safety holds: ${sum(input.runSummaries.map((summary) => summary.attackSafetyHoldCount))}`,
    `- Support-cooldown holds: ${sum(input.runSummaries.map((summary) => summary.supportCooldownHoldCount))}`,
    `- Unexplained holds: ${sum(input.runSummaries.map((summary) => summary.unexplainedHoldCount))}`,
    `- Social/flavor actions selected: ${sum(input.runSummaries.map((summary) => summary.socialActionCount))}`,
    "",
    "## Policy decision examples",
    ...policyDecisionExamples(input.runSummaries),
    "",
    "## Action coverage matrix",
    "| Action kind | Offered in full games | Accepted selections | Targeted offered | Targeted selected | Audit confirmed | Audit unknown/failed |",
    "| --- | ---: | ---: | --- | --- | ---: | ---: |",
    ...coverage.map(
      (row) =>
        `| ${row.kind} | ${row.offered} | ${row.selected} | ${row.targetedOffered ? "yes" : "no"} | ${row.targetedSelected ? "yes" : "no"} | ${row.auditConfirmed} | ${row.auditOther} |`,
    ),
    "",
    "## Failure analysis",
    input.diagnosis,
    "",
    "## Skill revisions made",
    "- Created repo-tracked `skills/FrontierAgent/SKILL.md` and loaded it into both direct LLM decision prompts and slow planner prompts.",
    "- Replaced planner-executor default policy with `FrontierPolicyExecutor`, keeping Codex CLI as a slow planner that chooses objectives, enabled modules, and tactical settings while the executor schedules a compatible ordered batch of offered `LegalAction.id` values.",
    "- Added deterministic AgentSettings for reserves, attack triggers, expansion ratios, retreat thresholds, one-war discipline, and nation-inspired structure timing.",
    "",
    "## Cost accounting",
    `External planner calls: ${input.cost.externalPlannerCallCount}. External action calls: ${input.cost.externalActionCallCount}. Total external calls: ${input.cost.callCount}.`,
    `Estimated input tokens: ${input.cost.inputTokens}. Estimated output tokens: ${input.cost.outputTokens}. Estimated cost: $${input.cost.estimatedCostUsd.toFixed(4)}.`,
    `Pricing note: ${input.cost.note}`,
    "",
    "## Suggested next improvements",
    ...suggestedBenchmarkImprovements(input.runSummaries).map(
      (item) => `- ${item}`,
    ),
    "",
  ].join("\n");
}

function runtimeAttributionReport(runs: FrontierRunSummary[]): string[] {
  const externalPlannerCalls = sum(
    runs.map((run) => run.externalPlannerCallCount),
  );
  const externalActionCalls = sum(
    runs.map((run) => run.externalActionCallCount),
  );
  const rawProviderOutputs = sum(
    runs.map((run) => run.rawProviderOutputRecordCount),
  );
  const localExecutorActions = sum(
    runs.map((run) => run.localExecutorActionCount),
  );
  const llmActionSelections = sum(
    runs.map((run) => run.llmActionSelectionCount),
  );
  return [
    `- Runtime modes observed: ${JSON.stringify(mergeRunCounts(runs, "runtimeMode"))}`,
    `- Planner sources: ${JSON.stringify(mergeNestedCounts(runs, "plannerSources"))}`,
    `- Executor sources: ${JSON.stringify(mergeNestedCounts(runs, "executorSources"))}`,
    `- Action selection sources: ${JSON.stringify(mergeNestedCounts(runs, "actionSelectionSources"))}`,
    `- External planner calls: ${externalPlannerCalls}`,
    `- External action calls: ${externalActionCalls}`,
    `- Raw provider output records: ${rawProviderOutputs}`,
    `- Local executor actions: ${localExecutorActions}`,
    `- LLM direct action selections: ${llmActionSelections}`,
  ];
}

function profileDifferentiationBenchmarkReport(
  runs: FrontierRunSummary[],
): string[] {
  if (runs.length === 0) {
    return ["- No runs were available for profile differentiation analysis."];
  }
  const evaluatedRuns = runs.filter(
    (run) => run.profileDifferentiation.evaluatedProfileCount > 0,
  );
  const distinctRuns = runs.filter(
    (run) => run.profileDifferentiation.distinctEnough,
  );
  const highStallRuns = runs.filter(
    (run) => run.profileDifferentiation.stallRisk === "high",
  );
  const mediumOrHighStallRuns = runs.filter(
    (run) => run.profileDifferentiation.stallRisk !== "low",
  );
  const distances = runs
    .map((run) => run.profileDifferentiation.averagePairwiseDistance)
    .filter((value): value is number => typeof value === "number");
  const profileRows = runs.flatMap((run) =>
    run.profileDifferentiation.profiles.map((profile) => ({
      run: run.index,
      profile: profile.profile,
      signature: profile.signatureLabel,
      score: profile.signatureScore,
      nonHoldRate: profile.nonHoldRate,
      holdRate: profile.holdRate,
      topActions: profile.topActionKinds.join(", ") || "none",
    })),
  );
  return [
    `- Runs with profile data: ${evaluatedRuns.length}/${runs.length}`,
    `- Distinct-profile runs: ${distinctRuns.length}/${runs.length}`,
    `- Average pairwise action-mix distance: ${distances.length === 0 ? "n/a" : String(round(average(distances)))}`,
    `- Medium/high profile stall-risk runs: ${mediumOrHighStallRuns.length}/${runs.length}`,
    `- High profile stall-risk runs: ${highStallRuns.length}/${runs.length}`,
    "",
    profileRows.length === 0
      ? "No per-profile signatures were recorded."
      : markdownTable(
          ["Run", "Profile", "Signature", "Score", "Non-hold", "Hold", "Top Actions"],
          profileRows.slice(0, 16).map((row) => [
            String(row.run),
            row.profile,
            row.signature,
            `${row.score}/100`,
            percent(row.nonHoldRate),
            percent(row.holdRate),
            row.topActions,
          ]),
        ),
  ];
}

function mergeRunCounts(
  runs: FrontierRunSummary[],
  key: "runtimeMode",
): Record<string, number> {
  return runs.reduce<Record<string, number>>((counts, run) => {
    counts[run[key]] = (counts[run[key]] ?? 0) + 1;
    return counts;
  }, {});
}

function mergeNestedCounts(
  runs: FrontierRunSummary[],
  key: "plannerSources" | "executorSources" | "actionSelectionSources",
): Record<string, number> {
  return runs.reduce<Record<string, number>>((counts, run) => {
    for (const [name, count] of Object.entries(run[key])) {
      counts[name] = (counts[name] ?? 0) + count;
    }
    return counts;
  }, {});
}

function policyDecisionExamples(runs: FrontierRunSummary[]): string[] {
  const records = runs
    .flatMap((run) => run.records.map((record) => ({ run: run.index, record })))
    .filter(({ record }) => {
      const metadata = record.decisionMetadata ?? {};
      return (
        metadata.plannerRan === true ||
        stringMetadata(metadata, "planObjective") !== "" ||
        stringMetadata(metadata, "actionSelectionSource") ===
          "llm-action-selector"
      );
    })
    .slice(0, 8);

  if (records.length === 0) {
    return ["No policy or direct LLM action decisions were recorded."];
  }

  return records.map(({ run, record }) => {
    const metadata = record.decisionMetadata ?? {};
    const mode = stringMetadata(metadata, "runtimeMode") || "unknown";
    const plannerSource =
      stringMetadata(metadata, "plannerSource") ||
      stringMetadata(metadata, "planPlannerSource") ||
      "unknown";
    const executorSource =
      stringMetadata(metadata, "executorSource") || "unknown";
    const selectionSource =
      stringMetadata(metadata, "actionSelectionSource") || "unknown";
    const objective = stringMetadata(metadata, "planObjective") || "none";
    const preferred =
      stringMetadata(metadata, "activePolicyPreferredActionKinds") ||
      stringMetadata(metadata, "planPreferredActionKinds") ||
      "none";
    const modules =
      stringMetadata(metadata, "activePolicyEnabledModules") ||
      stringMetadata(metadata, "planEnabledModules") ||
      "none";
    const refreshed =
      metadata.plannerRan === true
        ? `refreshed=${stringMetadata(metadata, "plannerRefreshReason") || "unknown"}`
        : "reused";
    const followed =
      metadata.actionFollowedActivePolicy ?? metadata.planFollowed ?? "unknown";
    return `- Run ${run} turn ${record.turnNumber}: mode=${mode}, planner=${plannerSource}, executor=${executorSource}, selector=${selectionSource}, objective=${objective}, preferred=${preferred}, modules=${modules}, action=${record.chosenActionKind}/${record.chosenActionID}, followed=${followed}, ${refreshed}.`;
  });
}

function coverageMatrix(
  runs: FrontierRunSummary[],
  targeted: Awaited<ReturnType<typeof runTargetedCoverageScenarios>>,
) {
  return autonomousActionKinds.map((kind) => {
    const offered = sum(runs.map((run) => run.offeredActionCounts[kind] ?? 0));
    const selected = sum(runs.map((run) => run.actionCounts[kind] ?? 0));
    const auditConfirmed = sum(
      runs.map(
        (run) =>
          run.records.filter(
            (record) =>
              record.chosenActionKind === kind &&
              record.audit?.auditStatus === "confirmed",
          ).length,
      ),
    );
    const auditOther = sum(
      runs.map(
        (run) =>
          run.records.filter(
            (record) =>
              record.chosenActionKind === kind &&
              record.audit !== undefined &&
              record.audit.auditStatus !== "confirmed" &&
              record.audit.auditStatus !== "not_applicable",
          ).length,
      ),
    );
    const targetedRows = targeted.filter((row) => row.expectedKind === kind);
    return {
      kind,
      offered,
      selected,
      targetedOffered: targetedRows.some((row) => row.offered),
      targetedSelected: targetedRows.some((row) => row.selectedExpected),
      auditConfirmed,
      auditOther,
    };
  });
}

function failureAnalysis(runs: FrontierRunSummary[]): string {
  const losses = runs.filter((summary) => !summary.won);
  if (losses.length === 0) {
    return `No losses in this ${runs.length}-run sample. Residual risk remains until broader map and difficulty suites pass.`;
  }
  const reasons = losses.map(
    (summary) =>
      `run ${summary.index} ended by ${summary.termination} with tileShare=${percent(summary.tileShare)} and winner=${summary.winner ?? "none"}`,
  );
  return reasons.map((reason) => `- ${reason}`).join("\n");
}

function performanceDiagnosis(
  runs: FrontierRunSummary[],
  config: FrontierBenchmarkConfig,
): string {
  const wins = runs.filter((summary) => summary.won).length;
  const losses = runs.filter((summary) => !summary.won);
  const records = runs.flatMap((run) => run.records);
  const actionTotals = mergeActionCounts(runs.map((run) => run.actionCounts));
  const offeredTotals = mergeActionCounts(
    runs.map((run) => run.offeredActionCounts),
  );
  const accepted = sum(runs.map((run) => run.acceptedIntentCount));
  const rejected = sum(runs.map((run) => run.rejectedIntentCount));
  const nonHold = sum(
    Object.entries(actionTotals)
      .filter(([kind]) => kind !== "hold")
      .map(([, count]) => count),
  );
  const decisions = records.length;
  const repeatedKinds = repeatedActionDiagnosis(records);
  const avgTileShare = average(runs.map((run) => run.tileShare));
  const maxTileShare = Math.max(0, ...runs.map((run) => run.tileShare));
  const maxTurnsLosses = losses.filter(
    (summary) => summary.termination === "max_turns",
  ).length;
  const eliminatedLosses = losses.filter(
    (summary) => summary.termination === "agent_eliminated",
  ).length;
  const rejectedRate = decisions === 0 ? 0 : rejected / decisions;
  const holdRate =
    decisions === 0 ? 0 : (actionTotals.hold ?? 0) / Math.max(decisions, 1);
  const hostileAttackCount = sum(runs.map((run) => run.hostileAttackCount));
  const offeredHostileAttackCount = sum(
    runs.map((run) => run.offeredHostileAttackCount),
  );
  const neutralExpansionAttackCount = sum(
    runs.map((run) => run.neutralExpansionAttackCount),
  );
  const pressureOnlyCount = sum(runs.map((run) => run.pressureOnlyActionCount));
  const pressureWithHostileAttackOfferedCount = sum(
    runs.map((run) => run.pressureWithHostileAttackOfferedCount),
  );
  const pressureWithUnblockedHostileAttackCount = sum(
    runs.map((run) => run.pressureWithUnblockedHostileAttackCount),
  );
  const socialActionCount = sum(runs.map((run) => run.socialActionCount));
  const holdCount = actionTotals.hold ?? 0;
  const transportWaitHoldCount = sum(
    runs.map((run) => run.transportWaitHoldCount),
  );
  const attackSafetyHoldCount = sum(
    runs.map((run) => run.attackSafetyHoldCount),
  );
  const supportCooldownHoldCount = sum(
    runs.map((run) => run.supportCooldownHoldCount),
  );
  const unexplainedHoldCount = sum(runs.map((run) => run.unexplainedHoldCount));
  const buildCount = actionTotals.build ?? 0;
  const retreatCount = actionTotals.retreat ?? 0;
  const lines = [
    "# Proxy War Full-Match Performance Diagnosis",
    "",
    `Benchmark id: \`${config.runID}\``,
    `Gate: ${wins}/${config.runs} wins, require ${config.targetWins}/${config.runs}.`,
    `Opposition: ${config.nations} built-in nation(s), ${config.bots} tribe/bot opponent(s), map=${config.map}, mapSize=${config.mapSize}, difficulty=${config.difficulty}.`,
    "",
    "## Outcome",
    `- PASS gate satisfied: ${wins >= config.targetWins ? "yes" : "no"}`,
    `- Losses/non-wins: ${losses.length}`,
    `- Max-turn unresolved losses: ${maxTurnsLosses}`,
    `- Eliminations: ${eliminatedLosses}`,
    `- Average final tile share: ${percent(avgTileShare)}`,
    `- Best final tile share: ${percent(maxTileShare)}`,
    "",
    "## Action health",
    `- Decisions: ${decisions}`,
    `- Accepted/rejected intents: ${accepted}/${rejected} (rejected rate ${percent(rejectedRate)})`,
    `- Non-hold actions: ${nonHold} (hold rate ${percent(holdRate)})`,
    `- Action counts: ${JSON.stringify(actionTotals)}`,
    `- Offered action counts: ${JSON.stringify(offeredTotals)}`,
    `- Neutral expansion vs hostile attacks: ${neutralExpansionAttackCount}/${hostileAttackCount}`,
    `- Offered hostile attacks: ${offeredHostileAttackCount}`,
    `- Pressure-only actions: ${pressureOnlyCount}`,
    `- Pressure-only actions while hostile attacks were offered: ${pressureWithHostileAttackOfferedCount}`,
    `- Pressure-only actions while no hostile attack blocker was logged: ${pressureWithUnblockedHostileAttackCount}`,
    `- Social/flavor actions: ${socialActionCount}`,
    `- Transport-wait holds: ${transportWaitHoldCount}`,
    `- Attack-safety holds: ${attackSafetyHoldCount}`,
    `- Support-cooldown holds: ${supportCooldownHoldCount}`,
    `- Unexplained holds: ${unexplainedHoldCount}`,
    `- Repeated action warning: ${repeatedKinds}`,
    "",
    "## Bottleneck diagnosis",
    ...benchmarkBottlenecks({
      losses,
      avgTileShare,
      maxTileShare,
      neutralExpansionAttackCount,
      hostileAttackCount,
      offeredHostileAttackCount,
      pressureOnlyCount,
      pressureWithHostileAttackOfferedCount,
      pressureWithUnblockedHostileAttackCount,
      socialActionCount,
      buildCount,
      retreatCount,
      rejectedRate,
      holdRate,
      holdCount,
      transportWaitHoldCount,
      attackSafetyHoldCount,
      supportCooldownHoldCount,
      unexplainedHoldCount,
      actionTotals,
      offeredTotals,
    }).map((item) => `- ${item}`),
    "",
    "## Per-run failure notes",
    failureAnalysis(runs),
    "",
  ];
  return lines.join("\n");
}

function suggestedBenchmarkImprovements(runs: FrontierRunSummary[]): string[] {
  const records = runs.flatMap((run) => run.records);
  const actionTotals = mergeActionCounts(runs.map((run) => run.actionCounts));
  const offeredTotals = mergeActionCounts(
    runs.map((run) => run.offeredActionCounts),
  );
  const pressureOnly =
    (actionTotals.embargo_all ?? 0) +
    (actionTotals.embargo ?? 0) +
    (actionTotals.target_player ?? 0);
  const transportWaitHolds = records.filter(isTransportWaitHoldRecord).length;
  const attackSafetyHolds = records.filter(isAttackSafetyHoldRecord).length;
  const supportCooldownHolds = records.filter(
    isSupportCooldownHoldRecord,
  ).length;
  const unexplainedHolds = Math.max(
    0,
    (actionTotals.hold ?? 0) -
      transportWaitHolds -
      attackSafetyHolds -
      supportCooldownHolds,
  );
  const attack = actionTotals.attack ?? 0;
  const build = actionTotals.build ?? 0;
  const suggestions: string[] = [];
  if (pressureOnly > attack && (offeredTotals.attack ?? 0) > 0) {
    suggestions.push(
      "Pressure actions outnumber direct attacks even when attacks are offered; raise favorable-attack priority and penalize repeated embargo/target loops.",
    );
  }
  if (
    build < Math.ceil(records.length / 40) &&
    (offeredTotals.build ?? 0) > 0
  ) {
    suggestions.push(
      "Build actions are rare despite being offered; improve economy timing for City/Factory and frontline timing for Defense Post.",
    );
  }
  if ((actionTotals.retreat ?? 0) > attack / 2) {
    suggestions.push(
      "Retreats are frequent relative to attacks; tighten attack risk filters and reserve thresholds.",
    );
  }
  if (transportWaitHolds > 0) {
    suggestions.push(
      "Transport-wait holds are present; make the spectator overlay label boat-crossing phases and skip quickly to landfall when possible.",
    );
  }
  if (attackSafetyHolds > 0) {
    suggestions.push(
      "Attack-safety holds are present; expose blocker summaries in replay and tune attack thresholds only when visual review shows missed favorable attacks.",
    );
  }
  if (supportCooldownHolds > 0) {
    suggestions.push(
      "Support-cooldown holds are present; expose them as deliberate avoidance of low-value diplomacy/support busy-work.",
    );
  }
  if (unexplainedHolds > Math.max(4, records.length / 8)) {
    suggestions.push(
      "Unexplained holds are high; inspect whether useful LegalActions are missing or scheduler penalties are over-blocking.",
    );
  }
  if (suggestions.length === 0) {
    suggestions.push(
      "Inspect visual replays for target selection and endgame conversion, then tune planner/executor thresholds against the largest remaining non-win pattern.",
    );
  }
  suggestions.push(
    "Keep behavior changes in AgentObservationBuilder, LegalActionBuilder, AgentPlannerExecutor, AgentStrategicStateBuilder, AgentMemoryBuilder, and StrategicSkillEvaluator only.",
  );
  return suggestions;
}

function benchmarkBottlenecks(input: {
  losses: FrontierRunSummary[];
  avgTileShare: number;
  maxTileShare: number;
  neutralExpansionAttackCount: number;
  hostileAttackCount: number;
  offeredHostileAttackCount: number;
  pressureOnlyCount: number;
  pressureWithHostileAttackOfferedCount: number;
  pressureWithUnblockedHostileAttackCount: number;
  socialActionCount: number;
  buildCount: number;
  retreatCount: number;
  rejectedRate: number;
  holdRate: number;
  holdCount: number;
  transportWaitHoldCount: number;
  attackSafetyHoldCount: number;
  supportCooldownHoldCount: number;
  unexplainedHoldCount: number;
  actionTotals: Partial<Record<LegalActionKind, number>>;
  offeredTotals: Partial<Record<LegalActionKind, number>>;
}): string[] {
  const notes: string[] = [];
  if (input.losses.length === 0) {
    notes.push("No losses in this run set; broaden map/opponent suite next.");
  }
  if (input.maxTileShare >= 0.45 && input.losses.length > 0) {
    notes.push(
      "Agent often reaches a large tile share but does not convert before the benchmark ends; endgame pressure and finish logic need attention.",
    );
  }
  if (input.avgTileShare < 0.2 && input.losses.length > 0) {
    notes.push(
      "Average tile share is low; opening expansion or spawn selection is likely too weak.",
    );
  }
  if (input.pressureOnlyCount > input.hostileAttackCount) {
    notes.push(
      "Embargo/target pressure exceeds hostile attacks; agents may be substituting pressure signals for territory-taking.",
    );
  }
  if (
    input.pressureWithHostileAttackOfferedCount >
      input.hostileAttackCount * 0.5 &&
    input.pressureWithUnblockedHostileAttackCount >
      Math.max(2, input.pressureOnlyCount * 0.1)
  ) {
    notes.push(
      "Pressure-only actions are still selected even when hostile attacks have no logged blocker; direct attack priority likely needs tuning.",
    );
  }
  if (
    input.pressureWithUnblockedHostileAttackCount >
    Math.max(2, input.pressureOnlyCount * 0.1)
  ) {
    notes.push(
      "Some pressure-only actions were selected without any logged hostile-attack blocker; direct attack priority likely needs tuning.",
    );
  } else if (input.pressureWithHostileAttackOfferedCount > 0) {
    notes.push(
      "Pressure-only actions coincided with offered attacks, but selected turns logged hostile-attack blockers; improve attack safety thresholds before raising aggression.",
    );
  }
  if (
    input.maxTileShare >= 0.42 &&
    input.offeredHostileAttackCount > input.hostileAttackCount * 3
  ) {
    notes.push(
      input.pressureWithUnblockedHostileAttackCount >
        Math.max(2, input.pressureOnlyCount * 0.1)
        ? "Hostile attacks were offered far more often than selected after a large map lead; direct conversion priority is likely too low."
        : "Hostile attacks were offered far more often than selected, but selected pressure turns usually logged attack blockers; tune safety thresholds before simply raising aggression.",
    );
  }
  if (
    input.maxTileShare >= 0.42 &&
    input.neutralExpansionAttackCount > input.hostileAttackCount * 4
  ) {
    notes.push(
      "Neutral expansion dominated the action mix before conversion; agents may be delaying rival pressure too long.",
    );
  }
  if (
    input.socialActionCount > input.hostileAttackCount &&
    input.offeredHostileAttackCount > 0
  ) {
    notes.push(
      "Social/flavor actions outnumber hostile attacks while attacks are available; spectator flavor should not crowd out conquest.",
    );
  }
  if (input.buildCount === 0 && (input.offeredTotals.build ?? 0) > 0) {
    notes.push(
      "Build actions were offered but never selected; economy/defense scoring is too low or repetition penalties are too harsh.",
    );
  }
  if (input.retreatCount > input.hostileAttackCount / 2) {
    notes.push(
      "Retreat volume is high; attacks may be under-reserved, poorly targeted, or too scattered.",
    );
  }
  if (input.rejectedRate > 0) {
    notes.push(
      "Some intents were rejected; inspect validator/submission mismatch before treating strategy results as reliable.",
    );
  }
  if (
    input.holdRate > 0.2 &&
    input.transportWaitHoldCount +
      input.attackSafetyHoldCount +
      input.supportCooldownHoldCount >=
      Math.max(2, input.holdCount * 0.5)
  ) {
    notes.push(
      "Hold rate is high, but most holds are explained waits: transport crossing, attack-safety conservation, or support-cooldown turns.",
    );
  } else if (input.holdRate > 0.2) {
    notes.push(
      "Hold rate is high for a competitive benchmark; LegalActionBuilder may not expose useful actions often enough.",
    );
  }
  if (input.attackSafetyHoldCount > Math.max(4, input.holdCount * 0.25)) {
    notes.push(
      "Many holds are attack-safety waits; inspect blocker summaries before loosening reserve or trigger thresholds.",
    );
  }
  if (input.supportCooldownHoldCount > Math.max(4, input.holdCount * 0.25)) {
    notes.push(
      "Many holds occur when only support/diplomacy cleanup is legal; this is safer than busy-work but still needs better endgame conversion options.",
    );
  }
  if (input.unexplainedHoldCount > Math.max(6, input.holdCount * 0.4)) {
    notes.push(
      "Many holds are not explained by transport-wait context; inspect missing legal actions or overly strict policy penalties.",
    );
  }
  if (notes.length === 0) {
    notes.push(
      "No obvious aggregate bottleneck; inspect per-run replay and decision records for target choice, timing, and map-specific failures.",
    );
  }
  return notes;
}

function repeatedActionDiagnosis(records: AgentDecisionRecord[]): string {
  if (records.length < 3) {
    return "not enough decisions";
  }
  let longestKind = records[0]?.chosenActionKind ?? "hold";
  let longest = 1;
  let currentKind = records[0]?.chosenActionKind ?? "hold";
  let current = 1;
  for (const record of records.slice(1)) {
    if (record.chosenActionKind === currentKind) {
      current += 1;
    } else {
      currentKind = record.chosenActionKind;
      current = 1;
    }
    if (current > longest) {
      longest = current;
      longestKind = currentKind;
    }
  }
  return `longest consecutive streak ${longest} of ${longestKind}`;
}

function mergeActionCounts(
  counts: Array<Partial<Record<LegalActionKind, number>>>,
): Partial<Record<LegalActionKind, number>> {
  return counts.reduce<Partial<Record<LegalActionKind, number>>>(
    (merged, entry) => {
      for (const [kind, count] of Object.entries(entry)) {
        const legalKind = kind as LegalActionKind;
        merged[legalKind] = (merged[legalKind] ?? 0) + count;
      }
      return merged;
    },
    {},
  );
}

function estimateCost(runs: FrontierRunSummary[]) {
  const records = runs.flatMap((run) => run.records);
  const plannerRecords = records.filter(
    (record) =>
      record.decisionMetadata?.externalPlannerCall === true ||
      (record.decisionMetadata?.plannerRan === true &&
        record.decisionMetadata?.planPlannerSource === "codex-cli"),
  );
  const actionRecords = records.filter(
    (record) => record.decisionMetadata?.externalActionCall === true,
  );
  const externalRecords = [...plannerRecords, ...actionRecords];
  if (plannerRecords.length === 0) {
    if (actionRecords.length === 0) {
      return {
        model:
          process.env.AI_LEAGUE_CODEX_MODEL ??
          process.env.AI_LEAGUE_LLM_MODEL ??
          "gpt-5.5",
        callCount: 0,
        externalPlannerCallCount: 0,
        externalActionCallCount: 0,
        rawProviderOutputRecordCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        note: "No external planner or action-selector calls were made; cost is zero for local-only and mock-only modes.",
      };
    }
  }
  if (externalRecords.length === 0) {
    return {
      model:
        process.env.AI_LEAGUE_CODEX_MODEL ??
        process.env.AI_LEAGUE_LLM_MODEL ??
        "gpt-5.5",
      callCount: 0,
      externalPlannerCallCount: 0,
      externalActionCallCount: 0,
      rawProviderOutputRecordCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      note: "No external provider calls were detected.",
    };
  }
  const inputChars = sum(
    externalRecords.map((record) => {
      const metadata = record.decisionMetadata ?? {};
      return (
        numberMetadata(metadata, "plannerPromptLength") ||
        numberMetadata(metadata, "promptLength") ||
        numberMetadata(metadata, "llmPromptLength") ||
        0
      );
    }),
  );
  const outputChars = sum(
    externalRecords.map((record) => {
      const metadata = record.decisionMetadata ?? {};
      return (
        stringMetadata(metadata, "plannerRawOutput").length +
        stringMetadata(metadata, "llmRawOutput").length
      );
    }),
  );
  const estimatedInputChars =
    inputChars > 0
      ? inputChars
      : plannerRecords.length * 18_000 + actionRecords.length * 16_000;
  const estimatedOutputChars =
    outputChars > 0
      ? outputChars
      : plannerRecords.length * 450 + actionRecords.length * 350;
  const inputTokens = Math.ceil(estimatedInputChars / 4);
  const outputTokens = Math.ceil(estimatedOutputChars / 4);
  const model =
    process.env.AI_LEAGUE_CODEX_MODEL ??
    process.env.AI_LEAGUE_LLM_MODEL ??
    "gpt-5.5";
  const pricing = pricingForModel(model);
  return {
    model,
    callCount: plannerRecords.length + actionRecords.length,
    externalPlannerCallCount: plannerRecords.length,
    externalActionCallCount: actionRecords.length,
    rawProviderOutputRecordCount: externalRecords.filter(
      (record) =>
        record.decisionMetadata?.rawProviderOutputPresent === true ||
        stringMetadata(record.decisionMetadata ?? {}, "plannerRawOutput") !==
          "" ||
        stringMetadata(record.decisionMetadata ?? {}, "llmRawOutput") !== "",
    ).length,
    inputTokens,
    outputTokens,
    estimatedCostUsd:
      (inputTokens / 1_000_000) * pricing.inputPerMTok +
      (outputTokens / 1_000_000) * pricing.outputPerMTok,
    note: `Provider usage was not exposed directly; token counts are estimated from prompt/output characters using ${model} pricing ${pricing.inputPerMTok}/${pricing.outputPerMTok} USD per million input/output tokens. Local-only and mock-only decisions are excluded.`,
  };
}

function pricingForModel(model: string) {
  const table: Record<string, { inputPerMTok: number; outputPerMTok: number }> =
    {
      "gpt-5.2": { inputPerMTok: 1.25, outputPerMTok: 10 },
      "gpt-5.3-codex": { inputPerMTok: 1.25, outputPerMTok: 10 },
      "gpt-5.4": { inputPerMTok: 3, outputPerMTok: 15 },
      "gpt-5.5": { inputPerMTok: 5, outputPerMTok: 25 },
    };
  return table[model] ?? table["gpt-5.2"];
}

function actionCounts(records: AgentDecisionRecord[]) {
  return records.reduce<Partial<Record<LegalActionKind, number>>>(
    (counts, record) => {
      counts[record.chosenActionKind] =
        (counts[record.chosenActionKind] ?? 0) + 1;
      return counts;
    },
    {},
  );
}

function benchmarkBehaviorCounts(records: AgentDecisionRecord[]) {
  return records.reduce(
    (counts, record) => {
      if (record.chosenActionKind === "attack") {
        if (recordIsNeutralExpansion(record)) {
          counts.neutralExpansionAttackCount += 1;
        } else {
          counts.hostileAttackCount += 1;
        }
      }
      if (
        record.chosenActionKind === "embargo" ||
        record.chosenActionKind === "embargo_all" ||
        record.chosenActionKind === "target_player"
      ) {
        counts.pressureOnlyActionCount += 1;
        if (record.legalActionIDs.some((id) => id.startsWith("attack:"))) {
          counts.pressureWithHostileAttackOfferedCount += 1;
          if (
            stringMetadata(
              record.decisionMetadata ?? {},
              "blockedHostileAttackSummary",
            ) === ""
          ) {
            counts.pressureWithUnblockedHostileAttackCount += 1;
          }
        }
      }
      if (isTransportWaitHoldRecord(record)) {
        counts.transportWaitHoldCount += 1;
      } else if (isAttackSafetyHoldRecord(record)) {
        counts.attackSafetyHoldCount += 1;
      } else if (isSupportCooldownHoldRecord(record)) {
        counts.supportCooldownHoldCount += 1;
      } else if (record.chosenActionKind === "hold") {
        counts.unexplainedHoldCount += 1;
      }
      if (
        record.chosenActionKind === "quick_chat" ||
        record.chosenActionKind === "emoji"
      ) {
        counts.socialActionCount += 1;
      }
      for (const actionID of record.legalActionIDs) {
        if (actionID.startsWith("expand:")) {
          counts.offeredNeutralExpansionCount += 1;
        } else if (actionID.startsWith("attack:")) {
          counts.offeredHostileAttackCount += 1;
        }
      }
      return counts;
    },
    {
      neutralExpansionAttackCount: 0,
      hostileAttackCount: 0,
      offeredNeutralExpansionCount: 0,
      offeredHostileAttackCount: 0,
      pressureOnlyActionCount: 0,
      pressureWithHostileAttackOfferedCount: 0,
      pressureWithUnblockedHostileAttackCount: 0,
      socialActionCount: 0,
      transportWaitHoldCount: 0,
      attackSafetyHoldCount: 0,
      supportCooldownHoldCount: 0,
      unexplainedHoldCount: 0,
    },
  );
}

function isTransportWaitHoldRecord(record: AgentDecisionRecord): boolean {
  if (record.chosenActionKind !== "hold") {
    return false;
  }
  const text = `${record.reason} ${record.observationSummary}`;
  return (
    /waiting for active transport|transport to land|active transport/i.test(
      text,
    ) ||
    (/attackable=0/.test(text) && /boats=[1-9]/.test(text))
  );
}

function isAttackSafetyHoldRecord(record: AgentDecisionRecord): boolean {
  return (
    record.chosenActionKind === "hold" &&
    typeof record.decisionMetadata?.blockedHostileAttackSummary === "string" &&
    record.decisionMetadata.blockedHostileAttackSummary.length > 0
  );
}

function isSupportCooldownHoldRecord(record: AgentDecisionRecord): boolean {
  if (
    record.chosenActionKind !== "hold" ||
    isTransportWaitHoldRecord(record) ||
    isAttackSafetyHoldRecord(record)
  ) {
    return false;
  }
  if (
    hasOfferedKind(record, [
      "attack",
      "boat",
      "build",
      "upgrade_structure",
      "retreat",
      "boat_retreat",
      "warship",
      "move_warship",
      "nuke",
      "embargo",
      "embargo_all",
      "target_player",
      "alliance_request",
    ])
  ) {
    return false;
  }
  return hasOfferedKind(record, [
    "donate_gold",
    "donate_troops",
    "alliance_extend",
    "break_alliance",
    "embargo_stop",
    "delete_unit",
    "quick_chat",
    "emoji",
  ]);
}

function hasOfferedKind(
  record: AgentDecisionRecord,
  kinds: readonly LegalActionKind[],
): boolean {
  return kinds.some(
    (kind) => (record.legalActionIDsByKind[kind]?.length ?? 0) > 0,
  );
}

function recordIsNeutralExpansion(record: AgentDecisionRecord): boolean {
  return (
    record.chosenActionID.startsWith("expand:") ||
    record.chosenActionMetadata?.expansion === true
  );
}

function offeredActionCounts(records: AgentDecisionRecord[]) {
  return records.reduce<Partial<Record<LegalActionKind, number>>>(
    (counts, record) => {
      for (const [kind, ids] of Object.entries(record.legalActionIDsByKind)) {
        const legalKind = kind as LegalActionKind;
        counts[legalKind] = (counts[legalKind] ?? 0) + ids.length;
      }
      return counts;
    },
    {},
  );
}

function auditCounts(records: AgentDecisionRecord[]) {
  return records.reduce<Record<string, number>>((counts, record) => {
    const status = record.audit?.auditStatus ?? "missing";
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

function runtimeAttribution(
  records: AgentDecisionRecord[],
  fallbackRuntimeMode: AgentRuntimeMode,
) {
  const plannerSources = countMetadataValues(
    records,
    "plannerSource",
    "planPlannerSource",
  );
  const executorSources = countMetadataValues(records, "executorSource");
  const actionSelectionSources = countMetadataValues(
    records,
    "actionSelectionSource",
  );
  const externalPlannerCallCount = records.filter(
    (record) => record.decisionMetadata?.externalPlannerCall === true,
  ).length;
  const externalActionCallCount = records.filter(
    (record) => record.decisionMetadata?.externalActionCall === true,
  ).length;
  const rawProviderOutputRecordCount = records.filter(
    (record) => record.decisionMetadata?.rawProviderOutputPresent === true,
  ).length;
  return {
    runtimeMode:
      (firstMetadataValue(records, "runtimeMode") as AgentRuntimeMode | null) ??
      fallbackRuntimeMode,
    plannerSources,
    executorSources,
    actionSelectionSources,
    externalPlannerCallCount,
    externalActionCallCount,
    rawProviderOutputRecordCount,
    localExecutorActionCount:
      actionSelectionSources["local-policy-executor"] ?? 0,
    llmActionSelectionCount: actionSelectionSources["llm-action-selector"] ?? 0,
  };
}

function countMetadataValues(
  records: AgentDecisionRecord[],
  primaryKey: string,
  fallbackKey?: string,
): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    const metadata = record.decisionMetadata ?? {};
    const value =
      stringMetadata(metadata, primaryKey) ||
      (fallbackKey ? stringMetadata(metadata, fallbackKey) : "");
    const key = value || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function firstMetadataValue(
  records: AgentDecisionRecord[],
  key: string,
): string | null {
  for (const record of records) {
    const value = stringMetadata(record.decisionMetadata ?? {}, key);
    if (value !== "") {
      return value;
    }
  }
  return null;
}

function winnerName(winner: ReturnType<Game["getWinner"]>): string | null {
  if (winner === null) {
    return null;
  }
  return typeof winner === "string" ? winner : winner.name();
}

function holdAction(): LegalAction {
  return {
    id: "hold",
    kind: "hold",
    label: "Hold this turn",
    intent: null,
    risk: { level: "none", score: 0 },
  };
}

function defaultRunID(brainMode: FrontierBrainMode): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-frontier-${brainMode}-${randomUUID().slice(0, 8)}`;
}

function stringArg(
  args: string[],
  prefix: string,
  defaultValue: string,
): string {
  return lastArg(args, prefix)?.slice(prefix.length) ?? defaultValue;
}

function booleanArg(
  args: string[],
  flag: string,
  defaultValue: boolean,
): boolean {
  const match = lastBooleanArg(args, flag);
  if (match === flag) {
    return true;
  }
  const raw = match?.slice(flag.length + 1);
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`${flag}=${raw} must be true or false`);
}

function botsArg(args: string[], defaultValue: number): number {
  const botsArgValue = lastArgAny(args, ["--bots=", "--tribes="]);
  const botsRaw =
    botsArgValue?.startsWith("--bots=") === true
      ? botsArgValue.slice("--bots=".length)
      : botsArgValue?.slice("--tribes=".length);
  if (botsRaw === undefined || botsRaw === "") {
    return defaultValue;
  }
  if (botsRaw === "enabled") {
    return 5;
  }
  if (botsRaw === "disabled" || botsRaw === "false") {
    return 0;
  }
  const value = Number(botsRaw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `--bots=${botsRaw} must be a non-negative integer, enabled, or disabled`,
    );
  }
  return value;
}

function positiveIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
): number {
  const raw = lastArg(args, prefix)?.slice(prefix.length);
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix}${raw} must be a positive integer`);
  }
  return value;
}

function optionalPositiveIntegerArg(
  args: string[],
  prefix: string,
): number | null {
  const raw = lastArg(args, prefix)?.slice(prefix.length);
  if (raw === undefined || raw === "") {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix}${raw} must be a positive integer`);
  }
  return value;
}

function enumArg<T extends Record<string, string>>(
  args: string[],
  prefix: string,
  enumObj: T,
  defaultValue: T[keyof T],
): T[keyof T] {
  const raw = lastArg(args, prefix)?.slice(prefix.length);
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  if (raw in enumObj) {
    return enumObj[raw as keyof T];
  }
  const value = Object.values(enumObj).find((candidate) => candidate === raw);
  if (value !== undefined) {
    return value as T[keyof T];
  }
  throw new Error(`${prefix}${raw} is not supported`);
}

function lastArg(args: string[], prefix: string): string | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (arg?.startsWith(prefix) === true) {
      return arg;
    }
  }
  return undefined;
}

function lastArgAny(
  args: string[],
  prefixes: readonly string[],
): string | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (
      arg !== undefined &&
      prefixes.some((prefix) => arg.startsWith(prefix))
    ) {
      return arg;
    }
  }
  return undefined;
}

function lastBooleanArg(args: string[], flag: string): string | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (arg === flag || arg?.startsWith(`${flag}=`) === true) {
      return arg;
    }
  }
  return undefined;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeMarkdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`),
  ].join("\n");
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function numberMetadata(
  metadata: Record<string, string | number | boolean | null>,
  key: string,
): number {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringMetadata(
  metadata: Record<string, string | number | boolean | null>,
  key: string,
): string {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

class StaticMapLoader implements GameMapLoader {
  private readonly maps = new Map<GameMapType, MapData>();
  private readonly rootDir: string;

  constructor() {
    const currentFile = fileURLToPath(import.meta.url);
    this.rootDir = path.resolve(path.dirname(currentFile), "../../static/maps");
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
          .then((raw) => JSON.parse(raw) as MapManifest),
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
