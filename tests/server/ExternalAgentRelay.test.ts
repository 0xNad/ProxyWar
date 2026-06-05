import { describe, expect, it } from "vitest";
import { PlayerType } from "../../src/core/game/Game";
import type {
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import {
  ExternalAgentRelayError,
  ExternalAgentRelayStore,
} from "../../src/server/agents/ExternalAgentRelay";
import { ExternalRelayAgentBrain } from "../../src/server/agents/ExternalRelayAgentBrain";
import { buildExternalAgentRequestPayload } from "../../src/server/agents/ExternalHttpAgentBrain";

const observation: AgentObservation = {
  agentID: "agent-1",
  clientID: "CLNT0001",
  username: "Relay Nation",
  profile: "opportunistic",
  gameID: "AGENTRELAY",
  phase: "active",
  turnNumber: 3,
  tick: 120,
  ownState: {
    playerID: "PLAYER01",
    clientID: "CLNT0001",
    smallID: 1,
    name: "Relay Nation",
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

describe("ExternalAgentRelayStore", () => {
  it("delivers one canonical request over poll and resolves a strict decision", async () => {
    const store = new ExternalAgentRelayStore();
    const session = store.createSession({
      agentName: "Relay Nation",
      profile: "opportunistic",
      relayBaseUrl: "https://beta.proxywar.xyz",
    });
    const request = buildExternalAgentRequestPayload({ observation, legalActions });
    const pending = store.requestDecision({
      sessionID: session.sessionID,
      token: session.sessionToken,
      request,
    });

    const poll = await store.poll({
      sessionID: session.sessionID,
      token: session.sessionToken,
      waitMs: 0,
    });

    expect(poll.status).toBe("request");
    if (poll.status !== "request") throw new Error("expected request");
    expect(poll.request.legalActions[0]).not.toHaveProperty("intent");
    store.submitDecision({
      sessionID: session.sessionID,
      token: session.sessionToken,
      requestID: poll.requestID,
      response: {
        decision: {
          selectedLegalActionId: "expand:terra-nullius:10",
          reason: "Safe expansion.",
          confidence: 0.8,
        },
      },
    });

    await expect(pending).resolves.toMatchObject({
      requestID: poll.requestID,
      responseText: expect.stringContaining("selectedLegalActionId"),
    });
  });

  it("accepts flat decision envelopes that echo requestID", async () => {
    const store = new ExternalAgentRelayStore();
    const session = store.createSession({
      agentName: "Relay Nation",
      profile: "opportunistic",
      relayBaseUrl: "https://beta.proxywar.xyz",
    });
    const request = buildExternalAgentRequestPayload({ observation, legalActions });
    const pending = store.requestDecision({
      sessionID: session.sessionID,
      token: session.sessionToken,
      request,
    });
    const poll = await store.poll({
      sessionID: session.sessionID,
      token: session.sessionToken,
      waitMs: 0,
    });

    expect(poll.status).toBe("request");
    if (poll.status !== "request") throw new Error("expected request");
    store.submitDecision({
      sessionID: session.sessionID,
      token: session.sessionToken,
      requestID: poll.requestID,
      response: {
        requestID: poll.requestID,
        selectedLegalActionId: "expand:terra-nullius:10",
        reason: "Safe expansion.",
        confidence: 0.8,
      },
    });

    const result = await pending;
    expect(result).toMatchObject({
      requestID: poll.requestID,
      responseText: expect.stringContaining("selectedLegalActionId"),
    });
    expect(result.responseText).not.toContain("requestID");
  });

  it("redelivers an in-flight request before the match brain timeout budget is spent", async () => {
    let now = Date.UTC(2026, 0, 1);
    const store = new ExternalAgentRelayStore({ now: () => now });
    const session = store.createSession({
      agentName: "Relay Nation",
      profile: "opportunistic",
      relayBaseUrl: "https://beta.proxywar.xyz",
    });
    const request = buildExternalAgentRequestPayload({ observation, legalActions });
    const pending = store.requestDecision({
      sessionID: session.sessionID,
      token: session.sessionToken,
      request,
    });
    const firstPoll = await store.poll({
      sessionID: session.sessionID,
      token: session.sessionToken,
      waitMs: 0,
    });
    const immediatePoll = await store.poll({
      sessionID: session.sessionID,
      token: session.sessionToken,
      waitMs: 0,
    });

    now += 5_000;
    const redeliveredPoll = await store.poll({
      sessionID: session.sessionID,
      token: session.sessionToken,
      waitMs: 0,
    });

    expect(firstPoll.status).toBe("request");
    expect(immediatePoll.status).toBe("idle");
    expect(redeliveredPoll.status).toBe("request");
    if (firstPoll.status !== "request" || redeliveredPoll.status !== "request") {
      throw new Error("expected redelivered request");
    }
    expect(redeliveredPoll.requestID).toBe(firstPoll.requestID);
    store.submitDecision({
      sessionID: session.sessionID,
      token: session.sessionToken,
      requestID: redeliveredPoll.requestID,
      response: {
        requestID: redeliveredPoll.requestID,
        selectedLegalActionId: "expand:terra-nullius:10",
        reason: "Safe redelivered expansion.",
      },
    });
    await expect(pending).resolves.toMatchObject({
      requestID: firstPoll.requestID,
    });
  });

  it("reports relay worker errors without masking them as schema failures", async () => {
    const store = new ExternalAgentRelayStore();
    const session = store.createSession({
      agentName: "Relay Nation",
      profile: "opportunistic",
      relayBaseUrl: "https://beta.proxywar.xyz",
    });
    const request = buildExternalAgentRequestPayload({ observation, legalActions });
    const pending = store.requestDecision({
      sessionID: session.sessionID,
      token: session.sessionToken,
      request,
    });
    const poll = await store.poll({
      sessionID: session.sessionID,
      token: session.sessionToken,
      waitMs: 0,
    });

    expect(poll.status).toBe("request");
    if (poll.status !== "request") throw new Error("expected request");
    expect(() =>
      store.submitDecision({
        sessionID: session.sessionID,
        token: session.sessionToken,
        requestID: poll.requestID,
        response: {
          requestID: poll.requestID,
          error: "Claude CLI is not logged in.",
        },
      }),
    ).toThrow(/Claude CLI is not logged in/);
    await expect(pending).rejects.toThrow(/Claude CLI is not logged in/);
  });

  it("rejects wrong relay tokens without leaking the expected token", async () => {
    const store = new ExternalAgentRelayStore();
    const session = store.createSession({
      agentName: "Relay Nation",
      profile: "opportunistic",
      relayBaseUrl: "https://beta.proxywar.xyz",
    });

    await expect(
      store.poll({
        sessionID: session.sessionID,
        token: "wrong-token",
        waitMs: 0,
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "relay_token_invalid",
    });
    await expect(
      store.poll({
        sessionID: session.sessionID,
        token: "wrong-token",
        waitMs: 0,
      }),
    ).rejects.not.toThrow(session.sessionToken);
  });

  it("rejects missing relay tokens before exposing session state", async () => {
    const store = new ExternalAgentRelayStore();

    await expect(
      store.poll({
        sessionID: "relay_missing",
        token: undefined,
        waitMs: 0,
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "relay_token_missing",
    });
  });

  it("restores a saved relay session after an in-memory store restart", async () => {
    const original = new ExternalAgentRelayStore();
    const created = original.createSession({
      agentName: "Relay Nation",
      profile: "opportunistic",
      relayBaseUrl: "https://beta.proxywar.xyz",
    });
    const restarted = new ExternalAgentRelayStore();

    expect(restarted.hasSession(created.sessionID)).toBe(false);
    const restored = restarted.restoreSession({
      sessionID: created.sessionID,
      sessionToken: created.sessionToken,
      agentName: "Relay Nation",
      profile: "opportunistic",
      relayBaseUrl: "https://beta.proxywar.xyz",
    });
    const poll = await restarted.poll({
      sessionID: created.sessionID,
      token: created.sessionToken,
      waitMs: 0,
    });

    expect(restored.restored).toBe(true);
    expect(restarted.hasSession(created.sessionID)).toBe(true);
    expect(restarted.hasActiveSession(created.sessionID)).toBe(true);
    expect(poll).toMatchObject({
      ok: true,
      status: "idle",
      sessionID: created.sessionID,
    });
  });

  it("rejects restore attempts with a wrong token for an existing session", () => {
    const store = new ExternalAgentRelayStore();
    const created = store.createSession({
      agentName: "Relay Nation",
      profile: "opportunistic",
      relayBaseUrl: "https://beta.proxywar.xyz",
    });

    expect(() =>
      store.restoreSession({
        sessionID: created.sessionID,
        sessionToken: "wrong-token",
        agentName: "Relay Nation",
        profile: "opportunistic",
        relayBaseUrl: "https://beta.proxywar.xyz",
      }),
    ).toThrow(/token is invalid/);
  });

  it("requires recent worker polling before a relay session is active", async () => {
    let now = Date.UTC(2026, 0, 1);
    const store = new ExternalAgentRelayStore({ now: () => now });
    const created = store.createSession({
      agentName: "Relay Nation",
      profile: "opportunistic",
      relayBaseUrl: "https://beta.proxywar.xyz",
    });

    expect(store.hasSession(created.sessionID)).toBe(true);
    expect(store.hasActiveSession(created.sessionID, 90_000)).toBe(false);

    await store.poll({
      sessionID: created.sessionID,
      token: created.sessionToken,
      waitMs: 0,
    });
    expect(store.hasActiveSession(created.sessionID, 90_000)).toBe(true);

    now += 90_001;
    expect(store.hasSession(created.sessionID)).toBe(true);
    expect(store.hasActiveSession(created.sessionID, 90_000)).toBe(false);
  });

  it("expires relay sessions and removes them after a valid expired-token check", async () => {
    let now = Date.UTC(2026, 0, 1);
    const store = new ExternalAgentRelayStore({ now: () => now });
    const session = store.createSession({
      agentName: "Relay Nation",
      profile: "opportunistic",
      relayBaseUrl: "https://beta.proxywar.xyz",
      ttlMs: 60_000,
    });

    now += 60_001;
    await expect(
      store.poll({
        sessionID: session.sessionID,
        token: session.sessionToken,
        waitMs: 0,
      }),
    ).rejects.toMatchObject({
      statusCode: 410,
      code: "relay_session_expired",
    });
    await expect(
      store.poll({
        sessionID: session.sessionID,
        token: session.sessionToken,
        waitMs: 0,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "relay_session_not_found",
    });
  });

  it("rejects actionId aliases and invented ids at submission time", async () => {
    const store = new ExternalAgentRelayStore();
    const session = store.createSession({
      agentName: "Relay Nation",
      profile: "opportunistic",
      relayBaseUrl: "https://beta.proxywar.xyz",
    });
    const request = buildExternalAgentRequestPayload({ observation, legalActions });
    const firstPending = store.requestDecision({
      sessionID: session.sessionID,
      token: session.sessionToken,
      request,
    });
    const firstPoll = await store.poll({
      sessionID: session.sessionID,
      token: session.sessionToken,
      waitMs: 0,
    });
    if (firstPoll.status !== "request") throw new Error("expected request");
    expect(() =>
      store.submitDecision({
        sessionID: session.sessionID,
        token: session.sessionToken,
        requestID: firstPoll.requestID,
        response: {
          actionId: "expand:terra-nullius:10",
          reason: "Wrong field.",
        },
      }),
    ).toThrow(/selectedLegalActionId/);
    await expect(firstPending).rejects.toThrow(/selectedLegalActionId/);

    const secondPending = store.requestDecision({
      sessionID: session.sessionID,
      token: session.sessionToken,
      request,
    });
    const secondPoll = await store.poll({
      sessionID: session.sessionID,
      token: session.sessionToken,
      waitMs: 0,
    });
    if (secondPoll.status !== "request") throw new Error("expected request");
    expect(() =>
      store.submitDecision({
        sessionID: session.sessionID,
        token: session.sessionToken,
        requestID: secondPoll.requestID,
        response: {
          selectedLegalActionId: "attack:invented",
          reason: "Invented id.",
        },
      }),
    ).toThrow(/unknown selectedLegalActionId/);
    await expect(secondPending).rejects.toThrow(/unknown selectedLegalActionId/);
  });

  it("times out pending decisions with an actionable relay error", async () => {
    const store = new ExternalAgentRelayStore({ requestTimeoutMs: 5 });
    const session = store.createSession({
      agentName: "Relay Nation",
      profile: "opportunistic",
      relayBaseUrl: "https://beta.proxywar.xyz",
    });

    await expect(
      store.requestDecision({
        sessionID: session.sessionID,
        token: session.sessionToken,
        request: buildExternalAgentRequestPayload({ observation, legalActions }),
      }),
    ).rejects.toMatchObject({
      statusCode: 408,
      code: "relay_decision_timeout",
    });
  });
});

describe("ExternalRelayAgentBrain", () => {
  it("posts canonical requests to the relay request endpoint and accepts responseText", async () => {
    const captured: { url?: string; body?: Record<string, unknown> } = {};
    const brain = new ExternalRelayAgentBrain({
      relayBaseUrl: "https://beta.proxywar.xyz",
      sessionID: "relay_1234567890abcdef12345678",
      token: "relay-token",
      profile: "opportunistic",
      fetchFn: async (url, init) => {
        captured.url = url;
        captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect((init.headers as Record<string, string>).authorization).toBe(
          "Bearer relay-token",
        );
        return new Response(
          JSON.stringify({
            ok: true,
            requestID: "req_1",
            responseText: JSON.stringify({
              selectedLegalActionId: "expand:terra-nullius:10",
              reason: "Safe expansion through relay.",
              confidence: 0.7,
            }),
          }),
          { status: 200 },
        );
      },
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(captured.url).toContain(
      "/api/agent-relay/sessions/relay_1234567890abcdef12345678/requests",
    );
    expect((captured.body?.request as Record<string, unknown>).protocolVersion).toBe(
      "proxywar-agent-v1",
    );
    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.metadata).toMatchObject({
      brain: "external-relay",
      parseSuccess: true,
      fallbackUsed: false,
      externalActionCall: true,
    });
  });

  it("falls back visibly when the relay returns invalid decision text", async () => {
    const brain = new ExternalRelayAgentBrain({
      relayBaseUrl: "https://beta.proxywar.xyz",
      sessionID: "relay_1234567890abcdef12345678",
      token: "relay-token",
      profile: "opportunistic",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            requestID: "req_1",
            responseText: JSON.stringify({
              selectedLegalActionId: "attack:invented",
              reason: "Invented id.",
            }),
          }),
          { status: 200 },
        ),
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.reason).toContain("Managed relay fallback");
    expect(decision.metadata).toMatchObject({
      brain: "external-relay",
      parseSuccess: false,
      fallbackUsed: true,
    });
  });
});
