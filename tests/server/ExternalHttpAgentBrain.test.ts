import { describe, expect, it } from "vitest";
import { PlayerType } from "../../src/core/game/Game";
import type {
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import { ExternalHttpAgentBrain } from "../../src/server/agents/ExternalHttpAgentBrain";

const observation: AgentObservation = {
  agentID: "agent-1",
  clientID: "CLNT0001",
  username: "Remote Nation",
  profile: "aggressive",
  gameID: "AGENTHTTP",
  phase: "active",
  turnNumber: 3,
  tick: 120,
  ownState: {
    playerID: "PLAYER01",
    clientID: "CLNT0001",
    smallID: 1,
    name: "Remote Nation",
    type: PlayerType.Human,
    isAlive: true,
    isDisconnected: false,
    isTraitor: false,
    hasSpawned: true,
    troops: 120,
    gold: "80",
    tilesOwned: 42,
    borderTiles: 5,
    outgoingAttacks: 0,
    incomingAttacks: 0,
    outgoingAllianceRequests: 0,
    incomingAllianceRequests: 0,
  },
  visiblePlayers: [],
  combat: {
    ownTroops: 120,
    borderedPlayerIDs: [],
    attackablePlayerIDs: [],
    canExpandIntoNeutral: true,
    neutralExpansionLegalReason: "owned border touches neutral land",
    incomingAttackPlayerIDs: [],
    outgoingAttackPlayerIDs: [],
    weakestAttackableTargetID: null,
    strongestAttackableTargetID: null,
    blockerNotes: [],
  },
  nonCombat: {
    buildOptions: [],
    supportOptions: [],
    embargoOptions: [],
    blockerNotes: [],
  },
  strategic: {
    priority: "expand",
    urgency: "medium",
    summary: "priority=expand, urgency=medium",
    scores: {
      expansion: 0.8,
      economy: 0.4,
      defense: 0.2,
      offense: 0.4,
      diplomacy: 0.1,
      threat: 0,
      idleTroops: 0.7,
    },
    recommendedActionKinds: ["attack", "hold"],
    targetPlayerIDs: [],
    notes: [],
  },
  memory: {
    recentActions: [],
    recentActionCountsByKind: {},
    recentNonHoldCount: 0,
    recentExpansionCount: 0,
    recentBuildCount: 0,
    repeatedActionKind: null,
    repeatedActionCount: 0,
    avoidActionIDs: [],
    summary: "no recent decisions",
    notes: [],
  },
  objective: null,
  recentDecisions: [],
  notes: [],
};

const legalActions: LegalAction[] = [
  {
    id: "expand:terra-nullius:10",
    kind: "attack",
    label: "Expand into neutral land with 10% troops",
    intent: { type: "attack", targetID: "terra-nullius", troops: 10 },
    risk: { level: "low", score: 0.2 },
    metadata: { expansion: true },
  },
  {
    id: "hold",
    kind: "hold",
    label: "Hold",
    intent: null,
    risk: { level: "none", score: 0 },
  },
];

describe("ExternalHttpAgentBrain", () => {
  it("posts observation and public legal actions, then accepts a selected LegalAction id", async () => {
    const captured: { requestBody?: Record<string, unknown> } = {};
    const brain = new ExternalHttpAgentBrain({
      endpointUrl: "https://1.1.1.1/decide",
      token: "secret-token",
      profile: "aggressive",
      fetchFn: async (_url, init) => {
        captured.requestBody = JSON.parse(String(init.body)) as Record<
          string,
          unknown
        >;
        const headers = init.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer secret-token");
        return new Response(
          JSON.stringify({
            selectedLegalActionId: "expand:terra-nullius:10",
            reason: "Early neutral expansion is safe and useful.",
            confidence: 0.84,
          }),
          { status: 200 },
        );
      },
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.metadata).toMatchObject({
      brain: "external-http",
      parseSuccess: true,
      fallbackUsed: false,
      confidence: 0.84,
    });
    expect(captured.requestBody?.protocolVersion).toBe(
      "open-frontier-agent-v1",
    );
    expect(
      (captured.requestBody?.legalActions as Array<Record<string, unknown>>)[0]
        .intent,
    ).toBeUndefined();
    expect(captured.requestBody?.decisionSupport).toMatchObject({
      actionIDsByKind: {
        attack: ["expand:terra-nullius:10"],
        hold: ["hold"],
      },
      usefulNonHoldActionIDs: ["expand:terra-nullius:10"],
      safeFallbackActionID: "hold",
    });
  });

  it("falls back safely when the endpoint returns an unknown action id", async () => {
    const brain = new ExternalHttpAgentBrain({
      endpointUrl: "https://1.1.1.1/decide",
      profile: "aggressive",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            selectedLegalActionId: "attack:invented",
            reason: "I invented an action.",
          }),
          { status: 200 },
        ),
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.reason).toContain("External agent fallback");
    expect(decision.metadata).toMatchObject({
      brain: "external-http",
      parseSuccess: false,
      fallbackUsed: true,
    });
  });

  it("falls back safely when the endpoint returns extra JSON fields", async () => {
    const brain = new ExternalHttpAgentBrain({
      endpointUrl: "https://1.1.1.1/decide",
      profile: "aggressive",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            selectedLegalActionId: "expand:terra-nullius:10",
            reason: "I also included an unsafe raw action.",
            action: { type: "attack" },
          }),
          { status: 200 },
        ),
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.reason).toContain("External agent fallback");
    expect(decision.metadata).toMatchObject({
      brain: "external-http",
      parseSuccess: false,
      fallbackUsed: true,
    });
  });

  it("retries transient network resets before falling back", async () => {
    let attempts = 0;
    const brain = new ExternalHttpAgentBrain({
      endpointUrl: "https://1.1.1.1/decide",
      profile: "aggressive",
      maxRetries: 1,
      fetchFn: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("read ECONNRESET");
        }
        return new Response(
          JSON.stringify({
            selectedLegalActionId: "expand:terra-nullius:10",
            reason: "Retried after a transient socket reset.",
            confidence: 0.8,
          }),
          { status: 200 },
        );
      },
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(attempts).toBe(2);
    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.metadata).toMatchObject({
      parseSuccess: true,
      fallbackUsed: false,
    });
  });

  it("falls back safely when the endpoint times out", async () => {
    const brain = new ExternalHttpAgentBrain({
      endpointUrl: "https://1.1.1.1/slow",
      profile: "aggressive",
      timeoutMs: 1,
      fetchFn: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.metadata?.externalFailureReason).toContain("timed out");
  });
});
