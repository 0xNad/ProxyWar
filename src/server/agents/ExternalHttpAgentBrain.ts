import {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  AgentStrategyProfile,
  LegalAction,
} from "./AgentTypes";
import {
  fetchExternalAgentWithPolicy,
  normalizeExternalAgentEndpointUrl,
  readExternalAgentResponseText,
} from "./ExternalAgentNetworkPolicy";
import { LlmDecisionParser } from "./LlmDecisionParser";
import { RuleAgentBrain } from "./RuleAgentBrain";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ExternalHttpAgentBrainOptions {
  endpointUrl: string;
  token?: string;
  timeoutMs?: number;
  maxRetries?: number;
  profile: AgentStrategyProfile;
  fetchFn?: FetchLike;
  fallbackBrain?: AgentBrain;
}

interface ExternalAgentRequest {
  protocolVersion: "open-frontier-agent-v1";
  agent: {
    agentID: string;
    username: string;
    profile: AgentStrategyProfile;
  };
  match: {
    gameID: string;
    phase: string;
    turnNumber: number;
    tick: number | null;
  };
  observation: AgentBrainInput["observation"];
  legalActions: Array<{
    id: string;
    kind: string;
    label: string;
    risk: LegalAction["risk"];
    metadata?: LegalAction["metadata"];
  }>;
  decisionSupport: {
    actionIDsByKind: Record<string, string[]>;
    recommendedActionKinds: string[];
    usefulNonHoldActionIDs: string[];
    avoidActionIDs: string[];
    safeFallbackActionID: string | null;
    antiStallHint: string | null;
    parityNote: string;
  };
  responseContract: {
    selectedLegalActionId: "must exactly match one offered legalActions[].id";
    reason: "short human-readable string";
    confidence: "optional number from 0 to 1";
  };
}

export class ExternalHttpAgentBrain implements AgentBrain {
  readonly brainType = "external-http";

  private readonly endpointUrl: URL;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: FetchLike;
  private readonly fallbackBrain: AgentBrain;
  private readonly parser = new LlmDecisionParser({ maxReasonLength: 500 });

  constructor(private readonly options: ExternalHttpAgentBrainOptions) {
    this.endpointUrl = parseEndpointUrl(options.endpointUrl);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.fetchFn = options.fetchFn ?? fetch;
    this.fallbackBrain =
      options.fallbackBrain ?? new RuleAgentBrain(options.profile);
  }

  async decide(input: AgentBrainInput): Promise<AgentDecision> {
    if (input.legalActions.length === 0) {
      return {
        actionID: "",
        reason: "External agent had no legal actions to choose from.",
        metadata: {
          brain: "external-http",
          externalActionCall: false,
          fallbackUsed: true,
          externalFailureReason: "no legal actions",
        },
      };
    }

    let raw = "";
    try {
      raw = await this.complete(input);
    } catch (error) {
      return this.fallback(
        input,
        `external agent request failed: ${errorMessage(error)}`,
        raw,
      );
    }

    const parsed = this.parser.parse(raw, input.legalActions);
    if (!parsed.ok) {
      return this.fallback(input, parsed.reason, raw);
    }

    return {
      actionID: parsed.selectedLegalActionId,
      reason: parsed.reason,
      metadata: {
        brain: "external-http",
        externalActionCall: true,
        externalEndpoint: endpointLabel(this.endpointUrl),
        parseSuccess: true,
        fallbackUsed: false,
        rawProviderOutputPresent: raw.trim().length > 0,
        ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
        externalRawOutput: truncate(raw, 1_000),
      },
    };
  }

  private async complete(input: AgentBrainInput): Promise<string> {
    let attempt = 0;
    while (true) {
      try {
        return await this.completeOnce(input);
      } catch (error) {
        if (
          attempt >= this.maxRetries ||
          !isRetryableExternalAgentError(error)
        ) {
          throw error;
        }
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 75 * attempt));
      }
    }
  }

  private async completeOnce(input: AgentBrainInput): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(requestPayload(input)),
        signal: controller.signal,
        redirect: "manual",
      };
      const response =
        this.options.fetchFn === undefined
          ? await fetchExternalAgentWithPolicy(this.endpointUrl, init, {
              allowPrivateNetwork:
                process.env.OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS === "true",
            })
          : await this.fetchFn(this.endpointUrl.toString(), init);
      const text = await readExternalAgentResponseText(response);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${truncate(text, 240)}`);
      }
      return text;
    } catch (error) {
      if (isAbortError(error)) {
        const timeoutError = new Error(`timed out after ${this.timeoutMs}ms`);
        (timeoutError as Error & { cause?: unknown }).cause = error;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "x-open-frontier-agent-protocol": "open-frontier-agent-v1",
    };
    if (this.options.token !== undefined && this.options.token.trim() !== "") {
      headers.authorization = `Bearer ${this.options.token.trim()}`;
    }
    return headers;
  }

  private async fallback(
    input: AgentBrainInput,
    failureReason: string,
    raw: string,
  ): Promise<AgentDecision> {
    const fallback = await Promise.resolve(this.fallbackBrain.decide(input));
    return {
      ...fallback,
      reason: `External agent fallback: ${failureReason}; ${fallback.reason}`,
      metadata: {
        ...fallback.metadata,
        brain: "external-http",
        externalActionCall: true,
        externalEndpoint: endpointLabel(this.endpointUrl),
        parseSuccess: false,
        fallbackUsed: true,
        externalFailureReason: truncate(failureReason, 240),
        rawProviderOutputPresent: raw.trim().length > 0,
        ...(raw.trim().length > 0
          ? { externalRawOutput: truncate(raw, 1_000) }
          : {}),
      },
    };
  }
}

function requestPayload(input: AgentBrainInput): ExternalAgentRequest {
  const { observation, legalActions } = input;
  return {
    protocolVersion: "open-frontier-agent-v1",
    agent: {
      agentID: observation.agentID,
      username: observation.username,
      profile: observation.profile,
    },
    match: {
      gameID: observation.gameID,
      phase: observation.phase,
      turnNumber: observation.turnNumber,
      tick: observation.tick,
    },
    observation,
    legalActions: legalActions.map((action) => ({
      id: action.id,
      kind: action.kind,
      label: action.label,
      risk: action.risk,
      metadata: action.metadata,
    })),
    decisionSupport: buildDecisionSupport(observation, legalActions),
    responseContract: {
      selectedLegalActionId:
        "must exactly match one offered legalActions[].id",
      reason: "short human-readable string",
      confidence: "optional number from 0 to 1",
    },
  };
}

function buildDecisionSupport(
  observation: AgentBrainInput["observation"],
  legalActions: LegalAction[],
): ExternalAgentRequest["decisionSupport"] {
  const actionIDsByKind: Record<string, string[]> = {};
  for (const action of legalActions) {
    actionIDsByKind[action.kind] ??= [];
    actionIDsByKind[action.kind].push(action.id);
  }
  const safeFallbackActionID =
    legalActions.find((action) => action.kind === "hold")?.id ??
    legalActions.find((action) => action.kind === "spawn")?.id ??
    legalActions[0]?.id ??
    null;
  const usefulNonHoldActionIDs = legalActions
    .filter((action) => action.kind !== "hold" && action.kind !== "spawn")
    .map((action) => action.id);
  const repeatedKind = observation.memory?.repeatedActionKind ?? null;
  const repeatedCount = observation.memory?.repeatedActionCount ?? 0;
  return {
    actionIDsByKind,
    recommendedActionKinds: observation.strategic?.recommendedActionKinds ?? [],
    usefulNonHoldActionIDs,
    avoidActionIDs: observation.memory?.avoidActionIDs ?? [],
    safeFallbackActionID,
    antiStallHint:
      repeatedKind !== null && repeatedCount >= 2
        ? `Recent ${repeatedKind} loop detected (${repeatedCount}x). Prefer a useful different kind when legal.`
        : usefulNonHoldActionIDs.length > 0
          ? "A useful non-hold action is available; hold should be treated as a fallback."
          : null,
    parityNote:
      "These hints are generated by the same observation/legal-action pipeline used by house agents. They are guidance only; select exactly one offered LegalAction.id.",
  };
}

function parseEndpointUrl(value: string): URL {
  return normalizeExternalAgentEndpointUrl(value).parsed;
}

function endpointLabel(url: URL): string {
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

function isRetryableExternalAgentError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  const message = errorMessage(error).toLowerCase();
  return [
    "econnreset",
    "socket hang up",
    "epipe",
    "econnrefused",
    "fetch failed",
    "networkerror",
  ].some((needle) => message.includes(needle));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
