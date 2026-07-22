import {
  isPremiereId,
  REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS,
  type PremiereChunkDescriptor,
  type PremiereChunkDraft,
  type PremiereChunkPayload,
  type PremierePlaybackRate,
  type PremiereReleasedRecord,
  type PremiereSourceRecord,
  type ReleasedPremiereChunk,
} from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import { assertNoOutcomeBearingReplayFields } from "./ReplayPremiereImport";
import {
  assertReplayPremiereJsonValue,
  canonicalReplayPremiereJson,
  cloneAndFreezeReplayPremiereValue,
  hashReplayPremiereJson,
  isSha256Hex,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";

// Runtime events retain the released descriptor prefix for append-only
// recovery. Keep the V1 ceiling conservative enough for the 64 MiB
// per-premiere journal even when every permitted lifecycle version records an
// outage begin/recovery pair with the full descriptor prefix.
export const REPLAY_PREMIERE_MAX_CHUNK_COUNT = 128;

export interface BuildPremiereChunksOptions {
  premiereId: string;
  records: PremiereSourceRecord[];
  playbackRate: PremierePlaybackRate;
  checkpointSequences: readonly number[];
  maxChunkBytes: number;
  maxTotalBytes: number;
  maxRecordsPerChunk: number;
  maxPresentationSpanMs: number;
}

export function buildPremiereChunks(
  options: BuildPremiereChunksOptions,
): PremiereChunkDraft[] {
  validateBuildOptions(options);
  const checkpointSequences = new Set(options.checkpointSequences);
  const chunks: PremiereChunkDraft[] = [];
  let pending: PremiereReleasedRecord[] = [];
  const emptyPayloadBytes = payloadBytes({
    schemaVersion: 1,
    records: [],
  }).byteLength;
  let pendingPayloadBytes = emptyPayloadBytes;
  let previousPrepublicationHash: string | null = null;
  let totalBytes = 0;

  const flush = (terminal = false): void => {
    if (pending.length === 0) return;
    assertChunkCountWithinCeiling(chunks.length + 1);
    const chunk = createChunk(
      options.premiereId,
      chunks.length,
      previousPrepublicationHash,
      pending,
      terminal,
    );
    if (chunk.descriptor.byteLength > options.maxChunkBytes) {
      throw capacityError("chunk_byte_ceiling_exceeded");
    }
    totalBytes += chunk.descriptor.byteLength;
    if (totalBytes > options.maxTotalBytes) {
      throw capacityError("total_chunk_byte_ceiling_exceeded");
    }
    chunks.push(chunk);
    previousPrepublicationHash = chunk.descriptor.prepublicationHash;
    pending = [];
    pendingPayloadBytes = emptyPayloadBytes;
  };

  for (const sourceRecord of options.records) {
    const record = normalizeSourceRecord(sourceRecord, options.playbackRate);
    const recordBytes = canonicalReleasedRecordByteLength(record);
    const candidateBytes =
      pendingPayloadBytes + recordBytes + (pending.length === 0 ? 0 : 1);
    if (
      pending.length > 0 &&
      (pending.length + 1 > options.maxRecordsPerChunk ||
        candidateBytes > options.maxChunkBytes ||
        record.presentationOffsetMs - pending[0].presentationOffsetMs >
          options.maxPresentationSpanMs)
    ) {
      flush();
    }
    pending.push(record);
    pendingPayloadBytes += recordBytes + (pending.length === 1 ? 0 : 1);
    if (
      pending.length > options.maxRecordsPerChunk ||
      pendingPayloadBytes > options.maxChunkBytes ||
      presentationSpanMs(pending) > options.maxPresentationSpanMs
    ) {
      throw capacityError("single_record_exceeds_chunk_ceiling");
    }
    if (checkpointSequences.has(record.sequence)) {
      flush();
    }
  }
  flush(true);
  verifyPremiereChunkDraftChain(chunks, options.checkpointSequences, {
    maxPresentationSpanMs: options.maxPresentationSpanMs,
  });
  return chunks;
}

export function verifyPremiereChunkChain(
  chunks: readonly ReleasedPremiereChunk[],
  checkpointSequences: readonly number[] = [],
  options: {
    allowNonZeroFirstIndex?: boolean;
    allowNonNullInitialHash?: boolean;
    allowPartialChain?: boolean;
    maxPresentationSpanMs?: number;
  } = {},
): void {
  assertChunkCountWithinCeiling(chunks.length);
  let previousDescriptor: PremiereChunkDescriptor | null = null;
  for (const chunk of chunks) {
    const { descriptor, payload } = chunk;
    validateDescriptorNumbers(descriptor);
    if (!isPremiereId(descriptor.premiereId)) {
      throw integrityError("chunk_invalid_premiere_id");
    }
    if (payload.schemaVersion !== 1 || payload.records.length === 0) {
      throw integrityError("chunk_invalid_payload");
    }
    const bytes = payloadBytes(payload);
    if (
      bytes.byteLength !== descriptor.byteLength ||
      sha256Hex(bytes) !== descriptor.payloadHash
    ) {
      throw integrityError("chunk_payload_hash_mismatch");
    }
    const expectedChunkHash = hashReplayPremiereJson(
      descriptorHashInput(descriptor),
    );
    if (expectedChunkHash !== descriptor.chunkHash) {
      throw integrityError("chunk_hash_mismatch");
    }
    const firstRecord = payload.records[0];
    const lastRecord = payload.records[payload.records.length - 1];
    if (
      firstRecord.sequence !== descriptor.startSequence ||
      lastRecord.sequence !== descriptor.endSequence ||
      firstRecord.turn !== descriptor.startTurn ||
      lastRecord.turn !== descriptor.endTurn ||
      lastRecord.presentationOffsetMs !== descriptor.presentationOffsetMs
    ) {
      throw integrityError("chunk_descriptor_range_mismatch");
    }
    validateReleasedRecords(payload.records);
    assertPresentationSpan(
      payload.records,
      options.maxPresentationSpanMs ?? REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS,
    );
    if (previousDescriptor === null) {
      if (options.allowNonZeroFirstIndex !== true && descriptor.index !== 0) {
        throw integrityError("chunk_index_not_zero_based");
      }
      if (
        options.allowNonNullInitialHash !== true &&
        descriptor.previousChunkHash !== null
      ) {
        throw integrityError("chunk_initial_hash_not_null");
      }
    } else if (
      descriptor.premiereId !== previousDescriptor.premiereId ||
      descriptor.index !== previousDescriptor.index + 1 ||
      descriptor.startSequence !== previousDescriptor.endSequence + 1 ||
      descriptor.previousChunkHash !== previousDescriptor.chunkHash
    ) {
      throw integrityError("chunk_chain_not_contiguous");
    }
    previousDescriptor = descriptor;
  }

  if (options.allowPartialChain !== true && chunks.length > 0) {
    const terminalChunks = chunks.filter((chunk) => chunk.descriptor.terminal);
    if (
      terminalChunks.length !== 1 ||
      chunks[chunks.length - 1].descriptor.terminal !== true
    ) {
      throw integrityError("terminal_chunk_not_unique_and_last");
    }
  }

  for (const sequence of checkpointSequences) {
    const containing = chunks.filter(
      (chunk) =>
        chunk.descriptor.startSequence <= sequence &&
        chunk.descriptor.endSequence >= sequence,
    );
    if (
      containing.length !== 1 ||
      containing[0].descriptor.endSequence !== sequence
    ) {
      throw integrityError("checkpoint_not_chunk_boundary");
    }
  }
}

export function verifyPremiereChunkDraftChain(
  chunks: readonly PremiereChunkDraft[],
  checkpointSequences: readonly number[] = [],
  options: {
    allowNonZeroFirstIndex?: boolean;
    allowPartialChain?: boolean;
    maxPresentationSpanMs?: number;
  } = {},
): void {
  assertChunkCountWithinCeiling(chunks.length);
  let previousDescriptor: PremiereChunkDraft["descriptor"] | null = null;
  for (const chunk of chunks) {
    const { descriptor, payload } = chunk;
    validateDraftDescriptor(descriptor);
    validateChunkPayloadAgainstDescriptor(
      payload,
      descriptor,
      options.maxPresentationSpanMs ?? REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS,
    );
    const expectedHash = hashReplayPremiereJson(
      prepublicationHashInput(descriptor),
    );
    if (expectedHash !== descriptor.prepublicationHash) {
      throw integrityError("chunk_prepublication_hash_mismatch");
    }
    if (previousDescriptor === null) {
      if (options.allowNonZeroFirstIndex !== true && descriptor.index !== 0) {
        throw integrityError("chunk_index_not_zero_based");
      }
      if (
        options.allowNonZeroFirstIndex !== true &&
        descriptor.previousPrepublicationHash !== null
      ) {
        throw integrityError("chunk_initial_hash_not_null");
      }
    } else if (
      descriptor.premiereId !== previousDescriptor.premiereId ||
      descriptor.index !== previousDescriptor.index + 1 ||
      descriptor.startSequence !== previousDescriptor.endSequence + 1 ||
      descriptor.previousPrepublicationHash !==
        previousDescriptor.prepublicationHash
    ) {
      throw integrityError("chunk_prepublication_chain_not_contiguous");
    }
    previousDescriptor = descriptor;
  }
  assertTerminalAndCheckpointBoundaries(
    chunks,
    checkpointSequences,
    options.allowPartialChain === true,
  );
}

function assertChunkCountWithinCeiling(count: number): void {
  if (count > REPLAY_PREMIERE_MAX_CHUNK_COUNT) {
    throw capacityError("chunk_count_ceiling_exceeded");
  }
}

export function premiereChunkContentPath(chunkHash: string): string {
  if (!isSha256Hex(chunkHash)) {
    throw new ReplayPremiereError(
      "invalid_chunk_content_hash",
      "PREMIERE_INVALID_REQUEST",
      400,
      "Replay premiere chunk hash is invalid",
    );
  }
  return `chunks/sha256/${chunkHash.slice(0, 2)}/${chunkHash}.json`;
}

export function isPremiereChunkReleaseDue(
  chunk: PremiereChunkDraft | ReleasedPremiereChunk,
  authoritativeElapsedMs: number,
): boolean {
  return (
    Number.isSafeInteger(authoritativeElapsedMs) &&
    authoritativeElapsedMs >= chunk.descriptor.presentationOffsetMs
  );
}

function createChunk(
  premiereId: string,
  index: number,
  previousPrepublicationHash: string | null,
  records: PremiereReleasedRecord[],
  terminal: boolean,
): PremiereChunkDraft {
  const payload: PremiereChunkPayload = {
    schemaVersion: 1,
    records: [...records],
  };
  const bytes = payloadBytes(payload);
  const payloadHash = sha256Hex(bytes);
  const descriptorWithoutPrepublicationHash: Omit<
    PremiereChunkDraft["descriptor"],
    "prepublicationHash" | "releasedAt"
  > = {
    premiereId,
    index,
    startSequence: records[0].sequence,
    endSequence: records[records.length - 1].sequence,
    startTurn: records[0].turn,
    endTurn: records[records.length - 1].turn,
    presentationOffsetMs: records[records.length - 1].presentationOffsetMs,
    previousPrepublicationHash,
    payloadHash,
    byteLength: bytes.byteLength,
    terminal,
  };
  const prepublicationHash = hashReplayPremiereJson(
    descriptorWithoutPrepublicationHash as unknown as ReplayPremiereJsonValue,
  );
  return cloneAndFreezeReplayPremiereValue(
    {
      descriptor: {
        ...descriptorWithoutPrepublicationHash,
        prepublicationHash,
        releasedAt: null,
      },
      payload,
    },
    "premiere chunk draft",
  );
}

function descriptorHashInput(
  descriptor: Omit<PremiereChunkDescriptor, "chunkHash">,
): ReplayPremiereJsonValue {
  const value: unknown = {
    premiereId: descriptor.premiereId,
    index: descriptor.index,
    startSequence: descriptor.startSequence,
    endSequence: descriptor.endSequence,
    startTurn: descriptor.startTurn,
    endTurn: descriptor.endTurn,
    presentationOffsetMs: descriptor.presentationOffsetMs,
    previousChunkHash: descriptor.previousChunkHash,
    payloadHash: descriptor.payloadHash,
    byteLength: descriptor.byteLength,
    terminal: descriptor.terminal,
    releasedAt: descriptor.releasedAt,
  };
  assertReplayPremiereJsonValue(value, "chunk descriptor hash input");
  return value;
}

function prepublicationHashInput(
  descriptor: PremiereChunkDraft["descriptor"],
): ReplayPremiereJsonValue {
  const value: unknown = {
    premiereId: descriptor.premiereId,
    index: descriptor.index,
    startSequence: descriptor.startSequence,
    endSequence: descriptor.endSequence,
    startTurn: descriptor.startTurn,
    endTurn: descriptor.endTurn,
    presentationOffsetMs: descriptor.presentationOffsetMs,
    previousPrepublicationHash: descriptor.previousPrepublicationHash,
    payloadHash: descriptor.payloadHash,
    byteLength: descriptor.byteLength,
    terminal: descriptor.terminal,
  };
  assertReplayPremiereJsonValue(value, "chunk prepublication hash input");
  return value;
}

function normalizeSourceRecord(
  record: PremiereSourceRecord,
  playbackRate: PremierePlaybackRate,
): PremiereReleasedRecord {
  assertNoOutcomeBearingReplayFields(record.payload);
  return {
    sequence: record.sequence,
    turn: record.turn,
    presentationOffsetMs: Math.floor(record.nominalOffsetMs / playbackRate),
    payload: cloneAndFreezeReplayPremiereValue(
      record.payload,
      "premiere replay record payload",
    ),
  };
}

/**
 * Canonical payload JSON is `{"records":[...],"schemaVersion":1}`. Measuring
 * each accepted record once plus the exact comma delimiters is therefore
 * byte-for-byte equivalent to serializing the growing candidate array, while
 * avoiding quadratic work for long dense replays. `createChunk` still
 * canonicalizes the complete payload and binds the resulting bytes to the
 * descriptor hash before any draft can leave this module.
 */
function canonicalReleasedRecordByteLength(
  record: PremiereReleasedRecord,
): number {
  return Buffer.byteLength(
    canonicalReplayPremiereJson(record as unknown as ReplayPremiereJsonValue),
    "utf8",
  );
}

function validateBuildOptions(options: BuildPremiereChunksOptions): void {
  if (!isPremiereId(options.premiereId)) {
    throw invalidRequest("invalid_premiere_id");
  }
  if (![1, 2, 4].includes(options.playbackRate)) {
    throw invalidRequest("invalid_playback_rate");
  }
  for (const [name, value] of [
    ["maxChunkBytes", options.maxChunkBytes],
    ["maxTotalBytes", options.maxTotalBytes],
    ["maxRecordsPerChunk", options.maxRecordsPerChunk],
    ["maxPresentationSpanMs", options.maxPresentationSpanMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalidRequest(`invalid_${name}`);
    }
  }
  if (options.maxTotalBytes < options.maxChunkBytes) {
    throw invalidRequest("total_ceiling_below_chunk_ceiling");
  }
  if (
    options.maxPresentationSpanMs > REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS
  ) {
    throw invalidRequest("presentation_span_exceeds_hard_maximum");
  }
  if (!Array.isArray(options.records) || options.records.length < 4) {
    throw invalidRequest("insufficient_replay_records");
  }
  for (const [index, record] of options.records.entries()) {
    if (
      !Number.isSafeInteger(record.sequence) ||
      record.sequence !== index ||
      !Number.isSafeInteger(record.turn) ||
      record.turn < 0 ||
      !Number.isSafeInteger(record.nominalOffsetMs) ||
      record.nominalOffsetMs < 0
    ) {
      throw invalidRequest("invalid_source_record_order");
    }
    if (
      index > 0 &&
      (record.turn <= options.records[index - 1].turn ||
        record.nominalOffsetMs <= options.records[index - 1].nominalOffsetMs)
    ) {
      throw invalidRequest("non_monotonic_source_record");
    }
  }
  if (
    options.checkpointSequences.length !== 2 ||
    new Set(options.checkpointSequences).size !== 2
  ) {
    throw invalidRequest("premiere_requires_two_checkpoints");
  }
  const finalSequence = options.records.length - 1;
  for (const checkpoint of options.checkpointSequences) {
    if (
      !Number.isSafeInteger(checkpoint) ||
      checkpoint <= 0 ||
      checkpoint >= finalSequence
    ) {
      throw invalidRequest("invalid_checkpoint_sequence");
    }
  }
}

function validateReleasedRecords(records: PremiereReleasedRecord[]): void {
  for (const [index, record] of records.entries()) {
    if (
      !Number.isSafeInteger(record.sequence) ||
      !Number.isSafeInteger(record.turn) ||
      !Number.isSafeInteger(record.presentationOffsetMs) ||
      record.sequence < 0 ||
      record.turn < 0 ||
      record.presentationOffsetMs < 0
    ) {
      throw integrityError("chunk_invalid_record");
    }
    assertReplayPremiereJsonValue(record.payload, "premiere chunk record");
    assertNoOutcomeBearingReplayFields(record.payload);
    if (
      index > 0 &&
      (record.sequence !== records[index - 1].sequence + 1 ||
        record.turn <= records[index - 1].turn ||
        record.presentationOffsetMs < records[index - 1].presentationOffsetMs)
    ) {
      throw integrityError("chunk_records_not_contiguous");
    }
  }
}

function validateDescriptorNumbers(descriptor: PremiereChunkDescriptor): void {
  for (const value of [
    descriptor.index,
    descriptor.startSequence,
    descriptor.endSequence,
    descriptor.startTurn,
    descriptor.endTurn,
    descriptor.presentationOffsetMs,
    descriptor.byteLength,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw integrityError("chunk_invalid_descriptor_number");
    }
  }
  if (
    !isSha256Hex(descriptor.payloadHash) ||
    !isSha256Hex(descriptor.chunkHash) ||
    (descriptor.previousChunkHash !== null &&
      !isSha256Hex(descriptor.previousChunkHash))
  ) {
    throw integrityError("chunk_invalid_descriptor_hash");
  }
  if (descriptor.releasedAt === null) {
    throw integrityError("published_chunk_missing_release_time");
  }
  assertCanonicalTimestamp(descriptor.releasedAt);
}

function validateDraftDescriptor(
  descriptor: PremiereChunkDraft["descriptor"],
): void {
  for (const value of [
    descriptor.index,
    descriptor.startSequence,
    descriptor.endSequence,
    descriptor.startTurn,
    descriptor.endTurn,
    descriptor.presentationOffsetMs,
    descriptor.byteLength,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw integrityError("chunk_invalid_descriptor_number");
    }
  }
  if (
    !isPremiereId(descriptor.premiereId) ||
    !isSha256Hex(descriptor.payloadHash) ||
    !isSha256Hex(descriptor.prepublicationHash) ||
    (descriptor.previousPrepublicationHash !== null &&
      !isSha256Hex(descriptor.previousPrepublicationHash)) ||
    descriptor.releasedAt !== null
  ) {
    throw integrityError("chunk_invalid_prepublication_descriptor");
  }
}

function validateChunkPayloadAgainstDescriptor(
  payload: PremiereChunkPayload,
  descriptor: {
    startSequence: number;
    endSequence: number;
    startTurn: number;
    endTurn: number;
    presentationOffsetMs: number;
    payloadHash: string;
    byteLength: number;
  },
  maxPresentationSpanMs: number,
): void {
  if (payload.schemaVersion !== 1 || payload.records.length === 0) {
    throw integrityError("chunk_invalid_payload");
  }
  const bytes = payloadBytes(payload);
  if (
    bytes.byteLength !== descriptor.byteLength ||
    sha256Hex(bytes) !== descriptor.payloadHash
  ) {
    throw integrityError("chunk_payload_hash_mismatch");
  }
  const firstRecord = payload.records[0];
  const lastRecord = payload.records[payload.records.length - 1];
  if (
    firstRecord.sequence !== descriptor.startSequence ||
    lastRecord.sequence !== descriptor.endSequence ||
    firstRecord.turn !== descriptor.startTurn ||
    lastRecord.turn !== descriptor.endTurn ||
    lastRecord.presentationOffsetMs !== descriptor.presentationOffsetMs
  ) {
    throw integrityError("chunk_descriptor_range_mismatch");
  }
  validateReleasedRecords(payload.records);
  assertPresentationSpan(payload.records, maxPresentationSpanMs);
}

function presentationSpanMs(
  records: readonly PremiereReleasedRecord[],
): number {
  if (records.length === 0) return 0;
  return (
    records[records.length - 1].presentationOffsetMs -
    records[0].presentationOffsetMs
  );
}

function assertPresentationSpan(
  records: readonly PremiereReleasedRecord[],
  maxPresentationSpanMs: number,
): void {
  if (
    !Number.isSafeInteger(maxPresentationSpanMs) ||
    maxPresentationSpanMs <= 0 ||
    maxPresentationSpanMs > REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS ||
    presentationSpanMs(records) > maxPresentationSpanMs
  ) {
    throw integrityError("chunk_presentation_span_exceeded");
  }
}

function assertTerminalAndCheckpointBoundaries(
  chunks: ReadonlyArray<{
    descriptor: {
      startSequence: number;
      endSequence: number;
      terminal: boolean;
    };
  }>,
  checkpointSequences: readonly number[],
  allowPartialChain: boolean,
): void {
  if (!allowPartialChain && chunks.length > 0) {
    const terminalChunks = chunks.filter((chunk) => chunk.descriptor.terminal);
    if (
      terminalChunks.length !== 1 ||
      chunks[chunks.length - 1].descriptor.terminal !== true
    ) {
      throw integrityError("terminal_chunk_not_unique_and_last");
    }
  }
  for (const sequence of checkpointSequences) {
    const containing = chunks.filter(
      (chunk) =>
        chunk.descriptor.startSequence <= sequence &&
        chunk.descriptor.endSequence >= sequence,
    );
    if (
      containing.length !== 1 ||
      containing[0].descriptor.endSequence !== sequence
    ) {
      throw integrityError("checkpoint_not_chunk_boundary");
    }
  }
}

function payloadBytes(payload: PremiereChunkPayload): Buffer {
  const value: unknown = payload;
  assertReplayPremiereJsonValue(value, "premiere chunk payload");
  return Buffer.from(canonicalReplayPremiereJson(value), "utf8");
}

function assertCanonicalTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw invalidRequest("invalid_release_timestamp");
  }
}

function capacityError(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_CAPACITY_EXCEEDED",
    413,
    `Replay premiere chunk build rejected: ${operatorCode}`,
  );
}

function integrityError(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    `Replay premiere chunk integrity check failed: ${operatorCode}`,
  );
}

function invalidRequest(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    400,
    `Replay premiere chunk request rejected: ${operatorCode}`,
  );
}
