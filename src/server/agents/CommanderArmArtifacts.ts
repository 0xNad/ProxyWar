import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Winner } from "../../core/Schemas";
import {
  writeAgentLeagueRunArtifacts,
  type AgentRunFinalState,
  type AgentRunRosterEntry,
  type WriteAgentLeagueRunArtifactsInput,
} from "./AgentDecisionLogWriter";
import type { AgentDecisionRecord } from "./AgentTypes";
import {
  buildCommanderArmReport,
  commanderArmReportJson,
  commanderArmReportMarkdown,
  fingerprintCommanderExperimentValue,
  type CommanderArmReport,
  type CommanderArmRunInput,
  type CommanderArtifactProvenance,
  type CommanderComponentHashes,
  type CommanderExperimentArm,
  type CommanderExperimentFlags,
  type CommanderMatchedGameConfiguration,
} from "./CommanderArmReport";
import {
  COMMANDER_GAME_ID_DERIVATION_VERSION,
  commanderGameIDFromSeed,
  parseCommanderCanonicalGameConfig,
} from "./CommanderExperimentIdentity";

const componentFiles = {
  sharedArchitecture: [
    "src/server/agents/StrategicCommanderBrain.ts",
    "src/server/agents/StrategicCommanderCaller.ts",
  ],
  optionBuilder: ["src/server/agents/StrategicOptionBuilder.ts"],
  stateBuilder: ["src/server/agents/CommanderStateBuilder.ts"],
  lifecycle: ["src/server/agents/CommanderPlanLifecycle.ts"],
  executorAndFidelity: [
    "src/server/agents/StrategicOptionExecutor.ts",
    "src/server/agents/StrategicOptionFidelity.ts",
  ],
} as const satisfies Record<keyof CommanderComponentHashes, readonly string[]>;

/** Content-addressed component identity; labels and filenames are not evidence. */
export async function computeCommanderComponentHashes(
  sourceRoot = process.cwd(),
): Promise<CommanderComponentHashes> {
  const entries = await Promise.all(
    Object.entries(componentFiles).map(async ([key, files]) => {
      const hash = createHash("sha256");
      for (const relativePath of files) {
        hash.update(relativePath);
        hash.update("\0");
        hash.update(await fs.readFile(path.join(sourceRoot, relativePath)));
        hash.update("\0");
      }
      return [key, hash.digest("hex")] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as CommanderComponentHashes;
}

export const COMMANDER_ARM_ARTIFACT_MANIFEST_SCHEMA_VERSION = 2;

type CommanderArmManifestRun = Omit<
  CommanderArmRunInput,
  "records" | "roster" | "finalState" | "winner" | "artifactProvenance"
>;

export interface CommanderArmArtifactManifest {
  schemaVersion: 2;
  experimentKind: "strategic-commander-arm-input";
  run: CommanderArmManifestRun;
  artifacts: {
    writer: "AgentDecisionLogWriter.writeAgentLeagueRunArtifacts";
    decisionsPath: string;
    decisionsSha256: string;
    summaryPath: string;
    summarySha256: string;
  };
}

export interface WriteCommanderArmInputArtifactsInput {
  comparisonDirectory: string;
  run: CommanderArmRunInput;
  artifactInput: WriteAgentLeagueRunArtifactsInput;
}

export interface WriteCommanderArmReportInput {
  comparisonDirectory: string;
  manifestPaths: readonly string[];
}

export interface CommanderArmReportArtifactPaths {
  report: CommanderArmReport;
  jsonPath: string;
  markdownPath: string;
  manifestPaths: string[];
}

/**
 * Persists one arm through the canonical decision-artifact writer, then writes
 * a small content-addressed manifest. The manifest deliberately contains no
 * decision body: report inputs are always reloaded from decisions.jsonl and
 * match-summary.json.
 */
export async function writeCommanderArmInputArtifacts(
  input: WriteCommanderArmInputArtifactsInput,
): Promise<string> {
  if (input.run.runID !== input.artifactInput.runID) {
    throw new Error("Commander arm runID disagrees with artifact writer input");
  }
  if (input.artifactInput.runnerConfig?.executionSeed !== input.run.seed) {
    throw new Error("Commander arm seed disagrees with artifact writer input");
  }
  if (
    JSON.stringify(input.artifactInput.winner) !==
    JSON.stringify(input.run.winner)
  ) {
    throw new Error(
      "Commander arm winner disagrees with artifact writer input",
    );
  }
  const armDirectory = path.join(
    path.resolve(input.comparisonDirectory),
    "inputs",
    safePathSegment(input.run.tripletID),
    input.run.arm,
  );
  await fs.mkdir(armDirectory, { recursive: true });
  const artifactPaths = await writeAgentLeagueRunArtifacts({
    ...input.artifactInput,
    rootDir: armDirectory,
  });
  const [decisionsSha256, summarySha256] = await Promise.all([
    sha256File(artifactPaths.decisionsPath),
    sha256File(artifactPaths.summaryPath),
  ]);
  const manifestPath = path.join(armDirectory, "commander-arm-manifest.json");
  const manifest: CommanderArmArtifactManifest = {
    schemaVersion: COMMANDER_ARM_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    experimentKind: "strategic-commander-arm-input",
    run: manifestRun(input.run),
    artifacts: {
      writer: "AgentDecisionLogWriter.writeAgentLeagueRunArtifacts",
      decisionsPath: path.relative(armDirectory, artifactPaths.decisionsPath),
      decisionsSha256,
      summaryPath: path.relative(armDirectory, artifactPaths.summaryPath),
      summarySha256,
    },
  };
  await writeTextAtomically(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifestPath;
}

/** Loads only allowlisted report fields from canonical persisted artifacts. */
export async function loadCommanderArmRunFromArtifacts(
  manifestPath: string,
  provenanceRoot = path.dirname(path.resolve(manifestPath)),
): Promise<CommanderArmRunInput> {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifest = parseManifest(
    JSON.parse(await fs.readFile(absoluteManifestPath, "utf8")) as unknown,
  );
  const manifestDirectory = path.dirname(absoluteManifestPath);
  const decisionsPath = resolveContainedArtifactPath(
    manifestDirectory,
    manifest.artifacts.decisionsPath,
  );
  const summaryPath = resolveContainedArtifactPath(
    manifestDirectory,
    manifest.artifacts.summaryPath,
  );
  const [decisionsSha256, summarySha256] = await Promise.all([
    sha256File(decisionsPath),
    sha256File(summaryPath),
  ]);
  if (decisionsSha256 !== manifest.artifacts.decisionsSha256) {
    throw new Error("Commander decisions artifact hash mismatch");
  }
  if (summarySha256 !== manifest.artifacts.summarySha256) {
    throw new Error("Commander summary artifact hash mismatch");
  }
  const summary = parseSummary(
    JSON.parse(await fs.readFile(summaryPath, "utf8")) as unknown,
  );
  if (summary.runID !== manifest.run.runID) {
    throw new Error("Commander summary runID disagrees with manifest");
  }
  const derivedSeed = requiredNonEmptyString(
    summary.runnerConfig?.executionSeed,
    "Commander execution seed",
  );
  if (derivedSeed !== manifest.run.seed) {
    throw new Error("Commander execution seed disagrees with manifest");
  }
  const derivedGameID = requiredNonEmptyString(
    summary.runnerConfig?.executionGameID,
    "Commander execution game identity",
  );
  if (
    summary.runnerConfig?.executionGameIDDerivation !==
    COMMANDER_GAME_ID_DERIVATION_VERSION
  ) {
    throw new Error("Commander execution game identity derivation is invalid");
  }
  if (
    derivedGameID !== summary.matchID ||
    derivedGameID !== commanderGameIDFromSeed(derivedSeed)
  ) {
    throw new Error(
      "Commander execution game identity disagrees with match summary",
    );
  }
  if (
    requiredBoolean(
      summary.runnerConfig?.structuredDealsEnabled,
      "Commander structured-deals runtime flag",
    ) !== manifest.run.experimentFlags.structuredDeals ||
    requiredBoolean(
      summary.runnerConfig?.freeTextMessagesEnabled,
      "Commander free-text runtime flag",
    ) !== manifest.run.experimentFlags.freeTextMessages
  ) {
    throw new Error(
      "Commander social experiment flags disagree with runtime summary",
    );
  }
  const gameConfiguration = gameConfigurationFromSummary(summary);
  const configuredAgentCount = requiredFiniteNumber(
    gameConfiguration.agents,
    "Commander agent count",
  );
  if (configuredAgentCount !== summary.roster.length) {
    throw new Error(
      "Commander configured agent count disagrees with canonical roster",
    );
  }
  const subject = summary.roster.find(
    (entry) => entry.agentID === manifest.run.subjectAgentID,
  );
  if (subject === undefined || subject.brainType !== summary.brainMode) {
    throw new Error(
      "Commander subject seat or brain mode disagrees with canonical roster",
    );
  }
  const gameConfigurationFingerprint =
    fingerprintCommanderExperimentValue(gameConfiguration);
  if (
    fingerprintCommanderExperimentValue(manifest.run.gameConfiguration) !==
      gameConfigurationFingerprint ||
    gameConfigurationFingerprint !== manifest.run.gameConfigurationFingerprint
  ) {
    throw new Error(
      "Commander game configuration disagrees with canonical match summary",
    );
  }
  const decisionLines = (await fs.readFile(decisionsPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const records = decisionLines.map((line, index) => {
    const entry = parseDecisionEntry(JSON.parse(line) as unknown, index);
    if (entry.runID !== summary.runID || entry.matchID !== summary.matchID) {
      throw new Error("Commander decision execution identity is inconsistent");
    }
    return decisionRecordFromEntry(entry, summary);
  });
  const derivedAutopilotEngagedAtStep =
    nullableFiniteNumber(summary.runnerConfig?.autopilotEngagedAtStep) ?? null;
  if (derivedAutopilotEngagedAtStep !== manifest.run.autopilotEngagedAtStep) {
    throw new Error(
      "Commander autopilot label disagrees with match-summary runnerConfig",
    );
  }
  const derivedRequireWinner = summary.runnerConfig?.requireWinner;
  if (
    typeof derivedRequireWinner !== "boolean" ||
    derivedRequireWinner !== manifest.run.requireWinner
  ) {
    throw new Error(
      "Commander require-winner label disagrees with match-summary runnerConfig",
    );
  }
  const finalState = summary.finalState ?? undefined;
  const winner = summary.winner;
  const completed = winner !== undefined && finalState?.phase === "finished";
  if (completed !== manifest.run.completed) {
    throw new Error(
      "Commander completion label disagrees with persisted artifacts",
    );
  }
  const derivedTurnCount = requiredFiniteNumber(
    finalState?.turnCount,
    "Commander final turn count",
  );
  if (derivedTurnCount !== manifest.run.turnCount) {
    throw new Error(
      "Commander turn-count label disagrees with persisted artifacts",
    );
  }
  const provenance: CommanderArtifactProvenance = {
    writer: manifest.artifacts.writer,
    manifestPath: relativeArtifactPath(provenanceRoot, absoluteManifestPath),
    decisionsPath: relativeArtifactPath(provenanceRoot, decisionsPath),
    decisionsSha256,
    summaryPath: relativeArtifactPath(provenanceRoot, summaryPath),
    summarySha256,
    executedRunID: summary.runID,
    executedMatchID: summary.matchID,
    executedSeed: derivedSeed,
    stepsCompleted:
      nullableFiniteNumber(summary.runnerConfig?.stepsCompleted) ?? null,
  };
  return {
    tripletID: manifest.run.tripletID,
    arm: manifest.run.arm,
    sourceSha: manifest.run.sourceSha,
    sourceTreeDirty: manifest.run.sourceTreeDirty,
    seed: manifest.run.seed,
    runID: manifest.run.runID,
    selectorSource: manifest.run.selectorSource,
    provider: manifest.run.provider,
    model: manifest.run.model,
    promptVersion: manifest.run.promptVersion,
    componentHashes: manifest.run.componentHashes,
    gameConfiguration,
    gameConfigurationFingerprint,
    artifactProvenance: provenance,
    experimentFlags: manifest.run.experimentFlags,
    roster: summary.roster,
    subjectAgentID: manifest.run.subjectAgentID,
    records,
    finalState,
    winner,
    turnCount: derivedTurnCount,
    localSmoke: manifest.run.localSmoke,
    completed,
    requireWinner: derivedRequireWinner,
    autopilotEngagedAtStep: derivedAutopilotEngagedAtStep,
  };
}

export async function loadCommanderArmRunsFromArtifacts(
  manifestPaths: readonly string[],
  provenanceRoot: string,
): Promise<CommanderArmRunInput[]> {
  return Promise.all(
    manifestPaths.map((manifestPath) =>
      loadCommanderArmRunFromArtifacts(manifestPath, provenanceRoot),
    ),
  );
}

/**
 * Artifact-backed report writer. It never accepts in-memory decision records,
 * preventing a caller from reporting a different corpus than the durable one.
 */
export async function writeCommanderArmReport(
  input: WriteCommanderArmReportInput,
): Promise<CommanderArmReportArtifactPaths> {
  const comparisonDirectory = path.resolve(input.comparisonDirectory);
  await fs.mkdir(comparisonDirectory, { recursive: true });
  const manifestPaths = input.manifestPaths.map((entry) => path.resolve(entry));
  const runs = await loadCommanderArmRunsFromArtifacts(
    manifestPaths,
    comparisonDirectory,
  );
  const report = buildCommanderArmReport(runs);
  const jsonPath = path.join(comparisonDirectory, "commander-three-arm.json");
  const markdownPath = path.join(comparisonDirectory, "commander-three-arm.md");
  await Promise.all([
    writeTextAtomically(jsonPath, commanderArmReportJson(report)),
    writeTextAtomically(markdownPath, commanderArmReportMarkdown(report)),
  ]);
  return { report, jsonPath, markdownPath, manifestPaths };
}

function manifestRun(run: CommanderArmRunInput): CommanderArmManifestRun {
  return {
    tripletID: run.tripletID,
    arm: run.arm,
    sourceSha: run.sourceSha,
    sourceTreeDirty: run.sourceTreeDirty,
    seed: run.seed,
    runID: run.runID,
    selectorSource: run.selectorSource,
    provider: run.provider,
    model: run.model,
    promptVersion: run.promptVersion,
    componentHashes: {
      sharedArchitecture: run.componentHashes.sharedArchitecture,
      optionBuilder: run.componentHashes.optionBuilder,
      stateBuilder: run.componentHashes.stateBuilder,
      lifecycle: run.componentHashes.lifecycle,
      executorAndFidelity: run.componentHashes.executorAndFidelity,
    },
    experimentFlags: {
      localSmoke: run.experimentFlags.localSmoke,
      structuredDeals: run.experimentFlags.structuredDeals,
      freeTextMessages: run.experimentFlags.freeTextMessages,
      optionExposureUsesDeterministicPreference:
        run.experimentFlags.optionExposureUsesDeterministicPreference,
      matchedOfferedOrderSpawnBallot:
        run.experimentFlags.matchedOfferedOrderSpawnBallot,
      autopilotEndgameSteps: run.experimentFlags.autopilotEndgameSteps,
      requireWinner: run.experimentFlags.requireWinner,
    },
    gameConfiguration: parseMatchedGameConfiguration(run.gameConfiguration),
    gameConfigurationFingerprint: run.gameConfigurationFingerprint,
    subjectAgentID: run.subjectAgentID,
    turnCount: run.turnCount,
    localSmoke: run.localSmoke,
    requireWinner: run.requireWinner,
    completed: run.completed,
    autopilotEngagedAtStep: run.autopilotEngagedAtStep,
  };
}

interface PersistedSummary {
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: string;
  runnerMode: "realtime" | "step-locked";
  roster: AgentRunRosterEntry[];
  finalState: AgentRunFinalState | null;
  runnerConfig: Record<string, unknown> | null;
  winner: Winner;
}

type PersistedDecisionEntry = Record<string, unknown> & {
  runID: string;
  matchID: string;
  sequence: number;
  turnNumber: number;
  agentID: string;
  username: string;
  profile: AgentDecisionRecord["profile"];
  brainType: AgentDecisionRecord["brainType"];
  timestamp: string;
  decisionLatencyMs: number;
  observationSummary: string;
  legalActionIDsByKind: AgentDecisionRecord["legalActionIDsByKind"];
  selectedLegalActionId: string;
  selectedActionKind: AgentDecisionRecord["chosenActionKind"];
  reason: string | null;
  generatedIntent: AgentDecisionRecord["intent"];
  result: AgentDecisionRecord["result"];
};

const decisionMetadataKeys = [
  "runtimeMode",
  "plannerSource",
  "externalPlannerCall",
  "planID",
  "planObjective",
  "planFollowed",
  "commanderSelectorSource",
  "commanderPrimarySelectorSource",
  "commanderFingerprint",
  "commanderEligibleOptionIds",
  "commanderExposedOptionIds",
  "commanderOmittedOptions",
  "commanderFidelity",
  "commanderReplanReason",
  "commanderResponseDisposition",
  "commanderRejectionCode",
  "commanderPreviousPlanID",
  "commanderPlanInstalled",
  "commanderHorizonDecisions",
  "commanderPlanAgeDecisions",
  "commanderBlockedReason",
  "commanderImmediateReplan",
  "commanderEmergencyCondition",
  "commanderDeterministicPreferredOptionId",
  "commanderDeterministicPreferredOptionAbsent",
  "commanderPromptCharacters",
  "commanderSelectionFailureKind",
  "commanderSelectorProvider",
  "commanderSelectorModel",
  "commanderPromptVersion",
  "commanderExperimentProvider",
  "commanderExperimentModel",
  "commanderExperimentPromptVersion",
  "commanderRuntimeProvider",
  "commanderRuntimeModel",
  "commanderRuntimePromptVersion",
  "commanderSelfTiles",
  "commanderSelfTroops",
  "plannerRan",
  "plannerLatencyMs",
  "plannerFallbackUsed",
  "plannerParseFailureReason",
  "degradedCause",
  "batchIndex",
] as const;

function decisionRecordFromEntry(
  entry: PersistedDecisionEntry,
  summary: PersistedSummary,
): AgentDecisionRecord {
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const key of decisionMetadataKeys) {
    const value = entry[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      metadata[key] = value;
    }
  }
  if (typeof entry.plannerParseSuccess === "boolean") {
    metadata.plannerParseOk = entry.plannerParseSuccess;
  }
  const legalActionIDs = Object.values(entry.legalActionIDsByKind).flatMap(
    (ids) => ids ?? [],
  );
  const rosterEntry = summary.roster.find(
    (candidate) => candidate.agentID === entry.agentID,
  );
  return {
    sequence: entry.sequence,
    gameID: summary.matchID,
    agentID: entry.agentID,
    clientID: rosterEntry?.clientID ?? null,
    username: entry.username,
    profile: entry.profile,
    brainType: entry.brainType,
    turnNumber: entry.turnNumber,
    decidedAt: Date.parse(entry.timestamp),
    decisionLatencyMs: entry.decisionLatencyMs,
    observationSummary: entry.observationSummary,
    legalActionIDs,
    legalActionIDsByKind: entry.legalActionIDsByKind,
    attackActionIDs: entry.legalActionIDsByKind.attack ?? [],
    chosenActionID: entry.selectedLegalActionId,
    chosenActionKind: entry.selectedActionKind,
    reason: entry.reason,
    decisionMetadata: metadata,
    ...(isRecord(entry.selectedActionMetadata)
      ? {
          chosenActionMetadata: entry.selectedActionMetadata as Record<
            string,
            string | number | boolean | null
          >,
        }
      : {}),
    ...(isRecord(entry.spawnSelectionEvidence)
      ? {
          spawnSelectionEvidence:
            entry.spawnSelectionEvidence as unknown as NonNullable<
              AgentDecisionRecord["spawnSelectionEvidence"]
            >,
        }
      : {}),
    intent: entry.generatedIntent,
    result: entry.result,
    audit: {
      auditStatus:
        typeof entry.auditStatus === "string"
          ? (entry.auditStatus as NonNullable<
              AgentDecisionRecord["audit"]
            >["auditStatus"])
          : "unknown",
      auditReason:
        typeof entry.auditReason === "string"
          ? entry.auditReason
          : "loaded from Commander decisions artifact",
    },
  };
}

function parseManifest(value: unknown): CommanderArmArtifactManifest {
  const manifest = requiredRecord(value, "Commander arm manifest");
  assertExactKeys(
    manifest,
    ["schemaVersion", "experimentKind", "run", "artifacts"],
    "Commander arm manifest has unknown or missing fields",
  );
  if (
    manifest.schemaVersion !== COMMANDER_ARM_ARTIFACT_MANIFEST_SCHEMA_VERSION ||
    manifest.experimentKind !== "strategic-commander-arm-input"
  ) {
    throw new Error("Unsupported Commander arm manifest schema");
  }
  const run = requiredRecord(manifest.run, "Commander arm manifest run");
  assertExactKeys(
    run,
    [
      "tripletID",
      "arm",
      "sourceSha",
      "sourceTreeDirty",
      "seed",
      "runID",
      "selectorSource",
      "provider",
      "model",
      "promptVersion",
      "componentHashes",
      "experimentFlags",
      "gameConfiguration",
      "gameConfigurationFingerprint",
      "subjectAgentID",
      "turnCount",
      "localSmoke",
      "requireWinner",
      "completed",
      "autopilotEngagedAtStep",
    ],
    "Commander arm manifest run has unknown or missing fields",
  );
  if (
    !isArm(run.arm) ||
    !isNonEmptyString(run.tripletID) ||
    !/^[0-9a-f]{40,64}$/i.test(String(run.sourceSha)) ||
    typeof run.sourceTreeDirty !== "boolean" ||
    !isNonEmptyString(run.seed) ||
    !isNonEmptyString(run.runID) ||
    !isSelectorSource(run.selectorSource) ||
    !isNullableString(run.provider) ||
    !isNullableString(run.model) ||
    !isNullableString(run.promptVersion) ||
    !/^[0-9a-f]{24}$/i.test(String(run.gameConfigurationFingerprint)) ||
    !isNonEmptyString(run.subjectAgentID) ||
    typeof run.turnCount !== "number" ||
    !Number.isFinite(run.turnCount) ||
    typeof run.localSmoke !== "boolean" ||
    typeof run.requireWinner !== "boolean" ||
    typeof run.completed !== "boolean" ||
    !isNullableFiniteNumber(run.autopilotEngagedAtStep)
  ) {
    throw new Error("Commander arm manifest run is malformed");
  }
  const componentHashes = parseComponentHashes(run.componentHashes);
  const experimentFlags = parseExperimentFlags(run.experimentFlags);
  const gameConfiguration = parseMatchedGameConfiguration(
    run.gameConfiguration,
  );
  const artifacts = requiredRecord(
    manifest.artifacts,
    "Commander arm manifest artifacts",
  );
  assertExactKeys(
    artifacts,
    [
      "writer",
      "decisionsPath",
      "decisionsSha256",
      "summaryPath",
      "summarySha256",
    ],
    "Commander arm manifest artifact provenance has unknown or missing fields",
  );
  if (
    artifacts.writer !==
      "AgentDecisionLogWriter.writeAgentLeagueRunArtifacts" ||
    typeof artifacts.decisionsPath !== "string" ||
    typeof artifacts.summaryPath !== "string" ||
    !isSha256(artifacts.decisionsSha256) ||
    !isSha256(artifacts.summarySha256)
  ) {
    throw new Error("Commander arm manifest has invalid artifact provenance");
  }
  return {
    schemaVersion: COMMANDER_ARM_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    experimentKind: "strategic-commander-arm-input",
    run: {
      tripletID: run.tripletID as string,
      arm: run.arm,
      sourceSha: run.sourceSha as string,
      sourceTreeDirty: run.sourceTreeDirty as boolean,
      seed: run.seed as string,
      runID: run.runID as string,
      selectorSource: run.selectorSource,
      provider: run.provider as string | null,
      model: run.model as string | null,
      promptVersion: run.promptVersion as string | null,
      componentHashes,
      experimentFlags,
      gameConfiguration,
      gameConfigurationFingerprint: run.gameConfigurationFingerprint as string,
      subjectAgentID: run.subjectAgentID as string,
      turnCount: run.turnCount as number,
      localSmoke: run.localSmoke as boolean,
      requireWinner: run.requireWinner as boolean,
      completed: run.completed as boolean,
      autopilotEngagedAtStep: run.autopilotEngagedAtStep as number | null,
    },
    artifacts: {
      writer: "AgentDecisionLogWriter.writeAgentLeagueRunArtifacts",
      decisionsPath: artifacts.decisionsPath,
      decisionsSha256: artifacts.decisionsSha256,
      summaryPath: artifacts.summaryPath,
      summarySha256: artifacts.summarySha256,
    },
  };
}

function parseComponentHashes(value: unknown): CommanderComponentHashes {
  const hashes = requiredRecord(value, "Commander component hashes");
  assertExactKeys(
    hashes,
    [
      "sharedArchitecture",
      "optionBuilder",
      "stateBuilder",
      "lifecycle",
      "executorAndFidelity",
    ],
    "Commander component hashes have unknown or missing fields",
  );
  if (
    !isSha256(hashes.sharedArchitecture) ||
    !isSha256(hashes.optionBuilder) ||
    !isSha256(hashes.stateBuilder) ||
    !isSha256(hashes.lifecycle) ||
    !isSha256(hashes.executorAndFidelity)
  ) {
    throw new Error("Commander component hashes are malformed");
  }
  return {
    sharedArchitecture: hashes.sharedArchitecture,
    optionBuilder: hashes.optionBuilder,
    stateBuilder: hashes.stateBuilder,
    lifecycle: hashes.lifecycle,
    executorAndFidelity: hashes.executorAndFidelity,
  };
}

function parseExperimentFlags(value: unknown): CommanderExperimentFlags {
  const flags = requiredRecord(value, "Commander experiment flags");
  assertExactKeys(
    flags,
    [
      "localSmoke",
      "structuredDeals",
      "freeTextMessages",
      "optionExposureUsesDeterministicPreference",
      "matchedOfferedOrderSpawnBallot",
      "autopilotEndgameSteps",
      "requireWinner",
    ],
    "Commander experiment flags have unknown or missing fields",
  );
  if (
    typeof flags.localSmoke !== "boolean" ||
    typeof flags.structuredDeals !== "boolean" ||
    typeof flags.freeTextMessages !== "boolean" ||
    typeof flags.optionExposureUsesDeterministicPreference !== "boolean" ||
    typeof flags.matchedOfferedOrderSpawnBallot !== "boolean" ||
    !Number.isSafeInteger(flags.autopilotEndgameSteps) ||
    Number(flags.autopilotEndgameSteps) < 0 ||
    typeof flags.requireWinner !== "boolean"
  ) {
    throw new Error("Commander experiment flags are malformed");
  }
  return {
    localSmoke: flags.localSmoke,
    structuredDeals: flags.structuredDeals,
    freeTextMessages: flags.freeTextMessages,
    optionExposureUsesDeterministicPreference:
      flags.optionExposureUsesDeterministicPreference,
    matchedOfferedOrderSpawnBallot: flags.matchedOfferedOrderSpawnBallot,
    autopilotEndgameSteps: Number(flags.autopilotEndgameSteps),
    requireWinner: flags.requireWinner,
  };
}

function parseMatchedGameConfiguration(
  value: unknown,
): CommanderMatchedGameConfiguration {
  const config = requiredRecord(value, "Commander game configuration");
  assertExactKeys(
    config,
    [
      "schemaVersion",
      "scenario",
      "runnerMode",
      "agents",
      "opponentBrainMode",
      "planEveryDecisionSteps",
      "runner",
      "selectedGameConfig",
      "disabledActionKinds",
      "rosterPolicy",
    ],
    "Commander game configuration has unknown or missing fields",
  );
  const runner = requiredRecord(
    config.runner,
    "Commander game configuration runner",
  );
  assertExactKeys(
    runner,
    [
      "turnsPerDecisionStep",
      "turnsPerDecisionSchedule",
      "maxDecisionMs",
      "maxSteps",
      "maxSpawnAdvanceTurns",
      "requireWinner",
      "waitForMirrorCatchup",
      "autopilotEndgameSteps",
      "replayTailTurns",
      "matchedOfferedOrderSpawnBallot",
      "variedSpawns",
    ],
    "Commander game configuration runner has unknown or missing fields",
  );
  if (
    !Number.isFinite(config.schemaVersion) ||
    !isNonEmptyString(config.scenario) ||
    (config.runnerMode !== "realtime" && config.runnerMode !== "step-locked") ||
    !Number.isFinite(config.agents) ||
    !isNullableString(config.opponentBrainMode) ||
    !Number.isFinite(config.planEveryDecisionSteps) ||
    !Number.isFinite(runner.turnsPerDecisionStep) ||
    !Number.isFinite(runner.maxDecisionMs) ||
    !Number.isFinite(runner.maxSteps) ||
    !Number.isFinite(runner.maxSpawnAdvanceTurns) ||
    typeof runner.requireWinner !== "boolean" ||
    typeof runner.waitForMirrorCatchup !== "boolean" ||
    !Number.isFinite(runner.autopilotEndgameSteps) ||
    !Number.isFinite(runner.replayTailTurns) ||
    typeof runner.matchedOfferedOrderSpawnBallot !== "boolean" ||
    typeof runner.variedSpawns !== "boolean" ||
    !isNonEmptyString(config.rosterPolicy)
  ) {
    throw new Error("Commander game configuration is malformed");
  }
  return {
    schemaVersion: config.schemaVersion as number,
    scenario: config.scenario as string,
    runnerMode: config.runnerMode,
    agents: config.agents as number,
    opponentBrainMode: config.opponentBrainMode as string | null,
    planEveryDecisionSteps: config.planEveryDecisionSteps as number,
    runner: {
      turnsPerDecisionStep: runner.turnsPerDecisionStep as number,
      turnsPerDecisionSchedule: nullableNumberArray(
        runner.turnsPerDecisionSchedule,
        "Commander turns-per-decision schedule",
      ),
      maxDecisionMs: runner.maxDecisionMs as number,
      maxSteps: runner.maxSteps as number,
      maxSpawnAdvanceTurns: runner.maxSpawnAdvanceTurns as number,
      requireWinner: runner.requireWinner as boolean,
      waitForMirrorCatchup: runner.waitForMirrorCatchup as boolean,
      autopilotEndgameSteps: runner.autopilotEndgameSteps as number,
      replayTailTurns: runner.replayTailTurns as number,
      matchedOfferedOrderSpawnBallot:
        runner.matchedOfferedOrderSpawnBallot as boolean,
      variedSpawns: runner.variedSpawns as boolean,
    },
    selectedGameConfig: parseCommanderCanonicalGameConfig(
      config.selectedGameConfig,
    ),
    disabledActionKinds: stringArray(
      config.disabledActionKinds,
      "Commander disabled action kinds",
    ),
    rosterPolicy: config.rosterPolicy as string,
  };
}

function parseSummary(value: unknown): PersistedSummary {
  const summary = requiredRecord(value, "Commander match summary");
  if (
    typeof summary.runID !== "string" ||
    typeof summary.matchID !== "string" ||
    typeof summary.scenario !== "string" ||
    typeof summary.brainMode !== "string" ||
    (summary.runnerMode !== "realtime" &&
      summary.runnerMode !== "step-locked") ||
    !Array.isArray(summary.roster)
  ) {
    throw new Error("Commander match summary is missing identity or roster");
  }
  const roster = summary.roster.map((entry, index) => {
    const row = requiredRecord(entry, `Commander roster row ${index}`);
    assertExactKeys(
      row,
      ["agentID", "username", "profile", "clientID", "brainType"],
      "Commander roster row has unknown or missing fields",
    );
    if (
      typeof row.agentID !== "string" ||
      typeof row.username !== "string" ||
      typeof row.profile !== "string" ||
      typeof row.brainType !== "string" ||
      (row.clientID !== null && typeof row.clientID !== "string")
    ) {
      throw new Error(`Commander roster row ${index} is malformed`);
    }
    return {
      agentID: row.agentID,
      username: row.username,
      profile: row.profile as AgentRunRosterEntry["profile"],
      clientID: row.clientID,
      brainType: row.brainType as AgentRunRosterEntry["brainType"],
    };
  });
  return {
    runID: summary.runID,
    matchID: summary.matchID,
    scenario: summary.scenario,
    brainMode: summary.brainMode,
    runnerMode: summary.runnerMode,
    roster,
    finalState:
      summary.finalState === null
        ? null
        : (requiredRecord(
            summary.finalState,
            "Commander final state",
          ) as unknown as AgentRunFinalState),
    runnerConfig:
      summary.runnerConfig === null
        ? null
        : requiredRecord(summary.runnerConfig, "Commander runner config"),
    winner: parseWinner(summary.winner),
  };
}

function gameConfigurationFromSummary(
  summary: PersistedSummary,
): CommanderMatchedGameConfiguration {
  const runner = requiredRecord(
    summary.runnerConfig,
    "Commander canonical runner config",
  );
  const turnsPerDecisionSchedule = nullableNumberArray(
    runner.turnsPerDecisionSchedule,
    "Commander turns-per-decision schedule",
  );
  const disabledActionKinds = stringArray(
    runner.disabledActionKinds,
    "Commander disabled action kinds",
  );
  const nations = runner.nations;
  if (typeof nations !== "string" && typeof nations !== "number") {
    throw new Error("Commander nations config is missing or malformed");
  }
  const opponentBrainMode = runner.opponentBrainMode;
  if (opponentBrainMode !== null && typeof opponentBrainMode !== "string") {
    throw new Error("Commander opponent brain config is malformed");
  }
  const selectedGameConfig = parseCommanderCanonicalGameConfig(
    runner.selectedGameConfig,
  );
  if (
    runner.map !== selectedGameConfig.gameMap ||
    runner.mapSize !== selectedGameConfig.gameMapSize ||
    runner.difficulty !== selectedGameConfig.difficulty ||
    runner.bots !== selectedGameConfig.bots ||
    runner.nations !== selectedGameConfig.nations
  ) {
    throw new Error(
      "Commander selected game configuration disagrees with runner summary",
    );
  }
  return {
    schemaVersion: requiredFiniteNumber(
      runner.executionConfigSchemaVersion,
      "Commander execution config schema version",
    ),
    scenario: summary.scenario,
    runnerMode: summary.runnerMode,
    agents: requiredFiniteNumber(runner.agents, "Commander agent count"),
    opponentBrainMode,
    planEveryDecisionSteps: requiredFiniteNumber(
      runner.planEveryDecisionSteps,
      "Commander planner cadence",
    ),
    runner: {
      turnsPerDecisionStep: requiredFiniteNumber(
        runner.turnsPerDecisionStep,
        "Commander turns per decision step",
      ),
      turnsPerDecisionSchedule,
      maxDecisionMs: requiredFiniteNumber(
        runner.maxDecisionMs,
        "Commander max decision time",
      ),
      maxSteps: requiredFiniteNumber(runner.maxSteps, "Commander max steps"),
      maxSpawnAdvanceTurns: requiredFiniteNumber(
        runner.maxSpawnAdvanceTurns,
        "Commander spawn advance limit",
      ),
      requireWinner: requiredBoolean(
        runner.requireWinner,
        "Commander require-winner config",
      ),
      waitForMirrorCatchup: requiredBoolean(
        runner.waitForMirrorCatchup,
        "Commander mirror catch-up config",
      ),
      autopilotEndgameSteps: requiredFiniteNumber(
        runner.autopilotEndgameSteps,
        "Commander autopilot endgame steps",
      ),
      replayTailTurns: requiredFiniteNumber(
        runner.replayTailTurns,
        "Commander replay tail turns",
      ),
      matchedOfferedOrderSpawnBallot: requiredBoolean(
        runner.matchedOfferedOrderSpawnBallot,
        "Commander matched spawn-ballot config",
      ),
      variedSpawns: requiredBoolean(
        runner.variedSpawns,
        "Commander varied-spawn config",
      ),
    },
    selectedGameConfig,
    disabledActionKinds,
    rosterPolicy: requiredNonEmptyString(
      runner.rosterPolicy,
      "Commander roster policy",
    ),
  };
}

function parseWinner(value: unknown): Winner {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    !["player", "team", "nation"].includes(String(value[0])) ||
    value.slice(1).some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Commander winner is malformed");
  }
  return value as Winner;
}

function parseDecisionEntry(
  value: unknown,
  index: number,
): PersistedDecisionEntry {
  const entry = requiredRecord(value, `Commander decision row ${index}`);
  const result = isRecord(entry.result) ? entry.result : null;
  if (
    typeof entry.runID !== "string" ||
    typeof entry.matchID !== "string" ||
    !Number.isSafeInteger(entry.sequence) ||
    !Number.isSafeInteger(entry.turnNumber) ||
    typeof entry.agentID !== "string" ||
    typeof entry.username !== "string" ||
    typeof entry.profile !== "string" ||
    typeof entry.brainType !== "string" ||
    typeof entry.timestamp !== "string" ||
    !Number.isFinite(entry.decisionLatencyMs) ||
    typeof entry.observationSummary !== "string" ||
    !isLegalActionIDsByKind(entry.legalActionIDsByKind) ||
    typeof entry.selectedLegalActionId !== "string" ||
    typeof entry.selectedActionKind !== "string" ||
    (entry.reason !== null && typeof entry.reason !== "string") ||
    !isIntentOrNull(entry.generatedIntent) ||
    result === null ||
    typeof result.accepted !== "boolean" ||
    typeof result.reason !== "string" ||
    !isIntentOrNull(result.submittedIntent) ||
    !["confirmed", "unknown", "failed", "not_applicable"].includes(
      String(entry.auditStatus),
    )
  ) {
    throw new Error(`Commander decision row ${index} is malformed`);
  }
  return entry as PersistedDecisionEntry;
}

function isLegalActionIDsByKind(
  value: unknown,
): value is AgentDecisionRecord["legalActionIDsByKind"] {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"),
    )
  );
}

function isIntentOrNull(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) && typeof value.type === "string" && value.type.length > 0)
  );
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArm(value: unknown): value is CommanderExperimentArm {
  return value === "A" || value === "B" || value === "C";
}

function isSelectorSource(
  value: unknown,
): value is CommanderArmRunInput["selectorSource"] {
  return (
    value === null ||
    value === "current-planner" ||
    value === "deterministic" ||
    value === "llm" ||
    value === "conflict"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  errorMessage: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(errorMessage);
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is missing or malformed`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} is missing or malformed`);
  }
  return value;
}

function requiredNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is missing or malformed`);
  }
  return value;
}

function nullableNumberArray(value: unknown, label: string): number[] | null {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    throw new Error(`${label} is missing or malformed`);
  }
  return [...value];
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${label} is missing or malformed`);
  }
  return [...value];
}

function resolveContainedArtifactPath(
  baseDirectory: string,
  relativePath: string,
): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Commander manifest artifact path must be relative");
  }
  const resolved = path.resolve(baseDirectory, relativePath);
  const relative = path.relative(baseDirectory, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Commander manifest artifact path escapes its input root");
  }
  return resolved;
}

function relativeArtifactPath(root: string, target: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Commander input artifact is outside the comparison root");
  }
  return relative.split(path.sep).join("/");
}

function safePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    throw new Error("Commander triplet identity cannot form a safe path");
  }
  return sanitized;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

async function writeTextAtomically(
  filePath: string,
  content: string,
): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, filePath);
}
