import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import type { LegalAction } from "./AgentTypes";
import type { ExternalAgentRequest } from "./ExternalHttpAgentBrain";
import { LlmDecisionParser } from "./LlmDecisionParser";

export interface ExternalAgentRelaySessionCreateInput {
  agentName: string;
  profile: string;
  relayBaseUrl: string;
  ttlMs?: number;
}

export interface ExternalAgentRelaySessionRestoreInput {
  sessionID: string;
  sessionToken: string;
  agentName: string;
  profile: string;
  relayBaseUrl: string;
  ttlMs?: number;
}

export interface ExternalAgentRelaySessionCreated {
  sessionID: string;
  sessionToken: string;
  relayBaseUrl: string;
  expiresAt: string;
  pollUrl: string;
  decisionsUrl: string;
}

export interface ExternalAgentRelayDecisionResult {
  requestID: string;
  responseText: string;
}

export type ExternalAgentRelayPollResult =
  | {
      ok: true;
      status: "idle";
      sessionID: string;
      expiresAt: string;
    }
  | {
      ok: true;
      status: "request";
      sessionID: string;
      requestID: string;
      expiresAt: string;
      request: ExternalAgentRequest;
    };

export class ExternalAgentRelayError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = "external_agent_relay_error",
    readonly fix?: string,
  ) {
    super(message);
  }
}

interface PendingRelayRequest {
  requestID: string;
  request: ExternalAgentRequest;
  createdAt: number;
  deliveredAt: number | null;
  timeout: NodeJS.Timeout;
  resolve: (result: ExternalAgentRelayDecisionResult) => void;
  reject: (error: ExternalAgentRelayError) => void;
}

interface RelaySession {
  sessionID: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  relayBaseUrl: string;
  agentName: string;
  profile: string;
  pending: Map<string, PendingRelayRequest>;
  waiters: Array<(result: ExternalAgentRelayPollResult) => void>;
  workerSeenAt: number | null;
}

export interface ExternalAgentRelayStoreOptions {
  now?: () => number;
  sessionTtlMs?: number;
  requestTimeoutMs?: number;
  maxPendingRequestsPerSession?: number;
  redeliveryMs?: number;
}

const defaultSessionTtlMs = 2 * 60 * 60 * 1_000;
const defaultRequestTimeoutMs = 120_000;
const defaultMaxPendingRequestsPerSession = 4;
const defaultRedeliveryMs = 5_000;

export class ExternalAgentRelayStore {
  private readonly sessions = new Map<string, RelaySession>();
  private readonly parser = new LlmDecisionParser({ maxReasonLength: 500 });

  constructor(private readonly options: ExternalAgentRelayStoreOptions = {}) {}

  createSession(
    input: ExternalAgentRelaySessionCreateInput,
  ): ExternalAgentRelaySessionCreated {
    this.cleanupExpired();
    const now = this.now();
    const sessionID = `relay_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const sessionToken = randomBytes(32).toString("base64url");
    const ttlMs = boundedMs(
      input.ttlMs,
      60_000,
      24 * 60 * 60 * 1_000,
      this.options.sessionTtlMs ?? defaultSessionTtlMs,
    );
    const relayBaseUrl = normalizeRelayBaseUrl(input.relayBaseUrl);
    const session: RelaySession = {
      sessionID,
      tokenHash: hashToken(sessionToken),
      createdAt: now,
      expiresAt: now + ttlMs,
      relayBaseUrl,
      agentName: input.agentName,
      profile: input.profile,
      pending: new Map(),
      waiters: [],
      workerSeenAt: null,
    };
    this.sessions.set(sessionID, session);
    return {
      sessionID,
      sessionToken,
      relayBaseUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
      pollUrl: `${relayBaseUrl}/api/agent-relay/sessions/${encodeURIComponent(
        sessionID,
      )}/poll`,
      decisionsUrl: `${relayBaseUrl}/api/agent-relay/sessions/${encodeURIComponent(
        sessionID,
      )}/decisions`,
    };
  }

  restoreSession(input: ExternalAgentRelaySessionRestoreInput): {
    ok: true;
    sessionID: string;
    relayBaseUrl: string;
    expiresAt: string;
    restored: boolean;
  } {
    this.cleanupExpired();
    const sessionID = normalizeRelaySessionID(input.sessionID);
    const sessionToken = input.sessionToken.trim();
    if (sessionToken === "") {
      throw new ExternalAgentRelayError(
        "Managed relay token is missing.",
        401,
        "relay_token_missing",
        "Use the session token returned by /api/agent-relay/sessions as a Bearer token.",
      );
    }
    const tokenHash = hashToken(sessionToken);
    const existing = this.sessions.get(sessionID);
    if (existing !== undefined) {
      if (!safeTokenEqual(existing.tokenHash, tokenHash)) {
        throw new ExternalAgentRelayError(
          "Managed relay token is invalid.",
          401,
          "relay_token_invalid",
          "Rerun the bootstrap command; do not edit the relay token.",
        );
      }
      return {
        ok: true,
        sessionID,
        relayBaseUrl: existing.relayBaseUrl,
        expiresAt: new Date(existing.expiresAt).toISOString(),
        restored: false,
      };
    }

    const now = this.now();
    const ttlMs = boundedMs(
      input.ttlMs,
      60_000,
      24 * 60 * 60 * 1_000,
      this.options.sessionTtlMs ?? defaultSessionTtlMs,
    );
    const relayBaseUrl = normalizeRelayBaseUrl(input.relayBaseUrl);
    const session: RelaySession = {
      sessionID,
      tokenHash,
      createdAt: now,
      expiresAt: now + ttlMs,
      relayBaseUrl,
      agentName: input.agentName,
      profile: input.profile,
      pending: new Map(),
      waiters: [],
      workerSeenAt: null,
    };
    this.sessions.set(sessionID, session);
    return {
      ok: true,
      sessionID,
      relayBaseUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
      restored: true,
    };
  }

  async poll(input: {
    sessionID: string;
    token: string | undefined;
    waitMs?: number;
  }): Promise<ExternalAgentRelayPollResult> {
    const session = this.sessionForToken(input.sessionID, input.token);
    session.workerSeenAt = this.now();
    const immediate = this.nextPollResult(session);
    if (immediate !== null) {
      return immediate;
    }
    const waitMs = boundedMs(input.waitMs, 0, 30_000, 25_000);
    if (waitMs <= 0) {
      return this.idle(session);
    }
    return new Promise((resolve) => {
      let waiter: (result: ExternalAgentRelayPollResult) => void = () => {};
      const timeout = setTimeout(() => {
        removeWaiter(session, waiter);
        resolve(this.idle(session));
      }, waitMs);
      waiter = (result: ExternalAgentRelayPollResult) => {
        clearTimeout(timeout);
        resolve(result);
      };
      session.waiters.push(waiter);
    });
  }

  requestDecision(input: {
    sessionID: string;
    token: string | undefined;
    request: ExternalAgentRequest;
    timeoutMs?: number;
  }): Promise<ExternalAgentRelayDecisionResult> {
    const session = this.sessionForToken(input.sessionID, input.token);
    if (session.pending.size >= this.maxPendingRequestsPerSession()) {
      throw new ExternalAgentRelayError(
        "Managed relay has too many pending decision requests for this session.",
        429,
        "relay_session_busy",
        "Keep exactly one relay worker running for this starter and wait for the current decision to finish.",
      );
    }
    const timeoutMs = boundedMs(
      input.timeoutMs,
      250,
      180_000,
      this.options.requestTimeoutMs ?? defaultRequestTimeoutMs,
    );
    const requestID = `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    let pending: PendingRelayRequest;
    const promise = new Promise<ExternalAgentRelayDecisionResult>(
      (resolve, reject) => {
        pending = {
          requestID,
          request: input.request,
          createdAt: this.now(),
          deliveredAt: null,
          timeout: setTimeout(() => {
            session.pending.delete(requestID);
            reject(
              new ExternalAgentRelayError(
                `Managed relay decision timed out after ${timeoutMs}ms.`,
                408,
                "relay_decision_timeout",
                "Confirm the local relay worker is still running and the configured Codex/Claude/custom command is logged in and non-interactive.",
              ),
            );
          }, timeoutMs),
          resolve,
          reject,
        };
      },
    );
    session.pending.set(requestID, pending!);
    this.notifyWaiters(session);
    return promise;
  }

  submitDecision(input: {
    sessionID: string;
    token: string | undefined;
    requestID: string;
    response: unknown;
  }): ExternalAgentRelayDecisionResult {
    const session = this.sessionForToken(input.sessionID, input.token);
    session.workerSeenAt = this.now();
    const requestID = String(input.requestID ?? "").trim();
    if (requestID === "") {
      throw new ExternalAgentRelayError(
        "Managed relay decision response is missing requestID.",
        400,
        "relay_missing_request_id",
        "Post the requestID from the poll response with the selectedLegalActionId decision.",
      );
    }
    const pending = session.pending.get(requestID);
    if (pending === undefined) {
      throw new ExternalAgentRelayError(
        "Managed relay request was not found or already expired.",
        404,
        "relay_request_not_found",
        "Poll for a fresh request and submit the matching requestID.",
      );
    }
    const workerError = relayWorkerErrorMessage(input.response);
    if (workerError !== null) {
      session.pending.delete(requestID);
      clearTimeout(pending.timeout);
      const error = new ExternalAgentRelayError(
        `Managed relay worker reported an error: ${workerError}`,
        422,
        "relay_worker_error",
        "Check the local relay worker log, fix the configured Codex/Claude/custom command, then restart the worker.",
      );
      pending.reject(error);
      throw error;
    }
    const responseText = responseTextForRelayDecision(input.response);
    const parsed = this.parser.parse(
      responseText,
      parserLegalActions(pending.request),
    );
    if (!parsed.ok) {
      session.pending.delete(requestID);
      clearTimeout(pending.timeout);
      const error = new ExternalAgentRelayError(
        `Managed relay rejected the local decision: ${parsed.reason}`,
        422,
        "relay_invalid_decision",
        `Return strict JSON with selectedLegalActionId equal to one offered id, for example ${exampleDecision(
          pending.request,
        )}.`,
      );
      pending.reject(error);
      throw error;
    }
    session.pending.delete(requestID);
    clearTimeout(pending.timeout);
    const result = { requestID, responseText };
    pending.resolve(result);
    return result;
  }

  closeSession(input: {
    sessionID: string;
    token: string | undefined;
  }): { ok: true } {
    const session = this.sessionForToken(input.sessionID, input.token);
    this.deleteSession(session);
    return { ok: true };
  }

  hasSession(sessionID: string): boolean {
    this.cleanupExpired();
    return this.sessions.has(sessionID);
  }

  hasActiveSession(sessionID: string, maxIdleMs = 90_000): boolean {
    this.cleanupExpired();
    const session = this.sessions.get(sessionID);
    if (session === undefined || session.expiresAt <= this.now()) {
      return false;
    }
    if (session.workerSeenAt === null) {
      return false;
    }
    const boundedIdleMs = boundedMs(maxIdleMs, 1_000, 30 * 60_000, 90_000);
    return this.now() - session.workerSeenAt <= boundedIdleMs;
  }

  private notifyWaiters(session: RelaySession): void {
    if (session.waiters.length === 0) {
      return;
    }
    const result = this.nextPollResult(session);
    if (result === null) {
      return;
    }
    const waiters = session.waiters.splice(0);
    for (const waiter of waiters) {
      waiter(result);
    }
  }

  private nextPollResult(
    session: RelaySession,
  ): ExternalAgentRelayPollResult | null {
    const now = this.now();
    const redeliveryMs = this.options.redeliveryMs ?? defaultRedeliveryMs;
    const pending = [...session.pending.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .find(
        (request) =>
          request.deliveredAt === null || now - request.deliveredAt >= redeliveryMs,
      );
    if (pending === undefined) {
      return null;
    }
    pending.deliveredAt = now;
    return {
      ok: true,
      status: "request",
      sessionID: session.sessionID,
      requestID: pending.requestID,
      expiresAt: new Date(session.expiresAt).toISOString(),
      request: pending.request,
    };
  }

  private idle(session: RelaySession): ExternalAgentRelayPollResult {
    return {
      ok: true,
      status: "idle",
      sessionID: session.sessionID,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  private sessionForToken(
    sessionID: string,
    token: string | undefined,
  ): RelaySession {
    if (token === undefined || token.trim() === "") {
      throw new ExternalAgentRelayError(
        "Managed relay token is missing.",
        401,
        "relay_token_missing",
        "Use the session token returned by /api/agent-relay/sessions as a Bearer token.",
      );
    }
    const session = this.sessions.get(sessionID);
    if (session === undefined) {
      throw new ExternalAgentRelayError(
        "Managed relay session was not found or has expired.",
        404,
        "relay_session_not_found",
        "Create a fresh relay session by rerunning the /agent-start.sh bootstrap command.",
      );
    }
    if (!safeTokenEqual(session.tokenHash, hashToken(token.trim()))) {
      throw new ExternalAgentRelayError(
        "Managed relay token is invalid.",
        401,
        "relay_token_invalid",
        "Rerun the bootstrap command; do not edit the relay token.",
      );
    }
    if (session.expiresAt <= this.now()) {
      this.deleteSession(session);
      throw new ExternalAgentRelayError(
        "Managed relay session expired.",
        410,
        "relay_session_expired",
        "Create a fresh relay session by rerunning the /agent-start.sh bootstrap command.",
      );
    }
    return session;
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= now) {
        this.deleteSession(session);
      }
    }
  }

  private deleteSession(session: RelaySession): void {
    this.sessions.delete(session.sessionID);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new ExternalAgentRelayError(
          "Managed relay session closed before the decision completed.",
          410,
          "relay_session_closed",
        ),
      );
    }
    session.pending.clear();
    const waiters = session.waiters.splice(0);
    for (const waiter of waiters) {
      waiter(this.idle(session));
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private maxPendingRequestsPerSession(): number {
    return Math.max(
      1,
      Math.min(
        16,
        Math.floor(
          this.options.maxPendingRequestsPerSession ??
            defaultMaxPendingRequestsPerSession,
        ),
      ),
    );
  }
}

function responseTextForRelayDecision(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.responseText === "string") {
      return record.responseText;
    }
    if (
      record.decision !== undefined &&
      record.decision !== null &&
      typeof record.decision === "object" &&
      !Array.isArray(record.decision)
    ) {
      return JSON.stringify(record.decision);
    }
    if (record.selectedLegalActionId !== undefined || record.actionId !== undefined) {
      const { requestID: _requestID, ...decision } = record;
      return JSON.stringify(decision);
    }
  }
  return JSON.stringify(value) ?? "";
}

function relayWorkerErrorMessage(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.responseText !== undefined ||
    record.decision !== undefined ||
    record.selectedLegalActionId !== undefined ||
    record.actionId !== undefined
  ) {
    return null;
  }
  if (typeof record.error !== "string") {
    return null;
  }
  const message = record.error.trim();
  return message.length > 0 ? message.slice(0, 500) : "unknown local worker error";
}

function parserLegalActions(request: ExternalAgentRequest): LegalAction[] {
  return request.legalActions.map((action) => ({
    id: action.id,
    kind: action.kind as LegalAction["kind"],
    label: action.label,
    risk: action.risk,
    metadata: action.metadata,
    intent: null,
  }));
}

function exampleDecision(request: ExternalAgentRequest): string {
  const actionID =
    request.legalActions.find((action) => action.kind !== "hold")?.id ??
    request.legalActions[0]?.id ??
    "one-offered-id";
  return JSON.stringify({
    selectedLegalActionId: actionID,
    reason: "short reason",
  });
}

function normalizeRelayBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("bad protocol");
    }
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new ExternalAgentRelayError(
      "Managed relay base URL must be a valid http or https URL.",
      400,
      "relay_base_url_invalid",
      "Use the beta origin, for example https://beta.proxywar.xyz.",
    );
  }
}

function normalizeRelaySessionID(value: string): string {
  const sessionID = String(value ?? "").trim();
  if (!/^relay_[a-f0-9]{24}$/i.test(sessionID)) {
    throw new ExternalAgentRelayError(
      "Managed relay session ID is invalid.",
      400,
      "relay_session_id_invalid",
      "Create a fresh relay session by rerunning the /agent-start.sh bootstrap command.",
    );
  }
  return sessionID;
}

function boundedMs(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeTokenEqual(leftHash: string, rightHash: string): boolean {
  const left = Buffer.from(leftHash);
  const right = Buffer.from(rightHash);
  return left.length === right.length && timingSafeEqual(left, right);
}

function removeWaiter(
  session: RelaySession,
  waiter: (result: ExternalAgentRelayPollResult) => void,
): void {
  const index = session.waiters.indexOf(waiter);
  if (index >= 0) {
    session.waiters.splice(index, 1);
  }
}
