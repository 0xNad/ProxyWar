import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, gunzipSync, gzipSync } from "node:zlib";
import { gameRecordFileIsRenderable } from "./AgentSpectatorReplay";
import {
  isSafeCoworldEpisodeRequestId,
  parseHostedReplayPayload,
  type ParsedHostedReplay,
} from "./CoworldLeagueMirrorCore";
import type { CoworldLeagueEpisodeRow } from "./CoworldLeagueSiteWriter";
import { withFileMutex } from "./FileMutex";

const managedRunPattern = /^league-coworld-[A-Za-z0-9-]+$/;
const managedReplayPattern = /^ereq_[A-Za-z0-9_-]+\.replay$/;

/**
 * Resolves the durable, indefinitely-retained compact-evidence archive
 * directory (`docs/COWORLD_LEAGUE_MIRROR.md`'s "indefinite compact
 * evidence") from the SAME `artifactsRoot` every other league-mirror
 * consumer already resolves from (`ai-agent-demo-server.ts`'s
 * `artifactsRootDir`, `FeaturedMatchRetentionPin.ts`'s own
 * `options.artifactsRoot`) — one canonical derivation, reused everywhere a
 * fallback lookup needs it, instead of re-deriving
 * `.../coworld-league-mirror/summaries` inline at each call site. Mirrors
 * `coworld-league-mirror.ts`'s own `--summary-archive`/env default exactly.
 */
export function resolveCoworldLeagueSummaryArchiveDir(
  artifactsRoot: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  const configured = environment.PROXYWAR_LEAGUE_SUMMARY_ARCHIVE_DIR?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : path.join(artifactsRoot, "coworld-league-mirror", "summaries");
}

export interface CoworldLeagueRetentionReferences {
  episodeRequestIds: Set<string>;
  publicRunKeys: Set<string>;
  publicRunKeyByEpisodeRequestId: Map<string, string>;
}

export interface CoworldLeagueArtifactRetentionOptions {
  cacheDir: string;
  runsRootDir: string;
  summaryArchiveDir: string;
  protectedEpisodeRequestIds: ReadonlySet<string>;
  protectedPublicRunKeys: ReadonlySet<string>;
  maxRetainedCacheFiles: number;
  maxRetainedRunDirectories: number;
  dryRun?: boolean;
}

export interface CoworldLeagueArtifactRetentionResult {
  cacheFilesFound: number;
  cacheFilesPruned: number;
  cacheFileCandidates: string[];
  runDirectoriesFound: number;
  runDirectoriesPruned: number;
  runDirectoryCandidates: string[];
}

export class CoworldLeagueDiskReserveError extends Error {}

interface ManagedEntry {
  name: string;
  modifiedAtMs: number;
  semanticTimestampMs: number | null;
}

interface ArchivePlan {
  targetName: string;
  materialize: () => Promise<Buffer>;
}

interface StagedArchive {
  finalPath: string;
  temporaryPath: string;
}

interface JsonObject {
  [key: string]: unknown;
}

export interface CoworldLeagueRetentionPin {
  episodeRequestId: string;
  publicRunKey: string;
  reason: string;
}

export interface CoworldLeagueRetentionPinManifest {
  schemaVersion: 1;
  pins: CoworldLeagueRetentionPin[];
}

export function publicRunKeyFromFullRenderHref(
  fullRenderHref: string | null,
): string | null {
  const prefix = "/ai-league-replay/";
  if (fullRenderHref === null || !fullRenderHref.startsWith(prefix)) {
    return null;
  }
  const encodedRunKey = fullRenderHref.slice(prefix.length);
  if (encodedRunKey.length === 0 || encodedRunKey.includes("/")) {
    return null;
  }
  try {
    const runKey = decodeURIComponent(encodedRunKey);
    return managedRunPattern.test(runKey) &&
      !runKey.includes("/") &&
      !runKey.includes("\\")
      ? runKey
      : null;
  } catch {
    return null;
  }
}

export function publicRunKeyFromWatchHref(
  watchHref: string | null,
): string | null {
  const prefix = "/ai-league-runs/";
  const suffix = "/spectator.html";
  if (
    watchHref === null ||
    !watchHref.startsWith(prefix) ||
    !watchHref.endsWith(suffix)
  ) {
    return null;
  }
  const encodedRunKey = watchHref.slice(prefix.length, -suffix.length);
  if (encodedRunKey.length === 0 || encodedRunKey.includes("/")) {
    return null;
  }
  try {
    const runKey = decodeURIComponent(encodedRunKey);
    return managedRunPattern.test(runKey) &&
      !runKey.includes("/") &&
      !runKey.includes("\\")
      ? runKey
      : null;
  } catch {
    return null;
  }
}

export function retentionReferencesFromEpisodes(
  episodes: CoworldLeagueEpisodeRow[],
): CoworldLeagueRetentionReferences {
  const episodeRequestIds = new Set<string>();
  const publicRunKeys = new Set<string>();
  const publicRunKeyByEpisodeRequestId = new Map<string, string>();
  for (const episode of episodes) {
    if (!isSafeCoworldEpisodeRequestId(episode.episodeRequestId)) {
      throw new Error(
        `Unsafe Coworld episode request id: ${episode.episodeRequestId}`,
      );
    }
    episodeRequestIds.add(episode.episodeRequestId);
    const fullRenderRunKey = publicRunKeyFromFullRenderHref(
      episode.fullRenderHref,
    );
    const watchRunKey = publicRunKeyFromWatchHref(episode.watchHref);
    if (episode.fullRenderHref !== null && fullRenderRunKey === null) {
      throw new Error(
        `Unsafe Coworld full-render href: ${episode.fullRenderHref}`,
      );
    }
    if (episode.watchHref !== null && watchRunKey === null) {
      throw new Error(`Unsafe Coworld watch href: ${episode.watchHref}`);
    }
    if (
      fullRenderRunKey !== null &&
      watchRunKey !== null &&
      fullRenderRunKey !== watchRunKey
    ) {
      throw new Error("Coworld replay hrefs reference different run bundles");
    }
    for (const runKey of [fullRenderRunKey, watchRunKey]) {
      if (runKey !== null) {
        publicRunKeys.add(runKey);
        publicRunKeyByEpisodeRequestId.set(episode.episodeRequestId, runKey);
      }
    }
  }
  return {
    episodeRequestIds,
    publicRunKeys,
    publicRunKeyByEpisodeRequestId,
  };
}

const MAX_ARCHIVED_REPLAY_SUMMARY_BYTES = 1024 * 1024; // compact JSON, generously bounded (compressed, pre-decompression stat check)
// Decompressed-size guard for the SAME read — a small compressed file can
// still gzip-bomb-expand to something huge, so the compressed-size check
// above alone is not a real bound on memory. `gunzipSync`'s own native
// `maxOutputLength` (Node's built-in zlib option, not a new abstraction)
// makes the decompress call itself throw once output would exceed this —
// caught by the existing try/catch below exactly like any other corrupt
// archive, and returns the same honest `null`.
const MAX_ARCHIVED_REPLAY_SUMMARY_DECOMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_REPLAY_BYTES = 64 * 1024 * 1024;

function archivedReplaySummaryPath(
  summaryArchiveDir: string,
  episodeRequestId: string,
): string | null {
  if (!isSafeCoworldEpisodeRequestId(episodeRequestId)) return null;
  const resolvedDir = path.resolve(summaryArchiveDir);
  const archivePath = path.resolve(
    resolvedDir,
    `${episodeRequestId}.replay-summary.json.gz`,
  );
  return path.dirname(archivePath) === resolvedDir ? archivePath : null;
}

/**
 * Full-replay-retention fix (2026-08-06): `publicFeaturedMatches()`/
 * `findLeagueEpisodeReplayInfo()` (and, transitively,
 * `FeaturedMatchRetentionPin.ts`'s own `computeFeaturedMatchPinAddOperation`)
 * only ever look an episode up in the LIVE mirror's `episodes[]` — a
 * rolling window bounded by the mirror sync's own `--meta-limit`
 * (observed in production: as narrow as ~30 minutes), far tighter than
 * the 24-raw/96-bundle on-disk retention `pruneCoworldLeagueMirrorArtifacts`
 * actually enforces, and narrower still once the raw `.replay` cache file
 * itself has been pruned. Once an episode rotates out of that live
 * window, every one of those callers permanently treats it as "not
 * mirrored" even while the pruner's own byte-faithful archive (written
 * BEFORE deletion — see `archivePlans`/`writeArchivePlans` above) still
 * durably, indefinitely proves which run it was.
 *
 * This is the ONE bounded, O(1), directly-addressable lookup every such
 * caller shares: `<episodeRequestId>.replay-summary.json.gz` is named
 * EXACTLY by the known `episodeRequestId` (no directory scan, ever), and
 * its `runID` field — preserved verbatim by `compactReplayArchive` above —
 * deterministically reproduces the SAME `publicRunKey = "league-" +
 * runID` `coworld-league-mirror.ts`'s own `unpackEpisodeRunDir` derives
 * live. `null` for absolutely any reason short of "a well-formed archived
 * record naming a syntactically valid run key" — no archive, an
 * oversized/corrupt/malformed gzip, or a `runID` that doesn't survive
 * `managedRunPattern` — is treated identically: honest "no durable
 * evidence", never a fabricated or partially-trusted key. Never throws.
 */
export async function resolveArchivedPublicRunKey(
  summaryArchiveDir: string,
  episodeRequestId: string,
): Promise<string | null> {
  return (
    (
      await readArchivedCoworldReplaySummary(
        summaryArchiveDir,
        episodeRequestId,
      )
    )?.publicRunKey ?? null
  );
}

/**
 * Bounded reader for the indefinitely retained compact replay summary.
 *
 * The filename alone is not evidence that the archive belongs to the requested
 * episode, so the embedded `episodeRequestId` must match exactly. The retained
 * replay projection is then passed through the same hosted-replay parser used
 * by the live mirror; this keeps run-id validation and result projection on one
 * canonical path. Any missing, oversized, corrupt, mismatched, or unsafe input
 * resolves to `null` and never escapes as a partially trusted replay row.
 */
export interface ArchivedCoworldReplaySummary {
  readonly publicRunKey: string;
  readonly replay: ParsedHostedReplay;
}

/**
 * Bounded exact lookup for a replay that has left the live episode window but
 * has not yet become a pruning candidate (and therefore has no compact archive
 * yet). The mirror itself names this file from the validated episode request
 * id; its payload still has to pass the canonical hosted-replay parser.
 */
export async function readRetainedCoworldReplay(
  cacheDir: string,
  episodeRequestId: string,
): Promise<ArchivedCoworldReplaySummary | null> {
  if (!isSafeCoworldEpisodeRequestId(episodeRequestId)) return null;
  const replayPath = coworldLeagueReplayCachePath(cacheDir, episodeRequestId);
  try {
    const stat = await fs.lstat(replayPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_RETAINED_REPLAY_BYTES
    ) {
      return null;
    }
    const parsed: unknown = JSON.parse(await fs.readFile(replayPath, "utf8"));
    const replay = parseHostedReplayPayload(parsed);
    if (replay === null) return null;
    const publicRunKey = `league-${replay.runID}`;
    return managedRunPattern.test(publicRunKey)
      ? { publicRunKey, replay }
      : null;
  } catch {
    return null;
  }
}

export async function readArchivedCoworldReplaySummary(
  summaryArchiveDir: string,
  episodeRequestId: string,
): Promise<ArchivedCoworldReplaySummary | null> {
  const archivePath = archivedReplaySummaryPath(
    summaryArchiveDir,
    episodeRequestId,
  );
  if (archivePath === null) return null;
  let stat;
  try {
    stat = await fs.lstat(archivePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_ARCHIVED_REPLAY_SUMMARY_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      gunzipSync(await fs.readFile(archivePath), {
        maxOutputLength: MAX_ARCHIVED_REPLAY_SUMMARY_DECOMPRESSED_BYTES,
      }).toString("utf8"),
    );
  } catch {
    return null;
  }
  if (!isJsonObject(parsed) || parsed.episodeRequestId !== episodeRequestId) {
    return null;
  }
  const replay = parseHostedReplayPayload(parsed);
  if (replay === null) return null;
  const publicRunKey = `league-${replay.runID}`;
  return managedRunPattern.test(publicRunKey) ? { publicRunKey, replay } : null;
}

/**
 * The archive-backed counterpart of `PublicFeaturedMatch.watchHref`/
 * `.fullRenderHref` (see that field's own doc) — same honest-null
 * contract, sourced from durable evidence instead of the live mirror
 * window. `watchHref` is ALWAYS `null` here: the lightweight spectator
 * bundle (`spectator.html`/`spectator-replay.json`/`decisions.jsonl`,
 * `docs/COWORLD_LEAGUE_MIRROR.md`'s own list) is never archived — only
 * `match-summary.json`/`game-record.json`/`spectator-telemetry.json` are
 * (`archivePlans` above) — reconstructing it would mean REGENERATING
 * spectator artifacts, not restoring them, which this fix does not do.
 * `fullRenderHref` is populated ONLY when the exact active game record or its
 * `<publicRunKey>.game-record.json.gz` archive exists — the files
 * `/ai-league-replay/:runID`'s own renderability gate actually needs (see
 * `restoreArchivedGameRecord` below) — never a link the server can't back.
 */
export interface CoworldLeagueArchivedReplayHrefs {
  readonly watchHref: null;
  readonly fullRenderHref: string | null;
}

export async function resolveArchivedEpisodeReplayHrefs(
  summaryArchiveDir: string,
  episodeRequestId: string,
  activeRunsRootDir?: string,
): Promise<CoworldLeagueArchivedReplayHrefs | null> {
  const archivedSummary = await readArchivedCoworldReplaySummary(
    summaryArchiveDir,
    episodeRequestId,
  );
  if (archivedSummary === null) return null;
  const { publicRunKey } = archivedSummary;
  const gameRecordArchivePath = archivedGameRecordArchivePath(
    summaryArchiveDir,
    publicRunKey,
  );
  let hasGameRecord = false;
  if (gameRecordArchivePath !== null) {
    try {
      hasGameRecord = (await fs.lstat(gameRecordArchivePath)).isFile();
    } catch {
      hasGameRecord = false;
    }
  }
  // A summary is archived before the heavier run bundle is pruned. During
  // that interval the byte-faithful game record is still served directly from
  // the active run directory, so it is equally valid evidence for the link.
  if (!hasGameRecord && activeRunsRootDir !== undefined) {
    hasGameRecord = await gameRecordFileIsRenderable(
      path.join(activeRunsRootDir, publicRunKey, "game-record.json"),
    );
  }
  return {
    watchHref: null,
    fullRenderHref: hasGameRecord
      ? `/ai-league-replay/${encodeURIComponent(publicRunKey)}`
      : null,
  };
}

export function parseCoworldLeagueRetentionPins(
  value: unknown,
  source = "Coworld league retention pin manifest",
): CoworldLeagueRetentionReferences {
  if (!isJsonObject(value)) {
    throw new Error(`${source} must be a JSON object`);
  }
  requireExactKeys(value, ["pins", "schemaVersion"], source);
  if (value.schemaVersion !== 1) {
    throw new Error(`${source} schemaVersion must be 1`);
  }
  if (!Array.isArray(value.pins)) {
    throw new Error(`${source} pins must be an array`);
  }

  const episodeRequestIds = new Set<string>();
  const publicRunKeys = new Set<string>();
  const publicRunKeyByEpisodeRequestId = new Map<string, string>();
  for (const [index, candidate] of value.pins.entries()) {
    const pinSource = `${source} pins[${index}]`;
    if (!isJsonObject(candidate)) {
      throw new Error(`${pinSource} must be a JSON object`);
    }
    requireExactKeys(
      candidate,
      ["episodeRequestId", "publicRunKey", "reason"],
      pinSource,
    );
    if (
      typeof candidate.episodeRequestId !== "string" ||
      !isSafeCoworldEpisodeRequestId(candidate.episodeRequestId)
    ) {
      throw new Error(`${pinSource} has an unsafe episodeRequestId`);
    }
    if (
      typeof candidate.publicRunKey !== "string" ||
      !managedRunPattern.test(candidate.publicRunKey) ||
      candidate.publicRunKey.includes("/") ||
      candidate.publicRunKey.includes("\\")
    ) {
      throw new Error(`${pinSource} has an unsafe publicRunKey`);
    }
    if (
      typeof candidate.reason !== "string" ||
      candidate.reason.trim().length === 0
    ) {
      throw new Error(`${pinSource} reason must be a non-empty string`);
    }
    if (episodeRequestIds.has(candidate.episodeRequestId)) {
      throw new Error(`${pinSource} duplicates an episodeRequestId`);
    }
    if (publicRunKeys.has(candidate.publicRunKey)) {
      throw new Error(`${pinSource} duplicates a publicRunKey`);
    }
    episodeRequestIds.add(candidate.episodeRequestId);
    publicRunKeys.add(candidate.publicRunKey);
    publicRunKeyByEpisodeRequestId.set(
      candidate.episodeRequestId,
      candidate.publicRunKey,
    );
  }
  return {
    episodeRequestIds,
    publicRunKeys,
    publicRunKeyByEpisodeRequestId,
  };
}

export async function readCoworldLeagueRetentionPins(
  pinManifestPath: string,
): Promise<CoworldLeagueRetentionReferences> {
  const contents = await fs.readFile(pinManifestPath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Coworld league retention pin manifest is not valid JSON: ${pinManifestPath}`,
      { cause: error },
    );
  }
  return parseCoworldLeagueRetentionPins(value, pinManifestPath);
}

/**
 * Raw manifest read (preserves the `pins[]` array with its `reason` field,
 * unlike {@link readCoworldLeagueRetentionPins}'s Set-based projection) for
 * a read-modify-write cycle. ENOENT-tolerant — a pin manifest that has
 * never been written yet is a normal cold start, not an error. Same
 * behavior `replay-premiere-loop.ts`'s own (private, unexported)
 * `readPinManifest` has always had; exported here so a second writer
 * (`FeaturedMatchRetentionPin.ts`) can share the exact same manifest
 * format/file without a parallel pinning system, per the product-overhaul
 * Stage 3 item 7 retention-pins requirement. `replay-premiere-loop.ts`
 * itself is deliberately left using its own local copy rather than
 * refactored to call this — it is a live, continuously-running critical
 * loop, and swapping its internals for a decoupling-only refactor carries
 * real risk for zero behavior change.
 */
export async function readCoworldLeagueRetentionPinManifest(
  pinManifestPath: string,
): Promise<CoworldLeagueRetentionPinManifest> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(pinManifestPath, "utf8"));
    if (
      isJsonObject(raw) &&
      raw.schemaVersion === 1 &&
      Array.isArray(raw.pins)
    ) {
      // Full validation (safe ids, no cross-pin duplicates, exact keys) —
      // matches writePinManifest's own "fail closed" discipline: a manifest
      // this reader can't validate is a loud failure, not a silent partial
      // read, since a malformed pin list breaks the mirror's own read on
      // the next sync tick regardless of who wrote it.
      parseCoworldLeagueRetentionPins(raw, pinManifestPath);
      return raw as unknown as CoworldLeagueRetentionPinManifest;
    }
    throw new Error(`retention pin manifest is malformed: ${pinManifestPath}`);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { schemaVersion: 1, pins: [] };
    }
    throw error;
  }
}

/** Atomic temp+rename write, validated before write — same discipline as `replay-premiere-loop.ts`'s own local `writePinManifest`. */
export async function writeCoworldLeagueRetentionPinManifest(
  pinManifestPath: string,
  manifest: CoworldLeagueRetentionPinManifest,
): Promise<void> {
  parseCoworldLeagueRetentionPins(manifest, pinManifestPath);
  await fs.mkdir(path.dirname(pinManifestPath), { recursive: true });
  const temporaryPath = `${pinManifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await fs.rename(temporaryPath, pinManifestPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

type PinOwnerOperation =
  | {
      type: "add";
      episodeRequestId: string;
      publicRunKey: string;
      ownerTag: string;
    }
  | { type: "remove"; episodeRequestId: string; ownerTag: string };

/** Pure: applies ONE add/remove operation to an in-memory pins array. No I/O — the caller owns locking/read/write around a whole batch. */
function applyPinOwnerOperation(
  pins: readonly CoworldLeagueRetentionPin[],
  operation: PinOwnerOperation,
): { pins: CoworldLeagueRetentionPin[]; changed: boolean } {
  const existingIndex = pins.findIndex(
    (pin) => pin.episodeRequestId === operation.episodeRequestId,
  );
  if (operation.type === "add") {
    if (existingIndex === -1) {
      return {
        pins: [
          ...pins,
          {
            episodeRequestId: operation.episodeRequestId,
            publicRunKey: operation.publicRunKey,
            reason: operation.ownerTag,
          },
        ],
        changed: true,
      };
    }
    const existing = pins[existingIndex];
    const owners = existing.reason.split(";").map((tag) => tag.trim());
    if (owners.includes(operation.ownerTag)) {
      return { pins: pins.slice(), changed: false };
    }
    const nextPins = pins.slice();
    nextPins[existingIndex] = {
      ...existing,
      reason: [...owners, operation.ownerTag].join(";"),
    };
    return { pins: nextPins, changed: true };
  }
  // remove
  if (existingIndex === -1) return { pins: pins.slice(), changed: false };
  const existing = pins[existingIndex];
  const owners = existing.reason
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (!owners.includes(operation.ownerTag)) {
    return { pins: pins.slice(), changed: false };
  }
  const remainingOwners = owners.filter((tag) => tag !== operation.ownerTag);
  const nextPins = pins.slice();
  if (remainingOwners.length === 0) {
    nextPins.splice(existingIndex, 1);
  } else {
    nextPins[existingIndex] = {
      ...existing,
      reason: remainingOwners.join(";"),
    };
  }
  return { pins: nextPins, changed: true };
}

/**
 * Applies MULTIPLE owner-tag operations to the manifest in ONE locked
 * read-modify-write — the fix for a real bug this session's own review
 * caught: a reconcile pass touching several `FeaturedMatch` records used
 * to fire one independent `addRetentionPinOwner` call per record via
 * `Promise.all`, each doing its OWN read+write against the SAME manifest
 * file — concurrent callers could each read the pre-mutation state and the
 * LATER write would silently discard the EARLIER one's change (a lost
 * update), even though each individual write was itself atomic. Locked via
 * `withFileMutex` (`FileMutex.ts`) keyed on the manifest path — this also
 * closes the same race for the single-operation functions below, and for
 * the OTHER writer (`replay-premiere-loop.ts`'s `pinHoldArtifacts`/
 * `unpinHoldArtifacts`) if it runs concurrently with either.
 */
export async function applyRetentionPinOwnerBatch(
  pinManifestPath: string,
  operations: readonly PinOwnerOperation[],
): Promise<boolean> {
  if (operations.length === 0) return false;
  return withFileMutex(pinManifestPath, async () => {
    const manifest =
      await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    let pins = manifest.pins;
    let changed = false;
    for (const operation of operations) {
      const applied = applyPinOwnerOperation(pins, operation);
      pins = applied.pins;
      changed = changed || applied.changed;
    }
    if (!changed) return false;
    await writeCoworldLeagueRetentionPinManifest(pinManifestPath, {
      schemaVersion: 1,
      pins,
    });
    return true;
  });
}

/**
 * Two independent writers share one retention-pin manifest per artifact:
 * `replay-premiere-loop.ts`'s own premiere-hold claim (alive only for an
 * admission's own duration) and a Featured Match's claim
 * (`FeaturedMatchRetentionPin.ts`, alive for as long as the operator keeps
 * a record featured, independent of the hold's own release timing). The
 * schema allows only ONE pin entry per `episodeRequestId` — never two
 * competing entries — so multi-owner protection has to live inside that
 * one entry's `reason` field, as an EXACT-MATCH set of owner tags
 * (`;`-joined). These two functions are the ONLY correct way to mutate
 * that set for a SINGLE operation: idempotent add/remove of exactly ONE
 * tag, atomically (locked via `withFileMutex`), leaving every other
 * owner's tag completely untouched. An artifact stays protected as long
 * as ANY tag remains; the pin entry itself is removed only once the LAST
 * tag is gone. A caller applying SEVERAL operations at once (e.g. a
 * reconcile pass touching multiple records) MUST use
 * `applyRetentionPinOwnerBatch` instead — calling these single-operation
 * functions concurrently (e.g. via `Promise.all`) reopens the same lost-
 * update race the lock exists to close, since each call's lock is held
 * only for ITS OWN read-modify-write, not across multiple calls.
 *
 * An earlier version of this file had each owner run its own bespoke
 * read-modify-write (a "return early if ANY pin already claims this key"
 * short-circuit in the premiere-hold writer, a prefix-`startsWith` removal
 * check that only recognized its own reason format, and a separate
 * prepend-vs-append tag-string convention in the Featured Match writer).
 * That produced two real, opposite-direction bugs depending on write
 * order: (a) a Featured Match pin written FIRST made the premiere-hold
 * writer's dedup check see "already pinned" and skip recording its own
 * ownership entirely — so a later Featured Match cancellation could strip
 * the ONLY pin while a live hold still depended on it; (b) a premiere-hold
 * pin written first, once a Featured Match tag was combined into the same
 * reason, could never again be recognized/removed by the hold's own
 * release path — an orphaned tag that nothing would ever clean up. Both
 * writers MUST go through these two functions, not their own logic.
 */
export async function addRetentionPinOwner(
  pinManifestPath: string,
  entry: { episodeRequestId: string; publicRunKey: string; ownerTag: string },
): Promise<boolean> {
  return applyRetentionPinOwnerBatch(pinManifestPath, [
    { type: "add", ...entry },
  ]);
}

export async function removeRetentionPinOwner(
  pinManifestPath: string,
  entry: { episodeRequestId: string; ownerTag: string },
): Promise<boolean> {
  return applyRetentionPinOwnerBatch(pinManifestPath, [
    { type: "remove", ...entry },
  ]);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(
  value: JsonObject,
  expectedKeys: readonly string[],
  source: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${source} must contain exactly: ${expected.join(", ")}`);
  }
}

async function directoryEntries(rootDir: string) {
  try {
    return await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function managedCacheEntries(cacheDir: string): Promise<ManagedEntry[]> {
  const managed: ManagedEntry[] = [];
  for (const entry of await directoryEntries(cacheDir)) {
    if (!entry.isFile() || !managedReplayPattern.test(entry.name)) {
      continue;
    }
    const replayPath = path.join(cacheDir, entry.name);
    try {
      const stat = await fs.lstat(replayPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        continue;
      }
      const runID = await coworldRunIDFromReplayHeader(replayPath);
      managed.push({
        name: entry.name,
        modifiedAtMs: stat.mtimeMs,
        semanticTimestampMs:
          runID === null ? null : coworldRunTimestampMs(runID),
      });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
  return sortManagedEntries(managed);
}

async function managedRunEntries(runsRootDir: string): Promise<ManagedEntry[]> {
  const managed: ManagedEntry[] = [];
  for (const entry of await directoryEntries(runsRootDir)) {
    if (!entry.isDirectory() || !managedRunPattern.test(entry.name)) {
      continue;
    }
    const runDir = path.join(runsRootDir, entry.name);
    try {
      const stat = await fs.lstat(runDir);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !(await hasManagedBundleMarker(runDir))
      ) {
        continue;
      }
      managed.push({
        name: entry.name,
        modifiedAtMs: stat.mtimeMs,
        semanticTimestampMs: coworldRunTimestampMs(entry.name),
      });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
  return sortManagedEntries(managed);
}

function sortManagedEntries(entries: ManagedEntry[]): ManagedEntry[] {
  return entries.sort((a, b) => {
    const aTimestamp = a.semanticTimestampMs ?? a.modifiedAtMs;
    const bTimestamp = b.semanticTimestampMs ?? b.modifiedAtMs;
    return (
      bTimestamp - aTimestamp ||
      b.modifiedAtMs - a.modifiedAtMs ||
      a.name.localeCompare(b.name)
    );
  });
}

async function coworldRunIDFromReplayHeader(
  replayPath: string,
): Promise<string | null> {
  const file = await fs.open(replayPath, "r");
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const match = /"runID"\s*:\s*"([^"]+)"/.exec(
      buffer.subarray(0, bytesRead).toString("utf8"),
    );
    return match?.[1] ?? null;
  } finally {
    await file.close();
  }
}

function coworldRunTimestampMs(runID: string): number | null {
  const match =
    /^(?:league-)?coworld-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[A-Za-z0-9_-]+$/.exec(
      runID,
    );
  if (match === null) {
    return null;
  }
  const isoTimestamp = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  const timestampMs = Date.parse(isoTimestamp);
  return Number.isFinite(timestampMs) &&
    new Date(timestampMs).toISOString() === isoTimestamp
    ? timestampMs
    : null;
}

async function hasManagedBundleMarker(runDir: string): Promise<boolean> {
  const markerPath = path.join(runDir, ".mirror-bundle-version");
  try {
    const markerStat = await fs.lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      return false;
    }
    return /^[1-9]\d*$/.test((await fs.readFile(markerPath, "utf8")).trim());
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function pruneCandidates(
  entries: ManagedEntry[],
  protectedNames: ReadonlySet<string>,
  maximumRetained: number,
): ManagedEntry[] {
  const availableNames = new Set(entries.map((entry) => entry.name));
  const kept = new Set(
    [...protectedNames].filter((name) => availableNames.has(name)),
  );
  for (const entry of entries.slice(0, maximumRetained)) {
    kept.add(entry.name);
  }
  return entries.filter((entry) => !kept.has(entry.name));
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function archivePlans(options: {
  cacheDir: string;
  cacheCandidates: ManagedEntry[];
  runsRootDir: string;
  runCandidates: ManagedEntry[];
}): ArchivePlan[] {
  const plans: ArchivePlan[] = [];
  for (const candidate of options.cacheCandidates) {
    const episodeRequestId = candidate.name.slice(0, -".replay".length);
    const replayPath = path.join(options.cacheDir, candidate.name);
    plans.push({
      targetName: `${episodeRequestId}.replay-summary.json.gz`,
      materialize: () => compactReplayArchive(replayPath, episodeRequestId),
    });
  }
  for (const candidate of options.runCandidates) {
    const runDir = path.join(options.runsRootDir, candidate.name);
    for (const sourceName of [
      "match-summary.json",
      "game-record.json",
      "spectator-telemetry.json",
    ]) {
      plans.push({
        targetName: `${candidate.name}.${sourceName}.gz`,
        materialize: () => byteFidelityArchive(path.join(runDir, sourceName)),
      });
    }
  }
  return plans;
}

async function compactReplayArchive(
  replayPath: string,
  episodeRequestId: string,
): Promise<Buffer> {
  const replayBytes = await readRegularFile(replayPath);
  let replay: unknown;
  try {
    replay = JSON.parse(replayBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Cannot archive invalid Coworld replay: ${replayPath}`, {
      cause: error,
    });
  }
  if (!isJsonObject(replay)) {
    throw new Error(`Cannot archive non-object Coworld replay: ${replayPath}`);
  }
  const spectatorReplay = isJsonObject(replay.spectatorReplay)
    ? replay.spectatorReplay
    : null;
  const snapshots = spectatorReplay?.snapshots;
  const spectatorSnapshotCount =
    typeof replay.spectatorSnapshotCount === "number" &&
    Number.isInteger(replay.spectatorSnapshotCount)
      ? replay.spectatorSnapshotCount
      : Array.isArray(snapshots)
        ? snapshots.length
        : null;
  const compactRecord = {
    episodeRequestId,
    sha256: createHash("sha256").update(replayBytes).digest("hex"),
    bytes: replayBytes.byteLength,
    schemaVersion: jsonField(replay, "schemaVersion"),
    replayKind: jsonField(replay, "replayKind"),
    runID: jsonField(replay, "runID"),
    matchID: jsonField(replay, "matchID"),
    gameID: jsonField(replay, "gameID"),
    seed: jsonField(replay, "seed"),
    config: jsonField(replay, "config"),
    results: jsonField(replay, "results"),
    finalState: jsonField(replay, "finalState"),
    spectatorSnapshotCount,
  };
  return gzipSync(`${JSON.stringify(compactRecord, null, 2)}\n`);
}

function jsonField(value: JsonObject, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : null;
}

async function byteFidelityArchive(sourcePath: string): Promise<Buffer> {
  return gzipSync(await readRegularFile(sourcePath));
}

async function readRegularFile(sourcePath: string): Promise<Buffer> {
  await requireRegularFile(sourcePath);
  return fs.readFile(sourcePath);
}

async function requireRegularFile(sourcePath: string): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `Coworld retention source is not a regular file: ${sourcePath}`,
    );
  }
}

async function writeArchivePlans(
  summaryArchiveDir: string,
  plans: ArchivePlan[],
): Promise<void> {
  if (plans.length === 0) {
    return;
  }
  const resolvedArchiveDir = path.resolve(summaryArchiveDir);
  await fs.mkdir(resolvedArchiveDir, { recursive: true });
  const archiveStat = await fs.lstat(resolvedArchiveDir);
  if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()) {
    throw new Error(
      `Coworld summary archive is not a safe directory: ${resolvedArchiveDir}`,
    );
  }

  const staged: StagedArchive[] = [];
  try {
    for (const plan of plans) {
      const finalPath = path.resolve(resolvedArchiveDir, plan.targetName);
      if (path.dirname(finalPath) !== resolvedArchiveDir) {
        throw new Error(
          `Unsafe Coworld summary archive name: ${plan.targetName}`,
        );
      }
      const temporaryPath = path.join(
        resolvedArchiveDir,
        `.${plan.targetName}.${process.pid}.${randomUUID()}.tmp`,
      );
      const contents = await plan.materialize();
      await fs.writeFile(temporaryPath, contents, { flag: "wx", mode: 0o600 });
      staged.push({ finalPath, temporaryPath });
    }
    for (const archive of staged) {
      await fs.rename(archive.temporaryPath, archive.finalPath);
    }
  } catch (error) {
    await Promise.all(
      staged.map((archive) =>
        fs.rm(archive.temporaryPath, { force: true }).catch(() => undefined),
      ),
    );
    throw error;
  }
}

async function validateDeletionTargets(options: {
  cacheDir: string;
  cacheCandidates: ManagedEntry[];
  runsRootDir: string;
  runCandidates: ManagedEntry[];
}): Promise<void> {
  for (const candidate of options.cacheCandidates) {
    await requireRegularFile(path.join(options.cacheDir, candidate.name));
  }
  for (const candidate of options.runCandidates) {
    const runDir = path.join(options.runsRootDir, candidate.name);
    const stat = await fs.lstat(runDir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !(await hasManagedBundleMarker(runDir))
    ) {
      throw new Error(`Unsafe Coworld run deletion target: ${runDir}`);
    }
  }
}

export async function pruneCoworldLeagueMirrorArtifacts(
  options: CoworldLeagueArtifactRetentionOptions,
): Promise<CoworldLeagueArtifactRetentionResult> {
  requirePositiveInteger(
    options.maxRetainedCacheFiles,
    "maxRetainedCacheFiles",
  );
  requirePositiveInteger(
    options.maxRetainedRunDirectories,
    "maxRetainedRunDirectories",
  );
  for (const episodeRequestId of options.protectedEpisodeRequestIds) {
    if (!isSafeCoworldEpisodeRequestId(episodeRequestId)) {
      throw new Error(
        `Unsafe protected Coworld episode request id: ${episodeRequestId}`,
      );
    }
  }
  for (const publicRunKey of options.protectedPublicRunKeys) {
    if (!managedRunPattern.test(publicRunKey)) {
      throw new Error(
        `Unsafe protected Coworld public run key: ${publicRunKey}`,
      );
    }
  }
  const [runDirectories, cacheFiles] = await Promise.all([
    managedRunEntries(options.runsRootDir),
    managedCacheEntries(options.cacheDir),
  ]);
  const protectedCacheFiles = new Set(
    [...options.protectedEpisodeRequestIds].map(
      (episodeRequestId) => `${episodeRequestId}.replay`,
    ),
  );
  const cacheCandidates = pruneCandidates(
    cacheFiles,
    protectedCacheFiles,
    options.maxRetainedCacheFiles,
  );
  const runCandidates = pruneCandidates(
    runDirectories,
    options.protectedPublicRunKeys,
    options.maxRetainedRunDirectories,
  );
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    const planOptions = {
      cacheDir: options.cacheDir,
      cacheCandidates,
      runsRootDir: options.runsRootDir,
      runCandidates,
    };
    const plans = archivePlans(planOptions);
    await writeArchivePlans(options.summaryArchiveDir, plans);
    await validateDeletionTargets(planOptions);
    for (const candidate of cacheCandidates) {
      await fs.rm(path.join(options.cacheDir, candidate.name));
    }
    for (const candidate of runCandidates) {
      await fs.rm(path.join(options.runsRootDir, candidate.name), {
        recursive: true,
      });
    }
  }
  return {
    cacheFilesFound: cacheFiles.length,
    cacheFilesPruned: cacheCandidates.length,
    cacheFileCandidates: cacheCandidates.map((entry) => entry.name),
    runDirectoriesFound: runDirectories.length,
    runDirectoriesPruned: runCandidates.length,
    runDirectoryCandidates: runCandidates.map((entry) => entry.name),
  };
}

export function requireSafeCoworldLeagueRetentionLayout(
  siteDir: string,
  runsRootDir: string,
  cacheDir?: string,
  summaryArchiveDir?: string,
): void {
  const resolvedRunsRoot = path.resolve(runsRootDir);
  const resolvedSiteDir = path.resolve(siteDir);
  if (
    path.dirname(resolvedSiteDir) !== resolvedRunsRoot ||
    path.basename(resolvedSiteDir) !== "league"
  ) {
    throw new Error(
      "Coworld league retention requires siteDir to be the direct league child of runsRootDir",
    );
  }
  if (cacheDir === undefined && summaryArchiveDir === undefined) {
    return;
  }
  if (cacheDir === undefined || summaryArchiveDir === undefined) {
    throw new Error(
      "Coworld league retention requires cacheDir and summaryArchiveDir together",
    );
  }
  const artifactRoot = path.dirname(resolvedRunsRoot);
  const expectedRunsRoot = path.join(artifactRoot, "ai-league-runs");
  const mirrorRoot = path.join(artifactRoot, "coworld-league-mirror");
  if (
    resolvedRunsRoot !== expectedRunsRoot ||
    path.resolve(cacheDir) !== path.join(mirrorRoot, "replays") ||
    path.resolve(summaryArchiveDir) !== path.join(mirrorRoot, "summaries")
  ) {
    throw new Error(
      "Coworld league retention storage must use the canonical artifact layout",
    );
  }
}

export function coworldLeagueReplayCachePath(
  cacheDir: string,
  episodeRequestId: string,
): string {
  if (!isSafeCoworldEpisodeRequestId(episodeRequestId)) {
    throw new Error(`Unsafe Coworld episode request id: ${episodeRequestId}`);
  }
  const resolvedCacheDir = path.resolve(cacheDir);
  const cachePath = path.resolve(
    resolvedCacheDir,
    `${episodeRequestId}.replay`,
  );
  if (path.dirname(cachePath) !== resolvedCacheDir) {
    throw new Error(`Unsafe Coworld episode request id: ${episodeRequestId}`);
  }
  return cachePath;
}

export async function ensureSafeCoworldLeagueRunDirectory(
  runsRootDir: string,
  publicRunKey: string,
): Promise<string> {
  if (!managedRunPattern.test(publicRunKey)) {
    throw new Error(`Unsafe Coworld public run key: ${publicRunKey}`);
  }
  const resolvedRunsRoot = path.resolve(runsRootDir);
  const runDir = path.resolve(resolvedRunsRoot, publicRunKey);
  if (path.dirname(runDir) !== resolvedRunsRoot) {
    throw new Error(`Unsafe Coworld public run key: ${publicRunKey}`);
  }
  try {
    const existing = await fs.lstat(runDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Unsafe Coworld run directory: ${runDir}`);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
    try {
      await fs.mkdir(runDir);
    } catch (mkdirError) {
      if (errorCode(mkdirError) !== "EEXIST") {
        throw mkdirError;
      }
    }
    const created = await fs.lstat(runDir);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`Unsafe Coworld run directory: ${runDir}`, {
        cause: error,
      });
    }
  }
  return runDir;
}

const DEFAULT_MAX_ARCHIVED_GAME_RECORD_COMPRESSED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVED_GAME_RECORD_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

/**
 * Safe join + validation twin of `coworldLeagueReplayCachePath` above, for
 * the byte-faithful `<publicRunKey>.game-record.json.gz` archive instead
 * of the raw `.replay` cache file.
 */
export function archivedGameRecordArchivePath(
  summaryArchiveDir: string,
  publicRunKey: string,
): string | null {
  if (!managedRunPattern.test(publicRunKey)) return null;
  const resolvedDir = path.resolve(summaryArchiveDir);
  const archivePath = path.resolve(
    resolvedDir,
    `${publicRunKey}.game-record.json.gz`,
  );
  return path.dirname(archivePath) === resolvedDir ? archivePath : null;
}

/**
 * Streams the archived gzip through a byte-counting `Transform` that
 * aborts once `maxBytes` is exceeded (a bounded decompression-bomb
 * guard), into a uniquely-named temp file in the SAME directory as
 * `destinationPath` so the final `fs.rename` in `restoreArchivedGameRecord`
 * is same-filesystem atomic. `wx` refuses to silently overwrite a
 * colliding temp name.
 */
async function decompressBoundedGzipToFile(
  sourceGzipPath: string,
  destinationPath: string,
  maxBytes: number,
): Promise<void> {
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        callback(
          new Error(
            `Archived artifact exceeds the ${maxBytes}-byte decompression limit: ${sourceGzipPath}`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(sourceGzipPath),
    createGunzip(),
    limiter,
    createWriteStream(destinationPath, { flags: "wx", mode: 0o644 }),
  );
}

/**
 * Lazily rehydrates JUST `game-record.json` (never the spectator/light
 * files — see `CoworldLeagueArchivedReplayHrefs`'s own doc for why) for
 * one `publicRunKey` from its durable archive, when the live copy under
 * `runsRootDir` is missing. Never mutates or deletes anything under
 * `summaryArchiveDir` — read-only there. Never creates a run directory
 * for an unknown/bogus `publicRunKey`: the archive's own existence is
 * checked FIRST, before `ensureSafeCoworldLeagueRunDirectory` is ever
 * called, so a request for a key with no archive evidence litters
 * nothing. Race-safe: concurrent requests for the SAME run each write to
 * their own unique temp name and `fs.rename` into the same final path,
 * which is atomic and idempotent (identical source bytes either way).
 * Deliberately does NOT validate the restored bytes as a real game
 * record — the caller's own existing renderability re-check after this
 * call already owns that validation, and duplicating it here would
 * duplicate archive/record parsing across two modules. Returns the
 * absolute `game-record.json` path once it exists (already live, or
 * freshly restored) — `null` when nothing durable backs this
 * `publicRunKey` or it's malformed/oversized. Never throws for an
 * ordinary "no evidence" outcome; a genuine I/O failure during the
 * restore itself (disk full, permission error) DOES throw, so the caller
 * can log it distinctly from an honest miss.
 */
export async function restoreArchivedGameRecord(options: {
  runsRootDir: string;
  summaryArchiveDir: string;
  publicRunKey: string;
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
}): Promise<string | null> {
  const archivePath = archivedGameRecordArchivePath(
    options.summaryArchiveDir,
    options.publicRunKey,
  );
  if (archivePath === null) return null;
  const maxCompressedBytes =
    options.maxCompressedBytes ??
    DEFAULT_MAX_ARCHIVED_GAME_RECORD_COMPRESSED_BYTES;
  const maxDecompressedBytes =
    options.maxDecompressedBytes ??
    DEFAULT_MAX_ARCHIVED_GAME_RECORD_DECOMPRESSED_BYTES;

  let archiveStat;
  try {
    archiveStat = await fs.lstat(archivePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!archiveStat.isFile() || archiveStat.size > maxCompressedBytes) {
    return null;
  }

  const runDir = await ensureSafeCoworldLeagueRunDirectory(
    options.runsRootDir,
    options.publicRunKey,
  );
  const finalPath = path.join(runDir, "game-record.json");
  try {
    const existing = await fs.lstat(finalPath);
    if (existing.isFile()) return finalPath;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const temporaryPath = path.join(
    runDir,
    `.game-record.json.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await decompressBoundedGzipToFile(
      archivePath,
      temporaryPath,
      maxDecompressedBytes,
    );
    await fs.rename(temporaryPath, finalPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return finalPath;
}

export async function availableDiskBytes(
  candidatePath: string,
): Promise<number> {
  const stats = await fs.statfs(candidatePath);
  return Number(stats.bavail) * Number(stats.bsize);
}

export async function minimumAvailableDiskBytes(
  candidatePaths: readonly string[],
  inspect: (candidatePath: string) => Promise<number> = availableDiskBytes,
): Promise<number> {
  const uniquePaths = [
    ...new Set(candidatePaths.map((value) => path.resolve(value))),
  ];
  if (uniquePaths.length === 0) {
    throw new Error("At least one disk path is required");
  }
  const available = await Promise.all(
    uniquePaths.map((value) => inspect(value)),
  );
  return Math.min(...available);
}

export async function requireMinimumDiskSpace(
  candidatePath: string,
  minimumBytes: number,
  pendingWriteBytes = 0,
  inspect: (value: string) => Promise<number> = availableDiskBytes,
): Promise<void> {
  const requiredBytes = minimumBytes + pendingWriteBytes;
  if (
    !Number.isFinite(requiredBytes) ||
    minimumBytes < 0 ||
    pendingWriteBytes < 0
  ) {
    throw new Error("Disk-space requirements must be non-negative numbers");
  }
  const availableBytes = await inspect(candidatePath);
  if (availableBytes < requiredBytes) {
    const availableMiB = Math.floor(availableBytes / (1024 * 1024));
    const requiredMiB = Math.ceil(requiredBytes / (1024 * 1024));
    throw new CoworldLeagueDiskReserveError(
      `Coworld league mirror paused: ${availableMiB} MiB free; ${requiredMiB} MiB required`,
    );
  }
}

function errorCode(error: unknown): string | null {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}
