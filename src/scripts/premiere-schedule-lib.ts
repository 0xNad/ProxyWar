import path from "node:path";
import {
  FeaturedMatchSchema,
  mutateFeaturedMatchStore,
  readFeaturedMatchStore,
  resolveFeaturedMatchStateRoot,
  type FeaturedMatch,
  type FeaturedMatchParticipant,
  type FeaturedMatchStoreFile,
} from "../server/agents/FeaturedMatch";
import {
  rankPremiereCandidates,
  resolveDefaultArtifactsRoot,
  resolveDefaultQueueReadyDir,
  resolveSealedBundleParticipants,
} from "./premiere-candidates";
import type { IdentityRegistrySnapshot } from "../server/identity/IdentityRegistry";

/**
 * Shared lookup/validation logic for the four `premiere:schedule`/
 * `premiere:validate`/`premiere:publish`/`premiere:cancel` operator CLIs
 * (product overhaul spec Stage 3 item 3). All four mutate the SAME
 * `FeaturedMatch` store (`src/server/agents/FeaturedMatch.ts`) — this
 * module is where their shared "resolve an operator-supplied id to a
 * record" and "is this schedule internally consistent" logic lives, so
 * the four scripts stay thin and never duplicate it.
 *
 * Concurrency: `upsertRecord` (this module's only write path) runs its
 * whole read-modify-write cycle inside `FeaturedMatch.ts`'s
 * `mutateFeaturedMatchStore`, which holds a real cross-process filesystem
 * lock (`FileMutex.ts`, keyed on the store's `stateRoot`) — the SAME lock
 * the demo server's `reconcileFeaturedMatchStore` holds. This safely
 * serializes any of the four CLIs against each other AND against the
 * server, even though the CLIs run as separate OS processes an in-process
 * mutex could never reach. What is NOT covered: a CLI's own pre-flight
 * validation (e.g. `premiere:publish`'s "state is already X" checks) reads
 * the store BEFORE the locked upsert and is not re-validated atomically
 * with the write — a concurrent writer changing THAT SAME record between
 * the pre-flight read and the upsert can still have its change to that one
 * record overwritten by a stale-informed CLI write (every OTHER record is
 * unaffected, since the upsert always reads fresh data for the rest of the
 * store under the lock). Closing that narrower same-record race would need
 * the CLI's user-facing validation itself to run inside the lock, which is
 * a bigger design change than this module makes today.
 */

/**
 * Real matches run roughly 20+ minutes wall-clock at the cadence
 * `cycle-premiere.sh`/`generate-premiere-queue.sh` already tune for
 * (`TARGET_MATCH_MS` there defaults to 21.6 minutes) — two premieres
 * scheduled closer together than this can never both actually play out
 * before the next is due. Kept generous (not exactly 20) because a
 * schedule built today has no visibility into a future turn's actual
 * per-item playback duration (`turnCount * turnIntervalMs`, only known
 * once the match is claimed) — this is a coarse operator-facing safety
 * rail, not a scheduling guarantee.
 */
export const MINIMUM_SCHEDULE_SPACING_MINUTES = 20;

export interface ScheduleResolveOptions {
  queueReadyDir?: string;
  artifactsRoot?: string;
  stateRoot?: string;
  now?: () => Date;
}

function resolvedRoots(options: ScheduleResolveOptions) {
  return {
    queueReadyDir: options.queueReadyDir ?? resolveDefaultQueueReadyDir(),
    artifactsRoot: options.artifactsRoot ?? resolveDefaultArtifactsRoot(),
    stateRoot: options.stateRoot ?? resolveFeaturedMatchStateRoot(),
  };
}

export interface ScheduleTargetFound {
  found: true;
  /** True when this record already exists in the store (an operator re-running `premiere:schedule` on an already-tracked candidate); false when it was just built fresh from a live queue candidate and has never been persisted. */
  existedInStore: boolean;
  record: FeaturedMatch;
}

export interface ScheduleTargetNotFound {
  found: false;
  /** Named reason — e.g. `not_found_in_queue_or_store`, or the exact `premiere:candidates` rejection reason (e.g. `already_published_on_league: ...`) when the id resolves to a rejected candidate. */
  reason: string;
}

export type ScheduleTargetResult = ScheduleTargetFound | ScheduleTargetNotFound;

/**
 * Resolves an operator-supplied id (a `FeaturedMatch.matchId`, a premiere-
 * queue item's directory name, or its `episodeId`/`experienceRequestId`)
 * to the record `premiere:schedule` should act on. Checks the STORE first
 * (an id already tracked, e.g. from a prior schedule/cancel) and only
 * falls back to a fresh `premiere:candidates` scan when nothing in the
 * store matches — this means an operator can re-target an
 * already-scheduled record by the same id they originally used.
 *
 * Deliberately reuses `rankPremiereCandidates` rather than re-scanning
 * `ready/` directly, so the named-rejection check (an id that resolves to
 * an already-published episode) is inherited for free instead of
 * re-implemented — this is exactly why an id that matches a REJECTED
 * queue candidate resolves to `found: false` with that candidate's own
 * rejection reason, never silently schedulable.
 */
export async function resolveScheduleTarget(
  id: string,
  options: ScheduleResolveOptions = {},
): Promise<ScheduleTargetResult> {
  const roots = resolvedRoots(options);
  const store = await readFeaturedMatchStore(roots.stateRoot);
  const existing = store.matches.find(
    (record) =>
      record.matchId === id ||
      record.queueItemName === id ||
      record.episodeRequestId === id,
  );
  if (existing !== undefined) {
    return { found: true, existedInStore: true, record: existing };
  }

  const ranked = await rankPremiereCandidates({
    queueReadyDir: roots.queueReadyDir,
    artifactsRoot: roots.artifactsRoot,
    now: options.now,
  });
  const rejectedMatch = ranked.rejected.find(
    (rejection) =>
      rejection.queueItemName === id ||
      rejection.episodeId === id ||
      rejection.experienceRequestId === id,
  );
  if (rejectedMatch !== undefined) {
    return { found: false, reason: rejectedMatch.reason };
  }
  const candidate = ranked.candidates.find(
    (entry) =>
      entry.queueItemName === id ||
      entry.meta.episodeId === id ||
      entry.meta.experienceRequestId === id,
  );
  if (candidate === undefined) {
    return { found: false, reason: "not_found_in_queue_or_store" };
  }
  return { found: true, existedInStore: false, record: candidate.featuredMatch };
}

export type EnsurePremiereParticipantsResult =
  | { ok: true; participants: FeaturedMatchParticipant[] }
  | { ok: false; reason: string };

/**
 * The fix for a real bug found activating Season Zero: a premiere-lane
 * record's `participants` was NEVER populated by any writer in this
 * family (`buildFeaturedMatchDraft`'s own doc explains why the RANKING
 * pass can't — see `premiere-candidates.ts`), which made
 * `EventPackageGate.isPubliclyPromotable`'s `participants.length === 0`
 * check unconditionally fail for every sealed premiere ever scheduled —
 * the "no anonymous public Premiere" gate was structurally unpassable
 * for its own primary lane. Called by `premiere-schedule.ts` for BOTH
 * branches `resolveScheduleTarget` can return: a fresh candidate
 * (`participants: []` from `buildFeaturedMatchDraft`) and a pre-existing
 * store record created before this fix shipped (self-heals on the next
 * re-schedule, no separate migration needed — the real store checked at
 * fix time had zero premiere-lane records yet).
 *
 * No-op (cheap, no bundle I/O) for an archive-lane record or one that
 * already carries a resolved lineup — archive-lane participants are
 * resolved at CREATION time by `feature:promote`
 * (`feature-candidates.ts`'s `buildParticipants`), and a premiere-lane
 * record is never re-resolved once non-empty (matches this module's own
 * "only the specific record being acted on pays any I/O cost" design —
 * unlike `premiere:package`'s prose fields, participants have no
 * operator-editable half to preserve, so "already resolved" is a
 * complete, stable answer, not a staleness risk worth re-checking on
 * every schedule call).
 */
export async function ensurePremiereParticipants(
  record: FeaturedMatch,
  identity: IdentityRegistrySnapshot,
  options: ScheduleResolveOptions = {},
): Promise<EnsurePremiereParticipantsResult> {
  if (record.lane !== "premiere" || record.participants.length > 0) {
    return { ok: true, participants: record.participants };
  }
  if (record.queueItemName === null) {
    return {
      ok: false,
      reason: `${record.matchId} has no queueItemName to locate its sealed bundle`,
    };
  }
  const roots = resolvedRoots(options);
  return resolveSealedBundleParticipants(roots.queueReadyDir, record.queueItemName, identity);
}

export async function loadStore(
  options: ScheduleResolveOptions = {},
): Promise<{ stateRoot: string; store: FeaturedMatchStoreFile }> {
  const roots = resolvedRoots(options);
  return { stateRoot: roots.stateRoot, store: await readFeaturedMatchStore(roots.stateRoot) };
}

/**
 * Upserts one record into the store by `matchId`. Runs the whole
 * read-filter-write cycle inside `mutateFeaturedMatchStore` (`FeaturedMatch.ts`)
 * so this CLI participates in the SAME cross-process lock the server's
 * `reconcileFeaturedMatchStore` holds for its own read-modify-write — the
 * CLI and the demo server are separate OS processes, so only a real
 * filesystem lock (not an in-process mutex) can serialize them. Without
 * this, a concurrent reconcile pass and this upsert could each read the
 * same pre-mutation snapshot and the later write would silently discard
 * whichever OTHER records the earlier write had just changed.
 */
export async function upsertRecord(
  stateRoot: string,
  record: FeaturedMatch,
): Promise<FeaturedMatchStoreFile> {
  const validated = FeaturedMatchSchema.parse(record);
  return mutateFeaturedMatchStore(stateRoot, (current) => {
    const withoutExisting = current.matches.filter(
      (entry) => entry.matchId !== validated.matchId,
    );
    return {
      ...current,
      matches: [...withoutExisting, validated],
    };
  });
}

export interface ScheduleValidationIssue {
  matchId: string;
  reason: string;
}

/**
 * `premiere:validate`'s checking logic, factored out so `premiere:schedule`
 * can run it eagerly against the WOULD-BE next state before writing (fail
 * before persisting a conflict, not after). Checks, per scheduled/published
 * premiere-lane record:
 *
 * - `scheduledAt` is a parseable date not already in the past (relative to
 *   `now`).
 * - `scheduledAt` is not within `MINIMUM_SCHEDULE_SPACING_MINUTES` of any
 *   OTHER scheduled/published premiere-lane record's own `scheduledAt` —
 *   two premieres this close can never both actually run.
 * - `queueItemName` still exists in the live queue's `ready/` directory —
 *   `cycle-premiere.sh`'s own FIFO consumption (unrelated to this
 *   schedule) can claim and remove a queue item at any time; a scheduled
 *   record whose source vanished out from under it is a real problem an
 *   operator needs to see, not a silent no-op later.
 *
 * Archive-lane records are never scheduled (enforced by `FeaturedMatch.ts`'s
 * own schema) so none of the above applies to them — this function only
 * inspects premiere-lane records.
 */
export async function validateSchedule(
  matches: readonly FeaturedMatch[],
  options: ScheduleResolveOptions = {},
): Promise<ScheduleValidationIssue[]> {
  const now = options.now?.() ?? new Date();
  const issues: ScheduleValidationIssue[] = [];
  const active = matches.filter(
    (record) =>
      record.lane === "premiere" &&
      (record.state === "scheduled" || record.state === "published"),
  );

  const roots = resolvedRoots(options);
  let queueItemNames: ReadonlySet<string> | null = null;
  const listQueueItemNames = async (): Promise<ReadonlySet<string>> => {
    if (queueItemNames !== null) return queueItemNames;
    const fs = await import("node:fs/promises");
    try {
      const entries = await fs.readdir(roots.queueReadyDir, {
        withFileTypes: true,
      });
      queueItemNames = new Set(
        entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      );
    } catch {
      queueItemNames = new Set();
    }
    return queueItemNames;
  };

  for (const record of active) {
    if (record.scheduledAt === null) {
      issues.push({
        matchId: record.matchId,
        reason: "missing_scheduled_at: a scheduled/published premiere-lane record must carry a scheduledAt",
      });
      continue;
    }
    const scheduledMs = Date.parse(record.scheduledAt);
    if (Number.isNaN(scheduledMs)) {
      issues.push({
        matchId: record.matchId,
        reason: `invalid_scheduled_at: "${record.scheduledAt}" does not parse as a date`,
      });
      continue;
    }
    if (scheduledMs < now.getTime()) {
      issues.push({
        matchId: record.matchId,
        reason: `scheduled_at_in_past: ${record.scheduledAt} is before ${now.toISOString()}`,
      });
    }
    for (const other of active) {
      if (other.matchId === record.matchId) continue;
      if (other.scheduledAt === null) continue;
      const otherMs = Date.parse(other.scheduledAt);
      if (Number.isNaN(otherMs)) continue;
      const spacingMinutes = Math.abs(scheduledMs - otherMs) / 60_000;
      if (spacingMinutes < MINIMUM_SCHEDULE_SPACING_MINUTES) {
        issues.push({
          matchId: record.matchId,
          reason: `schedule_collision: within ${spacingMinutes.toFixed(1)}min of ${other.matchId} (minimum spacing ${MINIMUM_SCHEDULE_SPACING_MINUTES}min)`,
        });
      }
    }
    if (record.queueItemName !== null) {
      const names = await listQueueItemNames();
      if (!names.has(record.queueItemName)) {
        issues.push({
          matchId: record.matchId,
          reason: `queue_item_missing: "${record.queueItemName}" is no longer in the premiere queue's ready/ directory (claimed or expired elsewhere)`,
        });
      }
    }
  }
  return issues;
}

export function parseIdArg(argv: string[], prefix = "--episode="): string | undefined {
  const arg = argv.find((entry) => entry.startsWith(prefix));
  return arg === undefined ? undefined : arg.slice(prefix.length);
}

export function parseValueArg(argv: string[], prefix: string): string | undefined {
  const arg = argv.find((entry) => entry.startsWith(prefix));
  return arg === undefined ? undefined : arg.slice(prefix.length);
}

export function resolveRootOverrides(argv: string[]): ScheduleResolveOptions {
  const queueRootOverride = parseValueArg(argv, "--queue-root=");
  const artifactsRootOverride = parseValueArg(argv, "--artifacts-root=");
  const stateRootOverride = parseValueArg(argv, "--state-root=");
  return {
    queueReadyDir:
      queueRootOverride === undefined
        ? undefined
        : path.join(path.resolve(queueRootOverride), "ready"),
    artifactsRoot:
      artifactsRootOverride === undefined ? undefined : path.resolve(artifactsRootOverride),
    stateRoot: stateRootOverride === undefined ? undefined : path.resolve(stateRootOverride),
  };
}
