import { z } from "zod";
import type { GameStartInfo } from "../core/Schemas";
import {
  ReplayPremiereNetworkController,
  ReplayPremiereNetworkError,
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
  type ReplayPremiereCounterChallengeRequest,
  type ReplayPremiereHighlightedMomentView,
  type ReplayPremiereMarkerRequest,
  type ReplayPremiereOverlayCallbacks,
  type ReplayPremiereOverlayHandle,
  type ReplayPremiereOverlayModel,
  type ReplayPremierePolicyIdentityView,
  type ReplayPremierePolicyView,
  type ReplayPremierePredictionRequest,
  type ReplayPremiereReminderRequest,
  type ReplayPremiereShareRequest,
} from "./ReplayPremiereOverlay";
import {
  ReplayPremierePlaybackController,
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
const INTERACTION_REQUEST_TIMEOUT_MS = 8_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const SESSION_RETRY_MS = 5_000;
const MAX_CLIPBOARD_TEXT_LENGTH = 16_384;
const PRE_REVEAL_BODY_CLASS = "replay-premiere-pre-reveal";

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
      30_000,
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
    const body = {
      visible: input.visible === true,
      observedSequence: parseObservedSequence(input.observedSequence),
    };
    const response = await this.postJson(
      `sessions/${session.id}/heartbeat`,
      body,
      this.createIdempotencyKey(),
      heartbeatResponseSchema,
      200,
      true,
    );
    this.assertHeartbeatResponseBound(response, session);
    this.currentSession = response.session;
    return response;
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
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
      const contentType = response.headers.get("content-type") ?? "";
      if (
        !JSON_CONTENT_TYPE_PATTERN.test(contentType.trim()) ||
        !hasNoStoreCachePolicy(response.headers)
      ) {
        throw serviceError(
          "invalid_response",
          response.status,
          null,
          "response_policy",
        );
      }
      const value = await readBoundedJsonResponse(
        response,
        this.maxResponseBytes,
        requestController.signal,
      );
      if (response.status !== expectedStatus) {
        const publicFailure = publicErrorResponseSchema.safeParse(value);
        if (!publicFailure.success) {
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
  documentRef?: Document;
  windowRef?: Window;
}

export interface ReplayPremiereRuntimeOptions {
  premiereId: string;
  onJoinReady: (request: ReplayPremiereJoinRequest) => void;
  onProjectionReady?: (
    projection: Readonly<ReplayPremiereReadyProjection>,
  ) => void;
  onRevealSeek?: (turn: number) => void;
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
  private interactionReady = false;
  private sessionBootstrapInFlight = false;
  private heartbeatInFlight = false;
  private joinDispatched = false;
  private revealSeekApplied = false;
  private ambient = false;
  private readySettled = false;
  private started = false;
  private disposed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sessionRetryTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.documentRef.body.classList.remove(PRE_REVEAL_BODY_CLASS);
    this.hydrateOverlay();
    if (this.incomingMoment !== null && !this.revealSeekApplied) {
      this.revealSeekApplied = true;
      this.options.onRevealSeek?.(this.incomingMoment.turn);
    }
    if (this.currentNetworkState() === "archived") {
      this.servicePremiereState = "archived";
      this.interactionReady = false;
      this.clearInteractionTimers();
      this.service.dispose();
      this.dispatchJoinAfterBootstrap();
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
      this.documentRef.body.classList.remove(PRE_REVEAL_BODY_CLASS);
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
    this.hydrateOverlay();
  };

  private readonly onClientPlaybackError = (): void => {
    if (this.disposed) return;
    this.latchFailure("runtime_failure");
  };

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
      this.applyServiceProjection(response);
      if (this.terminalFailure !== null) return;
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
          SESSION_RETRY_MS,
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
      this.applyServiceProjection(response);
      this.hydrateOverlay();
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
        (error.status === 401 || error.status === 403)
      ) {
        this.interactionReady = false;
        this.clearInteractionTimers();
        void this.bootstrapInteractions();
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
    if (
      this.reveal !== null &&
      this.incomingMoment !== null &&
      !this.revealSeekApplied
    ) {
      this.revealSeekApplied = true;
      this.options.onRevealSeek?.(this.incomingMoment.turn);
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
    if (
      (this.projection.state === "revealed" ||
        this.projection.state === "archived") &&
      this.reveal === null
    ) {
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

  private overlayCallbacks(): ReplayPremiereOverlayCallbacks {
    return {
      onAddReminder: (request) => this.downloadReminder(request),
      onAmbientChange: ({ ambient }) => {
        this.ambient = ambient;
        this.hydrateOverlay();
      },
      onPrediction: async (request) => {
        this.assertInteractionWriteAllowed();
        const response = await this.service.submitPrediction(request);
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
        await this.service.submitReaction(request);
      },
      onShare: (request) => this.share(request),
      onCopySuggestedCaption: (request) => this.copyCaption(request),
      onExportCounterChallenge: (request) => this.copyCounterChallenge(request),
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
    const response = await this.service.createShare({
      sequence: request.sequence,
    });
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
    this.overlay.hydrate(this.buildOverlayModel());
  }

  private buildOverlayModel(): ReplayPremiereOverlayModel {
    if (this.projection === null) {
      throw new ReplayPremiereNetworkError("callback_failure", false);
    }
    const manifest = preRevealManifest(this.latestManifest);
    const revealPending =
      (this.latestManifest?.state === "revealed" ||
        this.latestManifest?.state === "archived") &&
      this.reveal === null;
    const networkState = this.currentNetworkState();
    const state = this.terminalFailure
      ? "failed"
      : networkState === "failed" || networkState === "cancelled"
        ? networkState
        : this.reveal !== null &&
            (this.latestManifest?.state === "archived" ||
              this.servicePremiereState === "archived" ||
              networkState === "archived")
          ? "archived"
          : this.reveal !== null
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
    const currentTurn = this.latestFrame?.turnNumber ?? null;
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
      releasedSequence: viewedSequence,
      currentTurn,
      checkpoints: this.overlayCheckpoints(policies, manifest),
      activeCheckpointId:
        manifest?.activeCheckpoint?.id ??
        this.serviceCheckpoints?.find(
          (checkpoint) => checkpoint.state === "open",
        )?.id ??
        null,
      leaders: frameLeaders(this.latestFrame),
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
      reveal: this.revealView(),
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
      canPredict: this.interactionReady && !this.isReadOnlyLifecycle(),
      canMark: this.interactionReady && !this.isReadOnlyLifecycle(),
      canShare: this.interactionReady && !this.isReadOnlyLifecycle(),
      canExportCounterChallenge:
        this.reveal !== null &&
        networkState !== "failed" &&
        networkState !== "cancelled",
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
      return {
        id: definition.id,
        sequence: definition.sequence,
        state:
          serviceView?.state === "open"
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
        closesAt: serviceView?.closesAt ?? active?.closesAt ?? null,
        options: optionSeatIds.flatMap((seatId) => {
          const policy = policies.find(
            (candidate) => candidate.seatId === seatId,
          );
          return policy === undefined
            ? []
            : [{ seatId, displayName: policy.displayName }];
        }),
        selectedSeatId,
        distribution:
          distribution === null || distribution === undefined || total <= 0
            ? undefined
            : Object.entries(distribution).map(([seatId, count]) => ({
                seatId,
                percent: Math.round((count / total) * 100),
              })),
      };
    };
    return [toView(definitions[0]), toView(definitions[1])];
  }

  private revealView(): ReplayPremiereOverlayModel["reveal"] {
    if (this.reveal === null) return null;
    const winners = this.reveal.verifiedAuthoritativeResult.seats.filter(
      (seat) => seat.won,
    );
    return winners.length === 1
      ? { outcome: "winner", winnerSeatId: winners[0].seatId }
      : { outcome: "void", winnerSeatId: null };
  }

  private observedSequence(): number {
    return (
      this.playback.state().lastDispatchedSequence ??
      this.latestFrame?.sequence ??
      -1
    );
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
  }
}

interface ReplayPremiereFramePlayer {
  playerID: string;
  displayName: string;
  tilesOwned: number;
}

interface ReplayPremiereFrame {
  sequence: number | null;
  turnNumber: number;
  players: ReplayPremiereFramePlayer[];
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
        (error.status === 429 ||
          error.status === 503 ||
          error.publicCode === "PREMIERE_CAPACITY_EXCEEDED" ||
          error.publicCode === "PREMIERE_UNAVAILABLE")))
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
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599;
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
  const turnNumber = value.turnNumber;
  const players = value.players;
  if (
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
    sequence: null,
    turnNumber: Number(turnNumber),
    players: parsedPlayers,
  };
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
