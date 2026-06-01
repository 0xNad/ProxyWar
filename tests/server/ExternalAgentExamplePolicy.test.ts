import { spawn } from "child_process";
import fs from "fs/promises";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";

interface ExamplePolicyModule {
  buildDecisionBriefing(
    payload: unknown,
    memory?: unknown,
  ): {
    ok: boolean;
    actionCount: number;
    actionIDsByKind: Record<string, string[]>;
    safeFallbackActionID: string | null;
    antiStallGuidance?: {
      active: boolean;
      message: string;
      preferredDifferentKindIDs: string[];
    };
    profileRepairGuidance?: {
      active: boolean;
      profile: string;
      suggestedActionIDs: string[];
      candidates: Array<{ id: string; kind: string; score: number }>;
      message: string;
    };
    tacticalHints?: {
      economyCadence?: {
        recommended: boolean;
        bestBuildID: string | null;
        bestBuildUnit: string | null;
      };
      frontierFinishPressure?: {
        recommended: boolean;
        bestTargetID: string | null;
        bestAttackID: string | null;
      };
      navalControl?: {
        recommended: boolean;
        bestNavalActionID: string | null;
        bestNavalActionKind: string | null;
      };
      lateGameStrikeTargeting?: {
        recommended: boolean;
        bestStrikeActionID: string | null;
        bestStrikeTargetName: string | null;
        bestStrikeTargetStructureUnit: string | null;
      };
      personalityDiplomacyPressure?: {
        recommended: boolean;
        bestSocialActionID: string | null;
        bestSocialActionKind: string | null;
        personalityMode: string | null;
      };
    };
    topActions: Array<{
      id: string;
      kind: string;
      score: number;
      reason: string;
    }>;
  };
  buildAntiStallGuidance(
    payload: unknown,
    memory?: unknown,
  ): {
    active: boolean;
    message: string;
    preferredDifferentKindIDs: string[];
  };
  buildProfileRepairGuidance(
    payload: unknown,
    memory?: unknown,
  ): {
    active: boolean;
    profile: string;
    suggestedActionIDs: string[];
    candidates: Array<{ id: string; kind: string; score: number }>;
    message: string;
  };
  buildLlmPrompt(payload: unknown, ranked: unknown[]): string;
  createAgentCardMarkdown(options?: {
    publicBaseUrl?: string;
    endpointPath?: string;
    agentName?: string;
    profile?: string;
    doctrine?: string;
    personality?: string;
    endpointTimeoutMs?: number;
  }): string;
  createFrontierMemory(): unknown;
  createHealthResponse(options?: {
    publicBaseUrl?: string;
    decisionPath?: string;
    cardPath?: string;
    agentName?: string;
    endpointTokenRequired?: boolean;
    llmProvider?: { provider?: string };
  }): {
    ok: boolean;
    protocolVersion: string;
    decisionEndpointUrl: string;
    agentCardUrl: string;
    auth: { decisionEndpoint: string; tokenPlacement: string };
    responseContract: { selectedLegalActionId: string };
    llmProvider?: { provider: string; mode: string; configured: boolean };
  };
  createLlmCompleteFromEnv(options?: {
    provider?: string;
    command?: string;
    args?: string[];
    timeoutMs?: number;
  }): ((prompt: string) => Promise<string>) | null;
  createStarterAgent(options: {
    llmComplete?: (prompt: string) => Promise<string>;
    memory?: unknown;
    provider?: string;
  }): {
    decide(payload: unknown): Promise<{
      selectedLegalActionId: string;
      reason: string;
      confidence: number;
    } | null>;
  };
  decisionForPayload(payload: unknown): never;
  publicBaseUrlFromRequest(request: {
    headers: Record<string, string | undefined>;
  }): string;
  groupLegalActionsByKind(
    legalActions: unknown[],
  ): Record<string, Array<{ id: string; kind: string }>>;
  rankLegalActions(
    payload: unknown,
    memory?: unknown,
  ): Array<{
    action: { id: string; kind: string };
    score: number;
    reason: string;
  }>;
  selectSafeFallbackAction(
    legalActions: Array<{
      id: string;
      kind: string;
      risk?: { level?: string };
    }>,
  ): { id: string; kind: string } | null;
  validateDecisionOutput(
    raw: string,
    legalActions: Array<{ id: string; kind: string }>,
  ): { ok: boolean; error?: string; action?: { id: string; kind: string } };
  validateDecisionPayload(payload: unknown): {
    ok: boolean;
    errors: string[];
    legalActions: unknown[];
  };
}

async function loadPolicy(): Promise<ExamplePolicyModule> {
  return (await import(
    pathToFileURL(
      path.join(
        process.cwd(),
        "examples",
        "external-agent",
        "agent-policy.mjs",
      ),
    ).href
  )) as ExamplePolicyModule;
}

function action(
  id: string,
  kind: string,
  metadata: Record<string, unknown> = {},
  risk: "none" | "low" | "medium" | "high" = "low",
) {
  return {
    id,
    kind,
    label: id,
    risk: { level: risk, score: risk === "high" ? 0.8 : 0.2 },
    metadata,
  };
}

function runStarterSmokeTest(endpointUrl: string): Promise<{
  exitCode: number;
  output: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["smoke-test.mjs"], {
      cwd: path.join(process.cwd(), "examples", "external-agent"),
      env: {
        ...process.env,
        PROXYWAR_AGENT_TEST_ENDPOINT_URL: endpointUrl,
        PROXYWAR_AGENT_TEST_TIMEOUT_MS: "5000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`smoke-test timed out: ${output}`));
    }, 8_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? -1, output });
    });
  });
}

async function listenForSmokeTest(
  handler: http.RequestListener,
): Promise<{ endpointUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    endpointUrl: `http://127.0.0.1:${address.port}/proxywar/decide`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function freeLocalPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForHttpOk(url: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${url}`);
}

describe("external-agent example policy", () => {
  it("requires an LLM brain instead of making policy-only decisions", async () => {
    const policy = await loadPolicy();
    expect(() => policy.createStarterAgent({})).toThrow(
      /LLM provider required/,
    );
    expect(() => policy.decisionForPayload({})).toThrow(
      /requires an LLM brain/,
    );
  });

  it("generates a public Agent Card with the decision endpoint and no secrets", async () => {
    const policy = await loadPolicy();
    const card = policy.createAgentCardMarkdown({
      publicBaseUrl: "https://agent.example.com/base/path/",
      endpointPath: "/proxywar/decide",
      agentName: "SDK Frontier",
      profile: "diplomatic",
      doctrine: "buffer alliances and build economy",
      personality: "Calm, precise, and legal-action-id only.",
      endpointTimeoutMs: 12_000,
    });

    expect(card).toContain("agentName: SDK Frontier");
    expect(card).toContain("profile: diplomatic");
    expect(card).toContain(
      "endpointUrl: https://agent.example.com/proxywar/decide",
    );
    expect(card).toContain("endpointTimeoutMs: 12000");
    expect(card).toContain("LegalAction.id");
    expect(card).not.toMatch(/api[_-]?key|token|secret/i);
  });

  it("derives the public base URL from forwarded request headers", async () => {
    const policy = await loadPolicy();

    expect(
      policy.publicBaseUrlFromRequest({
        headers: {
          host: "127.0.0.1:7777",
        },
      }),
    ).toBe("http://127.0.0.1:7777");
    expect(
      policy.publicBaseUrlFromRequest({
        headers: {
          "x-forwarded-host": "remote-agent.example.com",
          "x-forwarded-proto": "https",
          host: "127.0.0.1:7777",
        },
      }),
    ).toBe("https://remote-agent.example.com");
  });

  it("generates a health response with Agent Card and decision endpoint metadata", async () => {
    const policy = await loadPolicy();
    const health = policy.createHealthResponse({
      publicBaseUrl: "https://agent.example.com",
      decisionPath: "/proxywar/decide",
      cardPath: "/agent-card.md",
      agentName: "SDK Frontier",
      endpointTokenRequired: true,
      llmProvider: { provider: "" },
    });

    expect(health).toMatchObject({
      ok: true,
      protocolVersion: "proxywar-agent-v1",
      decisionEndpointUrl: "https://agent.example.com/proxywar/decide",
      agentCardUrl: "https://agent.example.com/agent-card.md",
      auth: {
        decisionEndpoint: "bearer-token-required",
      },
    });
    expect(health.auth.tokenPlacement).toContain("endpoint token field");
    expect(health.responseContract.selectedLegalActionId).toContain(
      "legalActions[].id",
    );
    expect(health.llmProvider?.mode).toBe("none");
  });

  it("can use a command-backed local agent instead of an API key", async () => {
    const policy = await loadPolicy();
    const script = [
      "process.stdin.resume();",
      "let input = '';",
      "process.stdin.on('data', (chunk) => input += chunk);",
      "process.stdin.on('end', () => {",
      "  if (!input.includes('selectedLegalActionId')) process.exit(2);",
      "  console.log(JSON.stringify({",
      "    selectedLegalActionId: 'hold',",
      "    reason: 'Command backend selected an offered health action.',",
      "    confidence: 0.8",
      "  }));",
      "});",
    ].join("");
    const llmComplete = policy.createLlmCompleteFromEnv({
      provider: "command",
      command: process.execPath,
      args: ["-e", script],
      timeoutMs: 5_000,
    });
    const agent = policy.createStarterAgent({
      llmComplete: llmComplete ?? undefined,
    });

    const decision = await agent.decide({
      match: { gameID: "TEST" },
      agent: { agentID: "agent-1" },
      observation: { profile: "opportunistic", phase: "active" },
      legalActions: [
        action("health-check:expand", "attack", { expansion: true }),
        action("hold", "hold", {}, "none"),
      ],
    });

    expect(decision?.selectedLegalActionId).toBe("hold");
  });

  it("the runnable starter exposes health, decision, and Agent Card routes", async () => {
    const [source, smokeTest, launchScript, packageJson] = await Promise.all([
      fs.readFile(
        path.join(
          process.cwd(),
          "examples",
          "external-agent",
          "simple-agent.mjs",
        ),
        "utf8",
      ),
      fs.readFile(
        path.join(
          process.cwd(),
          "examples",
          "external-agent",
          "smoke-test.mjs",
        ),
        "utf8",
      ),
      fs.readFile(
        path.join(process.cwd(), "examples", "external-agent", "launch.sh"),
        "utf8",
      ),
      fs.readFile(
        path.join(process.cwd(), "examples", "external-agent", "package.json"),
        "utf8",
      ),
    ]);

    expect(source).toContain("/health");
    expect(source).toContain("/agent-card.md");
    expect(source).toContain("/proxywar/decide");
    expect(source).toContain("createAgentCardMarkdown");
    expect(source).toContain("publicBaseUrlFromRequest");
    expect(source).toContain("loadEnvFileIfPresent");
    expect(source).toContain("PROXYWAR_AGENT_ENDPOINT_TOKEN");
    expect(source).toContain("missing or invalid bearer token");
    expect(smokeTest).toContain("health-check:expand");
    expect(smokeTest).toContain("selectedLegalActionId");
    expect(smokeTest).toContain("PROXYWAR_AGENT_TEST_ENDPOINT_URL");
    expect(smokeTest).toContain("PROXYWAR_AGENT_TEST_TOKEN");
    expect(launchScript).toContain("does not source .env");
    expect(launchScript).toContain("npm run self-test");
    expect(packageJson).toContain('"self-test"');
    expect(packageJson).toContain('"launch"');
  });

  it("starter self-test accepts the selectedLegalActionId health-check contract", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const server = await listenForSmokeTest(async (request, response) => {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      capturedBody = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          selectedLegalActionId: "health-check:hold",
          reason: "The starter self-test endpoint can read offered ids.",
          confidence: 0.8,
        }),
      );
    });

    try {
      const result = await runStarterSmokeTest(server.endpointUrl);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("starter self-test passed");
      expect(result.output).toContain("health-check:hold");
      expect(capturedBody?.protocolVersion).toBe("proxywar-agent-v1");
      expect(
        (capturedBody?.legalActions as Array<Record<string, unknown>>).map(
          (entry) => entry.id,
        ),
      ).toEqual(["health-check:expand", "health-check:hold"]);
    } finally {
      await server.close();
    }
  });

  it("runnable starter can require a bearer token on the decision endpoint", async () => {
    const port = await freeLocalPort();
    const endpointUrl = `http://127.0.0.1:${port}/proxywar/decide`;
    const commandScript = [
      "process.stdin.resume();",
      "let input = '';",
      "process.stdin.on('data', (chunk) => input += chunk);",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({",
      "    selectedLegalActionId: input.includes('health-check:hold') ? 'health-check:hold' : 'health-check:expand',",
      "    reason: 'Authorized starter token test.',",
      "    confidence: 0.8",
      "  }));",
      "});",
    ].join("");
    const child = spawn(process.execPath, ["simple-agent.mjs"], {
      cwd: path.join(process.cwd(), "examples", "external-agent"),
      env: {
        ...process.env,
        PROXYWAR_AGENT_HOST: "127.0.0.1",
        PROXYWAR_AGENT_PORT: String(port),
        PROXYWAR_AGENT_LLM_PROVIDER: "command",
        PROXYWAR_AGENT_LLM_COMMAND: process.execPath,
        PROXYWAR_AGENT_LLM_ARGS: JSON.stringify(["-e", commandScript]),
        PROXYWAR_AGENT_ENDPOINT_TOKEN: "beta-test-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    try {
      await waitForHttpOk(`http://127.0.0.1:${port}/health`);

      const noToken = await fetch(endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(starterHealthPayload()),
      });
      const wrongToken = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-token",
        },
        body: JSON.stringify(starterHealthPayload()),
      });
      const goodToken = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer beta-test-token",
        },
        body: JSON.stringify(starterHealthPayload()),
      });
      const goodJson = (await goodToken.json()) as {
        selectedLegalActionId?: string;
      };

      expect(noToken.status).toBe(401);
      expect(wrongToken.status).toBe(401);
      expect(goodToken.status).toBe(200);
      expect(goodJson.selectedLegalActionId).toBe("health-check:hold");
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        setTimeout(() => resolve(), 2_000).unref();
      });
    }
    expect(output).toContain("ProxyWar LLM starter agent listening");
  });

  it("starter self-test explains actionId as the wrong response field", async () => {
    const server = await listenForSmokeTest((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          actionId: "health-check:expand",
          reason: "Wrong field.",
        }),
      );
    });

    try {
      const result = await runStarterSmokeTest(server.endpointUrl);

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("starter self-test failed");
      expect(result.output).toContain("Return selectedLegalActionId");
    } finally {
      await server.close();
    }
  });

  it("starter self-test rejects markdown-wrapped endpoint responses", async () => {
    const server = await listenForSmokeTest((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        '```json\n{"selectedLegalActionId":"health-check:expand","reason":"Wrapped in markdown.","confidence":0.8}\n```',
      );
    });

    try {
      const result = await runStarterSmokeTest(server.endpointUrl);

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("starter self-test failed");
      expect(result.output).toContain("Return strict JSON only");
    } finally {
      await server.close();
    }
  });

  it("ranks spawn before hold or post-spawn actions during the spawn phase", async () => {
    const policy = await loadPolicy();
    const ranked = policy.rankLegalActions({
      observation: { profile: "aggressive", phase: "spawn" },
      legalActions: [
        action("hold", "hold", {}, "none"),
        action("expand:terra-nullius:10", "attack", { expansion: true }),
        action("spawn:123", "spawn", { pressureScore: 1 }),
      ],
    });

    expect(ranked[0]?.action.id).toBe("spawn:123");
    expect(ranked[0]?.reason).toContain("spawn");
  });

  it("ranks useful economy builds over interior Defense Posts", async () => {
    const policy = await loadPolicy();
    const ranked = policy.rankLegalActions({
      observation: {
        profile: "defensive",
        phase: "active",
        objective: { kind: "secure_economy" },
        strategic: {
          scores: { threat: 0.1 },
          recommendedActionKinds: ["build"],
        },
        memory: {},
      },
      legalActions: [
        action("build:DefensePost:1", "build", {
          unit: "Defense Post",
          role: "defensive",
          defensiveValue: 0.05,
          frontierValue: 0.05,
          hostileBorderDistance: 100,
          nearbyEnemyCount: 0,
        }),
        action("build:Factory:2", "build", {
          unit: "Factory",
          role: "economic",
          economicValue: 0.8,
        }),
        action("hold", "hold", {}, "none"),
      ],
    });

    expect(ranked[0]?.action.id).toBe("build:Factory:2");
  });

  it("ranks away from recently repeated exact actions when a useful alternative exists", async () => {
    const policy = await loadPolicy();
    const ranked = policy.rankLegalActions({
      observation: {
        profile: "opportunistic",
        phase: "active",
        objective: { kind: "expand_territory" },
        strategic: {
          scores: { threat: 0.1 },
          recommendedActionKinds: ["attack"],
        },
        memory: {
          avoidActionIDs: ["expand:terra-nullius:10"],
          repeatedActionKind: "attack",
          repeatedActionCount: 3,
        },
        ownState: { tilesOwned: 100 },
      },
      legalActions: [
        action("expand:terra-nullius:10", "attack", {
          expansion: true,
          targetID: null,
          troopPercent: 10,
        }),
        action("build:City:2", "build", {
          unit: "City",
          role: "economic",
          economicValue: 0.7,
        }),
      ],
    });

    expect(ranked[0]?.action.id).toBe("build:City:2");
  });

  it("uses profile repair ranking to break repeated neutral expansion", async () => {
    const policy = await loadPolicy();
    const payload = {
      observation: {
        profile: "aggressive",
        phase: "active",
        turnNumber: 2_000,
        strategic: {
          scores: { threat: 0.1 },
          recommendedActionKinds: ["attack"],
        },
        memory: {
          recentExpansionCount: 3,
          repeatedActionKind: "attack",
          repeatedActionCount: 3,
        },
        ownState: { tileShare: 0.12, tilesOwned: 12_000 },
      },
      legalActions: [
        action("expand:terra-nullius:10", "attack", {
          expansion: true,
          targetID: null,
          troopPercent: 10,
        }),
        action("attack:rival-1:20", "attack", {
          targetID: "rival-1",
          relativeTroopRatio: 1.5,
          troopPercent: 20,
        }),
        action("hold", "hold", {}, "none"),
      ],
    };

    const ranked = policy.rankLegalActions(payload);
    const briefing = policy.buildDecisionBriefing(payload);
    const guidance = policy.buildProfileRepairGuidance(payload);
    const prompt = policy.buildLlmPrompt(payload, ranked);

    expect(ranked[0]?.action.id).toBe("attack:rival-1:20");
    expect(
      ranked.find((candidate) => candidate.action.id === "hold")?.score,
    ).toBeLessThan(0);
    expect(guidance).toMatchObject({
      active: true,
      profile: "aggressive",
      suggestedActionIDs: ["attack:rival-1:20"],
    });
    expect(briefing.profileRepairGuidance?.suggestedActionIDs).toContain(
      "attack:rival-1:20",
    );
    expect(prompt).toContain("profileRepairGuidance");
    expect(prompt).toContain("attack:rival-1:20");
  });

  it("ranks useful economy builds after initial neutral expansion", async () => {
    const policy = await loadPolicy();
    const ranked = policy.rankLegalActions({
      observation: {
        profile: "aggressive",
        phase: "active",
        objective: { kind: "expand_territory" },
        strategic: {
          scores: { threat: 0.1 },
          recommendedActionKinds: ["attack"],
        },
        memory: {
          recentExpansionCount: 1,
          recentBuildCount: 0,
          repeatedActionKind: "attack",
          repeatedActionCount: 1,
        },
        ownState: { tilesOwned: 160 },
      },
      legalActions: [
        action("expand:terra-nullius:10", "attack", {
          expansion: true,
          targetID: null,
          troopPercent: 10,
        }),
        action("build:Factory:2", "build", {
          unit: "Factory",
          role: "economic",
          economicValue: 0.75,
        }),
        action("hold", "hold", {}, "none"),
      ],
    });

    expect(ranked[0]?.action.id).toBe("build:Factory:2");
  });

  it("uses shared economy cadence hints in the external starter briefing", async () => {
    const policy = await loadPolicy();
    const payload = {
      observation: {
        profile: "opportunistic",
        phase: "active",
        strategic: {
          scores: { threat: 0.1 },
          recommendedActionKinds: ["attack"],
        },
        memory: {
          recentExpansionCount: 1,
          recentBuildCount: 0,
        },
        tacticalAffordances: {
          economyCadence: {
            tacticID: "economy_cadence",
            recommended: true,
            bestBuildID: "build:Factory:2",
            bestBuildUnit: "Factory",
            economyBuildActionCount: 1,
            safeEconomyBuildActionCount: 1,
            recentExpansionCount: 1,
            recentBuildCount: 0,
            homeDanger: "low",
          },
        },
      },
      legalActions: [
        action("expand:terra-nullius:20", "attack", {
          expansion: true,
          targetID: null,
          troopPercent: 20,
        }),
        action("build:Factory:2", "build", {
          unit: "Factory",
          role: "economic",
          economicValue: 0.75,
        }),
        action("hold", "hold", {}, "none"),
      ],
    };

    const ranked = policy.rankLegalActions(payload);
    const briefing = policy.buildDecisionBriefing(payload);
    const prompt = policy.buildLlmPrompt(payload, ranked);

    expect(ranked[0]?.action.id).toBe("build:Factory:2");
    expect(briefing.tacticalHints?.economyCadence).toMatchObject({
      recommended: true,
      bestBuildID: "build:Factory:2",
      bestBuildUnit: "Factory",
    });
    expect(prompt).toContain("economyCadence");
    expect(prompt).toContain("build:Factory:2");
  });

  it("uses shared finish-pressure hints in the external starter briefing", async () => {
    const policy = await loadPolicy();
    const payload = {
      observation: {
        profile: "aggressive",
        phase: "active",
        strategic: {
          scores: { threat: 0.1 },
          recommendedActionKinds: ["attack"],
        },
        tacticalAffordances: {
          frontierFinishPressure: {
            tacticID: "frontier_finish_pressure",
            recommended: true,
            bestTargetID: "rival-1",
            bestTargetName: "Weak Rival",
            bestAttackID: "attack:rival-1:25",
            decisiveAttackActionCount: 1,
            recentLowCommitmentAttackCount: 3,
            homeDanger: "low",
          },
        },
      },
      legalActions: [
        action("expand:terra-nullius:20", "attack", {
          expansion: true,
          targetID: null,
          troopPercent: 20,
        }),
        action("attack:rival-1:10", "attack", {
          targetID: "rival-1",
          targetName: "Weak Rival",
          troopPercent: 10,
          relativeTroopRatio: 1.6,
        }),
        action("attack:rival-1:25", "attack", {
          targetID: "rival-1",
          targetName: "Weak Rival",
          troopPercent: 25,
          relativeTroopRatio: 1.6,
        }),
        action("hold", "hold", {}, "none"),
      ],
    };

    const ranked = policy.rankLegalActions(payload);
    const briefing = policy.buildDecisionBriefing(payload);
    const prompt = policy.buildLlmPrompt(payload, ranked);

    expect(ranked[0]?.action.id).toBe("attack:rival-1:25");
    expect(briefing.tacticalHints?.frontierFinishPressure).toMatchObject({
      recommended: true,
      bestTargetID: "rival-1",
      bestAttackID: "attack:rival-1:25",
    });
    expect(prompt).toContain("frontierFinishPressure");
    expect(prompt).toContain("attack:rival-1:25");
  });

  it("uses shared naval-control hints in the external starter briefing", async () => {
    const policy = await loadPolicy();
    const payload = {
      observation: {
        profile: "opportunistic",
        phase: "active",
        strategic: {
          scores: { threat: 0.1 },
          recommendedActionKinds: ["warship", "boat"],
        },
        tacticalAffordances: {
          navalControl: {
            tacticID: "naval_control",
            recommended: true,
            bestNavalActionID: "warship:Port:777",
            bestNavalActionKind: "warship",
            activeTransportCount: 0,
            boatLaunchActionCount: 1,
            warshipBuildActionCount: 1,
            warshipMoveActionCount: 0,
            homeDanger: "low",
          },
        },
      },
      legalActions: [
        action("warship:Port:777", "warship", {
          unit: "Warship",
          role: "defensive",
        }),
        action("boat:neutral:25", "boat", {
          targetID: null,
          targetName: "Terra Nullius",
          troopPercent: 25,
          expansion: true,
        }),
        action("hold", "hold", {}, "none"),
      ],
    };

    const ranked = policy.rankLegalActions(payload);
    const briefing = policy.buildDecisionBriefing(payload);
    const prompt = policy.buildLlmPrompt(payload, ranked);

    expect(ranked[0]?.action.id).toBe("warship:Port:777");
    expect(briefing.tacticalHints?.navalControl).toMatchObject({
      recommended: true,
      bestNavalActionID: "warship:Port:777",
      bestNavalActionKind: "warship",
    });
    expect(prompt).toContain("navalControl");
    expect(prompt).toContain("warship:Port:777");
  });

  it("uses shared late-game strike hints in the external starter briefing", async () => {
    const policy = await loadPolicy();
    const payload = {
      observation: {
        profile: "aggressive",
        phase: "active",
        strategic: {
          scores: { threat: 0.1 },
          recommendedActionKinds: ["nuke", "target_player"],
        },
        tacticalAffordances: {
          lateGameStrikeTargeting: {
            tacticID: "late_game_strike_targeting",
            recommended: true,
            bestStrikeActionID: "nuke:Hydrogen Bomb:leader-1:777",
            bestStrikeWeapon: "Hydrogen Bomb",
            bestStrikeTargetID: "leader-1",
            bestStrikeTargetName: "Hard Leader",
            bestStrikeTargetStructureUnit: "Missile Silo",
            bestStrikeScore: 210,
            legalStrikeActionCount: 1,
            highValueStrikeActionCount: 1,
            homeDanger: "low",
          },
        },
      },
      legalActions: [
        action("nuke:Hydrogen Bomb:leader-1:777", "nuke", {
          unit: "Hydrogen Bomb",
          targetID: "leader-1",
          targetName: "Hard Leader",
          targetStructureUnit: "Missile Silo",
          nuclearTargetPriority: 210,
        }),
        action("target:leader-1", "target_player", {
          targetID: "leader-1",
          targetName: "Hard Leader",
        }),
        action("hold", "hold", {}, "none"),
      ],
    };

    const ranked = policy.rankLegalActions(payload);
    const briefing = policy.buildDecisionBriefing(payload);
    const prompt = policy.buildLlmPrompt(payload, ranked);

    expect(ranked[0]?.action.id).toBe("nuke:Hydrogen Bomb:leader-1:777");
    expect(briefing.tacticalHints?.lateGameStrikeTargeting).toMatchObject({
      recommended: true,
      bestStrikeActionID: "nuke:Hydrogen Bomb:leader-1:777",
      bestStrikeTargetName: "Hard Leader",
      bestStrikeTargetStructureUnit: "Missile Silo",
    });
    expect(prompt).toContain("lateGameStrikeTargeting");
    expect(prompt).toContain("nuke:Hydrogen Bomb:leader-1:777");
  });

  it("uses shared personality diplomacy hints in the external starter briefing", async () => {
    const policy = await loadPolicy();
    const payload = {
      observation: {
        profile: "aggressive",
        phase: "active",
        strategic: {
          scores: { threat: 0.1 },
          recommendedActionKinds: ["target_player", "emoji"],
        },
        tacticalAffordances: {
          personalityDiplomacyPressure: {
            tacticID: "personality_diplomacy_pressure",
            recommended: true,
            profile: "aggressive",
            bestSocialActionID: "target:rival-1",
            bestSocialActionKind: "target_player",
            bestSocialTargetID: "rival-1",
            bestSocialTargetName: "Weak Rival",
            bestSocialScore: 112,
            personalityMode: "aggressive_pressure",
            socialActionCount: 2,
            pressureActionCount: 1,
            communicationActionCount: 1,
            recentSocialActionCount: 0,
            homeDanger: "low",
          },
        },
      },
      legalActions: [
        action("target:rival-1", "target_player", {
          targetID: "rival-1",
          targetName: "Weak Rival",
        }),
        action("emoji:rival-1:41", "emoji", {
          recipientID: "rival-1",
          recipientName: "Weak Rival",
          emoji: 41,
        }),
        action("hold", "hold", {}, "none"),
      ],
    };

    const ranked = policy.rankLegalActions(payload);
    const briefing = policy.buildDecisionBriefing(payload);
    const prompt = policy.buildLlmPrompt(payload, ranked);

    expect(ranked[0]?.action.id).toBe("target:rival-1");
    expect(briefing.tacticalHints?.personalityDiplomacyPressure).toMatchObject({
      recommended: true,
      bestSocialActionID: "target:rival-1",
      bestSocialActionKind: "target_player",
      personalityMode: "aggressive_pressure",
    });
    expect(prompt).toContain("personalityDiplomacyPressure");
    expect(prompt).toContain("target:rival-1");
  });

  it("ranks decisive hostile attacks over timid attacks when it has a troop edge", async () => {
    const policy = await loadPolicy();
    const ranked = policy.rankLegalActions({
      observation: {
        profile: "aggressive",
        phase: "active",
        objective: { kind: "pressure_rival" },
        tacticalAffordances: {
          frontierConversionTiming: { recommended: true },
        },
        strategic: {
          scores: { threat: 0.1 },
          recommendedActionKinds: ["attack"],
        },
      },
      legalActions: [
        action("attack:rival:10", "attack", {
          targetID: "rival",
          targetName: "Rival",
          troopPercent: 10,
          ownTroops: 1_200_000,
          targetTroops: 400_000,
          relativeTroopRatio: 3,
          sharesBorder: true,
        }),
        action("attack:rival:25", "attack", {
          targetID: "rival",
          targetName: "Rival",
          troopPercent: 25,
          ownTroops: 1_200_000,
          targetTroops: 400_000,
          relativeTroopRatio: 3,
          sharesBorder: true,
        }),
        action("boat:neutral:8", "boat", {
          targetID: null,
          troopPercent: 8,
        }),
      ],
    });

    expect(ranked[0]?.action.id).toBe("attack:rival:25");
    expect(
      ranked.findIndex((entry) => entry.action.kind === "boat"),
    ).toBeGreaterThan(
      ranked.findIndex((entry) => entry.action.id === "attack:rival:25"),
    );
  });

  it("exposes SDK helpers for validation, grouping, fallback, and briefing", async () => {
    const policy = await loadPolicy();
    const payload = {
      observation: {
        profile: "opportunistic",
        phase: "active",
        summary: "test agent has repeated expansion pressure",
        memory: { repeatedActionKind: "attack", repeatedActionCount: 3 },
      },
      legalActions: [
        action("expand:terra-nullius:10", "attack", {
          expansion: true,
          targetID: null,
          troopPercent: 10,
        }),
        action("build:Factory:2", "build", {
          unit: "Factory",
          role: "economic",
          economicValue: 0.75,
        }),
        action("hold", "hold", {}, "none"),
      ],
    };

    expect(policy.validateDecisionPayload(payload)).toMatchObject({
      ok: true,
    });
    expect(
      policy.groupLegalActionsByKind(payload.legalActions).attack,
    ).toHaveLength(1);
    expect(policy.selectSafeFallbackAction(payload.legalActions)?.id).toBe(
      "hold",
    );
    const briefing = policy.buildDecisionBriefing(payload);
    expect(briefing.actionIDsByKind).toMatchObject({
      attack: ["expand:terra-nullius:10"],
      build: ["build:Factory:2"],
      hold: ["hold"],
    });
    expect(briefing.topActions[0]?.id).toBe("build:Factory:2");
    expect(briefing.safeFallbackActionID).toBe("hold");
    expect(briefing.antiStallGuidance?.active).toBe(true);
    expect(briefing.antiStallGuidance?.preferredDifferentKindIDs).toContain(
      "build:Factory:2",
    );
  });

  it("rejects raw intent-shaped LLM output in the starter response validator", async () => {
    const policy = await loadPolicy();
    const parsed = policy.validateDecisionOutput(
      JSON.stringify({
        selectedLegalActionId: "expand:terra-nullius:10",
        intent: { type: "attack", targetID: "player-1" },
        reason: "I tried to submit a raw intent.",
      }),
      [action("expand:terra-nullius:10", "attack", { expansion: true })],
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/unknown JSON field: intent/);
  });

  it("matches the platform parser by rejecting extra fields and prose wrappers", async () => {
    const policy = await loadPolicy();
    const offered = [action("build:Factory:2", "build", { unit: "Factory" })];

    expect(
      policy.validateDecisionOutput(
        JSON.stringify({
          selectedLegalActionId: "build:Factory:2",
          reason: "Good economy action.",
          confidence: 0.7,
          notes: "extra field",
        }),
        offered,
      ),
    ).toMatchObject({ ok: false });
    expect(
      policy.validateDecisionOutput(
        `Here is the decision: ${JSON.stringify({
          selectedLegalActionId: "build:Factory:2",
          reason: "Good economy action.",
        })}`,
        offered,
      ),
    ).toMatchObject({ ok: false });
    expect(
      policy.validateDecisionOutput(
        JSON.stringify({
          selectedLegalActionId: "build:Factory:2",
          reason: "",
        }),
        offered,
      ),
    ).toMatchObject({ ok: false });
    expect(
      policy.validateDecisionOutput(
        `\`\`\`json
${JSON.stringify({
  selectedLegalActionId: "build:Factory:2",
  reason: "Good economy action.",
})}
\`\`\``,
        offered,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("markdown code fence"),
    });
    expect(
      policy.validateDecisionOutput(
        JSON.stringify({
          selectedLegalActionId: "build:Factory:2",
          reason: "Good economy action.",
          confidence: "high",
        }),
        offered,
      ),
    ).toMatchObject({ ok: false });
    expect(
      policy.validateDecisionOutput(
        JSON.stringify({
          selectedLegalActionId: "build:Factory:2",
          reason: "Good economy action.",
          confidence: 2,
        }),
        offered,
      ),
    ).toMatchObject({
      ok: false,
      error: "confidence must be between 0 and 1",
    });
    expect(
      policy.validateDecisionOutput(
        JSON.stringify({
          actionId: "build:Factory:2",
          reason: "Wrong field name.",
        }),
        offered,
      ),
    ).toMatchObject({
      ok: false,
      error: "unknown JSON field: actionId. Use selectedLegalActionId instead.",
    });
  });

  it("exports anti-stall guidance for repeated low-value action loops", async () => {
    const policy = await loadPolicy();
    const guidance = policy.buildAntiStallGuidance({
      observation: {
        memory: {
          repeatedActionKind: "attack",
          repeatedActionCount: 3,
          recentExpansionCount: 3,
        },
      },
      legalActions: [
        action("expand:terra-nullius:10", "attack", { expansion: true }),
        action("build:Factory:2", "build", {
          unit: "Factory",
          role: "economic",
          economicValue: 0.75,
        }),
        action("hold", "hold", {}, "none"),
      ],
    });

    expect(guidance.active).toBe(true);
    expect(guidance.message).toContain("Avoid repeating");
    expect(guidance.preferredDifferentKindIDs).toContain("build:Factory:2");
  });

  it("uses AGENT_SKILL.md in the LLM prompt", async () => {
    const policy = await loadPolicy();
    const ranked = policy.rankLegalActions({
      observation: { profile: "opportunistic", phase: "active" },
      legalActions: [
        action("expand:terra-nullius:10", "attack", { expansion: true }),
        action("hold", "hold", {}, "none"),
      ],
    });

    const prompt = policy.buildLlmPrompt(
      {
        agent: { username: "Remote Frontier" },
        observation: {},
        legalActions: [],
      },
      ranked,
    );

    expect(prompt).toContain("ProxyWar Agent Skill");
    expect(prompt).toContain("Choose exactly one `LegalAction.id`");
    expect(prompt).toContain("Selectable legal actions");
    expect(prompt).toContain("selectableActionIDs");
    expect(prompt).not.toContain("actionIDsByKind");
  });

  it("lets the LLM choose a valid ranked LegalAction.id", async () => {
    const policy = await loadPolicy();
    const agent = policy.createStarterAgent({
      llmComplete: async () =>
        JSON.stringify({
          selectedLegalActionId: "build:Factory:2",
          reason: "Economy build beats another repeated expansion.",
          confidence: 0.82,
        }),
    });

    const decision = await agent.decide({
      match: { gameID: "TEST" },
      agent: { agentID: "agent-1" },
      observation: {
        profile: "opportunistic",
        phase: "active",
        memory: { repeatedActionKind: "attack", repeatedActionCount: 3 },
      },
      legalActions: [
        action("expand:terra-nullius:10", "attack", {
          expansion: true,
          targetID: null,
          troopPercent: 10,
        }),
        action("build:Factory:2", "build", {
          unit: "Factory",
          role: "economic",
          economicValue: 0.75,
        }),
      ],
    });

    expect(decision?.selectedLegalActionId).toBe("build:Factory:2");
    expect(decision?.reason).toContain("Economy build");
  });

  it("reprompts when the LLM chooses a stale repeated expansion", async () => {
    const policy = await loadPolicy();
    const prompts: string[] = [];
    const agent = policy.createStarterAgent({
      llmComplete: async (prompt: string) => {
        prompts.push(prompt);
        return JSON.stringify({
          selectedLegalActionId:
            prompts.length === 1 ? "expand:terra-nullius:10" : "build:City:2",
          reason:
            prompts.length === 1
              ? "Expand is low risk."
              : "Rotate into economy after repeated expansion.",
          confidence: 0.7,
        });
      },
    });

    const decision = await agent.decide({
      match: { gameID: "TEST" },
      agent: { agentID: "agent-1" },
      observation: {
        profile: "opportunistic",
        phase: "active",
        memory: { repeatedActionKind: "attack", repeatedActionCount: 3 },
      },
      legalActions: [
        action("expand:terra-nullius:10", "attack", {
          expansion: true,
          targetID: null,
          troopPercent: 10,
        }),
        action("build:City:2", "build", {
          unit: "City",
          role: "economic",
          economicValue: 0.7,
        }),
      ],
    });

    expect(decision?.selectedLegalActionId).toBe("build:City:2");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Previous response was invalid");
  });

  it("fails visibly instead of falling back to policy-only gameplay", async () => {
    const policy = await loadPolicy();
    const agent = policy.createStarterAgent({
      llmComplete: async () =>
        JSON.stringify({
          selectedLegalActionId: "unknown",
          reason: "invalid",
          confidence: 0.4,
        }),
    });

    await expect(
      agent.decide({
        match: { gameID: "TEST" },
        agent: { agentID: "agent-1" },
        observation: { profile: "opportunistic", phase: "active" },
        legalActions: [
          action("expand:terra-nullius:10", "attack", { expansion: true }),
          action("hold", "hold", {}, "none"),
        ],
      }),
    ).rejects.toThrow(/LLM failed to select/);
  });
});

function starterHealthPayload() {
  return {
    match: { gameID: "TOKEN-TEST" },
    agent: { agentID: "agent-token-test" },
    observation: { profile: "opportunistic", phase: "active" },
    legalActions: [
      action("health-check:expand", "attack", { expansion: true }),
      action("health-check:hold", "hold", {}, "none"),
    ],
  };
}
