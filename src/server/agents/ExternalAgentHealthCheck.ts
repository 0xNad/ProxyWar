import { PlayerType } from "../../core/game/Game";
import {
  AgentObservation,
  LegalAction,
} from "./AgentTypes";
import {
  assertExternalAgentEndpointAllowed,
  fetchExternalAgentWithPolicy,
  normalizeExternalAgentEndpointUrl,
  readExternalAgentResponseText,
} from "./ExternalAgentNetworkPolicy";
import {
  normalizeExternalAgentTokenInput,
  resolveExternalAgentToken,
} from "./ExternalAgentSecrets";
import { LlmDecisionParser } from "./LlmDecisionParser";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ExternalAgentHealthCheckInput {
  endpointUrl: unknown;
  token?: unknown;
  timeoutMs?: unknown;
  fetchFn?: FetchLike;
  allowTokenReferences?: boolean;
}

export interface NormalizedExternalAgentHealthCheckInput {
  endpointUrl: string;
  token?: string;
  timeoutMs: number;
  fetchFn?: FetchLike;
}

export interface ExternalAgentHealthCheckResult {
  ok: boolean;
  endpoint: string;
  latencyMs: number;
  request: {
    method: "POST";
    protocolVersion: "proxywar-agent-v1";
    contentType: "application/json";
  };
  offeredLegalActionIDs: string[];
  expectedResponse: {
    selectedLegalActionId: string;
    reason: string;
    confidence: string;
  };
  selectedLegalActionId?: string;
  reason?: string;
  confidence?: number;
  failureReason?: string;
  fixHint?: string;
  rawOutput?: string;
}

const healthCheckLegalActions: LegalAction[] = [
  {
    id: "health-check:expand",
    kind: "attack",
    label: "Health-check expansion action",
    intent: null,
    risk: { level: "low", score: 0.2 },
    metadata: { expansion: true, healthCheck: true },
  },
  {
    id: "health-check:hold",
    kind: "hold",
    label: "Health-check hold action",
    intent: null,
    risk: { level: "none", score: 0 },
    metadata: { healthCheck: true },
  },
];

const healthCheckObservation: AgentObservation = {
  agentID: "health-check-agent",
  clientID: null,
  username: "Health Check Nation",
  profile: "opportunistic",
  gameID: "HEALTHCHECK",
  phase: "active",
  turnNumber: 1,
  tick: 100,
  ownState: {
    playerID: "PLAYER_HEALTH",
    clientID: null,
    smallID: 1,
    name: "Health Check Nation",
    type: PlayerType.Human,
    isAlive: true,
    isDisconnected: false,
    isTraitor: false,
    hasSpawned: true,
    troops: 100,
    gold: "100",
    tilesOwned: 25,
    borderTiles: 4,
    outgoingAttacks: 0,
    incomingAttacks: 0,
    outgoingAllianceRequests: 0,
    incomingAllianceRequests: 0,
  },
  visiblePlayers: [],
  combat: {
    ownTroops: 100,
    borderedPlayerIDs: [],
    attackablePlayerIDs: [],
    canExpandIntoNeutral: true,
    neutralExpansionLegalReason: "health-check neutral expansion candidate",
    incomingAttackPlayerIDs: [],
    outgoingAttackPlayerIDs: [],
    weakestAttackableTargetID: null,
    strongestAttackableTargetID: null,
    blockerNotes: [],
  },
  nonCombat: {
    buildOptions: [],
    supportOptions: [],
    embargoOptions: [],
    blockerNotes: [],
  },
  strategic: {
    priority: "expand",
    urgency: "medium",
    summary: "health-check observation",
    scores: {
      expansion: 0.8,
      economy: 0.4,
      defense: 0.2,
      offense: 0.3,
      diplomacy: 0.1,
      threat: 0,
      idleTroops: 0.7,
    },
    recommendedActionKinds: ["attack", "hold"],
    targetPlayerIDs: [],
    notes: ["This is a synthetic protocol health check, not a real match."],
  },
  memory: {
    recentActions: [],
    recentActionCountsByKind: {},
    recentNonHoldCount: 0,
    recentExpansionCount: 0,
    recentBuildCount: 0,
    repeatedActionKind: null,
    repeatedActionCount: 0,
    avoidActionIDs: [],
    summary: "no recent health-check decisions",
    notes: [],
  },
  objective: null,
  recentDecisions: [],
  notes: ["Synthetic health check payload."],
};

export function normalizeExternalAgentHealthCheckInput(
  input: ExternalAgentHealthCheckInput,
): NormalizedExternalAgentHealthCheckInput {
  if (typeof input.endpointUrl !== "string") {
    throw new Error("Endpoint URL must be text");
  }
  const endpointUrl = normalizeEndpointUrl(input.endpointUrl);
  const tokenReference = normalizeExternalAgentTokenInput(
    input.token,
    "Endpoint bearer token",
  );
  if (
    input.allowTokenReferences !== true &&
    (tokenReference.tokenEnv !== undefined ||
      tokenReference.tokenSecret !== undefined)
  ) {
    throw new Error(
      "Endpoint token references are operator-only. Paste a beta-only token here or leave the token blank.",
    );
  }
  const token = resolveExternalAgentToken(tokenReference);
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
  return {
    endpointUrl,
    ...(token !== undefined ? { token } : {}),
    timeoutMs,
    ...(input.fetchFn !== undefined ? { fetchFn: input.fetchFn } : {}),
  };
}

export async function checkExternalAgentEndpoint(
  input: NormalizedExternalAgentHealthCheckInput,
): Promise<ExternalAgentHealthCheckResult> {
  const startedAt = Date.now();
  const endpoint = endpointLabel(input.endpointUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const fetchFn = input.fetchFn ?? fetch;
  const offeredLegalActionIDs = healthCheckLegalActions.map(
    (action) => action.id,
  );
  const baseResult = (): Pick<
    ExternalAgentHealthCheckResult,
    "endpoint" | "request" | "offeredLegalActionIDs" | "expectedResponse"
  > => ({
    endpoint,
    request: {
      method: "POST",
      protocolVersion: "proxywar-agent-v1",
      contentType: "application/json",
    },
    offeredLegalActionIDs,
    expectedResponse: {
      selectedLegalActionId:
        "one of health-check:expand or health-check:hold",
      reason: "short human-readable string",
      confidence: "optional number from 0 to 1",
    },
  });
  try {
    const policyOptions = {
      allowPrivateNetwork:
        process.env.PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS === "true",
    };
    await assertExternalAgentEndpointAllowed(input.endpointUrl, policyOptions);
    const init: RequestInit = {
      method: "POST",
      headers: headers(input.token),
      body: JSON.stringify(healthCheckPayload()),
      signal: controller.signal,
      redirect: "manual",
    };
    const response =
      input.fetchFn === undefined
        ? await fetchExternalAgentWithPolicy(input.endpointUrl, init, policyOptions)
        : await fetchFn(input.endpointUrl, init);
    const rawOutput = await readExternalAgentResponseText(response);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const failureReason = `HTTP ${response.status}: ${truncate(rawOutput, 240)}`;
      return {
        ok: false,
        ...baseResult(),
        latencyMs,
        failureReason,
        fixHint: healthCheckFixHint(failureReason, input.endpointUrl),
        rawOutput: truncate(rawOutput, 1_000),
      };
    }
    const parsed = new LlmDecisionParser({ maxReasonLength: 500 }).parse(
      rawOutput,
      healthCheckLegalActions,
    );
    if (!parsed.ok) {
      return {
        ok: false,
        ...baseResult(),
        latencyMs,
        failureReason: parsed.reason,
        fixHint: healthCheckFixHint(parsed.reason, input.endpointUrl),
        rawOutput: truncate(rawOutput, 1_000),
      };
    }
    return {
      ok: true,
      ...baseResult(),
      latencyMs,
      selectedLegalActionId: parsed.selectedLegalActionId,
      reason: parsed.reason,
      ...(parsed.confidence !== undefined
        ? { confidence: parsed.confidence }
        : {}),
      rawOutput: truncate(rawOutput, 1_000),
    };
  } catch (error) {
    const failureReason = isAbortError(error)
      ? `timed out after ${input.timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    return {
      ok: false,
      ...baseResult(),
      latencyMs: Date.now() - startedAt,
      failureReason,
      fixHint: healthCheckFixHint(failureReason, input.endpointUrl),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function healthCheckFixHint(message: string, endpointUrl: string): string {
  const lower = message.toLowerCase();
  const url = new URL(endpointUrl);
  if (lower.includes("unknown selectedlegalactionid")) {
    return "Choose exactly one id from this health check: health-check:expand or health-check:hold.";
  }
  if (lower.includes("unknown json field: actionid")) {
    return "Return selectedLegalActionId, not actionId. The value must exactly match one offered legalActions[].id.";
  }
  if (
    lower.includes("unknown json field: intent") ||
    lower.includes("unknown json field: type") ||
    lower.includes("raw intent")
  ) {
    return "Do not return raw game-engine intent JSON. Return only selectedLegalActionId, reason, and optional confidence.";
  }
  if (
    lower.includes("llm provider required") ||
    lower.includes("proxywar_agent_llm_provider")
  ) {
    return "Configure the starter model backend first, then restart the endpoint: PROXYWAR_AGENT_LLM_PROVIDER=codex-cli, claude-cowork, command, or openrouter. Run npm run self-test before saving the agent.";
  }
  if (lower.includes("openrouter_api_key")) {
    return "The starter is set to OpenRouter but no key is configured. Set OPENROUTER_API_KEY, or switch to codex-cli, claude-cowork, or command, then run npm run self-test.";
  }
  if (lower.includes("proxywar_agent_llm_command")) {
    return "The command-backed starter needs PROXYWAR_AGENT_LLM_COMMAND set to a non-interactive command that prints the strict JSON decision. Run npm run self-test after restarting.";
  }
  if (lower.includes("not logged in") || lower.includes("/login")) {
    return "Claude CLI is installed but not logged in for terminal use. Run `claude`, type `/login`, complete the browser login, exit Claude, then restart the starter and run npm run self-test.";
  }
  if (
    lower.includes("could not start llm command") ||
    lower.includes("llm command exited") ||
    lower.includes("enoent")
  ) {
    return "The starter could not run its model command. Check that Codex CLI, Claude/Cowork, or your custom command is installed and logged in, then run npm run self-test.";
  }
  if (lower.includes("content-type")) {
    return url.pathname.endsWith(".md") || url.pathname.includes("agent-card")
      ? "Manual Test Endpoint expects the POST decision endpoint, usually /proxywar/decide. Use Connect With One Link for /agent-card.md URLs."
      : "Return application/json or text/plain containing the strict decision JSON.";
  }
  if (lower.includes("json") || lower.includes("parse") || lower.includes("malformed")) {
    return "Return strict JSON only, with no prose wrapper or markdown fence.";
  }
  if (lower.includes("http 401") || lower.includes("http 403")) {
    return "If the endpoint requires auth, paste a beta-only bearer token in the token field. Do not put it in the Agent Card.";
  }
  if (/http 30[1278]/.test(lower)) {
    return "Redirects are disabled for external-agent checks. Paste the final public HTTPS decision endpoint directly, usually /proxywar/decide.";
  }
  if (lower.includes("http 404") || lower.includes("not found")) {
    return "Check the endpoint path. The starter decision path is /proxywar/decide; /agent-card.md is for Agent Card import.";
  }
  if (lower.includes("private") || lower.includes("reserved") || lower.includes("https")) {
    return "Remote beta endpoints must be public HTTPS. For local-only testing, start the host with PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS=true.";
  }
  if (lower.includes("timed out") || lower.includes("abort")) {
    return "The endpoint did not answer before its timeout. Reduce model/tool work, return a fast valid id, or raise endpointTimeoutMs for private tests. For the starter, run npm run self-test locally first.";
  }
  if (
    lower.includes("enotfound") ||
    lower.includes("getaddrinfo") ||
    lower.includes("eai_again") ||
    lower.includes("econnrefused") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("did not resolve")
  ) {
    return "Make sure the service is running and reachable from the Proxy War host. If this is a saved beta agent, restart or re-expose the endpoint, then retry Test Endpoint or delete the stale saved agent.";
  }
  return "Your endpoint must accept POST JSON and return selectedLegalActionId, reason, and optional confidence.";
}

function healthCheckPayload() {
  return {
    protocolVersion: "proxywar-agent-v1",
    agent: {
      agentID: healthCheckObservation.agentID,
      username: healthCheckObservation.username,
      profile: healthCheckObservation.profile,
    },
    match: {
      gameID: healthCheckObservation.gameID,
      phase: healthCheckObservation.phase,
      turnNumber: healthCheckObservation.turnNumber,
      tick: healthCheckObservation.tick,
    },
    observation: healthCheckObservation,
    legalActions: healthCheckLegalActions.map((action) => ({
      id: action.id,
      kind: action.kind,
      label: action.label,
      risk: action.risk,
      metadata: action.metadata,
    })),
    responseContract: {
      selectedLegalActionId:
        "must exactly match one offered legalActions[].id",
      reason: "short human-readable string",
      confidence: "optional number from 0 to 1",
    },
  };
}

function headers(token: string | undefined): HeadersInit {
  return {
    "content-type": "application/json",
    accept: "application/json",
    "x-proxywar-agent-protocol": "proxywar-agent-v1",
    ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
  };
}

function normalizeEndpointUrl(value: string): string {
  return normalizeExternalAgentEndpointUrl(value).url;
}

function normalizeTimeoutMs(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return 5_000;
  }
  const timeoutMs =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 250 ||
    timeoutMs > 180_000
  ) {
    throw new Error("Endpoint timeout must be 250-180000 ms");
  }
  return timeoutMs;
}

function endpointLabel(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message.includes("aborted");
  }
  if (error !== null && typeof error === "object") {
    return (error as { name?: unknown }).name === "AbortError";
  }
  return false;
}
