import { describe, expect, it } from "vitest";

import {
  commanderBedrockRequest,
  commanderBedrockSidecarEndpoint,
  commanderProviderEvidenceFromResponse,
  commanderRuntimeEnvironment,
  createProductionCommanderBrain,
  PRODUCTION_COMMANDER_DECISION_BUDGET_MS,
  PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS,
  productionCommanderReciprocalAlliance,
  productionCommanderTransportFallbackResponse,
  withCommanderProviderEvidence,
  withProductionCommanderSocial,
} from "../../coworld-adapter/commander-starter/commander-player";
import {
  CommanderBedrockProvider,
  isCommanderProviderTimeoutError,
} from "../../coworld-adapter/commander-starter/commander-production-runtime";
import {
  composeCoworldDecision,
  normalizeDecisionResponse,
  normalizeProviderEvidence,
} from "../../coworld-adapter/src/coworld-decision-wire";
import { decisionToResponse } from "../../coworld-adapter/src/keystone-player";
import type { LlmProvider } from "../../src/server/agents/LlmProvider";
import { makeCommanderStage2Fixture } from "../server/StrategicCommanderStage2TestHarness";

describe("Commander production player", () => {
  it("locks the provider request to the canary model and token cap", () => {
    expect(commanderBedrockRequest("choose")).toEqual({
      model: "us.anthropic.claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "choose" }],
    });
  });

  it("allows hosted Commander inference to finish inside the gameplay window", () => {
    expect(PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS).toBe(55_000);
    expect(PRODUCTION_COMMANDER_DECISION_BUDGET_MS).toBe(60_000);
    expect(
      PRODUCTION_COMMANDER_DECISION_BUDGET_MS -
        PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS,
    ).toBe(5_000);
  });

  it("emits only bounded provider attestation fields and no raw prompt or body", () => {
    expect(
      commanderProviderEvidenceFromResponse({
        id: "msg_01ABC",
        model: "claude-sonnet-4-6-20260801",
        content: [{ text: "private model body" }],
        usage: { input_tokens: 321, output_tokens: 45 },
      }),
    ).toEqual({
      provider: "bedrock-sidecar",
      callKind: "planner",
      requestedModel: "us.anthropic.claude-sonnet-4-6",
      attemptedModels: ["us.anthropic.claude-sonnet-4-6"],
      attemptCount: 1,
      completedAttemptCount: 1,
      failedAttemptCount: 0,
      timedOutAttemptCount: 0,
      responseModel: "claude-sonnet-4-6-20260801",
      requestID: "msg_01ABC",
      inputTokens: 321,
      outputTokens: 45,
      rawOutputPresent: true,
    });
  });

  it("keeps provider evidence on a degraded decision after a real model call", () => {
    const evidence = commanderProviderEvidenceFromResponse({
      id: "msg_fallback",
      model: "claude-sonnet-4-6-20260801",
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    expect(
      withCommanderProviderEvidence(
        { type: "decision_response", selectedLegalActionId: "hold" },
        {
          actionID: "hold",
          reason: null,
          metadata: { llmPlannerDegraded: true },
        },
        evidence,
      ),
    ).toHaveProperty("providerEvidence.callKind", "planner");
  });

  it("omits provider evidence on a fallback that made no model call", () => {
    const provider = new CommanderBedrockProvider(
      "us-east-1",
      "http://127.0.0.1:4567",
    );
    const message = productionCommanderTransportFallbackResponse({
      requestID: "no-call-fallback",
      request: { legalActions: [{ id: "hold", kind: "hold" }] },
      errorMessage: "request rejected before provider invocation",
      provider,
      evidenceCursor: provider.evidenceCursor(),
    });

    expect(message).not.toHaveProperty("providerEvidence");
  });

  it("records a failed Bedrock call without inventing response usage", async () => {
    const provider = new CommanderBedrockProvider(
      "us-east-1",
      "http://127.0.0.1:4567",
    );
    Object.defineProperty(provider, "client", {
      value: {
        messages: {
          create: async () => {
            throw new Error("provider unavailable");
          },
        },
      },
    });
    const cursor = provider.evidenceCursor();

    await expect(provider.complete("choose")).rejects.toThrow(
      "provider unavailable",
    );
    expect(provider.providerEvidenceAfter(cursor)).toEqual({
      provider: "bedrock-sidecar",
      callKind: "planner",
      requestedModel: "us.anthropic.claude-sonnet-4-6",
      attemptedModels: ["us.anthropic.claude-sonnet-4-6"],
      attemptCount: 1,
      completedAttemptCount: 0,
      failedAttemptCount: 1,
      timedOutAttemptCount: 0,
      rawOutputPresent: false,
    });
  });

  it("records one exact completed SDK attempt and does not reuse it for a no-call decision", async () => {
    const provider = new CommanderBedrockProvider(
      "us-east-1",
      "http://127.0.0.1:4567",
    );
    Object.defineProperty(provider, "client", {
      value: {
        messages: {
          create: async () => ({
            id: "msg_success",
            model: "claude-sonnet-4-6-20260801",
            content: [{ text: '{"selectedStrategicOptionId":"x"}' }],
            usage: { input_tokens: 210, output_tokens: 31 },
          }),
        },
      },
    });
    const cursor = provider.evidenceCursor();

    await expect(provider.complete("choose")).resolves.toContain(
      "selectedStrategicOptionId",
    );
    const evidence = provider.providerEvidenceAfter(cursor);
    expect(evidence).toEqual({
      provider: "bedrock-sidecar",
      callKind: "planner",
      requestedModel: "us.anthropic.claude-sonnet-4-6",
      attemptedModels: ["us.anthropic.claude-sonnet-4-6"],
      attemptCount: 1,
      completedAttemptCount: 1,
      failedAttemptCount: 0,
      timedOutAttemptCount: 0,
      responseModel: "claude-sonnet-4-6-20260801",
      requestID: "msg_success",
      inputTokens: 210,
      outputTokens: 31,
      rawOutputPresent: true,
    });
    expect(normalizeProviderEvidence(evidence)).toEqual(evidence);

    const nextDecisionCursor = provider.evidenceCursor();
    expect(provider.providerEvidenceAfter(nextDecisionCursor)).toBeUndefined();
  });

  it.each([
    Object.assign(new Error("aborted"), { name: "AbortError" }),
    Object.assign(new Error("aborted"), { code: "ABORT_ERR" }),
    Object.assign(new Error("SDK deadline"), { code: "ETIMEDOUT" }),
    new Error("request timed out"),
  ])(
    "classifies an SDK/abort timeout as timed out, not failed: %#",
    async (error) => {
      expect(isCommanderProviderTimeoutError(error)).toBe(true);
      const provider = new CommanderBedrockProvider(
        "us-east-1",
        "http://127.0.0.1:4567",
      );
      Object.defineProperty(provider, "client", {
        value: {
          messages: {
            create: async () => {
              throw error;
            },
          },
        },
      });
      const cursor = provider.evidenceCursor();

      await expect(provider.complete("choose")).rejects.toBe(error);
      const evidence = provider.providerEvidenceAfter(cursor);
      expect(evidence).toMatchObject({
        attemptCount: 1,
        completedAttemptCount: 0,
        failedAttemptCount: 0,
        timedOutAttemptCount: 1,
        rawOutputPresent: false,
      });
      expect(normalizeProviderEvidence(evidence)).toEqual(evidence);
    },
  );

  it("preserves completed evidence when an empty provider body fails after the call", async () => {
    const provider = new CommanderBedrockProvider(
      "us-east-1",
      "http://127.0.0.1:4567",
    );
    Object.defineProperty(provider, "client", {
      value: {
        messages: {
          create: async () => ({
            id: "msg_empty",
            model: "claude-sonnet-4-6-20260801",
            content: [],
            usage: { input_tokens: 55, output_tokens: 0 },
          }),
        },
      },
    });
    const cursor = provider.evidenceCursor();

    await expect(provider.complete("choose")).rejects.toThrow(
      "Commander Bedrock response was empty",
    );
    const evidence = provider.providerEvidenceAfter(cursor);
    expect(evidence).toMatchObject({
      attemptCount: 1,
      completedAttemptCount: 1,
      failedAttemptCount: 0,
      timedOutAttemptCount: 0,
      requestID: "msg_empty",
      inputTokens: 55,
      outputTokens: 0,
      rawOutputPresent: false,
    });
    expect(normalizeProviderEvidence(evidence)).toEqual(evidence);
  });

  it("bounds response identity and token fields to the strict Coworld contract", () => {
    const evidence = commanderProviderEvidenceFromResponse({
      id: "invalid request?id",
      model: "invalid model@name",
      content: [{ text: "result" }],
      usage: { input_tokens: 1_000_000_001, output_tokens: -1 },
    });

    expect(evidence).not.toHaveProperty("requestID");
    expect(evidence).not.toHaveProperty("responseModel");
    expect(evidence).not.toHaveProperty("inputTokens");
    expect(evidence).not.toHaveProperty("outputTokens");
    expect(normalizeProviderEvidence(evidence)).toEqual(evidence);
  });

  it("retains failed call evidence on the exact outer transport fallback and composes it as self-attested", async () => {
    const provider = new CommanderBedrockProvider(
      "us-east-1",
      "http://127.0.0.1:4567",
    );
    Object.defineProperty(provider, "client", {
      value: {
        messages: {
          create: async () => {
            throw new Error("provider unavailable before later handling");
          },
        },
      },
    });
    const evidenceCursor = provider.evidenceCursor();
    await expect(provider.complete("choose")).rejects.toThrow(
      "provider unavailable",
    );
    const request = {
      legalActions: [
        { id: "hold", kind: "hold" },
        { id: "attack:P2", kind: "attack" },
      ],
    };
    const message = productionCommanderTransportFallbackResponse({
      requestID: "outer-fallback",
      request,
      errorMessage: "post-call Commander failure",
      provider,
      evidenceCursor,
    });

    expect(message).toMatchObject({
      selectedLegalActionId: "hold",
      providerEvidence: {
        attemptCount: 1,
        completedAttemptCount: 0,
        failedAttemptCount: 1,
        timedOutAttemptCount: 0,
      },
    });
    const composed = composeCoworldDecision({
      normalized: normalizeDecisionResponse(message),
      message,
      slot: 0,
      requestID: "outer-fallback",
      offeredLegalActionCount: 2,
    });
    expect(composed.metadata).toMatchObject({
      providerEvidenceSource: "policy-self-attested",
      providerCallKind: "planner",
      providerAttemptCount: 1,
      providerCompletedAttemptCount: 0,
      providerFailedAttemptCount: 1,
      providerTimedOutAttemptCount: 0,
      externalPlannerCall: true,
      externalActionCall: false,
      rawProviderOutputPresent: false,
    });
  });

  it("lets strict Commander evidence override a preexisting response claim", () => {
    const evidence = commanderProviderEvidenceFromResponse({
      id: "msg_authoritative",
      model: "claude-sonnet-4-6-20260801",
      content: [{ text: "result" }],
    });
    const message = withCommanderProviderEvidence(
      {
        type: "decision_response",
        requestID: "overwrite",
        selectedLegalActionId: "hold",
        providerEvidence: { forged: true },
      },
      { actionID: "hold", reason: null },
      evidence,
    );

    expect(message.providerEvidence).toEqual(evidence);
    const composed = composeCoworldDecision({
      normalized: normalizeDecisionResponse(message),
      message,
      slot: 0,
      requestID: "overwrite",
      offeredLegalActionCount: 1,
    });
    expect(composed.metadata).toMatchObject({
      providerEvidenceSource: "policy-self-attested",
      providerCallKind: "planner",
      providerAttemptCount: 1,
      providerCompletedAttemptCount: 1,
    });
    expect(composed.metadata).not.toHaveProperty("providerEvidenceInvalid");
  });

  it("normalizes bounded provider evidence without retaining the raw provider body", () => {
    const evidence = commanderProviderEvidenceFromResponse({
      id: "msg_retained",
      model: "claude-sonnet-4-6-20260801",
      content: [{ text: "private model body" }],
      usage: { input_tokens: 321, output_tokens: 45 },
    });
    const message = withCommanderProviderEvidence(
      {
        type: "decision_response",
        requestID: "game-request",
        selectedLegalActionId: "hold",
        reason: "x".repeat(2_000),
      },
      {
        actionID: "hold",
        reason: null,
        metadata: { llmPlannerDegraded: false },
      },
      evidence,
    );

    const decision = composeCoworldDecision({
      normalized: normalizeDecisionResponse(message),
      message,
      slot: 2,
      requestID: "game-request",
      offeredLegalActionCount: 4,
    });
    expect(decision.metadata).toMatchObject({
      providerEvidenceSource: "policy-self-attested",
      providerCallKind: "planner",
      providerAttemptedModels: '["us.anthropic.claude-sonnet-4-6"]',
      providerAttemptCount: 1,
      providerCompletedAttemptCount: 1,
      providerFailedAttemptCount: 0,
      providerTimedOutAttemptCount: 0,
      providerInputTokens: 321,
      providerOutputTokens: 45,
      rawProviderOutputPresent: true,
    });
    expect(decision.metadata).not.toHaveProperty("externalRawOutput");
    expect(JSON.stringify(decision.metadata)).not.toContain(
      "private model body",
    );
  });

  it("does not discard a healthy model response that arrives after the former 12-second cutoff", async () => {
    const fixture = makeCommanderStage2Fixture();
    const optionID = fixture.strategicOptions.exposed[0]!.id;
    const provider: LlmProvider = {
      providerType: "custom",
      model: "delayed-healthy-test-model",
      async complete() {
        await new Promise((resolve) => setTimeout(resolve, 12_100));
        return JSON.stringify({
          selectedStrategicOptionId: optionID,
          horizonDecisions: 4,
          intent: "execute the delayed but healthy strategic choice",
          replanTriggers: [],
        });
      },
    };
    const brain = await createProductionCommanderBrain({
      repoRoot: process.cwd(),
      provider,
      profile: "aggressive",
    });

    const startedAt = Date.now();
    const decision = await brain.decide({
      observation: fixture.observation,
      legalActions: fixture.legalActions,
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(12_000);
    expect(fixture.legalActions.map((action) => action.id)).toContain(
      decision.actionID,
    );
    expect(decision.metadata).toMatchObject({
      llmPlannerDegraded: false,
      plannerFallbackUsed: false,
      commanderPrimarySelectorSource: "llm",
    });
  }, 20_000);

  it.each([
    "https://127.0.0.1:1234",
    "http://bedrock.internal:1234",
    "http://127.0.0.1:1234/path",
    "http://user@127.0.0.1:1234",
    "http://127.0.0.1",
  ])("rejects a non-loopback or ambiguous Bedrock endpoint: %s", (endpoint) => {
    expect(() =>
      commanderBedrockSidecarEndpoint({
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: endpoint,
      }),
    ).toThrow("Commander Bedrock sidecar endpoint is invalid");
  });

  it("accepts only the exact Coworld Bedrock model and returns the fixed profile", () => {
    expect(
      commanderRuntimeEnvironment({
        USE_BEDROCK: "true",
        BEDROCK_MODEL: "us.anthropic.claude-sonnet-4-6",
        AWS_REGION: "us-east-1",
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "http://127.0.0.1:4567",
      }),
    ).toEqual({
      profile: "aggressive",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:4567",
    });
  });

  it("rejects a different model", () => {
    expect(() =>
      commanderRuntimeEnvironment({
        USE_BEDROCK: "true",
        BEDROCK_MODEL: "different-model",
        AWS_REGION: "us-east-1",
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "http://127.0.0.1:4567",
      }),
    ).toThrow("Commander requires the exact Coworld Bedrock model");
  });

  it("answers a message, accepts peace, and reciprocates an incoming alliance in parallel", () => {
    const brainInput = {
      observation: {
        ownState: { playerID: "P_AURI" },
        visiblePlayers: [
          {
            playerID: "P_MITO",
            isAlive: true,
            sharesBorder: true,
            isAllied: false,
            hasIncomingAllianceRequest: true,
          },
        ],
        nonCombat: {
          inboundMessages: [
            {
              senderID: "P_MITO",
              senderName: "MitochondriaFriend",
              text: "Peace and alliance?",
              turnNumber: 500,
            },
          ],
        },
        deals: {
          decisionStep: 2,
          incomingProposals: [
            {
              dealID: "D1",
              proposerPlayerID: "P_MITO",
              recipientPlayerID: "P_AURI",
              terms: { template: "non_aggression_pact" },
              answerableThroughStep: 5,
            },
          ],
          outgoingProposals: [],
          activeDeals: [],
        },
      },
      legalActions: [
        {
          id: "alliance:P_MITO",
          kind: "alliance_request",
          intent: null,
          risk: { level: "none" },
          metadata: { targetID: "P_MITO" },
        },
        {
          id: "message:P_MITO",
          kind: "message",
          intent: null,
          risk: { level: "none" },
          metadata: { recipientID: "P_MITO" },
        },
        {
          id: "deal_accept:D1",
          kind: "deal_accept",
          intent: null,
          risk: { level: "none" },
          metadata: { dealID: "D1" },
        },
        {
          id: "hold",
          kind: "hold",
          intent: null,
          risk: { level: "none" },
          metadata: {},
        },
      ],
    } as any;
    const reciprocal = productionCommanderReciprocalAlliance(brainInput);
    expect(reciprocal?.actionID).toBe("alliance:P_MITO");
    const social = withProductionCommanderSocial({
      decision: reciprocal!,
      brainInput,
      answeredMessages: new Set(),
      proposedDeals: new Set(),
    });
    expect(decisionToResponse("req", social)).toMatchObject({
      selectedLegalActionId: "alliance:P_MITO",
      selectedDealActionId: "deal_accept:D1",
      selectedMessageActionId: "message:P_MITO",
    });
  });

  it("does not invent an alliance id when the visible requester has no offered alliance action", () => {
    const brainInput = {
      observation: {
        ownState: { playerID: "P_AURI" },
        visiblePlayers: [
          {
            playerID: "P_MITO",
            isAlive: true,
            hasIncomingAllianceRequest: true,
          },
        ],
      },
      legalActions: [
        {
          id: "hold",
          kind: "hold",
          intent: null,
          risk: { level: "none" },
          metadata: {},
        },
      ],
    } as any;
    expect(productionCommanderReciprocalAlliance(brainInput)).toBeNull();
  });
});
