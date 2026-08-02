import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseValueArg, runSeasonRemoveEvent } from "./season-lib";

/**
 * `season:remove-event --season=<id> --featured=<feat_id> [--json]` — the
 * sanctioned counterpart to `season:add-event` that never existed before
 * this fix. The Season Zero re-activation had to drop an aged-out slot by
 * hand-calling `loadSeasonRegistry`/`saveSeasonRegistry` directly (no CLI
 * existed to do it safely — see `SEASON_ZERO_BASELINE.md` and the
 * runbook's former "Known gaps" entry). This is that CLI: validated
 * (unknown season/slot both report a clear message, never a crash),
 * idempotent (removing an already-absent slot succeeds as a no-op — see
 * `SeasonRegistry.removeEventSlot`'s own doc), and refuses to remove a
 * slot whose event is currently live/airing
 * (`SeasonRegistry.isEventCurrentlyLive` — checked before the mutation
 * runs, so a refusal never partially writes the registry).
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seasonId = parseValueArg(argv, "--season=");
  const featuredMatchId = parseValueArg(argv, "--featured=");
  if (seasonId === undefined || featuredMatchId === undefined) {
    console.error("usage: season:remove-event --season=<id> --featured=<feat_id> [--json]");
    process.exitCode = 1;
    return;
  }
  const result = await runSeasonRemoveEvent({ seasonId, featuredMatchId });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.message);
  }
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
