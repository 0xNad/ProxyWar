import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { isSafeCoworldEpisodeRequestId } from "./CoworldLeagueMirrorCore";
import type { CoworldLeagueEpisodeRow } from "./CoworldLeagueSiteWriter";

const managedRunPattern = /^league-coworld-[A-Za-z0-9-]+$/;
const managedReplayPattern = /^ereq_[A-Za-z0-9_-]+\.replay$/;

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
    const raw: unknown = JSON.parse(
      await fs.readFile(pinManifestPath, "utf8"),
    );
    if (isJsonObject(raw) && raw.schemaVersion === 1 && Array.isArray(raw.pins)) {
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
 * that set: idempotent add/remove of exactly ONE tag, atomically, leaving
 * every other owner's tag completely untouched. An artifact stays
 * protected as long as ANY tag remains; the pin entry itself is removed
 * only once the LAST tag is gone.
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
  const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
  const existingIndex = manifest.pins.findIndex(
    (pin) => pin.episodeRequestId === entry.episodeRequestId,
  );
  if (existingIndex === -1) {
    await writeCoworldLeagueRetentionPinManifest(pinManifestPath, {
      schemaVersion: 1,
      pins: [
        ...manifest.pins,
        {
          episodeRequestId: entry.episodeRequestId,
          publicRunKey: entry.publicRunKey,
          reason: entry.ownerTag,
        },
      ],
    });
    return true;
  }
  const existing = manifest.pins[existingIndex];
  const owners = existing.reason.split(";").map((tag) => tag.trim());
  if (owners.includes(entry.ownerTag)) return false; // already owns it
  const nextPins = manifest.pins.slice();
  nextPins[existingIndex] = {
    ...existing,
    reason: [...owners, entry.ownerTag].join(";"),
  };
  await writeCoworldLeagueRetentionPinManifest(pinManifestPath, {
    schemaVersion: 1,
    pins: nextPins,
  });
  return true;
}

export async function removeRetentionPinOwner(
  pinManifestPath: string,
  entry: { episodeRequestId: string; ownerTag: string },
): Promise<boolean> {
  const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
  const existingIndex = manifest.pins.findIndex(
    (pin) => pin.episodeRequestId === entry.episodeRequestId,
  );
  if (existingIndex === -1) return false;
  const existing = manifest.pins[existingIndex];
  const owners = existing.reason
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (!owners.includes(entry.ownerTag)) return false;
  const remainingOwners = owners.filter((tag) => tag !== entry.ownerTag);
  const nextPins = manifest.pins.slice();
  if (remainingOwners.length === 0) {
    nextPins.splice(existingIndex, 1);
  } else {
    nextPins[existingIndex] = {
      ...existing,
      reason: remainingOwners.join(";"),
    };
  }
  await writeCoworldLeagueRetentionPinManifest(pinManifestPath, {
    schemaVersion: 1,
    pins: nextPins,
  });
  return true;
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
