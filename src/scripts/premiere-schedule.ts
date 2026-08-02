import path from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  loadIdentityRegistrySnapshot,
  type IdentityRegistrySnapshot,
} from "../server/identity/IdentityRegistry";

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
 * --- Autocycle coexistence (spec Stage 3 item 4) — DESIGN NOTE, NOT WIRED
 * THIS TURN ---
 *
 * This CLI only manages the `FeaturedMatch` store's `scheduledAt`/`state`
 * fields. It does NOT touch `cycle-premiere.sh`, `autocycle-premiere.sh`,
 * or `premiere-queue-lib.sh` — actually admitting a scheduled premiere
 * through the runtime (the thing that would make `/premiere/:id` and
 * `/bet/:id` show it) is explicitly a LATER turn's work ("actual admission
 * wiring of a scheduled premiere through the runtime" — out of scope here).
 * This note documents the intended integration so that turn does not need
 * to rediscover it:
 *
 * 1. `cycle-premiere.sh`'s queue-claiming step today is unconditional FIFO
 *    (`pq_claim "$STAGING/queue-claim"` — oldest `ready/` item, no concept
 *    of "this specific item is scheduled for later"). The wiring point is
 *    a NEW function in `premiere-queue-lib.sh`, e.g. `pq_claim_scheduled_due`,
 *    called BEFORE the existing `pq_claim`:
 *      - Reads this store's `featured-matches.json` (read-only from shell —
 *        a `jq` one-liner, or a tiny `tsx` helper script emitting the due
 *        item's queue-item name on stdout and nothing else on no-match).
 *      - "Due" = a premiere-lane record in `state: "published"` (NOT
 *        merely "scheduled" — `premiere:publish` is the operator's
 *        explicit "yes, actually run this one" signal, matching this
 *        module's own state-machine intent) whose `scheduledAt` has
 *        arrived (within some small lead window, mirroring
 *        `cycle-premiere.sh`'s own `LEAD_MIN` parameter).
 *      - If found: claim THAT SPECIFIC item by name (`mv` it out of
 *        `ready/` directly — `premiere-queue-lib.sh`'s own `pq_claim` only
 *        supports "claim the oldest"; claiming a specific one needs a
 *        sibling function, not a modification of `pq_claim` itself, so
 *        the existing FIFO behavior is untouched byte-for-byte when no
 *        schedule exists).
 *      - If not found: fall through to the EXISTING `pq_claim` (FIFO) →
 *        exhibition fallback chain, EXACTLY as today. This is the
 *        "autocycle fills gaps" behavior spec item 4 asks for, and it is
 *        already what happens for free once the due-check is a pure
 *        addition ahead of the existing call.
 * 2. On successful admission, that future turn should also flip the
 *    `FeaturedMatch` record's `state` to `"revealed"`/`"archived"` at the
 *    appropriate lifecycle point (out of this turn's scope — see
 *    `FeaturedMatch.ts`'s own state-machine doc) and set `revealAt`.
 * 3. This preserves `autocycle-premiere.sh`'s existing settlement-watch
 *    loop and the `/bet` coupling completely unmodified: it still cycles
 *    on the SAME terminal-status detection it does today; the only change
 *    is which item `cycle-premiere.sh` claims when it decides to cycle,
 *    never whether or when it decides to.
 * 4. Concurrency: the shell side's `mv`-based claim is already atomic
 *    (`premiere-queue-lib.sh`'s own doc explains why). The NEW read of
 *    `featured-matches.json` from shell (a raw `jq` read, bypassing
 *    `FeaturedMatch.ts`'s TypeScript API and its locked
 *    `mutateFeaturedMatchStore` entirely) has no such protection today —
 *    that turn must decide whether a lock is needed for THAT shell-side
 *    read (this CLI family's own TypeScript writes ARE already
 *    lock-protected — see `premiere-schedule-lib.ts`'s module doc — but a
 *    raw shell `jq` read participates in no lock at all).
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
    console.error(`invalid --at value: "${at}" does not parse as an ISO-8601 date`);
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
    (): IdentityRegistrySnapshot => ({ builders: [], agents: [], versions: [] }),
  );
  const participants = await ensurePremiereParticipants(target.record, identity, roots);
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
  const issues = await validateSchedule(proposedMatches, { ...roots, now: () => now });
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
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
