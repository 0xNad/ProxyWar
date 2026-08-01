import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseValueArg, runSeasonStatus } from "./season-lib";

/** `season:status [--season=<id>]` — prints every registered season (or one), its state, and its programme so far. Read-only. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seasonId = parseValueArg(argv, "--season=");
  console.log(await runSeasonStatus(seasonId));
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
