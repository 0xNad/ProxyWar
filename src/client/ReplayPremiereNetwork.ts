import { z } from "zod";
import {
  GameStartInfoSchema,
  TurnSchema,
  type GameStartInfo,
} from "../core/Schemas";
import {
  ReplayPremierePlaybackController,
  type VerifiedReplayPremiereBatch,
} from "./ReplayPremierePlayback";

const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;
const CHECKPOINT_ID_PATTERN = /^cp_[a-z0-9]{8,32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const JSON_CONTENT_TYPE_PATTERN = /^(?:application\/json|[^;]+\+json)(?:;|$)/i;
const ELIGIBILITY_COMMITMENT_DOMAIN = "proxywar-premiere-eligibility-v1\0";
const MAX_JSON_NODES = 100_000;
const MAX_JSON_DEPTH = 64;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_INITIAL_RETRY_MS = 250;
const DEFAULT_MAX_RETRY_MS = 5_000;
const DEFAULT_CATCH_UP_THRESHOLD_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_AUTHORITATIVE_RESULT_BYTES = 1_000_000;

const OUTCOME_BEARING_KEYS = new Set([
  "allplayersstats",
  "authoritativeresult",
  "decisiontail",
  "diagnostics",
  "duration",
  "finalchunkhash",
  "finalchunkindex",
  "finalsequence",
  "finalstandings",
  "finalstate",
  "gameendinfo",
  "gameresult",
  "lobbyfilltime",
  "numturns",
  "persistentid",
  "ratingmovement",
  "result",
  "resulthash",
  "results",
  "reward",
  "stats",
  "winner",
  "winnerid",
  "winnerseat",
  "winnerslot",
]);

export type ReplayPremiereNetworkErrorCode =
  | "invalid_configuration"
  | "request_failed"
  | "response_unavailable"
  | "invalid_cache_policy"
  | "invalid_content_type"
  | "response_too_large"
  | "invalid_json"
  | "invalid_schema"
  | "outcome_field_leak"
  | "bootstrap_integrity_failure"
  | "manifest_integrity_failure"
  | "manifest_regression"
  | "chunk_not_advertised"
  | "chunk_integrity_failure"
  | "reveal_integrity_failure"
  | "callback_failure"
  | "disposed";

/**
 * Stable error surface for UI integration. The message never contains a URL,
 * response body, status text, schema detail, raw path, or thrown network text.
 */
export class ReplayPremiereNetworkError extends Error {
  constructor(
    public readonly code: ReplayPremiereNetworkErrorCode,
    public readonly recoverable: boolean,
  ) {
    super(code);
    this.name = "ReplayPremiereNetworkError";
  }
}

const canonicalTimestampSchema = z
  .string()
  .refine((value) => isCanonicalTimestamp(value));
const premiereIdSchema = z.string().regex(PREMIERE_ID_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const opaqueIdSchema = z.string().regex(OPAQUE_ID_PATTERN);
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const releasedIndexSchema = z.number().int().min(-1).safe();
const safeTokenSchema = z.string().regex(SAFE_TOKEN_PATTERN);

function displayTextSchema(maxLength = 256): z.ZodString {
  return z
    .string()
    .max(maxLength)
    .refine(
      (value) =>
        value.trim() === value &&
        value.length > 0 &&
        !Array.from(value).some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 31 || codePoint === 127;
        }),
    );
}

const localPolicyIdentitySchema = z
  .object({
    namespace: z.literal("local_manifest"),
    manifestName: displayTextSchema(),
    declaredVersion: safeTokenSchema,
    manifestSha256: sha256Schema,
    contentSha256: sha256Schema,
  })
  .strict();

const softmaxPolicyIdentitySchema = z
  .object({
    namespace: z.literal("softmax_policy_version"),
    policyVersionId: opaqueIdSchema,
    policyName: displayTextSchema(),
    serverAssignedVersion: safeTokenSchema,
  })
  .strict();

const policyIdentitySchema = z.discriminatedUnion("namespace", [
  softmaxPolicyIdentitySchema,
  localPolicyIdentitySchema,
]);

const seatIdentitySchema = z
  .object({
    seatId: opaqueIdSchema,
    displayName: displayTextSchema(),
    policyIdentity: policyIdentitySchema,
  })
  .strict();

const coworldIdsSchema = z
  .object({
    episodeId: opaqueIdSchema,
    leagueId: opaqueIdSchema,
    divisionId: opaqueIdSchema,
    roundId: opaqueIdSchema,
  })
  .strict();

const baseProvenanceSchema = z
  .object({
    sourceKind: z.enum(["controlled_exhibition", "rated_coworld"]),
    sourceRunId: opaqueIdSchema,
    coworld: coworldIdsSchema.nullable(),
    sourceReplaySha256: sha256Schema,
    seats: z.array(seatIdentitySchema).min(2).max(64),
    publicLabel: z.enum(["premiere", "spoiler_resistant_premiere"]),
    eligibilityRecordHash: sha256Schema,
  })
  .strict();

const provenanceSchema = baseProvenanceSchema
  .extend({ publicationCommitmentHash: sha256Schema })
  .strict();

const publicationCheckpointSchema = z
  .object({
    id: z.string().regex(CHECKPOINT_ID_PATTERN),
    sequence: z.number().int().positive().safe(),
  })
  .strict();

const publicationCheckpointsSchema = z.tuple([
  publicationCheckpointSchema,
  publicationCheckpointSchema,
]);

const publicDefinitionSchema = z
  .object({
    title: displayTextSchema(160),
    spoilerNeutralDescription: displayTextSchema(1_000),
    map: z
      .object({ id: opaqueIdSchema, label: displayTextSchema(160) })
      .strict(),
    matchFormat: z
      .object({
        id: opaqueIdSchema,
        label: displayTextSchema(160),
        seatCount: z.number().int().min(2).max(64).safe(),
      })
      .strict(),
    scheduledAt: canonicalTimestampSchema,
    playbackRate: z.union([z.literal(1), z.literal(2), z.literal(4)]),
    checkpoints: publicationCheckpointsSchema,
    provenance: baseProvenanceSchema,
  })
  .strict();

const publicationCommitmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    commitmentKind: z.literal("replay_premiere_publication_v1"),
    premiereId: premiereIdSchema,
    eligibilityRecordHash: sha256Schema,
    sourceRunId: opaqueIdSchema,
    sourceReplaySha256: sha256Schema,
    gameStartInfoHash: sha256Schema,
    publicDefinitionHash: sha256Schema,
    playbackRate: z.union([z.literal(1), z.literal(2), z.literal(4)]),
    checkpoints: publicationCheckpointsSchema,
    maxPresentationSpanMs: z.number().int().min(1).max(1_000).safe(),
    finalSequence: nonNegativeIntegerSchema,
    chunkCount: z.number().int().positive().safe(),
    terminalPrepublicationRoot: sha256Schema,
    orderedDraftManifestRoot: sha256Schema,
    publicationCommitmentHash: sha256Schema,
  })
  .strict();

const frozenDraftDescriptorSchema = z
  .object({
    premiereId: premiereIdSchema,
    index: nonNegativeIntegerSchema,
    startSequence: nonNegativeIntegerSchema,
    endSequence: nonNegativeIntegerSchema,
    startTurn: nonNegativeIntegerSchema,
    endTurn: nonNegativeIntegerSchema,
    presentationOffsetMs: nonNegativeIntegerSchema,
    previousPrepublicationHash: sha256Schema.nullable(),
    prepublicationHash: sha256Schema,
    payloadHash: sha256Schema,
    byteLength: z.number().int().positive().safe(),
    terminal: z.boolean(),
    releasedAt: z.null(),
  })
  .strict();

const checkpointSchema = z
  .object({
    id: z.string().regex(CHECKPOINT_ID_PATTERN),
    sequence: z.number().int().positive().safe(),
    opensAt: canonicalTimestampSchema,
    closesAt: canonicalTimestampSchema,
    questionKind: z.literal("winner_from_here"),
    optionSeatIds: z.array(opaqueIdSchema).min(1).max(64),
    state: z.enum(["open", "closed"]),
  })
  .strict();

const releasedChunkDescriptorSchema = z
  .object({
    premiereId: premiereIdSchema,
    index: nonNegativeIntegerSchema,
    startSequence: nonNegativeIntegerSchema,
    endSequence: nonNegativeIntegerSchema,
    startTurn: nonNegativeIntegerSchema,
    endTurn: nonNegativeIntegerSchema,
    presentationOffsetMs: nonNegativeIntegerSchema,
    previousChunkHash: sha256Schema.nullable(),
    payloadHash: sha256Schema,
    chunkHash: sha256Schema,
    byteLength: nonNegativeIntegerSchema,
    terminal: z.boolean(),
    releasedAt: canonicalTimestampSchema,
  })
  .strict();

const preRevealManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    premiereId: premiereIdSchema,
    state: z.enum([
      "scheduled",
      "playing",
      "checkpoint",
      "failed",
      "cancelled",
    ]),
    serverNow: canonicalTimestampSchema,
    scheduledAt: canonicalTimestampSchema,
    actualStartAt: canonicalTimestampSchema.nullable(),
    playbackRate: z.union([z.literal(1), z.literal(2), z.literal(4)]),
    authoritativeElapsedMs: nonNegativeIntegerSchema,
    accumulatedPauseMs: nonNegativeIntegerSchema,
    releasedThroughSequence: releasedIndexSchema,
    lastReleasedChunkIndex: releasedIndexSchema,
    activeCheckpoint: checkpointSchema.nullable(),
    provenance: provenanceSchema,
    releasedChunks: z.array(releasedChunkDescriptorSchema).max(100_000),
  })
  .strict();

const revealPointerSchema = z
  .object({
    schemaVersion: z.literal(1),
    premiereId: premiereIdSchema,
    state: z.union([z.literal("revealed"), z.literal("archived")]),
    revealUrl: z.string(),
    revealedAt: canonicalTimestampSchema,
    revealCommitHash: sha256Schema,
    provenance: provenanceSchema,
  })
  .strict();

const bootstrapSchema = z
  .object({
    schemaVersion: z.literal(1),
    premiereId: premiereIdSchema,
    gameStartInfo: z.unknown(),
    gameStartInfoHash: sha256Schema,
    publicDefinition: publicDefinitionSchema,
    publicationCommitmentHash: sha256Schema,
    provenance: provenanceSchema,
    integrityScope: z
      .object({
        publicationCommitment: z.literal("anchored_server_enforced"),
        sourceReplay: z.literal("declared_hash_only"),
        authoritativeResult: z.literal("not_revealed"),
      })
      .strict(),
  })
  .strict();

const releasedRecordSchema = z
  .object({
    sequence: nonNegativeIntegerSchema,
    turn: nonNegativeIntegerSchema,
    presentationOffsetMs: nonNegativeIntegerSchema,
    payload: z.unknown(),
  })
  .strict();

const publicChunkSchema = z
  .object({
    schemaVersion: z.literal(1),
    premiereId: premiereIdSchema,
    index: nonNegativeIntegerSchema,
    startSequence: nonNegativeIntegerSchema,
    endSequence: nonNegativeIntegerSchema,
    startTurn: nonNegativeIntegerSchema,
    endTurn: nonNegativeIntegerSchema,
    presentationOffsetMs: nonNegativeIntegerSchema,
    previousChunkHash: sha256Schema.nullable(),
    payloadHash: sha256Schema,
    chunkHash: sha256Schema,
    byteLength: nonNegativeIntegerSchema,
    terminal: z.boolean(),
    releasedAt: canonicalTimestampSchema,
    provenance: provenanceSchema,
    records: z.array(releasedRecordSchema).min(1).max(100_000),
  })
  .strict();

const leakForbiddenTextSchema = z
  .array(displayTextSchema(512).min(4))
  .min(2)
  .max(128);
const leakStatusExpectationSchema = z
  .object({
    kind: z.literal("status"),
    allowedHttpStatuses: z.array(z.number().int().min(100).max(599)).min(1),
    forbiddenText: leakForbiddenTextSchema,
  })
  .strict();
const leakBodyExpectationSchema = z
  .object({
    kind: z.literal("body_absent"),
    requiredHttpStatus: z.number().int().min(100).max(599),
    forbiddenText: leakForbiddenTextSchema,
  })
  .strict();
const leakCacheExpectationSchema = z
  .object({
    kind: z.literal("not_cached"),
    allowedHttpStatuses: z.array(z.number().int().min(100).max(599)).min(1),
    forbiddenText: leakForbiddenTextSchema,
  })
  .strict();
const leakStructuredExpectationSchema = z
  .object({
    kind: z.literal("structured_absent"),
    requiredHttpStatus: z.number().int().min(100).max(599),
    forbiddenText: leakForbiddenTextSchema,
  })
  .strict();
const leakExpectationSchema = z.discriminatedUnion("kind", [
  leakStatusExpectationSchema,
  leakBodyExpectationSchema,
  leakCacheExpectationSchema,
  leakStructuredExpectationSchema,
]);
const leakTargetSchema = z
  .object({
    checkId: safeTokenSchema,
    surface: z.enum([
      "league_page",
      "league_data",
      "battle_card",
      "public_replay_allowlist",
      "public_artifact_allowlist",
      "game_record_route",
      "match_summary_route",
      "result_route",
      "decision_tail_route",
      "diagnostics_route",
      "social_metadata",
      "direct_source_watch_route",
      "browser_or_cdn_cache",
      "alternate_source_url",
    ]),
    target: displayTextSchema(2_048),
    method: z.enum(["GET", "HEAD"]),
    expectation: leakExpectationSchema,
  })
  .strict();
const leakManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifestId: opaqueIdSchema,
    sourceRunId: opaqueIdSchema,
    createdAt: canonicalTimestampSchema,
    targets: z.array(leakTargetSchema).min(1).max(256),
  })
  .strict();
const leakEvidenceSchema = z
  .object({
    checkId: opaqueIdSchema,
    target: displayTextSchema(2_048),
    method: z.enum(["GET", "HEAD"]),
    observedHttpStatus: z.number().int().min(100).max(599).nullable(),
    observedContentHash: sha256Schema.nullable(),
    // The admission collector bounds each body before it enters the reveal.
    // Keep the browser contract aligned by relying on the controller's
    // response-byte and JSON-complexity ceilings instead of a divergent
    // JavaScript character-count limit.
    observedBodyText: z.string().nullable(),
    observedHeaders: z
      .object({
        age: z.string().max(256).nullable(),
        cacheControl: z.string().max(512).nullable(),
        cdnCacheStatus: z.string().max(256).nullable(),
      })
      .strict(),
    checkedAt: canonicalTimestampSchema,
    checkerVersion: safeTokenSchema,
  })
  .strict();
const embargoEvidenceSchema = z
  .object({
    source: displayTextSchema(),
    scope: displayTextSchema(),
    observedAt: canonicalTimestampSchema,
    verifier: displayTextSchema(),
    embargoConfirmed: z.boolean(),
  })
  .strict();
const authoritativeResultSchema = z
  .object({
    sourceKind: z.enum(["controlled_result", "coworld_result"]),
    sourceId: opaqueIdSchema,
    resultHash: sha256Schema,
  })
  .strict();

const authoritativeResultEnvelopeSchema = z
  .object({
    encoding: z.literal("canonical_json_utf8_base64"),
    bytes: z.string().regex(BASE64_PATTERN),
    sha256: sha256Schema,
  })
  .strict();

const canonicalAuthoritativeResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceKind: z.enum(["controlled_result", "coworld_result"]),
    sourceRunId: opaqueIdSchema,
    sourceId: opaqueIdSchema,
    gameId: z.string().min(1).max(128),
    completedAt: canonicalTimestampSchema,
    turnCount: z.number().int().positive().safe(),
    winner: z.array(z.string()).min(2).max(66).nullable(),
    seats: z
      .array(
        z
          .object({
            seatId: opaqueIdSchema,
            displayName: displayTextSchema(),
            won: z.boolean(),
          })
          .strict(),
      )
      .min(2)
      .max(64),
  })
  .strict();
const eligibilityRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    eligibilityCheckVersion: safeTokenSchema,
    createdAt: canonicalTimestampSchema,
    sourceKind: z.enum(["controlled_exhibition", "rated_coworld"]),
    sourceRunId: opaqueIdSchema,
    coworld: coworldIdsSchema.nullable(),
    sourceReplaySha256: sha256Schema,
    sourceBundleOutsideServedRoots: z.literal(true),
    proxyWarLeakAuditManifest: leakManifestSchema,
    proxyWarLeakChecks: z.array(leakEvidenceSchema).min(1).max(512),
    externalEmbargoEvidence: z.array(embargoEvidenceSchema).max(128),
    externalOutcomeMayBePublic: z.boolean(),
    seats: z.array(seatIdentitySchema).min(2).max(64),
    authoritativeResult: authoritativeResultSchema,
    publicLabel: z.enum(["premiere", "spoiler_resistant_premiere"]),
  })
  .strict();

const revealSchema = z
  .object({
    schemaVersion: z.literal(1),
    premiereId: premiereIdSchema,
    state: z.literal("revealed"),
    eligibilityRecord: eligibilityRecordSchema,
    eligibilityCommitmentNonce: z.string().regex(BASE64URL_PATTERN),
    eligibilityRecordHash: sha256Schema,
    publicationCommitmentHash: sha256Schema,
    publicationCommitment: publicationCommitmentSchema,
    sourceReplaySha256: sha256Schema,
    resultHash: sha256Schema,
    authoritativeResult: authoritativeResultEnvelopeSchema,
    publicationDraftManifest: z
      .array(frozenDraftDescriptorSchema)
      .min(1)
      .max(100_000),
    finalSequence: nonNegativeIntegerSchema,
    finalChunkIndex: nonNegativeIntegerSchema,
    finalChunkHash: sha256Schema,
    revealedAt: canonicalTimestampSchema,
    revealCommitHash: sha256Schema,
    provenance: provenanceSchema,
    integrityScope: z
      .object({
        publicationCommitment: z.literal("reveal_verifiable"),
        sourceReplay: z.literal("declared_hash_only"),
        authoritativeResult: z.literal("included_hash_verifiable"),
      })
      .strict(),
  })
  .strict();

export type ReplayPremiereProvenance = z.infer<typeof provenanceSchema>;
export type ReplayPremiereChunkDescriptor = z.infer<
  typeof releasedChunkDescriptorSchema
>;
export type ReplayPremierePreRevealManifest = z.infer<
  typeof preRevealManifestSchema
>;
export type ReplayPremiereRevealPointer = z.infer<typeof revealPointerSchema>;
export type ReplayPremiereManifest =
  | ReplayPremierePreRevealManifest
  | ReplayPremiereRevealPointer;
export type ReplayPremiereEligibilityRecord = z.infer<
  typeof eligibilityRecordSchema
>;
export type ReplayPremierePublicationCommitment = z.infer<
  typeof publicationCommitmentSchema
>;
export type ReplayPremierePublicDefinition = z.infer<
  typeof publicDefinitionSchema
>;
export type ReplayPremiereFrozenDraftDescriptor = z.infer<
  typeof frozenDraftDescriptorSchema
>;
export type ReplayPremiereCanonicalAuthoritativeResult = z.infer<
  typeof canonicalAuthoritativeResultSchema
>;
export type ReplayPremiereRevealWire = z.infer<typeof revealSchema>;
export type ReplayPremiereReveal = ReplayPremiereRevealWire & {
  verifiedAuthoritativeResult: ReplayPremiereCanonicalAuthoritativeResult;
};

export interface ReplayPremiereBootstrap {
  schemaVersion: 1;
  premiereId: string;
  gameStartInfo: GameStartInfo;
  gameStartInfoHash: string;
  publicDefinition: ReplayPremierePublicDefinition;
  publicationCommitmentHash: string;
  provenance: ReplayPremiereProvenance;
  integrityScope: z.infer<typeof bootstrapSchema>["integrityScope"];
}

export interface ReplayPremiereReadyProjection {
  premiereId: string;
  gameStartInfo: GameStartInfo;
  gameStartInfoHash: string;
  /** Bootstrap-verified, spoiler-neutral, and immutable for this premiere. */
  publicDefinition: Readonly<ReplayPremierePublicDefinition>;
  playbackRate: 1 | 2 | 4;
  state: ReplayPremierePreRevealManifest["state"] | "revealed" | "archived";
  scheduledAt: string | null;
  actualStartAt: string | null;
  provenance: ReplayPremiereProvenance;
}

export interface ReplayPremiereRecoveryNotice {
  code: "request_failed" | "response_unavailable";
  attempt: number;
  retryInMs: number;
}

export interface ReplayPremiereNetworkCallbacks {
  onReady: (
    projection: Readonly<ReplayPremiereReadyProjection>,
  ) => void | Promise<void>;
  onManifest?: (
    manifest: Readonly<ReplayPremiereManifest>,
  ) => void | Promise<void>;
  onReveal?: (reveal: Readonly<ReplayPremiereReveal>) => void | Promise<void>;
  onTerminal?: (
    state: "failed" | "cancelled" | "revealed" | "archived",
  ) => void | Promise<void>;
  onRecovering?: (
    notice: Readonly<ReplayPremiereRecoveryNotice>,
  ) => void | Promise<void>;
  onFatalError?: (
    error: Readonly<ReplayPremiereNetworkError>,
  ) => void | Promise<void>;
}

export interface ReplayPremiereNetworkOptions {
  premiereId: string;
  playback: ReplayPremierePlaybackController;
  callbacks: ReplayPremiereNetworkCallbacks;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  initialRetryMs?: number;
  maxRetryMs?: number;
  catchUpThresholdMs?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
}

export type ReplayPremiereSyncResult =
  | { status: "active"; manifest: ReplayPremierePreRevealManifest }
  | {
      status: "failed" | "cancelled";
      manifest: ReplayPremierePreRevealManifest;
    }
  | { status: "revealed" | "archived"; reveal: ReplayPremiereReveal };

interface JsonFetchOptions {
  noStoreRequired: boolean;
  maxBytes: number;
}

/**
 * Browser-side integrity and polling boundary for progressive Premiere replay.
 * It has no API for arbitrary URLs and cannot load ordinary replay artifacts.
 */
export class ReplayPremiereNetworkController {
  private readonly fetchImpl: typeof fetch;
  private readonly abortController = new AbortController();
  // Advertisements remain immutable across retries, but only descriptors whose
  // chunks reached playback may participate in accepted-prefix verification.
  private readonly advertisedDescriptors = new Map<
    number,
    Readonly<ReplayPremiereChunkDescriptor>
  >();
  private readonly acceptedDescriptors = new Map<
    number,
    Readonly<ReplayPremiereChunkDescriptor>
  >();
  private readonly presentationOffsets = new Map<number, number>();
  private readonly pollIntervalMs: number;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly catchUpThresholdMs: number;
  private readonly maxResponseBytes: number;
  private readonly requestTimeoutMs: number;

  private bootstrap: Readonly<ReplayPremiereBootstrap> | null = null;
  private lastManifest: Readonly<ReplayPremierePreRevealManifest> | null = null;
  private readyProjection: Readonly<ReplayPremiereReadyProjection> | null =
    null;
  private revealed: Readonly<ReplayPremiereReveal> | null = null;
  private lastCatchUpTarget: number | null = null;
  private syncPromise: Promise<ReplayPremiereSyncResult> | null = null;
  private runPromise: Promise<ReplayPremiereSyncResult> | null = null;
  private disposed = false;

  constructor(private readonly options: ReplayPremiereNetworkOptions) {
    if (
      !PREMIERE_ID_PATTERN.test(options.premiereId) ||
      options.playback.premiereId !== options.premiereId ||
      typeof options.callbacks?.onReady !== "function"
    ) {
      throw networkError("invalid_configuration");
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.pollIntervalMs = positiveIntegerOrDefault(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
    );
    this.initialRetryMs = positiveIntegerOrDefault(
      options.initialRetryMs,
      DEFAULT_INITIAL_RETRY_MS,
    );
    this.maxRetryMs = positiveIntegerOrDefault(
      options.maxRetryMs,
      DEFAULT_MAX_RETRY_MS,
    );
    this.catchUpThresholdMs = positiveIntegerOrDefault(
      options.catchUpThresholdMs,
      DEFAULT_CATCH_UP_THRESHOLD_MS,
    );
    this.maxResponseBytes = positiveIntegerOrDefault(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.requestTimeoutMs = positiveIntegerOrDefault(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    if (
      this.maxRetryMs > DEFAULT_MAX_RETRY_MS ||
      this.initialRetryMs > this.maxRetryMs ||
      this.requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw networkError("invalid_configuration");
    }
  }

  public start(): Promise<ReplayPremiereSyncResult> {
    this.assertActive();
    this.runPromise ??= this.runLoop();
    return this.runPromise;
  }

  public syncOnce(): Promise<ReplayPremiereSyncResult> {
    this.assertActive();
    this.syncPromise ??= this.performSync().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  private async runLoop(): Promise<ReplayPremiereSyncResult> {
    let retryMs = this.initialRetryMs;
    let attempt = 0;
    while (true) {
      this.assertActive();
      try {
        const result = await this.syncOnce();
        attempt = 0;
        retryMs = this.initialRetryMs;
        if (result.status !== "active") return result;
        await abortableDelay(this.pollIntervalMs, this.abortController.signal);
      } catch (error) {
        if (this.disposed || isAbortError(error)) {
          throw networkError("disposed");
        }
        const safeError = normalizeNetworkError(error);
        if (!safeError.recoverable) {
          await this.invokeCallback(
            this.options.callbacks.onFatalError,
            safeError,
          );
          throw safeError;
        }
        attempt += 1;
        const notice: ReplayPremiereRecoveryNotice = {
          code: safeError.code as ReplayPremiereRecoveryNotice["code"],
          attempt,
          retryInMs: retryMs,
        };
        await this.invokeCallback(this.options.callbacks.onRecovering, notice);
        await abortableDelay(retryMs, this.abortController.signal);
        retryMs = Math.min(this.maxRetryMs, retryMs * 2);
      }
    }
  }

  private async performSync(): Promise<ReplayPremiereSyncResult> {
    const bootstrap = await this.loadBootstrap();
    const manifestValue = await this.fetchJson(this.manifestPath(), {
      noStoreRequired: true,
      maxBytes: this.maxResponseBytes,
    });
    assertNoOutcomeBearingFields(manifestValue);
    const manifest = parseManifest(manifestValue, this.options.premiereId);

    if (isReplayPremiereRevealPointer(manifest)) {
      this.assertProvenance(manifest.provenance);
      await this.invokeCallback(this.options.callbacks.onManifest, manifest);
      if (!this.readyProjection) {
        const projection = deepFreeze({
          premiereId: manifest.premiereId,
          gameStartInfo: bootstrap.gameStartInfo,
          gameStartInfoHash: bootstrap.gameStartInfoHash,
          publicDefinition: bootstrap.publicDefinition,
          playbackRate: bootstrap.publicDefinition.playbackRate,
          state: manifest.state,
          scheduledAt: bootstrap.publicDefinition.scheduledAt,
          actualStartAt: null,
          provenance: bootstrap.provenance,
        });
        await this.invokeCallback(this.options.callbacks.onReady, projection);
        this.readyProjection = projection;
      }
      const reveal = await this.completeReveal(manifest);
      await this.invokeCallback(
        this.options.callbacks.onTerminal,
        manifest.state,
      );
      return { status: manifest.state, reveal };
    }

    this.validateManifestProgression(manifest);
    await this.invokeCallback(this.options.callbacks.onManifest, manifest);
    if (!this.readyProjection) {
      const projection = deepFreeze({
        premiereId: manifest.premiereId,
        gameStartInfo: bootstrap.gameStartInfo,
        gameStartInfoHash: bootstrap.gameStartInfoHash,
        publicDefinition: bootstrap.publicDefinition,
        playbackRate: manifest.playbackRate,
        state: manifest.state,
        scheduledAt: manifest.scheduledAt,
        actualStartAt: manifest.actualStartAt,
        provenance: manifest.provenance,
      });
      await this.invokeCallback(this.options.callbacks.onReady, projection);
      this.readyProjection = projection;
    }

    await this.applyAdvertisedChunks(manifest);
    this.requestCatchUpIfBehind(manifest);
    this.lastManifest = deepFreeze(manifest);

    if (manifest.state === "failed" || manifest.state === "cancelled") {
      await this.invokeCallback(
        this.options.callbacks.onTerminal,
        manifest.state,
      );
      return { status: manifest.state, manifest };
    }
    return { status: "active", manifest };
  }

  private async loadBootstrap(): Promise<Readonly<ReplayPremiereBootstrap>> {
    if (this.bootstrap) return this.bootstrap;
    const value = await this.fetchJson(this.bootstrapPath(), {
      noStoreRequired: true,
      maxBytes: this.maxResponseBytes,
    });
    const parsed = bootstrapSchema.safeParse(value);
    if (!parsed.success || parsed.data.premiereId !== this.options.premiereId) {
      throw networkError("invalid_schema");
    }
    const gameStartInfo = parseStrictCoreValue(
      GameStartInfoSchema.strict(),
      parsed.data.gameStartInfo,
    );
    const computedHash = await hashCanonicalJson(gameStartInfo);
    if (computedHash !== parsed.data.gameStartInfoHash) {
      throw networkError("bootstrap_integrity_failure");
    }
    const bootstrap = deepFreeze({
      ...parsed.data,
      gameStartInfo,
    });
    await verifyBootstrapPublication(bootstrap);
    this.bootstrap = bootstrap;
    return this.bootstrap;
  }

  private validateManifestProgression(
    manifest: ReplayPremierePreRevealManifest,
  ): void {
    validatePreRevealManifest(manifest, this.options.premiereId);
    this.assertProvenance(manifest.provenance);
    if (
      !this.bootstrap ||
      manifest.playbackRate !== this.bootstrap.publicDefinition.playbackRate ||
      manifest.scheduledAt !== this.bootstrap.publicDefinition.scheduledAt ||
      (manifest.activeCheckpoint !== null &&
        !this.bootstrap.publicDefinition.checkpoints.some(
          (checkpoint) =>
            checkpoint.id === manifest.activeCheckpoint?.id &&
            checkpoint.sequence === manifest.activeCheckpoint.sequence,
        ))
    ) {
      throw networkError("manifest_integrity_failure");
    }
    if (!this.lastManifest) return;
    if (
      Date.parse(manifest.serverNow) <
        Date.parse(this.lastManifest.serverNow) ||
      manifest.authoritativeElapsedMs <
        this.lastManifest.authoritativeElapsedMs ||
      manifest.accumulatedPauseMs < this.lastManifest.accumulatedPauseMs ||
      manifest.releasedThroughSequence <
        this.lastManifest.releasedThroughSequence ||
      manifest.lastReleasedChunkIndex <
        this.lastManifest.lastReleasedChunkIndex ||
      !isAllowedManifestTransition(this.lastManifest.state, manifest.state)
    ) {
      throw networkError("manifest_regression");
    }
    if (
      this.lastManifest.actualStartAt !== null &&
      manifest.actualStartAt !== this.lastManifest.actualStartAt
    ) {
      throw networkError("manifest_integrity_failure");
    }
  }

  private async applyAdvertisedChunks(
    manifest: ReplayPremierePreRevealManifest,
  ): Promise<void> {
    for (const descriptor of manifest.releasedChunks) {
      const existing = this.advertisedDescriptors.get(descriptor.index);
      if (existing && !canonicalJsonEqual(existing, descriptor)) {
        throw networkError("manifest_integrity_failure");
      }
      if (!existing)
        this.advertisedDescriptors.set(
          descriptor.index,
          deepFreeze(descriptor),
        );
    }
    const initialPlaybackState = this.options.playback.state();
    let nextIndex = initialPlaybackState.nextChunkIndex;
    if (nextIndex > manifest.lastReleasedChunkIndex + 1) {
      throw networkError("manifest_integrity_failure");
    }
    if (nextIndex > 0) {
      const acceptedTail = this.acceptedDescriptors.get(nextIndex - 1);
      if (
        !acceptedTail ||
        acceptedTail.chunkHash !== initialPlaybackState.lastChunkHash ||
        acceptedTail.endSequence !==
          initialPlaybackState.releasedThroughSequence
      ) {
        throw networkError("manifest_integrity_failure");
      }
    }
    while (nextIndex <= manifest.lastReleasedChunkIndex) {
      const descriptor = this.advertisedDescriptors.get(nextIndex);
      if (!descriptor) throw networkError("chunk_not_advertised");
      const batch = await this.fetchAndVerifyChunk(descriptor, false);
      try {
        this.options.playback.appendVerifiedBatch(batch);
      } catch {
        throw networkError("chunk_integrity_failure");
      }
      this.acceptedDescriptors.set(nextIndex, descriptor);
      nextIndex += 1;
    }
  }

  private async fetchAndVerifyChunk(
    advertised: ReplayPremiereChunkDescriptor,
    afterReveal: boolean,
  ): Promise<VerifiedReplayPremiereBatch> {
    if (!afterReveal && !this.advertisedDescriptors.has(advertised.index)) {
      throw networkError("chunk_not_advertised");
    }
    const value = await this.fetchJson(this.chunkPath(advertised.index), {
      noStoreRequired: !afterReveal,
      maxBytes: this.maxResponseBytes,
    });
    if (!afterReveal) assertNoOutcomeBearingFields(value);
    const parsed = publicChunkSchema.safeParse(value);
    if (!parsed.success) throw networkError("invalid_schema");
    this.assertProvenance(parsed.data.provenance);
    const descriptor = descriptorFromChunk(parsed.data);
    if (!canonicalJsonEqual(descriptor, advertised)) {
      throw networkError("chunk_integrity_failure");
    }
    return this.verifyChunk(parsed.data, descriptor);
  }

  private async verifyChunk(
    chunk: z.infer<typeof publicChunkSchema>,
    descriptor: ReplayPremiereChunkDescriptor,
    maxPresentationSpanMs?: number,
  ): Promise<VerifiedReplayPremiereBatch> {
    if (chunk.premiereId !== this.options.premiereId) {
      throw networkError("chunk_integrity_failure");
    }
    const payload = { schemaVersion: 1 as const, records: chunk.records };
    const payloadBytes = canonicalJsonBytes(payload);
    if (
      payloadBytes.byteLength !== descriptor.byteLength ||
      (await sha256Hex(payloadBytes)) !== descriptor.payloadHash
    ) {
      throw networkError("chunk_integrity_failure");
    }
    const descriptorHash = await hashCanonicalJson(
      descriptorHashInput(descriptor),
    );
    if (descriptorHash !== descriptor.chunkHash) {
      throw networkError("chunk_integrity_failure");
    }

    const previousPlaybackState = this.options.playback.state();
    const expectedPreviousHash = previousPlaybackState.lastChunkHash;
    if (
      descriptor.index !== previousPlaybackState.nextChunkIndex ||
      descriptor.previousChunkHash !== expectedPreviousHash ||
      descriptor.startSequence !== previousPlaybackState.nextExpectedSequence ||
      descriptor.startTurn !== previousPlaybackState.nextExpectedTurnNumber
    ) {
      throw networkError("chunk_integrity_failure");
    }

    const presentationOffsets: Array<readonly [number, number]> = [];
    const records = chunk.records.map((record, offset) => {
      assertNoOutcomeBearingFields(record.payload);
      const turn = parseStrictCoreValue(TurnSchema.strict(), record.payload);
      const expectedSequence = descriptor.startSequence + offset;
      const expectedTurn = descriptor.startTurn + offset;
      if (
        record.sequence !== expectedSequence ||
        record.turn !== expectedTurn ||
        turn.turnNumber !== record.turn ||
        (offset > 0 &&
          record.presentationOffsetMs <
            chunk.records[offset - 1].presentationOffsetMs)
      ) {
        throw networkError("chunk_integrity_failure");
      }
      presentationOffsets.push([
        record.sequence,
        record.presentationOffsetMs,
      ] as const);
      return deepFreeze({
        sequence: record.sequence,
        presentationOffsetMs: record.presentationOffsetMs,
        turn,
      });
    });
    const last = chunk.records[chunk.records.length - 1];
    if (
      chunk.records[0].sequence !== descriptor.startSequence ||
      last.sequence !== descriptor.endSequence ||
      chunk.records[0].turn !== descriptor.startTurn ||
      last.turn !== descriptor.endTurn ||
      last.presentationOffsetMs !== descriptor.presentationOffsetMs ||
      (maxPresentationSpanMs !== undefined &&
        last.presentationOffsetMs - chunk.records[0].presentationOffsetMs >
          maxPresentationSpanMs)
    ) {
      throw networkError("chunk_integrity_failure");
    }
    for (const [sequence, presentationOffsetMs] of presentationOffsets) {
      this.presentationOffsets.set(sequence, presentationOffsetMs);
    }
    return deepFreeze({
      premiereId: descriptor.premiereId,
      chunkIndex: descriptor.index,
      chunkHash: descriptor.chunkHash,
      previousChunkHash: descriptor.previousChunkHash,
      payloadHash: descriptor.payloadHash,
      startSequence: descriptor.startSequence,
      endSequence: descriptor.endSequence,
      verification: {
        payloadHashVerified: true as const,
        chunkHashVerified: true as const,
      },
      records,
    });
  }

  private requestCatchUpIfBehind(
    manifest: ReplayPremierePreRevealManifest,
  ): void {
    const playbackState = this.options.playback.state();
    const target = playbackState.releasedThroughSequence;
    if (target === null) return;
    const dispatched = playbackState.lastDispatchedSequence;
    if (dispatched !== null && dispatched >= target) {
      this.lastCatchUpTarget = null;
      return;
    }
    const dispatchedOffset =
      dispatched === null ? 0 : (this.presentationOffsets.get(dispatched) ?? 0);
    if (
      manifest.authoritativeElapsedMs - dispatchedOffset <=
        this.catchUpThresholdMs ||
      this.lastCatchUpTarget === target
    ) {
      return;
    }
    try {
      this.options.playback.requestForwardCatchUp(target);
    } catch {
      throw networkError("manifest_integrity_failure");
    }
    this.lastCatchUpTarget = target;
  }

  private async completeReveal(
    pointer: ReplayPremiereRevealPointer,
  ): Promise<ReplayPremiereReveal> {
    const expectedRevealPath = this.revealPath();
    if (
      !this.bootstrap ||
      pointer.revealUrl !== expectedRevealPath ||
      (this.lastManifest !== null &&
        Date.parse(pointer.revealedAt) <
          Date.parse(this.lastManifest.serverNow)) ||
      this.lastManifest?.state === "failed" ||
      this.lastManifest?.state === "cancelled"
    ) {
      throw networkError("reveal_integrity_failure");
    }
    if (this.revealed) {
      if (this.revealed.revealCommitHash !== pointer.revealCommitHash) {
        throw networkError("reveal_integrity_failure");
      }
      return this.revealed;
    }
    const value = await this.fetchJson(expectedRevealPath, {
      noStoreRequired: false,
      maxBytes: this.maxResponseBytes,
    });
    const parsed = revealSchema.safeParse(value);
    if (!parsed.success || parsed.data.premiereId !== this.options.premiereId) {
      throw networkError("invalid_schema");
    }
    const reveal = parsed.data;
    if (
      reveal.revealedAt !== pointer.revealedAt ||
      reveal.revealCommitHash !== pointer.revealCommitHash ||
      !canonicalJsonEqual(reveal.provenance, pointer.provenance) ||
      (await hashCanonicalJson(revealCommitInput(reveal))) !==
        reveal.revealCommitHash
    ) {
      throw networkError("reveal_integrity_failure");
    }
    const nonce = decodeCanonicalBase64Url(reveal.eligibilityCommitmentNonce);
    const eligibilityCommitment = await hashEligibilityCommitment(
      reveal.eligibilityRecord,
      nonce,
    );
    if (
      eligibilityCommitment !== reveal.eligibilityRecordHash ||
      reveal.publicationCommitmentHash !==
        this.bootstrap.publicationCommitmentHash ||
      reveal.sourceReplaySha256 !==
        reveal.eligibilityRecord.sourceReplaySha256 ||
      reveal.resultHash !==
        reveal.eligibilityRecord.authoritativeResult.resultHash ||
      !canonicalJsonEqual(reveal.provenance, this.bootstrap.provenance)
    ) {
      throw networkError("reveal_integrity_failure");
    }
    const provenance = this.bootstrap.provenance;
    if (
      provenance.eligibilityRecordHash !== reveal.eligibilityRecordHash ||
      provenance.publicationCommitmentHash !==
        reveal.publicationCommitmentHash ||
      provenance.sourceReplaySha256 !== reveal.sourceReplaySha256 ||
      !eligibilityMatchesProvenance(reveal.eligibilityRecord, provenance)
    ) {
      throw networkError("reveal_integrity_failure");
    }

    const draftManifest = await verifyRevealedDraftManifest(
      reveal,
      this.bootstrap,
    );
    const acceptedChunkCount = this.options.playback.state().nextChunkIndex;
    for (let index = 0; index < acceptedChunkCount; index += 1) {
      const released = this.acceptedDescriptors.get(index);
      if (!released) throw networkError("reveal_integrity_failure");
      const draft = draftManifest.get(index);
      const startOffset = this.presentationOffsets.get(released.startSequence);
      const endOffset = this.presentationOffsets.get(released.endSequence);
      if (
        !draft ||
        !publishedDescriptorMatchesDraft(released, draft) ||
        startOffset === undefined ||
        endOffset === undefined ||
        endOffset - startOffset >
          reveal.publicationCommitment.maxPresentationSpanMs
      ) {
        throw networkError("reveal_integrity_failure");
      }
    }
    const authoritativeResult = await verifyReplayPremiereAuthoritativeResult(
      reveal,
      this.bootstrap,
    );

    await this.fetchRevealChain(reveal, draftManifest);
    const state = this.options.playback.state();
    if (
      state.nextChunkIndex !== reveal.finalChunkIndex + 1 ||
      state.releasedThroughSequence !== reveal.finalSequence ||
      state.lastChunkHash !== reveal.finalChunkHash
    ) {
      throw networkError("reveal_integrity_failure");
    }
    try {
      this.options.playback.finalize({
        premiereId: reveal.premiereId,
        finalSequence: reveal.finalSequence,
        finalChunkHash: reveal.finalChunkHash,
        revealedAt: Date.parse(reveal.revealedAt),
        verification: {
          releaseChainVerified: true,
          publicationCommitmentVerified: true,
          publicationDraftManifestVerified: true,
          provenanceVerified: true,
          eligibilityCommitmentVerified: true,
          sourceReplayIntegrityScope: "declared_hash_only",
          sourceReplayCommitmentMatched: true,
          authoritativeResultBytesVerified: true,
          resultCommitmentMatched: true,
          revealCommitmentVerified: true,
        },
      });
    } catch {
      throw networkError("reveal_integrity_failure");
    }
    this.revealed = deepFreeze({
      ...reveal,
      verifiedAuthoritativeResult: authoritativeResult,
    });
    await this.invokeCallback(this.options.callbacks.onReveal, this.revealed);
    return this.revealed;
  }

  private async fetchRevealChain(
    reveal: ReplayPremiereRevealWire,
    draftManifest: ReadonlyMap<
      number,
      Readonly<ReplayPremiereFrozenDraftDescriptor>
    >,
  ): Promise<void> {
    let nextIndex = this.options.playback.state().nextChunkIndex;
    if (nextIndex > reveal.finalChunkIndex) {
      throw networkError("reveal_integrity_failure");
    }
    while (nextIndex <= reveal.finalChunkIndex) {
      const value = await this.fetchJson(this.chunkPath(nextIndex), {
        noStoreRequired: false,
        maxBytes: this.maxResponseBytes,
      });
      const parsed = publicChunkSchema.safeParse(value);
      if (!parsed.success) throw networkError("invalid_schema");
      this.assertProvenance(parsed.data.provenance);
      const descriptor = descriptorFromChunk(parsed.data);
      const draft = draftManifest.get(nextIndex);
      const advertised = this.advertisedDescriptors.get(nextIndex);
      if (
        !draft ||
        (advertised !== undefined &&
          !canonicalJsonEqual(advertised, descriptor)) ||
        !publishedDescriptorMatchesDraft(descriptor, draft) ||
        descriptor.index !== nextIndex ||
        descriptor.terminal !== (nextIndex === reveal.finalChunkIndex) ||
        (nextIndex === reveal.finalChunkIndex &&
          (descriptor.chunkHash !== reveal.finalChunkHash ||
            descriptor.endSequence !== reveal.finalSequence))
      ) {
        throw networkError("reveal_integrity_failure");
      }
      const batch = await this.verifyChunk(
        parsed.data,
        descriptor,
        reveal.publicationCommitment.maxPresentationSpanMs,
      );
      try {
        this.options.playback.appendVerifiedBatch(batch);
      } catch {
        throw networkError("reveal_integrity_failure");
      }
      const accepted = deepFreeze(descriptor);
      this.advertisedDescriptors.set(nextIndex, accepted);
      this.acceptedDescriptors.set(nextIndex, accepted);
      nextIndex += 1;
    }
    if (
      this.advertisedDescriptors.size >
        reveal.publicationCommitment.chunkCount ||
      this.acceptedDescriptors.size !==
        reveal.publicationCommitment.chunkCount ||
      [...draftManifest].some(([index, draft]) => {
        const released = this.acceptedDescriptors.get(index);
        return !released || !publishedDescriptorMatchesDraft(released, draft);
      })
    ) {
      throw networkError("reveal_integrity_failure");
    }
  }

  private async fetchJson(
    pathname: string,
    options: JsonFetchOptions,
  ): Promise<unknown> {
    this.assertActive();
    const requestController = new AbortController();
    const abortFromController = (): void => requestController.abort();
    this.abortController.signal.addEventListener("abort", abortFromController, {
      once: true,
    });
    let rejectTimedOut: ((reason: ReplayPremiereNetworkError) => void) | null =
      null;
    const timedOut = new Promise<never>((_resolve, reject) => {
      rejectTimedOut = reject;
    });
    const timeout = setTimeout(() => {
      requestController.abort();
      rejectTimedOut?.(networkError("request_failed", true));
    }, this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(pathname, {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
            credentials: "same-origin",
            redirect: "error",
            signal: requestController.signal,
          }),
          timedOut,
        ]);
      } catch (error) {
        if (this.disposed) throw networkError("disposed");
        throw networkError("request_failed", true);
      }
      if (!response.ok) {
        throw networkError(
          "response_unavailable",
          response.status === 408 ||
            response.status === 425 ||
            response.status === 429 ||
            response.status >= 500,
        );
      }
      if (
        options.noStoreRequired &&
        !hasNoStoreDirective(response.headers.get("cache-control"))
      ) {
        throw networkError("invalid_cache_policy");
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!JSON_CONTENT_TYPE_PATTERN.test(contentType.trim())) {
        throw networkError("invalid_content_type");
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > options.maxBytes
      ) {
        throw networkError("response_too_large");
      }
      let text: string;
      try {
        text = await readResponseTextWithinLimit(
          response,
          options.maxBytes,
          requestController.signal,
        );
      } catch (error) {
        if (error instanceof ReplayPremiereNetworkError) throw error;
        if (this.disposed) throw networkError("disposed");
        throw networkError("request_failed", true);
      }
      try {
        const value: unknown = JSON.parse(text);
        canonicalReplayPremiereJson(value);
        return value;
      } catch (error) {
        if (error instanceof ReplayPremiereNetworkError) throw error;
        throw networkError("invalid_json");
      }
    } finally {
      clearTimeout(timeout);
      this.abortController.signal.removeEventListener(
        "abort",
        abortFromController,
      );
    }
  }

  private bootstrapPath(): string {
    return `/api/premieres/${this.options.premiereId}/bootstrap`;
  }

  private manifestPath(): string {
    return `/api/premieres/${this.options.premiereId}/manifest`;
  }

  private chunkPath(index: number): string {
    return `/api/premieres/${this.options.premiereId}/chunks/${index}`;
  }

  private revealPath(): string {
    return `/api/premieres/${this.options.premiereId}/reveal`;
  }

  private assertProvenance(provenance: ReplayPremiereProvenance): void {
    if (
      !this.bootstrap ||
      !canonicalJsonEqual(provenance, this.bootstrap.provenance)
    ) {
      throw networkError("manifest_integrity_failure");
    }
  }

  private async invokeCallback<T>(
    callback: ((value: T) => void | Promise<void>) | undefined,
    value: T,
  ): Promise<void> {
    if (!callback) return;
    try {
      await callback(value);
    } catch {
      throw networkError("callback_failure");
    }
  }

  private assertActive(): void {
    if (this.disposed) throw networkError("disposed");
  }
}

async function readResponseTextWithinLimit(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const decodedChunks: string[] = [];
  let receivedBytes = 0;
  let rejectAborted: ((reason: DOMException) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
    rejectAborted?.(new DOMException("aborted", "AbortError"));
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal.aborted) onAbort();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw networkError("response_too_large");
      }
      decodedChunks.push(decoder.decode(value, { stream: true }));
    }
    decodedChunks.push(decoder.decode());
    return decodedChunks.join("");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function canonicalReplayPremiereJson(value: unknown): string {
  return canonicalize(value, 0, { nodes: 0 });
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalReplayPremiereJson(value));
}

export async function hashCanonicalJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalJsonBytes(value));
}

export async function sha256Hex(value: Uint8Array): Promise<string> {
  const bytes = value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function canonicalize(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): string {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw networkError("invalid_json");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw networkError("invalid_json");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => canonicalize(entry, depth + 1, budget))
      .join(",")}]`;
  }
  if (typeof value !== "object") throw networkError("invalid_json");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw networkError("invalid_json");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize(record[key], depth + 1, budget)}`,
    )
    .join(",")}}`;
}

function parseManifest(
  value: unknown,
  expectedPremiereId: string,
): ReplayPremiereManifest {
  const pointer = revealPointerSchema.safeParse(value);
  if (pointer.success) {
    if (pointer.data.premiereId !== expectedPremiereId) {
      throw networkError("invalid_schema");
    }
    return deepFreeze(pointer.data);
  }
  const manifest = preRevealManifestSchema.safeParse(value);
  if (!manifest.success || manifest.data.premiereId !== expectedPremiereId) {
    throw networkError("invalid_schema");
  }
  return deepFreeze(manifest.data);
}

function isReplayPremiereRevealPointer(
  manifest: ReplayPremiereManifest,
): manifest is ReplayPremiereRevealPointer {
  return manifest.state === "revealed" || manifest.state === "archived";
}

function validatePreRevealManifest(
  manifest: ReplayPremierePreRevealManifest,
  premiereId: string,
): void {
  if (
    manifest.premiereId !== premiereId ||
    new Set(manifest.provenance.seats.map((seat) => seat.seatId)).size !==
      manifest.provenance.seats.length
  ) {
    throw networkError("manifest_integrity_failure");
  }
  const requiresStart =
    manifest.state === "playing" ||
    manifest.state === "checkpoint" ||
    manifest.state === "failed";
  if (
    (manifest.state === "scheduled" &&
      (manifest.actualStartAt !== null ||
        manifest.authoritativeElapsedMs !== 0 ||
        manifest.releasedThroughSequence !== -1 ||
        manifest.lastReleasedChunkIndex !== -1 ||
        manifest.releasedChunks.length !== 0)) ||
    (requiresStart && manifest.actualStartAt === null) ||
    (manifest.state === "cancelled" && manifest.actualStartAt !== null) ||
    (manifest.state === "checkpoint") !== (manifest.activeCheckpoint !== null)
  ) {
    throw networkError("manifest_integrity_failure");
  }
  if (manifest.actualStartAt !== null) {
    const wallElapsed =
      Date.parse(manifest.serverNow) - Date.parse(manifest.actualStartAt);
    if (
      wallElapsed < 0 ||
      manifest.authoritativeElapsedMs > wallElapsed ||
      manifest.accumulatedPauseMs > wallElapsed
    ) {
      throw networkError("manifest_integrity_failure");
    }
  }
  if (manifest.activeCheckpoint) {
    const checkpoint = manifest.activeCheckpoint;
    const optionSeats = new Set(checkpoint.optionSeatIds);
    const knownSeats = new Set(
      manifest.provenance.seats.map((seat) => seat.seatId),
    );
    if (
      Date.parse(checkpoint.opensAt) >= Date.parse(checkpoint.closesAt) ||
      optionSeats.size !== checkpoint.optionSeatIds.length ||
      checkpoint.optionSeatIds.some((seat) => !knownSeats.has(seat)) ||
      checkpoint.sequence > manifest.releasedThroughSequence
    ) {
      throw networkError("manifest_integrity_failure");
    }
  }

  if (
    manifest.releasedChunks.length !== manifest.lastReleasedChunkIndex + 1 ||
    (manifest.releasedChunks.length === 0
      ? manifest.releasedThroughSequence !== -1
      : manifest.releasedChunks[manifest.releasedChunks.length - 1]
          .endSequence !== manifest.releasedThroughSequence)
  ) {
    throw networkError("manifest_integrity_failure");
  }
  let previous: ReplayPremiereChunkDescriptor | null = null;
  for (const descriptor of manifest.releasedChunks) {
    if (
      descriptor.premiereId !== premiereId ||
      descriptor.terminal ||
      descriptor.endSequence < descriptor.startSequence ||
      descriptor.endTurn < descriptor.startTurn ||
      descriptor.endSequence - descriptor.startSequence !==
        descriptor.endTurn - descriptor.startTurn ||
      (previous === null
        ? descriptor.index !== 0 ||
          descriptor.startSequence !== 0 ||
          descriptor.startTurn !== 0 ||
          descriptor.previousChunkHash !== null
        : descriptor.index !== previous.index + 1 ||
          descriptor.startSequence !== previous.endSequence + 1 ||
          descriptor.startTurn !== previous.endTurn + 1 ||
          descriptor.presentationOffsetMs < previous.presentationOffsetMs ||
          descriptor.previousChunkHash !== previous.chunkHash)
    ) {
      throw networkError("manifest_integrity_failure");
    }
    previous = descriptor;
  }
}

function descriptorFromChunk(
  chunk: z.infer<typeof publicChunkSchema>,
): ReplayPremiereChunkDescriptor {
  return {
    premiereId: chunk.premiereId,
    index: chunk.index,
    startSequence: chunk.startSequence,
    endSequence: chunk.endSequence,
    startTurn: chunk.startTurn,
    endTurn: chunk.endTurn,
    presentationOffsetMs: chunk.presentationOffsetMs,
    previousChunkHash: chunk.previousChunkHash,
    payloadHash: chunk.payloadHash,
    chunkHash: chunk.chunkHash,
    byteLength: chunk.byteLength,
    terminal: chunk.terminal,
    releasedAt: chunk.releasedAt,
  };
}

function descriptorHashInput(
  descriptor: ReplayPremiereChunkDescriptor,
): Record<string, unknown> {
  return {
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
}

function prepublicationHashInput(
  descriptor: ReplayPremiereFrozenDraftDescriptor,
): Record<string, unknown> {
  return {
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
}

function revealCommitInput(
  reveal: ReplayPremiereRevealWire,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    premiereId: reveal.premiereId,
    eligibilityRecordHash: reveal.eligibilityRecordHash,
    publicationCommitmentHash: reveal.publicationCommitmentHash,
    publicationCommitment: reveal.publicationCommitment,
    sourceReplaySha256: reveal.sourceReplaySha256,
    resultHash: reveal.resultHash,
    authoritativeResult: reveal.authoritativeResult,
    publicationDraftManifest: reveal.publicationDraftManifest,
    finalSequence: reveal.finalSequence,
    finalChunkIndex: reveal.finalChunkIndex,
    finalChunkHash: reveal.finalChunkHash,
    revealedAt: reveal.revealedAt,
  };
}

async function verifyBootstrapPublication(
  bootstrap: Readonly<ReplayPremiereBootstrap>,
): Promise<void> {
  const definition = bootstrap.publicDefinition;
  const {
    publicationCommitmentHash: _provenanceCommitmentHash,
    ...baseProvenance
  } = bootstrap.provenance;
  const checkpointSequences = definition.checkpoints.map(
    (checkpoint) => checkpoint.sequence,
  );
  assertNoOutcomeBearingFields(bootstrap.gameStartInfo);
  assertNoOutcomeBearingFields(definition);
  if (
    bootstrap.provenance.publicationCommitmentHash !==
      bootstrap.publicationCommitmentHash ||
    !canonicalJsonEqual(definition.provenance, baseProvenance) ||
    definition.scheduledAt.trim() !== definition.scheduledAt ||
    definition.title.trim() !== definition.title ||
    definition.spoilerNeutralDescription.trim() !==
      definition.spoilerNeutralDescription ||
    definition.map.label.trim() !== definition.map.label ||
    definition.matchFormat.label.trim() !== definition.matchFormat.label ||
    definition.map.id !== String(bootstrap.gameStartInfo.config.gameMap) ||
    definition.matchFormat.seatCount !== bootstrap.provenance.seats.length ||
    definition.matchFormat.seatCount !==
      bootstrap.gameStartInfo.players.length ||
    new Set(bootstrap.provenance.seats.map((seat) => seat.seatId)).size !==
      bootstrap.provenance.seats.length ||
    definition.checkpoints[0].id === definition.checkpoints[1].id ||
    checkpointSequences[0] >= checkpointSequences[1]
  ) {
    throw networkError("bootstrap_integrity_failure");
  }
}

async function verifyRevealedDraftManifest(
  reveal: ReplayPremiereRevealWire,
  bootstrap: Readonly<ReplayPremiereBootstrap>,
): Promise<ReadonlyMap<number, Readonly<ReplayPremiereFrozenDraftDescriptor>>> {
  const commitment = reveal.publicationCommitment;
  const descriptors = reveal.publicationDraftManifest;
  const { publicationCommitmentHash: _hash, ...commitmentPreimage } =
    commitment;
  if (
    (await hashCanonicalJson(commitmentPreimage)) !==
      commitment.publicationCommitmentHash ||
    commitment.publicationCommitmentHash !==
      bootstrap.publicationCommitmentHash ||
    reveal.publicationCommitmentHash !== bootstrap.publicationCommitmentHash ||
    commitment.premiereId !== bootstrap.premiereId ||
    commitment.eligibilityRecordHash !==
      bootstrap.provenance.eligibilityRecordHash ||
    commitment.sourceRunId !== bootstrap.provenance.sourceRunId ||
    commitment.sourceReplaySha256 !== bootstrap.provenance.sourceReplaySha256 ||
    commitment.gameStartInfoHash !== bootstrap.gameStartInfoHash ||
    commitment.publicDefinitionHash !==
      (await hashCanonicalJson(bootstrap.publicDefinition)) ||
    commitment.playbackRate !== bootstrap.publicDefinition.playbackRate ||
    !canonicalJsonEqual(
      commitment.checkpoints,
      bootstrap.publicDefinition.checkpoints,
    ) ||
    commitment.checkpoints[1].sequence >= commitment.finalSequence ||
    commitment.chunkCount < 3 ||
    descriptors.length !== commitment.chunkCount ||
    reveal.finalChunkIndex !== commitment.chunkCount - 1 ||
    reveal.finalSequence !== commitment.finalSequence
  ) {
    throw networkError("reveal_integrity_failure");
  }
  let previous: ReplayPremiereFrozenDraftDescriptor | null = null;
  const byIndex = new Map<
    number,
    Readonly<ReplayPremiereFrozenDraftDescriptor>
  >();
  for (const descriptor of descriptors) {
    const isLast = descriptor.index === descriptors.length - 1;
    if (
      descriptor.premiereId !== reveal.premiereId ||
      descriptor.index !== byIndex.size ||
      descriptor.terminal !== isLast ||
      descriptor.endSequence < descriptor.startSequence ||
      descriptor.endTurn < descriptor.startTurn ||
      descriptor.endSequence - descriptor.startSequence !==
        descriptor.endTurn - descriptor.startTurn ||
      (await hashCanonicalJson(prepublicationHashInput(descriptor))) !==
        descriptor.prepublicationHash ||
      (previous === null
        ? descriptor.startSequence !== 0 ||
          descriptor.startTurn !== 0 ||
          descriptor.previousPrepublicationHash !== null
        : descriptor.startSequence !== previous.endSequence + 1 ||
          descriptor.startTurn !== previous.endTurn + 1 ||
          descriptor.presentationOffsetMs < previous.presentationOffsetMs ||
          descriptor.previousPrepublicationHash !== previous.prepublicationHash)
    ) {
      throw networkError("reveal_integrity_failure");
    }
    byIndex.set(descriptor.index, deepFreeze(descriptor));
    previous = descriptor;
  }
  const terminal = descriptors.at(-1);
  const checkpointBoundaries = new Set(
    descriptors.slice(0, -1).map((descriptor) => descriptor.endSequence),
  );
  if (
    !terminal ||
    terminal.endSequence !== commitment.finalSequence ||
    terminal.prepublicationHash !== commitment.terminalPrepublicationRoot ||
    commitment.checkpoints.some(
      (checkpoint) => !checkpointBoundaries.has(checkpoint.sequence),
    ) ||
    (await hashCanonicalJson({
      schemaVersion: 1,
      premiereId: reveal.premiereId,
      chunks: descriptors,
    })) !== commitment.orderedDraftManifestRoot
  ) {
    throw networkError("reveal_integrity_failure");
  }
  return byIndex;
}

function publishedDescriptorMatchesDraft(
  released: ReplayPremiereChunkDescriptor,
  draft: ReplayPremiereFrozenDraftDescriptor,
): boolean {
  return (
    released.premiereId === draft.premiereId &&
    released.index === draft.index &&
    released.startSequence === draft.startSequence &&
    released.endSequence === draft.endSequence &&
    released.startTurn === draft.startTurn &&
    released.endTurn === draft.endTurn &&
    released.presentationOffsetMs === draft.presentationOffsetMs &&
    released.payloadHash === draft.payloadHash &&
    released.byteLength === draft.byteLength &&
    released.terminal === draft.terminal
  );
}

export async function verifyReplayPremiereAuthoritativeResult(
  reveal: ReplayPremiereRevealWire,
  bootstrap: Readonly<ReplayPremiereBootstrap>,
): Promise<ReplayPremiereCanonicalAuthoritativeResult> {
  const bytes = decodeCanonicalBase64(reveal.authoritativeResult.bytes);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_AUTHORITATIVE_RESULT_BYTES ||
    (await sha256Hex(bytes)) !== reveal.authoritativeResult.sha256 ||
    reveal.authoritativeResult.sha256 !== reveal.resultHash ||
    reveal.resultHash !==
      reveal.eligibilityRecord.authoritativeResult.resultHash
  ) {
    throw networkError("reveal_integrity_failure");
  }
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw networkError("reveal_integrity_failure");
  }
  if (canonicalReplayPremiereJson(value) !== text) {
    throw networkError("reveal_integrity_failure");
  }
  const parsed = canonicalAuthoritativeResultSchema.safeParse(value);
  if (!parsed.success) throw networkError("reveal_integrity_failure");
  const result = parsed.data;
  const eligibility = reveal.eligibilityRecord;
  const expectedSeats = new Map(
    eligibility.seats.map((seat) => [seat.seatId, seat.displayName]),
  );
  const actualSeatIds = new Set<string>();
  for (const seat of result.seats) {
    if (
      actualSeatIds.has(seat.seatId) ||
      expectedSeats.get(seat.seatId) !== seat.displayName
    ) {
      throw networkError("reveal_integrity_failure");
    }
    actualSeatIds.add(seat.seatId);
  }
  let winnerSeatIds: string[] = [];
  if (result.winner !== null) {
    const [kind] = result.winner;
    if (
      (kind !== "player" && kind !== "team" && kind !== "nation") ||
      ((kind === "team" || kind === "nation") && result.winner.length < 3)
    ) {
      throw networkError("reveal_integrity_failure");
    }
    winnerSeatIds = result.winner.slice(kind === "player" ? 1 : 2);
  }
  const winners = new Set(winnerSeatIds);
  if (
    result.sourceKind !== eligibility.authoritativeResult.sourceKind ||
    result.sourceRunId !== eligibility.sourceRunId ||
    result.sourceId !== eligibility.authoritativeResult.sourceId ||
    result.gameId !== bootstrap.gameStartInfo.gameID ||
    result.turnCount !== reveal.finalSequence + 1 ||
    result.seats.length !== expectedSeats.size ||
    actualSeatIds.size !== expectedSeats.size ||
    winners.size !== winnerSeatIds.length ||
    winnerSeatIds.some((seatId) => !expectedSeats.has(seatId)) ||
    result.seats.some((seat) => seat.won !== winners.has(seat.seatId))
  ) {
    throw networkError("reveal_integrity_failure");
  }
  return deepFreeze(result);
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (!BASE64_PATTERN.test(value)) {
    throw networkError("reveal_integrity_failure");
  }
  try {
    const decoded = globalThis.atob(value);
    if (globalThis.btoa(decoded) !== value) {
      throw new Error("non-canonical base64");
    }
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw networkError("reveal_integrity_failure");
  }
}

async function hashEligibilityCommitment(
  eligibilityRecord: ReplayPremiereEligibilityRecord,
  nonce: Uint8Array,
): Promise<string> {
  const domain = new TextEncoder().encode(ELIGIBILITY_COMMITMENT_DOMAIN);
  const record = canonicalJsonBytes(eligibilityRecord);
  const input = new Uint8Array(
    domain.byteLength + nonce.byteLength + 1 + record.byteLength,
  );
  input.set(domain, 0);
  input.set(nonce, domain.byteLength);
  input[domain.byteLength + nonce.byteLength] = 0;
  input.set(record, domain.byteLength + nonce.byteLength + 1);
  return sha256Hex(input);
}

function decodeCanonicalBase64Url(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw networkError("reveal_integrity_failure");
  }
  try {
    const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat(
      (4 - (value.length % 4)) % 4,
    )}`;
    const decoded = globalThis.atob(padded);
    const bytes = Uint8Array.from(decoded, (character) =>
      character.charCodeAt(0),
    );
    if (bytes.byteLength < 16 || bytes.byteLength > 64) {
      throw new Error("invalid length");
    }
    const canonical = globalThis
      .btoa(String.fromCharCode(...bytes))
      .replace(/=+$/u, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    if (canonical !== value) throw new Error("non-canonical");
    return bytes;
  } catch {
    throw networkError("reveal_integrity_failure");
  }
}

function eligibilityMatchesProvenance(
  eligibility: ReplayPremiereEligibilityRecord,
  provenance: ReplayPremiereProvenance,
): boolean {
  return canonicalJsonEqual(
    {
      sourceKind: eligibility.sourceKind,
      sourceRunId: eligibility.sourceRunId,
      coworld: eligibility.coworld,
      sourceReplaySha256: eligibility.sourceReplaySha256,
      seats: eligibility.seats,
      publicLabel: eligibility.publicLabel,
    },
    {
      sourceKind: provenance.sourceKind,
      sourceRunId: provenance.sourceRunId,
      coworld: provenance.coworld,
      sourceReplaySha256: provenance.sourceReplaySha256,
      seats: provenance.seats,
      publicLabel: provenance.publicLabel,
    },
  );
}

function parseStrictCoreValue<T>(schema: z.ZodType<T>, value: unknown): T {
  assertNoOutcomeBearingFields(value);
  const parsed = schema.safeParse(value);
  if (!parsed.success || !canonicalJsonEqual(value, parsed.data)) {
    throw networkError("invalid_schema");
  }
  return parsed.data;
}

function assertNoOutcomeBearingFields(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) throw networkError("invalid_json");
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNoOutcomeBearingFields(entry, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLocaleLowerCase("en-US").replace(/[_-]/g, "");
    if (OUTCOME_BEARING_KEYS.has(normalized)) {
      throw networkError("outcome_field_leak");
    }
    assertNoOutcomeBearingFields(entry, depth + 1);
  }
}

function canonicalJsonEqual(left: unknown, right: unknown): boolean {
  return (
    canonicalReplayPremiereJson(left) === canonicalReplayPremiereJson(right)
  );
}

function isAllowedManifestTransition(
  from: ReplayPremierePreRevealManifest["state"],
  to: ReplayPremierePreRevealManifest["state"],
): boolean {
  if (from === to) return true;
  const transitions: Record<
    ReplayPremierePreRevealManifest["state"],
    readonly ReplayPremierePreRevealManifest["state"][]
  > = {
    scheduled: ["playing", "cancelled"],
    playing: ["checkpoint", "failed"],
    checkpoint: ["playing", "failed"],
    failed: [],
    cancelled: [],
  };
  return transitions[from].includes(to);
}

function hasNoStoreDirective(value: string | null): boolean {
  return (
    value
      ?.split(",")
      .map((directive) => directive.trim().toLowerCase())
      .includes("no-store") === true
  );
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function positiveIntegerOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw networkError("invalid_configuration");
  }
  return value;
}

function networkError(
  code: ReplayPremiereNetworkErrorCode,
  recoverable = false,
): ReplayPremiereNetworkError {
  return new ReplayPremiereNetworkError(code, recoverable);
}

function normalizeNetworkError(error: unknown): ReplayPremiereNetworkError {
  return error instanceof ReplayPremiereNetworkError
    ? error
    : networkError("request_failed", true);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError")
  );
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(networkError("disposed"));
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(networkError("disposed"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
