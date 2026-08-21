import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildClaudeCliCommandArgs,
  type ClaudeCliLlmProviderConfig,
  DEFAULT_CLAUDE_DISALLOWED_TOOLS,
} from "./ClaudeCliLlmProvider";
import { compareCommanderStrings } from "./CommanderPrimitives";

export const COMMANDER_OUTER_DECISION_TIMEOUT_MS = 120_000;
export const COMMANDER_SELECTOR_TIMEOUT_MS = 12_000;
export const COMMANDER_PROVIDER_KILL_TIMEOUT_MS = 11_000;

/**
 * Every AgentTunables override that can change an arm's observation, menu, or
 * policy. Values are the shipped defaults, made explicit for a sealed run.
 */
export const COMMANDER_EXPERIMENT_TUNABLE_DEFAULTS = {
  ATTACK_LADDER: "0",
  BEHIND_AND_FALLING: "1",
  COALITION: "0",
  COALITION_LEADER_FLOOR: "0.18",
  COALITION_LEADER_RATIO: "1.15",
  DIPLOMACY_RESERVE: "8",
  DIPLOMACY_SLOTS: "0",
  DIRECTIVE_BUILD: "0",
  DIRECTIVE_COMMITMENT: "1",
  DIRECTIVE_DIPLOMACY: "1",
  DOMINANCE_CONVERSION: "0",
  DOMINANCE_RATIO: "1.3",
  DOMINANCE_SHARE_FLOOR: "0.12",
  ECONOMY_BOOTSTRAP: "0",
  ECONOMY_BOOTSTRAP_MIN_TILES: "0",
  ECONOMY_EVENTS: "0",
  ECONOMY_OBSERVATION: "0",
  ENFORCE_CONVERSION: "1",
  FREETEXT_MESSAGES: "0",
  GOLD_PRESSURE: "0",
  GOLD_PRESSURE_FLOOR: "3000000",
  GOLD_PRESSURE_MIRV_FLOOR: "30000000",
  INHOUSE_SOCIAL_PROMPT: "0",
  MESSAGE_BEATS_DISPLAY: "1",
  NAVAL_WAR: "0",
  NAVAL_WAR_TROOP_FLOOR: "0.7",
  OPENING_COMMIT: "0",
  OPENING_COMMIT_RATIO: "0.35",
  OPENING_COMMIT_TROOP_FLOOR: "0.55",
  OPENING_PHASE_LOCK: "0",
  OPENING_TEMPO: "0",
  PRIMARY_ARGMAX: "0",
  SPATIAL_MINIMAP: "0",
  SPATIAL_OBSERVATION: "0",
  STRUCTURED_DEALS: "0",
  THIN_EXECUTOR: "0",
  UPGRADE_VISIBILITY: "0",
  WAR_DUEL_COMBINED_SHARE: "0.6",
  WAR_MIN_RATIO: "0.8",
  WAR_MODE: "0",
} as const;

const CHILD_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
] as const;

const SOURCE_COMPONENT_PATHS = {
  core: ["src/core"],
  server: ["src/server"],
  harness: [
    "src/scripts/ai-agent-commander-arm-gate.ts",
    "src/scripts/ai-agent-league-smoke.ts",
    "src/scripts/ai-agent-frontier-benchmark.ts",
  ],
  config: [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
    "vite.config.ts",
  ],
  runtimeAssets: [
    "resources/maps/asia",
    "resources/QuickChat.json",
    "resources/countries.json",
  ],
} as const;

export interface CommanderRuntimeIdentity {
  schemaVersion: 1;
  providerMode: "scripted" | "claude-cli";
  outerDecisionTimeoutMs: number;
  commanderSelectorTimeoutMs: number;
  provider: {
    type: "mock" | "claude-cli";
    binaryPath: string | null;
    binarySha256: string | null;
    version: string | null;
    cwd: string | null;
    cwdStateSha256: string | null;
    model: string;
    argv: string[];
    allowedTools: string[];
    disallowedTools: string;
    killTimeoutMs: number | null;
  };
  environment: {
    sanitized: true;
    values: Record<string, string | null>;
    snapshotSha256: string;
    tunableValues: Record<string, string>;
    tunableSnapshotSha256: string;
    childEnvironmentKeys: string[];
    childEnvironmentSha256: string;
  };
  identitySha256: string;
}

export interface ResolvedCommanderRuntime {
  identity: CommanderRuntimeIdentity;
  behaviorEnvironment: Record<string, string | null>;
  providerConfig: ClaudeCliLlmProviderConfig | null;
}

export interface CommanderSourceIdentity {
  schemaVersion: 1;
  sourceSha: string;
  sourceTreeSha: string;
  clean: boolean;
  statusSha256: string;
  ignoredLoadBearingFiles: string[];
  componentHashes: Record<keyof typeof SOURCE_COMPONENT_PATHS, string>;
  componentFiles: Record<
    keyof typeof SOURCE_COMPONENT_PATHS,
    Array<{ path: string; sha256: string }>
  >;
  loadBearingTreeSha256: string;
  identitySha256: string;
}

export interface CommanderSeedManifestEntry {
  replicaIndex: number;
  runID: string;
  seed: string;
  gameID: string;
  subjectSeatIndex: number;
  episodeIndex: number;
  armOrder: readonly ["A", "B", "C"];
}

export interface CommanderExperimentPreRegistration {
  schemaVersion: 1;
  experimentKind: "strategic-commander-three-arm";
  experimentID: string;
  createdAt: string;
  source: CommanderSourceIdentity;
  runtime: CommanderRuntimeIdentity;
  configuration: Record<string, unknown>;
  seeds: CommanderSeedManifestEntry[];
  expectedArmManifestPaths: string[];
}

export interface CommanderExperimentPreRegistrationEnvelope {
  manifest: CommanderExperimentPreRegistration;
  manifestSha256: string;
}

export interface CommanderExperimentSeal {
  schemaVersion: 1;
  experimentKind: "strategic-commander-three-arm-seal";
  experimentID: string;
  status: "complete" | "invalid";
  reasons: string[];
  preRegistrationManifestSha256: string;
  finalSource: CommanderSourceIdentity | null;
  finalRuntime: CommanderRuntimeIdentity | null;
  recapture: {
    source: "captured" | "unavailable";
    runtime: "captured" | "unavailable";
    sourceFailure: string | null;
    runtimeFailure: string | null;
  };
  artifacts: Array<{ path: string; sha256: string }>;
}

export interface CommanderExperimentSealEnvelope {
  seal: CommanderExperimentSeal;
  sealSha256: string;
}

interface RuntimeInspection {
  resolveDefaultBinary?: (env: NodeJS.ProcessEnv) => string;
  realpath?: (value: string) => string;
  readBinary?: (value: string) => Buffer;
  readVersion?: (value: string, env: NodeJS.ProcessEnv) => string;
}

export function newCommanderExperimentID(): string {
  return randomUUID();
}

export function assertCommanderExperimentID(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error("Commander experiment ID must be a unique UUIDv4");
  }
}

export function resolveScriptedCommanderRuntime(
  env: NodeJS.ProcessEnv = process.env,
  sourceRoot: string = process.cwd(),
): ResolvedCommanderRuntime {
  assertCommanderTunableCoverage(sourceRoot);
  assertAmbientTunableDefaults(env);
  const behaviorEnvironment = behaviorEnvironmentValues();
  const childEnvironment = sanitizedChildEnvironment(env);
  const resolved: ResolvedCommanderRuntime = {
    identity: runtimeIdentity({
      providerMode: "scripted",
      behaviorEnvironment,
      childEnvironment,
      provider: {
        type: "mock",
        binaryPath: null,
        binarySha256: null,
        version: null,
        cwd: null,
        cwdStateSha256: null,
        model: "scripted-deterministic-plumbing-v1",
        argv: [],
        allowedTools: [],
        disallowedTools: "",
        killTimeoutMs: null,
      },
    }),
    behaviorEnvironment,
    providerConfig: null,
  };
  assertResolvedCommanderRuntime(resolved);
  return resolved;
}

export function resolveRealCommanderRuntime(
  env: NodeJS.ProcessEnv = process.env,
  inspection: RuntimeInspection = {},
  providerCwd: string = process.cwd(),
  sourceRoot: string = process.cwd(),
): ResolvedCommanderRuntime {
  assertCommanderTunableCoverage(sourceRoot);
  assertAmbientTunableDefaults(env);
  assertExactProviderOverrides(env);
  const childEnvironment = sanitizedChildEnvironment(env);
  const resolveDefault =
    inspection.resolveDefaultBinary ?? resolveDefaultClaudeBinary;
  const realpath = inspection.realpath ?? fsSync.realpathSync;
  const readBinary = inspection.readBinary ?? fsSync.readFileSync;
  const readVersion = inspection.readVersion ?? readClaudeVersion;
  const allowedBinary = realpath(resolveDefault(childEnvironment));
  const configuredCommand = env.AI_LEAGUE_CLAUDE_COMMAND?.trim();
  const requestedCommand =
    configuredCommand === undefined || configuredCommand === ""
      ? "claude"
      : configuredCommand;
  const requestedBinary = realpath(
    requestedCommand === "claude"
      ? allowedBinary
      : resolveExecutable(requestedCommand, childEnvironment),
  );
  if (requestedBinary !== allowedBinary) {
    throw new Error(
      "real-provider Commander experiments reject non-allowlisted Claude binaries",
    );
  }
  const model = env.AI_LEAGUE_CLAUDE_MODEL?.trim() ?? "";
  assertExactNonAliasClaudeModel(model);
  const providerCwdSnapshot = snapshotEmptyProviderCwd(providerCwd);
  const providerConfig: ClaudeCliLlmProviderConfig = {
    command: allowedBinary,
    model,
    timeoutMs: COMMANDER_PROVIDER_KILL_TIMEOUT_MS,
    cwd: providerCwdSnapshot.path,
    disallowedTools: DEFAULT_CLAUDE_DISALLOWED_TOOLS,
    allowedTools: [],
    noSessionPersistence: true,
    safeMode: true,
    env: childEnvironment,
  };
  const behaviorEnvironment = behaviorEnvironmentValues({
    AI_LEAGUE_CLAUDE_COMMAND: allowedBinary,
    AI_LEAGUE_CLAUDE_MODEL: model,
    AI_LEAGUE_CLAUDE_TIMEOUT_MS: String(COMMANDER_PROVIDER_KILL_TIMEOUT_MS),
    AI_LEAGUE_CLAUDE_DISALLOWED_TOOLS: DEFAULT_CLAUDE_DISALLOWED_TOOLS,
    AI_LEAGUE_LLM_MODEL: null,
    AI_LEAGUE_LLM_TIMEOUT_MS: null,
  });
  const resolved: ResolvedCommanderRuntime = {
    identity: runtimeIdentity({
      providerMode: "claude-cli",
      behaviorEnvironment,
      childEnvironment,
      provider: {
        type: "claude-cli",
        binaryPath: allowedBinary,
        binarySha256: sha256(readBinary(allowedBinary)),
        version: readVersion(allowedBinary, childEnvironment),
        cwd: providerCwdSnapshot.path,
        cwdStateSha256: providerCwdSnapshot.stateSha256,
        model,
        argv: buildClaudeCliCommandArgs(providerConfig),
        allowedTools: [],
        disallowedTools: DEFAULT_CLAUDE_DISALLOWED_TOOLS,
        killTimeoutMs: COMMANDER_PROVIDER_KILL_TIMEOUT_MS,
      },
    }),
    behaviorEnvironment,
    providerConfig,
  };
  assertResolvedCommanderRuntime(resolved);
  return resolved;
}

export function assertExactNonAliasClaudeModel(model: string): void {
  if (!/^claude-[a-z0-9][a-z0-9-]*-\d{8}$/i.test(model)) {
    throw new Error(
      "real-provider Commander experiments require an exact non-alias Claude model ID ending in YYYYMMDD",
    );
  }
}

/** Prevents an injected or later-mutated provider config from wearing a sealed identity. */
export function assertResolvedCommanderRuntime(
  runtime: ResolvedCommanderRuntime,
): void {
  const identity = runtime.identity;
  const { identitySha256, ...identityMaterial } = identity;
  if (sha256Canonical(identityMaterial) !== identitySha256) {
    throw new Error(
      "Commander runtime identity envelope is internally invalid",
    );
  }
  if (
    identity.outerDecisionTimeoutMs !== COMMANDER_OUTER_DECISION_TIMEOUT_MS ||
    identity.commanderSelectorTimeoutMs !== COMMANDER_SELECTOR_TIMEOUT_MS
  ) {
    throw new Error(
      "Commander runtime decision budgets disagree with protocol",
    );
  }
  if (
    sha256Canonical(runtime.behaviorEnvironment) !==
      identity.environment.snapshotSha256 ||
    sha256Canonical(identity.environment.values) !==
      identity.environment.snapshotSha256 ||
    sha256Canonical(identity.environment.tunableValues) !==
      identity.environment.tunableSnapshotSha256
  ) {
    throw new Error("Commander runtime environment identity is inconsistent");
  }
  const expectedTunables = Object.fromEntries(
    Object.entries(COMMANDER_EXPERIMENT_TUNABLE_DEFAULTS).map(
      ([key, value]) => [`PROXYWAR_TUNE_${key}`, value],
    ),
  );
  if (
    sha256Canonical(expectedTunables) !==
    identity.environment.tunableSnapshotSha256
  ) {
    throw new Error("Commander runtime tunable identity is inconsistent");
  }
  if (identity.providerMode === "scripted") {
    if (
      runtime.providerConfig !== null ||
      identity.provider.type !== "mock" ||
      identity.provider.binaryPath !== null
    ) {
      throw new Error("scripted Commander runtime has a relabeled provider");
    }
    return;
  }
  const config = runtime.providerConfig;
  if (config === null || identity.provider.type !== "claude-cli") {
    throw new Error("real Commander runtime has a relabeled provider");
  }
  const configEnvironment = config.env ?? {};
  const unexpectedEnvironmentKeys = Object.keys(configEnvironment).filter(
    (key) => !identity.environment.childEnvironmentKeys.includes(key),
  );
  const childSnapshot = Object.fromEntries(
    identity.environment.childEnvironmentKeys.map((key) => [
      key,
      configEnvironment[key] ?? null,
    ]),
  );
  if (
    unexpectedEnvironmentKeys.length > 0 ||
    sha256Canonical(childSnapshot) !==
      identity.environment.childEnvironmentSha256 ||
    config.command !== identity.provider.binaryPath ||
    config.cwd !== identity.provider.cwd ||
    config.model !== identity.provider.model ||
    config.timeoutMs !== identity.provider.killTimeoutMs ||
    config.disallowedTools !== identity.provider.disallowedTools ||
    config.noSessionPersistence !== true ||
    config.safeMode !== true ||
    JSON.stringify(config.allowedTools ?? null) !==
      JSON.stringify(identity.provider.allowedTools) ||
    JSON.stringify(buildClaudeCliCommandArgs(config)) !==
      JSON.stringify(identity.provider.argv)
  ) {
    throw new Error(
      "real Commander provider config disagrees with its identity",
    );
  }
  const currentCwd = snapshotEmptyProviderCwd(identity.provider.cwd ?? "");
  if (
    currentCwd.path !== identity.provider.cwd ||
    currentCwd.stateSha256 !== identity.provider.cwdStateSha256
  ) {
    throw new Error("real Commander provider cwd identity drifted");
  }
}

/**
 * Creates the sealed provider's only working directory. The UUID path is
 * exclusive, owner-only, and empty; later runtime assertions recheck it.
 */
export function prepareCommanderProviderCwd(
  experimentID: string,
  temporaryRoot: string = os.tmpdir(),
): string {
  assertCommanderExperimentID(experimentID);
  const trustedTemporaryRoot = fsSync.realpathSync(temporaryRoot);
  const baseDirectory = path.join(
    trustedTemporaryRoot,
    "proxywar-commander-provider-cwds",
  );
  fsSync.mkdirSync(baseDirectory, { recursive: true, mode: 0o700 });
  const baseStat = fsSync.lstatSync(baseDirectory);
  if (
    baseStat.isSymbolicLink() ||
    !baseStat.isDirectory() ||
    (typeof process.getuid === "function" &&
      baseStat.uid !== process.getuid()) ||
    (baseStat.mode & 0o077) !== 0
  ) {
    throw new Error("Commander provider cwd base is not a real directory");
  }
  const canonicalBase = fsSync.realpathSync(baseDirectory);
  if (canonicalBase !== path.resolve(baseDirectory)) {
    throw new Error("Commander provider cwd base contains a symlink");
  }
  const providerCwd = path.join(canonicalBase, experimentID);
  try {
    fsSync.mkdirSync(providerCwd, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Commander provider cwd already exists; refusing experiment reuse",
        { cause: error },
      );
    }
    throw error;
  }
  return snapshotEmptyProviderCwd(providerCwd).path;
}

export async function withCommanderExperimentEnvironment<T>(
  values: Readonly<Record<string, string | null>>,
  task: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await task();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function captureCommanderSourceIdentity(
  sourceRoot = process.cwd(),
): Promise<CommanderSourceIdentity> {
  const sourceSha = git(sourceRoot, ["rev-parse", "HEAD"]);
  const sourceTreeSha = git(sourceRoot, ["rev-parse", "HEAD^{tree}"]);
  const status = git(sourceRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const componentEntries = await Promise.all(
    Object.entries(SOURCE_COMPONENT_PATHS).map(
      async ([key, pathspecs]) =>
        [
          key,
          await snapshotTrackedAndUntrackedFiles(sourceRoot, pathspecs),
        ] as const,
    ),
  );
  const componentHashes = Object.fromEntries(
    componentEntries.map(([key, snapshot]) => [key, snapshot.treeSha256]),
  ) as Record<keyof typeof SOURCE_COMPONENT_PATHS, string>;
  const componentFiles = Object.fromEntries(
    componentEntries.map(([key, snapshot]) => [key, snapshot.files]),
  ) as Record<
    keyof typeof SOURCE_COMPONENT_PATHS,
    Array<{ path: string; sha256: string }>
  >;
  const ignoredLoadBearingFiles = [
    ...new Set(
      componentEntries.flatMap(([_key, snapshot]) => snapshot.ignoredFiles),
    ),
  ].sort();
  const effectiveStatus = [
    status,
    ...ignoredLoadBearingFiles.map((entry) => `!! ${entry}`),
  ]
    .filter((entry) => entry !== "")
    .join("\n");
  const partial = {
    schemaVersion: 1 as const,
    sourceSha,
    sourceTreeSha,
    clean: effectiveStatus === "",
    statusSha256: sha256(effectiveStatus),
    ignoredLoadBearingFiles,
    componentHashes,
    componentFiles,
    loadBearingTreeSha256: sha256Canonical(componentFiles),
  };
  return { ...partial, identitySha256: sha256Canonical(partial) };
}

export function assertCommanderIdentityUnchanged(input: {
  initialSource: CommanderSourceIdentity;
  currentSource: CommanderSourceIdentity;
  initialRuntime: CommanderRuntimeIdentity;
  currentRuntime: CommanderRuntimeIdentity;
}): void {
  if (
    input.initialSource.identitySha256 !== input.currentSource.identitySha256
  ) {
    throw new Error("Commander experiment source identity drifted mid-run");
  }
  if (
    input.initialRuntime.identitySha256 !== input.currentRuntime.identitySha256
  ) {
    throw new Error("Commander experiment runtime identity drifted mid-run");
  }
}

export async function reserveCommanderExperimentOutput(input: {
  outputDirectory: string;
  manifest: CommanderExperimentPreRegistration;
  /** Required by the real gate; omitted only by contained scripted tests. */
  containmentRoot?: string;
}): Promise<{
  manifestPath: string;
  envelope: CommanderExperimentPreRegistrationEnvelope;
}> {
  assertCommanderExperimentID(input.manifest.experimentID);
  const outputDirectory = path.resolve(input.outputDirectory);
  if (input.containmentRoot === undefined) {
    await fs.mkdir(path.dirname(outputDirectory), { recursive: true });
    await createExclusiveDirectory(outputDirectory);
  } else {
    await createContainedExclusiveDirectory(
      input.containmentRoot,
      outputDirectory,
    );
  }
  const envelope: CommanderExperimentPreRegistrationEnvelope = {
    manifest: input.manifest,
    manifestSha256: sha256Canonical(input.manifest),
  };
  const manifestPath = path.join(
    outputDirectory,
    "commander-experiment-manifest.json",
  );
  await writeJsonExclusive(manifestPath, envelope);
  return { manifestPath, envelope };
}

/** Real evidence has one canonical root per UUID, independent of run labels. */
export function commanderExperimentOutputDirectory(
  sourceRoot: string,
  experimentID: string,
): string {
  assertCommanderExperimentID(experimentID);
  return path.resolve(
    sourceRoot,
    "artifacts",
    "ai-learning-comparisons",
    `commander-experiment-${experimentID}`,
  );
}

export async function writeCommanderExperimentSeal(input: {
  outputDirectory: string;
  containmentRoot?: string;
  seal: Omit<CommanderExperimentSeal, "artifacts">;
  artifactPaths: readonly string[];
}): Promise<{
  sealPath: string;
  envelope: CommanderExperimentSealEnvelope;
}> {
  assertCommanderExperimentSealStatus(input.seal);
  const requestedOutputDirectory = path.resolve(input.outputDirectory);
  const outputDirectory =
    input.containmentRoot === undefined
      ? await canonicalRealDirectory(requestedOutputDirectory)
      : await assertCommanderContainedRealDirectory(
          input.containmentRoot,
          requestedOutputDirectory,
        );
  const artifactPaths =
    input.seal.status === "invalid"
      ? [
          ...input.artifactPaths,
          ...(await inventoryCommanderExperimentArtifacts(outputDirectory)),
        ]
      : [...input.artifactPaths];
  const artifacts = await Promise.all(
    [...new Set(artifactPaths.map((entry) => path.resolve(entry)))]
      .sort()
      .map(async (artifactPath) => {
        const requestedArtifactStat = await fs.lstat(artifactPath);
        if (
          !requestedArtifactStat.isFile() ||
          requestedArtifactStat.isSymbolicLink()
        ) {
          throw new Error("Commander seal artifact is not a real file");
        }
        const realArtifactPath = await fs.realpath(artifactPath);
        const expectedRealArtifactPath = canonicalArtifactPathWithinOutput({
          requestedOutputDirectory,
          outputDirectory,
          artifactPath,
        });
        if (realArtifactPath !== expectedRealArtifactPath) {
          throw new Error("Commander seal artifact path contains a symlink");
        }
        return {
          path: containedRelativePath(outputDirectory, realArtifactPath),
          sha256: sha256(await fs.readFile(realArtifactPath)),
        };
      }),
  );
  const seal: CommanderExperimentSeal = { ...input.seal, artifacts };
  const envelope: CommanderExperimentSealEnvelope = {
    seal,
    sealSha256: sha256Canonical(seal),
  };
  const sealPath = path.join(
    requestedOutputDirectory,
    "commander-experiment-seal.json",
  );
  await writeJsonExclusive(sealPath, envelope);
  return { sealPath, envelope };
}

function canonicalArtifactPathWithinOutput(input: {
  requestedOutputDirectory: string;
  outputDirectory: string;
  artifactPath: string;
}): string {
  for (const candidateRoot of [
    input.requestedOutputDirectory,
    input.outputDirectory,
  ]) {
    const relative = path.relative(candidateRoot, input.artifactPath);
    if (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    ) {
      return path.resolve(input.outputDirectory, relative);
    }
  }
  throw new Error("Commander seal artifact path escapes output root");
}

function assertCommanderExperimentSealStatus(
  seal: Omit<CommanderExperimentSeal, "artifacts">,
): void {
  if (seal.status === "complete") {
    if (
      seal.reasons.length !== 0 ||
      seal.finalSource === null ||
      seal.finalRuntime === null ||
      seal.recapture.source !== "captured" ||
      seal.recapture.runtime !== "captured" ||
      seal.recapture.sourceFailure !== null ||
      seal.recapture.runtimeFailure !== null
    ) {
      throw new Error(
        "Complete Commander experiment seal has inconsistent evidence status",
      );
    }
    return;
  }
  if (seal.status !== "invalid") {
    throw new Error("Commander experiment seal status is unknown");
  }
  if (seal.reasons.length === 0) {
    throw new Error("Invalid Commander experiment seal requires a reason");
  }
  assertCommanderRecaptureStatus(
    "source",
    seal.recapture.source,
    seal.finalSource,
    seal.recapture.sourceFailure,
  );
  assertCommanderRecaptureStatus(
    "runtime",
    seal.recapture.runtime,
    seal.finalRuntime,
    seal.recapture.runtimeFailure,
  );
}

function assertCommanderRecaptureStatus(
  label: "source" | "runtime",
  status: "captured" | "unavailable",
  identity: CommanderSourceIdentity | CommanderRuntimeIdentity | null,
  failure: string | null,
): void {
  if (status !== "captured" && status !== "unavailable") {
    throw new Error(
      `Invalid Commander experiment seal has unknown ${label} recapture status`,
    );
  }
  const captured = status === "captured";
  if (
    (captured && (identity === null || failure !== null)) ||
    (!captured && (identity !== null || failure === null || failure === ""))
  ) {
    throw new Error(
      `Invalid Commander experiment seal has inconsistent ${label} recapture status`,
    );
  }
}

async function inventoryCommanderExperimentArtifacts(
  outputDirectory: string,
): Promise<string[]> {
  const artifacts: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      compareCommanderStrings(left.name, right.name),
    );
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          "Commander invalid evidence inventory contains a symlink",
        );
      }
      if (stat.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(
          "Commander invalid evidence inventory contains a non-file entry",
        );
      }
      if (
        entry.name === "commander-experiment-seal.json" ||
        /^\..+\.[0-9a-f-]{36}\.tmp$/i.test(entry.name)
      ) {
        continue;
      }
      const realEntryPath = await fs.realpath(entryPath);
      if (realEntryPath !== entryPath) {
        throw new Error(
          "Commander invalid evidence inventory contains a redirected path",
        );
      }
      containedRelativePath(outputDirectory, realEntryPath);
      artifacts.push(realEntryPath);
    }
  };
  await visit(outputDirectory);
  return artifacts;
}

export async function sha256File(value: string): Promise<string> {
  return sha256(await fs.readFile(value));
}

export function sha256Canonical(value: unknown): string {
  const serialized = JSON.stringify(canonicalValue(value));
  return sha256(serialized ?? "undefined");
}

function runtimeIdentity(input: {
  providerMode: CommanderRuntimeIdentity["providerMode"];
  behaviorEnvironment: Record<string, string | null>;
  childEnvironment: NodeJS.ProcessEnv;
  provider: CommanderRuntimeIdentity["provider"];
}): CommanderRuntimeIdentity {
  const tunableValues = Object.fromEntries(
    Object.entries(COMMANDER_EXPERIMENT_TUNABLE_DEFAULTS).map(
      ([key, value]) => [`PROXYWAR_TUNE_${key}`, value],
    ),
  );
  const childEnvironmentSnapshot = Object.fromEntries(
    CHILD_ENVIRONMENT_KEYS.map((key) => [
      key,
      input.childEnvironment[key] ?? null,
    ]),
  );
  const partial = {
    schemaVersion: 1 as const,
    providerMode: input.providerMode,
    outerDecisionTimeoutMs: COMMANDER_OUTER_DECISION_TIMEOUT_MS,
    commanderSelectorTimeoutMs: COMMANDER_SELECTOR_TIMEOUT_MS,
    provider: input.provider,
    environment: {
      sanitized: true as const,
      values: input.behaviorEnvironment,
      snapshotSha256: sha256Canonical(input.behaviorEnvironment),
      tunableValues,
      tunableSnapshotSha256: sha256Canonical(tunableValues),
      childEnvironmentKeys: [...CHILD_ENVIRONMENT_KEYS],
      childEnvironmentSha256: sha256Canonical(childEnvironmentSnapshot),
    },
  };
  return { ...partial, identitySha256: sha256Canonical(partial) };
}

function behaviorEnvironmentValues(
  extra: Record<string, string | null> = {},
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries({
      GAME_ENV: "dev",
      NODE_ENV: null,
      TZ: "UTC",
      AI_LEAGUE_AGENT_PERSONALITY: null,
      AI_LEAGUE_CLAUDE_COMMAND: null,
      AI_LEAGUE_CLAUDE_DISALLOWED_TOOLS: null,
      AI_LEAGUE_CLAUDE_MODEL: null,
      AI_LEAGUE_CLAUDE_TIMEOUT_MS: null,
      AI_LEAGUE_LLM_MODEL: null,
      AI_LEAGUE_LLM_TIMEOUT_MS: null,
      AI_LEAGUE_PLAYER_AGENT_NAME: null,
      AI_LEAGUE_REQUIRE_CODEX_SUCCESS: null,
      AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS: null,
      PROXYWAR_PLAN_EVERY_DECISION_STEPS: null,
      PROXYWAR_WRITE_DEMO_INDEX: null,
      ...Object.fromEntries(
        Object.entries(COMMANDER_EXPERIMENT_TUNABLE_DEFAULTS).map(
          ([key, value]) => [`PROXYWAR_TUNE_${key}`, value],
        ),
      ),
      ...extra,
    }).sort(([left], [right]) => compareCommanderStrings(left, right)),
  );
}

function assertAmbientTunableDefaults(env: NodeJS.ProcessEnv): void {
  for (const [name, expected] of Object.entries(
    COMMANDER_EXPERIMENT_TUNABLE_DEFAULTS,
  )) {
    const key = `PROXYWAR_TUNE_${name}`;
    const actual = env[key]?.trim();
    if (actual !== undefined && actual !== "" && actual !== expected) {
      throw new Error(
        `Commander experiment rejects ambient tunable override ${key}`,
      );
    }
  }
}

function assertExactProviderOverrides(env: NodeJS.ProcessEnv): void {
  const timeout = env.AI_LEAGUE_CLAUDE_TIMEOUT_MS?.trim();
  if (
    timeout !== undefined &&
    timeout !== "" &&
    timeout !== String(COMMANDER_PROVIDER_KILL_TIMEOUT_MS)
  ) {
    throw new Error("Commander experiment rejects altered provider timeout");
  }
  const tools = env.AI_LEAGUE_CLAUDE_DISALLOWED_TOOLS?.trim();
  if (
    tools !== undefined &&
    tools !== "" &&
    tools !== DEFAULT_CLAUDE_DISALLOWED_TOOLS
  ) {
    throw new Error("Commander experiment rejects altered Claude tool policy");
  }
  if (
    (env.AI_LEAGUE_LLM_MODEL?.trim() ?? "") !== "" ||
    (env.AI_LEAGUE_LLM_TIMEOUT_MS?.trim() ?? "") !== ""
  ) {
    throw new Error("Commander experiment rejects provider alias environment");
  }
}

function assertCommanderTunableCoverage(sourceRoot: string): void {
  const source = fsSync.readFileSync(
    path.join(sourceRoot, "src/server/agents/AgentTunables.ts"),
    "utf8",
  );
  const discovered = [...source.matchAll(/tunedNumber\("([A-Z0-9_]+)"/g)]
    .map((match) => match[1]!)
    .sort();
  const declared = Object.keys(COMMANDER_EXPERIMENT_TUNABLE_DEFAULTS).sort();
  if (
    discovered.length !== declared.length ||
    discovered.some((entry, index) => entry !== declared[index])
  ) {
    throw new Error(
      "Commander experiment tunable snapshot is incomplete for AgentTunables",
    );
  }
}

function sanitizedChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    CHILD_ENVIRONMENT_KEYS.flatMap((key) =>
      env[key] === undefined ? [] : [[key, env[key]!]],
    ),
  );
}

function snapshotEmptyProviderCwd(value: string): {
  path: string;
  stateSha256: string;
} {
  if (value.trim() === "") {
    throw new Error("Commander provider cwd is missing");
  }
  const lexicalPath = path.resolve(value);
  const stat = fsSync.lstatSync(lexicalPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Commander provider cwd is not a real directory");
  }
  if (
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("Commander provider cwd is not owner-only");
  }
  const canonicalPath = fsSync.realpathSync(lexicalPath);
  if (canonicalPath !== lexicalPath) {
    throw new Error("Commander provider cwd contains a symlink");
  }
  const entries = fsSync
    .readdirSync(canonicalPath)
    .sort(compareCommanderStrings);
  if (entries.length !== 0) {
    throw new Error("Commander provider cwd is not empty");
  }
  return {
    path: canonicalPath,
    stateSha256: sha256Canonical({
      path: canonicalPath,
      device: String(stat.dev),
      inode: String(stat.ino),
      mode: stat.mode,
      entries,
    }),
  };
}

function resolveDefaultClaudeBinary(_env: NodeJS.ProcessEnv): string {
  const candidates = commanderTrustedClaudeBinaryCandidates();
  for (const candidate of candidates) {
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      if (fsSync.statSync(candidate).isFile()) return candidate;
    } catch {
      // Only the fixed installation allowlist is eligible.
    }
  }
  throw new Error(
    "Unable to resolve Claude from the fixed experiment binary allowlist",
  );
}

export function commanderTrustedClaudeBinaryCandidates(
  userHome = os.userInfo().homedir,
): string[] {
  return [
    path.join(userHome, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string {
  const candidates =
    path.isAbsolute(command) || command.includes(path.sep)
      ? [path.resolve(command)]
      : (env.PATH ?? "")
          .split(path.delimiter)
          .filter((entry) => entry !== "")
          .map((entry) => path.join(entry, command));
  for (const candidate of candidates) {
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      if (fsSync.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next explicit PATH entry.
    }
  }
  throw new Error(`Unable to resolve executable ${command}`);
}

function readClaudeVersion(binary: string, env: NodeJS.ProcessEnv): string {
  const version = execFileSync(binary, ["--version"], {
    encoding: "utf8",
    env,
    timeout: 5_000,
  }).trim();
  if (version === "") throw new Error("Claude CLI version is empty");
  return version;
}

async function snapshotTrackedAndUntrackedFiles(
  sourceRoot: string,
  pathspecs: readonly string[],
): Promise<{
  treeSha256: string;
  files: Array<{ path: string; sha256: string }>;
  ignoredFiles: string[];
}> {
  const visibleFiles = git(sourceRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...pathspecs,
  ])
    .split("\n")
    .filter((entry) => entry !== "");
  const ignoredFiles = git(sourceRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ...pathspecs,
  ])
    .split("\n")
    .filter((entry) => entry !== "")
    .sort();
  const files = [...new Set([...visibleFiles, ...ignoredFiles])].sort();
  if (files.length === 0) {
    throw new Error(
      `Commander source component is empty: ${pathspecs.join(",")}`,
    );
  }
  const hash = createHash("sha256");
  const manifest: Array<{ path: string; sha256: string }> = [];
  for (const relativePath of files) {
    const content = await fs.readFile(path.join(sourceRoot, relativePath));
    hash.update(relativePath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
    manifest.push({ path: relativePath, sha256: sha256(content) });
  }
  return {
    treeSha256: hash.digest("hex"),
    files: manifest,
    ignoredFiles,
  };
}

function git(sourceRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCommanderStrings(left, right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJsonExclusive(
  value: string,
  payload: unknown,
): Promise<void> {
  const directory = await canonicalRealDirectory(path.dirname(value));
  const finalPath = path.join(directory, path.basename(value));
  const temporaryPath = path.join(
    directory,
    `.${path.basename(value)}.${randomUUID()}.tmp`,
  );
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    // A hard link is an atomic, no-overwrite publication on the same volume.
    await fs.link(temporaryPath, finalPath);
    await syncDirectory(directory);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await syncDirectory(directory);
  }
}

async function createExclusiveDirectory(value: string): Promise<void> {
  try {
    await fs.mkdir(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Commander experiment output root already exists; refusing overwrite",
        { cause: error },
      );
    }
    throw error;
  }
  await canonicalRealDirectory(value);
}

async function createContainedExclusiveDirectory(
  containmentRoot: string,
  outputDirectory: string,
): Promise<void> {
  const root = await canonicalRealDirectory(containmentRoot);
  if (root !== path.resolve(containmentRoot)) {
    throw new Error("Commander evidence containment root contains a symlink");
  }
  const relative = path.relative(root, outputDirectory);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Commander experiment output root escapes source root");
  }
  const segments = relative.split(path.sep).filter((entry) => entry !== "");
  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const final = index === segments.length - 1;
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
          "Commander evidence path contains a symlink or non-directory",
        );
      }
      if (final) {
        throw new Error(
          "Commander experiment output root already exists; refusing overwrite",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(cursor, { mode: 0o700 });
      const created = await fs.lstat(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error("Commander evidence path creation was redirected", {
          cause: error,
        });
      }
    }
  }
  await assertCommanderContainedRealDirectory(root, outputDirectory);
}

/** Rechecks every ancestor at use time so a lexical containment claim is not enough. */
export async function assertCommanderContainedRealDirectory(
  containmentRoot: string,
  targetDirectory: string,
): Promise<string> {
  const root = await canonicalRealDirectory(containmentRoot);
  if (root !== path.resolve(containmentRoot)) {
    throw new Error("Commander evidence containment root contains a symlink");
  }
  const target = path.resolve(targetDirectory);
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Commander evidence directory escapes containment root");
  }
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        "Commander evidence directory contains a symlink or non-directory",
      );
    }
  }
  const canonicalTarget = await fs.realpath(target);
  if (canonicalTarget !== target) {
    throw new Error("Commander evidence directory contains a symlink");
  }
  return canonicalTarget;
}

async function canonicalRealDirectory(value: string): Promise<string> {
  const lexical = path.resolve(value);
  const stat = await fs.lstat(lexical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Commander evidence path is not a real directory");
  }
  return fs.realpath(lexical);
}

async function syncDirectory(value: string): Promise<void> {
  const handle = await fs.open(value, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function containedRelativePath(root: string, value: string): string {
  const relative = path.relative(root, value);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Commander seal artifact path escapes output root");
  }
  return relative.split(path.sep).join("/");
}
