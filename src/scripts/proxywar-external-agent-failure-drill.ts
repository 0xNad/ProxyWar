import {
  checkExternalAgentEndpoint,
  normalizeExternalAgentHealthCheckInput,
} from "../server/agents/ExternalAgentHealthCheck";
import {
  evaluateExternalAgentEndpointPolicy,
} from "../server/agents/ExternalAgentNetworkPolicy";
import {
  parseProxyWarAgentCardMarkdown,
} from "../server/agents/ProxyWarAgentCard";

type DrillCase = {
  name: string;
  run: () => Promise<void> | void;
};

const validCard = `---
agentName: Drill Frontier
profile: opportunistic
doctrine: balanced
endpointUrl: https://agent.example.com/proxywar/decide
endpointTimeoutMs: 120000
personality: Chooses one offered LegalAction.id.
---

# Drill Frontier
`;

const healthEndpoint = "https://1.1.1.1/proxywar/decide";

const cases: DrillCase[] = [
  {
    name: "Agent Card accepts 120s endpoint timeout",
    run: () => {
      const card = parseProxyWarAgentCardMarkdown(validCard);
      assertEqual(card.nationInput.endpointTimeoutMs, "120000");
    },
  },
  {
    name: "Agent Card handles BOM and CRLF",
    run: () => {
      const card = parseProxyWarAgentCardMarkdown(
        `\uFEFF\r\n${validCard.replace(/\n/g, "\r\n")}`,
      );
      assertEqual(card.nationInput.agentName, "Drill Frontier");
    },
  },
  {
    name: "Agent Card rejects missing endpointUrl",
    run: () =>
      assertThrows(() =>
        parseProxyWarAgentCardMarkdown(`---
agentName: Missing Endpoint
profile: defensive
---
`),
      /endpointUrl/),
  },
  {
    name: "Agent Card rejects /agent-card.md endpointUrl",
    run: () =>
      assertThrows(() =>
        parseProxyWarAgentCardMarkdown(`---
agentName: Wrong URL
profile: defensive
endpointUrl: https://agent.example.com/agent-card.md
---
`),
      /POST decision endpoint/),
  },
  {
    name: "Agent Card rejects /health endpointUrl",
    run: () =>
      assertThrows(() =>
        parseProxyWarAgentCardMarkdown(`---
agentName: Wrong URL
profile: defensive
endpointUrl: https://agent.example.com/health/
---
`),
      /POST decision endpoint/),
  },
  {
    name: "Agent Card rejects public token text",
    run: () =>
      assertThrows(() =>
        parseProxyWarAgentCardMarkdown(`${validCard}
Authorization: Bearer beta-token-that-must-not-be-public
`),
      /must not contain bearer tokens/),
  },
  {
    name: "Network policy rejects private DNS resolution",
    run: async () => {
      const result = await evaluateExternalAgentEndpointPolicy(
        "https://agent.example.test/proxywar/decide",
        {
          resolveAddresses: async () => [{ address: "10.0.0.2", family: 4 }],
        },
      );
      if (result.allowed) throw new Error("private endpoint was allowed");
    },
  },
  {
    name: "Network policy rejects documentation IP ranges",
    run: async () => {
      const result = await evaluateExternalAgentEndpointPolicy(
        "https://agent.example.test/proxywar/decide",
        {
          resolveAddresses: async () => [
            { address: "203.0.113.10", family: 4 },
          ],
        },
      );
      if (result.allowed) throw new Error("reserved endpoint was allowed");
    },
  },
  healthCase("Decision endpoint accepts selectedLegalActionId", {
    selectedLegalActionId: "health-check:expand",
    reason: "Valid health response.",
    confidence: 0.9,
  }, true),
  healthCase("Decision endpoint rejects actionId", {
    actionId: "health-check:expand",
    reason: "Wrong field.",
  }),
  healthCase("Decision endpoint rejects invented ids", {
    selectedLegalActionId: "invented",
    reason: "Not offered.",
  }),
  healthCase("Decision endpoint rejects raw OpenFront intents", {
    selectedLegalActionId: "health-check:expand",
    intent: { type: "attack", targetID: "PLAYER" },
    reason: "Raw intent included.",
  }),
  healthTextCase(
    "Decision endpoint rejects markdown code fences",
    '```json\n{"selectedLegalActionId":"health-check:expand","reason":"fenced","confidence":0.7}\n```',
  ),
  healthTextCase("Decision endpoint rejects non-JSON", "not json"),
  healthCase("Decision endpoint rejects arrays", [
    {
      selectedLegalActionId: "health-check:expand",
      reason: "Array wrapper.",
    },
  ]),
  healthCase("Decision endpoint rejects missing reason", {
    selectedLegalActionId: "health-check:expand",
  }),
  healthCase("Decision endpoint rejects confidence out of range", {
    selectedLegalActionId: "health-check:expand",
    reason: "Bad confidence.",
    confidence: 2,
  }),
  {
    name: "Decision endpoint explains redirects",
    run: async () => {
      const result = await checkExternalAgentEndpoint(
        normalizeExternalAgentHealthCheckInput({
          endpointUrl: healthEndpoint,
          fetchFn: async () =>
            new Response("Moved", {
              status: 302,
              headers: {
                location: "https://agent.example.com/proxywar/decide",
              },
            }),
        }),
      );
      if (result.ok || !result.fixHint?.includes("Redirects are disabled")) {
        throw new Error(`unexpected redirect result: ${JSON.stringify(result)}`);
      }
    },
  },
  {
    name: "Decision endpoint reports HTTP failures",
    run: async () => {
      const result = await checkExternalAgentEndpoint(
        normalizeExternalAgentHealthCheckInput({
          endpointUrl: healthEndpoint,
          fetchFn: async () =>
            new Response(JSON.stringify({ error: "provider failed" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            }),
        }),
      );
      if (result.ok || !result.failureReason?.includes("HTTP 500")) {
        throw new Error(`unexpected HTTP result: ${JSON.stringify(result)}`);
      }
    },
  },
  {
    name: "Decision endpoint rejects wrong content type",
    run: async () => {
      const result = await checkExternalAgentEndpoint(
        normalizeExternalAgentHealthCheckInput({
          endpointUrl: healthEndpoint,
          fetchFn: async () =>
            new Response("<html></html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
        }),
      );
      if (result.ok || !result.fixHint?.includes("application/json")) {
        throw new Error(`unexpected content-type result: ${JSON.stringify(result)}`);
      }
    },
  },
];

let failed = 0;
for (const drill of cases) {
  try {
    await drill.run();
    console.log(`PASS ${drill.name}`);
  } catch (error) {
    failed += 1;
    console.error(
      `FAIL ${drill.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (failed > 0) {
  console.error(`ProxyWar external-agent failure drill failed: ${failed}/${cases.length}`);
  process.exitCode = 1;
} else {
  console.log(`ProxyWar external-agent failure drill passed: ${cases.length}/${cases.length}`);
}

function healthCase(
  name: string,
  body: unknown,
  expectOk = false,
): DrillCase {
  return {
    name,
    run: async () => {
      const result = await checkExternalAgentEndpoint(
        normalizeExternalAgentHealthCheckInput({
          endpointUrl: healthEndpoint,
          fetchFn: async () =>
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        }),
      );
      if (expectOk) {
        if (!result.ok) throw new Error(result.failureReason ?? "failed");
        return;
      }
      if (result.ok) throw new Error("invalid response passed health check");
      if (result.fixHint === undefined) {
        throw new Error(`missing fix hint: ${JSON.stringify(result)}`);
      }
    },
  };
}

function healthTextCase(name: string, text: string): DrillCase {
  return {
    name,
    run: async () => {
      const result = await checkExternalAgentEndpoint(
        normalizeExternalAgentHealthCheckInput({
          endpointUrl: healthEndpoint,
          fetchFn: async () =>
            new Response(text, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        }),
      );
      if (result.ok) throw new Error("invalid response passed health check");
      if (result.fixHint === undefined) {
        throw new Error(`missing fix hint: ${JSON.stringify(result)}`);
      }
    },
  };
}

function assertThrows(fn: () => void, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      const failure = new Error(`expected ${pattern}, got ${message}`);
      (failure as Error & { cause?: unknown }).cause = error;
      throw failure;
    }
    return;
  }
  throw new Error(`expected throw matching ${pattern}`);
}

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
