import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadStore,
  parseIdArg,
  resolveRootOverrides,
  upsertRecord,
  validateSchedule,
} from "./premiere-schedule-lib";
import { syncFeaturedMatchRetentionPin } from "../server/agents/FeaturedMatchRetentionPin";

/**
 * `premiere:publish --episode <id>` — Stage 3 item 3's operator "yes, run
 * this one" finalization step. Transitions a `state: "scheduled"`
 * premiere-lane record to `state: "published"` — the signal a future
 * turn's autocycle-coexistence wiring (see `premiere-schedule.ts`'s
 * module doc) is designed to key off, distinct from merely `"scheduled"`
 * (an operator may schedule several candidates ahead of time without
 * committing to run all of them). Re-runs the same schedule validation
 * `premiere:validate` reports, refusing to publish a record that would
 * leave the schedule in a broken state (past-dated, colliding, or whose
 * source queue item has vanished).
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const id = parseIdArg(argv);
  if (id === undefined) {
    console.error(
      "usage: premiere:publish --episode=<matchId> [--queue-root=<dir>] [--artifacts-root=<dir>] [--state-root=<dir>] [--json]",
    );
    process.exitCode = 1;
    return;
  }
  const roots = resolveRootOverrides(argv);
  const json = argv.includes("--json");

  const { stateRoot, store } = await loadStore(roots);
  const record = store.matches.find(
    (entry) => entry.matchId === id || entry.queueItemName === id || entry.episodeRequestId === id,
  );
  if (record === undefined) {
    console.error(`could not publish "${id}": not found in the FeaturedMatch store — schedule it first`);
    process.exitCode = 1;
    return;
  }
  if (record.lane !== "premiere") {
    console.error(`cannot publish "${id}": archive-lane records are already public — nothing to publish`);
    process.exitCode = 1;
    return;
  }
  if (record.state !== "scheduled") {
    console.error(
      `cannot publish "${id}": state is "${record.state}", expected "scheduled" — schedule it first, or it may already be published/cancelled`,
    );
    process.exitCode = 1;
    return;
  }

  const issues = await validateSchedule(store.matches, roots);
  const ownIssues = issues.filter((issue) => issue.matchId === record.matchId);
  if (ownIssues.length > 0) {
    console.error(`refusing to publish "${id}" — the current schedule has issues:`);
    for (const issue of ownIssues) console.error(`  - ${issue.reason}`);
    process.exitCode = 1;
    return;
  }

  const updated = {
    ...record,
    state: "published" as const,
    updatedAt: new Date().toISOString(),
  };
  await upsertRecord(stateRoot, updated);
  // Best-effort — see FeaturedMatchRetentionPin.ts's own doc for why this
  // may legitimately no-op today (the episode may not have reached the
  // league mirror yet) and self-heals via the next reconcile-on-read pass.
  await syncFeaturedMatchRetentionPin(updated, {
    artifactsRoot: roots.artifactsRoot,
  });

  if (json) {
    console.log(JSON.stringify({ published: updated }, null, 2));
    return;
  }
  console.log(`published ${updated.matchId} — scheduled for ${updated.scheduledAt}`);
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
