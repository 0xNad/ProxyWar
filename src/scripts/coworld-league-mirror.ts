import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  spectatorHtml,
  type AgentSpectatorReplay,
} from "../server/agents/AgentSpectatorReplay";
import {
  buildEpisodeRow,
  buildRoundRows,
  buildStandingRows,
  parseCompletedEpisodeMetaList,
  parseHostedReplayPayload,
  parseLeagueSummary,
  pickCompetitionDivision,
  roundNumberByRoundId,
  scoreLabelFromStandings,
  type HostedEpisodeMeta,
  type ParsedHostedReplay,
} from "../server/agents/CoworldLeagueMirrorCore";
import {
  coworldLeagueIndexHtml,
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

interface MirrorOptions {
  leagueId: string;
  siteDir: string;
  cacheDir: string;
  runsRootDir: string;
  maxRenderedEpisodes: number;
  episodeMetaLimit: number;
  roundsShown: number;
  unpackRunDirs: boolean;
  starterUrl: string;
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
    unpackRunDirs: true,
    starterUrl:
      process.env.PROXYWAR_LEAGUE_STARTER_URL ??
      "https://github.com/0xNad/proxywar-coworld-starter",
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
      case "--no-unpack":
        options.unpackRunDirs = false;
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
    !Number.isFinite(options.intervalSeconds)
  ) {
    throw new Error("Numeric flags must be positive numbers");
  }
  return options;
}

const readVerbs = new Set(["leagues", "results", "rounds", "replays"]);

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
): Promise<void> {
  if (!replayUrl.startsWith("https://")) {
    throw new Error(`Refusing non-https replay URL: ${replayUrl}`);
  }
  const response = await fetch(replayUrl);
  if (!response.ok) {
    throw new Error(`Replay download failed (${response.status}): ${replayUrl}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  await writeFileAtomic(destinationPath, body);
}

async function writeFileAtomic(
  destinationPath: string,
  contents: Buffer | string,
): Promise<void> {
  const temporaryPath = `${destinationPath}.tmp`;
  await fs.writeFile(temporaryPath, contents);
  await fs.rename(temporaryPath, destinationPath);
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function ensureEpisodeReplayCached(
  meta: HostedEpisodeMeta,
  cacheDir: string,
): Promise<string | null> {
  if (meta.replayUrl === null) {
    return null;
  }
  const cachedPath = path.join(cacheDir, `${meta.episodeRequestId}.replay`);
  if (await fileExists(cachedPath)) {
    return cachedPath;
  }
  await downloadReplay(meta.replayUrl, cachedPath);
  log(`downloaded replay ${meta.episodeRequestId}`);
  return cachedPath;
}

async function unpackEpisodeRunDir(
  replay: ParsedHostedReplay,
  runsRootDir: string,
): Promise<{ watchHrefFromLeagueDir: string; fullRenderHref: string } | null> {
  if (replay.spectatorReplay === null) {
    return null;
  }
  const runDir = path.join(runsRootDir, replay.runID);
  const spectatorPath = path.join(runDir, "spectator.html");
  if (!(await fileExists(spectatorPath))) {
    await fs.mkdir(runDir, { recursive: true });
    for (const [name, contents] of Object.entries(replay.inlineRunArtifacts)) {
      await writeFileAtomic(path.join(runDir, name), contents);
    }
    await writeFileAtomic(
      path.join(runDir, "spectator-replay.json"),
      `${JSON.stringify(replay.spectatorReplay, null, 2)}\n`,
    );
    await writeFileAtomic(
      spectatorPath,
      spectatorHtml(replay.spectatorReplay as AgentSpectatorReplay),
    );
  }
  const encodedRunId = encodeURIComponent(replay.runID);
  return {
    watchHrefFromLeagueDir: `../${encodedRunId}/spectator.html`,
    fullRenderHref: `/ai-league-replay/${encodedRunId}`,
  };
}

function log(message: string): void {
  console.log(`[league-mirror ${new Date().toISOString()}] ${message}`);
}

async function syncOnce(options: MirrorOptions): Promise<void> {
  await fs.mkdir(options.cacheDir, { recursive: true });
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
  const [standingsRaw, replaysRaw] = await Promise.all([
    coworldJson(["results", division.id]),
    coworldJson([
      "replays",
      "-d",
      division.id,
      "--limit",
      String(options.episodeMetaLimit),
    ]),
  ]);

  const standings = buildStandingRows(standingsRaw);
  const rounds = buildRoundRows(roundsRaw, options.roundsShown);
  const roundNumbers = roundNumberByRoundId(roundsRaw);
  const episodeMetas = parseCompletedEpisodeMetaList(replaysRaw);

  const episodes: CoworldLeagueEpisodeRow[] = [];
  for (const meta of episodeMetas.slice(0, options.maxRenderedEpisodes)) {
    try {
      const cachedPath = await ensureEpisodeReplayCached(meta, options.cacheDir);
      if (cachedPath === null) {
        continue;
      }
      const payload: unknown = JSON.parse(await fs.readFile(cachedPath, "utf8"));
      const replay = parseHostedReplayPayload(payload);
      if (replay === null) {
        log(`skipping ${meta.episodeRequestId}: unrecognized replay payload`);
        continue;
      }
      const unpacked = options.unpackRunDirs
        ? await unpackEpisodeRunDir(replay, options.runsRootDir)
        : null;
      episodes.push(
        buildEpisodeRow({
          meta,
          replay,
          roundNumber:
            meta.roundId === null
              ? null
              : (roundNumbers.get(meta.roundId) ?? null),
          watchHref: unpacked?.watchHrefFromLeagueDir ?? null,
          fullRenderHref: unpacked?.fullRenderHref ?? null,
        }),
      );
    } catch (error) {
      log(
        `episode ${meta.episodeRequestId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const now = new Date().toISOString();
  const data: CoworldLeagueMirrorData = {
    generatedAt: now,
    lastGoodSyncAt: now,
    stale: false,
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
}

async function regenerateStaleSite(options: MirrorOptions): Promise<boolean> {
  const dataPath = path.join(options.siteDir, "data.json");
  try {
    const previous = JSON.parse(
      await fs.readFile(dataPath, "utf8"),
    ) as CoworldLeagueMirrorData;
    previous.stale = true;
    previous.generatedAt = new Date().toISOString();
    await writeFileAtomic(
      path.join(options.siteDir, "index.html"),
      coworldLeagueIndexHtml(previous),
    );
    log("sync failed — regenerated index from last good data (stale banner)");
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.watch) {
    try {
      await syncOnce(options);
    } catch (error) {
      const degraded = await regenerateStaleSite(options);
      log(
        `sync failed${degraded ? " (stale site kept)" : ""}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exitCode = 1;
    }
    return;
  }
  log(
    `watching league ${options.leagueId} every ${options.intervalSeconds}s — Ctrl-C to stop`,
  );
  for (;;) {
    try {
      await syncOnce(options);
    } catch (error) {
      await regenerateStaleSite(options);
      log(
        `sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, options.intervalSeconds * 1000),
    );
  }
}

void main();
