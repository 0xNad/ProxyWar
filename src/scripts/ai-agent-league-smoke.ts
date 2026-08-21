import { createHash, randomUUID } from "crypto";
import fs from "fs";
import os from "os";
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
import { MapManifest, loadTerrainMap } from "../core/game/TerrainMapLoader";
import { GameConfig, ServerMessage, Winner } from "../core/Schemas";
import {
  auditDecisionEffects,
  captureDecisionAuditBaselines,
} from "../server/agents/AgentActionAuditor";
import {
  AgentRunFinalState,
  WriteAgentLeagueRunArtifactsInput,
  writeAgentLeagueRunArtifacts,
} from "../server/agents/AgentDecisionLogWriter";
import { writeAgentDemoIndex } from "../server/agents/AgentDemoIndexWriter";
import { deterministicAgentClientID } from "../server/agents/AgentDeterministicIdentity";
import { externalBrainCleanlinessReport } from "../server/agents/AgentExternalBrainCleanliness";
import type { SpawnCandidate } from "../server/agents/AgentLeagueMatch";
import {
  AgentLeagueMatchRunner,
  AgentSpec,
  buildAttackScenarioSpawnPlan,
  buildSpawnCandidates,
  createAgentParticipants,
  createDefaultAgentSpecs,
} from "../server/agents/AgentLeagueMatch";
import {
  AgentLocalGameMirror,
  waitForMirrorState,
} from "../server/agents/AgentLocalGameMirror";
import type { AgentManifest } from "../server/agents/AgentManifest";
import {
  agentManifestToSpec,
  loadAgentManifestsFromDirectory,
} from "../server/agents/AgentManifest";
import {
  FrontierPolicyExecutor,
  LlmAgentPlanner,
  MockLlmPlanner,
  PlannerExecutorAgentBrain,
} from "../server/agents/AgentPlannerExecutor";
import { buildAttachedAgentRunRoster } from "../server/agents/AgentRunRoster";
import {
  AgentSpectatorSnapshot,
  buildAgentSpectatorReplay,
  buildAgentSpectatorSnapshot,
  buildGameRecordFromServerMessages,
} from "../server/agents/AgentSpectatorReplay";
import {
  AgentStepLockedLeagueConfig,
  runAgentStepLockedLeague,
} from "../server/agents/AgentStepLockedLeague";
import {
  freeTextMessagesEnabled,
  structuredDealsEnabled,
} from "../server/agents/AgentTunables";
import type {
  AgentBrain,
  AgentBrainType,
  AgentDecisionRecord,
  LegalActionKind,
} from "../server/agents/AgentTypes";
import { MAX_SPAWN_PREFERENCE_ACTION_IDS } from "../server/agents/AgentWireProtocol";
import {
  ClaudeCliLlmProvider,
  createClaudeCliLlmProviderFromEnv,
  loadClaudeCliLlmProviderConfig,
} from "../server/agents/ClaudeCliLlmProvider";
import {
  CodexCliLlmProvider,
  loadCodexCliLlmProviderConfig,
} from "../server/agents/CodexCliLlmProvider";
import {
  normalizeCommanderGameConfig,
  type CommanderCanonicalGameConfig,
} from "../server/agents/CommanderExperimentIdentity";
import { resolveExternalAgentToken } from "../server/agents/ExternalAgentSecrets";
import { ExternalHttpAgentBrain } from "../server/agents/ExternalHttpAgentBrain";
import { ExternalRelayAgentBrain } from "../server/agents/ExternalRelayAgentBrain";
import { LlmAgentBrain } from "../server/agents/LlmAgentBrain";
import {
  COMMANDER_PROMPT_VERSION,
  LlmOptionSelector,
} from "../server/agents/LlmOptionSelector";
import { LlmProvider } from "../server/agents/LlmProvider";
import { MockLlmProvider } from "../server/agents/MockLlmProvider";
import {
  LlmProviderConfigError,
  OpenAiLlmProvider,
  loadOpenAiLlmProviderConfig,
} from "../server/agents/OpenAiLlmProvider";
import { createOpenRouterLlmProviderFromEnv } from "../server/agents/OpenRouterLlmProvider";
import type { PlayerStrategySpec } from "../server/agents/PlayerStrategySpec";
import { loadPlayerStrategySpecFromEnv } from "../server/agents/PlayerStrategySpec";
import { RuleAgentBrain } from "../server/agents/RuleAgentBrain";
import { StarterBotAgentBrain } from "../server/agents/StarterBotAgentBrain";
import { StrategicCommanderBrain } from "../server/agents/StrategicCommanderBrain";
import { StrategicCommanderCaller } from "../server/agents/StrategicCommanderCaller";
import { DeterministicOptionSelector } from "../server/agents/StrategicOptionSelectors";
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

export interface AgentLeagueSmokeArtifactWriterInput {
  artifactInput: WriteAgentLeagueRunArtifactsInput;
  winner: Winner;
  turnCount: number;
  playbackTurnIntervalMs: number;
  executionConfig: AgentLeagueSmokeExecutionConfig;
}

export type AgentLeagueSmokeArtifactWriter = (
  input: AgentLeagueSmokeArtifactWriterInput,
) => Promise<unknown>;

export interface AgentLeagueSmokeInjectedManifest {
  sourceName: string;
  rawManifestBase64: string;
  manifestSha256: string;
  contentSha256: string;
  manifest: Readonly<AgentManifest>;
}

export interface AgentLeagueSmokeExecutionConfig {
  schemaVersion: 1;
  scenario: "league" | "attack" | "actions";
  brainMode: string;
  runnerMode: "realtime" | "step-locked";
  /** Persisted by matched Commander runs; optional for legacy callers. */
  agents?: number;
  /** Persisted by matched Commander runs; optional for legacy callers. */
  opponentBrainMode?: string | null;
  /** Persisted by matched Commander runs; optional for legacy callers. */
  executionSeed?: string | null;
  /** Stage 5 matched subject seat; optional for legacy/default callers. */
  subjectSeatIndex?: number;
  /** Spawn-priority rotation ordinal actually passed to the league runner. */
  episodeIndex?: number;
  /** Exact normalized GameConfig; required by Stage 5 persisted comparisons. */
  selectedGameConfig?: CommanderCanonicalGameConfig;
  planEveryDecisionSteps: number;
  runner: {
    turnsPerDecisionStep: number;
    turnsPerDecisionSchedule: number[] | null;
    maxDecisionMs: number;
    maxSteps: number;
    maxSpawnAdvanceTurns: number;
    requireWinner: boolean;
    waitForMirrorCatchup: boolean;
    autopilotEndgameSteps: number;
    replayTailTurns: number;
    matchedOfferedOrderSpawnBallot?: boolean;
  };
  game: {
    bots: number;
    nations: number | string;
    map: string;
    mapSize: string;
    difficulty: string;
    varySpawns: boolean;
  };
  disabledActionKinds: LegalActionKind[];
}

export interface AgentLeagueSmokeRunOptions {
  args?: string[];
  artifactWriter?: AgentLeagueSmokeArtifactWriter;
  injectedManifests?: readonly AgentLeagueSmokeInjectedManifest[];
  manifestLimits?: {
    minAgents: number;
    maxAgents: number;
  };
  planEveryDecisionSteps?: number;
  allowEnvironmentStrategySpec?: boolean;
  /**
   * Bounded test seam for --brain=strategic-commander only: replaces the
   * OpenRouter Commander provider so verification needs no network credentials
   * or live model. Rejected with any other brain mode.
   */
  commanderProviderForTesting?: LlmProvider;
  /** Explicit provider for an offered-order matched real experiment. */
  commanderProviderForExperiment?: LlmProvider;
  /** Exact sealed provider used by Arm A's planner in a matched experiment. */
  claudeProviderForExperiment?: LlmProvider;
  /** Stage 5-only matched experiment seam; production/default runs never set it. */
  forceOfferedOrderSpawnBallotForExperiment?: boolean;
  /** Move the fixed subject identity from seat 0 to this matched seat. */
  subjectSeatIndexForExperiment?: number;
  /** Explicit sealed-spawn priority rotation ordinal. */
  episodeIndexForExperiment?: number;
  /** Artifact-only provenance stamped by the Stage 5 harness. */
  commanderExperimentProvenance?: {
    provider: string | null;
    model: string | null;
    promptVersion: string | null;
  };
  deterministicSource?: {
    seed: string;
    /** Optional deterministic GameServer id; identical matched arms share it. */
    gameID?: string;
    /** Versioned seed-to-game identity derivation used by matched experiments. */
    gameIDDerivation?: string;
    createdAtMs: number;
    playbackTurnIntervalMs: number;
  };
}

export function agentLeagueSmokeOutputMode(
  options: AgentLeagueSmokeRunOptions = {},
): "standard" | "private-writer" {
  return options.artifactWriter === undefined ? "standard" : "private-writer";
}

export async function runAgentLeagueSmoke(
  options: AgentLeagueSmokeRunOptions = {},
) {
  validateAgentLeagueSmokeRunOptions(options);
  const runtimeSocialExperimentFlags = {
    structuredDeals: structuredDealsEnabled(),
    freeTextMessages: freeTextMessagesEnabled(),
  };
  const startedAt = options.deterministicSource?.createdAtMs ?? Date.now();
  const args = options.args ?? process.argv.slice(2);
  const scenario = scenarioFromArgs(args);
  const brainMode = brainModeFromArgs(args, scenario);
  // --opponent-brain=<mode>: the configured subject uses --brain; other seats use this.
  // Enables the realigned eval — Keystone (seat 0) vs N starter-bot opponents — the
  // held-out Coworld field, instead of a uniform brain across all seats.
  const opponentBrainArg = args.find((arg) =>
    arg.startsWith("--opponent-brain="),
  );
  const opponentBrainMode: SmokeBrainMode | null = opponentBrainArg
    ? (opponentBrainArg.slice("--opponent-brain=".length) as SmokeBrainMode)
    : null;
  const runnerMode = runnerModeFromArgs(args);
  const stepLockedConfig = stepLockedConfigFromArgs(args);
  const planEveryDecisionSteps = resolvePlanEveryDecisionSteps(
    brainMode,
    options.planEveryDecisionSteps,
  );
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
  const replayTailTurns = nonNegativeIntegerArg(
    args,
    "--replay-tail-turns=",
    0,
  );
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
          outputSchema:
            brainMode === "planner-codex-cli" ? "planner" : "decision",
        });
  const usesClaudeCli =
    brainMode === "planner-claude-cli" || brainMode === "action-claude-cli";
  const claudeCliProvider = usesClaudeCli
    ? (options.claudeProviderForExperiment ??
      createClaudeCliLlmProviderFromEnv())
    : null;
  const usesOpenRouter =
    brainMode === "openrouter" || brainMode === "planner-openrouter";
  const openRouterProvider = usesOpenRouter
    ? createOpenRouterLlmProviderFromEnv()
    : null;
  // Stage 6 StrategicCommander smoke mode: Commander calls ride the existing
  // OpenRouter provider path and fail loud here when it is not configured. The
  // injected test provider is the only alternative, so verification never
  // silently downgrades to an unconfigured or fake manual run.
  const strategicCommanderProvider = isCommanderLlmMode(brainMode)
    ? (options.commanderProviderForTesting ??
      options.commanderProviderForExperiment ??
      createOpenRouterLlmProviderFromEnv())
    : null;
  // Promo mode: one Claude model per agent (e.g. --models=claude-fable-5,opus,sonnet),
  // optional display names (--names=Fable 5,Opus 4.8,Sonnet 4.6). Each agent gets its own
  // provider bound to its model; the provider serializes CLI calls globally so concurrent
  // ticks never collide into a fallback.
  const promoModels =
    args
      .find((a) => a.startsWith("--models="))
      ?.slice("--models=".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
  const promoNames =
    args
      .find((a) => a.startsWith("--names="))
      ?.slice("--names=".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
  // Run each `claude` call from a clean dir OUTSIDE the repo so it doesn't load this
  // project's CLAUDE.md/.claude settings (slow + would bias the model toward "coding
  // agent" instead of game-player).
  const claudeCleanCwd = path.join(os.tmpdir(), "proxywar-claude-cli-cwd");
  const initializeClaudePromoSupport =
    options.artifactWriter === undefined || promoModels !== null;
  if (initializeClaudePromoSupport) {
    fs.mkdirSync(claudeCleanCwd, { recursive: true });
  }
  const claudeBaseConfig = initializeClaudePromoSupport
    ? {
        ...loadClaudeCliLlmProviderConfig(),
        cwd: claudeCleanCwd,
      }
    : null;
  const claudeProviderCache = new Map<number, ClaudeCliLlmProvider>();
  const claudeProviderForIndex = (index: number): ClaudeCliLlmProvider => {
    if (claudeBaseConfig === null) {
      throw new Error("Claude promo support is unavailable for this smoke run");
    }
    let provider = claudeProviderCache.get(index);
    if (!provider) {
      provider = new ClaudeCliLlmProvider({
        ...claudeBaseConfig,
        model: promoModels?.[index] ?? claudeBaseConfig.model,
      });
      claudeProviderCache.set(index, provider);
    }
    return provider;
  };
  const decisionTimeoutMs =
    runnerMode === "step-locked"
      ? stepLockedConfig.maxDecisionMs
      : brainMode === "codex-cli" || brainMode === "planner-codex-cli"
        ? codexCliConfig?.timeoutMs
        : realLlmConfig?.timeoutMs;
  const manifests =
    options.injectedManifests !== undefined
      ? options.injectedManifests.map((entry) => entry.manifest)
      : manifestDir === null
        ? null
        : await loadAgentManifestsFromDirectory(manifestDir, {
            minAgents:
              options.manifestLimits?.minAgents ?? (explicitAgentCount ? 1 : 3),
            maxAgents:
              options.manifestLimits?.maxAgents ??
              (explicitAgentCount ? Math.max(1, 8 - agentCount) : 8),
          });
  if (
    manifests !== null &&
    (manifests.length < (options.manifestLimits?.minAgents ?? 1) ||
      manifests.length > (options.manifestLimits?.maxAgents ?? 8))
  ) {
    throw new Error("injected agent manifests do not meet manifest limits");
  }
  const manifestSpecs = manifests?.map(agentManifestToSpec) ?? [];
  const houseSpecs =
    manifests === null || explicitAgentCount
      ? createDefaultAgentSpecs(agentCount)
      : [];
  // Promo: name each agent after its model and give them an identical profile so the only
  // variable is the model driving the LLM planner (a genuine model-vs-model showcase).
  if (promoModels) {
    houseSpecs.forEach((spec, index) => {
      if (promoNames?.[index]) {
        spec.username = promoNames[index];
      }
      spec.profile = "aggressive";
    });
  }
  // Quick-start: stamp the player's chosen name onto the sponsored agent so the
  // tester sees THEIR agent (not a generated default) in the match and replay.
  const playerAgentName = process.env.AI_LEAGUE_PLAYER_AGENT_NAME?.trim();
  if (playerAgentName && explicitAgentCount && houseSpecs.length > 0) {
    houseSpecs[0].username = playerAgentName.slice(0, 27);
  }
  const unresolvedSpecsUnrotated =
    manifests === null ? houseSpecs : [...manifestSpecs, ...houseSpecs];
  const subjectSeatIndex = options.subjectSeatIndexForExperiment ?? 0;
  const episodeIndex = options.episodeIndexForExperiment ?? 0;
  const unresolvedSpecs =
    options.subjectSeatIndexForExperiment === undefined
      ? unresolvedSpecsUnrotated
      : moveFirstSpecToSeat(unresolvedSpecsUnrotated, subjectSeatIndex);
  const specs =
    options.deterministicSource === undefined
      ? unresolvedSpecs
      : unresolvedSpecs.map((spec, index) => ({
          ...spec,
          clientID: deterministicAgentClientID(
            options.deterministicSource!.seed,
            "client",
            index,
          ),
          persistentID: deterministicLocalUUID(
            options.deterministicSource!.seed,
            "persistent",
            index,
          ),
        }));
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
  const executionConfig = buildAgentLeagueSmokeExecutionConfig({
    scenario,
    brainMode,
    runnerMode,
    planEveryDecisionSteps,
    stepLockedConfig,
    replayTailTurns,
    selectedGameConfig,
    disabledActionKinds,
    varySpawns: args.includes("--vary-spawns"),
    matchedOfferedOrderSpawnBallot:
      options.forceOfferedOrderSpawnBallotForExperiment === true,
    agents: specs.length,
    opponentBrainMode,
    executionSeed: options.deterministicSource?.seed ?? null,
    subjectSeatIndex: options.subjectSeatIndexForExperiment,
    episodeIndex: options.episodeIndexForExperiment,
  });
  const game = new GameServer(
    options.deterministicSource?.gameID ?? "AGENT002",
    log,
    options.deterministicSource?.createdAtMs ?? Date.now(),
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
  // Provider for a given brain mode (per-mode, so opponent seats can differ from
  // seat 0). EXACTLY replicates the prior inline selection when called with brainMode,
  // so existing single-brain runs are unchanged; rule/starter-bot/mock-llm/planner
  // ignore the returned provider.
  const providerForBrainMode = (
    mode: SmokeBrainMode,
    index: number,
  ): LlmProvider | null => {
    if (mode === "codex-cli" || mode === "planner-codex-cli") {
      return codexCliProvider;
    }
    if (mode === "planner-claude-cli" || mode === "action-claude-cli") {
      return promoModels ? claudeProviderForIndex(index) : claudeCliProvider;
    }
    if (mode === "openrouter" || mode === "planner-openrouter") {
      return openRouterProvider;
    }
    if (isCommanderLlmMode(mode)) {
      return strategicCommanderProvider;
    }
    return realLlmProvider;
  };
  const participants = createAgentParticipants(specs, log, {
    brainFactory:
      brainMode === "rule" &&
      !hasManifestBrainOverride &&
      opponentBrainMode === null
        ? undefined
        : (spec, index) => {
            const mode =
              opponentBrainMode !== null && index !== subjectSeatIndex
                ? opponentBrainMode
                : brainMode;
            const brain = createBrainForManifestOrMode(
              index < manifestCount ? manifests?.[index] : undefined,
              spec,
              scenario,
              mode,
              providerForBrainMode(mode, index),
              decisionTimeoutMs,
              externalAgentMaxDecisionMs,
              planEveryDecisionSteps,
              options.allowEnvironmentStrategySpec !== false,
            );
            return options.forceOfferedOrderSpawnBallotForExperiment === true
              ? withOfferedOrderSpawnBallot(
                  brain,
                  index === subjectSeatIndex
                    ? options.commanderExperimentProvenance
                    : undefined,
                  runtimeProvenanceForBrainMode(
                    mode,
                    providerForBrainMode(mode, index),
                  ),
                )
              : brain;
          },
  });
  const spectatorSnapshots: AgentSpectatorSnapshot[] = [];
  const mirror = new AgentLocalGameMirror(mapLoader, log);
  const mirrorMessages = () => participants[0]?.runner.serverMessages() ?? [];
  const league = new AgentLeagueMatchRunner({
    game,
    participants,
    spawnCandidates,
    log,
    disabledActionKinds,
    episodeIndex,
  });

  try {
    league.attachAgents();
    const roster = buildAttachedAgentRunRoster(participants);
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
        // Labeled autopilot endgame (operator-approved failsafe): swap every
        // participant onto a deterministic planner-executor brain tagged with
        // runtimeMode "autopilot-executor". Decisions after this point are NOT
        // model play and artifacts must say so; silent fallback stays forbidden.
        ...(stepLockedConfig.autopilotExtraSteps > 0
          ? {
              onAutopilotEngage: ({ step }: { step: number }) => {
                log.warn(
                  "AUTOPILOT ENDGAME ENGAGED: deterministic executor plays out the endgame; decisions from this step are NOT model play",
                  {
                    step,
                    autopilotExtraSteps: stepLockedConfig.autopilotExtraSteps,
                  },
                );
                for (const participant of participants) {
                  participant.brain = new PlannerExecutorAgentBrain({
                    profile: participant.spec.profile,
                    planner: new MockLlmPlanner(participant.spec.profile),
                    executor: new FrontierPolicyExecutor(
                      participant.spec.profile,
                      {
                        settings: {
                          territoryFirstNeutralLandEnabled: true,
                          maxActionsPerDecision: 5,
                          siloTileShareRatio: 0.14,
                          samTileShareRatio: 0.14,
                        },
                      },
                    ),
                    planEveryDecisionSteps: 3,
                    runtimeMode: "autopilot-executor",
                  });
                }
              },
            }
          : {}),
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
      const completedAt = completedAtForSmokeRun(
        options,
        startedAt,
        mirror.turnCount(),
      );
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
      const terminalWinner = winnerFromGame(finalGameState);
      const artifactInput: WriteAgentLeagueRunArtifactsInput = {
        runID,
        matchID: game.id,
        scenario,
        brainMode: artifactBrainMode(brainMode),
        runnerMode,
        runnerConfig: {
          executionConfigSchemaVersion: executionConfig.schemaVersion,
          turnsPerDecisionStep: stepResult.turnsPerDecisionStep,
          turnsPerDecisionSchedule: stepResult.turnsPerDecisionSchedule,
          maxDecisionMs: stepResult.maxDecisionMs,
          maxSteps: stepLockedConfig.maxSteps,
          stepsCompleted: stepResult.stepsCompleted,
          planEveryDecisionSteps,
          maxSpawnAdvanceTurns: stepLockedConfig.maxSpawnAdvanceTurns,
          waitForMirrorCatchup: stepLockedConfig.waitForMirrorCatchup,
          requireWinner: stepLockedConfig.requireWinner,
          mirrorCatchupSucceeded: stepResult.mirrorCatchupSucceeded,
          onlyHoldReason: stepResult.onlyHoldReason,
          autopilotEndgameSteps: stepLockedConfig.autopilotExtraSteps,
          autopilotEngagedAtStep: stepResult.autopilotEngagedAtStep,
          replayTailTurns,
          agents: specs.length,
          bots: botCount,
          nations: nationCount,
          map: selectedGameConfig.gameMap,
          mapSize: selectedGameConfig.gameMapSize,
          difficulty: selectedGameConfig.difficulty,
          variedSpawns: args.includes("--vary-spawns"),
          matchedOfferedOrderSpawnBallot:
            options.forceOfferedOrderSpawnBallotForExperiment === true,
          disabledActionKinds,
          opponentBrainMode,
          rosterPolicy: rosterPolicyForOpponent(
            opponentBrainMode,
            subjectSeatIndex,
            options.subjectSeatIndexForExperiment !== undefined,
          ),
          ...(options.subjectSeatIndexForExperiment === undefined
            ? {}
            : { subjectSeatIndex }),
          ...(options.episodeIndexForExperiment === undefined
            ? {}
            : { episodeIndex }),
          executionSeed: options.deterministicSource?.seed ?? null,
          executionGameID: game.id,
          executionGameIDDerivation:
            options.deterministicSource?.gameIDDerivation ?? null,
          selectedGameConfig: executionConfig.selectedGameConfig ?? null,
          structuredDealsEnabled: runtimeSocialExperimentFlags.structuredDeals,
          freeTextMessagesEnabled:
            runtimeSocialExperimentFlags.freeTextMessages,
          spawnSelectionMode: "sealed-ranked-v1",
        },
        startedAt,
        completedAt,
        records: league.decisionRecords(),
        roster,
        finalState,
        winner: terminalWinner,
        spectatorReplay,
        gameRecord,
        notes: artifactNotes(scenario, brainMode, runnerMode),
      };
      const artifacts = await writeSmokeRunArtifacts(options, {
        artifactInput,
        winner: terminalWinner,
        turnCount: mirror.turnCount(),
        playbackTurnIntervalMs:
          options.deterministicSource?.playbackTurnIntervalMs ?? 1,
        executionConfig,
      });
      // Skip the global demo-index rebuild by default: writeAgentDemoIndex()
      // readdir+reads every historical run in artifacts/ai-league-runs (tens of
      // thousands of files / tens of GB), which is wasteful on automated
      // smoke/dry-run matches. The live beta server writes its index elsewhere,
      // so only rebuild here when explicitly requested.
      if (
        options.artifactWriter === undefined &&
        process.env.PROXYWAR_WRITE_DEMO_INDEX === "1"
      ) {
        await writeAgentDemoIndex();
      }

      const allRecords = league.decisionRecords();
      assertRequiredExternalBrainSucceeded({
        brainMode,
        records: allRecords,
      });
      assertCommanderSmokeSelectedStrategicOption({
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
          postSpawnNonHoldActionCount: stepResult.postSpawnNonHoldActionCount,
          fallbackCount: fallbackCount(allRecords),
          onlyHoldReason: stepResult.onlyHoldReason,
        },
        opening: summarizeRecords(stepResult.openingRecords),
        postSpawn: summarizeRecords(stepResult.postSpawnRecords),
        artifacts,
        ...(options.artifactWriter === undefined
          ? {
              openFrontReplayUrl: `http://localhost:9000/ai-league-replay/${encodeURIComponent(runID)}`,
            }
          : {}),
      });
      return;
    }

    // The sealed spawn ballot consults every configured brain concurrently.
    // Bound that pre-game stage just like ordinary decisions so a hung
    // provider cannot block a realtime smoke forever.
    const openingRecords = await league.runSpawnPhase({
      mirror,
      messages: mirrorMessages,
      maxDecisionMs: decisionTimeoutMs ?? stepLockedConfig.maxDecisionMs,
    });
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
    const postSpawnAuditBaselines = captureDecisionAuditBaselines(
      postSpawnRecords,
      postSpawnGame,
    );
    const postSpawnTurnCount = mirror.turnCount();
    // startGame() runs the match on a manual clock (realtimeClock: false), so
    // nothing ends turns by itself here: advance two — one to land the
    // just-submitted intents, one so their executions tick — before auditing.
    game.advanceTurnsForTesting(2);
    const afterPostSpawnGame = await waitForMirrorState({
      mirror,
      messages: mirrorMessages,
      until: (_state, currentMirror) =>
        currentMirror.turnCount() > postSpawnTurnCount,
      timeoutMs: 2_000,
    });
    auditDecisionEffects({
      records: postSpawnRecords,
      beforeGame: null,
      afterGame: afterPostSpawnGame,
      baselines: postSpawnAuditBaselines,
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
      assertActionDiversitySmokeSucceeded(postSpawnRecords, afterPostSpawnGame);
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
    const completedAt = completedAtForSmokeRun(
      options,
      startedAt,
      mirror.turnCount(),
    );
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
    const terminalWinner = winnerFromGame(finalGameState);
    const artifactInput: WriteAgentLeagueRunArtifactsInput = {
      runID,
      matchID: game.id,
      scenario,
      brainMode: artifactBrainMode(brainMode),
      runnerMode,
      runnerConfig: {
        executionConfigSchemaVersion: executionConfig.schemaVersion,
        turnsPerDecisionStep: executionConfig.runner.turnsPerDecisionStep,
        turnsPerDecisionSchedule:
          executionConfig.runner.turnsPerDecisionSchedule,
        maxDecisionMs: executionConfig.runner.maxDecisionMs,
        maxSteps: executionConfig.runner.maxSteps,
        planEveryDecisionSteps,
        maxSpawnAdvanceTurns: executionConfig.runner.maxSpawnAdvanceTurns,
        waitForMirrorCatchup: executionConfig.runner.waitForMirrorCatchup,
        requireWinner: executionConfig.runner.requireWinner,
        autopilotEndgameSteps: executionConfig.runner.autopilotEndgameSteps,
        autopilotEngagedAtStep: null,
        replayTailTurns,
        agents: specs.length,
        bots: botCount,
        nations: nationCount,
        map: selectedGameConfig.gameMap,
        mapSize: selectedGameConfig.gameMapSize,
        difficulty: selectedGameConfig.difficulty,
        variedSpawns: args.includes("--vary-spawns"),
        matchedOfferedOrderSpawnBallot:
          options.forceOfferedOrderSpawnBallotForExperiment === true,
        disabledActionKinds,
        opponentBrainMode,
        rosterPolicy: rosterPolicyForOpponent(
          opponentBrainMode,
          subjectSeatIndex,
          options.subjectSeatIndexForExperiment !== undefined,
        ),
        ...(options.subjectSeatIndexForExperiment === undefined
          ? {}
          : { subjectSeatIndex }),
        ...(options.episodeIndexForExperiment === undefined
          ? {}
          : { episodeIndex }),
        executionSeed: options.deterministicSource?.seed ?? null,
        executionGameID: game.id,
        executionGameIDDerivation:
          options.deterministicSource?.gameIDDerivation ?? null,
        selectedGameConfig: executionConfig.selectedGameConfig ?? null,
        structuredDealsEnabled: runtimeSocialExperimentFlags.structuredDeals,
        freeTextMessagesEnabled: runtimeSocialExperimentFlags.freeTextMessages,
        spawnSelectionMode: "sealed-ranked-v1",
      },
      startedAt,
      completedAt,
      records: league.decisionRecords(),
      roster,
      finalState,
      winner: terminalWinner,
      spectatorReplay,
      gameRecord,
      notes: artifactNotes(scenario, brainMode, runnerMode),
    };
    const artifacts = await writeSmokeRunArtifacts(options, {
      artifactInput,
      winner: terminalWinner,
      turnCount: mirror.turnCount(),
      playbackTurnIntervalMs:
        options.deterministicSource?.playbackTurnIntervalMs ?? 1,
      executionConfig,
    });
    // Skip the global demo-index rebuild by default: writeAgentDemoIndex()
    // readdir+reads every historical run in artifacts/ai-league-runs (tens of
    // thousands of files / tens of GB), which is wasteful on automated
    // smoke/dry-run matches. The live beta server writes its index elsewhere,
    // so only rebuild here when explicitly requested.
    if (
      options.artifactWriter === undefined &&
      process.env.PROXYWAR_WRITE_DEMO_INDEX === "1"
    ) {
      await writeAgentDemoIndex();
    }
    assertRequiredExternalBrainSucceeded({
      brainMode,
      records: league.decisionRecords(),
    });
    assertCommanderSmokeSelectedStrategicOption({
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
      ...(options.artifactWriter === undefined
        ? {
            openFrontReplayUrl: `http://localhost:9000/ai-league-replay/${encodeURIComponent(runID)}`,
          }
        : {}),
    });
  } finally {
    codexCliProvider?.close();
    await game.end({ archive: false });
  }
}

async function writeSmokeRunArtifacts(
  options: AgentLeagueSmokeRunOptions,
  input: AgentLeagueSmokeArtifactWriterInput,
): Promise<unknown> {
  if (options.artifactWriter !== undefined) {
    return options.artifactWriter(input);
  }
  return writeAgentLeagueRunArtifacts(input.artifactInput);
}

function winnerFromGame(game: Game): Winner {
  const winner = game.getWinner();
  if (winner === null) {
    return undefined;
  }
  if (typeof winner === "string") {
    return [
      "team",
      winner,
      ...game
        .players()
        .filter(
          (player) => player.team() === winner && player.clientID() !== null,
        )
        .map((player) => player.clientID()!),
    ];
  }
  const clientID = winner.clientID();
  return clientID === null ? ["nation", winner.name()] : ["player", clientID];
}

function completedAtForSmokeRun(
  options: AgentLeagueSmokeRunOptions,
  startedAt: number,
  turnCount: number,
): number {
  const turnIntervalMs = options.deterministicSource?.playbackTurnIntervalMs;
  return turnIntervalMs === undefined
    ? Date.now()
    : startedAt + turnCount * turnIntervalMs;
}

function deterministicLocalUUID(
  seed: string,
  namespace: string,
  index: number,
): string {
  const hex = createHash("sha256")
    .update(`proxywar-agent-smoke-v1\0${seed}\0${namespace}\0${index}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(
    13,
    16,
  )}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function validateAgentLeagueSmokeRunOptions(
  options: AgentLeagueSmokeRunOptions,
): void {
  if (
    options.injectedManifests !== undefined &&
    (options.args ?? process.argv.slice(2)).some((arg) =>
      arg.startsWith("--agent-manifest-dir="),
    )
  ) {
    throw new Error(
      "injected agent manifests cannot be combined with a manifest directory",
    );
  }
  if (
    options.planEveryDecisionSteps !== undefined &&
    (!Number.isSafeInteger(options.planEveryDecisionSteps) ||
      options.planEveryDecisionSteps < 1 ||
      options.planEveryDecisionSteps > 10)
  ) {
    throw new Error("agent league smoke planner cadence must be from 1 to 10");
  }
  const requestedArgs = options.args ?? process.argv.slice(2);
  const requestedBrainMode = brainModeFromArgs(
    requestedArgs,
    scenarioFromArgs(requestedArgs),
  );
  if (
    options.commanderProviderForTesting !== undefined &&
    !isCommanderLlmMode(requestedBrainMode)
  ) {
    throw new Error(
      "a Commander test provider can only be injected into Commander LLM runs",
    );
  }
  if (
    options.commanderProviderForExperiment !== undefined &&
    (!isCommanderLlmMode(requestedBrainMode) ||
      options.forceOfferedOrderSpawnBallotForExperiment !== true)
  ) {
    throw new Error(
      "a Commander experiment provider requires a Commander LLM mode and matched experiment seam",
    );
  }
  if (
    options.commanderProviderForTesting !== undefined &&
    options.commanderProviderForExperiment !== undefined
  ) {
    throw new Error(
      "Commander test and experiment providers are mutually exclusive",
    );
  }
  if (
    options.commanderExperimentProvenance !== undefined &&
    options.forceOfferedOrderSpawnBallotForExperiment !== true
  ) {
    throw new Error(
      "Commander experiment provenance requires the matched experiment seam",
    );
  }
  if (
    options.claudeProviderForExperiment !== undefined &&
    (requestedBrainMode !== "planner-claude-cli" ||
      options.forceOfferedOrderSpawnBallotForExperiment !== true)
  ) {
    throw new Error(
      "a Claude experiment provider requires planner-claude-cli and the matched experiment seam",
    );
  }
  for (const [label, value] of [
    ["subject seat", options.subjectSeatIndexForExperiment],
    ["episode index", options.episodeIndexForExperiment],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 0 || value > 7)
    ) {
      throw new Error(`Commander experiment ${label} must be from 0 to 7`);
    }
  }
  if (
    (options.subjectSeatIndexForExperiment !== undefined ||
      options.episodeIndexForExperiment !== undefined) &&
    options.forceOfferedOrderSpawnBallotForExperiment !== true
  ) {
    throw new Error(
      "Commander experiment seat and priority rotation require the matched experiment seam",
    );
  }
  if (options.injectedManifests !== undefined) {
    for (const entry of options.injectedManifests) {
      const rawManifest = Buffer.from(entry.rawManifestBase64, "base64");
      if (
        entry.sourceName.trim() === "" ||
        !/^[a-f0-9]{64}$/.test(entry.manifestSha256) ||
        !/^[a-f0-9]{64}$/.test(entry.contentSha256) ||
        entry.rawManifestBase64.trim() === "" ||
        rawManifest.toString("base64") !== entry.rawManifestBase64 ||
        createHash("sha256").update(rawManifest).digest("hex") !==
          entry.manifestSha256
      ) {
        throw new Error("invalid injected agent manifest identity");
      }
    }
  }
  if (options.manifestLimits !== undefined) {
    const { minAgents, maxAgents } = options.manifestLimits;
    if (
      !Number.isSafeInteger(minAgents) ||
      !Number.isSafeInteger(maxAgents) ||
      minAgents < 1 ||
      maxAgents > 8 ||
      minAgents > maxAgents
    ) {
      throw new Error(
        "agent league smoke manifest limits must be between 1 and 8",
      );
    }
  }
  const deterministic = options.deterministicSource;
  if (deterministic === undefined) {
    return;
  }
  if (
    deterministic.seed.trim() === "" ||
    !Number.isSafeInteger(deterministic.createdAtMs) ||
    deterministic.createdAtMs <= 0 ||
    !Number.isSafeInteger(deterministic.playbackTurnIntervalMs) ||
    deterministic.playbackTurnIntervalMs <= 0 ||
    deterministic.playbackTurnIntervalMs > 60_000
  ) {
    throw new Error("invalid deterministic agent league smoke source options");
  }
}

function buildAgentLeagueSmokeExecutionConfig(input: {
  scenario: SmokeScenario;
  brainMode: SmokeBrainMode;
  runnerMode: SmokeRunnerMode;
  planEveryDecisionSteps: number;
  stepLockedConfig: AgentStepLockedLeagueConfig;
  replayTailTurns: number;
  selectedGameConfig: GameConfig;
  disabledActionKinds: LegalActionKind[];
  varySpawns: boolean;
  matchedOfferedOrderSpawnBallot: boolean;
  agents: number;
  opponentBrainMode: SmokeBrainMode | null;
  executionSeed: string | null;
  subjectSeatIndex?: number;
  episodeIndex?: number;
}): AgentLeagueSmokeExecutionConfig {
  return {
    schemaVersion: 1,
    scenario: input.scenario,
    brainMode: input.brainMode,
    runnerMode: input.runnerMode,
    agents: input.agents,
    opponentBrainMode: input.opponentBrainMode,
    executionSeed: input.executionSeed,
    ...(input.subjectSeatIndex === undefined
      ? {}
      : { subjectSeatIndex: input.subjectSeatIndex }),
    ...(input.episodeIndex === undefined
      ? {}
      : { episodeIndex: input.episodeIndex }),
    selectedGameConfig: normalizeCommanderGameConfig(input.selectedGameConfig),
    planEveryDecisionSteps: input.planEveryDecisionSteps,
    runner: {
      turnsPerDecisionStep: input.stepLockedConfig.turnsPerDecisionStep,
      turnsPerDecisionSchedule:
        input.stepLockedConfig.turnsPerDecisionSchedule === undefined
          ? null
          : [...input.stepLockedConfig.turnsPerDecisionSchedule],
      maxDecisionMs: input.stepLockedConfig.maxDecisionMs,
      maxSteps: input.stepLockedConfig.maxSteps,
      maxSpawnAdvanceTurns: input.stepLockedConfig.maxSpawnAdvanceTurns,
      requireWinner: input.stepLockedConfig.requireWinner,
      waitForMirrorCatchup: input.stepLockedConfig.waitForMirrorCatchup,
      autopilotEndgameSteps: input.stepLockedConfig.autopilotExtraSteps,
      replayTailTurns: input.replayTailTurns,
      matchedOfferedOrderSpawnBallot: input.matchedOfferedOrderSpawnBallot,
    },
    game: {
      bots: input.selectedGameConfig.bots ?? 0,
      nations: input.selectedGameConfig.nations ?? "disabled",
      map: String(input.selectedGameConfig.gameMap),
      mapSize: String(input.selectedGameConfig.gameMapSize),
      difficulty: String(input.selectedGameConfig.difficulty),
      varySpawns: input.varySpawns,
    },
    disabledActionKinds: [
      ...new Set(input.disabledActionKinds),
    ].sort() as LegalActionKind[],
  };
}

function rosterPolicyForOpponent(
  opponentBrainMode: SmokeBrainMode | null,
  subjectSeatIndex = 0,
  rotatingSubject = false,
): string {
  return opponentBrainMode === null
    ? "uniform-brain"
    : opponentBrainMode === "starter-bot"
      ? rotatingSubject
        ? "rotating-subject-vs-starter-bot"
        : `subject-seat-${subjectSeatIndex}-vs-starter-bot`
      : rotatingSubject
        ? "rotating-subject-vs-opponent-brain"
        : `subject-seat-${subjectSeatIndex}-vs-opponent-brain`;
}

function moveFirstSpecToSeat<T>(specs: readonly T[], seatIndex: number): T[] {
  if (
    !Number.isSafeInteger(seatIndex) ||
    seatIndex < 0 ||
    seatIndex >= specs.length
  ) {
    throw new Error("Commander experiment subject seat is outside the roster");
  }
  const [subject, ...opponents] = specs;
  if (subject === undefined) {
    throw new Error("Commander experiment requires a subject participant");
  }
  const rotated = [...opponents];
  rotated.splice(seatIndex, 0, subject);
  return rotated;
}

/** Exact normalized game configuration used by a manifest-free smoke run. */
export function agentLeagueSmokeSelectedGameConfig(
  args: string[],
): CommanderCanonicalGameConfig {
  const scenario = scenarioFromArgs(args);
  const base = gameConfigForScenario(scenario, args);
  const agents = positiveIntegerArg(args, "--agents=", 4);
  return normalizeCommanderGameConfig({
    ...base,
    bots: nonNegativeIntegerArg(args, "--bots=", 0),
    nations: nationsArg(args, "disabled"),
    maxPlayers: Math.max(base.maxPlayers ?? 4, agents),
  });
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

function stepLockedConfigFromArgs(args: string[]): AgentStepLockedLeagueConfig {
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
    // Labeled autopilot endgame failsafe (OFF by default): extra deterministic
    // decision steps allowed after --max-steps if no winner exists yet.
    autopilotExtraSteps: nonNegativeIntegerArg(
      args,
      "--autopilot-endgame-steps=",
      0,
    ),
  };
}

function turnsPerDecisionScheduleFromArgs(
  args: string[],
): number[] | undefined {
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

function nationsArg(
  args: string[],
  defaultValue: GameConfig["nations"],
): GameConfig["nations"] {
  const raw = args
    .find((arg) => arg.startsWith("--nations="))
    ?.slice("--nations=".length);
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  if (raw === "disabled" || raw === "default") {
    return raw;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 400) {
    throw new Error(
      `--nations=${raw} must be a positive integer, default, or disabled`,
    );
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
  if (args.includes("--brain=planner-claude-cli")) {
    return "planner-claude-cli";
  }
  if (args.includes("--brain=action-claude-cli")) {
    return "action-claude-cli";
  }
  if (args.includes("--brain=planner-openrouter")) {
    return "planner-openrouter";
  }
  if (args.includes("--brain=openrouter")) {
    return "openrouter";
  }
  if (args.includes("--brain=mock-llm")) {
    return "mock-llm";
  }
  if (args.includes("--brain=strategic-commander")) {
    return "strategic-commander";
  }
  if (args.includes("--brain=commander-v0-det")) {
    return "commander-v0-det";
  }
  if (args.includes("--brain=commander-v0-llm")) {
    return "commander-v0-llm";
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
  const disabled: LegalActionKind[] = [];
  if (args.includes("--disable-alliance-actions")) {
    disabled.push("alliance_request");
  }
  // FORGE experiment: --disable-social strips chat/emoji from the offered menu so
  // the executor cannot pad moves with social filler instead of converting attacks.
  if (args.includes("--disable-social")) {
    disabled.push("quick_chat", "emoji");
  }
  // Generic escape hatch: --disable-action-kinds=quick_chat,emoji,target_player
  const generic = args.find((arg) => arg.startsWith("--disable-action-kinds="));
  if (generic) {
    for (const kind of generic
      .slice("--disable-action-kinds=".length)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      disabled.push(kind as LegalActionKind);
    }
  }
  return disabled;
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
    difficulty: enumArg(
      args,
      "--difficulty=",
      Difficulty,
      gameConfig.difficulty,
    ),
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
  const entries = Object.entries(values).filter(
    ([, value]) => typeof value === "string",
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
  planEveryDecisionSteps: number,
  allowEnvironmentStrategySpec: boolean,
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
  // starter-bot: the faithful in-process port of the Coworld starter policy — the
  // held-out opponent class the eval must measure Keystone against (NOT OpenFront's
  // built-in nation AI). Only ever selects an offered LegalAction.id (same contract).
  if (brainMode === "starter-bot") {
    return new StarterBotAgentBrain();
  }
  // Player strategy spec: per-seat from the manifest, else a single spec from env
  // (AI_LEAGUE_PLAYER_STRATEGY_SPEC) for the sponsored single-seat path.
  const playerStrategySpec = resolveAgentLeagueSmokePlayerStrategySpec(
    manifest?.strategySpec,
    allowEnvironmentStrategySpec,
  );
  return createBrainForMode(
    spec,
    scenario,
    brainMode,
    provider,
    providerTimeoutMs,
    playerStrategySpec,
    planEveryDecisionSteps,
  );
}

/**
 * Experiment-only wrapper used by the Stage 5 matched harness. Every arm
 * submits the same bounded offered-order spawn ballot, while active play and
 * failure/feedback behavior remain the original brain's exact implementation.
 */
function withOfferedOrderSpawnBallot(
  brain: AgentBrain,
  assertedProvenance:
    | AgentLeagueSmokeRunOptions["commanderExperimentProvenance"]
    | undefined,
  runtimeProvenance: CommanderRuntimeProvenance,
): AgentBrain {
  const wrapped: AgentBrain = {
    get brainType() {
      return brain.brainType;
    },
    get internalDecisionTimeoutMs() {
      return brain.internalDecisionTimeoutMs;
    },
    decide: async (input) => {
      if (input.observation.phase !== "spawn") {
        const decision = await brain.decide(input);
        return {
          ...decision,
          metadata: {
            ...decision.metadata,
            ...(assertedProvenance === undefined
              ? {}
              : {
                  commanderExperimentProvider: assertedProvenance.provider,
                  commanderExperimentModel: assertedProvenance.model,
                  commanderExperimentPromptVersion:
                    assertedProvenance.promptVersion,
                }),
            commanderRuntimeProvider: runtimeProvenance.provider,
            commanderRuntimeModel: runtimeProvenance.model,
            commanderRuntimePromptVersion: runtimeProvenance.promptVersion,
          },
        };
      }
      const offered = input.legalActions
        .filter((action) => action.kind === "spawn")
        .slice(0, MAX_SPAWN_PREFERENCE_ACTION_IDS);
      if (offered.length === 0) {
        return brain.decide(input);
      }
      return {
        actionID: offered[0]!.id,
        spawnPreferenceActionIDs: offered.map((action) => action.id),
        reason: "Stage 5 matched experiment offered-order spawn ballot",
        metadata: { commanderExperimentMatchedSpawnBallot: true },
      };
    },
    ...(brain.failClosed === undefined
      ? {}
      : { failClosed: (input) => brain.failClosed!(input) }),
    ...(brain.onActionResult === undefined
      ? {}
      : { onActionResult: (feedback) => brain.onActionResult!(feedback) }),
  };
  return wrapped;
}

interface CommanderRuntimeProvenance {
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
}

export const PLANNER_RUNTIME_PROMPT_VERSION = "planner-executor-current-v1";

/**
 * Runtime binding evidence comes from the exact constructed mode/provider,
 * never from the Stage 5 manifest or its asserted experiment labels.
 */
function runtimeProvenanceForBrainMode(
  mode: SmokeBrainMode,
  provider: LlmProvider | null,
): CommanderRuntimeProvenance {
  if (mode === "planner") {
    return {
      provider: "mock-llm",
      model: "mock-planner-v0",
      promptVersion: PLANNER_RUNTIME_PROMPT_VERSION,
    };
  }
  if (mode === "commander-v0-det") {
    return { provider: null, model: null, promptVersion: null };
  }
  if (mode === "commander-v0-llm" || mode === "strategic-commander") {
    return {
      provider: provider?.providerType ?? null,
      model: normalizedProviderModel(provider),
      promptVersion: COMMANDER_PROMPT_VERSION,
    };
  }
  if (
    mode === "planner-claude-cli" ||
    mode === "planner-codex-cli" ||
    mode === "planner-openrouter"
  ) {
    return {
      provider: provider?.providerType ?? null,
      model: normalizedProviderModel(provider),
      promptVersion: PLANNER_RUNTIME_PROMPT_VERSION,
    };
  }
  return { provider: null, model: null, promptVersion: null };
}

function normalizedProviderModel(provider: LlmProvider | null): string | null {
  const model = provider?.model?.trim();
  return model === undefined || model === "" ? null : model;
}

function externalAgentTimeoutMs(input: {
  manifestTimeoutMs: number | undefined;
  providerTimeoutMs: number | undefined;
  externalAgentMaxDecisionMs: number;
}): number {
  const requested =
    input.manifestTimeoutMs ??
    input.providerTimeoutMs ??
    input.externalAgentMaxDecisionMs;
  return Math.max(250, Math.min(requested, input.externalAgentMaxDecisionMs));
}

function manifestHasBrainOverride(manifest: AgentManifest): boolean {
  return (
    manifest.brainType === "external-http" ||
    manifest.brainType === "external-relay" ||
    manifest.provider?.provider === "external-http" ||
    manifest.provider?.provider === "external-relay"
  );
}

// Beta seats can tighten the replan cadence (default 3) so a player's strategy is
// re-expressed more often. Env-overridable via PROXYWAR_PLAN_EVERY_DECISION_STEPS.
function resolvePlanEveryDecisionSteps(
  brainMode: SmokeBrainMode,
  explicitValue: number | undefined,
): number {
  if (explicitValue !== undefined) {
    return explicitValue;
  }
  return brainMode === "planner-openrouter"
    ? planEveryDecisionStepsFromEnv()
    : 3;
}

function planEveryDecisionStepsFromEnv(): number {
  const raw = process.env.PROXYWAR_PLAN_EVERY_DECISION_STEPS?.trim();
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10) {
    return parsed;
  }
  return 3;
}

export function resolveAgentLeagueSmokePlayerStrategySpec(
  manifestStrategySpec: PlayerStrategySpec | undefined,
  allowEnvironmentStrategySpec: boolean,
  loadEnvironmentStrategySpec: () => PlayerStrategySpec | null = loadPlayerStrategySpecFromEnv,
): PlayerStrategySpec | null {
  if (manifestStrategySpec !== undefined) {
    return manifestStrategySpec;
  }
  return allowEnvironmentStrategySpec ? loadEnvironmentStrategySpec() : null;
}

function createBrainForMode(
  spec: AgentSpec,
  scenario: SmokeScenario,
  brainMode: Exclude<SmokeBrainMode, "rule">,
  provider: LlmProvider | null,
  providerTimeoutMs: number | undefined,
  playerStrategySpec: PlayerStrategySpec | null = null,
  planEveryDecisionSteps?: number,
): AgentBrain {
  if (brainMode === "mock-llm") {
    return createMockLlmBrain(spec, scenario, providerTimeoutMs);
  }
  if (
    brainMode === "strategic-commander" ||
    brainMode === "commander-v0-llm" ||
    brainMode === "commander-v0-det"
  ) {
    const selector =
      brainMode === "commander-v0-det"
        ? new DeterministicOptionSelector()
        : provider === null
          ? null
          : new LlmOptionSelector({
              provider,
              timeoutMs: commanderProviderTimeoutBelowOuter(providerTimeoutMs),
            });
    if (selector === null) {
      throw new LlmProviderConfigError(
        `${brainMode} smoke requested but no Commander provider was configured.`,
      );
    }
    // The tactical brain owns spawn/non-active phases only. Active play is
    // executed binding-first by StrategicOptionExecutor, including its narrow
    // same-target support batch; it never escapes to RuleAgentBrain.
    return new StrategicCommanderBrain(
      new StrategicCommanderCaller(
        selector,
        commanderProviderTimeoutBelowOuter(providerTimeoutMs),
      ),
      new RuleAgentBrain(spec.profile),
    );
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
      planEveryDecisionSteps: planEveryDecisionSteps ?? 3,
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
      planEveryDecisionSteps: planEveryDecisionSteps ?? 3,
    });
  }
  if (brainMode === "planner-claude-cli") {
    if (provider === null) {
      throw new LlmProviderConfigError(
        "planner-claude-cli smoke requested but no provider was configured.",
      );
    }
    return new PlannerExecutorAgentBrain({
      profile: spec.profile,
      planner: new LlmAgentPlanner({
        provider,
        profile: spec.profile,
        providerTimeoutMs,
        plannerType: "real-llm",
      }),
      executor: new FrontierPolicyExecutor(spec.profile, {
        settings: {
          territoryFirstNeutralLandEnabled: true,
          maxActionsPerDecision: 5,
          siloTileShareRatio: 0.14,
          samTileShareRatio: 0.14,
        },
      }),
      planEveryDecisionSteps: planEveryDecisionSteps ?? 3,
    });
  }
  if (brainMode === "planner-openrouter") {
    if (provider === null) {
      throw new LlmProviderConfigError(
        "planner-openrouter smoke requested but no provider was configured.",
      );
    }
    // The player's posture knob maps onto the agent profile (profile weights); the
    // rest of the spec binds at the planner's merge chokepoint.
    const profile = playerStrategySpec?.posture ?? spec.profile;
    return new PlannerExecutorAgentBrain({
      profile,
      planner: new LlmAgentPlanner({
        provider,
        profile,
        providerTimeoutMs,
        plannerType: "real-llm",
        playerStrategySpec: playerStrategySpec ?? undefined,
      }),
      executor: new FrontierPolicyExecutor(profile, {
        settings: {
          territoryFirstNeutralLandEnabled: true,
          maxActionsPerDecision: 5,
          siloTileShareRatio: 0.14,
          samTileShareRatio: 0.14,
        },
      }),
      planEveryDecisionSteps:
        planEveryDecisionSteps ?? planEveryDecisionStepsFromEnv(),
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
  if (brainMode === "action-claude-cli") {
    if (provider === null) {
      throw new LlmProviderConfigError(
        "action-claude-cli smoke requested but no provider was configured.",
      );
    }
    // FULL LLM authority: the model picks the LegalAction.id directly from the complete
    // legal menu every decision step (no deterministic executor choosing moves). Optional
    // shared personality (same text for every agent => fair) via AI_LEAGUE_AGENT_PERSONALITY.
    return new LlmAgentBrain({
      provider,
      profile: spec.profile,
      brainType: "llm",
      runtimeMode: "llm-action-selector",
      providerTimeoutMs,
      includePromptInMetadata: false,
      personality: process.env.AI_LEAGUE_AGENT_PERSONALITY?.trim() || undefined,
    });
  }
  if (brainMode === "openrouter") {
    if (provider === null) {
      throw new LlmProviderConfigError(
        "openrouter smoke requested but no provider was configured.",
      );
    }
    // Full LLM authority: the model picks the LegalAction.id directly each step.
    return new LlmAgentBrain({
      provider,
      profile: spec.profile,
      brainType: "llm",
      runtimeMode: "llm-action-selector",
      providerTimeoutMs,
      includePromptInMetadata: false,
      personality: process.env.AI_LEAGUE_AGENT_PERSONALITY?.trim() || undefined,
    });
  }
  throw new Error(`Unsupported brain mode: ${brainMode}`);
}

function commanderProviderTimeoutBelowOuter(
  outerTimeoutMs: number | undefined,
): number | undefined {
  if (outerTimeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(outerTimeoutMs) || outerTimeoutMs <= 1) {
    throw new Error(
      "Strategic Commander requires an outer decision timeout above 1ms",
    );
  }
  return Math.min(12_000, outerTimeoutMs - 1);
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
  // Reflected if the player now owns a unit of the built type. The earlier check
  // required a unit on EXACTLY chosenActionMetadata.buildTile, which spuriously failed
  // legitimate builds whose decision metadata omits buildTile (e.g. a directive- or
  // bootstrap-forced economy build) — failing whole beta games even though the structure
  // was built. A genuinely unreflected build (zero units of the type) still throws. See
  // decision-log 2026-06-20.
  const builtCount = player?.units(selected.intent.unit).length ?? 0;
  if (builtCount === 0) {
    throw new Error(
      "action smoke failed: accepted build intent was not reflected in mirrored core state",
    );
  }
}

type SmokeScenario = "league" | "attack" | "actions";
type SmokeBrainMode =
  | "rule"
  | "starter-bot"
  | "mock-llm"
  | "real-llm"
  | "codex-cli"
  | "planner"
  | "planner-codex-cli"
  | "planner-claude-cli"
  | "action-claude-cli"
  | "openrouter"
  | "planner-openrouter"
  | "strategic-commander"
  | "commander-v0-det"
  | "commander-v0-llm";
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
  if (brainMode === "action-claude-cli" || brainMode === "openrouter") {
    return "llm";
  }
  if (brainMode === "starter-bot") {
    // StarterBotAgentBrain.brainType === "rule" (a deterministic rule policy).
    return "rule";
  }
  if (
    brainMode === "strategic-commander" ||
    brainMode === "commander-v0-det" ||
    brainMode === "commander-v0-llm"
  ) {
    return "strategic-commander";
  }
  return brainMode === "planner" ||
    brainMode === "planner-codex-cli" ||
    brainMode === "planner-claude-cli" ||
    brainMode === "planner-openrouter"
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
    phase:
      input.gameState.getWinner() !== null
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
  const requireStrict = requiresExternalBrainSuccess(input.brainMode);
  // The fully-down guard runs for ANY real-LLM brain, even when the strict clean-run gate
  // is off (sponsored/live games set REQUIRE_EXTERNAL_BRAIN_SUCCESS=false to tolerate the
  // occasional "hold"/fallback). So only return early when there is nothing to check.
  const guardFullyDown = isExternalProviderBrain(input.brainMode);
  if (!requireStrict && !guardFullyDown) {
    return;
  }

  const report = externalBrainCleanlinessReport({
    // planner-claude-cli is an external-provider planner-executor brain, so it
    // shares the planner-codex-cli cleanliness semantics (clean external planner
    // calls with house fallbacks tolerated).
    brainMode:
      input.brainMode === "planner-claude-cli" ||
      input.brainMode === "planner-openrouter"
        ? "planner-codex-cli"
        : // action-claude-cli / openrouter are external-provider action selectors, so they
          // share the codex-cli cleanliness semantics (every decision must be a clean LLM call).
          input.brainMode === "action-claude-cli" ||
            input.brainMode === "openrouter"
          ? "codex-cli"
          : // starter-bot is a deterministic rule policy (no external calls) — same
            // cleanliness class as "rule".
            // Commander provider failures are absorbed by an attributable
            // same-option-set fallback plan and certified separately below.
            input.brainMode === "starter-bot" ||
              input.brainMode === "strategic-commander" ||
              input.brainMode === "commander-v0-det" ||
              input.brainMode === "commander-v0-llm"
            ? "rule"
            : input.brainMode,
    records: input.records,
  });

  // Fail loud when a real-LLM brain's provider is FULLY DOWN — every external call attempted
  // but none succeeded — INDEPENDENT of the strict gate. A match with zero successful LLM
  // calls ran 100% on the local-policy executor and must never be presented as the user's LLM
  // agent. Exposed 2026-06-20: the OpenRouter spend cap exhausted → 0% LLM, yet the sponsored
  // game (REQUIRE=false) silently "completed". (externalCalls===0 means no call was attempted —
  // e.g. a trivial all-spawn match — which is not a provider failure, so it is not caught here.)
  if (
    guardFullyDown &&
    report.externalCalls > 0 &&
    report.cleanExternalCalls === 0
  ) {
    throw new Error(
      `${input.brainMode} provider produced ZERO successful calls ` +
        `(${report.externalCalls} attempted, all failed) — sponsored play is unavailable ` +
        `(LLM provider down or over quota). Refusing to present a 100% local-policy match ` +
        `as an LLM agent. firstFailure=${report.firstFailureReason}`,
    );
  }

  if (!requireStrict) {
    return;
  }
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

/**
 * Stage 7 certification: a strategic-commander smoke must carry positive
 * evidence that the Commander actually commanded. A provider failure during
 * the match is still absorbed by the plan lifecycle's deterministic option
 * fallback, but a run where NO decision carries
 * commanderSelectedStrategicOptionId ran entirely on that fallback and must
 * never certify as Commander play.
 */
function assertCommanderSmokeSelectedStrategicOption(input: {
  brainMode: SmokeBrainMode;
  records: AgentDecisionRecord[];
}): void {
  if (!isCommanderLlmMode(input.brainMode)) {
    return;
  }
  const hasCommanderEvidence = input.records.some(
    (record) =>
      record.decisionMetadata?.commanderSelectedStrategicOptionId !== undefined,
  );
  if (hasCommanderEvidence) {
    return;
  }
  throw new Error(
    "strategic-commander smoke failed certification: no decision carries " +
      "commanderSelectedStrategicOptionId, so no Commander-authored plan was " +
      "ever executed and the whole match ran on fallback-authored plans. " +
      "Refusing to present a fallback-only run as Commander play.",
  );
}

function isCommanderLlmMode(brainMode: SmokeBrainMode): boolean {
  return (
    brainMode === "strategic-commander" || brainMode === "commander-v0-llm"
  );
}

/**
 * Brains that drive decisions through an external LLM provider (so a fully-down provider
 * means the match silently ran on the local-policy executor). Excludes rule / mock-llm /
 * planner (mock), which never make external calls.
 */
function isExternalProviderBrain(brainMode: SmokeBrainMode): boolean {
  return (
    brainMode === "codex-cli" ||
    brainMode === "planner-codex-cli" ||
    brainMode === "planner-claude-cli" ||
    brainMode === "action-claude-cli" ||
    brainMode === "planner-openrouter" ||
    brainMode === "openrouter" ||
    brainMode === "real-llm"
  );
}

function requiresExternalBrainSuccess(brainMode: SmokeBrainMode): boolean {
  if (process.env.AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS === "true") {
    return true;
  }
  if (brainMode !== "codex-cli" && brainMode !== "planner-codex-cli") {
    return false;
  }
  return process.env.AI_LEAGUE_REQUIRE_CODEX_SUCCESS === "true";
}

class StaticMapLoader implements GameMapLoader {
  private readonly maps = new Map<GameMapType, MapData>();
  private readonly rootDir: string;

  constructor() {
    const currentFile = fileURLToPath(import.meta.url);
    this.rootDir = path.resolve(
      path.dirname(currentFile),
      "../../resources/maps",
    );
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

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    await runAgentLeagueSmoke();
  } catch (error) {
    if (error instanceof LlmProviderConfigError) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
