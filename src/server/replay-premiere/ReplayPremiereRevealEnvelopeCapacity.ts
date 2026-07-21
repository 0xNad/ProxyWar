import type { PremiereAuthoritativeResultBytes } from "./ReplayPremiereAuthoritativeResult";
import type {
  PremiereChunkDraft,
  PremiereEligibility,
} from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import {
  canonicalReplayPremiereJson,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import type {
  PremiereFrozenDraftDescriptor,
  PremierePublicationBaseProvenance,
  PremierePublicationCommitment,
} from "./ReplayPremierePublication";
import type {
  PremiereLifecycleSnapshot,
  PremiereTransitionAuditEvent,
} from "./ReplayPremiereStateMachine";
import type {
  PremierePublicChunkResponse,
  PremierePublicProvenance,
  PremiereRevealResponse,
} from "./ReplayPremiereWire";

interface RevealCommitPayloadCapacityShape {
  schemaVersion: 1;
  commitKind: "terminal_chunk_and_reveal";
  publicationCommitmentHash: string;
  lifecycle: PremiereLifecycleSnapshot;
  transitionAuditEvent: PremiereTransitionAuditEvent;
  releasedPrefixChunkCount: number;
  releasedPrefixLastChunkHash: string | null;
  terminalChunk: PremierePublicChunkResponse;
  reveal: PremiereRevealResponse;
}

interface StoredRevealEventCapacityShape {
  schemaVersion: 1;
  eventSequence: number;
  eventId: string;
  aggregateId: string;
  eventType: "premiere_reveal_committed";
  occurredAt: string;
  payload: RevealCommitPayloadCapacityShape;
  idempotencyKey: string;
  idempotencyStateHash: string;
  previousEventHash: string;
  eventHash: string;
}

export interface ReplayPremiereRevealEnvelopeCapacityMaterial {
  eligibilityRecord: PremiereEligibility;
  authoritativeResult: PremiereAuthoritativeResultBytes;
  publicationCommitment: PremierePublicationCommitment;
  publicationDraftManifest: readonly PremiereFrozenDraftDescriptor[];
  terminalDraft: PremiereChunkDraft;
  publicProvenance: PremierePublicationBaseProvenance;
}

export const REPLAY_PREMIERE_V1_MAX_REVEAL_STORED_EVENT_BYTES = 2 * 1024 * 1024;

const maximumHash = "f".repeat(64);
const maximumPremiereAggregateId = `prem_${"z".repeat(32)}`;
const maximumCanonicalTimestamp = "x".repeat(27);
const maximumCommitmentNonceBase64Url = "x".repeat(86);

/**
 * Admission-time structural twin of RevealCommitPayload and its stored-event
 * JSONL envelope. Canonical JSON charges one node per object, array, or scalar;
 * runtime-only values use their maximum serialized length so the returned byte
 * requirement cannot undercount the eventual atomic reveal event.
 */
export function assertReplayPremiereRevealEnvelopeCapacity(
  material: ReplayPremiereRevealEnvelopeCapacityMaterial,
): number {
  const commitment = material.publicationCommitment;
  const terminal = material.terminalDraft;
  const publicProvenance = {
    ...material.publicProvenance,
    publicationCommitmentHash: commitment.publicationCommitmentHash,
  } satisfies PremierePublicProvenance;
  const lifecycle = {
    schemaVersion: 1,
    premiereId: commitment.premiereId,
    state: "revealed",
    eligibilityRecordHash: commitment.eligibilityRecordHash,
    publicationCommitmentHash: commitment.publicationCommitmentHash,
    sourceRunId: commitment.sourceRunId,
    sourceReplaySha256: commitment.sourceReplaySha256,
    lastSafeReleasedSequence: commitment.finalSequence,
    terminalReasonCode: null,
    version: Number.MAX_SAFE_INTEGER,
    createdAt: maximumCanonicalTimestamp,
    updatedAt: maximumCanonicalTimestamp,
  } satisfies PremiereLifecycleSnapshot;
  const transitionAuditEvent = {
    schemaVersion: 1,
    eventKind: "premiere_transition",
    premiereId: commitment.premiereId,
    action: "reveal",
    fromState: "playing",
    toState: "revealed",
    actor: "service",
    occurredAt: maximumCanonicalTimestamp,
    lifecycleVersion: Number.MAX_SAFE_INTEGER,
    eligibilityRecordHash: commitment.eligibilityRecordHash,
    publicationCommitmentHash: commitment.publicationCommitmentHash,
    sourceRunId: commitment.sourceRunId,
    sourceReplaySha256: commitment.sourceReplaySha256,
    terminalReasonCode: null,
    lastSafeReleasedSequence: commitment.finalSequence,
  } satisfies PremiereTransitionAuditEvent;
  const terminalChunk = {
    schemaVersion: 1,
    premiereId: terminal.descriptor.premiereId,
    index: terminal.descriptor.index,
    startSequence: terminal.descriptor.startSequence,
    endSequence: terminal.descriptor.endSequence,
    startTurn: terminal.descriptor.startTurn,
    endTurn: terminal.descriptor.endTurn,
    presentationOffsetMs: terminal.descriptor.presentationOffsetMs,
    previousChunkHash: maximumHash,
    payloadHash: terminal.descriptor.payloadHash,
    chunkHash: maximumHash,
    byteLength: terminal.descriptor.byteLength,
    terminal: true,
    releasedAt: maximumCanonicalTimestamp,
    provenance: publicProvenance,
    records: terminal.payload.records,
  } satisfies PremierePublicChunkResponse;
  const reveal = {
    schemaVersion: 1,
    premiereId: commitment.premiereId,
    state: "revealed",
    eligibilityRecord: material.eligibilityRecord,
    eligibilityCommitmentNonce: maximumCommitmentNonceBase64Url,
    eligibilityRecordHash: commitment.eligibilityRecordHash,
    publicationCommitmentHash: commitment.publicationCommitmentHash,
    publicationCommitment: commitment,
    sourceReplaySha256: commitment.sourceReplaySha256,
    resultHash: material.authoritativeResult.sha256,
    authoritativeResult: material.authoritativeResult,
    publicationDraftManifest: [...material.publicationDraftManifest],
    finalSequence: commitment.finalSequence,
    finalChunkIndex: terminal.descriptor.index,
    finalChunkHash: maximumHash,
    revealedAt: maximumCanonicalTimestamp,
    revealCommitHash: maximumHash,
    provenance: publicProvenance,
    integrityScope: {
      publicationCommitment: "reveal_verifiable",
      sourceReplay: "declared_hash_only",
      authoritativeResult: "included_hash_verifiable",
    },
  } satisfies PremiereRevealResponse;
  const capacityShape = {
    schemaVersion: 1,
    commitKind: "terminal_chunk_and_reveal",
    publicationCommitmentHash: commitment.publicationCommitmentHash,
    lifecycle,
    transitionAuditEvent,
    releasedPrefixChunkCount: terminal.descriptor.index,
    releasedPrefixLastChunkHash: maximumHash,
    terminalChunk,
    reveal,
  } satisfies RevealCommitPayloadCapacityShape;
  const storedEvent = {
    schemaVersion: 1,
    eventSequence: Number.MAX_SAFE_INTEGER,
    eventId: "00000000-0000-4000-8000-000000000000",
    aggregateId: maximumPremiereAggregateId,
    eventType: "premiere_reveal_committed",
    occurredAt: maximumCanonicalTimestamp,
    payload: capacityShape,
    idempotencyKey: `reveal:${maximumHash}`,
    idempotencyStateHash: maximumHash,
    previousEventHash: maximumHash,
    eventHash: maximumHash,
  } satisfies StoredRevealEventCapacityShape;

  let canonicalStoredEvent: string;
  try {
    canonicalStoredEvent = canonicalReplayPremiereJson(
      storedEvent as unknown as ReplayPremiereJsonValue,
    );
  } catch (error) {
    if (
      error instanceof ReplayPremiereError &&
      error.operatorCode === "json_complexity_exceeded"
    ) {
      throw new ReplayPremiereError(
        "reveal_envelope_json_complexity_exceeded",
        "PREMIERE_CAPACITY_EXCEEDED",
        413,
        "Replay premiere reveal envelope exceeds the canonical JSON complexity ceiling",
        { cause: error },
      );
    }
    throw error;
  }
  const requiredStoredEventBytes = Buffer.byteLength(
    `${canonicalStoredEvent}\n`,
    "utf8",
  );
  if (
    requiredStoredEventBytes > REPLAY_PREMIERE_V1_MAX_REVEAL_STORED_EVENT_BYTES
  ) {
    throw new ReplayPremiereError(
      "reveal_event_byte_ceiling_exceeded",
      "PREMIERE_CAPACITY_EXCEEDED",
      413,
      "Replay premiere reveal event exceeds the V1 stored-event byte ceiling",
    );
  }
  return requiredStoredEventBytes;
}
