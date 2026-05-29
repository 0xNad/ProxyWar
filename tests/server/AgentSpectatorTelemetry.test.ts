import { describe, expect, it } from "vitest";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";
import {
  AgentDecisionRecord,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";

describe("AgentSpectatorTelemetry", () => {
  it("turns alliance, betrayal, trade, and attack decisions into spectator relationships", () => {
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "politics-run",
      roster: [
        {
          agentID: "a1",
          username: "Atlas",
          profile: "diplomatic",
          clientID: "c1",
          brainType: "planner-executor",
        },
        {
          agentID: "a2",
          username: "Blitz",
          profile: "aggressive",
          clientID: "c2",
          brainType: "planner-executor",
        },
      ],
      records: [
        record(1, "a1", "Atlas", "p1", "alliance_request", {
          recipientID: "p2",
          recipientName: "Blitz",
        }),
        record(2, "a2", "Blitz", "p2", "alliance_request", {
          recipientID: "p1",
          recipientName: "Atlas",
        }),
        record(3, "a1", "Atlas", "p1", "donate_gold", {
          recipientID: "p2",
          recipientName: "Blitz",
          gold: 500,
        }),
        record(4, "a2", "Blitz", "p2", "break_alliance", {
          recipientID: "p1",
          recipientName: "Atlas",
        }),
        record(5, "a2", "Blitz", "p2", "attack", {
          targetID: "p1",
          targetName: "Atlas",
        }),
      ],
      finalState: {
        phase: "finished",
        tick: 50,
        turnCount: 500,
        players: [
          {
            agentID: "a1",
            username: "Atlas",
            profile: "diplomatic",
            playerID: "p1",
            isAlive: false,
            tilesOwned: 0,
            troops: 0,
            gold: "0",
          },
          {
            agentID: "a2",
            username: "Blitz",
            profile: "aggressive",
            playerID: "p2",
            isAlive: true,
            tilesOwned: 100,
            troops: 2000,
            gold: "500",
          },
        ],
      },
    });

    expect(telemetry.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "alliance_request",
        "alliance_formed",
        "trade",
        "alliance_break",
        "attack",
        "elimination",
      ]),
    );

    const atlasToBlitz = telemetry.relationships.find(
      (relationship) =>
        relationship.fromAgentID === "a1" && relationship.toAgentID === "a2",
    );
    const blitzToAtlas = telemetry.relationships.find(
      (relationship) =>
        relationship.fromAgentID === "a2" && relationship.toAgentID === "a1",
    );

    expect(atlasToBlitz).toMatchObject({
      allianceState: "broken",
      currentLabel: "betrayed",
      tradeGivenGold: 500,
      betrayals: 1,
    });
    expect(blitzToAtlas).toMatchObject({
      allianceState: "broken",
      currentLabel: "betrayed",
      attacksSent: 1,
      betrayals: 1,
    });
    expect(blitzToAtlas!.distrust).toBeGreaterThan(atlasToBlitz!.trust);
    expect(telemetry.communicationThreads[0]).toMatchObject({
      agentIDs: ["a1", "a2"],
    });
    expect(telemetry.timelineBuckets.length).toBeGreaterThan(0);
  });

  it("groups chat into readable threads and infers pressure tone", () => {
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "chat-run",
      roster: [
        {
          agentID: "a1",
          username: "Civic",
          profile: "diplomatic",
          clientID: "c1",
          brainType: "planner-executor",
        },
        {
          agentID: "a2",
          username: "Dagger",
          profile: "opportunistic",
          clientID: "c2",
          brainType: "planner-executor",
        },
      ],
      records: [
        record(1, "a1", "Civic", "p1", "quick_chat", {
          recipientID: "p2",
          recipientName: "Dagger",
          targetID: "p2",
          targetName: "Dagger",
          message: "Let us pressure the leader after the pact.",
        }),
        record(2, "a2", "Dagger", "p2", "emoji", {
          recipientID: "p1",
          recipientName: "Civic",
          emojiText: "🤝",
          emojiContext: "alliance_signal",
        }),
      ],
    });

    const chat = telemetry.events.find((event) => event.kind === "chat");
    expect(chat).toMatchObject({
      tone: "pact",
      publicText: "Let us pressure the leader after the pact.",
    });
    expect(telemetry.communicationThreads).toHaveLength(1);
    expect(telemetry.communicationThreads[0]!.messages).toHaveLength(2);
  });
});

function record(
  sequence: number,
  agentID: string,
  username: string,
  playerID: string,
  kind: LegalActionKind,
  metadata: Record<string, string | number | boolean | null>,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "POLITICS",
    agentID,
    clientID: `client-${agentID}`,
    username,
    profile: agentID === "a1" ? "diplomatic" : "aggressive",
    brainType: "planner-executor",
    turnNumber: sequence * 100,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 12,
    observationSummary: `${username} sees the board`,
    legalActionIDs: [`${kind}:${sequence}`],
    legalActionIDsByKind: { [kind]: [`${kind}:${sequence}`] },
    attackActionIDs: kind === "attack" ? [`${kind}:${sequence}`] : [],
    chosenActionID: `${kind}:${sequence}`,
    chosenActionKind: kind,
    reason: `${username} selects ${kind}`,
    chosenActionMetadata: metadata,
    intent: null,
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: null,
    },
    audit: {
      auditStatus: "confirmed",
      auditReason: "test decision applied",
      after: {
        tick: sequence,
        playerID,
        isAlive: true,
        hasSpawned: true,
        tilesOwned: 10 + sequence,
        troops: 1000,
        gold: "100",
        unitCounts: {},
        outgoingAttackTargetIDs: [],
        outgoingAllianceRequestRecipientIDs: [],
        outgoingEmbargoTargetIDs: [],
      },
    },
  };
}
