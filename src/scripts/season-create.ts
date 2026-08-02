import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseValueArg, runSeasonCreate } from "./season-lib";

/**
 * `season:create --slug <slug> --title <title> --start <YYYY-MM-DD> --end <YYYY-MM-DD> [--description <text>]`
 * — Season Zero activation prompt Phase 4's `season:create` operator CLI.
 * Creates a new `draft` Season in the tracked registry
 * (`resources/season/seasons.json` by default — see
 * `SeasonRegistry.ts`). No points system, no auto-activation: an operator
 * runs `season:activate` separately once the programme is ready to go
 * live.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const slug = parseValueArg(argv, "--slug=");
  const title = parseValueArg(argv, "--title=");
  const startDate = parseValueArg(argv, "--start=");
  const endDate = parseValueArg(argv, "--end=");
  const description = parseValueArg(argv, "--description=") ?? "";
  if (slug === undefined || title === undefined || startDate === undefined || endDate === undefined) {
    console.error(
      "usage: season:create --slug=<slug> --title=<title> --start=<YYYY-MM-DD> --end=<YYYY-MM-DD> [--description=<text>]",
    );
    process.exitCode = 1;
    return;
  }
  const result = await runSeasonCreate({ slug, title, description, startDate, endDate });
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
