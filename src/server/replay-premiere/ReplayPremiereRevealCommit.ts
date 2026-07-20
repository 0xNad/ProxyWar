import { verifyPremiereChunkChain } from "./ReplayPremiereChunks";
import type { ReleasedPremiereChunk } from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import type {
  ReplayPremiereEventInput,
  ReplayPremiereSnapshot,
  StoredReplayPremiereEvent,
} from "./ReplayPremiereEventStore";
import {
  assertReplayPremiereJsonValue,
  cloneAndFreezeReplayPremiereValue,
  hashReplayPremiereJson,
  isSha256Hex,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import {
  VerifiedPremiereEligibilityGate,
  VerifiedPremiereTerminalChunk,
} from "./ReplayPremierePublication";
import {
  assertValidPremiereLifecycleSnapshot,
  transitionPremiereLifecycle,
  VerifiedPremiereRevealGate,
  type PremiereLifecycleSnapshot,
  type PremiereTransitionAuditEvent,
} from "./ReplayPremiereStateMachine";
import {
  createPremierePublicProvenance,
  createPremiereRevealPointer,
  createPremiereRevealResponse,
  toPremierePublicChunkResponse,
  verifyPremiereRevealResponse,
  type PremiereManifestResponse,
  type PremierePreRevealManifestResponse,
  type PremierePublicChunkDescriptor,
  type PremierePublicChunkResponse,
  type PremiereRevealPointerResponse,
  type PremiereRevealResponse,
} from "./ReplayPremiereWire";

export interface PremiereRevealPersistence {
  appendAndSnapshot(options: {
    event: ReplayPremiereEventInput;
    state: ReplayPremiereJsonValue;
    idempotencyKey?: string;
  }): Promise<{
    event: StoredReplayPremiereEvent;
    snapshot: ReplayPremiereSnapshot;
  }>;
}

export interface PremiereRevealCommitOptions {
  lockedLifecycle: PremiereLifecycleSnapshot;
  terminal: VerifiedPremiereTerminalChunk;
}

export interface PremiereRevealCommitResult {
  lifecycle: PremiereLifecycleSnapshot;
  reveal: PremiereRevealResponse;
  pointer: PremiereRevealPointerResponse;
  terminalChunk: PremierePublicChunkResponse;
  event: StoredReplayPremiereEvent;
  snapshot: ReplayPremiereSnapshot;
}

interface PublishedPremiereView {
  lifecycle: PremiereLifecycleSnapshot;
  manifest: PremiereManifestResponse;
  chunks: ReadonlyMap<number, PremierePublicChunkResponse>;
  reveal: PremiereRevealResponse | null;
}

interface RevealCommitPayload {
  schemaVersion: 1;
  commitKind: "terminal_chunk_and_reveal";
  publicationCommitmentHash: string;
  lifecycle: PremiereLifecycleSnapshot;
  transitionAuditEvent: PremiereTransitionAuditEvent;
  releasedPrefix: PremierePublicChunkResponse[];
  terminalChunk: PremierePublicChunkResponse;
  reveal: PremiereRevealResponse;
}

/**
 * Owns an exact, validated pre-reveal view. Constructor recovery accepts only
 * the contiguous advertised prefix of the frozen publication. Reads return
 * fresh recursively frozen values, so callers cannot mutate retained hashes.
 */
export class ReplayPremiereAtomicPublication {
  private published: PublishedPremiereView;
  private commitInFlight = false;
  private readonly gate: VerifiedPremiereEligibilityGate;

  constructor(options: {
    gate: VerifiedPremiereEligibilityGate;
    lifecycle: PremiereLifecycleSnapshot;
    manifest: PremierePreRevealManifestResponse;
    releasedChunks: readonly PremierePublicChunkResponse[];
  }) {
    if (!VerifiedPremiereEligibilityGate.isAuthentic(options.gate)) {
      throw integrityCommit("fabricated_publication_gate");
    }
    this.gate = options.gate;
    const lifecycle = immutable(options.lifecycle, "publication lifecycle");
    const manifest = immutable(options.manifest, "publication manifest");
    const chunks = options.releasedChunks.map((chunk) =>
      immutable(chunk, "publication chunk"),
    );
    validateInitialPublicationView(this.gate, lifecycle, manifest, chunks);
    this.published = {
      lifecycle,
      manifest,
      chunks: new Map(chunks.map((chunk) => [chunk.index, chunk])),
      reveal: null,
    };
  }

  readManifest(): PremiereManifestResponse {
    return immutable(this.published.manifest, "public manifest view");
  }

  readChunk(index: number): PremierePublicChunkResponse | null {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    if ("releasedChunks" in this.published.manifest) {
      const descriptor = this.published.manifest.releasedChunks.find(
        (entry) => entry.index === index,
      );
      if (
        descriptor === undefined ||
        index > this.published.manifest.lastReleasedChunkIndex
      ) {
        return null;
      }
    }
    const chunk = this.published.chunks.get(index);
    return chunk === undefined
      ? null
      : immutable(chunk, "public chunk read view");
  }

  readReveal(): PremiereRevealResponse | null {
    return this.published.reveal === null
      ? null
      : immutable(this.published.reveal, "public reveal read view");
  }

  async commitReveal(
    persistence: PremiereRevealPersistence,
    options: PremiereRevealCommitOptions,
  ): Promise<PremiereRevealCommitResult> {
    if (this.commitInFlight) throw integrityCommit("reveal_commit_in_flight");
    if (
      !sameJson(options.lockedLifecycle, this.published.lifecycle) ||
      this.published.reveal !== null ||
      !VerifiedPremiereTerminalChunk.isAuthenticFor(options.terminal, this.gate)
    ) {
      throw integrityCommit("stale_or_fabricated_reveal_lifecycle");
    }
    this.commitInFlight = true;
    try {
      const publishedChunks = [...this.published.chunks.values()].sort(
        (left, right) => left.index - right.index,
      );
      const lastPublishedResponse = publishedChunks.at(-1) ?? null;
      const lastPublished =
        lastPublishedResponse === null
          ? null
          : releasedChunkFromPublic(lastPublishedResponse);
      const gate = VerifiedPremiereRevealGate.verify({
        lockedLifecycle: this.published.lifecycle,
        publicationGate: this.gate,
        terminal: options.terminal,
        previousChunk: lastPublished,
      });
      const transition = transitionPremiereLifecycle(this.published.lifecycle, {
        action: "reveal",
        actor: "service",
        occurredAt: options.terminal.revealedAt,
        gate,
      });
      const reveal = createPremiereRevealResponse({
        gate: this.gate,
        terminal: options.terminal,
      });
      const pointer = createPremiereRevealPointer(reveal);
      const terminalChunk = toPremierePublicChunkResponse(
        options.terminal.chunk(),
        this.gate,
      );
      const payload = immutable(
        {
          schemaVersion: 1,
          commitKind: "terminal_chunk_and_reveal",
          publicationCommitmentHash: this.gate.publicationCommitmentHash,
          lifecycle: transition.snapshot,
          transitionAuditEvent: transition.auditEvent,
          releasedPrefix: publishedChunks,
          terminalChunk,
          reveal,
        } satisfies RevealCommitPayload,
        "reveal commit payload",
      );
      const durable = await persistence.appendAndSnapshot({
        event: {
          aggregateId: this.gate.premiereId,
          eventType: "premiere_reveal_committed",
          occurredAt: options.terminal.revealedAt,
          payload: asJson(payload),
        },
        state: asJson(payload),
        idempotencyKey: `reveal:${this.gate.publicationCommitmentHash}`,
      });
      const nextChunks = new Map(this.published.chunks);
      nextChunks.set(terminalChunk.index, terminalChunk);
      this.published = {
        lifecycle: immutable(transition.snapshot, "revealed lifecycle"),
        manifest: immutable(pointer, "reveal pointer"),
        chunks: nextChunks,
        reveal: immutable(reveal, "published reveal"),
      };
      return immutable(
        {
          lifecycle: transition.snapshot,
          reveal,
          pointer,
          terminalChunk,
          event: durable.event,
          snapshot: durable.snapshot,
        },
        "reveal commit result",
      );
    } finally {
      this.commitInFlight = false;
    }
  }
}

export function recoverCommittedReveal(
  events: readonly StoredReplayPremiereEvent[],
  premiereId: string,
  gate: VerifiedPremiereEligibilityGate,
): {
  lifecycle: PremiereLifecycleSnapshot;
  terminalChunk: PremierePublicChunkResponse;
  releasedChunks: PremierePublicChunkResponse[];
  reveal: PremiereRevealResponse;
  pointer: PremiereRevealPointerResponse;
} | null {
  if (
    !VerifiedPremiereEligibilityGate.isAuthentic(gate) ||
    gate.premiereId !== premiereId
  ) {
    throw integrityCommit("recovery_publication_gate_mismatch");
  }
  const candidates = events.filter(
    (candidate) =>
      candidate.aggregateId === premiereId &&
      candidate.eventType === "premiere_reveal_committed",
  );
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw integrityCommit("duplicate_reveal_commit_events");
  }
  const event = candidates[0];
  validateStoredRevealEvent(event);
  const payload = parseRevealCommitPayload(event.payload);
  const releasedPrefix = payload.releasedPrefix.map(releasedChunkFromPublic);
  const terminal = releasedChunkFromPublic(payload.terminalChunk);
  gate.recoverReleasedChainForReveal([...releasedPrefix, terminal]);
  gate.assertReleasedChunk(terminal);
  verifyPremiereRevealResponse(payload.reveal, {
    premiereId,
    eligibilityRecordHash: gate.eligibilityRecordHash,
    publicationCommitmentHash: gate.publicationCommitmentHash,
    revealCommitHash: payload.reveal.revealCommitHash,
  });
  const revealIdempotencyKey = `reveal:${gate.publicationCommitmentHash}`;
  if (
    event.idempotencyKey !== revealIdempotencyKey ||
    event.occurredAt !== payload.lifecycle.updatedAt ||
    event.occurredAt !== payload.transitionAuditEvent.occurredAt ||
    event.occurredAt !== payload.terminalChunk.releasedAt ||
    event.occurredAt !== payload.reveal.revealedAt ||
    payload.publicationCommitmentHash !== gate.publicationCommitmentHash ||
    !gate.matchesLifecycleBinding(payload.lifecycle) ||
    payload.lifecycle.state !== "revealed" ||
    payload.lifecycle.lastSafeReleasedSequence !== gate.finalSequence ||
    payload.terminalChunk.premiereId !== premiereId ||
    !payload.terminalChunk.terminal ||
    payload.terminalChunk.endSequence !== gate.finalSequence ||
    payload.reveal.finalChunkHash !== payload.terminalChunk.chunkHash ||
    payload.reveal.finalChunkIndex !== payload.terminalChunk.index ||
    payload.releasedPrefix.some(
      (chunk, index) =>
        chunk.terminal ||
        chunk.index !== index ||
        !sameJson(chunk.provenance, createPremierePublicProvenance(gate)),
    ) ||
    !sameJson(
      payload.terminalChunk.provenance,
      createPremierePublicProvenance(gate),
    ) ||
    !sameJson(
      payload.reveal.provenance,
      createPremierePublicProvenance(gate),
    ) ||
    payload.transitionAuditEvent.action !== "reveal" ||
    payload.transitionAuditEvent.toState !== "revealed" ||
    payload.transitionAuditEvent.lifecycleVersion !== payload.lifecycle.version
  ) {
    throw integrityCommit("invalid_recovered_reveal_commit");
  }
  return immutable(
    {
      lifecycle: payload.lifecycle,
      terminalChunk: payload.terminalChunk,
      releasedChunks: [...payload.releasedPrefix, payload.terminalChunk],
      reveal: payload.reveal,
      pointer: createPremiereRevealPointer(payload.reveal),
    },
    "recovered reveal",
  );
}

function validateInitialPublicationView(
  gate: VerifiedPremiereEligibilityGate,
  lifecycle: PremiereLifecycleSnapshot,
  manifest: PremierePreRevealManifestResponse,
  chunks: readonly PremierePublicChunkResponse[],
): void {
  assertExactKeys(manifest as unknown as Record<string, unknown>, [
    "schemaVersion",
    "premiereId",
    "state",
    "serverNow",
    "scheduledAt",
    "actualStartAt",
    "playbackRate",
    "authoritativeElapsedMs",
    "accumulatedPauseMs",
    "releasedThroughSequence",
    "lastReleasedChunkIndex",
    "activeCheckpoint",
    "provenance",
    "releasedChunks",
  ]);
  validateRecoveredLifecycle(lifecycle);
  const definition = gate.publicDefinition();
  if (
    manifest.schemaVersion !== 1 ||
    lifecycle.state !== manifest.state ||
    lifecycle.premiereId !== manifest.premiereId ||
    !gate.matchesLifecycleBinding(lifecycle) ||
    manifest.premiereId !== gate.premiereId ||
    manifest.playbackRate !== definition.playbackRate ||
    manifest.scheduledAt !== definition.scheduledAt ||
    !isTimestamp(manifest.serverNow) ||
    !isTimestamp(manifest.scheduledAt) ||
    (manifest.actualStartAt !== null && !isTimestamp(manifest.actualStartAt)) ||
    !Number.isSafeInteger(manifest.authoritativeElapsedMs) ||
    manifest.authoritativeElapsedMs < 0 ||
    !Number.isSafeInteger(manifest.accumulatedPauseMs) ||
    manifest.accumulatedPauseMs < 0 ||
    !sameJson(manifest.provenance, createPremierePublicProvenance(gate)) ||
    chunks.some((chunk) => chunk.terminal) ||
    new Set(chunks.map((chunk) => chunk.index)).size !== chunks.length
  ) {
    throw integrityCommit("invalid_initial_publication_view");
  }
  const sorted = [...chunks].sort((left, right) => left.index - right.index);
  const released = sorted.map(releasedChunkFromPublic);
  verifyPremiereChunkChain(released, [], {
    allowPartialChain: true,
    maxPresentationSpanMs: gate.maxPresentationSpanMs,
  });
  gate.recoverReleasedPrefix(released, manifest.authoritativeElapsedMs);
  if (manifest.releasedChunks.length !== sorted.length) {
    throw integrityCommit("manifest_chunk_count_mismatch");
  }
  for (const [index, chunk] of sorted.entries()) {
    if (
      chunk.index !== index ||
      !sameJson(manifest.releasedChunks[index], descriptorFromPublic(chunk))
    ) {
      throw integrityCommit("manifest_chunk_descriptor_mismatch");
    }
  }
  const last = sorted.at(-1) ?? null;
  const expectedLastIndex = last?.index ?? -1;
  const expectedLastSequence = last?.endSequence ?? -1;
  if (
    manifest.lastReleasedChunkIndex !== expectedLastIndex ||
    manifest.releasedThroughSequence !== expectedLastSequence ||
    lifecycle.lastSafeReleasedSequence !== expectedLastSequence ||
    sorted.length >= gate.chunkCount ||
    sorted.some(
      (chunk) => chunk.presentationOffsetMs > manifest.authoritativeElapsedMs,
    ) ||
    sorted.some(
      (chunk) =>
        chunk.provenance.publicationCommitmentHash !==
        gate.publicationCommitmentHash,
    )
  ) {
    throw integrityCommit("publication_prefix_state_mismatch");
  }
}

function releasedChunkFromPublic(
  value: PremierePublicChunkResponse,
): ReleasedPremiereChunk {
  assertExactKeys(value as unknown as Record<string, unknown>, [
    "schemaVersion",
    "premiereId",
    "index",
    "startSequence",
    "endSequence",
    "startTurn",
    "endTurn",
    "presentationOffsetMs",
    "previousChunkHash",
    "payloadHash",
    "chunkHash",
    "byteLength",
    "terminal",
    "releasedAt",
    "provenance",
    "records",
  ]);
  const chunk = immutable(
    {
      descriptor: {
        premiereId: value.premiereId,
        index: value.index,
        startSequence: value.startSequence,
        endSequence: value.endSequence,
        startTurn: value.startTurn,
        endTurn: value.endTurn,
        presentationOffsetMs: value.presentationOffsetMs,
        previousChunkHash: value.previousChunkHash,
        payloadHash: value.payloadHash,
        chunkHash: value.chunkHash,
        byteLength: value.byteLength,
        terminal: value.terminal,
        releasedAt: value.releasedAt,
      },
      payload: { schemaVersion: 1 as const, records: value.records },
    },
    "public released chunk",
  );
  verifyPremiereChunkChain([chunk], [], {
    allowNonZeroFirstIndex: true,
    allowNonNullInitialHash: true,
    allowPartialChain: true,
  });
  return chunk;
}

function descriptorFromPublic(
  value: PremierePublicChunkResponse,
): PremierePublicChunkDescriptor {
  if (value.terminal) throw integrityCommit("terminal_in_prereveal_manifest");
  return {
    premiereId: value.premiereId,
    index: value.index,
    startSequence: value.startSequence,
    endSequence: value.endSequence,
    startTurn: value.startTurn,
    endTurn: value.endTurn,
    presentationOffsetMs: value.presentationOffsetMs,
    previousChunkHash: value.previousChunkHash,
    payloadHash: value.payloadHash,
    chunkHash: value.chunkHash,
    byteLength: value.byteLength,
    terminal: false,
    releasedAt: value.releasedAt,
  };
}

function validateStoredRevealEvent(event: StoredReplayPremiereEvent): void {
  assertExactKeys(event as unknown as Record<string, unknown>, [
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
  ]);
  if (
    event.schemaVersion !== 1 ||
    !Number.isSafeInteger(event.eventSequence) ||
    event.eventSequence < 0 ||
    typeof event.eventId !== "string" ||
    typeof event.aggregateId !== "string" ||
    event.eventType !== "premiere_reveal_committed" ||
    typeof event.idempotencyKey !== "string" ||
    !isSha256Hex(event.idempotencyStateHash) ||
    event.idempotencyStateHash !== hashReplayPremiereJson(event.payload) ||
    !isTimestamp(event.occurredAt) ||
    (event.previousEventHash !== null &&
      !isSha256Hex(event.previousEventHash)) ||
    !isSha256Hex(event.eventHash)
  ) {
    throw integrityCommit("invalid_recovered_event_contract");
  }
  const hashInput: unknown = {
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
  assertReplayPremiereJsonValue(hashInput, "recovered event hash input");
  if (hashReplayPremiereJson(hashInput) !== event.eventHash) {
    throw integrityCommit("recovered_event_hash_mismatch");
  }
}

function parseRevealCommitPayload(
  value: ReplayPremiereJsonValue,
): RevealCommitPayload {
  if (!isRecord(value)) throw integrityCommit("reveal_commit_not_object");
  assertExactKeys(value, [
    "schemaVersion",
    "commitKind",
    "publicationCommitmentHash",
    "lifecycle",
    "transitionAuditEvent",
    "releasedPrefix",
    "terminalChunk",
    "reveal",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.commitKind !== "terminal_chunk_and_reveal" ||
    !isSha256Hex(value.publicationCommitmentHash) ||
    !isRecord(value.lifecycle) ||
    !isRecord(value.transitionAuditEvent) ||
    !Array.isArray(value.releasedPrefix) ||
    !isRecord(value.terminalChunk) ||
    !isRecord(value.reveal)
  ) {
    throw integrityCommit("invalid_reveal_commit_payload");
  }
  const payload = immutable(
    value as unknown as RevealCommitPayload,
    "reveal commit payload",
  );
  validateRecoveredLifecycle(payload.lifecycle);
  validateRecoveredTransitionAudit(
    payload.transitionAuditEvent,
    payload.lifecycle,
  );
  validateRecoveredRevealShape(payload.reveal);
  return payload;
}

function validateRecoveredLifecycle(
  lifecycle: PremiereLifecycleSnapshot,
): void {
  assertExactKeys(lifecycle as unknown as Record<string, unknown>, [
    "schemaVersion",
    "premiereId",
    "state",
    "eligibilityRecordHash",
    "publicationCommitmentHash",
    "sourceRunId",
    "sourceReplaySha256",
    "lastSafeReleasedSequence",
    "terminalReasonCode",
    "version",
    "createdAt",
    "updatedAt",
  ]);
  assertValidPremiereLifecycleSnapshot(lifecycle);
}

function validateRecoveredTransitionAudit(
  audit: PremiereTransitionAuditEvent,
  lifecycle: PremiereLifecycleSnapshot,
): void {
  assertExactKeys(audit as unknown as Record<string, unknown>, [
    "schemaVersion",
    "eventKind",
    "premiereId",
    "action",
    "fromState",
    "toState",
    "actor",
    "occurredAt",
    "lifecycleVersion",
    "eligibilityRecordHash",
    "publicationCommitmentHash",
    "sourceRunId",
    "sourceReplaySha256",
    "terminalReasonCode",
    "lastSafeReleasedSequence",
  ]);
  if (
    audit.schemaVersion !== 1 ||
    audit.eventKind !== "premiere_transition" ||
    audit.action !== "reveal" ||
    audit.fromState !== "playing" ||
    audit.toState !== "revealed" ||
    audit.actor !== "service" ||
    !isTimestamp(audit.occurredAt) ||
    audit.occurredAt !== lifecycle.updatedAt ||
    audit.premiereId !== lifecycle.premiereId ||
    audit.lifecycleVersion !== lifecycle.version ||
    audit.eligibilityRecordHash !== lifecycle.eligibilityRecordHash ||
    audit.publicationCommitmentHash !== lifecycle.publicationCommitmentHash ||
    audit.sourceRunId !== lifecycle.sourceRunId ||
    audit.sourceReplaySha256 !== lifecycle.sourceReplaySha256 ||
    audit.terminalReasonCode !== lifecycle.terminalReasonCode ||
    audit.lastSafeReleasedSequence !== lifecycle.lastSafeReleasedSequence
  ) {
    throw integrityCommit("invalid_recovered_transition_audit");
  }
}

function validateRecoveredRevealShape(reveal: PremiereRevealResponse): void {
  assertExactKeys(reveal as unknown as Record<string, unknown>, [
    "schemaVersion",
    "premiereId",
    "state",
    "eligibilityRecord",
    "eligibilityCommitmentNonce",
    "eligibilityRecordHash",
    "publicationCommitmentHash",
    "publicationCommitment",
    "sourceReplaySha256",
    "resultHash",
    "authoritativeResult",
    "publicationDraftManifest",
    "finalSequence",
    "finalChunkIndex",
    "finalChunkHash",
    "revealedAt",
    "revealCommitHash",
    "provenance",
    "integrityScope",
  ]);
  if (
    reveal.schemaVersion !== 1 ||
    reveal.state !== "revealed" ||
    !isTimestamp(reveal.revealedAt) ||
    !Number.isSafeInteger(reveal.finalSequence) ||
    !Number.isSafeInteger(reveal.finalChunkIndex) ||
    !isSha256Hex(reveal.finalChunkHash) ||
    !isSha256Hex(reveal.revealCommitHash)
  ) {
    throw integrityCommit("invalid_recovered_reveal_shape");
  }
}

function asJson(value: unknown): ReplayPremiereJsonValue {
  const cloned = immutable(value, "reveal commit JSON");
  assertReplayPremiereJsonValue(cloned, "reveal commit JSON");
  return cloned;
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
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw integrityCommit("unknown_or_missing_recovery_field");
  }
}

function isRecord(
  value: unknown,
): value is Record<string, ReplayPremiereJsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function integrityCommit(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    `Replay premiere reveal commit failed: ${operatorCode}`,
  );
}
