import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStore, parseIdArg, resolveRootOverrides, upsertRecord } from "./premiere-schedule-lib";
import { removeFeaturedMatchRetentionPin } from "../server/agents/FeaturedMatchRetentionPin";

/**
 * `premiere:cancel --episode <id>` — Stage 3 item 3's operator override.
 * Transitions any non-terminal premiere-lane record (`scheduled` or
 * `published`) to `state: "cancelled"`, freeing its `scheduledAt` slot
 * (`premiere:validate`'s collision check ignores cancelled records — see
 * `validateSchedule`'s own `active` filter). `cancelled` is terminal:
 * `premiere:schedule` explicitly refuses to resurrect one (build a fresh
 * record from the queue instead, if the underlying queue item is still
 * available). Does NOT delete the record — a cancelled entry stays in the
 * store as an audit trail of what was once planned and pulled.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const id = parseIdArg(argv);
  if (id === undefined) {
    console.error(
      "usage: premiere:cancel --episode=<matchId> [--queue-root=<dir>] [--artifacts-root=<dir>] [--state-root=<dir>] [--json]",
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
    console.error(`could not cancel "${id}": not found in the FeaturedMatch store`);
    process.exitCode = 1;
    return;
  }
  if (record.lane !== "premiere") {
    console.error(`cannot cancel "${id}": archive-lane records are never scheduled — nothing to cancel`);
    process.exitCode = 1;
    return;
  }
  if (record.state !== "scheduled" && record.state !== "published") {
    console.error(
      `cannot cancel "${id}": state is "${record.state}" — only a scheduled or published record can be cancelled`,
    );
    process.exitCode = 1;
    return;
  }

  const updated = {
    ...record,
    state: "cancelled" as const,
    scheduledAt: null,
    updatedAt: new Date().toISOString(),
  };
  await upsertRecord(stateRoot, updated);
  // Never deletes artifacts directly — only removes this record's OWN
  // retention claim (see FeaturedMatchRetentionPin.ts's cooperative-
  // ownership doc); a still-live premiere hold's own pin, if any, survives
  // untouched.
  await removeFeaturedMatchRetentionPin(updated.matchId, {
    artifactsRoot: roots.artifactsRoot,
  });

  if (json) {
    console.log(JSON.stringify({ cancelled: updated }, null, 2));
    return;
  }
  console.log(`cancelled ${updated.matchId}`);
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
