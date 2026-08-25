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
  withCommanderProviderEvidence,
  withProductionCommanderSocial,
} from "../../coworld-adapter/commander-starter/commander-player";
import {
  composeCoworldDecision,
  normalizeDecisionResponse,
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
      requestedModel: "us.anthropic.claude-sonnet-4-6",
      responseModel: "claude-sonnet-4-6-20260801",
      requestID: "msg_01ABC",
      inputTokens: 321,
      outputTokens: 45,
    });
  });

  it("omits provider evidence on a degraded fallback decision", () => {
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
    ).not.toHaveProperty("providerEvidence");
  });

  it("keeps bounded provider evidence inside retained Coworld decision evidence", () => {
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
    const retained = String(decision.metadata.externalRawOutput);

    expect(retained).toContain('"providerEvidence"');
    expect(retained).toContain('"inputTokens":321');
    expect(retained).toContain('"outputTokens":45');
    expect(retained).not.toContain("private model body");
    expect(retained.length).toBeLessThanOrEqual(1_000);
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
