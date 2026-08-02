import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStore, resolveRootOverrides, validateSchedule } from "./premiere-schedule-lib";

/**
 * `premiere:validate` — Stage 3 item 3's schedule-consistency check.
 * Reads the whole `FeaturedMatch` store and reports every scheduling
 * problem found (see `validateSchedule`'s doc: past-dated slots,
 * schedule collisions, and a scheduled record whose source queue item has
 * since vanished from `ready/`). Exits non-zero when any issue is found —
 * safe to run from a cron/CI step ahead of `premiere:publish`.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const roots = resolveRootOverrides(argv);
  const json = argv.includes("--json");

  const { store } = await loadStore(roots);
  const issues = await validateSchedule(store.matches, roots);

  if (json) {
    console.log(
      JSON.stringify({ ok: issues.length === 0, issueCount: issues.length, issues }, null, 2),
    );
  } else if (issues.length === 0) {
    console.log(`premiere:validate — ok (${store.matches.length} record(s) checked)`);
  } else {
    console.log(`premiere:validate — ${issues.length} issue(s):`);
    for (const issue of issues) {
      console.log(`  [${issue.matchId}] ${issue.reason}`);
    }
  }
  if (issues.length > 0) process.exitCode = 1;
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
