import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_CLAUDE_DISALLOWED_TOOLS } from "./ClaudeCliLlmProvider";
import {
  commanderArmTripletPathSegment,
  commanderComponentHashesFromFileEvidence,
  loadCommanderArmRunsFromArtifacts,
} from "./CommanderArmArtifacts";
import {
  buildCommanderArmReport,
  commanderArmReportJson,
  commanderArmReportMarkdown,
} from "./CommanderArmReport";
import { commanderGameIDFromSeed } from "./CommanderExperimentIdentity";
import {
  assertCommanderArmOrder,
  assertCommanderExperimentID,
  COMMANDER_EXPERIMENT_TUNABLE_DEFAULTS,
  COMMANDER_OUTER_DECISION_TIMEOUT_MS,
  COMMANDER_PROVIDER_KILL_TIMEOUT_MS,
  COMMANDER_SELECTOR_TIMEOUT_MS,
  commanderArmOrderForReplica,
  isCommanderConfirmatoryAnalysisSpecification,
  sha256Canonical,
  sha256File,
  type CommanderExperimentPreRegistration,
  type CommanderExperimentPreRegistrationEnvelope,
  type CommanderExperimentSeal,
  type CommanderExperimentSealEnvelope,
  type CommanderRuntimeIdentity,
  type CommanderSourceIdentity,
} from "./CommanderExperimentProtocol";

export const COMMANDER_EXPERIMENT_VERIFIER_SCHEMA_VERSION = 2;
export const MAX_COMMANDER_VERIFICATION_DIAGNOSTICS = 32;

export interface CommanderExperimentVerificationDiagnostic {
  code: string;
  path: string | null;
  expectedSha256: string | null;
  actualSha256: string | null;
}

export interface CommanderExperimentSealVerification {
  schemaVersion: 2;
  integrityVerified: boolean;
  experimentUsable: boolean;
  experimentID: string | null;
  experimentStatus: "complete" | "invalid" | null;
  sealedArtifactCount: number;
  verifiedArtifactCount: number;
  diagnostics: CommanderExperimentVerificationDiagnostic[];
  diagnosticsTruncated: boolean;
  authenticity: {
    verified: false;
    status: "external-seal-receipt-required";
    sealSha256: string | null;
    rootAloneAuthenticatesProducerOrTime: false;
  };
}

class VerificationContext {
  readonly diagnostics: CommanderExperimentVerificationDiagnostic[] = [];
  diagnosticsTruncated = false;
  verifiedArtifactCount = 0;
  sealSha256: string | null = null;

  add(
    code: string,
    relativePath: string | null = null,
    expectedSha256: string | null = null,
    actualSha256: string | null = null,
  ): void {
    if (this.diagnostics.length >= MAX_COMMANDER_VERIFICATION_DIAGNOSTICS) {
      this.diagnosticsTruncated = true;
      return;
    }
    this.diagnostics.push({
      code,
      path: boundedDiagnosticPath(relativePath),
      expectedSha256: isSha256(expectedSha256) ? expectedSha256 : null,
      actualSha256: isSha256(actualSha256) ? actualSha256 : null,
    });
  }
}

/**
 * Verifies a transported Commander experiment from its root alone. This is an
 * internal-consistency proof, not a signature: authenticity still requires an
 * externally published or signed seal hash.
 */
export async function verifyCommanderExperimentSeal(
  experimentRoot: string,
): Promise<CommanderExperimentSealVerification> {
  try {
    return await verifyCommanderExperimentSealInternal(experimentRoot);
  } catch {
    const context = new VerificationContext();
    context.add("VERIFICATION_INPUT_INVALID");
    return result(context, null, null, 0);
  }
}

async function verifyCommanderExperimentSealInternal(
  experimentRoot: string,
): Promise<CommanderExperimentSealVerification> {
  const context = new VerificationContext();
  let root: string;
  try {
    root = await canonicalRealRoot(experimentRoot);
  } catch {
    context.add("ROOT_INVALID");
    return result(context, null, null, 0);
  }

  const manifestPath = path.join(root, "commander-experiment-manifest.json");
  const sealPath = path.join(root, "commander-experiment-seal.json");
  const manifestEnvelope =
    await readEnvelope<CommanderExperimentPreRegistrationEnvelope>(
      root,
      manifestPath,
      "MANIFEST_ENVELOPE_INVALID",
      context,
    );
  const sealEnvelope = await readEnvelope<CommanderExperimentSealEnvelope>(
    root,
    sealPath,
    "SEAL_ENVELOPE_INVALID",
    context,
  );
  if (manifestEnvelope === null || sealEnvelope === null) {
    return result(context, null, null, 0);
  }
  if (
    !hasExactKeys(manifestEnvelope as unknown as Record<string, unknown>, [
      "manifest",
      "manifestSha256",
    ]) ||
    !isRecord(manifestEnvelope.manifest) ||
    !isSha256(manifestEnvelope.manifestSha256)
  ) {
    context.add(
      "MANIFEST_ENVELOPE_INVALID",
      "commander-experiment-manifest.json",
    );
    return result(context, null, null, 0);
  }
  if (
    !hasExactKeys(sealEnvelope as unknown as Record<string, unknown>, [
      "seal",
      "sealSha256",
    ]) ||
    !isRecord(sealEnvelope.seal) ||
    !isSha256(sealEnvelope.sealSha256)
  ) {
    context.add("SEAL_ENVELOPE_INVALID", "commander-experiment-seal.json");
    return result(context, null, null, 0);
  }
  context.sealSha256 = sealEnvelope.sealSha256;

  const manifest =
    manifestEnvelope.manifest as CommanderExperimentPreRegistration;
  const seal = sealEnvelope.seal as CommanderExperimentSeal;
  if (
    !hasExactKeys(manifest as unknown as Record<string, unknown>, [
      "schemaVersion",
      "experimentKind",
      "experimentID",
      "createdAt",
      "source",
      "runtime",
      "configuration",
      "seeds",
      "expectedArmManifestPaths",
    ]) ||
    manifest.schemaVersion !== 1 ||
    manifest.experimentKind !== "strategic-commander-three-arm" ||
    typeof manifest.createdAt !== "string" ||
    !isRecord(manifest.configuration)
  ) {
    context.add("MANIFEST_BODY_INVALID");
    return result(context, null, null, 0);
  }
  if (
    !hasExactKeys(seal as unknown as Record<string, unknown>, [
      "schemaVersion",
      "experimentKind",
      "experimentID",
      "status",
      "reasons",
      "preRegistrationManifestSha256",
      "finalSource",
      "finalRuntime",
      "recapture",
      "artifacts",
    ]) ||
    seal.schemaVersion !== 1 ||
    seal.experimentKind !== "strategic-commander-three-arm-seal"
  ) {
    context.add("SEAL_BODY_INVALID");
    return result(context, null, null, 0);
  }
  const manifestHash = sha256Canonical(manifest);
  const sealHash = sha256Canonical(seal);
  if (manifestHash !== manifestEnvelope.manifestSha256) {
    context.add(
      "MANIFEST_HASH_MISMATCH",
      "commander-experiment-manifest.json",
      manifestEnvelope.manifestSha256,
      manifestHash,
    );
  }
  if (sealHash !== sealEnvelope.sealSha256) {
    context.add(
      "SEAL_HASH_MISMATCH",
      "commander-experiment-seal.json",
      sealEnvelope.sealSha256,
      sealHash,
    );
  }

  const experimentID = validExperimentID(manifest.experimentID)
    ? manifest.experimentID
    : null;
  const status =
    seal.status === "complete" || seal.status === "invalid"
      ? seal.status
      : null;
  if (experimentID === null || seal.experimentID !== experimentID) {
    context.add("EXPERIMENT_ID_MISMATCH");
  }
  if (seal.preRegistrationManifestSha256 !== manifestEnvelope.manifestSha256) {
    context.add(
      "PREREGISTRATION_LINK_MISMATCH",
      "commander-experiment-manifest.json",
      seal.preRegistrationManifestSha256,
      manifestEnvelope.manifestSha256,
    );
  }
  validateSealStatus(seal, context);
  validateSourceIdentity(manifest.source, "initial-source", context);
  validateRuntimeIdentity(manifest.runtime, "initial-runtime", context);
  if (seal.finalSource !== null) {
    validateSourceIdentity(seal.finalSource, "final-source", context);
  }
  if (seal.finalRuntime !== null) {
    validateRuntimeIdentity(seal.finalRuntime, "final-runtime", context);
  }
  if (
    seal.status === "complete" &&
    (seal.finalSource?.identitySha256 !== manifest.source?.identitySha256 ||
      seal.finalRuntime?.identitySha256 !== manifest.runtime?.identitySha256)
  ) {
    context.add("FINAL_IDENTITY_MISMATCH");
  }
  const sourceCommanderHashes = commanderHashesFromSource(manifest.source);
  if (
    sourceCommanderHashes === null ||
    !isRecord(manifest.configuration?.legacyComponentHashes) ||
    sha256Canonical(sourceCommanderHashes) !==
      sha256Canonical(manifest.configuration.legacyComponentHashes)
  ) {
    context.add("COMMANDER_COMPONENT_CROSS_LINK_INVALID");
  }
  if (
    seal.finalSource !== null &&
    sha256Canonical(commanderHashesFromSource(seal.finalSource)) !==
      sha256Canonical(sourceCommanderHashes)
  ) {
    context.add("FINAL_COMMANDER_COMPONENT_CROSS_LINK_INVALID");
  }

  const expectedArmPaths = validateSchedule(manifest, context);
  const artifacts = Array.isArray(seal.artifacts) ? seal.artifacts : [];
  if (!Array.isArray(seal.artifacts))
    context.add("SEALED_ARTIFACT_LIST_INVALID");
  const sealedPaths = new Set<string>();
  for (const [index, rawArtifact] of artifacts.entries()) {
    if (
      !isRecord(rawArtifact) ||
      !hasExactKeys(rawArtifact, ["path", "sha256"]) ||
      typeof rawArtifact.path !== "string" ||
      !isSha256(rawArtifact.sha256)
    ) {
      context.add("SEALED_ARTIFACT_ENTRY_INVALID", `artifact-${index}`);
      continue;
    }
    if (sealedPaths.has(rawArtifact.path)) {
      context.add("SEALED_ARTIFACT_PATH_DUPLICATE", rawArtifact.path);
      continue;
    }
    sealedPaths.add(rawArtifact.path);
    const artifactPath = await containedRealFile(root, rawArtifact.path);
    if (artifactPath === null) {
      context.add("SEALED_ARTIFACT_PATH_INVALID", rawArtifact.path);
      continue;
    }
    let actualHash: string;
    try {
      actualHash = await sha256File(artifactPath);
    } catch {
      context.add("SEALED_ARTIFACT_READ_FAILED", rawArtifact.path);
      continue;
    }
    if (actualHash !== rawArtifact.sha256) {
      context.add(
        "SEALED_ARTIFACT_HASH_MISMATCH",
        rawArtifact.path,
        rawArtifact.sha256,
        actualHash,
      );
    } else {
      context.verifiedArtifactCount += 1;
    }
  }

  if (seal.status === "complete") {
    const requiredDirect = new Set([
      "commander-experiment-manifest.json",
      ...expectedArmPaths,
      "commander-three-arm.json",
      "commander-three-arm.md",
    ]);
    if (!sameStringSet(requiredDirect, sealedPaths)) {
      context.add("COMPLETE_SEAL_ARTIFACT_SET_MISMATCH");
    }
    await verifyCanonicalReports(root, manifest, expectedArmPaths, context);
  }

  return result(context, experimentID, status, artifacts.length);
}

async function verifyCanonicalReports(
  root: string,
  manifest: CommanderExperimentPreRegistration,
  expectedArmPaths: readonly string[],
  context: VerificationContext,
): Promise<void> {
  const absoluteManifestPaths: string[] = [];
  for (const relativePath of expectedArmPaths) {
    const absolute = await containedRealFile(root, relativePath);
    if (absolute === null) {
      context.add("ARM_MANIFEST_PATH_INVALID", relativePath);
    } else {
      absoluteManifestPaths.push(absolute);
    }
  }
  if (absoluteManifestPaths.length !== expectedArmPaths.length) return;
  let runs: Awaited<ReturnType<typeof loadCommanderArmRunsFromArtifacts>>;
  try {
    runs = await loadCommanderArmRunsFromArtifacts(absoluteManifestPaths, root);
  } catch {
    context.add("ARM_ARTIFACT_GRAPH_INVALID");
    return;
  }
  const byIdentity = new Map(
    runs.map((run) => [`${run.replicaIndex}:${run.arm}`, run]),
  );
  if (
    byIdentity.size !== runs.length ||
    runs.length !== manifest.seeds.length * 3
  ) {
    context.add("ARM_EXECUTION_IDENTITY_DUPLICATE");
  }
  const sourceCommanderHashes = commanderHashesFromSource(manifest.source);
  for (const seed of manifest.seeds) {
    for (const [armExecutionIndex, arm] of seed.armOrder.entries()) {
      const run = byIdentity.get(`${seed.replicaIndex}:${arm}`);
      if (
        run === undefined ||
        run.tripletID !== seed.runID ||
        run.runID !== seed.runID ||
        run.seed !== seed.seed ||
        run.protocol !== manifest.configuration.protocol ||
        run.subjectSeatIndex !== seed.subjectSeatIndex ||
        run.episodeIndex !== seed.episodeIndex ||
        run.armExecutionIndex !== armExecutionIndex ||
        JSON.stringify(run.armOrder) !== JSON.stringify(seed.armOrder) ||
        run.subjectAgentID !== run.roster[seed.subjectSeatIndex]?.agentID ||
        run.runtimeIdentitySha256 !== manifest.runtime.identitySha256 ||
        run.preRegistrationManifestSha256 !== sha256Canonical(manifest) ||
        run.sourceSha !== manifest.source.sourceSha ||
        run.sourceTreeDirty !== !manifest.source.clean
      ) {
        context.add("ARM_PREREGISTRATION_MISMATCH");
      }
      if (run !== undefined) {
        if (
          sha256Canonical(run.componentHashes) !==
          sha256Canonical(sourceCommanderHashes)
        ) {
          context.add("ARM_COMPONENT_CROSS_LINK_INVALID");
        }
        for (const code of runTreatmentMismatchCodes(run, manifest, arm)) {
          context.add(code);
        }
      }
    }
  }
  let report;
  try {
    report = buildCommanderArmReport(runs);
  } catch {
    context.add("REPORT_REBUILD_FAILED");
    return;
  }
  if (!report.integrity.valid) {
    context.add("ARM_EVIDENCE_INTEGRITY_INVALID");
  }
  if (
    (manifest.configuration.protocol === "technical-canary" &&
      !report.technicalCanaryEligibility.eligible) ||
    (manifest.configuration.protocol === "confirmatory" &&
      !report.performanceClaimsAllowed)
  ) {
    context.add("PROTOCOL_EVIDENCE_FLOOR_NOT_MET");
  }
  const expected = [
    ["commander-three-arm.json", commanderArmReportJson(report)],
    ["commander-three-arm.md", commanderArmReportMarkdown(report)],
  ] as const;
  for (const [relativePath, expectedText] of expected) {
    try {
      const actualText = await fs.readFile(
        path.join(root, relativePath),
        "utf8",
      );
      if (actualText !== expectedText) {
        context.add("REPORT_REBUILD_MISMATCH", relativePath);
      }
    } catch {
      context.add("REPORT_REBUILD_READ_FAILED", relativePath);
    }
  }
}

function validateSchedule(
  manifest: CommanderExperimentPreRegistration,
  context: VerificationContext,
): string[] {
  const configuration = manifest.configuration;
  const configurationKeys = [
    "baseRunID",
    "baseSeed",
    "protocol",
    "providerMode",
    "replicaCount",
    "startIndex",
    "maxSteps",
    "turnsPerDecisionStep",
    "requireWinner",
    "planEveryDecisionSteps",
    "sharedArgs",
    "selectedGameConfig",
    "socialFlags",
    "legacyComponentHashes",
    "analysisSpecification",
    "arms",
  ] as const;
  if (
    !isRecord(configuration) ||
    !hasExactKeys(configuration, configurationKeys) ||
    typeof configuration.baseRunID !== "string" ||
    configuration.baseRunID === "" ||
    typeof configuration.baseSeed !== "string" ||
    configuration.baseSeed === "" ||
    !isProtocol(configuration.protocol) ||
    (configuration.providerMode !== "scripted" &&
      configuration.providerMode !== "claude-cli") ||
    configuration.providerMode !== manifest.runtime?.providerMode ||
    !isPositiveInteger(configuration.replicaCount) ||
    !isNonNegativeInteger(configuration.startIndex) ||
    !isPositiveInteger(configuration.maxSteps) ||
    !isPositiveInteger(configuration.turnsPerDecisionStep) ||
    typeof configuration.requireWinner !== "boolean" ||
    !isPositiveInteger(configuration.planEveryDecisionSteps) ||
    !Array.isArray(configuration.sharedArgs) ||
    configuration.sharedArgs.some((entry) => typeof entry !== "string") ||
    !isRecord(configuration.selectedGameConfig) ||
    !isRecord(configuration.socialFlags) ||
    !isRecord(configuration.legacyComponentHashes) ||
    !Array.isArray(configuration.arms) ||
    !Array.isArray(manifest.seeds) ||
    manifest.seeds.length !== configuration.replicaCount
  ) {
    context.add("PREREGISTRATION_SCHEDULE_INVALID");
    return [];
  }
  const expectedSharedArgs = [
    "--runner=step-locked",
    `--turns-per-decision-step=${configuration.turnsPerDecisionStep}`,
    `--max-decision-ms=${COMMANDER_OUTER_DECISION_TIMEOUT_MS}`,
    `--max-steps=${configuration.maxSteps}`,
    "--agents=4",
    "--opponent-brain=starter-bot",
    ...(configuration.requireWinner ? ["--require-winner"] : []),
  ];
  const protocolShapeValid =
    configuration.protocol === "plumbing"
      ? configuration.providerMode === "scripted" &&
        configuration.planEveryDecisionSteps === 3 &&
        configuration.analysisSpecification === null
      : configuration.providerMode === "claude-cli" &&
        configuration.planEveryDecisionSteps === 3 &&
        configuration.startIndex === 0 &&
        configuration.maxSteps === 60 &&
        configuration.turnsPerDecisionStep === 100 &&
        configuration.requireWinner === true &&
        configuration.replicaCount ===
          (configuration.protocol === "technical-canary" ? 4 : 48) &&
        (configuration.protocol === "confirmatory"
          ? isCommanderConfirmatoryAnalysisSpecification(
              configuration.analysisSpecification,
            )
          : configuration.analysisSpecification === null);
  if (
    !protocolShapeValid ||
    JSON.stringify(configuration.sharedArgs) !==
      JSON.stringify(expectedSharedArgs) ||
    !validSocialFlags(configuration.socialFlags) ||
    !validLegacyComponentHashes(configuration.legacyComponentHashes) ||
    !validArmDefinitions(configuration.arms, configuration.providerMode)
  ) {
    context.add("PREREGISTRATION_TREATMENT_INVALID");
  }
  if (!protocolShapeValid) {
    context.add("PREREGISTRATION_PROTOCOL_FLOOR_INVALID");
  }
  const paths: string[] = [];
  const replicaIndices = new Set<number>();
  const runIDs = new Set<string>();
  const seeds = new Set<string>();
  const gameIDs = new Set<string>();
  for (const [offset, seed] of manifest.seeds.entries()) {
    try {
      const expectedReplicaIndex = configuration.startIndex + offset;
      const expectedRunID = replicatedIdentityForVerification(
        configuration.baseRunID,
        expectedReplicaIndex,
        configuration.replicaCount,
      );
      const expectedSeed = replicatedIdentityForVerification(
        configuration.baseSeed,
        expectedReplicaIndex,
        configuration.replicaCount,
      );
      if (
        !hasExactKeys(seed as unknown as Record<string, unknown>, [
          "replicaIndex",
          "runID",
          "seed",
          "gameID",
          "subjectSeatIndex",
          "episodeIndex",
          "armOrder",
        ]) ||
        seed.replicaIndex !== expectedReplicaIndex ||
        seed.runID !== expectedRunID ||
        seed.seed !== expectedSeed ||
        seed.gameID !== commanderGameIDFromSeed(expectedSeed) ||
        seed.subjectSeatIndex !== expectedReplicaIndex % 4 ||
        seed.episodeIndex !==
          (configuration.protocol === "confirmatory"
            ? Math.floor(expectedReplicaIndex / 4) % 4
            : expectedReplicaIndex % 4)
      ) {
        throw new Error("invalid");
      }
      assertCommanderArmOrder(seed.armOrder);
      if (
        JSON.stringify(seed.armOrder) !==
          JSON.stringify(commanderArmOrderForReplica(expectedReplicaIndex)) ||
        replicaIndices.has(seed.replicaIndex) ||
        runIDs.has(seed.runID) ||
        seeds.has(seed.seed) ||
        gameIDs.has(seed.gameID)
      ) {
        throw new Error("duplicate or unscheduled");
      }
      replicaIndices.add(seed.replicaIndex);
      runIDs.add(seed.runID);
      seeds.add(seed.seed);
      gameIDs.add(seed.gameID);
      for (const arm of seed.armOrder) {
        paths.push(
          `inputs/${commanderArmTripletPathSegment(seed.runID)}/${arm}/commander-arm-manifest.json`,
        );
      }
    } catch {
      context.add("PREREGISTRATION_SCHEDULE_INVALID");
    }
  }
  if (
    !Array.isArray(manifest.expectedArmManifestPaths) ||
    JSON.stringify(manifest.expectedArmManifestPaths) !== JSON.stringify(paths)
  ) {
    context.add("EXPECTED_ARM_MANIFEST_SET_MISMATCH");
  }
  return paths;
}

function replicatedIdentityForVerification(
  base: string,
  index: number,
  replicaCount: number,
): string {
  return replicaCount === 1
    ? base
    : `${base}-r${String(index).padStart(4, "0")}`;
}

function validateSourceIdentity(
  source: CommanderSourceIdentity | null | undefined,
  label: string,
  context: VerificationContext,
): void {
  if (
    !isRecord(source) ||
    !hasExactKeys(source, [
      "schemaVersion",
      "sourceSha",
      "sourceTreeSha",
      "clean",
      "statusSha256",
      "ignoredLoadBearingFiles",
      "componentHashes",
      "componentFiles",
      "loadBearingTreeSha256",
      "identitySha256",
    ]) ||
    source.schemaVersion !== 1 ||
    typeof source.identitySha256 !== "string"
  ) {
    context.add("SOURCE_IDENTITY_INVALID", label);
    return;
  }
  const { identitySha256, ...material } = source;
  if (sha256Canonical(material) !== identitySha256) {
    context.add("SOURCE_IDENTITY_HASH_MISMATCH", label);
  }
  const componentFiles = source.componentFiles;
  const componentHashes = source.componentHashes;
  const ignored = source.ignoredLoadBearingFiles;
  if (isRecord(componentFiles) && isRecord(componentHashes)) {
    for (const key of [
      "core",
      "server",
      "harness",
      "config",
      "runtimeAssets",
    ] as const) {
      if (
        Array.isArray(componentFiles[key]) &&
        componentHashes[key] !== sha256Canonical(componentFiles[key])
      ) {
        context.add("SOURCE_COMPONENT_HASH_MISMATCH", `${label}/${key}`);
      }
    }
  }
  if (
    !isRecord(componentFiles) ||
    !isRecord(componentHashes) ||
    !sameStringSet(
      new Set(Object.keys(componentFiles)),
      new Set(["core", "server", "harness", "config", "runtimeAssets"]),
    ) ||
    !sameStringSet(
      new Set(Object.keys(componentFiles)),
      new Set(Object.keys(componentHashes)),
    ) ||
    Object.values(componentHashes).some((value) => !isNonZeroSha256(value)) ||
    Object.values(componentFiles).some(
      (entries) =>
        !Array.isArray(entries) ||
        entries.some(
          (entry) =>
            !isRecord(entry) ||
            !hasExactKeys(entry, ["path", "sha256"]) ||
            typeof entry.path !== "string" ||
            entry.path === "" ||
            path.isAbsolute(entry.path) ||
            entry.path.split(/[\\/]/).some((segment) => segment === "..") ||
            !isSha256(entry.sha256),
        ),
    ) ||
    !Array.isArray(ignored) ||
    ignored.some((entry) => typeof entry !== "string") ||
    new Set(ignored).size !== ignored.length ||
    JSON.stringify(ignored) !== JSON.stringify([...ignored].sort()) ||
    sha256Canonical(source.componentFiles) !== source.loadBearingTreeSha256 ||
    typeof source.clean !== "boolean" ||
    !/^[0-9a-f]{40,64}$/i.test(String(source.sourceSha)) ||
    !isSha256(source.statusSha256) ||
    !/^[0-9a-f]{40,64}$/i.test(String(source.sourceTreeSha))
  ) {
    context.add("SOURCE_IDENTITY_INVALID", label);
    return;
  }
}

function validateRuntimeIdentity(
  runtime: CommanderRuntimeIdentity | null | undefined,
  label: string,
  context: VerificationContext,
): void {
  if (
    !isRecord(runtime) ||
    !hasExactKeys(runtime, [
      "schemaVersion",
      "providerMode",
      "outerDecisionTimeoutMs",
      "commanderSelectorTimeoutMs",
      "provider",
      "environment",
      "identitySha256",
    ]) ||
    runtime.schemaVersion !== 1 ||
    typeof runtime.identitySha256 !== "string"
  ) {
    context.add("RUNTIME_IDENTITY_INVALID", label);
    return;
  }
  const { identitySha256, ...material } = runtime;
  if (sha256Canonical(material) !== identitySha256) {
    context.add("RUNTIME_IDENTITY_HASH_MISMATCH", label);
  }
  const expectedTunables = Object.fromEntries(
    Object.entries(COMMANDER_EXPERIMENT_TUNABLE_DEFAULTS).map(
      ([key, value]) => [`PROXYWAR_TUNE_${key}`, value],
    ),
  );
  const environment = runtime.environment;
  const provider = runtime.provider;
  if (
    runtime.outerDecisionTimeoutMs !== COMMANDER_OUTER_DECISION_TIMEOUT_MS ||
    runtime.commanderSelectorTimeoutMs !== COMMANDER_SELECTOR_TIMEOUT_MS ||
    !isRecord(environment) ||
    !hasExactKeys(environment, [
      "sanitized",
      "values",
      "snapshotSha256",
      "tunableValues",
      "tunableSnapshotSha256",
      "childEnvironmentKeys",
      "childEnvironmentSha256",
    ]) ||
    environment.sanitized !== true ||
    !isRecord(environment.values) ||
    sha256Canonical(environment.values) !== environment.snapshotSha256 ||
    sha256Canonical(environment.tunableValues) !==
      environment.tunableSnapshotSha256 ||
    sha256Canonical(expectedTunables) !== environment.tunableSnapshotSha256 ||
    !Array.isArray(environment.childEnvironmentKeys) ||
    environment.childEnvironmentKeys.some(
      (entry) => typeof entry !== "string",
    ) ||
    new Set(environment.childEnvironmentKeys).size !==
      environment.childEnvironmentKeys.length ||
    !isSha256(environment.childEnvironmentSha256) ||
    !isRecord(provider) ||
    !hasExactKeys(provider, [
      "type",
      "binaryPath",
      "binarySha256",
      "version",
      "cwd",
      "cwdStateSha256",
      "model",
      "argv",
      "allowedTools",
      "disallowedTools",
      "killTimeoutMs",
    ])
  ) {
    context.add("RUNTIME_IDENTITY_INVALID", label);
    return;
  }
  if (runtime.providerMode === "scripted") {
    if (
      provider.type !== "mock" ||
      provider.binaryPath !== null ||
      provider.binarySha256 !== null ||
      provider.version !== null ||
      provider.cwd !== null ||
      provider.cwdStateSha256 !== null ||
      provider.killTimeoutMs !== null ||
      provider.model !== "scripted-deterministic-plumbing-v1" ||
      !Array.isArray(provider.argv) ||
      provider.argv.length !== 0 ||
      !Array.isArray(provider.allowedTools) ||
      provider.allowedTools.length !== 0 ||
      provider.disallowedTools !== ""
    ) {
      context.add("RUNTIME_PROVIDER_POLICY_INVALID", label);
    }
  } else if (runtime.providerMode === "claude-cli") {
    if (
      provider.type !== "claude-cli" ||
      !isSha256(provider.binarySha256) ||
      typeof provider.binaryPath !== "string" ||
      typeof provider.version !== "string" ||
      provider.version === "" ||
      typeof provider.cwd !== "string" ||
      !isSha256(provider.cwdStateSha256) ||
      !/^claude-[a-z0-9][a-z0-9-]*-\d{8}$/i.test(String(provider.model)) ||
      provider.killTimeoutMs !== COMMANDER_PROVIDER_KILL_TIMEOUT_MS ||
      provider.disallowedTools !== DEFAULT_CLAUDE_DISALLOWED_TOOLS ||
      !Array.isArray(provider.allowedTools) ||
      provider.allowedTools.length !== 0 ||
      !Array.isArray(provider.argv) ||
      JSON.stringify(provider.argv) !==
        JSON.stringify([
          "-p",
          "--max-turns",
          "1",
          "--disallowedTools",
          DEFAULT_CLAUDE_DISALLOWED_TOOLS,
          "--setting-sources=",
          "--tools",
          "",
          "--no-session-persistence",
          "--safe-mode",
          "--model",
          provider.model,
        ])
    ) {
      context.add("RUNTIME_PROVIDER_POLICY_INVALID", label);
    }
  } else {
    context.add("RUNTIME_PROVIDER_POLICY_INVALID", label);
  }
}

function validateSealStatus(
  seal: CommanderExperimentSeal,
  context: VerificationContext,
): void {
  if (
    !isRecord(seal.recapture) ||
    !hasExactKeys(seal.recapture, [
      "source",
      "runtime",
      "sourceFailure",
      "runtimeFailure",
    ])
  ) {
    context.add("SEAL_STATUS_INVALID");
    return;
  }
  if (seal.status === "complete") {
    if (
      !Array.isArray(seal.reasons) ||
      seal.reasons.length !== 0 ||
      seal.finalSource === null ||
      seal.finalRuntime === null ||
      seal.recapture?.source !== "captured" ||
      seal.recapture?.runtime !== "captured" ||
      seal.recapture?.sourceFailure !== null ||
      seal.recapture?.runtimeFailure !== null
    ) {
      context.add("SEAL_STATUS_INVALID");
    }
    return;
  }
  if (
    seal.status !== "invalid" ||
    !Array.isArray(seal.reasons) ||
    seal.reasons.length === 0
  ) {
    context.add("SEAL_STATUS_INVALID");
  }
}

async function readEnvelope<T>(
  root: string,
  absolutePath: string,
  code: string,
  context: VerificationContext,
): Promise<T | null> {
  const relativePath = path
    .relative(root, absolutePath)
    .split(path.sep)
    .join("/");
  const realFile = await containedRealFile(root, relativePath);
  if (realFile === null) {
    context.add(code, relativePath);
    return null;
  }
  try {
    const stat = await fs.stat(realFile);
    if (stat.size > 32 * 1024 * 1024) throw new Error("oversized");
    return JSON.parse(await fs.readFile(realFile, "utf8")) as T;
  } catch {
    context.add(code, relativePath);
    return null;
  }
}

async function canonicalRealRoot(value: string): Promise<string> {
  const lexical = path.resolve(value);
  const stat = await fs.lstat(lexical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("invalid");
  return fs.realpath(lexical);
}

async function containedRealFile(
  root: string,
  relativePath: string,
): Promise<string | null> {
  if (
    relativePath === "" ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0")
  ) {
    return null;
  }
  const segments = relativePath.split(/[\\/]/);
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  let cursor = root;
  try {
    for (const [index, segment] of segments.entries()) {
      cursor = path.join(cursor, segment);
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) return null;
      const leaf = index === segments.length - 1;
      if (leaf ? !stat.isFile() : !stat.isDirectory()) return null;
    }
    const real = await fs.realpath(cursor);
    return real === cursor ? real : null;
  } catch {
    return null;
  }
}

function result(
  context: VerificationContext,
  experimentID: string | null,
  status: "complete" | "invalid" | null,
  sealedArtifactCount: number,
): CommanderExperimentSealVerification {
  const integrityVerified = context.diagnostics.length === 0;
  return {
    schemaVersion: COMMANDER_EXPERIMENT_VERIFIER_SCHEMA_VERSION,
    integrityVerified,
    experimentUsable: integrityVerified && status === "complete",
    experimentID,
    experimentStatus: status,
    sealedArtifactCount,
    verifiedArtifactCount: context.verifiedArtifactCount,
    diagnostics: context.diagnostics,
    diagnosticsTruncated: context.diagnosticsTruncated,
    authenticity: {
      verified: false,
      status: "external-seal-receipt-required",
      sealSha256: context.sealSha256,
      rootAloneAuthenticatesProducerOrTime: false,
    },
  };
}

function validExperimentID(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    assertCommanderExperimentID(value);
    return true;
  } catch {
    return false;
  }
}

function boundedDiagnosticPath(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value
    .split(path.sep)
    .join("/")
    .replace(/[^A-Za-z0-9._/-]/g, "_");
  if (normalized.startsWith("/") || normalized.includes("../")) return null;
  return normalized.slice(0, 256);
}

function sameStringSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size && [...left].every((entry) => right.has(entry))
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((entry, index) => entry === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProtocol(
  value: unknown,
): value is "plumbing" | "technical-canary" | "confirmatory" {
  return (
    value === "plumbing" ||
    value === "technical-canary" ||
    value === "confirmatory"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validSocialFlags(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["structuredDeals", "freeTextMessages"]) &&
    value.structuredDeals === false &&
    value.freeTextMessages === false
  );
}

function validLegacyComponentHashes(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "sharedArchitecture",
      "optionBuilder",
      "stateBuilder",
      "lifecycle",
      "executorAndFidelity",
    ]) &&
    Object.values(value).every(isNonZeroSha256)
  );
}

function validArmDefinitions(value: unknown, providerMode: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 3) return false;
  const expectedBrains =
    providerMode === "scripted"
      ? ["planner", "commander-v0-det", "commander-v0-llm"]
      : ["planner-claude-cli", "commander-v0-det", "commander-v0-llm"];
  return value.every((entry, index) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["arm", "brain", "provenance"]) ||
      entry.arm !== (["A", "B", "C"] as const)[index] ||
      entry.brain !== expectedBrains[index] ||
      !isRecord(entry.provenance) ||
      !hasExactKeys(entry.provenance, ["provider", "model", "promptVersion"])
    ) {
      return false;
    }
    const provenance = entry.provenance;
    if (entry.arm === "B") {
      return (
        provenance.provider === null &&
        provenance.model === null &&
        provenance.promptVersion === null
      );
    }
    return (
      typeof provenance.provider === "string" &&
      provenance.provider !== "" &&
      typeof provenance.model === "string" &&
      provenance.model !== "" &&
      typeof provenance.promptVersion === "string" &&
      provenance.promptVersion !== ""
    );
  });
}

function commanderHashesFromSource(
  source: CommanderSourceIdentity | null | undefined,
) {
  const serverFiles = source?.componentFiles?.server;
  if (!Array.isArray(serverFiles)) return null;
  return commanderComponentHashesFromFileEvidence(serverFiles);
}

function runTreatmentMismatchCodes(
  run: Awaited<ReturnType<typeof loadCommanderArmRunsFromArtifacts>>[number],
  manifest: CommanderExperimentPreRegistration,
  arm: "A" | "B" | "C",
): string[] {
  const codes: string[] = [];
  const configuration = manifest.configuration;
  if (!isRecord(configuration)) return ["ARM_TREATMENT_CONFIGURATION_INVALID"];
  const expectedSharedArgs = [
    `--runner=${run.gameConfiguration.runnerMode}`,
    `--turns-per-decision-step=${run.gameConfiguration.runner.turnsPerDecisionStep}`,
    `--max-decision-ms=${run.gameConfiguration.runner.maxDecisionMs}`,
    `--max-steps=${run.gameConfiguration.runner.maxSteps}`,
    `--agents=${run.gameConfiguration.agents}`,
    `--opponent-brain=${run.gameConfiguration.opponentBrainMode}`,
    ...(run.requireWinner ? ["--require-winner"] : []),
  ];
  const definitions = Array.isArray(configuration.arms)
    ? configuration.arms
    : [];
  const definition = definitions.find(
    (entry) => isRecord(entry) && entry.arm === arm,
  );
  if (!isRecord(definition) || !isRecord(definition.provenance)) {
    return ["ARM_DEFINITION_MISMATCH"];
  }
  const expectedBrainType =
    definition.brain === "planner" || definition.brain === "planner-claude-cli"
      ? "planner-executor"
      : "strategic-commander";
  const subject = run.roster[run.subjectSeatIndex];
  if (
    configuration.providerMode !== manifest.runtime.providerMode ||
    configuration.protocol !== run.protocol
  ) {
    codes.push("ARM_PROTOCOL_PROVIDER_MISMATCH");
  }
  if (
    configuration.maxSteps !== run.gameConfiguration.runner.maxSteps ||
    configuration.turnsPerDecisionStep !==
      run.gameConfiguration.runner.turnsPerDecisionStep ||
    configuration.requireWinner !== run.requireWinner ||
    configuration.requireWinner !==
      run.gameConfiguration.runner.requireWinner ||
    configuration.planEveryDecisionSteps !==
      run.gameConfiguration.planEveryDecisionSteps ||
    JSON.stringify(configuration.sharedArgs) !==
      JSON.stringify(expectedSharedArgs) ||
    sha256Canonical(configuration.selectedGameConfig) !==
      sha256Canonical(run.gameConfiguration.selectedGameConfig)
  ) {
    codes.push("ARM_GAME_TREATMENT_MISMATCH");
  }
  if (
    !isRecord(configuration.socialFlags) ||
    configuration.socialFlags.structuredDeals !==
      run.experimentFlags.structuredDeals ||
    configuration.socialFlags.freeTextMessages !==
      run.experimentFlags.freeTextMessages ||
    run.experimentFlags.localSmoke !==
      (configuration.providerMode === "scripted")
  ) {
    codes.push("ARM_SOCIAL_TREATMENT_MISMATCH");
  }
  if (
    stableAnalysisSpecification(configuration.analysisSpecification) !==
    stableAnalysisSpecification(run.analysisSpecification)
  ) {
    codes.push("ARM_ANALYSIS_SPECIFICATION_MISMATCH");
  }
  if (
    subject?.agentID !== run.subjectAgentID ||
    subject?.brainType !== expectedBrainType ||
    definition.provenance.provider !== run.provider ||
    definition.provenance.model !== run.model ||
    definition.provenance.promptVersion !== run.promptVersion
  ) {
    codes.push("ARM_DEFINITION_MISMATCH");
  }
  return codes;
}

function stableAnalysisSpecification(value: unknown): string {
  if (value === null) return "null";
  if (!isCommanderConfirmatoryAnalysisSpecification(value)) return "invalid";
  return sha256Canonical(value);
}

function isNonZeroSha256(value: unknown): value is string {
  return isSha256(value) && value !== "0".repeat(64);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}
