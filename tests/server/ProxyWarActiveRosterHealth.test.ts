import { describe, expect, it } from "vitest";
import type { AgentManifest } from "../../src/server/agents/AgentManifest";
import {
  assertProxyWarActiveRosterExternalEndpointsHealthy,
  checkProxyWarActiveRosterExternalEndpoints,
  proxyWarProviderTokenInput,
  type ProxyWarActiveRosterHealthChecker,
} from "../../src/server/agents/ProxyWarActiveRosterHealth";
import type { ExternalAgentHealthCheckResult } from "../../src/server/agents/ExternalAgentHealthCheck";

const externalProvider = {
  provider: "external-http",
  endpointUrl: "https://fresh.example.test/proxywar/decide",
  token: "beta-token",
  timeoutMs: 1500,
} as const;

const externalManifest: AgentManifest = {
  schemaVersion: 1,
  agentName: "Fresh Endpoint",
  profile: "opportunistic",
  brainType: "external-http",
  provider: externalProvider,
};

const mockManifest: AgentManifest = {
  schemaVersion: 1,
  agentName: "House Agent",
  profile: "defensive",
  brainType: "planner",
  provider: { provider: "mock-llm" },
};

describe("ProxyWarActiveRosterHealth", () => {
  it("health-checks saved external endpoints before a saved-roster run", async () => {
    const checked: string[] = [];
    const checkEndpoint: ProxyWarActiveRosterHealthChecker = async (input) => {
      checked.push(input.endpointUrl);
      return healthResult({ ok: true, endpoint: input.endpointUrl });
    };

    const report = await checkProxyWarActiveRosterExternalEndpoints(
      [externalManifest, mockManifest],
      { checkEndpoint },
    );

    expect(report.ok).toBe(true);
    expect(report.checkedExternalAgentCount).toBe(1);
    expect(report.issues).toEqual([]);
    expect(checked).toEqual(["https://fresh.example.test/proxywar/decide"]);
  });

  it("reports a clear failure when a saved external endpoint is stale", async () => {
    const checkEndpoint: ProxyWarActiveRosterHealthChecker = async (input) =>
      healthResult({
        ok: false,
        endpoint: input.endpointUrl,
        failureReason: "network timeout after 1500ms",
        fixHint: "Restart the endpoint or delete this saved agent.",
      });

    const report = await checkProxyWarActiveRosterExternalEndpoints(
      [externalManifest],
      { checkEndpoint },
    );

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual([
      {
        agentName: "Fresh Endpoint",
        endpoint: "https://fresh.example.test/proxywar/decide",
        failureReason: "network timeout after 1500ms",
        fixHint: "Restart the endpoint or delete this saved agent.",
      },
    ]);
    await expect(
      assertProxyWarActiveRosterExternalEndpointsHealthy([externalManifest], {
        checkEndpoint,
      }),
    ).rejects.toThrow(
      'Saved external agent "Fresh Endpoint" did not pass endpoint health check: network timeout after 1500ms. Fix: Restart the endpoint or delete this saved agent.',
    );
  });

  it("normalizes provider token references for operator-owned saved agents", () => {
    expect(proxyWarProviderTokenInput(externalProvider)).toBe("beta-token");
    expect(
      proxyWarProviderTokenInput({
        provider: "external-http",
        endpointUrl: "https://fresh.example.test/proxywar/decide",
        tokenEnv: "PROXYWAR_TEST_AGENT_TOKEN",
      }),
    ).toBe("env:PROXYWAR_TEST_AGENT_TOKEN");
    expect(
      proxyWarProviderTokenInput({
        provider: "external-http",
        endpointUrl: "https://fresh.example.test/proxywar/decide",
        tokenSecret: "agent_abc123",
      }),
    ).toBe("secret:agent_abc123");
  });
});

function healthResult(
  input: Pick<ExternalAgentHealthCheckResult, "ok" | "endpoint"> &
    Partial<ExternalAgentHealthCheckResult>,
): ExternalAgentHealthCheckResult {
  return {
    ok: input.ok,
    endpoint: input.endpoint,
    latencyMs: input.latencyMs ?? 12,
    request: {
      method: "POST",
      protocolVersion: "proxywar-agent-v1",
      contentType: "application/json",
    },
    offeredLegalActionIDs: ["health-check:expand", "health-check:hold"],
    expectedResponse: {
      selectedLegalActionId:
        "one of health-check:expand or health-check:hold",
      reason: "short human-readable string",
      confidence: "optional number from 0 to 1",
    },
    ...(input.selectedLegalActionId !== undefined
      ? { selectedLegalActionId: input.selectedLegalActionId }
      : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.failureReason !== undefined
      ? { failureReason: input.failureReason }
      : {}),
    ...(input.fixHint !== undefined ? { fixHint: input.fixHint } : {}),
  };
}
