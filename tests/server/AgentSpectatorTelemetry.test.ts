import { describe, expect, it } from "vitest";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";
import {
  AgentActionAuditStatus,
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

  // P0 fix (2026-08-03): addEliminationEvents used to stamp EVERY eliminated
  // agent's synthetic event at the match's own final turn (finalState.turnCount),
  // regardless of when that agent actually died -- a viewer watching anywhere
  // before the literal last turn saw zero eliminations in the client's
  // playhead-windowed War Room feed, no matter how many agents had already
  // died. This pipeline has no sampled turn-by-turn state series to consult
  // (see AgentMatchStateDerivations.ts's computeEliminationTimings for the
  // one genuinely turn-accurate signal, used elsewhere but not available
  // here), so the fix uses each agent's own LAST decision record's turn as
  // the best available approximation.
  it("stamps a mid-match elimination near the eliminated agent's own last decision turn, not the match's final turn", () => {
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "elimination-timing-run",
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
        // Atlas's last record lands at turn 300 (sequence 3) -- eliminated
        // shortly after, nowhere near the match's real final turn of 7300.
        record(1, "a1", "Atlas", "p1", "attack", {
          targetID: "p2",
          targetName: "Blitz",
        }),
        record(2, "a2", "Blitz", "p2", "attack", {
          targetID: "p1",
          targetName: "Atlas",
        }),
        record(3, "a1", "Atlas", "p1", "attack", {
          targetID: "p2",
          targetName: "Blitz",
        }),
        // Blitz keeps playing long after Atlas's last decision.
        record(4, "a2", "Blitz", "p2", "attack", {
          targetID: "p1",
          targetName: "Atlas",
        }),
      ],
      finalState: {
        phase: "finished",
        tick: 7300,
        turnCount: 7300,
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

    const elimination = telemetry.events.find(
      (event) => event.kind === "elimination",
    );
    expect(elimination).toBeDefined();
    expect(elimination!.actorName).toBe("Atlas");
    // Atlas's own last record (sequence 3) is at turnNumber 300 (sequence * 100,
    // per the record() fixture below) -- the elimination must land there, NOT
    // at the match's final turn (7300), which would make it invisible to any
    // viewer whose playhead hasn't reached the literal last turn yet.
    expect(elimination!.turnNumber).toBe(300);
    expect(elimination!.turnNumber).not.toBe(7300);
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

  it("does not let a rejected reciprocal request fabricate an alliance", () => {
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "rejected-alliance-run",
      roster: roster(),
      records: [
        record(1, "a1", "Atlas", "p1", "alliance_request", {
          recipientID: "p2",
          recipientName: "Blitz",
        }),
        record(
          2,
          "a2",
          "Blitz",
          "p2",
          "alliance_request",
          { recipientID: "p1", recipientName: "Atlas" },
          { accepted: false, auditStatus: "not_applicable" },
        ),
      ],
    });

    expect(telemetry.events.map((event) => event.kind)).toEqual([
      "alliance_request",
    ]);
    expect(
      telemetry.relationships.filter(
        (relationship) => relationship.allianceState === "allied",
      ),
    ).toHaveLength(0);
  });

  it("suppresses rejected donation and attack records without mutating relationships", () => {
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "rejected-effects-run",
      roster: roster(),
      records: [
        record(
          1,
          "a1",
          "Atlas",
          "p1",
          "donate_gold",
          { recipientID: "p2", recipientName: "Blitz", gold: 500 },
          { accepted: false, auditStatus: "not_applicable" },
        ),
        record(
          2,
          "a2",
          "Blitz",
          "p2",
          "attack",
          { targetID: "p1", targetName: "Atlas" },
          { accepted: false, auditStatus: "not_applicable" },
        ),
      ],
    });

    expect(telemetry.events).toHaveLength(0);
    for (const relationship of telemetry.relationships) {
      expect(relationship).toMatchObject({
        trust: 50,
        distrust: 10,
        tension: 10,
        tradeGivenGold: 0,
        tradeGivenTroops: 0,
        attacksSent: 0,
        attacksReceived: 0,
        betrayals: 0,
      });
    }
  });

  it("labels fallback/degraded accepted attempts without claiming an unconfirmed effect", () => {
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "fallback-provenance-run",
      roster: roster(),
      finalState: finalState(),
      records: [
        record(
          1,
          "a1",
          "Atlas",
          "p1",
          "attack",
          { targetID: "p2", targetName: "Blitz" },
          {
            fallbackUsed: true,
            llmPlannerDegraded: true,
            auditStatus: "unknown",
          },
        ),
      ],
    });

    expect(telemetry.events).toHaveLength(1);
    expect(telemetry.events[0]).toMatchObject({
      kind: "attack",
      evidenceLevel: "accepted_action",
      fallbackUsed: true,
      llmPlannerDegraded: true,
      auditStatus: "unknown",
      auditReason: "test decision unknown",
      message: "Atlas orders an attack against Blitz.",
    });
    expect(
      telemetry.relationships.find(
        (relationship) =>
          relationship.fromAgentID === "a1" &&
          relationship.toAgentID === "a2",
      ),
    ).toMatchObject({ attacksSent: 0, distrust: 10, tension: 10 });
  });

  it("keeps an accepted but unaudited donation as an attempt, not a transfer", () => {
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "unconfirmed-support-run",
      roster: roster(),
      finalState: finalState(),
      records: [
        record(
          1,
          "a1",
          "Atlas",
          "p1",
          "donate_troops",
          { recipientID: "p2", recipientName: "Blitz", troops: 200 },
          { auditStatus: "unknown" },
        ),
      ],
    });

    expect(telemetry.events[0]).toMatchObject({
      kind: "trade",
      evidenceLevel: "accepted_action",
      message: "Atlas attempts to support Blitz.",
    });
    expect(
      telemetry.relationships.find(
        (relationship) =>
          relationship.fromAgentID === "a1" &&
          relationship.toAgentID === "a2",
      ),
    ).toMatchObject({ tradeGivenTroops: 0, trust: 50 });
  });
});

function roster() {
  return [
    {
      agentID: "a1",
      username: "Atlas",
      profile: "diplomatic" as const,
      clientID: "c1",
      brainType: "planner-executor" as const,
    },
    {
      agentID: "a2",
      username: "Blitz",
      profile: "aggressive" as const,
      clientID: "c2",
      brainType: "planner-executor" as const,
    },
  ];
}

function finalState() {
  return {
    phase: "active" as const,
    tick: 1,
    turnCount: 100,
    players: [
      {
        agentID: "a1",
        username: "Atlas",
        profile: "diplomatic" as const,
        playerID: "p1",
        isAlive: true,
        tilesOwned: 10,
        troops: 1000,
        gold: "100",
      },
      {
        agentID: "a2",
        username: "Blitz",
        profile: "aggressive" as const,
        playerID: "p2",
        isAlive: true,
        tilesOwned: 10,
        troops: 1000,
        gold: "100",
      },
    ],
  };
}

function record(
  sequence: number,
  agentID: string,
  username: string,
  playerID: string,
  kind: LegalActionKind,
  metadata: Record<string, string | number | boolean | null>,
  options: {
    accepted?: boolean;
    auditStatus?: AgentActionAuditStatus;
    fallbackUsed?: boolean;
    llmPlannerDegraded?: boolean;
  } = {},
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
    reason: options.fallbackUsed ? null : `${username} selects ${kind}`,
    decisionMetadata: {
      ...(options.fallbackUsed !== undefined
        ? { fallbackUsed: options.fallbackUsed }
        : {}),
      ...(options.llmPlannerDegraded !== undefined
        ? { llmPlannerDegraded: options.llmPlannerDegraded }
        : {}),
    },
    chosenActionMetadata: metadata,
    intent: null,
    result: {
      accepted: options.accepted ?? true,
      reason: options.accepted === false ? "rejected for test" : "accepted",
      submittedIntent: null,
    },
    audit: {
      auditStatus: options.auditStatus ?? "confirmed",
      auditReason: `test decision ${options.auditStatus ?? "applied"}`,
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
