import {
  GameRecordSchema,
  GameStartInfoSchema,
  type GameStartInfo,
} from "../../core/Schemas";
import {
  encodePremiereAuthoritativeResult,
  verifyPremiereAuthoritativeResultBytes,
  type PremiereAuthoritativeResultBytes,
} from "./ReplayPremiereAuthoritativeResult";
import {
  REPLAY_PREMIERE_MAX_CHUNK_COUNT,
  verifyPremiereChunkChain,
  verifyPremiereChunkDraftChain,
} from "./ReplayPremiereChunks";
import {
  isPremiereId,
  type CoworldPremiereSourceIds,
  type PolicyIdentity,
  type PremiereChunkDescriptor,
  type PremiereChunkDraft,
  type PremiereEligibility,
  type PremierePlaybackRate,
  type PremierePublicLabel,
  type PremiereSeatIdentity,
  type PremiereSourceKind,
  type PremiereSourceRecord,
  type ReleasedPremiereChunk,
} from "./ReplayPremiereContracts";
import {
  validateReplayPremiereControlledExecutionConfig,
  type ReplayPremiereControlledExecutionConfig,
} from "./ReplayPremiereControlledExecution";
import {
  assessPremiereEligibility,
  type PremiereEligibilityAssessmentOptions,
} from "./ReplayPremiereEligibility";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import {
  assertNoOutcomeBearingReplayFields,
  importPremiereReplay,
  type ImportedPremiereReplay,
  type PremiereReplayImportLimits,
} from "./ReplayPremiereImport";
import {
  assertReplayPremiereJsonValue,
  cloneAndFreezeReplayPremiereValue,
  hashReplayPremiereJson,
  isSha256Hex,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import { VerifiedReplayPremiereLeakAuditReceipt } from "./ReplayPremiereLeakAuditCollector";
import { VerifiedStagedPremiereSourceBytes } from "./ReplayPremierePrivateStaging";
import { assertReplayPremiereRevealEnvelopeCapacity } from "./ReplayPremiereRevealEnvelopeCapacity";

const issuedEligibilityGates = new WeakSet<object>();
const issuedTerminalChunks = new WeakSet<object>();
const terminalIssueToken = Symbol("premiere-terminal-issue");
const checkpointIdPattern = /^cp_[a-z0-9]{8,32}$/;

export interface PremierePublicationBaseProvenance {
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
}

export interface PremierePublicationCheckpointDescriptor {
  id: string;
  sequence: number;
}

/** Public, spoiler-neutral fields frozen before the lifecycle can schedule. */
export interface PremierePublicDefinition {
  title: string;
  spoilerNeutralDescription: string;
  map: { id: string; label: string };
  matchFormat: { id: string; label: string; seatCount: number };
  scheduledAt: string;
  playbackRate: PremierePlaybackRate;
  checkpoints: [
    PremierePublicationCheckpointDescriptor,
    PremierePublicationCheckpointDescriptor,
  ];
  provenance: PremierePublicationBaseProvenance;
}

export interface PremierePublicationCommitment {
  schemaVersion: 1;
  commitmentKind: "replay_premiere_publication_v1";
  premiereId: string;
  eligibilityRecordHash: string;
  sourceRunId: string;
  sourceReplaySha256: string;
  gameStartInfoHash: string;
  publicDefinitionHash: string;
  playbackRate: PremierePlaybackRate;
  checkpoints: [
    PremierePublicationCheckpointDescriptor,
    PremierePublicationCheckpointDescriptor,
  ];
  maxPresentationSpanMs: number;
  finalSequence: number;
  chunkCount: number;
  terminalPrepublicationRoot: string;
  orderedDraftManifestRoot: string;
  publicationCommitmentHash: string;
}

export function verifyPremierePublicationCommitment(
  commitment: PremierePublicationCommitment,
): void {
  const expectedKeys = [
    "schemaVersion",
    "commitmentKind",
    "premiereId",
    "eligibilityRecordHash",
    "sourceRunId",
    "sourceReplaySha256",
    "gameStartInfoHash",
    "publicDefinitionHash",
    "playbackRate",
    "checkpoints",
    "maxPresentationSpanMs",
    "finalSequence",
    "chunkCount",
    "terminalPrepublicationRoot",
    "orderedDraftManifestRoot",
    "publicationCommitmentHash",
  ].sort();
  const actualKeys = Object.keys(commitment).sort();
  const { publicationCommitmentHash, ...preimage } =
    cloneAndFreezeReplayPremiereValue(
      commitment,
      "premiere publication commitment verification",
    );
  if (
    commitment.schemaVersion !== 1 ||
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    commitment.commitmentKind !== "replay_premiere_publication_v1" ||
    !isPremiereId(commitment.premiereId) ||
    !Number.isSafeInteger(commitment.finalSequence) ||
    commitment.finalSequence < 0 ||
    !Number.isSafeInteger(commitment.chunkCount) ||
    commitment.chunkCount < 1 ||
    commitment.chunkCount > REPLAY_PREMIERE_MAX_CHUNK_COUNT ||
    !isSha256Hex(commitment.eligibilityRecordHash) ||
    !isSha256Hex(commitment.sourceReplaySha256) ||
    !isSha256Hex(commitment.gameStartInfoHash) ||
    !isSha256Hex(commitment.publicDefinitionHash) ||
    !isSha256Hex(commitment.terminalPrepublicationRoot) ||
    !isSha256Hex(commitment.orderedDraftManifestRoot) ||
    !isSha256Hex(commitment.publicationCommitmentHash) ||
    !Number.isSafeInteger(commitment.maxPresentationSpanMs) ||
    commitment.maxPresentationSpanMs < 1 ||
    commitment.maxPresentationSpanMs > 1_000 ||
    jsonHash(preimage) !== publicationCommitmentHash
  ) {
    throw publicationFailure("invalid_publication_commitment");
  }
}

export interface VerifyPremierePublicationOptions {
  premiereId: string;
  eligibilityRecord: PremiereEligibility;
  eligibilityOptions: PremiereEligibilityAssessmentOptions;
  leakAuditReceipt: VerifiedReplayPremiereLeakAuditReceipt;
  verifiedSource: VerifiedStagedPremiereSourceBytes;
  authoritativeResultBytes: Uint8Array;
  replayImportLimits: PremiereReplayImportLimits;
  publicDefinition: PremierePublicDefinition;
  draftChunks: readonly PremiereChunkDraft[];
  maxPresentationSpanMs: number;
}

/** Rebuilds the canonical dense replay from strict controlled-source bytes. */
export function importControlledPremiereSourceForPublication(options: {
  sourceBytes: Uint8Array;
  eligibilityRecord: PremiereEligibility;
  authoritativeResultBytes: Uint8Array;
  replayImportLimits: PremiereReplayImportLimits;
}): ImportedPremiereReplay {
  return decodeControlledSource(
    options.sourceBytes,
    options.eligibilityRecord,
    options.authoritativeResultBytes,
    options.replayImportLimits,
  ).replay;
}

export interface PremiereFrozenDraftDescriptor {
  premiereId: string;
  index: number;
  startSequence: number;
  endSequence: number;
  startTurn: number;
  endTurn: number;
  presentationOffsetMs: number;
  previousPrepublicationHash: string | null;
  prepublicationHash: string;
  payloadHash: string;
  byteLength: number;
  terminal: boolean;
  releasedAt: null;
}

export function verifyPremiereRevealedDraftManifest(
  commitment: PremierePublicationCommitment,
  descriptors: readonly PremiereFrozenDraftDescriptor[],
): void {
  verifyPremierePublicationCommitment(commitment);
  const last = descriptors.at(-1);
  if (
    descriptors.length > REPLAY_PREMIERE_MAX_CHUNK_COUNT ||
    descriptors.length !== commitment.chunkCount ||
    last === undefined ||
    last.terminal !== true ||
    last.endSequence !== commitment.finalSequence ||
    last.prepublicationHash !== commitment.terminalPrepublicationRoot ||
    descriptors.some(
      (descriptor, index) =>
        descriptor.index !== index ||
        descriptor.premiereId !== commitment.premiereId ||
        (index === 0
          ? descriptor.previousPrepublicationHash !== null
          : descriptor.previousPrepublicationHash !==
            descriptors[index - 1].prepublicationHash),
    ) ||
    jsonHash({
      schemaVersion: 1,
      premiereId: commitment.premiereId,
      chunks: descriptors,
    }) !== commitment.orderedDraftManifestRoot
  ) {
    throw publicationFailure("revealed_draft_manifest_commitment_mismatch");
  }
}

export class VerifiedPremiereEligibilityGate {
  readonly #issuedReleasedChunks = new Map<number, ReleasedPremiereChunk>();
  private constructor(
    private readonly eligibilityRecord: PremiereEligibility,
    private readonly commitmentNonceBase64: string,
    private readonly bootstrap: GameStartInfo,
    private readonly definition: PremierePublicDefinition,
    private readonly commitmentValue: PremierePublicationCommitment,
    private readonly drafts: readonly PremiereChunkDraft[],
    private readonly result: PremiereAuthoritativeResultBytes,
    private readonly revealEventByteRequirementValue: number,
  ) {
    issuedEligibilityGates.add(this);
    Object.freeze(this);
  }

  static isAuthentic(value: unknown): value is VerifiedPremiereEligibilityGate {
    return (
      value instanceof VerifiedPremiereEligibilityGate &&
      issuedEligibilityGates.has(value)
    );
  }

  static verify(
    options: VerifyPremierePublicationOptions,
  ): VerifiedPremiereEligibilityGate {
    if (!isPremiereId(options.premiereId)) {
      throw publicationFailure("invalid_premiere_id");
    }
    if (
      !VerifiedStagedPremiereSourceBytes.isAuthentic(options.verifiedSource)
    ) {
      throw publicationFailure("unverified_staged_source");
    }
    const stagedSource = options.verifiedSource.stagedSource();
    const sourceBytes = options.verifiedSource.copyBytes();
    if (
      stagedSource.schemaVersion !== 1 ||
      stagedSource.byteLength !== sourceBytes.byteLength ||
      sha256Hex(sourceBytes) !== stagedSource.sourceReplaySha256 ||
      stagedSource.sourceReplaySha256 !==
        options.eligibilityRecord.sourceReplaySha256
    ) {
      throw publicationFailure("staged_source_hash_mismatch");
    }
    VerifiedReplayPremiereLeakAuditReceipt.verifyForEligibility({
      receipt: options.leakAuditReceipt,
      eligibilityRecord: options.eligibilityRecord,
      assessmentOptions: options.eligibilityOptions,
    });
    const assessment = assessPremiereEligibility(
      options.eligibilityRecord,
      options.eligibilityOptions,
    );
    if (!assessment.eligible) {
      throw new ReplayPremiereError(
        "publication_source_ineligible",
        "PREMIERE_SOURCE_INELIGIBLE",
        422,
        "Replay premiere source failed full eligibility assessment",
      );
    }
    const source = decodeControlledSource(
      sourceBytes,
      options.eligibilityRecord,
      options.authoritativeResultBytes,
      options.replayImportLimits,
    );
    const parsedBootstrap = GameStartInfoSchema.strict().safeParse(
      source.replay.gameStartInfo,
    );
    if (!parsedBootstrap.success) {
      throw publicationFailure(
        "invalid_game_start_info",
        parsedBootstrap.error,
      );
    }
    assertNoOutcomeBearingReplayFields(parsedBootstrap.data);
    const canonicalResult = verifyPremiereAuthoritativeResultBytes({
      eligibilityRecord: options.eligibilityRecord,
      resultBytes: options.authoritativeResultBytes,
    });
    if (canonicalResult.gameId !== parsedBootstrap.data.gameID) {
      throw publicationFailure("result_bootstrap_game_mismatch");
    }
    if (!sameJson(canonicalResult.winner, source.authoritativeOutcome.winner)) {
      throw publicationFailure("result_game_record_winner_mismatch");
    }
    if (
      canonicalResult.completedAt !== source.authoritativeOutcome.completedAt
    ) {
      throw publicationFailure("result_game_record_completed_at_mismatch");
    }
    assertLeakFingerprintsBound(options.eligibilityRecord, [
      options.eligibilityRecord.sourceRunId,
      options.eligibilityRecord.sourceReplaySha256,
      options.eligibilityRecord.authoritativeResult.resultHash,
      options.eligibilityRecord.authoritativeResult.sourceId,
      canonicalResult.gameId,
      ...options.eligibilityRecord.seats.flatMap((seat) => [
        seat.seatId,
        seat.displayName,
      ]),
    ]);
    if (
      canonicalResult.turnCount !== source.turnCount ||
      !replayPremiereRecordsMatchDrafts(
        source.replay.records,
        options.publicDefinition.playbackRate,
        options.draftChunks,
      )
    ) {
      throw publicationFailure("source_replay_draft_binding_mismatch");
    }
    const provenance = baseProvenance(
      options.eligibilityRecord,
      assessment.eligibilityRecordHash,
    );
    validatePublicDefinition(
      options.publicDefinition,
      provenance,
      parsedBootstrap.data,
    );
    if (
      !Number.isSafeInteger(options.maxPresentationSpanMs) ||
      options.maxPresentationSpanMs <= 0 ||
      options.maxPresentationSpanMs > 1_000
    ) {
      throw publicationFailure("invalid_max_presentation_span");
    }
    const checkpoints = options.publicDefinition.checkpoints;
    verifyPremiereChunkDraftChain(
      options.draftChunks,
      checkpoints.map((checkpoint) => checkpoint.sequence),
      { maxPresentationSpanMs: options.maxPresentationSpanMs },
    );
    if (
      options.draftChunks.length === 0 ||
      options.draftChunks.some(
        (chunk) => chunk.descriptor.premiereId !== options.premiereId,
      )
    ) {
      throw publicationFailure("draft_premiere_binding_mismatch");
    }
    const frozenDrafts = cloneAndFreezePremiereDraftChunks(options.draftChunks);
    const draftDescriptors = frozenDrafts.map((chunk) =>
      frozenDescriptor(chunk.descriptor),
    );
    const last = draftDescriptors[draftDescriptors.length - 1];
    if (last.endSequence + 1 !== source.turnCount) {
      throw publicationFailure("terminal_sequence_source_turn_count_mismatch");
    }
    const publicDefinition = cloneAndFreezeReplayPremiereValue(
      options.publicDefinition,
      "premiere public definition",
    );
    const bootstrap = cloneAndFreezeReplayPremiereValue(
      parsedBootstrap.data,
      "premiere bootstrap",
    );
    const commitmentWithoutHash = {
      schemaVersion: 1 as const,
      commitmentKind: "replay_premiere_publication_v1" as const,
      premiereId: options.premiereId,
      eligibilityRecordHash: assessment.eligibilityRecordHash,
      sourceRunId: options.eligibilityRecord.sourceRunId,
      sourceReplaySha256: options.eligibilityRecord.sourceReplaySha256,
      gameStartInfoHash: jsonHash(bootstrap),
      publicDefinitionHash: jsonHash(publicDefinition),
      playbackRate: publicDefinition.playbackRate,
      checkpoints: publicDefinition.checkpoints,
      maxPresentationSpanMs: options.maxPresentationSpanMs,
      finalSequence: last.endSequence,
      chunkCount: draftDescriptors.length,
      terminalPrepublicationRoot: last.prepublicationHash,
      orderedDraftManifestRoot: jsonHash({
        schemaVersion: 1,
        premiereId: options.premiereId,
        chunks: draftDescriptors,
      }),
    };
    const commitment = cloneAndFreezeReplayPremiereValue(
      {
        ...commitmentWithoutHash,
        publicationCommitmentHash: jsonHash(commitmentWithoutHash),
      },
      "premiere publication commitment",
    );
    const authoritativeResult = encodePremiereAuthoritativeResult(
      options.authoritativeResultBytes,
    );
    const revealEventByteRequirement =
      assertReplayPremiereRevealEnvelopeCapacity({
        eligibilityRecord: options.eligibilityRecord,
        authoritativeResult,
        publicationCommitment: commitment,
        publicationDraftManifest: draftDescriptors,
        terminalDraft: frozenDrafts[frozenDrafts.length - 1],
        publicProvenance: provenance,
      });
    return new VerifiedPremiereEligibilityGate(
      cloneAndFreezeReplayPremiereValue(
        options.eligibilityRecord,
        "premiere eligibility record",
      ),
      Buffer.from(options.eligibilityOptions.privateCommitmentNonce).toString(
        "base64",
      ),
      bootstrap,
      publicDefinition,
      commitment,
      frozenDrafts,
      authoritativeResult,
      revealEventByteRequirement,
    );
  }

  get premiereId(): string {
    this.assertAuthentic();
    return this.commitmentValue.premiereId;
  }

  get eligibilityRecordHash(): string {
    this.assertAuthentic();
    return this.commitmentValue.eligibilityRecordHash;
  }

  get publicationCommitmentHash(): string {
    this.assertAuthentic();
    return this.commitmentValue.publicationCommitmentHash;
  }

  get sourceRunId(): string {
    this.assertAuthentic();
    return this.commitmentValue.sourceRunId;
  }

  get sourceReplaySha256(): string {
    this.assertAuthentic();
    return this.commitmentValue.sourceReplaySha256;
  }

  get finalSequence(): number {
    this.assertAuthentic();
    return this.commitmentValue.finalSequence;
  }

  get chunkCount(): number {
    this.assertAuthentic();
    return this.commitmentValue.chunkCount;
  }

  get maxPresentationSpanMs(): number {
    this.assertAuthentic();
    return this.commitmentValue.maxPresentationSpanMs;
  }

  /** Conservative full StoredReplayPremiereEvent JSONL bytes for reveal. */
  get requiredRevealEventBytes(): number {
    this.assertAuthentic();
    return this.revealEventByteRequirementValue;
  }

  publicDefinition(): PremierePublicDefinition {
    this.assertAuthentic();
    return cloneAndFreezeReplayPremiereValue(
      this.definition,
      "premiere public definition view",
    );
  }

  publicBootstrap(): GameStartInfo {
    this.assertAuthentic();
    return cloneAndFreezeReplayPremiereValue(
      this.bootstrap,
      "premiere bootstrap view",
    );
  }

  publicationCommitment(): PremierePublicationCommitment {
    this.assertAuthentic();
    return cloneAndFreezeReplayPremiereValue(
      this.commitmentValue,
      "premiere commitment view",
    );
  }

  publicProvenance(): PremierePublicationBaseProvenance {
    this.assertAuthentic();
    return cloneAndFreezeReplayPremiereValue(
      this.definition.provenance,
      "premiere provenance view",
    );
  }

  checkpointSequences(): [number, number] {
    this.assertAuthentic();
    return Object.freeze([
      this.definition.checkpoints[0].sequence,
      this.definition.checkpoints[1].sequence,
    ]) as [number, number];
  }

  expectedDraftDescriptor(index: number): PremiereFrozenDraftDescriptor | null {
    this.assertAuthentic();
    const draft = this.drafts[index];
    return draft === undefined
      ? null
      : cloneAndFreezeReplayPremiereValue(
          frozenDescriptor(draft.descriptor),
          "premiere draft descriptor view",
        );
  }

  revealedDraftManifest(
    terminal: VerifiedPremiereTerminalChunk,
  ): PremiereFrozenDraftDescriptor[] {
    this.assertAuthentic();
    if (!VerifiedPremiereTerminalChunk.isAuthenticFor(terminal, this)) {
      throw publicationFailure("terminal_gate_publication_mismatch");
    }
    const descriptors = cloneAndFreezeReplayPremiereValue(
      this.drafts.map((draft) => frozenDescriptor(draft.descriptor)),
      "revealed draft manifest",
    );
    verifyPremiereRevealedDraftManifest(this.commitmentValue, descriptors);
    return descriptors;
  }

  matchesLifecycleBinding(binding: {
    premiereId: string;
    eligibilityRecordHash: string | null;
    publicationCommitmentHash: string | null;
    sourceRunId: string | null;
    sourceReplaySha256: string | null;
  }): boolean {
    this.assertAuthentic();
    return (
      binding.premiereId === this.premiereId &&
      binding.eligibilityRecordHash === this.eligibilityRecordHash &&
      binding.publicationCommitmentHash === this.publicationCommitmentHash &&
      binding.sourceRunId === this.sourceRunId &&
      binding.sourceReplaySha256 === this.sourceReplaySha256
    );
  }

  releaseNonTerminalChunk(options: {
    draft: PremiereChunkDraft;
    releasedAt: string;
    previousChunk: ReleasedPremiereChunk | null;
    authoritativeElapsedMs: number;
  }): ReleasedPremiereChunk {
    this.assertAuthentic();
    if (options.draft.descriptor.terminal) {
      throw publicationFailure("terminal_requires_verified_reveal_path");
    }
    return this.releaseBoundChunk(options);
  }

  prepareTerminalChunk(options: {
    draft: PremiereChunkDraft;
    releasedAt: string;
    previousChunk: ReleasedPremiereChunk | null;
    authoritativeElapsedMs: number;
  }): VerifiedPremiereTerminalChunk {
    this.assertAuthentic();
    if (!options.draft.descriptor.terminal) {
      throw publicationFailure("terminal_gate_requires_terminal_draft");
    }
    const chunk = this.releaseBoundChunk(options);
    return new VerifiedPremiereTerminalChunk(
      terminalIssueToken,
      this,
      chunk,
      this.result,
      this.eligibilityRecord,
      this.commitmentNonceBase64,
    );
  }

  assertReleasedChunk(chunk: ReleasedPremiereChunk): void {
    this.assertAuthentic();
    verifyPremiereChunkChain([chunk], [], {
      allowNonZeroFirstIndex: true,
      allowNonNullInitialHash: true,
      allowPartialChain: true,
      maxPresentationSpanMs: this.maxPresentationSpanMs,
    });
    this.assertChunkMatchesFrozen(chunk);
    const issued = this.#issuedReleasedChunks.get(chunk.descriptor.index);
    if (issued === undefined || !sameJson(issued, chunk)) {
      throw publicationFailure("released_chunk_not_issued_by_gate");
    }
  }

  recoverReleasedPrefix(
    chunks: readonly ReleasedPremiereChunk[],
    authoritativeElapsedMs: number,
  ): void {
    this.assertAuthentic();
    if (
      !Number.isSafeInteger(authoritativeElapsedMs) ||
      authoritativeElapsedMs < 0 ||
      chunks.some(
        (chunk) =>
          chunk.descriptor.terminal ||
          chunk.descriptor.presentationOffsetMs > authoritativeElapsedMs,
      )
    ) {
      throw publicationFailure("invalid_recovered_release_timing");
    }
    verifyPremiereChunkChain(chunks, [], {
      allowPartialChain: true,
      maxPresentationSpanMs: this.maxPresentationSpanMs,
    });
    for (const chunk of chunks) {
      this.assertChunkMatchesFrozen(chunk);
      const accepted = cloneAndFreezeReplayPremiereValue(
        chunk,
        "recovered released premiere chunk",
      );
      const existing = this.#issuedReleasedChunks.get(chunk.descriptor.index);
      if (existing !== undefined && !sameJson(existing, accepted)) {
        throw publicationFailure(
          "recovered_release_conflicts_with_issued_chunk",
        );
      }
      this.#issuedReleasedChunks.set(chunk.descriptor.index, accepted);
    }
  }

  recoverReleasedChainForReveal(
    chunks: readonly ReleasedPremiereChunk[],
  ): void {
    this.assertAuthentic();
    if (
      chunks.length !== this.chunkCount ||
      chunks.at(-1)?.descriptor.terminal !== true
    ) {
      throw publicationFailure("invalid_recovered_reveal_chain_length");
    }
    verifyPremiereChunkChain(chunks, this.checkpointSequences(), {
      maxPresentationSpanMs: this.maxPresentationSpanMs,
    });
    for (const chunk of chunks) {
      this.assertChunkMatchesFrozen(chunk);
      const accepted = cloneAndFreezeReplayPremiereValue(
        chunk,
        "recovered reveal chain chunk",
      );
      const existing = this.#issuedReleasedChunks.get(chunk.descriptor.index);
      if (existing !== undefined && !sameJson(existing, accepted)) {
        throw publicationFailure(
          "recovered_release_conflicts_with_issued_chunk",
        );
      }
      this.#issuedReleasedChunks.set(chunk.descriptor.index, accepted);
    }
  }

  private assertChunkMatchesFrozen(chunk: ReleasedPremiereChunk): void {
    const frozen = this.drafts[chunk.descriptor.index];
    if (
      frozen === undefined ||
      !sameJson(frozen.payload, chunk.payload) ||
      !sameDraftAndReleasedDescriptor(frozen.descriptor, chunk.descriptor)
    ) {
      throw publicationFailure("released_chunk_not_in_frozen_publication");
    }
  }

  revealMaterial(terminal: VerifiedPremiereTerminalChunk): {
    eligibilityRecord: PremiereEligibility;
    commitmentNonce: Uint8Array;
    authoritativeResult: PremiereAuthoritativeResultBytes;
  } {
    this.assertAuthentic();
    if (!VerifiedPremiereTerminalChunk.isAuthenticFor(terminal, this)) {
      throw publicationFailure("terminal_gate_publication_mismatch");
    }
    return {
      eligibilityRecord: cloneAndFreezeReplayPremiereValue(
        this.eligibilityRecord,
        "revealed eligibility record",
      ),
      commitmentNonce: Buffer.from(this.commitmentNonceBase64, "base64"),
      authoritativeResult: cloneAndFreezeReplayPremiereValue(
        this.result,
        "revealed authoritative result",
      ),
    };
  }

  private releaseBoundChunk(options: {
    draft: PremiereChunkDraft;
    releasedAt: string;
    previousChunk: ReleasedPremiereChunk | null;
    authoritativeElapsedMs: number;
  }): ReleasedPremiereChunk {
    assertTimestamp(options.releasedAt);
    if (
      !Number.isSafeInteger(options.authoritativeElapsedMs) ||
      options.authoritativeElapsedMs <
        options.draft.descriptor.presentationOffsetMs
    ) {
      throw publicationFailure("chunk_release_before_presentation_end");
    }
    const expected = this.drafts[options.draft.descriptor.index];
    if (
      expected === undefined ||
      !sameJson(expected, options.draft) ||
      options.draft.descriptor.index >= this.chunkCount
    ) {
      throw publicationFailure("draft_not_in_frozen_publication");
    }
    const previousChunkHash =
      options.previousChunk?.descriptor.chunkHash ?? null;
    if (expected.descriptor.index === 0) {
      if (options.previousChunk !== null) {
        throw publicationFailure("unexpected_previous_published_chunk");
      }
    } else {
      if (
        options.previousChunk === null ||
        options.previousChunk.descriptor.index !== expected.descriptor.index - 1
      ) {
        throw publicationFailure("missing_previous_published_chunk");
      }
      this.assertReleasedChunk(options.previousChunk);
    }
    const withoutHash: Omit<
      PremiereChunkDescriptor,
      "chunkHash" | "releasedAt"
    > & { releasedAt: string } = {
      premiereId: expected.descriptor.premiereId,
      index: expected.descriptor.index,
      startSequence: expected.descriptor.startSequence,
      endSequence: expected.descriptor.endSequence,
      startTurn: expected.descriptor.startTurn,
      endTurn: expected.descriptor.endTurn,
      presentationOffsetMs: expected.descriptor.presentationOffsetMs,
      previousChunkHash,
      payloadHash: expected.descriptor.payloadHash,
      byteLength: expected.descriptor.byteLength,
      terminal: expected.descriptor.terminal,
      releasedAt: options.releasedAt,
    };
    const released = cloneAndFreezeReplayPremiereValue(
      {
        descriptor: {
          ...withoutHash,
          chunkHash: jsonHash(descriptorHashInput(withoutHash)),
        },
        payload: expected.payload,
      },
      "released premiere chunk",
    );
    this.assertChunkMatchesFrozen(released);
    this.#issuedReleasedChunks.set(released.descriptor.index, released);
    this.assertReleasedChunk(released);
    return released;
  }

  private assertAuthentic(): void {
    if (!issuedEligibilityGates.has(this)) {
      throw publicationFailure("fabricated_publication_gate");
    }
  }
}

export class VerifiedPremiereTerminalChunk {
  constructor(
    issueToken: typeof terminalIssueToken,
    private readonly gate: VerifiedPremiereEligibilityGate,
    private readonly value: ReleasedPremiereChunk,
    private readonly result: PremiereAuthoritativeResultBytes,
    private readonly eligibility: PremiereEligibility,
    private readonly nonceBase64: string,
  ) {
    if (issueToken !== terminalIssueToken) {
      throw publicationFailure("fabricated_terminal_gate");
    }
    issuedTerminalChunks.add(this);
    Object.freeze(this);
  }

  static isAuthentic(value: unknown): value is VerifiedPremiereTerminalChunk {
    return (
      value instanceof VerifiedPremiereTerminalChunk &&
      issuedTerminalChunks.has(value)
    );
  }

  static isAuthenticFor(
    value: unknown,
    gate: VerifiedPremiereEligibilityGate,
  ): value is VerifiedPremiereTerminalChunk {
    return (
      this.isAuthentic(value) &&
      value.gate === gate &&
      VerifiedPremiereEligibilityGate.isAuthentic(gate)
    );
  }

  get premiereId(): string {
    this.assertAuthentic();
    return this.value.descriptor.premiereId;
  }

  get finalSequence(): number {
    this.assertAuthentic();
    return this.value.descriptor.endSequence;
  }

  get resultHash(): string {
    this.assertAuthentic();
    return this.result.sha256;
  }

  get revealedAt(): string {
    this.assertAuthentic();
    return this.value.descriptor.releasedAt;
  }

  chunk(): ReleasedPremiereChunk {
    this.assertAuthentic();
    return cloneAndFreezeReplayPremiereValue(
      this.value,
      "verified terminal chunk view",
    );
  }

  matchesPrevious(previous: ReleasedPremiereChunk | null): boolean {
    this.assertAuthentic();
    return (
      this.value.descriptor.index === (previous?.descriptor.index ?? -1) + 1 &&
      this.value.descriptor.startSequence ===
        (previous?.descriptor.endSequence ?? -1) + 1 &&
      this.value.descriptor.previousChunkHash ===
        (previous?.descriptor.chunkHash ?? null)
    );
  }

  revealMaterial(): {
    eligibilityRecord: PremiereEligibility;
    commitmentNonce: Uint8Array;
    authoritativeResult: PremiereAuthoritativeResultBytes;
  } {
    this.assertAuthentic();
    return {
      eligibilityRecord: cloneAndFreezeReplayPremiereValue(
        this.eligibility,
        "terminal eligibility view",
      ),
      commitmentNonce: Buffer.from(this.nonceBase64, "base64"),
      authoritativeResult: cloneAndFreezeReplayPremiereValue(
        this.result,
        "terminal result view",
      ),
    };
  }

  private assertAuthentic(): void {
    if (!issuedTerminalChunks.has(this)) {
      throw publicationFailure("fabricated_terminal_gate");
    }
  }
}

function validatePublicDefinition(
  definition: PremierePublicDefinition,
  provenance: PremierePublicationBaseProvenance,
  bootstrap: GameStartInfo,
): void {
  const checkpoints = definition.checkpoints;
  if (
    !isDisplayText(definition.title, 160) ||
    !isDisplayText(definition.spoilerNeutralDescription, 1_000) ||
    !isIdentifier(definition.map.id) ||
    !isDisplayText(definition.map.label, 160) ||
    definition.map.id !== String(bootstrap.config.gameMap) ||
    !isIdentifier(definition.matchFormat.id) ||
    !isDisplayText(definition.matchFormat.label, 160) ||
    definition.matchFormat.seatCount !== provenance.seats.length ||
    bootstrap.players.length !== provenance.seats.length ||
    ![1, 2, 4].includes(definition.playbackRate) ||
    !isCanonicalTimestamp(definition.scheduledAt) ||
    !Array.isArray(checkpoints) ||
    checkpoints.length !== 2 ||
    !checkpointIdPattern.test(checkpoints[0].id) ||
    !checkpointIdPattern.test(checkpoints[1].id) ||
    checkpoints[0].id === checkpoints[1].id ||
    !Number.isSafeInteger(checkpoints[0].sequence) ||
    !Number.isSafeInteger(checkpoints[1].sequence) ||
    checkpoints[0].sequence <= 0 ||
    checkpoints[0].sequence >= checkpoints[1].sequence ||
    !sameJson(definition.provenance, provenance)
  ) {
    throw publicationFailure("invalid_public_definition");
  }
  assertNoOutcomeBearingReplayFields(definition);
}

function baseProvenance(
  record: PremiereEligibility,
  eligibilityRecordHash: string,
): PremierePublicationBaseProvenance {
  return cloneAndFreezeReplayPremiereValue(
    {
      sourceKind: record.sourceKind,
      sourceRunId: record.sourceRunId,
      coworld: record.coworld,
      sourceReplaySha256: record.sourceReplaySha256,
      seats: record.seats.map(copySeat),
      publicLabel: record.publicLabel,
      eligibilityRecordHash,
    },
    "publication provenance",
  );
}

function frozenDescriptor(
  value: PremiereChunkDraft["descriptor"],
): PremiereFrozenDraftDescriptor {
  return {
    premiereId: value.premiereId,
    index: value.index,
    startSequence: value.startSequence,
    endSequence: value.endSequence,
    startTurn: value.startTurn,
    endTurn: value.endTurn,
    presentationOffsetMs: value.presentationOffsetMs,
    previousPrepublicationHash: value.previousPrepublicationHash,
    prepublicationHash: value.prepublicationHash,
    payloadHash: value.payloadHash,
    byteLength: value.byteLength,
    terminal: value.terminal,
    releasedAt: null,
  };
}

function sameDraftAndReleasedDescriptor(
  draft: PremiereChunkDraft["descriptor"],
  released: ReleasedPremiereChunk["descriptor"],
): boolean {
  return (
    draft.premiereId === released.premiereId &&
    draft.index === released.index &&
    draft.startSequence === released.startSequence &&
    draft.endSequence === released.endSequence &&
    draft.startTurn === released.startTurn &&
    draft.endTurn === released.endTurn &&
    draft.presentationOffsetMs === released.presentationOffsetMs &&
    draft.payloadHash === released.payloadHash &&
    draft.byteLength === released.byteLength &&
    draft.terminal === released.terminal
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
  assertReplayPremiereJsonValue(value, "published chunk descriptor");
  return value;
}

function jsonHash(value: unknown): string {
  assertReplayPremiereJsonValue(value, "publication commitment value");
  return hashReplayPremiereJson(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return jsonHash(left) === jsonHash(right);
  } catch {
    return false;
  }
}

function copySeat(seat: PremiereSeatIdentity): PremiereSeatIdentity {
  return {
    seatId: seat.seatId,
    displayName: seat.displayName,
    policyIdentity: { ...seat.policyIdentity },
  };
}

function decodeControlledSource(
  sourceBytes: Uint8Array,
  eligibility: PremiereEligibility,
  authoritativeResultBytes: Uint8Array,
  importLimits: PremiereReplayImportLimits,
): {
  replay: ReturnType<typeof importPremiereReplay>;
  turnCount: number;
  authoritativeOutcome: {
    winner: ReplayPremiereJsonValue;
    completedAt: string;
  };
} {
  if (eligibility.sourceKind !== "controlled_exhibition") {
    throw publicationFailure("unsupported_strict_source_kind");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(sourceBytes).toString("utf8"));
  } catch (error) {
    throw publicationFailure("staged_source_invalid_json", error);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw publicationFailure("staged_source_not_object");
  }
  const source = value as Record<string, unknown>;
  assertExactObjectKeys(source, [
    "schemaVersion",
    "bundleKind",
    "sourceRunId",
    "createdAt",
    "gameRecord",
    "replay",
    "authoritativeResult",
    "seats",
    "provenance",
  ]);
  if (
    source.schemaVersion !== 1 ||
    source.bundleKind !== "proxywar_controlled_exhibition_source" ||
    source.sourceRunId !== eligibility.sourceRunId ||
    !isCanonicalTimestamp(source.createdAt) ||
    !sameJson(source.seats, eligibility.seats) ||
    source.replay === null ||
    typeof source.replay !== "object" ||
    Array.isArray(source.replay) ||
    source.authoritativeResult === null ||
    typeof source.authoritativeResult !== "object" ||
    Array.isArray(source.authoritativeResult)
  ) {
    throw publicationFailure("staged_source_contract_mismatch");
  }
  const replay = source.replay as Record<string, unknown>;
  const result = source.authoritativeResult as Record<string, unknown>;
  assertExactObjectKeys(replay, ["turnCount", "turnIntervalMs"]);
  assertExactObjectKeys(result, ["sourceId", "encoding", "bytes", "sha256"]);
  if (
    !Number.isSafeInteger(replay.turnCount) ||
    Number(replay.turnCount) < 4 ||
    !Number.isSafeInteger(replay.turnIntervalMs) ||
    Number(replay.turnIntervalMs) <= 0 ||
    result.sourceId !== eligibility.authoritativeResult.sourceId ||
    result.encoding !== "base64" ||
    typeof result.bytes !== "string" ||
    typeof result.sha256 !== "string" ||
    result.sha256 !== eligibility.authoritativeResult.resultHash
  ) {
    throw publicationFailure("staged_source_replay_or_result_mismatch");
  }
  const embeddedResult = Buffer.from(result.bytes, "base64");
  if (
    embeddedResult.toString("base64") !== result.bytes ||
    sha256Hex(embeddedResult) !== result.sha256 ||
    !embeddedResult.equals(Buffer.from(authoritativeResultBytes))
  ) {
    throw publicationFailure("staged_source_embedded_result_mismatch");
  }
  const parsedRecord = GameRecordSchema.strict().safeParse(source.gameRecord);
  if (!parsedRecord.success) {
    throw publicationFailure(
      "staged_source_invalid_game_record",
      parsedRecord.error,
    );
  }
  if (
    parsedRecord.data.info.num_turns !== replay.turnCount ||
    parsedRecord.data.turns.some(
      (turn, index, turns) =>
        turn.turnNumber >= Number(replay.turnCount) ||
        (index > 0 && turn.turnNumber <= turns[index - 1].turnNumber),
    )
  ) {
    throw publicationFailure("staged_source_turn_count_mismatch");
  }
  validateControlledSourceSeats(
    source.seats,
    parsedRecord.data.info.players,
    eligibility.seats,
  );
  const info = parsedRecord.data.info;
  const completedAt = canonicalGameRecordCompletion(info.end);
  const winner =
    info.winner === undefined
      ? null
      : jsonValueForPublication(info.winner, "controlled GameRecord winner");
  validateControlledSourceProvenance(
    source.provenance,
    parsedRecord.data,
    Number(replay.turnCount),
    source.createdAt,
  );
  const gameStartInfo = {
    gameID: info.gameID,
    lobbyCreatedAt: info.lobbyCreatedAt,
    ...(info.visibleAt === undefined ? {} : { visibleAt: info.visibleAt }),
    config: info.config,
    players: info.players.map((player) => ({
      clientID: player.clientID,
      username: player.username,
      clanTag: player.clanTag,
      ...(player.cosmetics === undefined
        ? {}
        : { cosmetics: player.cosmetics }),
      ...(player.isLobbyCreator === undefined
        ? {}
        : { isLobbyCreator: player.isLobbyCreator }),
    })),
  };
  const imported = importPremiereReplay(
    {
      gameStartInfo,
      turns: parsedRecord.data.turns.map((turn) => ({ turn })),
      turnCount: Number(replay.turnCount),
      turnIntervalMs: Number(replay.turnIntervalMs),
    },
    importLimits,
  );
  return {
    replay: imported,
    turnCount: Number(replay.turnCount),
    authoritativeOutcome: { winner, completedAt },
  };
}

function canonicalGameRecordCompletion(end: number): string {
  if (!Number.isSafeInteger(end)) {
    throw publicationFailure("controlled_source_ambiguous_completion_time");
  }
  const completedAt = new Date(end);
  if (!Number.isFinite(completedAt.getTime())) {
    throw publicationFailure("controlled_source_invalid_completion_time");
  }
  return completedAt.toISOString();
}

export function replayPremiereRecordsMatchDrafts(
  records: readonly PremiereSourceRecord[],
  playbackRate: PremierePlaybackRate,
  chunks: readonly PremiereChunkDraft[],
): boolean {
  let sourceIndex = 0;
  for (const chunk of chunks) {
    for (const draftRecord of chunk.payload.records) {
      const sourceRecord = records[sourceIndex];
      if (
        sourceRecord === undefined ||
        !sameJson(
          {
            sequence: sourceRecord.sequence,
            turn: sourceRecord.turn,
            presentationOffsetMs: Math.floor(
              sourceRecord.nominalOffsetMs / playbackRate,
            ),
            payload: sourceRecord.payload,
          },
          draftRecord,
        )
      ) {
        return false;
      }
      sourceIndex += 1;
    }
  }
  return sourceIndex === records.length;
}

export function cloneAndFreezePremiereDraftChunks(
  chunks: readonly PremiereChunkDraft[],
): readonly PremiereChunkDraft[] {
  return Object.freeze(
    chunks.map((chunk, index) =>
      cloneAndFreezeReplayPremiereValue(
        chunk,
        `premiere frozen draft chunk ${index}`,
      ),
    ),
  );
}

export function replayPremiereDraftChunksMatch(
  left: readonly PremiereChunkDraft[],
  right: readonly PremiereChunkDraft[],
): boolean {
  return (
    left.length === right.length &&
    left.every((chunk, index) => sameJson(chunk, right[index]))
  );
}

function assertExactObjectKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw publicationFailure("staged_source_unknown_or_missing_field");
  }
}

function assertLeakFingerprintsBound(
  eligibility: PremiereEligibility,
  required: readonly string[],
): void {
  for (const target of eligibility.proxyWarLeakAuditManifest.targets) {
    const fingerprints = target.expectation.forbiddenText;
    if (required.some((identity) => !fingerprints.includes(identity))) {
      throw publicationFailure("leak_manifest_fingerprint_binding_mismatch");
    }
  }
}

function validateControlledSourceSeats(
  sourceSeats: unknown,
  players: Array<{ clientID: string; username: string }>,
  eligibilitySeats: PremiereSeatIdentity[],
): void {
  if (
    !Array.isArray(sourceSeats) ||
    sourceSeats.length !== players.length ||
    sourceSeats.length !== eligibilitySeats.length
  ) {
    throw publicationFailure("controlled_source_seat_count_mismatch");
  }
  const playerById = new Map(
    players.map((player) => [player.clientID, player.username]),
  );
  const seen = new Set<string>();
  for (const [index, value] of sourceSeats.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw publicationFailure("controlled_source_invalid_seat");
    }
    const seat = value as Record<string, unknown>;
    assertExactObjectKeys(seat, ["seatId", "displayName", "policyIdentity"]);
    if (
      typeof seat.seatId !== "string" ||
      typeof seat.displayName !== "string" ||
      seen.has(seat.seatId) ||
      playerById.get(seat.seatId) !== seat.displayName ||
      !sameJson(seat, eligibilitySeats[index])
    ) {
      throw publicationFailure(
        "controlled_source_seat_player_binding_mismatch",
      );
    }
    seen.add(seat.seatId);
  }
}

function validateControlledSourceProvenance(
  value: unknown,
  gameRecord: {
    gitCommit: string;
    info: {
      gameID: string;
      start: number;
      end: number;
      num_turns: number;
      config: Record<string, unknown>;
    };
  },
  turnCount: number,
  createdAt: unknown,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw publicationFailure("controlled_source_missing_provenance");
  }
  const provenance = value as Record<string, unknown>;
  assertExactObjectKeys(provenance, [
    "generator",
    "brainMode",
    "runnerMode",
    "executionConfig",
    "executionConfigSha256",
    "game",
    "build",
  ]);
  if (
    provenance.generator !== "replay-premiere-controlled-exhibition/v1" ||
    typeof provenance.brainMode !== "string" ||
    provenance.runnerMode !== "step-locked" ||
    !isSha256Hex(provenance.executionConfigSha256) ||
    provenance.executionConfig === null ||
    typeof provenance.executionConfig !== "object" ||
    Array.isArray(provenance.executionConfig) ||
    provenance.game === null ||
    typeof provenance.game !== "object" ||
    Array.isArray(provenance.game) ||
    provenance.build === null ||
    typeof provenance.build !== "object" ||
    Array.isArray(provenance.build)
  ) {
    throw publicationFailure("controlled_source_invalid_provenance");
  }
  const execution = provenance.executionConfig as Record<string, unknown>;
  const game = provenance.game as Record<string, unknown>;
  const build = provenance.build as Record<string, unknown>;
  assertExactObjectKeys(execution, [
    "schemaVersion",
    "scenario",
    "brainMode",
    "runnerMode",
    "planEveryDecisionSteps",
    "runner",
    "game",
    "disabledActionKinds",
  ]);
  assertExactObjectKeys(game, [
    "gameId",
    "startedAt",
    "completedAt",
    "turnCount",
    "map",
    "mapSize",
    "mode",
    "gameType",
  ]);
  assertExactObjectKeys(build, [
    "repositoryHead",
    "repositoryTree",
    "trackedWorktreeClean",
    "trackedWorktreeStateSha256",
    "packageName",
    "packageVersion",
    "packageJsonSha256",
    "smokeRunnerSha256",
    "generatorSha256",
    "nodeVersion",
    "platform",
    "architecture",
  ]);
  let controlledExecution: ReplayPremiereControlledExecutionConfig;
  try {
    controlledExecution =
      validateReplayPremiereControlledExecutionConfig(execution);
  } catch {
    throw publicationFailure("controlled_source_execution_outside_allowlist");
  }
  if (
    controlledExecution.brainMode !== provenance.brainMode ||
    controlledExecution.runnerMode !== provenance.runnerMode ||
    hashReplayPremiereJson(
      jsonValueForPublication(
        controlledExecution,
        "controlled execution config",
      ),
    ) !== provenance.executionConfigSha256
  ) {
    throw publicationFailure("controlled_source_execution_provenance_mismatch");
  }
  validateControlledExecutionGameBinding(
    controlledExecution,
    gameRecord.info.config,
  );
  const completedAt = new Date(gameRecord.info.end).toISOString();
  if (
    game.gameId !== gameRecord.info.gameID ||
    game.startedAt !== new Date(gameRecord.info.start).toISOString() ||
    game.completedAt !== completedAt ||
    game.turnCount !== turnCount ||
    game.map !== String(gameRecord.info.config.gameMap) ||
    game.mapSize !== String(gameRecord.info.config.gameMapSize) ||
    game.mode !== String(gameRecord.info.config.gameMode) ||
    game.gameType !== String(gameRecord.info.config.gameType) ||
    createdAt !== completedAt
  ) {
    throw publicationFailure("controlled_source_game_provenance_mismatch");
  }
  if (
    !isGitIdentity(build.repositoryHead) ||
    build.repositoryHead !== gameRecord.gitCommit ||
    !isGitIdentity(build.repositoryTree) ||
    build.trackedWorktreeClean !== true ||
    !isSha256Hex(build.trackedWorktreeStateSha256) ||
    !isDisplayText(build.packageName, 128) ||
    (build.packageVersion !== null && !isIdentifier(build.packageVersion)) ||
    !isSha256Hex(build.packageJsonSha256) ||
    !isSha256Hex(build.smokeRunnerSha256) ||
    !isSha256Hex(build.generatorSha256) ||
    !isDisplayText(build.nodeVersion, 128) ||
    !isDisplayText(build.platform, 128) ||
    !isDisplayText(build.architecture, 128)
  ) {
    throw publicationFailure("controlled_source_build_provenance_mismatch");
  }
}

function validateControlledExecutionGameBinding(
  execution: ReplayPremiereControlledExecutionConfig,
  gameConfig: Record<string, unknown>,
): void {
  const game = execution.game;
  if (
    game.bots !== (gameConfig.bots ?? 0) ||
    game.nations !== (gameConfig.nations ?? "disabled") ||
    game.map !== String(gameConfig.gameMap) ||
    game.mapSize !== String(gameConfig.gameMapSize) ||
    game.difficulty !== String(gameConfig.difficulty) ||
    game.varySpawns !== false ||
    gameConfig.randomSpawn !== false
  ) {
    throw publicationFailure("controlled_source_execution_game_mismatch");
  }
}

function jsonValueForPublication(
  value: unknown,
  source: string,
): ReplayPremiereJsonValue {
  assertReplayPremiereJsonValue(value, source);
  return value;
}

function isGitIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}

function isDisplayText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maxLength &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertTimestamp(value: string): void {
  if (!isCanonicalTimestamp(value)) {
    throw publicationFailure("invalid_release_timestamp");
  }
}

function publicationFailure(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    `Replay premiere publication verification failed: ${operatorCode}`,
    cause === undefined ? undefined : { cause },
  );
}
