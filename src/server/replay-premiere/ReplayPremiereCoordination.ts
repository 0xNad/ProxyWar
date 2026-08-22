import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import {
  readReplayPremiereArchivePointer,
  type PremiereArchivePointerV1,
} from "./ReplayPremiereArchiveIndex";
import {
  readReplayPremiereAdmissionRecord,
  type ReplayPremiereAdmissionRecordV1,
} from "./ReplayPremiereCatalog";
import type { PremiereState } from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import { isSha256Hex, sha256Hex } from "./ReplayPremiereIntegrity";

const COORDINATION_DIRECTORY = "coordination-v1";
const TOMBSTONE_DIRECTORY = "terminal-tombstones";
const STARTUP_SELECTION_FILE = "startup-selection.json";
const EVENT_STORE_WRITER_FILE = path.join("event-store-v1", "write-owner.json");
const TOMBSTONE_SUFFIX = ".terminal.json";
const MAX_COORDINATION_FILE_BYTES = 256 * 1024;
const MAX_WRITER_IDENTITY_BYTES = 4 * 1024;
const MAX_COORDINATED_PREMIERES = 256;
const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,192}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReplayPremiereRetirementPhase = "admitted" | "activated" | "live";

export type ReplayPremiereTerminalReleaseOutcome =
  | "expired"
  | "leak_audit_refused"
  | "activation_refused"
  | "activation_lost"
  | "ingest_failed"
  | "admit_failed"
  | "projection_over_budget";

export interface ReplayPremiereTerminalTombstoneV1 {
  schemaVersion: 1;
  kind: "replay_premiere_terminal_tombstone_v1";
  premiereId: string;
  admissionRecordHash: string;
  episodeRequestId: string;
  roundId: string;
  releasePhase: ReplayPremiereRetirementPhase;
  releaseOutcome: ReplayPremiereTerminalReleaseOutcome;
  releasedAt: string;
}

interface ReplayPremiereServerWriterIdentityV1 {
  schemaVersion: 1;
  pid: number;
  writerId: string;
  acquiredAt: string;
}

export interface ReplayPremiereServerStartupIdentityV1 {
  pid: number;
  writerId: string;
  writerAcquiredAt: string;
  startupId: string;
  startupStartedAt: string;
}

export interface ReplayPremiereStartupSelectionEntryV1 {
  premiereId: string;
  admissionRecordHash: string;
  projectionState: PremiereState;
}

export interface ReplayPremiereStartupSelectionReceiptV1 {
  schemaVersion: 1;
  kind: "replay_premiere_startup_selection_v1";
  phase: "assembling" | "ready";
  server: ReplayPremiereServerStartupIdentityV1;
  selected: ReplayPremiereStartupSelectionEntryV1[];
  registeredPremiereIds: string[];
  writtenAt: string;
}

export interface ReplayPremiereHistoricalReleaseRecord {
  kind: "hold_released";
  ts: string;
  episodeRequestId: string;
  premiereId: string;
  roundId: string | null;
  outcome: string;
  terminal: boolean;
}

export interface ReplayPremiereTerminalTombstoneBackfillResult {
  tombstones: readonly ReplayPremiereTerminalTombstoneV1[];
  catalogAbsentArchivedPremiereIds: readonly string[];
  catalogAbsentUnarchivedPremiereIds: readonly string[];
}

interface HistoricalHoldIdentity {
  episodeRequestId: string;
  premiereId: string;
  roundId: string | null;
  phase: "claimed" | ReplayPremiereRetirementPhase;
}

export function shouldRetireReplayPremiereRelease(options: {
  phase: string;
  outcome: string;
  terminal: boolean;
}): options is {
  phase: ReplayPremiereRetirementPhase;
  outcome: ReplayPremiereTerminalReleaseOutcome;
  terminal: true;
} {
  return (
    options.terminal === true &&
    isRetirementPhase(options.phase) &&
    options.outcome !== "revealed" &&
    options.outcome !== "failed_or_cancelled" &&
    isTerminalReleaseOutcome(options.outcome)
  );
}

export async function createReplayPremiereServerStartupIdentity(options: {
  privateStateRoot: string;
  now?: Date;
}): Promise<ReplayPremiereServerStartupIdentityV1> {
  const writer = await readActiveServerWriterIdentity(options.privateStateRoot);
  if (writer.pid !== process.pid) {
    throw coordinationIntegrity("coordination_writer_pid_mismatch");
  }
  const now = options.now ?? new Date();
  return {
    pid: writer.pid,
    writerId: writer.writerId,
    writerAcquiredAt: writer.acquiredAt,
    startupId: randomUUID(),
    startupStartedAt: canonicalTimestamp(now.toISOString()),
  };
}

export async function writeReplayPremiereStartupSelection(options: {
  privateStateRoot: string;
  phase: "assembling" | "ready";
  server: ReplayPremiereServerStartupIdentityV1;
  selected: readonly ReplayPremiereStartupSelectionEntryV1[];
  registeredPremiereIds: readonly string[];
  now?: Date;
}): Promise<ReplayPremiereStartupSelectionReceiptV1> {
  const layout = await ensureCoordinationLayout(options.privateStateRoot);
  const receipt = parseStartupSelectionReceipt({
    schemaVersion: 1,
    kind: "replay_premiere_startup_selection_v1",
    phase: options.phase,
    server: { ...options.server },
    selected: options.selected.map((entry) => ({ ...entry })),
    registeredPremiereIds: [...options.registeredPremiereIds],
    writtenAt: (options.now ?? new Date()).toISOString(),
  });
  const writer = await readActiveServerWriterIdentity(options.privateStateRoot);
  assertReceiptMatchesWriter(receipt, writer);
  if (writer.pid !== process.pid) {
    throw coordinationIntegrity("coordination_writer_pid_mismatch");
  }
  await writeAtomicMutableJson(layout.selectionPath, receipt);
  return receipt;
}

/**
 * Reads only the receipt owned by the currently-active event-store writer.
 * Missing, assembling, stale, dead, malformed, or writer-mismatched receipts
 * fail closed; the loop must not claim while server identity is uncertain.
 */
export async function readActiveReplayPremiereStartupSelection(
  privateStateRoot: string,
): Promise<ReplayPremiereStartupSelectionReceiptV1> {
  const selectionPath = path.join(
    path.resolve(privateStateRoot),
    COORDINATION_DIRECTORY,
    STARTUP_SELECTION_FILE,
  );
  const receipt = parseStartupSelectionReceipt(
    parseJson(
      await readBoundedRegularFile(selectionPath, MAX_COORDINATION_FILE_BYTES),
      "coordination_selection_invalid_json",
    ),
  );
  const writer = await readActiveServerWriterIdentity(privateStateRoot);
  assertReceiptMatchesWriter(receipt, writer);
  if (receipt.phase !== "ready") {
    throw coordinationUnavailable("coordination_selection_not_ready");
  }
  return receipt;
}

export function replayPremiereStartupSelectionFingerprint(
  receipt: ReplayPremiereStartupSelectionReceiptV1,
): string {
  const parsed = parseStartupSelectionReceipt(receipt);
  return sha256Hex(Buffer.from(JSON.stringify(parsed), "utf8"));
}

export async function persistReplayPremiereTerminalTombstone(options: {
  privateStateRoot: string;
  episodeRequestId: string;
  premiereId: string;
  roundId: string | null;
  phase: string;
  outcome: string;
  terminal: boolean;
  releasedAt: string;
}): Promise<ReplayPremiereTerminalTombstoneV1 | null> {
  if (!shouldRetireReplayPremiereRelease(options)) return null;
  const record = await readReplayPremiereAdmissionRecord({
    privateStateRoot: options.privateStateRoot,
    premiereId: options.premiereId,
  });
  if (record === null) {
    const archived = await readReplayPremiereArchivePointer({
      privateStateRoot: options.privateStateRoot,
      premiereId: options.premiereId,
    });
    if (archived !== null) return null;
    throw coordinationIntegrity("coordination_retired_admission_missing");
  }
  const tombstone = tombstoneForRelease(record, {
    episodeRequestId: options.episodeRequestId,
    premiereId: options.premiereId,
    roundId: options.roundId,
    phase: options.phase,
    outcome: options.outcome,
    terminal: options.terminal,
    releasedAt: options.releasedAt,
  });
  const layout = await ensureCoordinationLayout(options.privateStateRoot);
  const destination = tombstonePath(layout.tombstoneRoot, tombstone.premiereId);
  try {
    const existing = parseTerminalTombstone(
      parseJson(
        await readBoundedRegularFile(destination, MAX_COORDINATION_FILE_BYTES),
        "coordination_tombstone_invalid_json",
      ),
    );
    assertTombstoneAdmissionBinding(existing, record);
    if (
      existing.episodeRequestId !== tombstone.episodeRequestId ||
      existing.roundId !== tombstone.roundId ||
      existing.releasePhase !== tombstone.releasePhase ||
      existing.releaseOutcome !== tombstone.releaseOutcome
    ) {
      throw coordinationIntegrity("coordination_tombstone_is_immutable");
    }
    return existing;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  await writeImmutableJson(destination, tombstone);
  return tombstone;
}

/**
 * Strict migration of terminal releases written before tombstones existed.
 * Release records use an exact schema; their identities and inferred phase
 * must agree with the preceding hold update and immutable admission.
 */
export async function backfillReplayPremiereTerminalTombstones(options: {
  privateStateRoot: string;
  records: readonly unknown[];
}): Promise<readonly ReplayPremiereTerminalTombstoneV1[]> {
  return (await backfillReplayPremiereTerminalTombstonesDetailed(options))
    .tombstones;
}

/**
 * Historical migration with a read-only validation pass before any immutable
 * tombstone is created. An absent catalog admission is already non-selectable,
 * so it is recorded and skipped; malformed or conflicting present state still
 * aborts the whole preflight before any new tombstone is written.
 */
export async function backfillReplayPremiereTerminalTombstonesDetailed(options: {
  privateStateRoot: string;
  records: readonly unknown[];
}): Promise<ReplayPremiereTerminalTombstoneBackfillResult> {
  await assertPrivateStateRoot(options.privateStateRoot);
  const activeHolds = new Map<string, HistoricalHoldIdentity>();
  const releases: Array<{
    hold: HistoricalHoldIdentity;
    release: ReplayPremiereHistoricalReleaseRecord;
  }> = [];
  for (const value of options.records) {
    if (!isRecord(value)) continue;
    if (value.kind === "hold_update") {
      const hold = parseHistoricalHoldUpdate(value);
      activeHolds.set(hold.episodeRequestId, hold);
      continue;
    }
    if (value.kind !== "hold_released") continue;
    const release = parseHistoricalRelease(value);
    const hold = activeHolds.get(release.episodeRequestId);
    if (
      hold !== undefined &&
      (hold.premiereId !== release.premiereId ||
        hold.roundId !== release.roundId)
    ) {
      throw coordinationIntegrity(
        "coordination_journal_release_identity_mismatch",
      );
    }
    if (hold !== undefined) activeHolds.delete(release.episodeRequestId);
    if (
      hold === undefined &&
      release.terminal &&
      isTerminalReleaseOutcome(release.outcome)
    ) {
      throw coordinationIntegrity("coordination_journal_release_phase_missing");
    }
    if (
      !shouldRetireReplayPremiereRelease({
        phase: hold?.phase ?? "unknown",
        outcome: release.outcome,
        terminal: release.terminal,
      })
    ) {
      continue;
    }
    if (hold === undefined)
      throw coordinationIntegrity("coordination_journal_release_phase_missing");
    releases.push({ hold, release });
  }
  if (releases.length > MAX_COORDINATED_PREMIERES) {
    throw coordinationCapacity("coordination_backfill_count_exceeded");
  }

  const planned = new Map<
    string,
    {
      tombstone: ReplayPremiereTerminalTombstoneV1;
      needsWrite: boolean;
    }
  >();
  const catalogAbsentArchived = new Set<string>();
  const catalogAbsentUnarchived = new Set<string>();

  for (const { hold, release } of releases) {
    const record = await readReplayPremiereAdmissionRecord({
      privateStateRoot: options.privateStateRoot,
      premiereId: release.premiereId,
    });
    if (record === null) {
      const archived = await readReplayPremiereArchivePointer({
        privateStateRoot: options.privateStateRoot,
        premiereId: release.premiereId,
      });
      (archived === null ? catalogAbsentUnarchived : catalogAbsentArchived).add(
        release.premiereId,
      );
      continue;
    }

    const expected = tombstoneForRelease(record, {
      episodeRequestId: release.episodeRequestId,
      premiereId: release.premiereId,
      roundId: release.roundId,
      phase: hold.phase,
      outcome: release.outcome,
      terminal: release.terminal,
      releasedAt: release.ts,
    });
    const prior = planned.get(expected.premiereId);
    if (prior !== undefined) {
      assertEquivalentTerminalTombstone(prior.tombstone, expected);
      continue;
    }

    const existing = await readTerminalTombstoneIfPresent({
      privateStateRoot: options.privateStateRoot,
      premiereId: expected.premiereId,
    });
    if (existing !== null) {
      assertTombstoneAdmissionBinding(existing, record);
      assertEquivalentTerminalTombstone(existing, expected);
    }
    planned.set(expected.premiereId, {
      tombstone: existing ?? expected,
      needsWrite: existing === null,
    });
  }

  if ([...planned.values()].some((entry) => entry.needsWrite)) {
    const layout = await ensureCoordinationLayout(options.privateStateRoot);
    for (const entry of planned.values()) {
      if (!entry.needsWrite) continue;
      await writeImmutableJson(
        tombstonePath(layout.tombstoneRoot, entry.tombstone.premiereId),
        entry.tombstone,
      );
    }
  }
  return {
    tombstones: [...planned.values()].map((entry) => entry.tombstone),
    catalogAbsentArchivedPremiereIds: [...catalogAbsentArchived].sort(),
    catalogAbsentUnarchivedPremiereIds: [...catalogAbsentUnarchived].sort(),
  };
}

/**
 * Loads every retained tombstone, validates it against its immutable admission,
 * and removes only tombstones whose catalog admission is absent AND whose
 * durable archive pointer is already loaded. The returned map is bounded.
 */
export async function reconcileReplayPremiereTerminalTombstones(options: {
  privateStateRoot: string;
  admissionRecords: readonly ReplayPremiereAdmissionRecordV1[];
  archivePointerFor: (premiereId: string) => PremiereArchivePointerV1 | null;
}): Promise<ReadonlyMap<string, ReplayPremiereTerminalTombstoneV1>> {
  const layout = await ensureCoordinationLayout(options.privateStateRoot);
  const names = await fs.readdir(layout.tombstoneRoot);
  if (names.length > MAX_COORDINATED_PREMIERES) {
    throw coordinationCapacity("coordination_tombstone_count_exceeded");
  }
  const admissions = new Map(
    options.admissionRecords.map((record) => [record.premiereId, record]),
  );
  const tombstones = new Map<string, ReplayPremiereTerminalTombstoneV1>();
  for (const name of names.sort()) {
    if (!name.endsWith(TOMBSTONE_SUFFIX)) {
      throw coordinationIntegrity("coordination_tombstone_filename_invalid");
    }
    const expectedPremiereId = name.slice(0, -TOMBSTONE_SUFFIX.length);
    if (!PREMIERE_ID_PATTERN.test(expectedPremiereId)) {
      throw coordinationIntegrity("coordination_tombstone_filename_invalid");
    }
    const filePath = path.join(layout.tombstoneRoot, name);
    const tombstone = parseTerminalTombstone(
      parseJson(
        await readBoundedRegularFile(filePath, MAX_COORDINATION_FILE_BYTES),
        "coordination_tombstone_invalid_json",
      ),
    );
    if (tombstone.premiereId !== expectedPremiereId) {
      throw coordinationIntegrity("coordination_tombstone_filename_mismatch");
    }
    const admission = admissions.get(tombstone.premiereId);
    if (admission === undefined) {
      const pointer = options.archivePointerFor(tombstone.premiereId);
      if (pointer === null || pointer.premiereId !== tombstone.premiereId) {
        throw coordinationIntegrity(
          "coordination_tombstone_unproven_catalog_absence",
        );
      }
      await fs.unlink(filePath);
      await syncDirectory(layout.tombstoneRoot);
      continue;
    }
    assertTombstoneAdmissionBinding(tombstone, admission);
    if (tombstones.has(tombstone.premiereId)) {
      throw coordinationIntegrity("coordination_tombstone_duplicate");
    }
    tombstones.set(tombstone.premiereId, tombstone);
  }
  return tombstones;
}

/** Remove one tombstone only after the reclaimer's pointer-then-delete proof. */
export async function garbageCollectReplayPremiereTerminalTombstone(options: {
  privateStateRoot: string;
  premiereId: string;
  archivePointer: PremiereArchivePointerV1;
}): Promise<boolean> {
  if (
    !PREMIERE_ID_PATTERN.test(options.premiereId) ||
    options.archivePointer.premiereId !== options.premiereId
  ) {
    throw coordinationIntegrity("coordination_tombstone_gc_pointer_mismatch");
  }
  const admission = await readReplayPremiereAdmissionRecord({
    privateStateRoot: options.privateStateRoot,
    premiereId: options.premiereId,
  });
  if (admission !== null) return false;
  const tombstoneRoot = path.join(
    path.resolve(options.privateStateRoot),
    COORDINATION_DIRECTORY,
    TOMBSTONE_DIRECTORY,
  );
  const filePath = tombstonePath(tombstoneRoot, options.premiereId);
  try {
    const tombstone = parseTerminalTombstone(
      parseJson(
        await readBoundedRegularFile(filePath, MAX_COORDINATION_FILE_BYTES),
        "coordination_tombstone_invalid_json",
      ),
    );
    if (tombstone.premiereId !== options.premiereId) {
      throw coordinationIntegrity(
        "coordination_tombstone_gc_identity_mismatch",
      );
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  await fs.unlink(filePath);
  await syncDirectory(tombstoneRoot);
  return true;
}

function tombstoneForRelease(
  record: ReplayPremiereAdmissionRecordV1,
  release: {
    episodeRequestId: string;
    premiereId: string;
    roundId: string | null;
    phase: string;
    outcome: string;
    terminal: boolean;
    releasedAt: string;
  },
): ReplayPremiereTerminalTombstoneV1 {
  if (!shouldRetireReplayPremiereRelease(release)) {
    throw coordinationIntegrity("coordination_release_not_retirable");
  }
  if (release.roundId === null) {
    throw coordinationIntegrity("coordination_retired_round_id_missing");
  }
  const tombstone = parseTerminalTombstone({
    schemaVersion: 1,
    kind: "replay_premiere_terminal_tombstone_v1",
    premiereId: release.premiereId,
    admissionRecordHash: record.recordHash,
    episodeRequestId: release.episodeRequestId,
    roundId: release.roundId,
    releasePhase: release.phase,
    releaseOutcome: release.outcome,
    releasedAt: release.releasedAt,
  });
  assertTombstoneAdmissionBinding(tombstone, record);
  return tombstone;
}

function assertTombstoneAdmissionBinding(
  tombstone: ReplayPremiereTerminalTombstoneV1,
  record: ReplayPremiereAdmissionRecordV1,
): void {
  if (
    tombstone.premiereId !== record.premiereId ||
    tombstone.admissionRecordHash !== record.recordHash ||
    record.eligibilityRecord.sourceKind !== "rated_coworld" ||
    record.eligibilityRecord.coworld === null ||
    record.eligibilityRecord.authoritativeResult.sourceKind !==
      "coworld_result" ||
    tombstone.episodeRequestId !==
      record.eligibilityRecord.authoritativeResult.sourceId ||
    tombstone.episodeRequestId !== record.authoritativeResult.sourceId ||
    tombstone.roundId !== record.eligibilityRecord.coworld.roundId
  ) {
    throw coordinationIntegrity("coordination_tombstone_admission_mismatch");
  }
}

function assertEquivalentTerminalTombstone(
  existing: ReplayPremiereTerminalTombstoneV1,
  expected: ReplayPremiereTerminalTombstoneV1,
): void {
  if (
    existing.premiereId !== expected.premiereId ||
    existing.admissionRecordHash !== expected.admissionRecordHash ||
    existing.episodeRequestId !== expected.episodeRequestId ||
    existing.roundId !== expected.roundId ||
    existing.releasePhase !== expected.releasePhase ||
    existing.releaseOutcome !== expected.releaseOutcome
  ) {
    throw coordinationIntegrity("coordination_tombstone_is_immutable");
  }
}

async function readTerminalTombstoneIfPresent(options: {
  privateStateRoot: string;
  premiereId: string;
}): Promise<ReplayPremiereTerminalTombstoneV1 | null> {
  const destination = tombstonePath(
    path.join(
      path.resolve(options.privateStateRoot),
      COORDINATION_DIRECTORY,
      TOMBSTONE_DIRECTORY,
    ),
    options.premiereId,
  );
  try {
    return parseTerminalTombstone(
      parseJson(
        await readBoundedRegularFile(destination, MAX_COORDINATION_FILE_BYTES),
        "coordination_tombstone_invalid_json",
      ),
    );
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

function parseHistoricalHoldUpdate(
  value: Record<string, unknown>,
): HistoricalHoldIdentity {
  assertExactKeys(value, ["kind", "ts", "hold"]);
  const hold = value.hold;
  if (
    value.kind !== "hold_update" ||
    canonicalTimestampOrNull(value.ts) === null ||
    !isRecord(hold)
  ) {
    throw coordinationIntegrity("coordination_journal_hold_invalid");
  }
  if (
    !isSafeIdentifier(hold.episodeRequestId) ||
    !isPremiereId(hold.premiereId) ||
    !isNullableSafeIdentifier(hold.roundId) ||
    !isHoldPhase(hold.phase)
  ) {
    throw coordinationIntegrity("coordination_journal_hold_identity_invalid");
  }
  return {
    episodeRequestId: hold.episodeRequestId,
    premiereId: hold.premiereId,
    roundId: hold.roundId,
    phase: hold.phase,
  };
}

function parseHistoricalRelease(
  value: Record<string, unknown>,
): ReplayPremiereHistoricalReleaseRecord {
  assertExactKeys(value, [
    "kind",
    "ts",
    "episodeRequestId",
    "premiereId",
    "roundId",
    "outcome",
    "terminal",
  ]);
  if (
    value.kind !== "hold_released" ||
    canonicalTimestampOrNull(value.ts) === null ||
    !isSafeIdentifier(value.episodeRequestId) ||
    !isPremiereId(value.premiereId) ||
    !isNullableSafeIdentifier(value.roundId) ||
    typeof value.outcome !== "string" ||
    !isKnownReleaseOutcome(value.outcome) ||
    typeof value.terminal !== "boolean"
  ) {
    throw coordinationIntegrity("coordination_journal_release_invalid");
  }
  return value as unknown as ReplayPremiereHistoricalReleaseRecord;
}

function parseTerminalTombstone(
  value: unknown,
): ReplayPremiereTerminalTombstoneV1 {
  if (!isRecord(value)) {
    throw coordinationIntegrity("coordination_tombstone_not_object");
  }
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "premiereId",
    "admissionRecordHash",
    "episodeRequestId",
    "roundId",
    "releasePhase",
    "releaseOutcome",
    "releasedAt",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "replay_premiere_terminal_tombstone_v1" ||
    !isPremiereId(value.premiereId) ||
    !isSha256Hex(value.admissionRecordHash) ||
    !isSafeIdentifier(value.episodeRequestId) ||
    !isSafeIdentifier(value.roundId) ||
    !isRetirementPhase(value.releasePhase) ||
    !isTerminalReleaseOutcome(value.releaseOutcome) ||
    canonicalTimestampOrNull(value.releasedAt) === null
  ) {
    throw coordinationIntegrity("coordination_tombstone_contract_invalid");
  }
  return value as unknown as ReplayPremiereTerminalTombstoneV1;
}

function parseStartupSelectionReceipt(
  value: unknown,
): ReplayPremiereStartupSelectionReceiptV1 {
  if (!isRecord(value)) {
    throw coordinationIntegrity("coordination_selection_not_object");
  }
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "phase",
    "server",
    "selected",
    "registeredPremiereIds",
    "writtenAt",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "replay_premiere_startup_selection_v1" ||
    (value.phase !== "assembling" && value.phase !== "ready") ||
    !Array.isArray(value.selected) ||
    !Array.isArray(value.registeredPremiereIds) ||
    value.selected.length > MAX_COORDINATED_PREMIERES ||
    value.registeredPremiereIds.length > MAX_COORDINATED_PREMIERES ||
    canonicalTimestampOrNull(value.writtenAt) === null
  ) {
    throw coordinationIntegrity("coordination_selection_contract_invalid");
  }
  const server = parseServerStartupIdentity(value.server);
  const selected = value.selected.map(parseStartupSelectionEntry);
  const selectedIds = new Set(selected.map((entry) => entry.premiereId));
  if (selectedIds.size !== selected.length) {
    throw coordinationIntegrity("coordination_selection_duplicate");
  }
  const registeredPremiereIds = value.registeredPremiereIds.map((id) => {
    if (!isPremiereId(id)) {
      throw coordinationIntegrity("coordination_registered_id_invalid");
    }
    return id;
  });
  const registeredIds = new Set(registeredPremiereIds);
  if (
    registeredIds.size !== registeredPremiereIds.length ||
    registeredPremiereIds.some((id) => !selectedIds.has(id)) ||
    (value.phase === "assembling" && registeredPremiereIds.length !== 0) ||
    (value.phase === "ready" &&
      selected.some(
        (entry) =>
          isNonterminalPremiereState(entry.projectionState) &&
          !registeredIds.has(entry.premiereId),
      ))
  ) {
    throw coordinationIntegrity("coordination_registered_selection_mismatch");
  }
  return {
    schemaVersion: 1,
    kind: "replay_premiere_startup_selection_v1",
    phase: value.phase,
    server,
    selected,
    registeredPremiereIds,
    writtenAt: String(value.writtenAt),
  };
}

function parseServerStartupIdentity(
  value: unknown,
): ReplayPremiereServerStartupIdentityV1 {
  if (!isRecord(value)) {
    throw coordinationIntegrity("coordination_server_identity_invalid");
  }
  assertExactKeys(value, [
    "pid",
    "writerId",
    "writerAcquiredAt",
    "startupId",
    "startupStartedAt",
  ]);
  if (
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    typeof value.writerId !== "string" ||
    !UUID_PATTERN.test(value.writerId) ||
    canonicalTimestampOrNull(value.writerAcquiredAt) === null ||
    typeof value.startupId !== "string" ||
    !UUID_PATTERN.test(value.startupId) ||
    canonicalTimestampOrNull(value.startupStartedAt) === null
  ) {
    throw coordinationIntegrity("coordination_server_identity_invalid");
  }
  return value as unknown as ReplayPremiereServerStartupIdentityV1;
}

function parseStartupSelectionEntry(
  value: unknown,
): ReplayPremiereStartupSelectionEntryV1 {
  if (!isRecord(value)) {
    throw coordinationIntegrity("coordination_selection_entry_invalid");
  }
  assertExactKeys(value, [
    "premiereId",
    "admissionRecordHash",
    "projectionState",
  ]);
  if (
    !isPremiereId(value.premiereId) ||
    !isSha256Hex(value.admissionRecordHash) ||
    !isPremiereState(value.projectionState)
  ) {
    throw coordinationIntegrity("coordination_selection_entry_invalid");
  }
  return value as unknown as ReplayPremiereStartupSelectionEntryV1;
}

async function readActiveServerWriterIdentity(
  privateStateRoot: string,
): Promise<ReplayPremiereServerWriterIdentityV1> {
  const writerPath = path.join(
    path.resolve(privateStateRoot),
    EVENT_STORE_WRITER_FILE,
  );
  const value = parseJson(
    await readBoundedRegularFile(writerPath, MAX_WRITER_IDENTITY_BYTES),
    "coordination_writer_identity_invalid_json",
  );
  if (!isRecord(value)) {
    throw coordinationIntegrity("coordination_writer_identity_invalid");
  }
  assertExactKeys(value, ["schemaVersion", "pid", "writerId", "acquiredAt"]);
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    typeof value.writerId !== "string" ||
    !UUID_PATTERN.test(value.writerId) ||
    canonicalTimestampOrNull(value.acquiredAt) === null
  ) {
    throw coordinationIntegrity("coordination_writer_identity_invalid");
  }
  const writer = value as unknown as ReplayPremiereServerWriterIdentityV1;
  if (!processIsAlive(writer.pid)) {
    throw coordinationUnavailable("coordination_writer_not_alive");
  }
  return writer;
}

function assertReceiptMatchesWriter(
  receipt: ReplayPremiereStartupSelectionReceiptV1,
  writer: ReplayPremiereServerWriterIdentityV1,
): void {
  if (
    receipt.server.pid !== writer.pid ||
    receipt.server.writerId !== writer.writerId ||
    receipt.server.writerAcquiredAt !== writer.acquiredAt ||
    Date.parse(receipt.server.startupStartedAt) <
      Date.parse(writer.acquiredAt) ||
    Date.parse(receipt.writtenAt) < Date.parse(receipt.server.startupStartedAt)
  ) {
    throw coordinationUnavailable("coordination_selection_stale");
  }
}

async function ensureCoordinationLayout(privateStateRoot: string): Promise<{
  coordinationRoot: string;
  tombstoneRoot: string;
  selectionPath: string;
}> {
  const root = await assertPrivateStateRoot(privateStateRoot);
  const coordinationRoot = await ensurePrivateDirectory(
    path.join(root, COORDINATION_DIRECTORY),
    root,
  );
  const tombstoneRoot = await ensurePrivateDirectory(
    path.join(coordinationRoot, TOMBSTONE_DIRECTORY),
    coordinationRoot,
  );
  return {
    coordinationRoot,
    tombstoneRoot,
    selectionPath: path.join(coordinationRoot, STARTUP_SELECTION_FILE),
  };
}

async function assertPrivateStateRoot(
  privateStateRoot: string,
): Promise<string> {
  const root = path.resolve(privateStateRoot);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw coordinationIntegrity("coordination_private_root_invalid");
  }
  if ((await fs.realpath(root)) !== root) {
    throw coordinationIntegrity("coordination_private_root_invalid");
  }
  return root;
}

async function ensurePrivateDirectory(
  directory: string,
  expectedParent: string,
): Promise<string> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw coordinationIntegrity("coordination_directory_invalid");
  }
  await fs.chmod(directory, 0o700);
  const [canonical, canonicalParent] = await Promise.all([
    fs.realpath(directory),
    fs.realpath(expectedParent),
  ]);
  if (
    canonical !== path.resolve(directory) ||
    path.dirname(canonical) !== canonicalParent
  ) {
    throw coordinationIntegrity("coordination_directory_alias_rejected");
  }
  await syncDirectory(canonicalParent);
  return canonical;
}

async function writeAtomicMutableJson(
  destination: string,
  value: unknown,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_COORDINATION_FILE_BYTES) {
    throw coordinationCapacity("coordination_file_size_exceeded");
  }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await fs.open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, destination);
    created = false;
    await syncDirectory(path.dirname(destination));
  } finally {
    if (created) await fs.unlink(temporary).catch(() => undefined);
  }
}

async function writeImmutableJson(
  destination: string,
  value: unknown,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_COORDINATION_FILE_BYTES) {
    throw coordinationCapacity("coordination_file_size_exceeded");
  }
  try {
    const existing = await readBoundedRegularFile(
      destination,
      MAX_COORDINATION_FILE_BYTES,
    );
    if (existing.equals(bytes)) return;
    throw coordinationIntegrity("coordination_tombstone_is_immutable");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await fs.open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o400,
    );
    created = true;
    try {
      await handle.chmod(0o400);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = await readBoundedRegularFile(
        destination,
        MAX_COORDINATION_FILE_BYTES,
      );
      if (!existing.equals(bytes)) {
        throw coordinationIntegrity("coordination_tombstone_is_immutable");
      }
    }
    await fs.unlink(temporary);
    created = false;
    await syncDirectory(path.dirname(destination));
  } finally {
    if (created) await fs.unlink(temporary).catch(() => undefined);
  }
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw coordinationIntegrity("coordination_file_not_regular");
    }
    if (stat.size <= 0 || stat.size > maxBytes) {
      throw coordinationCapacity("coordination_file_size_invalid");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseJson(bytes: Buffer, operatorCode: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw coordinationIntegrity(operatorCode, error);
  }
}

function tombstonePath(root: string, premiereId: string): string {
  if (!isPremiereId(premiereId)) {
    throw coordinationIntegrity("coordination_premiere_id_invalid");
  }
  return path.join(root, `${premiereId}${TOMBSTONE_SUFFIX}`);
}

function isRetirementPhase(
  value: unknown,
): value is ReplayPremiereRetirementPhase {
  return value === "admitted" || value === "activated" || value === "live";
}

function isHoldPhase(
  value: unknown,
): value is "claimed" | ReplayPremiereRetirementPhase {
  return value === "claimed" || isRetirementPhase(value);
}

function isTerminalReleaseOutcome(
  value: unknown,
): value is ReplayPremiereTerminalReleaseOutcome {
  return (
    value === "expired" ||
    value === "leak_audit_refused" ||
    value === "activation_refused" ||
    value === "activation_lost" ||
    value === "ingest_failed" ||
    value === "admit_failed" ||
    value === "projection_over_budget"
  );
}

function isKnownReleaseOutcome(value: string): boolean {
  return (
    value === "revealed" ||
    value === "failed_or_cancelled" ||
    isTerminalReleaseOutcome(value)
  );
}

function isPremiereState(value: unknown): value is PremiereState {
  return (
    value === "draft" ||
    value === "scheduled" ||
    value === "playing" ||
    value === "checkpoint" ||
    value === "revealed" ||
    value === "archived" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isNonterminalPremiereState(value: PremiereState): boolean {
  return (
    value === "draft" ||
    value === "scheduled" ||
    value === "playing" ||
    value === "checkpoint"
  );
}

function isPremiereId(value: unknown): value is string {
  return typeof value === "string" && PREMIERE_ID_PATTERN.test(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value);
}

function isNullableSafeIdentifier(value: unknown): value is string | null {
  return value === null || isSafeIdentifier(value);
}

function canonicalTimestamp(value: string): string {
  const canonical = canonicalTimestampOrNull(value);
  if (canonical === null) {
    throw coordinationIntegrity("coordination_timestamp_invalid");
  }
  return canonical;
}

function canonicalTimestampOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? value
    : null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) {
    throw coordinationIntegrity("coordination_object_keys_invalid");
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function coordinationIntegrity(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    `Replay Premiere coordination failed integrity validation: ${operatorCode}`,
    cause === undefined ? undefined : { cause },
  );
}

function coordinationCapacity(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_CAPACITY_EXCEEDED",
    413,
    `Replay Premiere coordination exceeded a bounded limit: ${operatorCode}`,
  );
}

function coordinationUnavailable(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_UNAVAILABLE",
    503,
    `Replay Premiere coordination is unavailable: ${operatorCode}`,
  );
}
