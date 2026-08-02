import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseValueArg, runSeasonActivate } from "./season-lib";

/**
 * `season:activate --season=<id>` — walks a `draft` Season to `active`.
 * Refuses if another season is already active (see `activateSeason`'s own
 * doc) or the season isn't in `draft`.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seasonId = parseValueArg(argv, "--season=");
  if (seasonId === undefined) {
    console.error("usage: season:activate --season=<id>");
    process.exitCode = 1;
    return;
  }
  const result = await runSeasonActivate(seasonId);
  console.log(result.message);
  if (!result.ok) process.exitCode = 1;
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
