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
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
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
    const stat = await fs.stat(filePath);
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

async function repositoryHead() {
  return (
    await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
    })
  ).stdout.trim();
}

async function repositoryTrackedStatus() {
  return (
    await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=no"],
      { cwd: repositoryRoot },
    )
  ).stdout.trim();
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

async function stageInstallation({ sentinelPath, stageDirectory }) {
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
  const hashes = {
    repositoryHead: await repositoryHead(),
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
  for (const key of ["sentinel", "detector", "adapter"]) {
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
    schemaVersion: 1,
    status,
    createdAt: new Date().toISOString(),
    repositoryHead: stage.hashes.repositoryHead,
    detectorSourceSha256: stage.hashes.detectorSource,
    sentinelPath,
    files,
  };
}

async function restoreReceiptFiles(receipt, { verifyInstalledHashes }) {
  for (const key of ["sentinel", "adapter", "detector"]) {
    const file = receipt.files[key];
    if (verifyInstalledHashes) {
      const current = await optionalFileState(file.targetPath);
      if (!current.exists || current.sha256 !== file.installedSha256) {
        throw new Error(
          `Refusing rollback: ${key} drifted from installed hash ${file.installedSha256}`,
        );
      }
    }
    if (file.existed) {
      await atomicCopy(file.backupPath, file.targetPath, file.mode);
    } else {
      await fs.rm(file.targetPath, { force: true });
    }
  }
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

export async function verifyPwLeagueSentinelRoundIntegrity({ sentinelPath }) {
  assertAbsoluteFilePath(sentinelPath, "sentinelPath");
  const inspection = await inspectPwLeagueSentinelRoundIntegrity({
    sentinelPath,
  });
  if (!inspection.active) {
    throw new Error(
      `Sentinel integration is inactive: ${inspection.issues.join(", ")}`,
    );
  }
  await Promise.all(Object.values(inspection.paths).map(checkSyntax));
  const selfTest = await runAdapterSelfTest(inspection.paths.adapter);
  return {
    ok: true,
    mode: "verify",
    inspection,
    selfTest,
  };
}

export async function installPwLeagueSentinelRoundIntegrity({
  sentinelPath,
  expectedSentinelSha256,
  expectedRepositorySha,
}) {
  assertAbsoluteFilePath(sentinelPath, "sentinelPath");
  if (!/^[a-f0-9]{64}$/.test(expectedSentinelSha256 ?? "")) {
    throw new Error("expectedSentinelSha256 must be an exact SHA-256");
  }
  if (!/^[a-f0-9]{40}$/.test(expectedRepositorySha ?? "")) {
    throw new Error("expectedRepositorySha must be an exact Git SHA");
  }
  const directory = path.dirname(sentinelPath);
  return withInstallLock(directory, async () => {
    const [currentSentinelSha, currentRepositoryHead, trackedStatus] =
      await Promise.all([
        fileSha256(sentinelPath),
        repositoryHead(),
        repositoryTrackedStatus(),
      ]);
    if (currentSentinelSha !== expectedSentinelSha256) {
      throw new Error(
        `Sentinel hash drift: expected ${expectedSentinelSha256}, found ${currentSentinelSha}`,
      );
    }
    if (currentRepositoryHead !== expectedRepositorySha) {
      throw new Error(
        `Repository SHA drift: expected ${expectedRepositorySha}, found ${currentRepositoryHead}`,
      );
    }
    if (trackedStatus.length > 0) {
      throw new Error(
        "Repository has tracked modifications; commit or restore them before install",
      );
    }

    const nonce = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const stageDirectory = path.join(
      directory,
      `.pw-league-round-integrity-stage-${nonce}`,
    );
    const backupDirectory = path.join(
      directory,
      "pw-league-sentinel-backups",
      nonce,
    );
    await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const pendingReceiptPath = path.join(
      backupDirectory,
      "receipt.pending.json",
    );
    const receiptPath = path.join(backupDirectory, "receipt.json");
    let receipt = null;
    try {
      const stage = await stageInstallation({ sentinelPath, stageDirectory });
      receipt = await buildReceipt({
        sentinelPath,
        stage,
        backupDirectory,
      });
      await atomicWriteJson(pendingReceiptPath, receipt);
      const targets = integrationPaths(sentinelPath);
      // The old sentinel cannot reference the new modules. Install dependencies
      // first and atomically replace the sentinel last as the activation barrier.
      for (const key of ["detector", "adapter", "sentinel"]) {
        await fs.rename(stage.stagedPaths[key], targets[key]);
      }
      const inspection = await inspectPwLeagueSentinelRoundIntegrity({
        sentinelPath,
      });
      if (!inspection.active) {
        throw new Error(
          `Installed sentinel integration failed verification: ${inspection.issues.join(", ")}`,
        );
      }
      for (const key of ["sentinel", "detector", "adapter"]) {
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
      await fs.rm(pendingReceiptPath, { force: true });
      return {
        ok: true,
        mode: "install",
        restartPerformed: false,
        receiptPath,
        inspection,
      };
    } catch (error) {
      if (receipt !== null) {
        await restoreReceiptFiles(receipt, {
          verifyInstalledHashes: false,
        }).catch(() => undefined);
        receipt.status = "rolled_back_after_install_failure";
        receipt.rollbackAt = new Date().toISOString();
        await atomicWriteJson(pendingReceiptPath, receipt).catch(
          () => undefined,
        );
      }
      throw error;
    } finally {
      await fs.rm(stageDirectory, { recursive: true, force: true });
    }
  });
}

export async function rollbackPwLeagueSentinelRoundIntegrity({ receiptPath }) {
  assertAbsoluteFilePath(receiptPath, "receiptPath");
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  const directory = path.dirname(receipt.sentinelPath);
  return withInstallLock(directory, async () => {
    await restoreReceiptFiles(receipt, { verifyInstalledHashes: true });
    receipt.status = "rolled_back";
    receipt.rollbackAt = new Date().toISOString();
    await atomicWriteJson(receiptPath, receipt);
    return {
      ok: true,
      mode: "rollback",
      restartPerformed: false,
      receiptPath,
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
    "Usage: node scripts/install-pw-league-round-integrity-sentinel.mjs <dry-run|inspect|verify|install|rollback> --sentinel <absolute-path> [--expected-sentinel-sha256 <sha256> --expected-repository-sha <git-sha> | --receipt <absolute-path>]",
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
