import { z } from "zod";
import type { GameStartInfo } from "../core/Schemas";
import {
  readProxyWarClipGenerationCapabilities,
  type ProxyWarClipGenerationCapabilities,
} from "./ClipGenerationCapabilities";
import {
  PREMIERE_PRESENTATION_TRAIL_MS,
  premiereClipStatusResponseSchema,
  ReplayPremiereNetworkController,
  ReplayPremiereNetworkError,
  type ReplayPremiereClipReadyPayload,
  type ReplayPremiereClipStatusResponse,
  type ReplayPremiereManifest,
  type ReplayPremiereNetworkCallbacks,
  type ReplayPremiereNetworkOptions,
  type ReplayPremierePreRevealManifest,
  type ReplayPremiereReadyProjection,
  type ReplayPremiereRecoveryNotice,
  type ReplayPremiereReveal,
} from "./ReplayPremiereNetwork";
import {
  mountReplayPremiereOverlay,
  type ReplayPremiereCaptionRequest,
  type ReplayPremiereCheckpointPair,
  type ReplayPremiereCheckpointView,
  type ReplayPremiereClipCopyRequest,
  type ReplayPremiereClipRequest,
  type ReplayPremiereClipView,
  type ReplayPremiereCounterChallengeRequest,
  type ReplayPremiereHighlightedMomentView,
  type ReplayPremiereMarkerKind,
  type ReplayPremiereMarkerRequest,
  type ReplayPremiereOverlayCallbacks,
  type ReplayPremiereOverlayHandle,
  type ReplayPremiereOverlayModel,
  type ReplayPremierePolicyIdentityView,
  type ReplayPremierePolicyView,
  type ReplayPremierePredictionRequest,
  type ReplayPremiereReminderRequest,
  type ReplayPremiereResultsSummaryView,
  type ReplayPremiereShareRequest,
  type ReplayPremiereWarEventView,
} from "./ReplayPremiereOverlay";
import {
  ReplayPremierePlaybackController,
  type ReplayPremierePlaybackEvent,
  type ReplayPremiereProgressiveReplayConfig,
} from "./ReplayPremierePlayback";
import { translateText } from "./Utils";

const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;
const CHECKPOINT_ID_PATTERN = /^cp_[a-z0-9]{8,32}$/;
const SESSION_ID_PATTERN = /^sess_[a-f0-9]{32}$/;
const PARTICIPANT_ID_PATTERN = /^guest_[a-f0-9]{32}$/;
const REACTION_ID_PATTERN = /^react_[a-f0-9]{32}$/;
const SHARE_ID_PATTERN = /^share_[a-f0-9]{32}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CSRF_PATTERN = /^v1\.[0-9a-z]{1,16}\.[a-f0-9]{32}\.[a-f0-9]{64}$/;
const ATTRIBUTION_PATTERN = /^[A-Za-z0-9_-]{16,512}\.[A-Za-z0-9_-]{16,128}$/;
const JSON_CONTENT_TYPE_PATTERN = /^(?:application\/json|[^;]+\+json)(?:;|$)/i;
const MAX_INTERACTION_RESPONSE_BYTES = 256 * 1024;
const INTERACTION_REQUEST_TIMEOUT_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const INTERACTION_RECOVERY_RETRY_MS = 1_000;
const MAX_CLIPBOARD_TEXT_LENGTH = 16_384;
const PRE_REVEAL_BODY_CLASS = "replay-premiere-pre-reveal";
// Bounded clip render poll: after a POST returns pending, poll the status GET
// with capped backoff. A hard attempt/time cap guarantees the loop terminates
// (never a cold poll of an unknown bucket — 404 is indistinguishable from a
// nonexistent premiere, so we only poll a bucket a POST already reported).
const CLIP_POLL_INITIAL_MS = 1_500;
const CLIP_POLL_MAX_MS = 6_000;
const CLIP_POLL_BACKOFF = 1.5;
const CLIP_POLL_MAX_ATTEMPTS = 20;
const CLIP_POLL_MAX_ELAPSED_MS = 120_000;
const CLIP_MAX_BUCKET = 999_999_999;

const premiereLifecycleStateSchema = z.enum([
  "draft",
  "scheduled",
  "playing",
  "checkpoint",
  "revealed",
  "failed",
  "cancelled",
  "archived",
]);
const publicErrorCodeSchema = z.enum([
  "PREMIERE_CAPACITY_EXCEEDED",
  "PREMIERE_INTEGRITY_FAILURE",
  "PREMIERE_INVALID_REQUEST",
  "PREMIERE_SOURCE_INELIGIBLE",
  "PREMIERE_UNAVAILABLE",
]);
const publicErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: publicErrorCodeSchema,
      })
      .strict(),
  })
  .strict();

const canonicalTimestampSchema = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
});
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const observedSequenceSchema = z.number().int().min(-1).max(10_000_000).safe();
const sha256Schema = z.string().regex(SHA256_PATTERN);
const opaqueIdSchema = z.string().regex(OPAQUE_ID_PATTERN);

const localPolicyIdentitySchema = z
  .object({
    namespace: z.literal("local_manifest"),
    manifestName: z.string().min(1).max(256),
    declaredVersion: z.string().min(1).max(128),
    manifestSha256: sha256Schema,
    contentSha256: sha256Schema,
  })
  .strict();
const softmaxPolicyIdentitySchema = z
  .object({
    namespace: z.literal("softmax_policy_version"),
    policyVersionId: opaqueIdSchema,
    policyName: z.string().min(1).max(256),
    serverAssignedVersion: z.string().min(1).max(128),
  })
  .strict();
const policyIdentitySchema = z.discriminatedUnion("namespace", [
  softmaxPolicyIdentitySchema,
  localPolicyIdentitySchema,
]);
const attributionSchema = z
  .object({
    attributionId: z.string().regex(PARTICIPANT_ID_PATTERN),
    shareId: z.string().regex(SHARE_ID_PATTERN),
    premiereId: z.string().regex(PREMIERE_ID_PATTERN),
    issuedAt: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
  })
  .strict();
const predictionSchema = z
  .object({
    premiereId: z.string().regex(PREMIERE_ID_PATTERN),
    checkpointId: z.string().regex(CHECKPOINT_ID_PATTERN),
    participantId: z.string().regex(PARTICIPANT_ID_PATTERN),
    selectedSeatId: opaqueIdSchema,
    submittedAt: canonicalTimestampSchema,
    lockedAt: canonicalTimestampSchema,
  })
  .strict();
const predictionResolutionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("winner"),
      winnerSeatId: opaqueIdSchema,
      resolvedAt: canonicalTimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("void"),
      reason: z.enum(["no_winner", "ambiguous_winner", "invalid_result"]),
      resolvedAt: canonicalTimestampSchema,
    })
    .strict(),
]);
const checkpointViewSchema = z
  .object({
    id: z.string().regex(CHECKPOINT_ID_PATTERN),
    sequence: z.number().int().positive().safe(),
    opensAt: canonicalTimestampSchema.nullable(),
    closesAt: canonicalTimestampSchema.nullable(),
    outageShiftMs: z.number().int().min(0).max(60_000).safe(),
    optionSeatIds: z.array(opaqueIdSchema).max(64),
    state: z.enum(["upcoming", "open", "closed"]),
    participantPrediction: predictionSchema.nullable(),
    distribution: z.record(opaqueIdSchema, nonNegativeIntegerSchema).nullable(),
    totalPredictions: nonNegativeIntegerSchema.nullable(),
    resolution: predictionResolutionSchema.nullable(),
    crowdAccuracy: z
      .object({
        correctPredictions: nonNegativeIntegerSchema,
        totalPredictions: nonNegativeIntegerSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
const checkpointPairSchema = z.tuple([
  checkpointViewSchema,
  checkpointViewSchema,
]);
const viewerSessionSchema = z
  .object({
    id: z.string().regex(SESSION_ID_PATTERN),
    premiereId: z.string().regex(PREMIERE_ID_PATTERN),
    participantId: z.string().regex(PARTICIPANT_ID_PATTERN),
    startedAt: canonicalTimestampSchema,
    lastHeartbeatAt: canonicalTimestampSchema,
    endedAt: canonicalTimestampSchema.nullable(),
    connectedDurationMs: nonNegativeIntegerSchema,
    visibleDurationMs: nonNegativeIntegerSchema,
    currentlyVisible: z.boolean(),
    firstReleasedSequenceObserved: observedSequenceSchema,
    lastReleasedSequenceObserved: observedSequenceSchema,
    predictionCount: nonNegativeIntegerSchema,
    reactionCount: nonNegativeIntegerSchema,
    shareCount: nonNegativeIntegerSchema,
    incomingAttribution: attributionSchema.nullable(),
    excludedAsOperator: z.boolean(),
    excludedAsBot: z.boolean(),
    qualifiedAt: canonicalTimestampSchema.nullable(),
    idempotencyKey: z.string().min(16).max(128),
    creationRequestHash: sha256Schema,
    heartbeatReceipts: z
      .array(
        z
          .object({
            idempotencyKey: z.string().min(16).max(128),
            requestHash: sha256Schema,
            acceptedAt: canonicalTimestampSchema,
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
const incomingMomentSchema = z
  .object({
    shareId: z.string().regex(SHARE_ID_PATTERN),
    sequence: nonNegativeIntegerSchema,
    turn: nonNegativeIntegerSchema,
  })
  .strict();
const sessionResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    csrfToken: z.string().min(1).max(512).regex(CSRF_PATTERN),
    session: viewerSessionSchema,
    premiereState: premiereLifecycleStateSchema,
    checkpoints: checkpointPairSchema,
    incomingMoment: incomingMomentSchema.nullable(),
  })
  .strict();
const heartbeatResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    session: viewerSessionSchema,
    idempotent: z.boolean(),
    persisted: z.boolean(),
    premiereState: premiereLifecycleStateSchema,
    checkpoints: checkpointPairSchema,
  })
  .strict();
const predictionResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    prediction: predictionSchema,
    idempotent: z.boolean(),
    checkpoint: checkpointViewSchema,
  })
  .strict();
const reactionSchema = z
  .object({
    id: z.string().regex(REACTION_ID_PATTERN),
    premiereId: z.string().regex(PREMIERE_ID_PATTERN),
    participantId: z.string().regex(PARTICIPANT_ID_PATTERN),
    sequence: nonNegativeIntegerSchema,
    turn: nonNegativeIntegerSchema,
    kind: z.enum([
      "turning_point",
      "smart",
      "mistake",
      "betrayal",
      "clip_this",
    ]),
    policyIdentity: policyIdentitySchema.nullable(),
    eventContext: z.unknown().refine((value) => isBoundedJsonValue(value)),
    createdAt: canonicalTimestampSchema,
  })
  .strict();
const reactionResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    reaction: reactionSchema,
    idempotent: z.boolean(),
  })
  .strict();
const shareSchema = z
  .object({
    id: z.string().regex(SHARE_ID_PATTERN),
    premiereId: z.string().regex(PREMIERE_ID_PATTERN),
    sourceReactionId: z.string().regex(REACTION_ID_PATTERN).nullable(),
    sequence: nonNegativeIntegerSchema,
    turn: nonNegativeIntegerSchema,
    createdByParticipantId: z.string().regex(PARTICIPANT_ID_PATTERN),
    cardVersion: z.literal(1),
    createdAt: canonicalTimestampSchema,
    idempotencyKey: z.string().min(16).max(128),
  })
  .strict();
const shareResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    share: shareSchema,
    attributionToken: z.string().regex(ATTRIBUTION_PATTERN).max(1024),
    url: z.string().url().max(2_048),
    idempotent: z.boolean(),
  })
  .strict();

export type ReplayPremiereServiceCheckpoint = z.infer<
  typeof checkpointViewSchema
>;
export type ReplayPremiereServiceSession = z.infer<typeof viewerSessionSchema>;
export type ReplayPremiereServiceSessionResponse = z.infer<
  typeof sessionResponseSchema
>;
export type ReplayPremiereServiceHeartbeatResponse = z.infer<
  typeof heartbeatResponseSchema
>;
export type ReplayPremiereServicePredictionResponse = z.infer<
  typeof predictionResponseSchema
>;
export type ReplayPremiereServiceReactionResponse = z.infer<
  typeof reactionResponseSchema
>;
export type ReplayPremiereServiceShareResponse = z.infer<
  typeof shareResponseSchema
>;
export type ReplayPremiereLifecycleState = z.infer<
  typeof premiereLifecycleStateSchema
>;
export type ReplayPremierePublicErrorCode = z.infer<
  typeof publicErrorCodeSchema
>;

export type ReplayPremiereServiceErrorCode =
  | "invalid_configuration"
  | "session_required"
  | "request_failed"
  | "request_rejected"
  | "invalid_response"
  | "disposed";

export type ReplayPremiereServiceErrorPhase =
  | "constructor"
  | "input"
  | "fetch_rejection"
  | "timeout"
  | "response_policy"
  | "response_read"
  | "response_schema"
  | "response_status"
  | "response_binding"
  | "unspecified";

export class ReplayPremiereServiceError extends Error {
  constructor(
    public readonly code: ReplayPremiereServiceErrorCode,
    public readonly status: number | null = null,
    public readonly publicCode: ReplayPremierePublicErrorCode | null = null,
    public readonly phase: ReplayPremiereServiceErrorPhase = "unspecified",
  ) {
    super(code);
    this.name = "ReplayPremiereServiceError";
  }
}

export interface ReplayPremiereServiceClientOptions {
  premiereId: string;
  /** Exact page origin used by the server's same-origin write gate. */
  origin?: string;
  fetchImpl?: typeof fetch;
  randomBytes?: (size: number) => Uint8Array;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

/** Strict same-origin client for anonymous Premiere interaction writes. */
export class ReplayPremiereServiceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly origin: string;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly abortController = new AbortController();
  private readonly semanticIdempotencyKeys = new Map<string, string>();
  private readonly sessionIdempotencyKey: string;
  private verifiedBinding: ReplayPremiereVerifiedBinding | null = null;
  private sessionBootstrapBody: ReplayPremiereSessionInput | null = null;
  private pendingHeartbeat: {
    sessionId: string;
    body: { visible: boolean; observedSequence: number };
    idempotencyKey: string;
  } | null = null;
  private csrfToken: string | null = null;
  private currentSession: ReplayPremiereServiceSession | null = null;
  private disposed = false;

  constructor(private readonly options: ReplayPremiereServiceClientOptions) {
    if (!PREMIERE_ID_PATTERN.test(options.premiereId)) {
      throw serviceError("invalid_configuration");
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.origin = parseSameOrigin(options.origin);
    this.randomBytes =
      options.randomBytes ??
      ((size: number): Uint8Array => {
        const bytes = new Uint8Array(size);
        globalThis.crypto.getRandomValues(bytes);
        return bytes;
      });
    this.requestTimeoutMs = boundedPositiveInteger(
      options.requestTimeoutMs,
      INTERACTION_REQUEST_TIMEOUT_MS,
      INTERACTION_REQUEST_TIMEOUT_MS,
    );
    this.maxResponseBytes = boundedPositiveInteger(
      options.maxResponseBytes,
      MAX_INTERACTION_RESPONSE_BYTES,
      1024 * 1024,
    );
    this.sessionIdempotencyKey = this.createIdempotencyKey();
  }

  session(): ReplayPremiereServiceSession | null {
    return this.currentSession;
  }

  bindVerifiedProjection(
    projection: Readonly<ReplayPremiereReadyProjection>,
  ): void {
    this.assertActive();
    const binding = bindingFromProjection(projection, this.options.premiereId);
    if (
      this.verifiedBinding !== null &&
      !sameVerifiedBinding(this.verifiedBinding, binding)
    ) {
      throw serviceError("invalid_response");
    }
    this.verifiedBinding = binding;
  }

  async startSession(
    input: ReplayPremiereSessionInput,
  ): Promise<ReplayPremiereServiceSessionResponse> {
    try {
      this.assertActive();
      const parsedInput = parseSessionInput(input);
      if (this.sessionBootstrapBody === null) {
        this.sessionBootstrapBody = parsedInput;
      } else if (!sameSessionInput(this.sessionBootstrapBody, parsedInput)) {
        throw serviceError("invalid_configuration");
      }
    } catch (error) {
      throw serviceErrorWithPhase(error, "input");
    }
    const response = await this.postJson(
      "sessions",
      this.sessionBootstrapBody,
      this.sessionIdempotencyKey,
      sessionResponseSchema,
      201,
      false,
    );
    try {
      this.assertSessionResponseBound(
        response,
        this.sessionBootstrapBody,
        this.sessionIdempotencyKey,
      );
    } catch (error) {
      throw serviceErrorWithPhase(error, "response_binding");
    }
    this.csrfToken = response.csrfToken;
    this.currentSession = response.session;
    return response;
  }

  async refreshSession(): Promise<ReplayPremiereServiceSessionResponse> {
    if (this.sessionBootstrapBody === null) {
      throw serviceError("session_required");
    }
    return this.startSession(this.sessionBootstrapBody);
  }

  async heartbeat(input: {
    visible: boolean;
    observedSequence: number;
  }): Promise<ReplayPremiereServiceHeartbeatResponse> {
    const session = this.requireSession();
    const requestedBody = {
      visible: input.visible === true,
      observedSequence: parseObservedSequence(input.observedSequence),
    };
    if (
      this.pendingHeartbeat !== null &&
      this.pendingHeartbeat.sessionId !== session.id
    ) {
      this.pendingHeartbeat = null;
      throw serviceError("invalid_response");
    }
    this.pendingHeartbeat ??= {
      sessionId: session.id,
      body: requestedBody,
      idempotencyKey: this.createIdempotencyKey(),
    };
    const pending = this.pendingHeartbeat;
    try {
      const response = await this.postJson(
        `sessions/${session.id}/heartbeat`,
        pending.body,
        pending.idempotencyKey,
        heartbeatResponseSchema,
        200,
        true,
      );
      this.assertHeartbeatResponseBound(response, session);
      this.currentSession = response.session;
      this.pendingHeartbeat = null;
      return response;
    } catch (error) {
      if (!isRetryableServiceFailure(error)) {
        this.pendingHeartbeat = null;
      }
      throw error;
    }
  }

  async submitPrediction(
    input: ReplayPremierePredictionRequest,
  ): Promise<ReplayPremiereServicePredictionResponse> {
    const session = this.requireSession();
    if (
      input.premiereId !== this.options.premiereId ||
      !CHECKPOINT_ID_PATTERN.test(input.checkpointId) ||
      !OPAQUE_ID_PATTERN.test(input.selectedSeatId)
    ) {
      throw serviceError("invalid_configuration");
    }
    const body = {
      sessionId: session.id,
      checkpointId: input.checkpointId,
      selectedSeatId: input.selectedSeatId,
    };
    const response = await this.postJson(
      "predictions",
      body,
      this.semanticKey(
        `prediction:${input.checkpointId}:${input.selectedSeatId}`,
      ),
      predictionResponseSchema,
      200,
      true,
    );
    this.assertPredictionResponseBound(response, input, session);
    return response;
  }

  async submitReaction(
    input: ReplayPremiereMarkerRequest,
  ): Promise<ReplayPremiereServiceReactionResponse> {
    const session = this.requireSession();
    if (
      input.premiereId !== this.options.premiereId ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 0 ||
      (input.policySeatId !== null &&
        !OPAQUE_ID_PATTERN.test(input.policySeatId))
    ) {
      throw serviceError("invalid_configuration");
    }
    const body = {
      sessionId: session.id,
      sequence: input.sequence,
      kind: input.kind,
      ...(input.policySeatId === null
        ? {}
        : { policySeatId: input.policySeatId }),
    };
    const response = await this.postJson(
      "reactions",
      body,
      this.semanticKey(`reaction:${input.sequence}:${input.kind}`),
      reactionResponseSchema,
      200,
      true,
    );
    this.assertReactionResponseBound(response, input, session);
    return response;
  }

  async createShare(input: {
    sequence: number;
    sourceReactionId?: string | null;
  }): Promise<ReplayPremiereServiceShareResponse> {
    const session = this.requireSession();
    if (
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 0 ||
      (input.sourceReactionId !== null &&
        input.sourceReactionId !== undefined &&
        !REACTION_ID_PATTERN.test(input.sourceReactionId))
    ) {
      throw serviceError("invalid_configuration");
    }
    const sourceReactionId = input.sourceReactionId ?? null;
    const body = {
      sessionId: session.id,
      sourceReactionId,
      sequence: input.sequence,
    };
    const idempotencyKey = this.semanticKey(
      `share:${input.sequence}:${sourceReactionId ?? "none"}`,
    );
    const response = await this.postJson(
      "shares",
      body,
      idempotencyKey,
      shareResponseSchema,
      200,
      true,
    );
    this.assertShareResponseBound(
      response,
      { sequence: input.sequence, sourceReactionId },
      session,
      idempotencyKey,
    );
    return response;
  }

  /**
   * Request a social clip anchored on a released moment. Requires an active
   * CSRF-bound session (same as share/reaction). The server floors the anchor
   * turn into a 10-turn bucket and returns a `ready` or `pending` status. A
   * pending status must be polled with {@link readClipStatus} on the returned
   * bucket — never a cold bucket, since an absent clip returns an
   * indistinguishable 404.
   */
  async requestClip(input: {
    sequence: number;
    turn: number;
  }): Promise<ReplayPremiereClipStatusResponse> {
    this.requireSession();
    if (
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 0 ||
      !Number.isSafeInteger(input.turn) ||
      input.turn < 0
    ) {
      throw serviceError("invalid_configuration");
    }
    const body = { sequence: input.sequence, turn: input.turn };
    const response = await this.postJson(
      "clips",
      body,
      this.semanticKey(`clip:${input.sequence}:${input.turn}`),
      premiereClipStatusResponseSchema,
      200,
      true,
    );
    this.assertClipStatusBound(response);
    return response;
  }

  /**
   * Read a clip's render status by bucket. Public read (no CSRF); only poll a
   * bucket a prior {@link requestClip} reported as pending or ready. An absent
   * clip is a 404 that surfaces as a rejected request the caller treats as a
   * terminal failure.
   */
  async readClipStatus(
    bucket: number,
  ): Promise<ReplayPremiereClipStatusResponse> {
    this.assertActive();
    if (
      !Number.isSafeInteger(bucket) ||
      bucket < 0 ||
      bucket > CLIP_MAX_BUCKET
    ) {
      throw serviceError("invalid_configuration");
    }
    const response = await this.getJson(
      `clips/${bucket}`,
      premiereClipStatusResponseSchema,
      200,
    );
    if (response.bucket !== bucket) {
      throw serviceError("invalid_response");
    }
    this.assertClipStatusBound(response);
    return response;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    this.pendingHeartbeat = null;
    this.csrfToken = null;
    this.currentSession = null;
  }

  private async postJson<T>(
    route: string,
    body: object,
    idempotencyKey: string,
    schema: z.ZodType<T>,
    expectedStatus: number,
    requireCsrf: boolean,
  ): Promise<T> {
    this.assertActive();
    if (requireCsrf && this.csrfToken === null) {
      throw serviceError("session_required");
    }
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    this.abortController.signal.addEventListener("abort", abortRequest, {
      once: true,
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort();
    }, this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `/api/premieres/${this.options.premiereId}/${route}`,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              // Origin is user-agent controlled. A relative same-origin POST
              // lets the browser supply the actual page origin.
              "x-idempotency-key": idempotencyKey,
              ...(requireCsrf && this.csrfToken !== null
                ? { "x-csrf-token": this.csrfToken }
                : {}),
            },
            body: JSON.stringify(body),
            cache: "no-store",
            credentials: "same-origin",
            redirect: "error",
            signal: requestController.signal,
          },
        );
      } catch {
        if (this.disposed) {
          throw serviceError("disposed", null, null, "fetch_rejection");
        }
        throw serviceError(
          "request_failed",
          null,
          null,
          timedOut ? "timeout" : "fetch_rejection",
        );
      }
      const transientStatus = isTransientInteractionStatus(response.status);
      const contentType = response.headers.get("content-type") ?? "";
      const hasJsonContentType = JSON_CONTENT_TYPE_PATTERN.test(
        contentType.trim(),
      );
      const responseHasApplicationPolicy =
        hasJsonContentType && hasNoStoreCachePolicy(response.headers);
      // An intermediary response is transport evidence, never application
      // state. Reject it before touching an untrusted (often HTML) body. A
      // valid no-store JSON error envelope still crosses the ordinary strict
      // application-error boundary below.
      if (transientStatus && !hasJsonContentType) {
        throw serviceError(
          "request_failed",
          response.status,
          null,
          "response_status",
        );
      }
      if (!responseHasApplicationPolicy) {
        throw serviceError(
          "invalid_response",
          response.status,
          null,
          "response_policy",
        );
      }
      let value: unknown;
      try {
        value = await readBoundedJsonResponse(
          response,
          this.maxResponseBytes,
          requestController.signal,
        );
      } catch (error) {
        if (transientStatus) {
          throw serviceError(
            "request_failed",
            response.status,
            null,
            "response_status",
          );
        }
        throw error;
      }
      if (response.status !== expectedStatus) {
        const publicFailure = publicErrorResponseSchema.safeParse(value);
        if (!publicFailure.success) {
          if (transientStatus) {
            throw serviceError(
              "request_failed",
              response.status,
              null,
              "response_status",
            );
          }
          throw serviceError(
            "invalid_response",
            response.status,
            null,
            "response_schema",
          );
        }
        throw serviceError(
          "request_rejected",
          response.status,
          publicFailure.data.error.code,
          "response_status",
        );
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw serviceError(
          "invalid_response",
          response.status,
          null,
          "response_schema",
        );
      }
      return parsed.data;
    } finally {
      clearTimeout(timeout);
      this.abortController.signal.removeEventListener("abort", abortRequest);
    }
  }

  /**
   * Bounded same-origin GET with the identical transient-status, no-store
   * application-policy, response-size, and timeout discipline as
   * {@link postJson}. No CSRF or body — used for public clip status reads.
   */
  private async getJson<T>(
    route: string,
    schema: z.ZodType<T>,
    expectedStatus: number,
  ): Promise<T> {
    this.assertActive();
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    this.abortController.signal.addEventListener("abort", abortRequest, {
      once: true,
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort();
    }, this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `/api/premieres/${this.options.premiereId}/${route}`,
          {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
            credentials: "same-origin",
            redirect: "error",
            signal: requestController.signal,
          },
        );
      } catch {
        if (this.disposed) {
          throw serviceError("disposed", null, null, "fetch_rejection");
        }
        throw serviceError(
          "request_failed",
          null,
          null,
          timedOut ? "timeout" : "fetch_rejection",
        );
      }
      const transientStatus = isTransientInteractionStatus(response.status);
      const contentType = response.headers.get("content-type") ?? "";
      const hasJsonContentType = JSON_CONTENT_TYPE_PATTERN.test(
        contentType.trim(),
      );
      const responseHasApplicationPolicy =
        hasJsonContentType && hasNoStoreCachePolicy(response.headers);
      if (transientStatus && !hasJsonContentType) {
        throw serviceError(
          "request_failed",
          response.status,
          null,
          "response_status",
        );
      }
      if (!responseHasApplicationPolicy) {
        throw serviceError(
          "invalid_response",
          response.status,
          null,
          "response_policy",
        );
      }
      let value: unknown;
      try {
        value = await readBoundedJsonResponse(
          response,
          this.maxResponseBytes,
          requestController.signal,
        );
      } catch (error) {
        if (transientStatus) {
          throw serviceError(
            "request_failed",
            response.status,
            null,
            "response_status",
          );
        }
        throw error;
      }
      if (response.status !== expectedStatus) {
        const publicFailure = publicErrorResponseSchema.safeParse(value);
        if (!publicFailure.success) {
          if (transientStatus) {
            throw serviceError(
              "request_failed",
              response.status,
              null,
              "response_status",
            );
          }
          throw serviceError(
            "invalid_response",
            response.status,
            null,
            "response_schema",
          );
        }
        throw serviceError(
          "request_rejected",
          response.status,
          publicFailure.data.error.code,
          "response_status",
        );
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw serviceError(
          "invalid_response",
          response.status,
          null,
          "response_schema",
        );
      }
      return parsed.data;
    } finally {
      clearTimeout(timeout);
      this.abortController.signal.removeEventListener("abort", abortRequest);
    }
  }

  private requireSession(): ReplayPremiereServiceSession {
    this.assertActive();
    if (this.currentSession === null || this.csrfToken === null) {
      throw serviceError("session_required");
    }
    return this.currentSession;
  }

  private requireBinding(): ReplayPremiereVerifiedBinding {
    if (this.verifiedBinding === null) {
      throw serviceError("invalid_configuration");
    }
    return this.verifiedBinding;
  }

  private assertSessionResponseBound(
    response: ReplayPremiereServiceSessionResponse,
    input: ReplayPremiereSessionInput,
    idempotencyKey: string,
  ): void {
    const binding = this.requireBinding();
    const { session } = response;
    if (
      session.premiereId !== binding.premiereId ||
      session.idempotencyKey !== idempotencyKey ||
      session.firstReleasedSequenceObserved !== input.observedSequence ||
      session.lastReleasedSequenceObserved < input.observedSequence ||
      session.visibleDurationMs > session.connectedDurationMs ||
      Date.parse(session.lastHeartbeatAt) < Date.parse(session.startedAt) ||
      (session.endedAt !== null &&
        Date.parse(session.endedAt) < Date.parse(session.startedAt)) ||
      (session.incomingAttribution !== null &&
        (session.incomingAttribution.premiereId !== binding.premiereId ||
          Date.parse(session.incomingAttribution.expiresAt) <=
            Date.parse(session.incomingAttribution.issuedAt)))
    ) {
      throw serviceError("invalid_response");
    }
    this.assertCheckpointsBound(response.checkpoints, session.participantId);
    if (
      response.incomingMoment !== null &&
      (session.incomingAttribution === null ||
        response.incomingMoment.shareId !== session.incomingAttribution.shareId)
    ) {
      throw serviceError("invalid_response");
    }
  }

  private assertHeartbeatResponseBound(
    response: ReplayPremiereServiceHeartbeatResponse,
    current: ReplayPremiereServiceSession,
  ): void {
    if (
      response.session.id !== current.id ||
      response.session.participantId !== current.participantId ||
      response.session.premiereId !== this.options.premiereId ||
      response.session.idempotencyKey !== current.idempotencyKey ||
      response.session.startedAt !== current.startedAt ||
      response.session.connectedDurationMs < current.connectedDurationMs ||
      response.session.visibleDurationMs < current.visibleDurationMs ||
      response.session.visibleDurationMs >
        response.session.connectedDurationMs ||
      response.session.lastReleasedSequenceObserved <
        current.lastReleasedSequenceObserved ||
      Date.parse(response.session.lastHeartbeatAt) <
        Date.parse(current.lastHeartbeatAt)
    ) {
      throw serviceError("invalid_response");
    }
    this.assertCheckpointsBound(response.checkpoints, current.participantId);
  }

  private assertPredictionResponseBound(
    response: ReplayPremiereServicePredictionResponse,
    input: ReplayPremierePredictionRequest,
    session: ReplayPremiereServiceSession,
  ): void {
    const prediction = response.prediction;
    if (
      prediction.premiereId !== this.options.premiereId ||
      prediction.participantId !== session.participantId ||
      prediction.checkpointId !== input.checkpointId ||
      prediction.selectedSeatId !== input.selectedSeatId ||
      Date.parse(prediction.lockedAt) < Date.parse(prediction.submittedAt)
    ) {
      throw serviceError("invalid_response");
    }
    this.assertCheckpointBound(response.checkpoint, session.participantId);
    if (
      response.checkpoint.id !== input.checkpointId ||
      response.checkpoint.participantPrediction === null ||
      !samePrediction(response.checkpoint.participantPrediction, prediction)
    ) {
      throw serviceError("invalid_response");
    }
  }

  private assertReactionResponseBound(
    response: ReplayPremiereServiceReactionResponse,
    input: ReplayPremiereMarkerRequest,
    session: ReplayPremiereServiceSession,
  ): void {
    const reaction = response.reaction;
    const binding = this.requireBinding();
    const expectedIdentity =
      input.policySeatId === null
        ? null
        : (binding.policyIdentities.get(input.policySeatId) ?? undefined);
    if (
      reaction.premiereId !== this.options.premiereId ||
      reaction.participantId !== session.participantId ||
      reaction.sequence !== input.sequence ||
      reaction.kind !== input.kind ||
      expectedIdentity === undefined ||
      !samePolicyIdentity(reaction.policyIdentity, expectedIdentity)
    ) {
      throw serviceError("invalid_response");
    }
  }

  private assertShareResponseBound(
    response: ReplayPremiereServiceShareResponse,
    input: { sequence: number; sourceReactionId: string | null },
    session: ReplayPremiereServiceSession,
    idempotencyKey: string,
  ): void {
    const share = response.share;
    let url: URL;
    try {
      url = new URL(response.url);
    } catch {
      throw serviceError("invalid_response");
    }
    if (
      share.premiereId !== this.options.premiereId ||
      share.createdByParticipantId !== session.participantId ||
      share.sequence !== input.sequence ||
      share.sourceReactionId !== input.sourceReactionId ||
      share.idempotencyKey !== idempotencyKey ||
      url.origin !== this.origin ||
      url.pathname !== `/premiere/${this.options.premiereId}` ||
      url.searchParams.get("moment") !== share.id ||
      url.searchParams.get("attribution") !== response.attributionToken ||
      [...url.searchParams.keys()].some(
        (key) => key !== "moment" && key !== "attribution",
      ) ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw serviceError("invalid_response");
    }
  }

  private assertClipStatusBound(
    response: ReplayPremiereClipStatusResponse,
  ): void {
    if (response.premiereId !== this.options.premiereId) {
      throw serviceError("invalid_response");
    }
    // A `ready` payload exists iff the state is ready.
    if ((response.state === "ready") !== (response.ready !== null)) {
      throw serviceError("invalid_response");
    }
    if (response.ready !== null) {
      const ready = response.ready;
      const expectedClipUrl = `/premiere/${this.options.premiereId}/clip-v1-${response.bucket}.mp4`;
      // The deep link belongs ONLY in the reply; the caption carries the
      // license lines and must never contain the premiere watch path.
      const watchPath = `/premiere/${this.options.premiereId}`;
      if (
        ready.clipUrl !== expectedClipUrl ||
        !ready.social.firstReply.includes(watchPath) ||
        ready.social.caption.includes(watchPath)
      ) {
        throw serviceError("invalid_response");
      }
    }
  }

  private assertCheckpointsBound(
    checkpoints: readonly [
      ReplayPremiereServiceCheckpoint,
      ReplayPremiereServiceCheckpoint,
    ],
    participantId: string,
  ): void {
    if (checkpoints[0].id === checkpoints[1].id) {
      throw serviceError("invalid_response");
    }
    for (const checkpoint of checkpoints) {
      this.assertCheckpointBound(checkpoint, participantId);
    }
  }

  private assertCheckpointBound(
    checkpoint: ReplayPremiereServiceCheckpoint,
    participantId: string,
  ): void {
    const binding = this.requireBinding();
    const expected = binding.checkpoints.get(checkpoint.id);
    const uniqueOptions = new Set(checkpoint.optionSeatIds);
    const optionsAreBound = checkpoint.optionSeatIds.every((seatId) =>
      binding.policyIdentities.has(seatId),
    );
    const prediction = checkpoint.participantPrediction;
    const distribution = checkpoint.distribution;
    const total = checkpoint.totalPredictions;
    const resolution = checkpoint.resolution;
    const crowd = checkpoint.crowdAccuracy;
    if (
      expected === undefined ||
      checkpoint.sequence !== expected.sequence ||
      uniqueOptions.size !== checkpoint.optionSeatIds.length ||
      !optionsAreBound ||
      (checkpoint.state === "upcoming" &&
        checkpoint.optionSeatIds.length !== 0) ||
      (checkpoint.state !== "upcoming" &&
        checkpoint.optionSeatIds.length < 2) ||
      (checkpoint.opensAt === null) !== (checkpoint.closesAt === null) ||
      (checkpoint.opensAt !== null &&
        checkpoint.closesAt !== null &&
        Date.parse(checkpoint.closesAt) <= Date.parse(checkpoint.opensAt)) ||
      (prediction !== null &&
        (prediction.premiereId !== binding.premiereId ||
          prediction.participantId !== participantId ||
          prediction.checkpointId !== checkpoint.id ||
          !uniqueOptions.has(prediction.selectedSeatId))) ||
      (distribution === null) !== (total === null) ||
      (distribution !== null &&
        (Object.keys(distribution).length !== uniqueOptions.size ||
          Object.keys(distribution).some(
            (seatId) => !uniqueOptions.has(seatId),
          ) ||
          Object.values(distribution).reduce((sum, count) => sum + count, 0) !==
            total)) ||
      (resolution?.kind === "winner" &&
        !uniqueOptions.has(resolution.winnerSeatId)) ||
      (crowd !== null &&
        (resolution?.kind !== "winner" ||
          crowd.correctPredictions > crowd.totalPredictions ||
          (total !== null && crowd.totalPredictions !== total)))
    ) {
      throw serviceError("invalid_response");
    }
  }

  private semanticKey(key: string): string {
    const existing = this.semanticIdempotencyKeys.get(key);
    if (existing !== undefined) return existing;
    const created = this.createIdempotencyKey();
    this.semanticIdempotencyKeys.set(key, created);
    return created;
  }

  private createIdempotencyKey(): string {
    const bytes = this.randomBytes(16);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
      throw serviceError("invalid_configuration");
    }
    return `idem_${Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  }

  private assertActive(): void {
    if (this.disposed) throw serviceError("disposed");
  }
}

export interface ReplayPremiereSessionInput {
  visible: boolean;
  observedSequence: number;
  attributionToken?: string;
}

export interface ReplayPremiereJoinRequest {
  gameID: string;
  gameStartInfo: GameStartInfo;
  progressiveReplay: ReplayPremiereProgressiveReplayConfig;
  premiereId: string;
  readyState: ReplayPremiereReadyProjection["state"];
}

interface ReplayPremiereNetworkLike {
  start(): Promise<unknown>;
  syncOnce(): Promise<unknown>;
  dispose(): void;
}

interface ReplayPremiereServiceLike {
  session(): ReplayPremiereServiceSession | null;
  bindVerifiedProjection(
    projection: Readonly<ReplayPremiereReadyProjection>,
  ): void;
  startSession(
    input: ReplayPremiereSessionInput,
  ): Promise<ReplayPremiereServiceSessionResponse>;
  refreshSession(): Promise<ReplayPremiereServiceSessionResponse>;
  heartbeat(input: {
    visible: boolean;
    observedSequence: number;
  }): Promise<ReplayPremiereServiceHeartbeatResponse>;
  submitPrediction(
    input: ReplayPremierePredictionRequest,
  ): Promise<ReplayPremiereServicePredictionResponse>;
  submitReaction(
    input: ReplayPremiereMarkerRequest,
  ): Promise<ReplayPremiereServiceReactionResponse>;
  createShare(input: {
    sequence: number;
    sourceReactionId?: string | null;
  }): Promise<ReplayPremiereServiceShareResponse>;
  requestClip(input: {
    sequence: number;
    turn: number;
  }): Promise<ReplayPremiereClipStatusResponse>;
  readClipStatus(bucket: number): Promise<ReplayPremiereClipStatusResponse>;
  dispose(): void;
}

export interface ReplayPremiereRuntimeDependencies {
  networkFactory?: (
    options: ReplayPremiereNetworkOptions,
  ) => ReplayPremiereNetworkLike;
  serviceFactory?: (
    options: ReplayPremiereServiceClientOptions,
  ) => ReplayPremiereServiceLike;
  overlayFactory?: typeof mountReplayPremiereOverlay;
  copyText?: (text: string) => Promise<void>;
  downloadReminder?: (request: ReplayPremiereReminderRequest) => void;
  readClipGenerationCapabilities?: () => Promise<ProxyWarClipGenerationCapabilities>;
  documentRef?: Document;
  windowRef?: Window;
}

/**
 * Live-join synchronization progress. `syncing` reports the catch-up toward
 * the trail-buffered entry position (turn numbers are viewer-facing);
 * `complete` fires exactly once, when the entry position is reached with the
 * standard presentation trail in hand — the host lifts its join veil then.
 */
export type ReplayPremiereJoinSyncUpdate =
  | { state: "syncing"; currentTurn: number | null; targetTurn: number }
  | { state: "complete" };

export interface ReplayPremiereRuntimeOptions {
  premiereId: string;
  onJoinReady: (request: ReplayPremiereJoinRequest) => void;
  onProjectionReady?: (
    projection: Readonly<ReplayPremiereReadyProjection>,
  ) => void;
  onRevealSeek?: (turn: number) => void;
  onJoinSync?: (update: ReplayPremiereJoinSyncUpdate) => void;
  fetchImpl?: typeof fetch;
  dependencies?: ReplayPremiereRuntimeDependencies;
}

export class ReplayPremiereRuntimeController {
  readonly playback: ReplayPremierePlaybackController;

  private readonly documentRef: Document;
  private readonly windowRef: Window;
  private readonly overlayFactory: typeof mountReplayPremiereOverlay;
  private readonly copyText: (text: string) => Promise<void>;
  private readonly downloadReminder: (
    request: ReplayPremiereReminderRequest,
  ) => void;
  private readonly readClipGenerationCapabilities: () => Promise<ProxyWarClipGenerationCapabilities>;
  private readonly service: ReplayPremiereServiceLike;
  private readonly network: ReplayPremiereNetworkLike;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;

  private overlay: ReplayPremiereOverlayHandle | null = null;
  private projection: Readonly<ReplayPremiereReadyProjection> | null = null;
  private latestManifest: Readonly<ReplayPremiereManifest> | null = null;
  private reveal: Readonly<ReplayPremiereReveal> | null = null;
  private serviceCheckpoints:
    | readonly [
        ReplayPremiereServiceCheckpoint,
        ReplayPremiereServiceCheckpoint,
      ]
    | null = null;
  private incomingMoment: ReplayPremiereHighlightedMomentView | null = null;
  private latestFrame: ReplayPremiereFrame | null = null;
  /** Newest-first spoiler-safe war narrative (bounded ring; see war feed). */
  private warFeed: ReplayPremiereWarEventView[] = [];
  /** The viewer's own server-accepted marks per kind (session-local). */
  private ownMarkCounts: Partial<Record<ReplayPremiereMarkerKind, number>> = {};
  private lastMarkConfirmation: {
    kind: ReplayPremiereMarkerKind;
    turn: number;
  } | null = null;
  private headlineEvent: string | null = null;
  private previousLeaderId: string | null = null;
  private recovery: ReplayPremiereRecoveryNotice | null = null;
  private networkTerminalState:
    | "failed"
    | "cancelled"
    | "revealed"
    | "archived"
    | null = null;
  private servicePremiereState: ReplayPremiereLifecycleState | null = null;
  private terminalFailure: "integrity_failure" | "runtime_failure" | null =
    null;
  private sessionBootstrapInput: ReplayPremiereSessionInput | null = null;
  private fencedSessionReadyForVerifiedReveal = false;
  private interactionReady = false;
  private sessionBootstrapInFlight = false;
  private heartbeatInFlight = false;
  private joinDispatched = false;
  private revealSeekApplied = false;
  /**
   * True when this session ever observed a sealed (pre-reveal) lifecycle. At
   * real-speed pacing the viewer's map trails the authoritative release clock
   * by up to one chunk presentation span (~45 s), so a reveal that lands
   * while the ending is still playing out is DEFERRED for display until local
   * playback completes — otherwise the overlay would name the winner while
   * the final minutes were still on screen. Pages that load already revealed
   * or archived never defer (no live trailing view to spoil).
   */
  private preRevealLifecycleObserved = false;
  private revealDisplayTimer: ReturnType<typeof setInterval> | null = null;
  /** Dispatcher starvation surfaced by playback ("Buffering live…"). */
  private buffering = false;
  /**
   * Starvation display grace: releases are edge-timed against the trail, so
   * a sub-second stall at each chunk boundary is normal jitter. The chip only
   * shows after continuous starvation outlives the grace; clearing is
   * immediate.
   */
  private bufferingDisplayTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackUnsubscribe: (() => void) | null = null;
  /**
   * Live-join catch-up target (sequence). Set from playback catch-up events
   * observed before the first sync completion; catch-ups after that are
   * mid-watch gap recovery and never re-veil.
   */
  private joinSyncTargetSequence: number | null = null;
  private joinSyncSettled = false;
  private ambient = false;
  private readySettled = false;
  private started = false;
  private disposed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sessionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private checkpointDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private locallyClosedCheckpointId: string | null = null;
  // Social-clip state (revealed-only). `clipStatus` drives the overlay clip
  // block; `clipReady` holds the verbatim server-composed download + social
  // text. The poll loop is bounded by attempt/time caps.
  private clipStatus: ReplayPremiereClipView["status"] = "idle";
  private clipReady: ReplayPremiereClipReadyPayload | null = null;
  private clipPollTimer: ReturnType<typeof setTimeout> | null = null;
  private clipPollBucket: number | null = null;
  private clipPollAttempts = 0;
  private clipPollStartedMs = 0;
  private clipGenerationEnabled = false;

  constructor(private readonly options: ReplayPremiereRuntimeOptions) {
    if (
      !PREMIERE_ID_PATTERN.test(options.premiereId) ||
      typeof options.onJoinReady !== "function"
    ) {
      throw new ReplayPremiereNetworkError("invalid_configuration", false);
    }
    this.documentRef = options.dependencies?.documentRef ?? document;
    this.windowRef = options.dependencies?.windowRef ?? window;
    this.overlayFactory =
      options.dependencies?.overlayFactory ?? mountReplayPremiereOverlay;
    this.copyText = options.dependencies?.copyText ?? defaultCopyText;
    this.downloadReminder =
      options.dependencies?.downloadReminder ??
      ((request) => defaultDownloadReminder(request, this.documentRef));
    this.readClipGenerationCapabilities =
      options.dependencies?.readClipGenerationCapabilities ??
      (() =>
        readProxyWarClipGenerationCapabilities(
          options.fetchImpl ?? globalThis.fetch,
        ));
    this.playback = new ReplayPremierePlaybackController(options.premiereId);
    this.service =
      options.dependencies?.serviceFactory?.({
        premiereId: options.premiereId,
        origin: this.windowRef.location.origin,
        fetchImpl: options.fetchImpl,
      }) ??
      new ReplayPremiereServiceClient({
        premiereId: options.premiereId,
        origin: this.windowRef.location.origin,
        fetchImpl: options.fetchImpl,
      });
    const callbacks: ReplayPremiereNetworkCallbacks = {
      onReady: (projection) => this.onReady(projection),
      onManifest: (manifest) => this.onManifest(manifest),
      onReveal: (reveal) => this.onReveal(reveal),
      onTerminal: (state) => this.onTerminal(state),
      onRecovering: (notice) => this.onRecovering(notice),
      onFatalError: (error) => this.onFatalError(error),
    };
    const networkOptions: ReplayPremiereNetworkOptions = {
      premiereId: options.premiereId,
      playback: this.playback,
      callbacks,
      fetchImpl: options.fetchImpl,
    };
    this.network =
      options.dependencies?.networkFactory?.(networkOptions) ??
      new ReplayPremiereNetworkController(networkOptions);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  start(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new ReplayPremiereNetworkError("disposed", false));
    }
    if (!this.started) {
      this.started = true;
      this.documentRef.body.classList.add(PRE_REVEAL_BODY_CLASS);
      this.playbackUnsubscribe = this.playback.subscribe((event) =>
        this.onPlaybackEvent(event),
      );
      this.documentRef.addEventListener(
        "ai-league-replay-frame",
        this.onFrameEvent,
      );
      this.documentRef.addEventListener(
        "ai-league-replay-load-error",
        this.onClientPlaybackError,
      );
      this.documentRef.addEventListener(
        "visibilitychange",
        this.onVisibilityChange,
      );
      void this.readClipGenerationCapabilities().then(
        (capabilities) => {
          this.applyClipGenerationCapability(
            capabilities?.premiereGenerationEnabled === true,
          );
        },
        () => this.applyClipGenerationCapability(false),
      );
      void this.network
        .start()
        .catch((error) => this.handleNetworkRejection(error));
    }
    return this.readyPromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.network.dispose();
    this.service.dispose();
    this.overlay?.dispose();
    this.overlay = null;
    this.clearInteractionTimers();
    this.clearCheckpointDeadline();
    this.clearClipPoll();
    this.clearRevealDisplayPump();
    this.playbackUnsubscribe?.();
    this.playbackUnsubscribe = null;
    if (this.bufferingDisplayTimer !== null) {
      clearTimeout(this.bufferingDisplayTimer);
      this.bufferingDisplayTimer = null;
    }
    this.documentRef.removeEventListener(
      "ai-league-replay-frame",
      this.onFrameEvent,
    );
    this.documentRef.removeEventListener(
      "ai-league-replay-load-error",
      this.onClientPlaybackError,
    );
    this.documentRef.removeEventListener(
      "visibilitychange",
      this.onVisibilityChange,
    );
    this.documentRef.body.classList.remove(PRE_REVEAL_BODY_CLASS);
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(new ReplayPremiereNetworkError("disposed", false));
    }
  }

  private async onReady(
    projection: Readonly<ReplayPremiereReadyProjection>,
  ): Promise<void> {
    if (this.disposed || this.projection !== null) return;
    if (projection.premiereId !== this.options.premiereId) {
      this.latchFailure("integrity_failure");
      return;
    }
    this.projection = projection;
    if (
      projection.state === "scheduled" ||
      projection.state === "playing" ||
      projection.state === "checkpoint"
    ) {
      this.preRevealLifecycleObserved = true;
    }
    try {
      this.service.bindVerifiedProjection(projection);
    } catch {
      this.latchFailure("integrity_failure");
      return;
    }
    this.overlay = this.overlayFactory(
      this.buildOverlayModel(),
      this.overlayCallbacks(),
    );
    this.options.onProjectionReady?.(projection);

    if (this.isReadOnlyLifecycle()) {
      this.interactionReady = false;
      this.clearInteractionTimers();
      this.service.dispose();
      if (
        this.currentNetworkState() === "failed" ||
        this.currentNetworkState() === "cancelled"
      ) {
        this.settleReady();
      }
      return;
    }

    // The verified reveal must land before an already-finished premiere may
    // read interaction checkpoint outcomes. Active premieres can bootstrap
    // their anonymous session immediately, but no path joins before success.
    if (projection.state !== "revealed" && projection.state !== "archived") {
      void this.bootstrapInteractions();
    }
  }

  private async onManifest(
    manifest: Readonly<ReplayPremiereManifest>,
  ): Promise<void> {
    if (this.disposed || this.terminalFailure !== null) return;
    if (manifest.premiereId !== this.options.premiereId) {
      this.latchFailure("integrity_failure");
      return;
    }
    if (
      this.networkTerminalState !== null &&
      manifest.state !== this.networkTerminalState
    ) {
      return;
    }
    this.latestManifest = manifest;
    this.reconcileCheckpointDeadline(manifest);
    this.recovery = null;
    if (
      manifest.state === "archived" ||
      manifest.state === "failed" ||
      manifest.state === "cancelled"
    ) {
      this.enterReadOnlyNetworkTerminal(manifest.state);
    }
    this.hydrateOverlay();
  }

  private async onReveal(
    reveal: Readonly<ReplayPremiereReveal>,
  ): Promise<void> {
    if (this.disposed || this.terminalFailure !== null) return;
    if (
      reveal.premiereId !== this.options.premiereId ||
      this.projection === null ||
      !isRevealBoundToProjection(reveal, this.projection)
    ) {
      this.latchFailure("integrity_failure");
      return;
    }
    this.reveal = reveal;
    this.recovery = null;
    this.maybeLiftPreRevealSuppression();
    this.hydrateOverlay();
    this.maybeApplyRevealSeek();
    if (this.isRevealDisplayDeferred()) {
      this.ensureRevealDisplayPump();
    }
    if (this.currentNetworkState() === "archived") {
      this.servicePremiereState = "archived";
      this.interactionReady = false;
      this.clearInteractionTimers();
      this.clearClipPoll();
      this.service.dispose();
      this.dispatchJoinAfterBootstrap();
    } else if (this.fencedSessionReadyForVerifiedReveal) {
      this.activateFencedSessionAfterReveal();
    } else if (!this.interactionReady) {
      void this.bootstrapInteractions();
    }
  }

  private async onTerminal(
    state: "failed" | "cancelled" | "revealed" | "archived",
  ): Promise<void> {
    if (this.disposed || this.terminalFailure !== null) return;
    if (
      this.networkTerminalState !== null &&
      this.networkTerminalState !== state
    ) {
      return;
    }
    this.networkTerminalState = state;
    if (state === "revealed" || state === "archived") {
      this.maybeLiftPreRevealSuppression();
    }
    if (state === "failed" || state === "cancelled" || state === "archived") {
      this.enterReadOnlyNetworkTerminal(state);
    }
    this.hydrateOverlay();
  }

  private async onRecovering(
    notice: Readonly<ReplayPremiereRecoveryNotice>,
  ): Promise<void> {
    if (
      this.disposed ||
      this.terminalFailure !== null ||
      this.networkTerminalState !== null
    ) {
      return;
    }
    this.recovery = notice;
    this.hydrateOverlay();
  }

  private async onFatalError(
    error: Readonly<ReplayPremiereNetworkError>,
  ): Promise<void> {
    if (this.disposed) return;
    this.latchFailure("integrity_failure", error);
  }

  private handleNetworkRejection(error: unknown): void {
    if (this.disposed || this.terminalFailure !== null) return;
    const safeError =
      error instanceof ReplayPremiereNetworkError
        ? error
        : new ReplayPremiereNetworkError("request_failed", true);
    this.latchFailure(
      safeError.recoverable ? "runtime_failure" : "integrity_failure",
      safeError,
    );
  }

  private readonly onFrameEvent = (event: Event): void => {
    if (this.disposed) return;
    const frame = parseReplayPremiereFrame(
      (event as CustomEvent<unknown>).detail,
    );
    if (frame === null) return;
    const playbackState = this.playback.state();
    if (
      frame.sequence === null ||
      playbackState.releasedThroughSequence === null ||
      playbackState.lastDispatchedSequence === null ||
      frame.sequence > playbackState.releasedThroughSequence ||
      frame.sequence > playbackState.lastDispatchedSequence ||
      (this.latestFrame?.sequence !== null &&
        this.latestFrame?.sequence !== undefined &&
        frame.sequence < this.latestFrame.sequence)
    ) {
      this.latchFailure("integrity_failure");
      return;
    }
    const leaders = [...frame.players].sort(
      (left, right) =>
        right.tilesOwned - left.tilesOwned ||
        left.displayName.localeCompare(right.displayName),
    );
    const leader = leaders[0] ?? null;
    if (
      leader !== null &&
      this.previousLeaderId !== null &&
      leader.playerID !== this.previousLeaderId
    ) {
      this.headlineEvent = translateText(
        "replay_premiere.headline_lead_change",
        { name: leader.displayName },
      );
    }
    this.previousLeaderId = leader?.playerID ?? this.previousLeaderId;
    this.latestFrame = frame;
    if (frame.warEvents.length > 0) {
      this.warFeed = [
        ...frame.warEvents.slice().reverse(),
        ...this.warFeed,
      ].slice(0, MAX_WAR_FEED_ENTRIES);
    }
    this.maybeSettleJoinSync(frame);
    this.hydrateOverlay();
  };

  private readonly onClientPlaybackError = (): void => {
    if (this.disposed) return;
    this.latchFailure("runtime_failure");
  };

  private onPlaybackEvent(event: ReplayPremierePlaybackEvent): void {
    if (this.disposed) return;
    if (event.type === "buffering") {
      if (event.buffering) {
        if (this.bufferingDisplayTimer === null && !this.buffering) {
          this.bufferingDisplayTimer = setTimeout(() => {
            this.bufferingDisplayTimer = null;
            if (this.disposed) return;
            this.buffering = true;
            this.hydrateOverlay();
          }, BUFFERING_DISPLAY_GRACE_MS);
        }
      } else {
        if (this.bufferingDisplayTimer !== null) {
          clearTimeout(this.bufferingDisplayTimer);
          this.bufferingDisplayTimer = null;
        }
        if (this.buffering) {
          this.buffering = false;
          this.hydrateOverlay();
        }
      }
      return;
    }
    if (event.type === "catch-up") {
      // Only pre-settlement catch-ups define the join entry position; later
      // ones are mid-watch gap recovery (buffering chip + fast-forward, no
      // re-veil). Catch-up may free-run the simulation: it replays ALREADY
      // RELEASED content and playback stays bounded by released chunks
      // regardless of pacing, so there is no spoiler surface.
      if (!this.joinSyncSettled) {
        this.joinSyncTargetSequence = Math.max(
          this.joinSyncTargetSequence ?? event.targetSequence,
          event.targetSequence,
        );
        this.options.onJoinSync?.({
          state: "syncing",
          currentTurn: this.latestFrame?.turnNumber ?? null,
          // Dense records: sequence === turn number, viewer-facing.
          targetTurn: this.joinSyncTargetSequence,
        });
      }
      return;
    }
    if (event.type === "playback-complete" && !this.joinSyncSettled) {
      // A show that ends before the entry position is reached still settles
      // (short shows, reveal racing a join).
      this.settleJoinSync();
    }
  }

  /**
   * Join-sync settlement: the veil lifts once the viewer's rendered frame
   * reaches the trail-buffered entry position (or immediately on the first
   * frame when no catch-up was requested — a from-start join). At settlement
   * the standard presentation trail is in hand by construction, so playback
   * has runway and does not gate on the next release.
   */
  private maybeSettleJoinSync(frame: ReplayPremiereFrame): void {
    if (this.joinSyncSettled) return;
    if (this.joinSyncTargetSequence === null) {
      // No catch-up requested yet. If the released stream is already more
      // than the catch-up threshold's worth of records beyond this frame, the
      // network WILL request one imminently (same arithmetic on its side) —
      // hold the veil instead of settling into the pre-teleport view. Joins
      // within the threshold settle on their first frame and simply play
      // from where they are (they are already inside the designed trail).
      const released = this.playback.state().releasedThroughSequence;
      if (
        released !== null &&
        frame.sequence !== null &&
        released - frame.sequence > this.imminentCatchUpGuardRecords()
      ) {
        this.options.onJoinSync?.({
          state: "syncing",
          currentTurn: frame.turnNumber,
          targetTurn: released,
        });
        return;
      }
      this.settleJoinSync();
      return;
    }
    if (
      frame.sequence === null ||
      frame.sequence < this.joinSyncTargetSequence
    ) {
      this.options.onJoinSync?.({
        state: "syncing",
        currentTurn: frame.turnNumber,
        targetTurn: this.joinSyncTargetSequence,
      });
      return;
    }
    this.settleJoinSync();
  }

  /**
   * The catch-up threshold (two presentation trails) expressed in records:
   * presentation time per record is the real 100 ms turn interval divided by
   * the fixed playback rate (dense records, one per game turn).
   */
  private imminentCatchUpGuardRecords(): number {
    const rate = this.projection?.playbackRate ?? 1;
    return Math.ceil((2 * PREMIERE_PRESENTATION_TRAIL_MS * rate) / 100);
  }

  private settleJoinSync(): void {
    if (this.joinSyncSettled) return;
    this.joinSyncSettled = true;
    this.options.onJoinSync?.({ state: "complete" });
  }

  private readonly onVisibilityChange = (): void => {
    if (this.disposed || !this.interactionReady) return;
    void this.sendHeartbeat();
  };

  private async bootstrapInteractions(): Promise<void> {
    if (
      this.disposed ||
      this.projection === null ||
      this.interactionReady ||
      this.sessionBootstrapInFlight ||
      this.terminalFailure !== null
    ) {
      return;
    }
    if (this.sessionRetryTimer !== null) {
      clearTimeout(this.sessionRetryTimer);
      this.sessionRetryTimer = null;
    }
    this.sessionBootstrapInput ??= this.createSessionBootstrapInput();
    const networkStateAtRequest = this.currentNetworkState();
    this.sessionBootstrapInFlight = true;
    try {
      const response = await this.service.startSession(
        this.sessionBootstrapInput,
      );
      if (
        this.disposed ||
        this.terminalFailure !== null ||
        this.isReadOnlyLifecycle()
      ) {
        return;
      }
      const staleAcrossReveal = isStalePreRevealServiceProjection(
        networkStateAtRequest,
        this.currentNetworkState(),
        response.premiereState,
        response.checkpoints,
      );
      if (!staleAcrossReveal) {
        this.applyServiceProjection(response);
      }
      if (this.terminalFailure !== null) return;
      if (staleAcrossReveal || this.isRevealVerificationPending()) {
        if (staleAcrossReveal) {
          this.incomingMoment = response.incomingMoment;
        }
        this.fencedSessionReadyForVerifiedReveal = true;
        if (this.reveal !== null) {
          this.activateFencedSessionAfterReveal();
        }
        return;
      }
      this.interactionReady = !this.isReadOnlyLifecycle();
      this.hydrateOverlay();
      this.dispatchJoinAfterBootstrap();
      if (!this.isReadOnlyLifecycle() && this.heartbeatTimer === null) {
        this.heartbeatTimer = setInterval(
          () => void this.sendHeartbeat(),
          HEARTBEAT_INTERVAL_MS,
        );
      }
    } catch (error) {
      if (
        this.disposed ||
        this.terminalFailure !== null ||
        this.isReadOnlyLifecycle()
      ) {
        return;
      }
      this.interactionReady = false;
      this.hydrateOverlay();
      if (isRetryableServiceFailure(error)) {
        this.sessionRetryTimer = setTimeout(
          () => void this.bootstrapInteractions(),
          INTERACTION_RECOVERY_RETRY_MS,
        );
      } else {
        logInteractionBootstrapFailure(error);
        this.latchFailure(
          error instanceof ReplayPremiereServiceError &&
            error.code === "invalid_response"
            ? "integrity_failure"
            : "runtime_failure",
          error,
        );
      }
    } finally {
      this.sessionBootstrapInFlight = false;
    }
  }

  private activateFencedSessionAfterReveal(): void {
    if (
      !this.fencedSessionReadyForVerifiedReveal ||
      this.reveal === null ||
      this.disposed ||
      this.terminalFailure !== null ||
      this.service.session() === null
    ) {
      return;
    }
    if (this.isReadOnlyLifecycle()) {
      if (
        this.servicePremiereState !== "archived" ||
        this.currentNetworkState() !== "revealed"
      ) {
        return;
      }
      this.fencedSessionReadyForVerifiedReveal = false;
      this.interactionReady = false;
      this.clearInteractionTimers();
      this.dispatchJoinAfterBootstrap();
      this.service.dispose();
      return;
    }
    this.fencedSessionReadyForVerifiedReveal = false;
    this.interactionReady = true;
    this.hydrateOverlay();
    this.maybeApplyRevealSeek();
    this.dispatchJoinAfterBootstrap();
    this.heartbeatTimer ??= setInterval(
      () => void this.sendHeartbeat(),
      HEARTBEAT_INTERVAL_MS,
    );
  }

  private async sendHeartbeat(): Promise<void> {
    if (
      this.disposed ||
      !this.interactionReady ||
      this.heartbeatInFlight ||
      this.terminalFailure !== null ||
      this.isReadOnlyLifecycle()
    ) {
      return;
    }
    const networkStateAtRequest = this.currentNetworkState();
    this.heartbeatInFlight = true;
    try {
      const response = await this.service.heartbeat({
        visible: this.documentRef.visibilityState === "visible",
        observedSequence: this.observedSequence(),
      });
      if (
        this.disposed ||
        this.terminalFailure !== null ||
        this.isReadOnlyLifecycle()
      ) {
        return;
      }
      if (
        isStalePreRevealServiceProjection(
          networkStateAtRequest,
          this.currentNetworkState(),
          response.premiereState,
          response.checkpoints,
        )
      ) {
        return;
      }
      this.applyServiceProjection(response);
      this.hydrateOverlay();
      if (this.heartbeatRetryTimer !== null) {
        clearTimeout(this.heartbeatRetryTimer);
        this.heartbeatRetryTimer = null;
      }
    } catch (error) {
      if (
        this.disposed ||
        this.terminalFailure !== null ||
        this.isReadOnlyLifecycle()
      ) {
        return;
      }
      if (
        error instanceof ReplayPremiereServiceError &&
        error.code === "request_rejected" &&
        (error.status === 401 || error.status === 403)
      ) {
        this.interactionReady = false;
        this.clearInteractionTimers();
        void this.bootstrapInteractions();
      } else if (isRetryableServiceFailure(error)) {
        this.scheduleHeartbeatRetry();
      } else if (
        error instanceof ReplayPremiereServiceError &&
        error.code === "invalid_response"
      ) {
        this.latchFailure("integrity_failure", error);
      }
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private createSessionBootstrapInput(): ReplayPremiereSessionInput {
    const attributionToken = attributionFromLocation(this.windowRef.location);
    return {
      visible: this.documentRef.visibilityState === "visible",
      observedSequence: this.observedSequence(),
      ...(attributionToken === null ? {} : { attributionToken }),
    };
  }

  private applyServiceProjection(
    response:
      | ReplayPremiereServiceSessionResponse
      | ReplayPremiereServiceHeartbeatResponse,
  ): void {
    if (
      this.projection === null ||
      !isLifecycleCompatible(
        this.currentNetworkState(),
        response.premiereState,
      ) ||
      (this.reveal === null && hasOutcomeProjection(response.checkpoints))
    ) {
      this.latchFailure("integrity_failure");
      return;
    }
    this.servicePremiereState = response.premiereState;
    this.serviceCheckpoints = response.checkpoints;
    if ("incomingMoment" in response) {
      this.incomingMoment = response.incomingMoment;
    }
    if (this.isReadOnlyLifecycle()) {
      this.interactionReady = false;
      this.clearInteractionTimers();
    }
    this.maybeApplyRevealSeek();
  }

  /**
   * Applies the shared-moment reveal seek exactly once, and only when the
   * reveal is actually displayable — a seek during the live-view deferral
   * window would skip the still-playing ending.
   */
  private maybeApplyRevealSeek(): void {
    if (
      this.reveal === null ||
      this.incomingMoment === null ||
      this.revealSeekApplied ||
      this.isRevealDisplayDeferred()
    ) {
      return;
    }
    this.revealSeekApplied = true;
    this.options.onRevealSeek?.(this.incomingMoment.turn);
  }

  /**
   * Whether a verified reveal exists but must not be PRESENTED yet because
   * this session watched the premiere live and the viewer's rendered frame is
   * still behind the released stream (at real-speed pacing the map trails the
   * release clock by up to one chunk presentation span). Bounded by
   * construction: playback runs at presentation speed toward the already
   * released terminal sequence, and the deferral pump re-checks every 500 ms,
   * so the banner lands as the viewer's own playback reaches the end. Pages
   * with no live playback on screen (no frame yet — fresh revealed/archived
   * loads, or a session that never joined) never defer.
   */
  private isRevealDisplayDeferred(): boolean {
    if (
      this.reveal === null ||
      !this.preRevealLifecycleObserved ||
      this.terminalFailure !== null
    ) {
      return false;
    }
    const observed = this.latestFrame?.sequence ?? null;
    const released = this.playback.state().releasedThroughSequence;
    if (observed === null || released === null) {
      return false;
    }
    return observed < released;
  }

  private displayableReveal(): Readonly<ReplayPremiereReveal> | null {
    return this.reveal !== null && !this.isRevealDisplayDeferred()
      ? this.reveal
      : null;
  }

  /** Pre-reveal host suppression lifts only when the reveal may display. */
  private maybeLiftPreRevealSuppression(): void {
    if (this.isRevealDisplayDeferred()) return;
    this.documentRef.body.classList.remove(PRE_REVEAL_BODY_CLASS);
  }

  private ensureRevealDisplayPump(): void {
    if (this.revealDisplayTimer !== null || this.disposed) return;
    this.revealDisplayTimer = setInterval(() => {
      if (this.disposed) {
        this.clearRevealDisplayPump();
        return;
      }
      if (this.isRevealDisplayDeferred()) return;
      this.clearRevealDisplayPump();
      this.maybeLiftPreRevealSuppression();
      this.maybeApplyRevealSeek();
      this.hydrateOverlay();
    }, 500);
  }

  private clearRevealDisplayPump(): void {
    if (this.revealDisplayTimer !== null) {
      clearInterval(this.revealDisplayTimer);
      this.revealDisplayTimer = null;
    }
  }

  private currentNetworkState(): ReplayPremiereReadyProjection["state"] {
    return (
      this.networkTerminalState ??
      this.latestManifest?.state ??
      this.projection!.state
    );
  }

  private enterReadOnlyNetworkTerminal(
    state: "failed" | "cancelled" | "archived",
  ): void {
    this.networkTerminalState ??= state;
    this.interactionReady = false;
    this.clearInteractionTimers();
    this.clearClipPoll();
    if (this.projection !== null) {
      this.service.dispose();
      if (state === "failed" || state === "cancelled") {
        this.settleReady();
      }
    }
  }

  private isReadOnlyLifecycle(): boolean {
    return (
      this.servicePremiereState === "archived" ||
      this.servicePremiereState === "failed" ||
      this.servicePremiereState === "cancelled" ||
      this.projection?.state === "archived" ||
      this.latestManifest?.state === "archived" ||
      this.latestManifest?.state === "failed" ||
      this.latestManifest?.state === "cancelled" ||
      this.networkTerminalState === "archived" ||
      this.networkTerminalState === "failed" ||
      this.networkTerminalState === "cancelled"
    );
  }

  private isRevealVerificationPending(): boolean {
    const networkState = this.currentNetworkState();
    return (
      this.reveal === null &&
      (networkState === "revealed" || networkState === "archived")
    );
  }

  private dispatchJoinAfterBootstrap(): void {
    const verifiedArchived =
      this.projection !== null &&
      this.currentNetworkState() === "archived" &&
      this.reveal !== null;
    if (
      this.disposed ||
      this.joinDispatched ||
      this.projection === null ||
      (this.service.session() === null && !verifiedArchived) ||
      this.terminalFailure !== null
    ) {
      return;
    }
    if (this.isRevealVerificationPending()) {
      return;
    }
    if (
      this.currentNetworkState() === "failed" ||
      this.currentNetworkState() === "cancelled" ||
      this.servicePremiereState === "failed" ||
      this.servicePremiereState === "cancelled"
    ) {
      this.settleReady();
      return;
    }
    this.joinDispatched = true;
    try {
      this.options.onJoinReady({
        gameID: this.projection.gameStartInfo.gameID,
        gameStartInfo: this.projection.gameStartInfo,
        progressiveReplay: {
          controller: this.playback,
          playbackRate: this.projection.playbackRate,
        },
        premiereId: this.projection.premiereId,
        readyState: this.projection.state,
      });
    } catch (error) {
      this.latchFailure("runtime_failure", error);
      return;
    }
    this.settleReady();
  }

  private settleReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady();
  }

  private latchFailure(
    failure: "integrity_failure" | "runtime_failure",
    rejection?: unknown,
  ): void {
    if (this.disposed || this.terminalFailure !== null) return;
    this.terminalFailure = failure;
    this.recovery = null;
    this.interactionReady = false;
    this.clearInteractionTimers();
    this.clearCheckpointDeadline();
    this.clearClipPoll();
    this.network.dispose();
    this.service.dispose();
    this.hydrateOverlay();
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(
        rejection instanceof ReplayPremiereNetworkError
          ? rejection
          : new ReplayPremiereNetworkError(
              failure === "integrity_failure"
                ? "callback_failure"
                : "request_failed",
              false,
            ),
      );
    }
  }

  private assertInteractionWriteAllowed(): void {
    if (
      this.disposed ||
      this.terminalFailure !== null ||
      !this.interactionReady ||
      this.isReadOnlyLifecycle()
    ) {
      throw serviceError("request_rejected");
    }
  }

  private async strictInteractionWrite<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (
        error instanceof ReplayPremiereServiceError &&
        error.code === "invalid_response"
      ) {
        this.latchFailure("integrity_failure", error);
      }
      throw error;
    }
  }

  private overlayCallbacks(): ReplayPremiereOverlayCallbacks {
    return {
      onAddReminder: (request) => this.downloadReminder(request),
      onAmbientChange: ({ ambient }) => {
        this.ambient = ambient;
        this.hydrateOverlay();
      },
      onPrediction: async (request) => {
        this.assertInteractionWriteAllowed();
        const checkpoint = this.projection?.publicDefinition.checkpoints.find(
          (candidate) => candidate.id === request.checkpointId,
        );
        if (
          checkpoint === undefined ||
          checkpoint.sequence > this.observedSequence()
        ) {
          throw serviceError("request_rejected");
        }
        const response = await this.strictInteractionWrite(() =>
          this.service.submitPrediction(request),
        );
        if (
          this.reveal === null &&
          hasOutcomeProjection([response.checkpoint])
        ) {
          this.latchFailure("integrity_failure");
          throw serviceError("invalid_response");
        }
        this.replaceServiceCheckpoint(response.checkpoint);
        this.hydrateOverlay();
      },
      onMarker: async (request) => {
        this.assertInteractionWriteAllowed();
        if (
          request.premiereId !== this.options.premiereId ||
          request.sequence > this.observedSequence()
        ) {
          throw serviceError("request_rejected");
        }
        const response = await this.strictInteractionWrite(() =>
          this.service.submitReaction(request),
        );
        // Server-confirmed feedback: bump the viewer's own per-kind tally
        // (idempotent replays of the same moment+kind do not double-count)
        // and surface the acknowledgment line.
        if (!response.idempotent) {
          this.ownMarkCounts[request.kind] =
            (this.ownMarkCounts[request.kind] ?? 0) + 1;
        }
        this.lastMarkConfirmation = {
          kind: request.kind,
          turn: response.reaction.turn,
        };
        this.hydrateOverlay();
      },
      onShare: (request) => this.share(request),
      onCopySuggestedCaption: (request) => this.copyCaption(request),
      onExportCounterChallenge: (request) => this.copyCounterChallenge(request),
      onRequestClip: (request) => this.requestClip(request),
      onCopyClipText: (request) => this.copyClipText(request),
    };
  }

  private async share(request: ReplayPremiereShareRequest): Promise<void> {
    if (request.premiereId !== this.options.premiereId) {
      throw serviceError("invalid_configuration");
    }
    if (request.kind === "canonical" || request.sequence === null) {
      await this.copyText(this.canonicalUrl());
      return;
    }
    this.assertInteractionWriteAllowed();
    if (request.sequence > this.observedSequence()) {
      throw serviceError("request_rejected");
    }
    const sequence = request.sequence;
    const response = await this.strictInteractionWrite(() =>
      this.service.createShare({
        sequence,
      }),
    );
    if (
      !isSafeShareUrl(response.url, this.options.premiereId, this.windowRef)
    ) {
      throw serviceError("invalid_response");
    }
    await this.copyText(response.url);
  }

  private async copyCaption(
    request: ReplayPremiereCaptionRequest,
  ): Promise<void> {
    if (
      request.premiereId !== this.options.premiereId ||
      request.caption.length > 500
    ) {
      throw serviceError("invalid_configuration");
    }
    await this.copyText(request.caption);
  }

  private async copyCounterChallenge(
    request: ReplayPremiereCounterChallengeRequest,
  ): Promise<void> {
    if (
      request.premiereId !== this.options.premiereId ||
      this.reveal === null
    ) {
      throw serviceError("invalid_configuration");
    }
    const policies = request.policies.map(policyIdentityLabel).join("; ");
    const opponents = request.policies
      .map((policy) => policy.displayName)
      .join(", ");
    const text = translateText("replay_premiere.counter_challenge_template", {
      opponents,
      replayUrl: request.replayUrl,
      turn: request.turn ?? 0,
      sequence: request.sequence,
      map: request.mapName,
      format: request.matchFormat,
      policies,
    });
    await this.copyText(text);
  }

  /**
   * Request a downloadable clip for the moment currently on screen. Only the
   * `revealed` lifecycle admits a clip request (archived is server-410'd and
   * the interaction session is already disposed). Failures surface on the clip
   * status line — a clip is a non-authoritative cache, so a bad clip response
   * never latches a page-level integrity failure.
   */
  private async requestClip(request: ReplayPremiereClipRequest): Promise<void> {
    if (request.premiereId !== this.options.premiereId) {
      throw serviceError("invalid_configuration");
    }
    if (!this.clipGenerationEnabled) {
      throw serviceError("request_rejected");
    }
    this.assertInteractionWriteAllowed();
    if (this.currentNetworkState() !== "revealed") {
      throw serviceError("request_rejected");
    }
    const frame = this.latestFrame;
    if (frame === null || frame.sequence === null) {
      throw serviceError("request_rejected");
    }
    // Anchor on the runtime's own observed frame so sequence and turn are a
    // consistent pair (the server cross-checks turn against the released
    // context for the sequence).
    const anchor = { sequence: frame.sequence, turn: frame.turnNumber };
    this.clearClipPoll();
    this.clipStatus = "preparing";
    this.clipReady = null;
    this.hydrateOverlay();
    let status: ReplayPremiereClipStatusResponse;
    try {
      status = await this.service.requestClip(anchor);
    } catch (error) {
      this.applyClipFailure(error);
      return;
    }
    if (this.disposed || this.terminalFailure !== null) return;
    this.applyClipStatus(status);
  }

  private async copyClipText(
    request: ReplayPremiereClipCopyRequest,
  ): Promise<void> {
    if (
      request.premiereId !== this.options.premiereId ||
      this.clipReady === null
    ) {
      throw serviceError("invalid_configuration");
    }
    // Copy the exact server-composed text: the reply carries the watch url;
    // the caption carries the license lines and no url.
    const text =
      request.part === "reply"
        ? this.clipReady.social.firstReply
        : this.clipReady.social.caption;
    await this.copyText(text);
  }

  private applyClipStatus(status: ReplayPremiereClipStatusResponse): void {
    if (status.state === "ready" && status.ready !== null) {
      this.clipStatus = "ready";
      this.clipReady = status.ready;
      this.clearClipPoll();
      this.hydrateOverlay();
      return;
    }
    if (status.state === "pending") {
      this.clipStatus = "preparing";
      this.clipReady = null;
      this.clipPollBucket = status.bucket;
      this.clipPollAttempts = 0;
      this.clipPollStartedMs = Date.now();
      this.scheduleClipPoll(CLIP_POLL_INITIAL_MS);
      this.hydrateOverlay();
      return;
    }
    // "absent" is never a 200 body from the server; fail closed defensively.
    this.failClip();
  }

  private applyClipFailure(error: unknown): void {
    if (this.disposed) return;
    if (
      error instanceof ReplayPremiereServiceError &&
      (error.code === "request_failed" ||
        (error.code === "request_rejected" &&
          (error.publicCode === "PREMIERE_CAPACITY_EXCEEDED" ||
            error.publicCode === "PREMIERE_UNAVAILABLE")))
    ) {
      // 429/503/transport (busy, disk, quota) or a 404 that means the clip
      // service is unavailable: recoverable, "try again later".
      this.clipStatus = "busy";
    } else {
      this.clipStatus = "failed";
    }
    this.clipReady = null;
    this.clearClipPoll();
    this.hydrateOverlay();
  }

  private failClip(): void {
    this.clipStatus = "failed";
    this.clipReady = null;
    this.clearClipPoll();
    this.hydrateOverlay();
  }

  private scheduleClipPoll(delayMs: number): void {
    this.clearClipPollTimer();
    this.clipPollTimer = setTimeout(() => void this.pollClipStatus(), delayMs);
  }

  private async pollClipStatus(): Promise<void> {
    this.clipPollTimer = null;
    if (
      this.disposed ||
      this.terminalFailure !== null ||
      this.clipPollBucket === null
    ) {
      return;
    }
    // Leaving the revealed window (archived/failed) disposes the session and
    // ends clip availability; stop polling.
    if (
      this.currentNetworkState() !== "revealed" ||
      this.isReadOnlyLifecycle()
    ) {
      this.clearClipPoll();
      return;
    }
    const bucket = this.clipPollBucket;
    this.clipPollAttempts += 1;
    let status: ReplayPremiereClipStatusResponse;
    try {
      status = await this.service.readClipStatus(bucket);
    } catch (error) {
      if (this.disposed || this.terminalFailure !== null) return;
      if (
        error instanceof ReplayPremiereServiceError &&
        error.code === "request_failed"
      ) {
        // Transient transport (timeout/gateway): keep polling under the caps.
        this.continueClipPollOrTimeout();
        return;
      }
      // A 404 (absent — the render finished without producing a clip) or any
      // other rejection while the bucket was already pending is terminal.
      this.failClip();
      return;
    }
    if (this.disposed || this.terminalFailure !== null) return;
    if (status.state === "ready" && status.ready !== null) {
      this.clipStatus = "ready";
      this.clipReady = status.ready;
      this.clearClipPoll();
      this.hydrateOverlay();
      return;
    }
    if (status.state === "pending") {
      this.continueClipPollOrTimeout();
      return;
    }
    this.failClip();
  }

  private continueClipPollOrTimeout(): void {
    const elapsed = Date.now() - this.clipPollStartedMs;
    if (
      this.clipPollAttempts >= CLIP_POLL_MAX_ATTEMPTS ||
      elapsed >= CLIP_POLL_MAX_ELAPSED_MS
    ) {
      this.failClip();
      return;
    }
    const delay = Math.min(
      CLIP_POLL_MAX_MS,
      Math.round(
        CLIP_POLL_INITIAL_MS * CLIP_POLL_BACKOFF ** this.clipPollAttempts,
      ),
    );
    this.scheduleClipPoll(delay);
  }

  private clearClipPollTimer(): void {
    if (this.clipPollTimer !== null) {
      clearTimeout(this.clipPollTimer);
      this.clipPollTimer = null;
    }
  }

  private clearClipPoll(): void {
    this.clearClipPollTimer();
    this.clipPollBucket = null;
    this.clipPollAttempts = 0;
  }

  private applyClipGenerationCapability(enabled: boolean): void {
    if (this.disposed) return;
    this.clipGenerationEnabled = enabled;
    if (!enabled) {
      this.clearClipPoll();
      this.clipStatus = "idle";
      this.clipReady = null;
    }
    this.hydrateOverlay();
  }

  private clipView(): ReplayPremiereClipView {
    return {
      status: this.clipStatus,
      ready:
        this.clipReady === null
          ? null
          : { downloadUrl: this.clipReady.clipUrl },
    };
  }

  private replaceServiceCheckpoint(
    checkpoint: ReplayPremiereServiceCheckpoint,
  ): void {
    if (this.serviceCheckpoints === null) return;
    const next = this.serviceCheckpoints.map((candidate) =>
      candidate.id === checkpoint.id ? checkpoint : candidate,
    );
    if (next.length === 2) {
      this.serviceCheckpoints = [next[0], next[1]];
    }
  }

  private hydrateOverlay(): void {
    if (this.overlay === null || this.projection === null || this.disposed) {
      return;
    }
    // A deferred reveal becomes displayable the moment the viewer catches up;
    // every hydrate path (frames, manifests, the deferral pump) settles the
    // idempotent side effects here so no caller can miss the transition.
    if (this.reveal !== null && !this.isRevealDisplayDeferred()) {
      this.maybeLiftPreRevealSuppression();
      this.maybeApplyRevealSeek();
    }
    this.overlay.hydrate(this.buildOverlayModel());
  }

  private buildOverlayModel(): ReplayPremiereOverlayModel {
    if (this.projection === null) {
      throw new ReplayPremiereNetworkError("callback_failure", false);
    }
    const manifest = preRevealManifest(this.latestManifest);
    // Presentation uses the DISPLAYABLE reveal: during a live watch the
    // verified reveal is deferred until local playback reaches the end, so
    // the overlay keeps its live "playing" surface (plus the quiet verifying
    // status) instead of naming the winner over the still-playing ending.
    const displayReveal = this.displayableReveal();
    const revealPending =
      (this.latestManifest?.state === "revealed" ||
        this.latestManifest?.state === "archived") &&
      displayReveal === null;
    const networkState = this.currentNetworkState();
    const checkpointDeadlineElapsed =
      this.locallyClosedCheckpointId !== null &&
      (manifest?.state === "playing" ||
        (manifest?.state === "checkpoint" &&
          manifest.activeCheckpoint?.id === this.locallyClosedCheckpointId));
    const unprojectedState = this.terminalFailure
      ? "failed"
      : networkState === "failed" || networkState === "cancelled"
        ? networkState
        : displayReveal !== null &&
            (this.latestManifest?.state === "archived" ||
              this.servicePremiereState === "archived" ||
              networkState === "archived")
          ? "archived"
          : displayReveal !== null
            ? "revealed"
            : revealPending
              ? "playing"
              : presentationState(this.servicePremiereState, networkState);
    const policies = this.projection.provenance.seats.map(
      (seat): ReplayPremierePolicyView => ({
        seatId: seat.seatId,
        displayName: seat.displayName,
        policyIdentity: seat.policyIdentity as ReplayPremierePolicyIdentityView,
      }),
    );
    const viewedSequence = this.observedSequence();
    const authoritativeTerminalSequence =
      this.terminalFailure === null &&
      manifest !== null &&
      (manifest.state === "failed" || manifest.state === "cancelled")
        ? manifest.releasedThroughSequence
        : null;
    const currentTurn = this.latestFrame?.turnNumber ?? null;
    const projectedActiveCheckpointId =
      manifest?.activeCheckpoint?.id ??
      this.serviceCheckpoints?.find(
        (checkpoint) =>
          checkpoint.state === "open" &&
          checkpoint.id !== this.locallyClosedCheckpointId,
      )?.id ??
      null;
    const projectedActiveCheckpoint =
      projectedActiveCheckpointId === null
        ? undefined
        : this.projection.publicDefinition.checkpoints.find(
            (checkpoint) => checkpoint.id === projectedActiveCheckpointId,
          );
    // Soften only a checkpoint bound to the immutable public definition.
    // Unknown/mismatched checkpoint ids stay fail-closed in the overlay.
    const checkpointBoundaryPending =
      unprojectedState === "checkpoint" &&
      projectedActiveCheckpoint !== undefined &&
      projectedActiveCheckpoint.sequence > viewedSequence;
    const state =
      (checkpointDeadlineElapsed || checkpointBoundaryPending) &&
      unprojectedState === "checkpoint"
        ? "playing"
        : unprojectedState;
    return {
      premiereId: this.options.premiereId,
      state,
      title: this.projection.publicDefinition.title,
      description: this.projection.publicDefinition.spoilerNeutralDescription,
      sourceKind: this.projection.provenance.sourceKind,
      publicLabel: this.projection.provenance.publicLabel,
      scheduledAt: this.projection.publicDefinition.scheduledAt,
      actualStartAt: manifest?.actualStartAt ?? this.projection.actualStartAt,
      authoritativeNow:
        manifest?.serverNow ??
        (this.latestManifest?.state === "revealed" ||
        this.latestManifest?.state === "archived"
          ? this.latestManifest.revealedAt
          : this.projection.publicDefinition.scheduledAt),
      playbackRate: this.projection.playbackRate,
      mapName: this.projection.publicDefinition.map.label,
      matchFormat: this.projection.publicDefinition.matchFormat.label,
      policies,
      releasedSequence: authoritativeTerminalSequence ?? viewedSequence,
      currentTurn,
      checkpoints: this.overlayCheckpoints(policies, manifest),
      activeCheckpointId: checkpointDeadlineElapsed
        ? null
        : projectedActiveCheckpoint !== undefined &&
            projectedActiveCheckpoint.sequence <= viewedSequence
          ? projectedActiveCheckpoint.id
          : null,
      leaders: frameLeaders(this.latestFrame),
      warEvents: this.warFeed,
      markerCounts: { ...this.ownMarkCounts },
      markerConfirmation: this.lastMarkConfirmation,
      headlineEvent: this.headlineEvent,
      markerPolicySeatId: null,
      share: {
        canonicalUrl: this.canonicalUrl(),
        timestampUrl: viewedSequence < 0 ? null : this.canonicalUrl(),
        suggestedCaption:
          currentTurn === null
            ? translateText("replay_premiere.share_caption_premiere", {
                title: this.projection.publicDefinition.title,
              })
            : translateText("replay_premiere.share_caption", {
                title: this.projection.publicDefinition.title,
                turn: currentTurn,
              }),
      },
      reveal: displayReveal === null ? null : this.revealView(policies),
      recovery:
        this.recovery === null
          ? null
          : {
              attempt: this.recovery.attempt,
              retryInMs: this.recovery.retryInMs,
            },
      highlightedMoment: this.incomingMoment,
      revealPending,
      failureCode:
        this.terminalFailure ??
        (state === "cancelled" ? "cancelled_by_operator" : null),
      ambient: this.ambient,
      buffering: this.buffering,
      canPredict: this.interactionReady && !this.isReadOnlyLifecycle(),
      canMark: this.interactionReady && !this.isReadOnlyLifecycle(),
      canShare: this.interactionReady && !this.isReadOnlyLifecycle(),
      canExportCounterChallenge:
        displayReveal !== null &&
        networkState !== "failed" &&
        networkState !== "cancelled",
      // The entire live clip block stays absent unless this process explicitly
      // advertised a constructed generation service. Durable archived clips
      // use the separate archive view and are unaffected by this capability.
      clip:
        this.clipGenerationEnabled &&
        (state === "revealed" || state === "archived")
          ? this.clipView()
          : null,
      canRequestClip:
        this.clipGenerationEnabled &&
        state === "revealed" &&
        this.interactionReady &&
        !this.isReadOnlyLifecycle(),
    };
  }

  private overlayCheckpoints(
    policies: readonly ReplayPremierePolicyView[],
    manifest: ReplayPremierePreRevealManifest | null,
  ): ReplayPremiereCheckpointPair {
    const definitions = this.projection!.publicDefinition.checkpoints;
    const toView = (
      definition: (typeof definitions)[number],
    ): ReplayPremiereCheckpointView => {
      const serviceView = this.serviceCheckpoints?.find(
        (checkpoint) => checkpoint.id === definition.id,
      );
      const active =
        manifest?.activeCheckpoint?.id === definition.id
          ? manifest.activeCheckpoint
          : null;
      const optionSeatIds =
        serviceView?.optionSeatIds ?? active?.optionSeatIds ?? [];
      const selectedSeatId =
        serviceView?.participantPrediction?.selectedSeatId ?? null;
      const distribution = serviceView?.distribution;
      const total = serviceView?.totalPredictions ?? 0;
      const deadlineElapsed = definition.id === this.locallyClosedCheckpointId;
      const observed = definition.sequence <= this.observedSequence();
      return {
        id: definition.id,
        sequence: definition.sequence,
        state: !observed
          ? "pending"
          : deadlineElapsed
            ? "closed"
            : serviceView?.state === "open"
              ? selectedSeatId === null
                ? "open"
                : "submitted"
              : serviceView?.state === "closed"
                ? "closed"
                : active?.state === "open"
                  ? "open"
                  : active?.state === "closed" ||
                      (manifest !== null &&
                        manifest.releasedThroughSequence >= definition.sequence)
                    ? "closed"
                    : "pending",
        closesAt: observed
          ? (serviceView?.closesAt ?? active?.closesAt ?? null)
          : null,
        options: observed
          ? optionSeatIds.flatMap((seatId) => {
              const policy = policies.find(
                (candidate) => candidate.seatId === seatId,
              );
              return policy === undefined
                ? []
                : [{ seatId, displayName: policy.displayName }];
            })
          : [],
        selectedSeatId: observed ? selectedSeatId : null,
        distribution:
          !observed ||
          distribution === null ||
          distribution === undefined ||
          total <= 0
            ? undefined
            : Object.entries(distribution).map(([seatId, count]) => ({
                seatId,
                percent: Math.round((count / total) * 100),
              })),
      };
    };
    return [toView(definitions[0]), toView(definitions[1])];
  }

  private revealView(
    policies: readonly ReplayPremierePolicyView[],
  ): ReplayPremiereOverlayModel["reveal"] {
    if (this.reveal === null) return null;
    const winners = this.reveal.verifiedAuthoritativeResult.seats.filter(
      (seat) => seat.won,
    );
    const results = this.resultsView(policies);
    return winners.length === 1
      ? { outcome: "winner", winnerSeatId: winners[0].seatId, results }
      : { outcome: "void", winnerSeatId: null, results };
  }

  /**
   * Builds the aggregate-only results summary from the verified authoritative
   * result and the service checkpoint views. It carries no per-viewer data;
   * the marker tally is server-owned, so live it is empty and the durable
   * archived page fills it in from the persisted summary.
   */
  private resultsView(
    policies: readonly ReplayPremierePolicyView[],
  ): ReplayPremiereResultsSummaryView | null {
    if (this.reveal === null) return null;
    const result = this.reveal.verifiedAuthoritativeResult;
    const nameOf = (seatId: string): string =>
      result.seats.find((seat) => seat.seatId === seatId)?.displayName ??
      policies.find((policy) => policy.seatId === seatId)?.displayName ??
      seatId;
    const definitions = this.projection!.publicDefinition.checkpoints;
    const predictions = definitions.map((definition) => {
      const serviceView = this.serviceCheckpoints?.find(
        (checkpoint) => checkpoint.id === definition.id,
      );
      const total = serviceView?.totalPredictions ?? 0;
      const distribution = serviceView?.distribution ?? null;
      const options = (serviceView?.optionSeatIds ?? []).map((seatId) => ({
        seatId,
        displayName: nameOf(seatId),
        percent:
          total > 0 && distribution !== null
            ? ((distribution[seatId] ?? 0) / total) * 100
            : 0,
      }));
      const crowd = serviceView?.crowdAccuracy ?? null;
      const correctPercent =
        crowd !== null && crowd.totalPredictions > 0
          ? (crowd.correctPredictions / crowd.totalPredictions) * 100
          : null;
      return {
        checkpointId: definition.id,
        sequence: definition.sequence,
        correctPercent,
        totalPredictions: total,
        options,
      };
    });
    return {
      turnCount: result.turnCount,
      standings: result.seats.map((seat) => ({
        seatId: seat.seatId,
        displayName: seat.displayName,
        won: seat.won,
      })),
      predictions,
      markers: [],
    };
  }

  private observedSequence(): number {
    // Dispatch may run thousands of turns ahead of the simulation during a
    // reload. Only a frame emitted after GameView/render is viewer-observed.
    return this.latestFrame?.sequence ?? -1;
  }

  private canonicalUrl(): string {
    return new URL(
      `/premiere/${this.options.premiereId}`,
      this.windowRef.location.origin,
    ).toString();
  }

  private clearInteractionTimers(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.sessionRetryTimer !== null) {
      clearTimeout(this.sessionRetryTimer);
      this.sessionRetryTimer = null;
    }
    if (this.heartbeatRetryTimer !== null) {
      clearTimeout(this.heartbeatRetryTimer);
      this.heartbeatRetryTimer = null;
    }
  }

  private scheduleHeartbeatRetry(): void {
    if (
      this.heartbeatRetryTimer !== null ||
      this.disposed ||
      !this.interactionReady ||
      this.terminalFailure !== null ||
      this.isReadOnlyLifecycle()
    ) {
      return;
    }
    this.heartbeatRetryTimer = setTimeout(() => {
      this.heartbeatRetryTimer = null;
      void this.sendHeartbeat();
    }, INTERACTION_RECOVERY_RETRY_MS);
  }

  private reconcileCheckpointDeadline(
    manifest: Readonly<ReplayPremiereManifest>,
  ): void {
    this.clearCheckpointDeadline();
    if (!("serverNow" in manifest)) {
      this.locallyClosedCheckpointId = null;
      return;
    }
    if (manifest.state !== "checkpoint") {
      // Keep the just-closed checkpoint latched while the interaction service
      // catches up with the verified playing manifest. The next checkpoint or
      // any terminal state replaces this local projection.
      if (
        manifest.state === "playing" &&
        this.locallyClosedCheckpointId !== null
      ) {
        return;
      }
      this.locallyClosedCheckpointId = null;
      return;
    }
    if (manifest.activeCheckpoint === null) {
      this.locallyClosedCheckpointId = null;
      return;
    }
    const checkpoint = manifest.activeCheckpoint;
    if (this.locallyClosedCheckpointId === checkpoint.id) return;
    this.locallyClosedCheckpointId = null;
    const remainingMs = Math.max(
      0,
      Date.parse(checkpoint.closesAt) - Date.parse(manifest.serverNow),
    );
    this.checkpointDeadlineTimer = setTimeout(() => {
      this.checkpointDeadlineTimer = null;
      if (this.disposed || this.terminalFailure !== null) return;
      const latest = preRevealManifest(this.latestManifest);
      if (
        latest?.state !== "checkpoint" ||
        latest.activeCheckpoint?.id !== checkpoint.id
      ) {
        return;
      }
      this.locallyClosedCheckpointId = checkpoint.id;
      this.hydrateOverlay();
      // syncOnce deduplicates with an in-flight poll. A failed prompt is left
      // to the network controller's bounded retry loop and never opens a
      // second polling loop.
      void this.network.syncOnce().catch(() => undefined);
    }, remainingMs);
  }

  private clearCheckpointDeadline(): void {
    if (this.checkpointDeadlineTimer !== null) {
      clearTimeout(this.checkpointDeadlineTimer);
      this.checkpointDeadlineTimer = null;
    }
  }
}

interface ReplayPremiereFramePlayer {
  playerID: string;
  displayName: string;
  tilesOwned: number;
}

/** Continuous starvation must outlive this before "Buffering live…" shows. */
const BUFFERING_DISPLAY_GRACE_MS = 1_500;

const WAR_EVENT_KINDS = new Set([
  "attack",
  "alliance",
  "betrayal",
  "nuke",
  "conquest",
  "emote",
  "chat",
]);
const MAX_WAR_EVENTS_PER_FRAME = 12;
/** Newest-first entries kept for the overlay's battle feed. */
const MAX_WAR_FEED_ENTRIES = 8;

interface ReplayPremiereFrame {
  sequence: number | null;
  turnNumber: number;
  players: ReplayPremiereFramePlayer[];
  warEvents: ReplayPremiereWarEventView[];
}

interface ReplayPremiereVerifiedBinding {
  premiereId: string;
  checkpoints: ReadonlyMap<string, { sequence: number }>;
  policyIdentities: ReadonlyMap<string, ReplayPremierePolicyIdentityView>;
  fingerprint: string;
}

function bindingFromProjection(
  projection: Readonly<ReplayPremiereReadyProjection>,
  expectedPremiereId: string,
): ReplayPremiereVerifiedBinding {
  const checkpoints = projection.publicDefinition.checkpoints;
  const seats = projection.provenance.seats;
  if (
    projection.premiereId !== expectedPremiereId ||
    checkpoints[0].id === checkpoints[1].id ||
    new Set(seats.map((seat) => seat.seatId)).size !== seats.length ||
    seats.length !== projection.publicDefinition.matchFormat.seatCount
  ) {
    throw serviceError("invalid_response");
  }
  const checkpointMap = new Map(
    checkpoints.map((checkpoint) => [
      checkpoint.id,
      { sequence: checkpoint.sequence },
    ]),
  );
  const policyIdentities = new Map(
    seats.map((seat) => [
      seat.seatId,
      seat.policyIdentity as ReplayPremierePolicyIdentityView,
    ]),
  );
  return {
    premiereId: projection.premiereId,
    checkpoints: checkpointMap,
    policyIdentities,
    fingerprint: JSON.stringify({
      premiereId: projection.premiereId,
      gameId: projection.gameStartInfo.gameID,
      checkpoints: checkpoints.map(({ id, sequence }) => ({ id, sequence })),
      seats: seats.map(({ seatId, policyIdentity }) => ({
        seatId,
        policyIdentity,
      })),
    }),
  };
}

function sameVerifiedBinding(
  left: ReplayPremiereVerifiedBinding,
  right: ReplayPremiereVerifiedBinding,
): boolean {
  return left.fingerprint === right.fingerprint;
}

function samePrediction(
  left: z.infer<typeof predictionSchema>,
  right: z.infer<typeof predictionSchema>,
): boolean {
  return (
    left.premiereId === right.premiereId &&
    left.checkpointId === right.checkpointId &&
    left.participantId === right.participantId &&
    left.selectedSeatId === right.selectedSeatId &&
    left.submittedAt === right.submittedAt &&
    left.lockedAt === right.lockedAt
  );
}

function samePolicyIdentity(
  actual: ReplayPremierePolicyIdentityView | null,
  expected: ReplayPremierePolicyIdentityView | null,
): boolean {
  if (actual === null || expected === null) return actual === expected;
  if (actual.namespace !== expected.namespace) return false;
  if (
    actual.namespace === "softmax_policy_version" &&
    expected.namespace === "softmax_policy_version"
  ) {
    return (
      actual.policyVersionId === expected.policyVersionId &&
      actual.policyName === expected.policyName &&
      actual.serverAssignedVersion === expected.serverAssignedVersion
    );
  }
  return (
    actual.namespace === "local_manifest" &&
    expected.namespace === "local_manifest" &&
    actual.manifestName === expected.manifestName &&
    actual.declaredVersion === expected.declaredVersion &&
    actual.manifestSha256 === expected.manifestSha256 &&
    actual.contentSha256 === expected.contentSha256
  );
}

function hasOutcomeProjection(
  checkpoints: readonly ReplayPremiereServiceCheckpoint[],
): boolean {
  return checkpoints.some(
    (checkpoint) =>
      checkpoint.resolution !== null || checkpoint.crowdAccuracy !== null,
  );
}

function isRevealBoundToProjection(
  reveal: Readonly<ReplayPremiereReveal>,
  projection: Readonly<ReplayPremiereReadyProjection>,
): boolean {
  const result = reveal.verifiedAuthoritativeResult;
  const expectedSeats = new Map(
    projection.provenance.seats.map((seat) => [seat.seatId, seat.displayName]),
  );
  return (
    reveal.state === "revealed" &&
    reveal.premiereId === projection.premiereId &&
    result.gameId === projection.gameStartInfo.gameID &&
    result.seats.length === expectedSeats.size &&
    new Set(result.seats.map((seat) => seat.seatId)).size ===
      result.seats.length &&
    result.seats.every(
      (seat) => expectedSeats.get(seat.seatId) === seat.displayName,
    ) &&
    JSON.stringify(reveal.provenance) === JSON.stringify(projection.provenance)
  );
}

function isLifecycleCompatible(
  networkState: ReplayPremiereReadyProjection["state"],
  serviceState: ReplayPremiereLifecycleState,
): boolean {
  switch (networkState) {
    case "scheduled":
      return serviceState !== "draft";
    case "playing":
      return serviceState !== "draft" && serviceState !== "scheduled";
    case "checkpoint":
      return serviceState !== "draft" && serviceState !== "scheduled";
    case "revealed":
      return serviceState === "revealed" || serviceState === "archived";
    case "archived":
      return serviceState === "archived";
    case "failed":
      return serviceState === "failed" || serviceState === "archived";
    case "cancelled":
      return serviceState === "cancelled" || serviceState === "archived";
  }
}

function isStalePreRevealServiceProjection(
  networkStateAtRequest: ReplayPremiereReadyProjection["state"],
  currentNetworkState: ReplayPremiereReadyProjection["state"],
  serviceState: ReplayPremiereLifecycleState,
  checkpoints: readonly ReplayPremiereServiceCheckpoint[],
): boolean {
  // The interaction response is a snapshot taken when its request began. A
  // reveal pointer may become visible while that request is in flight. Fence
  // only an outcome-free response that was valid for the request's pre-reveal
  // phase; responses already invalid at request time still fail closed.
  const requestWasPreReveal =
    networkStateAtRequest === "playing" ||
    networkStateAtRequest === "checkpoint";
  const responseIsPreReveal =
    serviceState === "playing" || serviceState === "checkpoint";
  return (
    requestWasPreReveal &&
    currentNetworkState === "revealed" &&
    responseIsPreReveal &&
    isLifecycleCompatible(networkStateAtRequest, serviceState) &&
    !hasOutcomeProjection(checkpoints)
  );
}

function presentationState(
  serviceState: ReplayPremiereLifecycleState | null,
  networkState: ReplayPremiereReadyProjection["state"],
): ReplayPremiereOverlayModel["state"] {
  if (networkState === "failed" || networkState === "cancelled") {
    return networkState;
  }
  if (serviceState === "failed" || serviceState === "cancelled") {
    return serviceState;
  }
  if (serviceState === "checkpoint") return "checkpoint";
  if (serviceState === "playing") return "playing";
  if (serviceState === "draft" || serviceState === "scheduled") {
    return "scheduled";
  }
  if (networkState === "archived") return "playing";
  return networkState;
}

function isRetryableServiceFailure(error: unknown): boolean {
  return (
    error instanceof ReplayPremiereServiceError &&
    (error.code === "request_failed" ||
      (error.code === "request_rejected" &&
        (error.publicCode === "PREMIERE_CAPACITY_EXCEEDED" ||
          error.publicCode === "PREMIERE_UNAVAILABLE")))
  );
}

function isTransientInteractionStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

function logInteractionBootstrapFailure(error: unknown): void {
  let code = "unexpected_failure";
  let status = "none";
  let publicCode = "none";
  let phase = "unexpected";
  try {
    if (error instanceof ReplayPremiereServiceError) {
      code = isServiceErrorCode(error.code) ? error.code : "unexpected_failure";
      status = isHttpStatus(error.status) ? String(error.status) : "none";
      publicCode = publicErrorCodeSchema.safeParse(error.publicCode).success
        ? String(error.publicCode)
        : "none";
      phase = isServiceErrorPhase(error.phase) ? error.phase : "unspecified";
    }
  } catch {
    code = "unexpected_failure";
    status = "none";
    publicCode = "none";
    phase = "unexpected";
  }
  console.error(
    `Replay Premiere interaction bootstrap failed code=${code} status=${status} publicCode=${publicCode} phase=${phase}`,
  );
}

function isServiceErrorCode(
  value: unknown,
): value is ReplayPremiereServiceErrorCode {
  return (
    value === "invalid_configuration" ||
    value === "session_required" ||
    value === "request_failed" ||
    value === "request_rejected" ||
    value === "invalid_response" ||
    value === "disposed"
  );
}

function isServiceErrorPhase(
  value: unknown,
): value is ReplayPremiereServiceErrorPhase {
  return (
    value === "constructor" ||
    value === "input" ||
    value === "fetch_rejection" ||
    value === "timeout" ||
    value === "response_policy" ||
    value === "response_read" ||
    value === "response_schema" ||
    value === "response_status" ||
    value === "response_binding" ||
    value === "unspecified"
  );
}

function isHttpStatus(value: unknown): value is number {
  return (
    Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
  );
}

export function parseReplayPremiereRoute(pathname: string): string | null {
  const match = pathname.match(/^\/premiere\/(prem_[a-z0-9]{16,32})$/);
  return match?.[1] ?? null;
}

export function attributionFromLocation(location: Location): string | null {
  const query = new URLSearchParams(location.search);
  const attribution = query.get("attribution");
  const moment = query.get("moment");
  if (
    attribution === null ||
    moment === null ||
    !ATTRIBUTION_PATTERN.test(attribution) ||
    !SHARE_ID_PATTERN.test(moment)
  ) {
    return null;
  }
  return attribution;
}

export function isSafeShareUrl(
  value: string,
  premiereId: string,
  windowRef: Window = window,
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.origin === windowRef.location.origin &&
    url.pathname === `/premiere/${premiereId}` &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    SHARE_ID_PATTERN.test(url.searchParams.get("moment") ?? "") &&
    ATTRIBUTION_PATTERN.test(url.searchParams.get("attribution") ?? "") &&
    [...url.searchParams.keys()].every(
      (key) => key === "moment" || key === "attribution",
    )
  );
}

function preRevealManifest(
  manifest: Readonly<ReplayPremiereManifest> | null,
): ReplayPremierePreRevealManifest | null {
  return manifest !== null && "serverNow" in manifest ? manifest : null;
}

function parseReplayPremiereFrame(value: unknown): ReplayPremiereFrame | null {
  if (!isRecord(value)) return null;
  const sequence = value.sequence;
  const turnNumber = value.turnNumber;
  const players = value.players;
  if (
    (sequence !== null &&
      (!Number.isSafeInteger(sequence) || Number(sequence) < 0)) ||
    !Number.isSafeInteger(turnNumber) ||
    Number(turnNumber) < 0 ||
    !Array.isArray(players) ||
    players.length > 64
  ) {
    return null;
  }
  const parsedPlayers: ReplayPremiereFramePlayer[] = [];
  for (const player of players) {
    if (
      !isRecord(player) ||
      typeof player.playerID !== "string" ||
      !OPAQUE_ID_PATTERN.test(player.playerID) ||
      typeof player.displayName !== "string" ||
      player.displayName.length === 0 ||
      player.displayName.length > 256 ||
      !Number.isSafeInteger(player.tilesOwned) ||
      Number(player.tilesOwned) < 0
    ) {
      return null;
    }
    parsedPlayers.push({
      playerID: player.playerID,
      displayName: player.displayName,
      tilesOwned: Number(player.tilesOwned),
    });
  }
  return {
    sequence: sequence === null ? null : Number(sequence),
    turnNumber: Number(turnNumber),
    players: parsedPlayers,
    warEvents: parseFrameWarEvents(value.warEvents),
  };
}

/**
 * Lenient parse of the spoiler-safe war narrative riding the frame event:
 * malformed entries are dropped (never a page-level failure — the feed is a
 * display garnish, not an integrity surface).
 */
function parseFrameWarEvents(value: unknown): ReplayPremiereWarEventView[] {
  if (!Array.isArray(value)) return [];
  const events: ReplayPremiereWarEventView[] = [];
  for (const entry of value.slice(0, MAX_WAR_EVENTS_PER_FRAME)) {
    if (!isRecord(entry)) continue;
    const { kind, actor, target, detail, turn } = entry;
    if (
      typeof kind !== "string" ||
      !WAR_EVENT_KINDS.has(kind) ||
      typeof actor !== "string" ||
      actor.length === 0 ||
      actor.length > 256 ||
      (target !== null && typeof target !== "string") ||
      (typeof target === "string" && target.length > 256) ||
      (detail !== null && typeof detail !== "string") ||
      (typeof detail === "string" && detail.length > 256) ||
      !Number.isSafeInteger(turn) ||
      Number(turn) < 0
    ) {
      continue;
    }
    events.push({
      kind: kind as ReplayPremiereWarEventView["kind"],
      actor,
      target: (target ?? null) as string | null,
      detail: (detail ?? null) as string | null,
      turn: Number(turn),
    });
  }
  return events;
}

function frameLeaders(
  frame: ReplayPremiereFrame | null,
): ReplayPremiereOverlayModel["leaders"] {
  if (frame === null) return [];
  const total = frame.players.reduce(
    (sum, player) => sum + player.tilesOwned,
    0,
  );
  return [...frame.players]
    .sort(
      (left, right) =>
        right.tilesOwned - left.tilesOwned ||
        left.displayName.localeCompare(right.displayName),
    )
    .slice(0, 3)
    .map((player) => ({
      seatId: player.playerID,
      displayName: player.displayName,
      territoryPercent: total <= 0 ? 0 : (player.tilesOwned / total) * 100,
    }));
}

function policyIdentityLabel(policy: ReplayPremierePolicyView): string {
  const identity = policy.policyIdentity;
  return identity.namespace === "softmax_policy_version"
    ? translateText("replay_premiere.counter_policy_softmax", {
        displayName: policy.displayName,
        policyName: identity.policyName,
        version: identity.serverAssignedVersion,
        id: identity.policyVersionId,
      })
    : translateText("replay_premiere.counter_policy_local", {
        displayName: policy.displayName,
        manifestName: identity.manifestName,
        version: identity.declaredVersion,
        hash: identity.contentSha256,
      });
}

function parseSessionInput(
  input: ReplayPremiereSessionInput,
): ReplayPremiereSessionInput {
  const observedSequence = parseObservedSequence(input.observedSequence);
  const attributionToken = input.attributionToken;
  if (
    attributionToken !== undefined &&
    !ATTRIBUTION_PATTERN.test(attributionToken)
  ) {
    throw serviceError("invalid_configuration");
  }
  return {
    visible: input.visible === true,
    observedSequence,
    ...(attributionToken === undefined ? {} : { attributionToken }),
  };
}

function parseObservedSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < -1 || value > 10_000_000) {
    throw serviceError("invalid_configuration");
  }
  return value;
}

function sameSessionInput(
  left: ReplayPremiereSessionInput,
  right: ReplayPremiereSessionInput,
): boolean {
  return (
    left.visible === right.visible &&
    left.observedSequence === right.observedSequence &&
    left.attributionToken === right.attributionToken
  );
}

async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw serviceError(
      "invalid_response",
      response.status,
      null,
      "response_read",
    );
  }
  if (response.body === null) {
    throw serviceError(
      "invalid_response",
      response.status,
      null,
      "response_read",
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw serviceError("request_failed", null, null, "response_read");
      }
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel();
        throw serviceError(
          "invalid_response",
          response.status,
          null,
          "response_read",
        );
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    if (error instanceof ReplayPremiereServiceError) throw error;
    throw serviceError("request_failed", null, null, "response_read");
  }
  try {
    return JSON.parse(chunks.join("")) as unknown;
  } catch {
    throw serviceError(
      "invalid_response",
      response.status,
      null,
      "response_read",
    );
  }
}

function hasNoStoreCachePolicy(headers: Headers): boolean {
  const cacheControl = headers.get("cache-control") ?? "";
  return cacheControl
    .split(",")
    .map((directive) => directive.trim().toLowerCase())
    .includes("no-store");
}

function parseSameOrigin(value: string | undefined): string {
  const candidate =
    value ??
    (typeof globalThis.location === "object" ? globalThis.location.origin : "");
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw serviceError("invalid_configuration");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.origin !== candidate ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw serviceError("invalid_configuration");
  }
  return parsed.origin;
}

function isBoundedJsonValue(value: unknown): boolean {
  let nodes = 0;
  const visit = (current: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) return false;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return typeof current !== "string" || current.length <= 8_192;
    }
    if (typeof current === "number") return Number.isFinite(current);
    if (Array.isArray(current)) {
      return (
        current.length <= 1_000 &&
        current.every((entry) => visit(entry, depth + 1))
      );
    }
    if (!isRecord(current) || Object.keys(current).length > 1_000) return false;
    return Object.entries(current).every(
      ([key, entry]) => key.length <= 256 && visit(entry, depth + 1),
    );
  };
  return visit(value, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw serviceError("invalid_configuration");
  }
  return value;
}

function serviceError(
  code: ReplayPremiereServiceErrorCode,
  status: number | null = null,
  publicCode: ReplayPremierePublicErrorCode | null = null,
  phase: ReplayPremiereServiceErrorPhase = "unspecified",
): ReplayPremiereServiceError {
  return new ReplayPremiereServiceError(code, status, publicCode, phase);
}

function serviceErrorWithPhase(
  error: unknown,
  phase: ReplayPremiereServiceErrorPhase,
): ReplayPremiereServiceError {
  return error instanceof ReplayPremiereServiceError
    ? serviceError(error.code, error.status, error.publicCode, phase)
    : serviceError("invalid_configuration", null, null, phase);
}

async function defaultCopyText(text: string): Promise<void> {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > MAX_CLIPBOARD_TEXT_LENGTH ||
    navigator.clipboard === undefined
  ) {
    throw serviceError("invalid_configuration");
  }
  await navigator.clipboard.writeText(text);
}

function defaultDownloadReminder(
  request: ReplayPremiereReminderRequest,
  documentRef: Document,
): void {
  const start = Date.parse(request.scheduledAt);
  if (!Number.isFinite(start)) throw serviceError("invalid_configuration");
  const end = start + 60 * 60 * 1_000;
  const summary = translateText("replay_premiere.reminder_title", {
    title: request.title,
  });
  const description = translateText("replay_premiere.reminder_description");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Proxy War//Replay Premiere//EN",
    "BEGIN:VEVENT",
    `UID:${request.premiereId}@proxywar`,
    `DTSTAMP:${icsTimestamp(Date.now())}`,
    `DTSTART:${icsTimestamp(start)}`,
    `DTEND:${icsTimestamp(end)}`,
    `SUMMARY:${escapeIcs(summary)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    ...(request.canonicalUrl === null
      ? []
      : [`URL:${escapeIcs(request.canonicalUrl)}`]),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const url = URL.createObjectURL(
    new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" }),
  );
  const link = documentRef.createElement("a");
  link.href = url;
  link.download = "proxy-war-replay-premiere.ics";
  link.hidden = true;
  documentRef.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function icsTimestamp(value: number): string {
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
