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
  parseHostedReplayPayload,
  parseLeagueSummary,
  pickCompetitionDivision,
  roundNumberByRoundId,
  scoreLabelFromStandings,
  type HostedEpisodeMeta,
  type ParsedHostedReplay,
} from "../server/agents/CoworldLeagueMirrorCore";
import { withCoworldLeagueMirrorOperationLock } from "../server/agents/CoworldLeagueMirrorOperationLock";
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
): Promise<{ watchHref: string; fullRenderHref: string } | null> {
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
  };
}

function log(message: string): void {
  console.log(`[league-mirror ${new Date().toISOString()}] ${message}`);
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
  const episodeMetasToProcess =
    recoveryReferences === null
      ? episodeMetas.slice(0, options.maxRenderedEpisodes)
      : episodeMetas.filter((meta) =>
          recoveryReferences.episodeRequestIds.has(meta.episodeRequestId),
        );

  const freshEpisodes: CoworldLeagueEpisodeRow[] = [];
  const recoveredEpisodeRequestIds = new Set<string>();
  let replayEpisodeFailures = 0;
  for (const meta of episodeMetasToProcess) {
    try {
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
    episodes,
    links: {
      enterTheLeagueUrl: options.starterUrl,
      platformLabel: "Softmax Coworld",
    },
  };
  const paths = await writeCoworldLeagueSite(options.siteDir, data);
  log(
    `site updated: ${paths.indexPath} (${standings.length} standings, ${episodes.length} battles)`,
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
