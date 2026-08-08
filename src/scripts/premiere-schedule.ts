import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadIdentityRegistrySnapshot,
  type IdentityRegistrySnapshot,
} from "../server/identity/IdentityRegistry";
import {
  ensurePremiereParticipants,
  loadStore,
  parseIdArg,
  parseValueArg,
  resolveRootOverrides,
  resolveScheduleTarget,
  upsertRecord,
  validateSchedule,
} from "./premiere-schedule-lib";

/**
 * `premiere:schedule --episode <id> --at <ISO>` — Stage 3 item 3's
 * operator scheduling CLI (product overhaul spec). Resolves `<id>` (a
 * `FeaturedMatch.matchId`, a premiere-queue item's directory name, or its
 * `episodeId`/`experienceRequestId` — see `resolveScheduleTarget`'s doc)
 * to a record, sets it to `scheduledAt: <ISO>` / `state: "scheduled"`,
 * validates the RESULTING schedule (not just the one record) before
 * writing, and persists. No public admin page — this is the entire
 * operator surface for scheduling, per spec.
 *
 * This CLI changes only the `FeaturedMatch` store. Runtime admission and
 * lifecycle transitions remain separate, operator-controlled steps.
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const id = parseIdArg(argv);
  const at = parseValueArg(argv, "--at=");
  if (id === undefined || at === undefined) {
    console.error(
      "usage: premiere:schedule --episode=<id> --at=<ISO-8601> [--queue-root=<dir>] [--artifacts-root=<dir>] [--state-root=<dir>] [--json]",
    );
    process.exitCode = 1;
    return;
  }
  const roots = resolveRootOverrides(argv);
  const json = argv.includes("--json");

  const scheduledMs = Date.parse(at);
  if (Number.isNaN(scheduledMs)) {
    console.error(
      `invalid --at value: "${at}" does not parse as an ISO-8601 date`,
    );
    process.exitCode = 1;
    return;
  }

  const target = await resolveScheduleTarget(id, roots);
  if (!target.found) {
    console.error(`could not schedule "${id}": ${target.reason}`);
    process.exitCode = 1;
    return;
  }
  if (target.record.lane !== "premiere") {
    console.error(
      `cannot schedule "${id}": it is an archive-lane record — archive-lane matches are never premiered (see FeaturedMatch.ts)`,
    );
    process.exitCode = 1;
    return;
  }
  if (target.record.state === "cancelled") {
    console.error(
      `cannot schedule "${id}": it was previously cancelled — this CLI never resurrects a cancelled record (create a fresh one from the queue if the underlying item is still available)`,
    );
    process.exitCode = 1;
    return;
  }

  const identity = await loadIdentityRegistrySnapshot().catch(
    (): IdentityRegistrySnapshot => ({
      builders: [],
      agents: [],
      versions: [],
    }),
  );
  const participants = await ensurePremiereParticipants(
    target.record,
    identity,
    roots,
  );
  if (!participants.ok) {
    console.error(
      `cannot schedule "${id}": participant identity could not be resolved from the sealed bundle — ${participants.reason}`,
    );
    console.error(
      `  a premiere-lane record can never be publicly promotable with an unresolved lineup (EventPackageGate.ts's "no anonymous public Premiere" gate) — fix the sealed bundle, or this candidate cannot be scheduled.`,
    );
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const updated = {
    ...target.record,
    participants: participants.participants,
    scheduledAt: new Date(scheduledMs).toISOString(),
    state: "scheduled" as const,
    updatedAt: now.toISOString(),
  };

  const { store } = await loadStore(roots);
  const proposedMatches = [
    ...store.matches.filter((entry) => entry.matchId !== updated.matchId),
    updated,
  ];
  const issues = await validateSchedule(proposedMatches, {
    ...roots,
    now: () => now,
  });
  const ownIssues = issues.filter((issue) => issue.matchId === updated.matchId);
  if (ownIssues.length > 0) {
    console.error(`refusing to schedule "${id}" — would violate the schedule:`);
    for (const issue of ownIssues) console.error(`  - ${issue.reason}`);
    process.exitCode = 1;
    return;
  }

  const { stateRoot } = await loadStore(roots);
  await upsertRecord(stateRoot, updated);

  if (json) {
    console.log(JSON.stringify({ scheduled: updated }, null, 2));
    return;
  }
  console.log(
    `scheduled ${updated.matchId} (${updated.queueItemName ?? updated.episodeRequestId ?? "?"}) at ${updated.scheduledAt}`,
  );
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
