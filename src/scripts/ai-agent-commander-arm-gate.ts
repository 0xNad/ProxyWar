import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  freeTextMessagesEnabled,
  structuredDealsEnabled,
} from "../server/agents/AgentTunables";
import { createClaudeCliLlmProviderFromEnv } from "../server/agents/ClaudeCliLlmProvider";
import {
  computeCommanderComponentHashes,
  writeCommanderArmInputArtifacts,
  writeCommanderArmReport,
} from "../server/agents/CommanderArmArtifacts";
import {
  buildCommanderArmReport,
  deriveCommanderPlanStartProvenance,
  fingerprintCommanderExperimentValue,
  type CommanderArmReport,
  type CommanderArmRunInput,
  type CommanderExperimentArm,
  type CommanderExperimentFlags,
  type CommanderMatchedGameConfiguration,
} from "../server/agents/CommanderArmReport";
import {
  COMMANDER_GAME_ID_DERIVATION_VERSION,
  commanderGameIDFromSeed,
} from "../server/agents/CommanderExperimentIdentity";
import { COMMANDER_PROMPT_VERSION } from "../server/agents/LlmOptionSelector";
import type { LlmProvider } from "../server/agents/LlmProvider";
import type { CommanderState } from "../server/agents/StrategicCommanderTypes";
import { selectDeterministicStrategicOption } from "../server/agents/StrategicOptionSelectors";
import {
  PLANNER_RUNTIME_PROMPT_VERSION,
  runAgentLeagueSmoke,
  type AgentLeagueSmokeArtifactWriterInput,
} from "./ai-agent-league-smoke";

export const COMMANDER_LOCAL_SMOKE_DEFAULT_SEED =
  "strategic-commander-v0-stage5-local-smoke";
export const COMMANDER_LOCAL_SMOKE_DEFAULT_RUN_ID =
  "strategic-commander-v0-stage5-local-smoke";

export type CommanderArmGateProviderMode = "scripted" | "claude-cli";

export interface CommanderArmGateOptions {
  outputDirectory?: string;
  seed?: string;
  runID?: string;
  maxSteps?: number;
  turnsPerDecisionStep?: number;
  requireWinner?: boolean;
  runs?: number;
  startIndex?: number;
  providerMode?: CommanderArmGateProviderMode;
  sourceSha?: string;
  sourceTreeDirty?: boolean;
  writeReport?: boolean;
}

export interface CommanderArmGateResult {
  report: CommanderArmReport;
  jsonPath: string | null;
  markdownPath: string | null;
  runs: Record<CommanderExperimentArm, AgentLeagueSmokeArtifactWriterInput>;
  replicas: Array<
    Record<CommanderExperimentArm, AgentLeagueSmokeArtifactWriterInput>
  >;
}

interface CommanderArmMode {
  arm: CommanderExperimentArm;
  brain:
    | "planner"
    | "planner-claude-cli"
    | "commander-v0-det"
    | "commander-v0-llm";
  provider?: LlmProvider;
  provenance: {
    provider: string | null;
    model: string | null;
    promptVersion: string | null;
  };
}

/**
 * One-command, three-arm canonical step-locked plumbing smoke. It uses a
 * scripted Arm C provider by design and therefore can never be presented as
 * evidence of strategic performance or LLM value.
 */
export async function runCommanderArmGate(
  options: CommanderArmGateOptions = {},
): Promise<CommanderArmGateResult> {
  process.env.GAME_ENV ??= "dev";
  const socialFlags = assertSocialExperimentFlagsOff();
  const baseSeed = options.seed ?? COMMANDER_LOCAL_SMOKE_DEFAULT_SEED;
  const baseRunID = options.runID ?? COMMANDER_LOCAL_SMOKE_DEFAULT_RUN_ID;
  const providerMode = options.providerMode ?? "scripted";
  const replicaCount = boundedPositive(options.runs ?? 1, "runs");
  const startIndex = boundedNonNegative(options.startIndex ?? 0, "startIndex");
  if (providerMode === "claude-cli" && replicaCount < 2) {
    throw new Error(
      "real-provider Commander experiments require at least 2 matched triplets",
    );
  }
  if (providerMode === "claude-cli" && options.requireWinner !== true) {
    throw new Error(
      "real-provider Commander experiments require --require-winner",
    );
  }
  const maxSteps = boundedPositive(
    options.maxSteps ?? (providerMode === "claude-cli" ? 18 : 3),
    "maxSteps",
  );
  const turnsPerDecisionStep = boundedPositive(
    options.turnsPerDecisionStep ?? (providerMode === "claude-cli" ? 100 : 25),
    "turnsPerDecisionStep",
  );
  const actualSourceSha = currentSourceSha();
  const actualSourceTreeDirty = currentSourceTreeDirty();
  if (
    providerMode === "claude-cli" &&
    options.sourceSha !== undefined &&
    options.sourceSha !== actualSourceSha
  ) {
    throw new Error(
      "real-provider Commander sourceSha override disagrees with git HEAD",
    );
  }
  if (
    providerMode === "claude-cli" &&
    options.sourceTreeDirty !== undefined &&
    options.sourceTreeDirty !== actualSourceTreeDirty
  ) {
    throw new Error(
      "real-provider Commander sourceTreeDirty override disagrees with git status",
    );
  }
  const sourceSha =
    providerMode === "claude-cli"
      ? actualSourceSha
      : (options.sourceSha ?? actualSourceSha);
  const sourceTreeDirty =
    providerMode === "claude-cli"
      ? actualSourceTreeDirty
      : (options.sourceTreeDirty ?? actualSourceTreeDirty);
  if (providerMode === "claude-cli" && sourceTreeDirty) {
    throw new Error(
      "real-provider Commander experiments require a clean source tree",
    );
  }
  const componentHashes = await computeCommanderComponentHashes();
  const replicas: Array<
    Record<CommanderExperimentArm, AgentLeagueSmokeArtifactWriterInput>
  > = [];
  const executedGameIDs = new Set<string>();
  const persistedInputs: Array<{
    run: CommanderArmRunInput;
    captured: AgentLeagueSmokeArtifactWriterInput;
  }> = [];
  for (let offset = 0; offset < replicaCount; offset++) {
    const index = startIndex + offset;
    const runID = replicatedIdentity(baseRunID, index, replicaCount);
    const seed = replicatedIdentity(baseSeed, index, replicaCount);
    const gameID = commanderGameIDFromSeed(seed);
    if (executedGameIDs.has(gameID)) {
      throw new Error(
        "replicated Commander seeds collide on the same GameServer identity",
      );
    }
    executedGameIDs.add(gameID);
    const deterministicSource = {
      seed,
      gameID,
      gameIDDerivation: COMMANDER_GAME_ID_DERIVATION_VERSION,
      createdAtMs: 1_700_000_000_000 + index,
      playbackTurnIntervalMs: 1,
    };
    const sharedArgs = [
      "--runner=step-locked",
      `--turns-per-decision-step=${turnsPerDecisionStep}`,
      "--max-decision-ms=5000",
      `--max-steps=${maxSteps}`,
      "--agents=4",
      "--opponent-brain=starter-bot",
      `--run-id=${runID}`,
      ...(options.requireWinner === true ? ["--require-winner"] : []),
    ];
    const modes = commanderArmModes(providerMode);
    const captured = {} as Record<
      CommanderExperimentArm,
      AgentLeagueSmokeArtifactWriterInput
    >;
    for (const mode of modes) {
      const writes: AgentLeagueSmokeArtifactWriterInput[] = [];
      await runAgentLeagueSmoke({
        args: [`--brain=${mode.brain}`, ...sharedArgs],
        deterministicSource,
        forceOfferedOrderSpawnBallotForExperiment: true,
        commanderExperimentProvenance: mode.provenance,
        allowEnvironmentStrategySpec: false,
        ...(mode.provider === undefined
          ? {}
          : providerMode === "claude-cli"
            ? { commanderProviderForExperiment: mode.provider }
            : { commanderProviderForTesting: mode.provider }),
        artifactWriter: async (input) => {
          writes.push(input);
          return {};
        },
      });
      if (writes.length !== 1) {
        throw new Error(
          `Arm ${mode.arm} emitted ${writes.length} artifact writes`,
        );
      }
      captured[mode.arm] = writes[0]!;
      persistedInputs.push({
        run: armRunInput({
          arm: mode.arm,
          captured: writes[0]!,
          seed,
          runID,
          sourceSha,
          sourceTreeDirty,
          componentHashes,
          socialFlags,
          localSmoke: providerMode === "scripted",
        }),
        captured: writes[0]!,
      });
    }
    replicas.push(captured);
  }

  const runInputs = persistedInputs.map((entry) => entry.run);
  const outputDirectory = path.resolve(
    options.outputDirectory ??
      path.join(
        process.cwd(),
        "artifacts",
        "ai-learning-comparisons",
        safeComparisonID(baseRunID),
      ),
  );
  let report = buildCommanderArmReport(runInputs);
  let jsonPath: string | null = null;
  let markdownPath: string | null = null;
  if (options.writeReport !== false) {
    const manifestPaths = await Promise.all(
      persistedInputs.map(({ run, captured }) =>
        writeCommanderArmInputArtifacts({
          comparisonDirectory: outputDirectory,
          run,
          artifactInput: captured.artifactInput,
        }),
      ),
    );
    const persisted = await writeCommanderArmReport({
      comparisonDirectory: outputDirectory,
      manifestPaths,
    });
    report = persisted.report;
    jsonPath = persisted.jsonPath;
    markdownPath = persisted.markdownPath;
  }
  return {
    report,
    jsonPath,
    markdownPath,
    runs: replicas[0]!,
    replicas,
  };
}

class ScriptedDeterministicCommanderProvider implements LlmProvider {
  readonly providerType = "mock" as const;
  readonly model = "scripted-deterministic-plumbing-v1";

  async complete(prompt: string): Promise<string> {
    const state = commanderStateFromPrompt(prompt);
    const selection = selectDeterministicStrategicOption(state, state.options);
    return JSON.stringify(selection);
  }
}

function commanderArmModes(
  providerMode: CommanderArmGateProviderMode,
): CommanderArmMode[] {
  if (providerMode === "scripted") {
    return [
      {
        arm: "A",
        brain: "planner",
        provenance: {
          provider: "mock-llm",
          model: "mock-planner-v0",
          promptVersion: PLANNER_RUNTIME_PROMPT_VERSION,
        },
      },
      {
        arm: "B",
        brain: "commander-v0-det",
        provenance: { provider: null, model: null, promptVersion: null },
      },
      {
        arm: "C",
        brain: "commander-v0-llm",
        provider: new ScriptedDeterministicCommanderProvider(),
        provenance: {
          provider: "mock",
          model: "scripted-deterministic-plumbing-v1",
          promptVersion: COMMANDER_PROMPT_VERSION,
        },
      },
    ];
  }
  const provider = createClaudeCliLlmProviderFromEnv();
  if (provider.model === null) {
    throw new Error(
      "real-provider Commander experiments require an explicit AI_LEAGUE_CLAUDE_MODEL",
    );
  }
  const realProvenance = {
    provider: provider.providerType,
    model: provider.model,
  };
  return [
    {
      arm: "A",
      brain: "planner-claude-cli",
      provenance: {
        ...realProvenance,
        promptVersion: PLANNER_RUNTIME_PROMPT_VERSION,
      },
    },
    {
      arm: "B",
      brain: "commander-v0-det",
      provenance: { provider: null, model: null, promptVersion: null },
    },
    {
      arm: "C",
      brain: "commander-v0-llm",
      provider,
      provenance: {
        ...realProvenance,
        promptVersion: COMMANDER_PROMPT_VERSION,
      },
    },
  ];
}

function commanderStateFromPrompt(prompt: string): CommanderState {
  const startMarker = "COMMANDER_STATE_JSON:\n";
  const endMarker = "\nEND_COMMANDER_STATE_JSON";
  const start = prompt.indexOf(startMarker);
  const end = prompt.lastIndexOf(endMarker);
  if (start === -1 || end <= start) {
    throw new Error(
      "Stage 5 scripted provider received a non-Commander prompt",
    );
  }
  return JSON.parse(
    prompt.slice(start + startMarker.length, end),
  ) as CommanderState;
}

function armRunInput(input: {
  arm: CommanderExperimentArm;
  captured: AgentLeagueSmokeArtifactWriterInput;
  seed: string;
  runID: string;
  sourceSha: string;
  sourceTreeDirty: boolean;
  componentHashes: Awaited<ReturnType<typeof computeCommanderComponentHashes>>;
  socialFlags: Pick<
    CommanderExperimentFlags,
    "structuredDeals" | "freeTextMessages"
  >;
  localSmoke: boolean;
}): CommanderArmRunInput {
  const artifact = input.captured.artifactInput;
  const subject = artifact.roster[0];
  if (subject === undefined) {
    throw new Error(`Arm ${input.arm} has no subject seat`);
  }
  const gameConfiguration = sharedGameConfiguration(
    input.captured.executionConfig,
  );
  const provisional: CommanderArmRunInput = {
    tripletID: input.runID,
    arm: input.arm,
    sourceSha: input.sourceSha,
    sourceTreeDirty: input.sourceTreeDirty,
    seed: input.seed,
    runID: input.runID,
    selectorSource: null,
    provider: null,
    model: null,
    promptVersion: null,
    componentHashes: input.componentHashes,
    artifactProvenance: null,
    experimentFlags: {
      localSmoke: input.localSmoke,
      structuredDeals: input.socialFlags.structuredDeals,
      freeTextMessages: input.socialFlags.freeTextMessages,
      optionExposureUsesDeterministicPreference: false,
      matchedOfferedOrderSpawnBallot:
        input.captured.executionConfig.runner.matchedOfferedOrderSpawnBallot ===
        true,
      autopilotEndgameSteps:
        input.captured.executionConfig.runner.autopilotEndgameSteps,
      requireWinner: input.captured.executionConfig.runner.requireWinner,
    },
    gameConfiguration,
    gameConfigurationFingerprint:
      fingerprintCommanderExperimentValue(gameConfiguration),
    roster: artifact.roster,
    subjectAgentID: subject.agentID,
    records: artifact.records,
    finalState: artifact.finalState,
    winner: input.captured.winner,
    turnCount: input.captured.turnCount,
    localSmoke: input.localSmoke,
    requireWinner: input.captured.executionConfig.runner.requireWinner,
    completed:
      input.captured.winner !== undefined &&
      artifact.finalState?.phase === "finished",
    autopilotEngagedAtStep:
      artifact.runnerConfig?.autopilotEngagedAtStep ?? null,
  };
  const actual = deriveCommanderPlanStartProvenance(provisional);
  return {
    ...provisional,
    selectorSource: actual.selectorSource,
    provider: actual.provider,
    model: actual.model,
    promptVersion: actual.promptVersion,
  };
}

function sharedGameConfiguration(
  config: AgentLeagueSmokeArtifactWriterInput["executionConfig"],
): CommanderMatchedGameConfiguration {
  if (
    config.agents === undefined ||
    config.opponentBrainMode === undefined ||
    config.selectedGameConfig === undefined ||
    config.runner.matchedOfferedOrderSpawnBallot === undefined
  ) {
    throw new Error("Commander execution config is missing matched-run fields");
  }
  return {
    schemaVersion: config.schemaVersion,
    scenario: config.scenario,
    runnerMode: config.runnerMode,
    agents: config.agents,
    opponentBrainMode: config.opponentBrainMode,
    planEveryDecisionSteps: config.planEveryDecisionSteps,
    runner: {
      turnsPerDecisionStep: config.runner.turnsPerDecisionStep,
      turnsPerDecisionSchedule:
        config.runner.turnsPerDecisionSchedule === null
          ? null
          : [...config.runner.turnsPerDecisionSchedule],
      maxDecisionMs: config.runner.maxDecisionMs,
      maxSteps: config.runner.maxSteps,
      maxSpawnAdvanceTurns: config.runner.maxSpawnAdvanceTurns,
      requireWinner: config.runner.requireWinner,
      waitForMirrorCatchup: config.runner.waitForMirrorCatchup,
      autopilotEndgameSteps: config.runner.autopilotEndgameSteps,
      replayTailTurns: config.runner.replayTailTurns,
      matchedOfferedOrderSpawnBallot:
        config.runner.matchedOfferedOrderSpawnBallot,
      variedSpawns: config.game.varySpawns,
    },
    selectedGameConfig: config.selectedGameConfig,
    disabledActionKinds: [...config.disabledActionKinds],
    rosterPolicy:
      config.opponentBrainMode === "starter-bot"
        ? "subject-seat-0-vs-starter-bot"
        : config.opponentBrainMode === null
          ? "uniform-brain"
          : "subject-seat-0-vs-opponent-brain",
  };
}

export function commanderSocialExperimentFlags(): Pick<
  CommanderExperimentFlags,
  "structuredDeals" | "freeTextMessages"
> {
  return {
    structuredDeals: structuredDealsEnabled(),
    freeTextMessages: freeTextMessagesEnabled(),
  };
}

function assertSocialExperimentFlagsOff(): Pick<
  CommanderExperimentFlags,
  "structuredDeals" | "freeTextMessages"
> {
  const flags = commanderSocialExperimentFlags();
  if (flags.structuredDeals || flags.freeTextMessages) {
    throw new Error("Commander arm gate requires social experiment flags OFF");
  }
  return flags;
}

function boundedPositive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
    throw new Error(`${label} must be an integer from 1 through 5000`);
  }
  return value;
}

function boundedNonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error(`${label} must be an integer from 0 through 1000000`);
  }
  return value;
}

function replicatedIdentity(
  base: string,
  index: number,
  replicaCount: number,
): string {
  return replicaCount === 1
    ? base
    : `${base}-r${String(index).padStart(4, "0")}`;
}

function safeComparisonID(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    throw new Error("runID cannot form a safe comparison directory");
  }
  return sanitized;
}

function currentSourceSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

function currentSourceTreeDirty(): boolean {
  return (
    execFileSync("git", ["status", "--porcelain"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim().length > 0
  );
}

function numberArg(
  args: readonly string[],
  prefix: string,
): number | undefined {
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return undefined;
  return Number(raw);
}

function stringArg(
  args: readonly string[],
  prefix: string,
): string | undefined {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function providerModeArg(
  args: readonly string[],
): CommanderArmGateProviderMode | undefined {
  const value = stringArg(args, "--provider-mode=");
  if (value === undefined) return undefined;
  if (value !== "scripted" && value !== "claude-cli") {
    throw new Error("--provider-mode must be scripted or claude-cli");
  }
  return value;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const args = process.argv.slice(2);
  const result = await runCommanderArmGate({
    outputDirectory: stringArg(args, "--output-dir="),
    seed: stringArg(args, "--seed="),
    runID: stringArg(args, "--run-id="),
    maxSteps: numberArg(args, "--max-steps="),
    turnsPerDecisionStep: numberArg(args, "--turns-per-decision-step="),
    requireWinner: args.includes("--require-winner"),
    runs: numberArg(args, "--runs="),
    startIndex: numberArg(args, "--start-index="),
    providerMode: providerModeArg(args),
  });
  console.log("StrategicCommanderV0 three-arm plumbing gate", {
    status: result.report.status,
    integrity: result.report.integrity,
    jsonPath: result.jsonPath,
    markdownPath: result.markdownPath,
  });
  if (!result.report.integrity.valid) {
    process.exitCode = 1;
  }
}
