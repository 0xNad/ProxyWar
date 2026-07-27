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
  type ReplayPremiereResultsPredictionView,
  type ReplayPremiereResultsSummaryView,
  type ReplayPremiereShareManualCopyReason,
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
const INTERACTION_CONTRACT_HEADER = "X-ProxyWar-Premiere-Interactions";
const INTERACTION_CONTRACT_VERSION = "4";
const HEARTBEAT_INTERVAL_MS = 10_000;
const INTERACTION_RECOVERY_RETRY_MS = 1_000;
// Exponential-backoff ceiling for session/heartbeat recovery retries
// (doubling from `INTERACTION_RECOVERY_RETRY_MS` — same scheme
// `ReplayPremiereNetworkController.runLoop` already uses for its own
// manifest/reveal retry loop). A fixed 1s retry with no cap is what let a
// single transient rejection escalate into a self-sustaining retry storm:
// every attempt is itself a new server request, so a client stuck retrying
// once a second never gives the very rate limit it tripped a chance to
// clear, and — since limiter buckets can be shared (e.g. by IP) — can starve
// other clients' legitimate traffic too. See `scheduleHeartbeatRetry` and
// `bootstrapInteractions`.
const INTERACTION_RECOVERY_MAX_RETRY_MS = 30_000;
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
const CLIP_ANCHOR_BUCKET_TURNS = 10;
const CLIP_MIN_ANCHOR_TURN = 50;
const CLIP_POST_ANCHOR_TURNS = 150;

interface ReplayPremiereShareDeliveryState {
  attemptId: number;
  participantId: string;
  phase: "creating" | "copying" | "copied" | "manual";
  url: string | null;
  manualCopyReason: ReplayPremiereShareManualCopyReason | null;
}

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
const REACTION_KINDS = [
  "turning_point",
  "smart",
  "mistake",
  "betrayal",
  "clip_this",
] as const;
const reactionKindSchema = z.enum(REACTION_KINDS);
const reactionCountsSchema = z
  .object({
    turning_point: nonNegativeIntegerSchema,
    smart: nonNegativeIntegerSchema,
    mistake: nonNegativeIntegerSchema,
    betrayal: nonNegativeIntegerSchema,
    clip_this: nonNegativeIntegerSchema,
  })
  .strict();
const ownReactionAnchorSchema = z
  .object({
    id: z.string().regex(REACTION_ID_PATTERN),
    sequence: nonNegativeIntegerSchema,
    turn: nonNegativeIntegerSchema,
    kind: reactionKindSchema,
  })
  .strict();
const reactionSummarySchema = z
  .object({
    totalReactions: nonNegativeIntegerSchema,
    distinctParticipants: nonNegativeIntegerSchema,
    byKind: reactionCountsSchema,
    ownByKind: reactionCountsSchema.nullable(),
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
const clipEligibilitySchema = z
  .object({
    generationEnabled: z.boolean(),
    renderableThroughTurn: nonNegativeIntegerSchema.nullable(),
    sourceComplete: z.boolean(),
  })
  .strict();
const sessionResponseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    csrfToken: z.string().min(1).max(512).regex(CSRF_PATTERN),
    session: viewerSessionSchema,
    premiereState: premiereLifecycleStateSchema,
    checkpoints: checkpointPairSchema,
    incomingMoment: incomingMomentSchema.nullable(),
  })
  .strict();
const sessionResponseV2Schema = sessionResponseV1Schema.extend({
  schemaVersion: z.literal(2),
  reactionSummary: reactionSummarySchema,
  clipsEnabled: z.boolean(),
  // Accept the short-lived pre-v4 additive shape so a newly loaded client can
  // recover through either side of the corrective rolling deployment.
  clipEligibility: clipEligibilitySchema.optional(),
});
const sessionResponseV3Schema = sessionResponseV2Schema.extend({
  schemaVersion: z.literal(3),
  latestOwnReaction: ownReactionAnchorSchema.nullable(),
});
const sessionResponseV4Schema = sessionResponseV3Schema.extend({
  schemaVersion: z.literal(4),
  clipEligibility: clipEligibilitySchema,
});
const sessionResponseSchema = z
  .discriminatedUnion("schemaVersion", [
    sessionResponseV1Schema,
    sessionResponseV2Schema,
    sessionResponseV3Schema,
    sessionResponseV4Schema,
  ])
  .transform((response) => {
    switch (response.schemaVersion) {
      case 1:
        return {
          ...response,
          reactionSummary: null,
          clipsEnabled: null,
          clipEligibility: null,
        };
      case 2:
      case 3:
        return {
          ...response,
          clipEligibility: response.clipEligibility ?? null,
        };
      case 4:
        return response;
    }
  });
const heartbeatResponseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    session: viewerSessionSchema,
    idempotent: z.boolean(),
    persisted: z.boolean(),
    premiereState: premiereLifecycleStateSchema,
    checkpoints: checkpointPairSchema,
  })
  .strict();
const heartbeatResponseV2Schema = heartbeatResponseV1Schema.extend({
  schemaVersion: z.literal(2),
  reactionSummary: reactionSummarySchema,
  clipsEnabled: z.boolean(),
  clipEligibility: clipEligibilitySchema.optional(),
});
const heartbeatResponseV3Schema = heartbeatResponseV2Schema.extend({
  schemaVersion: z.literal(3),
  latestOwnReaction: ownReactionAnchorSchema.nullable(),
});
const heartbeatResponseV4Schema = heartbeatResponseV3Schema.extend({
  schemaVersion: z.literal(4),
  clipEligibility: clipEligibilitySchema,
});
const heartbeatResponseSchema = z
  .discriminatedUnion("schemaVersion", [
    heartbeatResponseV1Schema,
    heartbeatResponseV2Schema,
    heartbeatResponseV3Schema,
    heartbeatResponseV4Schema,
  ])
  .transform((response) => {
    switch (response.schemaVersion) {
      case 1:
        return {
          ...response,
          reactionSummary: null,
          clipsEnabled: null,
          clipEligibility: null,
        };
      case 2:
      case 3:
        return {
          ...response,
          clipEligibility: response.clipEligibility ?? null,
        };
      case 4:
        return response;
    }
  });
const predictionResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    prediction: predictionSchema,
    idempotent: z.boolean(),
    checkpoint: checkpointViewSchema,
  })
  .strict();
// ---------------------------------------------------------------------------
// Prediction market — LMSR (Logarithmic Market Scoring Rule), server-
// authoritative, ONE continuous market per premiere (not per checkpoint,
// per Main's pivot off the earlier pari-mutuel design). Every seat trades
// as an integer-chip share priced 0..100 for the whole live phase of the
// premiere — NOT gated to a checkpoint window; checkpoints are content
// beats the UI highlights, they gate nothing (see `BettingOverlay.ts`).
// Price moves with real trades plus a server-side synthetic crowd. One
// settlement at reveal: winning shares pay 100/share. The client only
// mirrors and validates the shape — see
// `src/client/prediction/wagering/lmsr.ts` for the pure pricing math this
// mirrors.
// ---------------------------------------------------------------------------
const marketPositionSchema = z
  .object({
    seatId: opaqueIdSchema,
    shares: nonNegativeIntegerSchema,
    costBasis: nonNegativeIntegerSchema,
    currentValue: nonNegativeIntegerSchema,
    unrealizedPnl: z.number().int().safe(),
  })
  .strict();
const marketStateSchema = z
  .object({
    outcomeSeatIds: z.array(opaqueIdSchema).min(2).max(64),
    q: z.array(z.number().int().safe()),
    b: z.number().positive().safe(),
    prices: z.array(z.number().min(0).max(100)),
    status: z.enum(["open", "settled"]),
    winnerSeatId: opaqueIdSchema.nullable(),
    // Anti-replay freshness bound the client echoes back on its NEXT market
    // order (see `submitMarketOrder`) — never cached across multiple orders.
    liveVisibleSequence: nonNegativeIntegerSchema,
    positions: z.array(marketPositionSchema).nullable(),
    // The caller's own available ledger balance — the SOLE money-
    // authoritative number for bankroll display and buy-stake validation
    // (see `src/client/prediction/wagering/**`, which carries no local
    // debit/credit arithmetic of its own). Null only when this view was
    // read anonymously (no participant bound); an authenticated read
    // (`market/me`, or any trade response) always carries a number.
    balance: nonNegativeIntegerSchema.nullable(),
  })
  .strict();
const marketStateResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    market: marketStateSchema,
  })
  .strict();
const tradeSchema = z
  .object({
    id: z.string().min(1).max(128),
    premiereId: z.string().regex(PREMIERE_ID_PATTERN),
    participantId: z.string().regex(PARTICIPANT_ID_PATTERN),
    participantKind: z.enum(["real", "synthetic"]),
    seatId: opaqueIdSchema,
    side: z.enum(["buy", "sell"]),
    shares: z.number().int().positive().safe(),
    chips: nonNegativeIntegerSchema,
    avgPrice: z.number().min(0).max(100),
    executedAt: canonicalTimestampSchema,
    sequence: nonNegativeIntegerSchema,
    idempotencyKey: z.string().min(16).max(128),
  })
  .strict();
const tradeResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    trade: tradeSchema,
    idempotent: z.boolean(),
    market: marketStateSchema,
  })
  .strict();
const reactionSchema = z
  .object({
    id: z.string().regex(REACTION_ID_PATTERN),
    premiereId: z.string().regex(PREMIERE_ID_PATTERN),
    participantId: z.string().regex(PARTICIPANT_ID_PATTERN),
    sequence: nonNegativeIntegerSchema,
    turn: nonNegativeIntegerSchema,
    kind: reactionKindSchema,
    policyIdentity: policyIdentitySchema.nullable(),
    eventContext: z.unknown().refine((value) => isBoundedJsonValue(value)),
    createdAt: canonicalTimestampSchema,
  })
  .strict();
const reactionResponseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    reaction: reactionSchema,
    idempotent: z.boolean(),
  })
  .strict();
const reactionResponseV2Schema = reactionResponseV1Schema.extend({
  schemaVersion: z.literal(2),
  reactionSummary: reactionSummarySchema,
  clipsEnabled: z.boolean(),
  clipEligibility: clipEligibilitySchema.optional(),
});
const reactionResponseV3Schema = reactionResponseV2Schema.extend({
  schemaVersion: z.literal(3),
  latestOwnReaction: ownReactionAnchorSchema.nullable(),
});
const reactionResponseV4Schema = reactionResponseV3Schema.extend({
  schemaVersion: z.literal(4),
  clipEligibility: clipEligibilitySchema,
});
const reactionResponseSchema = z
  .discriminatedUnion("schemaVersion", [
    reactionResponseV1Schema,
    reactionResponseV2Schema,
    reactionResponseV3Schema,
    reactionResponseV4Schema,
  ])
  .transform((response) => {
    switch (response.schemaVersion) {
      case 1:
        return {
          ...response,
          reactionSummary: null,
          clipsEnabled: null,
          clipEligibility: null,
        };
      case 2:
      case 3:
        return {
          ...response,
          clipEligibility: response.clipEligibility ?? null,
        };
      case 4:
        return response;
    }
  });
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
export type ReplayPremiereServiceMarketState = z.infer<
  typeof marketStateSchema
>;
export type ReplayPremiereServiceMarketStateResponse = z.infer<
  typeof marketStateResponseSchema
>;
export type ReplayPremiereServiceTradeResponse = z.infer<
  typeof tradeResponseSchema
>;
export type ReplayPremiereServiceReactionResponse = z.infer<
  typeof reactionResponseSchema
>;
export type ReplayPremiereClipEligibility = z.infer<
  typeof clipEligibilitySchema
>;
export type ReplayPremiereServiceReactionSummary = z.infer<
  typeof reactionSummarySchema
>;
export type ReplayPremiereServiceOwnReactionAnchor = z.infer<
  typeof ownReactionAnchorSchema
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
    // Server-suggested backoff floor from a `Retry-After` response header
    // (seconds, per RFC 9110 §10.2.3 — the HTTP-date form is not honored,
    // only the delay-seconds form). `null` when absent/unparseable; callers
    // fall back to their own backoff schedule.
    public readonly retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = "ReplayPremiereServiceError";
  }
}

export interface ReplayPremiereTradeRequest {
  premiereId: string;
  seatId: string;
  side: "buy" | "sell";
  amount: number;
  /** 0..100 — ceiling for a buy, floor for a sell. The crowd trades the same live book. */
  limitPrice: number;
  /**
   * The freshest `market.liveVisibleSequence` the caller has observed — an
   * anti-replay freshness bound, NOT a checkpoint reference. The server
   * rejects with 410 `order_sequence_unreleased` if this is ahead of what
   * it has actually released. Never reuse a value across multiple orders.
   */
  sequence: number;
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
  private currentReactionSummary: ReplayPremiereServiceReactionSummary | null =
    null;
  private currentParticipantReactionSummary: ReplayPremiereServiceReactionSummary | null =
    null;
  private currentReactionParticipantId: string | null = null;
  private clipsEnabled: boolean | null = null;
  private clipEligibility: ReplayPremiereClipEligibility | null = null;
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
      true,
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
    const previousParticipantId = this.currentSession?.participantId ?? null;
    this.csrfToken = response.csrfToken;
    this.currentSession = response.session;
    this.mergeCurrentReactionSummary(
      response.reactionSummary,
      response.session.participantId,
    );
    if (
      previousParticipantId !== null &&
      previousParticipantId !== response.session.participantId
    ) {
      // Operation keys are participant-private. A recovered guest identity
      // must not reuse semantic keys that were accepted for the old viewer.
      this.semanticIdempotencyKeys.clear();
    }
    this.mergeClipEligibility(response.clipsEnabled, response.clipEligibility);
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
        true,
      );
      this.assertHeartbeatResponseBound(response, session);
      this.currentSession = response.session;
      this.mergeCurrentReactionSummary(
        response.reactionSummary,
        response.session.participantId,
      );
      this.mergeClipEligibility(
        response.clipsEnabled,
        response.clipEligibility,
      );
      this.pendingHeartbeat = null;
      return response;
    } catch (error) {
      if (!isRetryableServiceFailure(error)) {
        this.pendingHeartbeat = null;
      }
      throw error;
    }
  }

  /**
   * Reattaches to a session created in an earlier page load (persisted
   * client-side) by heartbeating it directly, instead of minting a new
   * session record via `startSession`. `maxSessionsPerParticipant` /
   * `maxSessionCreatesPerParticipantPerMinute` are small, permanent, per-
   * participant server-side caps — every ordinary page reload calling
   * `startSession` again burns one, and a handful of reloads across a
   * single premiere is enough to exhaust the cap for good. Resuming avoids
   * creating a record at all for the overwhelmingly common case (the
   * session is still alive server-side).
   */
  async resumeSession(
    persisted: PersistedReplayPremiereSession,
    input: { visible: boolean; observedSequence: number },
  ): Promise<ReplayPremiereServiceHeartbeatResponse> {
    this.assertActive();
    this.csrfToken = persisted.csrfToken;
    const requestedBody = {
      visible: input.visible === true,
      observedSequence: parseObservedSequence(input.observedSequence),
    };
    const response = await this.postJson(
      `sessions/${persisted.sessionId}/heartbeat`,
      requestedBody,
      this.createIdempotencyKey(),
      heartbeatResponseSchema,
      200,
      true,
      true,
    );
    this.assertResumeResponseBound(response, persisted);
    this.currentSession = response.session;
    this.mergeCurrentReactionSummary(
      response.reactionSummary,
      response.session.participantId,
    );
    this.mergeClipEligibility(response.clipsEnabled, response.clipEligibility);
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

  /**
   * LMSR market order write (buy or sell). Not part of
   * `ReplayPremiereOverlayCallbacks` — trading renders its own dedicated
   * overlay (see `src/client/prediction/wagering/**`), so this is a plain
   * public method: callable from that overlay's event handlers AND
   * directly from a programmatic caller (synthetic crowd / persona
   * testing), same integrity path either way. Unlike the old one-stake-
   * per-checkpoint wager, a participant may submit MANY orders across the
   * life of the market — each gets its own fresh idempotency key (a
   * network-level retry of ONE order reuses it; a second, genuinely
   * different order never does).
   */
  async submitMarketOrder(
    input: ReplayPremiereTradeRequest,
  ): Promise<ReplayPremiereServiceTradeResponse> {
    const session = this.requireSession();
    if (
      input.premiereId !== this.options.premiereId ||
      !OPAQUE_ID_PATTERN.test(input.seatId) ||
      (input.side !== "buy" && input.side !== "sell") ||
      !Number.isSafeInteger(input.amount) ||
      input.amount <= 0 ||
      !Number.isFinite(input.limitPrice) ||
      input.limitPrice < 0 ||
      input.limitPrice > 100 ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 0
    ) {
      throw serviceError("invalid_configuration");
    }
    const body = {
      sessionId: session.id,
      seatId: input.seatId,
      side: input.side,
      amount: input.amount,
      limitPrice: input.limitPrice,
      sequence: input.sequence,
    };
    const response = await this.postJson(
      "market-orders",
      body,
      // Each order is a genuinely distinct action (unlike the old
      // deterministic-per-checkpoint wager key) — a fresh key per call, so
      // only a network-level retry of THIS call reuses it.
      this.createIdempotencyKey(),
      tradeResponseSchema,
      200,
      true,
    );
    this.assertTradeResponseBound(response, input, session);
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
    // Bind a non-idempotent acceptance to the state visible when THIS request
    // began. A newer heartbeat or concurrent reaction may legitimately update
    // the client before this response arrives.
    const summaryAtRequest = this.currentParticipantReactionSummary;
    const response = await this.postJson(
      "reactions",
      body,
      this.semanticKey(`reaction:${input.sequence}:${input.kind}`),
      reactionResponseSchema,
      200,
      true,
      true,
    );
    const sessionStillCurrent =
      this.currentSession?.participantId === session.participantId;
    this.assertReactionResponseBound(
      response,
      input,
      session,
      summaryAtRequest,
      sessionStillCurrent,
    );
    if (!sessionStillCurrent) {
      return response;
    }
    this.mergeCurrentReactionSummary(
      response.reactionSummary,
      session.participantId,
    );
    this.mergeClipEligibility(response.clipsEnabled, response.clipEligibility);
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

  /**
   * Cheap, participant-agnostic poll read for the live odds ticker:
   * current LMSR prices for the whole premiere market, no session/CSRF
   * scoping, safe to poll on an interval independent of the heartbeat
   * cadence. The market is visible for the entire life of the premiere,
   * not gated behind having traded. Any per-participant `positions` on
   * the response are best-effort for an anonymous poll — a trade's own
   * response is the authoritative source for the viewer's own position.
   */
  async readMarketState(): Promise<ReplayPremiereServiceMarketStateResponse> {
    this.assertActive();
    const response = await this.getJson(
      "market",
      marketStateResponseSchema,
      200,
    );
    if (
      response.market.q.length !== response.market.outcomeSeatIds.length ||
      response.market.prices.length !== response.market.outcomeSeatIds.length
    ) {
      throw serviceError("invalid_response");
    }
    return response;
  }

  /**
   * Authenticated participant read: this caller's own open positions AND
   * available ledger balance — the sole money authority for the client
   * (see `src/client/prediction/wagering/**`, which keeps no local
   * debit/credit/payout arithmetic of its own; every figure it shows is
   * this response, verbatim). Same auth discipline as every write route
   * (guest cookie + CSRF + strict Origin, via {@link authenticatedGetJson})
   * — never silently degrades to the anonymous view when creds are
   * missing; the server 401s, and so does this call (via
   * {@link requireSession}'s client-side short-circuit) before a request
   * is even sent.
   */
  async readMarketSelf(): Promise<ReplayPremiereServiceMarketStateResponse> {
    this.requireSession();
    const response = await this.authenticatedGetJson(
      "market/me",
      marketStateResponseSchema,
      200,
    );
    if (
      response.market.q.length !== response.market.outcomeSeatIds.length ||
      response.market.prices.length !== response.market.outcomeSeatIds.length
    ) {
      throw serviceError("invalid_response");
    }
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
    negotiateInteractionContract = false,
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
              ...(negotiateInteractionContract
                ? {
                    [INTERACTION_CONTRACT_HEADER]: INTERACTION_CONTRACT_VERSION,
                  }
                : {}),
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
          parseRetryAfterMs(response.headers.get("retry-after")),
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

  /**
   * Same-origin GET with the identical transient-status, no-store
   * application-policy, response-size, and timeout discipline as
   * {@link postJson} / {@link getJson}, but stamped with the guest CSRF
   * token like every write — for a read that returns one participant's
   * own private data (`market/me`) and is never exempt from that
   * discipline. Throws `session_required` before sending anything if
   * there is no session yet, exactly like `postJson`'s `requireCsrf` path.
   */
  private async authenticatedGetJson<T>(
    route: string,
    schema: z.ZodType<T>,
    expectedStatus: number,
  ): Promise<T> {
    this.assertActive();
    if (this.csrfToken === null) {
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
            method: "GET",
            headers: {
              Accept: "application/json",
              "x-csrf-token": this.csrfToken,
            },
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
    this.assertReactionSummaryBound(
      response.reactionSummary,
      session.participantId,
    );
    this.assertOwnReactionAnchorBound(
      response.schemaVersion === 3 || response.schemaVersion === 4
        ? response.latestOwnReaction
        : null,
      response.reactionSummary,
      response.schemaVersion,
    );
    this.assertClipEligibilityBound(
      response.clipsEnabled,
      response.clipEligibility,
    );
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
    this.assertReactionSummaryBound(
      response.reactionSummary,
      current.participantId,
    );
    this.assertOwnReactionAnchorBound(
      response.schemaVersion === 3 || response.schemaVersion === 4
        ? response.latestOwnReaction
        : null,
      response.reactionSummary,
      response.schemaVersion,
    );
    this.assertClipEligibilityBound(
      response.clipsEnabled,
      response.clipEligibility,
    );
  }

  /**
   * Same discipline as {@link assertHeartbeatResponseBound}, narrowed for
   * resume: there is no in-memory prior session to check monotonic growth
   * against (this JS context has never seen this session before), so only
   * identity binding plus each field's own internal consistency is
   * checked. A stale/foreign/tampered persisted id is caught here or by
   * `ownedSession` server-side (404) before anything is trusted.
   */
  private assertResumeResponseBound(
    response: ReplayPremiereServiceHeartbeatResponse,
    persisted: PersistedReplayPremiereSession,
  ): void {
    if (
      response.session.id !== persisted.sessionId ||
      response.session.participantId !== persisted.participantId ||
      response.session.premiereId !== this.options.premiereId ||
      response.session.visibleDurationMs >
        response.session.connectedDurationMs ||
      Date.parse(response.session.lastHeartbeatAt) <
        Date.parse(response.session.startedAt)
    ) {
      throw serviceError("invalid_response");
    }
    this.assertCheckpointsBound(
      response.checkpoints,
      response.session.participantId,
    );
    this.assertReactionSummaryBound(
      response.reactionSummary,
      response.session.participantId,
    );
    this.assertOwnReactionAnchorBound(
      response.schemaVersion === 3 || response.schemaVersion === 4
        ? response.latestOwnReaction
        : null,
      response.reactionSummary,
      response.schemaVersion,
    );
    this.assertClipEligibilityBound(
      response.clipsEnabled,
      response.clipEligibility,
    );
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

  private assertTradeResponseBound(
    response: ReplayPremiereServiceTradeResponse,
    input: ReplayPremiereTradeRequest,
    session: ReplayPremiereServiceSession,
  ): void {
    const trade = response.trade;
    // 1 point of chip-rounding slop tolerated between the requested limit
    // and the executed average price — the server fills in whole chips,
    // the limit is a continuous 0..100 figure.
    if (
      trade.premiereId !== this.options.premiereId ||
      trade.participantId !== session.participantId ||
      trade.sequence !== input.sequence ||
      trade.seatId !== input.seatId ||
      trade.side !== input.side ||
      (trade.side === "buy" && trade.avgPrice > input.limitPrice + 1) ||
      (trade.side === "sell" && trade.avgPrice < input.limitPrice - 1)
    ) {
      throw serviceError("invalid_response");
    }
    this.assertMarketStateBound(response.market);
  }

  private assertMarketStateBound(
    market: ReplayPremiereServiceMarketState,
  ): void {
    const binding = this.requireBinding();
    const uniqueSeats = new Set(market.outcomeSeatIds);
    const seatsAreBound = market.outcomeSeatIds.every((seatId) =>
      binding.policyIdentities.has(seatId),
    );
    const pricesSum = market.prices.reduce((sum, price) => sum + price, 0);
    if (
      uniqueSeats.size !== market.outcomeSeatIds.length ||
      !seatsAreBound ||
      market.q.length !== market.outcomeSeatIds.length ||
      market.prices.length !== market.outcomeSeatIds.length ||
      Math.abs(pricesSum - 100) > 0.5 ||
      (market.status === "settled") !== (market.winnerSeatId !== null) ||
      (market.winnerSeatId !== null &&
        !uniqueSeats.has(market.winnerSeatId)) ||
      (market.positions !== null &&
        market.positions.some(
          (position) => !uniqueSeats.has(position.seatId),
        ))
    ) {
      throw serviceError("invalid_response");
    }
  }

  private assertReactionResponseBound(
    response: ReplayPremiereServiceReactionResponse,
    input: ReplayPremiereMarkerRequest,
    session: ReplayPremiereServiceSession,
    summaryAtRequest: ReplayPremiereServiceReactionSummary | null,
    compareWithCurrent: boolean,
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
    this.assertReactionSummaryBound(
      response.reactionSummary,
      session.participantId,
      compareWithCurrent,
    );
    this.assertOwnReactionAnchorBound(
      response.schemaVersion === 3 || response.schemaVersion === 4
        ? response.latestOwnReaction
        : null,
      response.reactionSummary,
      response.schemaVersion,
    );
    if (compareWithCurrent) {
      this.assertClipEligibilityBound(
        response.clipsEnabled,
        response.clipEligibility,
      );
    }
    if (
      response.reactionSummary !== null &&
      (response.reactionSummary.ownByKind === null ||
        response.reactionSummary.byKind[reaction.kind] < 1 ||
        response.reactionSummary.ownByKind[reaction.kind] < 1 ||
        (!response.idempotent &&
          !reactionSummaryProvesIncrement(
            response.reactionSummary,
            summaryAtRequest,
            reaction.kind,
          )))
    ) {
      throw serviceError("invalid_response");
    }
  }

  private assertReactionSummaryBound(
    summary: ReplayPremiereServiceReactionSummary | null,
    participantId: string,
    compareWithCurrent = true,
  ): void {
    if (summary === null) return;
    const identityChanged =
      this.currentReactionParticipantId !== null &&
      this.currentReactionParticipantId !== participantId;
    if (
      !isConsistentReactionSummary(summary) ||
      summary.ownByKind === null ||
      (compareWithCurrent &&
        this.currentReactionSummary !== null &&
        comparePublicReactionSummaries(summary, this.currentReactionSummary) ===
          "incomparable") ||
      (compareWithCurrent &&
        !identityChanged &&
        this.currentParticipantReactionSummary !== null &&
        compareReactionSummaries(
          summary,
          this.currentParticipantReactionSummary,
        ) === "incomparable")
    ) {
      throw serviceError("invalid_response");
    }
  }

  private assertOwnReactionAnchorBound(
    anchor: ReplayPremiereServiceOwnReactionAnchor | null,
    summary: ReplayPremiereServiceReactionSummary | null,
    schemaVersion: 1 | 2 | 3 | 4,
  ): void {
    // v1/v2 carry no private anchor. Callers normalize their omission to null,
    // but v3+ null is authoritative evidence that this participant has never
    // submitted a mark.
    if (schemaVersion < 3) {
      if (anchor !== null) throw serviceError("invalid_response");
      return;
    }
    if (summary?.ownByKind === null || summary === null) {
      throw serviceError("invalid_response");
    }
    const ownTotal = REACTION_KINDS.reduce(
      (total, kind) => total + summary.ownByKind![kind],
      0,
    );
    if (
      (anchor === null && ownTotal !== 0) ||
      (anchor !== null &&
        (ownTotal === 0 || summary.ownByKind[anchor.kind] < 1))
    ) {
      throw serviceError("invalid_response");
    }
  }

  private mergeCurrentReactionSummary(
    summary: ReplayPremiereServiceReactionSummary | null,
    participantId: string,
  ): void {
    const identityChanged =
      this.currentReactionParticipantId !== null &&
      this.currentReactionParticipantId !== participantId;
    this.currentReactionParticipantId = participantId;
    if (identityChanged) {
      this.currentParticipantReactionSummary = summary;
      if (summary === null) {
        if (this.currentReactionSummary !== null) {
          this.currentReactionSummary = {
            ...this.currentReactionSummary,
            ownByKind: null,
          };
        }
        return;
      }
      if (this.currentReactionSummary === null) {
        this.currentReactionSummary = summary;
        return;
      }
      const publicOrder = comparePublicReactionSummaries(
        summary,
        this.currentReactionSummary,
      );
      if (publicOrder === "incomparable") {
        throw serviceError("invalid_response");
      }
      this.currentReactionSummary =
        publicOrder === "newer"
          ? summary
          : {
              ...this.currentReactionSummary,
              ownByKind: { ...summary.ownByKind! },
            };
      return;
    }
    if (summary === null) return;
    const participantOrder =
      this.currentParticipantReactionSummary === null
        ? "newer"
        : compareReactionSummaries(
            summary,
            this.currentParticipantReactionSummary,
          );
    const publicOrder =
      this.currentReactionSummary === null
        ? "newer"
        : comparePublicReactionSummaries(summary, this.currentReactionSummary);
    const previousPrivate = this.currentReactionSummary?.ownByKind ?? null;
    if (
      this.currentParticipantReactionSummary === null ||
      participantOrder === "newer"
    ) {
      this.currentParticipantReactionSummary = summary;
    }
    if (this.currentReactionSummary === null) {
      this.currentReactionSummary = summary;
      return;
    }
    if (publicOrder === "incomparable" || participantOrder === "incomparable") {
      // Every caller validates before merging. Keep this defensive guard so a
      // future call site cannot silently combine contradictory evidence.
      throw serviceError("invalid_response");
    }
    if (publicOrder === "newer" || participantOrder === "newer") {
      const publicSource =
        publicOrder === "newer" ? summary : this.currentReactionSummary;
      this.currentReactionSummary = {
        ...publicSource,
        ownByKind:
          participantOrder === "newer"
            ? { ...summary.ownByKind! }
            : previousPrivate,
      };
    }
    // Equal and totally ordered older snapshots are safe no-ops.
  }

  private assertClipEligibilityBound(
    clipsEnabled: boolean | null,
    eligibility: ReplayPremiereClipEligibility | null,
  ): void {
    // v1 has neither field; v2/v3 carry only the legacy boolean. The v4 range
    // proof is required before any clip control is exposed, but an exact
    // legacy response remains valid during a rolling server transition.
    if (eligibility === null) {
      if (
        clipsEnabled !== null &&
        this.clipsEnabled !== null &&
        clipsEnabled !== this.clipsEnabled
      ) {
        throw serviceError("invalid_response");
      }
      return;
    }
    if (
      clipsEnabled === null ||
      clipsEnabled !== eligibility.generationEnabled ||
      (this.clipsEnabled !== null && clipsEnabled !== this.clipsEnabled)
    ) {
      throw serviceError("invalid_response");
    }
  }

  private mergeClipEligibility(
    clipsEnabled: boolean | null,
    eligibility: ReplayPremiereClipEligibility | null,
  ): void {
    this.assertClipEligibilityBound(clipsEnabled, eligibility);
    if (eligibility === null) {
      this.clipsEnabled = clipsEnabled;
      this.clipEligibility = null;
      return;
    }
    this.clipsEnabled = clipsEnabled;
    this.clipEligibility = mergeClipEligibility(
      this.clipEligibility,
      eligibility,
    );
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
        // Strictly `<`, not `<=`: a checkpoint whose pause was bypassed
        // entirely (wagering premieres never gate on checkpoints — see
        // `ReplayPremiereInteractions.ts`'s "close without ever opening"
        // transition) is reported by the server with `opensAt === closesAt`
        // — a genuine, intentional zero-duration window, not a lie. Only a
        // window that closes BEFORE it opens is actually impossible.
        Date.parse(checkpoint.closesAt) < Date.parse(checkpoint.opensAt)) ||
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
  /**
   * Reattaches to an already-established session (persisted client-side
   * across a reload/new-tab) via a heartbeat, without minting a new
   * session record. Throws exactly like `heartbeat()` — including a 404
   * `request_rejected` when the persisted session no longer exists
   * server-side (expired/evicted/cleared state root), which callers treat
   * as "fall back to `startSession`", never a hard failure.
   */
  resumeSession(
    persisted: PersistedReplayPremiereSession,
    input: { visible: boolean; observedSequence: number },
  ): Promise<ReplayPremiereServiceHeartbeatResponse>;
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
  submitMarketOrder(
    input: ReplayPremiereTradeRequest,
  ): Promise<ReplayPremiereServiceTradeResponse>;
  readMarketState(): Promise<ReplayPremiereServiceMarketStateResponse>;
  readMarketSelf(): Promise<ReplayPremiereServiceMarketStateResponse>;
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
  /**
   * "chunks" (default): coarse ~60s hash-chained storage chunks — the
   * ordinary `/premiere/<id>` route, completely unperturbed.
   * "tap": the fine-grained live-projection tap, used by the betting page
   * so rendered content and the wagering trade gate are never behind (and
   * therefore never held ahead of) the authoritative server clock. See
   * `ReplayPremiereNetworkOptions.contentSource` for the detail.
   */
  contentSource?: "chunks" | "tap";
  dependencies?: ReplayPremiereRuntimeDependencies;
}

/**
 * Client-persisted pointer to an already-established viewer session,
 * surviving a reload/new-tab within the same browser session (persisted to
 * `sessionStorage`, not `localStorage` — a fresh browser session/incognito
 * window starts clean, same as arriving cold). `csrfToken` is guest-cookie-
 * scoped (issued once per anonymous identity, not rotated per session) so
 * it stays valid for as long as the underlying guest cookie does; the
 * server is always the final authority regardless — a stale or foreign
 * value here only ever produces a clean rejection, never a bypass.
 */
interface PersistedReplayPremiereSession {
  sessionId: string;
  csrfToken: string;
  participantId: string;
}

const persistedSessionSchema = z
  .object({
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    csrfToken: z.string().min(1).max(512).regex(CSRF_PATTERN),
    participantId: z.string().regex(PARTICIPANT_ID_PATTERN),
  })
  .strict();

function persistedSessionStorageKey(premiereId: string): string {
  return `proxywar:replay-premiere:session:${premiereId}`;
}

function loadPersistedSession(
  storage: Storage,
  premiereId: string,
): PersistedReplayPremiereSession | null {
  let raw: string | null;
  try {
    raw = storage.getItem(persistedSessionStorageKey(premiereId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = persistedSessionSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function savePersistedSession(
  storage: Storage,
  premiereId: string,
  session: PersistedReplayPremiereSession,
): void {
  try {
    storage.setItem(
      persistedSessionStorageKey(premiereId),
      JSON.stringify(session),
    );
  } catch {
    // Storage unavailable, full, or blocked (private browsing) — resumption
    // degrades to "always mint a fresh session on reload", never a hard
    // failure. Losing the resumability optimization is acceptable; losing
    // the ability to join at all is not.
  }
}

function removePersistedSession(storage: Storage, premiereId: string): void {
  try {
    storage.removeItem(persistedSessionStorageKey(premiereId));
  } catch {
    // Best-effort; nothing actionable if storage itself is unavailable.
  }
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
  /** Consecutive `onFrameEvent` bookkeeping mismatches not yet resolved by a clean frame — see `MAX_FRAME_BOOKKEEPING_DRIFT_STRIKES`. */
  private frameBookkeepingDriftStrikes = 0;
  /** Newest-first spoiler-safe war narrative (bounded ring; see war feed). */
  private warFeed: ReplayPremiereWarEventView[] = [];
  /** The viewer's own server-accepted marks per kind (participant-private). */
  private ownMarkCounts: Partial<Record<ReplayPremiereMarkerKind, number>> = {};
  /** Public aggregate returned by the interaction service, never raw reactions. */
  private reactionSummary: ReplayPremiereServiceReactionSummary | null = null;
  /** False after an exact-v1 response cannot refresh the public aggregate. */
  private reactionSummaryFresh = false;
  /** Participant identity that owns the private side of reactionSummary. */
  private reactionSummaryParticipantId: string | null = null;
  /** Raw monotonic baseline for the current participant's private counts. */
  private participantReactionSummary: ReplayPremiereServiceReactionSummary | null =
    null;
  /** Most recent accepted mark; timestamp sharing uses it as an explicit anchor. */
  private lastAcceptedReaction: {
    id: string;
    sequence: number;
    turn: number;
  } | null = null;
  /** Memory-only delivery state for a bound share URL; never survives identity rotation. */
  private shareDelivery: ReplayPremiereShareDeliveryState | null = null;
  /** Invalidates older share/copy completions when another attempt or identity wins. */
  private shareAttemptId = 0;
  /** Server-proven clip capability; null/false both fail closed in the UI. */
  private clipsEnabled: boolean | null = null;
  /** Dynamic immutable-source/range proof from the v4 interaction contract. */
  private clipEligibility: ReplayPremiereClipEligibility | null = null;
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
  // Consecutive-failure counters for each recovery loop's backoff — feed
  // `nextRetryDelayMs`, which doubles the base delay per attempt (capped at
  // `INTERACTION_RECOVERY_MAX_RETRY_MS`). Both reset to 0 on the next
  // success.
  private sessionRetryAttempt = 0;
  private heartbeatRetryAttempt = 0;
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
    this.copyText =
      options.dependencies?.copyText ??
      ((text) => defaultCopyText(text, this.windowRef.navigator));
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
      contentSource: options.contentSource,
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
    if (frame.sequence === null) {
      // Not a premiere-sequenced frame (e.g. the plain-replay engine a
      // revealed/archived page falls back to) — nothing here for this
      // controller's release/dispatch bookkeeping to check against.
      return;
    }
    const playbackState = this.playback.state();
    const bookkeepingConsistent =
      playbackState.releasedThroughSequence !== null &&
      playbackState.lastDispatchedSequence !== null &&
      frame.sequence <= playbackState.releasedThroughSequence &&
      frame.sequence <= playbackState.lastDispatchedSequence &&
      (this.latestFrame?.sequence === null ||
        this.latestFrame?.sequence === undefined ||
        frame.sequence >= this.latestFrame.sequence);
    if (!bookkeepingConsistent) {
      this.frameBookkeepingDriftStrikes += 1;
      if (
        this.frameBookkeepingDriftStrikes >=
        MAX_FRAME_BOOKKEEPING_DRIFT_STRIKES
      ) {
        this.latchFailure("integrity_failure");
      }
      // Otherwise: this one frame is skipped (not folded into overlay
      // state) and the next frame event gets a fresh read of both
      // subsystems' bookkeeping — an ordinary same-tick race resolves
      // itself well within the strike budget.
      return;
    }
    this.frameBookkeepingDriftStrikes = 0;
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
      const persisted = loadPersistedSession(
        this.windowRef.sessionStorage,
        this.options.premiereId,
      );
      let response:
        | ReplayPremiereServiceSessionResponse
        | ReplayPremiereServiceHeartbeatResponse;
      // A resumed session's response has no `incomingMoment` field (only a
      // fresh `startSession` response carries one) — tracked separately so
      // the `staleAcrossReveal` branch below never reads a field that
      // doesn't exist on the resumed shape.
      let freshSession: ReplayPremiereServiceSessionResponse | null = null;
      if (persisted === null) {
        freshSession = await this.establishFreshSession(this.sessionBootstrapInput);
        response = freshSession;
      } else {
        try {
          response = await this.service.resumeSession(persisted, {
            visible: this.documentRef.visibilityState === "visible",
            observedSequence: this.observedSequence(),
          });
        } catch (resumeError) {
          // A retryable resume failure (network blip, 429, 5xx) should be
          // retried as a resume again next attempt, not immediately abandon
          // resumability and burn a fresh session record — rethrow to the
          // outer backoff/retry handling below, which calls
          // `bootstrapInteractions()` again unchanged.
          if (isRetryableServiceFailure(resumeError)) throw resumeError;
          // Non-retryable: the persisted session is confirmed dead
          // (expired, evicted by a server restart, or its CSRF no longer
          // valid). Never keep retrying a pointer that can't come back —
          // clear it and fall back to a fresh session, exactly like a
          // first-ever visit.
          removePersistedSession(
            this.windowRef.sessionStorage,
            this.options.premiereId,
          );
          freshSession = await this.establishFreshSession(this.sessionBootstrapInput);
          response = freshSession;
        }
      }
      this.sessionRetryAttempt = 0;
      this.recovery = null;
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
        if (staleAcrossReveal && freshSession !== null) {
          this.incomingMoment = freshSession.incomingMoment;
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
      if (isRetryableServiceFailure(error)) {
        // Transient — recover on its own: no alarming UI, just a quiet
        // reconnecting indicator, and back off instead of hammering the
        // endpoint (a fixed-interval retry-forever loop is what let one
        // rejected session-create escalate into a self-sustaining 429
        // storm — every retry attempt is itself a new request against the
        // same limiter it just tripped).
        const retryAfterMs =
          error instanceof ReplayPremiereServiceError
            ? error.retryAfterMs
            : null;
        const delayMs = nextRetryDelayMs(this.sessionRetryAttempt, retryAfterMs);
        this.sessionRetryAttempt += 1;
        this.recovery = {
          code: "request_failed",
          attempt: this.sessionRetryAttempt,
          retryInMs: delayMs,
        };
        this.sessionRetryTimer = setTimeout(
          () => void this.bootstrapInteractions(),
          delayMs,
        );
        this.hydrateOverlay();
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
      this.isReadOnlyLifecycle() ||
      // A backoff retry is already scheduled — let it be authoritative
      // instead of the regular interval timer also firing in the
      // meantime, which would send a redundant request against a limiter
      // that's already ratcheting its own retry interval up.
      this.heartbeatRetryTimer !== null
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
      this.heartbeatRetryAttempt = 0;
      this.recovery = null;
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
        // Session no longer recognized (expired/invalidated server-side) —
        // recover on its own by establishing a fresh one, never a latch.
        this.interactionReady = false;
        this.clearInteractionTimers();
        this.clearPersistedSession();
        void this.bootstrapInteractions();
      } else if (isRetryableServiceFailure(error)) {
        this.scheduleHeartbeatRetry(
          error instanceof ReplayPremiereServiceError
            ? error.retryAfterMs
            : null,
        );
      } else if (
        error instanceof ReplayPremiereServiceError &&
        error.code === "invalid_response"
      ) {
        this.latchFailure("integrity_failure", error);
      } else {
        // Neither a recognized transient condition, a session-expiry
        // signal, nor a schema-level integrity violation — an unexpected
        // rejection heartbeat cannot self-explain. Previously this fell
        // through silently (no retry scheduled, no UI change, nothing
        // until the next ordinary heartbeat tick 10s later) with no
        // indication anything was wrong. Surface it honestly instead:
        // this is not a data-integrity violation, so it gets the
        // recoverable bucket (offers reload, never claims a refund) —
        // never the alarming, unconditional one.
        this.latchFailure("runtime_failure", error);
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

  /**
   * Creates a brand-new session record and persists its pointer so the
   * next reload/new-tab can `resumeSession` instead of minting another
   * one.
   */
  private async establishFreshSession(
    input: ReplayPremiereSessionInput,
  ): Promise<ReplayPremiereServiceSessionResponse> {
    const response = await this.service.startSession(input);
    savePersistedSession(
      this.windowRef.sessionStorage,
      this.options.premiereId,
      {
        sessionId: response.session.id,
        csrfToken: response.csrfToken,
        participantId: response.session.participantId,
      },
    );
    return response;
  }

  private clearPersistedSession(): void {
    removePersistedSession(this.windowRef.sessionStorage, this.options.premiereId);
  }

  private applyServiceProjection(
    response:
      | ReplayPremiereServiceSessionResponse
      | ReplayPremiereServiceHeartbeatResponse,
  ): void {
    if (this.projection === null) {
      this.latchFailure("integrity_failure");
      return;
    }
    if (
      !isLifecycleCompatible(this.currentNetworkState(), response.premiereState)
    ) {
      this.latchFailure("integrity_failure");
      return;
    }
    if (this.reveal === null && hasOutcomeProjection(response.checkpoints)) {
      // Checkpoint pauses are bypassed for wagering premieres, so the
      // replay races straight through to the true end with none of the
      // breathing room a normal premiere's final checkpoint pause gives
      // the verified-reveal fetch to land first. A session/heartbeat
      // response can legitimately carry an outcome-bearing checkpoint
      // before `reveal` has landed client-side — the SAME "ordinary
      // delivery race, not a failure" distinction `submitMarketOrder`
      // relies on `isRevealVerificationPending()` for. Skip applying (and
      // re-hydrating from) a response taken in that exact window instead
      // of latching a hard failure; the next heartbeat after `reveal`
      // lands applies normally. A lifecycle mismatch (checked above,
      // never exempted here) stays a hard failure regardless — an
      // impossible regression is not explained by a pending reveal.
      //
      // NOTE (Resilience session): investigated narrowing this to
      // `response.premiereState === "revealed" || "archived"`, theorizing
      // per-checkpoint resolution could arrive mid-match independent of
      // the premiere's own outcome. Server-side proof this is wrong:
      // `applyReplayPremierePredictionResolutionTransition`
      // (`ReplayPremiereInteractions.ts`) throws
      // `predictions_not_revealable` unless the premiere state is already
      // `revealed`/`archived`, and resolves every checkpoint atomically
      // in one transition — a checkpoint's `resolution`/`crowdAccuracy`
      // literally cannot be non-null while `premiereState` is genuinely
      // `"playing"`/`"checkpoint"`. A response claiming otherwise IS
      // exactly the impossible, genuine violation this guard exists to
      // catch — reverted after the regression suite caught the false
      // negative this would have introduced. Occurrence 3's real trigger
      // is elsewhere; see the live-reproduction diagnostic in
      // `latchFailure`.
      if (this.isRevealVerificationPending()) return;
      this.latchFailure("integrity_failure");
      return;
    }
    if (
      !this.acceptReactionSummary(
        response.reactionSummary,
        response.session.participantId,
        undefined,
        {
          schemaVersion: response.schemaVersion,
          latestOwnReaction:
            response.schemaVersion === 3 || response.schemaVersion === 4
              ? response.latestOwnReaction
              : null,
        },
      )
    ) {
      return;
    }
    if (
      !this.acceptClipEligibility(
        response.clipsEnabled,
        response.clipEligibility,
      )
    ) {
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

  private acceptReactionSummary(
    summary: ReplayPremiereServiceReactionSummary | null,
    participantId: string,
    accepted?: {
      kind: ReplayPremiereMarkerKind;
      newlyAccepted: boolean;
      summaryAtRequest: ReplayPremiereServiceReactionSummary | null;
    },
    privateProjection?: {
      schemaVersion: 1 | 2 | 3 | 4;
      latestOwnReaction: ReplayPremiereServiceOwnReactionAnchor | null;
    },
  ): boolean {
    const identityChanged =
      this.reactionSummaryParticipantId !== null &&
      this.reactionSummaryParticipantId !== participantId;
    // Exact legacy v1 response: there is no aggregate evidence to compare.
    // Keep public v2 evidence, but never carry private counts or mark anchors
    // across a recovered anonymous participant identity.
    if (summary === null) {
      this.reactionSummaryFresh = false;
      if (identityChanged) {
        if (this.reactionSummary !== null) {
          this.reactionSummary = {
            ...this.reactionSummary,
            ownByKind: null,
          };
        }
        this.participantReactionSummary = null;
        this.resetParticipantReactionState();
      }
      this.reactionSummaryParticipantId = participantId;
      return true;
    }
    const previous = this.reactionSummary;
    if (!isConsistentReactionSummary(summary) || summary.ownByKind === null) {
      this.latchFailure("integrity_failure");
      return false;
    }
    if (
      privateProjection !== undefined &&
      privateProjection.schemaVersion >= 3 &&
      !isConsistentOwnReactionAnchor(
        privateProjection.latestOwnReaction,
        summary,
      )
    ) {
      this.latchFailure("integrity_failure");
      return false;
    }
    this.reactionSummaryFresh = true;
    const publicOrder =
      previous === null
        ? "newer"
        : comparePublicReactionSummaries(summary, previous);
    const participantOrder =
      identityChanged || this.participantReactionSummary === null
        ? "newer"
        : compareReactionSummaries(summary, this.participantReactionSummary);
    if (
      publicOrder === "incomparable" ||
      participantOrder === "incomparable" ||
      (accepted?.newlyAccepted === true &&
        !reactionSummaryProvesIncrement(
          summary,
          accepted.summaryAtRequest,
          accepted.kind,
        ))
    ) {
      this.latchFailure("integrity_failure");
      return false;
    }
    if (identityChanged) {
      this.resetParticipantReactionState();
    }
    if (
      this.participantReactionSummary === null ||
      identityChanged ||
      participantOrder === "newer"
    ) {
      this.participantReactionSummary = summary;
    }
    if (
      previous === null ||
      identityChanged ||
      publicOrder === "newer" ||
      participantOrder === "newer"
    ) {
      const publicSource =
        previous === null || publicOrder === "newer" ? summary : previous;
      const ownByKind =
        identityChanged || participantOrder === "newer"
          ? summary.ownByKind
          : (previous?.ownByKind ?? null);
      this.reactionSummary = {
        ...publicSource,
        ownByKind: ownByKind === null ? null : { ...ownByKind },
      };
      this.ownMarkCounts = ownByKind === null ? {} : { ...ownByKind };
    }
    this.reactionSummaryParticipantId = participantId;
    if (
      privateProjection !== undefined &&
      privateProjection.schemaVersion >= 3 &&
      (identityChanged || participantOrder !== "older")
    ) {
      const nextAnchor = privateProjection.latestOwnReaction;
      if (
        !identityChanged &&
        participantOrder === "equal" &&
        this.lastAcceptedReaction !== null &&
        nextAnchor !== null &&
        (!sameOwnReactionAnchor(this.lastAcceptedReaction, nextAnchor) ||
          this.lastMarkConfirmation?.kind !== nextAnchor.kind)
      ) {
        this.latchFailure("integrity_failure");
        return false;
      }
      this.applyOwnReactionAnchor(nextAnchor);
    }
    // Equal or totally ordered older snapshots are valid but do not regress
    // the public or participant counters already visible in the overlay.
    return true;
  }

  private resetParticipantReactionState(): void {
    this.ownMarkCounts = {};
    this.lastAcceptedReaction = null;
    this.lastMarkConfirmation = null;
    this.shareAttemptId += 1;
    this.shareDelivery = null;
  }

  private applyOwnReactionAnchor(
    anchor: ReplayPremiereServiceOwnReactionAnchor | null,
  ): void {
    if (anchor === null) {
      this.lastAcceptedReaction = null;
      this.lastMarkConfirmation = null;
      return;
    }
    this.lastAcceptedReaction = {
      id: anchor.id,
      sequence: anchor.sequence,
      turn: anchor.turn,
    };
    this.lastMarkConfirmation = { kind: anchor.kind, turn: anchor.turn };
  }

  private acceptClipEligibility(
    clipsEnabled: boolean | null,
    eligibility: ReplayPremiereClipEligibility | null,
  ): boolean {
    // v1 has neither field; v2/v3 carry only the legacy capability boolean.
    // Clear the v4 range proof on either downgrade so unsupported clip
    // controls cannot remain exposed while replay and reactions continue.
    if (eligibility === null) {
      if (
        clipsEnabled !== null &&
        this.clipsEnabled !== null &&
        clipsEnabled !== this.clipsEnabled
      ) {
        this.latchFailure("integrity_failure");
        return false;
      }
      this.clipsEnabled = clipsEnabled;
      this.clipEligibility = null;
      return true;
    }
    if (
      clipsEnabled === null ||
      clipsEnabled !== eligibility.generationEnabled ||
      (this.clipsEnabled !== null && clipsEnabled !== this.clipsEnabled)
    ) {
      this.latchFailure("integrity_failure");
      return false;
    }
    this.clipsEnabled = clipsEnabled;
    this.clipEligibility = mergeClipEligibility(
      this.clipEligibility,
      eligibility,
    );
    return true;
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
    if (failure === "integrity_failure") {
      // A genuine integrity violation must never let a later reload
      // silently resume the compromised session — force a fresh session
      // on the next visit, the same as if none had ever existed.
      this.clearPersistedSession();
    }
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

  /**
   * Public market-order write — NOT part of `overlayCallbacks()` because
   * trading renders its own dedicated overlay (`src/client/prediction/
   * wagering/**`), not `ReplayPremiereOverlay`. Continuous LMSR trading is
   * NOT gated to a checkpoint window (operator override — checkpoints are
   * content beats, not a trading gate); the only client-side freshness
   * bound is `request.sequence`, the caller's freshest observed
   * `market.liveVisibleSequence`. The server is the sole authority on
   * sequence freshness — it independently rejects a stale/ahead claim with
   * 410 `order_sequence_unreleased`. Also callable directly by a non-UI
   * caller (synthetic crowd / persona testing) — this is a plain method,
   * not tucked inside a click handler. Unlike a checkpoint prediction, a
   * trade does NOT replace anything in `serviceCheckpoints` or re-hydrate
   * the overlay — the market is a sibling concern the page controller
   * polls and renders independently (see `readMarketState()` below).
   */
  async submitMarketOrder(
    request: ReplayPremiereTradeRequest,
  ): Promise<ReplayPremiereServiceTradeResponse> {
    this.assertInteractionWriteAllowed();
    const response = await this.strictInteractionWrite(() =>
      this.service.submitMarketOrder(request),
    );
    // Checkpoint pauses are bypassed for wagering premieres (the replay
    // plays straight through to the end, never pausing at the final
    // checkpoint the way a non-wagering premiere does) — so a trade
    // landing in the last moments of a live match can race the verified
    // reveal payload's own delivery: the market can legitimately settle
    // (server-authoritative, independent of video reveal) before `reveal`
    // has been fetched client-side. `isRevealVerificationPending()` is
    // the SAME "is this an ordinary reveal-delivery race, or a genuinely
    // impossible claim" distinction `sendHeartbeat` already relies on for
    // this exact scenario — only latch a hard integrity failure when the
    // replay's own state machine doesn't yet think the match is over
    // either (i.e., nothing here can explain a "settled" claim).
    if (
      this.reveal === null &&
      response.market.status === "settled" &&
      !this.isRevealVerificationPending()
    ) {
      this.latchFailure("integrity_failure");
      throw serviceError("invalid_response");
    }
    return response;
  }

  /** Public poll read for the live odds ticker — no session/write gating. */
  async readMarketState(): Promise<ReplayPremiereServiceMarketStateResponse> {
    return this.service.readMarketState();
  }

  /**
   * Authenticated participant read — this caller's own positions AND
   * available ledger balance, the sole money authority for the client
   * (see `src/client/prediction/wagering/**`; no local bankroll
   * arithmetic anywhere in that module). Deliberately NOT gated by
   * {@link assertInteractionWriteAllowed} — unlike a trade, this is a
   * pure read and must keep working after settlement (to reconcile the
   * final balance) and before this session has ever placed an order.
   */
  async readMarketSelf(): Promise<ReplayPremiereServiceMarketStateResponse> {
    return this.service.readMarketSelf();
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
        // Same ordinary reveal-delivery race `submitMarketOrder` guards
        // against with `isRevealVerificationPending()`: checkpoint pauses
        // are bypassed for wagering premieres, so a prediction response
        // can legitimately carry this checkpoint's outcome before `reveal`
        // has landed client-side.
        if (
          this.reveal === null &&
          hasOutcomeProjection([response.checkpoint]) &&
          !this.isRevealVerificationPending()
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
        const summaryAtRequest = this.participantReactionSummary;
        const response = await this.strictInteractionWrite(() =>
          this.service.submitReaction(request),
        );
        const participantId = this.service.session()?.participantId;
        if (participantId === undefined) {
          this.latchFailure("integrity_failure");
          throw serviceError("invalid_response");
        }
        if (response.reaction.participantId !== participantId) {
          // A valid response for the anonymous identity that initiated this
          // request may arrive after session recovery rotated that identity.
          // It must not restore the old viewer's private marks or share anchor.
          return;
        }
        if (
          !this.acceptReactionSummary(
            response.reactionSummary,
            participantId,
            {
              kind: request.kind,
              newlyAccepted: !response.idempotent,
              summaryAtRequest,
            },
            {
              schemaVersion: response.schemaVersion,
              latestOwnReaction:
                response.schemaVersion === 3 || response.schemaVersion === 4
                  ? response.latestOwnReaction
                  : null,
            },
          )
        ) {
          throw serviceError("invalid_response");
        }
        if (
          !this.acceptClipEligibility(
            response.clipsEnabled,
            response.clipEligibility,
          )
        ) {
          throw serviceError("invalid_response");
        }
        if (response.reactionSummary === null && !response.idempotent) {
          this.ownMarkCounts[request.kind] =
            (this.ownMarkCounts[request.kind] ?? 0) + 1;
        }
        if (response.schemaVersion < 3) {
          this.lastAcceptedReaction = {
            id: response.reaction.id,
            sequence: response.reaction.sequence,
            turn: response.reaction.turn,
          };
          this.lastMarkConfirmation = {
            kind: request.kind,
            turn: response.reaction.turn,
          };
        }
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
    const participantId = this.service.session()?.participantId;
    if (participantId === undefined) {
      throw serviceError("session_required");
    }
    const sequence = request.sequence;
    const sourceReactionId = request.sourceReactionId ?? null;
    const attemptId = ++this.shareAttemptId;
    this.shareDelivery = {
      attemptId,
      participantId,
      phase: "creating",
      url: null,
      manualCopyReason: null,
    };
    // Preserve safeRun's disabled state across structural hydrates while the
    // server write and clipboard delivery are in flight.
    this.hydrateOverlay();
    let response: ReplayPremiereServiceShareResponse;
    try {
      response = await this.strictInteractionWrite(() =>
        this.service.createShare({
          sequence,
          sourceReactionId,
        }),
      );
    } catch (error) {
      if (this.shareDelivery?.attemptId === attemptId) {
        this.shareDelivery = null;
        this.hydrateOverlay();
      }
      throw error;
    }
    if (
      response.share.createdByParticipantId !== participantId ||
      !isSafeShareUrl(response.url, this.options.premiereId, this.windowRef)
    ) {
      if (this.shareDelivery?.attemptId === attemptId) {
        this.shareDelivery = null;
        this.hydrateOverlay();
      }
      throw serviceError("invalid_response");
    }
    // A response can be valid for the session that initiated it but stale for
    // the recovered session now on screen. Never copy or expose that old
    // participant's attribution URL.
    if (
      this.shareDelivery?.attemptId !== attemptId ||
      this.service.session()?.participantId !== participantId
    ) {
      if (this.shareDelivery?.attemptId === attemptId) {
        this.shareDelivery = null;
        this.hydrateOverlay();
      }
      return;
    }
    this.shareDelivery = {
      attemptId,
      participantId,
      phase: "copying",
      url: response.url,
      manualCopyReason: null,
    };
    try {
      await this.copyText(response.url);
    } catch (error) {
      if (
        this.shareDelivery?.attemptId === attemptId &&
        this.service.session()?.participantId === participantId
      ) {
        this.shareDelivery = {
          attemptId,
          participantId,
          phase: "manual",
          url: response.url,
          manualCopyReason:
            error instanceof ReplayPremiereClipboardUnavailableError
              ? "clipboard_unavailable"
              : "clipboard_rejected",
        };
        this.hydrateOverlay();
      }
      // The share is already durably created and its validated URL remains
      // usable. Clipboard delivery failure is therefore a handled UI state,
      // not a failed backend action and not a reason to repeat createShare.
      return;
    }
    if (
      this.shareDelivery?.attemptId === attemptId &&
      this.service.session()?.participantId === participantId
    ) {
      this.shareDelivery = {
        attemptId,
        participantId,
        phase: "copied",
        url: response.url,
        manualCopyReason: null,
      };
      this.hydrateOverlay();
    }
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
   * server-proven immutable/released range admits the anchor; lifecycle labels
   * do not. Archived Premiere pages use the replay-scoped league endpoint and
   * never need this interaction-session client. Failures surface on the clip
   * status line because a clip is a non-authoritative cache.
   */
  private async requestClip(request: ReplayPremiereClipRequest): Promise<void> {
    if (request.premiereId !== this.options.premiereId) {
      throw serviceError("invalid_configuration");
    }
    if (!this.clipGenerationEnabled) {
      throw serviceError("request_rejected");
    }
    this.assertInteractionWriteAllowed();
    if (this.clipsEnabled !== true) {
      throw serviceError("request_rejected");
    }
    const anchor = this.currentClipAnchor();
    if (anchor === null) {
      throw serviceError("request_rejected");
    }
    // Anchor on the runtime's own observed frame so sequence and turn are a
    // consistent pair (the server cross-checks turn against the released
    // context for the sequence).
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

  private currentClipAnchor(): { sequence: number; turn: number } | null {
    const frame = this.latestFrame;
    if (
      frame === null ||
      frame.sequence === null ||
      !isPremiereClipAnchorEligible(frame.turnNumber, this.clipEligibility)
    ) {
      return null;
    }
    return { sequence: frame.sequence, turn: frame.turnNumber };
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
    // Terminal reclamation disposes the live service. Playing/checkpoint/
    // revealed transitions do not: a render admitted from a proven safe range
    // keeps polling through those presentation-state changes.
    if (this.isReadOnlyLifecycle()) {
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
    const shareTurn = this.lastAcceptedReaction?.turn ?? currentTurn;
    const currentParticipantId = this.service.session()?.participantId ?? null;
    const manualShareDelivery =
      this.shareDelivery?.phase === "manual" &&
      this.shareDelivery.participantId === currentParticipantId
        ? this.shareDelivery
        : null;
    const shareWritePending =
      this.shareDelivery?.participantId === currentParticipantId &&
      (this.shareDelivery.phase === "creating" ||
        this.shareDelivery.phase === "copying");
    const currentClipAnchor = this.currentClipAnchor();
    const clipContractEnabled =
      this.clipsEnabled === true &&
      this.clipEligibility?.generationEnabled === true &&
      this.clipGenerationEnabled;
    const clipVisible =
      clipContractEnabled &&
      (currentClipAnchor !== null || this.clipStatus !== "idle");
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
      markerCounts: {
        ...(this.reactionSummary?.byKind ?? this.ownMarkCounts),
      },
      ownMarkerCounts: { ...this.ownMarkCounts },
      markerParticipantCount: this.reactionSummary?.distinctParticipants,
      markerAggregateFresh: this.reactionSummaryFresh,
      clipMarkerAvailable:
        this.clipEligibility?.generationEnabled === true &&
        this.clipGenerationEnabled,
      markerConfirmation: this.lastMarkConfirmation,
      headlineEvent: this.headlineEvent,
      markerPolicySeatId: null,
      share: {
        canonicalUrl: this.canonicalUrl(),
        timestampUrl: viewedSequence < 0 ? null : this.canonicalUrl(),
        sourceReactionId: this.lastAcceptedReaction?.id ?? null,
        sourceReactionSequence: this.lastAcceptedReaction?.sequence ?? null,
        sourceReactionTurn: this.lastAcceptedReaction?.turn ?? null,
        manualCopyUrl: manualShareDelivery?.url ?? null,
        manualCopyReason: manualShareDelivery?.manualCopyReason ?? null,
        suggestedCaption:
          shareTurn === null
            ? translateText("replay_premiere.share_caption_premiere", {
                title: this.projection.publicDefinition.title,
              })
            : translateText("replay_premiere.share_caption", {
                title: this.projection.publicDefinition.title,
                turn: shareTurn,
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
      canShare:
        this.interactionReady &&
        !this.isReadOnlyLifecycle() &&
        !shareWritePending,
      canExportCounterChallenge:
        displayReveal !== null &&
        networkState !== "failed" &&
        networkState !== "cancelled",
      // Visibility is replay/range-scoped, not lifecycle-scoped. The process
      // master flag and the interaction contract must both prove generation,
      // and an idle control appears only for a fully renderable current range.
      clip: clipVisible ? this.clipView() : null,
      canRequestClip:
        clipContractEnabled &&
        currentClipAnchor !== null &&
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
   * Builds results from the verified authoritative result and service
   * checkpoint views. Aggregate tallies are public; a participant's sealed
   * selection stays session-local and is attached only for their reveal
   * verdict. Archived summaries never carry that private selection.
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
    const authoritativeWinners = result.seats.filter((seat) => seat.won);
    const authoritativeWinnerSeatId =
      authoritativeWinners.length === 1 ? authoritativeWinners[0].seatId : null;
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
      const correctPercent =
        authoritativeWinnerSeatId !== null &&
        serviceView?.optionSeatIds.includes(authoritativeWinnerSeatId) ===
          true &&
        distribution !== null &&
        total > 0
          ? ((distribution[authoritativeWinnerSeatId] ?? 0) / total) * 100
          : null;
      const accuracyStatus: ReplayPremiereResultsPredictionView["accuracyStatus"] =
        authoritativeWinnerSeatId === null ||
        serviceView?.optionSeatIds.includes(authoritativeWinnerSeatId) !== true
          ? "void"
          : total > 0 && distribution !== null
            ? "scored"
            : "no_predictions";
      return {
        checkpointId: definition.id,
        sequence: definition.sequence,
        correctPercent,
        accuracyStatus,
        totalPredictions: total,
        options,
        selectedSeatId:
          serviceView?.participantPrediction?.selectedSeatId ?? null,
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

  private scheduleHeartbeatRetry(retryAfterMs: number | null = null): void {
    if (
      this.heartbeatRetryTimer !== null ||
      this.disposed ||
      !this.interactionReady ||
      this.terminalFailure !== null ||
      this.isReadOnlyLifecycle()
    ) {
      return;
    }
    const delayMs = nextRetryDelayMs(this.heartbeatRetryAttempt, retryAfterMs);
    this.heartbeatRetryAttempt += 1;
    this.recovery = {
      code: "request_failed",
      attempt: this.heartbeatRetryAttempt,
      retryInMs: delayMs,
    };
    this.hydrateOverlay();
    this.heartbeatRetryTimer = setTimeout(() => {
      this.heartbeatRetryTimer = null;
      void this.sendHeartbeat();
    }, delayMs);
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
/**
 * `onFrameEvent` cross-checks a just-rendered frame's sequence against the
 * network/playback controller's own bookkeeping (`releasedThroughSequence`/
 * `lastDispatchedSequence`) — two client-side subsystems (render pipeline,
 * network/playback controller) that update on independent event-loop turns.
 * A single observed mismatch is at least as likely to be an ordinary same-
 * tick read-before-write race between them as a real integrity violation —
 * the engine can only ever process turns this controller itself already
 * released and dispatched, so a transient "ahead" reading never reflects
 * data the viewer wasn't already entitled to. Tolerate a short run of
 * mismatches (skip those frames, wait for the bookkeeping to resync) and
 * only latch the terminal failure once the drift persists across this many
 * consecutive frames — a real, non-self-healing violation exhausts this
 * budget in well under a second at premiere frame rates.
 */
const MAX_FRAME_BOOKKEEPING_DRIFT_STRIKES = 3;

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

function mergeClipEligibility(
  current: ReplayPremiereClipEligibility | null,
  next: ReplayPremiereClipEligibility,
): ReplayPremiereClipEligibility {
  if (current === null) return { ...next };
  const currentTurn = current.renderableThroughTurn;
  const nextTurn = next.renderableThroughTurn;
  return {
    generationEnabled: next.generationEnabled,
    renderableThroughTurn:
      currentTurn === null
        ? nextTurn
        : nextTurn === null
          ? currentTurn
          : Math.max(currentTurn, nextTurn),
    // Source completeness is immutable once observed. An older in-flight
    // interaction response may still report false after a terminal response.
    sourceComplete: current.sourceComplete || next.sourceComplete,
  };
}

function isPremiereClipAnchorEligible(
  anchorTurn: number,
  eligibility: ReplayPremiereClipEligibility | null,
): boolean {
  if (
    eligibility === null ||
    eligibility.generationEnabled !== true ||
    eligibility.renderableThroughTurn === null ||
    !Number.isSafeInteger(anchorTurn) ||
    anchorTurn < CLIP_MIN_ANCHOR_TURN
  ) {
    return false;
  }
  const representativeAnchor =
    Math.floor(anchorTurn / CLIP_ANCHOR_BUCKET_TURNS) *
      CLIP_ANCHOR_BUCKET_TURNS +
    Math.floor(CLIP_ANCHOR_BUCKET_TURNS / 2);
  if (representativeAnchor > eligibility.renderableThroughTurn) return false;
  return (
    eligibility.sourceComplete ||
    representativeAnchor + CLIP_POST_ANCHOR_TURNS <=
      eligibility.renderableThroughTurn
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
  if (!(error instanceof ReplayPremiereServiceError)) return false;
  if (error.code === "request_failed") return true;
  if (error.code !== "request_rejected") return false;
  if (
    error.publicCode === "PREMIERE_CAPACITY_EXCEEDED" ||
    error.publicCode === "PREMIERE_UNAVAILABLE"
  ) {
    return true;
  }
  // The wire flattens many distinct server-side rejections onto the one
  // coarse `PREMIERE_INVALID_REQUEST` public code — the actual HTTP status
  // is the only signal left that distinguishes "this specific request was
  // malformed" (never retryable) from "the server is overloaded/rate-
  // limiting/temporarily down" (always retryable, regardless of which
  // public code it was dressed up as). A raw transient status is
  // retryable on its own terms even when the domain-specific public code
  // doesn't say so.
  return error.status !== null && isTransientInteractionStatus(error.status);
}

// Exponential backoff, doubling from `INTERACTION_RECOVERY_RETRY_MS` and
// capped at `INTERACTION_RECOVERY_MAX_RETRY_MS` — same scheme
// `ReplayPremiereNetworkController.runLoop` already uses. A server-supplied
// `Retry-After` is honored as a floor, never a ceiling: it tells the client
// the earliest safe time to retry, not the latest useful one.
function nextRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
  const exponential = Math.min(
    INTERACTION_RECOVERY_MAX_RETRY_MS,
    INTERACTION_RECOVERY_RETRY_MS * 2 ** attempt,
  );
  return Math.max(exponential, retryAfterMs ?? 0);
}

function isTransientInteractionStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

// Only the delay-seconds form of `Retry-After` is honored (RFC 9110
// §10.2.3); the HTTP-date form is deliberately not parsed — a malformed or
// unexpected date is worse than falling back to the caller's own backoff.
// Bounded to a sane range so a misconfigured server cannot park a client
// forever or make it hammer the endpoint.
function parseRetryAfterMs(headerValue: string | null): number | null {
  if (headerValue === null) return null;
  if (!/^\d+$/.test(headerValue.trim())) return null;
  const seconds = Number(headerValue.trim());
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1_000, 300_000);
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

function isConsistentReactionSummary(
  summary: ReplayPremiereServiceReactionSummary,
): boolean {
  const aggregateTotal = REACTION_KINDS.reduce(
    (total, kind) => total + summary.byKind[kind],
    0,
  );
  const ownTotal =
    summary.ownByKind === null
      ? 0
      : REACTION_KINDS.reduce(
          (total, kind) => total + summary.ownByKind![kind],
          0,
        );
  return (
    aggregateTotal === summary.totalReactions &&
    summary.distinctParticipants <= summary.totalReactions &&
    (summary.totalReactions === 0) === (summary.distinctParticipants === 0) &&
    ownTotal <= summary.totalReactions &&
    (summary.ownByKind === null ||
      REACTION_KINDS.every(
        (kind) => summary.ownByKind![kind] <= summary.byKind[kind],
      ))
  );
}

function isConsistentOwnReactionAnchor(
  anchor: ReplayPremiereServiceOwnReactionAnchor | null,
  summary: ReplayPremiereServiceReactionSummary,
): boolean {
  if (summary.ownByKind === null) return false;
  const ownTotal = REACTION_KINDS.reduce(
    (total, kind) => total + summary.ownByKind![kind],
    0,
  );
  return anchor === null
    ? ownTotal === 0
    : ownTotal > 0 && summary.ownByKind[anchor.kind] > 0;
}

function sameOwnReactionAnchor(
  current: { id: string; sequence: number; turn: number },
  candidate: ReplayPremiereServiceOwnReactionAnchor,
): boolean {
  return (
    current.id === candidate.id &&
    current.sequence === candidate.sequence &&
    current.turn === candidate.turn
  );
}

function reactionSummaryAtLeast(
  next: ReplayPremiereServiceReactionSummary,
  previous: ReplayPremiereServiceReactionSummary,
): boolean {
  return (
    next.totalReactions >= previous.totalReactions &&
    next.distinctParticipants >= previous.distinctParticipants &&
    REACTION_KINDS.every(
      (kind) => next.byKind[kind] >= previous.byKind[kind],
    ) &&
    (previous.ownByKind === null ||
      (next.ownByKind !== null &&
        REACTION_KINDS.every(
          (kind) => next.ownByKind![kind] >= previous.ownByKind![kind],
        )))
  );
}

function publicReactionSummaryAtLeast(
  next: ReplayPremiereServiceReactionSummary,
  previous: ReplayPremiereServiceReactionSummary,
): boolean {
  return (
    next.totalReactions >= previous.totalReactions &&
    next.distinctParticipants >= previous.distinctParticipants &&
    REACTION_KINDS.every((kind) => next.byKind[kind] >= previous.byKind[kind])
  );
}

type ReactionSummaryOrder = "equal" | "newer" | "older" | "incomparable";

function compareReactionSummaries(
  candidate: ReplayPremiereServiceReactionSummary,
  current: ReplayPremiereServiceReactionSummary,
): ReactionSummaryOrder {
  const candidateAtLeastCurrent = reactionSummaryAtLeast(candidate, current);
  const currentAtLeastCandidate = reactionSummaryAtLeast(current, candidate);
  if (candidateAtLeastCurrent && currentAtLeastCandidate) return "equal";
  if (candidateAtLeastCurrent) return "newer";
  if (currentAtLeastCandidate) return "older";
  return "incomparable";
}

function comparePublicReactionSummaries(
  candidate: ReplayPremiereServiceReactionSummary,
  current: ReplayPremiereServiceReactionSummary,
): ReactionSummaryOrder {
  const candidateAtLeastCurrent = publicReactionSummaryAtLeast(
    candidate,
    current,
  );
  const currentAtLeastCandidate = publicReactionSummaryAtLeast(
    current,
    candidate,
  );
  if (candidateAtLeastCurrent && currentAtLeastCandidate) return "equal";
  if (candidateAtLeastCurrent) return "newer";
  if (currentAtLeastCandidate) return "older";
  return "incomparable";
}

function reactionSummaryProvesIncrement(
  summary: ReplayPremiereServiceReactionSummary,
  summaryAtRequest: ReplayPremiereServiceReactionSummary | null,
  kind: ReplayPremiereMarkerKind,
): boolean {
  if (summary.ownByKind === null) return false;
  if (summaryAtRequest === null) {
    return (
      summary.totalReactions > 0 &&
      summary.byKind[kind] > 0 &&
      summary.ownByKind[kind] > 0
    );
  }
  return (
    reactionSummaryAtLeast(summary, summaryAtRequest) &&
    summary.totalReactions > summaryAtRequest.totalReactions &&
    summary.byKind[kind] > summaryAtRequest.byKind[kind] &&
    (summaryAtRequest.ownByKind === null
      ? summary.ownByKind[kind] > 0
      : summary.ownByKind[kind] > summaryAtRequest.ownByKind[kind])
  );
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
  retryAfterMs: number | null = null,
): ReplayPremiereServiceError {
  return new ReplayPremiereServiceError(
    code,
    status,
    publicCode,
    phase,
    retryAfterMs,
  );
}

function serviceErrorWithPhase(
  error: unknown,
  phase: ReplayPremiereServiceErrorPhase,
): ReplayPremiereServiceError {
  return error instanceof ReplayPremiereServiceError
    ? serviceError(
        error.code,
        error.status,
        error.publicCode,
        phase,
        error.retryAfterMs,
      )
    : serviceError("invalid_configuration", null, null, phase);
}

class ReplayPremiereClipboardUnavailableError extends Error {
  constructor() {
    super("clipboard_unavailable");
    this.name = "ReplayPremiereClipboardUnavailableError";
  }
}

async function defaultCopyText(
  text: string,
  navigatorRef: Navigator = navigator,
): Promise<void> {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > MAX_CLIPBOARD_TEXT_LENGTH
  ) {
    throw serviceError("invalid_configuration");
  }
  let clipboard: Clipboard | undefined;
  try {
    clipboard = navigatorRef.clipboard;
  } catch {
    throw new ReplayPremiereClipboardUnavailableError();
  }
  if (clipboard === undefined || typeof clipboard.writeText !== "function") {
    throw new ReplayPremiereClipboardUnavailableError();
  }
  await clipboard.writeText(text);
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
