import { LlmProvider, LlmProviderConfigError } from "./LlmProvider";

export { LlmProviderConfigError } from "./LlmProvider";

export interface OpenAiLlmProviderConfig {
  apiKey: string;
  model: string;
  endpoint: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
  fetchFn?: FetchLike;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface OpenAiResponseBody {
  output_text?: unknown;
  output?: unknown;
}

export class OpenAiLlmProvider implements LlmProvider {
  readonly providerType = "openai";
  private readonly fetchFn: FetchLike;

  constructor(private readonly config: OpenAiLlmProviderConfig) {
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
    const controller = new AbortController();
    const timeoutID = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const response = await this.fetchFn(this.config.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          input: prompt,
          max_output_tokens: this.config.maxOutputTokens,
          store: false,
        }),
        signal: controller.signal,
      });
      const bodyText = await response.text();

      if (!response.ok) {
        throw new Error(
          `OpenAI Responses API returned HTTP ${response.status}: ${safeErrorBody(
            bodyText,
          )}`,
        );
      }

      let body: OpenAiResponseBody;
      try {
        body = JSON.parse(bodyText) as OpenAiResponseBody;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw errorWithCause(
          `OpenAI Responses API returned invalid JSON: ${message}`,
          error,
        );
      }

      return extractOpenAiResponseText(body);
    } catch (error) {
      if (isAbortError(error)) {
        throw errorWithCause(
          `OpenAI LLM request timed out after ${this.config.timeoutMs}ms`,
          error,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutID);
    }
  }
}

export function loadOpenAiLlmProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenAiLlmProviderConfig {
  const provider = env.AI_LEAGUE_LLM_PROVIDER?.trim().toLowerCase();
  if (provider !== "openai") {
    throw new LlmProviderConfigError(
      "Real LLM smoke requires AI_LEAGUE_LLM_PROVIDER=openai.",
    );
  }

  const apiKey = requiredEnv(env, "OPENAI_API_KEY");
  const model = requiredEnv(env, "AI_LEAGUE_LLM_MODEL");

  const endpoint = env.AI_LEAGUE_LLM_ENDPOINT?.trim();

  return {
    apiKey,
    model,
    endpoint:
      endpoint === undefined || endpoint === ""
        ? "https://api.openai.com/v1/responses"
        : endpoint,
    timeoutMs: positiveIntegerEnv(env, "AI_LEAGUE_LLM_TIMEOUT_MS", 15_000),
    maxRetries: positiveIntegerEnv(env, "AI_LEAGUE_LLM_MAX_RETRIES", 0, {
      min: 0,
      max: 3,
    }),
    maxOutputTokens: positiveIntegerEnv(
      env,
      "AI_LEAGUE_LLM_MAX_OUTPUT_TOKENS",
      300,
      { min: 1, max: 2_000 },
    ),
  };
}

export function createOpenAiLlmProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenAiLlmProvider {
  return new OpenAiLlmProvider(loadOpenAiLlmProviderConfig(env));
}

export function extractOpenAiResponseText(body: OpenAiResponseBody): string {
  if (typeof body.output_text === "string" && body.output_text.trim() !== "") {
    return body.output_text.trim();
  }

  const texts: string[] = [];
  collectOutputText(body.output, texts);
  const text = texts.join("").trim();
  if (text === "") {
    throw new Error("OpenAI Responses API response contained no output text");
  }
  return text;
}

function collectOutputText(value: unknown, texts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectOutputText(item, texts);
    }
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "output_text" && typeof record.text === "string") {
    texts.push(record.text);
  }
  collectOutputText(record.content, texts);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new LlmProviderConfigError(
      `Real LLM smoke requires ${name}; no API call was made.`,
    );
  }
  return value;
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
    .slice(0, 500);
}
