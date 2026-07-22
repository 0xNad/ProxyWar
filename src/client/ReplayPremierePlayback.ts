import { Turn, TurnSchema } from "../core/Schemas";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PREMIERE_ID = /^prem_[a-z0-9]{16,32}$/;
const StrictTurnSchema = TurnSchema.strict();

export type ReplayPremiereProtocolErrorCode =
  | "invalid_configuration"
  | "wrong_premiere"
  | "unverified_batch"
  | "invalid_batch"
  | "invalid_hash"
  | "chunk_gap"
  | "conflicting_duplicate"
  | "hash_chain_mismatch"
  | "sequence_gap"
  | "turn_gap"
  | "already_finalized"
  | "invalid_finalization"
  | "finalization_conflict"
  | "future_seek"
  | "backward_seek"
  | "dispatch_order"
  | "playback_not_complete";

/**
 * A stable, non-user-facing protocol failure. UI code should map `code` to
 * sanitized translated copy instead of displaying `message` publicly.
 */
export class ReplayPremiereProtocolError extends Error {
  constructor(
    public readonly code: ReplayPremiereProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReplayPremiereProtocolError";
  }
}

export interface ReplayPremiereReleasedTurn {
  /** Immutable premiere release sequence, independent from the game turn. */
  sequence: number;
  /** Verified server-committed presentation time, already rate-normalized. */
  presentationOffsetMs: number;
  /** A complete real-client Turn derived from released wire records. */
  turn: Turn;
}

/**
 * Wire-agnostic input to the playback controller. Main owns fetching and
 * canonical byte hashing; this type records that both advertised hashes were
 * checked before any turn reaches LocalServer.
 */
export interface VerifiedReplayPremiereBatch {
  premiereId: string;
  chunkIndex: number;
  chunkHash: string;
  previousChunkHash: string | null;
  payloadHash: string;
  startSequence: number;
  endSequence: number;
  verification: {
    payloadHashVerified: true;
    chunkHashVerified: true;
  };
  records: readonly ReplayPremiereReleasedTurn[];
}

export interface ReplayPremiereFinalizationSignal {
  premiereId: string;
  finalSequence: number;
  finalChunkHash: string;
  revealedAt: number;
  verification: {
    releaseChainVerified: true;
    publicationCommitmentVerified: true;
    publicationDraftManifestVerified: true;
    provenanceVerified: true;
    eligibilityCommitmentVerified: true;
    /** The source bytes stay private; only their declared digest is cross-bound. */
    sourceReplayIntegrityScope: "declared_hash_only";
    sourceReplayCommitmentMatched: true;
    authoritativeResultBytesVerified: true;
    resultCommitmentMatched: true;
    revealCommitmentVerified: true;
  };
}

export interface ReplayPremierePlaybackState {
  premiereId: string;
  nextChunkIndex: number;
  nextExpectedSequence: number;
  nextExpectedTurnNumber: number;
  releasedThroughSequence: number | null;
  lastDispatchedSequence: number | null;
  lastDispatchedTurnNumber: number | null;
  lastAcceptedPresentationOffsetMs: number | null;
  lastChunkHash: string | null;
  finalized: boolean;
  playbackComplete: boolean;
  /** True while the dispatcher is starved of released content. */
  buffering: boolean;
}

export type ReplayPremierePlaybackEvent =
  | {
      type: "batch";
      batch: Readonly<VerifiedReplayPremiereBatch>;
    }
  | {
      type: "catch-up";
      targetSequence: number;
    }
  | {
      type: "finalized";
      signal: Readonly<ReplayPremiereFinalizationSignal>;
    }
  | {
      type: "playback-complete";
      finalSequence: number;
    }
  | {
      /**
       * The dispatcher wanted the next record and none was released yet
       * (frontier stall or network hiccup). Surfaced so the overlay can show
       * a "Buffering live…" state instead of a silently frozen canvas;
       * clears automatically when dispatch resumes.
       */
      type: "buffering";
      buffering: boolean;
    };

export type ReplayPremierePlaybackListener = (
  event: ReplayPremierePlaybackEvent,
) => void;

export interface ReplayPremiereProgressiveReplayConfig {
  controller: ReplayPremierePlaybackController;
  /** Fixed public premiere rate. Viewers cannot change it before reveal. */
  playbackRate: 1 | 2 | 4;
}

export type ReplayPremiereAppendResult =
  | { status: "appended"; state: ReplayPremierePlaybackState }
  | { status: "duplicate"; state: ReplayPremierePlaybackState };

interface StoredBatchIdentity {
  chunkHash: string;
  previousChunkHash: string | null;
  payloadHash: string;
  startSequence: number;
  endSequence: number;
}

/**
 * Integrity boundary between premiere networking and the real replay client.
 * It accepts only independently hash-verified batches, enforces the immutable
 * chunk/sequence/turn chain, and exposes released state without any result.
 */
export class ReplayPremierePlaybackController {
  private readonly listeners = new Set<ReplayPremierePlaybackListener>();
  private readonly batches: Readonly<VerifiedReplayPremiereBatch>[] = [];
  private readonly batchIdentities = new Map<number, StoredBatchIdentity>();
  private readonly initialSequence = 0;
  private readonly initialTurnNumber = 0;

  private nextChunkIndex = 0;
  private nextExpectedSequence = 0;
  private nextExpectedTurnNumber = 0;
  private releasedThroughSequence: number | null = null;
  private lastDispatchedSequence: number | null = null;
  private lastDispatchedTurnNumber: number | null = null;
  private lastChunkHash: string | null = null;
  private lastAcceptedPresentationOffsetMs: number | null = null;
  private finalization: Readonly<ReplayPremiereFinalizationSignal> | null =
    null;
  private pendingCatchUpTarget: number | null = null;
  private playbackComplete = false;
  private dispatchStarved = false;

  constructor(public readonly premiereId: string) {
    if (!PREMIERE_ID.test(premiereId)) {
      throw new ReplayPremiereProtocolError(
        "invalid_configuration",
        "premiereId contains unsupported characters",
      );
    }
  }

  public state(): ReplayPremierePlaybackState {
    return Object.freeze({
      premiereId: this.premiereId,
      nextChunkIndex: this.nextChunkIndex,
      nextExpectedSequence: this.nextExpectedSequence,
      nextExpectedTurnNumber: this.nextExpectedTurnNumber,
      releasedThroughSequence: this.releasedThroughSequence,
      lastDispatchedSequence: this.lastDispatchedSequence,
      lastDispatchedTurnNumber: this.lastDispatchedTurnNumber,
      lastAcceptedPresentationOffsetMs: this.lastAcceptedPresentationOffsetMs,
      lastChunkHash: this.lastChunkHash,
      finalized: this.finalization !== null,
      playbackComplete: this.playbackComplete,
      buffering: this.dispatchStarved,
    });
  }

  /**
   * Subscriptions replay already accepted batches first, which makes creating
   * the controller before or after joinLobby deterministic.
   */
  public subscribe(listener: ReplayPremierePlaybackListener): () => void {
    this.listeners.add(listener);
    for (const batch of this.batches) {
      listener({ type: "batch", batch });
    }
    if (this.finalization) {
      listener({ type: "finalized", signal: this.finalization });
    }
    if (this.pendingCatchUpTarget !== null) {
      listener({
        type: "catch-up",
        targetSequence: this.pendingCatchUpTarget,
      });
    }
    if (this.playbackComplete && this.finalization) {
      listener({
        type: "playback-complete",
        finalSequence: this.finalization.finalSequence,
      });
    }
    if (this.dispatchStarved) {
      listener({ type: "buffering", buffering: true });
    }
    return () => this.listeners.delete(listener);
  }

  /**
   * Dispatcher starvation signal (LocalServer). Idempotent; a completed
   * playback is never "buffering" — the stream simply ended.
   */
  public reportDispatchStarvation(starved: boolean): void {
    const next = starved && !this.playbackComplete;
    if (next === this.dispatchStarved) {
      return;
    }
    this.dispatchStarved = next;
    this.emit({ type: "buffering", buffering: next });
  }

  public appendVerifiedBatch(
    input: VerifiedReplayPremiereBatch,
  ): ReplayPremiereAppendResult {
    this.assertBatchEnvelope(input);

    if (input.chunkIndex < this.nextChunkIndex) {
      this.assertIdempotentDuplicate(input);
      return { status: "duplicate", state: this.state() };
    }
    if (this.finalization) {
      throw new ReplayPremiereProtocolError(
        "already_finalized",
        "cannot append a replay batch after finalization",
      );
    }
    if (input.chunkIndex > this.nextChunkIndex) {
      throw new ReplayPremiereProtocolError(
        "chunk_gap",
        `expected chunk ${this.nextChunkIndex}, received ${input.chunkIndex}`,
      );
    }

    const previousChunkHash = normalizeOptionalHash(
      input.previousChunkHash,
      "previousChunkHash",
    );
    if (previousChunkHash !== this.lastChunkHash) {
      throw new ReplayPremiereProtocolError(
        "hash_chain_mismatch",
        `chunk ${input.chunkIndex} does not extend the accepted hash chain`,
      );
    }
    if (input.startSequence !== this.nextExpectedSequence) {
      throw new ReplayPremiereProtocolError(
        "sequence_gap",
        `expected sequence ${this.nextExpectedSequence}, received ${input.startSequence}`,
      );
    }

    const records = input.records.map((record, offset) => {
      const expectedSequence = this.nextExpectedSequence + offset;
      if (record.sequence !== expectedSequence) {
        throw new ReplayPremiereProtocolError(
          "sequence_gap",
          `expected sequence ${expectedSequence}, received ${record.sequence}`,
        );
      }
      const parsedTurn = StrictTurnSchema.safeParse(record.turn);
      if (!parsedTurn.success) {
        throw new ReplayPremiereProtocolError(
          "invalid_batch",
          `sequence ${record.sequence} does not contain a valid replay turn`,
        );
      }
      const expectedTurnNumber = this.nextExpectedTurnNumber + offset;
      if (
        parsedTurn.data.turnNumber !== expectedTurnNumber ||
        !Number.isSafeInteger(record.presentationOffsetMs) ||
        record.presentationOffsetMs < 0 ||
        (record.sequence === 0 && record.presentationOffsetMs !== 0) ||
        (record.sequence > 0 &&
          record.presentationOffsetMs <
            (offset === 0
              ? (this.lastAcceptedPresentationOffsetMs ?? -1)
              : input.records[offset - 1].presentationOffsetMs))
      ) {
        throw new ReplayPremiereProtocolError(
          parsedTurn.data.turnNumber !== expectedTurnNumber
            ? "turn_gap"
            : "invalid_batch",
          "replay record turn or presentation offset is invalid",
        );
      }
      return deepFreeze({
        sequence: record.sequence,
        presentationOffsetMs: record.presentationOffsetMs,
        turn: parsedTurn.data,
      });
    });

    const expectedEndSequence =
      input.startSequence + Math.max(0, records.length - 1);
    if (
      records.length === 0 ||
      input.endSequence !== expectedEndSequence ||
      input.records[0]?.sequence !== input.startSequence ||
      input.records[records.length - 1]?.sequence !== input.endSequence
    ) {
      throw new ReplayPremiereProtocolError(
        "invalid_batch",
        "batch sequence bounds do not match its released records",
      );
    }

    const chunkHash = normalizeHash(input.chunkHash, "chunkHash");
    const payloadHash = normalizeHash(input.payloadHash, "payloadHash");
    const batch = deepFreeze({
      ...input,
      chunkHash,
      previousChunkHash,
      payloadHash,
      records,
    });
    this.batches.push(batch);
    this.batchIdentities.set(input.chunkIndex, {
      chunkHash,
      previousChunkHash,
      payloadHash,
      startSequence: input.startSequence,
      endSequence: input.endSequence,
    });
    this.nextChunkIndex++;
    this.nextExpectedSequence = input.endSequence + 1;
    this.nextExpectedTurnNumber += records.length;
    this.releasedThroughSequence = input.endSequence;
    this.lastChunkHash = chunkHash;
    this.lastAcceptedPresentationOffsetMs =
      records[records.length - 1].presentationOffsetMs;
    this.emit({ type: "batch", batch });
    return { status: "appended", state: this.state() };
  }

  /**
   * Catch-up is forward-only and cannot exceed the last released sequence.
   * It is intended for late join/resync, never user-controlled premiere seek.
   */
  public requestForwardCatchUp(targetSequence: number): void {
    assertNonNegativeSafeInteger(
      targetSequence,
      "targetSequence",
      "future_seek",
    );
    const currentSequence =
      this.lastDispatchedSequence ?? this.initialSequence - 1;
    if (targetSequence <= currentSequence) {
      throw new ReplayPremiereProtocolError(
        "backward_seek",
        `cannot seek from sequence ${currentSequence} to ${targetSequence}`,
      );
    }
    if (
      this.releasedThroughSequence === null ||
      targetSequence > this.releasedThroughSequence
    ) {
      throw new ReplayPremiereProtocolError(
        "future_seek",
        `sequence ${targetSequence} has not been released`,
      );
    }
    this.pendingCatchUpTarget = Math.max(
      this.pendingCatchUpTarget ?? targetSequence,
      targetSequence,
    );
    this.emit({ type: "catch-up", targetSequence });
  }

  /** LocalServer acknowledges each turn only after dispatching it in order. */
  public acknowledgeDispatchedRecord(record: ReplayPremiereReleasedTurn): void {
    const expectedSequence =
      (this.lastDispatchedSequence ?? this.initialSequence - 1) + 1;
    const expectedTurnNumber =
      (this.lastDispatchedTurnNumber ?? this.initialTurnNumber - 1) + 1;
    if (
      record.sequence !== expectedSequence ||
      record.turn.turnNumber !== expectedTurnNumber ||
      this.releasedThroughSequence === null ||
      record.sequence > this.releasedThroughSequence
    ) {
      throw new ReplayPremiereProtocolError(
        "dispatch_order",
        `cannot dispatch sequence ${record.sequence} / turn ${record.turn.turnNumber}`,
      );
    }
    this.lastDispatchedSequence = record.sequence;
    this.lastDispatchedTurnNumber = record.turn.turnNumber;
    if (
      this.pendingCatchUpTarget !== null &&
      record.sequence >= this.pendingCatchUpTarget
    ) {
      this.pendingCatchUpTarget = null;
    }
  }

  public finalize(input: ReplayPremiereFinalizationSignal): void {
    this.assertFinalizationEnvelope(input);
    const finalChunkHash = normalizeHash(
      input.finalChunkHash,
      "finalChunkHash",
    );
    const signal = deepFreeze({ ...input, finalChunkHash });
    if (this.finalization) {
      if (
        this.finalization.finalSequence === signal.finalSequence &&
        this.finalization.finalChunkHash === signal.finalChunkHash &&
        this.finalization.revealedAt === signal.revealedAt
      ) {
        return;
      }
      throw new ReplayPremiereProtocolError(
        "finalization_conflict",
        "received conflicting replay finalization signals",
      );
    }
    if (
      this.releasedThroughSequence === null ||
      input.finalSequence !== this.releasedThroughSequence ||
      finalChunkHash !== this.lastChunkHash
    ) {
      throw new ReplayPremiereProtocolError(
        "invalid_finalization",
        "finalization does not match the complete released replay chain",
      );
    }
    this.finalization = signal;
    this.emit({ type: "finalized", signal });
  }

  /** Called by LocalServer after the finalized last turn is processed. */
  public markPlaybackComplete(): void {
    if (
      !this.finalization ||
      this.lastDispatchedSequence !== this.finalization.finalSequence
    ) {
      throw new ReplayPremiereProtocolError(
        "playback_not_complete",
        "the finalized replay has not been fully dispatched",
      );
    }
    if (this.playbackComplete) {
      return;
    }
    this.playbackComplete = true;
    this.reportDispatchStarvation(false);
    this.emit({
      type: "playback-complete",
      finalSequence: this.finalization.finalSequence,
    });
  }

  private assertBatchEnvelope(input: VerifiedReplayPremiereBatch): void {
    if (typeof input !== "object" || input === null) {
      throw new ReplayPremiereProtocolError(
        "invalid_batch",
        "batch must be an object",
      );
    }
    if (input.premiereId !== this.premiereId) {
      throw new ReplayPremiereProtocolError(
        "wrong_premiere",
        "batch belongs to a different premiere",
      );
    }
    if (!Array.isArray(input.records)) {
      throw new ReplayPremiereProtocolError(
        "invalid_batch",
        "batch records must be an array",
      );
    }
    if (
      input.verification?.payloadHashVerified !== true ||
      input.verification?.chunkHashVerified !== true
    ) {
      throw new ReplayPremiereProtocolError(
        "unverified_batch",
        "batch hashes must be verified before playback",
      );
    }
    assertNonNegativeSafeInteger(
      input.chunkIndex,
      "chunkIndex",
      "invalid_batch",
    );
    assertNonNegativeSafeInteger(
      input.startSequence,
      "startSequence",
      "invalid_batch",
    );
    assertNonNegativeSafeInteger(
      input.endSequence,
      "endSequence",
      "invalid_batch",
    );
    normalizeHash(input.chunkHash, "chunkHash");
    normalizeOptionalHash(input.previousChunkHash, "previousChunkHash");
    normalizeHash(input.payloadHash, "payloadHash");
  }

  private assertIdempotentDuplicate(input: VerifiedReplayPremiereBatch): void {
    const stored = this.batchIdentities.get(input.chunkIndex);
    const inputPreviousHash = normalizeOptionalHash(
      input.previousChunkHash,
      "previousChunkHash",
    );
    if (
      !stored ||
      stored.chunkHash !== normalizeHash(input.chunkHash, "chunkHash") ||
      stored.previousChunkHash !== inputPreviousHash ||
      stored.payloadHash !== normalizeHash(input.payloadHash, "payloadHash") ||
      stored.startSequence !== input.startSequence ||
      stored.endSequence !== input.endSequence
    ) {
      throw new ReplayPremiereProtocolError(
        "conflicting_duplicate",
        `chunk ${input.chunkIndex} conflicts with an accepted chunk`,
      );
    }
  }

  private assertFinalizationEnvelope(
    input: ReplayPremiereFinalizationSignal,
  ): void {
    if (typeof input !== "object" || input === null) {
      throw new ReplayPremiereProtocolError(
        "invalid_finalization",
        "finalization must be an object",
      );
    }
    if (input.premiereId !== this.premiereId) {
      throw new ReplayPremiereProtocolError(
        "wrong_premiere",
        "finalization belongs to a different premiere",
      );
    }
    if (
      input.verification?.releaseChainVerified !== true ||
      input.verification?.publicationCommitmentVerified !== true ||
      input.verification?.publicationDraftManifestVerified !== true ||
      input.verification?.provenanceVerified !== true ||
      input.verification?.eligibilityCommitmentVerified !== true ||
      input.verification?.sourceReplayIntegrityScope !== "declared_hash_only" ||
      input.verification?.sourceReplayCommitmentMatched !== true ||
      input.verification?.authoritativeResultBytesVerified !== true ||
      input.verification?.resultCommitmentMatched !== true ||
      input.verification?.revealCommitmentVerified !== true
    ) {
      throw new ReplayPremiereProtocolError(
        "invalid_finalization",
        "finalization integrity checks are incomplete",
      );
    }
    assertNonNegativeSafeInteger(
      input.finalSequence,
      "finalSequence",
      "invalid_finalization",
    );
    if (!Number.isFinite(input.revealedAt) || input.revealedAt < 0) {
      throw new ReplayPremiereProtocolError(
        "invalid_finalization",
        "revealedAt must be a non-negative timestamp",
      );
    }
  }

  private emit(event: ReplayPremierePlaybackEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function normalizeHash(value: string, field: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new ReplayPremiereProtocolError(
      "invalid_hash",
      `${field} must be a SHA-256 hex digest`,
    );
  }
  return value.toLowerCase();
}

function normalizeOptionalHash(
  value: string | null,
  field: string,
): string | null {
  return value === null ? null : normalizeHash(value, field);
}

function assertNonNegativeSafeInteger(
  value: number,
  field: string,
  code: ReplayPremiereProtocolErrorCode,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReplayPremiereProtocolError(
      code,
      `${field} must be a non-negative safe integer`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
