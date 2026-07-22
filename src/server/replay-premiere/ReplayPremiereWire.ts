import { GameStartInfoSchema, type GameStartInfo } from "../../core/Schemas";
import {
  decodePremiereAuthoritativeResult,
  verifyPremiereAuthoritativeResultBytes,
  type PremiereAuthoritativeResultBytes,
} from "./ReplayPremiereAuthoritativeResult";
import {
  isPremiereId,
  type CoworldPremiereSourceIds,
  type PolicyIdentity,
  type PremiereChunkDescriptor,
  type PremiereEligibility,
  type PremierePlaybackRate,
  type PremierePublicLabel,
  type PremiereReleasedRecord,
  type PremiereSeatIdentity,
  type PremiereSourceKind,
  type ReleasedPremiereChunk,
} from "./ReplayPremiereContracts";
import { computeEligibilityRecordCommitment } from "./ReplayPremiereEligibility";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import { assertNoOutcomeBearingReplayFields } from "./ReplayPremiereImport";
import {
  assertReplayPremiereJsonValue,
  cloneAndFreezeReplayPremiereValue,
  hashReplayPremiereJson,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import {
  VerifiedPremiereEligibilityGate,
  VerifiedPremiereTerminalChunk,
  verifyPremierePublicationCommitment,
  verifyPremiereRevealedDraftManifest,
  type PremiereFrozenDraftDescriptor,
  type PremierePublicationCommitment,
  type PremierePublicDefinition,
} from "./ReplayPremierePublication";

export const REPLAY_PREMIERE_API_PREFIX = "/api/premieres" as const;

export interface PremierePublicBootstrapResponse {
  schemaVersion: 1;
  premiereId: string;
  gameStartInfo: GameStartInfo;
  gameStartInfoHash: string;
  publicDefinition: PremierePublicDefinition;
  publicationCommitmentHash: string;
  provenance: PremierePublicProvenance;
  integrityScope: {
    publicationCommitment: "anchored_server_enforced";
    sourceReplay: "declared_hash_only";
    authoritativeResult: "not_revealed";
  };
}

export interface PremierePublicProvenance {
  sourceKind: PremiereSourceKind;
  sourceRunId: string;
  coworld: CoworldPremiereSourceIds | null;
  sourceReplaySha256: string;
  seats: Array<{
    seatId: string;
    displayName: string;
    policyIdentity: PolicyIdentity;
  }>;
  publicLabel: PremierePublicLabel;
  eligibilityRecordHash: string;
  publicationCommitmentHash: string;
}

export interface PremierePublicCheckpoint {
  id: string;
  sequence: number;
  opensAt: string;
  closesAt: string;
  questionKind: "winner_from_here";
  optionSeatIds: string[];
  state: "open" | "closed";
}

export type PremierePublicChunkDescriptor = Omit<
  PremiereChunkDescriptor,
  "releasedAt" | "terminal"
> & {
  releasedAt: string;
  terminal: false;
};

export interface PremierePreRevealManifestResponse {
  schemaVersion: 1;
  premiereId: string;
  state: "scheduled" | "playing" | "checkpoint" | "failed" | "cancelled";
  serverNow: string;
  scheduledAt: string;
  actualStartAt: string | null;
  playbackRate: PremierePlaybackRate;
  authoritativeElapsedMs: number;
  accumulatedPauseMs: number;
  releasedThroughSequence: number;
  lastReleasedChunkIndex: number;
  activeCheckpoint: PremierePublicCheckpoint | null;
  provenance: PremierePublicProvenance;
  releasedChunks: PremierePublicChunkDescriptor[];
}

export interface PremiereRevealPointerResponse {
  schemaVersion: 1;
  premiereId: string;
  state: "revealed" | "archived";
  revealUrl: string;
  revealedAt: string;
  revealCommitHash: string;
  provenance: PremierePublicProvenance;
}

export type PremiereManifestResponse =
  | PremierePreRevealManifestResponse
  | PremiereRevealPointerResponse;

export interface PremierePublicChunkResponse {
  schemaVersion: 1;
  premiereId: string;
  index: number;
  startSequence: number;
  endSequence: number;
  startTurn: number;
  endTurn: number;
  presentationOffsetMs: number;
  previousChunkHash: string | null;
  payloadHash: string;
  chunkHash: string;
  byteLength: number;
  terminal: boolean;
  releasedAt: string;
  provenance: PremierePublicProvenance;
  records: PremiereReleasedRecord[];
}

export interface PremiereRevealResponse {
  schemaVersion: 1;
  premiereId: string;
  state: "revealed";
  eligibilityRecord: PremiereEligibility;
  eligibilityCommitmentNonce: string;
  eligibilityRecordHash: string;
  publicationCommitmentHash: string;
  publicationCommitment: PremierePublicationCommitment;
  sourceReplaySha256: string;
  resultHash: string;
  authoritativeResult: PremiereAuthoritativeResultBytes;
  publicationDraftManifest: PremiereFrozenDraftDescriptor[];
  finalSequence: number;
  finalChunkIndex: number;
  finalChunkHash: string;
  revealedAt: string;
  revealCommitHash: string;
  provenance: PremierePublicProvenance;
  integrityScope: {
    publicationCommitment: "reveal_verifiable";
    sourceReplay: "declared_hash_only";
    authoritativeResult: "included_hash_verifiable";
  };
}

export interface PremiereRevealVerificationAnchor {
  premiereId: string;
  eligibilityRecordHash: string;
  publicationCommitmentHash: string;
  revealCommitHash: string;
}

export function replayPremiereApiPaths(premiereId: string): {
  bootstrap: string;
  manifest: string;
  reveal: string;
  chunk: (index: number) => string;
} {
  if (!isPremiereId(premiereId)) throw invalidWire("invalid_premiere_id");
  const base = `${REPLAY_PREMIERE_API_PREFIX}/${premiereId}`;
  return {
    bootstrap: `${base}/bootstrap`,
    manifest: `${base}/manifest`,
    reveal: `${base}/reveal`,
    chunk: (index: number): string => {
      if (!Number.isSafeInteger(index) || index < 0) {
        throw invalidWire("invalid_chunk_index");
      }
      return `${base}/chunks/${index}`;
    },
  };
}

export function createPremierePublicBootstrap(options: {
  gate: VerifiedPremiereEligibilityGate;
}): PremierePublicBootstrapResponse {
  if (!VerifiedPremiereEligibilityGate.isAuthentic(options.gate)) {
    throw integrityWire("fabricated_publication_gate");
  }
  const gameStartInfo = options.gate.publicBootstrap();
  assertNoOutcomeBearingReplayFields(gameStartInfo);
  const parsed = GameStartInfoSchema.strict().safeParse(gameStartInfo);
  if (!parsed.success)
    throw invalidWire("invalid_game_start_info", parsed.error);
  const startInfoValue = jsonValue(parsed.data, "game start info");
  const commitment = options.gate.publicationCommitment();
  verifyPremierePublicationCommitment(commitment);
  if (hashReplayPremiereJson(startInfoValue) !== commitment.gameStartInfoHash) {
    throw integrityWire("bootstrap_commitment_mismatch");
  }
  return cloneAndFreezeReplayPremiereValue(
    {
      schemaVersion: 1,
      premiereId: options.gate.premiereId,
      gameStartInfo: parsed.data,
      gameStartInfoHash: commitment.gameStartInfoHash,
      publicDefinition: options.gate.publicDefinition(),
      publicationCommitmentHash: options.gate.publicationCommitmentHash,
      provenance: createPremierePublicProvenance(options.gate),
      integrityScope: {
        publicationCommitment: "anchored_server_enforced" as const,
        sourceReplay: "declared_hash_only" as const,
        authoritativeResult: "not_revealed" as const,
      },
    },
    "premiere bootstrap response",
  );
}

export function createPremierePublicProvenance(
  gate: VerifiedPremiereEligibilityGate,
): PremierePublicProvenance {
  if (!VerifiedPremiereEligibilityGate.isAuthentic(gate)) {
    throw integrityWire("fabricated_publication_gate");
  }
  return cloneAndFreezeReplayPremiereValue(
    {
      ...gate.publicProvenance(),
      publicationCommitmentHash: gate.publicationCommitmentHash,
    },
    "premiere public provenance",
  );
}

export function toPremierePublicChunkResponse(
  chunk: ReleasedPremiereChunk,
  gate: VerifiedPremiereEligibilityGate,
): PremierePublicChunkResponse {
  if (!VerifiedPremiereEligibilityGate.isAuthentic(gate)) {
    throw integrityWire("fabricated_publication_gate");
  }
  gate.assertReleasedChunk(chunk);
  return cloneAndFreezeReplayPremiereValue(
    {
      schemaVersion: 1,
      premiereId: chunk.descriptor.premiereId,
      index: chunk.descriptor.index,
      startSequence: chunk.descriptor.startSequence,
      endSequence: chunk.descriptor.endSequence,
      startTurn: chunk.descriptor.startTurn,
      endTurn: chunk.descriptor.endTurn,
      presentationOffsetMs: chunk.descriptor.presentationOffsetMs,
      previousChunkHash: chunk.descriptor.previousChunkHash,
      payloadHash: chunk.descriptor.payloadHash,
      chunkHash: chunk.descriptor.chunkHash,
      byteLength: chunk.descriptor.byteLength,
      terminal: chunk.descriptor.terminal,
      releasedAt: chunk.descriptor.releasedAt,
      provenance: createPremierePublicProvenance(gate),
      records: chunk.payload.records,
    },
    "premiere public chunk response",
  );
}

export function createPremiereRevealResponse(options: {
  gate: VerifiedPremiereEligibilityGate;
  terminal: VerifiedPremiereTerminalChunk;
}): PremiereRevealResponse {
  if (
    !VerifiedPremiereEligibilityGate.isAuthentic(options.gate) ||
    !VerifiedPremiereTerminalChunk.isAuthenticFor(
      options.terminal,
      options.gate,
    )
  ) {
    throw integrityWire("fabricated_reveal_gate");
  }
  const terminalChunk = options.terminal.chunk();
  const revealedAt = options.terminal.revealedAt;
  assertTimestamp(revealedAt, "revealedAt");
  const material = options.gate.revealMaterial(options.terminal);
  const resultBytes = decodePremiereAuthoritativeResult(
    material.authoritativeResult,
  );
  verifyPremiereAuthoritativeResultBytes({
    eligibilityRecord: material.eligibilityRecord,
    resultBytes,
  });
  if (
    terminalChunk.descriptor.premiereId !== options.gate.premiereId ||
    terminalChunk.descriptor.terminal !== true ||
    terminalChunk.descriptor.endSequence !== options.gate.finalSequence ||
    material.authoritativeResult.sha256 !== options.terminal.resultHash
  ) {
    throw integrityWire("invalid_reveal_material");
  }
  const computedEligibilityCommitment = computeEligibilityRecordCommitment(
    material.eligibilityRecord,
    material.commitmentNonce,
  );
  if (computedEligibilityCommitment !== options.gate.eligibilityRecordHash) {
    throw integrityWire("eligibility_commitment_mismatch");
  }
  const withoutCommitHash = revealCommitInput({
    premiereId: options.gate.premiereId,
    eligibilityRecordHash: options.gate.eligibilityRecordHash,
    publicationCommitmentHash: options.gate.publicationCommitmentHash,
    publicationCommitment: options.gate.publicationCommitment(),
    sourceReplaySha256: options.gate.sourceReplaySha256,
    resultHash: material.authoritativeResult.sha256,
    authoritativeResult: material.authoritativeResult,
    publicationDraftManifest: options.gate.revealedDraftManifest(
      options.terminal,
    ),
    finalSequence: options.gate.finalSequence,
    finalChunkIndex: terminalChunk.descriptor.index,
    finalChunkHash: terminalChunk.descriptor.chunkHash,
    revealedAt,
  });
  return cloneAndFreezeReplayPremiereValue(
    {
      schemaVersion: 1,
      premiereId: options.gate.premiereId,
      state: "revealed",
      eligibilityRecord: material.eligibilityRecord,
      eligibilityCommitmentNonce: Buffer.from(
        material.commitmentNonce,
      ).toString("base64url"),
      eligibilityRecordHash: options.gate.eligibilityRecordHash,
      publicationCommitmentHash: options.gate.publicationCommitmentHash,
      publicationCommitment: options.gate.publicationCommitment(),
      sourceReplaySha256: options.gate.sourceReplaySha256,
      resultHash: material.authoritativeResult.sha256,
      authoritativeResult: material.authoritativeResult,
      publicationDraftManifest: options.gate.revealedDraftManifest(
        options.terminal,
      ),
      finalSequence: options.gate.finalSequence,
      finalChunkIndex: terminalChunk.descriptor.index,
      finalChunkHash: terminalChunk.descriptor.chunkHash,
      revealedAt,
      revealCommitHash: hashReplayPremiereJson(withoutCommitHash),
      provenance: createPremierePublicProvenance(options.gate),
      integrityScope: {
        publicationCommitment: "reveal_verifiable" as const,
        sourceReplay: "declared_hash_only" as const,
        authoritativeResult: "included_hash_verifiable" as const,
      },
    },
    "premiere reveal response",
  );
}

export function verifyPremiereRevealResponse(
  response: PremiereRevealResponse,
  anchor: PremiereRevealVerificationAnchor,
): void {
  if (
    response.premiereId !== anchor.premiereId ||
    response.eligibilityRecordHash !== anchor.eligibilityRecordHash ||
    response.publicationCommitmentHash !== anchor.publicationCommitmentHash ||
    response.revealCommitHash !== anchor.revealCommitHash
  ) {
    throw integrityWire("reveal_does_not_match_prereveal_anchor");
  }
  verifyPremiereRevealSelfConsistency(response);
}

function verifyPremiereRevealSelfConsistency(
  response: PremiereRevealResponse,
): void {
  const nonce = Buffer.from(response.eligibilityCommitmentNonce, "base64url");
  if (nonce.byteLength < 16 || nonce.byteLength > 64) {
    throw integrityWire("invalid_revealed_commitment_nonce");
  }
  const commitment = computeEligibilityRecordCommitment(
    response.eligibilityRecord,
    nonce,
  );
  verifyPremierePublicationCommitment(response.publicationCommitment);
  verifyPremiereRevealedDraftManifest(
    response.publicationCommitment,
    response.publicationDraftManifest,
  );
  const resultBytes = decodePremiereAuthoritativeResult(
    response.authoritativeResult,
  );
  verifyPremiereAuthoritativeResultBytes({
    eligibilityRecord: response.eligibilityRecord,
    resultBytes,
  });
  if (
    response.schemaVersion !== 1 ||
    response.state !== "revealed" ||
    commitment !== response.eligibilityRecordHash ||
    response.sourceReplaySha256 !==
      response.eligibilityRecord.sourceReplaySha256 ||
    response.publicationCommitmentHash !==
      response.provenance.publicationCommitmentHash ||
    response.publicationCommitmentHash !==
      response.publicationCommitment.publicationCommitmentHash ||
    response.publicationCommitment.premiereId !== response.premiereId ||
    response.publicationCommitment.eligibilityRecordHash !==
      response.eligibilityRecordHash ||
    response.publicationCommitment.sourceRunId !==
      response.eligibilityRecord.sourceRunId ||
    response.publicationCommitment.sourceReplaySha256 !==
      response.sourceReplaySha256 ||
    response.publicationCommitment.finalSequence !== response.finalSequence ||
    response.publicationCommitment.chunkCount !==
      response.finalChunkIndex + 1 ||
    !sameWireJson(response.provenance, provenanceFromReveal(response)) ||
    response.resultHash !==
      response.eligibilityRecord.authoritativeResult.resultHash ||
    response.resultHash !== response.authoritativeResult.sha256 ||
    hashReplayPremiereJson(revealCommitInput(response)) !==
      response.revealCommitHash
  ) {
    throw integrityWire("reveal_commitment_verification_failed");
  }
}

export function createPremiereRevealPointer(
  response: PremiereRevealResponse,
): PremiereRevealPointerResponse {
  verifyPremiereRevealSelfConsistency(response);
  return cloneAndFreezeReplayPremiereValue(
    {
      schemaVersion: 1,
      premiereId: response.premiereId,
      state: "revealed",
      revealUrl: replayPremiereApiPaths(response.premiereId).reveal,
      revealedAt: response.revealedAt,
      revealCommitHash: response.revealCommitHash,
      provenance: copyPublicProvenance(response.provenance),
    },
    "premiere reveal pointer",
  );
}

function revealCommitInput(value: {
  premiereId: string;
  eligibilityRecordHash: string;
  publicationCommitmentHash: string;
  publicationCommitment: PremierePublicationCommitment;
  sourceReplaySha256: string;
  resultHash: string;
  authoritativeResult: PremiereAuthoritativeResultBytes;
  publicationDraftManifest: PremiereFrozenDraftDescriptor[];
  finalSequence: number;
  finalChunkIndex: number;
  finalChunkHash: string;
  revealedAt: string;
}): ReplayPremiereJsonValue {
  const input: unknown = {
    schemaVersion: 1,
    premiereId: value.premiereId,
    eligibilityRecordHash: value.eligibilityRecordHash,
    publicationCommitmentHash: value.publicationCommitmentHash,
    publicationCommitment: value.publicationCommitment,
    sourceReplaySha256: value.sourceReplaySha256,
    resultHash: value.resultHash,
    authoritativeResult: value.authoritativeResult,
    publicationDraftManifest: value.publicationDraftManifest,
    finalSequence: value.finalSequence,
    finalChunkIndex: value.finalChunkIndex,
    finalChunkHash: value.finalChunkHash,
    revealedAt: value.revealedAt,
  };
  assertReplayPremiereJsonValue(input, "reveal commitment input");
  return input;
}

function copySeat(seat: PremiereSeatIdentity): PremiereSeatIdentity {
  return {
    seatId: seat.seatId,
    displayName: seat.displayName,
    policyIdentity: { ...seat.policyIdentity },
  };
}

function copyPublicProvenance(
  provenance: PremierePublicProvenance,
): PremierePublicProvenance {
  return {
    sourceKind: provenance.sourceKind,
    sourceRunId: provenance.sourceRunId,
    coworld: provenance.coworld === null ? null : { ...provenance.coworld },
    sourceReplaySha256: provenance.sourceReplaySha256,
    seats: provenance.seats.map(copySeat),
    publicLabel: provenance.publicLabel,
    eligibilityRecordHash: provenance.eligibilityRecordHash,
    publicationCommitmentHash: provenance.publicationCommitmentHash,
  };
}

function provenanceFromReveal(
  response: PremiereRevealResponse,
): PremierePublicProvenance {
  return {
    sourceKind: response.eligibilityRecord.sourceKind,
    sourceRunId: response.eligibilityRecord.sourceRunId,
    coworld:
      response.eligibilityRecord.coworld === null
        ? null
        : { ...response.eligibilityRecord.coworld },
    sourceReplaySha256: response.eligibilityRecord.sourceReplaySha256,
    seats: response.eligibilityRecord.seats.map(copySeat),
    publicLabel: response.eligibilityRecord.publicLabel,
    eligibilityRecordHash: response.eligibilityRecordHash,
    publicationCommitmentHash: response.publicationCommitmentHash,
  };
}

function sameWireJson(left: unknown, right: unknown): boolean {
  try {
    const leftValue = jsonValue(left, "wire comparison left");
    const rightValue = jsonValue(right, "wire comparison right");
    return (
      hashReplayPremiereJson(leftValue) === hashReplayPremiereJson(rightValue)
    );
  } catch {
    return false;
  }
}

function jsonValue(value: unknown, source: string): ReplayPremiereJsonValue {
  const serialized: unknown = JSON.parse(JSON.stringify(value));
  assertReplayPremiereJsonValue(serialized, source);
  return serialized;
}

function assertTimestamp(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw invalidWire(`invalid_${field}_timestamp`);
  }
}

function invalidWire(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    400,
    `Replay premiere wire contract rejected: ${operatorCode}`,
    cause === undefined ? undefined : { cause },
  );
}

function integrityWire(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    `Replay premiere wire integrity check failed: ${operatorCode}`,
  );
}
