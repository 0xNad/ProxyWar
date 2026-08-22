import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCliLlmProvider } from "../server/agents/ClaudeCliLlmProvider";
import {
  commanderArmTripletPathSegment,
  computeCommanderComponentHashes,
  writeCommanderArmInputArtifacts,
  writeCommanderArmReport,
} from "../server/agents/CommanderArmArtifacts";
import { assertScriptedCommanderBCEquivalence } from "../server/agents/CommanderArmEquivalence";
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
import {
  assertCommanderExperimentID,
  assertCommanderIdentityUnchanged,
  assertResolvedCommanderRuntime,
  captureCommanderSourceIdentity,
  COMMANDER_OUTER_DECISION_TIMEOUT_MS,
  commanderArmOrderForReplica,
  commanderConfirmatoryAnalysisSpecification,
  commanderExperimentOutputDirectory,
  newCommanderExperimentID,
  prepareCommanderProviderCwd,
  reserveCommanderExperimentOutput,
  resolveRealCommanderRuntime,
  resolveScriptedCommanderRuntime,
  withCommanderExperimentEnvironment,
  writeCommanderExperimentSeal,
  type CommanderArmOrder,
  type CommanderEvidenceProtocol,
  type CommanderExperimentPreRegistration,
  type CommanderSourceIdentity,
  type ResolvedCommanderRuntime,
} from "../server/agents/CommanderExperimentProtocol";
import { COMMANDER_PROMPT_VERSION } from "../server/agents/LlmOptionSelector";
import type { LlmProvider } from "../server/agents/LlmProvider";
import type { CommanderState } from "../server/agents/StrategicCommanderTypes";
import { selectDeterministicStrategicOption } from "../server/agents/StrategicOptionSelectors";
import {
  agentLeagueSmokeSelectedGameConfig,
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
  protocol?: CommanderEvidenceProtocol;
  sourceSha?: string;
  sourceTreeDirty?: boolean;
  writeReport?: boolean;
  /** Optional replay ID; omitted runs generate and preregister a fresh UUIDv4. */
  experimentID?: string;
  /** Bounded fault-injection seam for evidence-integrity tests only. */
  verificationHooks?: {
    afterArmPersisted?: (input: {
      arm: CommanderExperimentArm;
      replicaIndex: number;
      manifestPath: string | null;
    }) => void | Promise<void>;
    captureSourceIdentity?: () => Promise<CommanderSourceIdentity>;
    resolveRuntime?: () => ResolvedCommanderRuntime;
    resolveSocialFlags?: () => Pick<
      CommanderExperimentFlags,
      "structuredDeals" | "freeTextMessages"
    >;
  };
}

export interface CommanderArmGateResult {
  report: CommanderArmReport;
  jsonPath: string | null;
  markdownPath: string | null;
  runs: Record<CommanderExperimentArm, AgentLeagueSmokeArtifactWriterInput>;
  replicas: Array<
    Record<CommanderExperimentArm, AgentLeagueSmokeArtifactWriterInput>
  >;
  experimentID: string | null;
  preRegistrationManifestPath: string | null;
  sealPath: string | null;
  armExecutionOrders: Array<{
    replicaIndex: number;
    preregistered: CommanderArmOrder;
    executed: CommanderArmOrder;
  }>;
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
  const providerMode = options.providerMode ?? "scripted";
  const protocol =
    options.protocol ??
    (providerMode === "claude-cli" ? "technical-canary" : "plumbing");
  if (providerMode === "claude-cli" && protocol === "plumbing") {
    throw new Error(
      "real-provider Commander gates require technical-canary or confirmatory protocol",
    );
  }
  const sourceRoot = commanderGateSourceRoot();
  assertCommanderGateSourceRoot(process.cwd(), sourceRoot);
  const socialFlags = assertSocialExperimentFlagsOff(
    options.verificationHooks?.resolveSocialFlags?.() ??
      commanderSocialExperimentFlags(),
  );
  const baseSeed = options.seed ?? COMMANDER_LOCAL_SMOKE_DEFAULT_SEED;
  const baseRunID = options.runID ?? COMMANDER_LOCAL_SMOKE_DEFAULT_RUN_ID;
  if (providerMode === "scripted" && protocol !== "plumbing") {
    throw new Error("scripted Commander gates are plumbing protocol only");
  }
  if (
    providerMode === "claude-cli" &&
    options.verificationHooks !== undefined
  ) {
    throw new Error(
      "real-provider Commander experiments reject verification-hook runtime substitution",
    );
  }
  const replicaCount = boundedPositive(options.runs ?? 1, "runs");
  const startIndex = boundedNonNegative(options.startIndex ?? 0, "startIndex");
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
  if (
    providerMode === "claude-cli" &&
    ((protocol === "technical-canary" && replicaCount !== 4) ||
      (protocol === "confirmatory" && replicaCount !== 48) ||
      startIndex !== 0 ||
      maxSteps !== 60 ||
      turnsPerDecisionStep !== 100)
  ) {
    throw new Error(
      protocol === "technical-canary"
        ? "real technical canary requires runs=4, start-index=0, max-steps=60, and turns-per-decision-step=100"
        : "real confirmatory protocol requires runs=48, start-index=0, max-steps=60, and turns-per-decision-step=100",
    );
  }
  if (providerMode === "claude-cli" && options.writeReport === false) {
    throw new Error(
      "real-provider Commander experiments require durable evidence output",
    );
  }
  const experimentID = options.experimentID ?? newCommanderExperimentID();
  assertCommanderExperimentID(experimentID);
  const canonicalOutputDirectory = commanderExperimentOutputDirectory(
    sourceRoot,
    experimentID,
  );
  if (
    providerMode === "claude-cli" &&
    options.outputDirectory !== undefined &&
    path.resolve(options.outputDirectory) !== canonicalOutputDirectory
  ) {
    throw new Error(
      "real-provider Commander evidence must use the canonical UUID output root",
    );
  }
  const outputDirectory =
    providerMode === "claude-cli"
      ? canonicalOutputDirectory
      : path.resolve(options.outputDirectory ?? canonicalOutputDirectory);
  const actualSourceSha = currentSourceSha(sourceRoot);
  const actualSourceTreeDirty = currentSourceTreeDirty(sourceRoot);
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
  const captureSource =
    options.verificationHooks?.captureSourceIdentity ??
    (() => captureCommanderSourceIdentity(sourceRoot));
  const providerCwd =
    providerMode === "claude-cli"
      ? prepareCommanderProviderCwd(experimentID)
      : null;
  const resolveRuntime =
    options.verificationHooks?.resolveRuntime ??
    (providerMode === "claude-cli"
      ? () =>
          resolveRealCommanderRuntime(process.env, {}, providerCwd!, sourceRoot)
      : () => resolveScriptedCommanderRuntime(process.env, sourceRoot));
  const initialSourceIdentity = await captureSource();
  if (
    providerMode === "claude-cli" &&
    (!initialSourceIdentity.clean ||
      initialSourceIdentity.sourceSha !== actualSourceSha)
  ) {
    throw new Error(
      "real-provider Commander source identity is not the clean git HEAD",
    );
  }
  const initialRuntime = resolveRuntime();
  assertResolvedCommanderRuntime(initialRuntime);
  const modes = commanderArmModes(providerMode, initialRuntime);
  const modeByArm = Object.fromEntries(
    modes.map((mode) => [mode.arm, mode]),
  ) as Record<CommanderExperimentArm, CommanderArmMode>;
  const componentHashes = await computeCommanderComponentHashes(sourceRoot);
  const schedule = Array.from({ length: replicaCount }, (_unused, offset) => {
    const index = startIndex + offset;
    const runID = replicatedIdentity(baseRunID, index, replicaCount);
    const seed = replicatedIdentity(baseSeed, index, replicaCount);
    return {
      replicaIndex: index,
      runID,
      seed,
      gameID: commanderGameIDFromSeed(seed),
      subjectSeatIndex: index % 4,
      episodeIndex:
        protocol === "confirmatory" ? Math.floor(index / 4) % 4 : index % 4,
      armOrder: commanderArmOrderForReplica(index),
    };
  });
  if (new Set(schedule.map((entry) => entry.gameID)).size !== schedule.length) {
    throw new Error(
      "replicated Commander seeds collide on the same GameServer identity",
    );
  }
  const tripletPathSegments = schedule.map((entry) =>
    commanderArmTripletPathSegment(entry.runID),
  );
  if (new Set(tripletPathSegments).size !== schedule.length) {
    throw new Error("replicated Commander run IDs collide on an evidence path");
  }
  const sharedArgs = [
    "--runner=step-locked",
    `--turns-per-decision-step=${turnsPerDecisionStep}`,
    `--max-decision-ms=${COMMANDER_OUTER_DECISION_TIMEOUT_MS}`,
    `--max-steps=${maxSteps}`,
    "--agents=4",
    "--opponent-brain=starter-bot",
    ...(options.requireWinner === true ? ["--require-winner"] : []),
  ];
  const preRegistration: CommanderExperimentPreRegistration = {
    schemaVersion: 1,
    experimentKind: "strategic-commander-three-arm",
    experimentID,
    createdAt: new Date().toISOString(),
    source: initialSourceIdentity,
    runtime: initialRuntime.identity,
    configuration: {
      baseRunID,
      baseSeed,
      protocol,
      providerMode,
      replicaCount,
      startIndex,
      maxSteps,
      turnsPerDecisionStep,
      requireWinner: options.requireWinner === true,
      planEveryDecisionSteps: 3,
      sharedArgs,
      selectedGameConfig: agentLeagueSmokeSelectedGameConfig(sharedArgs),
      socialFlags,
      legacyComponentHashes: componentHashes,
      analysisSpecification:
        protocol === "confirmatory"
          ? commanderConfirmatoryAnalysisSpecification()
          : null,
      arms: modes.map((mode) => ({
        arm: mode.arm,
        brain: mode.brain,
        provenance: mode.provenance,
      })),
    },
    seeds: schedule,
    expectedArmManifestPaths: schedule.flatMap((entry) =>
      entry.armOrder.map(
        (arm) =>
          `inputs/${commanderArmTripletPathSegment(entry.runID)}/${arm}/commander-arm-manifest.json`,
      ),
    ),
  };
  const writeEvidence = options.writeReport !== false;
  let preRegistrationManifestPath: string | null = null;
  let preRegistrationManifestSha256: string | null = null;
  if (writeEvidence) {
    const reservation = await reserveCommanderExperimentOutput({
      outputDirectory,
      manifest: preRegistration,
      ...(providerMode === "claude-cli" ? { containmentRoot: sourceRoot } : {}),
    });
    preRegistrationManifestPath = reservation.manifestPath;
    preRegistrationManifestSha256 = reservation.envelope.manifestSha256;
  }
  const replicas: Array<
    Record<CommanderExperimentArm, AgentLeagueSmokeArtifactWriterInput>
  > = [];
  const persistedInputs: Array<{
    run: CommanderArmRunInput;
    captured: AgentLeagueSmokeArtifactWriterInput;
  }> = [];
  let jsonPath: string | null = null;
  let markdownPath: string | null = null;
  let sealPath: string | null = null;
  const manifestPaths: string[] = [];
  const armExecutionOrders: CommanderArmGateResult["armExecutionOrders"] = [];
  try {
    await withCommanderExperimentEnvironment(
      initialRuntime.behaviorEnvironment,
      async () => {
        for (const entry of schedule) {
          const deterministicSource = {
            seed: entry.seed,
            gameID: entry.gameID,
            gameIDDerivation: COMMANDER_GAME_ID_DERIVATION_VERSION,
            createdAtMs: 1_700_000_000_000 + entry.replicaIndex,
            playbackTurnIntervalMs: 1,
          };
          const captured = {} as Record<
            CommanderExperimentArm,
            AgentLeagueSmokeArtifactWriterInput
          >;
          const executedOrder: CommanderExperimentArm[] = [];
          for (const arm of entry.armOrder) {
            const mode = modeByArm[arm];
            executedOrder.push(arm);
            const writes: AgentLeagueSmokeArtifactWriterInput[] = [];
            await runAgentLeagueSmoke({
              args: [
                `--brain=${mode.brain}`,
                ...sharedArgs,
                `--run-id=${entry.runID}`,
              ],
              deterministicSource,
              planEveryDecisionSteps: 3,
              forceOfferedOrderSpawnBallotForExperiment: true,
              subjectSeatIndexForExperiment: entry.subjectSeatIndex,
              episodeIndexForExperiment: entry.episodeIndex,
              commanderExperimentProvenance: mode.provenance,
              allowEnvironmentStrategySpec: false,
              ...(mode.provider === undefined
                ? {}
                : mode.brain === "planner-claude-cli"
                  ? { claudeProviderForExperiment: mode.provider }
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
            const capturedArm = writes[0]!;
            captured[mode.arm] = capturedArm;
            const persistedInput = {
              run: armRunInput({
                arm: mode.arm,
                captured: capturedArm,
                seed: entry.seed,
                runID: entry.runID,
                protocol,
                replicaIndex: entry.replicaIndex,
                armOrder: entry.armOrder,
                armExecutionIndex: executedOrder.length - 1,
                subjectSeatIndex: entry.subjectSeatIndex,
                episodeIndex: entry.episodeIndex,
                analysisSpecification:
                  protocol === "confirmatory"
                    ? commanderConfirmatoryAnalysisSpecification()
                    : null,
                sourceSha,
                sourceTreeDirty,
                runtimeIdentitySha256: initialRuntime.identity.identitySha256,
                preRegistrationManifestSha256,
                componentHashes,
                socialFlags,
                localSmoke: providerMode === "scripted",
              }),
              captured: capturedArm,
            };
            persistedInputs.push(persistedInput);
            let manifestPath: string | null = null;
            if (writeEvidence) {
              manifestPath = await writeCommanderArmInputArtifacts({
                comparisonDirectory: outputDirectory,
                ...(providerMode === "claude-cli"
                  ? { containmentRoot: sourceRoot }
                  : {}),
                run: persistedInput.run,
                artifactInput: persistedInput.captured.artifactInput,
              });
              manifestPaths.push(manifestPath);
            }
            await options.verificationHooks?.afterArmPersisted?.({
              arm: mode.arm,
              replicaIndex: entry.replicaIndex,
              manifestPath,
            });
            const currentRuntime = resolveRuntime();
            assertResolvedCommanderRuntime(currentRuntime);
            assertCommanderIdentityUnchanged({
              initialSource: initialSourceIdentity,
              currentSource: await captureSource(),
              initialRuntime: initialRuntime.identity,
              currentRuntime: currentRuntime.identity,
            });
          }
          if (
            JSON.stringify(executedOrder) !== JSON.stringify(entry.armOrder)
          ) {
            throw new Error(
              "Commander executed arm order drifted from preregistration",
            );
          }
          armExecutionOrders.push({
            replicaIndex: entry.replicaIndex,
            preregistered: entry.armOrder,
            executed: [...executedOrder] as unknown as CommanderArmOrder,
          });
          if (providerMode === "scripted") {
            const bSubject = fixedSubject(captured.B, entry.subjectSeatIndex);
            const cSubject = fixedSubject(captured.C, entry.subjectSeatIndex);
            assertScriptedCommanderBCEquivalence({
              bSubjectAgentID: bSubject.agentID,
              bRecords: captured.B.artifactInput.records,
              cSubjectAgentID: cSubject.agentID,
              cRecords: captured.C.artifactInput.records,
              minimumActiveCycles: maxSteps >= 7 ? 7 : 0,
              minimumInstalledPlans: maxSteps >= 7 ? 3 : 0,
            });
          }
          replicas.push(captured);
        }
      },
    );

    if (writeEvidence) {
      assertExpectedArmManifests(
        outputDirectory,
        preRegistration.expectedArmManifestPaths,
        manifestPaths,
      );
    }
    let report = buildCommanderArmReport(
      persistedInputs.map((entry) => entry.run),
    );
    if (
      options.requireWinner === true &&
      persistedInputs.some(
        ({ run }) =>
          !run.completed ||
          run.winner === undefined ||
          run.finalState?.phase !== "finished",
      )
    ) {
      throw new Error(
        "Commander require-winner experiment ended without a terminal winner in every arm",
      );
    }
    // Evidence is not publishable until the final source/runtime recapture is
    // successful and matches the preregistered identities.
    const finalSource = await captureSource();
    const finalRuntime = resolveRuntime();
    assertResolvedCommanderRuntime(finalRuntime);
    assertCommanderIdentityUnchanged({
      initialSource: initialSourceIdentity,
      currentSource: finalSource,
      initialRuntime: initialRuntime.identity,
      currentRuntime: finalRuntime.identity,
    });
    if (writeEvidence) {
      jsonPath = path.join(outputDirectory, "commander-three-arm.json");
      markdownPath = path.join(outputDirectory, "commander-three-arm.md");
      const persisted = await writeCommanderArmReport({
        comparisonDirectory: outputDirectory,
        ...(providerMode === "claude-cli"
          ? { containmentRoot: sourceRoot }
          : {}),
        manifestPaths,
      });
      report = persisted.report;
      jsonPath = persisted.jsonPath;
      markdownPath = persisted.markdownPath;
      if (providerMode === "claude-cli") {
        const protocolEligible =
          protocol === "technical-canary"
            ? report.technicalCanaryEligibility.eligible
            : report.performanceClaimsAllowed;
        if (!report.integrity.valid || !protocolEligible) {
          throw new Error(
            "Commander real-provider evidence failed its preregistered report gates",
          );
        }
      }
      const sealed = await writeCommanderExperimentSeal({
        outputDirectory,
        ...(providerMode === "claude-cli"
          ? { containmentRoot: sourceRoot }
          : {}),
        seal: {
          schemaVersion: 1,
          experimentKind: "strategic-commander-three-arm-seal",
          experimentID,
          status: "complete",
          reasons: [],
          preRegistrationManifestSha256: preRegistrationManifestSha256!,
          finalSource,
          finalRuntime: finalRuntime.identity,
          recapture: {
            source: "captured",
            runtime: "captured",
            sourceFailure: null,
            runtimeFailure: null,
          },
        },
        artifactPaths: [
          preRegistrationManifestPath!,
          ...manifestPaths,
          jsonPath!,
          markdownPath!,
        ],
      });
      sealPath = sealed.sealPath;
    }
    return {
      report,
      jsonPath,
      markdownPath,
      runs: replicas[0]!,
      replicas,
      experimentID,
      preRegistrationManifestPath,
      sealPath,
      armExecutionOrders,
    };
  } catch (error) {
    if (writeEvidence && preRegistrationManifestSha256 !== null) {
      const reason = boundedExperimentFailure(error);
      const recaptured = await recaptureInvalidExperimentIdentity(
        captureSource,
        resolveRuntime,
      );
      try {
        const sealed = await writeCommanderExperimentSeal({
          outputDirectory,
          ...(providerMode === "claude-cli"
            ? { containmentRoot: sourceRoot }
            : {}),
          seal: {
            schemaVersion: 1,
            experimentKind: "strategic-commander-three-arm-seal",
            experimentID,
            status: "invalid",
            reasons: [reason],
            preRegistrationManifestSha256,
            finalSource: recaptured.source,
            finalRuntime: recaptured.runtime?.identity ?? null,
            recapture: recaptured.status,
          },
          artifactPaths: [
            preRegistrationManifestPath!,
            ...manifestPaths,
            ...(jsonPath === null ? [] : [jsonPath]),
            ...(markdownPath === null ? [] : [markdownPath]),
          ].filter(existingRealFile),
        });
        sealPath = sealed.sealPath;
      } catch (sealError) {
        throw new AggregateError(
          [error, sealError],
          "Commander experiment failed and its invalid seal could not be written",
          { cause: sealError },
        );
      }
    }
    throw error;
  }
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
  runtime: ResolvedCommanderRuntime,
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
  if (runtime.providerConfig === null) {
    throw new Error("real-provider Commander runtime has no provider config");
  }
  const provider = new ClaudeCliLlmProvider(runtime.providerConfig);
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
      provider,
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
  protocol: CommanderEvidenceProtocol;
  replicaIndex: number;
  armOrder: CommanderArmOrder;
  armExecutionIndex: number;
  subjectSeatIndex: number;
  episodeIndex: number;
  analysisSpecification: CommanderArmRunInput["analysisSpecification"];
  sourceSha: string;
  sourceTreeDirty: boolean;
  runtimeIdentitySha256: string;
  preRegistrationManifestSha256: string | null;
  componentHashes: Awaited<ReturnType<typeof computeCommanderComponentHashes>>;
  socialFlags: Pick<
    CommanderExperimentFlags,
    "structuredDeals" | "freeTextMessages"
  >;
  localSmoke: boolean;
}): CommanderArmRunInput {
  const artifact = input.captured.artifactInput;
  const subject = artifact.roster[input.subjectSeatIndex];
  if (subject === undefined) {
    throw new Error(`Arm ${input.arm} has no subject seat`);
  }
  const gameConfiguration = sharedGameConfiguration(
    input.captured.executionConfig,
  );
  const provisional: CommanderArmRunInput = {
    tripletID: input.runID,
    arm: input.arm,
    protocol: input.protocol,
    replicaIndex: input.replicaIndex,
    subjectSeatIndex: input.subjectSeatIndex,
    episodeIndex: input.episodeIndex,
    armOrder: input.armOrder,
    armExecutionIndex: input.armExecutionIndex,
    sourceSha: input.sourceSha,
    sourceTreeDirty: input.sourceTreeDirty,
    runtimeIdentitySha256: input.runtimeIdentitySha256,
    preRegistrationManifestSha256: input.preRegistrationManifestSha256,
    seed: input.seed,
    runID: input.runID,
    selectorSource: null,
    provider: null,
    model: null,
    promptVersion: null,
    analysisSpecification: input.analysisSpecification,
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
        ? config.subjectSeatIndex === undefined
          ? "subject-seat-0-vs-starter-bot"
          : "rotating-subject-vs-starter-bot"
        : config.opponentBrainMode === null
          ? "uniform-brain"
          : config.subjectSeatIndex === undefined
            ? "subject-seat-0-vs-opponent-brain"
            : "rotating-subject-vs-opponent-brain",
  };
}

function fixedSubject(
  captured: AgentLeagueSmokeArtifactWriterInput,
  subjectSeatIndex: number,
) {
  const subject = captured.artifactInput.roster[subjectSeatIndex];
  if (subject === undefined) {
    throw new Error(
      "Commander matched subject seat is missing from the roster",
    );
  }
  return subject;
}

async function recaptureInvalidExperimentIdentity(
  capture: () => Promise<CommanderSourceIdentity>,
  resolve: () => ResolvedCommanderRuntime,
): Promise<{
  source: CommanderSourceIdentity | null;
  runtime: ResolvedCommanderRuntime | null;
  status: {
    source: "captured" | "unavailable";
    runtime: "captured" | "unavailable";
    sourceFailure: string | null;
    runtimeFailure: string | null;
  };
}> {
  let source: CommanderSourceIdentity | null = null;
  let sourceFailure: string | null = null;
  try {
    source = await capture();
  } catch (error) {
    sourceFailure = boundedExperimentFailure(error);
  }
  let runtime: ResolvedCommanderRuntime | null = null;
  let runtimeFailure: string | null = null;
  try {
    runtime = resolve();
    assertResolvedCommanderRuntime(runtime);
  } catch (error) {
    runtimeFailure = boundedExperimentFailure(error);
  }
  return {
    source,
    runtime,
    status: {
      source: source === null ? "unavailable" : "captured",
      runtime: runtime === null ? "unavailable" : "captured",
      sourceFailure,
      runtimeFailure,
    },
  };
}

function boundedExperimentFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const category = /source identity drifted/i.test(message)
    ? "source_identity_drift"
    : /runtime identity drifted/i.test(message)
      ? "runtime_identity_drift"
      : /timed out/i.test(message)
        ? "timeout"
        : "experiment_failure";
  return [
    `category=${category}`,
    `errorType=${name.replace(/[^A-Za-z0-9_.-]/g, "_")}`,
    `diagnosticBytes=${Buffer.byteLength(message, "utf8")}`,
    `diagnosticSha256=${createHash("sha256").update(message).digest("hex")}`,
  ].join(" ");
}

function existingRealFile(value: string): boolean {
  if (!existsSync(value)) return false;
  const stat = lstatSync(value);
  return stat.isFile() && !stat.isSymbolicLink();
}

function assertExpectedArmManifests(
  outputDirectory: string,
  expected: readonly string[],
  actual: readonly string[],
): void {
  const canonicalOutputDirectory = realpathSync(outputDirectory);
  const normalizedActual = actual
    .map((entry) =>
      path
        .relative(canonicalOutputDirectory, realpathSync(entry))
        .split(path.sep)
        .join("/"),
    )
    .sort();
  const normalizedExpected = [...expected].sort();
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(
      "Commander persisted arm manifests disagree with pre-registration",
    );
  }
}

export function commanderSocialExperimentFlags(
  env: NodeJS.ProcessEnv = process.env,
): Pick<
  CommanderExperimentFlags,
  "structuredDeals" | "freeTextMessages"
> {
  return {
    structuredDeals: numericFlag(env.PROXYWAR_TUNE_STRUCTURED_DEALS),
    freeTextMessages: numericFlag(env.PROXYWAR_TUNE_FREETEXT_MESSAGES),
  };
}

function assertSocialExperimentFlagsOff(
  flags: Pick<
    CommanderExperimentFlags,
    "structuredDeals" | "freeTextMessages"
  >,
): Pick<
  CommanderExperimentFlags,
  "structuredDeals" | "freeTextMessages"
> {
  if (flags.structuredDeals || flags.freeTextMessages) {
    throw new Error("Commander arm gate requires social experiment flags OFF");
  }
  return flags;
}

function numericFlag(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1;
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

export function commanderGateSourceRoot(): string {
  return realpathSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  );
}

export function assertCommanderGateSourceRoot(
  workingDirectory: string,
  moduleSourceRoot: string = commanderGateSourceRoot(),
): void {
  if (realpathSync(workingDirectory) !== realpathSync(moduleSourceRoot)) {
    throw new Error(
      "Commander arm gate must run from the exact checkout that owns the executed module",
    );
  }
}

function currentSourceSha(sourceRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
}

function currentSourceTreeDirty(sourceRoot: string): boolean {
  return (
    execFileSync("git", ["status", "--porcelain"], {
      cwd: sourceRoot,
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

function protocolArg(
  args: readonly string[],
): CommanderEvidenceProtocol | undefined {
  const value = stringArg(args, "--protocol=");
  if (value === undefined) return undefined;
  if (
    value !== "plumbing" &&
    value !== "technical-canary" &&
    value !== "confirmatory"
  ) {
    throw new Error(
      "--protocol must be plumbing, technical-canary, or confirmatory",
    );
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
    protocol: protocolArg(args),
    experimentID: stringArg(args, "--experiment-id="),
  });
  console.log("StrategicCommanderV0 three-arm plumbing gate", {
    status: result.report.status,
    integrity: result.report.integrity,
    jsonPath: result.jsonPath,
    markdownPath: result.markdownPath,
    experimentID: result.experimentID,
    sealPath: result.sealPath,
  });
  if (!result.report.integrity.valid) {
    process.exitCode = 1;
  }
}
