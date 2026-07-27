import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { isSafeProxyWarArtifactSegment } from "../agents/ProxyWarPublicArtifacts";
import type {
  PremiereArchivePointerV1,
  ReplayPremiereArchiveStore,
} from "./ReplayPremiereArchiveIndex";
import {
  archivedPremiereClipFileName,
  archivedPremiereClipManifestFileName,
  archivedPremiereClipsDir,
  clipFileName,
  parsePremiereClipRenderManifest,
  replayPremiereClipCacheDir,
} from "./ReplayPremiereClips";
import {
  isPremiereClipBucket,
  PREMIERE_CLIP_VERSION,
  premiereClipBucketForTurn,
  type PremiereClipRenderManifest,
} from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import { isSha256Hex } from "./ReplayPremiereIntegrity";
import { publicRunKeyForSourceRunId } from "./ReplayPremiereLoopCore";

export const DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIPS = 200;
export const DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIP_BYTES = 1024 ** 3;

const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;
const CACHED_CLIP_FILE_PATTERN = /^clip-v1-(0|[1-9][0-9]{0,8})\.mp4$/;
const MAX_CACHE_CANDIDATES = 128;
const MAX_MANIFEST_BYTES = 64 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;
const MAX_TEMP_FILES_SCANNED = 512;
const MAX_TEMP_FILES_REMOVED = 64;
const STALE_TEMP_MIN_AGE_MS = 10 * 60 * 1_000;
const OWNED_PROMOTION_TEMP_FILE_PATTERN =
  /^\.prem_[a-z0-9]{16,32}\.([1-9][0-9]{0,9})\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:mp4|manifest)\.tmp$/;
const LEGACY_PROMOTION_TEMP_FILE_PATTERN =
  /^\.prem_[a-z0-9]{16,32}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:mp4|manifest)\.tmp$/;

interface ValidatedCandidate {
  cacheId: string;
  bucket: number;
  clipPath: string;
  manifestPath: string;
  manifestBytes: Buffer;
  manifest: PremiereClipRenderManifest;
  clipStat: Awaited<ReturnType<typeof fs.lstat>>;
  manifestStat: Awaited<ReturnType<typeof fs.lstat>>;
}

export interface RatedCoworldArchivedClipPromotion {
  runKey: string;
  bucket: number;
  sourceReplaySha256: string;
  sourceFilePath: string;
}

export interface ReplayPremiereArchivedClipPromoterOptions {
  privateStateRoot: string;
  archiveStore: ReplayPremiereArchiveStore;
  maxArchivedClips?: number;
  maxArchivedClipBytes?: number;
  logger?: (message: string) => void;
  /** Bounded deterministic test barrier; production callers omit it. */
  beforeDurableClipCommit?: (premiereId: string) => Promise<void>;
  /** Bounded deterministic retention-race barrier; production callers omit it. */
  afterRetentionClipUnlink?: (premiereId: string) => Promise<void>;
}

/**
 * The one durable archive-clip promotion boundary. Both terminal reclamation
 * (premiere cache) and post-archive league rendering use this implementation,
 * so provenance validation, first-write semantics, fsync ordering, and
 * retention cannot drift between the two paths.
 */
export class ReplayPremiereArchivedClipPromoter {
  private readonly archiveStore: ReplayPremiereArchiveStore;
  private readonly premiereClipsRoot: string;
  private readonly leagueClipsRoot: string;
  private readonly archivedClipsRoot: string;
  private readonly maxArchivedClips: number;
  private readonly maxArchivedClipBytes: number;
  private readonly logger: (message: string) => void;
  private readonly beforeDurableClipCommit:
    | ((premiereId: string) => Promise<void>)
    | undefined;
  private readonly afterRetentionClipUnlink:
    | ((premiereId: string) => Promise<void>)
    | undefined;
  private readonly ownTemporaryFiles = new Set<string>();
  private tempCleanupCursor: string | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: ReplayPremiereArchivedClipPromoterOptions) {
    const privateStateRoot = path.resolve(options.privateStateRoot);
    this.archiveStore = options.archiveStore;
    this.premiereClipsRoot = replayPremiereClipCacheDir(privateStateRoot);
    this.leagueClipsRoot = path.join(privateStateRoot, "league-clips-v1");
    this.archivedClipsRoot = archivedPremiereClipsDir(
      options.archiveStore.archiveRoot,
    );
    this.maxArchivedClips =
      options.maxArchivedClips ?? DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIPS;
    this.maxArchivedClipBytes =
      options.maxArchivedClipBytes ??
      DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIP_BYTES;
    if (
      !Number.isSafeInteger(this.maxArchivedClips) ||
      this.maxArchivedClips < 1 ||
      !Number.isSafeInteger(this.maxArchivedClipBytes) ||
      this.maxArchivedClipBytes < 1
    ) {
      throw promotionRequest("invalid_archived_clip_bounds");
    }
    this.logger = options.logger ?? (() => undefined);
    this.beforeDurableClipCommit = options.beforeDurableClipCommit;
    this.afterRetentionClipUnlink = options.afterRetentionClipUnlink;
  }

  /**
   * Bounded startup recovery for crash-left temp hardlinks. Safe to call with
   * no archive pointer or render candidate; repeated calls advance a cursor so
   * young/invalid names in one page cannot starve later stale artifacts.
   */
  async repairOrphanedTemporaryFiles(): Promise<number> {
    return await this.runExclusive(async () => {
      await this.ensureArchivedClipsDirectory();
      return await this.cleanupStaleTemporaryFiles();
    });
  }

  /** Promote the highest valid clip from the original Premiere cache. */
  async promotePremiereCache(
    premiereId: string,
    pointer: PremiereArchivePointerV1,
  ): Promise<boolean> {
    if (!this.isCurrentRevealPublicPointer(premiereId, pointer)) return false;
    const candidate = await this.selectBestCandidate({
      clipsRoot: this.premiereClipsRoot,
      cacheId: premiereId,
      expectedSourceReplaySha256: pointer.sourceReplaySha256,
    });
    if (candidate === null) return false;
    return await this.runExclusive(() =>
      this.promoteCandidate(pointer, candidate, null),
    );
  }

  /**
   * Promote a ready league-run clip to every reveal-public rated Coworld
   * archive pointer that names that exact public run. The published league
   * record hash is intentionally independent of the pointer's original
   * admission-bundle hash.
   */
  async promoteRatedCoworldRunClip(
    request: RatedCoworldArchivedClipPromotion,
  ): Promise<number> {
    if (
      !isSafeProxyWarArtifactSegment(request.runKey) ||
      !isPremiereClipBucket(request.bucket) ||
      !isSha256Hex(request.sourceReplaySha256)
    ) {
      return 0;
    }
    const pointers =
      this.archiveStore.revealPublicRatedCoworldPointersForRunKey(
        request.runKey,
      );
    if (pointers.length === 0) return 0;
    const candidate = await this.validateCandidate({
      clipsRoot: this.leagueClipsRoot,
      cacheId: request.runKey,
      bucket: request.bucket,
      expectedSourceReplaySha256: request.sourceReplaySha256,
    });
    if (candidate === null) return 0;
    let promoted = 0;
    for (const pointer of pointers) {
      const wrote = await this.runExclusive(() =>
        this.promoteCandidate(pointer, candidate, {
          filePath: request.sourceFilePath,
          sha256: request.sourceReplaySha256,
        }),
      );
      if (wrote) promoted += 1;
    }
    return promoted;
  }

  private async promoteCandidate(
    pointer: PremiereArchivePointerV1,
    candidate: ValidatedCandidate,
    retainedSource: { filePath: string; sha256: string } | null,
  ): Promise<boolean> {
    if (!this.isCurrentRevealPublicPointer(pointer.premiereId, pointer)) {
      return false;
    }
    if (retainedSource !== null) {
      const expectedRunKey = publicRunKeyForSourceRunId(pointer.sourceRunId);
      if (
        pointer.sourceKind !== "rated_coworld" ||
        expectedRunKey !== candidate.cacheId ||
        !(await regularFileHasSha256(
          retainedSource.filePath,
          retainedSource.sha256,
        ))
      ) {
        return false;
      }
    }
    if (!(await candidatePathsUnchanged(candidate))) return false;

    await this.ensureArchivedClipsDirectory();
    await this.cleanupStaleTemporaryFiles();
    const destinationClip = path.join(
      this.archivedClipsRoot,
      archivedPremiereClipFileName(pointer.premiereId),
    );
    const destinationManifest = path.join(
      this.archivedClipsRoot,
      archivedPremiereClipManifestFileName(pointer.premiereId),
    );
    const existing = await lstatOrNull(destinationClip);
    if (existing !== null) {
      // First write wins. A malformed or symlinked first write is never
      // replaced through this path.
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw promotionIntegrity("archived_clip_destination_invalid");
      }
      const existingManifest = await lstatOrNull(destinationManifest);
      if (
        existingManifest === null ||
        !existingManifest.isFile() ||
        existingManifest.isSymbolicLink()
      ) {
        throw promotionIntegrity("archived_clip_destination_manifest_invalid");
      }
      await this.evictOverBounds(pointer.premiereId);
      return false;
    }

    const token = randomUUID();
    const temporaryClip = path.join(
      this.archivedClipsRoot,
      `.${pointer.premiereId}.${process.pid}.${token}.mp4.tmp`,
    );
    const temporaryManifest = path.join(
      this.archivedClipsRoot,
      `.${pointer.premiereId}.${process.pid}.${token}.manifest.tmp`,
    );
    this.ownTemporaryFiles.add(temporaryClip);
    this.ownTemporaryFiles.add(temporaryManifest);
    try {
      await writeExclusiveSynced(temporaryManifest, candidate.manifestBytes);
      await copyCandidateExclusiveSynced(candidate, temporaryClip);
      if (retainedSource !== null) {
        if (
          !(await regularFileHasSha256(
            retainedSource.filePath,
            retainedSource.sha256,
          ))
        ) {
          return false;
        }
      }
      if (!this.isCurrentRevealPublicPointer(pointer.premiereId, pointer)) {
        return false;
      }

      const durableManifest = await lstatOrNull(destinationManifest);
      if (durableManifest === null) {
        await fs.link(temporaryManifest, destinationManifest);
      } else if (
        durableManifest.isSymbolicLink() ||
        !durableManifest.isFile() ||
        !(await regularFileEquals(destinationManifest, candidate.manifestBytes))
      ) {
        return false;
      }
      await syncDirectory(this.archivedClipsRoot);
      await this.beforeDurableClipCommit?.(pointer.premiereId);

      // The mp4 link is the public visibility commit and is installed last,
      // after both temp files and the final manifest are durable. link(2) is
      // atomic and refuses overwrite, preserving first-write semantics.
      try {
        await fs.link(temporaryClip, destinationClip);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") return false;
        throw error;
      }
      await syncDirectory(this.archivedClipsRoot);
      this.logger(
        `archived_clip_promoted ${pointer.premiereId} anchorTurn=${candidate.manifest.anchorTurn} bytes=${candidate.manifest.outBytes}`,
      );
      await this.evictOverBounds(pointer.premiereId);
      return true;
    } finally {
      await this.cleanupOwnTemporaryFiles([temporaryClip, temporaryManifest]);
    }
  }

  private isCurrentRevealPublicPointer(
    premiereId: string,
    pointer: PremiereArchivePointerV1,
  ): boolean {
    const current = this.archiveStore.lookup(premiereId);
    return (
      PREMIERE_ID_PATTERN.test(premiereId) &&
      current !== null &&
      current.premiereId === pointer.premiereId &&
      current.schemaVersion === pointer.schemaVersion &&
      current.summaryHash === pointer.summaryHash &&
      current.summaryRelPath === pointer.summaryRelPath &&
      current.sourceRunId === pointer.sourceRunId &&
      current.sourceKind === pointer.sourceKind &&
      current.sourceReplaySha256 === pointer.sourceReplaySha256 &&
      current.publicationCommitmentHash === pointer.publicationCommitmentHash &&
      current.terminalState === pointer.terminalState &&
      current.revealedAt === pointer.revealedAt &&
      current.reclaimedAt === pointer.reclaimedAt &&
      current.revealedAt !== null &&
      (current.terminalState === "revealed" ||
        current.terminalState === "archived")
    );
  }

  private async selectBestCandidate(options: {
    clipsRoot: string;
    cacheId: string;
    expectedSourceReplaySha256: string;
  }): Promise<ValidatedCandidate | null> {
    const directory = path.join(options.clipsRoot, options.cacheId);
    let files: string[];
    try {
      files = (await fs.readdir(directory))
        .filter((file) => CACHED_CLIP_FILE_PATTERN.test(file))
        .sort();
    } catch {
      return null;
    }
    if (files.length > MAX_CACHE_CANDIDATES) return null;
    let best: ValidatedCandidate | null = null;
    for (const file of files) {
      const match = CACHED_CLIP_FILE_PATTERN.exec(file);
      if (match === null) continue;
      const candidate = await this.validateCandidate({
        ...options,
        bucket: Number(match[1]),
      });
      if (
        candidate !== null &&
        (best === null ||
          candidate.manifest.anchorTurn > best.manifest.anchorTurn)
      ) {
        best = candidate;
      }
    }
    return best;
  }

  private async validateCandidate(options: {
    clipsRoot: string;
    cacheId: string;
    bucket: number;
    expectedSourceReplaySha256: string;
  }): Promise<ValidatedCandidate | null> {
    if (
      !isSafeProxyWarArtifactSegment(options.cacheId) ||
      !isPremiereClipBucket(options.bucket) ||
      !isSha256Hex(options.expectedSourceReplaySha256)
    ) {
      return null;
    }
    const directory = path.join(options.clipsRoot, options.cacheId);
    const clipPath = path.join(directory, clipFileName(options.bucket));
    const manifestPath = clipPath.replace(/\.mp4$/, ".render-manifest.json");
    try {
      const [clipStat, manifestRead] = await Promise.all([
        fs.lstat(clipPath),
        readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES),
      ]);
      if (clipStat.isSymbolicLink() || !clipStat.isFile()) return null;
      const manifest = parsePremiereClipRenderManifest(
        JSON.parse(manifestRead.bytes.toString("utf8")),
      );
      if (
        manifest === null ||
        manifest.premiereId !== options.cacheId ||
        manifest.sourceReplaySha256 !== options.expectedSourceReplaySha256 ||
        manifest.clipVersion !== PREMIERE_CLIP_VERSION ||
        manifest.outBytes <= 0 ||
        manifest.outBytes !== clipStat.size ||
        premiereClipBucketForTurn(manifest.anchorTurn) !== options.bucket ||
        (await hashRegularFile(clipPath, clipStat)) !== manifest.outSha256
      ) {
        return null;
      }
      return {
        cacheId: options.cacheId,
        bucket: options.bucket,
        clipPath,
        manifestPath,
        manifestBytes: manifestRead.bytes,
        manifest,
        clipStat,
        manifestStat: manifestRead.stat,
      };
    } catch {
      return null;
    }
  }

  private async evictOverBounds(justPromotedPremiereId: string): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(this.archivedClipsRoot);
    } catch {
      return;
    }
    const entries: Array<{
      premiereId: string;
      clipPath: string;
      bytes: number;
      mtimeMs: number;
    }> = [];
    for (const file of files) {
      if (!file.endsWith(".mp4")) continue;
      const premiereId = file.slice(0, -4);
      if (!PREMIERE_ID_PATTERN.test(premiereId)) continue;
      const clipPath = path.join(this.archivedClipsRoot, file);
      try {
        const stat = await fs.lstat(clipPath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        entries.push({
          premiereId,
          clipPath,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        continue;
      }
    }
    let count = entries.length;
    let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const oldestFirst = [...entries].sort((left, right) =>
      left.mtimeMs === right.mtimeMs
        ? left.premiereId.localeCompare(right.premiereId)
        : left.mtimeMs - right.mtimeMs,
    );
    for (const entry of oldestFirst) {
      if (
        count <= this.maxArchivedClips &&
        totalBytes <= this.maxArchivedClipBytes
      ) {
        break;
      }
      if (entry.premiereId === justPromotedPremiereId) continue;
      await unlinkAndVerifyAbsent(entry.clipPath);
      await syncDirectory(this.archivedClipsRoot);
      // Provenance sidecars are monotonic. A competing process may install a
      // new MP4 after this verified unlink; retaining the manifest guarantees
      // every such visibility commit still has its matching provenance.
      await this.afterRetentionClipUnlink?.(entry.premiereId);
      if ((await lstatOrNull(entry.clipPath)) !== null) {
        throw promotionIntegrity("archived_clip_retention_target_reappeared");
      }
      count -= 1;
      totalBytes -= entry.bytes;
      this.logger(`archived_clip_evicted ${entry.premiereId} retention`);
    }
  }

  /**
   * Removes only old, regular temp artifacts matching this promoter's exact
   * grammar. The age floor prevents one process from deleting another active
   * promotion; scan/removal caps keep startup repair bounded.
   */
  private async ensureArchivedClipsDirectory(): Promise<void> {
    await fs.mkdir(this.archivedClipsRoot, {
      recursive: true,
      mode: 0o700,
    });
    await syncDirectory(path.dirname(this.archivedClipsRoot));
  }

  private async cleanupStaleTemporaryFiles(): Promise<number> {
    if (this.ownTemporaryFiles.size > 0) {
      await this.cleanupOwnTemporaryFiles([...this.ownTemporaryFiles]);
    }
    const names = (await fs.readdir(this.archivedClipsRoot))
      .filter((name) => promotionTempOwnerPid(name) !== undefined)
      .sort();
    if (names.length === 0) {
      this.tempCleanupCursor = null;
      return 0;
    }
    const start =
      this.tempCleanupCursor === null
        ? 0
        : Math.max(
            0,
            names.findIndex((name) => name > this.tempCleanupCursor!),
          );
    const rotated = [...names.slice(start), ...names.slice(0, start)];
    const page = rotated.slice(0, MAX_TEMP_FILES_SCANNED);
    this.tempCleanupCursor = page.at(-1) ?? null;
    const cutoffMs = Date.now() - STALE_TEMP_MIN_AGE_MS;
    let removed = 0;
    for (const name of page) {
      if (removed >= MAX_TEMP_FILES_REMOVED) break;
      const filePath = path.join(this.archivedClipsRoot, name);
      const stat = await lstatOrNull(filePath);
      const ownerPid = promotionTempOwnerPid(name);
      if (
        stat === null ||
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        ownerPid === undefined ||
        (ownerPid === null && stat.mtimeMs > cutoffMs) ||
        (ownerPid !== null && processIsAlive(ownerPid))
      ) {
        continue;
      }
      await unlinkAndVerifyAbsent(filePath);
      removed += 1;
    }
    if (removed > 0) await syncDirectory(this.archivedClipsRoot);
    return removed;
  }

  /** Own temp unlink durability matters because they are hardlinks to MP4s. */
  private async cleanupOwnTemporaryFiles(
    filePaths: readonly string[],
  ): Promise<void> {
    let removed = false;
    let failure: unknown = null;
    try {
      for (const filePath of filePaths) {
        const stat = await lstatOrNull(filePath);
        if (stat === null) {
          this.ownTemporaryFiles.delete(filePath);
          continue;
        }
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw promotionIntegrity("archived_clip_temporary_file_invalid");
        }
        await unlinkAndVerifyAbsent(filePath);
        this.ownTemporaryFiles.delete(filePath);
        removed = true;
      }
    } catch (error) {
      failure = error;
    } finally {
      if (removed) await syncDirectory(this.archivedClipsRoot);
    }
    if (failure !== null) throw failure;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function unlinkAndVerifyAbsent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  if ((await lstatOrNull(filePath)) !== null) {
    throw promotionIntegrity("archived_clip_unlink_not_absent");
  }
}

function promotionTempOwnerPid(name: string): number | null | undefined {
  const owned = OWNED_PROMOTION_TEMP_FILE_PATTERN.exec(name);
  if (owned !== null) {
    const pid = Number(owned[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  }
  return LEGACY_PROMOTION_TEMP_FILE_PATTERN.test(name) ? null : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function copyCandidateExclusiveSynced(
  candidate: ValidatedCandidate,
  destinationPath: string,
): Promise<void> {
  const source = await fs.open(
    candidate.clipPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const destination = await fs.open(
    destinationPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o400,
  );
  try {
    const sourceStat = await source.stat();
    if (!sameFile(sourceStat, candidate.clipStat) || !sourceStat.isFile()) {
      throw promotionIntegrity("archived_clip_source_changed");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let offset = 0;
    while (offset < candidate.manifest.outBytes) {
      const length = Math.min(
        buffer.byteLength,
        candidate.manifest.outBytes - offset,
      );
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead <= 0) {
        throw promotionIntegrity("archived_clip_copy_short_read");
      }
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          offset + written,
        );
        if (result.bytesWritten <= 0) {
          throw promotionIntegrity("archived_clip_copy_short_write");
        }
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    const after = await source.stat();
    if (
      !sameFile(after, sourceStat) ||
      hash.digest("hex") !== candidate.manifest.outSha256
    ) {
      throw promotionIntegrity("archived_clip_copy_integrity_mismatch");
    }
    await destination.sync();
  } finally {
    await Promise.all([source.close(), destination.close()]);
  }
  if (!(await candidatePathsUnchanged(candidate))) {
    throw promotionIntegrity("archived_clip_source_path_changed");
  }
}

async function writeExclusiveSynced(
  filePath: string,
  bytes: Buffer,
): Promise<void> {
  const handle = await fs.open(
    filePath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<{
  bytes: Buffer;
  stat: Awaited<ReturnType<typeof fs.lstat>>;
}> {
  const pathStat = await fs.lstat(filePath);
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.size > maxBytes
  ) {
    throw promotionIntegrity("archived_clip_manifest_invalid_file");
  }
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const openedStat = await handle.stat();
    if (!sameFile(openedStat, pathStat)) {
      throw promotionIntegrity("archived_clip_manifest_changed");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      throw promotionIntegrity("archived_clip_manifest_too_large");
    }
    return { bytes, stat: pathStat };
  } finally {
    await handle.close();
  }
}

async function hashRegularFile(
  filePath: string,
  expectedStat: Awaited<ReturnType<typeof fs.lstat>>,
): Promise<string> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!sameFile(before, expectedStat) || !before.isFile()) {
      throw promotionIntegrity("archived_clip_source_changed");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        offset,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (!sameFile(await handle.stat(), before)) {
      throw promotionIntegrity("archived_clip_source_changed");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function candidatePathsUnchanged(
  candidate: ValidatedCandidate,
): Promise<boolean> {
  try {
    const [clipStat, manifestStat] = await Promise.all([
      fs.lstat(candidate.clipPath),
      fs.lstat(candidate.manifestPath),
    ]);
    return (
      !clipStat.isSymbolicLink() &&
      !manifestStat.isSymbolicLink() &&
      sameFile(clipStat, candidate.clipStat) &&
      sameFile(manifestStat, candidate.manifestStat)
    );
  } catch {
    return false;
  }
}

async function regularFileHasSha256(
  filePath: string,
  expectedSha256: string,
): Promise<boolean> {
  if (!isSha256Hex(expectedSha256)) return false;
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    if ((await hashRegularFile(filePath, stat)) !== expectedSha256) {
      return false;
    }
    const after = await fs.lstat(filePath);
    return !after.isSymbolicLink() && after.isFile() && sameFile(after, stat);
  } catch {
    return false;
  }
}

async function regularFileEquals(
  filePath: string,
  expected: Buffer,
): Promise<boolean> {
  try {
    const read = await readBoundedRegularFile(filePath, MAX_MANIFEST_BYTES);
    return read.bytes.equals(expected);
  } catch {
    return false;
  }
}

function sameFile(
  left: Awaited<ReturnType<typeof fs.lstat>>,
  right: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function lstatOrNull(
  filePath: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function promotionRequest(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    400,
    `Replay premiere archived clip request rejected: ${operatorCode}`,
  );
}

function promotionIntegrity(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    `Replay premiere archived clip failed integrity validation: ${operatorCode}`,
  );
}
