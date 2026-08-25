import { describe, expect, it, vi } from "vitest";

import {
  normalizeProviderEvidence,
  type CoworldProviderEvidence,
} from "../../coworld-adapter/src/coworld-decision-wire";
import {
  bedrockModelCandidates,
  boundedKeystoneProviderBudgetMs,
  createKeystoneBedrockProvider,
  createKeystoneBrain,
  decisionToResponse,
  keystoneBedrockSidecarEndpoint,
  transportFallbackResponse,
  withKeystoneProviderEvidence,
  type BedrockClientLike,
  type BedrockResponseLike,
  type KeystoneModules,
} from "../../coworld-adapter/src/keystone-player";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import * as plannerExecutorModule from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrainInput,
  AgentDecision,
} from "../../src/server/agents/AgentTypes";
import * as claudeCliModule from "../../src/server/agents/ClaudeCliLlmProvider";

const modules: KeystoneModules = {
  plannerExecutor: plannerExecutorModule,
  claudeCli: claudeCliModule,
};

type BedrockStep = BedrockResponseLike | Error;

function bedrockClient(steps: BedrockStep[]): {
  client: BedrockClientLike;
  create: ReturnType<typeof vi.fn>;
} {
  const queue = [...steps];
  const create = vi.fn(async () => {
    const step = queue.shift();
    if (step === undefined) throw new Error("unexpected Bedrock call");
    if (step instanceof Error) throw step;
    return step;
  });
  return { client: { messages: { create } }, create };
}

function response(
  text: string,
  overrides: Partial<BedrockResponseLike> = {},
): BedrockResponseLike {
  return {
    content: [{ text }],
    model: "model/a",
    id: "msg_request_1",
    usage: { input_tokens: 31, output_tokens: 7 },
    ...overrides,
  };
}

function decision(): AgentDecision {
  return {
    actionID: "hold:wait",
    reason: "wait",
    metadata: { runtimeMode: "llm-policy-planner" },
  };
}

function expectTerminal(evidence: CoworldProviderEvidence): void {
  expect(
    evidence.completedAttemptCount +
      evidence.failedAttemptCount +
      evidence.timedOutAttemptCount,
  ).toBe(evidence.attemptCount);
  expect(evidence.attemptedModels).toHaveLength(evidence.attemptCount);
  expect(normalizeProviderEvidence(evidence)).toEqual(evidence);
}

function plannerOutput(): string {
  return JSON.stringify({
    objective: "secure_economy",
    turnIntent: "build",
    rationale: "Build the economy from a safe position.",
    maxDecisionCycles: 6,
    preferredActionKinds: ["build", "hold"],
    enabledModules: ["economy"],
    targetPlayerId: null,
  });
}

function activeInput(): AgentBrainInput {
  return {
    observation: new AgentObservationBuilder().build({
      agentID: "auri",
      clientID: null,
      username: "Auri",
      profile: "aggressive",
      gameID: "KEYSTONE_PROVIDER_EVIDENCE",
      turnNumber: 100,
      phaseOverride: "active",
    }),
    legalActions: [
      {
        id: "build:City:100",
        kind: "build",
        label: "Build City",
        intent: null,
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "economic",
          unit: "City",
          buildTile: 100,
        },
      },
      {
        id: "hold:wait",
        kind: "hold",
        label: "Hold",
        intent: null,
        risk: { level: "none", score: 0 },
      },
    ],
  };
}

describe("Keystone hosted Bedrock provider evidence", () => {
  it.each([
    [undefined, 12_000],
    ["garbage", 12_000],
    [Number.NaN, 12_000],
    [-1, 250],
    [100, 250],
    [8_000, 8_000],
    [99_999, 12_000],
  ])("bounds the whole provider group %s to %s ms", (value, expected) => {
    expect(boundedKeystoneProviderBudgetMs(value)).toBe(expected);
  });

  it("carries one successful terminal planner call with response usage", async () => {
    const fake = bedrockClient([response("ok")]);
    const handle = createKeystoneBedrockProvider(
      {
        PROXYWAR_LLM_MODEL_ID: "model/a",
        PROXYWAR_LLM_MODEL_STRICT: "1",
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "http://127.0.0.1:9100",
      },
      { createClient: async () => fake.client },
    );
    handle.evidence.beginDecision();

    await expect(handle.provider.complete("prompt")).resolves.toBe("ok");
    const evidence = handle.evidence.takeEvidence();

    expect(evidence).toEqual({
      callKind: "planner",
      provider: "bedrock-sidecar",
      requestedModel: "model/a",
      attemptedModels: ["model/a"],
      attemptCount: 1,
      completedAttemptCount: 1,
      failedAttemptCount: 0,
      timedOutAttemptCount: 0,
      responseModel: "model/a",
      requestID: "msg_request_1",
      inputTokens: 31,
      outputTokens: 7,
      rawOutputPresent: true,
    });
    expectTerminal(evidence!);
    expect(fake.create.mock.calls[0][1].timeout).toBeLessThanOrEqual(12_000);
    expect(fake.create.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    const wire = decisionToResponse(
      "req-success",
      withKeystoneProviderEvidence(decision(), evidence),
    );
    expect(wire.providerEvidence).toEqual(evidence);
  });

  it("aggregates an unavailable model failure followed by a completed response", async () => {
    const fake = bedrockClient([
      new Error("The provided model identifier is invalid"),
      response("fallback answered", {
        model: "us.anthropic.claude-sonnet-4-6",
        id: "msg_request_2",
        usage: { input_tokens: 41, output_tokens: 9 },
      }),
    ]);
    const handle = createKeystoneBedrockProvider(
      { PROXYWAR_LLM_MODEL_ID: "model/retired" },
      { createClient: async () => fake.client },
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      handle.evidence.beginDecision();
      await expect(handle.provider.complete("prompt")).resolves.toBe(
        "fallback answered",
      );
      const evidence = handle.evidence.takeEvidence()!;

      expect(evidence).toMatchObject({
        requestedModel: "model/retired",
        attemptedModels: ["model/retired", "us.anthropic.claude-sonnet-4-6"],
        attemptCount: 2,
        completedAttemptCount: 1,
        failedAttemptCount: 1,
        timedOutAttemptCount: 0,
        responseModel: "us.anthropic.claude-sonnet-4-6",
        requestID: "msg_request_2",
        inputTokens: 41,
        outputTokens: 9,
        rawOutputPresent: true,
      });
      expectTerminal(evidence);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("omits an over-cap completed-response token sum without dropping the call aggregate", async () => {
    const fake = bedrockClient([
      response("primary", {
        id: "msg_big_1",
        usage: { input_tokens: 600_000_000, output_tokens: 550_000_000 },
      }),
      response("repair", {
        id: "msg_big_2",
        usage: { input_tokens: 600_000_000, output_tokens: 550_000_000 },
      }),
    ]);
    const handle = createKeystoneBedrockProvider(
      {
        PROXYWAR_LLM_MODEL_ID: "model/a",
        PROXYWAR_LLM_MODEL_STRICT: "1",
      },
      { createClient: async () => fake.client },
    );
    handle.evidence.beginDecision();

    await expect(handle.provider.complete("primary prompt")).resolves.toBe(
      "primary",
    );
    await expect(handle.provider.complete("repair prompt")).resolves.toBe(
      "repair",
    );
    const evidence = handle.evidence.takeEvidence()!;

    expect(evidence).toMatchObject({
      attemptedModels: ["model/a", "model/a"],
      attemptCount: 2,
      completedAttemptCount: 2,
      failedAttemptCount: 0,
      timedOutAttemptCount: 0,
      rawOutputPresent: true,
    });
    expect(evidence).not.toHaveProperty("inputTokens");
    expect(evidence).not.toHaveProperty("outputTokens");
    expect(evidence).not.toHaveProperty("requestID");
    expectTerminal(evidence);
  });

  it.each([
    "https://127.0.0.1:9100",
    "http://bedrock.internal:9100",
    "http://127.0.0.1:9100/path",
    "http://user@127.0.0.1:9100",
    "http://127.0.0.1",
    "http://127.0.0.1:9100?model=a",
    "http://127.0.0.1:9100#fragment",
  ])("rejects a non-loopback or ambiguous sidecar endpoint: %s", (endpoint) => {
    expect(() =>
      keystoneBedrockSidecarEndpoint({
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: endpoint,
      }),
    ).toThrow("Keystone Bedrock sidecar endpoint is invalid");
  });

  it("accepts credential-free loopback HTTP with an explicit port only", () => {
    expect(
      keystoneBedrockSidecarEndpoint({
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: " http://localhost:9100 ",
      }),
    ).toBe("http://localhost:9100");
    expect(() =>
      createKeystoneBedrockProvider({ USE_BEDROCK: "true" }),
    ).toThrow("Keystone Bedrock sidecar endpoint is missing");
  });

  it("keeps every all-model failure terminal and never invents response usage", async () => {
    const candidates = bedrockModelCandidates({});
    const fake = bedrockClient(
      candidates.map(() => new Error("model is not supported")),
    );
    const handle = createKeystoneBedrockProvider(
      {},
      { createClient: async () => fake.client },
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      handle.evidence.beginDecision();
      await expect(handle.provider.complete("prompt")).rejects.toThrow(
        /No Bedrock model candidate/,
      );
      const evidence = handle.evidence.takeEvidence()!;

      expect(evidence).toMatchObject({
        attemptedModels: candidates,
        attemptCount: candidates.length,
        completedAttemptCount: 0,
        failedAttemptCount: candidates.length,
        timedOutAttemptCount: 0,
        rawOutputPresent: false,
      });
      expect(evidence).not.toHaveProperty("responseModel");
      expect(evidence).not.toHaveProperty("requestID");
      expect(evidence).not.toHaveProperty("inputTokens");
      expect(evidence).not.toHaveProperty("outputTokens");
      expectTerminal(evidence);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("classifies a provider deadline as timed out, not as a generic failure", async () => {
    const timeout = Object.assign(new Error("request timed out after 250ms"), {
      name: "TimeoutError",
    });
    const fake = bedrockClient([timeout]);
    const handle = createKeystoneBedrockProvider(
      {
        PROXYWAR_LLM_MODEL_ID: "model/a",
        PROXYWAR_LLM_MODEL_STRICT: "1",
        PROXYWAR_LLM_TIMEOUT_MS: "250",
      },
      { createClient: async () => fake.client },
    );
    handle.evidence.beginDecision();

    await expect(handle.provider.complete("prompt")).rejects.toThrow(
      /timed out/,
    );
    const evidence = handle.evidence.takeEvidence()!;
    expect(evidence).toMatchObject({
      attemptCount: 1,
      completedAttemptCount: 0,
      failedAttemptCount: 0,
      timedOutAttemptCount: 1,
      rawOutputPresent: false,
    });
    expectTerminal(evidence);
  });

  it("awaits Bedrock only on refresh decisions and omits evidence on executor-only decisions", async () => {
    const fake = bedrockClient([
      response(plannerOutput(), {
        model: "model/a",
        id: "msg_planner_refresh_1",
      }),
    ]);
    const bedrock = createKeystoneBedrockProvider(
      {
        PROXYWAR_LLM_MODEL_ID: "model/a",
        PROXYWAR_LLM_MODEL_STRICT: "1",
      },
      { createClient: async () => fake.client },
    );
    const brain = createKeystoneBrain(modules, {
      mode: "bedrock",
      profile: "aggressive",
      planEveryDecisionSteps: 3,
      bedrockProviderHandle: bedrock,
    });

    const refreshDecision = await brain.decide(activeInput());
    const refreshWire = decisionToResponse("refresh", refreshDecision);
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(refreshDecision.metadata).toMatchObject({
      plannerFallbackUsed: false,
      plannerParseOk: true,
    });
    expect(refreshWire.providerEvidence).toMatchObject({
      callKind: "planner",
      attemptCount: 1,
      completedAttemptCount: 1,
    });

    const executorDecision = await brain.decide(activeInput());
    const executorWire = decisionToResponse("executor", executorDecision);
    expect(executorDecision.metadata?.plannerRefreshReason).toBe(
      "active_plan_reused",
    );
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(executorWire).not.toHaveProperty("providerEvidence");
  });

  it("does not fabricate valid evidence from malformed or metadata-only claims", () => {
    const metadataSpoof = decision();
    metadataSpoof.metadata = {
      ...metadataSpoof.metadata,
      externalPlannerCall: true,
      providerAttemptCount: 99,
    };
    expect(decisionToResponse("spoof", metadataSpoof)).not.toHaveProperty(
      "providerEvidence",
    );

    const malformed = withKeystoneProviderEvidence(decision(), {
      callKind: "planner",
      provider: "bedrock-sidecar",
      requestedModel: "model/a",
      attemptedModels: ["model/a"],
      attemptCount: 1,
      completedAttemptCount: 1,
      failedAttemptCount: 1,
      timedOutAttemptCount: 0,
      rawOutputPresent: true,
    });
    const wire = decisionToResponse("malformed", malformed);
    expect(wire.providerEvidence).toEqual({ invalid: true });
    expect(normalizeProviderEvidence(wire.providerEvidence)).toBeNull();
    expect(wire.providerEvidence).not.toMatchObject({
      attemptCount: expect.any(Number),
    });
  });

  it("never resurrects a social side-slot id as the executable fallback", () => {
    const wire = transportFallbackResponse(
      "only-social",
      {
        legalActions: [
          { id: "deal_accept:d1", kind: "deal_accept" },
          { id: "message:r1", kind: "message" },
        ],
      },
      "primary menu was empty",
    );

    expect(wire.selectedLegalActionId).toBe("");
    expect(wire.selectedLegalActionId).not.toBe("deal_accept:d1");
    expect(wire.selectedLegalActionId).not.toBe("message:r1");
    expect(wire).not.toHaveProperty("selectedDealActionId");
    expect(wire).not.toHaveProperty("selectedMessageActionId");
  });
});
