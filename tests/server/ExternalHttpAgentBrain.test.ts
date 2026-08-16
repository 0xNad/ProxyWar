import { describe, expect, it } from "vitest";
import { PlayerType, Relation } from "../../src/core/game/Game";
import type {
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import {
  buildExternalAgentRequestPayload,
  ExternalHttpAgentBrain,
} from "../../src/server/agents/ExternalHttpAgentBrain";
import { ExternalRelayAgentBrain } from "../../src/server/agents/ExternalRelayAgentBrain";

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

const spawnObservation: AgentObservation = {
  ...observation,
  phase: "spawn",
  mapInfo: { name: "Pangaea", width: 3000, height: 2000 },
};

const spawnLegalActions: LegalAction[] = [
  {
    id: "spawn:10",
    kind: "spawn",
    label: "Spawn at tile 10",
    intent: { type: "spawn", tile: 10 },
    risk: { level: "low", score: 0.2 },
    metadata: { tile: 10, safetyScore: 0.8, opportunityScore: 0.7 },
  },
  {
    id: "spawn:20",
    kind: "spawn",
    label: "Spawn at tile 20",
    intent: { type: "spawn", tile: 20 },
    risk: { level: "medium", score: 0.4 },
    metadata: { tile: 20, safetyScore: 0.6, opportunityScore: 0.9 },
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
    // A genuine (non-fallback) decision keeps its real stated reason —
    // unaffected by the fallback-path P0 fix below.
    expect(decision.reason).toBe("Early neutral expansion is safe and useful.");
    expect(decision.metadata).toMatchObject({
      brain: "external-http",
      parseSuccess: true,
      fallbackUsed: false,
      confidence: 0.84,
    });
    expect(captured.requestBody?.protocolVersion).toBe("proxywar-agent-v1");
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
    // Scalar-only replies never grow an actionIDs batch.
    expect(decision.actionIDs).toBeUndefined();
  });

  it("maps a selectedLegalActionIds batch onto AgentDecision.actionIDs", async () => {
    const brain = new ExternalHttpAgentBrain({
      endpointUrl: "https://1.1.1.1/decide",
      token: "secret-token",
      profile: "aggressive",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            selectedLegalActionId: "expand:terra-nullius:10",
            selectedLegalActionIds: ["expand:terra-nullius:10", "hold"],
            reason: "expand, then bank the remainder as a hold",
          }),
          { status: 200 },
        ),
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.actionIDs).toEqual(["expand:terra-nullius:10", "hold"]);
    expect(decision.metadata).toMatchObject({ fallbackUsed: false });
  });

  it("maps the batch through the relay transport for parity", async () => {
    const brain = new ExternalRelayAgentBrain({
      relayBaseUrl: "https://relay.example",
      sessionID: "sess-1",
      profile: "aggressive",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            responseText: JSON.stringify({
              selectedLegalActionId: "expand:terra-nullius:10",
              selectedLegalActionIds: ["expand:terra-nullius:10", "hold"],
              reason: "expand, then bank the remainder as a hold",
            }),
          }),
          { status: 200 },
        ),
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.actionIDs).toEqual(["expand:terra-nullius:10", "hold"]);
  });

  it("maps a spawn-only ranking without treating it as an executable batch", async () => {
    const brain = new ExternalHttpAgentBrain({
      endpointUrl: "https://1.1.1.1/decide",
      profile: "aggressive",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            selectedLegalActionId: "spawn:20",
            spawnPreferenceLegalActionIds: ["spawn:20", "spawn:10"],
            reason: "Prefer the stronger opportunity score.",
          }),
          { status: 200 },
        ),
    });

    const decision = await brain.decide({
      observation: spawnObservation,
      legalActions: spawnLegalActions,
    });

    expect(decision.actionID).toBe("spawn:20");
    expect(decision.spawnPreferenceActionIDs).toEqual(["spawn:20", "spawn:10"]);
    expect(decision.actionIDs).toBeUndefined();
  });

  it("maps the spawn ranking through the relay transport for parity", async () => {
    const brain = new ExternalRelayAgentBrain({
      relayBaseUrl: "https://relay.example",
      sessionID: "sess-spawn",
      profile: "aggressive",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            responseText: JSON.stringify({
              selectedLegalActionId: "spawn:10",
              spawnPreferenceLegalActionIds: ["spawn:10", "spawn:20"],
              reason: "Prefer safety.",
            }),
          }),
          { status: 200 },
        ),
    });

    const decision = await brain.decide({
      observation: spawnObservation,
      legalActions: spawnLegalActions,
    });

    expect(decision.spawnPreferenceActionIDs).toEqual(["spawn:10", "spawn:20"]);
    expect(decision.actionIDs).toBeUndefined();
  });

  it("rejects executable batching alongside a spawn ballot through HTTP and relay", async () => {
    const conflictingReply = JSON.stringify({
      selectedLegalActionId: "spawn:20",
      selectedLegalActionIds: ["spawn:20", "spawn:10"],
      spawnPreferenceLegalActionIds: ["spawn:20", "spawn:10"],
      reason: "This incorrectly treats spawn preferences as executable moves.",
    });
    const http = new ExternalHttpAgentBrain({
      endpointUrl: "https://1.1.1.1/decide",
      profile: "aggressive",
      fetchFn: async () => new Response(conflictingReply, { status: 200 }),
    });
    const relay = new ExternalRelayAgentBrain({
      relayBaseUrl: "https://relay.example",
      sessionID: "sess-spawn-conflict",
      profile: "aggressive",
      fetchFn: async () =>
        new Response(JSON.stringify({ responseText: conflictingReply }), {
          status: 200,
        }),
    });

    const decisions = await Promise.all(
      [http, relay].map((brain) =>
        brain.decide({
          observation: spawnObservation,
          legalActions: spawnLegalActions,
        }),
      ),
    );

    for (const decision of decisions) {
      expect(decision.actionID).toBe("spawn:10");
      expect(decision.actionIDs).toBeUndefined();
      expect(decision.spawnPreferenceActionIDs).toEqual([
        "spawn:10",
        "spawn:20",
      ]);
      expect(decision.metadata).toMatchObject({ fallbackUsed: true });
      expect(decision.metadata?.externalFailureReason).toContain(
        "selectedLegalActionIds is not allowed on an all-spawn menu",
      );
    }
  });

  it("falls back safely when the endpoint returns an unknown action id, recording no stated reason", async () => {
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
    // P0 fix: a fallback decision has no stated reason — the external agent
    // never produced a usable one, so `reason` is null rather than a
    // synthesized "External agent fallback (...); ..." string.
    expect(decision.reason).toBeNull();
    expect(decision.metadata).toMatchObject({
      brain: "external-http",
      parseSuccess: false,
      fallbackUsed: true,
    });
    // The distinct fields carry what `reason` used to conflate: the
    // external-agent failure text (unchanged field), and the substituted
    // rule brain's own genuine reason (new field).
    expect(decision.metadata?.externalFailureReason).toContain(
      "unknown selectedLegalActionId",
    );
    expect(typeof decision.metadata?.fallbackReason).toBe("string");
    expect(decision.metadata?.fallbackReason).not.toContain(
      "External agent fallback",
    );
  });

  it("falls back safely when the endpoint returns extra JSON fields, recording no stated reason", async () => {
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
    expect(decision.reason).toBeNull();
    expect(decision.metadata).toMatchObject({
      brain: "external-http",
      parseSuccess: false,
      fallbackUsed: true,
    });
    expect(typeof decision.metadata?.fallbackReason).toBe("string");
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
    expect(decision.reason).toBe("Retried after a transient socket reset.");
    expect(decision.metadata).toMatchObject({
      parseSuccess: true,
      fallbackUsed: false,
    });
  });

  it("falls back safely when the endpoint times out, recording no stated reason", async () => {
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
    expect(decision.reason).toBeNull();
    expect(decision.metadata?.externalFailureReason).toContain("timed out");
    expect(typeof decision.metadata?.fallbackReason).toBe("string");
  });
});

describe("buildExternalAgentRequestPayload map identity and spawn protocol", () => {
  it("echoes bounded map identity/dimensions whenever the observation carries it", () => {
    const spawnPayload = buildExternalAgentRequestPayload({
      observation: spawnObservation,
      legalActions: spawnLegalActions,
    });
    expect(spawnPayload.match.map).toEqual({
      name: "Pangaea",
      width: 3000,
      height: 2000,
    });

    const activePayload = buildExternalAgentRequestPayload({
      observation,
      legalActions,
    });
    expect(activePayload.match.map).toBeNull();
  });

  it("advertises a bounded ranked ballot only for an all-spawn menu and never exposes raw coordinates", () => {
    const previousDeals = process.env.PROXYWAR_TUNE_STRUCTURED_DEALS;
    const previousMessages = process.env.PROXYWAR_TUNE_FREETEXT_MESSAGES;
    process.env.PROXYWAR_TUNE_STRUCTURED_DEALS = "1";
    process.env.PROXYWAR_TUNE_FREETEXT_MESSAGES = "1";
    try {
      const spawnPayload = buildExternalAgentRequestPayload({
        observation: spawnObservation,
        legalActions: spawnLegalActions,
      });
      expect(spawnPayload.decisionSupport).not.toHaveProperty("spawnFreeform");
      expect(spawnPayload.responseContract).toMatchObject({
        spawnPreferenceLegalActionIds: expect.stringContaining("exact offered"),
        maxSpawnPreferences: 16,
      });
      expect(spawnPayload.responseContract).not.toHaveProperty(
        "selectedDealActionId",
      );
      expect(spawnPayload.responseContract).not.toHaveProperty(
        "selectedMessageActionId",
      );
      expect(spawnPayload.responseContract).not.toHaveProperty("messageText");
      expect(JSON.stringify(spawnPayload.responseContract)).not.toContain(
        "coordinate",
      );

      const activePayload = buildExternalAgentRequestPayload({
        observation,
        legalActions,
      });
      expect(activePayload.decisionSupport).not.toHaveProperty("spawnFreeform");
      expect(activePayload.responseContract).not.toHaveProperty(
        "spawnPreferenceLegalActionIds",
      );
      expect(activePayload.responseContract).not.toHaveProperty(
        "maxSpawnPreferences",
      );
      expect(activePayload.responseContract).toHaveProperty(
        "selectedDealActionId",
      );
      expect(activePayload.responseContract).toHaveProperty(
        "selectedMessageActionId",
      );
    } finally {
      if (previousDeals === undefined) {
        delete process.env.PROXYWAR_TUNE_STRUCTURED_DEALS;
      } else {
        process.env.PROXYWAR_TUNE_STRUCTURED_DEALS = previousDeals;
      }
      if (previousMessages === undefined) {
        delete process.env.PROXYWAR_TUNE_FREETEXT_MESSAGES;
      } else {
        process.env.PROXYWAR_TUNE_FREETEXT_MESSAGES = previousMessages;
      }
    }
  });
});

// The renewal fact rides on the observation, but a policy reading fifteen
// rivals' worth of JSON will not notice one new boolean, and the window to
// answer is only a few decisions wide. The hint makes it salient, exactly like
// antiStallHint, and stays null when there is nothing to answer.
describe("buildExternalAgentRequestPayload alliance renewal hint", () => {
  const ally = (
    overrides: Partial<AgentObservation["visiblePlayers"][number]> = {},
  ): AgentObservation["visiblePlayers"][number] =>
    ({
      playerID: "PLAYER02",
      clientID: "CLNT0002",
      smallID: 2,
      name: "Steady Ally",
      type: PlayerType.Human,
      isAlive: true,
      isDisconnected: false,
      hasSpawned: true,
      troops: 100,
      maxTroops: 200,
      troopRatio: 0.5,
      gold: "50",
      tilesOwned: 30,
      tileShare: 0.03,
      sharesBorder: true,
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      canAttack: false,
      canRequestAlliance: false,
      canDonateGold: false,
      canDonateTroops: false,
      canEmbargo: false,
      hasEmbargoAgainst: false,
      outgoingAttack: false,
      incomingAttack: false,
      hasOutgoingAllianceRequest: false,
      hasIncomingAllianceRequest: false,
      allianceInExtensionWindow: true,
      ...overrides,
    }) as AgentObservation["visiblePlayers"][number];

  const extendAction: LegalAction = {
    id: "alliance_extend:PLAYER02",
    kind: "alliance_extend",
    label: "extend alliance with Steady Ally",
    intent: null,
    risk: { level: "low", score: 0.2 },
    metadata: { targetID: "PLAYER02", targetName: "Steady Ally" },
  };

  it("names the ally waiting on a reply and says the alliance lapses without one", () => {
    const payload = buildExternalAgentRequestPayload({
      observation: {
        ...observation,
        visiblePlayers: [ally({ allianceOtherAgreedToExtend: true })],
      },
      legalActions: [extendAction],
    });
    expect(payload.decisionSupport.allianceRenewalHint).toContain(
      "Steady Ally",
    );
    expect(payload.decisionSupport.allianceRenewalHint).toContain("BOTH sides");
    expect(payload.decisionSupport.allianceRenewalHint).toContain("lapses");
  });

  it("stays null when the ally has not asked, or when no extend is offered", () => {
    expect(
      buildExternalAgentRequestPayload({
        observation: { ...observation, visiblePlayers: [ally()] },
        legalActions: [extendAction],
      }).decisionSupport.allianceRenewalHint,
    ).toBeNull();

    expect(
      buildExternalAgentRequestPayload({
        observation: {
          ...observation,
          visiblePlayers: [ally({ allianceOtherAgreedToExtend: true })],
        },
        legalActions: [],
      }).decisionSupport.allianceRenewalHint,
    ).toBeNull();

    expect(
      buildExternalAgentRequestPayload({ observation, legalActions })
        .decisionSupport.allianceRenewalHint,
    ).toBeNull();
  });
});
