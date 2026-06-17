import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENROUTER_MAX_TOKENS,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_TIMEOUT_MS,
  OpenRouterLlmProvider,
  extractOpenRouterText,
  loadOpenRouterLlmProviderConfig,
} from "../../src/server/agents/OpenRouterLlmProvider";

function chatResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status },
  );
}

describe("OpenRouterLlmProvider", () => {
  it("fails clearly when the API key is missing", () => {
    expect(() => loadOpenRouterLlmProviderConfig({})).toThrow(
      /AI_LEAGUE_OPENROUTER_API_KEY/,
    );
  });

  it("loads typed config with sensible defaults", () => {
    const config = loadOpenRouterLlmProviderConfig({
      OPENROUTER_API_KEY: "test-key",
    });
    expect(config).toMatchObject({
      apiKey: "test-key",
      model: DEFAULT_OPENROUTER_MODEL,
      timeoutMs: DEFAULT_OPENROUTER_TIMEOUT_MS,
      maxRetries: 0,
      maxOutputTokens: DEFAULT_OPENROUTER_MAX_TOKENS,
      temperature: 0.2,
    });
  });

  it("honors explicit env overrides and the model precedence chain", () => {
    const config = loadOpenRouterLlmProviderConfig({
      AI_LEAGUE_OPENROUTER_API_KEY: "explicit-key",
      OPENROUTER_API_KEY: "fallback-key",
      AI_LEAGUE_OPENROUTER_MODEL: "deepseek/deepseek-v4-flash",
      AI_LEAGUE_OPENROUTER_TIMEOUT_MS: "30000",
      AI_LEAGUE_OPENROUTER_MAX_TOKENS: "800",
      AI_LEAGUE_OPENROUTER_TEMPERATURE: "0.5",
    });
    expect(config).toMatchObject({
      apiKey: "explicit-key",
      model: "deepseek/deepseek-v4-flash",
      timeoutMs: 30000,
      maxOutputTokens: 800,
      temperature: 0.5,
    });
  });

  it("rejects out-of-range numeric env", () => {
    expect(() =>
      loadOpenRouterLlmProviderConfig({
        OPENROUTER_API_KEY: "k",
        AI_LEAGUE_OPENROUTER_MAX_TOKENS: "10",
      }),
    ).toThrow(/AI_LEAGUE_OPENROUTER_MAX_TOKENS/);
  });

  it("returns content and sends the chat-completions request shape", async () => {
    const calls: RequestInit[] = [];
    const provider = new OpenRouterLlmProvider({
      apiKey: "test-key",
      model: "deepseek/deepseek-v4-flash",
      endpoint: "https://example.test/v1/chat/completions",
      timeoutMs: 1_000,
      maxRetries: 0,
      maxOutputTokens: 600,
      temperature: 0.2,
      fetchFn: async (_input, init) => {
        calls.push(init);
        return chatResponse('{"objective":"expand_territory"}');
      },
    });

    await expect(provider.complete("plan prompt")).resolves.toBe(
      '{"objective":"expand_territory"}',
    );
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].body as string);
    expect(body).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: "json_object" },
    });
    expect(body.messages.at(-1)).toMatchObject({
      role: "user",
      content: "plan prompt",
    });
  });

  it("times out slow provider calls (fail loud)", async () => {
    const provider = new OpenRouterLlmProvider({
      apiKey: "test-key",
      model: "m",
      endpoint: "https://example.test/v1/chat/completions",
      timeoutMs: 1,
      maxRetries: 0,
      maxOutputTokens: 600,
      temperature: 0.2,
      fetchFn: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });

    await expect(provider.complete("prompt")).rejects.toThrow(/timed out/);
  });

  it("fails loud on a non-2xx response and redacts bearer tokens", async () => {
    const secretToken = "proxy-tok_ABC123.def-456";
    const provider = new OpenRouterLlmProvider({
      apiKey: "test-key",
      model: "m",
      endpoint: "https://example.test/v1/chat/completions",
      timeoutMs: 1_000,
      maxRetries: 0,
      maxOutputTokens: 600,
      temperature: 0.2,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            error: { message: `Bearer ${secretToken} rejected` },
          }),
          { status: 429 },
        ),
    });

    const error = await provider.complete("prompt").then(
      () => {
        throw new Error("expected complete() to reject");
      },
      (err: unknown) => err as Error,
    );
    expect(error.message).toContain("HTTP 429");
    expect(error.message).toContain("Bearer [redacted-token]");
    expect(error.message).not.toContain(secretToken);
  });

  it("fails loud on empty content and missing choices", async () => {
    const empty = new OpenRouterLlmProvider({
      apiKey: "k",
      model: "m",
      endpoint: "https://example.test/v1/chat/completions",
      timeoutMs: 1_000,
      maxRetries: 0,
      maxOutputTokens: 600,
      temperature: 0.2,
      fetchFn: async () => chatResponse("   "),
    });
    await expect(empty.complete("p")).rejects.toThrow(/no message content/);

    const noChoices = new OpenRouterLlmProvider({
      apiKey: "k",
      model: "m",
      endpoint: "https://example.test/v1/chat/completions",
      timeoutMs: 1_000,
      maxRetries: 0,
      maxOutputTokens: 600,
      temperature: 0.2,
      fetchFn: async () =>
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    });
    await expect(noChoices.complete("p")).rejects.toThrow(/no choices/);
  });

  it("retries then succeeds when maxRetries allows", async () => {
    let attempts = 0;
    const provider = new OpenRouterLlmProvider({
      apiKey: "k",
      model: "m",
      endpoint: "https://example.test/v1/chat/completions",
      timeoutMs: 1_000,
      maxRetries: 1,
      maxOutputTokens: 600,
      temperature: 0.2,
      fetchFn: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response("{}", { status: 503 });
        }
        return chatResponse('{"objective":"survive"}');
      },
    });
    await expect(provider.complete("p")).resolves.toBe(
      '{"objective":"survive"}',
    );
    expect(attempts).toBe(2);
  });

  it("extractOpenRouterText trims and validates", () => {
    expect(
      extractOpenRouterText({ choices: [{ message: { content: "  hi  " } }] }),
    ).toBe("hi");
    expect(() => extractOpenRouterText({ choices: [] })).toThrow(/no choices/);
  });
});
