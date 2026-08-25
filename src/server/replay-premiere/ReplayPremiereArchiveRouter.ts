import express, { type Request, type Response, type Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import englishTranslations from "../../../resources/lang/en.json";
import { matchProxyWarPublicPremiereReadPath } from "../agents/ProxyWarPublicArtifacts";
import type {
  PremiereArchivePointerV1,
  ReplayPremiereArchiveStore,
} from "./ReplayPremiereArchiveIndex";
import {
  archivedPremiereClipFileName,
  archivedPremiereClipManifestFileName,
  archivedPremiereClipRoute,
  archivedPremiereClipsDir,
  parsePremiereClipRenderManifest,
} from "./ReplayPremiereClips";
import { PREMIERE_CLIP_VERSION } from "./ReplayPremiereContracts";
import type { ReplayPremiereHttpRegistry } from "./ReplayPremiereHttp";
import { publicRunKeyForSourceRunId } from "./ReplayPremiereLoopCore";
import {
  escapeHtml,
  nonceInlineScripts,
  pageContentSecurityPolicyWithNonce,
} from "./ReplayPremierePublicPage";
import type { PremiereResultSummaryV1 } from "./ReplayPremiereResultSummary";

const JSON_DOCUMENT_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox";
const ARCHIVE_DATA_ELEMENT_ID = "proxywar-premiere-archive";
const MAX_ARCHIVED_CLIP_MANIFEST_BYTES = 64 * 1024;
const ARCHIVED_CLIP_HASH_BUFFER_BYTES = 64 * 1024;
/** Initial validation plus one independent settlement retry per published leaf. */
const MAX_ARCHIVED_CLIP_OPEN_ATTEMPTS = 3;
const PINNED_READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const PINNED_DIRECTORY_FLAGS = PINNED_READ_FLAGS | constants.O_DIRECTORY;

/** The archived page's downloadable-clip descriptor (stat-derived, no schema). */
export interface PremiereArchiveClientClip {
  /** Same-origin download route (`/premiere/<id>/clip.mp4`). */
  url: string;
  byteLength: number;
}

/** The exact JSON the archived premiere page hands the client to render. */
export interface PremiereArchiveClientPayload {
  schemaVersion: 1;
  premiereId: string;
  sourceRunId: string;
  sourceKind: PremiereResultSummaryV1["sourceKind"];
  terminalState: PremiereResultSummaryV1["terminalState"];
  revealedAt: string | null;
  /** The ordinary league replay run key to render behind the summary, or null. */
  replayRunKey: string | null;
  /**
   * Canonical generation target for a retained, renderable completed replay.
   * Capability flags remain the independent process-level emergency gate.
   */
  clipGenerationTarget: {
    kind: "league_run";
    replayRunKey: string;
  } | null;
  /**
   * The durable archived clip, when one was promoted at reclamation and still
   * exists on disk (retention-bounded). Availability is a stat of the artifact
   * — the durable summary schema is untouched.
   */
  clip: PremiereArchiveClientClip | null;
  summary: PremiereResultSummaryV1;
}

export interface ReplayPremiereArchiveRouterOptions {
  registry: Pick<ReplayPremiereHttpRegistry, "get">;
  archiveStore: ReplayPremiereArchiveStore;
  loadAppShell(): Promise<string>;
  publicOrigin: string;
  pageContentSecurityPolicy: string;
  /**
   * True only while the ordinary replay source is retained and renderable.
   * The result gates both playback and clip generation: an archive page must
   * never advertise a replay identity whose bytes have already aged out.
   */
  resolveClipGenerationTarget?: (replayRunKey: string) => Promise<boolean>;
  onOperatorError?: (error: unknown) => void;
}

/**
 * Serves revealed/terminal premieres whose live runtime has de-registered (e.g.
 * after a restart, or once the bulk was reclaimed). It MUST mount before the
 * premiere public-page router: for a still-registered premiere it defers to the
 * live path, and for an unknown id it defers so the live router returns the
 * fixed 404. It only ever serves ids present in the durable archive index, so a
 * pre-reveal premiere can never be exposed here.
 */
export function createReplayPremiereArchiveRouter(
  options: ReplayPremiereArchiveRouterOptions,
): Router {
  const router = express.Router();
  const publicOrigin = exactPublicOrigin(options.publicOrigin);
  if (
    typeof options.pageContentSecurityPolicy !== "string" ||
    options.pageContentSecurityPolicy.trim() === ""
  ) {
    throw new Error("Replay Premiere archive page CSP is required");
  }

  router.use((request, response, next) => {
    const route = matchProxyWarPublicPremiereReadPath(request.path);
    if (
      route === null ||
      (route.kind !== "page" &&
        route.kind !== "card" &&
        route.kind !== "archive_clip")
    ) {
      next();
      return;
    }
    // The durable-clip route is owned here TERMINALLY: no downstream premiere
    // router serves it, so every state (registered/live, unknown, failed,
    // missing artifact) is an identical fixed 404 and nothing falls through to
    // generic handling.
    if (route.kind === "archive_clip") {
      void handleArchivedClipRequest({
        request,
        response,
        route,
        options,
      }).catch((error: unknown) => {
        try {
          options.onOperatorError?.(error);
        } catch {
          // Operator diagnostics can never replace the fixed public response.
        }
        if (!response.headersSent) {
          sendFailure(response, 404);
        } else {
          response.destroy();
        }
      });
      return;
    }
    // Active/revealed runtimes are owned by the downstream public-page router.
    // Once a registered runtime is archived, however, its anonymous
    // interaction and Premiere-cache write surfaces are permanently fenced.
    // If a durable reveal-public pointer exists below, let this archive router
    // take ownership so the page can expose the canonical session-free
    // retained-run clip control instead of reopening the Premiere API.
    const registered = options.registry.get(route.premiereId);
    if (
      registered !== null &&
      registered.runtime.readLifecycleState() !== "archived"
    ) {
      next();
      return;
    }
    const pointer = options.archiveStore.lookup(route.premiereId);
    if (pointer === null) {
      // Unknown or still pre-reveal (never indexed): let the live router 404.
      next();
      return;
    }
    void handleArchivedDocumentRequest({
      request,
      response,
      route,
      pointer,
      options,
      publicOrigin,
    }).catch((error: unknown) => {
      try {
        options.onOperatorError?.(error);
      } catch {
        // Operator diagnostics can never replace the fixed public response.
      }
      if (!response.headersSent) {
        sendFailure(response, 503);
      } else {
        response.destroy();
      }
    });
  });
  return router;
}

/**
 * Serves `GET|HEAD /premiere/<id>/clip.mp4` — the ONE durable clip promoted at
 * reclamation. Fail-closed: anything but a reveal-public archived premiere
 * with an on-disk artifact is the same bare 404 (unknown id, still-registered
 * premiere, failed/cancelled terminal, evicted clip). Post-reveal-public, so
 * the mp4 itself is cacheable; the noindex robots header stays.
 */
async function handleArchivedClipRequest(context: {
  request: Request;
  response: Response;
  route: { premiereId: string };
  options: ReplayPremiereArchiveRouterOptions;
}): Promise<void> {
  const { request, response, route, options } = context;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendFailure(response, 405);
    return;
  }
  if (request.headers.range !== undefined) {
    sendFailure(response, 416);
    return;
  }
  const clip = await openValidatedArchivedClipFile(
    options.archiveStore,
    options.registry,
    route.premiereId,
  );
  if (clip === null) {
    sendFailure(response, 404);
    return;
  }
  try {
    setArchivedClipSuccessHeaders(response);
    response.status(200);
    response.setHeader("Content-Type", "video/mp4");
    response.setHeader("Content-Length", clip.byteLength);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${archivedPremiereClipFileName(route.premiereId)}"`,
    );
    if (request.method === "HEAD") {
      await clip.close();
      response.end();
      return;
    }
    pipePinnedArchivedClipFile(clip, response, () => {
      if (!response.headersSent) sendFailure(response, 404);
      else response.destroy();
    });
  } catch (error) {
    await clip.close();
    throw error;
  }
}

/**
 * Opens and authenticates the durable clip artifact, or null (=> 404).
 * Requires: not active/revealed-registered (an archived registration is safe),
 * archived pointer present, reveal-public (revealedAt non-null, terminal
 * revealed|archived), and a canonical manifest whose immutable source, output
 * size, and output hash match the same pinned MP4 descriptor returned to the
 * caller. No validated pathname is reopened.
 */
async function openValidatedArchivedClipFile(
  archiveStore: ReplayPremiereArchiveRouterOptions["archiveStore"],
  registry: ReplayPremiereArchiveRouterOptions["registry"],
  premiereId: string,
): Promise<PinnedArchivedClipFile | null> {
  for (
    let attempt = 0;
    attempt < MAX_ARCHIVED_CLIP_OPEN_ATTEMPTS;
    attempt += 1
  ) {
    const result = await openValidatedArchivedClipFileOnce(
      archiveStore,
      registry,
      premiereId,
    );
    if (result.state === "ready") return result.clip;
    if (result.state === "unavailable") return null;
  }
  return null;
}

type ArchivedClipOpenResult =
  | { state: "ready"; clip: PinnedArchivedClipFile }
  | { state: "promoter_hardlink_settled" }
  | { state: "unavailable" };

async function openValidatedArchivedClipFileOnce(
  archiveStore: ReplayPremiereArchiveRouterOptions["archiveStore"],
  registry: ReplayPremiereArchiveRouterOptions["registry"],
  premiereId: string,
): Promise<ArchivedClipOpenResult> {
  const registered = registry.get(premiereId);
  if (
    registered !== null &&
    registered.runtime.readLifecycleState() !== "archived"
  ) {
    return { state: "unavailable" };
  }
  const pointer = archiveStore.lookup(premiereId);
  if (
    pointer === null ||
    pointer.revealedAt === null ||
    (pointer.terminalState !== "revealed" &&
      pointer.terminalState !== "archived")
  ) {
    return { state: "unavailable" };
  }

  const archiveRootPath = archiveStore.archiveRoot;
  const clipsDirectoryPath = archivedPremiereClipsDir(archiveRootPath);
  const clipPath = path.join(
    clipsDirectoryPath,
    archivedPremiereClipFileName(premiereId),
  );
  const manifestPath = path.join(
    clipsDirectoryPath,
    archivedPremiereClipManifestFileName(premiereId),
  );
  let archiveRoot: PinnedDirectory | null = null;
  let clipsDirectory: PinnedDirectory | null = null;
  let clip: PinnedRegularFile | null = null;
  let manifest: PinnedRegularFile | null = null;
  let transferred = false;
  try {
    archiveRoot = await openPinnedDirectory(archiveRootPath);
    if (archiveRoot === null) return { state: "unavailable" };
    clipsDirectory = await openPinnedDirectory(clipsDirectoryPath, [
      archiveRoot,
    ]);
    if (clipsDirectory === null) return { state: "unavailable" };
    const [clipOpen, manifestOpen] = await Promise.all([
      openPinnedRegularFile(clipPath, [archiveRoot, clipsDirectory]),
      openPinnedRegularFile(manifestPath, [archiveRoot, clipsDirectory]),
    ]);
    if (clipOpen.state === "ready") clip = clipOpen.file;
    if (manifestOpen.state === "ready") manifest = manifestOpen.file;
    if (
      clipOpen.state === "unavailable" ||
      manifestOpen.state === "unavailable"
    ) {
      return { state: "unavailable" };
    }
    if (
      clipOpen.state === "promoter_hardlink_settled" ||
      manifestOpen.state === "promoter_hardlink_settled"
    ) {
      return { state: "promoter_hardlink_settled" };
    }
    if (clip === null || manifest === null) {
      return { state: "unavailable" };
    }
    if (
      clip.stat.size <= 0 ||
      manifest.stat.size <= 0 ||
      manifest.stat.size > MAX_ARCHIVED_CLIP_MANIFEST_BYTES
    ) {
      return { state: "unavailable" };
    }

    const [manifestBytes, clipDigest] = await Promise.all([
      manifest.fileHandle.readFile(),
      sha256FileHandle(clip.fileHandle),
    ]);
    if (
      manifestBytes.byteLength !== manifest.stat.size ||
      manifestBytes.byteLength > MAX_ARCHIVED_CLIP_MANIFEST_BYTES ||
      clipDigest.byteLength !== clip.stat.size
    ) {
      return { state: "unavailable" };
    }
    const renderManifest = parsePremiereClipRenderManifest(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    const originalPremiereProvenance =
      renderManifest?.premiereId === premiereId &&
      renderManifest.sourceReplaySha256 === pointer.sourceReplaySha256;
    const ratedCoworldRunProvenance =
      pointer.sourceKind === "rated_coworld" &&
      renderManifest?.premiereId ===
        publicRunKeyForSourceRunId(pointer.sourceRunId);
    if (
      renderManifest === null ||
      (!originalPremiereProvenance && !ratedCoworldRunProvenance) ||
      renderManifest.clipVersion !== PREMIERE_CLIP_VERSION ||
      renderManifest.outBytes !== clip.stat.size ||
      renderManifest.outBytes <= 0 ||
      renderManifest.outSha256 !== clipDigest.sha256
    ) {
      return { state: "unavailable" };
    }
    const [clipStability, manifestStability] = await Promise.all([
      pinnedRegularFileStability(clip),
      pinnedRegularFileStability(manifest),
    ]);
    if (
      clipStability === "unavailable" ||
      manifestStability === "unavailable"
    ) {
      return { state: "unavailable" };
    }
    if (
      clipStability === "promoter_hardlink_settled" ||
      manifestStability === "promoter_hardlink_settled"
    ) {
      return { state: "promoter_hardlink_settled" };
    }
    if (!isSameRevealPublicPointer(archiveStore.lookup(premiereId), pointer)) {
      return { state: "unavailable" };
    }

    const closeClip = closeFileHandlesOnce([clip.fileHandle]);
    const closeCompanions = closeFileHandlesOnce([
      manifest.fileHandle,
      clipsDirectory.fileHandle,
      archiveRoot.fileHandle,
    ]);
    const close = closeOperationsOnce([closeClip, closeCompanions]);
    transferred = true;
    return {
      state: "ready",
      clip: {
        fileHandle: clip.fileHandle,
        byteLength: clip.stat.size,
        close,
        closeAfterStream: closeCompanions,
      },
    };
  } catch {
    return { state: "unavailable" };
  } finally {
    if (!transferred) {
      await closeFileHandles([
        clip?.fileHandle,
        manifest?.fileHandle,
        clipsDirectory?.fileHandle,
        archiveRoot?.fileHandle,
      ]);
    }
  }
}

interface PinnedArchivedClipFile {
  fileHandle: FileHandle;
  byteLength: number;
  close(): Promise<void>;
  /** The FileHandle stream owns the MP4 descriptor after construction. */
  closeAfterStream(): Promise<void>;
}

interface PinnedDirectory {
  directoryPath: string;
  fileHandle: FileHandle;
  stat: Stats;
}

interface PinnedRegularFile {
  filePath: string;
  fileHandle: FileHandle;
  stat: Stats;
  pinnedDirectories: readonly PinnedDirectory[];
}

type PinnedRegularFileOpenResult =
  | { state: "ready"; file: PinnedRegularFile }
  | { state: "promoter_hardlink_settled" }
  | { state: "unavailable" };

type PinnedRegularFileStability =
  | "stable"
  | "promoter_hardlink_settled"
  | "unavailable";

async function openPinnedDirectory(
  directoryPath: string,
  pinnedAncestors: readonly PinnedDirectory[] = [],
): Promise<PinnedDirectory | null> {
  if (!(await pinnedDirectoriesAreStable(pinnedAncestors))) return null;
  let before: Stats;
  try {
    before = await fs.lstat(directoryPath);
  } catch {
    return null;
  }
  if (!before.isDirectory() || before.isSymbolicLink()) return null;

  let fileHandle: FileHandle | null = null;
  try {
    fileHandle = await fs.open(directoryPath, PINNED_DIRECTORY_FLAGS);
    const [opened, afterOpen, ancestorsStable] = await Promise.all([
      fileHandle.stat(),
      fs.lstat(directoryPath),
      pinnedDirectoriesAreStable(pinnedAncestors),
    ]);
    if (
      !ancestorsStable ||
      !sameStableDirectory(before, opened) ||
      !sameStableDirectory(opened, afterOpen)
    ) {
      await closeFileHandle(fileHandle);
      return null;
    }
    return { directoryPath, fileHandle, stat: opened };
  } catch {
    await closeFileHandle(fileHandle);
    return null;
  }
}

async function openPinnedRegularFile(
  filePath: string,
  pinnedDirectories: readonly PinnedDirectory[],
): Promise<PinnedRegularFileOpenResult> {
  if (!(await pinnedDirectoriesAreStable(pinnedDirectories))) {
    return { state: "unavailable" };
  }
  let before: Stats;
  try {
    before = await fs.lstat(filePath);
  } catch {
    return { state: "unavailable" };
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    return { state: "unavailable" };
  }

  let fileHandle: FileHandle | null = null;
  try {
    fileHandle = await fs.open(filePath, PINNED_READ_FLAGS);
    // These snapshots are direction-sensitive: only an observed 2 -> 1
    // transition can be a promoter temp-link settlement. Keep their reads
    // sequential so array position always matches observation order.
    const opened = await fileHandle.stat();
    const afterOpen = await fs.lstat(filePath);
    const directoriesStable =
      await pinnedDirectoriesAreStable(pinnedDirectories);
    const stability = regularFileSnapshotStability([before, opened, afterOpen]);
    if (!directoriesStable || stability !== "stable") {
      await closeFileHandle(fileHandle);
      return {
        state:
          directoriesStable && stability === "promoter_hardlink_settled"
            ? "promoter_hardlink_settled"
            : "unavailable",
      };
    }
    return {
      state: "ready",
      file: { filePath, fileHandle, stat: opened, pinnedDirectories },
    };
  } catch {
    await closeFileHandle(fileHandle);
    return { state: "unavailable" };
  }
}

async function pinnedRegularFileStability(
  pinned: PinnedRegularFile,
): Promise<PinnedRegularFileStability> {
  try {
    // Preserve temporal order for the same direction-sensitive classification
    // used while opening the leaf.
    const descriptorStat = await pinned.fileHandle.stat();
    const pathStat = await fs.lstat(pinned.filePath);
    const directoriesStable = await pinnedDirectoriesAreStable(
      pinned.pinnedDirectories,
    );
    return directoriesStable
      ? regularFileSnapshotStability([pinned.stat, descriptorStat, pathStat])
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function pinnedDirectoriesAreStable(
  directories: readonly PinnedDirectory[],
): Promise<boolean> {
  const results = await Promise.all(
    directories.map((directory) => pinnedDirectoryIsStable(directory)),
  );
  return results.every(Boolean);
}

async function pinnedDirectoryIsStable(
  pinned: PinnedDirectory,
): Promise<boolean> {
  try {
    const [descriptorStat, pathStat] = await Promise.all([
      pinned.fileHandle.stat(),
      fs.lstat(pinned.directoryPath),
    ]);
    return (
      sameStableDirectory(pinned.stat, descriptorStat) &&
      sameStableDirectory(descriptorStat, pathStat)
    );
  } catch {
    return false;
  }
}

function sameStableDirectory(left: Stats, right: Stats): boolean {
  return (
    left.isDirectory() &&
    !left.isSymbolicLink() &&
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function sameStableRegularFile(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    !left.isSymbolicLink() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function regularFileSnapshotStability(
  snapshots: readonly [Stats, Stats, Stats],
): PinnedRegularFileStability {
  let promoterHardlinkSettled = false;
  for (let index = 1; index < snapshots.length; index += 1) {
    const left = snapshots[index - 1];
    const right = snapshots[index];
    if (sameStableRegularFile(left, right)) continue;
    if (!isPromoterHardlinkSettlement(left, right)) return "unavailable";
    promoterHardlinkSettled = true;
  }
  return promoterHardlinkSettled ? "promoter_hardlink_settled" : "stable";
}

/**
 * The promoter publishes each final leaf with link(2), then removes its sole
 * temp hardlink. That changes nlink and ctime on the final inode during the
 * 2 -> 1 settlement. Classify exactly that forward transition so the caller
 * can close every descriptor and repeat the complete strict validation;
 * additions, replacements, and content/ownership changes remain terminal.
 */
function isPromoterHardlinkSettlement(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    !left.isSymbolicLink() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === 2 &&
    right.nlink === 1 &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    right.ctimeMs >= left.ctimeMs
  );
}

async function sha256FileHandle(
  fileHandle: FileHandle,
): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  const buffer = Buffer.allocUnsafe(ARCHIVED_CLIP_HASH_BUFFER_BYTES);
  for (;;) {
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      buffer.byteLength,
      byteLength,
    );
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    byteLength += bytesRead;
  }
  return { sha256: hash.digest("hex"), byteLength };
}

function isSameRevealPublicPointer(
  current: PremiereArchivePointerV1 | null,
  expected: PremiereArchivePointerV1,
): boolean {
  return (
    current !== null &&
    current.schemaVersion === expected.schemaVersion &&
    current.premiereId === expected.premiereId &&
    current.sourceRunId === expected.sourceRunId &&
    current.sourceKind === expected.sourceKind &&
    current.terminalState === expected.terminalState &&
    current.revealedAt === expected.revealedAt &&
    current.revealedAt !== null &&
    (current.terminalState === "revealed" ||
      current.terminalState === "archived") &&
    current.publicationCommitmentHash === expected.publicationCommitmentHash &&
    current.sourceReplaySha256 === expected.sourceReplaySha256 &&
    current.summaryHash === expected.summaryHash &&
    current.summaryRelPath === expected.summaryRelPath &&
    current.reclaimedAt === expected.reclaimedAt
  );
}

function closeFileHandlesOnce(
  fileHandles: readonly FileHandle[],
): () => Promise<void> {
  let closePromise: Promise<void> | null = null;
  return () => {
    closePromise ??= closeFileHandles(fileHandles);
    return closePromise;
  };
}

function closeOperationsOnce(
  operations: readonly (() => Promise<void>)[],
): () => Promise<void> {
  let closePromise: Promise<void> | null = null;
  return () => {
    closePromise ??= Promise.all(
      operations.map((operation) => operation()),
    ).then(() => undefined);
    return closePromise;
  };
}

async function closeFileHandles(
  fileHandles: readonly (FileHandle | null | undefined)[],
): Promise<void> {
  await Promise.all(
    fileHandles.map((fileHandle) => closeFileHandle(fileHandle)),
  );
}

async function closeFileHandle(
  fileHandle: FileHandle | null | undefined,
): Promise<void> {
  await fileHandle?.close().catch(() => undefined);
}

/** Stream the authenticated MP4 descriptor; never reopen its pathname. */
function pipePinnedArchivedClipFile(
  clip: PinnedArchivedClipFile,
  response: Response,
  onStreamError: () => void,
): void {
  const stream = clip.fileHandle.createReadStream({
    autoClose: true,
    start: 0,
  });
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    stream.destroy();
    void clip.closeAfterStream();
  };
  response.once("finish", finalize);
  response.once("close", finalize);
  stream.once("error", () => {
    finalize();
    onStreamError();
  });
  try {
    stream.pipe(response);
  } catch {
    finalize();
    onStreamError();
  }
}

function setArchivedClipSuccessHeaders(response: Response): void {
  // Public post-reveal artifact: cacheable (unlike premiere pages/cache clips).
  response.setHeader("Cache-Control", "public, max-age=3600");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox",
  );
}

async function handleArchivedDocumentRequest(context: {
  request: Request;
  response: Response;
  route: { kind: "page" | "card"; premiereId: string };
  pointer: PremiereArchivePointerV1;
  options: ReplayPremiereArchiveRouterOptions;
  publicOrigin: string;
}): Promise<void> {
  const { request, response, route, pointer, options } = context;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendFailure(response, 405);
    return;
  }
  if (request.headers.range !== undefined) {
    sendFailure(response, 416);
    return;
  }
  // Card/asset routes for an archived premiere behave sanely: a bare 404,
  // indistinguishable from a nonexistent card.
  if (route.kind === "card") {
    sendFailure(response, 404);
    return;
  }
  const summary = await options.archiveStore.loadSummary(route.premiereId);
  if (summary === null || summary.premiereId !== pointer.premiereId) {
    sendFailure(response, 404);
    return;
  }
  const clip = await openValidatedArchivedClipFile(
    options.archiveStore,
    options.registry,
    route.premiereId,
  );
  const clipByteLength = clip?.byteLength ?? null;
  await clip?.close();
  const candidateReplayRunKey =
    summary.sourceKind === "rated_coworld"
      ? publicRunKeyForSourceRunId(summary.sourceRunId)
      : null;
  const isRevealPublic =
    summary.revealedAt !== null &&
    (summary.terminalState === "revealed" ||
      summary.terminalState === "archived");
  // A source-derived run key is only an identity candidate. Exposing it to the
  // browser is a playback promise, so require a current retained/renderable
  // source check. Without that proof the durable result summary remains the
  // page's honest terminal presentation and Main never starts the replay
  // loader that would otherwise end on the generic failure veil.
  const replayRunKey =
    candidateReplayRunKey !== null &&
    isRevealPublic &&
    options.resolveClipGenerationTarget !== undefined &&
    (await options
      .resolveClipGenerationTarget(candidateReplayRunKey)
      .catch(() => false))
      ? candidateReplayRunKey
      : null;
  const clipGenerationTarget =
    replayRunKey !== null
      ? { kind: "league_run" as const, replayRunKey }
      : null;
  const payload: PremiereArchiveClientPayload = {
    schemaVersion: 1,
    premiereId: summary.premiereId,
    sourceRunId: summary.sourceRunId,
    sourceKind: summary.sourceKind,
    terminalState: summary.terminalState,
    revealedAt: summary.revealedAt,
    replayRunKey,
    clipGenerationTarget,
    clip:
      clipByteLength === null
        ? null
        : {
            url: archivedPremiereClipRoute(summary.premiereId),
            byteLength: clipByteLength,
          },
    summary,
  };
  const shell = await options.loadAppShell();
  const scriptNonce = randomBytes(24).toString("base64");
  const html = renderReplayPremiereArchivePageHtml({
    appShell: shell,
    payload,
    publicOrigin: context.publicOrigin,
    scriptNonce,
  });
  sendDocument(response, request.method, 200, html, {
    contentType: "text/html; charset=utf-8",
    contentSecurityPolicy: pageContentSecurityPolicyWithNonce(
      options.pageContentSecurityPolicy,
      scriptNonce,
    ),
  });
}

export function renderReplayPremiereArchivePageHtml(options: {
  appShell: string;
  payload: PremiereArchiveClientPayload;
  publicOrigin: string;
  scriptNonce: string;
}): string {
  if (!/<head(?:\s[^>]*)?>/i.test(options.appShell)) {
    throw new Error("Replay Premiere archive app shell has no head element");
  }
  const origin = exactPublicOrigin(options.publicOrigin);
  const canonicalUrl = new URL(
    `/premiere/${options.payload.premiereId}`,
    origin,
  ).href;
  // Reveal-public archives get a real social card again (the same URL that
  // unfurled with a card during the premiere). Winner/standings language reaches
  // meta ONLY when the summary carries an outcome — which, by construction, only
  // a post-reveal (revealed/archived) summary ever does; failed/cancelled and
  // archived-without-reveal stay neutral. Deliberately no og:image: the card
  // image route intentionally 404s, so this is a text-only card.
  const meta = archivedSocialMetadata(options.payload.summary);
  // `<` is escaped inside the JSON island so it can never break out of the
  // non-executing data block; the client reads it by element id.
  const dataJson = JSON.stringify(options.payload).replaceAll("<", "\\u003c");
  const injected = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}">`,
    `<meta name="proxywar:premiere_archived" content="1">`,
    `<meta name="proxywar:premiere_id" content="${escapeHtml(options.payload.premiereId)}">`,
    `<script type="application/json" id="${ARCHIVE_DATA_ELEMENT_ID}">${dataJson}</script>`,
  ].join("\n");
  // Strip the app shell's generic site card first so exactly one set of social
  // tags survives (mirrors the live premiere page).
  const withoutShellSocial = stripShellSocialMetadata(options.appShell);
  const withInjection = withoutShellSocial.replace(
    /<head(?:\s[^>]*)?>/i,
    (head) => `${head}\n${injected}`,
  );
  return nonceInlineScripts(withInjection, options.scriptNonce);
}

/**
 * Builds the archived page's title + description from the durable summary.
 *
 * SPOILER GATE: an outcome is present only on a reveal-public summary
 * (validateSummaryPreimage rejects an outcome on failed/cancelled, and the
 * archive index never holds a pre-reveal id), so winner/standings language is
 * emitted only when `summary.outcome !== null`. Failed/cancelled/archived-
 * without-reveal fall through to a neutral, outcome-free card.
 */
function archivedSocialMetadata(summary: PremiereResultSummaryV1): {
  title: string;
  description: string;
} {
  const outcome = summary.outcome;
  if (outcome === null) {
    return {
      title: translateText("replay_premiere.archived_meta_ended_title"),
      description: translateText(
        "replay_premiere.archived_meta_ended_description",
      ),
    };
  }
  const wonStandings = outcome.standings.filter((standing) => standing.won);
  const soleWinner = wonStandings.length === 1 ? wonStandings[0] : null;
  const title =
    soleWinner === null
      ? translateText("replay_premiere.archived_meta_results_title")
      : interpolate(
          translateText("replay_premiere.archived_meta_winner_title"),
          { name: soleWinner.displayName },
        );
  const revealedDate = (summary.revealedAt ?? outcome.completedAt).slice(0, 10);
  let description = interpolate(
    translateText("replay_premiere.archived_meta_description"),
    {
      agents: String(outcome.standings.length),
      turns: String(outcome.turnCount),
      date: revealedDate,
    },
  );
  if (typeof summary.mapLabel === "string" && summary.mapLabel.length > 0) {
    description += ` · ${summary.mapLabel}`;
  }
  return { title, description };
}

type ReplayPremiereTranslationSuffix =
  keyof typeof englishTranslations.replay_premiere;
type ReplayPremiereTranslationKey =
  `replay_premiere.${ReplayPremiereTranslationSuffix}`;

function translateText(key: ReplayPremiereTranslationKey): string {
  const suffix = key.slice(
    "replay_premiere.".length,
  ) as ReplayPremiereTranslationSuffix;
  return englishTranslations.replay_premiere[suffix];
}

function interpolate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key] : match,
  );
}

// Mirrors the live premiere page: drops the shell's <title>, canonical link, and
// every description/og:/twitter:/proxywar: tag so the archived injection owns the
// page's social metadata outright.
function stripShellSocialMetadata(appShell: string): string {
  return appShell
    .replace(/<title(?:\s[^>]*)?>[\s\S]*?<\/title>/gi, "")
    .replace(/<(?:meta|link)\b[^>]*>/gi, (tag) => {
      const rel = tagAttribute(tag, "rel")?.toLocaleLowerCase("en-US");
      if (rel?.split(/\s+/).includes("canonical") === true) return "";
      const identity = (
        tagAttribute(tag, "name") ?? tagAttribute(tag, "property")
      )?.toLocaleLowerCase("en-US");
      if (
        identity === "description" ||
        identity?.startsWith("og:") === true ||
        identity?.startsWith("twitter:") === true ||
        identity?.startsWith("proxywar:") === true
      ) {
        return "";
      }
      return tag;
    });
}

function tagAttribute(tag: string, name: string): string | null {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function sendDocument(
  response: Response,
  method: string,
  status: number,
  body: string,
  options: { contentType: string; contentSecurityPolicy: string },
): void {
  setArchiveDocumentHeaders(response, options.contentSecurityPolicy);
  response.status(status);
  response.setHeader("Content-Type", options.contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(method === "HEAD" ? undefined : body);
}

function sendFailure(response: Response, status: number): void {
  const body = JSON.stringify({ error: { code: "PREMIERE_UNAVAILABLE" } });
  setArchiveDocumentHeaders(response, JSON_DOCUMENT_CSP);
  response.status(status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(response.req.method === "HEAD" ? undefined : body);
}

function setArchiveDocumentHeaders(
  response: Response,
  contentSecurityPolicy: string,
): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("CDN-Cache-Control", "no-store");
  response.setHeader("Surrogate-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
  response.setHeader("Vary", "Origin, Cookie");
  response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader("Referrer-Policy", "same-origin");
  response.removeHeader("ETag");
}

function exactPublicOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("Replay Premiere archive public origin is invalid");
  }
  return parsed.origin;
}
