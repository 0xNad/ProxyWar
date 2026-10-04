import path from "node:path";
import {
  FRONTIER_FOUR_GAMES_FILE,
  publishFrontierFourWorld,
  restoreLeagueWorldSource,
} from "../server/agents/FrontierFourWorld";

/**
 * Publishes the Frontier Four world into the league site directory.
 *
 *   tsx src/scripts/frontier-four-publish.ts --site-dir <dir> [--games <file>]
 *   tsx src/scripts/frontier-four-publish.ts --site-dir <dir> --restore-league
 *
 * The scheduler runs the first form after every completed game. The second
 * hands `world.json` back to the league mirror.
 */
function parseArgs(argv: readonly string[]): {
  siteDir: string;
  gamesPath: string | null;
  restoreLeague: boolean;
} {
  let siteDir = path.join("artifacts", "ai-league-runs", "league");
  let gamesPath: string | null = null;
  let restoreLeague = false;
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
        siteDir = next();
        break;
      case "--games":
        gamesPath = next();
        break;
      case "--restore-league":
        restoreLeague = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { siteDir, gamesPath, restoreLeague };
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
