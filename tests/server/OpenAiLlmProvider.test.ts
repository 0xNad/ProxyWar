import { describe, expect, it } from "vitest";
import {
  OpenAiLlmProvider,
  extractOpenAiResponseText,
  loadOpenAiLlmProviderConfig,
} from "../../src/server/agents/OpenAiLlmProvider";

describe("OpenAiLlmProvider", () => {
  it("fails clearly when real provider config is missing", () => {
    expect(() =>
      loadOpenAiLlmProviderConfig({
        AI_LEAGUE_LLM_PROVIDER: "openai",
      }),
    ).toThrow(/OPENAI_API_KEY/);
    expect(() =>
      loadOpenAiLlmProviderConfig({
        AI_LEAGUE_LLM_PROVIDER: "mock",
      }),
    ).toThrow(/AI_LEAGUE_LLM_PROVIDER=openai/);
  });

  it("loads typed config from environment without requiring it by default", () => {
    const config = loadOpenAiLlmProviderConfig({
      AI_LEAGUE_LLM_PROVIDER: "openai",
      AI_LEAGUE_LLM_MODEL: "gpt-test",
      OPENAI_API_KEY: "test-key",
      AI_LEAGUE_LLM_TIMEOUT_MS: "2500",
      AI_LEAGUE_LLM_MAX_RETRIES: "1",
    });

    expect(config).toMatchObject({
      apiKey: "test-key",
      model: "gpt-test",
      timeoutMs: 2500,
      maxRetries: 1,
    });
  });

  it("returns output text from the Responses API shape", async () => {
    const calls: RequestInit[] = [];
    const provider = new OpenAiLlmProvider({
      apiKey: "test-key",
      model: "gpt-test",
      endpoint: "https://example.test/v1/responses",
      timeoutMs: 1_000,
      maxRetries: 0,
      maxOutputTokens: 42,
      fetchFn: async (_input, init) => {
        calls.push(init);
        return new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: '{"selectedLegalActionId":"hold","reason":"Safe."}',
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    await expect(provider.complete("prompt")).resolves.toBe(
      '{"selectedLegalActionId":"hold","reason":"Safe."}',
    );
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body as string)).toMatchObject({
      model: "gpt-test",
      input: "prompt",
      max_output_tokens: 42,
      store: false,
    });
  });

  it("times out slow provider calls", async () => {
    const provider = new OpenAiLlmProvider({
      apiKey: "test-key",
      model: "gpt-test",
      endpoint: "https://example.test/v1/responses",
      timeoutMs: 1,
      maxRetries: 0,
      maxOutputTokens: 42,
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

  it("extracts SDK-style output_text when present", () => {
    expect(extractOpenAiResponseText({ output_text: "  hello  " })).toBe(
      "hello",
    );
  });
});
