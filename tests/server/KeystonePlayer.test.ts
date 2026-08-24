import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  decisionRequestEnvelope,
  normalizeDecisionResponse,
} from "../../coworld-adapter/src/coworld-decision-wire";
import {
  bedrockModelCandidates,
  createKeystoneBrain,
  decisionToResponse,
  DeferredAgentPlanner,
  isModelUnavailableError,
  keystoneModeFromEnv,
  reconstructWireIntent,
  requestToBrainInput,
  spawnPreferenceDecision,
  transportFallbackResponse,
  wireMaxActionsPerDecision,
  wireMaxSpawnPreferences,
  type KeystoneModules,
} from "../../coworld-adapter/src/keystone-player";
import { UnitType } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import type {
  AgentPlanDecision,
  AgentPlanner,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import * as plannerExecutorModule from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrainInput,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import * as claudeCliModule from "../../src/server/agents/ClaudeCliLlmProvider";
import { buildExternalAgentRequestPayload } from "../../src/server/agents/ExternalHttpAgentBrain";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import { buildStrategicOptions } from "../../src/server/agents/StrategicOptionBuilder";
import { stubObservation, stubVisiblePlayer } from "./DealTestHarness";

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

function rankedSpawnBrainInput(): AgentBrainInput {
  return {
    observation: { ...spawnBrainInput().observation, phase: "spawn" },
    legalActions: [
      {
        id: "spawn:10",
        kind: "spawn",
        label: "Spawn at 10",
        intent: { type: "spawn", tile: 10 },
        risk: { level: "medium", score: 0.4 },
        metadata: { tile: 10, safetyScore: 0.5, localLandScore: 0.5 },
      },
      {
        id: "spawn:30",
        kind: "spawn",
        label: "Spawn at 30",
        intent: { type: "spawn", tile: 30 },
        risk: { level: "low", score: 0.2 },
        metadata: { tile: 30, safetyScore: 0.5, localLandScore: 0.9 },
      },
      {
        id: "spawn:20",
        kind: "spawn",
        label: "Spawn at 20",
        intent: { type: "spawn", tile: 20 },
        risk: { level: "medium", score: 0.3 },
        metadata: { tile: 20, safetyScore: 0.5, localLandScore: 0.7 },
      },
    ],
  };
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

  it("preserves all four Commander families across the intent-free Coworld JSON boundary", () => {
    const rival = stubVisiblePlayer(
      {
        agentID: "rival-agent",
        playerID: "RIVAL_A",
        username: "Rival A",
      },
      { troops: 8_000, tilesOwned: 80, sharesBorder: true },
    );
    const observation = stubObservation({
      seat: {
        agentID: "commander-agent",
        playerID: "SELF",
        username: "Commander",
      },
      others: [rival],
      turnNumber: 100,
      gameID: "CMDWIRE1",
    });
    observation.nonCombat.buildOptions = [
      {
        unit: UnitType.City,
        role: "economic",
        targetTile: 101,
        buildTile: 101,
        cost: "100",
        legalReason: "fixture can build a City",
      },
    ];
    observation.nonCombat.upgradeOptions = [
      {
        unitID: 41,
        unit: UnitType.Factory,
        tile: 102,
        level: 1,
        cost: "100",
        legalReason: "fixture can upgrade a Factory",
      },
    ];
    observation.nonCombat.embargoOptions = [
      {
        targetID: rival.playerID,
        targetName: rival.name,
        action: "start",
        legalReason: "fixture can embargo rival",
      },
    ];
    observation.nonCombat.targetOptions = [
      {
        targetID: rival.playerID,
        targetName: rival.name,
        legalReason: "fixture can mark rival",
      },
    ];
    const originalActions = new LegalActionBuilder().build({ observation });
    const originalInput = { observation, legalActions: originalActions };
    const request = wireRequest(originalInput) as {
      legalActions: Array<Record<string, unknown>>;
    };

    expect(request.legalActions).not.toHaveLength(0);
    expect(
      request.legalActions.every((action) => !Object.hasOwn(action, "intent")),
    ).toBe(true);

    const rebuilt = requestToBrainInput(request);
    const options = buildStrategicOptions(rebuilt);
    expect(options.candidates.map((candidate) => candidate.family)).toEqual([
      "expand",
      "develop_economy",
      "pressure_rival",
      "survive",
    ]);

    const offeredIDs = new Set(originalActions.map((action) => action.id));
    for (const candidate of options.candidates) {
      const boundIDs = [
        ...candidate.binding.alignedPrimaryActionIDs,
        ...candidate.binding.alignedSupportActionIDs,
      ];
      expect(boundIDs.length).toBeGreaterThan(0);
      expect(boundIDs.every((id) => offeredIDs.has(id))).toBe(true);
    }
    expect(
      options.candidates.find((candidate) => candidate.family === "expand")
        ?.binding.alignedPrimaryActionIDs,
    ).toContain("expand:terra-nullius:10");
    expect(
      options.candidates.find(
        (candidate) => candidate.family === "develop_economy",
      )?.binding.alignedPrimaryActionIDs,
    ).toEqual(expect.arrayContaining(["build:City:101", "upgrade:Factory:41"]));
    expect(
      options.candidates.find(
        (candidate) => candidate.family === "pressure_rival",
      )?.binding.alignedPrimaryActionIDs,
    ).toContain("attack:RIVAL_A:10");
  });

  it("fails closed on malformed compatibility metadata", () => {
    const malformed: Array<[LegalAction["kind"], LegalAction["metadata"]]> = [
      ["attack", { targetID: null, troops: -1 }],
      ["attack", { targetID: null, troops: 1.5 }],
      ["attack", { targetID: 7, troops: 100 }],
      ["boat", { targetTile: -1, troops: 100 }],
      ["boat", { targetTile: 1.5, troops: 100 }],
      ["boat", { targetTile: 10, troops: -5 }],
      ["build", { unit: UnitType.City, buildTile: 1.5 }],
      ["upgrade_structure", { unit: UnitType.Factory, unitID: -1 }],
      ["embargo", { targetID: "RIVAL_A", action: "stop" }],
      ["target_player", { targetID: 7 }],
      ["retreat", { attackID: "" }],
    ];
    for (const [kind, metadata] of malformed) {
      expect(reconstructWireIntent(kind, metadata)).toBeNull();
    }
    expect(reconstructWireIntent("spawn", { tile: 10 })).toBeNull();
    expect(reconstructWireIntent("hold", undefined)).toBeNull();
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
    expect(decision.metadata?.runtimeMode).toBe("mock-policy-planner");
    expect(decisionToResponse("req_mock", decision).runtimeMode).toBe(
      "mock-policy-planner",
    );
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

  it("DeferredAgentPlanner reports plan-stale when a refresh fails with a standing directive", async () => {
    // A plan exists and the refresh that would have replaced it failed. This is a
    // materially better state than having no plan, and the boolean cannot say so.
    const input = spawnBrainInput();
    const failingInner: AgentPlanner = {
      plannerType: "real-llm",
      plan: () => Promise.reject(new Error("bedrock 500")),
    };
    const deferred = new DeferredAgentPlanner(
      failingInner,
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
    );

    const first = await deferred.plan(input, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await deferred.plan(input, first.plan);

    expect(second.llmPlannerDegraded).toBe(true);
    expect(second.degradedCause).toBe("plan-stale");
    // The cause must also ride ON THE PLAN, not just on this decision. The executor
    // reports an inherited degradation from the standing plan's tag, and those
    // cadence-amplified decisions are the majority of the league's degraded count -
    // a decision-level cause alone would explain only the refresh itself.
    expect(second.plan.degradedOrigin).toBe(true);
    expect(second.plan.degradedOriginCause).toBe("plan-stale");
  });

  it("reports plan-stale on the surfacing path too, not only from the landed refresh", async () => {
    // Two distinct code paths produce `plan-stale`, and a test that only covers the
    // landed-refresh one lets the other be mislabelled - mutation testing showed
    // exactly that. This is the surfacing path: the background refresh AND its
    // bootstrap both failed, so nothing landed and a degradation is pending; the
    // caller then asks again while holding a previous plan, which is what the
    // executor always does. A directive is standing, so the honest label is stale.
    const input = spawnBrainInput();
    const failingInner: AgentPlanner = {
      plannerType: "real-llm",
      plan: () => Promise.reject(new Error("bedrock 500")),
    };
    let bootstrapCalls = 0;
    const flakyBootstrap: AgentPlanner = {
      plannerType: "rule",
      plan: (planInput, previous) => {
        bootstrapCalls += 1;
        return bootstrapCalls <= 2
          ? Promise.reject(new Error("bootstrap unavailable"))
          : new plannerExecutorModule.RuleAgentPlanner("aggressive").plan(
              planInput,
              previous,
            );
      },
    };
    const deferred = new DeferredAgentPlanner(failingInner, flakyBootstrap);

    await deferred.plan(input, null).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const standing = makePlanDecision("standing-directive").plan;
    const surfaced = await deferred.plan(input, standing);

    expect(surfaced.plan.planID).toBe("standing-directive");
    expect(surfaced.llmPlannerDegraded).toBe(true);
    expect(surfaced.degradedCause).toBe("plan-stale");
  });

  it("DeferredAgentPlanner reports plan-unavailable only when no directive is standing", async () => {
    // Reachability is narrower than it looks, and the difference is truthful rather
    // than cosmetic. A degradation surfaces on the NEXT plan() call, and by then a
    // bootstrap plan is usually standing - so `plan-stale` is the honest label. To
    // reach `plan-unavailable` the bootstrap must have failed too, leaving the seat
    // with no intent at all. Call 1 invokes the bootstrap twice (once inside the
    // background catch, once on the main path), so both must fail.
    const input = spawnBrainInput();
    const failingInner: AgentPlanner = {
      plannerType: "real-llm",
      plan: () => Promise.reject(new Error("bedrock 500")),
    };
    let bootstrapCalls = 0;
    const flakyBootstrap: AgentPlanner = {
      plannerType: "rule",
      plan: (planInput, previous) => {
        bootstrapCalls += 1;
        return bootstrapCalls <= 2
          ? Promise.reject(new Error("bootstrap unavailable"))
          : new plannerExecutorModule.RuleAgentPlanner("aggressive").plan(
              planInput,
              previous,
            );
      },
    };
    const deferred = new DeferredAgentPlanner(failingInner, flakyBootstrap);

    // Call 1 cannot produce any plan at all, so nothing is retained.
    await expect(deferred.plan(input, null)).rejects.toThrow(
      "bootstrap unavailable",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const surfaced = await deferred.plan(input, null);

    expect(surfaced.llmPlannerDegraded).toBe(true);
    expect(surfaced.degradedCause).toBe("plan-unavailable");
  });

  it("DeferredAgentPlanner claims no cause while it is merely warming up", async () => {
    // Keystone treats a healthy bootstrap during the first refresh as NOT degraded,
    // unlike tester-starter-llm which reports warmup as degradation. That difference
    // is the open question about whether warmup should count at all, so this pins
    // current behaviour rather than quietly redefining either policy's metric.
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

    const first = await deferred.plan(input, null);
    expect(first.llmPlannerDegraded).toBeUndefined();
    expect(first.degradedCause).toBeUndefined();
    // Not a fallback either: the bootstrap plan is a healthy in-clock answer, and
    // flipping this would silently reclassify every warming seat as degraded in
    // `fallback_count` - the metric-redefinition trap.
    expect(first.fallbackUsed).toBe(false);
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
      metadata: { confidence: 0.85, runtimeMode: "llm-policy-planner" },
    });

    expect(response).toMatchObject({
      type: "decision_response",
      requestID: "req_1",
      selectedLegalActionId: "attack:rival",
      runtimeMode: "llm-policy-planner",
      confidence: 0.85,
    });
    expect((response.reason as string).length).toBe(500);

    const forged = decisionToResponse("req_forged", {
      actionID: "hold",
      reason: "unknown runtime",
      metadata: { runtimeMode: "llm-policy-planner " },
    });
    expect(forged).not.toHaveProperty("runtimeMode");
  });

  it("ranks an all-spawn menu locally and carries the independent preference field", () => {
    const decision = spawnPreferenceDecision(rankedSpawnBrainInput(), 16);
    expect(decision).not.toBeNull();
    expect(decision?.actionID).toBe("spawn:30");
    expect(decision?.spawnPreferenceActionIDs).toEqual([
      "spawn:30",
      "spawn:20",
      "spawn:10",
    ]);
    expect(decision?.actionIDs).toBeUndefined();
    expect(decision?.metadata).toMatchObject({
      externalActionCall: false,
      fallbackUsed: false,
    });

    const response = decisionToResponse("req_spawn", decision!, 5, 16);
    expect(response.selectedLegalActionId).toBe("spawn:30");
    expect(response.spawnPreferenceLegalActionIds).toEqual([
      "spawn:30",
      "spawn:20",
      "spawn:10",
    ]);
    expect(response.selectedLegalActionIds).toBeUndefined();
  });

  it("does not synthesize a spawn ranking without capability or for a mixed menu", () => {
    expect(
      spawnPreferenceDecision(rankedSpawnBrainInput(), undefined),
    ).toBeNull();
    expect(spawnPreferenceDecision(spawnBrainInput(), 16)).toBeNull();
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

  // ---- action batching (capability-negotiated) ----

  it("decisionToResponse emits NO batch and the primary-only note when the wire never advertised one", () => {
    // Behavior pin for older game images: identical to pre-batching keystone.
    const response = decisionToResponse("req_noadv", {
      actionID: "attack:rival",
      actionIDs: ["attack:rival", "build:City:10", "boat:20"],
      reason: "cascade",
      metadata: { confidence: 0.8 },
    });

    expect(response.selectedLegalActionIds).toBeUndefined();
    expect(response.selectedLegalActionId).toBe("attack:rival");
    expect(response.reason).toContain(
      "[wire carries primary only; 2 batched follow-up(s) not executed]",
    );
  });

  it("decisionToResponse emits the executor cascade once the wire advertises a batch", () => {
    const response = decisionToResponse(
      "req_adv",
      {
        actionID: "attack:rival",
        actionIDs: ["attack:rival", "build:City:10", "boat:20"],
        reason: "cascade",
        metadata: { confidence: 0.8 },
      },
      5,
    );

    // Scalar stays the authoritative primary AND leads the batch.
    expect(response.selectedLegalActionId).toBe("attack:rival");
    expect(response.selectedLegalActionIds).toEqual([
      "attack:rival",
      "build:City:10",
      "boat:20",
    ]);
    // Nothing was dropped, so no note is fabricated.
    expect(response.reason).not.toContain("not executed");
  });

  it("decisionToResponse caps at the ADVERTISED width and stays honest about the remainder", () => {
    const response = decisionToResponse(
      "req_narrow",
      {
        actionID: "a",
        actionIDs: ["a", "b", "c", "d"],
        reason: "cascade",
      },
      2,
    );

    expect(response.selectedLegalActionIds).toEqual(["a", "b"]);
    expect(response.reason).toContain(
      "[wire carries 2 action(s); 2 batched follow-up(s) not executed]",
    );
  });

  it("decisionToResponse dedupes the primary out of the cascade", () => {
    const response = decisionToResponse(
      "req_dupe",
      {
        actionID: "a",
        actionIDs: ["a", "a", "b"],
        reason: "cascade",
      },
      5,
    );

    expect(response.selectedLegalActionIds).toEqual(["a", "b"]);
    expect(response.reason).not.toContain("not executed");
  });

  it("decisionToResponse omits the batch key for an ordinary single-action decision", () => {
    const response = decisionToResponse(
      "req_single",
      { actionID: "hold", reason: "waiting" },
      5,
    );

    expect(response.selectedLegalActionIds).toBeUndefined();
    expect(response.reason).not.toContain("not executed");
  });

  it("wireMaxActionsPerDecision reads the envelope advertisement defensively", () => {
    expect(
      wireMaxActionsPerDecision({
        type: "decision_request",
        protocol: { maxActionsPerDecision: 5 },
      }),
    ).toBe(5);
    // Older image: no protocol block at all.
    expect(
      wireMaxActionsPerDecision({ type: "decision_request" }),
    ).toBeUndefined();
    // Hostile/garbled shapes must not throw or fabricate a width.
    expect(wireMaxActionsPerDecision({ protocol: null })).toBeUndefined();
    expect(wireMaxActionsPerDecision({ protocol: "5" })).toBeUndefined();
    expect(
      wireMaxActionsPerDecision({ protocol: { maxActionsPerDecision: "5" } }),
    ).toBeUndefined();
  });

  it("wireMaxSpawnPreferences reads the independent envelope advertisement defensively", () => {
    expect(
      wireMaxSpawnPreferences({
        type: "decision_request",
        protocol: { maxSpawnPreferences: 16 },
      }),
    ).toBe(16);
    expect(
      wireMaxSpawnPreferences({ type: "decision_request" }),
    ).toBeUndefined();
    expect(wireMaxSpawnPreferences({ protocol: null })).toBeUndefined();
    expect(
      wireMaxSpawnPreferences({ protocol: { maxSpawnPreferences: "16" } }),
    ).toBeUndefined();
  });

  it("round-trips: the game's envelope drives the emit, and the game's parser accepts it", () => {
    // Both halves of the protocol in one test — the emitter (this PR) against
    // the game-side envelope builder and reply normalizer (shipped in the
    // batching wire PR). If either side drifts, this fails.
    const envelope = decisionRequestEnvelope({
      requestID: "req_rt",
      slot: 3,
      request: { legalActions: [] },
    });

    const advertised = wireMaxActionsPerDecision(envelope);
    expect(advertised).toBe(5);
    expect(wireMaxSpawnPreferences(envelope)).toBe(16);

    const response = decisionToResponse(
      "req_rt",
      {
        actionID: "attack:rival",
        actionIDs: ["attack:rival", "build:City:10", "boat:20"],
        reason: "cascade",
      },
      advertised,
    );

    const parsed = normalizeDecisionResponse(
      response as Record<string, unknown>,
    );
    expect(parsed.actionID).toBe("attack:rival");
    expect(parsed.actionIDs).toEqual([
      "attack:rival",
      "build:City:10",
      "boat:20",
    ]);
  });

  it("round-trips a spawn ballot through the advertised Coworld wire", () => {
    const envelope = decisionRequestEnvelope({
      requestID: "req_spawn_rt",
      slot: 0,
      request: {},
    });
    const decision = spawnPreferenceDecision(
      rankedSpawnBrainInput(),
      wireMaxSpawnPreferences(envelope),
    );
    expect(decision).not.toBeNull();
    const response = decisionToResponse(
      "req_spawn_rt",
      decision!,
      wireMaxActionsPerDecision(envelope),
      wireMaxSpawnPreferences(envelope),
    );
    const parsed = normalizeDecisionResponse(
      response as Record<string, unknown>,
    );
    expect(parsed.actionID).toBe("spawn:30");
    expect(parsed.spawnPreferenceActionIDs).toEqual([
      "spawn:30",
      "spawn:20",
      "spawn:10",
    ]);
    expect(parsed.actionIDs).toBeUndefined();
  });

  it("round-trips a scalar decision to a byte-identical parse (no batch key either side)", () => {
    const response = decisionToResponse(
      "req_rt_scalar",
      { actionID: "hold", reason: "waiting" },
      wireMaxActionsPerDecision(
        decisionRequestEnvelope({
          requestID: "req_rt_scalar",
          slot: 0,
          request: {},
        }),
      ),
    );
    const parsed = normalizeDecisionResponse(
      response as Record<string, unknown>,
    );
    expect(parsed.actionID).toBe("hold");
    expect(parsed.actionIDs).toBeUndefined();
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
      request as { legalActions: Array<{ id: string }> }
    ).legalActions.map((action) => action.id);

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

describe("keystone deployment shape", () => {
  it("never VALUE-imports from the repo tree, only types", async () => {
    // The deployed layout puts this file at `/app/integration/src` with the ProxyWar
    // repo at `/app/proxywar`, so a runtime `../../src/...` specifier resolves to
    // `/app/src/...` and the player dies on import. Every existing `src/` import
    // here is `import type`, which erases at build time; values are resolved at
    // runtime through `createRequire` and `PROXYWAR_REPO`.
    //
    // This is not hypothetical: the degraded-cause work added exactly such an import
    // and no monorepo test could see it, because in the monorepo the path resolves.
    const source = await fs.readFile(
      path.join("coworld-adapter", "src", "keystone-player.ts"),
      "utf8",
    );
    // `[^;]*` keeps each match inside ONE statement: a lazy `[\s\S]*?` can start at
    // an earlier import and span into the next one, which made the first version of
    // this test report a false failure.
    const repoImports = [
      ...source.matchAll(
        /^import\s+(type\s+)?[^;]*?from\s+"(\.\.\/\.\.\/src\/[^"]+)";/gm,
      ),
    ];
    expect(repoImports.length).toBeGreaterThan(0);
    for (const match of repoImports) {
      expect(
        match[1],
        `value import of ${match[2]} will not resolve in the deployed image`,
      ).toBeDefined();
    }
  });
});

describe("keystone degradation cause", () => {
  it("stamps a truthful self-reported cause on the transport fallback", () => {
    const response = transportFallbackResponse(
      "req_dead",
      { legalActions: [{ id: "hold:1", kind: "hold" }] },
      "socket hung up",
    );
    expect(response).toMatchObject({
      type: "decision_response",
      requestID: "req_dead",
      selectedLegalActionId: "hold:1",
      llmPlannerDegraded: true,
      fallbackUsed: true,
      // NOT a planner diagnosis: the catch behind this path covers request
      // reconstruction, spawn handling and executor exceptions, so the only claim
      // it supports is "our own side threw".
      degradedCause: "policy-error",
    });
  });

  it("forwards a cause through decisionToResponse, which picks fields explicitly", () => {
    // The regression this pins: `decisionToResponse` names every field it emits,
    // so a cause stamped upstream reaches no artifact unless it is named here. The
    // first version of this feature stamped the metadata and shipped nothing.
    const response = decisionToResponse(
      "req_fwd",
      {
        actionID: "hold:1",
        reason: null,
        metadata: {
          fallbackUsed: true,
          plannerFallbackUsed: true,
          llmPlannerDegraded: true,
          degradedCause: "plan-timeout",
        },
      },
      5,
      16,
    );
    expect(response).toMatchObject({
      llmPlannerDegraded: true,
      degradedCause: "plan-timeout",
    });
  });

  it("cannot emit a server-observed cause, even if one is stamped upstream", () => {
    // Keystone is a PLAYER. `brain-timeout` asserts the server never heard from
    // the seat, so a player emitting it would forge provenance.
    const response = decisionToResponse(
      "req_forge",
      {
        actionID: "hold:1",
        reason: null,
        metadata: {
          fallbackUsed: true,
          plannerFallbackUsed: true,
          llmPlannerDegraded: true,
          degradedCause: "brain-timeout",
        },
      },
      5,
      16,
    );
    expect(response).not.toHaveProperty("degradedCause");
    expect(response).toMatchObject({ llmPlannerDegraded: true });
  });

  it("omits the cause on a healthy decision", () => {
    const response = decisionToResponse(
      "req_ok",
      {
        actionID: "attack:1",
        reason: "push north",
        metadata: { degradedCause: "plan-warmup" },
      },
      5,
      16,
    );
    expect(response).not.toHaveProperty("degradedCause");
  });
});
