import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import {
  matchProxyWarPublicPremiereReadPath,
  matchProxyWarPublicPremiereWritePath,
} from "../agents/ProxyWarPublicArtifacts";
import type { ReplayPremiereClientAddressResolver } from "./ReplayPremiereClientAddress";
import type { ReplayPremiereClips } from "./ReplayPremiereClips";
import type {
  PremiereState,
  ReplayClipEligibility,
} from "./ReplayPremiereContracts";
import {
  ReplayPremiereError,
  toPublicReplayPremiereFailure,
  type ReplayPremierePublicErrorCode,
} from "./ReplayPremiereErrors";
import {
  isReplayPremiereBotUserAgent,
  ReplayPremiereGuestSecurity,
  type ReplayPremiereShareAttribution,
} from "./ReplayPremiereGuestSecurity";
import type {
  ReplayPremiereAnonymousWriteAdmission,
  ReplayPremiereReactionKind,
  ReplayPremiereReleasedContext,
} from "./ReplayPremiereInteractions";
import {
  REPLAY_PREMIERE_REACTION_KINDS,
  ReplayPremiereInteractions,
} from "./ReplayPremiereInteractions";
import type {
  PremiereManifestResponse,
  PremierePublicBootstrapResponse,
  PremierePublicChunkResponse,
  PremiereRevealResponse,
} from "./ReplayPremiereWire";

const DEFAULT_BODY_LIMIT_BYTES = 32 * 1024;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const SESSION_ID_PATTERN = /^sess_[a-f0-9]{32}$/;
const CHECKPOINT_ID_PATTERN = /^cp_[a-z0-9]{8,32}$/;
const SEAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const REACTION_ID_PATTERN = /^react_[a-f0-9]{32}$/;
const REACTION_KINDS = new Set<ReplayPremiereReactionKind>(
  REPLAY_PREMIERE_REACTION_KINDS,
);
type ReplayPremiereInteractionContractVersion = 1 | 2 | 3 | 4;

export interface ReplayPremiereIncomingMoment {
  shareId: string;
  sequence: number;
  turn: number;
}

export interface ReplayPremiereRuntimeReader {
  readonly premiereId: string;
  readLifecycleState(): PremiereState;
  readBootstrap(): PremierePublicBootstrapResponse;
  readManifest(): Promise<PremiereManifestResponse>;
  readChunk(index: number): PremierePublicChunkResponse | null;
  readReveal(): PremiereRevealResponse | null;
  /**
   * Released context for a sequence, or null if not yet released. Used to
   * resolve clip anchors exactly like share moments (sequence <=
   * releasedThroughSequence). Already implemented by the runtime coordinator.
   */
  readReleasedContext(sequence: number): ReplayPremiereReleasedContext | null;
}

export interface ReplayPremiereHttpTarget {
  runtime: ReplayPremiereRuntimeReader;
  interactions: ReplayPremiereInteractions;
}

/** A process-local registry. Registration is explicit and has no hosted side effect. */
export class ReplayPremiereHttpRegistry {
  private readonly targets = new Map<string, ReplayPremiereHttpTarget>();

  constructor(
    readonly admitAnonymousWrite: ReplayPremiereAnonymousWriteAdmission,
  ) {}

  register(target: ReplayPremiereHttpTarget): void {
    if (this.targets.has(target.runtime.premiereId)) {
      throw invalidRequest("duplicate_premiere_registration", 409);
    }
    if (
      !target.interactions.usesAnonymousWriteAdmission(this.admitAnonymousWrite)
    ) {
      throw invalidRequest("premiere_admission_mismatch", 409);
    }
    this.targets.set(target.runtime.premiereId, target);
  }

  unregister(target: ReplayPremiereHttpTarget): void {
    if (this.targets.get(target.runtime.premiereId) === target) {
      this.targets.delete(target.runtime.premiereId);
    }
  }

  get(premiereId: string): ReplayPremiereHttpTarget | null {
    return this.targets.get(premiereId) ?? null;
  }
}

export interface ReplayPremiereHttpOptions {
  registry: ReplayPremiereHttpRegistry;
  security: ReplayPremiereGuestSecurity;
  bodyLimitBytes?: number;
  operationTimeoutMs?: number;
  /** Must return a validated client address across any trusted proxy boundary. */
  resolveClientAddress?: ReplayPremiereClientAddressResolver;
  /**
   * Replay-scoped clip cache service. When absent, clip routes fail closed
   * with a bare 404 (the effective master + Premiere flags are off).
   */
  clips?: ReplayPremiereClips;
  /** Operator-only diagnostics sink; never serialized into the response. */
  onOperatorError?: (error: unknown) => void;
}

export function formatReplayPremiereHttpOperatorError(error: unknown): string {
  const operatorCode =
    error instanceof ReplayPremiereError &&
    /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(error.operatorCode)
      ? error.operatorCode
      : "unexpected_failure";
  const status =
    error instanceof ReplayPremiereError &&
    Number.isInteger(error.httpStatus) &&
    error.httpStatus >= 100 &&
    error.httpStatus <= 599
      ? String(error.httpStatus)
      : "none";
  const publicCode =
    error instanceof ReplayPremiereError && isPublicErrorCode(error.publicCode)
      ? error.publicCode
      : "none";
  return `Replay Premiere HTTP rejected operatorCode=${operatorCode} status=${status} publicCode=${publicCode}`;
}

/**
 * Exact public Premiere API adapter. It deliberately has no publication,
 * scheduling, transition, source-file, or admin route.
 */
export function createReplayPremiereRouter(
  options: ReplayPremiereHttpOptions,
): Router {
  const router = express.Router();
  const bodyLimitBytes = boundedInteger(
    options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    1_024,
    256 * 1_024,
    "invalid_http_body_limit",
  );
  const operationTimeoutMs = boundedInteger(
    options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    100,
    30_000,
    "invalid_http_operation_timeout",
  );
  const parseJson = express.json({
    limit: bodyLimitBytes,
    strict: true,
    type: "application/json",
  });

  router.use((request, response, next) => {
    if (!isPremiereApiPath(request.path)) {
      next();
      return;
    }
    setNoStoreHeaders(response);
    if (
      request.method !== "POST" ||
      matchProxyWarPublicPremiereWritePath(request.path) === null
    ) {
      next();
      return;
    }
    const declaredLength = request.headers["content-length"];
    if (
      typeof declaredLength === "string" &&
      (!/^[0-9]{1,12}$/.test(declaredLength) ||
        Number(declaredLength) > bodyLimitBytes)
    ) {
      next(capacityExceeded("premiere_request_body_too_large", 413));
      return;
    }
    if (!request.is("application/json")) {
      next(invalidRequest("premiere_json_content_type_required", 415));
      return;
    }
    parseJson(request, response, next);
  });

  router.use(async (request, response, next) => {
    if (!isPremiereApiPath(request.path)) {
      next();
      return;
    }
    try {
      await handlePremiereApiRequest(
        request,
        response,
        options,
        operationTimeoutMs,
      );
    } catch (error) {
      next(error);
    }
  });

  router.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (!isPremiereApiPath(request.path)) {
        next(error);
        return;
      }
      const normalized = normalizeHttpError(error);
      try {
        options.onOperatorError?.(normalized);
      } catch {
        // Diagnostics are non-authoritative and must never replace the fixed
        // public failure envelope.
      }
      sendJson(
        response,
        normalized instanceof ReplayPremiereError ? normalized.httpStatus : 503,
        toPublicReplayPremiereFailure(normalized),
      );
    },
  );
  return router;
}

async function handlePremiereApiRequest(
  request: Request,
  response: Response,
  options: ReplayPremiereHttpOptions,
  operationTimeoutMs: number,
): Promise<void> {
  const readRoute = matchProxyWarPublicPremiereReadPath(request.path);
  const writeRoute = matchProxyWarPublicPremiereWritePath(request.path);
  if (
    readRoute?.kind === "page" ||
    readRoute?.kind === "card" ||
    readRoute?.kind === "archive_clip"
  ) {
    throw unavailable("premiere_non_api_route_reached_api_adapter", 404);
  }
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    readRoute !== null
  ) {
    if (request.headers.range !== undefined) {
      throw invalidRequest("premiere_range_request_rejected", 416);
    }
    const target = requireTarget(options.registry, readRoute.premiereId);
    const runtime = target.runtime;
    switch (readRoute.kind) {
      case "bootstrap":
        sendJson(response, 200, runtime.readBootstrap());
        return;
      case "manifest":
        sendJson(
          response,
          200,
          await withTimeout(runtime.readManifest(), operationTimeoutMs),
        );
        return;
      case "chunk": {
        const chunk = runtime.readChunk(readRoute.chunkIndex);
        if (chunk === null)
          throw unavailable("premiere_chunk_not_released", 404);
        sendJson(response, 200, chunk);
        return;
      }
      case "reveal": {
        const reveal = runtime.readReveal();
        if (reveal === null)
          throw unavailable("premiere_reveal_not_available", 404);
        sendJson(response, 200, reveal);
        return;
      }
      case "clip_status": {
        // Fail closed exactly like a nonexistent replay when generation is
        // disabled or this immutable source has no cached artifact.
        if (options.clips === undefined) {
          throw unavailable("premiere_clips_disabled", 404);
        }
        const clipState = runtime.readLifecycleState();
        if (
          clipState === "failed" ||
          clipState === "cancelled" ||
          clipState === "archived"
        ) {
          throw unavailable("premiere_clip_absent", 404);
        }
        const status = options.clips.readStatus({
          premiereId: readRoute.premiereId,
          bucket: readRoute.bucket,
          sourceReplaySha256:
            runtime.readBootstrap().provenance.sourceReplaySha256,
        });
        if (status.state === "absent") {
          throw unavailable("premiere_clip_absent", 404);
        }
        sendJson(response, 200, status);
        return;
      }
      case "clip_file":
        // The mp4 is served by the document router, not this API adapter.
        throw unavailable("premiere_non_api_route_reached_api_adapter", 404);
      case "market_state":
        sendJson(response, 200, {
          schemaVersion: 1,
          market: target.interactions.readMarketState(null),
        });
        return;
    }
  }
  if (request.method === "POST" && writeRoute !== null) {
    const target = requireTarget(options.registry, writeRoute.premiereId);
    if (target.runtime.readLifecycleState() === "archived") {
      throw invalidRequest("premiere_interactions_archived", 410);
    }
    const idempotencyKey = requiredHeader(request, "x-idempotency-key");
    if (
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) ||
      idempotencyKey.includes("..")
    ) {
      throw invalidRequest("invalid_idempotency_key", 400);
    }
    const requesterBucketId = options.security.deriveRequesterBucketId(
      trustedClientAddress(request, options.resolveClientAddress),
    );
    const interactionContractVersion = requestedInteractionContract(request);
    if (writeRoute.kind === "session") {
      await handleSessionWrite({
        request,
        response,
        target,
        security: options.security,
        idempotencyKey,
        requesterBucketId,
        operationTimeoutMs,
        interactionContractVersion,
        clipsEnabled: options.clips !== undefined,
      });
      return;
    }
    const authorization = options.security.authorizeWrite(
      requestSecurityHeaders(request),
    );
    const participantId = authorization.participant.participantId;
    switch (writeRoute.kind) {
      case "heartbeat": {
        const body = parseHeartbeatBody(request.body);
        const result = await withTimeout(
          target.interactions.heartbeat({
            participantId,
            sessionId: writeRoute.sessionId,
            idempotencyKey,
            requesterBucketId,
            ...body,
          }),
          operationTimeoutMs,
        );
        sendJson(response, 200, {
          schemaVersion: interactionContractVersion,
          ...result,
          premiereState: target.runtime.readLifecycleState(),
          checkpoints: target.interactions.readCheckpoints(participantId),
          ...(interactionContractVersion >= 2
            ? {
                clipsEnabled: options.clips !== undefined,
                reactionSummary:
                  target.interactions.readReactionSummary(participantId),
              }
            : {}),
          ...(interactionContractVersion >= 3
            ? {
                latestOwnReaction:
                  target.interactions.readLatestOwnReaction(participantId),
              }
            : {}),
          ...(interactionContractVersion >= 4
            ? {
                clipEligibility: await readClipEligibility(
                  target,
                  options.clips !== undefined,
                  operationTimeoutMs,
                ),
              }
            : {}),
        });
        return;
      }
      case "prediction": {
        const body = parsePredictionBody(request.body);
        const result = await withTimeout(
          target.interactions.submitPrediction({
            participantId,
            idempotencyKey,
            requesterBucketId,
            ...body,
          }),
          operationTimeoutMs,
        );
        sendJson(response, 200, {
          schemaVersion: 1,
          ...result,
          checkpoint:
            target.interactions
              .readCheckpoints(participantId)
              .find((entry) => entry.id === body.checkpointId) ?? null,
        });
        return;
      }
      case "market_order": {
        const body = parseMarketOrderBody(request.body);
        const result = await withTimeout(
          target.interactions.submitMarketOrder({
            participantId,
            participantKind: "real",
            idempotencyKey,
            requesterBucketId,
            ...body,
          }),
          operationTimeoutMs,
        );
        sendJson(response, 200, {
          schemaVersion: 1,
          ...result,
          market: target.interactions.readMarketState(participantId),
        });
        return;
      }
      case "reaction": {
        const body = parseReactionBody(request.body);
        const result = await withTimeout(
          target.interactions.submitReaction({
            participantId,
            idempotencyKey,
            requesterBucketId,
            ...body,
          }),
          operationTimeoutMs,
        );
        sendJson(response, 200, {
          schemaVersion: interactionContractVersion,
          ...result,
          ...(interactionContractVersion >= 2
            ? {
                clipsEnabled: options.clips !== undefined,
                reactionSummary:
                  target.interactions.readReactionSummary(participantId),
              }
            : {}),
          ...(interactionContractVersion >= 3
            ? {
                latestOwnReaction:
                  target.interactions.readLatestOwnReaction(participantId),
              }
            : {}),
          ...(interactionContractVersion >= 4
            ? {
                clipEligibility: await readClipEligibility(
                  target,
                  options.clips !== undefined,
                  operationTimeoutMs,
                ),
              }
            : {}),
        });
        return;
      }
      case "share": {
        const body = parseShareBody(request.body);
        const result = await withTimeout(
          target.interactions.createShare({
            participantId,
            idempotencyKey,
            requesterBucketId,
            ...body,
          }),
          operationTimeoutMs,
        );
        sendJson(response, 200, { schemaVersion: 1, ...result });
        return;
      }
      case "clip": {
        // Replay lifecycle is not clip eligibility. Any public released prefix
        // may render, while terminal/private states still fail closed.
        if (options.clips === undefined) {
          throw unavailable("premiere_clips_disabled", 404);
        }
        const state = target.runtime.readLifecycleState();
        if (
          state === "failed" ||
          state === "cancelled" ||
          state === "archived"
        ) {
          throw unavailable("premiere_clip_unavailable", 404);
        }
        const clipBody = parseClipBody(request.body);
        const clipEligibility = await readClipEligibility(
          target,
          true,
          operationTimeoutMs,
        );
        if (
          !clipEligibility.generationEnabled ||
          clipEligibility.renderableThroughTurn === null
        ) {
          throw unavailable("premiere_clip_range_unavailable", 404);
        }
        const anchor = resolveClipAnchor(target, clipBody);
        // Shared anonymous-write admission, exactly like reaction/share writes
        // (which admit inside the interactions layer). Clips have no session.
        options.registry.admitAnonymousWrite({
          route: "clip",
          premiereId: writeRoute.premiereId,
          participantId,
          sessionId: null,
          requesterBucketId,
          idempotencyKey,
          occurredAt: new Date().toISOString(),
          currentPremiereRecordCount: 0,
        });
        const status = await withTimeout(
          options.clips.requestClip({
            premiereId: writeRoute.premiereId,
            anchorTurn: anchor.turn,
            participantId,
            sourceReplaySha256:
              target.runtime.readBootstrap().provenance.sourceReplaySha256,
            renderableThroughTurn: clipEligibility.renderableThroughTurn,
            sourceComplete: clipEligibility.sourceComplete,
          }),
          operationTimeoutMs,
        );
        sendJson(response, 200, status);
        return;
      }
    }
  }
  if (readRoute !== null || writeRoute !== null) {
    response.setHeader("Allow", readRoute !== null ? "GET, HEAD" : "POST");
    throw invalidRequest("premiere_method_not_allowed", 405);
  }
  throw unavailable("premiere_route_not_found", 404);
}

async function handleSessionWrite(options: {
  request: Request;
  response: Response;
  target: ReplayPremiereHttpTarget;
  security: ReplayPremiereGuestSecurity;
  idempotencyKey: string;
  requesterBucketId: string;
  operationTimeoutMs: number;
  interactionContractVersion: ReplayPremiereInteractionContractVersion;
  clipsEnabled: boolean;
}): Promise<void> {
  const body = parseSessionBody(options.request.body);
  const guest = options.security.authorizeSessionCreation(
    requestSecurityHeaders(options.request),
  );
  // Commit the participant binding to the response before starting a durable
  // operation. If the bounded HTTP wait expires but persistence later commits,
  // the 503 still carries this cookie and a retry reuses the same participant.
  if (guest.setCookie !== null) {
    options.response.setHeader("Set-Cookie", guest.setCookie);
  }
  const attribution =
    body.attributionToken === null
      ? null
      : options.security.verifyShareAttribution(body.attributionToken);
  if (body.attributionToken !== null && attribution === null) {
    throw invalidRequest("invalid_share_attribution", 400);
  }
  const incomingMoment =
    attribution === null
      ? null
      : resolveIncomingMoment(options.target, attribution);
  if (attribution !== null && incomingMoment === null) {
    throw invalidRequest("share_attribution_not_found", 400);
  }
  const session = await withTimeout(
    options.target.interactions.createViewerSession({
      participantId: guest.participant.participantId,
      idempotencyKey: options.idempotencyKey,
      requesterBucketId: options.requesterBucketId,
      visible: body.visible,
      observedSequence: body.observedSequence,
      excludedAsOperator: false,
      excludedAsBot: isReplayPremiereBotUserAgent(
        options.request.headers["user-agent"],
      ),
      incomingAttribution: attribution,
    }),
    options.operationTimeoutMs,
  );
  sendJson(options.response, 201, {
    schemaVersion: options.interactionContractVersion,
    csrfToken: guest.csrfToken,
    session,
    premiereState: options.target.runtime.readLifecycleState(),
    checkpoints: options.target.interactions.readCheckpoints(
      guest.participant.participantId,
    ),
    incomingMoment,
    ...(options.interactionContractVersion >= 2
      ? {
          clipsEnabled: options.clipsEnabled,
          reactionSummary: options.target.interactions.readReactionSummary(
            guest.participant.participantId,
          ),
        }
      : {}),
    ...(options.interactionContractVersion >= 3
      ? {
          latestOwnReaction: options.target.interactions.readLatestOwnReaction(
            guest.participant.participantId,
          ),
        }
      : {}),
    ...(options.interactionContractVersion >= 4
      ? {
          clipEligibility: await readClipEligibility(
            options.target,
            options.clipsEnabled,
            options.operationTimeoutMs,
          ),
        }
      : {}),
  });
}

async function readClipEligibility(
  target: ReplayPremiereHttpTarget,
  serviceEnabled: boolean,
  operationTimeoutMs: number,
): Promise<ReplayClipEligibility> {
  const unavailableEligibility: ReplayClipEligibility = {
    generationEnabled: false,
    renderableThroughTurn: null,
    sourceComplete: false,
  };
  if (!serviceEnabled) return unavailableEligibility;
  const state = target.runtime.readLifecycleState();
  if (state === "failed" || state === "cancelled" || state === "archived") {
    return unavailableEligibility;
  }
  try {
    const reveal = target.runtime.readReveal();
    if (reveal !== null) {
      const finalContext = target.runtime.readReleasedContext(
        reveal.finalSequence,
      );
      return {
        generationEnabled: finalContext !== null,
        renderableThroughTurn: finalContext?.turn ?? null,
        sourceComplete: finalContext !== null,
      };
    }
    const manifest = await withTimeout(
      target.runtime.readManifest(),
      operationTimeoutMs,
    );
    if (!("releasedThroughSequence" in manifest)) {
      return unavailableEligibility;
    }
    const releasedContext = target.runtime.readReleasedContext(
      manifest.releasedThroughSequence,
    );
    return {
      generationEnabled: true,
      renderableThroughTurn: releasedContext?.turn ?? null,
      sourceComplete: false,
    };
  } catch {
    // Clip availability is optional payoff state; a failed projection must not
    // turn a valid heartbeat/session into a 503.
    return unavailableEligibility;
  }
}

function parseSessionBody(value: unknown): {
  visible: boolean;
  observedSequence: number;
  attributionToken: string | null;
} {
  const body = exactObject(
    value,
    ["visible", "observedSequence"],
    ["attributionToken"],
  );
  return {
    visible: booleanField(body, "visible"),
    observedSequence: observedSequenceField(body, "observedSequence"),
    attributionToken: nullableStringField(body, "attributionToken", 1_024),
  };
}

function parseHeartbeatBody(value: unknown): {
  visible: boolean;
  observedSequence: number;
} {
  const body = exactObject(value, ["visible", "observedSequence"]);
  return {
    visible: booleanField(body, "visible"),
    observedSequence: observedSequenceField(body, "observedSequence"),
  };
}

function parsePredictionBody(value: unknown): {
  sessionId: string;
  checkpointId: string;
  selectedSeatId: string;
} {
  const body = exactObject(value, [
    "sessionId",
    "checkpointId",
    "selectedSeatId",
  ]);
  const sessionId = stringField(body, "sessionId", 64);
  const checkpointId = stringField(body, "checkpointId", 64);
  const selectedSeatId = stringField(body, "selectedSeatId", 128);
  if (
    !SESSION_ID_PATTERN.test(sessionId) ||
    !CHECKPOINT_ID_PATTERN.test(checkpointId) ||
    !SEAT_ID_PATTERN.test(selectedSeatId) ||
    selectedSeatId.includes("..")
  ) {
    throw invalidRequest("invalid_prediction_body", 400);
  }
  return { sessionId, checkpointId, selectedSeatId };
}

function parseMarketOrderBody(value: unknown): {
  sessionId: string;
  seatId: string;
  side: "buy" | "sell";
  amount: number;
  limitPrice: number;
} {
  const body = exactObject(value, [
    "sessionId",
    "seatId",
    "side",
    "amount",
    "limitPrice",
  ]);
  const sessionId = stringField(body, "sessionId", 64);
  const seatId = stringField(body, "seatId", 128);
  const side = stringField(body, "side", 4);
  const amount = marketOrderAmountField(body, "amount");
  const limitPrice = limitPriceField(body, "limitPrice");
  if (
    !SESSION_ID_PATTERN.test(sessionId) ||
    !SEAT_ID_PATTERN.test(seatId) ||
    seatId.includes("..") ||
    (side !== "buy" && side !== "sell")
  ) {
    throw invalidRequest("invalid_market_order_body", 400);
  }
  return { sessionId, seatId, side, amount, limitPrice };
}

function marketOrderAmountField(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = record[key];
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > 1_000_000
  ) {
    throw invalidRequest(`invalid_${key}`, 400);
  }
  return value as number;
}

function limitPriceField(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw invalidRequest(`invalid_${key}`, 400);
  }
  return value;
}

function parseReactionBody(value: unknown): {
  sessionId: string;
  sequence: number;
  kind: ReplayPremiereReactionKind;
  policySeatId: string | null;
} {
  const body = exactObject(
    value,
    ["sessionId", "sequence", "kind"],
    ["policySeatId"],
  );
  const sessionId = stringField(body, "sessionId", 64);
  const sequence = sequenceField(body, "sequence");
  const kind = stringField(body, "kind", 32) as ReplayPremiereReactionKind;
  const policySeatId = nullableStringField(body, "policySeatId", 128);
  if (
    !SESSION_ID_PATTERN.test(sessionId) ||
    !REACTION_KINDS.has(kind) ||
    (policySeatId !== null &&
      (!SEAT_ID_PATTERN.test(policySeatId) || policySeatId.includes("..")))
  ) {
    throw invalidRequest("invalid_reaction_body", 400);
  }
  return { sessionId, sequence, kind, policySeatId };
}

function parseShareBody(value: unknown): {
  sessionId: string;
  sourceReactionId: string | null;
  sequence: number | null;
} {
  const body = exactObject(
    value,
    ["sessionId"],
    ["sourceReactionId", "sequence"],
  );
  const sessionId = stringField(body, "sessionId", 64);
  const sourceReactionId = nullableStringField(body, "sourceReactionId", 64);
  const sequence = nullableSequenceField(body, "sequence");
  if (
    !SESSION_ID_PATTERN.test(sessionId) ||
    (sourceReactionId !== null &&
      !REACTION_ID_PATTERN.test(sourceReactionId)) ||
    (sourceReactionId === null && sequence === null)
  ) {
    throw invalidRequest("invalid_share_body", 400);
  }
  return { sessionId, sourceReactionId, sequence };
}

function parseClipBody(value: unknown): {
  sourceReactionId: string | null;
  sequence: number | null;
  turn: number | null;
} {
  const body = exactObject(value, [], ["sourceReactionId", "sequence", "turn"]);
  const sourceReactionId = nullableStringField(body, "sourceReactionId", 64);
  const sequence = nullableSequenceField(body, "sequence");
  const turn = nullableSequenceField(body, "turn");
  const hasReaction = sourceReactionId !== null;
  const hasSequenceTurn = sequence !== null && turn !== null;
  // Exactly one anchor form: a source reaction, or a full sequence+turn pair.
  if (
    (hasReaction && (sequence !== null || turn !== null)) ||
    (!hasReaction && !hasSequenceTurn) ||
    (sourceReactionId !== null && !REACTION_ID_PATTERN.test(sourceReactionId))
  ) {
    throw invalidRequest("invalid_clip_body", 400);
  }
  return { sourceReactionId, sequence, turn };
}

/**
 * Resolve a clip anchor to a canonical released turn, validated exactly like
 * share moments (sequence <= releasedThroughSequence via readReleasedContext).
 */
function resolveClipAnchor(
  target: ReplayPremiereHttpTarget,
  body: {
    sourceReactionId: string | null;
    sequence: number | null;
    turn: number | null;
  },
): { sequence: number; turn: number } {
  if (body.sourceReactionId !== null) {
    const reaction = target.interactions
      .readState()
      .reactions.find((entry) => entry.id === body.sourceReactionId);
    if (reaction === undefined) {
      throw invalidRequest("clip_reaction_not_found", 400);
    }
    const context = target.runtime.readReleasedContext(reaction.sequence);
    if (context === null) throw invalidRequest("clip_reaction_unreleased", 410);
    return { sequence: reaction.sequence, turn: context.turn };
  }
  const sequence = body.sequence as number;
  const context = target.runtime.readReleasedContext(sequence);
  if (context === null) throw invalidRequest("clip_sequence_unreleased", 410);
  if (context.turn !== body.turn) {
    throw invalidRequest("clip_turn_mismatch", 400);
  }
  return { sequence, turn: context.turn };
}

function requestSecurityHeaders(request: Request): {
  cookie?: string | string[];
  origin?: string | string[];
  csrfToken?: string | string[];
} {
  return {
    cookie: request.headers.cookie,
    origin: request.headers.origin,
    csrfToken: request.headers["x-csrf-token"],
  };
}

function requireTarget(
  registry: ReplayPremiereHttpRegistry,
  premiereId: string,
): ReplayPremiereHttpTarget {
  const target = registry.get(premiereId);
  if (target === null) throw unavailable("premiere_not_registered", 404);
  return target;
}

function resolveIncomingMoment(
  target: ReplayPremiereHttpTarget,
  attribution: ReplayPremiereShareAttribution,
): ReplayPremiereIncomingMoment | null {
  if (attribution.premiereId !== target.runtime.premiereId) return null;
  const share = target.interactions.readShareMoment(attribution.shareId);
  if (
    share === null ||
    share.createdByParticipantId !== attribution.attributionId
  ) {
    return null;
  }
  return { shareId: share.id, sequence: share.sequence, turn: share.turn };
}

function trustedClientAddress(
  request: Request,
  resolver: ReplayPremiereHttpOptions["resolveClientAddress"],
): string {
  const address =
    resolver === undefined
      ? (request.socket.remoteAddress ?? null)
      : resolver(request);
  if (address === null) throw invalidRequest("remote_address_unavailable", 400);
  return address;
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers[name];
  const single = optionalSingleHeader(value);
  if (single === null)
    throw invalidRequest(`missing_${name.replaceAll("-", "_")}`, 400);
  return single;
}

/**
 * Opt-in additive interaction response contract. Each recognized version is
 * immutable; missing, duplicated, malformed, or unknown values deliberately
 * stay on the exact legacy v1 shape. That lets both an old tab and a newly
 * loaded tab survive opposite sides of a rolling server transition.
 */
function requestedInteractionContract(
  request: Request,
): ReplayPremiereInteractionContractVersion {
  const requested = request.headers["x-proxywar-premiere-interactions"];
  if (requested === "4") return 4;
  if (requested === "3") return 3;
  if (requested === "2") return 2;
  return 1;
}

function optionalSingleHeader(
  value: string | string[] | undefined,
): string | null {
  if (value === undefined) return null;
  if (
    Array.isArray(value) ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes(",")
  ) {
    throw invalidRequest("ambiguous_or_oversized_header", 400);
  }
  return value;
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("request_body_must_be_object", 400);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw invalidRequest("request_body_shape_rejected", 400);
  }
  return record;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  max: number,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw invalidRequest(`invalid_${key}`, 400);
  }
  return value;
}

function nullableStringField(
  record: Record<string, unknown>,
  key: string,
  max: number,
): string | null {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  return stringField(record, key, max);
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  if (typeof record[key] !== "boolean")
    throw invalidRequest(`invalid_${key}`, 400);
  return record[key];
}

function observedSequenceField(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = record[key];
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < -1 ||
    (value as number) > 10_000_000
  ) {
    throw invalidRequest(`invalid_${key}`, 400);
  }
  return value as number;
}

function sequenceField(record: Record<string, unknown>, key: string): number {
  const value = observedSequenceField(record, key);
  if (value < 0) throw invalidRequest(`invalid_${key}`, 400);
  return value;
}

function nullableSequenceField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  return sequenceField(record, key);
}

function isPremiereApiPath(pathname: string): boolean {
  return (
    pathname === "/api/premieres" || pathname.startsWith("/api/premieres/")
  );
}

function setNoStoreHeaders(response: Response): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("CDN-Cache-Control", "no-store");
  response.setHeader("Surrogate-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox",
  );
  response.setHeader("Vary", "Origin, Cookie");
}

function sendJson(response: Response, status: number, value: unknown): void {
  setNoStoreHeaders(response);
  const body = JSON.stringify(value);
  response.status(status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(response.req.method === "HEAD" ? undefined : body);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(unavailable("premiere_operation_timeout", 503)),
          timeoutMs,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function normalizeHttpError(error: unknown): unknown {
  if (error instanceof ReplayPremiereError) return error;
  if (
    error !== null &&
    typeof error === "object" &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    return capacityExceeded("premiere_request_body_too_large", 413);
  }
  if (error instanceof SyntaxError)
    return invalidRequest("invalid_json_body", 400);
  return error;
}

function isPublicErrorCode(
  value: unknown,
): value is ReplayPremierePublicErrorCode {
  return (
    value === "PREMIERE_CAPACITY_EXCEEDED" ||
    value === "PREMIERE_INTEGRITY_FAILURE" ||
    value === "PREMIERE_INVALID_REQUEST" ||
    value === "PREMIERE_SOURCE_INELIGIBLE" ||
    value === "PREMIERE_UNAVAILABLE"
  );
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  operatorCode: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidRequest(operatorCode, 400);
  }
  return value;
}

function invalidRequest(
  operatorCode: string,
  status: number,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    status,
    `Replay Premiere request rejected: ${operatorCode}`,
  );
}

function capacityExceeded(
  operatorCode: string,
  status: number,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_CAPACITY_EXCEEDED",
    status,
    `Replay Premiere capacity rejected: ${operatorCode}`,
  );
}

function unavailable(
  operatorCode: string,
  status: number,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_UNAVAILABLE",
    status,
    `Replay Premiere unavailable: ${operatorCode}`,
  );
}
