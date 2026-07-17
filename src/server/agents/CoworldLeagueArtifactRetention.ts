import { promises as fs } from "node:fs";
import path from "node:path";
import { isSafeCoworldEpisodeRequestId } from "./CoworldLeagueMirrorCore";
import type { CoworldLeagueEpisodeRow } from "./CoworldLeagueSiteWriter";

const managedRunPattern = /^league-coworld-[A-Za-z0-9-]+$/;
const managedReplayPattern = /^ereq_[A-Za-z0-9_-]+\.replay$/;

export interface CoworldLeagueRetentionReferences {
  episodeRequestIds: Set<string>;
  publicRunKeys: Set<string>;
}

export interface CoworldLeagueArtifactRetentionOptions {
  cacheDir: string;
  runsRootDir: string;
  protectedEpisodeRequestIds: ReadonlySet<string>;
  protectedPublicRunKeys: ReadonlySet<string>;
  maxRetainedArtifacts: number;
  minimumRetentionAgeMs: number;
  nowMs?: number;
  dryRun?: boolean;
}

export interface CoworldLeagueArtifactRetentionResult {
  cacheFilesFound: number;
  cacheFilesPruned: number;
  runDirectoriesFound: number;
  runDirectoriesPruned: number;
}

export class CoworldLeagueDiskReserveError extends Error {}

interface ManagedEntry {
  name: string;
  modifiedAtMs: number;
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
      }
    }
  }
  return { episodeRequestIds, publicRunKeys };
}

async function managedEntries(
  rootDir: string,
  include: (entry: {
    isDirectory(): boolean;
    isFile(): boolean;
    name: string;
  }) => boolean,
): Promise<ManagedEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const managed: ManagedEntry[] = [];
  for (const entry of entries) {
    if (!include(entry)) {
      continue;
    }
    try {
      const stat = await fs.lstat(path.join(rootDir, entry.name));
      managed.push({ name: entry.name, modifiedAtMs: stat.mtimeMs });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
  return managed.sort(
    (a, b) => b.modifiedAtMs - a.modifiedAtMs || a.name.localeCompare(b.name),
  );
}

function namesToKeep(
  entries: ManagedEntry[],
  protectedNames: ReadonlySet<string>,
  maxRetainedArtifacts: number,
  minimumModifiedAtMs: number,
): Set<string> {
  const availableNames = new Set(entries.map((entry) => entry.name));
  const kept = new Set(
    [...protectedNames].filter((name) => availableNames.has(name)),
  );
  for (const entry of entries.slice(0, maxRetainedArtifacts)) {
    kept.add(entry.name);
  }
  for (const entry of entries) {
    if (entry.modifiedAtMs >= minimumModifiedAtMs) {
      kept.add(entry.name);
    }
  }
  return kept;
}

async function pruneEntries(options: {
  rootDir: string;
  entries: ManagedEntry[];
  protectedNames: ReadonlySet<string>;
  maxRetainedArtifacts: number;
  minimumModifiedAtMs: number;
  recursive: boolean;
  dryRun: boolean;
}): Promise<number> {
  const kept = namesToKeep(
    options.entries,
    options.protectedNames,
    options.maxRetainedArtifacts,
    options.minimumModifiedAtMs,
  );
  const obsolete = options.entries.filter((entry) => !kept.has(entry.name));
  if (!options.dryRun) {
    for (const entry of obsolete) {
      await fs.rm(path.join(options.rootDir, entry.name), {
        force: true,
        recursive: options.recursive,
      });
    }
  }
  return obsolete.length;
}

export async function pruneCoworldLeagueMirrorArtifacts(
  options: CoworldLeagueArtifactRetentionOptions,
): Promise<CoworldLeagueArtifactRetentionResult> {
  if (
    !Number.isInteger(options.maxRetainedArtifacts) ||
    options.maxRetainedArtifacts < 1
  ) {
    throw new Error("maxRetainedArtifacts must be a positive integer");
  }
  if (
    !Number.isFinite(options.minimumRetentionAgeMs) ||
    options.minimumRetentionAgeMs < 0
  ) {
    throw new Error("minimumRetentionAgeMs must be a non-negative number");
  }
  const nowMs = options.nowMs ?? Date.now();
  const minimumModifiedAtMs = nowMs - options.minimumRetentionAgeMs;
  const [runDirectories, cacheFiles] = await Promise.all([
    managedEntries(
      options.runsRootDir,
      (entry) => entry.isDirectory() && managedRunPattern.test(entry.name),
    ),
    managedEntries(
      options.cacheDir,
      (entry) => entry.isFile() && managedReplayPattern.test(entry.name),
    ),
  ]);
  const protectedCacheFiles = new Set(
    [...options.protectedEpisodeRequestIds].map(
      (episodeRequestId) => `${episodeRequestId}.replay`,
    ),
  );
  const dryRun = options.dryRun === true;
  const [runDirectoriesPruned, cacheFilesPruned] = await Promise.all([
    pruneEntries({
      rootDir: options.runsRootDir,
      entries: runDirectories,
      protectedNames: options.protectedPublicRunKeys,
      maxRetainedArtifacts: options.maxRetainedArtifacts,
      minimumModifiedAtMs,
      recursive: true,
      dryRun,
    }),
    pruneEntries({
      rootDir: options.cacheDir,
      entries: cacheFiles,
      protectedNames: protectedCacheFiles,
      maxRetainedArtifacts: options.maxRetainedArtifacts,
      minimumModifiedAtMs,
      recursive: false,
      dryRun,
    }),
  ]);
  return {
    cacheFilesFound: cacheFiles.length,
    cacheFilesPruned,
    runDirectoriesFound: runDirectories.length,
    runDirectoriesPruned,
  };
}

export function requireSafeCoworldLeagueRetentionLayout(
  siteDir: string,
  runsRootDir: string,
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
