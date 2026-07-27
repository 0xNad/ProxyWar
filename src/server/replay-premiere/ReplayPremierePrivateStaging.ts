import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { StagedPremiereSource } from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import {
  cloneAndFreezeReplayPremiereValue,
  sha256Hex,
} from "./ReplayPremiereIntegrity";

const issuedVerifiedSourceReads = new WeakSet<object>();
const verifiedSourceIssueToken = Symbol("verified-staged-premiere-source");

export interface StagePremiereSourceOptions {
  sourceFilePath: string;
  privateStateRoot: string;
  servedRoots: readonly string[];
  maxSourceBytes: number;
  expectedSourceReplaySha256?: string;
  statfs?: typeof fs.statfs;
}

export interface ValidatedPremierePrivateLayout {
  privateStateRoot: string;
  servedRoots: string[];
}

export class VerifiedStagedPremiereSourceBytes {
  constructor(
    issueToken: typeof verifiedSourceIssueToken,
    private readonly staged: StagedPremiereSource,
    private readonly bytesBase64: string,
  ) {
    if (issueToken !== verifiedSourceIssueToken) {
      throw unsafeLayout("fabricated_verified_source_read");
    }
    issuedVerifiedSourceReads.add(this);
    Object.freeze(this);
  }

  static isAuthentic(
    value: unknown,
  ): value is VerifiedStagedPremiereSourceBytes {
    return (
      value instanceof VerifiedStagedPremiereSourceBytes &&
      issuedVerifiedSourceReads.has(value)
    );
  }

  stagedSource(): StagedPremiereSource {
    this.assertAuthentic();
    return cloneAndFreezeReplayPremiereValue(
      this.staged,
      "verified staged source view",
    );
  }

  copyBytes(): Buffer {
    this.assertAuthentic();
    return Buffer.from(this.bytesBase64, "base64");
  }

  private assertAuthentic(): void {
    if (!issuedVerifiedSourceReads.has(this)) {
      throw unsafeLayout("fabricated_verified_source_read");
    }
  }
}

export async function validatePremierePrivateLayout(options: {
  privateStateRoot: string;
  servedRoots: readonly string[];
}): Promise<ValidatedPremierePrivateLayout> {
  if (!path.isAbsolute(options.privateStateRoot)) {
    throw unsafeLayout("private_state_root_not_absolute");
  }
  if (options.servedRoots.length === 0) {
    throw unsafeLayout("served_roots_not_declared");
  }
  await fs.mkdir(options.privateStateRoot, { recursive: true, mode: 0o700 });
  const privateStateRoot = await fs.realpath(options.privateStateRoot);
  await assertNoSymlinkComponents(privateStateRoot);
  await hardenPrivateDirectory(privateStateRoot);
  const servedRoots: string[] = [];
  for (const configuredRoot of options.servedRoots) {
    if (!path.isAbsolute(configuredRoot)) {
      throw unsafeLayout("served_root_not_absolute");
    }
    const servedRoot = await canonicalPath(configuredRoot);
    if (
      pathsOverlap(privateStateRoot, servedRoot) ||
      pathsOverlap(servedRoot, privateStateRoot)
    ) {
      throw unsafeLayout("private_and_served_roots_overlap");
    }
    servedRoots.push(servedRoot);
  }
  return { privateStateRoot, servedRoots };
}

export async function stagePremiereSource(
  options: StagePremiereSourceOptions,
): Promise<StagedPremiereSource> {
  if (
    !Number.isSafeInteger(options.maxSourceBytes) ||
    options.maxSourceBytes <= 0
  ) {
    throw invalidStagingRequest("invalid_source_byte_ceiling");
  }
  const layout = await validatePremierePrivateLayout(options);
  const sourcePath = path.resolve(options.sourceFilePath);
  let requestedSourceStat;
  try {
    requestedSourceStat = await fs.lstat(sourcePath);
  } catch (error) {
    throw invalidStagingRequest("source_bundle_unavailable", error);
  }
  if (requestedSourceStat.isSymbolicLink()) {
    throw unsafeLayout("source_bundle_symlink");
  }
  const sourceRealPath = await fs.realpath(sourcePath);
  await assertNoSymlinkComponents(sourceRealPath);
  if (
    layout.servedRoots.some(
      (servedRoot) =>
        pathsOverlap(servedRoot, sourceRealPath) ||
        pathsOverlap(sourceRealPath, servedRoot),
    )
  ) {
    throw unsafeLayout("source_bundle_is_under_served_root");
  }
  const before = await fs.lstat(sourceRealPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw unsafeLayout("source_bundle_not_regular_file");
  }
  if (before.size > options.maxSourceBytes) {
    throw capacityError("source_bundle_byte_ceiling_exceeded");
  }
  const sourceHandle = await fs.open(
    sourceRealPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let contents: Buffer;
  try {
    const openedBefore = await sourceHandle.stat();
    contents = await sourceHandle.readFile();
    const openedAfter = await sourceHandle.stat();
    if (
      openedBefore.dev !== openedAfter.dev ||
      openedBefore.ino !== openedAfter.ino ||
      openedBefore.nlink !== 1 ||
      openedAfter.nlink !== 1 ||
      openedBefore.size !== openedAfter.size ||
      openedBefore.mtimeMs !== openedAfter.mtimeMs ||
      contents.byteLength !== openedAfter.size
    ) {
      throw new ReplayPremiereError(
        "source_bundle_changed_during_read",
        "PREMIERE_INTEGRITY_FAILURE",
        409,
        "Private replay source changed during staging",
      );
    }
  } finally {
    await sourceHandle.close();
  }
  if (contents.byteLength > options.maxSourceBytes) {
    throw capacityError("source_bundle_byte_ceiling_exceeded");
  }
  const sourceReplaySha256 = sha256Hex(contents);
  if (
    options.expectedSourceReplaySha256 !== undefined &&
    options.expectedSourceReplaySha256 !== sourceReplaySha256
  ) {
    throw new ReplayPremiereError(
      "source_bundle_hash_mismatch",
      "PREMIERE_INTEGRITY_FAILURE",
      409,
      "Private replay source hash does not match its declared identity",
    );
  }
  await assertPremiereDurableWriteAdmission({
    destinationPath: layout.privateStateRoot,
    pendingBytes: contents.byteLength,
    statfs: options.statfs,
  });
  const contentDirectory = path.join(
    layout.privateStateRoot,
    "sources",
    "sha256",
    sourceReplaySha256.slice(0, 2),
  );
  await fs.mkdir(contentDirectory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(contentDirectory);
  await hardenPrivateDirectory(path.join(layout.privateStateRoot, "sources"));
  await hardenPrivateDirectory(
    path.join(layout.privateStateRoot, "sources", "sha256"),
  );
  await hardenPrivateDirectory(contentDirectory);
  const destinationPath = path.join(
    contentDirectory,
    `${sourceReplaySha256}.replay`,
  );
  if (await verifyExistingContent(destinationPath, contents)) {
    return cloneAndFreezeReplayPremiereValue(
      {
        schemaVersion: 1,
        sourceReplaySha256,
        byteLength: contents.byteLength,
        privatePath: destinationPath,
        reused: true,
      },
      "reused staged premiere source",
    );
  }
  const temporaryPath = path.join(
    contentDirectory,
    `.${sourceReplaySha256}.${randomUUID()}.tmp`,
  );
  await assertPremiereDurableWriteAdmission({
    destinationPath: contentDirectory,
    pendingBytes: contents.byteLength,
    statfs: options.statfs,
  });
  const temporaryHandle = await fs.open(
    temporaryPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await temporaryHandle.writeFile(contents);
    await temporaryHandle.sync();
  } finally {
    await temporaryHandle.close();
  }
  try {
    await fs.link(temporaryPath, destinationPath);
    await fs.chmod(destinationPath, 0o400);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    if (!(await verifyExistingContent(destinationPath, contents))) {
      throw new ReplayPremiereError(
        "content_address_collision",
        "PREMIERE_INTEGRITY_FAILURE",
        409,
        "Private replay content address contains different bytes",
      );
    }
  } finally {
    await fs.unlink(temporaryPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
  if (!(await verifyExistingContent(destinationPath, contents))) {
    throw new ReplayPremiereError(
      "staged_content_missing_after_publish",
      "PREMIERE_INTEGRITY_FAILURE",
      409,
      "Private replay content was not durably staged",
    );
  }
  const directoryHandle = await fs.open(contentDirectory, constants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  return cloneAndFreezeReplayPremiereValue(
    {
      schemaVersion: 1,
      sourceReplaySha256,
      byteLength: contents.byteLength,
      privatePath: destinationPath,
      reused: false,
    },
    "staged premiere source",
  );
}

export const PREMIERE_BOUNDED_WRITE_FLOOR_BYTES = 15 * 1024 ** 3;
export const PREMIERE_IMMUTABLE_MIRROR_RESERVE_BYTES = 10 * 1024 ** 3;

export async function assertPremiereDurableWriteAdmission(options: {
  destinationPath: string;
  pendingBytes: number;
  statfs?: typeof fs.statfs;
}): Promise<void> {
  if (!Number.isSafeInteger(options.pendingBytes) || options.pendingBytes < 0) {
    throw invalidStagingRequest("invalid_pending_write_bytes");
  }
  const stats = await (options.statfs ?? fs.statfs)(options.destinationPath);
  const available = Number(stats.bavail) * Number(stats.bsize);
  const required = Math.max(
    PREMIERE_BOUNDED_WRITE_FLOOR_BYTES,
    PREMIERE_IMMUTABLE_MIRROR_RESERVE_BYTES + options.pendingBytes,
  );
  if (!Number.isSafeInteger(available) || available < required) {
    throw capacityError("durable_write_free_space_floor_not_met");
  }
}

/**
 * Mandatory consumption boundary for staged source content. Every call
 * re-opens with O_NOFOLLOW and rechecks containment, identity, mode, size and
 * content hash before issuing a runtime-authentic byte object.
 */
export async function readVerifiedStagedPremiereSource(options: {
  stagedSource: StagedPremiereSource;
  privateStateRoot: string;
  servedRoots: readonly string[];
  maxSourceBytes: number;
}): Promise<VerifiedStagedPremiereSourceBytes> {
  if (
    !Number.isSafeInteger(options.maxSourceBytes) ||
    options.maxSourceBytes <= 0 ||
    options.stagedSource.schemaVersion !== 1 ||
    options.stagedSource.byteLength > options.maxSourceBytes
  ) {
    throw invalidStagingRequest("invalid_verified_source_read_request");
  }
  const layout = await validatePremierePrivateLayout(options);
  const requestedPath = path.resolve(options.stagedSource.privatePath);
  if (!isContainedPath(layout.privateStateRoot, requestedPath)) {
    throw unsafeLayout("staged_source_outside_private_root");
  }
  const stat = await fs.lstat(requestedPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    !ownedByCurrentProcess(stat.uid) ||
    (stat.mode & 0o777) !== 0o400 ||
    stat.size !== options.stagedSource.byteLength
  ) {
    throw unsafeLayout("staged_source_read_contract_mismatch");
  }
  const realPath = await fs.realpath(requestedPath);
  if (
    realPath !== requestedPath ||
    !isContainedPath(layout.privateStateRoot, realPath)
  ) {
    throw unsafeLayout("staged_source_path_identity_mismatch");
  }
  const handle = await fs.open(
    requestedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      !ownedByCurrentProcess(before.uid) ||
      (before.mode & 0o777) !== 0o400 ||
      before.size > options.maxSourceBytes
    ) {
      throw unsafeLayout("staged_source_open_contract_mismatch");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.nlink !== 1 ||
      !ownedByCurrentProcess(after.uid) ||
      bytes.byteLength !== after.size
    ) {
      throw unsafeLayout("staged_source_changed_during_verified_read");
    }
  } finally {
    await handle.close();
  }
  if (
    sha256Hex(bytes) !== options.stagedSource.sourceReplaySha256 ||
    bytes.byteLength !== options.stagedSource.byteLength
  ) {
    throw unsafeLayout("staged_source_verified_hash_mismatch");
  }
  return new VerifiedStagedPremiereSourceBytes(
    verifiedSourceIssueToken,
    cloneAndFreezeReplayPremiereValue(
      options.stagedSource,
      "verified staged source metadata",
    ),
    bytes.toString("base64"),
  );
}

function ownedByCurrentProcess(uid: number): boolean {
  const getuid = process.getuid;
  return getuid === undefined || uid === getuid.call(process);
}

export function isContainedPath(root: string, candidate: string): boolean {
  // Inputs are resolved/realpathed by callers. Preserve exact filesystem byte
  // semantics: Darwin may host case-sensitive or Unicode-distinct volumes.
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function verifyExistingContent(
  destinationPath: string,
  expected: Buffer,
): Promise<boolean> {
  let stat;
  try {
    stat = await fs.lstat(destinationPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw unsafeLayout("staged_content_path_not_regular_file");
  }
  if ((stat.mode & 0o777) !== 0o400) {
    throw unsafeLayout("staged_content_not_read_only");
  }
  if (stat.size !== expected.byteLength) {
    throw new ReplayPremiereError(
      "content_address_size_mismatch",
      "PREMIERE_INTEGRITY_FAILURE",
      409,
      "Private replay content address has an invalid size",
    );
  }
  const handle = await fs.open(
    destinationPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.nlink !== 1 ||
      !opened.isFile()
    ) {
      throw unsafeLayout("staged_content_identity_changed");
    }
    const found = await handle.readFile();
    if (!found.equals(expected)) {
      throw new ReplayPremiereError(
        "content_address_bytes_mismatch",
        "PREMIERE_INTEGRITY_FAILURE",
        409,
        "Private replay content address has invalid bytes",
      );
    }
  } finally {
    await handle.close();
  }
  return true;
}

async function canonicalPath(value: string): Promise<string> {
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

async function assertNoSymlinkComponents(value: string): Promise<void> {
  let current = path.resolve(value);
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw unsafeLayout("symlink_path_component");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function pathsOverlap(root: string, candidate: string): boolean {
  return isContainedPath(root, candidate);
}

async function hardenPrivateDirectory(directoryPath: string): Promise<void> {
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw unsafeLayout("private_state_component_not_directory");
  }
  if ((stat.mode & 0o777) !== 0o700) {
    await fs.chmod(directoryPath, 0o700);
  }
}

function unsafeLayout(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    `Unsafe private replay staging layout: ${operatorCode}`,
  );
}

function invalidStagingRequest(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    400,
    `Replay premiere staging request rejected: ${operatorCode}`,
    cause === undefined ? undefined : { cause },
  );
}

function capacityError(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_CAPACITY_EXCEEDED",
    413,
    `Replay premiere staging rejected: ${operatorCode}`,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
