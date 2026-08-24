import { describe, expect, it } from "vitest";

import {
  commanderBedrockRequest,
  commanderBedrockSidecarEndpoint,
  commanderRuntimeEnvironment,
  productionCommanderReciprocalAlliance,
  withProductionCommanderSocial,
} from "../../coworld-adapter/commander-starter/commander-player";
import { decisionToResponse } from "../../coworld-adapter/src/keystone-player";

describe("Commander production player", () => {
  it("locks the provider request to the canary model and token cap", () => {
    expect(commanderBedrockRequest("choose")).toEqual({
      model: "us.anthropic.claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "choose" }],
    });
  });

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
});
