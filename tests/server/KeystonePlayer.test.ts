import { describe, expect, it, vi } from "vitest";

import { KEYSTONE_DIPLOMACY_ADJUDICATOR_MARKER } from "../../coworld-adapter/src/keystone-diplomacy-adjudicator";
import {
  bedrockModelCandidates,
  CommanderTelemetryAgentBrain,
  createKeystoneBrain,
  decisionToResponse,
  DeferredAgentPlanner,
  isModelUnavailableError,
  KEYSTONE_COMMANDER_RETENTION_MARKER,
  KEYSTONE_EXECUTOR_SETTINGS,
  keystoneCommanderRetentionFromEnv,
  keystoneCouncilDiplomacyAdjudicatorFromEnv,
  keystoneCouncilPoliticsGuardFromEnv,
  keystoneCouncilSurvivalShieldFromEnv,
  keystoneDefenseAuthorityFromEnv,
  keystoneExpertCouncilShadowFromEnv,
  keystoneExpertMaskFromEnv,
  keystoneModeFromEnv,
  keystoneSingleActionFromEnv,
  requestToBrainInput,
  transportFallbackResponse,
  type KeystoneModules,
} from "../../coworld-adapter/src/keystone-player";
import {
  KEYSTONE_SHADOW_COUNCIL_METADATA_KEY,
  KeystoneShadowCouncilTelemetryAgentBrain,
} from "../../coworld-adapter/src/keystone-shadow-council";
import { PlayerType, Relation } from "../../src/core/game/Game";
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

function activePoliticsBrainInput(): AgentBrainInput {
  const observation = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: null,
    username: "Keystone Agent",
    profile: "aggressive",
    gameID: "KEYSTONE-GUARD",
    turnNumber: 2_000,
    phaseOverride: "active",
  });
  return {
    observation: {
      ...observation,
      ownState: {
        playerID: "ME",
        clientID: null,
        smallID: 1,
        name: "Keystone",
        type: PlayerType.Nation,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 75_000,
        maxTroops: 100_000,
        troopRatio: 0.75,
        gold: "250000",
        tilesOwned: 80,
        tileShare: 0.3,
        borderTiles: 12,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
        team: null,
      },
      visiblePlayers: [
        {
          playerID: "RIVAL",
          clientID: null,
          smallID: 2,
          name: "Rival",
          type: PlayerType.Human,
          isAlive: true,
          isDisconnected: false,
          hasSpawned: true,
          troops: 40_000,
          maxTroops: 80_000,
          troopRatio: 0.5,
          gold: "100000",
          tilesOwned: 50,
          tileShare: 0.2,
          sharesBorder: true,
          isAllied: false,
          isFriendly: false,
          relation: Relation.Hostile,
          canAttack: true,
          canRequestAlliance: true,
          canDonateGold: true,
          canDonateTroops: true,
          canEmbargo: true,
          hasEmbargoAgainst: false,
          outgoingAttack: false,
          incomingAttack: false,
          hasOutgoingAllianceRequest: false,
          hasIncomingAllianceRequest: false,
          relativeTroopRatio: 1.25,
        },
      ],
      combat: { ...observation.combat, canExpandIntoNeutral: true },
    },
    legalActions: [
      {
        id: "alliance_request:RIVAL",
        kind: "alliance_request",
        label: "Request alliance",
        intent: null,
        risk: { level: "low", score: 0.1 },
        metadata: { recipientID: "RIVAL" },
      },
      {
        id: "expand:neutral:35",
        kind: "attack",
        label: "Expand",
        intent: null,
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: null, expansion: true, troopPercent: 35 },
      },
      {
        id: "hold:wait",
        kind: "hold",
        label: "Hold",
        intent: null,
        risk: { level: "low", score: 0.1 },
      },
    ],
  };
}

function brainInputAt(
  input: AgentBrainInput,
  turnNumber: number,
  phase: AgentBrainInput["observation"]["phase"] = input.observation.phase,
): AgentBrainInput {
  return {
    ...input,
    observation: { ...input.observation, turnNumber, phase },
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

function makeResolvedFallback(planID: string): AgentPlanDecision {
  return {
    ...makePlanDecision(planID),
    plan: {
      ...makePlan(planID),
      degradedOrigin: true,
    },
    reason: `resolved fallback ${planID}`,
    fallbackUsed: true,
    llmPlannerDegraded: true,
    parseOk: false,
    parseFailureReason: "provider returned no output",
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

  it("keeps the exact v16 FrontierPolicyExecutor path when single-action is off", async () => {
    const implicitOff = createKeystoneBrain(modules, {
      mode: "mock",
      profile: "aggressive",
    });
    const explicitOff = createKeystoneBrain(modules, {
      mode: "mock",
      profile: "aggressive",
      singleActionExecutor: false,
    });
    const current = spawnBrainInput();

    expect(await implicitOff.decide(current)).toEqual(
      await explicitOff.decide(spawnBrainInput()),
    );
  });

  it("constructs no shadow wrapper when the council flag is absent or false", () => {
    const implicitOff = createKeystoneBrain(modules, {
      mode: "mock",
      profile: "aggressive",
    });
    const explicitOff = createKeystoneBrain(modules, {
      mode: "mock",
      profile: "aggressive",
      expertCouncilShadow: false,
      councilPoliticsGuard: false,
      councilDiplomacyAdjudicator: false,
      councilSurvivalShield: false,
    });

    expect(implicitOff).not.toBeInstanceOf(
      KeystoneShadowCouncilTelemetryAgentBrain,
    );
    expect(explicitOff).not.toBeInstanceOf(
      KeystoneShadowCouncilTelemetryAgentBrain,
    );
    expect(implicitOff.constructor).toBe(explicitOff.constructor);
  });

  it("keeps frontier executor identity on ordinary DTA decisions", async () => {
    const baseline = createKeystoneBrain(modules, {
      mode: "mock",
      profile: "aggressive",
    });
    const treatment = createKeystoneBrain(modules, {
      mode: "mock",
      profile: "aggressive",
      councilDiplomacyAdjudicator: true,
    });

    const baselineDecision = await baseline.decide(spawnBrainInput());
    const treatmentDecision = await treatment.decide(spawnBrainInput());

    expect(treatmentDecision.actionID).toBe(baselineDecision.actionID);
    expect(treatmentDecision.reason).toBe(baselineDecision.reason);
    expect(treatmentDecision.metadata).toMatchObject({
      executorSource: "frontier-policy-executor",
      actionSelectionSource: baselineDecision.metadata?.actionSelectionSource,
    });
    expect(treatmentDecision.metadata?.executorSource).not.toBe(
      "custom-agent-executor",
    );
  });

  it("constructs the guard wrapper but skips all Council work on non-triggers", async () => {
    const baseline = createKeystoneBrain(modules, {
      mode: "mock",
      profile: "aggressive",
    });
    const guard = createKeystoneBrain(modules, {
      mode: "mock",
      profile: "aggressive",
      councilPoliticsGuard: true,
    });

    expect(guard).toBeInstanceOf(KeystoneShadowCouncilTelemetryAgentBrain);
    const guardDecision = await guard.decide(spawnBrainInput());
    const baselineDecision = await baseline.decide(spawnBrainInput());
    expect(guardDecision.actionID).toBe(baselineDecision.actionID);
    expect(guardDecision.actionIDs).toEqual(baselineDecision.actionIDs);
    expect(guardDecision.reason).toBe(baselineDecision.reason);
    expect(guardDecision.metadata).toMatchObject({
      executorSource: baselineDecision.metadata?.executorSource,
      actionSelectionSource: baselineDecision.metadata?.actionSelectionSource,
      planFollowed: baselineDecision.metadata?.planFollowed,
    });
    expect(guardDecision.metadata).not.toHaveProperty(
      KEYSTONE_SHADOW_COUNCIL_METADATA_KEY,
    );
  });

  it("applies an active trigger through createKeystoneBrain with truthful final metadata and wire marker", async () => {
    const authoritative = Object.freeze({
      actionID: "alliance_request:RIVAL",
      actionIDs: ["alliance_request:RIVAL", "hold:wait"],
      reason: "scripted v16 proactive request",
      planFollowed: false,
      selectedSkill: "stale-diplomacy-skill",
    });
    class ScriptedFrontierPolicyExecutor {
      decide() {
        return authoritative;
      }
    }
    const instrumentedModules = {
      ...modules,
      plannerExecutor: {
        ...plannerExecutorModule,
        FrontierPolicyExecutor: ScriptedFrontierPolicyExecutor,
      },
    } as unknown as KeystoneModules;
    const brain = createKeystoneBrain(instrumentedModules, {
      mode: "mock",
      profile: "aggressive",
      councilPoliticsGuard: true,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const decision = await brain.decide(activePoliticsBrainInput());
      const response = decisionToResponse("req_guard", decision);

      expect(decision).toMatchObject({
        actionID: "expand:neutral:35",
        actionIDs: ["expand:neutral:35"],
        metadata: {
          executorSource: "keystone-council-politics-guard",
          actionSelectionSource: "keystone-council-politics-guard:expansion",
          scheduledActionIDs: "expand:neutral:35",
          planFollowed: expect.any(Boolean),
        },
      });
      expect(decision.metadata).not.toHaveProperty("selectedSkill");
      expect(response).toMatchObject({
        selectedLegalActionId: "expand:neutral:35",
      });
      expect(String(response.reason)).toMatch(
        /^\[keystone-politics-guard:v1 proactive_alliance_request\]/,
      );
    } finally {
      log.mockRestore();
    }
  });

  it("rejects combining the politics guard with the independent single-action treatment", () => {
    expect(() =>
      createKeystoneBrain(modules, {
        mode: "mock",
        profile: "aggressive",
        singleActionExecutor: true,
        councilPoliticsGuard: true,
      }),
    ).toThrow(/cannot be combined with the single-action executor treatment/);
  });

  it("wires accepted request state into the isolated diplomacy adjudicator", async () => {
    const authoritative = Object.freeze({
      actionID: "alliance_request:RIVAL",
      actionIDs: ["alliance_request:RIVAL", "hold:wait"],
      reason: "scripted v16 repeated request",
      planFollowed: false,
    });
    class ScriptedFrontierPolicyExecutor {
      decide() {
        return authoritative;
      }
    }
    const instrumentedModules = {
      ...modules,
      plannerExecutor: {
        ...plannerExecutorModule,
        FrontierPolicyExecutor: ScriptedFrontierPolicyExecutor,
      },
    } as unknown as KeystoneModules;
    const brain = createKeystoneBrain(instrumentedModules, {
      mode: "mock",
      profile: "aggressive",
      councilDiplomacyAdjudicator: true,
    });
    const current = activePoliticsBrainInput();
    const withAcceptedRequest: AgentBrainInput = {
      ...current,
      observation: {
        ...current.observation,
        recentDecisions: [
          {
            sequence: 1,
            actionID: "alliance_request:RIVAL",
            actionKind: "alliance_request",
            reason: "accepted fixture",
            accepted: true,
            targetID: "RIVAL",
          },
        ],
      },
    };

    const decision = await brain.decide(withAcceptedRequest);
    const response = decisionToResponse("req_dta", decision);

    expect(decision).toMatchObject({
      actionID: "expand:neutral:35",
      actionIDs: ["expand:neutral:35"],
      metadata: {
        executorSource: "keystone-diplomacy-adjudicator",
        actionSelectionSource: "keystone-diplomacy-adjudicator:expansion",
      },
    });
    expect(response.selectedLegalActionId).toBe("expand:neutral:35");
    expect(String(response.reason)).toContain(
      `[${KEYSTONE_DIPLOMACY_ADJUDICATOR_MARKER} request_repeat_suppressed]`,
    );
  });

  it("keeps Council treatments mutually exclusive and pins DTA mask 15", () => {
    expect(() =>
      createKeystoneBrain(modules, {
        mode: "mock",
        profile: "aggressive",
        councilPoliticsGuard: true,
        councilDiplomacyAdjudicator: true,
      }),
    ).toThrow(/mutually exclusive treatments/);
    expect(() =>
      createKeystoneBrain(modules, {
        mode: "mock",
        profile: "aggressive",
        councilDiplomacyAdjudicator: true,
        councilSurvivalShield: true,
      }),
    ).toThrow(/mutually exclusive treatments/);
    expect(() =>
      createKeystoneBrain(modules, {
        mode: "mock",
        profile: "aggressive",
        councilDiplomacyAdjudicator: true,
        expertMask: 7,
      }),
    ).toThrow(/requires the reviewed expert mask 15/);
  });

  it("requires and isolates the default-off candidate treatments", () => {
    expect(() =>
      createKeystoneBrain(modules, {
        mode: "mock",
        profile: "aggressive",
        defenseAuthority: true,
      }),
    ).toThrow(/requires the Council survival shield/);
    expect(() =>
      createKeystoneBrain(modules, {
        mode: "mock",
        profile: "aggressive",
        councilSurvivalShield: true,
        defenseAuthority: true,
        commanderRetention: true,
      }),
    ).toThrow(/mutually exclusive treatments/);
    expect(() =>
      createKeystoneBrain(modules, {
        mode: "bedrock",
        profile: "aggressive",
        blocking: true,
        commanderRetention: true,
        provider: { complete: async () => "unused" },
      }),
    ).toThrow(/requires the deferred non-blocking Commander/);
  });

  it("wires the isolated survival shield above an ordinary v16 build", async () => {
    const authoritative = Object.freeze({
      actionID: "build:Factory:10",
      actionIDs: ["build:Factory:10"],
      reason: "scripted stale economy decision",
      planFollowed: true,
    });
    class ScriptedFrontierPolicyExecutor {
      decide() {
        return authoritative;
      }
    }
    const instrumentedModules = {
      ...modules,
      plannerExecutor: {
        ...plannerExecutorModule,
        FrontierPolicyExecutor: ScriptedFrontierPolicyExecutor,
      },
    } as unknown as KeystoneModules;
    const base = activePoliticsBrainInput();
    const rival = {
      ...base.observation.visiblePlayers[0]!,
      incomingAttack: true,
    };
    const current: AgentBrainInput = {
      ...base,
      observation: {
        ...base.observation,
        visiblePlayers: [rival],
        combat: {
          ...base.observation.combat,
          incomingAttackPlayerIDs: [rival.playerID],
          incomingAttacks: [
            {
              attackID: "incoming:RIVAL",
              targetID: rival.playerID,
              targetName: rival.name,
              troops: 42_075,
              retreating: false,
              sourceTile: null,
              borderSize: 10,
            },
          ],
        },
      },
      legalActions: [
        {
          id: "build:Factory:10",
          kind: "build",
          label: "Build Factory",
          intent: null,
          risk: { level: "low", score: 0.1 },
          metadata: { unit: "Factory", role: "economic" },
        },
        {
          id: "build:Defense Post:11",
          kind: "build",
          label: "Build Defense Post",
          intent: null,
          risk: { level: "low", score: 0.1 },
          metadata: {
            unit: "Defense Post",
            role: "defensive",
            nearbyIncomingAttack: true,
            defensiveValue: 0.9,
            hostileBorderDistance: 4,
          },
        },
      ],
    };
    const brain = createKeystoneBrain(instrumentedModules, {
      mode: "mock",
      profile: "aggressive",
      councilSurvivalShield: true,
    });

    const selected = await brain.decide(current);

    expect(selected).toMatchObject({
      actionID: "build:Defense Post:11",
      metadata: {
        executorSource: "keystone-survival-shield",
        actionSelectionSource: "keystone-survival-shield:survival",
      },
    });
  });

  it.each([false, true])(
    "keeps %s single-action authority exact when shadow observation is enabled",
    async (singleActionExecutor) => {
      const baseline = createKeystoneBrain(modules, {
        mode: "mock",
        profile: "aggressive",
        singleActionExecutor,
      });
      const shadow = createKeystoneBrain(modules, {
        mode: "mock",
        profile: "aggressive",
        singleActionExecutor,
        expertCouncilShadow: true,
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const baselineDecision = await baseline.decide(spawnBrainInput());
        const shadowDecision = await shadow.decide(spawnBrainInput());

        expect(shadowDecision.actionID).toBe(baselineDecision.actionID);
        expect(shadowDecision.actionIDs).toEqual(baselineDecision.actionIDs);
        expect(shadowDecision.reason).toBe(baselineDecision.reason);
        expect(shadowDecision.metadata?.executorSource).toBe(
          baselineDecision.metadata?.executorSource,
        );
        expect(shadowDecision.metadata?.actionSelectionSource).toBe(
          baselineDecision.metadata?.actionSelectionSource,
        );
        expect(
          shadowDecision.metadata?.[KEYSTONE_SHADOW_COUNCIL_METADATA_KEY],
        ).toEqual(expect.any(String));
        expect(shadowDecision.metadata?.fallbackUsed).toBe(
          baselineDecision.metadata?.fallbackUsed,
        );
        expect(shadowDecision.metadata?.llmPlannerDegraded).toBe(
          baselineDecision.metadata?.llmPlannerDegraded,
        );
      } finally {
        log.mockRestore();
      }
    },
  );

  it("wires a zero expert mask into shadow telemetry without changing authority", async () => {
    const baseline = createKeystoneBrain(modules, {
      mode: "mock",
      profile: "aggressive",
    });
    const shadow = createKeystoneBrain(modules, {
      mode: "mock",
      profile: "aggressive",
      expertCouncilShadow: true,
      expertMask: 0,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const baselineDecision = await baseline.decide(spawnBrainInput());
      const shadowDecision = await shadow.decide(spawnBrainInput());
      const compact = JSON.parse(
        String(shadowDecision.metadata?.[KEYSTONE_SHADOW_COUNCIL_METADATA_KEY]),
      ) as Record<string, unknown>;

      expect(shadowDecision.actionID).toBe(baselineDecision.actionID);
      expect(shadowDecision.actionIDs).toEqual(baselineDecision.actionIDs);
      expect(shadowDecision.reason).toBe(baselineDecision.reason);
      expect(compact).toMatchObject({ k: 0, p: 16, e: 0, s: 5 });
    } finally {
      log.mockRestore();
    }
  });

  it("arms the Coworld treatment in the same image with exact Keystone settings", async () => {
    const ranker = vi.fn(plannerExecutorModule.rankLegalActionsForExecution);
    const instrumentedModules = {
      ...modules,
      plannerExecutor: {
        ...plannerExecutorModule,
        rankLegalActionsForExecution: ranker,
      },
    } as KeystoneModules;
    const brain = createKeystoneBrain(instrumentedModules, {
      mode: "mock",
      profile: "aggressive",
      singleActionExecutor: true,
    });

    const decision = await brain.decide(spawnBrainInput());

    expect(decision.metadata).toMatchObject({
      executorSource: "coworld-single-action-v1",
      actionSelectionSource: "coworld-single-action-v1:opening",
    });
    expect(ranker).toHaveBeenCalledOnce();
    expect(ranker.mock.calls[0]![0].settings).toEqual(
      KEYSTONE_EXECUTOR_SETTINGS,
    );
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
    expect(deferred.telemetrySnapshot(input)).toMatchObject({
      commanderTelemetryVersion: 1,
      commanderRefreshAttempts: 1,
      commanderRefreshCompletions: 0,
      commanderRefreshInFlight: true,
      commanderLastOutcome: "none",
    });

    // A second executor call while the same refresh is pending must remain
    // in-clock and be measured as coalesced, not as another provider attempt.
    const carried = await deferred.plan(input, first.plan);
    expect(carried.plan).toEqual(first.plan);
    expect(deferred.telemetrySnapshot(input)).toMatchObject({
      commanderRefreshAttempts: 1,
      commanderCoalescedRefreshes: 1,
      commanderRefreshInFlight: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await deferred.plan(input, first.plan);
    expect(second.plan.planID).toBe("llm-plan-1");
    expect(deferred.telemetrySnapshot(input)).toMatchObject({
      commanderRefreshAttempts: 2,
      commanderRefreshCompletions: 1,
      commanderHealthyCompletions: 1,
      commanderPlansDelivered: 1,
      commanderLastOutcome: "healthy",
      commanderActivePlanGeneratedAtTurn: 0,
      commanderActivePlanAgeTurns: 0,
      commanderDeliveredPlanCriticalEpochChanged: false,
    });
  });

  it("classifies resolved Commander invalid-output fallbacks instead of hiding them as healthy", async () => {
    const input = spawnBrainInput();
    let calls = 0;
    const fallbackInner: AgentPlanner = {
      plannerType: "real-llm",
      plan: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({
              ...makePlanDecision("parse-fallback"),
              fallbackUsed: true,
              llmPlannerDegraded: true,
              parseOk: false,
              parseFailureReason: "malformed directive",
              rawPlannerOutput: "{not-json",
            })
          : new Promise<AgentPlanDecision>(() => undefined);
      },
    };
    const deferred = new DeferredAgentPlanner(
      fallbackInner,
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
    );

    const bootstrap = await deferred.plan(input, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await deferred.plan(input, bootstrap.plan);

    expect(deferred.telemetrySnapshot(input)).toMatchObject({
      commanderRefreshCompletions: 1,
      commanderHealthyCompletions: 0,
      commanderFallbackCompletions: 1,
      commanderInvalidOutputCompletions: 1,
      commanderNoOutputFailureCompletions: 0,
      commanderRejectedCompletions: 0,
      commanderLastOutcome: "invalid_output",
    });
  });

  it("keeps resolved no-output failures broad when the provider cause is unknowable", async () => {
    const input = spawnBrainInput();
    let calls = 0;
    const fallbackInner: AgentPlanner = {
      plannerType: "real-llm",
      plan: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({
              ...makePlanDecision("no-output-fallback"),
              fallbackUsed: true,
              llmPlannerDegraded: true,
              parseOk: false,
              parseFailureReason: "provider timed out",
            })
          : new Promise<AgentPlanDecision>(() => undefined);
      },
    };
    const deferred = new DeferredAgentPlanner(
      fallbackInner,
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
    );

    const bootstrap = await deferred.plan(input, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await deferred.plan(input, bootstrap.plan);

    expect(deferred.telemetrySnapshot(input)).toMatchObject({
      commanderRefreshCompletions: 1,
      commanderFallbackCompletions: 1,
      commanderInvalidOutputCompletions: 0,
      commanderNoOutputFailureCompletions: 1,
      commanderLastOutcome: "failure_no_output",
    });
  });

  it("adopts a resolved Commander fallback when retention is off", async () => {
    const input = spawnBrainInput();
    let calls = 0;
    const deferred = new DeferredAgentPlanner(
      {
        plannerType: "real-llm",
        plan: () => {
          calls += 1;
          if (calls === 1) {
            return Promise.resolve(makePlanDecision("healthy"));
          }
          if (calls === 2) {
            return Promise.resolve(makeResolvedFallback("fallback"));
          }
          return new Promise<AgentPlanDecision>(() => undefined);
        },
      },
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
    );

    const bootstrap = await deferred.plan(input, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const healthy = await deferred.plan(input, bootstrap.plan);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fallback = await deferred.plan(input, healthy.plan);

    expect(fallback.plan.planID).toBe("fallback");
    expect(fallback.reason).not.toContain(KEYSTONE_COMMANDER_RETENTION_MARKER);
    expect(deferred.telemetrySnapshot(input)).toMatchObject({
      commanderRetainedFallbacksDelivered: 0,
      commanderLastRetentionOutcome: "none",
    });
  });

  it("retains one healthy same-epoch directive, then accepts the next resolved fallback", async () => {
    const input = spawnBrainInput();
    let calls = 0;
    let resolveSecondFallback!: (decision: AgentPlanDecision) => void;
    const deferred = new DeferredAgentPlanner(
      {
        plannerType: "real-llm",
        plan: () => {
          calls += 1;
          if (calls === 1) {
            const healthy = makePlanDecision("healthy");
            return Promise.resolve({
              ...healthy,
              plan: {
                ...healthy.plan,
                commitment: {
                  targetPlayerId: "RIVAL",
                  minAttackRatio: 0.25,
                },
              },
            });
          }
          if (calls === 2) {
            return Promise.resolve({
              ...makeResolvedFallback("fallback-one"),
              commitmentDroppedOnFallback: true,
            });
          }
          if (calls === 3) {
            return new Promise<AgentPlanDecision>((resolve) => {
              resolveSecondFallback = resolve;
            });
          }
          return new Promise<AgentPlanDecision>(() => undefined);
        },
      },
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
      { retainHealthyDirectiveOnDegradedCompletion: true },
    );

    const bootstrap = await deferred.plan(input, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const healthy = await deferred.plan(input, bootstrap.plan);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const retained = await deferred.plan(input, healthy.plan);

    expect(retained).toMatchObject({
      plan: {
        planID: "healthy",
        objective: healthy.plan.objective,
        targetPlayerId: healthy.plan.targetPlayerId,
        commitment: healthy.plan.commitment,
        degradedOrigin: true,
      },
      fallbackUsed: true,
      llmPlannerDegraded: true,
    });
    expect(retained.reason).toContain(
      `[${KEYSTONE_COMMANDER_RETENTION_MARKER} retained_resolved_fallback]`,
    );
    expect(retained.plan.rationale).toContain(
      KEYSTONE_COMMANDER_RETENTION_MARKER,
    );
    expect(retained.commitmentDroppedOnFallback).toBeUndefined();
    expect(deferred.telemetrySnapshot(input)).toMatchObject({
      commanderRetainedFallbacksDelivered: 1,
      commanderLastRetentionOutcome: "retained_resolved_fallback",
      commanderActivePlanGeneratedAtTurn: 0,
    });

    resolveSecondFallback(makeResolvedFallback("fallback-two"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const boundedFallback = await deferred.plan(input, retained.plan);
    expect(boundedFallback.plan.planID).toBe("fallback-two");
    expect(boundedFallback.reason).not.toContain(
      KEYSTONE_COMMANDER_RETENTION_MARKER,
    );
    expect(deferred.telemetrySnapshot(input)).toMatchObject({
      commanderRetainedFallbacksDelivered: 1,
      commanderLastRetentionOutcome: "bound_exhausted",
    });
  });

  it("a healthy Commander recovery re-arms one bounded retention", async () => {
    const input = spawnBrainInput();
    let calls = 0;
    const decisions = [
      makePlanDecision("healthy-one"),
      makeResolvedFallback("fallback-one"),
      makePlanDecision("healthy-two"),
      makeResolvedFallback("fallback-two"),
    ];
    const deferred = new DeferredAgentPlanner(
      {
        plannerType: "real-llm",
        plan: () => {
          const decision = decisions[calls];
          calls += 1;
          return decision === undefined
            ? new Promise<AgentPlanDecision>(() => undefined)
            : Promise.resolve(decision);
        },
      },
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
      { retainHealthyDirectiveOnDegradedCompletion: true },
    );

    let current = await deferred.plan(input, null);
    for (let index = 0; index < decisions.length; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      current = await deferred.plan(input, current.plan);
    }

    expect(current.plan.planID).toBe("healthy-two");
    expect(current.llmPlannerDegraded).toBe(true);
    expect(current.reason).toContain(KEYSTONE_COMMANDER_RETENTION_MARKER);
    expect(deferred.telemetrySnapshot(input)).toMatchObject({
      commanderHealthyCompletions: 2,
      commanderFallbackCompletions: 2,
      commanderRetainedFallbacksDelivered: 2,
      commanderLastRetentionOutcome: "retained_resolved_fallback",
    });
  });

  it("rejects a pending retention when the critical observation epoch changes", async () => {
    const input = spawnBrainInput();
    let calls = 0;
    const deferred = new DeferredAgentPlanner(
      {
        plannerType: "real-llm",
        plan: () => {
          calls += 1;
          if (calls === 1) {
            return Promise.resolve(makePlanDecision("spawn-healthy"));
          }
          if (calls === 2) {
            return Promise.resolve(makeResolvedFallback("active-fallback"));
          }
          return new Promise<AgentPlanDecision>(() => undefined);
        },
      },
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
      { retainHealthyDirectiveOnDegradedCompletion: true },
    );

    const bootstrap = await deferred.plan(input, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const healthy = await deferred.plan(input, bootstrap.plan);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const activeInput = brainInputAt(input, 100, "active");
    const fallback = await deferred.plan(activeInput, healthy.plan);

    expect(fallback.plan.planID).toBe("active-fallback");
    expect(fallback.reason).not.toContain(KEYSTONE_COMMANDER_RETENTION_MARKER);
    expect(deferred.telemetrySnapshot(activeInput)).toMatchObject({
      commanderRetainedFallbacksDelivered: 0,
      commanderLastRetentionOutcome: "critical_epoch_rejected",
      commanderDeliveredPlanCriticalEpochChanged: true,
    });
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

  it("preserves standing-plan provenance when a Commander refresh rejects", async () => {
    const input = spawnBrainInput();
    let calls = 0;
    const sequencedInner: AgentPlanner = {
      plannerType: "real-llm",
      plan: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(makePlanDecision("healthy-at-turn-zero"));
        }
        if (calls === 2) {
          return Promise.reject(new Error("refresh rejected"));
        }
        return new Promise<AgentPlanDecision>(() => undefined);
      },
    };
    const deferred = new DeferredAgentPlanner(
      sequencedInner,
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
    );

    const bootstrap = await deferred.plan(input, null);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const atTurn100 = brainInputAt(input, 100);
    const healthy = await deferred.plan(atTurn100, bootstrap.plan);
    expect(healthy.plan.planID).toBe("healthy-at-turn-zero");
    expect(deferred.telemetrySnapshot(atTurn100)).toMatchObject({
      commanderActivePlanGeneratedAtTurn: 0,
      commanderActivePlanAgeTurns: 100,
      commanderDeliveredPlanCriticalEpochChanged: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const atTurn200 = brainInputAt(input, 200);
    const degraded = await deferred.plan(atTurn200, healthy.plan);

    expect(degraded.llmPlannerDegraded).toBe(true);
    expect(deferred.telemetrySnapshot(atTurn200)).toMatchObject({
      commanderRefreshAttempts: 3,
      commanderRefreshCompletions: 2,
      commanderHealthyCompletions: 1,
      commanderRejectedCompletions: 1,
      commanderPlansDelivered: 2,
      commanderLastOutcome: "rejected",
      commanderActivePlanGeneratedAtTurn: 0,
      commanderActivePlanAgeTurns: 200,
      commanderDeliveredPlanCriticalEpochChanged: false,
    });
  });

  it("reports when a delivered plan was authored before a critical observation epoch change", async () => {
    const input = spawnBrainInput();
    const deferred = new DeferredAgentPlanner(
      {
        plannerType: "real-llm",
        plan: () => Promise.resolve(makePlanDecision("spawn-era-plan")),
      },
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
    );

    const bootstrap = await deferred.plan(input, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const activeInput = brainInputAt(input, 100, "active");
    await deferred.plan(activeInput, bootstrap.plan);

    expect(deferred.telemetrySnapshot(activeInput)).toMatchObject({
      commanderActivePlanGeneratedAtTurn: 0,
      commanderActivePlanAgeTurns: 100,
      commanderDeliveredPlanCriticalEpochChanged: true,
    });
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
    expect(response).not.toHaveProperty("shadowCouncil");
  });

  it("places allowlisted bounded shadow telemetry on the Coworld wire", () => {
    const compact = JSON.stringify({
      v: 1,
      o: 2,
      g: 1,
      x: 0,
      h: "h",
      p: 127,
      e: 64,
      j: 0,
      w: "0123456789abcdef",
      r: "-",
      d: "fedcba9876543210",
      m: -499,
      a: "d",
      s: 3,
      k: 15,
      u: 450,
    });
    const response = decisionToResponse("req_shadow", {
      actionID: "hold:wait",
      reason: '"\n\\'.repeat(200),
      metadata: {
        [KEYSTONE_SHADOW_COUNCIL_METADATA_KEY]: compact,
      },
    });

    expect(response.shadowCouncil).toBe(compact);
    expect(JSON.stringify(response).length).toBeLessThan(1_000);

    for (const margin of [null, -20_000, 20_000]) {
      const bounded = JSON.stringify({ ...JSON.parse(compact), m: margin });
      expect(
        decisionToResponse(`req_shadow_margin_${String(margin)}`, {
          actionID: "hold:wait",
          reason: "hold",
          metadata: {
            [KEYSTONE_SHADOW_COUNCIL_METADATA_KEY]: bounded,
          },
        }).shadowCouncil,
      ).toBe(bounded);
    }

    const unexpected = decisionToResponse("req_shadow_bad", {
      actionID: "hold:wait",
      reason: "hold",
      metadata: {
        [KEYSTONE_SHADOW_COUNCIL_METADATA_KEY]: JSON.stringify({
          ...JSON.parse(compact),
          secret: "must-not-cross-wire",
        }),
      },
    });
    expect(unexpected).not.toHaveProperty("shadowCouncil");
    expect(JSON.stringify(unexpected)).not.toContain("must-not-cross-wire");

    const oversized = decisionToResponse("req_shadow_large", {
      actionID: "hold:wait",
      reason: "hold",
      metadata: {
        [KEYSTONE_SHADOW_COUNCIL_METADATA_KEY]: "x".repeat(301),
      },
    });
    expect(oversized).not.toHaveProperty("shadowCouncil");

    for (const [key, value] of [
      ["p", 128],
      ["p", 64.5],
      ["e", 128],
      ["e", 64.5],
      ["m", -20_001],
      ["m", 20_001],
      ["m", -499.5],
      ["j", 2_048],
      ["k", 16],
      ["s", 9],
      ["h", "healthy"],
      ["a", "agree"],
    ] as const) {
      const invalid = decisionToResponse(`req_shadow_invalid_${key}`, {
        actionID: "hold:wait",
        reason: "hold",
        metadata: {
          [KEYSTONE_SHADOW_COUNCIL_METADATA_KEY]: JSON.stringify({
            ...JSON.parse(compact),
            [key]: value,
          }),
        },
      });
      expect(invalid).not.toHaveProperty("shadowCouncil");
    }
  });

  it("adds Commander telemetry without changing the delegated decision", async () => {
    const input = spawnBrainInput();
    const deferred = new DeferredAgentPlanner(
      {
        plannerType: "real-llm",
        plan: () => Promise.resolve(makePlanDecision("unused")),
      },
      new plannerExecutorModule.RuleAgentPlanner("aggressive"),
    );
    const delegated = {
      actionID: "spawn:10",
      actionIDs: ["spawn:10", "hold:wait"],
      reason: "scripted behavior identity",
      metadata: { confidence: 0.61 },
    };
    const wrapped = new CommanderTelemetryAgentBrain(
      {
        brainType: "planner-executor",
        decide: () => delegated,
      },
      deferred,
    );

    const decision = await wrapped.decide(input);

    expect(decision.actionID).toBe(delegated.actionID);
    expect(decision.actionIDs).toEqual(delegated.actionIDs);
    expect(decision.reason).toBe(delegated.reason);
    expect(decision.metadata).toMatchObject({
      confidence: 0.61,
      commanderTelemetryVersion: 1,
      commanderRefreshAttempts: 0,
      commanderRefreshCompletions: 0,
    });
  });

  it("places bounded Commander telemetry before a worst-case wire reason", () => {
    const requestID = `req_${"r".repeat(24)}`;
    const actionID = `attack:rival:${"9".repeat(37)}`;
    const shadowCouncil = JSON.stringify({
      v: 1,
      o: Number.MAX_SAFE_INTEGER,
      g: Number.MAX_SAFE_INTEGER,
      x: 1,
      h: "u",
      p: 127,
      e: 127,
      j: 2_047,
      w: "0123456789abcdef",
      r: "fedcba9876543210",
      d: "0011223344556677",
      m: 20_000,
      a: "d",
      s: 6,
      k: 15,
      u: Number.MAX_SAFE_INTEGER,
    });
    const response = decisionToResponse(requestID, {
      actionID,
      actionIDs: [actionID, "hold:wait"],
      // Quotes, newlines, and backslashes all expand under JSON.stringify.
      reason: '"\n\\'.repeat(200),
      metadata: {
        commanderTelemetryVersion: 1,
        commanderRefreshAttempts: Number.MAX_SAFE_INTEGER,
        commanderRefreshCompletions: Number.MAX_SAFE_INTEGER,
        commanderHealthyCompletions: Number.MAX_SAFE_INTEGER,
        commanderFallbackCompletions: Number.MAX_SAFE_INTEGER,
        commanderInvalidOutputCompletions: Number.MAX_SAFE_INTEGER,
        commanderNoOutputFailureCompletions: Number.MAX_SAFE_INTEGER,
        commanderRejectedCompletions: Number.MAX_SAFE_INTEGER,
        commanderCoalescedRefreshes: Number.MAX_SAFE_INTEGER,
        commanderPlansDelivered: Number.MAX_SAFE_INTEGER,
        commanderRefreshInFlight: true,
        commanderLastOutcome: "invalid_output",
        commanderActivePlanGeneratedAtTurn: Number.MAX_SAFE_INTEGER,
        commanderActivePlanAgeTurns: Number.MAX_SAFE_INTEGER,
        commanderDeliveredPlanCriticalEpochChanged: true,
        llmPlannerDegraded: true,
        plannerFallbackUsed: true,
        [KEYSTONE_SHADOW_COUNCIL_METADATA_KEY]: shadowCouncil,
      },
    });
    const serialized = JSON.stringify(response);

    expect(response.selectedLegalActionId).toBe(actionID);
    expect(response.requestID).toBe(requestID);
    expect(response.llmPlannerDegraded).toBe(true);
    expect(response.fallbackUsed).toBe(true);
    expect(response.shadowCouncil).toBe(shadowCouncil);
    expect(response.reason as string).toMatch(
      /\[wire carries primary only; 1 batched follow-up\(s\) not executed\]$/,
    );
    expect(response.commanderTelemetry).toMatchObject({
      v: 1,
      attempts: Number.MAX_SAFE_INTEGER,
      completions: Number.MAX_SAFE_INTEGER,
      lastOutcome: "invalid_output",
      criticalEpochChanged: true,
    });
    expect(serialized.length).toBeLessThan(1_000);
    expect(serialized.indexOf('"commanderTelemetry"')).toBeLessThan(1_000);
    expect(serialized.indexOf('"reason"')).toBeGreaterThan(
      serialized.indexOf('"commanderTelemetry"'),
    );
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

  it("parses the shadow-council flag strictly and defaults it off", () => {
    expect(keystoneExpertCouncilShadowFromEnv({})).toBe(false);
    expect(
      keystoneExpertCouncilShadowFromEnv({
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "0",
      }),
    ).toBe(false);
    expect(
      keystoneExpertCouncilShadowFromEnv({
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: " FALSE ",
      }),
    ).toBe(false);
    expect(
      keystoneExpertCouncilShadowFromEnv({
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "1",
      }),
    ).toBe(true);
    expect(
      keystoneExpertCouncilShadowFromEnv({
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: " true ",
      }),
    ).toBe(true);
    expect(() =>
      keystoneExpertCouncilShadowFromEnv({
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "yes",
      }),
    ).toThrow(/expected 0\|1\|false\|true/);
  });

  it("parses the Council politics guard flag strictly and defaults it off", () => {
    expect(keystoneCouncilPoliticsGuardFromEnv({})).toBe(false);
    expect(
      keystoneCouncilPoliticsGuardFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD: "0",
      }),
    ).toBe(false);
    expect(
      keystoneCouncilPoliticsGuardFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD: " FALSE ",
      }),
    ).toBe(false);
    expect(
      keystoneCouncilPoliticsGuardFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD: "1",
      }),
    ).toBe(true);
    expect(
      keystoneCouncilPoliticsGuardFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD: " true ",
      }),
    ).toBe(true);
    expect(() =>
      keystoneCouncilPoliticsGuardFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD: "yes",
      }),
    ).toThrow(/expected 0\|1\|false\|true/);
  });

  it("parses the diplomacy-adjudicator flag strictly and defaults it off", () => {
    expect(keystoneCouncilDiplomacyAdjudicatorFromEnv({})).toBe(false);
    expect(
      keystoneCouncilDiplomacyAdjudicatorFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR: "0",
      }),
    ).toBe(false);
    expect(
      keystoneCouncilDiplomacyAdjudicatorFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR: " FALSE ",
      }),
    ).toBe(false);
    expect(
      keystoneCouncilDiplomacyAdjudicatorFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR: "1",
      }),
    ).toBe(true);
    expect(
      keystoneCouncilDiplomacyAdjudicatorFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR: " true ",
      }),
    ).toBe(true);
    expect(() =>
      keystoneCouncilDiplomacyAdjudicatorFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR: "yes",
      }),
    ).toThrow(/expected 0\|1\|false\|true/);
  });

  it("parses the survival-shield flag strictly and defaults it off", () => {
    expect(keystoneCouncilSurvivalShieldFromEnv({})).toBe(false);
    expect(
      keystoneCouncilSurvivalShieldFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD: "0",
      }),
    ).toBe(false);
    expect(
      keystoneCouncilSurvivalShieldFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD: " FALSE ",
      }),
    ).toBe(false);
    expect(
      keystoneCouncilSurvivalShieldFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD: "1",
      }),
    ).toBe(true);
    expect(
      keystoneCouncilSurvivalShieldFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD: " true ",
      }),
    ).toBe(true);
    expect(() =>
      keystoneCouncilSurvivalShieldFromEnv({
        PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD: "yes",
      }),
    ).toThrow(/expected 0\|1\|false\|true/);
  });

  it.each([
    [keystoneCommanderRetentionFromEnv, "PROXYWAR_KEYSTONE_COMMANDER_RETENTION"],
    [keystoneDefenseAuthorityFromEnv, "PROXYWAR_KEYSTONE_DEFENSE_AUTHORITY"],
  ] as const)("parses %s strictly and defaults it off", (parse, key) => {
    expect(parse({})).toBe(false);
    expect(parse({ [key]: "0" })).toBe(false);
    expect(parse({ [key]: " FALSE " })).toBe(false);
    expect(parse({ [key]: "1" })).toBe(true);
    expect(parse({ [key]: " true " })).toBe(true);
    expect(() => parse({ [key]: "yes" })).toThrow(
      /expected 0\|1\|false\|true/,
    );
  });

  it("parses the shadow expert mask strictly and defaults to all experts", () => {
    expect(keystoneExpertMaskFromEnv({})).toBe(15);
    expect(
      keystoneExpertMaskFromEnv({ PROXYWAR_KEYSTONE_EXPERT_MASK: "0" }),
    ).toBe(0);
    expect(
      keystoneExpertMaskFromEnv({ PROXYWAR_KEYSTONE_EXPERT_MASK: " 9 " }),
    ).toBe(9);
    expect(
      keystoneExpertMaskFromEnv({ PROXYWAR_KEYSTONE_EXPERT_MASK: "15" }),
    ).toBe(15);
    for (const invalid of ["-1", "16", "01", "1.0", "all", "+1"]) {
      expect(() =>
        keystoneExpertMaskFromEnv({
          PROXYWAR_KEYSTONE_EXPERT_MASK: invalid,
        }),
      ).toThrow(/expected decimal integer 0\.\.15/);
    }
  });

  it("single-action env defaults off and rejects ambiguous treatment values", () => {
    expect(keystoneSingleActionFromEnv({})).toBe(false);
    expect(
      keystoneSingleActionFromEnv({ PROXYWAR_KEYSTONE_SINGLE_ACTION: "0" }),
    ).toBe(false);
    expect(
      keystoneSingleActionFromEnv({ PROXYWAR_KEYSTONE_SINGLE_ACTION: "true" }),
    ).toBe(true);
    expect(() =>
      keystoneSingleActionFromEnv({
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "enabled-ish",
      }),
    ).toThrow(/expected 0\|1\|false\|true/);
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
