import fs from "node:fs/promises";
import path from "node:path";
import { publishFrontierForm } from "../server/agents/FrontierForm";
import {
  FRONTIER_DEFAULT_BATTLE_TIMES_UTC,
  FRONTIER_FOUR_GAMES_FILE,
  FRONTIER_SEASON_TWO_TEAMS,
  frontierSchedulerFacts,
  parseFrontierBattleTimes,
  parseFrontierRoster,
  publishFrontierFourWorld,
  publishFrontierWorld,
  restoreLeagueWorldSource,
  type FrontierFourTeam,
} from "../server/agents/FrontierFourWorld";

/**
 * Publishes the Frontier world into the league site directory.
 *
 *   Season 2 (world.json, frontier-form.json, the match rows):
 *   tsx src/scripts/frontier-four-publish.ts --site-dir <dir> --ffa-games <file>
 *       [--season1-games <file>] [--roster <json file>]
 *       [--scheduler-config <file>] [--scheduler-state <file>]
 *       [--battle-times 13:00,19:00] [--next-battle-at <iso>|none]
 *
 *   Season 1 (the Frontier Four world, unchanged):
 *   tsx src/scripts/frontier-four-publish.ts --site-dir <dir> [--games <file>]
 *
 *   tsx src/scripts/frontier-four-publish.ts --site-dir <dir> --restore-league
 *
 * The publisher job runs a publish after every completed game. The last form
 * hands `world.json` back to the league mirror.
 *
 * The roster comes from `--roster`, else the scheduler config's `teams`
 * (the models it actually schedules), else the built-in five. The battle
 * times come from `--battle-times`, else the scheduler config's
 * `schedule.times_utc`, else 13:00 and 19:00 UTC. The next battle is
 * `--next-battle-at` (`none`: no battle planned), else the first battle time
 * after now, or after the refill while the scheduler state holds for credits.
 * Both scheduler files are only read. Anything in them the publisher cannot
 * use is reported on stderr and replaced by the default, so the page keeps
 * updating.
 */
interface PublishOptions {
  siteDir: string;
  gamesPath: string | null;
  ffaGamesPath: string | null;
  seasonOneGamesPath: string | null;
  battleTimes: string[] | null;
  nextBattleAt: string | null | undefined;
  schedulerConfigPath: string | null;
  schedulerStatePath: string | null;
  rosterPath: string | null;
  restoreLeague: boolean;
}

function parseArgs(argv: readonly string[]): PublishOptions {
  const options: PublishOptions = {
    siteDir: path.join("artifacts", "ai-league-runs", "league"),
    gamesPath: null,
    ffaGamesPath: null,
    seasonOneGamesPath: null,
    battleTimes: null,
    nextBattleAt: undefined,
    schedulerConfigPath: null,
    schedulerStatePath: null,
    rosterPath: null,
    restoreLeague: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--site-dir":
        options.siteDir = next();
        break;
      case "--games":
        options.gamesPath = next();
        break;
      case "--ffa-games":
        options.ffaGamesPath = next();
        break;
      case "--season1-games":
        options.seasonOneGamesPath = next();
        break;
      case "--battle-times":
        options.battleTimes = parseFrontierBattleTimes(next());
        break;
      case "--next-battle-at": {
        const value = next();
        if (value === "none") {
          options.nextBattleAt = null;
        } else {
          const time = Date.parse(value);
          if (!Number.isFinite(time)) {
            throw new Error(`--next-battle-at needs a time or none: ${value}`);
          }
          options.nextBattleAt = new Date(time).toISOString();
        }
        break;
      }
      case "--roster":
        options.rosterPath = next();
        break;
      case "--scheduler-config":
        options.schedulerConfigPath = next();
        break;
      case "--scheduler-state":
        options.schedulerStatePath = next();
        break;
      case "--restore-league":
        options.restoreLeague = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.ffaGamesPath !== null && options.gamesPath !== null) {
    throw new Error(
      "--games publishes Season 1 and --ffa-games Season 2; pass one",
    );
  }
  return options;
}

/**
 * `--roster` when given (a bad one fails the publish); else the scheduler
 * config's `teams`; else the built-in roster.
 */
async function readRoster(
  rosterPath: string | null,
  schedulerConfig: unknown,
): Promise<FrontierFourTeam[]> {
  if (rosterPath !== null) {
    return parseFrontierRoster(
      JSON.parse(await fs.readFile(rosterPath, "utf8")),
    );
  }
  if (
    typeof schedulerConfig === "object" &&
    schedulerConfig !== null &&
    "teams" in schedulerConfig
  ) {
    try {
      return parseFrontierRoster(schedulerConfig.teams);
    } catch (error) {
      warn(
        `the scheduler config's teams cannot be published (${error instanceof Error ? error.message : String(error)}); using the built-in roster`,
      );
    }
  }
  return [...FRONTIER_SEASON_TWO_TEAMS];
}

function warn(message: string): void {
  console.error(`frontier-four-publish: ${message}`);
}

/** A JSON file's content, or `null` when it is missing or unreadable. */
async function readJsonOrNull(filePath: string | null): Promise<unknown> {
  if (filePath === null) return null;
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.restoreLeague) {
    await restoreLeagueWorldSource(options.siteDir);
    console.log(
      JSON.stringify({ restored: "league", siteDir: options.siteDir }),
    );
    return;
  }
  if (options.ffaGamesPath !== null) {
    const now = new Date().toISOString();
    const schedulerConfig = await readJsonOrNull(options.schedulerConfigPath);
    const scheduler = frontierSchedulerFacts({
      config: schedulerConfig,
      state: await readJsonOrNull(options.schedulerStatePath),
    });
    if (options.battleTimes === null) scheduler.warnings.forEach(warn);
    const publication = await publishFrontierWorld({
      siteDir: options.siteDir,
      gamesPath: options.ffaGamesPath,
      seasonOneGamesPath: options.seasonOneGamesPath,
      now,
      roster: await readRoster(options.rosterPath, schedulerConfig),
      timesUtc: options.battleTimes ??
        scheduler.timesUtc ?? [...FRONTIER_DEFAULT_BATTLE_TIMES_UTC],
      nextBattleAt: options.nextBattleAt,
      holdUntil: scheduler.holdUntil,
    });
    publication.warnings.forEach(warn);
    const { formPath } = await publishFrontierForm({
      siteDir: options.siteDir,
      records: publication.records,
      teams: publication.teams,
      now,
    });
    console.log(
      JSON.stringify({
        mode: "frontier",
        season: publication.season,
        games: publication.games,
        battles: publication.battles,
        worldPath: publication.worldPath,
        episodesPath: publication.episodesPath,
        formPath,
      }),
    );
    return;
  }
  const publication = await publishFrontierFourWorld({
    siteDir: options.siteDir,
    gamesPath:
      options.gamesPath ?? path.join(options.siteDir, FRONTIER_FOUR_GAMES_FILE),
  });
  console.log(JSON.stringify(publication));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
