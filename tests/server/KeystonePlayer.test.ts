import { describe, expect, it } from "vitest";

import * as plannerExecutorModule from "../../src/server/agents/AgentPlannerExecutor";
import * as claudeCliModule from "../../src/server/agents/ClaudeCliLlmProvider";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import { buildExternalAgentRequestPayload } from "../../src/server/agents/ExternalHttpAgentBrain";
import type {
  AgentPlanDecision,
  AgentPlanner,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrainInput,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import {
  createKeystoneBrain,
  decisionToResponse,
  DeferredAgentPlanner,
  keystoneModeFromEnv,
  requestToBrainInput,
  type KeystoneModules,
} from "../../coworld-adapter/src/keystone-player";

const modules: KeystoneModules = {
  plannerExecutor: plannerExecutorModule,
  claudeCli: claudeCliModule,
};

function spawnLegalActions(): LegalAction[] {
  return [
    {
      id: "spawn:10",
      kind: "spawn",
      label: "Spawn at 10",
      intent: { type: "spawn", tile: 10 },
      risk: { level: "medium", score: 0.4 },
      metadata: { coastal: true },
    },
    {
      id: "hold:wait",
      kind: "hold",
      label: "Hold",
      intent: null,
      risk: { level: "low", score: 0.1 },
    },
  ];
}

function spawnBrainInput(): AgentBrainInput {
  const observation = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: null,
    username: "Keystone Agent",
    profile: "aggressive",
    gameID: "KEYSTONE",
    turnNumber: 0,
    phaseOverride: "spawn",
  });
  return { observation, legalActions: spawnLegalActions() };
}

/** Simulates the Coworld wire: the game serializes the canonical payload and
 * the player receives plain JSON. */
function wireRequest(input: AgentBrainInput): unknown {
  return JSON.parse(JSON.stringify(buildExternalAgentRequestPayload(input)));
}

function makePlan(planID: string): StrategicPlan {
  return {
    planID,
    objective: "expand_territory",
    targetPlayerId: null,
    rationale: "test plan",
    startedAtTick: 0,
    maxDecisionCycles: 6,
    successCriteria: [],
    failureCriteria: [],
    preferredActionKinds: ["attack", "hold"],
    forbiddenActionKinds: [],
    plannerSource: "real-llm",
  };
}

function makePlanDecision(planID: string): AgentPlanDecision {
  return {
    plan: makePlan(planID),
    reason: "llm plan",
    latencyMs: 5,
    fallbackUsed: false,
  };
}

describe("Coworld keystone player", () => {
  it("reconstructs the canonical brain input from the wire payload", () => {
    const input = spawnBrainInput();
    const request = wireRequest(input);

    const rebuilt = requestToBrainInput(request);

    expect(rebuilt.observation.agentID).toBe("agent-1");
    expect(rebuilt.observation.phase).toBe(input.observation.phase);
    expect(rebuilt.legalActions.map((action) => action.id)).toEqual([
      "spawn:10",
      "hold:wait",
    ]);
    // Intents never cross the wire — the runner owns them.
    expect(rebuilt.legalActions.every((action) => action.intent === null)).toBe(
      true,
    );
    expect(rebuilt.legalActions[0].risk).toEqual({
      level: "medium",
      score: 0.4,
    });
    expect(rebuilt.legalActions[0].metadata).toEqual({ coastal: true });
  });

  it("rejects payloads without legal actions", () => {
    const input = spawnBrainInput();
    const request = wireRequest(input) as Record<string, unknown>;
    request.legalActions = [];

    expect(() => requestToBrainInput(request)).toThrow(/no legalActions/);
  });

  it("executor mode answers in-clock with an offered LegalAction.id", async () => {
    const brain = createKeystoneBrain(modules, {
      mode: "executor",
      profile: "aggressive",
    });
    const rebuilt = requestToBrainInput(wireRequest(spawnBrainInput()));

    const startedAt = Date.now();
    const decision = await brain.decide(rebuilt);
    const elapsedMs = Date.now() - startedAt;

    expect(["spawn:10", "hold:wait"]).toContain(decision.actionID);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("mock mode plumbs the LLM plan path and still selects an offered id", async () => {
    const brain = createKeystoneBrain(modules, {
      mode: "mock",
      profile: "aggressive",
    });
    const rebuilt = requestToBrainInput(wireRequest(spawnBrainInput()));

    const decision = await brain.decide(rebuilt);

    expect(["spawn:10", "hold:wait"]).toContain(decision.actionID);
  });

  it("DeferredAgentPlanner answers in-clock while the Commander refresh is in flight", async () => {
    const input = spawnBrainInput();
    const slowInner: AgentPlanner = {
      plannerType: "real-llm",
      plan: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(makePlanDecision("llm-plan-1")), 100),
        ),
    };
    const deferred = new DeferredAgentPlanner(
      slowInner,
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
    );

    const startedAt = Date.now();
    const first = await deferred.plan(input, null);
    const elapsedMs = Date.now() - startedAt;

    // Bootstrap rule plan, returned without waiting on the 100ms inner call.
    expect(elapsedMs).toBeLessThan(60);
    expect(first.plan.plannerSource).toBe("rule");

    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await deferred.plan(input, first.plan);
    expect(second.plan.planID).toBe("llm-plan-1");
  });

  it("DeferredAgentPlanner surfaces Commander failures loudly", async () => {
    const input = spawnBrainInput();
    const failingInner: AgentPlanner = {
      plannerType: "real-llm",
      plan: () => Promise.reject(new Error("quota exhausted")),
    };
    const deferred = new DeferredAgentPlanner(
      failingInner,
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
    );

    const first = await deferred.plan(input, null);
    expect(first.plan.plannerSource).toBe("rule");

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await deferred.plan(input, first.plan);
    expect(second.llmPlannerDegraded).toBe(true);
    expect(second.fallbackUsed).toBe(true);
    expect(second.reason).toContain("quota exhausted");
  });

  it("decisionToResponse maps the decision onto the wire contract", () => {
    const longReason = "x".repeat(600);
    const response = decisionToResponse("req_1", {
      actionID: "attack:rival",
      reason: longReason,
      metadata: { confidence: 0.85 },
    });

    expect(response).toMatchObject({
      type: "decision_response",
      requestID: "req_1",
      selectedLegalActionId: "attack:rival",
      confidence: 0.85,
    });
    expect((response.reason as string).length).toBe(500);
  });

  it("keystoneModeFromEnv defaults to executor and rejects unknown modes", () => {
    expect(keystoneModeFromEnv({})).toBe("executor");
    expect(keystoneModeFromEnv({ PROXYWAR_KEYSTONE_MODE: "bedrock" })).toBe(
      "bedrock",
    );
    expect(() =>
      keystoneModeFromEnv({ PROXYWAR_KEYSTONE_MODE: "warp-drive" }),
    ).toThrow(/Unknown PROXYWAR_KEYSTONE_MODE/);
  });
});
