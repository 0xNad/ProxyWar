import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import {
  recoverReplayPremiereEventLog,
  type ReplayPremiereEventStoreLimits,
} from "./ReplayPremiereEventStore";
import {
  canonicalReplayPremiereJson,
  hashReplayPremiereJson,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import { replayPremiereInteractionAggregateId } from "./ReplayPremiereInteractionRecovery";

const EVENT_STORE_DIRECTORY = "event-store-v1";
const EVENTS_FILE = "events.jsonl";
const SNAPSHOTS_DIRECTORY = "snapshots";
const WRITE_OWNER_FILE = "write-owner.json";

const STORED_EVENT_KEYS = [
  "schemaVersion",
  "eventSequence",
  "eventId",
  "aggregateId",
  "eventType",
  "occurredAt",
  "payload",
  "idempotencyKey",
  "idempotencyStateHash",
  "previousEventHash",
  "eventHash",
] as const;

export interface ReplayPremiereJournalCompactionResult {
  compacted: boolean;
  reason:
    | "no_reclaimed_aggregates"
    | "no_journal"
    | "writer_active"
    | "unparsable_journal"
    | "nothing_dropped"
    | "validation_failed"
    | "compacted";
  droppedAggregateIds: string[];
  keptEventCount: number;
  removedEventCount: number;
}

interface ParsedStoredEvent {
  aggregateId: string;
  schemaVersion: unknown;
  eventId: unknown;
  eventType: unknown;
  occurredAt: unknown;
  payload: ReplayPremiereJsonValue;
  idempotencyKey: unknown;
  idempotencyStateHash: unknown;
}

/**
 * Reclaims a fully-terminated premiere's bytes from the shared, hash-chained
 * event journal. This runs at startup ONLY, before the event store opens (no
 * live writer), and is the mechanism that keeps the event-store byte ceiling
 * unreachable across an unbounded stream of premieres.
 *
 * An aggregate is dropped only when its premiere is BOTH recorded in the archive
 * index (a durable "bulk reclaimed" pointer) AND absent from the live admission
 * catalog. That guarantees the premiere can never be reassembled, so removing
 * its events loses nothing recoverable. Survivor events are re-sequenced and
 * re-hash-chained; the rewrite is validated by the event store's own recovery
 * before it atomically replaces the journal, and every snapshot is dropped so
 * each surviving aggregate re-derives its snapshot from the compacted log.
 *
 * Fail-closed: any anomaly (unparsable line, active writer, failed revalidation)
 * leaves the original journal and snapshots untouched.
 */
export async function compactReplayPremiereEventJournal(options: {
  privateStateRoot: string;
  reclaimedPremiereIds: readonly string[];
  presentPremiereIds: readonly string[];
  /** Premiere ids that must never be dropped, even if reclaimed and absent. */
  excludedPremiereIds?: readonly string[];
  limits: ReplayPremiereEventStoreLimits;
}): Promise<ReplayPremiereJournalCompactionResult> {
  const empty = (
    reason: ReplayPremiereJournalCompactionResult["reason"],
  ): ReplayPremiereJournalCompactionResult => ({
    compacted: false,
    reason,
    droppedAggregateIds: [],
    keptEventCount: 0,
    removedEventCount: 0,
  });

  // `presentPremiereIds` is the set of successfully-parsed live admissions. A
  // corrupt admission whose premiere is ALSO in the archive index would parse to
  // neither `entries` nor here, so it would be treated as absent and dropped.
  // That is unreachable in normal flow (a premiere reaches the archive index only
  // after being durably summarized) and safe if it ever happened: the summary +
  // pointer already persist, so dropping the orphaned events loses nothing.
  const present = new Set(options.presentPremiereIds);
  // Excluded premieres are treated as present so their journal events survive,
  // even if they were reclaimed before being excluded (reclaimed-then-excluded).
  const excluded = new Set(options.excludedPremiereIds ?? []);
  const dropAggregateIds = new Set<string>();
  for (const premiereId of options.reclaimedPremiereIds) {
    if (present.has(premiereId) || excluded.has(premiereId)) continue;
    dropAggregateIds.add(premiereId);
    dropAggregateIds.add(replayPremiereInteractionAggregateId(premiereId));
  }
  if (dropAggregateIds.size === 0) return empty("no_reclaimed_aggregates");

  const storeRoot = path.join(
    path.resolve(options.privateStateRoot),
    EVENT_STORE_DIRECTORY,
  );
  const eventsPath = path.join(storeRoot, EVENTS_FILE);
  const snapshotsDir = path.join(storeRoot, SNAPSHOTS_DIRECTORY);

  let raw: string;
  try {
    raw = await fs.readFile(eventsPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT")
      return empty("no_journal");
    throw error;
  }
  if (raw.length === 0) return empty("no_journal");

  if (await activeWriterHoldsLock(path.join(storeRoot, WRITE_OWNER_FILE))) {
    return empty("writer_active");
  }

  if (raw[raw.length - 1] !== "\n") return empty("unparsable_journal");
  const lines = raw.slice(0, -1).split("\n");
  const survivors: ParsedStoredEvent[] = [];
  const dropped = new Set<string>();
  for (const line of lines) {
    const event = parseStoredEventLine(line);
    if (event === null) return empty("unparsable_journal");
    if (dropAggregateIds.has(event.aggregateId)) {
      dropped.add(event.aggregateId);
      continue;
    }
    survivors.push(event);
  }
  if (dropped.size === 0 || survivors.length === lines.length) {
    return empty("nothing_dropped");
  }

  const compactedBody = serializeCompactedJournal(survivors);
  const temporaryPath = `${eventsPath}.${process.pid}.${randomUUID()}.compact.tmp`;
  await writeFileSynced(temporaryPath, compactedBody);
  try {
    const recovered = await recoverReplayPremiereEventLog(
      temporaryPath,
      options.limits,
    );
    const recoveredAggregateIds = new Set(
      recovered.events.map((event) => event.aggregateId),
    );
    const droppedStillPresent = [...dropAggregateIds].some((aggregateId) =>
      recoveredAggregateIds.has(aggregateId),
    );
    if (
      recovered.events.length !== survivors.length ||
      recovered.lastEventSequence !== survivors.length - 1 ||
      droppedStillPresent
    ) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      return {
        ...empty("validation_failed"),
        droppedAggregateIds: [...dropped].sort(),
      };
    }
  } catch {
    await fs.unlink(temporaryPath).catch(() => undefined);
    return {
      ...empty("validation_failed"),
      droppedAggregateIds: [...dropped].sort(),
    };
  }

  // Snapshots must be gone before the compacted journal goes live: a snapshot
  // whose anchor sequence no longer exists in the journal fails recovery. A
  // missing snapshot always self-heals, so deleting first is the safe order.
  // If this throws after validation, the validated temp is unlinked so it never
  // orphans against maxPrivateStateBytes; the live journal stays intact (rename
  // is atomic — the store still recovers the original).
  try {
    await deleteAllSnapshots(snapshotsDir);
    await fs.rename(temporaryPath, eventsPath);
    await syncDirectory(storeRoot);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  return {
    compacted: true,
    reason: "compacted",
    droppedAggregateIds: [...dropped].sort(),
    keptEventCount: survivors.length,
    removedEventCount: lines.length - survivors.length,
  };
}

export interface ReplayPremiereSourceGcResult {
  removed: string[];
}

const SOURCE_SHA_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Deletes the shared, content-addressed source `.replay` bundle for reclaimed
 * premieres. This is the startup-time counterpart to terminal reclamation: it
 * runs in the same no-active-writer window as journal compaction (before the
 * event store opens), so it cannot race a concurrent admission that reuses the
 * same-sha source.
 *
 * A source is deleted only when its hash is referenced by NO surviving admission
 * (`presentSourceShas`, drawn from the parsed live catalog). That check makes it
 * fail-closed: any still-referenced source is retained, and a premiere that is
 * still admitted keeps its source (its own admission carries the hash). Deletion
 * is idempotent (ENOENT is a no-op) and each hash is attempted at most once.
 */
export async function reclaimUnreferencedPremiereSources(options: {
  privateStateRoot: string;
  reclaimedSources: ReadonlyArray<{
    premiereId: string;
    sourceReplaySha256: string;
  }>;
  presentSourceShas: readonly string[];
  /** Premiere ids whose shared source must never be deleted. */
  excludedPremiereIds?: readonly string[];
}): Promise<ReplayPremiereSourceGcResult> {
  const present = new Set(options.presentSourceShas);
  const excluded = new Set(options.excludedPremiereIds ?? []);
  const sourcesRoot = path.join(
    path.resolve(options.privateStateRoot),
    "sources",
    "sha256",
  );
  const removed: string[] = [];
  const attempted = new Set<string>();
  for (const { premiereId, sourceReplaySha256 } of options.reclaimedSources) {
    if (
      excluded.has(premiereId) ||
      !SOURCE_SHA_PATTERN.test(sourceReplaySha256) ||
      present.has(sourceReplaySha256) ||
      attempted.has(sourceReplaySha256)
    ) {
      continue;
    }
    attempted.add(sourceReplaySha256);
    const sourcePath = path.join(
      sourcesRoot,
      sourceReplaySha256.slice(0, 2),
      `${sourceReplaySha256}.replay`,
    );
    try {
      await fs.unlink(sourcePath);
      removed.push(sourceReplaySha256);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
  return { removed };
}

function serializeCompactedJournal(
  events: readonly ParsedStoredEvent[],
): string {
  let previousEventHash: string | null = null;
  const lines: string[] = [];
  for (const [index, event] of events.entries()) {
    const hashInput: ReplayPremiereJsonValue = {
      schemaVersion: event.schemaVersion as ReplayPremiereJsonValue,
      eventSequence: index,
      eventId: event.eventId as ReplayPremiereJsonValue,
      aggregateId: event.aggregateId,
      eventType: event.eventType as ReplayPremiereJsonValue,
      occurredAt: event.occurredAt as ReplayPremiereJsonValue,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey as ReplayPremiereJsonValue,
      idempotencyStateHash:
        event.idempotencyStateHash as ReplayPremiereJsonValue,
      previousEventHash,
    };
    const eventHash = hashReplayPremiereJson(hashInput);
    const stored: ReplayPremiereJsonValue = {
      ...(hashInput as Record<string, ReplayPremiereJsonValue>),
      eventHash,
    };
    lines.push(canonicalReplayPremiereJson(stored));
    previousEventHash = eventHash;
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function parseStoredEventLine(line: string): ParsedStoredEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== STORED_EVENT_KEYS.length ||
    keys.some((key, index) => key !== [...STORED_EVENT_KEYS].sort()[index])
  ) {
    return null;
  }
  if (
    typeof record.aggregateId !== "string" ||
    record.aggregateId.length === 0
  ) {
    return null;
  }
  return {
    aggregateId: record.aggregateId,
    schemaVersion: record.schemaVersion,
    eventId: record.eventId,
    eventType: record.eventType,
    occurredAt: record.occurredAt,
    payload: record.payload as ReplayPremiereJsonValue,
    idempotencyKey: record.idempotencyKey,
    idempotencyStateHash: record.idempotencyStateHash,
  };
}

async function activeWriterHoldsLock(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    return true; // Unreadable lock: fail closed, do not compact.
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return true;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isSafeInteger((value as { pid?: unknown }).pid)
  ) {
    return true;
  }
  const pid = Number((value as { pid: number }).pid);
  try {
    process.kill(pid, 0);
    return true; // The owner process is alive.
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function deleteAllSnapshots(snapshotsDir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(snapshotsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".snapshot.json")) continue;
    await fs.unlink(path.join(snapshotsDir, name)).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
  await syncDirectory(snapshotsDir).catch(() => undefined);
}

async function writeFileSynced(filePath: string, body: string): Promise<void> {
  const handle = await fs.open(
    filePath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
