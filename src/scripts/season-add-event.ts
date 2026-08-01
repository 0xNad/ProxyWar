import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseValueArg, runSeasonAddEvent, runSeasonAddStandingsSnapshot } from "./season-lib";

/**
 * `season:add-event --season=<id> --featured=<feat_id> [--scheduled-at=<ISO>] [--archive]`
 * — folds one `FeaturedMatch` id into a Season's programme (a scheduled
 * flagship/highlight slot by default, or the archive refs with
 * `--archive` — see `SeasonRegistry.ts`'s `addEventSlot`/`addArchiveMatch`).
 *
 * `season:add-event --season=<id> --standings-snapshot=<generatedAt> --label=<text>`
 * appends an official Coworld standings snapshot REFERENCE instead (never
 * a score copy — see `SeasonStandingsSnapshotRefSchema`'s own doc); the
 * two operations share one entry point since both are "attach this
 * season to one more piece of programme content" and the doc's CLI list
 * names only five verbs total.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seasonId = parseValueArg(argv, "--season=");
  if (seasonId === undefined) {
    console.error(
      "usage: season:add-event --season=<id> --featured=<feat_id> [--scheduled-at=<ISO>] [--archive]\n" +
        "   or: season:add-event --season=<id> --standings-snapshot=<generatedAtISO> --label=<text>",
    );
    process.exitCode = 1;
    return;
  }
  const snapshotGeneratedAt = parseValueArg(argv, "--standings-snapshot=");
  if (snapshotGeneratedAt !== undefined) {
    const label = parseValueArg(argv, "--label=");
    if (label === undefined) {
      console.error("usage: season:add-event --season=<id> --standings-snapshot=<generatedAtISO> --label=<text>");
      process.exitCode = 1;
      return;
    }
    const result = await runSeasonAddStandingsSnapshot(seasonId, snapshotGeneratedAt, label);
    console.log(result.message);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const featuredMatchId = parseValueArg(argv, "--featured=");
  if (featuredMatchId === undefined) {
    console.error("usage: season:add-event --season=<id> --featured=<feat_id> [--scheduled-at=<ISO>] [--archive]");
    process.exitCode = 1;
    return;
  }
  const scheduledAt = parseValueArg(argv, "--scheduled-at=") ?? null;
  const result = await runSeasonAddEvent({
    seasonId,
    featuredMatchId,
    scheduledAt,
    archive: argv.includes("--archive"),
  });
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
