import {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  AgentStrategyProfile,
} from "./AgentTypes";
import { buildExternalAgentRequestPayload } from "./ExternalHttpAgentBrain";
import { LlmDecisionParser } from "./LlmDecisionParser";
import { RuleAgentBrain } from "./RuleAgentBrain";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ExternalRelayAgentBrainOptions {
  relayBaseUrl: string;
  sessionID: string;
  token?: string;
  timeoutMs?: number;
  profile: AgentStrategyProfile;
  fetchFn?: FetchLike;
  fallbackBrain?: AgentBrain;
}

const defaultExternalRelayDecisionTimeoutMs = 15_000;

export class ExternalRelayAgentBrain implements AgentBrain {
  readonly brainType = "external-relay";

  private readonly relayBaseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchLike;
  private readonly fallbackBrain: AgentBrain;
  private readonly parser = new LlmDecisionParser({ maxReasonLength: 500 });

  constructor(private readonly options: ExternalRelayAgentBrainOptions) {
    this.relayBaseUrl = parseRelayBaseUrl(options.relayBaseUrl);
    this.timeoutMs = options.timeoutMs ?? defaultExternalRelayDecisionTimeoutMs;
    this.fetchFn = options.fetchFn ?? fetch;
    this.fallbackBrain =
      options.fallbackBrain ?? new RuleAgentBrain(options.profile);
  }

  async decide(input: AgentBrainInput): Promise<AgentDecision> {
    if (input.legalActions.length === 0) {
      return {
        actionID: "",
        reason: "Relay agent had no legal actions to choose from.",
        metadata: {
          brain: "external-relay",
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
        `managed relay request failed: ${errorMessage(error)}`,
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
        brain: "external-relay",
        externalActionCall: true,
        externalEndpoint: relayLabel(this.relayBaseUrl, this.options.sessionID),
        parseSuccess: true,
        fallbackUsed: false,
        rawProviderOutputPresent: raw.trim().length > 0,
        ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
        externalRawOutput: truncate(raw, 1_000),
      },
    };
  }

  private async complete(input: AgentBrainInput): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(this.requestUrl(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          request: buildExternalAgentRequestPayload(input),
          timeoutMs: this.timeoutMs,
        }),
        signal: controller.signal,
        redirect: "manual",
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${truncate(text, 360)}`);
      }
      const parsed = JSON.parse(text) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof (parsed as { responseText?: unknown }).responseText !== "string"
      ) {
        throw new Error("relay response did not include responseText");
      }
      return (parsed as { responseText: string }).responseText;
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private requestUrl(): string {
    const url = new URL(
      `/api/agent-relay/sessions/${encodeURIComponent(
        this.options.sessionID,
      )}/requests`,
      this.relayBaseUrl,
    );
    return url.toString();
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "x-proxywar-agent-protocol": "proxywar-agent-v1",
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
      reason: `Managed relay fallback: ${failureReason}; ${fallback.reason}`,
      metadata: {
        ...fallback.metadata,
        brain: "external-relay",
        externalActionCall: true,
        externalEndpoint: relayLabel(this.relayBaseUrl, this.options.sessionID),
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

function parseRelayBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("relayBaseUrl must be an http or https URL");
  }
  url.hash = "";
  url.search = "";
  return url;
}

function relayLabel(url: URL, sessionID: string): string {
  return `${url.origin}/api/agent-relay/sessions/${sessionID}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
