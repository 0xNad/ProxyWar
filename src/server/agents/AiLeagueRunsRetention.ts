import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Bounded, evidence-preserving retention for the general (non-league) run
 * bundles under `artifacts/ai-league-runs/`.
 *
 * This is deliberately separate from {@link ./CoworldLeagueArtifactRetention}:
 * that module owns the public league mirror bundles (`league`,
 * `league-coworld-*`) that the league frontend serves. This module NEVER
 * touches those — it only reclaims the ad-hoc smoke / forge / evaluation run
 * directories that otherwise accumulate without any retention.
 *
 * Design mirrors the house storage idioms (fixed reserve caps, dry-run
 * default, bounded per-run deletion, atomic audit manifests, refuse-when-
 * uncertain): the tool only ever removes directories it is confident about,
 * and skips (retains) everything else.
 */

export const GIB = 1024 ** 3;

/** Newest N run directories are always retained regardless of age/citation. */
export const DEFAULT_RETAIN_NEWEST = 200;
/** Runs newer than this many days are always retained. */
export const DEFAULT_TTL_DAYS = 30;
/** At most this many directories are removed per invocation. */
export const DEFAULT_MAX_DIRS_PER_RUN = 200;
/** At most this many bytes are removed per invocation. */
export const DEFAULT_MAX_BYTES_PER_RUN = 5 * GIB;
/** Directory roots scanned for evidence citations (relative to cwd or absolute). */
export const DEFAULT_CITATION_ROOTS = ["docs"] as const;
/** File extensions treated as citation text. */
export const DEFAULT_CITATION_EXTENSIONS = [
  ".md",
  ".mdx",
  ".markdown",
  ".txt",
  ".json",
] as const;

/**
 * A safe managed run directory name: begins alphanumeric, then only
 * `[A-Za-z0-9._-]`. Never a dotfile, never a path traversal token.
 */
const safeRunNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Trailing git-style hex hash token used as a secondary citation key. */
const hashSuffixPattern = /-([0-9a-f]{7,40})$/;

export interface RawRunDirEntry {
  name: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  modifiedAtMs: number;
}

export interface ClassifiedRunEntry {
  name: string;
  effectiveTimestampMs: number;
  timestampSource: "semantic" | "mtime";
  ageMs: number;
}

export type RunProtectionReason =
  | "league-bundle"
  | "unsafe-name"
  | "pin"
  | "citation"
  | "newest"
  | "ttl";

export interface ClassifyAiLeagueRunsOptions {
  entries: readonly RawRunDirEntry[];
  nowMs: number;
  citationCorpus: string;
  pinnedRunNames: ReadonlySet<string>;
  retainNewest: number;
  ttlDays: number;
}

export interface AiLeagueRunsClassification {
  scannedEntries: number;
  candidates: number;
  skippedLeagueBundles: string[];
  skippedUnsafeNames: string[];
  protectedByPin: string[];
  protectedByCitation: string[];
  protectedByNewest: number;
  protectedByTtl: number;
  /** Removal-eligible directories, oldest first. */
  eligible: ClassifiedRunEntry[];
}

export interface SizedRunEntry extends ClassifiedRunEntry {
  sizeBytes: number;
}

export interface SelectWithinCapsOptions {
  eligible: readonly SizedRunEntry[];
  maxDirs: number;
  maxBytes: number;
}

export interface SelectWithinCapsResult {
  selected: SizedRunEntry[];
  selectedBytes: number;
  deferred: number;
}

/** True for the protected public league mirror bundles (`league`, `league-*`). */
export function isProtectedLeagueBundleName(name: string): boolean {
  return name.startsWith("league");
}

/** True only for a normal, traversal-safe run directory name. */
export function isSafeAiLeagueRunName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    safeRunNamePattern.test(name)
  );
}

/**
 * Parse a UTC timestamp embedded in a run id. Handles the two shapes the
 * generators actually emit:
 *   - full ISO:   `2026-05-08T16-35-58-815Z-...` (optionally `coworld-` prefixed)
 *   - date-only:  `2026-05-16-...`
 * Returns null when no unambiguous timestamp is present (fall back to mtime).
 */
export function parseAiLeagueRunSemanticTimestampMs(
  name: string,
): number | null {
  const isoMatch =
    /^(?:coworld-)?(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-|$)/.exec(
      name,
    );
  if (isoMatch !== null) {
    const [, year, month, day, hour, minute, second, millis] = isoMatch;
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`;
    return isoTimestampMs(iso);
  }
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})(?:-|$)/.exec(name);
  if (dateMatch !== null) {
    const [, year, month, day] = dateMatch;
    return isoTimestampMs(`${year}-${month}-${day}T00:00:00.000Z`);
  }
  return null;
}

function isoTimestampMs(iso: string): number | null {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === iso
    ? parsed
    : null;
}

/**
 * Citation keys for a run: its full directory name plus, when present, its
 * trailing hex hash token — because docs cite runs both ways.
 */
export function runCitationTokens(name: string): string[] {
  const tokens = [name];
  const hashMatch = hashSuffixPattern.exec(name);
  if (hashMatch !== null && hashMatch[1] !== name) {
    tokens.push(hashMatch[1]);
  }
  return tokens;
}

/** True when any citation key for the run appears anywhere in the corpus. */
export function isRunCited(name: string, citationCorpus: string): boolean {
  return runCitationTokens(name).some((token) =>
    citationCorpus.includes(token),
  );
}

/**
 * Pure retention classifier: partitions scanned directory entries into
 * protected (with reason) vs. removal-eligible (oldest first). No filesystem
 * access — every input is injected, so this is the unit-tested heart.
 */
export function classifyAiLeagueRuns(
  options: ClassifyAiLeagueRunsOptions,
): AiLeagueRunsClassification {
  requirePositiveInteger(options.retainNewest, "retainNewest");
  requireNonNegativeFinite(options.ttlDays, "ttlDays");
  const ttlMs = options.ttlDays * 24 * 60 * 60 * 1000;

  const skippedLeagueBundles: string[] = [];
  const skippedUnsafeNames: string[] = [];
  const candidates: ClassifiedRunEntry[] = [];

  for (const entry of options.entries) {
    if (isProtectedLeagueBundleName(entry.name)) {
      skippedLeagueBundles.push(entry.name);
      continue;
    }
    if (
      !entry.isDirectory ||
      entry.isSymbolicLink ||
      !isSafeAiLeagueRunName(entry.name)
    ) {
      skippedUnsafeNames.push(entry.name);
      continue;
    }
    const semanticTimestampMs = parseAiLeagueRunSemanticTimestampMs(entry.name);
    const effectiveTimestampMs = semanticTimestampMs ?? entry.modifiedAtMs;
    candidates.push({
      name: entry.name,
      effectiveTimestampMs,
      timestampSource: semanticTimestampMs === null ? "mtime" : "semantic",
      ageMs: options.nowMs - effectiveTimestampMs,
    });
  }

  // Newest-first ordering, deterministic on ties.
  const newestFirst = [...candidates].sort(
    (a, b) =>
      b.effectiveTimestampMs - a.effectiveTimestampMs ||
      a.name.localeCompare(b.name),
  );
  const newestProtectedNames = new Set(
    newestFirst.slice(0, options.retainNewest).map((entry) => entry.name),
  );

  const protectedByPin: string[] = [];
  const protectedByCitation: string[] = [];
  let protectedByNewest = 0;
  let protectedByTtl = 0;
  const eligible: ClassifiedRunEntry[] = [];

  for (const candidate of newestFirst) {
    if (options.pinnedRunNames.has(candidate.name)) {
      protectedByPin.push(candidate.name);
      continue;
    }
    if (isRunCited(candidate.name, options.citationCorpus)) {
      protectedByCitation.push(candidate.name);
      continue;
    }
    if (newestProtectedNames.has(candidate.name)) {
      protectedByNewest += 1;
      continue;
    }
    if (candidate.ageMs < ttlMs) {
      protectedByTtl += 1;
      continue;
    }
    eligible.push(candidate);
  }

  eligible.sort(
    (a, b) =>
      a.effectiveTimestampMs - b.effectiveTimestampMs ||
      a.name.localeCompare(b.name),
  );

  return {
    scannedEntries: options.entries.length,
    candidates: candidates.length,
    skippedLeagueBundles,
    skippedUnsafeNames,
    protectedByPin,
    protectedByCitation,
    protectedByNewest,
    protectedByTtl,
    eligible,
  };
}

/**
 * Apply the bounded per-invocation caps to the (oldest-first) eligible set.
 * Strict: stops at the first directory that would breach either cap so a bug
 * can never cascade into unbounded deletion.
 */
export function selectWithinCaps(
  options: SelectWithinCapsOptions,
): SelectWithinCapsResult {
  requirePositiveInteger(options.maxDirs, "maxDirs");
  requirePositiveInteger(options.maxBytes, "maxBytes");
  const selected: SizedRunEntry[] = [];
  let selectedBytes = 0;
  for (const entry of options.eligible) {
    if (selected.length >= options.maxDirs) {
      break;
    }
    if (selectedBytes + entry.sizeBytes > options.maxBytes) {
      break;
    }
    selected.push(entry);
    selectedBytes += entry.sizeBytes;
  }
  return {
    selected,
    selectedBytes,
    deferred: options.eligible.length - selected.length,
  };
}

// ---------------------------------------------------------------------------
// Filesystem orchestration
// ---------------------------------------------------------------------------

export interface RunAiLeagueRunsRetentionOptions {
  runsRootDir: string;
  citationRoots: readonly string[];
  citationExtensions: readonly string[];
  pinnedRunNames: ReadonlySet<string>;
  stateDir: string;
  retainNewest: number;
  ttlDays: number;
  maxDirs: number;
  maxBytes: number;
  archiveToDir: string | null;
  dryRun: boolean;
  now?: Date;
}

export interface RunAiLeagueRunsRetentionReport {
  dryRun: boolean;
  mode: "delete" | "archive";
  runsRoot: string;
  archiveDir: string | null;
  scannedEntries: number;
  candidates: number;
  protectedCounts: {
    leagueBundles: number;
    unsafeNames: number;
    pin: number;
    citation: number;
    newest: number;
    ttl: number;
  };
  policy: {
    retainNewest: number;
    ttlDays: number;
    maxDirs: number;
    maxBytes: number;
  };
  eligibleCount: number;
  eligibleBytesSampled: number;
  plan: {
    selectedCount: number;
    selectedBytes: number;
    deferred: number;
  };
  selected: Array<{
    name: string;
    sizeBytes: number;
    effectiveTimestampMs: number;
    timestampSource: "semantic" | "mtime";
  }>;
  removed: string[];
  auditManifestPath: string | null;
}

/**
 * Refuse to operate on any directory that is not literally the
 * `ai-league-runs` root. Combined with per-target parent checks, this confines
 * every deletion to the configured root.
 */
export function requireSafeAiLeagueRunsRetentionLayout(
  runsRootDir: string,
): string {
  const resolved = path.resolve(runsRootDir);
  if (path.basename(resolved) !== "ai-league-runs") {
    throw new Error(
      "ai-league-runs retention requires runsRootDir to be the ai-league-runs directory",
    );
  }
  return resolved;
}

async function collectRawRunEntries(
  resolvedRunsRoot: string,
): Promise<RawRunDirEntry[]> {
  const dirents = await fs.readdir(resolvedRunsRoot, { withFileTypes: true });
  const entries: RawRunDirEntry[] = [];
  for (const dirent of dirents) {
    const fullPath = path.join(resolvedRunsRoot, dirent.name);
    let stat;
    try {
      stat = await fs.lstat(fullPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
    entries.push({
      name: dirent.name,
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      modifiedAtMs: stat.mtimeMs,
    });
  }
  return entries;
}

export async function readCitationCorpus(
  roots: readonly string[],
  extensions: readonly string[],
): Promise<string> {
  const allowed = new Set(extensions.map((ext) => ext.toLowerCase()));
  const chunks: string[] = [];
  for (const root of roots) {
    await appendCitationText(path.resolve(root), allowed, chunks);
  }
  return chunks.join("\n");
}

async function appendCitationText(
  dir: string,
  allowedExtensions: ReadonlySet<string>,
  chunks: string[],
): Promise<void> {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const dirent of dirents) {
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isSymbolicLink()) {
      continue;
    }
    if (dirent.isDirectory()) {
      await appendCitationText(fullPath, allowedExtensions, chunks);
      continue;
    }
    if (
      dirent.isFile() &&
      allowedExtensions.has(path.extname(dirent.name).toLowerCase())
    ) {
      chunks.push(await fs.readFile(fullPath, "utf8"));
    }
  }
}

export async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return 0;
    }
    throw error;
  }
  for (const dirent of dirents) {
    const fullPath = path.join(dir, dirent.name);
    let stat;
    try {
      stat = await fs.lstat(fullPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      total += await directorySizeBytes(fullPath);
    } else if (stat.isFile()) {
      total += stat.size;
    }
  }
  return total;
}

/**
 * Size eligible directories oldest-first and apply caps. Only sizes as many as
 * needed to fill the plan (plus one to confirm the cap boundary), so scanning
 * cost stays bounded even with thousands of eligible directories.
 */
async function selectSizedWithinCaps(
  resolvedRunsRoot: string,
  eligible: readonly ClassifiedRunEntry[],
  maxDirs: number,
  maxBytes: number,
): Promise<{
  selected: SizedRunEntry[];
  selectedBytes: number;
  deferred: number;
}> {
  const selected: SizedRunEntry[] = [];
  let selectedBytes = 0;
  let index = 0;
  for (; index < eligible.length; index++) {
    if (selected.length >= maxDirs) {
      break;
    }
    const entry = eligible[index];
    const sizeBytes = await directorySizeBytes(
      path.join(resolvedRunsRoot, entry.name),
    );
    if (selectedBytes + sizeBytes > maxBytes) {
      break;
    }
    selected.push({ ...entry, sizeBytes });
    selectedBytes += sizeBytes;
  }
  return {
    selected,
    selectedBytes,
    deferred: eligible.length - selected.length,
  };
}

async function assertSafeDeletionTarget(
  resolvedRunsRoot: string,
  name: string,
): Promise<string> {
  if (isProtectedLeagueBundleName(name) || !isSafeAiLeagueRunName(name)) {
    throw new Error(`Unsafe ai-league-runs deletion target: ${name}`);
  }
  const target = path.resolve(resolvedRunsRoot, name);
  if (path.dirname(target) !== resolvedRunsRoot) {
    throw new Error(`Unsafe ai-league-runs deletion target: ${name}`);
  }
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe ai-league-runs deletion target: ${target}`);
  }
  return target;
}

async function archiveDirectory(
  target: string,
  archiveDir: string,
  name: string,
): Promise<void> {
  const resolvedArchiveDir = path.resolve(archiveDir);
  await fs.mkdir(resolvedArchiveDir, { recursive: true });
  const destination = path.resolve(resolvedArchiveDir, name);
  if (path.dirname(destination) !== resolvedArchiveDir) {
    throw new Error(`Unsafe archive destination: ${name}`);
  }
  try {
    await fs.lstat(destination);
    throw new Error(`Archive destination already exists: ${destination}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  try {
    await fs.rename(target, destination);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") {
      throw error;
    }
    await fs.cp(target, destination, { recursive: true, force: false });
    await fs.rm(target, { recursive: true });
  }
}

async function writeAuditManifest(
  stateDir: string,
  manifest: unknown,
  now: Date,
): Promise<string> {
  const resolvedStateDir = path.resolve(stateDir, "ai-league-runs-retention");
  await fs.mkdir(resolvedStateDir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const finalPath = path.join(
    resolvedStateDir,
    `${stamp}-ai-league-runs-retention.json`,
  );
  const temporaryPath = path.join(
    resolvedStateDir,
    `.${stamp}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temporaryPath, finalPath);
  return finalPath;
}

export async function runAiLeagueRunsRetention(
  options: RunAiLeagueRunsRetentionOptions,
): Promise<RunAiLeagueRunsRetentionReport> {
  requirePositiveInteger(options.retainNewest, "retainNewest");
  requireNonNegativeFinite(options.ttlDays, "ttlDays");
  requirePositiveInteger(options.maxDirs, "maxDirs");
  requirePositiveInteger(options.maxBytes, "maxBytes");
  const now = options.now ?? new Date();
  const resolvedRunsRoot = requireSafeAiLeagueRunsRetentionLayout(
    options.runsRootDir,
  );

  const [entries, citationCorpus] = await Promise.all([
    collectRawRunEntries(resolvedRunsRoot),
    readCitationCorpus(options.citationRoots, options.citationExtensions),
  ]);

  const classification = classifyAiLeagueRuns({
    entries,
    nowMs: now.getTime(),
    citationCorpus,
    pinnedRunNames: options.pinnedRunNames,
    retainNewest: options.retainNewest,
    ttlDays: options.ttlDays,
  });

  const { selected, selectedBytes, deferred } = await selectSizedWithinCaps(
    resolvedRunsRoot,
    classification.eligible,
    options.maxDirs,
    options.maxBytes,
  );

  const mode: "delete" | "archive" =
    options.archiveToDir !== null ? "archive" : "delete";
  const report: RunAiLeagueRunsRetentionReport = {
    dryRun: options.dryRun,
    mode,
    runsRoot: resolvedRunsRoot,
    archiveDir:
      options.archiveToDir === null ? null : path.resolve(options.archiveToDir),
    scannedEntries: classification.scannedEntries,
    candidates: classification.candidates,
    protectedCounts: {
      leagueBundles: classification.skippedLeagueBundles.length,
      unsafeNames: classification.skippedUnsafeNames.length,
      pin: classification.protectedByPin.length,
      citation: classification.protectedByCitation.length,
      newest: classification.protectedByNewest,
      ttl: classification.protectedByTtl,
    },
    policy: {
      retainNewest: options.retainNewest,
      ttlDays: options.ttlDays,
      maxDirs: options.maxDirs,
      maxBytes: options.maxBytes,
    },
    eligibleCount: classification.eligible.length,
    eligibleBytesSampled: selectedBytes,
    plan: {
      selectedCount: selected.length,
      selectedBytes,
      deferred,
    },
    selected: selected.map((entry) => ({
      name: entry.name,
      sizeBytes: entry.sizeBytes,
      effectiveTimestampMs: entry.effectiveTimestampMs,
      timestampSource: entry.timestampSource,
    })),
    removed: [],
    auditManifestPath: null,
  };

  if (options.dryRun || selected.length === 0) {
    return report;
  }

  const removed: string[] = [];
  let removedBytes = 0;
  let thrown: unknown = null;
  try {
    for (const entry of selected) {
      const target = await assertSafeDeletionTarget(
        resolvedRunsRoot,
        entry.name,
      );
      if (isRunCited(entry.name, citationCorpus)) {
        // Defense in depth: never remove a run that became cited.
        continue;
      }
      if (options.archiveToDir !== null) {
        await archiveDirectory(target, options.archiveToDir, entry.name);
      } else {
        await fs.rm(target, { recursive: true });
      }
      removed.push(entry.name);
      removedBytes += entry.sizeBytes;
    }
  } catch (error) {
    thrown = error;
  }

  report.removed = removed;
  report.auditManifestPath = await writeAuditManifest(
    options.stateDir,
    {
      schemaVersion: 1,
      tool: "ai-league-runs-retention",
      generatedAt: now.toISOString(),
      runsRoot: resolvedRunsRoot,
      mode,
      archiveDir: report.archiveDir,
      policy: report.policy,
      protectedCounts: report.protectedCounts,
      removed: selected
        .filter((entry) => removed.includes(entry.name))
        .map((entry) => ({
          name: entry.name,
          sizeBytes: entry.sizeBytes,
          effectiveTimestampMs: entry.effectiveTimestampMs,
          timestampSource: entry.timestampSource,
        })),
      removedBytes,
      deferredEligible: deferred + (selected.length - removed.length),
      completed: thrown === null,
    },
    now,
  );

  if (thrown !== null) {
    throw thrown;
  }
  return report;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function requireNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
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
