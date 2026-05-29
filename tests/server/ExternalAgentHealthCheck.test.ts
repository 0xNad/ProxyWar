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
        protocolVersion: "open-frontier-agent-v1",
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
    expect(captured.body?.protocolVersion).toBe("open-frontier-agent-v1");
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
              "LLM provider required. Set OPEN_FRONTIER_AGENT_LLM_PROVIDER=codex-cli, claude-cowork, command, or openrouter.",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });

    const result = await checkExternalAgentEndpoint(input);

    expect(result.ok).toBe(false);
    expect(result.fixHint).toContain("Configure the starter model backend");
    expect(result.fixHint).toContain("npm run self-test");
  });

  it("rejects env bearer tokens in user-submitted endpoint health checks", () => {
    expect(() =>
      normalizeExternalAgentHealthCheckInput({
        endpointUrl: "https://1.1.1.1/decide",
        token: "env:OPEN_FRONTIER_AGENT_TEST_TOKEN",
      }),
    ).toThrow(/operator-only/);
  });

  it("resolves env bearer tokens only for operator health checks", async () => {
    const previous = process.env.OPEN_FRONTIER_AGENT_TEST_TOKEN;
    process.env.OPEN_FRONTIER_AGENT_TEST_TOKEN = "env-health-token";
    try {
      const input = normalizeExternalAgentHealthCheckInput({
        endpointUrl: "https://1.1.1.1/decide",
        token: "env:OPEN_FRONTIER_AGENT_TEST_TOKEN",
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
        delete process.env.OPEN_FRONTIER_AGENT_TEST_TOKEN;
      } else {
        process.env.OPEN_FRONTIER_AGENT_TEST_TOKEN = previous;
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
