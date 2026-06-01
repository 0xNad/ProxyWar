import { describe, expect, it } from "vitest";
import {
  checkExternalAgentEndpoint,
  normalizeExternalAgentHealthCheckInput,
} from "../../src/server/agents/ExternalAgentHealthCheck";

describe("ExternalAgentHealthCheck", () => {
  it("verifies an endpoint can select one offered LegalAction id", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const input = normalizeExternalAgentHealthCheckInput({
      endpointUrl: "https://1.1.1.1/decide#ignore",
      token: "health-token",
      timeoutMs: "1000",
      fetchFn: async (_url, init) => {
        captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect((init.headers as Record<string, string>).authorization).toBe(
          "Bearer health-token",
        );
        return new Response(
          JSON.stringify({
            selectedLegalActionId: "health-check:expand",
            reason: "The endpoint can read legal action ids.",
            confidence: 0.9,
          }),
          { status: 200 },
        );
      },
    });

    const result = await checkExternalAgentEndpoint(input);

    expect(input.endpointUrl).toBe("https://1.1.1.1/decide");
    expect(result).toMatchObject({
      ok: true,
      request: {
        method: "POST",
        protocolVersion: "proxywar-agent-v1",
      },
      selectedLegalActionId: "health-check:expand",
      confidence: 0.9,
    });
    expect(result.expectedResponse.selectedLegalActionId).toContain(
      "health-check:expand",
    );
    expect(result.offeredLegalActionIDs).toEqual([
      "health-check:expand",
      "health-check:hold",
    ]);
    expect(result.rawOutput).toContain("health-check:expand");
    expect(captured.body?.protocolVersion).toBe("proxywar-agent-v1");
    expect(
      (captured.body?.legalActions as Array<Record<string, unknown>>)[0].intent,
    ).toBeUndefined();
  });

  it("reports parser failures without pretending the endpoint is healthy", async () => {
    const input = normalizeExternalAgentHealthCheckInput({
      endpointUrl: "https://1.1.1.1/decide",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            selectedLegalActionId: "invented",
            reason: "I invented an id.",
          }),
          { status: 200 },
        ),
    });

    const result = await checkExternalAgentEndpoint(input);

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("unknown selectedLegalActionId");
    expect(result.fixHint).toContain("Choose exactly one id");
  });

  it("coaches endpoints that return actionId instead of selectedLegalActionId", async () => {
    const input = normalizeExternalAgentHealthCheckInput({
      endpointUrl: "https://1.1.1.1/decide",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            actionId: "health-check:expand",
            reason: "I used the wrong field name.",
          }),
          { status: 200 },
        ),
    });

    const result = await checkExternalAgentEndpoint(input);

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("Use selectedLegalActionId instead");
    expect(result.fixHint).toContain("Return selectedLegalActionId");
  });

  it("rejects markdown fences and confidence outside the contract range", async () => {
    const fenced = normalizeExternalAgentHealthCheckInput({
      endpointUrl: "https://1.1.1.1/decide",
      fetchFn: async () =>
        new Response(
          '```json\n{"selectedLegalActionId":"health-check:expand","reason":"Fenced response.","confidence":0.7}\n```',
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const outOfRange = normalizeExternalAgentHealthCheckInput({
      endpointUrl: "https://1.1.1.1/decide",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            selectedLegalActionId: "health-check:expand",
            reason: "Confidence is outside the protocol.",
            confidence: 1.5,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(checkExternalAgentEndpoint(fenced)).resolves.toMatchObject({
      ok: false,
      failureReason: expect.stringContaining("markdown code fence"),
      fixHint: expect.stringContaining("strict JSON"),
    });
    await expect(checkExternalAgentEndpoint(outOfRange)).resolves.toMatchObject({
      ok: false,
      failureReason: expect.stringContaining("between 0 and 1"),
    });
  });

  it("coaches users who paste an Agent Card URL into manual Test Endpoint", async () => {
    const input = normalizeExternalAgentHealthCheckInput({
      endpointUrl: "https://1.1.1.1/agent-card.md",
      fetchFn: async () =>
        new Response("---\nagentName: Wrong Field\n---\n", {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }),
    });

    const result = await checkExternalAgentEndpoint(input);

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("content-type");
    expect(result.fixHint).toContain("Manual Test Endpoint expects");
  });

  it("coaches starter users when the LLM provider is not configured", async () => {
    const input = normalizeExternalAgentHealthCheckInput({
      endpointUrl: "https://1.1.1.1/decide",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            error:
              "LLM provider required. Set PROXYWAR_AGENT_LLM_PROVIDER=codex-cli, claude-cowork, command, or openrouter.",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });

    const result = await checkExternalAgentEndpoint(input);

    expect(result.ok).toBe(false);
    expect(result.fixHint).toContain("Configure the starter model backend");
    expect(result.fixHint).toContain("npm run self-test");
  });

  it("explains that redirects are disabled for decision endpoints", async () => {
    const input = normalizeExternalAgentHealthCheckInput({
      endpointUrl: "https://1.1.1.1/decide",
      fetchFn: async () =>
        new Response("Moved", {
          status: 302,
          headers: { location: "https://agent.example.com/proxywar/decide" },
        }),
    });

    const result = await checkExternalAgentEndpoint(input);

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("HTTP 302");
    expect(result.fixHint).toContain("Redirects are disabled");
  });

  it("coaches users to refresh stale tunnel endpoints", async () => {
    const input = normalizeExternalAgentHealthCheckInput({
      endpointUrl: "https://stale-tunnel.example.test/proxywar/decide",
      fetchFn: async () => {
        throw new Error("getaddrinfo ENOTFOUND stale-tunnel.example.test");
      },
    });

    const result = await checkExternalAgentEndpoint(input);

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("ENOTFOUND");
    expect(result.fixHint).toContain("restart or re-expose the endpoint");
    expect(result.fixHint).toContain("delete the stale saved agent");
  });

  it("rejects env bearer tokens in user-submitted endpoint health checks", () => {
    expect(() =>
      normalizeExternalAgentHealthCheckInput({
        endpointUrl: "https://1.1.1.1/decide",
        token: "env:PROXYWAR_AGENT_TEST_TOKEN",
      }),
    ).toThrow(/operator-only/);
  });

  it("resolves env bearer tokens only for operator health checks", async () => {
    const previous = process.env.PROXYWAR_AGENT_TEST_TOKEN;
    process.env.PROXYWAR_AGENT_TEST_TOKEN = "env-health-token";
    try {
      const input = normalizeExternalAgentHealthCheckInput({
        endpointUrl: "https://1.1.1.1/decide",
        token: "env:PROXYWAR_AGENT_TEST_TOKEN",
        allowTokenReferences: true,
        fetchFn: async (_url, init) => {
          expect((init.headers as Record<string, string>).authorization).toBe(
            "Bearer env-health-token",
          );
          return new Response(
            JSON.stringify({
              selectedLegalActionId: "health-check:hold",
              reason: "The env token was resolved.",
            }),
            { status: 200 },
          );
        },
      });

      const result = await checkExternalAgentEndpoint(input);

      expect(result.ok).toBe(true);
      expect(result.selectedLegalActionId).toBe("health-check:hold");
    } finally {
      if (previous === undefined) {
        delete process.env.PROXYWAR_AGENT_TEST_TOKEN;
      } else {
        process.env.PROXYWAR_AGENT_TEST_TOKEN = previous;
      }
    }
  });

  it("normalizes invalid endpoint input into clear errors", () => {
    expect(() =>
      normalizeExternalAgentHealthCheckInput({
        endpointUrl: "file:///tmp/agent",
      }),
    ).toThrow(/http or https/);
    expect(() =>
      normalizeExternalAgentHealthCheckInput({
        endpointUrl: "https://agent.example.test/decide",
        timeoutMs: "10",
      }),
    ).toThrow(/250-180000/);
  });
});
