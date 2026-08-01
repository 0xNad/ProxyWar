import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseValueArg, runSeasonComplete } from "./season-lib";

/** `season:complete --season=<id>` — walks an `active` Season to the terminal `completed` state. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seasonId = parseValueArg(argv, "--season=");
  if (seasonId === undefined) {
    console.error("usage: season:complete --season=<id>");
    process.exitCode = 1;
    return;
  }
  const result = await runSeasonComplete(seasonId);
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
