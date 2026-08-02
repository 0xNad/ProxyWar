import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStore, parseValueArg, resolveRootOverrides } from "./premiere-schedule-lib";
import { resolveDefaultQueueReadyDir } from "./premiere-candidates";
import type { FeaturedMatch } from "../server/agents/FeaturedMatch";

/**
 * `premiere-autocycle-due.ts --lead-minutes=<N>` — the read-only lookup half
 * of the autocycle coexistence wiring documented in `premiere-schedule.ts`'s
 * module doc ("Autocycle coexistence — DESIGN NOTE"). Prints the DUE queue
 * item's name (a `premiere-queue-lib.sh` `ready/` directory name) on stdout
 * and nothing else on stdout when nothing is due — NEVER throws for "no
 * match", only for a genuinely broken store, so `pq_claim_scheduled_due`'s
 * shell caller can treat "empty output" as its unconditional fall-through
 * signal to plain FIFO `pq_claim`.
 *
 * "Due" (design note point 1): a `lane: "premiere"` record in
 * `state: "published"` (never merely `"scheduled"` — `premiere:publish` is
 * the operator's explicit "yes, run this one" signal) whose `scheduledAt`
 * has entered the admission lead window, i.e.
 * `Date.parse(scheduledAt) - leadMinutes*60_000 <= now`. `cycle-premiere.sh`
 * itself writes admission inputs whose trading window opens `leadMinutes`
 * AFTER admission (its own "writing admission inputs (lead ${LEAD_MIN}m)"
 * step) — so admitting a record exactly `leadMinutes` before its
 * `scheduledAt` is what makes the market open AT `scheduledAt`, not before
 * or long after it. No upper bound on how overdue a record may be: if the
 * previous match ran long and the window has already passed, the record
 * stays due (admitted as soon as autocycle next cycles) rather than being
 * silently skipped — never picking a scheduled item over one that is more
 * overdue avoids a satisfied-but-stale schedule being starved forever by a
 * schedule that keeps growing.
 *
 * Only records whose `queueItemName` still names an item PRESENT in
 * `ready/` are eligible — a record can outlive its queue item (generator
 * behind, or the item already consumed by a previous crash-mid-cycle) and
 * this script must never claim a name that is no longer there; the shell
 * caller's `mv` would already fail safely, but resolving it here keeps the
 * "which is the ONE due item" choice in one place rather than split across
 * languages.
 *
 * Ties (more than one due, eligible record) resolve to the EARLIEST
 * `scheduledAt` — the most overdue (or, if none are overdue, the soonest)
 * item goes first, matching the schedule's own ordering intent.
 */

interface DueOptions {
  leadMinutes: number;
  readyItemNames: ReadonlySet<string>;
  now: Date;
}

export function findDueQueueItemName(
  matches: readonly FeaturedMatch[],
  options: DueOptions,
): string | null {
  const leadMs = options.leadMinutes * 60_000;
  const nowMs = options.now.getTime();
  let best: { queueItemName: string; scheduledAtMs: number } | null = null;
  for (const record of matches) {
    if (record.lane !== "premiere") continue;
    if (record.state !== "published") continue;
    if (record.queueItemName === null) continue;
    if (record.scheduledAt === null) continue;
    if (!options.readyItemNames.has(record.queueItemName)) continue;
    const scheduledAtMs = Date.parse(record.scheduledAt);
    if (Number.isNaN(scheduledAtMs)) continue;
    if (scheduledAtMs - leadMs > nowMs) continue; // not due yet
    if (best === null || scheduledAtMs < best.scheduledAtMs) {
      best = { queueItemName: record.queueItemName, scheduledAtMs };
    }
  }
  return best === null ? null : best.queueItemName;
}

async function listReadyItemNames(readyDir: string): Promise<Set<string>> {
  const fs = await import("node:fs/promises");
  try {
    const entries = await fs.readdir(readyDir, { withFileTypes: true });
    return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const leadMinutesRaw = parseValueArg(argv, "--lead-minutes=");
  const leadMinutes = leadMinutesRaw === undefined ? 4 : Number(leadMinutesRaw);
  if (!Number.isFinite(leadMinutes) || leadMinutes < 0) {
    console.error(`invalid --lead-minutes value: "${leadMinutesRaw}"`);
    process.exitCode = 1;
    return;
  }
  const roots = resolveRootOverrides(argv);
  const { store } = await loadStore(roots);
  const readyDir = roots.queueReadyDir ?? resolveDefaultQueueReadyDir();
  const readyItemNames = await listReadyItemNames(readyDir);
  const due = findDueQueueItemName(store.matches, {
    leadMinutes,
    readyItemNames,
    now: new Date(),
  });
  if (due !== null) {
    process.stdout.write(`${due}\n`);
  }
}

const isMainModule = process.argv[1] === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
