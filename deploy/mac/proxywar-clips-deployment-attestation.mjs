#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ATTESTATION_NAME = "clip-deployment-attestation-v1.json";
const RELEASE_STATE_NAME = "clip-release-v1.json";
const GIT_BIN = "/usr/bin/git";
const MAX_ATTESTATION_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_STATE_BYTES = 1_024;
const MAX_TRACKED_FILES = 20_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const RUNTIME_INVENTORY_EXCLUDED_PATHS = new Set([
  ".git",
  "artifacts",
  "coworld-adapter/tmp",
  "node_modules",
  "static",
]);
const ATTESTATION_KEYS = [
  "buildSha256",
  "commit",
  "createdAt",
  "helperPath",
  "helperSha256",
  "nonce",
  "projectDir",
  "schemaVersion",
  "trackedContentSha256",
  "trackedFiles",
  "tree",
  "wrapperPath",
  "wrapperSha256",
];
const TRACKED_FILE_KEYS = ["gitBlobOid", "mode", "path", "sha256", "size"];
const RELEASE_STATE_V1_KEYS = [
  "buildSha256",
  "commit",
  "enabled",
  "schemaVersion",
  "tree",
];
const RELEASE_STATE_V2_KEYS = [
  "attestationNonce",
  "buildSha256",
  "commit",
  "enabled",
  "schemaVersion",
  "tree",
];

class AttestationError extends Error {
  constructor(stage, code, cause) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "AttestationError";
    this.stage = stage;
  }
}

export async function createDeploymentAttestation({
  stateRoot,
  trustedRoot,
  projectDir,
  wrapperPath,
  helperPath,
  expectedCommit,
  expectedTree,
  expectedBuildSha256,
  expectedWrapperSha256,
  expectedHelperSha256,
  now = () => new Date(),
  nonce = randomBytes(32).toString("hex"),
}) {
  validateHex(expectedCommit, 40, "binding", "attestation_commit_invalid");
  validateHex(expectedTree, 40, "binding", "attestation_tree_invalid");
  validateHex(expectedBuildSha256, 64, "binding", "attestation_build_invalid");
  validateHex(
    expectedWrapperSha256,
    64,
    "binding",
    "attestation_wrapper_invalid",
  );
  validateHex(
    expectedHelperSha256,
    64,
    "binding",
    "attestation_helper_invalid",
  );
  validateHex(nonce, 64, "binding", "attestation_nonce_invalid");

  const roots = await validatePaths({
    stateRoot,
    trustedRoot,
    projectDir,
    wrapperPath,
    helperPath,
  });
  await validateCanonicalGit();
  const wrapper = await hashInstalledExecutable(roots.wrapperPath, "wrapper");
  const helper = await hashInstalledExecutable(roots.helperPath, "helper");
  if (wrapper.sha256 !== expectedWrapperSha256)
    fail("wrapper", "attestation_wrapper_mismatch");
  if (helper.sha256 !== expectedHelperSha256)
    fail("helper", "attestation_helper_mismatch");

  await assertGitIdentity({
    projectDir: roots.projectDir,
    expectedCommit,
    expectedTree,
  });
  const trackedFiles = await collectTrackedFiles({
    projectDir: roots.projectDir,
  });
  await verifyRuntimeInventory(roots.projectDir, trackedFiles);
  const trackedContentSha256 = hashTrackedManifest(trackedFiles);
  const buildSha256 = await hashStaticBuild(
    path.join(roots.projectDir, "static"),
  );
  if (buildSha256 !== expectedBuildSha256)
    fail("static_build", "attestation_build_mismatch");
  await assertGitIdentity({
    projectDir: roots.projectDir,
    expectedCommit,
    expectedTree,
  });

  const createdAt = now().toISOString();
  if (!isCanonicalIsoTimestamp(createdAt))
    fail("binding", "attestation_created_at_invalid");
  const attestation = {
    schemaVersion: 1,
    nonce,
    createdAt,
    projectDir: roots.projectDir,
    commit: expectedCommit,
    tree: expectedTree,
    buildSha256,
    wrapperPath: roots.wrapperPath,
    wrapperSha256: wrapper.sha256,
    helperPath: roots.helperPath,
    helperSha256: helper.sha256,
    trackedContentSha256,
    trackedFiles,
  };
  if (parseDeploymentAttestation(JSON.stringify(attestation)) === null)
    fail("attestation", "attestation_internal_schema_invalid");
  const attestationPath = path.join(roots.stateRoot, ATTESTATION_NAME);
  await writeAttestation(attestationPath, attestation);
  return { attestationPath, attestation };
}

export async function verifyDeploymentAttestation({
  stateRoot,
  trustedRoot,
  projectDir,
  wrapperPath,
  helperPath,
  expectedNonce,
  expectedCommit,
  expectedTree,
  expectedBuildSha256,
}) {
  validateHex(expectedNonce, 64, "binding", "attestation_nonce_invalid");
  validateHex(expectedCommit, 40, "binding", "attestation_commit_invalid");
  validateHex(expectedTree, 40, "binding", "attestation_tree_invalid");
  validateHex(expectedBuildSha256, 64, "binding", "attestation_build_invalid");
  const roots = await validatePaths({
    stateRoot,
    trustedRoot,
    projectDir,
    wrapperPath,
    helperPath,
  });
  const attestation = await readAttestation(
    path.join(roots.stateRoot, ATTESTATION_NAME),
  );
  if (
    attestation.nonce !== expectedNonce ||
    attestation.projectDir !== roots.projectDir ||
    attestation.commit !== expectedCommit ||
    attestation.tree !== expectedTree ||
    attestation.buildSha256 !== expectedBuildSha256 ||
    attestation.wrapperPath !== roots.wrapperPath ||
    attestation.helperPath !== roots.helperPath
  ) {
    fail("binding", "attestation_binding_mismatch");
  }
  if (
    hashTrackedManifest(attestation.trackedFiles) !==
    attestation.trackedContentSha256
  ) {
    fail("attestation", "attestation_manifest_digest_mismatch");
  }
  const wrapper = await hashInstalledExecutable(roots.wrapperPath, "wrapper");
  if (wrapper.sha256 !== attestation.wrapperSha256)
    fail("wrapper", "attestation_wrapper_mismatch");
  const helper = await hashInstalledExecutable(roots.helperPath, "helper");
  if (helper.sha256 !== attestation.helperSha256)
    fail("helper", "attestation_helper_mismatch");
  await verifyTrackedFiles(roots.projectDir, attestation.trackedFiles);
  await verifyRuntimeInventory(roots.projectDir, attestation.trackedFiles);
  const buildSha256 = await hashStaticBuild(
    path.join(roots.projectDir, "static"),
  );
  if (buildSha256 !== attestation.buildSha256)
    fail("static_build", "attestation_build_mismatch");
  return attestation;
}

export function parseDeploymentAttestation(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || !hasExactKeys(value, ATTESTATION_KEYS))
    return null;
  if (
    value.schemaVersion !== 1 ||
    !isHex(value.nonce, 64) ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    !isCanonicalAbsolutePath(value.projectDir) ||
    !isHex(value.commit, 40) ||
    !isHex(value.tree, 40) ||
    !isHex(value.buildSha256, 64) ||
    !isCanonicalAbsolutePath(value.wrapperPath) ||
    !isHex(value.wrapperSha256, 64) ||
    !isCanonicalAbsolutePath(value.helperPath) ||
    !isHex(value.helperSha256, 64) ||
    !isHex(value.trackedContentSha256, 64) ||
    !Array.isArray(value.trackedFiles) ||
    value.trackedFiles.length < 1 ||
    value.trackedFiles.length > MAX_TRACKED_FILES
  ) {
    return null;
  }
  let previousPath = "";
  for (const entry of value.trackedFiles) {
    if (
      !isPlainObject(entry) ||
      !hasExactKeys(entry, TRACKED_FILE_KEYS) ||
      (entry.mode !== "100644" && entry.mode !== "100755") ||
      !isSafeRelativePath(entry.path) ||
      entry.path <= previousPath ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !isGitObjectId(entry.gitBlobOid) ||
      !isHex(entry.sha256, 64)
    ) {
      return null;
    }
    previousPath = entry.path;
  }
  return value;
}

export function parseClipReleaseState(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || typeof value.enabled !== "boolean") return null;
  if (value.schemaVersion === 1) {
    if (
      !hasExactKeys(value, RELEASE_STATE_V1_KEYS) ||
      value.enabled ||
      value.commit !== null ||
      value.tree !== null ||
      value.buildSha256 !== null
    ) {
      return null;
    }
    return value;
  }
  if (
    value.schemaVersion !== 2 ||
    !hasExactKeys(value, RELEASE_STATE_V2_KEYS)
  ) {
    return null;
  }
  if (value.enabled) {
    if (
      !isHex(value.commit, 40) ||
      !isHex(value.tree, 40) ||
      !isHex(value.buildSha256, 64) ||
      !isHex(value.attestationNonce, 64)
    ) {
      return null;
    }
  } else if (
    value.commit !== null ||
    value.tree !== null ||
    value.buildSha256 !== null ||
    value.attestationNonce !== null
  ) {
    return null;
  }
  return value;
}

export async function readDurableClipReleaseStatus({ stateRoot, trustedRoot }) {
  if (
    !isCanonicalAbsolutePath(stateRoot) ||
    !isCanonicalAbsolutePath(trustedRoot)
  ) {
    fail("release_state", "clip_release_state_path_invalid");
  }
  const resolvedTrustedRoot = await canonicalExistingPath(
    trustedRoot,
    "release_state",
  );
  const resolvedStateRoot = await canonicalExistingPath(
    stateRoot,
    "release_state",
  );
  if (!isDescendant(resolvedStateRoot, resolvedTrustedRoot))
    fail("release_state", "clip_release_state_trust_boundary_invalid");
  await validateDirectory(resolvedTrustedRoot, 0o700, "release_state");
  await validateDirectory(resolvedStateRoot, 0o700, "release_state");
  const statePath = path.join(resolvedStateRoot, RELEASE_STATE_NAME);
  try {
    await fs.lstat(statePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "disabled", state: null };
    fail("release_state", "clip_release_state_unreadable", error);
  }
  const bytes = await readStableFile(statePath, {
    stage: "release_state",
    mode: 0o600,
    maxBytes: MAX_RELEASE_STATE_BYTES,
  });
  const state = parseClipReleaseState(bytes.toString("utf8"));
  if (state === null)
    fail("release_state", "clip_release_state_schema_invalid");
  return state.enabled
    ? { kind: "enabled", state }
    : { kind: "disabled", state };
}

export async function hashStaticBuild(staticRoot) {
  if (!isCanonicalAbsolutePath(staticRoot))
    fail("static_build", "attestation_static_path_invalid");
  await validateDirectory(staticRoot, null, "static_build");
  const files = [];
  const directories = new Map();
  await collectStaticFiles(path.resolve(staticRoot), "", files, directories);
  files.sort();
  const digest = createHash("sha256");
  for (const relativePath of files) {
    const absolutePath = path.join(staticRoot, ...relativePath.split("/"));
    const file = await hashRegularFile(absolutePath, "static_build");
    digest.update(relativePath, "utf8");
    digest.update("\0");
    digest.update(String(file.size), "utf8");
    digest.update("\0");
    digest.update(file.bytes);
    digest.update("\0");
  }
  await assertRememberedDirectoriesStable(directories, "static_build");
  return digest.digest("hex");
}

async function validatePaths({
  stateRoot,
  trustedRoot,
  projectDir,
  wrapperPath,
  helperPath,
}) {
  for (const [name, value] of Object.entries({
    stateRoot,
    trustedRoot,
    projectDir,
    wrapperPath,
    helperPath,
  })) {
    if (!isCanonicalAbsolutePath(value))
      fail("root", `attestation_${name}_path_invalid`);
  }
  const resolvedTrustedRoot = await canonicalExistingPath(trustedRoot, "root");
  const resolvedStateRoot = await canonicalExistingPath(stateRoot, "root");
  const resolvedProjectDir = await canonicalExistingPath(projectDir, "root");
  const resolvedWrapperPath = await canonicalExistingPath(
    wrapperPath,
    "wrapper",
  );
  const resolvedHelperPath = await canonicalExistingPath(helperPath, "helper");
  if (
    !isDescendant(resolvedStateRoot, resolvedTrustedRoot) ||
    resolvedWrapperPath !==
      path.join(resolvedTrustedRoot, "bin", "start-proxywar-beta.zsh") ||
    resolvedHelperPath !==
      path.join(
        resolvedTrustedRoot,
        "bin",
        "proxywar-clips-deployment-attestation.mjs",
      ) ||
    isDescendant(resolvedProjectDir, resolvedTrustedRoot)
  ) {
    fail("root", "attestation_trust_boundary_invalid");
  }
  await validateDirectory(resolvedTrustedRoot, 0o700, "root");
  await validateDirectory(resolvedStateRoot, 0o700, "root");
  await validateDirectory(resolvedProjectDir, null, "root");
  return {
    trustedRoot: resolvedTrustedRoot,
    stateRoot: resolvedStateRoot,
    projectDir: resolvedProjectDir,
    wrapperPath: resolvedWrapperPath,
    helperPath: resolvedHelperPath,
  };
}

async function collectTrackedFiles({ projectDir }) {
  const { stdout } = await runGit(
    projectDir,
    ["ls-tree", "-r", "-z", "--full-tree", "HEAD"],
    "tracked_content",
  );
  const payload = stdout.at(-1) === 0 ? stdout.subarray(0, -1) : stdout;
  const decoded = payload.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(payload))
    fail("tracked_content", "attestation_tracked_path_encoding_invalid");
  const records = decoded.split("\0").filter(Boolean);
  if (records.length < 1 || records.length > MAX_TRACKED_FILES)
    fail("tracked_content", "attestation_tracked_count_invalid");
  const entries = [];
  const validatedDirectories = new Map();
  await rememberDirectory(projectDir, validatedDirectories, "tracked_content");
  for (const record of records) {
    const match =
      /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(record);
    if (match === null || !isSafeRelativePath(match[3]))
      fail("tracked_content", "attestation_tracked_record_invalid");
    await validateTrackedParentDirectories(
      projectDir,
      match[3],
      validatedDirectories,
    );
    const absolutePath = path.join(projectDir, ...match[3].split("/"));
    const file = await hashRegularFile(absolutePath, "tracked_content");
    const executable = (file.mode & 0o111) !== 0;
    if (executable !== (match[1] === "100755"))
      fail("tracked_content", "attestation_tracked_mode_mismatch");
    const gitBlobOid = hashGitBlob(file.bytes, match[2].length);
    if (gitBlobOid !== match[2])
      fail("tracked_content", "attestation_tracked_blob_mismatch");
    entries.push({
      path: match[3],
      mode: match[1],
      size: file.size,
      gitBlobOid,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    });
  }
  await assertRememberedDirectoriesStable(
    validatedDirectories,
    "tracked_content",
  );
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].path === entries[index].path)
      fail("tracked_content", "attestation_tracked_duplicate");
  }
  return entries;
}

async function verifyTrackedFiles(projectDir, entries) {
  const validatedDirectories = new Map();
  await rememberDirectory(projectDir, validatedDirectories, "tracked_content");
  for (const entry of entries) {
    await validateTrackedParentDirectories(
      projectDir,
      entry.path,
      validatedDirectories,
    );
    const absolutePath = path.join(projectDir, ...entry.path.split("/"));
    const file = await hashRegularFile(absolutePath, "tracked_content");
    const executable = (file.mode & 0o111) !== 0;
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    const gitBlobOid = hashGitBlob(file.bytes, entry.gitBlobOid.length);
    if (
      file.size !== entry.size ||
      executable !== (entry.mode === "100755") ||
      gitBlobOid !== entry.gitBlobOid ||
      sha256 !== entry.sha256
    ) {
      fail("tracked_content", "attestation_tracked_content_mismatch");
    }
  }
  await assertRememberedDirectoriesStable(
    validatedDirectories,
    "tracked_content",
  );
}

async function validateTrackedParentDirectories(
  projectDir,
  relativePath,
  validatedDirectories,
) {
  const segments = relativePath.split("/");
  let relativeDirectory = "";
  for (const segment of segments.slice(0, -1)) {
    relativeDirectory = relativeDirectory
      ? `${relativeDirectory}/${segment}`
      : segment;
    const absoluteDirectory = path.join(
      projectDir,
      ...relativeDirectory.split("/"),
    );
    if (validatedDirectories.has(absoluteDirectory)) continue;
    await rememberDirectory(
      absoluteDirectory,
      validatedDirectories,
      "tracked_content",
    );
  }
}

async function verifyRuntimeInventory(projectDir, entries) {
  const expectedPaths = new Set(entries.map((entry) => entry.path));
  const observedPaths = new Set();
  const directories = new Map();
  await collectRuntimeInventory(
    projectDir,
    "",
    expectedPaths,
    observedPaths,
    directories,
  );
  await assertRememberedDirectoriesStable(directories, "runtime_inventory");
  if (
    observedPaths.size !== expectedPaths.size ||
    [...expectedPaths].some((relativePath) => !observedPaths.has(relativePath))
  ) {
    fail("runtime_inventory", "attestation_runtime_inventory_mismatch");
  }
}

async function collectRuntimeInventory(
  projectDir,
  relativeDirectory,
  expectedPaths,
  observedPaths,
  directories,
) {
  const directory = relativeDirectory
    ? path.join(projectDir, ...relativeDirectory.split("/"))
    : projectDir;
  await rememberDirectory(directory, directories, "runtime_inventory");
  let dirents;
  try {
    dirents = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    fail(
      "runtime_inventory",
      "attestation_runtime_inventory_unreadable",
      error,
    );
  }
  await assertDirectoryStable(
    directory,
    directories.get(directory),
    "runtime_inventory",
  );
  for (const dirent of dirents) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${dirent.name}`
      : dirent.name;
    if (RUNTIME_INVENTORY_EXCLUDED_PATHS.has(relativePath)) continue;
    if (dirent.isSymbolicLink())
      fail("runtime_inventory", "attestation_runtime_inventory_symlink");
    if (dirent.isDirectory()) {
      await collectRuntimeInventory(
        projectDir,
        relativePath,
        expectedPaths,
        observedPaths,
        directories,
      );
    } else if (dirent.isFile()) {
      if (!expectedPaths.has(relativePath))
        fail("runtime_inventory", "attestation_runtime_inventory_unexpected");
      observedPaths.add(relativePath);
    } else {
      fail("runtime_inventory", "attestation_runtime_inventory_not_regular");
    }
  }
}

function hashTrackedManifest(entries) {
  const digest = createHash("sha256");
  for (const entry of entries) {
    digest.update(entry.path, "utf8");
    digest.update("\0");
    digest.update(entry.mode, "ascii");
    digest.update("\0");
    digest.update(String(entry.size), "ascii");
    digest.update("\0");
    digest.update(entry.gitBlobOid, "ascii");
    digest.update("\0");
    digest.update(entry.sha256, "ascii");
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function assertGitIdentity({ projectDir, expectedCommit, expectedTree }) {
  const commit = await runGitText(
    projectDir,
    ["rev-parse", "--verify", "HEAD"],
    "commit",
  );
  if (commit !== expectedCommit) fail("commit", "attestation_commit_mismatch");
  const tree = await runGitText(
    projectDir,
    ["rev-parse", "--verify", "HEAD^{tree}"],
    "tree",
  );
  if (tree !== expectedTree) fail("tree", "attestation_tree_mismatch");
  const status = await runGitText(
    projectDir,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "status",
  );
  if (status !== "") fail("status", "attestation_status_not_clean");
}

async function runGitText(projectDir, args, stage) {
  const { stdout } = await runGit(projectDir, args, stage);
  return stdout.toString("utf8").trim();
}

async function runGit(projectDir, args, stage) {
  try {
    return await execFileAsync(
      GIT_BIN,
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-C",
        projectDir,
        ...args,
      ],
      {
        encoding: null,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
  } catch (error) {
    fail(stage, `attestation_git_${stage}_failed`, error);
  }
}

async function writeAttestation(attestationPath, attestation) {
  const parent = path.dirname(attestationPath);
  await validateDirectory(parent, 0o700, "root");
  const bytes = Buffer.from(`${JSON.stringify(attestation)}\n`, "utf8");
  if (bytes.byteLength > MAX_ATTESTATION_BYTES)
    fail("attestation", "attestation_too_large");
  const temp = path.join(
    parent,
    `.${ATTESTATION_NAME}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, attestationPath);
    const directory = await fs.open(parent, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    fail("attestation", "attestation_write_failed", error);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temp).catch(() => undefined);
  }
}

async function readAttestation(attestationPath) {
  let bytes;
  try {
    bytes = await readStableFile(attestationPath, {
      stage: "attestation",
      mode: 0o600,
      maxBytes: MAX_ATTESTATION_BYTES,
    });
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    fail("attestation", "attestation_read_failed", error);
  }
  const value = parseDeploymentAttestation(bytes.toString("utf8"));
  if (value === null) fail("attestation", "attestation_schema_invalid");
  return value;
}

async function hashInstalledExecutable(filePath, stage) {
  const bytes = await readStableFile(filePath, {
    stage,
    mode: 0o755,
    maxBytes: 8 * 1024 * 1024,
  });
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function hashRegularFile(filePath, stage) {
  let before;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    fail(stage, "attestation_content_unreadable", error);
  }
  if (!before.isFile() || before.isSymbolicLink())
    fail(stage, "attestation_content_not_regular");
  let handle;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (!sameIdentity(before, opened))
      fail(stage, "attestation_content_changed");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(opened, after) || bytes.byteLength !== opened.size)
      fail(stage, "attestation_content_changed");
    const finalPath = await fs
      .lstat(filePath)
      .catch((error) => fail(stage, "attestation_content_changed", error));
    if (!sameIdentity(before, finalPath))
      fail(stage, "attestation_content_changed");
    return { bytes, size: opened.size, mode: opened.mode };
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    fail(stage, "attestation_content_unreadable", error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readStableFile(filePath, { stage, mode, maxBytes }) {
  let before;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    fail(stage, "attestation_file_unreadable", error);
  }
  validateOwnedFile(before, mode, maxBytes, stage);
  let handle;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    validateOwnedFile(opened, mode, maxBytes, stage);
    if (!sameIdentity(before, opened)) fail(stage, "attestation_file_changed");
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    if (
      !sameIdentity(opened, openedAfter) ||
      bytes.byteLength !== opened.size
    ) {
      fail(stage, "attestation_file_changed");
    }
    const after = await fs.lstat(filePath);
    if (!sameIdentity(before, after)) fail(stage, "attestation_file_changed");
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateOwnedFile(stats, mode, maxBytes, stage) {
  if (!stats.isFile() || stats.isSymbolicLink())
    fail(stage, "attestation_file_not_regular");
  if (stats.nlink !== 1) fail(stage, "attestation_file_hardlinked");
  if (stats.uid !== process.getuid()) fail(stage, "attestation_file_owner");
  if ((stats.mode & 0o777) !== mode) fail(stage, "attestation_file_mode");
  if (stats.size > maxBytes) fail(stage, "attestation_file_too_large");
}

async function validateDirectory(directory, expectedMode, stage) {
  let stats;
  try {
    stats = await fs.lstat(directory);
  } catch (error) {
    fail(stage, "attestation_directory_unreadable", error);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink())
    fail(stage, "attestation_directory_invalid");
  if (stats.uid !== process.getuid())
    fail(stage, "attestation_directory_owner");
  if (expectedMode !== null && (stats.mode & 0o777) !== expectedMode)
    fail(stage, "attestation_directory_mode");
}

async function validateCanonicalGit() {
  const real = await fs
    .realpath(GIT_BIN)
    .catch((error) => fail("git", "attestation_git_unreadable", error));
  if (real !== GIT_BIN) fail("git", "attestation_git_not_canonical");
  const stats = await fs
    .lstat(GIT_BIN)
    .catch((error) => fail("git", "attestation_git_unreadable", error));
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== 0 ||
    (stats.mode & 0o111) === 0 ||
    (stats.mode & 0o022) !== 0
  ) {
    fail("git", "attestation_git_invalid");
  }
}

async function canonicalExistingPath(value, stage) {
  let real;
  try {
    real = await fs.realpath(value);
  } catch (error) {
    fail(stage, "attestation_path_unreadable", error);
  }
  if (real !== value) fail(stage, "attestation_path_not_canonical");
  return real;
}

async function collectStaticFiles(root, relativeDirectory, files, directories) {
  const directory = path.join(
    root,
    ...relativeDirectory.split("/").filter(Boolean),
  );
  await rememberDirectory(directory, directories, "static_build");
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    fail("static_build", "attestation_static_unreadable", error);
  }
  await assertDirectoryStable(
    directory,
    directories.get(directory),
    "static_build",
  );
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      fail("static_build", "attestation_static_symlink");
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      await collectStaticFiles(root, relativePath, files, directories);
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      fail("static_build", "attestation_static_not_regular");
    }
  }
}

async function rememberDirectory(directory, directories, stage) {
  let stats;
  try {
    stats = await fs.lstat(directory);
  } catch (error) {
    fail(stage, "attestation_directory_unreadable", error);
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== process.getuid() ||
    (stats.mode & 0o022) !== 0
  ) {
    fail(stage, "attestation_directory_invalid");
  }
  const existing = directories.get(directory);
  if (existing !== undefined && !sameIdentity(existing, stats))
    fail(stage, "attestation_directory_changed");
  directories.set(directory, stats);
}

async function assertDirectoryStable(directory, before, stage) {
  const after = await fs
    .lstat(directory)
    .catch((error) => fail(stage, "attestation_directory_changed", error));
  if (before === undefined || !sameIdentity(before, after))
    fail(stage, "attestation_directory_changed");
}

async function assertRememberedDirectoriesStable(directories, stage) {
  for (const [directory, before] of directories) {
    await assertDirectoryStable(directory, before, stage);
  }
}

function hashGitBlob(bytes, oidLength) {
  const algorithm =
    oidLength === 40 ? "sha1" : oidLength === 64 ? "sha256" : null;
  if (algorithm === null)
    fail("tracked_content", "attestation_tracked_oid_invalid");
  return createHash(algorithm)
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function validateHex(value, length, stage, code) {
  if (!isHex(value, length)) fail(stage, code);
}

function isHex(value, length) {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[a-f0-9]+$/.test(value)
  );
}

function isGitObjectId(value) {
  return isHex(value, 40) || isHex(value, 64);
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isCanonicalAbsolutePath(value) {
  return (
    typeof value === "string" &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value.split("/").every((segment) => segment !== "." && segment !== "..")
  );
}

function isDescendant(candidate, root) {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function fail(stage, code, cause) {
  throw new AttestationError(stage, code, cause);
}

function parseArgs(argv) {
  const command = argv[0];
  if (
    command !== "create" &&
    command !== "verify" &&
    command !== "release-status"
  )
    throw new Error("attestation_usage");
  const options = { command };
  for (const argument of argv.slice(1)) {
    const match = /^--([a-z0-9-]+)=(.*)$/.exec(argument);
    if (match === null || match[2] === "")
      throw new Error("attestation_argument_invalid");
    if (match[1] in options)
      throw new Error(`attestation_argument_duplicate:${match[1]}`);
    options[match[1]] = match[2];
  }
  const common = [
    "state-root",
    "trusted-root",
    "project-dir",
    "wrapper-path",
    "helper-path",
    "expected-commit",
    "expected-tree",
    "expected-build-sha256",
  ];
  const required =
    command === "release-status"
      ? ["state-root", "trusted-root"]
      : command === "create"
        ? [...common, "expected-wrapper-sha256", "expected-helper-sha256"]
        : [...common, "expected-nonce"];
  if (
    Object.keys(options).some(
      (key) => key !== "command" && !required.includes(key),
    ) ||
    required.some((key) => !(key in options))
  ) {
    throw new Error("attestation_argument_set_invalid");
  }
  return options;
}

const invokedModulePath = process.argv[1]
  ? await fs.realpath(path.resolve(process.argv[1])).catch(() => null)
  : null;
const currentModulePath = await fs
  .realpath(fileURLToPath(import.meta.url))
  .catch(() => null);

if (invokedModulePath !== null && invokedModulePath === currentModulePath) {
  let command = process.argv[2] ?? "";
  try {
    const options = parseArgs(process.argv.slice(2));
    command = options.command;
    if (options.command === "release-status") {
      const result = await readDurableClipReleaseStatus({
        stateRoot: options["state-root"],
        trustedRoot: options["trusted-root"],
      });
      process.stdout.write(
        result.kind === "enabled"
          ? `enabled ${result.state.commit} ${result.state.tree} ${result.state.buildSha256} ${result.state.attestationNonce}\n`
          : "disabled\n",
      );
      process.exitCode = 0;
    } else {
      const common = {
        stateRoot: options["state-root"],
        trustedRoot: options["trusted-root"],
        projectDir: options["project-dir"],
        wrapperPath: options["wrapper-path"],
        helperPath: options["helper-path"],
        expectedCommit: options["expected-commit"],
        expectedTree: options["expected-tree"],
        expectedBuildSha256: options["expected-build-sha256"],
      };
      if (options.command === "create") {
        const result = await createDeploymentAttestation({
          ...common,
          expectedWrapperSha256: options["expected-wrapper-sha256"],
          expectedHelperSha256: options["expected-helper-sha256"],
        });
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: result.attestation.schemaVersion,
            nonce: result.attestation.nonce,
            commit: result.attestation.commit,
            tree: result.attestation.tree,
            buildSha256: result.attestation.buildSha256,
            wrapperSha256: result.attestation.wrapperSha256,
            helperSha256: result.attestation.helperSha256,
            trackedContentSha256: result.attestation.trackedContentSha256,
            trackedFileCount: result.attestation.trackedFiles.length,
            attestationPath: result.attestationPath,
          })}\n`,
        );
      } else {
        await verifyDeploymentAttestation({
          ...common,
          expectedNonce: options["expected-nonce"],
        });
        process.stdout.write("verified\n");
      }
    }
  } catch (error) {
    if (command === "verify" || command === "release-status") {
      const stage =
        error instanceof AttestationError ? error.stage : "invocation";
      process.stdout.write(`failed ${stage}\n`);
    } else {
      process.stderr.write(
        `${error instanceof Error ? error.message : "attestation_failed"}\n`,
      );
    }
    process.exitCode = 1;
  }
}

export const DEPLOYMENT_ATTESTATION_NAME = ATTESTATION_NAME;
