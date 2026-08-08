import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

const STARTER_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "tester-starter-llm",
  "llm-player.mjs",
);

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found in llm-player.mjs`).toBeGreaterThan(
    -1,
  );
  const end = source.indexOf("\n}", start);
  expect(end, `function ${name} has no top-level close`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

describe("tester-starter-llm full-prompt hardening", () => {
  it("parses normal JSON and repairs only a truncated final reason", async () => {
    const source = await fs.readFile(STARTER_FILE, "utf8");
    const extractJson = new Function(
      `${extractFunction(source, "extractJson")}\nreturn extractJson;`,
    )() as (
      text: string,
      repairTruncatedReason?: boolean,
    ) => Record<string, unknown> | null;

    expect(
      extractJson('prefix {"focus":"attack","preferKinds":["attack"]} suffix'),
    ).toEqual({ focus: "attack", preferKinds: ["attack"] });
    expect(
      extractJson(
        '{"focus":"attack","preferKinds":["attack"],"target":"Auri","avoidTargets":[],"deal":null,"reason":"press now',
        true,
      ),
    ).toEqual({
      focus: "attack",
      preferKinds: ["attack"],
      target: "Auri",
      avoidTargets: [],
      deal: null,
      reason: "press now",
    });
    expect(
      extractJson(
        '{"focus":"attack","preferKinds":["attack"],"target":"Aur',
        true,
      ),
    ).toBeNull();
    expect(
      extractJson(
        '{"focus":"attack","preferKinds":["attack"],"target":"Auri","avoidTargets":[],"deal":null,"reason":"press now',
      ),
    ).toBeNull();
    expect(extractJson("ordinary prose without an object")).toBeNull();
    expect(extractJson('{"focus": not-json')).toBeNull();
  });

  it("normalizes raw Bedrock usage counters without inventing tokens", async () => {
    const source = await fs.readFile(STARTER_FILE, "utf8");
    const tokenCountSrc = extractFunction(source, "tokenCount");
    const optionalTokenCountSrc = extractFunction(source, "optionalTokenCount");
    const normalizeSrc = extractFunction(source, "normalizeBedrockUsage");
    const normalize = new Function(
      `${tokenCountSrc}\n${optionalTokenCountSrc}\n${normalizeSrc}\nreturn normalizeBedrockUsage;`,
    )() as (usage: unknown) => Record<string, unknown>;

    expect(
      normalize({
        input_tokens: 3525,
        output_tokens: 87,
        cache_creation_input_tokens: 1024,
        cache_read_input_tokens: 0,
      }),
    ).toEqual({
      usageAvailable: true,
      inputTokens: 3525,
      outputTokens: 87,
      cacheCreationInputTokens: 1024,
      cacheReadInputTokens: 0,
    });
    expect(
      normalize({
        inputTokens: "25",
        outputTokens: -4,
        cacheCreationInputTokens: Number.NaN,
      }),
    ).toEqual({
      usageAvailable: false,
      inputTokens: 25,
      outputTokens: undefined,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
    });
  });

  it("isolates the current baseline from the hardened candidate request", async () => {
    const source = await fs.readFile(STARTER_FILE, "utf8");

    const buildRequest = new Function(
      `${extractFunction(source, "buildBedrockRequest")}\nreturn buildBedrockRequest;`,
    )() as (
      model: string,
      prompt: string,
      hardening: boolean,
    ) => Record<string, unknown>;
    const responseText = new Function(
      `${extractFunction(source, "bedrockResponseText")}\nreturn bedrockResponseText;`,
    )() as (response: unknown, hardening: boolean) => string;

    expect(buildRequest("model", "prompt", false)).toEqual({
      model: "model",
      max_tokens: 300,
      messages: [{ role: "user", content: "prompt" }],
    });
    expect(buildRequest("model", "prompt", true)).toEqual({
      model: "model",
      max_tokens: 500,
      messages: [
        { role: "user", content: "prompt" },
        { role: "assistant", content: "{" },
      ],
    });
    const response = { content: [{ text: '"focus":"attack"}' }] };
    expect(responseText(response, false)).toBe('"focus":"attack"}');
    expect(responseText(response, true)).toBe('{"focus":"attack"}');

    expect(source).toContain("PROXYWAR_PROMPT_HARDENING");
    expect(source).not.toContain("PROXYWAR_PROMPT_VARIANT");
    expect(source).toContain("Reply with ONLY JSON:");
    expect(source).toContain(
      "Reply with ONLY a JSON object — no prose before or after it:",
    );
  });

  it("keeps the full menu and makes usage treatment explicit", async () => {
    const source = await fs.readFile(STARTER_FILE, "utf8");

    expect(source).toContain("legalActions: legal,");
    expect(source).not.toContain("legalKinds,");
    expect(source).toContain("max_tokens: hardening ? 500 : 300,");
    expect(source).toContain('{ role: "assistant", content: "{" },');
    expect(source).toContain("return hardening ? `{${text}` : text;");
    expect(source).toContain("PROXYWAR_LLM_USAGE");
    expect(source).toContain('event: "response"');
    expect(source).toContain('event: "plan_result"');
    expect(source).toContain('event: "summary"');

    // Usage logging must whitelist bounded counters/labels rather than spread
    // an arbitrary event that could contain state or model content.
    const emitSrc = extractFunction(source, "emitPlannerUsage");
    expect(emitSrc).toContain("normalizePlannerUsageEvent(event)");
    expect(emitSrc).not.toContain("...event");

    const normalizerSrc = extractFunction(source, "normalizePlannerUsageEvent");
    expect(normalizerSrc).not.toContain("...event");
    expect(normalizerSrc).not.toContain('normalized["prompt"]');
    expect(normalizerSrc).not.toContain('normalized["state"]');
    expect(normalizerSrc).not.toContain('normalized["text"]');
  });
});
