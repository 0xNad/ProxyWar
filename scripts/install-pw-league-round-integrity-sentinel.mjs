import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { buildPwLeagueRoundIntegrityArtifact } from "./build-pw-league-round-integrity.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");
const adapterSourcePath = path.join(
  scriptDir,
  "pw-league-round-integrity-sentinel-adapter.mjs",
);
const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_MAX_BYTES = 64 * 1024;
const BACKUP_ROOT_BASENAME = "pw-league-sentinel-backups";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const FILE_KEYS = ["sentinel", "detector", "adapter"];
const RESTORE_ORDER = ["sentinel", "adapter", "detector"];

export const INSTALLED_DETECTOR_BASENAME = "pw-league-round-integrity.mjs";
export const INSTALLED_ADAPTER_BASENAME =
  "pw-league-round-integrity-sentinel.mjs";
export const SENTINEL_INTEGRATION_IMPORT_BEGIN =
  "// BEGIN PROXYWAR ROUND INTEGRITY IMPORT";
export const SENTINEL_INTEGRATION_IMPORT_END =
  "// END PROXYWAR ROUND INTEGRITY IMPORT";
export const SENTINEL_INTEGRATION_CALL_BEGIN =
  "    // BEGIN PROXYWAR ROUND INTEGRITY CHECK";
export const SENTINEL_INTEGRATION_CALL_END =
  "    // END PROXYWAR ROUND INTEGRITY CHECK";

const IMPORT_ANCHOR = 'import { promisify } from "node:util";';
const CALL_ANCHOR = "    evidence.rounds = rounds;";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  return sha256(await fs.readFile(filePath));
}

function assertAbsoluteFilePath(value, label) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw new Error(`${label} must be an absolute path`);
  }
}

function boundedError(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(record, allowed, label) {
  if (!isPlainRecord(record)) throw new Error(`${label} must be an object`);
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(`${label} has unknown key(s): ${extras.join(", ")}`);
  }
}

function assertSha256(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact SHA-256`);
  }
}

function assertGitSha(value, label) {
  if (typeof value !== "string" || !GIT_SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact Git SHA`);
  }
}

async function assertRegularFile(filePath, label) {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return stat;
}

async function assertRegularDirectory(directoryPath, label) {
  const stat = await fs.lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
}

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

export function transformPwLeagueSentinelSource(source) {
  const markers = [
    SENTINEL_INTEGRATION_IMPORT_BEGIN,
    SENTINEL_INTEGRATION_IMPORT_END,
    SENTINEL_INTEGRATION_CALL_BEGIN,
    SENTINEL_INTEGRATION_CALL_END,
  ];
  const present = markers.filter((marker) => source.includes(marker));
  if (present.length === markers.length) return source;
  if (present.length > 0) {
    throw new Error(
      `Sentinel contains a partial round-integrity integration: ${present.join(", ")}`,
    );
  }
  if (countOccurrences(source, IMPORT_ANCHOR) !== 1) {
    throw new Error("Expected exactly one sentinel import anchor");
  }
  if (countOccurrences(source, CALL_ANCHOR) !== 1) {
    throw new Error("Expected exactly one sentinel round collection anchor");
  }

  const importBlock = [
    IMPORT_ANCHOR,
    SENTINEL_INTEGRATION_IMPORT_BEGIN,
    `import { collectConfirmedCoworldRoundIntegrity } from "./${INSTALLED_ADAPTER_BASENAME}";`,
    SENTINEL_INTEGRATION_IMPORT_END,
  ].join("\n");
  const callBlock = [
    CALL_ANCHOR,
    SENTINEL_INTEGRATION_CALL_BEGIN,
    "    try {",
    "      const roundIntegrity =",
    "        await collectConfirmedCoworldRoundIntegrity({",
    "          coworld,",
    "          leagueId: LEAGUE_ID,",
    "          initialRoundsRaw: roundsRaw,",
    "        });",
    "      evidence.roundIntegrity = roundIntegrity.evidence;",
    "      if (roundIntegrity.signal !== null) {",
    "        signals.push(roundIntegrity.signal);",
    "      }",
    "    } catch (error) {",
    "      signals.push({",
    '        class: "probe_error",',
    '        key: "round-integrity",',
    '        severity: "warn",',
    "        detail: `round-integrity probe failed: ${String(error).slice(0, 300)}`,",
    "      });",
    "    }",
    SENTINEL_INTEGRATION_CALL_END,
  ].join("\n");
  return source
    .replace(IMPORT_ANCHOR, importBlock)
    .replace(CALL_ANCHOR, callBlock);
}

function integrationPaths(sentinelPath) {
  const directory = path.dirname(sentinelPath);
  return {
    sentinel: sentinelPath,
    detector: path.join(directory, INSTALLED_DETECTOR_BASENAME),
    adapter: path.join(directory, INSTALLED_ADAPTER_BASENAME),
  };
}

async function optionalFileState(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${filePath} must be a regular non-symlink file`);
    }
    return {
      exists: true,
      mode: stat.mode & 0o777,
      sha256: await fileSha256(filePath),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, mode: null, sha256: null };
    }
    throw error;
  }
}

export async function inspectPwLeagueSentinelRoundIntegrity({ sentinelPath }) {
  assertAbsoluteFilePath(sentinelPath, "sentinelPath");
  const paths = integrationPaths(sentinelPath);
  const [sentinelSource, detector, adapter] = await Promise.all([
    fs.readFile(sentinelPath, "utf8"),
    optionalFileState(paths.detector),
    optionalFileState(paths.adapter),
  ]);
  const importWired =
    sentinelSource.includes(SENTINEL_INTEGRATION_IMPORT_BEGIN) &&
    sentinelSource.includes(SENTINEL_INTEGRATION_IMPORT_END) &&
    sentinelSource.includes(`from "./${INSTALLED_ADAPTER_BASENAME}"`);
  const callWired =
    sentinelSource.includes(SENTINEL_INTEGRATION_CALL_BEGIN) &&
    sentinelSource.includes(SENTINEL_INTEGRATION_CALL_END) &&
    sentinelSource.includes("collectConfirmedCoworldRoundIntegrity({");
  const issues = [];
  if (!detector.exists) issues.push("detector_artifact_missing");
  if (!adapter.exists) issues.push("sentinel_adapter_missing");
  if (!importWired || !callWired) issues.push("sentinel_not_wired");
  return {
    active: issues.length === 0,
    issues,
    paths,
    hashes: {
      sentinel: sha256(sentinelSource),
      detector: detector.sha256,
      adapter: adapter.sha256,
    },
    detectorPresent: detector.exists,
    adapterPresent: adapter.exists,
    importWired,
    callWired,
  };
}

async function readRepositoryIdentity() {
  const [head, trackedStatus] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
      cwd: repositoryRoot,
    }),
  ]);
  return {
    head: head.stdout.trim(),
    trackedStatus: trackedStatus.stdout.trim(),
  };
}

async function checkSyntax(filePath) {
  await execFileAsync(process.execPath, ["--check", filePath]);
}

function roundFixture({ phantomCount = 14 } = {}) {
  return Array.from({ length: 25 }, (_, index) =>
    index < 25 - phantomCount
      ? {
          id: `ereq_${index}`,
          round_id: "round_self_test",
          status: "completed",
          episode_id: `episode_${index}`,
          running_at: "2026-08-22T00:00:00.000Z",
          error: null,
          policy_version_ids: [`policy_${index}`],
          scores: [{ policy_version_id: `policy_${index}`, score: 1 }],
        }
      : {
          id: `ereq_${index}`,
          round_id: "round_self_test",
          status: "completed",
          episode_id: null,
          running_at: null,
          error: null,
          policy_version_ids: [`policy_${index}`],
          scores: [],
        },
  );
}

async function runAdapterSelfTest(adapterPath) {
  const round = {
    id: "round_self_test",
    round_number: 1,
    status: "completed",
    completed_at: "2026-08-22T00:01:00.000Z",
  };
  const episodes = roundFixture();
  const league = {
    id: "league_self_test",
    settings: {
      round_interval_minutes: 25,
      ladder: {
        scheduler: { num_episodes: 25 },
        fulfillment: { allowed_failures: 0.05 },
      },
    },
  };
  const divisions = [
    {
      id: "division_self_test",
      name: "Competition",
      level: 2,
      member_count: 12,
    },
  ];
  const selfTestSource = [
    `import { collectConfirmedCoworldRoundIntegrity } from ${JSON.stringify(pathToFileURL(adapterPath).href)};`,
    `const round = ${JSON.stringify(round)};`,
    `const episodes = ${JSON.stringify(episodes)};`,
    `const league = ${JSON.stringify(league)};`,
    `const divisions = ${JSON.stringify(divisions)};`,
    "const calls = [];",
    "let clock = 0;",
    "const coworld = async (args) => {",
    "  calls.push([...args]);",
    "  if (args[0] === 'rounds') return [round];",
    "  if (args[0] === 'leagues') return league;",
    "  if (args[0] === 'results') return divisions;",
    "  if (args[0] === 'episodes') return episodes;",
    "  throw new Error(`unexpected self-test command: ${args.join(' ')}`);",
    "};",
    "const result = await collectConfirmedCoworldRoundIntegrity({",
    "  coworld,",
    "  leagueId: 'league_self_test',",
    "  initialRoundsRaw: [round],",
    "  sleep: async (milliseconds) => { clock += milliseconds; },",
    "  now: () => clock,",
    "});",
    "process.stdout.write(JSON.stringify({ result, calls }));",
  ].join("\n");
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    selfTestSource,
  ]);
  const { result, calls } = JSON.parse(stdout);
  if (
    result.status !== "confirmed_breach" ||
    result.signal?.class !== "round_incomplete_execution" ||
    result.signal?.key !== "round_self_test" ||
    result.evidence.observedForMs < 60_000
  ) {
    throw new Error("Round-integrity adapter self-test did not confirm breach");
  }
  return {
    status: result.status,
    signal: result.signal,
    observedForMs: result.evidence.observedForMs,
    coworldCalls: calls,
  };
}

async function stageInstallation({
  sentinelPath,
  stageDirectory,
  readIdentity = readRepositoryIdentity,
}) {
  const sentinelSource = await fs.readFile(sentinelPath, "utf8");
  const transformedSentinel = transformPwLeagueSentinelSource(sentinelSource);
  const sourceStat = await fs.stat(sentinelPath);
  const stagedPaths = {
    sentinel: path.join(stageDirectory, path.basename(sentinelPath)),
    detector: path.join(stageDirectory, INSTALLED_DETECTOR_BASENAME),
    adapter: path.join(stageDirectory, INSTALLED_ADAPTER_BASENAME),
  };
  await fs.mkdir(stageDirectory, { recursive: true, mode: 0o700 });
  const detectorBuild = await buildPwLeagueRoundIntegrityArtifact({
    outputPath: stagedPaths.detector,
  });
  const adapterSource = await fs.readFile(adapterSourcePath);
  await Promise.all([
    fs.writeFile(stagedPaths.adapter, adapterSource, { mode: 0o644 }),
    fs.writeFile(stagedPaths.sentinel, transformedSentinel, {
      mode: sourceStat.mode & 0o777,
    }),
  ]);
  await Promise.all(Object.values(stagedPaths).map(checkSyntax));
  const selfTest = await runAdapterSelfTest(stagedPaths.adapter);
  const repositoryIdentity = await readIdentity();
  const hashes = {
    repositoryHead: repositoryIdentity.head,
    repositoryTrackedStatus: repositoryIdentity.trackedStatus,
    detectorSource: detectorBuild.sourceSha256,
    detectorArtifact: detectorBuild.sha256,
    adapterSource: sha256(adapterSource),
    sentinelBefore: sha256(sentinelSource),
    sentinelInstalled: sha256(transformedSentinel),
  };
  return { stagedPaths, detectorBuild, hashes, selfTest };
}

async function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
}

async function atomicCopy(sourcePath, targetPath, mode) {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.copyFile(sourcePath, temporaryPath);
  await fs.chmod(temporaryPath, mode);
  await fs.rename(temporaryPath, targetPath);
}

async function buildReceipt({
  sentinelPath,
  stage,
  backupDirectory,
  status = "pending",
}) {
  const targets = integrationPaths(sentinelPath);
  const files = {};
  for (const key of FILE_KEYS) {
    const targetPath = targets[key];
    const previous = await optionalFileState(targetPath);
    const backupPath = previous.exists
      ? path.join(backupDirectory, `${path.basename(targetPath)}.previous`)
      : null;
    if (backupPath !== null) await fs.copyFile(targetPath, backupPath);
    files[key] = {
      targetPath,
      existed: previous.exists,
      mode: previous.mode ?? (key === "sentinel" ? 0o755 : 0o644),
      previousSha256: previous.sha256,
      installedSha256:
        key === "sentinel"
          ? stage.hashes.sentinelInstalled
          : key === "detector"
            ? stage.hashes.detectorArtifact
            : stage.hashes.adapterSource,
      backupPath,
    };
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    status,
    createdAt: new Date().toISOString(),
    repositoryHead: stage.hashes.repositoryHead,
    detectorSourceSha256: stage.hashes.detectorSource,
    sentinelPath,
    files,
  };
}

async function readValidatedReceipt({ receiptPath, allowedStatuses }) {
  assertAbsoluteFilePath(receiptPath, "receiptPath");
  if (path.basename(receiptPath) !== "receipt.json") {
    throw new Error("receiptPath must name receipt.json");
  }
  const receiptStat = await assertRegularFile(receiptPath, "receiptPath");
  if (receiptStat.size > RECEIPT_MAX_BYTES) {
    throw new Error(`receipt exceeds ${RECEIPT_MAX_BYTES} bytes`);
  }
  let receipt;
  try {
    receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  } catch (error) {
    throw new Error(`receipt is not valid JSON: ${boundedError(error)}`, {
      cause: error,
    });
  }
  assertExactKeys(
    receipt,
    [
      "schemaVersion",
      "status",
      "createdAt",
      "installedAt",
      "rollbackAt",
      "repositoryHead",
      "detectorSourceSha256",
      "sentinelPath",
      "files",
      "selfTest",
      "installError",
      "rollbackError",
    ],
    "receipt",
  );
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(`unsupported receipt schema ${receipt.schemaVersion}`);
  }
  if (!allowedStatuses.includes(receipt.status)) {
    throw new Error(
      `receipt status ${String(receipt.status)} is not allowed for this operation`,
    );
  }
  if (
    typeof receipt.createdAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.createdAt))
  ) {
    throw new Error("receipt.createdAt must be an ISO timestamp");
  }
  assertGitSha(receipt.repositoryHead, "receipt.repositoryHead");
  assertSha256(receipt.detectorSourceSha256, "receipt.detectorSourceSha256");
  assertAbsoluteFilePath(receipt.sentinelPath, "receipt.sentinelPath");
  if (path.basename(receipt.sentinelPath) !== "pw-league-sentinel.mjs") {
    throw new Error("receipt.sentinelPath must name pw-league-sentinel.mjs");
  }

  const sentinelDirectory = path.dirname(receipt.sentinelPath);
  const backupRoot = path.join(sentinelDirectory, BACKUP_ROOT_BASENAME);
  const receiptDirectory = path.dirname(receiptPath);
  if (path.dirname(receiptDirectory) !== backupRoot) {
    throw new Error(
      "receiptPath must be one direct child below the backup root",
    );
  }
  await Promise.all([
    assertRegularDirectory(sentinelDirectory, "sentinel directory"),
    assertRegularDirectory(backupRoot, "backup root"),
    assertRegularDirectory(receiptDirectory, "receipt directory"),
  ]);
  const [realSentinelDirectory, realBackupRoot, realReceiptDirectory] =
    await Promise.all([
      fs.realpath(sentinelDirectory),
      fs.realpath(backupRoot),
      fs.realpath(receiptDirectory),
    ]);
  if (
    path.dirname(realBackupRoot) !== realSentinelDirectory ||
    path.dirname(realReceiptDirectory) !== realBackupRoot
  ) {
    throw new Error("receipt backup directories escape the sentinel directory");
  }

  assertExactKeys(receipt.files, FILE_KEYS, "receipt.files");
  const expectedTargets = integrationPaths(receipt.sentinelPath);
  for (const key of FILE_KEYS) {
    const file = receipt.files[key];
    assertExactKeys(
      file,
      [
        "targetPath",
        "existed",
        "mode",
        "previousSha256",
        "installedSha256",
        "backupPath",
      ],
      `receipt.files.${key}`,
    );
    if (file.targetPath !== expectedTargets[key]) {
      throw new Error(
        `receipt.files.${key}.targetPath is not the exact target`,
      );
    }
    if (typeof file.existed !== "boolean") {
      throw new Error(`receipt.files.${key}.existed must be boolean`);
    }
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
      throw new Error(`receipt.files.${key}.mode is invalid`);
    }
    assertSha256(file.installedSha256, `receipt.files.${key}.installedSha256`);
    assertSha256(file.previousSha256, `receipt.files.${key}.previousSha256`, {
      nullable: !file.existed,
    });
    const expectedBackupPath = file.existed
      ? path.join(
          receiptDirectory,
          `${path.basename(file.targetPath)}.previous`,
        )
      : null;
    if (file.backupPath !== expectedBackupPath) {
      throw new Error(
        `receipt.files.${key}.backupPath is not the exact backup`,
      );
    }
    if (file.existed) {
      const backupStat = await assertRegularFile(
        file.backupPath,
        `receipt.files.${key}.backupPath`,
      );
      if (backupStat.size > 16 * 1024 * 1024) {
        throw new Error(
          `receipt.files.${key}.backupPath is unexpectedly large`,
        );
      }
      if ((await fileSha256(file.backupPath)) !== file.previousSha256) {
        throw new Error(
          `receipt.files.${key} backup hash does not match receipt`,
        );
      }
    } else if (file.previousSha256 !== null) {
      throw new Error(
        `receipt.files.${key}.previousSha256 must be null when absent`,
      );
    }
  }
  if (receipt.files.sentinel.existed !== true) {
    throw new Error("receipt must preserve a pre-existing sentinel");
  }
  if (receipt.status === "installed") {
    if (
      typeof receipt.installedAt !== "string" ||
      !Number.isFinite(Date.parse(receipt.installedAt))
    ) {
      throw new Error("installed receipt requires installedAt");
    }
    if (
      !isPlainRecord(receipt.selfTest) ||
      receipt.selfTest.status !== "confirmed_breach" ||
      !Number.isFinite(receipt.selfTest.observedForMs) ||
      receipt.selfTest.observedForMs < 60_000
    ) {
      throw new Error(
        "installed receipt requires a passing 60-second self-test",
      );
    }
  }
  return receipt;
}

async function restoreReceiptFiles(
  receipt,
  { keys = RESTORE_ORDER, beforeRestoreKey } = {},
) {
  const requested = new Set(keys);
  const restored = [];
  for (const key of RESTORE_ORDER) {
    if (!requested.has(key)) continue;
    const file = receipt.files[key];
    const current = await optionalFileState(file.targetPath);
    const alreadyRestored = file.existed
      ? current.exists && current.sha256 === file.previousSha256
      : !current.exists;
    if (alreadyRestored) {
      restored.push({ key, status: "already_restored" });
      continue;
    }
    if (!current.exists || current.sha256 !== file.installedSha256) {
      throw new Error(
        `Refusing rollback: ${key} is neither installed nor already restored`,
      );
    }
    await beforeRestoreKey?.({ key, file, restored: [...restored] });
    if (file.existed) {
      await atomicCopy(file.backupPath, file.targetPath, file.mode);
      const restoredState = await optionalFileState(file.targetPath);
      if (
        !restoredState.exists ||
        restoredState.sha256 !== file.previousSha256
      ) {
        throw new Error(`Rollback verification failed for restored ${key}`);
      }
    } else {
      await fs.rm(file.targetPath, { force: true });
      if ((await optionalFileState(file.targetPath)).exists) {
        throw new Error(`Rollback verification failed removing ${key}`);
      }
    }
    restored.push({ key, status: "restored" });
  }
  return restored;
}

async function withInstallLock(directory, operation) {
  const lockPath = path.join(
    directory,
    ".pw-league-round-integrity-install.lock",
  );
  const lock = await fs.open(lockPath, "wx", 0o600);
  try {
    return await operation();
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}

function assertRepositoryIdentity({ identity, expectedRepositorySha, label }) {
  if (identity.head !== expectedRepositorySha) {
    throw new Error(
      `${label} repository SHA drift: expected ${expectedRepositorySha}, found ${identity.head}`,
    );
  }
  if (identity.trackedStatus.length > 0) {
    throw new Error(`${label} repository has tracked modifications`);
  }
}

async function assertActivationIdentity({
  sentinelPath,
  expectedSentinelSha256,
  expectedRepositorySha,
  stagedHashes,
  readIdentity,
  label,
}) {
  const [sentinelSha, identity] = await Promise.all([
    fileSha256(sentinelPath),
    readIdentity(),
  ]);
  if (
    sentinelSha !== expectedSentinelSha256 ||
    sentinelSha !== stagedHashes.sentinelBefore
  ) {
    throw new Error(
      `${label} sentinel hash drift: expected ${expectedSentinelSha256}, found ${sentinelSha}`,
    );
  }
  assertRepositoryIdentity({ identity, expectedRepositorySha, label });
  if (identity.head !== stagedHashes.repositoryHead) {
    throw new Error(`${label} repository no longer matches staged source`);
  }
  return { sentinelSha, identity };
}

async function assertStagedHashes(stage, receipt) {
  for (const key of FILE_KEYS) {
    const actual = await fileSha256(stage.stagedPaths[key]);
    if (actual !== receipt.files[key].installedSha256) {
      throw new Error(`staged ${key} hash drifted before activation`);
    }
  }
}

export async function dryRunPwLeagueSentinelRoundIntegrity({ sentinelPath }) {
  assertAbsoluteFilePath(sentinelPath, "sentinelPath");
  const before = await inspectPwLeagueSentinelRoundIntegrity({ sentinelPath });
  const stageDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "proxywar-sentinel-round-integrity-"),
  );
  try {
    const stage = await stageInstallation({ sentinelPath, stageDirectory });
    return {
      ok: true,
      mode: "dry-run",
      targetMutated: false,
      before,
      stagedHashes: stage.hashes,
      selfTest: stage.selfTest,
    };
  } finally {
    await fs.rm(stageDirectory, { recursive: true, force: true });
  }
}

export async function verifyPwLeagueSentinelRoundIntegrity(
  { sentinelPath, receiptPath },
  { readIdentity = readRepositoryIdentity } = {},
) {
  assertAbsoluteFilePath(sentinelPath, "sentinelPath");
  const receipt = await readValidatedReceipt({
    receiptPath,
    allowedStatuses: ["installed"],
  });
  if (receipt.sentinelPath !== sentinelPath) {
    throw new Error("receipt sentinelPath does not match requested sentinel");
  }
  const identity = await readIdentity();
  assertRepositoryIdentity({
    identity,
    expectedRepositorySha: receipt.repositoryHead,
    label: "verify",
  });
  const inspection = await inspectPwLeagueSentinelRoundIntegrity({
    sentinelPath,
  });
  if (!inspection.active) {
    throw new Error(
      `Sentinel integration is inactive: ${inspection.issues.join(", ")}`,
    );
  }
  for (const key of FILE_KEYS) {
    if (inspection.hashes[key] !== receipt.files[key].installedSha256) {
      throw new Error(`verify ${key} hash does not match receipt`);
    }
  }

  const stageDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "proxywar-sentinel-verify-"),
  );
  try {
    const detectorBuild = await buildPwLeagueRoundIntegrityArtifact({
      outputPath: path.join(stageDirectory, INSTALLED_DETECTOR_BASENAME),
    });
    if (detectorBuild.sourceSha256 !== receipt.detectorSourceSha256) {
      throw new Error("verify detector source hash does not match receipt");
    }
    if (detectorBuild.sha256 !== receipt.files.detector.installedSha256) {
      throw new Error("verify rebuilt detector hash does not match receipt");
    }
    const adapterSourceSha = await fileSha256(adapterSourcePath);
    if (adapterSourceSha !== receipt.files.adapter.installedSha256) {
      throw new Error("verify adapter source hash does not match receipt");
    }
    const previousSentinel = await fs.readFile(
      receipt.files.sentinel.backupPath,
      "utf8",
    );
    const rebuiltSentinelSha = sha256(
      transformPwLeagueSentinelSource(previousSentinel),
    );
    if (rebuiltSentinelSha !== receipt.files.sentinel.installedSha256) {
      throw new Error("verify rebuilt sentinel hash does not match receipt");
    }
    await Promise.all(Object.values(inspection.paths).map(checkSyntax));
    const selfTest = await runAdapterSelfTest(inspection.paths.adapter);
    return {
      ok: true,
      mode: "verify",
      receiptPath,
      repositoryHead: identity.head,
      detectorSourceSha256: detectorBuild.sourceSha256,
      inspection,
      selfTest,
    };
  } finally {
    await fs.rm(stageDirectory, { recursive: true, force: true });
  }
}

export async function installPwLeagueSentinelRoundIntegrity(
  { sentinelPath, expectedSentinelSha256, expectedRepositorySha },
  {
    readIdentity = readRepositoryIdentity,
    beforeActivate,
    beforeSentinelActivate,
    beforeAutomaticRestoreKey,
  } = {},
) {
  assertAbsoluteFilePath(sentinelPath, "sentinelPath");
  assertSha256(expectedSentinelSha256, "expectedSentinelSha256");
  assertGitSha(expectedRepositorySha, "expectedRepositorySha");
  const directory = path.dirname(sentinelPath);
  return withInstallLock(directory, async () => {
    const [currentSentinelSha, initialIdentity] = await Promise.all([
      fileSha256(sentinelPath),
      readIdentity(),
    ]);
    if (currentSentinelSha !== expectedSentinelSha256) {
      throw new Error(
        `Sentinel hash drift: expected ${expectedSentinelSha256}, found ${currentSentinelSha}`,
      );
    }
    assertRepositoryIdentity({
      identity: initialIdentity,
      expectedRepositorySha,
      label: "initial",
    });

    const nonce = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const stageDirectory = path.join(
      directory,
      `.pw-league-round-integrity-stage-${nonce}`,
    );
    const backupDirectory = path.join(directory, BACKUP_ROOT_BASENAME, nonce);
    await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const pendingReceiptPath = path.join(
      backupDirectory,
      "receipt.pending.json",
    );
    const receiptPath = path.join(backupDirectory, "receipt.json");
    let receipt = null;
    let durableReceiptPath = pendingReceiptPath;
    const replacedKeys = [];
    try {
      const stage = await stageInstallation({
        sentinelPath,
        stageDirectory,
        readIdentity,
      });
      if (stage.hashes.sentinelBefore !== expectedSentinelSha256) {
        throw new Error("staged sentinel source does not match expected hash");
      }
      assertRepositoryIdentity({
        identity: {
          head: stage.hashes.repositoryHead,
          trackedStatus: stage.hashes.repositoryTrackedStatus,
        },
        expectedRepositorySha,
        label: "staged",
      });
      receipt = await buildReceipt({
        sentinelPath,
        stage,
        backupDirectory,
      });
      await atomicWriteJson(pendingReceiptPath, receipt);
      const targets = integrationPaths(sentinelPath);
      await beforeActivate?.({
        sentinelPath,
        targets,
        stage,
        pendingReceiptPath,
      });
      await assertStagedHashes(stage, receipt);
      await assertActivationIdentity({
        sentinelPath,
        expectedSentinelSha256,
        expectedRepositorySha,
        stagedHashes: stage.hashes,
        readIdentity,
        label: "pre-activation",
      });
      // The old sentinel cannot reference the new modules. Install dependencies
      // first and atomically replace the sentinel last as the activation barrier.
      for (const key of ["detector", "adapter"]) {
        await fs.rename(stage.stagedPaths[key], targets[key]);
        replacedKeys.push(key);
      }
      await beforeSentinelActivate?.({
        sentinelPath,
        targets,
        stage,
        pendingReceiptPath,
      });
      await assertActivationIdentity({
        sentinelPath,
        expectedSentinelSha256,
        expectedRepositorySha,
        stagedHashes: stage.hashes,
        readIdentity,
        label: "pre-sentinel-activation",
      });
      await fs.rename(stage.stagedPaths.sentinel, targets.sentinel);
      replacedKeys.push("sentinel");
      const inspection = await inspectPwLeagueSentinelRoundIntegrity({
        sentinelPath,
      });
      if (!inspection.active) {
        throw new Error(
          `Installed sentinel integration failed verification: ${inspection.issues.join(", ")}`,
        );
      }
      for (const key of FILE_KEYS) {
        if (inspection.hashes[key] !== receipt.files[key].installedSha256) {
          throw new Error(
            `Installed ${key} hash does not match staged receipt`,
          );
        }
      }
      receipt.status = "installed";
      receipt.installedAt = new Date().toISOString();
      receipt.selfTest = stage.selfTest;
      await atomicWriteJson(receiptPath, receipt);
      durableReceiptPath = receiptPath;
      await fs.rm(pendingReceiptPath, { force: true });
      const verification = await verifyPwLeagueSentinelRoundIntegrity(
        { sentinelPath, receiptPath },
        { readIdentity },
      );
      return {
        ok: true,
        mode: "install",
        restartPerformed: false,
        receiptPath,
        inspection,
        verification,
      };
    } catch (error) {
      if (receipt !== null) {
        receipt.installError = boundedError(error);
        receipt.rollbackAt = new Date().toISOString();
        let rollbackError = null;
        if (replacedKeys.length === 0) {
          receipt.status = "aborted_before_activation";
        } else {
          try {
            await restoreReceiptFiles(receipt, {
              keys: replacedKeys,
              beforeRestoreKey: beforeAutomaticRestoreKey,
            });
            receipt.status = "rolled_back_after_install_failure";
          } catch (restoreError) {
            rollbackError = restoreError;
            receipt.status = "rollback_failed";
            receipt.rollbackError = boundedError(restoreError);
          }
        }
        let receiptWriteError = null;
        try {
          await atomicWriteJson(durableReceiptPath, receipt);
        } catch (writeError) {
          receiptWriteError = writeError;
        }
        if (rollbackError !== null || receiptWriteError !== null) {
          throw new AggregateError(
            [error, rollbackError, receiptWriteError].filter(
              (candidate) => candidate !== null,
            ),
            `Sentinel install failed; automatic rollback or receipt recording also failed: install=${boundedError(error)} rollback=${rollbackError === null ? "none" : boundedError(rollbackError)} receipt=${receiptWriteError === null ? "none" : boundedError(receiptWriteError)}`,
            { cause: error },
          );
        }
      }
      throw error;
    } finally {
      await fs.rm(stageDirectory, { recursive: true, force: true });
    }
  });
}

export async function rollbackPwLeagueSentinelRoundIntegrity(
  { receiptPath },
  { beforeRestoreKey } = {},
) {
  const receipt = await readValidatedReceipt({
    receiptPath,
    allowedStatuses: ["installed", "rollback_failed"],
  });
  const directory = path.dirname(receipt.sentinelPath);
  return withInstallLock(directory, async () => {
    try {
      const restored = await restoreReceiptFiles(receipt, {
        beforeRestoreKey,
      });
      receipt.status = "rolled_back";
      receipt.rollbackAt = new Date().toISOString();
      delete receipt.rollbackError;
      await atomicWriteJson(receiptPath, receipt);
      return {
        ok: true,
        mode: "rollback",
        restartPerformed: false,
        receiptPath,
        restored,
        restoredHashes: {
          sentinel: await fileSha256(receipt.files.sentinel.targetPath),
          detector: receipt.files.detector.existed
            ? await fileSha256(receipt.files.detector.targetPath)
            : null,
          adapter: receipt.files.adapter.existed
            ? await fileSha256(receipt.files.adapter.targetPath)
            : null,
        },
      };
    } catch (restoreError) {
      receipt.status = "rollback_failed";
      receipt.rollbackAt = new Date().toISOString();
      receipt.rollbackError = boundedError(restoreError);
      let receiptWriteError = null;
      try {
        await atomicWriteJson(receiptPath, receipt);
      } catch (writeError) {
        receiptWriteError = writeError;
      }
      throw new AggregateError(
        [restoreError, receiptWriteError].filter(
          (candidate) => candidate !== null,
        ),
        `Sentinel rollback failed: restore=${boundedError(restoreError)} receipt=${receiptWriteError === null ? "recorded" : boundedError(receiptWriteError)}`,
        { cause: restoreError },
      );
    }
  });
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const equals = argument.indexOf("=");
    if (equals !== -1) {
      options[argument.slice(2, equals)] = argument.slice(equals + 1);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Expected a value after ${argument}`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function runCli(argv) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  if (command === "dry-run") {
    return dryRunPwLeagueSentinelRoundIntegrity({
      sentinelPath: options.sentinel,
    });
  }
  if (command === "inspect") {
    return inspectPwLeagueSentinelRoundIntegrity({
      sentinelPath: options.sentinel,
    });
  }
  if (command === "verify") {
    return verifyPwLeagueSentinelRoundIntegrity({
      sentinelPath: options.sentinel,
      receiptPath: options.receipt,
    });
  }
  if (command === "install") {
    return installPwLeagueSentinelRoundIntegrity({
      sentinelPath: options.sentinel,
      expectedSentinelSha256: options["expected-sentinel-sha256"],
      expectedRepositorySha: options["expected-repository-sha"],
    });
  }
  if (command === "rollback") {
    return rollbackPwLeagueSentinelRoundIntegrity({
      receiptPath: options.receipt,
    });
  }
  throw new Error(
    "Usage: node scripts/install-pw-league-round-integrity-sentinel.mjs <dry-run|inspect|verify|install|rollback> [--sentinel <absolute-path>] [--receipt <absolute-path>] [--expected-sentinel-sha256 <sha256> --expected-repository-sha <git-sha>]",
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
