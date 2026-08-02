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
  bedrockModelCandidates,
  createKeystoneBrain,
  decisionToResponse,
  DeferredAgentPlanner,
  isModelUnavailableError,
  keystoneModeFromEnv,
  requestToBrainInput,
  transportFallbackResponse,
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

  it("pins the configured policy profile instead of inheriting the seat profile", () => {
    const request = wireRequest(spawnBrainInput());

    const rebuilt = requestToBrainInput(request, "opportunistic");

    expect(rebuilt.observation.profile).toBe("opportunistic");
    expect(spawnBrainInput().observation.profile).toBe("aggressive");
  });

  it("mock mode answers in-clock with an offered LegalAction.id (protocol plumbing)", async () => {
    const brain = createKeystoneBrain(modules, {
      mode: "mock",
      profile: "aggressive",
    });
    const rebuilt = requestToBrainInput(wireRequest(spawnBrainInput()));

    const startedAt = Date.now();
    const decision = await brain.decide(rebuilt);
    const elapsedMs = Date.now() - startedAt;

    expect(["spawn:10", "hold:wait"]).toContain(decision.actionID);
    expect(elapsedMs).toBeLessThan(2000);
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

  it("DeferredAgentPlanner keeps the full Commander cadence: consuming a landed plan arms the next refresh", async () => {
    const input = spawnBrainInput();
    let innerCalls = 0;
    const countingInner: AgentPlanner = {
      plannerType: "real-llm",
      plan: () => {
        innerCalls++;
        return Promise.resolve(makePlanDecision(`llm-plan-${innerCalls}`));
      },
    };
    const deferred = new DeferredAgentPlanner(
      countingInner,
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
    );

    // Each plan() call either starts a refresh or consumes a landed one AND
    // starts the next. The pre-fix behavior only started refreshes on
    // empty-handed calls, so N calls produced ~N/2 inner refreshes — silently
    // halving the documented planEvery cadence and serving every landed plan
    // one interval stale.
    const CALLS = 6;
    let previous = null as Awaited<ReturnType<typeof deferred.plan>> | null;
    for (let i = 0; i < CALLS; i++) {
      previous = await deferred.plan(input, previous?.plan ?? null);
      // let the instant background refresh land before the next call
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(innerCalls).toBeGreaterThanOrEqual(CALLS - 1);
    // And landed plans are actually consumed, not just recomputed.
    expect(previous?.plan.planID).toContain("llm-plan-");
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

  it("decisionToResponse wires an honest empty base for a fallback decision (reason: null)", () => {
    // P0 fix: an LlmAgentBrain fallback decision (the exact `brain.decide()`
    // return value this function's real caller feeds it) now carries
    // `reason: null` — the LLM had no stated reason. The wire must never
    // stringify that to the literal text "null"; it degrades to an honest
    // empty base while `llmPlannerDegraded`/`fallbackUsed` still carry the
    // degradation loudly.
    const response = decisionToResponse("req_null_reason", {
      actionID: "hold:wait",
      reason: null,
      metadata: { llmPlannerDegraded: true, plannerFallbackUsed: true },
    });

    expect(response.reason).toBe("");
    expect(response.reason).not.toContain("null");
    expect(response.llmPlannerDegraded).toBe(true);
    expect(response.fallbackUsed).toBe(true);
  });

  it("keystoneModeFromEnv defaults to the LLM Commander; no deterministic mode exists", () => {
    // Local default: Claude CLI subscription. Hosted --use-bedrock pods:
    // Bedrock. There is deliberately no executor/deterministic mode ("the
    // agent" IS the LLM brain — operator standing rule, permanent).
    expect(keystoneModeFromEnv({})).toBe("claude-cli");
    expect(keystoneModeFromEnv({ USE_BEDROCK: "true" })).toBe("bedrock");
    expect(keystoneModeFromEnv({ PROXYWAR_KEYSTONE_MODE: "bedrock" })).toBe(
      "bedrock",
    );
    expect(() =>
      keystoneModeFromEnv({ PROXYWAR_KEYSTONE_MODE: "executor" }),
    ).toThrow(/no deterministic mode by design/);
    expect(() =>
      keystoneModeFromEnv({ PROXYWAR_KEYSTONE_MODE: "warp-drive" }),
    ).toThrow(/Unknown PROXYWAR_KEYSTONE_MODE/);
  });

  it("bedrock model autodetect: env pin first, unavailable-errors classified", () => {
    // us. inference-profile id first — the hosted account rejects bare ids
    // with "on-demand throughput isn't supported" (verified from the v2
    // qualifier 2026-06-10).
    expect(bedrockModelCandidates({})[0]).toBe(
      "us.anthropic.claude-sonnet-4-6",
    );
    expect(
      bedrockModelCandidates({ PROXYWAR_LLM_MODEL_ID: "my.custom-id" })[0],
    ).toBe("my.custom-id");
    expect(bedrockModelCandidates({}).length).toBeGreaterThanOrEqual(3);

    // Switch-model errors
    expect(
      isModelUnavailableError(
        "404 This model version has reached the end of its life.",
      ),
    ).toBe(true);
    expect(
      isModelUnavailableError("The provided model identifier is invalid"),
    ).toBe(true);
    expect(
      isModelUnavailableError(
        "Invocation with on-demand throughput isn't supported",
      ),
    ).toBe(true);
    // Do-NOT-switch errors (auth/throttle/timeout)
    expect(isModelUnavailableError("403 Forbidden: security token")).toBe(
      false,
    );
    expect(isModelUnavailableError("ThrottlingException: rate exceeded")).toBe(
      false,
    );
    expect(isModelUnavailableError("Request timed out after 12000ms")).toBe(
      false,
    );
  });

  it("decisionToResponse carries degradation flags on the wire", () => {
    const degraded = decisionToResponse("req_2", {
      actionID: "hold:wait",
      reason: "carrying standing directive",
      metadata: { llmPlannerDegraded: true, plannerFallbackUsed: true },
    });
    expect(degraded.llmPlannerDegraded).toBe(true);
    expect(degraded.fallbackUsed).toBe(true);

    const healthy = decisionToResponse("req_3", {
      actionID: "attack:rival",
      reason: "executing directive",
    });
    expect("llmPlannerDegraded" in healthy).toBe(false);
    expect("fallbackUsed" in healthy).toBe(false);
  });

  it("transport fallback is LOUD: degraded flags on the wire + a valid offered id", () => {
    // This is the exact path the socket message handler takes when the brain
    // (or payload reconstruction) throws. A dead/degraded brain must NEVER
    // look healthy on the wire — the v1 bedrock seat played 60+ hosted rounds
    // on a silent fallback because this branch had no loudness channel.
    const request = wireRequest(spawnBrainInput());
    const offeredIDs = (
      (request as { legalActions: Array<{ id: string }> }).legalActions
    ).map((action) => action.id);

    const response = transportFallbackResponse(
      "req_fallback",
      request,
      "brain exploded: ECONNRESET",
    );

    // Honest degradation flags — reverting the fix (omitting these) fails here.
    expect(response.llmPlannerDegraded).toBe(true);
    expect(response.fallbackUsed).toBe(true);
    // Still answers with a VALID offered LegalAction.id (never a stall / empty).
    expect(typeof response.selectedLegalActionId).toBe("string");
    expect(response.selectedLegalActionId).not.toBe("");
    expect(offeredIDs).toContain(response.selectedLegalActionId as string);
    // The inner error text is preserved for incident triage.
    expect(response.reason as string).toContain("brain exploded: ECONNRESET");
    expect(response.type).toBe("decision_response");
    expect(response.requestID).toBe("req_fallback");
  });

  it("transport fallback prefers an offered hold action over legalActions[0]", () => {
    // legalActions[0] is the higher-risk spawn; the lowest-risk no-op (hold)
    // is the safer last resort when the brain is down.
    const request = wireRequest(spawnBrainInput());

    const response = transportFallbackResponse("req_hold", request, "boom");

    expect(response.selectedLegalActionId).toBe("hold:wait");
  });

  it("transport fallback never throws on an empty/missing legalActions payload", () => {
    const response = transportFallbackResponse("req_empty", {}, "no payload");

    // No offered actions -> empty id, but it is still a LOUD degraded response
    // (the loudness channel must survive even the worst-case payload).
    expect(response.selectedLegalActionId).toBe("");
    expect(response.llmPlannerDegraded).toBe(true);
    expect(response.fallbackUsed).toBe(true);
  });
});
