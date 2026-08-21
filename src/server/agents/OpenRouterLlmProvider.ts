import { createAbortableRequestAttempt } from "./AgentDecisionTimeout";
import { LlmProvider, LlmProviderConfigError } from "./LlmProvider";

export { LlmProviderConfigError } from "./LlmProvider";

// OpenRouter house/sponsored-seat provider. Calls the OpenRouter chat-completions
// API over plain fetch and returns the model's text, which the planner/decision
// parser handles like any other LLM output. Unlike the Claude CLI provider this is
// a stateless HTTP call, so concurrent sponsored seats are safe (no shared CLI
// state, no process-wide lock needed).
//
// Not a deterministic-sim concern: lives in src/server, never src/core. It fails
// LOUD on transport/parse failure (the caller surfaces llmPlannerDegraded) so a
// sponsored seat can never silently degrade into a rule bot.

export const DEFAULT_OPENROUTER_ENDPOINT =
  "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-v4-flash";
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 45_000;
// Content-only budget for the planner's JSON plan (objective, intent,
// preferred/forbidden arrays, rationale, optional commitment). Reasoning is
// disabled by default (see reasoningEnabled), so 800 is ample headroom; raise it
// only if you re-enable reasoning, which consumes this same budget first.
export const DEFAULT_OPENROUTER_MAX_TOKENS = 800;

// Neutral system message: enforce strict JSON (also satisfies OpenRouter's
// response_format=json_object requirement that some message mention "json")
// WITHOUT imposing a single-action schema — the per-call prompt (planner plan vs
// single action) already carries its own schema.
const SYSTEM_INSTRUCTION =
  "Return only strict JSON. No markdown, no code fences, no prose outside the " +
  "JSON. Follow exactly the JSON schema described in the user message.";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenRouterLlmProviderConfig {
  apiKey: string;
  model: string;
  endpoint: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
  temperature: number;
  // When false (default), send reasoning:{enabled:false}. Reasoning models
  // (e.g. deepseek-v4-flash) otherwise spend the whole token budget on reasoning
  // and return EMPTY content on long planner prompts -> fail-loud. Off = reliable
  // content, lower latency, lower cost.
  reasoningEnabled?: boolean;
  referer?: string;
  title?: string;
  fetchFn?: FetchLike;
}

interface OpenRouterResponseBody {
  choices?: unknown;
  error?: unknown;
}

export class OpenRouterLlmProvider implements LlmProvider {
  readonly providerType = "openrouter";
  readonly model: string;
  private readonly fetchFn: FetchLike;

  constructor(private readonly config: OpenRouterLlmProviderConfig) {
    this.model = config.model;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async complete(prompt: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await this.completeOnce(prompt);
      } catch (error) {
        lastError = error;
        if (attempt >= this.config.maxRetries) {
          break;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async completeOnce(prompt: string): Promise<string> {
    const { controller, timeout } = createAbortableRequestAttempt(
      this.config.timeoutMs,
    );
    // Microtask arming: a request dispatched during the synchronous
    // observation batch does not have its window consumed by later builds.
    queueMicrotask(timeout.arm);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      };
      // Optional OpenRouter attribution headers (ranking/analytics only).
      if (this.config.referer !== undefined && this.config.referer !== "") {
        headers["HTTP-Referer"] = this.config.referer;
      }
      if (this.config.title !== undefined && this.config.title !== "") {
        headers["X-Title"] = this.config.title;
      }

      const response = await this.fetchFn(this.config.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: SYSTEM_INSTRUCTION },
            { role: "user", content: prompt },
          ],
          temperature: this.config.temperature,
          max_tokens: this.config.maxOutputTokens,
          response_format: { type: "json_object" },
          // Disable reasoning unless explicitly enabled — otherwise a reasoning
          // model burns the whole budget thinking and returns empty content.
          ...(this.config.reasoningEnabled === true
            ? {}
            : { reasoning: { enabled: false } }),
        }),
        signal: controller.signal,
      });
      const bodyText = await response.text();

      if (!response.ok) {
        throw new Error(
          `OpenRouter API returned HTTP ${response.status}: ${safeErrorBody(
            bodyText,
          )}`,
        );
      }

      let body: OpenRouterResponseBody;
      try {
        body = JSON.parse(bodyText) as OpenRouterResponseBody;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw errorWithCause(
          `OpenRouter API returned invalid JSON: ${message}`,
          error,
        );
      }

      return extractOpenRouterText(body);
    } catch (error) {
      if (isAbortError(error)) {
        throw errorWithCause(
          `OpenRouter request timed out after ${this.config.timeoutMs}ms`,
          error,
        );
      }
      throw error;
    } finally {
      timeout.clear();
    }
  }
}

export function extractOpenRouterText(body: OpenRouterResponseBody): string {
  if (!Array.isArray(body.choices) || body.choices.length === 0) {
    throw new Error("OpenRouter response contained no choices");
  }
  const first = body.choices[0] as Record<string, unknown> | null;
  const message =
    first === null ? undefined : (first.message as Record<string, unknown>);
  const content = message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("OpenRouter response contained no message content");
  }
  return content.trim();
}

export function loadOpenRouterLlmProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterLlmProviderConfig {
  const apiKey =
    env.AI_LEAGUE_OPENROUTER_API_KEY?.trim() ||
    env.OPENROUTER_API_KEY?.trim() ||
    "";
  if (apiKey === "") {
    throw new LlmProviderConfigError(
      "OpenRouter brain requires AI_LEAGUE_OPENROUTER_API_KEY (or OPENROUTER_API_KEY); no API call was made.",
    );
  }

  const model =
    env.AI_LEAGUE_OPENROUTER_MODEL?.trim() ||
    env.OPENROUTER_MODEL?.trim() ||
    env.PROXYWAR_AGENT_LLM_MODEL?.trim() ||
    DEFAULT_OPENROUTER_MODEL;

  const endpoint =
    env.AI_LEAGUE_OPENROUTER_ENDPOINT?.trim() || DEFAULT_OPENROUTER_ENDPOINT;

  const timeoutMs = positiveIntegerEnv(
    env,
    "AI_LEAGUE_OPENROUTER_TIMEOUT_MS",
    DEFAULT_OPENROUTER_TIMEOUT_MS,
    { min: 1_000, max: 120_000 },
  );

  return {
    apiKey,
    model,
    endpoint,
    timeoutMs,
    // One retry by default: a rare transient empty/5xx then succeeds.
    maxRetries: positiveIntegerEnv(env, "AI_LEAGUE_OPENROUTER_MAX_RETRIES", 1, {
      min: 0,
      max: 3,
    }),
    maxOutputTokens: positiveIntegerEnv(
      env,
      "AI_LEAGUE_OPENROUTER_MAX_TOKENS",
      DEFAULT_OPENROUTER_MAX_TOKENS,
      { min: 64, max: 4_000 },
    ),
    temperature: unitFloatEnv(env, "AI_LEAGUE_OPENROUTER_TEMPERATURE", 0.2),
    reasoningEnabled:
      (env.AI_LEAGUE_OPENROUTER_REASONING?.trim().toLowerCase() ?? "off") ===
      "on",
    referer: env.AI_LEAGUE_OPENROUTER_REFERER?.trim() || "https://proxywar.xyz",
    title: env.AI_LEAGUE_OPENROUTER_TITLE?.trim() || "Proxy War",
  };
}

export function createOpenRouterLlmProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterLlmProvider {
  return new OpenRouterLlmProvider(loadOpenRouterLlmProviderConfig(env));
}

function positiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  const min = bounds.min ?? 1;
  const max = bounds.max ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new LlmProviderConfigError(
      `${name} must be an integer from ${min} to ${max}; received ${raw}.`,
    );
  }
  return value;
}

function unitFloatEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new LlmProviderConfigError(
      `${name} must be a number from 0 to 2; received ${raw}.`,
    );
  }
  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

function safeErrorBody(body: string): string {
  return body
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted-token]")
    .slice(0, 500);
}
