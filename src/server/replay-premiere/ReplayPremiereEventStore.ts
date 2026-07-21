import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import {
  assertReplayPremiereJsonValue,
  canonicalReplayPremiereJson,
  cloneAndFreezeReplayPremiereValue,
  hashReplayPremiereJson,
  isSha256Hex,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import {
  assertPremiereDurableWriteAdmission,
  validatePremierePrivateLayout,
} from "./ReplayPremierePrivateStaging";

const aggregateIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const eventTypePattern = /^[a-z][a-z0-9_]{0,63}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const activeWriterRoots = new Set<string>();

export interface ReplayPremiereEventStoreLimits {
  maxEventBytes: number;
  maxAggregateEventBytes: number;
  maxEventLogBytes: number;
  maxSnapshotBytes: number;
  maxPrivateStateBytes: number;
}

export interface ReplayPremiereEventStoreOptions {
  privateStateRoot: string;
  servedRoots: readonly string[];
  limits: ReplayPremiereEventStoreLimits;
  now?: () => Date;
  statfs?: typeof fs.statfs;
  eventWrite?: (
    handle: fs.FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
  ) => Promise<{ bytesWritten: number }>;
  eventSync?: (handle: fs.FileHandle) => Promise<void>;
  snapshotWrite?: (
    handle: fs.FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
  ) => Promise<{ bytesWritten: number }>;
  snapshotSync?: (handle: fs.FileHandle) => Promise<void>;
}

export interface ReplayPremiereEventInput {
  aggregateId: string;
  eventType: string;
  occurredAt: string;
  payload: ReplayPremiereJsonValue;
  idempotencyKey?: string;
  idempotencyStateHash?: string;
}

export interface StoredReplayPremiereEvent {
  schemaVersion: 1;
  eventSequence: number;
  eventId: string;
  aggregateId: string;
  eventType: string;
  occurredAt: string;
  payload: ReplayPremiereJsonValue;
  idempotencyKey: string | null;
  idempotencyStateHash: string | null;
  previousEventHash: string | null;
  eventHash: string;
}

export interface ReplayPremiereSnapshot {
  schemaVersion: 1;
  snapshotKind: "replay_premiere_aggregate";
  aggregateId: string;
  lastEventSequence: number;
  lastEventHash: string;
  state: ReplayPremiereJsonValue;
  stateHash: string;
  writtenAt: string;
}

export interface ReplayPremiereEventRecovery {
  events: StoredReplayPremiereEvent[];
  lastEventSequence: number;
  lastEventHash: string | null;
  eventLogBytes: number;
  aggregateBytes: Map<string, number>;
}

export interface ReplayPremiereEventRecoveryView {
  recovery: ReplayPremiereEventRecovery;
  snapshot: ReplayPremiereSnapshot | null;
}

export class ReplayPremiereEventStore {
  readonly privateStateRoot: string;
  readonly eventsPath: string;
  readonly snapshotsDirectory: string;
  private readonly lockPath: string;
  private readonly writerId: string;
  private readonly limits: ReplayPremiereEventStoreLimits;
  private readonly now: () => Date;
  private readonly statfs: typeof fs.statfs;
  private readonly eventWrite: NonNullable<
    ReplayPremiereEventStoreOptions["eventWrite"]
  >;
  private readonly eventSync: NonNullable<
    ReplayPremiereEventStoreOptions["eventSync"]
  >;
  private readonly snapshotWrite: NonNullable<
    ReplayPremiereEventStoreOptions["snapshotWrite"]
  >;
  private readonly snapshotSync: NonNullable<
    ReplayPremiereEventStoreOptions["snapshotSync"]
  >;
  private eventHandle: fs.FileHandle;
  private closed = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private privateStateBytes: number;
  private readonly recoveryState: ReplayPremiereEventRecovery;

  private constructor(options: {
    privateStateRoot: string;
    limits: ReplayPremiereEventStoreLimits;
    now: () => Date;
    statfs: typeof fs.statfs;
    eventWrite: NonNullable<ReplayPremiereEventStoreOptions["eventWrite"]>;
    eventSync: NonNullable<ReplayPremiereEventStoreOptions["eventSync"]>;
    snapshotWrite: NonNullable<
      ReplayPremiereEventStoreOptions["snapshotWrite"]
    >;
    snapshotSync: NonNullable<ReplayPremiereEventStoreOptions["snapshotSync"]>;
    eventsPath: string;
    snapshotsDirectory: string;
    lockPath: string;
    writerId: string;
    eventHandle: fs.FileHandle;
    recovered: ReplayPremiereEventRecovery;
    privateStateBytes: number;
  }) {
    this.privateStateRoot = options.privateStateRoot;
    this.eventsPath = options.eventsPath;
    this.snapshotsDirectory = options.snapshotsDirectory;
    this.lockPath = options.lockPath;
    this.writerId = options.writerId;
    this.limits = options.limits;
    this.now = options.now;
    this.statfs = options.statfs;
    this.eventWrite = options.eventWrite;
    this.eventSync = options.eventSync;
    this.snapshotWrite = options.snapshotWrite;
    this.snapshotSync = options.snapshotSync;
    this.eventHandle = options.eventHandle;
    this.recoveryState = options.recovered;
    this.privateStateBytes = options.privateStateBytes;
  }

  get recovered(): ReplayPremiereEventRecovery {
    return {
      // Stored events are cloned and recursively frozen when they cross the
      // append/recovery trust boundary. Return a caller-owned array while
      // reusing those immutable event objects; re-canonicalizing a large reveal
      // payload on every recovery read makes multi-target startup scale with
      // targets x journal bytes without adding isolation.
      events: [...this.recoveryState.events],
      lastEventSequence: this.recoveryState.lastEventSequence,
      lastEventHash: this.recoveryState.lastEventHash,
      eventLogBytes: this.recoveryState.eventLogBytes,
      aggregateBytes: new Map(this.recoveryState.aggregateBytes),
    };
  }

  static async open(
    options: ReplayPremiereEventStoreOptions,
  ): Promise<ReplayPremiereEventStore> {
    validateStoreLimits(options.limits);
    const layout = await validatePremierePrivateLayout(options);
    const storeRoot = path.join(layout.privateStateRoot, "event-store-v1");
    await fs.mkdir(storeRoot, { recursive: true, mode: 0o700 });
    const canonicalStoreRoot = await fs.realpath(storeRoot);
    if (activeWriterRoots.has(canonicalStoreRoot)) {
      throw writerError("writer_already_active_in_process");
    }
    const eventsPath = path.join(canonicalStoreRoot, "events.jsonl");
    const snapshotsDirectory = path.join(canonicalStoreRoot, "snapshots");
    const recoveryDirectory = path.join(canonicalStoreRoot, "recovery");
    await Promise.all([
      fs.mkdir(snapshotsDirectory, { recursive: true, mode: 0o700 }),
      fs.mkdir(recoveryDirectory, { recursive: true, mode: 0o700 }),
    ]);
    const lockPath = path.join(canonicalStoreRoot, "write-owner.json");
    const writerId = randomUUID();
    await acquireWriterLock(lockPath, recoveryDirectory, writerId);
    let eventHandle: fs.FileHandle | null = null;
    try {
      const recovered = await recoverReplayPremiereEventLog(
        eventsPath,
        options.limits,
      );
      const privateStateBytes = await measurePrivateStateBytes(
        canonicalStoreRoot,
        options.limits.maxPrivateStateBytes,
      );
      eventHandle = await fs.open(
        eventsPath,
        constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
        0o600,
      );
      activeWriterRoots.add(canonicalStoreRoot);
      return new ReplayPremiereEventStore({
        privateStateRoot: canonicalStoreRoot,
        limits: options.limits,
        now: options.now ?? (() => new Date()),
        statfs: options.statfs ?? fs.statfs,
        eventWrite:
          options.eventWrite ??
          (async (handle, buffer, offset, length) =>
            handle.write(buffer, offset, length, null)),
        eventSync: options.eventSync ?? (async (handle) => handle.sync()),
        snapshotWrite:
          options.snapshotWrite ??
          (async (handle, buffer, offset, length) =>
            handle.write(buffer, offset, length, null)),
        snapshotSync: options.snapshotSync ?? (async (handle) => handle.sync()),
        eventsPath,
        snapshotsDirectory,
        lockPath,
        writerId,
        eventHandle,
        recovered,
        privateStateBytes,
      });
    } catch (error) {
      await eventHandle?.close();
      await releaseWriterLock(lockPath, writerId).catch(() => undefined);
      throw error;
    }
  }

  async append(
    input: ReplayPremiereEventInput,
  ): Promise<StoredReplayPremiereEvent> {
    return this.runExclusive(async () => this.appendUnlocked(input));
  }

  /**
   * Appends one durable event and then atomically replaces its recovery
   * snapshot under the same writer queue. A crash after the append but before
   * snapshot rename is recovered by replaying the committed event.
   */
  async appendAndSnapshot(options: {
    event: ReplayPremiereEventInput;
    state: ReplayPremiereJsonValue;
    idempotencyKey?: string;
  }): Promise<{
    event: StoredReplayPremiereEvent;
    snapshot: ReplayPremiereSnapshot;
  }> {
    return this.runExclusive(async () => {
      const acceptedState = immutable(
        options.state,
        "idempotent snapshot state",
      );
      const idempotencyStateHash = hashReplayPremiereJson(acceptedState);
      const idempotencyKey =
        options.idempotencyKey ?? options.event.idempotencyKey;
      if (
        typeof idempotencyKey !== "string" ||
        !idempotencyKeyPattern.test(idempotencyKey)
      ) {
        throw new ReplayPremiereError(
          "invalid_event_idempotency_key",
          "PREMIERE_INVALID_REQUEST",
          400,
          "Replay premiere idempotency key is invalid",
        );
      }
      const input = immutable(
        { ...options.event, idempotencyKey, idempotencyStateHash },
        "idempotent event input",
      );
      const existing = this.recoveryState.events.find(
        (candidate) =>
          candidate.aggregateId === input.aggregateId &&
          candidate.idempotencyKey === idempotencyKey,
      );
      let event: StoredReplayPremiereEvent;
      if (existing === undefined) {
        event = await this.appendUnlocked(input);
      } else {
        if (
          existing.eventType !== input.eventType ||
          existing.occurredAt !== input.occurredAt ||
          !sameJson(existing.payload, input.payload) ||
          existing.idempotencyStateHash !== idempotencyStateHash
        ) {
          throw storeIntegrity("idempotency_key_payload_mismatch");
        }
        const latestForAggregate = [...this.recoveryState.events]
          .reverse()
          .find((candidate) => candidate.aggregateId === input.aggregateId);
        if (latestForAggregate?.eventHash !== existing.eventHash) {
          throw storeIntegrity("idempotent_operation_superseded");
        }
        const existingSnapshot = await this.readSnapshot(input.aggregateId);
        if (
          existingSnapshot !== null &&
          existingSnapshot.lastEventHash === existing.eventHash &&
          existingSnapshot.lastEventSequence === existing.eventSequence
        ) {
          if (existingSnapshot.stateHash !== idempotencyStateHash) {
            throw storeIntegrity("idempotent_snapshot_state_mismatch");
          }
          return immutable(
            { event: existing, snapshot: existingSnapshot },
            "idempotent event and snapshot replay",
          );
        }
        event = existing;
      }
      let snapshot: ReplayPremiereSnapshot;
      try {
        snapshot = await this.writeSnapshotUnlocked(
          input.aggregateId,
          event,
          acceptedState,
        );
      } catch (error) {
        await this.poisonAfterAmbiguousEventWrite();
        throw error;
      }
      return immutable({ event, snapshot }, "event and snapshot result");
    });
  }

  async writeSnapshot(
    aggregateId: string,
    state: ReplayPremiereJsonValue,
  ): Promise<ReplayPremiereSnapshot> {
    return this.runExclusive(async () => {
      const anchor = [...this.recoveryState.events]
        .reverse()
        .find((event) => event.aggregateId === aggregateId);
      if (anchor === undefined) throw storeIntegrity("snapshot_missing_anchor");
      return this.writeSnapshotUnlocked(aggregateId, anchor, state);
    });
  }

  async readSnapshot(
    aggregateId: string,
  ): Promise<ReplayPremiereSnapshot | null> {
    assertAggregateId(aggregateId);
    const snapshotPath = path.join(
      this.snapshotsDirectory,
      `${aggregateId}.snapshot.json`,
    );
    let bytes: Buffer;
    try {
      bytes = await readBoundedRegularFile(
        snapshotPath,
        this.limits.maxSnapshotBytes,
        "snapshot",
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    if (bytes.byteLength > this.limits.maxSnapshotBytes) {
      throw storeCapacity("snapshot_byte_ceiling_exceeded");
    }
    const snapshot = parseSnapshot(bytes, aggregateId);
    const anchor = this.recoveryState.events.find(
      (event) =>
        event.eventSequence === snapshot.lastEventSequence &&
        event.eventHash === snapshot.lastEventHash &&
        event.aggregateId === aggregateId,
    );
    if (anchor === undefined) throw storeIntegrity("snapshot_anchor_mismatch");
    return immutable(snapshot, "snapshot read view");
  }

  /**
   * Returns the event tip and one aggregate snapshot from the same serialized
   * writer boundary. Startup recovery must use this instead of reading
   * `recovered` and `readSnapshot()` separately.
   */
  async readRecoveryView(
    aggregateId: string,
  ): Promise<ReplayPremiereEventRecoveryView> {
    return this.runExclusive(async () => ({
      recovery: this.recovered,
      snapshot: await this.readSnapshot(aggregateId),
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.writeQueue;
    this.closed = true;
    await this.eventHandle.close();
    activeWriterRoots.delete(this.privateStateRoot);
    await releaseWriterLock(this.lockPath, this.writerId);
  }

  private async appendUnlocked(
    input: ReplayPremiereEventInput,
  ): Promise<StoredReplayPremiereEvent> {
    this.assertOpen();
    validateEventInput(input);
    const acceptedInput = immutable(input, "event append input");
    const eventSequence = this.recoveryState.lastEventSequence + 1;
    const withoutHash = {
      schemaVersion: 1 as const,
      eventSequence,
      eventId: randomUUID(),
      aggregateId: acceptedInput.aggregateId,
      eventType: acceptedInput.eventType,
      occurredAt: acceptedInput.occurredAt,
      payload: acceptedInput.payload,
      idempotencyKey: acceptedInput.idempotencyKey ?? null,
      idempotencyStateHash: acceptedInput.idempotencyStateHash ?? null,
      previousEventHash: this.recoveryState.lastEventHash,
    };
    const eventValue: unknown = withoutHash;
    assertReplayPremiereJsonValue(eventValue, "replay premiere event");
    const event = immutable<StoredReplayPremiereEvent>(
      {
        ...withoutHash,
        eventHash: hashReplayPremiereJson(eventValue),
      },
      "stored replay premiere event",
    );
    const line = Buffer.from(`${canonicalEventJson(event)}\n`, "utf8");
    const bytes = line.byteLength;
    if (line.byteLength > this.limits.maxEventBytes) {
      throw storeCapacity("event_byte_ceiling_exceeded");
    }
    const aggregateBytes =
      (this.recoveryState.aggregateBytes.get(acceptedInput.aggregateId) ?? 0) +
      bytes;
    if (aggregateBytes > this.limits.maxAggregateEventBytes) {
      throw storeCapacity("aggregate_event_byte_ceiling_exceeded");
    }
    if (
      this.recoveryState.eventLogBytes + bytes >
      this.limits.maxEventLogBytes
    ) {
      throw storeCapacity("event_log_byte_ceiling_exceeded");
    }
    if (this.privateStateBytes + bytes > this.limits.maxPrivateStateBytes) {
      throw storeCapacity("private_state_byte_ceiling_exceeded");
    }
    await assertPremiereDurableWriteAdmission({
      destinationPath: this.privateStateRoot,
      pendingBytes: bytes,
      statfs: this.statfs,
    });
    let writeStarted = false;
    try {
      let offset = 0;
      while (offset < line.byteLength) {
        writeStarted = true;
        const result = await this.eventWrite(
          this.eventHandle,
          line,
          offset,
          line.byteLength - offset,
        );
        if (
          !Number.isSafeInteger(result.bytesWritten) ||
          result.bytesWritten <= 0 ||
          result.bytesWritten > line.byteLength - offset
        ) {
          throw storeIntegrity("invalid_or_zero_event_short_write");
        }
        offset += result.bytesWritten;
      }
      await this.eventSync(this.eventHandle);
    } catch (error) {
      if (writeStarted) await this.poisonAfterAmbiguousEventWrite();
      throw error;
    }
    this.recoveryState.events.push(event);
    this.recoveryState.lastEventSequence = event.eventSequence;
    this.recoveryState.lastEventHash = event.eventHash;
    this.recoveryState.eventLogBytes += bytes;
    this.recoveryState.aggregateBytes.set(
      acceptedInput.aggregateId,
      aggregateBytes,
    );
    this.privateStateBytes += bytes;
    return immutable(event, "event append result");
  }

  private async writeSnapshotUnlocked(
    aggregateId: string,
    anchor: StoredReplayPremiereEvent,
    state: ReplayPremiereJsonValue,
  ): Promise<ReplayPremiereSnapshot> {
    this.assertOpen();
    assertAggregateId(aggregateId);
    assertReplayPremiereJsonValue(state, "replay premiere snapshot state");
    const acceptedState = immutable(state, "snapshot state input");
    if (anchor.aggregateId !== aggregateId) {
      throw storeIntegrity("snapshot_anchor_aggregate_mismatch");
    }
    const snapshot = immutable<ReplayPremiereSnapshot>(
      {
        schemaVersion: 1,
        snapshotKind: "replay_premiere_aggregate",
        aggregateId,
        lastEventSequence: anchor.eventSequence,
        lastEventHash: anchor.eventHash,
        state: acceptedState,
        stateHash: hashReplayPremiereJson(acceptedState),
        writtenAt: this.now().toISOString(),
      },
      "replay premiere snapshot",
    );
    const bytes = Buffer.from(
      `${canonicalReplayPremiereJson(snapshot as unknown as ReplayPremiereJsonValue)}\n`,
      "utf8",
    );
    if (bytes.byteLength > this.limits.maxSnapshotBytes) {
      throw storeCapacity("snapshot_byte_ceiling_exceeded");
    }
    const destinationPath = path.join(
      this.snapshotsDirectory,
      `${aggregateId}.snapshot.json`,
    );
    const temporaryPath = path.join(
      this.snapshotsDirectory,
      `.${aggregateId}.${randomUUID()}.tmp`,
    );
    const priorBytes = await fileSizeOrZero(destinationPath);
    if (
      this.privateStateBytes - priorBytes + bytes.byteLength >
      this.limits.maxPrivateStateBytes
    ) {
      throw storeCapacity("private_state_byte_ceiling_exceeded");
    }
    await assertPremiereDurableWriteAdmission({
      destinationPath: this.snapshotsDirectory,
      pendingBytes: bytes.byteLength,
      statfs: this.statfs,
    });
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(
        temporaryPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await this.snapshotWrite(
          handle,
          bytes,
          offset,
          bytes.byteLength - offset,
        );
        if (bytesWritten <= 0) throw storeIntegrity("snapshot_short_write");
        offset += bytesWritten;
      }
      await this.snapshotSync(handle);
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, destinationPath);
      const directoryHandle = await fs.open(
        this.snapshotsDirectory,
        constants.O_RDONLY,
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    this.privateStateBytes =
      this.privateStateBytes - priorBytes + bytes.byteLength;
    return immutable(snapshot, "snapshot write result");
  }

  private async poisonAfterAmbiguousEventWrite(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.eventHandle.close().catch(() => undefined);
    activeWriterRoots.delete(this.privateStateRoot);
    await releaseWriterLock(this.lockPath, this.writerId).catch(
      () => undefined,
    );
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw writerError("event_store_closed");
  }
}

export async function recoverReplayPremiereEventLog(
  eventsPath: string,
  limits: ReplayPremiereEventStoreLimits,
): Promise<ReplayPremiereEventRecovery> {
  let bytes: Buffer;
  try {
    bytes = await readBoundedRegularFile(
      eventsPath,
      limits.maxEventLogBytes,
      "event_log",
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        events: [],
        lastEventSequence: -1,
        lastEventHash: null,
        eventLogBytes: 0,
        aggregateBytes: new Map(),
      };
    }
    throw error;
  }
  if (bytes.byteLength > limits.maxEventLogBytes) {
    throw storeCapacity("event_log_byte_ceiling_exceeded");
  }
  if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) {
    throw storeIntegrity("partial_trailing_event_line");
  }
  const text = bytes.toString("utf8");
  const lines = text === "" ? [] : text.slice(0, -1).split("\n");
  const events: StoredReplayPremiereEvent[] = [];
  const aggregateBytes = new Map<string, number>();
  let previousEventHash: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(`${line}\n`, "utf8") > limits.maxEventBytes) {
      throw storeCapacity("event_byte_ceiling_exceeded");
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw storeIntegrity("invalid_event_json", error);
    }
    const event = parseStoredEvent(value);
    if (
      event.eventSequence !== index ||
      event.previousEventHash !== previousEventHash
    ) {
      throw storeIntegrity("event_chain_not_contiguous");
    }
    const expectedHash = hashReplayPremiereJson(eventHashInput(event));
    if (event.eventHash !== expectedHash) {
      throw storeIntegrity("event_hash_mismatch");
    }
    const eventBytes = Buffer.byteLength(`${line}\n`, "utf8");
    const nextAggregateBytes =
      (aggregateBytes.get(event.aggregateId) ?? 0) + eventBytes;
    if (nextAggregateBytes > limits.maxAggregateEventBytes) {
      throw storeCapacity("aggregate_event_byte_ceiling_exceeded");
    }
    aggregateBytes.set(event.aggregateId, nextAggregateBytes);
    events.push(event);
    previousEventHash = event.eventHash;
  }
  return {
    events,
    lastEventSequence: events.length - 1,
    lastEventHash: previousEventHash,
    eventLogBytes: bytes.byteLength,
    aggregateBytes,
  };
}

function parseStoredEvent(value: unknown): StoredReplayPremiereEvent {
  if (!isRecord(value)) throw storeIntegrity("event_not_object");
  assertExactKeys(
    value,
    [
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
    ],
    "event",
  );
  const event = value as unknown as StoredReplayPremiereEvent;
  if (
    event.schemaVersion !== 1 ||
    !Number.isSafeInteger(event.eventSequence) ||
    event.eventSequence < 0 ||
    typeof event.eventId !== "string" ||
    !aggregateIdPattern.test(event.aggregateId) ||
    !eventTypePattern.test(event.eventType) ||
    assertTimestampOrNull(event.occurredAt) === null ||
    (event.idempotencyKey !== null &&
      !idempotencyKeyPattern.test(event.idempotencyKey)) ||
    (event.idempotencyStateHash !== null &&
      !isSha256Hex(event.idempotencyStateHash)) ||
    (event.idempotencyKey === null) !== (event.idempotencyStateHash === null) ||
    (event.previousEventHash !== null &&
      !isSha256Hex(event.previousEventHash)) ||
    !isSha256Hex(event.eventHash)
  ) {
    throw storeIntegrity("invalid_event_contract");
  }
  assertReplayPremiereJsonValue(event.payload, "stored event payload");
  return immutable(event, "parsed stored event");
}

function eventHashInput(
  event: StoredReplayPremiereEvent,
): ReplayPremiereJsonValue {
  const value: unknown = {
    schemaVersion: event.schemaVersion,
    eventSequence: event.eventSequence,
    eventId: event.eventId,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    payload: event.payload,
    idempotencyKey: event.idempotencyKey,
    idempotencyStateHash: event.idempotencyStateHash,
    previousEventHash: event.previousEventHash,
  };
  assertReplayPremiereJsonValue(value, "event hash input");
  return value;
}

function canonicalEventJson(event: StoredReplayPremiereEvent): string {
  const value: unknown = event;
  assertReplayPremiereJsonValue(value, "stored replay premiere event");
  return canonicalReplayPremiereJson(value);
}

function parseSnapshot(
  bytes: Buffer,
  aggregateId: string,
): ReplayPremiereSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw storeIntegrity("invalid_snapshot_json", error);
  }
  if (!isRecord(value)) throw storeIntegrity("snapshot_not_object");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "snapshotKind",
      "aggregateId",
      "lastEventSequence",
      "lastEventHash",
      "state",
      "stateHash",
      "writtenAt",
    ],
    "snapshot",
  );
  const snapshot = value as unknown as ReplayPremiereSnapshot;
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.snapshotKind !== "replay_premiere_aggregate" ||
    snapshot.aggregateId !== aggregateId ||
    !Number.isSafeInteger(snapshot.lastEventSequence) ||
    snapshot.lastEventSequence < 0 ||
    !isSha256Hex(snapshot.lastEventHash) ||
    !isSha256Hex(snapshot.stateHash) ||
    assertTimestampOrNull(snapshot.writtenAt) === null
  ) {
    throw storeIntegrity("invalid_snapshot_contract");
  }
  assertReplayPremiereJsonValue(snapshot.state, "snapshot state");
  if (hashReplayPremiereJson(snapshot.state) !== snapshot.stateHash) {
    throw storeIntegrity("snapshot_state_hash_mismatch");
  }
  return immutable(snapshot, "parsed snapshot");
}

function validateEventInput(input: ReplayPremiereEventInput): void {
  assertAggregateId(input.aggregateId);
  if (!eventTypePattern.test(input.eventType)) {
    throw new ReplayPremiereError(
      "invalid_event_type",
      "PREMIERE_INVALID_REQUEST",
      400,
      "Replay premiere event type is invalid",
    );
  }
  if (assertTimestampOrNull(input.occurredAt) === null) {
    throw new ReplayPremiereError(
      "invalid_event_timestamp",
      "PREMIERE_INVALID_REQUEST",
      400,
      "Replay premiere event timestamp is invalid",
    );
  }
  assertReplayPremiereJsonValue(input.payload, "event payload");
  if (
    (input.idempotencyKey === undefined) !==
    (input.idempotencyStateHash === undefined)
  ) {
    throw new ReplayPremiereError(
      "incomplete_event_idempotency_binding",
      "PREMIERE_INVALID_REQUEST",
      400,
      "Replay premiere event idempotency binding is incomplete",
    );
  }
  if (
    input.idempotencyKey !== undefined &&
    !idempotencyKeyPattern.test(input.idempotencyKey)
  ) {
    throw new ReplayPremiereError(
      "invalid_event_idempotency_key",
      "PREMIERE_INVALID_REQUEST",
      400,
      "Replay premiere event idempotency key is invalid",
    );
  }
  if (
    input.idempotencyStateHash !== undefined &&
    !isSha256Hex(input.idempotencyStateHash)
  ) {
    throw new ReplayPremiereError(
      "invalid_event_idempotency_state_hash",
      "PREMIERE_INVALID_REQUEST",
      400,
      "Replay premiere idempotency state hash is invalid",
    );
  }
}

function validateStoreLimits(limits: ReplayPremiereEventStoreLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ReplayPremiereError(
        "invalid_event_store_limit",
        "PREMIERE_INVALID_REQUEST",
        400,
        `Replay premiere event store limit is invalid: ${name}`,
      );
    }
  }
  if (
    limits.maxEventBytes > limits.maxAggregateEventBytes ||
    limits.maxAggregateEventBytes > limits.maxEventLogBytes ||
    limits.maxSnapshotBytes > limits.maxPrivateStateBytes ||
    limits.maxEventLogBytes > limits.maxPrivateStateBytes
  ) {
    throw new ReplayPremiereError(
      "inconsistent_event_store_limits",
      "PREMIERE_INVALID_REQUEST",
      400,
      "Replay premiere event store limits are inconsistent",
    );
  }
}

async function acquireWriterLock(
  lockPath: string,
  recoveryDirectory: string,
  writerId: string,
): Promise<void> {
  const lock = {
    schemaVersion: 1,
    pid: process.pid,
    writerId,
    acquiredAt: new Date().toISOString(),
  };
  const lockBytes = `${JSON.stringify(lock)}\n`;
  try {
    await fs.writeFile(lockPath, lockBytes, { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  let existing: unknown;
  try {
    existing = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch (error) {
    throw writerError("unreadable_existing_writer_lock", error);
  }
  if (!isRecord(existing) || !Number.isSafeInteger(existing.pid)) {
    throw writerError("invalid_existing_writer_lock");
  }
  if (isProcessAlive(Number(existing.pid))) {
    throw writerError("writer_already_active_on_host");
  }
  const retainedLockPath = path.join(
    recoveryDirectory,
    `stale-write-owner-${Date.now()}-${randomUUID()}.json`,
  );
  await fs.rename(lockPath, retainedLockPath);
  try {
    await fs.writeFile(lockPath, lockBytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw writerError("writer_lock_reacquisition_failed", error);
  }
}

async function releaseWriterLock(
  lockPath: string,
  writerId: string,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!isRecord(value) || value.writerId !== writerId) {
    throw writerError("writer_lock_ownership_changed");
  }
  await fs.unlink(lockPath);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function measurePrivateStateBytes(
  root: string,
  ceiling: number,
): Promise<number> {
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw storeIntegrity("state_tree_contains_symlink");
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) {
        total += (await fs.stat(entryPath)).size;
        if (total > ceiling)
          throw storeCapacity("private_state_byte_ceiling_exceeded");
      } else {
        throw storeIntegrity("state_tree_contains_special_file");
      }
    }
  };
  await visit(root);
  return total;
}

async function fileSizeOrZero(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
  source: "event_log" | "snapshot",
): Promise<Buffer> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw storeIntegrity(`${source}_not_regular_file`);
  }
  if (before.size > maxBytes) {
    throw storeCapacity(`${source}_byte_ceiling_exceeded`);
  }
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== 1 ||
      !opened.isFile()
    ) {
      throw storeIntegrity(`${source}_identity_changed_before_read`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead <= 0) {
        throw storeIntegrity(`${source}_short_read`);
      }
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      throw storeIntegrity(`${source}_changed_during_read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertAggregateId(value: string): void {
  if (!aggregateIdPattern.test(value) || value.includes("..")) {
    throw new ReplayPremiereError(
      "invalid_event_aggregate_id",
      "PREMIERE_INVALID_REQUEST",
      400,
      "Replay premiere aggregate id is invalid",
    );
  }
}

function assertTimestampOrNull(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function immutable<T>(value: T, source: string): T {
  return cloneAndFreezeReplayPremiereValue(value, source);
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    assertReplayPremiereJsonValue(left);
    assertReplayPremiereJsonValue(right);
    return hashReplayPremiereJson(left) === hashReplayPremiereJson(right);
  } catch {
    return false;
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  source: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw storeIntegrity(`${source}_unknown_or_missing_field`);
  }
}

function storeIntegrity(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    `Replay premiere event-store integrity check failed: ${operatorCode}`,
    cause === undefined ? undefined : { cause },
  );
}

function storeCapacity(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_CAPACITY_EXCEEDED",
    413,
    `Replay premiere event-store capacity check failed: ${operatorCode}`,
  );
}

function writerError(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_UNAVAILABLE",
    503,
    `Replay premiere writer is unavailable: ${operatorCode}`,
    cause === undefined ? undefined : { cause },
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
