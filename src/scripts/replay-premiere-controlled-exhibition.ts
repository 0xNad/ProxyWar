import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Difficulty, GameMapSize, GameMapType } from "../core/game/Game";
import {
  GameRecordSchema,
  GameStartInfoSchema,
  TurnSchema,
  type GameRecord,
  type Winner,
} from "../core/Schemas";
import { replacer } from "../core/Util";
import type {
  AgentRunRosterEntry,
  WriteAgentLeagueRunArtifactsInput,
} from "../server/agents/AgentDecisionLogWriter";
import {
  validateAgentManifest,
  type AgentManifest,
} from "../server/agents/AgentManifest";
import {
  legalActionKinds,
  type LegalActionKind,
} from "../server/agents/AgentTypes";
import type {
  PolicyIdentity,
  PremiereSeatIdentity,
} from "../server/replay-premiere/ReplayPremiereContracts";
import { validateReplayPremiereControlledExecutionConfig } from "../server/replay-premiere/ReplayPremiereControlledExecution";
import {
  assertReplayPremiereJsonValue,
  canonicalReplayPremiereJson,
  hashReplayPremiereJson,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "../server/replay-premiere/ReplayPremiereIntegrity";
import {
  validatePremierePrivateLayout,
  type ValidatedPremierePrivateLayout,
} from "../server/replay-premiere/ReplayPremierePrivateStaging";
import type {
  AgentLeagueSmokeArtifactWriterInput,
  AgentLeagueSmokeExecutionConfig,
  AgentLeagueSmokeInjectedManifest,
  AgentLeagueSmokeRunOptions,
} from "./ai-agent-league-smoke";

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_MAX_BUNDLE_BYTES = 256 * MIB;
const DEFAULT_MIN_FREE_BYTES = 25 * GIB;
const LOW_DISK_MIN_FREE_BYTES = 15 * GIB;
const IMMUTABLE_MIRROR_RESERVE_BYTES = 10 * GIB;
const MAX_POLICY_MANIFEST_BYTES = 1 * MIB;
const SOURCE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SAFE_MANIFEST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,127}$/;
const FORBIDDEN_BUNDLE_KEYS = new Set([
  "decisiontail",
  "decisions",
  "privatepolicyoutput",
  "prompt",
  "rawllmoutput",
  "rawllmprompt",
  "token",
  "tokens",
]);

type DeterministicBrainMode = "rule" | "mock-llm" | "planner";

export interface ControlledPolicyProvenance {
  displayName: string;
  policyIdentity: Extract<PolicyIdentity, { namespace: "local_manifest" }>;
}

export interface ControlledPolicySet {
  policies: readonly ControlledPolicyProvenance[];
  injectedManifests: readonly AgentLeagueSmokeInjectedManifest[];
  executionConfigSha256: string;
}

export interface ControlledExhibitionBuildProvenance {
  repositoryHead: string;
  repositoryTree: string;
  trackedWorktreeClean: boolean;
  trackedWorktreeStateSha256: string;
  packageName: string;
  packageVersion: string | null;
  packageJsonSha256: string;
  smokeRunnerSha256: string;
  generatorSha256: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
}

export interface ControlledExhibitionPrivateOutput {
  privateOutputRoot: string;
  servedRoots: readonly string[];
  maxBundleBytes: number;
  minFreeBytes: number;
}

type ControlledExhibitionEnvironment = Partial<
  Record<
    | "PROXYWAR_ALLOW_LOW_DISK_HEAVY_WRITE"
    | "PROXYWAR_PLAN_EVERY_DECISION_STEPS"
    | "AI_LEAGUE_PLAYER_STRATEGY_SPEC",
    string | undefined
  >
>;

export interface ControlledExhibitionWriteOptions {
  sourceRunId: string;
  artifact: AgentLeagueSmokeArtifactWriterInput;
  policies: readonly ControlledPolicyProvenance[];
  expectedExecutionConfig: AgentLeagueSmokeExecutionConfig;
  build: ControlledExhibitionBuildProvenance;
  output: ControlledExhibitionPrivateOutput;
  validatePrivateLayout?: (options: {
    privateStateRoot: string;
    servedRoots: readonly string[];
  }) => Promise<ValidatedPremierePrivateLayout>;
  statfs?: typeof fs.statfs;
  environment?: ControlledExhibitionEnvironment;
}

export interface ControlledExhibitionWriteResult {
  schemaVersion: 1;
  sourceRunId: string;
  bundlePath: string;
  bundleSha256: string;
  byteLength: number;
  authoritativeResultHash: string;
  seats: PremiereSeatIdentity[];
}

export interface ControlledExhibitionSourceBundle {
  schemaVersion: 1;
  bundleKind: "proxywar_controlled_exhibition_source";
  sourceRunId: string;
  createdAt: string;
  gameRecord: ReplayPremiereJsonValue;
  replay: {
    turnCount: number;
    turnIntervalMs: number;
  };
  authoritativeResult: {
    sourceId: string;
    encoding: "base64";
    bytes: string;
    sha256: string;
  };
  seats: PremiereSeatIdentity[];
  provenance: {
    generator: "replay-premiere-controlled-exhibition/v1";
    brainMode: string;
    runnerMode: string;
    executionConfig: AgentLeagueSmokeExecutionConfig;
    executionConfigSha256: string;
    game: {
      gameId: string;
      startedAt: string;
      completedAt: string;
      turnCount: number;
      map: string;
      mapSize: string;
      mode: string;
      gameType: string;
    };
    build: ControlledExhibitionBuildProvenance;
  };
}

interface ControlledExhibitionCliConfig {
  sourceRunId: string;
  manifestDirectory: string;
  brainMode: DeterministicBrainMode;
  smokeArgs: string[];
  playbackTurnIntervalMs: number;
  executionConfig: AgentLeagueSmokeExecutionConfig;
  output: ControlledExhibitionPrivateOutput;
}

export interface ControlledExhibitionRunDependencies {
  runAgentLeagueSmoke?: (
    options: AgentLeagueSmokeRunOptions,
  ) => Promise<unknown>;
  resolveBuildProvenance?: () => Promise<ControlledExhibitionBuildProvenance>;
  environment?: ControlledExhibitionEnvironment;
  statfs?: typeof fs.statfs;
}

export async function writeControlledExhibitionBundle(
  options: ControlledExhibitionWriteOptions,
): Promise<ControlledExhibitionWriteResult> {
  assertSourceRunId(options.sourceRunId);
  validateOutputCeilings(options.output, options.environment ?? process.env);
  await assertConfiguredRootSeparation(options.output);
  const validateLayout =
    options.validatePrivateLayout ?? validatePremierePrivateLayout;
  const layout = await validateLayout({
    privateStateRoot: options.output.privateOutputRoot,
    servedRoots: options.output.servedRoots,
  });
  await assertDirectoryMode(layout.privateStateRoot);

  if (options.artifact.artifactInput.runID !== options.sourceRunId) {
    throw new Error(
      "controlled source run id does not match smoke artifact run id",
    );
  }
  const sourceGameRecord = options.artifact.artifactInput.gameRecord;
  if (sourceGameRecord === null || sourceGameRecord === undefined) {
    throw new Error("controlled source did not produce a GameRecord");
  }
  if (options.artifact.winner === undefined) {
    throw new Error(
      "controlled source did not finish with an authoritative winner",
    );
  }
  const executionConfig = validateControlledExecutionConfig(
    options.artifact.executionConfig,
    options.expectedExecutionConfig,
    options.artifact.artifactInput,
  );
  const executionConfigSha256 = hashReplayPremiereJson(
    replayJsonValue(executionConfig, "controlled execution config"),
  );

  const gameRecord = strictJsonGameRecord(
    sourceGameRecord,
    options.artifact.winner,
    options.build.repositoryHead,
  );
  const parsedRecord = GameRecordSchema.strict().parse(gameRecord);
  if (
    parsedRecord.info.num_turns !== options.artifact.turnCount ||
    parsedRecord.info.num_turns < 4 ||
    parsedRecord.turns.length > parsedRecord.info.num_turns
  ) {
    throw new Error("controlled source turn count is inconsistent");
  }
  validateReplayImportFields(gameRecord, parsedRecord.info.num_turns);
  validateGameRecordExecutionConfig(parsedRecord, executionConfig);

  const seats = bindPolicyIdentities(
    parsedRecord,
    options.artifact.artifactInput.roster,
    options.policies,
  );
  const authoritativeResultSourceId = `${options.sourceRunId}:result`;
  const resultValue = authoritativeResultValue({
    sourceRunId: options.sourceRunId,
    sourceId: authoritativeResultSourceId,
    gameRecord: parsedRecord,
    winner: options.artifact.winner,
    seats,
  });
  const resultBytes = Buffer.from(
    canonicalReplayPremiereJson(resultValue),
    "utf8",
  );
  const authoritativeResultHash = sha256Hex(resultBytes);
  const bundle: ControlledExhibitionSourceBundle = {
    schemaVersion: 1,
    bundleKind: "proxywar_controlled_exhibition_source",
    sourceRunId: options.sourceRunId,
    createdAt: new Date(parsedRecord.info.end).toISOString(),
    gameRecord,
    replay: {
      turnCount: parsedRecord.info.num_turns,
      turnIntervalMs: options.artifact.playbackTurnIntervalMs,
    },
    authoritativeResult: {
      sourceId: authoritativeResultSourceId,
      encoding: "base64",
      bytes: resultBytes.toString("base64"),
      sha256: authoritativeResultHash,
    },
    seats,
    provenance: {
      generator: "replay-premiere-controlled-exhibition/v1",
      brainMode: options.artifact.artifactInput.brainMode,
      runnerMode: options.artifact.artifactInput.runnerMode ?? "realtime",
      executionConfig,
      executionConfigSha256,
      game: {
        gameId: parsedRecord.info.gameID,
        startedAt: new Date(parsedRecord.info.start).toISOString(),
        completedAt: new Date(parsedRecord.info.end).toISOString(),
        turnCount: parsedRecord.info.num_turns,
        map: String(parsedRecord.info.config.gameMap),
        mapSize: String(parsedRecord.info.config.gameMapSize),
        mode: String(parsedRecord.info.config.gameMode),
        gameType: String(parsedRecord.info.config.gameType),
      },
      build: options.build,
    },
  };
  assertNoPrivatePolicyMaterial(bundle);
  const bundleValue: unknown = bundle;
  assertReplayPremiereJsonValue(bundleValue, "controlled exhibition bundle");
  const bytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  if (bytes.byteLength > options.output.maxBundleBytes) {
    throw new Error("controlled source bundle exceeds configured byte ceiling");
  }
  await assertFreeSpace(
    layout.privateStateRoot,
    bytes.byteLength,
    options.output.minFreeBytes,
    options.statfs ?? fs.statfs,
  );

  const bundlePath = path.join(
    layout.privateStateRoot,
    `${options.sourceRunId}.source.json`,
  );
  await writePrivateFileOnce(bundlePath, bytes);
  const found = await fs.readFile(bundlePath);
  if (!found.equals(bytes)) {
    throw new Error("controlled source bundle failed post-write verification");
  }
  const bundleSha256 = sha256Hex(found);
  return {
    schemaVersion: 1,
    sourceRunId: options.sourceRunId,
    bundlePath,
    bundleSha256,
    byteLength: found.byteLength,
    authoritativeResultHash,
    seats,
  };
}

export async function prepareControlledExhibitionOutput(
  output: ControlledExhibitionPrivateOutput,
  dependencies: {
    validatePrivateLayout?: ControlledExhibitionWriteOptions["validatePrivateLayout"];
    statfs?: typeof fs.statfs;
    environment?: ControlledExhibitionEnvironment;
  } = {},
): Promise<ValidatedPremierePrivateLayout> {
  validateOutputCeilings(output, dependencies.environment ?? process.env);
  await assertConfiguredRootSeparation(output);
  const layout = await (
    dependencies.validatePrivateLayout ?? validatePremierePrivateLayout
  )({
    privateStateRoot: output.privateOutputRoot,
    servedRoots: output.servedRoots,
  });
  await assertDirectoryMode(layout.privateStateRoot);
  await assertFreeSpace(
    layout.privateStateRoot,
    output.maxBundleBytes,
    output.minFreeBytes,
    dependencies.statfs ?? fs.statfs,
  );
  return layout;
}

export async function loadControlledPolicySet(
  manifestDirectory: string,
  expectedBrainMode: DeterministicBrainMode,
  executionConfig: AgentLeagueSmokeExecutionConfig,
): Promise<ControlledPolicySet> {
  const boundExecutionConfig =
    validateControlledExecutionConfigShape(executionConfig);
  const executionConfigSha256 = hashReplayPremiereJson(
    replayJsonValue(boundExecutionConfig, "controlled execution config"),
  );
  if (!path.isAbsolute(manifestDirectory)) {
    throw new Error("controlled policy manifest directory must be absolute");
  }
  const directoryStat = await fs.lstat(manifestDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(
      "controlled policy manifest directory is not a regular directory",
    );
  }
  const files = (await fs.readdir(manifestDirectory))
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  if (files.length < 2 || files.length > 8) {
    throw new Error(
      "controlled exhibitions require 2 to 8 exact policy manifests",
    );
  }
  const policies: ControlledPolicyProvenance[] = [];
  const injectedManifests: AgentLeagueSmokeInjectedManifest[] = [];
  for (const fileName of files) {
    const filePath = path.join(manifestDirectory, fileName);
    const bytes = await readBoundedRegularFile(
      filePath,
      MAX_POLICY_MANIFEST_BYTES,
    );
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`${fileName} is not valid JSON`, { cause: error });
    }
    const manifest = deepFreeze(
      JSON.parse(
        JSON.stringify(validateAgentManifest(raw, fileName)),
      ) as AgentManifest,
    );
    assertDeterministicManifest(manifest, expectedBrainMode, fileName);
    const identity = parseLocalPolicyIdentity(raw, fileName, manifest);
    const normalizedManifest: unknown = manifest;
    assertReplayPremiereJsonValue(
      normalizedManifest,
      `${fileName} normalized policy content`,
    );
    const manifestSha256 = sha256Hex(bytes);
    const contentSha256 = hashReplayPremiereJson(
      replayJsonValue(
        {
          schemaVersion: 1,
          manifest: normalizedManifest,
          executionConfig: boundExecutionConfig,
        },
        `${fileName} policy execution identity`,
      ),
    );
    policies.push({
      displayName: manifest.agentName,
      policyIdentity: {
        ...identity,
        manifestSha256,
        contentSha256,
      },
    });
    injectedManifests.push(
      deepFreeze({
        sourceName: fileName,
        rawManifestBase64: bytes.toString("base64"),
        manifestSha256,
        contentSha256,
        manifest,
      }),
    );
  }
  return deepFreeze({
    policies,
    injectedManifests,
    executionConfigSha256,
  });
}

export async function loadControlledPolicyProvenance(
  manifestDirectory: string,
  expectedBrainMode: DeterministicBrainMode,
  executionConfig: AgentLeagueSmokeExecutionConfig,
): Promise<ControlledPolicyProvenance[]> {
  const set = await loadControlledPolicySet(
    manifestDirectory,
    expectedBrainMode,
    executionConfig,
  );
  return [...set.policies];
}

export async function resolveControlledExhibitionBuildProvenance(
  repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  ),
): Promise<ControlledExhibitionBuildProvenance> {
  const [head, tree, status, diff] = await Promise.all([
    git(repositoryRoot, ["rev-parse", "HEAD"]),
    git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]),
    git(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
    git(repositoryRoot, ["diff", "--binary", "HEAD", "--"]),
  ]);
  if (
    !/^[a-f0-9]{40}$/.test(head.trim()) ||
    !/^[a-f0-9]{40}$/.test(tree.trim())
  ) {
    throw new Error(
      "controlled exhibition requires exact git build provenance",
    );
  }
  if (status.length !== 0 || diff.length !== 0) {
    throw new Error(
      "controlled exhibition requires a clean committed source checkout",
    );
  }
  const packageBytes = await fs.readFile(
    path.join(repositoryRoot, "package.json"),
  );
  const packageRecord = JSON.parse(packageBytes.toString("utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    typeof packageRecord.name !== "string" ||
    packageRecord.name.trim() === ""
  ) {
    throw new Error("package.json has no package name");
  }
  const scriptsDirectory = path.join(repositoryRoot, "src/scripts");
  const [smokeRunner, generator] = await Promise.all([
    fs.readFile(path.join(scriptsDirectory, "ai-agent-league-smoke.ts")),
    fs.readFile(
      path.join(scriptsDirectory, "replay-premiere-controlled-exhibition.ts"),
    ),
  ]);
  return {
    repositoryHead: head.trim(),
    repositoryTree: tree.trim(),
    trackedWorktreeClean: true,
    trackedWorktreeStateSha256: sha256Hex(
      Buffer.concat([
        Buffer.from("proxywar-tracked-worktree-v1\0", "utf8"),
        Buffer.from(status, "utf8"),
        Buffer.from("\0", "utf8"),
        Buffer.from(diff, "utf8"),
      ]),
    ),
    packageName: packageRecord.name,
    packageVersion:
      typeof packageRecord.version === "string" ? packageRecord.version : null,
    packageJsonSha256: sha256Hex(packageBytes),
    smokeRunnerSha256: sha256Hex(smokeRunner),
    generatorSha256: sha256Hex(generator),
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
  };
}

export async function runControlledExhibition(
  args = process.argv.slice(2),
  dependencies: ControlledExhibitionRunDependencies = {},
): Promise<ControlledExhibitionWriteResult> {
  const environment = dependencies.environment ?? process.env;
  const config = parseControlledExhibitionCli(args, environment);
  assertControlledBehaviorEnvironment(environment);
  const layout = await prepareControlledExhibitionOutput(config.output, {
    environment,
    statfs: dependencies.statfs,
  });
  const destination = path.join(
    layout.privateStateRoot,
    `${config.sourceRunId}.source.json`,
  );
  await assertDestinationAbsent(destination);
  const resolveBuildProvenance =
    dependencies.resolveBuildProvenance ??
    resolveControlledExhibitionBuildProvenance;
  const [policySet, build] = await Promise.all([
    loadControlledPolicySet(
      config.manifestDirectory,
      config.brainMode,
      config.executionConfig,
    ),
    resolveBuildProvenance(),
  ]);
  const buildBinding = canonicalReplayPremiereJson(
    replayJsonValue(build, "initial controlled build provenance"),
  );
  const boundBuild = deepFreeze(
    JSON.parse(buildBinding) as ControlledExhibitionBuildProvenance,
  );
  let result: ControlledExhibitionWriteResult | null = null;
  let writerCalls = 0;
  const runAgentLeagueSmoke =
    dependencies.runAgentLeagueSmoke ??
    (await import("./ai-agent-league-smoke")).runAgentLeagueSmoke;
  await runAgentLeagueSmoke({
    args: config.smokeArgs,
    injectedManifests: policySet.injectedManifests,
    manifestLimits: { minAgents: 2, maxAgents: 8 },
    planEveryDecisionSteps: config.executionConfig.planEveryDecisionSteps,
    allowEnvironmentStrategySpec: false,
    deterministicSource: {
      seed: config.sourceRunId,
      createdAtMs: deterministicCreatedAtMs(config.sourceRunId),
      playbackTurnIntervalMs: config.playbackTurnIntervalMs,
    },
    artifactWriter: async (artifact) => {
      writerCalls += 1;
      if (writerCalls !== 1) {
        throw new Error(
          "controlled exhibition attempted multiple bundle writes",
        );
      }
      const commitBuild = await resolveBuildProvenance();
      const commitBinding = canonicalReplayPremiereJson(
        replayJsonValue(commitBuild, "commit controlled build provenance"),
      );
      if (commitBinding !== buildBinding) {
        throw new Error(
          "controlled exhibition build provenance changed before bundle commit",
        );
      }
      result = await writeControlledExhibitionBundle({
        sourceRunId: config.sourceRunId,
        artifact,
        policies: policySet.policies,
        expectedExecutionConfig: config.executionConfig,
        build: boundBuild,
        output: {
          ...config.output,
          privateOutputRoot: layout.privateStateRoot,
        },
        environment,
        statfs: dependencies.statfs,
      });
      return result;
    },
  });
  if (result === null || writerCalls !== 1) {
    throw new Error(
      "controlled exhibition completed without one private source bundle",
    );
  }
  return result;
}

function parseControlledExhibitionCli(
  args: string[],
  environment: ControlledExhibitionEnvironment,
): ControlledExhibitionCliConfig {
  const allowedExactArguments = new Set([
    "--vary-spawns",
    "--disable-alliance-actions",
    "--disable-social",
  ]);
  const allowedPrefixes = [
    "--run-id=",
    "--private-output-root=",
    "--agent-manifest-dir=",
    "--served-root=",
    "--brain=",
    "--runner=",
    "--scenario=",
    "--bots=",
    "--nations=",
    "--max-steps=",
    "--turns-per-decision-step=",
    "--max-spawn-advance-turns=",
    "--max-decision-ms=",
    "--replay-tail-turns=",
    "--map=",
    "--map-size=",
    "--difficulty=",
    "--disable-action-kinds=",
    "--plan-every-decision-steps=",
    "--playback-turn-interval-ms=",
    "--max-bundle-bytes=",
    "--min-free-bytes=",
  ];
  const unknownArgument = args.find(
    (arg) =>
      !allowedExactArguments.has(arg) &&
      !allowedPrefixes.some((prefix) => arg.startsWith(prefix)),
  );
  if (unknownArgument !== undefined) {
    throw new Error(
      `controlled exhibition argument is not allowlisted: ${unknownArgument}`,
    );
  }
  for (const prefix of allowedPrefixes) {
    if (prefix !== "--served-root=") assertAtMostOneArg(args, prefix);
  }
  for (const exact of allowedExactArguments) {
    if (args.filter((arg) => arg === exact).length > 1) {
      throw new Error(`${exact} may be provided once`);
    }
  }
  const sourceRunId = requiredSingleArg(args, "--run-id=");
  assertSourceRunId(sourceRunId);
  const privateOutputRoot = requiredSingleArg(args, "--private-output-root=");
  const manifestDirectory = requiredSingleArg(args, "--agent-manifest-dir=");
  const servedRoots = repeatedArg(args, "--served-root=");
  if (
    !path.isAbsolute(privateOutputRoot) ||
    !path.isAbsolute(manifestDirectory) ||
    servedRoots.length === 0 ||
    servedRoots.some((root) => !path.isAbsolute(root))
  ) {
    throw new Error(
      "controlled exhibition roots and manifest directory must be explicit absolute paths",
    );
  }
  const brainArg =
    args.find((arg) => arg.startsWith("--brain=")) ?? "--brain=planner";
  const brainMode = brainArg.slice("--brain=".length);
  if (
    brainMode !== "rule" &&
    brainMode !== "mock-llm" &&
    brainMode !== "planner"
  ) {
    throw new Error(
      "controlled exhibitions require a deterministic local brain mode",
    );
  }
  if (
    args.some(
      (arg) => arg.startsWith("--runner=") && arg !== "--runner=step-locked",
    ) ||
    args.some(
      (arg) => arg.startsWith("--scenario=") && arg !== "--scenario=league",
    ) ||
    args.some((arg) => arg.startsWith("--bots=") && arg !== "--bots=0") ||
    args.some(
      (arg) => arg.startsWith("--nations=") && arg !== "--nations=disabled",
    )
  ) {
    throw new Error(
      "controlled exhibitions require the bounded agent-only league path",
    );
  }
  const playbackTurnIntervalMs = optionalPositiveIntegerArg(
    args,
    "--playback-turn-interval-ms=",
    100,
    60_000,
  );
  const maxBundleBytes = optionalPositiveIntegerArg(
    args,
    "--max-bundle-bytes=",
    DEFAULT_MAX_BUNDLE_BYTES,
    2 * GIB,
  );
  const minimumFreeBytes = controlledExhibitionMinimumFreeBytes(environment);
  const minFreeBytes = Math.max(
    minimumFreeBytes,
    optionalNonNegativeIntegerArg(
      args,
      "--min-free-bytes=",
      minimumFreeBytes,
    ),
  );
  const maxSteps = optionalPositiveIntegerArg(args, "--max-steps=", 120, 500);
  const turnsPerDecisionStep = optionalPositiveIntegerArg(
    args,
    "--turns-per-decision-step=",
    300,
    2_000,
  );
  const maxSpawnAdvanceTurns = optionalPositiveIntegerArg(
    args,
    "--max-spawn-advance-turns=",
    2_000,
    10_000,
  );
  const maxDecisionMs = optionalPositiveIntegerArg(
    args,
    "--max-decision-ms=",
    120_000,
    180_000,
  );
  const replayTailTurns = optionalNonNegativeIntegerArg(
    args,
    "--replay-tail-turns=",
    0,
    10_000,
  );
  const planEveryDecisionSteps = optionalPositiveIntegerArg(
    args,
    "--plan-every-decision-steps=",
    3,
    10,
  );
  const map = controlledEnumArg(args, "--map=", GameMapType, GameMapType.Asia);
  const mapSize = controlledEnumArg(
    args,
    "--map-size=",
    GameMapSize,
    GameMapSize.Compact,
  );
  const difficulty = controlledEnumArg(
    args,
    "--difficulty=",
    Difficulty,
    Difficulty.Medium,
  );
  const varySpawns = args.includes("--vary-spawns");
  const disabledActionKinds = controlledDisabledActionKinds(args);
  const executionConfig = deepFreeze({
    schemaVersion: 1 as const,
    scenario: "league" as const,
    brainMode,
    runnerMode: "step-locked" as const,
    planEveryDecisionSteps,
    runner: {
      turnsPerDecisionStep,
      turnsPerDecisionSchedule: null,
      maxDecisionMs,
      maxSteps,
      maxSpawnAdvanceTurns,
      requireWinner: true,
      waitForMirrorCatchup: true,
      autopilotEndgameSteps: 0,
      replayTailTurns,
    },
    game: {
      bots: 0,
      nations: "disabled",
      map: String(map),
      mapSize: String(mapSize),
      difficulty: String(difficulty),
      varySpawns,
    },
    disabledActionKinds,
  }) satisfies AgentLeagueSmokeExecutionConfig;
  const smokeArgs = [
    `--run-id=${sourceRunId}`,
    `--brain=${brainMode}`,
    "--runner=step-locked",
    "--scenario=league",
    "--bots=0",
    "--nations=disabled",
    `--max-steps=${maxSteps}`,
    `--turns-per-decision-step=${turnsPerDecisionStep}`,
    `--max-spawn-advance-turns=${maxSpawnAdvanceTurns}`,
    `--max-decision-ms=${maxDecisionMs}`,
    `--replay-tail-turns=${replayTailTurns}`,
    `--map=${String(map)}`,
    `--map-size=${String(mapSize)}`,
    `--difficulty=${String(difficulty)}`,
    ...(varySpawns ? ["--vary-spawns"] : []),
    ...(disabledActionKinds.length > 0
      ? [`--disable-action-kinds=${disabledActionKinds.join(",")}`]
      : []),
    "--require-winner",
  ];
  return {
    sourceRunId,
    manifestDirectory,
    brainMode,
    smokeArgs,
    playbackTurnIntervalMs,
    executionConfig,
    output: {
      privateOutputRoot,
      servedRoots,
      maxBundleBytes,
      minFreeBytes,
    },
  };
}

export function assertControlledBehaviorEnvironment(
  environment: Partial<
    Record<
      "PROXYWAR_PLAN_EVERY_DECISION_STEPS" | "AI_LEAGUE_PLAYER_STRATEGY_SPEC",
      string | undefined
    >
  >,
): void {
  for (const key of [
    "PROXYWAR_PLAN_EVERY_DECISION_STEPS",
    "AI_LEAGUE_PLAYER_STRATEGY_SPEC",
  ] as const) {
    if ((environment[key] ?? "").trim() !== "") {
      throw new Error(
        `controlled exhibitions reject unrecorded behavior environment ${key}`,
      );
    }
  }
}

function controlledEnumArg<T extends Record<string, string | number>>(
  args: string[],
  prefix: string,
  values: T,
  defaultValue: T[keyof T],
): T[keyof T] {
  const raw = repeatedArg(args, prefix)[0];
  if (raw === undefined) return defaultValue;
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

function controlledDisabledActionKinds(args: string[]): LegalActionKind[] {
  const disabled = new Set<LegalActionKind>();
  if (args.includes("--disable-alliance-actions")) {
    disabled.add("alliance_request");
  }
  if (args.includes("--disable-social")) {
    disabled.add("emoji");
    disabled.add("quick_chat");
  }
  const raw = repeatedArg(args, "--disable-action-kinds=")[0];
  if (raw !== undefined) {
    const values = raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length === 0) {
      throw new Error("--disable-action-kinds= requires legal action kinds");
    }
    for (const value of values) {
      if (!(legalActionKinds as readonly string[]).includes(value)) {
        throw new Error(
          `controlled exhibition action kind is invalid: ${value}`,
        );
      }
      disabled.add(value as LegalActionKind);
    }
  }
  return [...disabled].sort() as LegalActionKind[];
}

function validateControlledExecutionConfig(
  actual: AgentLeagueSmokeExecutionConfig,
  expected: AgentLeagueSmokeExecutionConfig,
  artifactInput: WriteAgentLeagueRunArtifactsInput,
): AgentLeagueSmokeExecutionConfig {
  const parsedActual = validateControlledExecutionConfigShape(actual);
  const parsedExpected = validateControlledExecutionConfigShape(expected);
  if (
    canonicalReplayPremiereJson(
      replayJsonValue(parsedActual, "actual controlled execution config"),
    ) !==
    canonicalReplayPremiereJson(
      replayJsonValue(parsedExpected, "expected controlled execution config"),
    )
  ) {
    throw new Error(
      "controlled source execution config does not match its bound policy identity",
    );
  }
  const runner = artifactInput.runnerConfig;
  const expectedArtifactBrainMode =
    parsedActual.brainMode === "planner"
      ? "planner-executor"
      : parsedActual.brainMode;
  if (
    artifactInput.scenario !== parsedActual.scenario ||
    artifactInput.runnerMode !== parsedActual.runnerMode ||
    artifactInput.brainMode !== expectedArtifactBrainMode ||
    runner === undefined ||
    runner.turnsPerDecisionStep !== parsedActual.runner.turnsPerDecisionStep ||
    canonicalReplayPremiereJson(
      (runner.turnsPerDecisionSchedule ?? null) as ReplayPremiereJsonValue,
    ) !==
      canonicalReplayPremiereJson(
        parsedActual.runner.turnsPerDecisionSchedule as ReplayPremiereJsonValue,
      ) ||
    runner.maxDecisionMs !== parsedActual.runner.maxDecisionMs ||
    runner.maxSteps !== parsedActual.runner.maxSteps ||
    runner.autopilotEndgameSteps !==
      parsedActual.runner.autopilotEndgameSteps ||
    runner.replayTailTurns !== parsedActual.runner.replayTailTurns ||
    runner.agents !== artifactInput.roster.length ||
    runner.bots !== parsedActual.game.bots ||
    runner.nations !== parsedActual.game.nations ||
    runner.map !== parsedActual.game.map ||
    runner.mapSize !== parsedActual.game.mapSize ||
    runner.difficulty !== parsedActual.game.difficulty ||
    runner.variedSpawns !== parsedActual.game.varySpawns
  ) {
    throw new Error(
      "controlled source artifact runner config is not the exact recorded execution config",
    );
  }
  return parsedActual;
}

function validateControlledExecutionConfigShape(
  value: unknown,
): AgentLeagueSmokeExecutionConfig {
  return validateReplayPremiereControlledExecutionConfig(value);
}

function replayJsonValue(
  value: unknown,
  label: string,
): ReplayPremiereJsonValue {
  assertReplayPremiereJsonValue(value, label);
  return value as ReplayPremiereJsonValue;
}

function strictJsonGameRecord(
  source: GameRecord,
  winner: Winner,
  repositoryHead: string,
): ReplayPremiereJsonValue {
  if (winner === undefined) {
    throw new Error("controlled source winner is missing");
  }
  const jsonSafe: unknown = JSON.parse(
    JSON.stringify(
      {
        ...source,
        gitCommit: repositoryHead,
        info: { ...source.info, winner },
      },
      replacer,
    ),
  );
  assertReplayPremiereJsonValue(jsonSafe, "controlled GameRecord");
  GameRecordSchema.strict().parse(jsonSafe);
  return jsonSafe;
}

function validateReplayImportFields(
  gameRecord: ReplayPremiereJsonValue,
  turnCount: number,
): void {
  if (
    gameRecord === null ||
    Array.isArray(gameRecord) ||
    typeof gameRecord !== "object"
  ) {
    throw new Error("controlled GameRecord is not an object");
  }
  const info = gameRecord.info;
  const turns = gameRecord.turns;
  if (info === null || Array.isArray(info) || typeof info !== "object") {
    throw new Error("controlled GameRecord has no strict start info");
  }
  const startInfo = {
    gameID: info.gameID,
    lobbyCreatedAt: info.lobbyCreatedAt,
    ...(info.visibleAt === undefined ? {} : { visibleAt: info.visibleAt }),
    config: info.config,
    players: Array.isArray(info.players)
      ? info.players.map((player) => {
          if (
            player === null ||
            Array.isArray(player) ||
            typeof player !== "object"
          ) {
            throw new Error("controlled GameRecord contains an invalid player");
          }
          return {
            clientID: player.clientID,
            username: player.username,
            clanTag: player.clanTag,
            ...(player.cosmetics === undefined
              ? {}
              : { cosmetics: player.cosmetics }),
            ...(player.isLobbyCreator === undefined
              ? {}
              : { isLobbyCreator: player.isLobbyCreator }),
          };
        })
      : info.players,
  };
  GameStartInfoSchema.strict().parse(startInfo);
  if (!Array.isArray(turns) || turns.length > turnCount) {
    throw new Error("controlled GameRecord sparse turns are invalid");
  }
  let previousTurn = -1;
  for (const turn of turns) {
    const parsed = TurnSchema.strict().parse(turn);
    if (
      parsed.turnNumber <= previousTurn ||
      parsed.turnNumber < 0 ||
      parsed.turnNumber >= turnCount
    ) {
      throw new Error("controlled GameRecord turns are not strictly ordered");
    }
    previousTurn = parsed.turnNumber;
  }
}

function validateGameRecordExecutionConfig(
  gameRecord: GameRecord,
  executionConfig: AgentLeagueSmokeExecutionConfig,
): void {
  const game = gameRecord.info.config;
  if (
    String(game.gameMap) !== executionConfig.game.map ||
    String(game.gameMapSize) !== executionConfig.game.mapSize ||
    String(game.difficulty) !== executionConfig.game.difficulty ||
    (game.bots ?? 0) !== executionConfig.game.bots ||
    (game.nations ?? "disabled") !== executionConfig.game.nations
  ) {
    throw new Error(
      "controlled GameRecord config does not match execution provenance",
    );
  }
}

function bindPolicyIdentities(
  gameRecord: GameRecord,
  roster: AgentRunRosterEntry[],
  policies: readonly ControlledPolicyProvenance[],
): PremiereSeatIdentity[] {
  if (
    policies.length !== roster.length ||
    gameRecord.info.players.length !== roster.length
  ) {
    throw new Error(
      "controlled source policy identities do not cover every seat",
    );
  }
  const playerByClientId = new Map(
    gameRecord.info.players.map((player) => [player.clientID, player]),
  );
  return roster.map((entry, index) => {
    const policy = policies[index];
    if (
      entry.clientID === null ||
      entry.username !== policy.displayName ||
      playerByClientId.get(entry.clientID)?.username !== entry.username
    ) {
      throw new Error(
        "controlled policy identity does not match its game seat",
      );
    }
    return {
      seatId: entry.clientID,
      displayName: entry.username,
      policyIdentity: policy.policyIdentity,
    };
  });
}

function authoritativeResultValue(input: {
  sourceRunId: string;
  sourceId: string;
  gameRecord: GameRecord;
  winner: Exclude<Winner, undefined>;
  seats: PremiereSeatIdentity[];
}): ReplayPremiereJsonValue {
  const winnerSeatIds = new Set(
    input.winner
      .slice(1)
      .filter((value) => input.seats.some((seat) => seat.seatId === value)),
  );
  const value: ReplayPremiereJsonValue = {
    schemaVersion: 1,
    sourceKind: "controlled_result",
    sourceRunId: input.sourceRunId,
    sourceId: input.sourceId,
    gameId: input.gameRecord.info.gameID,
    completedAt: new Date(input.gameRecord.info.end).toISOString(),
    turnCount: input.gameRecord.info.num_turns,
    winner: input.winner,
    seats: input.seats.map((seat) => ({
      seatId: seat.seatId,
      displayName: seat.displayName,
      won: winnerSeatIds.has(seat.seatId),
    })),
  };
  assertReplayPremiereJsonValue(value, "controlled authoritative result");
  return value;
}

function assertNoPrivatePolicyMaterial(value: unknown, depth = 0): void {
  if (depth > 80) {
    throw new Error("controlled source bundle exceeds inspection depth");
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoPrivatePolicyMaterial(entry, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLocaleLowerCase("en-US").replace(/[_-]/g, "");
    if (FORBIDDEN_BUNDLE_KEYS.has(normalized)) {
      throw new Error(
        `controlled source bundle contains forbidden field ${key}`,
      );
    }
    assertNoPrivatePolicyMaterial(entry, depth + 1);
  }
}

function parseLocalPolicyIdentity(
  raw: unknown,
  source: string,
  manifest: AgentManifest,
): Omit<
  Extract<PolicyIdentity, { namespace: "local_manifest" }>,
  "manifestSha256" | "contentSha256"
> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source} must be an object`);
  }
  const identity = (raw as Record<string, unknown>).policyIdentity;
  if (
    identity === null ||
    typeof identity !== "object" ||
    Array.isArray(identity)
  ) {
    throw new Error(`${source} must declare policyIdentity`);
  }
  const record = identity as Record<string, unknown>;
  if (
    record.namespace !== "local_manifest" ||
    typeof record.manifestName !== "string" ||
    !SAFE_MANIFEST_NAME_PATTERN.test(record.manifestName) ||
    typeof record.declaredVersion !== "string" ||
    !SAFE_VERSION_PATTERN.test(record.declaredVersion)
  ) {
    throw new Error(`${source} has an invalid local_manifest identity`);
  }
  if (
    typeof (raw as Record<string, unknown>).agentName !== "string" ||
    manifest.agentName !== (raw as Record<string, unknown>).agentName
  ) {
    throw new Error(`${source} has an unstable display identity`);
  }
  return {
    namespace: "local_manifest",
    manifestName: record.manifestName,
    declaredVersion: record.declaredVersion,
  };
}

function assertDeterministicManifest(
  manifest: AgentManifest,
  brainMode: DeterministicBrainMode,
  source: string,
): void {
  const validBrain =
    (brainMode === "rule" && manifest.brainType === "rule") ||
    (brainMode === "mock-llm" && manifest.brainType === "mock-llm") ||
    (brainMode === "planner" &&
      (manifest.brainType === "planner" ||
        manifest.brainType === "planner-executor"));
  if (!validBrain) {
    throw new Error(`${source} brainType does not match controlled brain mode`);
  }
  const provider = manifest.provider?.provider;
  if (
    provider === "external-http" ||
    provider === "external-relay" ||
    provider === "codex-cli" ||
    provider === "openai"
  ) {
    throw new Error(`${source} uses a non-deterministic or networked provider`);
  }
  if (
    (brainMode === "rule" && provider !== undefined && provider !== "rule") ||
    ((brainMode === "mock-llm" || brainMode === "planner") &&
      provider !== undefined &&
      provider !== "mock-llm" &&
      provider !== "rule")
  ) {
    throw new Error(`${source} provider does not match controlled brain mode`);
  }
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const before = await fs.lstat(filePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > maxBytes
  ) {
    throw new Error("controlled policy manifest is not a bounded regular file");
  }
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const openedBefore = await handle.stat();
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    if (
      openedBefore.dev !== openedAfter.dev ||
      openedBefore.ino !== openedAfter.ino ||
      openedAfter.nlink !== 1 ||
      openedBefore.size !== openedAfter.size ||
      openedBefore.mtimeMs !== openedAfter.mtimeMs ||
      bytes.byteLength !== openedAfter.size ||
      bytes.byteLength > maxBytes
    ) {
      throw new Error("controlled policy manifest changed during read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writePrivateFileOnce(
  destinationPath: string,
  bytes: Buffer,
): Promise<void> {
  await assertDestinationAbsent(destinationPath);
  const parent = path.dirname(destinationPath);
  const temporaryPath = path.join(
    parent,
    `.${path.basename(destinationPath)}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(
    temporaryPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporaryPath, destinationPath);
    await fs.chmod(destinationPath, 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error("controlled source bundle already exists", {
        cause: error,
      });
    }
    throw error;
  } finally {
    await fs.unlink(temporaryPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
  const stat = await fs.lstat(destinationPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size !== bytes.byteLength
  ) {
    throw new Error("controlled source bundle has unsafe file metadata");
  }
  const directory = await fs.open(parent, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function assertDestinationAbsent(destinationPath: string): Promise<void> {
  try {
    await fs.lstat(destinationPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("controlled source bundle destination already exists");
}

async function assertDirectoryMode(directoryPath: string): Promise<void> {
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      "controlled private output root is not a regular directory",
    );
  }
  if ((stat.mode & 0o777) !== 0o700) {
    await fs.chmod(directoryPath, 0o700);
  }
}

async function assertFreeSpace(
  directoryPath: string,
  pendingBytes: number,
  minFreeBytes: number,
  statfs: typeof fs.statfs,
): Promise<void> {
  const stat = await statfs(directoryPath, { bigint: true });
  const freeBytes = stat.bavail * stat.bsize;
  const required =
    BigInt(minFreeBytes) >
    BigInt(IMMUTABLE_MIRROR_RESERVE_BYTES) + BigInt(pendingBytes)
      ? BigInt(minFreeBytes)
      : BigInt(IMMUTABLE_MIRROR_RESERVE_BYTES) + BigInt(pendingBytes);
  if (freeBytes < required) {
    throw new Error(
      "controlled source output does not meet the free-space reserve",
    );
  }
}

function validateOutputCeilings(
  output: ControlledExhibitionPrivateOutput,
  environment: ControlledExhibitionEnvironment,
): void {
  const minimumFreeBytes = controlledExhibitionMinimumFreeBytes(environment);
  if (
    !path.isAbsolute(output.privateOutputRoot) ||
    output.servedRoots.length === 0 ||
    output.servedRoots.some((root) => !path.isAbsolute(root)) ||
    !Number.isSafeInteger(output.maxBundleBytes) ||
    output.maxBundleBytes <= 0 ||
    output.maxBundleBytes > 2 * GIB ||
    !Number.isSafeInteger(output.minFreeBytes) ||
    output.minFreeBytes < minimumFreeBytes
  ) {
    throw new Error("invalid controlled source private-output ceilings");
  }
}

export function controlledExhibitionMinimumFreeBytes(
  environment: ControlledExhibitionEnvironment,
): number {
  return environment.PROXYWAR_ALLOW_LOW_DISK_HEAVY_WRITE === "1"
    ? LOW_DISK_MIN_FREE_BYTES
    : DEFAULT_MIN_FREE_BYTES;
}

async function assertConfiguredRootSeparation(
  output: ControlledExhibitionPrivateOutput,
): Promise<void> {
  const privateRoot = await canonicalPathWithoutCreate(
    output.privateOutputRoot,
  );
  for (const servedRoot of output.servedRoots) {
    const canonicalServedRoot = await canonicalPathWithoutCreate(servedRoot);
    if (
      isContainedPath(canonicalServedRoot, privateRoot) ||
      isContainedPath(privateRoot, canonicalServedRoot)
    ) {
      throw new Error("private_and_served_roots_overlap");
    }
  }
}

async function canonicalPathWithoutCreate(value: string): Promise<string> {
  const resolved = path.resolve(value);
  let existing = resolved;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const realExisting = await fs.realpath(existing);
      return path.join(realExisting, ...missingSegments.reverse());
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    missingSegments.push(path.basename(existing));
    existing = parent;
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.resolve(value).normalize("NFC");
    return process.platform === "darwin"
      ? normalized.toLocaleLowerCase("en-US")
      : normalized;
  };
  const relative = path.relative(normalize(root), normalize(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function assertSourceRunId(sourceRunId: string): void {
  if (!SOURCE_RUN_ID_PATTERN.test(sourceRunId)) {
    throw new Error("controlled source run id is invalid");
  }
}

function deterministicCreatedAtMs(sourceRunId: string): number {
  const digest = createHash("sha256").update(sourceRunId).digest();
  const offset = digest.readUInt32BE(0) % (365 * 24 * 60 * 60 * 1_000);
  return Date.UTC(2025, 0, 1) + offset;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function assertAtMostOneArg(args: string[], prefix: string): void {
  if (repeatedArg(args, prefix).length > 1) {
    throw new Error(`${prefix} may be provided once`);
  }
}

function requiredSingleArg(args: string[], prefix: string): string {
  const values = repeatedArg(args, prefix);
  if (values.length !== 1 || values[0].trim() === "") {
    throw new Error(`${prefix} requires exactly one non-empty value`);
  }
  return values[0];
}

function repeatedArg(args: string[], prefix: string): string[] {
  return args
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length));
}

function optionalPositiveIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
  maxValue: number,
): number {
  const values = repeatedArg(args, prefix);
  if (values.length === 0) return defaultValue;
  if (values.length !== 1) throw new Error(`${prefix} may be provided once`);
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maxValue) {
    throw new Error(`${prefix} has an invalid byte or timing ceiling`);
  }
  return value;
}

function optionalNonNegativeIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
  maxValue = Number.MAX_SAFE_INTEGER,
): number {
  const values = repeatedArg(args, prefix);
  if (values.length === 0) return defaultValue;
  if (values.length !== 1) throw new Error(`${prefix} may be provided once`);
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value < 0 || value > maxValue) {
    throw new Error(`${prefix} has an invalid free-space floor`);
  }
  return value;
}

async function git(repositoryRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * MIB,
  });
  return result.stdout;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const result = await runControlledExhibition();
  console.log("Proxy War controlled exhibition source", result);
}
