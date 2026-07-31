import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  spectatorHtml,
  type AgentSpectatorReplay,
} from "../server/agents/AgentSpectatorReplay";
import {
  CoworldLeagueDiskReserveError,
  coworldLeagueReplayCachePath,
  ensureSafeCoworldLeagueRunDirectory,
  minimumAvailableDiskBytes,
  pruneCoworldLeagueMirrorArtifacts,
  readCoworldLeagueRetentionPins,
  requireMinimumDiskSpace,
  requireSafeCoworldLeagueRetentionLayout,
  retentionReferencesFromEpisodes,
} from "../server/agents/CoworldLeagueArtifactRetention";
import {
  buildCoworldReplayUiArtifact,
  buildEpisodeRow,
  buildRoundRows,
  buildStandingRows,
  mergeEpisodeRows,
  parseCompletedEpisodeMetaList,
  parseDirectorCutPlanSummary,
  parseHostedReplayPayload,
  parseLeagueSummary,
  pickCompetitionDivision,
  premiereHrefForEpisode,
  resolveLatestRevealedPremiere,
  roundNumberByRoundId,
  scoreLabelFromStandings,
  selectServingLatestPremiere,
  summarizePremiereArchiveIndex,
  type HostedEpisodeMeta,
  type ParsedHostedReplay,
  type PremiereArchiveIndexSummary,
} from "../server/agents/CoworldLeagueMirrorCore";
import { withCoworldLeagueMirrorOperationLock } from "../server/agents/CoworldLeagueMirrorOperationLock";
import {
  buildPremiereSiteBlock,
  classifyEpisodeSuppression,
  filterSuppressedEpisodeRows,
  loadLatestPremierePointer,
  loadPremiereSuppressionContract,
  type PremiereSuppressionState,
} from "../server/agents/CoworldLeaguePremiereSuppression";
import {
  markCoworldLeagueSiteStale,
  writeCoworldLeagueSite,
  type CoworldLeagueEpisodeRow,
  type CoworldLeagueMirrorData,
} from "../server/agents/CoworldLeagueSiteWriter";

/**
 * Read-only Coworld league mirror.
 *
 * Pulls hosted league state through the `coworld` CLI's read verbs
 * (`leagues`, `results`, `memberships`, `rounds`, `replays`) plus public S3
 * replay downloads, then writes a static league site into
 * `artifacts/ai-league-runs/league/` and unpacks each mirrored episode into a
 * standard `artifacts/ai-league-runs/<runID>/` bundle (self-contained
 * spectator.html + the inline artifacts the real-client renderer needs).
 *
 * This script never mutates hosted state: no upload, submit, publish, or
 * experience-request creation. Keep it that way — hosted mutations are
 * operator-gated.
 *
 * Premiere links (`--premiere-archive-index <absolute path>`): when pointed at
 * the replay-premiere archive index (production:
 * `$PROXYWAR_STORAGE_STATE_DIR/replay-premiere/archive-v1/archive-index.jsonl`,
 * wired in `start-proxywar-league-mirror.zsh` exactly like
 * `--suppression-contract`), each battle card whose episode has a REVEALED
 * premiere gains a `/premiere/<premiereId>` link. The index is READ-ONLY here,
 * only reveal-public facts are extracted, and every failure mode fails open to
 * "no links". Default off: without the flag the mirror output is unchanged.
 *
 * Latest-premiere card (`--latest-premiere <absolute path>`): when pointed at
 * the loop-written latest-revealed pointer (production:
 * `$PROXYWAR_STORAGE_STATE_DIR/premiere-suppression/latest-premiere.json`,
 * next to the suppression contract), the league page's premiere slot becomes
 * persistent: whenever no LIVE premiere card is showing it renders the most
 * recent REVEALED premiere as a watchable card, replaced only when the next
 * premiere activates — so once any premiere has revealed, the slot is never
 * empty. The pointer is the freshness source (written at reveal, before the
 * ~30-minute terminal reclamation), READ-ONLY here, carries reveal-public
 * facts only, and is cross-checked against the archive index when that is
 * also wired (with the index's newest revealed entry as the fallback). Every
 * failure mode fails open to "no card". Default off: without the flag the
 * mirror output is unchanged.
 */

const execFileAsync = promisify(execFile);
const maximumReplayBytes = 512 * 1024 * 1024;

interface MirrorOptions {
  leagueId: string;
  siteDir: string;
  cacheDir: string;
  runsRootDir: string;
  maxRenderedEpisodes: number;
  episodeMetaLimit: number;
  roundsShown: number;
  maxRetainedCacheFiles: number;
  maxRetainedRunDirectories: number;
  summaryArchiveDir: string;
  retentionPinManifestPath: string;
  minimumFreeBytes: number;
  unpackRunDirs: boolean;
  starterUrl: string;
  recoverPinnedArtifacts: boolean;
  watch: boolean;
  intervalSeconds: number;
  /**
   * Absolute path to the premiere-suppression contract, or null (default) to
   * run with suppression disabled — the mirror then behaves exactly as before.
   */
  suppressionContractPath: string | null;
  /**
   * Absolute path to the replay-premiere archive index
   * (`archive-v1/archive-index.jsonl`), or null (default) to publish battle
   * cards without premiere links — the mirror then behaves exactly as before.
   */
  premiereArchiveIndexPath: string | null;
  /**
   * Absolute path to the loop-written latest-revealed-premiere pointer
   * (`premiere-suppression/latest-premiere.json`), or null (default) to
   * publish without the "Latest premiere" card — the mirror then behaves
   * exactly as before.
   */
  latestPremierePointerPath: string | null;
  /**
   * Origin to probe (`--premiere-probe-origin`, e.g. `http://127.0.0.1:8788`)
   * before linking a "Latest premiere" card: a candidate whose
   * `/premiere/<id>` page does not return 200 is dropped in favor of the
   * archive-index fallback (or no card). Null (default) skips probing —
   * candidates are trusted as before. 2026-07-22 orphan incident: a pointer
   * can name a revealed premiere that is neither live-registered nor archived
   * after restart churn; without the probe the card links a 404.
   */
  premiereProbeOrigin: string | null;
}

function parseOptions(argv: string[]): MirrorOptions {
  const options: MirrorOptions = {
    leagueId:
      process.env.PROXYWAR_LEAGUE_ID ??
      "league_cb60d526-ecfd-4836-ab3a-81fc6cf7dc42",
    siteDir: path.join("artifacts", "ai-league-runs", "league"),
    cacheDir: path.join("artifacts", "coworld-league-mirror", "replays"),
    runsRootDir: path.join("artifacts", "ai-league-runs"),
    maxRenderedEpisodes: 12,
    episodeMetaLimit: 24,
    roundsShown: 10,
    maxRetainedCacheFiles: Number(
      process.env.PROXYWAR_LEAGUE_RETAIN_RAW_REPLAYS ?? "24",
    ),
    maxRetainedRunDirectories: Number(
      process.env.PROXYWAR_LEAGUE_RETAIN_RUN_BUNDLES ?? "96",
    ),
    summaryArchiveDir:
      process.env.PROXYWAR_LEAGUE_SUMMARY_ARCHIVE_DIR ??
      path.join("artifacts", "coworld-league-mirror", "summaries"),
    retentionPinManifestPath:
      process.env.PROXYWAR_LEAGUE_RETENTION_PINS ??
      path.join("deploy", "coworld-league-retention-pins.json"),
    minimumFreeBytes:
      Number(process.env.PROXYWAR_LEAGUE_MIN_FREE_GIB ?? "10") *
      1024 *
      1024 *
      1024,
    unpackRunDirs: true,
    starterUrl:
      process.env.PROXYWAR_LEAGUE_STARTER_URL ??
      "https://github.com/0xNad/proxywar-coworld-starter",
    recoverPinnedArtifacts: false,
    watch: false,
    intervalSeconds: 300,
    suppressionContractPath: null,
    premiereArchiveIndexPath: null,
    latestPremierePointerPath: null,
    premiereProbeOrigin: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      return value;
    };
    switch (arg) {
      case "--league":
        options.leagueId = next();
        break;
      case "--site-dir":
        options.siteDir = next();
        break;
      case "--cache-dir":
        options.cacheDir = next();
        break;
      case "--runs-root":
        options.runsRootDir = next();
        break;
      case "--max-rendered":
        options.maxRenderedEpisodes = Number(next());
        break;
      case "--meta-limit":
        options.episodeMetaLimit = Number(next());
        break;
      case "--retain-raw":
        options.maxRetainedCacheFiles = Number(next());
        break;
      case "--retain-bundles":
        options.maxRetainedRunDirectories = Number(next());
        break;
      case "--summary-archive":
        options.summaryArchiveDir = next();
        break;
      case "--pin-manifest":
        options.retentionPinManifestPath = next();
        break;
      case "--min-free-gib":
        options.minimumFreeBytes = Number(next()) * 1024 * 1024 * 1024;
        break;
      case "--no-unpack":
        options.unpackRunDirs = false;
        break;
      case "--recover-pins-only":
        options.recoverPinnedArtifacts = true;
        break;
      case "--watch":
        options.watch = true;
        break;
      case "--interval-seconds":
        options.intervalSeconds = Math.max(60, Number(next()));
        break;
      case "--suppression-contract": {
        const value = next();
        if (!path.isAbsolute(value)) {
          throw new Error(
            `--suppression-contract must be an absolute path: ${value}`,
          );
        }
        options.suppressionContractPath = value;
        break;
      }
      case "--premiere-archive-index": {
        const value = next();
        if (!path.isAbsolute(value)) {
          throw new Error(
            `--premiere-archive-index must be an absolute path: ${value}`,
          );
        }
        options.premiereArchiveIndexPath = value;
        break;
      }
      case "--latest-premiere": {
        const value = next();
        if (!path.isAbsolute(value)) {
          throw new Error(
            `--latest-premiere must be an absolute path: ${value}`,
          );
        }
        options.latestPremierePointerPath = value;
        break;
      }
      case "--premiere-probe-origin": {
        const value = next();
        if (!/^https?:\/\/[^/\s]+$/.test(value)) {
          throw new Error(
            `--premiere-probe-origin must be a bare http(s) origin: ${value}`,
          );
        }
        options.premiereProbeOrigin = value;
        break;
      }
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (
    !Number.isFinite(options.maxRenderedEpisodes) ||
    options.maxRenderedEpisodes < 1 ||
    !Number.isFinite(options.episodeMetaLimit) ||
    options.episodeMetaLimit < 1 ||
    !Number.isInteger(options.maxRetainedCacheFiles) ||
    options.maxRetainedCacheFiles < options.maxRenderedEpisodes ||
    !Number.isInteger(options.maxRetainedRunDirectories) ||
    options.maxRetainedRunDirectories < options.maxRenderedEpisodes ||
    !Number.isFinite(options.minimumFreeBytes) ||
    options.minimumFreeBytes < 10 * 1024 * 1024 * 1024 ||
    !Number.isFinite(options.intervalSeconds)
  ) {
    throw new Error(
      "Numeric flags must be positive; retention must cover rendered episodes and preserve at least 10 GiB free",
    );
  }
  if (
    options.recoverPinnedArtifacts &&
    (options.watch || !options.unpackRunDirs)
  ) {
    throw new Error(
      "--recover-pins-only requires bundle unpacking and cannot run in watch mode",
    );
  }
  return options;
}

const readVerbs = new Set([
  "leagues",
  "results",
  "memberships",
  "rounds",
  "replays",
]);

async function coworldJson(args: string[]): Promise<unknown> {
  const verb = args[0];
  if (!readVerbs.has(verb)) {
    throw new Error(`Refusing non-read coworld verb: ${verb}`);
  }
  const { stdout } = await execFileAsync(
    "uvx",
    ["coworld", ...args, "--json"],
    { timeout: 180_000, maxBuffer: 128 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as unknown;
}

async function downloadReplay(
  replayUrl: string,
  destinationPath: string,
  minimumFreeBytes: number,
): Promise<void> {
  if (!replayUrl.startsWith("https://")) {
    throw new Error(`Refusing non-https replay URL: ${replayUrl}`);
  }
  const response = await fetch(replayUrl);
  if (!response.ok) {
    throw new Error(
      `Replay download failed (${response.status}): ${replayUrl}`,
    );
  }
  const contentLengthHeader = response.headers.get("content-length");
  const parsedContentLength =
    contentLengthHeader === null ? null : Number(contentLengthHeader);
  const contentLength =
    parsedContentLength !== null &&
    Number.isFinite(parsedContentLength) &&
    parsedContentLength >= 0
      ? parsedContentLength
      : null;
  if (contentLength !== null && contentLength > maximumReplayBytes) {
    throw new Error(
      `Replay download exceeds ${maximumReplayBytes} byte limit: ${replayUrl}`,
    );
  }
  await requireMinimumDiskSpace(
    path.dirname(destinationPath),
    minimumFreeBytes,
    contentLength ?? maximumReplayBytes,
  );
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > maximumReplayBytes) {
    throw new Error(
      `Replay download exceeds ${maximumReplayBytes} byte limit: ${replayUrl}`,
    );
  }
  await requireMinimumDiskSpace(
    path.dirname(destinationPath),
    minimumFreeBytes,
    body.byteLength,
  );
  await writeFileAtomic(destinationPath, body);
}

async function writeFileAtomic(
  destinationPath: string,
  contents: Buffer | string,
): Promise<void> {
  const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, destinationPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readPreviousMirrorData(
  siteDir: string,
): Promise<CoworldLeagueMirrorData | null> {
  try {
    const value: unknown = JSON.parse(
      await fs.readFile(path.join(siteDir, "data.json"), "utf8"),
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !Array.isArray((value as { episodes?: unknown }).episodes)
    ) {
      return null;
    }
    return value as CoworldLeagueMirrorData;
  } catch {
    return null;
  }
}

async function ensureEpisodeReplayCached(
  meta: HostedEpisodeMeta,
  cacheDir: string,
  minimumFreeBytes: number,
): Promise<string | null> {
  if (meta.replayUrl === null) {
    return null;
  }
  const cachedPath = coworldLeagueReplayCachePath(
    cacheDir,
    meta.episodeRequestId,
  );
  if (await fileExists(cachedPath)) {
    return cachedPath;
  }
  await downloadReplay(meta.replayUrl, cachedPath, minimumFreeBytes);
  log(`downloaded replay ${meta.episodeRequestId}`);
  return cachedPath;
}

// Bump when bundle contents change shape so existing directories regenerate
// in place on the next sync (files are overwritten, never deleted).
const bundleVersion = "3";

async function unpackEpisodeRunDir(
  replay: ParsedHostedReplay,
  runsRootDir: string,
  minimumFreeBytes: number,
): Promise<{ watchHref: string; fullRenderHref: string; runDir: string } | null> {
  if (replay.spectatorReplay === null) {
    return null;
  }
  // The `league-` prefix is what the beta invite gate's public-league path
  // allowlist keys on — only mirror-written bundles become anonymously
  // viewable, never other run directories.
  const publicRunKey = `league-${replay.runID}`;
  const runDir = await ensureSafeCoworldLeagueRunDirectory(
    runsRootDir,
    publicRunKey,
  );
  const versionPath = path.join(runDir, ".mirror-bundle-version");
  const upToDate =
    (await fileExists(versionPath)) &&
    (await fs.readFile(versionPath, "utf8")).trim() === bundleVersion;
  if (!upToDate) {
    // Point the bundle's own runID at the public key so links generated
    // inside spectator.html (the real-renderer link) resolve publicly.
    const publicSpectatorReplay = {
      ...replay.spectatorReplay,
      runID: publicRunKey,
    } as AgentSpectatorReplay;
    const generatedFiles = [
      ...Object.entries(replay.inlineRunArtifacts),
      [
        "replay-ui.json",
        `${JSON.stringify(buildCoworldReplayUiArtifact(replay.inlineRunArtifacts))}\n`,
      ],
      [
        "spectator-replay.json",
        `${JSON.stringify(publicSpectatorReplay, null, 2)}\n`,
      ],
      ["spectator.html", spectatorHtml(publicSpectatorReplay)],
      [".mirror-bundle-version", `${bundleVersion}\n`],
    ] satisfies Array<[string, string]>;
    const pendingWriteBytes = generatedFiles.reduce(
      (total, [, contents]) => total + Buffer.byteLength(contents),
      0,
    );
    await requireMinimumDiskSpace(
      runsRootDir,
      minimumFreeBytes,
      pendingWriteBytes,
    );
    for (const [name, contents] of generatedFiles) {
      await writeFileAtomic(path.join(runDir, name), contents);
    }
  }
  const encodedRunKey = encodeURIComponent(publicRunKey);
  return {
    watchHref: `/ai-league-runs/${encodedRunKey}/spectator.html`,
    fullRenderHref: `/ai-league-replay/${encodedRunKey}`,
    runDir,
  };
}

/**
 * Product overhaul spec Stage 5: reads `director-cut-plan.json` from an
 * episode's unpacked run directory, when one exists. Tolerant of absence —
 * a missing file (the common case: the hosted platform doesn't inline this
 * artifact today, so it's only ever present for episodes a LOCAL run wrote
 * one for) or any other read failure resolves to `null`, exactly like
 * every other optional-artifact path in this mirror. Parsing itself is
 * delegated to the pure, unit-tested `parseDirectorCutPlanSummary`.
 */
async function readDirectorCutSummaryFromRunDir(
  runDir: string,
): Promise<{ durationEstimateSeconds: number; segmentCount: number } | null> {
  try {
    const raw = await fs.readFile(
      path.join(runDir, "director-cut-plan.json"),
      "utf8",
    );
    return parseDirectorCutPlanSummary(raw);
  } catch {
    return null;
  }
}

function log(message: string): void {
  console.log(`[league-mirror ${new Date().toISOString()}] ${message}`);
}

/**
 * Read the premiere-suppression contract, or resolve to a stale (non-
 * suppressing) state when no contract path is configured. Fail-open: any
 * unreadable/corrupt/stale contract also resolves to a stale state inside
 * {@link loadPremiereSuppressionContract}, so this never throws and never
 * blocks publication.
 */
async function readSuppressionState(
  options: MirrorOptions,
  now: Date = new Date(),
): Promise<PremiereSuppressionState> {
  if (options.suppressionContractPath === null) {
    return { status: "stale", reason: "not_configured" };
  }
  return loadPremiereSuppressionContract(options.suppressionContractPath, now);
}

const maximumPremiereArchiveIndexBytes = 64 * 1024 * 1024;

/**
 * Read the replay-premiere archive index into its mirror projection: REVEALED
 * premiere ids for battle-card links plus the known-id/newest-revealed view
 * the latest-premiere card cross-checks against. Fail-open on every failure
 * mode — not configured, missing (the normal pre-first-premiere state),
 * unreadable, not a regular file, or oversized — the mirror then publishes
 * without premiere links rather than degrading the feed. A link appears on
 * the first mirror cycle after the premiere's terminal reclamation (≤ ~30
 * minutes after reveal); revealed-but-not-yet-reclaimed premieres are
 * intentionally not linked, so this reader never has to touch the live
 * premiere catalog.
 */
async function readPremiereArchiveIndex(
  options: MirrorOptions,
): Promise<PremiereArchiveIndexSummary | null> {
  if (options.premiereArchiveIndexPath === null) {
    return null;
  }
  try {
    const indexStat = await fs.stat(options.premiereArchiveIndexPath);
    if (
      !indexStat.isFile() ||
      indexStat.size > maximumPremiereArchiveIndexBytes
    ) {
      log(
        "premiere archive index skipped (not a regular file or over the byte ceiling); publishing without premiere links",
      );
      return null;
    }
    const summary = summarizePremiereArchiveIndex(
      await fs.readFile(options.premiereArchiveIndexPath, "utf8"),
    );
    log(
      `premiere archive index: ${summary.revealedIds.size} revealed premiere(s)`,
    );
    return summary;
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : null;
    if (code !== "ENOENT") {
      log(
        `premiere archive index unreadable; publishing without premiere links: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return null;
  }
}

/**
 * Resolve the "Latest premiere" card for this cycle, or null when the feature
 * is off (`--latest-premiere` not passed) or nothing revealed is known.
 * Fail-open end to end: the pointer read tolerates missing/unreadable/
 * malformed/oversized files, the resolver drops a pointer the archive index
 * contradicts and falls back to the index's newest revealed entry, and any
 * failure here only costs the card — never the cycle.
 */
async function readLatestPremiereCard(
  options: MirrorOptions,
  archiveIndex: PremiereArchiveIndexSummary | null,
): Promise<ReturnType<typeof resolveLatestRevealedPremiere>> {
  if (options.latestPremierePointerPath === null) {
    return null;
  }
  const pointer = await loadLatestPremierePointer(
    options.latestPremierePointerPath,
  );
  const latest = await selectServingLatestPremiere(
    pointer,
    archiveIndex,
    latestPremiereProbe(options),
  );
  if (latest !== null) {
    log(
      `latest premiere card: ${latest.premiereId} (${
        pointer !== null && pointer.premiereId === latest.premiereId
          ? "pointer"
          : "archive-index fallback"
      })`,
    );
  } else if (pointer !== null) {
    log(
      `latest premiere card omitted: no candidate page is serving (pointer ${pointer.premiereId})`,
    );
  }
  return latest;
}

/**
 * Bounded page probe for latest-premiere candidates. With no
 * `--premiere-probe-origin` the probe trusts every candidate (legacy
 * behavior). With an origin, a candidate must answer 200 on its
 * `/premiere/<id>` page within 2.5 s; any error, timeout, or non-200 drops
 * it. Probe failures never fail the cycle — worst case the card is omitted
 * for this cycle and returns when the page serves.
 */
function latestPremiereProbe(
  options: MirrorOptions,
): (premiereId: string) => Promise<boolean> {
  const origin = options.premiereProbeOrigin;
  if (origin === null) {
    return async () => true;
  }
  return async (premiereId: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    try {
      const response = await fetch(
        `${origin}/premiere/${encodeURIComponent(premiereId)}`,
        { method: "GET", redirect: "manual", signal: controller.signal },
      );
      await response.body?.cancel().catch(() => undefined);
      return response.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function pruneMirrorArtifacts(
  options: MirrorOptions,
  protectedEpisodes: CoworldLeagueEpisodeRow[],
): Promise<void> {
  const publishedReferences =
    retentionReferencesFromEpisodes(protectedEpisodes);
  const pinnedReferences = await readCoworldLeagueRetentionPins(
    options.retentionPinManifestPath,
  );
  const result = await pruneCoworldLeagueMirrorArtifacts({
    cacheDir: options.cacheDir,
    runsRootDir: options.runsRootDir,
    summaryArchiveDir: options.summaryArchiveDir,
    protectedEpisodeRequestIds: new Set([
      ...publishedReferences.episodeRequestIds,
      ...pinnedReferences.episodeRequestIds,
    ]),
    protectedPublicRunKeys: new Set([
      ...publishedReferences.publicRunKeys,
      ...pinnedReferences.publicRunKeys,
    ]),
    maxRetainedCacheFiles: options.maxRetainedCacheFiles,
    maxRetainedRunDirectories: options.maxRetainedRunDirectories,
  });
  if (result.cacheFilesPruned > 0 || result.runDirectoriesPruned > 0) {
    log(
      `pruned ${result.cacheFilesPruned} cached replay(s) and ${result.runDirectoriesPruned} rendered run bundle(s); retaining newest ${options.maxRetainedCacheFiles} raw replay(s), newest ${options.maxRetainedRunDirectories} bundle(s), published battles, and durable pins`,
    );
  }
}

async function syncOnce(options: MirrorOptions): Promise<void> {
  await fs.mkdir(options.cacheDir, { recursive: true });
  const previousData = await readPreviousMirrorData(options.siteDir);
  if (previousData !== null) {
    await pruneMirrorArtifacts(options, previousData.episodes);
  }
  const [leagueRaw, divisionsRaw, roundsRaw] = await Promise.all([
    coworldJson(["leagues", options.leagueId]),
    coworldJson(["results", options.leagueId]),
    coworldJson(["rounds", "-l", options.leagueId, "--limit", "40"]),
  ]);
  const league = parseLeagueSummary(leagueRaw);
  if (league === null) {
    throw new Error(`League ${options.leagueId} not found or unreadable`);
  }
  const division = pickCompetitionDivision(divisionsRaw);
  if (division === null) {
    throw new Error(`League ${options.leagueId} has no readable division`);
  }
  const [standingsRaw, championMembershipRead, replayRead] = await Promise.all([
    coworldJson(["results", division.id]),
    // Results retain the policy label that owns the historical rating. Fetch
    // current champion memberships separately instead of relabeling that score.
    coworldJson([
      "memberships",
      "-d",
      division.id,
      "--active-only",
      "--champions-only",
      "--limit",
      "1000",
    ])
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => {
        log(
          `champion memberships unavailable; publishing qualified rating rows only: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { ok: false as const };
      }),
    coworldJson([
      "replays",
      "-d",
      division.id,
      "--limit",
      String(options.recoverPinnedArtifacts ? 1000 : options.episodeMetaLimit),
    ])
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => {
        log(
          `replay feed unavailable; retaining last published battles: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { ok: false as const };
      }),
  ]);

  const standings = buildStandingRows(
    standingsRaw,
    championMembershipRead.ok ? championMembershipRead.value : [],
  );
  const rounds = buildRoundRows(roundsRaw, options.roundsShown);
  const roundNumbers = roundNumberByRoundId(roundsRaw);
  let replayStorageAvailable =
    (await minimumAvailableDiskBytes([
      options.cacheDir,
      options.runsRootDir,
    ])) >= options.minimumFreeBytes;
  if (!replayStorageAvailable) {
    log(
      `replay storage reserve is below ${Math.ceil(options.minimumFreeBytes / (1024 * 1024))} MiB; retaining published battles without downloading`,
    );
  }
  const episodeMetas =
    replayRead.ok && replayStorageAvailable
      ? parseCompletedEpisodeMetaList(replayRead.value)
      : [];
  const recoveryReferences = options.recoverPinnedArtifacts
    ? await readCoworldLeagueRetentionPins(options.retentionPinManifestPath)
    : null;
  // Revealed premieres, for spoiler-safe battle-card links and the latest-
  // premiere card's cross-check/fallback. Read once per cycle; fail-open to an
  // absent summary (cards simply carry no premiere link, no latest card
  // fallback).
  const premiereArchiveIndex = await readPremiereArchiveIndex(options);
  const revealedPremiereIds =
    premiereArchiveIndex?.revealedIds ?? new Set<string>();
  // Read the contract at cycle start to log/observe suppression status. Only
  // the cycle-start OBSERVATION is skipped during operator-driven pinned-artifact
  // recovery; the final-defense filter below still runs unconditionally, so a
  // held/quarantined episode is spoiler-shielded even on the recovery path.
  const suppressionAtCycleStart =
    recoveryReferences === null ? await readSuppressionState(options) : null;
  if (
    options.suppressionContractPath !== null &&
    suppressionAtCycleStart !== null
  ) {
    log(
      suppressionAtCycleStart.status === "active"
        ? `premiere suppression active (${suppressionAtCycleStart.contract.holds.length} hold(s))`
        : `premiere suppression inactive (contract ${suppressionAtCycleStart.reason})`,
    );
  }
  const episodeMetasToProcess = (
    recoveryReferences === null
      ? episodeMetas.slice(0, options.maxRenderedEpisodes)
      : episodeMetas.filter((meta) =>
          recoveryReferences.episodeRequestIds.has(meta.episodeRequestId),
        )
  ).filter((meta) => {
    if (suppressionAtCycleStart === null) {
      return true;
    }
    const decision = classifyEpisodeSuppression(
      suppressionAtCycleStart,
      meta,
      new Date(),
    );
    if (decision !== "publish") {
      log(
        `episode ${meta.episodeRequestId} ${
          decision === "held"
            ? "held for premiere — excluded"
            : "deferred this cycle (premiere quarantine)"
        }`,
      );
    }
    return decision === "publish";
  });

  const freshEpisodes: CoworldLeagueEpisodeRow[] = [];
  const recoveredEpisodeRequestIds = new Set<string>();
  let replayEpisodeFailures = 0;
  for (const meta of episodeMetasToProcess) {
    try {
      // Re-read the contract immediately before unpack/card build so a claim
      // that lands mid-cycle still suppresses this episode (shrinks the
      // in-flight race). Stale/absent contract keeps this a no-op.
      if (recoveryReferences === null) {
        const decision = classifyEpisodeSuppression(
          await readSuppressionState(options),
          meta,
          new Date(),
        );
        if (decision !== "publish") {
          log(
            `episode ${meta.episodeRequestId} suppressed before unpack (${
              decision === "held" ? "premiere hold" : "premiere quarantine"
            })`,
          );
          continue;
        }
      }
      if (
        (await minimumAvailableDiskBytes([
          options.cacheDir,
          options.runsRootDir,
        ])) < options.minimumFreeBytes
      ) {
        replayStorageAvailable = false;
        log(
          "replay storage reserve was exhausted during sync; stopping downloads",
        );
        break;
      }
      const cachedPath = await ensureEpisodeReplayCached(
        meta,
        options.cacheDir,
        options.minimumFreeBytes,
      );
      if (cachedPath === null) {
        replayEpisodeFailures += 1;
        log(`episode ${meta.episodeRequestId} has no replay URL yet`);
        continue;
      }
      const payload: unknown = JSON.parse(
        await fs.readFile(cachedPath, "utf8"),
      );
      const replay = parseHostedReplayPayload(payload);
      if (replay === null) {
        replayEpisodeFailures += 1;
        log(`skipping ${meta.episodeRequestId}: unrecognized replay payload`);
        continue;
      }
      const unpacked = options.unpackRunDirs
        ? await unpackEpisodeRunDir(
            replay,
            options.runsRootDir,
            options.minimumFreeBytes,
          )
        : null;
      if (
        recoveryReferences !== null &&
        (unpacked === null ||
          recoveryReferences.publicRunKeyByEpisodeRequestId.get(
            meta.episodeRequestId,
          ) !== `league-${replay.runID}`)
      ) {
        throw new Error(
          `Pinned replay ${meta.episodeRequestId} did not produce its declared run bundle`,
        );
      }
      const directorCut =
        unpacked !== null
          ? await readDirectorCutSummaryFromRunDir(unpacked.runDir)
          : null;
      freshEpisodes.push(
        buildEpisodeRow({
          meta,
          replay,
          roundNumber:
            meta.roundId === null
              ? null
              : (roundNumbers.get(meta.roundId) ?? null),
          watchHref: unpacked?.watchHref ?? null,
          fullRenderHref: unpacked?.fullRenderHref ?? null,
          premiereHref: premiereHrefForEpisode(
            meta.episodeRequestId,
            revealedPremiereIds,
          ),
          directorCut,
        }),
      );
      recoveredEpisodeRequestIds.add(meta.episodeRequestId);
    } catch (error) {
      if (error instanceof CoworldLeagueDiskReserveError) {
        replayStorageAvailable = false;
        log(error.message);
        break;
      }
      replayEpisodeFailures += 1;
      log(
        `episode ${meta.episodeRequestId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (recoveryReferences !== null) {
    const missing = [...recoveryReferences.episodeRequestIds].filter(
      (episodeRequestId) => !recoveredEpisodeRequestIds.has(episodeRequestId),
    );
    if (missing.length > 0 || replayEpisodeFailures > 0) {
      throw new Error(
        `Pinned replay recovery incomplete; missing ${missing.join(", ") || "none"}; failures ${replayEpisodeFailures}`,
      );
    }
    log(`recovered ${recoveredEpisodeRequestIds.size} pinned replay bundle(s)`);
    return;
  }

  const replayFeedStale =
    !replayRead.ok || !replayStorageAvailable || replayEpisodeFailures > 0;
  const episodes =
    replayRead.ok && replayStorageAvailable
      ? replayFeedStale
        ? mergeEpisodeRows(
            freshEpisodes,
            previousData?.episodes ?? [],
            options.maxRenderedEpisodes,
          )
        : freshEpisodes
      : (previousData?.episodes ?? []).slice(0, options.maxRenderedEpisodes);
  if (replayEpisodeFailures > 0) {
    log(
      `${replayEpisodeFailures} replay episode(s) failed; retaining available previous battle cards`,
    );
  }

  // Final defense: mergeEpisodeRows retains previously-published cards, so a
  // card published before a premiere claim can still be in `episodes`. Re-read
  // the contract and filter held/quarantined episodes out of the MERGED list
  // before it reaches data.json. Stale/absent contract returns the list
  // unchanged, so the mirror output stays byte-identical to today.
  const finalSuppression = await readSuppressionState(options);
  const publishedEpisodes = filterSuppressedEpisodeRows(
    finalSuppression,
    episodes,
    new Date(),
  );
  if (publishedEpisodes.length !== episodes.length) {
    log(
      `premiere suppression removed ${
        episodes.length - publishedEpisodes.length
      } card(s) from the merged episode list`,
    );
  }
  const premiere = buildPremiereSiteBlock(finalSuppression, new Date());
  // Latest REVEALED premiere for the between-premieres card. Read late (after
  // the final suppression read) so a reveal that lands mid-cycle is already
  // visible. Feature-gated on --latest-premiere; the site writer gives the
  // live card precedence, so data.json may carry both while only one renders.
  const latestPremiere = await readLatestPremiereCard(
    options,
    premiereArchiveIndex,
  );

  const now = new Date().toISOString();
  const data: CoworldLeagueMirrorData = {
    generatedAt: now,
    lastGoodSyncAt: now,
    stale: false,
    championFeedStale: !championMembershipRead.ok,
    replayFeedStale,
    lastGoodReplaySyncAt: replayFeedStale
      ? (previousData?.lastGoodReplaySyncAt ??
        previousData?.lastGoodSyncAt ??
        null)
      : now,
    league: {
      id: league.id,
      name: league.name,
      description: league.description,
      divisionName: division.name,
      roundIntervalMinutes: league.roundIntervalMinutes,
      episodesPerRound: league.episodesPerRound,
      currentRoundNumber: rounds[0]?.roundNumber ?? null,
      currentRoundStatus: rounds[0]?.status ?? null,
      scoreLabel: scoreLabelFromStandings(standingsRaw),
    },
    standings,
    rounds,
    episodes: publishedEpisodes,
    // Only present when a premiere is currently claimed; omitting the key keeps
    // stale/absent-contract output byte-identical to pre-premiere behavior.
    ...(premiere !== null ? { premiere } : {}),
    // Additive: only present when --latest-premiere resolved a revealed
    // premiere; omitted otherwise so existing consumers see identical output.
    ...(latestPremiere !== null ? { latestPremiere } : {}),
    links: {
      enterTheLeagueUrl: options.starterUrl,
      platformLabel: "Softmax Coworld",
    },
  };
  const paths = await writeCoworldLeagueSite(options.siteDir, data);
  log(
    `site updated: ${paths.indexPath} (${standings.length} standings, ${publishedEpisodes.length} battles)`,
  );
  await pruneMirrorArtifacts(options, data.episodes);
}

async function regenerateStaleSite(options: MirrorOptions): Promise<boolean> {
  try {
    await markCoworldLeagueSiteStale(options.siteDir);
    log("sync failed — regenerated site from last good data (stale banner)");
    return true;
  } catch {
    return false;
  }
}

async function runSyncIteration(options: MirrorOptions): Promise<boolean> {
  try {
    return await withCoworldLeagueMirrorOperationLock(
      options.siteDir,
      async () => {
        try {
          await syncOnce(options);
          return true;
        } catch (error) {
          const degraded = await regenerateStaleSite(options);
          log(
            `sync failed${degraded ? " (stale site kept)" : ""}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return false;
        }
      },
    );
  } catch (error) {
    log(
      `sync skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  requireSafeCoworldLeagueRetentionLayout(
    options.siteDir,
    options.runsRootDir,
    options.cacheDir,
    options.summaryArchiveDir,
  );
  if (!options.watch) {
    if (!(await runSyncIteration(options))) {
      process.exitCode = 1;
    }
    return;
  }
  log(
    `watching league ${options.leagueId} every ${options.intervalSeconds}s — Ctrl-C to stop`,
  );
  for (;;) {
    await runSyncIteration(options);
    await new Promise((resolve) =>
      setTimeout(resolve, options.intervalSeconds * 1000),
    );
  }
}

void main();
