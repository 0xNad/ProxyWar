import { describe, expect, it } from "vitest";
import { PlayerType, Relation, UnitType } from "../../src/core/game/Game";
import { AgentMemoryBuilder } from "../../src/server/agents/AgentMemoryBuilder";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import {
  FrontierPolicyExecutor,
  LlmAgentPlanner,
  MockLlmPlanner,
  PlannerExecutorAgentBrain,
  RuleAgentExecutor,
  RuleAgentPlanner,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import { buildAgentTacticalAffordances } from "../../src/server/agents/AgentTacticalAffordances";
import {
  AgentObjectiveKind,
  AgentObservation,
  AgentVisiblePlayer,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import { LlmProvider } from "../../src/server/agents/LlmProvider";

describe("Planner/executor agent brain", () => {
  it("creates a spawn plan before spawn", async () => {
    const observation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Planner Agent",
      profile: "aggressive",
      gameID: "PLAN",
      turnNumber: 0,
      phaseOverride: "spawn",
    });
    const legalActions: LegalAction[] = [
      {
        id: "spawn:10",
        kind: "spawn",
        label: "Spawn",
        intent: { type: "spawn", tile: 10 },
        risk: { level: "medium", score: 0.4 },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("aggressive").plan(
      { observation, legalActions },
      null,
    );

    expect(plan.plan).toMatchObject({
      objective: "choose_spawn",
      preferredActionKinds: ["spawn", "hold"],
    });
  });

  it("executor selects a LegalAction.id aligned with the current plan", async () => {
    const observation = activeObservation("secure_economy");
    const legalActions = buildLegalActions();
    const brain = new PlannerExecutorAgentBrain({
      profile: "opportunistic",
      planner: new RuleAgentPlanner("opportunistic"),
      executor: new RuleAgentExecutor("opportunistic"),
      planEveryDecisionSteps: 3,
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(decision.actionID).toBe("build:City:100");
    expect(decision.metadata).toMatchObject({
      brain: "planner-executor",
      runtimeMode: "local-policy-baseline",
      plannerSource: "rule",
      executorSource: "rule-agent-executor",
      actionSelectionSource: "local-policy-executor",
      externalPlannerCall: false,
      externalActionCall: false,
      planObjective: "secure_economy",
      planFollowed: true,
      plannerRan: true,
      plannerRefreshReason: "no_active_plan",
      selectedSkill: "economy_building",
    });
    expect(decision.metadata?.selectedSkillScore).toBeTypeOf("number");
    expect(decision.metadata?.skillSummary).toContain("build:City:100");
  });

  it("lets an external LLM planner choose strategy while the executor selects the legal action", async () => {
    // Give the agent a real territorial base so the base-building control (which forces
    // expand_territory while tile share is below the base floor) does not override the
    // LLM's free strategy choice. This test verifies that free choice flows through; the
    // no-base override is covered by the dedicated base-building test.
    const observation: AgentObservation = {
      ...activeObservation("expand_territory"),
      ownState: {
        playerID: "agent-1",
        clientID: null,
        smallID: 1,
        name: "Planner Agent",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 500_000,
        maxTroops: 800_000,
        troopRatio: 0.6,
        gold: "1000",
        tilesOwned: 2500,
        tileShare: 0.25,
        borderTiles: 100,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
    };
    const legalActions = buildLegalActions();
    const prompts: string[] = [];
    const provider: LlmProvider = {
      providerType: "codex-cli",
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return JSON.stringify({
          objective: "secure_economy",
          turnIntent: "build",
          rationale: "Build economy because safe expansion can wait.",
          maxDecisionCycles: 2,
          preferredActionKinds: ["build", "hold"],
          enabledModules: ["economy", "defense"],
          targetPlayerId: null,
          tacticalSettings: {
            reserveRatio: 0.42,
            triggerRatio: 0.6,
            expansionRatio: 0.12,
            maxConcurrentWars: 1,
            retreatThreshold: 0.38,
            maxActionsPerDecision: 3,
          },
        });
      },
    };
    const brain = new PlannerExecutorAgentBrain({
      profile: "opportunistic",
      planner: new LlmAgentPlanner({
        provider,
        profile: "opportunistic",
        plannerType: "codex-cli",
      }),
      executor: new FrontierPolicyExecutor("opportunistic"),
      planEveryDecisionSteps: 3,
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(legalActions.map((action) => action.id)).toContain(
      decision.actionID,
    );
    expect(decision.actionID).toBe("build:City:100");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Do not select a LegalAction.id");
    expect(prompts[0]).toContain("PLANNER_DECISION_BRIEF");
    expect(prompts[0]).toContain('"version":"frontier-planner-brief-v1"');
    expect(prompts[0]).toContain('"recommendedControls"');
    expect(prompts[0]).toContain('"targetPlayerIdPolicy"');
    expect(prompts[0]).toContain("Use null for growth/economy/fortify plans");
    expect(decision.metadata).toMatchObject({
      brain: "planner-executor",
      runtimeMode: "llm-policy-planner",
      plannerSource: "codex-cli",
      executorSource: "frontier-policy-executor",
      actionSelectionSource: "local-policy-executor",
      externalPlannerCall: true,
      externalActionCall: false,
      rawProviderOutputPresent: true,
      plannerRan: true,
      plannerFallbackUsed: false,
      plannerParseOk: true,
      planObjective: "secure_economy",
      planTurnIntent: "build",
      planEnabledModules: "economy,defense",
      planFollowed: true,
    });
    expect(String(decision.metadata?.plannerRawOutput)).toContain(
      '"objective":"secure_economy"',
    );
    expect(String(decision.metadata?.planTacticalSettings)).toContain(
      '"reserveRatio":0.42',
    );
  });

  it("forces base-building (must_follow expand) over pressure when the agent has no territory", async () => {
    // No ownState -> tile share 0 (no base) and neutral growth is legal -> the
    // base-building control must fire as must_follow expand_territory so the agent
    // claims land instead of attacking comparable rivals (the measured 0%-elimination
    // failure mode was 65% pressure_rival while sitting at ~0% tile share).
    const observation = activeObservation("pressure_rival");
    const legalActions = buildLegalActions();
    const prompts: string[] = [];
    const provider: LlmProvider = {
      providerType: "codex-cli",
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return JSON.stringify({
          objective: "expand_territory",
          turnIntent: "growth",
          rationale: "claim neutral land",
          maxDecisionCycles: 2,
          preferredActionKinds: ["attack", "hold"],
          enabledModules: ["expansion", "economy", "defense"],
          targetPlayerId: null,
          tacticalSettings: {
            reserveRatio: 0.35,
            triggerRatio: 0.55,
            expansionRatio: 0.15,
            maxConcurrentWars: 1,
            retreatThreshold: 0.35,
            maxActionsPerDecision: 3,
          },
        });
      },
    };
    const brain = new PlannerExecutorAgentBrain({
      profile: "aggressive",
      planner: new LlmAgentPlanner({
        provider,
        profile: "aggressive",
        plannerType: "codex-cli",
      }),
      executor: new FrontierPolicyExecutor("aggressive"),
      planEveryDecisionSteps: 3,
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(prompts[0]).toContain("MUST FOLLOW: objective=expand_territory");
    // executor should pick the neutral land grab, not a rival attack
    expect(decision.actionID).toBe("expand:terra-nullius:10");
  });

  it("accumulates a persistent opponent model (theory of mind) across decisions", async () => {
    const base = leaderPressureObservation();
    const sampleVisible = base.visiblePlayers[0]!;
    const rival = (over: Partial<AgentVisiblePlayer>): AgentVisiblePlayer => ({
      ...sampleVisible,
      playerID: "RIVAL02",
      clientID: "RIVAL02",
      name: "Rival",
      type: PlayerType.Nation,
      isAlive: true,
      sharesBorder: true,
      tileShare: 0.14,
      relativeTroopRatio: 1.1,
      incomingAttack: false,
      outgoingAttack: false,
      hasIncomingAllianceRequest: false,
      ...over,
    });
    const tribe: AgentVisiblePlayer = {
      ...sampleVisible,
      playerID: "TRIBE01",
      clientID: "TRIBE01",
      name: "Tribe",
      type: PlayerType.Bot,
      isAlive: true,
      tileShare: 0.02,
    };
    const prompts: string[] = [];
    const provider: LlmProvider = {
      providerType: "codex-cli",
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return JSON.stringify({
          objective: "expand_territory",
          turnIntent: "growth",
          rationale: "grow",
          maxDecisionCycles: 2,
          preferredActionKinds: ["attack", "hold"],
          enabledModules: ["expansion"],
          targetPlayerId: null,
          tacticalSettings: {
            reserveRatio: 0.35,
            triggerRatio: 0.55,
            expansionRatio: 0.15,
            maxConcurrentWars: 1,
            retreatThreshold: 0.35,
            maxActionsPerDecision: 3,
          },
        });
      },
    };
    const brain = new PlannerExecutorAgentBrain({
      profile: "opportunistic",
      planner: new LlmAgentPlanner({
        provider,
        profile: "opportunistic",
        plannerType: "codex-cli",
      }),
      executor: new FrontierPolicyExecutor("opportunistic"),
      planEveryDecisionSteps: 3,
    });
    const legalActions = buildLegalActions();

    // Decision 1: rival is a current ally; a weak tribe is also on the board.
    const obs1: AgentObservation = {
      ...base,
      gameID: "GAME-A",
      visiblePlayers: [
        rival({ isAllied: true, isFriendly: true, relation: Relation.Friendly }),
        tribe,
      ],
    };
    await brain.decide({ observation: obs1, legalActions });
    const model1 = obs1.opponentModel ?? [];
    // Tribes are not political actors -> excluded; the ally is tracked.
    expect(model1.map((entry) => entry.playerID)).toEqual(["RIVAL02"]);
    expect(model1[0]).toMatchObject({ isAllied: true, betrayedMe: false });
    expect(prompts[0]).toContain("OPPONENT_MODEL");
    expect(prompts[0]).toContain("RIVAL02");

    // Decision 2 (same game): the ally turns on me — breaks the alliance and attacks.
    const obs2: AgentObservation = {
      ...base,
      gameID: "GAME-A",
      visiblePlayers: [
        rival({
          isAllied: false,
          isFriendly: false,
          relation: Relation.Hostile,
          incomingAttack: true,
        }),
      ],
      combat: { ...base.combat, incomingAttackPlayerIDs: ["RIVAL02"] },
    };
    await brain.decide({ observation: obs2, legalActions });
    const model2 = obs2.opponentModel ?? [];
    expect(model2[0]).toMatchObject({ playerID: "RIVAL02", betrayedMe: true });
    expect(model2[0]!.attacksOnMe).toBeGreaterThanOrEqual(1);
    expect(model2[0]!.trust).toBeLessThanOrEqual(0.2);

    // A new game resets the ledger: a fresh hostile rival is NOT a betrayer.
    const obs3: AgentObservation = {
      ...base,
      gameID: "GAME-B",
      visiblePlayers: [
        rival({ isAllied: false, isFriendly: false, relation: Relation.Hostile }),
      ],
    };
    await brain.decide({ observation: obs3, legalActions });
    const model3 = obs3.opponentModel ?? [];
    expect(model3[0]).toMatchObject({
      playerID: "RIVAL02",
      betrayedMe: false,
      attacksOnMe: 0,
    });
  });

  it("briefs the external LLM planner to take low-share builds after sustained expansion", async () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      memory: {
        ...base.memory,
        recentExpansionCount: 4,
        repeatedActionKind: "attack",
        repeatedActionCount: 4,
      },
    };
    const legalActions = buildLegalActions();
    const prompts: string[] = [];
    const provider: LlmProvider = {
      providerType: "codex-cli",
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return JSON.stringify({
          objective: "secure_economy",
          turnIntent: "build",
          rationale: "Follow the low-share build gate before attack repeats.",
          maxDecisionCycles: 1,
          preferredActionKinds: ["build", "attack", "hold"],
          enabledModules: ["economy", "defense", "expansion"],
          targetPlayerId: null,
          tacticalSettings: {
            reserveRatio: 0.38,
            triggerRatio: 0.58,
            expansionRatio: 0.12,
            maxConcurrentWars: 1,
            retreatThreshold: 0.35,
            maxActionsPerDecision: 3,
          },
        });
      },
    };
    const brain = new PlannerExecutorAgentBrain({
      profile: "aggressive",
      planner: new LlmAgentPlanner({
        provider,
        profile: "aggressive",
        plannerType: "codex-cli",
      }),
      executor: new FrontierPolicyExecutor("aggressive"),
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(prompts[0]).toContain('"strength":"must_follow"');
    expect(prompts[0]).toContain(
      "low-share hard-nation run has legal economic build",
    );
    expect(decision.actionID).toBe("build:City:100");
    expect(decision.metadata).toMatchObject({
      planObjective: "secure_economy",
      planTurnIntent: "build",
      plannerSource: "codex-cli",
      externalPlannerCall: true,
      externalActionCall: false,
      plannerParseOk: true,
    });
  });

  it("briefs the external LLM planner to switch when frontier conversion is executor-ready", async () => {
    const initial = closeLeaderConversionObservation();
    const base: AgentObservation = {
      ...initial,
      memory: {
        ...initial.memory,
        recentExpansionCount: 4,
        repeatedActionKind: "attack",
        repeatedActionCount: 4,
      },
    };
    const legalActions = closeLeaderConversionLegalActions();
    const observation: AgentObservation = {
      ...base,
      tacticalAffordances: buildAgentTacticalAffordances({
        observation: base,
        legalActions,
      }),
    };
    const prompts: string[] = [];
    const provider: LlmProvider = {
      providerType: "codex-cli",
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return JSON.stringify({
          objective: "pressure_rival",
          turnIntent: "pressure",
          rationale: "Follow executor-ready frontier conversion.",
          maxDecisionCycles: 1,
          preferredActionKinds: ["attack", "target_player", "hold"],
          enabledModules: ["combat", "defense", "economy"],
          targetPlayerId: "CHAD01",
          tacticalSettings: {
            reserveRatio: 0.35,
            triggerRatio: 0.55,
            expansionRatio: 0.15,
            maxConcurrentWars: 1,
            retreatThreshold: 0.35,
            maxActionsPerDecision: 3,
          },
        });
      },
    };
    const brain = new PlannerExecutorAgentBrain({
      profile: "aggressive",
      planner: new LlmAgentPlanner({
        provider,
        profile: "aggressive",
        plannerType: "codex-cli",
      }),
      executor: new FrontierPolicyExecutor("aggressive"),
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(prompts[0]).toContain("MUST FOLLOW: objective=pressure_rival");
    expect(prompts[0]).toContain("targetPlayerId=CHAD01");
    expect(decision.actionID).toBe("attack:CHAD01:25");
    expect(decision.metadata).toMatchObject({
      planObjective: "pressure_rival",
      planTurnIntent: "pressure",
      planTargetPlayerId: "CHAD01",
      plannerSource: "codex-cli",
      externalPlannerCall: true,
      externalActionCall: false,
      plannerParseOk: true,
    });
  });

  it("repairs an external LLM planner response that ignores a must-follow pressure control", async () => {
    const base = closeLeaderConversionObservation();
    const observation: AgentObservation = {
      ...base,
      memory: {
        ...base.memory,
        recentExpansionCount: 4,
        repeatedActionKind: "attack",
        repeatedActionCount: 4,
      },
    };
    const legalActions = closeLeaderConversionLegalActions();
    const prompts: string[] = [];
    const provider: LlmProvider = {
      providerType: "codex-cli",
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return JSON.stringify({
            objective: "expand_territory",
            turnIntent: "growth",
            rationale: "Mistakenly keep growing despite pressure readiness.",
            maxDecisionCycles: 3,
            preferredActionKinds: ["attack", "hold"],
            enabledModules: ["expansion", "economy", "defense"],
            targetPlayerId: null,
            tacticalSettings: {
              reserveRatio: 0.35,
              triggerRatio: 0.55,
              expansionRatio: 0.15,
              maxConcurrentWars: 1,
              retreatThreshold: 0.35,
              maxActionsPerDecision: 4,
            },
          });
        }
        return JSON.stringify({
          objective: "pressure_rival",
          turnIntent: "pressure",
          rationale: "Corrected to follow the must-follow conversion window.",
          maxDecisionCycles: 1,
          preferredActionKinds: ["attack", "target_player", "embargo", "hold"],
          enabledModules: ["combat", "defense", "economy"],
          targetPlayerId: "CHAD01",
          tacticalSettings: {
            reserveRatio: 0.35,
            triggerRatio: 0.55,
            expansionRatio: 0.12,
            maxConcurrentWars: 1,
            retreatThreshold: 0.35,
            maxActionsPerDecision: 3,
          },
        });
      },
    };
    const brain = new PlannerExecutorAgentBrain({
      profile: "aggressive",
      planner: new LlmAgentPlanner({
        provider,
        profile: "aggressive",
        plannerType: "codex-cli",
      }),
      executor: new FrontierPolicyExecutor("aggressive"),
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(
      "FINAL_DECISION_CHECK:\nMUST FOLLOW: objective=pressure_rival",
    );
    expect(prompts[1]).toContain(
      "Your previous planner JSON contradicted a MUST FOLLOW control.",
    );
    expect(decision.actionID).toBe("attack:CHAD01:25");
    expect(decision.metadata).toMatchObject({
      planObjective: "pressure_rival",
      planTurnIntent: "pressure",
      planTargetPlayerId: "CHAD01",
      plannerSource: "codex-cli",
      externalPlannerCall: true,
      externalActionCall: false,
      plannerParseOk: true,
      plannerRepairUsed: true,
    });
    expect(String(decision.metadata?.plannerRawOutput)).toContain(
      "REPAIR_OUTPUT",
    );
  });

  it("does not fail must-follow planner repair when the primary control kind is unavailable", async () => {
    const base = leaderPressureObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 300_000,
              maxTroops: 800_000,
              troopRatio: 0.38,
            },
      combat: {
        ...base.combat,
        ownTroops: 300_000,
        maxTroops: 800_000,
        troopRatio: 0.38,
        incomingAttackPlayerIDs: ["LEADER01"],
        incomingAttacks: [
          {
            attackID: "incoming-leader",
            targetID: "LEADER01",
            targetName: "Leader",
            troops: 720_000,
            retreating: false,
            sourceTile: null,
            borderSize: 20,
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:LEADER01:25",
        kind: "attack",
        label: "Attack Leader with 25%",
        intent: { type: "attack", targetID: "LEADER01", troops: 75_000 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          troopPercentage: 0.25,
          relativeTroopRatio: 0.42,
          targetTileShare: 0.42,
        },
      },
      {
        id: "build:DefensePost:20",
        kind: "build",
        label: "Build Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 20 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "defensive",
          unit: UnitType.DefensePost,
          defensiveValue: 0.8,
          frontierValue: 0.9,
        },
      },
      hold(),
    ];
    const prompts: string[] = [];
    const provider: LlmProvider = {
      providerType: "codex-cli",
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return JSON.stringify({
            objective: "expand_territory",
            turnIntent: "growth",
            rationale: "Mistakenly keep growing despite home danger.",
            maxDecisionCycles: 3,
            preferredActionKinds: ["attack", "hold"],
            enabledModules: ["expansion", "economy", "defense"],
            targetPlayerId: null,
            tacticalSettings: {
              reserveRatio: 0.35,
              triggerRatio: 0.55,
              expansionRatio: 0.15,
              maxConcurrentWars: 1,
              retreatThreshold: 0.35,
              maxActionsPerDecision: 4,
            },
          });
        }
        const marker = "MUST_FOLLOW_CONTROL:\n";
        const start = prompt.indexOf(marker);
        const end = prompt.indexOf("\nVIOLATION:", start);
        const controls = JSON.parse(
          prompt.slice(start + marker.length, end),
        ) as {
          objective: AgentObjectiveKind;
          turnIntent: string;
          targetPlayerId: string | null;
          preferredActionKinds: string[];
          enabledModules: string[];
          maxDecisionCycles: number;
          reason: string;
        };
        return JSON.stringify({
          objective: controls.objective,
          turnIntent: controls.turnIntent,
          rationale: `Following must-follow planner control: ${controls.reason}.`,
          maxDecisionCycles: controls.maxDecisionCycles,
          preferredActionKinds: controls.preferredActionKinds,
          enabledModules: controls.enabledModules,
          targetPlayerId: controls.targetPlayerId,
          tacticalSettings: {
            reserveRatio: 0.45,
            triggerRatio: 0.55,
            expansionRatio: 0.12,
            maxConcurrentWars: 1,
            retreatThreshold: 0.45,
            maxActionsPerDecision: 3,
          },
        });
      },
    };
    const brain = new PlannerExecutorAgentBrain({
      profile: "aggressive",
      planner: new LlmAgentPlanner({
        provider,
        profile: "aggressive",
        plannerType: "codex-cli",
      }),
      executor: new FrontierPolicyExecutor("aggressive"),
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("MUST FOLLOW: objective=survive");
    expect(prompts[1]).toContain(
      '"preferredActionKinds":["retreat","build","attack","hold"]',
    );
    expect(decision.actionID).toBe("build:DefensePost:20");
    expect(decision.metadata).toMatchObject({
      planObjective: "survive",
      plannerSource: "codex-cli",
      externalPlannerCall: true,
      externalActionCall: false,
      plannerFallbackUsed: false,
      plannerParseOk: true,
      plannerRepairUsed: true,
    });
  });

  it("respects an external LLM planner null or blank target for growth plans", async () => {
    const observation = earlyExpansionObservation();
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand neutral land",
        intent: { type: "attack", targetID: null, troops: 40_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Probe Rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 40_000 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          relativeTroopRatio: 1.1,
          troopPercentage: 0.1,
        },
      },
      hold(),
    ];
    const provider: LlmProvider = {
      providerType: "codex-cli",
      async complete(): Promise<string> {
        return JSON.stringify({
          objective: "expand_territory",
          turnIntent: "growth",
          rationale: "Keep neutral growth and avoid focusing a rival yet.",
          maxDecisionCycles: 2,
          preferredActionKinds: ["attack", "hold"],
          enabledModules: ["expansion", "economy", "defense"],
          targetPlayerId: "",
          tacticalSettings: {
            reserveRatio: 0.35,
            triggerRatio: 0.55,
            expansionRatio: 0.15,
            maxConcurrentWars: 1,
            retreatThreshold: 0.35,
            maxActionsPerDecision: 3,
          },
        });
      },
    };
    const brain = new PlannerExecutorAgentBrain({
      profile: "aggressive",
      planner: new LlmAgentPlanner({
        provider,
        profile: "aggressive",
        plannerType: "codex-cli",
      }),
      executor: new FrontierPolicyExecutor("aggressive"),
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.metadata?.planTargetPlayerId).toBeUndefined();
    expect(decision.metadata?.activePolicyTargetPlayerId).toBeUndefined();
    expect(decision.metadata).toMatchObject({
      plannerSource: "codex-cli",
      externalPlannerCall: true,
      externalActionCall: false,
      plannerParseOk: true,
    });
  });

  it("keeps defensive structure module available when pressure plans include builds", async () => {
    const observation = activeObservation("pressure_rival");
    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions: buildLegalActions() },
      null,
    );

    expect(plan.plan.objective).toBe("pressure_rival");
    expect(plan.plan.enabledModules).toContain("defense");
    expect(plan.plan.enabledModules).toContain("economy");
  });

  it("preserves an active pressure target across planner refreshes", async () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      strategic: {
        ...base.strategic,
        priority: "attack",
      },
      memory: {
        ...base.memory,
        recentExpansionCount: 2,
      },
    };
    const previousPlan: StrategicPlan = {
      planID: "agent-1:pressure:old",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL02",
      rationale: "finish the current rival before rotating",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["finish current target"],
      failureCriteria: ["target disappears"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:25",
        kind: "attack",
        label: "Attack Rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 100_000 },
        risk: { level: "medium", score: 0.4 },
        metadata: { targetID: "RIVAL02", relativeTroopRatio: 1.2 },
      },
      {
        id: "attack:RIVAL03:25",
        kind: "attack",
        label: "Attack New Rival",
        intent: { type: "attack", targetID: "RIVAL03", troops: 100_000 },
        risk: { level: "medium", score: 0.4 },
        metadata: { targetID: "RIVAL03", relativeTroopRatio: 1.5 },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("aggressive").plan(
      { observation, legalActions },
      previousPlan,
    );

    expect(plan.plan.objective).toBe("pressure_rival");
    expect(plan.plan.targetPlayerId).toBe("RIVAL02");
  });

  it("switches pressure focus when a different visible rival becomes runaway leader", async () => {
    const base = earlyExpansionObservation();
    const leader: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      playerID: "RIVAL03",
      clientID: "RIVAL03",
      name: "Runaway Rival",
      tileShare: 0.42,
      relativeTroopRatio: 1.4,
      canAttack: true,
    };
    const observation: AgentObservation = {
      ...base,
      visiblePlayers: [...base.visiblePlayers, leader],
      strategic: {
        ...base.strategic,
        priority: "attack",
      },
      memory: {
        ...base.memory,
        recentExpansionCount: 2,
      },
      endgame: {
        ...base.endgame!,
        leaderID: "RIVAL03",
        leaderName: "Runaway Rival",
        leaderTileShare: 0.42,
      },
    };
    const previousPlan: StrategicPlan = {
      planID: "agent-1:pressure:old",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL02",
      rationale: "old focus",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["finish current target"],
      failureCriteria: ["target disappears"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:25",
        kind: "attack",
        label: "Attack old rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 100_000 },
        risk: { level: "medium", score: 0.4 },
        metadata: { targetID: "RIVAL02", relativeTroopRatio: 1.2 },
      },
      {
        id: "attack:RIVAL03:25",
        kind: "attack",
        label: "Attack runaway rival",
        intent: { type: "attack", targetID: "RIVAL03", troops: 100_000 },
        risk: { level: "medium", score: 0.4 },
        metadata: { targetID: "RIVAL03", relativeTroopRatio: 1.4 },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("aggressive").plan(
      { observation, legalActions },
      previousPlan,
    );

    expect(plan.plan.objective).toBe("pressure_rival");
    expect(plan.plan.targetPlayerId).toBe("RIVAL03");
  });

  it("does not preserve a pressure target that only has symbolic actions", async () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      strategic: {
        ...base.strategic,
        priority: "attack",
      },
      memory: {
        ...base.memory,
        recentExpansionCount: 2,
      },
    };
    const previousPlan: StrategicPlan = {
      planID: "agent-1:pressure:old",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL02",
      rationale: "old symbolic focus",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["finish current target"],
      failureCriteria: ["target disappears"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };
    const legalActions: LegalAction[] = [
      {
        id: "target:RIVAL02",
        kind: "target_player",
        label: "Mark old rival",
        intent: { type: "targetPlayer", target: "RIVAL02" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL02" },
      },
      {
        id: "attack:RIVAL03:25",
        kind: "attack",
        label: "Attack active border",
        intent: { type: "attack", targetID: "RIVAL03", troops: 100_000 },
        risk: { level: "medium", score: 0.4 },
        metadata: { targetID: "RIVAL03", relativeTroopRatio: 1.4 },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("aggressive").plan(
      { observation, legalActions },
      previousPlan,
    );

    expect(plan.plan.objective).toBe("pressure_rival");
    expect(plan.plan.targetPlayerId).toBe("RIVAL03");
  });

  it("overrides stale expansion objectives in a one-on-one map-control duel", async () => {
    const observation = duelModeExpansionObservation();
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand",
        intent: { type: "attack", targetID: null, troops: 100 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      {
        id: "attack:RIVAL001:25",
        kind: "attack",
        label: "Attack Rival with 25%",
        intent: { type: "attack", targetID: "RIVAL001", troops: 250_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "RIVAL001",
          targetName: "Rival",
          troopPercentage: 0.25,
          relativeTroopRatio: 1.4,
        },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions },
      null,
    );

    expect(plan.plan.objective).toBe("pressure_rival");
  });

  it("refreshes the plan when repeated low-value actions are detected", async () => {
    const observation = activeObservation("expand_territory");
    const legalActions = buildLegalActions();
    const brain = new PlannerExecutorAgentBrain({
      profile: "aggressive",
      planner: new MockLlmPlanner("aggressive"),
      planEveryDecisionSteps: 10,
    });

    const first = await brain.decide({ observation, legalActions });
    const repeatedObservation = {
      ...observation,
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "expand:terra-nullius:10",
            actionKind: "attack",
            accepted: true,
            reason: "expanded",
            expansion: true,
          },
          {
            sequence: 2,
            actionID: "expand:terra-nullius:10",
            actionKind: "attack",
            accepted: true,
            reason: "expanded again",
            expansion: true,
          },
          {
            sequence: 3,
            actionID: "expand:terra-nullius:10",
            actionKind: "attack",
            accepted: true,
            reason: "expanded a third time",
            expansion: true,
          },
        ],
      }),
    };
    const second = await brain.decide({
      observation: repeatedObservation,
      legalActions,
    });

    expect(first.metadata?.plannerRan).toBe(true);
    expect(second.metadata?.plannerRan).toBe(true);
    expect(second.metadata?.runtimeMode).toBe("mock-policy-planner");
    expect(second.metadata?.plannerRefreshReason).toBe(
      "repeated_action_memory",
    );
    expect(second.metadata?.planTurnIntent).toBe("build");
    expect(second.metadata?.externalPlannerCall).toBe(false);
    expect(second.actionID).toBe("build:City:100");
    expect(second.metadata?.selectedModules).toContain(
      "economic_structure:economy",
    );
  });

  it("keeps direct neutral land ahead of naval diversification", () => {
    const base = leaderPressureObservation();
    const observation: AgentObservation = {
      ...base,
      visiblePlayers: [],
      combat: {
        ...base.combat,
        borderedPlayerIDs: [],
        attackablePlayerIDs: [],
        weakestAttackableTargetID: null,
        strongestAttackableTargetID: null,
        canExpandIntoNeutral: true,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: null,
        leaderName: null,
        leaderTileShare: 0,
        ownTileShare: base.ownState?.tileShare ?? 0,
        turnsToTimer: 4_000,
      },
      memory: {
        ...base.memory,
        recentExpansionCount: 5,
        repeatedActionKind: "attack",
        repeatedActionCount: 5,
      },
      strategic: {
        ...base.strategic,
        priority: "expand",
        urgency: "medium",
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand into neutral land",
        intent: { type: "attack", targetID: null, troops: 90_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      {
        id: "boat:555:8",
        kind: "boat",
        label: "Send 8% transport",
        intent: { type: "boat", troops: 72_000, dst: 555 },
        risk: { level: "low", score: 0.08 },
        metadata: {
          targetTile: 555,
          targetID: null,
          targetName: "Safe Shore",
          troops: 72_000,
          troopPercentage: 0.08,
          troopPercent: 8,
          expansion: true,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:naval-intent",
      objective: "expand_territory",
      turnIntent: "naval",
      targetPlayerId: null,
      rationale:
        "break the repeated land expansion loop with safe naval growth",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["launch safe naval growth"],
      failureCriteria: ["repeat the same land attack"],
      preferredActionKinds: ["boat", "attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "naval"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic", {
      settings: { territoryFirstNeutralLandEnabled: true },
    }).decide({ observation, legalActions }, plan);

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
  });

  it("uses safe near-cap troop banking even when the plan did not prefer boats", () => {
    const base = leaderPressureObservation();
    const rival: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "RIVAL02",
      clientID: "RIVAL02",
      name: "Rival",
      troops: 280_000,
      tilesOwned: 14_000,
      tileShare: 0.14,
      relativeTroopRatio: 1.2,
      canAttack: true,
      sharesBorder: true,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 760_000,
              maxTroops: 800_000,
              troopRatio: 0.95,
              tilesOwned: 20_000,
              tileShare: 0.2,
            },
      visiblePlayers: [rival],
      combat: {
        ...base.combat,
        ownTroops: 760_000,
        maxTroops: 800_000,
        troopRatio: 0.95,
        attackablePlayerIDs: ["RIVAL02"],
        borderedPlayerIDs: ["RIVAL02"],
        canExpandIntoNeutral: true,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand into neutral land",
        intent: { type: "attack", targetID: null, troops: 152_000 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          targetID: null,
          targetName: "Terra Nullius",
          troops: 152_000,
          troopPercentage: 0.2,
          troopPercent: 20,
          expansion: true,
        },
      },
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Probe Rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 76_000 },
        risk: { level: "medium", score: 0.2 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          troopPercentage: 0.1,
          relativeTroopRatio: 1.2,
          targetTileShare: 0.14,
          targetTiles: 14_000,
        },
      },
      {
        id: "boat:555:25",
        kind: "boat",
        label: "Bank 25% into transport",
        intent: { type: "boat", troops: 190_000, dst: 555 },
        risk: { level: "low", score: 0.05 },
        metadata: {
          targetTile: 555,
          targetID: null,
          targetName: "Neutral Shore",
          troops: 190_000,
          troopPercentage: 0.25,
          troopPercent: 25,
          expansion: true,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:banking",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "RIVAL02",
      rationale: "pressure plan should still bank capped troops",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["bank troops"],
      failureCriteria: ["waste capped growth"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:555:25");
  });

  it("does not troop-bank into boats while home danger is high", () => {
    const base = leaderPressureObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 760_000,
              maxTroops: 800_000,
              troopRatio: 0.95,
              tilesOwned: 40_000,
              tileShare: 0.4,
            },
      combat: {
        ...base.combat,
        ownTroops: 760_000,
        maxTroops: 800_000,
        troopRatio: 0.95,
        incomingAttackPlayerIDs: ["RIVAL02"],
        incomingAttacks: [
          {
            attackID: "incoming-1",
            targetID: "RIVAL02",
            targetName: "Rival",
            troops: 720_000,
            retreating: false,
            sourceTile: null,
            borderSize: 20,
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Counter Rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 76_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          troopPercentage: 0.1,
          relativeTroopRatio: 1.2,
          targetTileShare: 0.14,
          targetTiles: 14_000,
        },
      },
      {
        id: "boat:555:25",
        kind: "boat",
        label: "Bank 25% into transport",
        intent: { type: "boat", troops: 190_000, dst: 555 },
        risk: { level: "low", score: 0.05 },
        metadata: {
          targetTile: 555,
          targetID: null,
          targetName: "Neutral Shore",
          troops: 190_000,
          troopPercentage: 0.25,
          troopPercent: 25,
          expansion: true,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:danger-banking",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "RIVAL02",
      rationale: "danger should block banking",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["survive"],
      failureCriteria: ["launch into collapse"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "emergency_survival"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.reason).not.toContain(
      "transport troop-banking converts capped population into future force",
    );
  });

  it("lets explicit pressure turn intent take a favorable small probe through reserve blockers", () => {
    const base = leaderPressureObservation();
    const rival: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "RIVAL02",
      clientID: "RIVAL02",
      name: "Rival",
      troops: 140_000,
      maxTroops: 600_000,
      troopRatio: 0.23,
      tilesOwned: 11_000,
      tileShare: 0.11,
      relativeTroopRatio: 2.25,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 315_000,
              maxTroops: 900_000,
              troopRatio: 0.35,
              tilesOwned: 13_000,
              tileShare: 0.13,
            },
      visiblePlayers: [rival],
      combat: {
        ...base.combat,
        ownTroops: 315_000,
        maxTroops: 900_000,
        troopRatio: 0.35,
        borderedPlayerIDs: ["RIVAL02"],
        attackablePlayerIDs: ["RIVAL02"],
        weakestAttackableTargetID: "RIVAL02",
        strongestAttackableTargetID: "RIVAL02",
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttacks: [],
      },
      memory: {
        ...base.memory,
        recentExpansionCount: 3,
        repeatedActionKind: "attack",
        repeatedActionCount: 3,
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Probe Rival with 10%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 31_500 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          targetTroops: 140_000,
          targetTiles: 11_000,
          targetTileShare: 0.11,
          troopPercentage: 0.1,
          relativeTroopRatio: 2.25,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure-intent",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "RIVAL02",
      rationale: "stop holding and use a small favorable probe",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["probe the pressure target"],
      failureCriteria: ["feed a stronger rival"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "expansion"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:RIVAL02:10");
    expect(decision.selectedModules).toContain("combat_attack:combat");
  });

  it("escalates repeated pressure probes into a clean medium attack", () => {
    const base = leaderPressureObservation();
    const rival: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "RIVAL02",
      clientID: "RIVAL02",
      name: "Rival",
      troops: 150_000,
      maxTroops: 600_000,
      troopRatio: 0.25,
      tilesOwned: 10_000,
      tileShare: 0.1,
      relativeTroopRatio: 2.2,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 330_000,
              maxTroops: 900_000,
              troopRatio: 0.37,
              tilesOwned: 14_000,
              tileShare: 0.14,
            },
      visiblePlayers: [rival],
      combat: {
        ...base.combat,
        ownTroops: 330_000,
        maxTroops: 900_000,
        troopRatio: 0.37,
        borderedPlayerIDs: ["RIVAL02"],
        attackablePlayerIDs: ["RIVAL02"],
        weakestAttackableTargetID: "RIVAL02",
        strongestAttackableTargetID: "RIVAL02",
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: ["RIVAL02"],
        outgoingAttacks: [],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          ...Array.from({ length: 4 }, (_, index) => ({
            sequence: index + 1,
            actionID: "attack:RIVAL02:10",
            actionKind: "attack" as const,
            accepted: true,
            expansion: false,
            targetID: "RIVAL02",
            targetName: "Rival",
            reason: "pressure probe",
          })),
        ],
      }),
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Probe Rival with 10%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 33_000 },
        risk: { level: "medium", score: 0.2 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          targetTroops: 150_000,
          targetTiles: 10_000,
          targetTileShare: 0.1,
          troopPercentage: 0.1,
          relativeTroopRatio: 2.2,
        },
      },
      {
        id: "attack:RIVAL02:25",
        kind: "attack",
        label: "Attack Rival with 25%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 82_500 },
        risk: { level: "medium", score: 0.32 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          targetTroops: 150_000,
          targetTiles: 10_000,
          targetTileShare: 0.1,
          troopPercentage: 0.25,
          relativeTroopRatio: 2.2,
        },
      },
      {
        id: "attack:RIVAL02:40",
        kind: "attack",
        label: "Attack Rival with 40%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 132_000 },
        risk: { level: "medium", score: 0.45 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          targetTroops: 150_000,
          targetTiles: 10_000,
          targetTileShare: 0.1,
          troopPercentage: 0.4,
          relativeTroopRatio: 2.2,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure-escalate",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "RIVAL02",
      rationale: "repeated probes should become real pressure",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["escalate pressure"],
      failureCriteria: ["keep probing forever"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "expansion"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:RIVAL02:25");
  });

  it("recognizes a close leader conversion window with a large troop edge", () => {
    const observation = closeLeaderConversionObservation();
    const legalActions = closeLeaderConversionLegalActions();

    const affordance = buildAgentTacticalAffordances({
      observation,
      legalActions,
    }).frontierConversionTiming;

    expect(affordance).toMatchObject({
      recommended: true,
      executorReady: true,
      bestExecutorReadyTargetID: "CHAD01",
      bestExecutorReadyAttackTroopPercent: 10,
    });
  });

  it("lets executor-ready conversion outrank more neutral expansion", () => {
    const observation = closeLeaderConversionObservation();
    const legalActions = closeLeaderConversionLegalActions();
    const plan: StrategicPlan = {
      planID: "agent-1:conversion-handoff",
      objective: "expand_territory",
      turnIntent: "growth",
      targetPlayerId: null,
      rationale: "conversion window should interrupt stale neutral growth",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["convert weak rival"],
      failureCriteria: ["keep farming neutral land"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:CHAD01:10");
  });

  it("uses a reserve-safe conversion probe instead of holding under medium defensive pressure", () => {
    const base = closeLeaderConversionObservation();
    const observation: AgentObservation = {
      ...base,
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      combat: {
        ...base.combat,
        incomingAttackPlayerIDs: ["CHAD01"],
        incomingAttacks: [
          {
            attackID: "incoming-chad",
            targetID: "CHAD01",
            targetName: "Chad",
            troops: 125_000,
            retreating: false,
            sourceTile: null,
            borderSize: 18,
          },
        ],
      },
    };
    const plan: StrategicPlan = {
      planID: "agent-1:survive:conversion-probe",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "CHAD01",
      rationale: "hold unless a reserve-safe conversion probe is available",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["preserve core"],
      failureCriteria: ["feed a rival"],
      preferredActionKinds: ["retreat", "build", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "defense", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions: closeLeaderConversionLegalActions() },
      plan,
    );

    expect(decision.actionID).toBe("attack:CHAD01:10");
  });

  it("uses a calibrated conversion probe under medium pressure even when neutral land remains", () => {
    const base = leaderPressureObservation();
    const canada: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "CAN001",
      clientID: "CAN001",
      name: "Canada",
      troops: 279_000,
      maxTroops: 740_000,
      troopRatio: 0.38,
      tilesOwned: 10_100,
      tileShare: 0.1,
      relativeTroopRatio: 1.55,
      canAttack: true,
      sharesBorder: true,
      incomingAttack: false,
      outgoingAttack: false,
    };
    const saudi: AgentVisiblePlayer = {
      ...base.visiblePlayers[1]!,
      playerID: "SAU001",
      clientID: "SAU001",
      name: "Saudi Arabia",
      troops: 520_000,
      maxTroops: 800_000,
      troopRatio: 0.65,
      tilesOwned: 32_000,
      tileShare: 0.32,
      relativeTroopRatio: 0.83,
      canAttack: true,
      sharesBorder: true,
      incomingAttack: true,
      outgoingAttack: false,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_601,
      tick: 1_601,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 432_966,
              maxTroops: 569_692,
              troopRatio: 0.76,
              tilesOwned: 8_948,
              tileShare: 0.09,
            },
      visiblePlayers: [canada, saudi],
      combat: {
        ...base.combat,
        ownTroops: 432_966,
        maxTroops: 569_692,
        troopRatio: 0.76,
        borderedPlayerIDs: ["CAN001", "SAU001"],
        attackablePlayerIDs: ["CAN001", "SAU001"],
        weakestAttackableTargetID: "CAN001",
        strongestAttackableTargetID: "SAU001",
        canExpandIntoNeutral: true,
        incomingAttackPlayerIDs: ["SAU001"],
        incomingAttacks: [
          {
            attackID: "saudi-medium-pressure",
            targetID: "SAU001",
            targetName: "Saudi Arabia",
            troops: 120_000,
            retreating: false,
            sourceTile: null,
            borderSize: 70,
          },
        ],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "expand:terra-nullius:20",
            actionKind: "attack" as const,
            accepted: true,
            expansion: true,
            reason: "expanded neutral land",
          },
          {
            sequence: 2,
            actionID: "expand:terra-nullius:10",
            actionKind: "attack" as const,
            accepted: true,
            expansion: true,
            reason: "expanded neutral land",
          },
        ],
      }),
      endgame: {
        winner: null,
        leaderID: "SAU001",
        leaderName: "Saudi Arabia",
        leaderTileShare: 0.32,
        ownTileShare: 0.09,
        turnsToTimer: 4_000,
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand into neutral land with 10%",
        intent: { type: "attack", targetID: null, troops: 43_296 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          targetID: null,
          targetName: "Terra Nullius",
          troops: 43_296,
          troopPercentage: 0.1,
          troopPercent: 10,
          expansion: true,
        },
      },
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand into neutral land with 20%",
        intent: { type: "attack", targetID: null, troops: 86_593 },
        risk: { level: "low", score: 0.12 },
        metadata: {
          targetID: null,
          targetName: "Terra Nullius",
          troops: 86_593,
          troopPercentage: 0.2,
          troopPercent: 20,
          expansion: true,
        },
      },
      {
        id: "expand:terra-nullius:35",
        kind: "attack",
        label: "Expand into neutral land with 35%",
        intent: { type: "attack", targetID: null, troops: 151_538 },
        risk: { level: "medium", score: 0.25 },
        metadata: {
          targetID: null,
          targetName: "Terra Nullius",
          troops: 151_538,
          troopPercentage: 0.35,
          troopPercent: 35,
          expansion: true,
        },
      },
      hardNationAttackAction("CAN001", "Canada", 10, 43_296, 1.55, 0.1),
      hardNationAttackAction("CAN001", "Canada", 25, 108_241, 1.55, 0.1),
      hardNationAttackAction("SAU001", "Saudi Arabia", 10, 43_296, 0.83, 0.32),
      hold(),
    ];
    const affordance = buildAgentTacticalAffordances({
      observation,
      legalActions,
    }).frontierConversionTiming;
    const plan: StrategicPlan = {
      planID: "agent-1:pressure:medium-conversion-probe",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "SAU001",
      rationale:
        "active pressure target is not the best conversion target this turn",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["convert weaker border"],
      failureCriteria: ["hold through conversion window"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "expansion", "defense"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(affordance).toMatchObject({
      recommended: true,
      executorReady: true,
      bestExecutorReadyTargetID: "CAN001",
    });
    expect(decision.actionID).toBe("attack:CAN001:10");
  });

  it("converts a tiny weak side rival when leader pressure would otherwise stall", () => {
    const base = leaderPressureObservation();
    const leader: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "TUR001",
      clientID: "TUR001",
      name: "Turkey",
      troops: 1_090_000,
      maxTroops: 1_800_000,
      troopRatio: 0.61,
      tilesOwned: 74_000,
      tileShare: 0.74,
      relativeTroopRatio: 0.44,
      canAttack: true,
      sharesBorder: true,
      incomingAttack: false,
      outgoingAttack: false,
    };
    const side: AgentVisiblePlayer = {
      ...base.visiblePlayers[1]!,
      playerID: "ANT001",
      clientID: "ANT001",
      name: "Antarctica",
      type: PlayerType.Nation,
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      troops: 190_000,
      maxTroops: 600_000,
      troopRatio: 0.32,
      tilesOwned: 5_200,
      tileShare: 0.05,
      relativeTroopRatio: 2.35,
      canAttack: true,
      sharesBorder: true,
      incomingAttack: false,
      outgoingAttack: false,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 6_126,
      tick: 6_126,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 480_000,
              maxTroops: 1_000_000,
              troopRatio: 0.48,
              tilesOwned: 6_500,
              tileShare: 0.06,
            },
      visiblePlayers: [leader, side],
      combat: {
        ...base.combat,
        ownTroops: 480_000,
        maxTroops: 1_000_000,
        troopRatio: 0.48,
        borderedPlayerIDs: ["TUR001", "ANT001"],
        attackablePlayerIDs: ["TUR001", "ANT001"],
        weakestAttackableTargetID: "ANT001",
        strongestAttackableTargetID: "TUR001",
        canExpandIntoNeutral: false,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          ...Array.from({ length: 4 }, (_, index) => ({
            sequence: index + 1,
            actionID: `expand:neutral:${index}`,
            actionKind: "attack" as const,
            accepted: true,
            expansion: true,
            reason: "expanded neutral land",
          })),
        ],
      }),
      endgame: {
        winner: null,
        leaderID: "TUR001",
        leaderName: "Turkey",
        leaderTileShare: 0.74,
        ownTileShare: 0.06,
        turnsToTimer: 2_000,
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
    };
    const legalActions: LegalAction[] = [
      hardNationAttackAction("ANT001", "Antarctica", 10, 48_000, 2.35, 0.05),
      hardNationAttackAction("ANT001", "Antarctica", 25, 120_000, 2.35, 0.05),
      hardNationAttackAction("TUR001", "Turkey", 10, 48_000, 0.44, 0.74),
      hold(),
    ];
    const affordance = buildAgentTacticalAffordances({
      observation,
      legalActions,
    }).frontierConversionTiming;
    const plan: StrategicPlan = {
      planID: "agent-1:leader-pressure-side-window",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "TUR001",
      rationale: "pressure the runaway leader unless a tiny rival is free land",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["grow enough to contest leader"],
      failureCriteria: ["hold while a weak side rival is convertible"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "expansion"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(affordance).toMatchObject({
      recommended: true,
      executorReady: true,
      bestExecutorReadyTargetID: "ANT001",
    });
    expect(decision.actionID).toBe("attack:ANT001:10");

    const mediumOnlyDecision = new FrontierPolicyExecutor("aggressive").decide(
      {
        observation,
        legalActions: [
          hardNationAttackAction(
            "ANT001",
            "Antarctica",
            25,
            120_000,
            2.35,
            0.05,
          ),
          hold(),
        ],
      },
      plan,
    );

    expect(mediumOnlyDecision.actionID).not.toBe("attack:ANT001:25");
  });

  it("escalates an opened weak front instead of neutral growth after repeated probes", () => {
    const base = leaderPressureObservation();
    const canada: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "CAN001",
      clientID: "CAN001",
      name: "Canada",
      troops: 242_000,
      maxTroops: 700_000,
      troopRatio: 0.35,
      tilesOwned: 11_000,
      tileShare: 0.11,
      relativeTroopRatio: 1.63,
      canAttack: true,
      sharesBorder: true,
      incomingAttack: false,
      outgoingAttack: true,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_076,
      tick: 1_076,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 394_000,
              maxTroops: 700_000,
              troopRatio: 0.56,
              tilesOwned: 13_700,
              tileShare: 0.13,
            },
      visiblePlayers: [canada],
      combat: {
        ...base.combat,
        ownTroops: 394_000,
        maxTroops: 700_000,
        troopRatio: 0.56,
        borderedPlayerIDs: ["CAN001"],
        attackablePlayerIDs: ["CAN001"],
        weakestAttackableTargetID: "CAN001",
        strongestAttackableTargetID: "CAN001",
        canExpandIntoNeutral: true,
        outgoingAttackPlayerIDs: ["CAN001"],
        outgoingAttacks: [
          {
            attackID: "canada-probe",
            targetID: "CAN001",
            targetName: "Canada",
            troops: 39_400,
            retreating: false,
            sourceTile: null,
            borderSize: 60,
          },
        ],
        incomingAttackPlayerIDs: ["CAN001"],
        incomingAttacks: [
          {
            attackID: "canada-counter",
            targetID: "CAN001",
            targetName: "Canada",
            troops: 180_000,
            retreating: false,
            sourceTile: null,
            borderSize: 80,
          },
        ],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "expand:terra-nullius:20",
            actionKind: "attack" as const,
            accepted: true,
            expansion: true,
            reason: "expanded neutral land",
          },
          {
            sequence: 2,
            actionID: "attack:CAN001:10",
            actionKind: "attack" as const,
            accepted: true,
            expansion: false,
            targetID: "CAN001",
            targetName: "Canada",
            reason: "opened weak front",
          },
          {
            sequence: 3,
            actionID: "attack:CAN001:10",
            actionKind: "attack" as const,
            accepted: true,
            expansion: false,
            targetID: "CAN001",
            targetName: "Canada",
            reason: "probed weak front again",
          },
        ],
      }),
      endgame: {
        winner: null,
        leaderID: "CAN001",
        leaderName: "Canada",
        leaderTileShare: 0.22,
        ownTileShare: 0.13,
        turnsToTimer: 4_000,
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand into neutral land with 20%",
        intent: { type: "attack", targetID: null, troops: 78_800 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.2, troopPercent: 20 },
      },
      hardNationAttackAction("CAN001", "Canada", 10, 39_400, 1.63, 0.11),
      hardNationAttackAction("CAN001", "Canada", 25, 98_500, 1.63, 0.11),
      hardNationAttackAction("CAN001", "Canada", 40, 157_600, 1.63, 0.11),
      hold(),
    ];
    const affordance = buildAgentTacticalAffordances({
      observation,
      legalActions,
    }).frontierFinishPressure;
    const plan: StrategicPlan = {
      planID: "agent-1:expand:finish-open-front",
      objective: "expand_territory",
      turnIntent: "growth",
      targetPlayerId: null,
      rationale: "neutral growth is stale when a weak front is already open",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["finish weak rival"],
      failureCriteria: ["repeat tiny probes"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(affordance).toMatchObject({
      recommended: false,
      bestTargetID: "CAN001",
      bestAttackTroopPercent: 25,
    });
    expect(decision.actionID).toBe("attack:CAN001:25");
  });

  it("switches to the executor-ready weak rival during conversion handoff", () => {
    const base = closeLeaderConversionObservation();
    const canada: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "CANADA01",
      clientID: "CANADA01",
      name: "Canada",
      troops: 120_000,
      maxTroops: 800_000,
      troopRatio: 0.15,
      tilesOwned: 10_000,
      tileShare: 0.1,
      relativeTroopRatio: 2.67,
      canAttack: true,
      sharesBorder: true,
      incomingAttack: false,
      outgoingAttack: false,
    };
    const saudi: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "SAUDI02",
      clientID: "SAUDI02",
      name: "Saudi Arabia",
      troops: 165_000,
      maxTroops: 800_000,
      troopRatio: 0.21,
      tilesOwned: 19_000,
      tileShare: 0.19,
      relativeTroopRatio: 1.97,
      canAttack: true,
      sharesBorder: true,
      incomingAttack: false,
      outgoingAttack: true,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 324_000,
              maxTroops: 690_000,
              troopRatio: 0.47,
              tilesOwned: 13_280,
              tileShare: 0.13,
            },
      visiblePlayers: [canada, saudi],
      combat: {
        ...base.combat,
        ownTroops: 324_000,
        maxTroops: 690_000,
        troopRatio: 0.47,
        borderedPlayerIDs: ["CANADA01", "SAUDI02"],
        attackablePlayerIDs: ["CANADA01", "SAUDI02"],
        weakestAttackableTargetID: "CANADA01",
        strongestAttackableTargetID: "SAUDI02",
        canExpandIntoNeutral: true,
        outgoingAttackPlayerIDs: ["SAUDI02"],
        outgoingAttacks: [
          {
            attackID: "outgoing-saudi",
            targetID: "SAUDI02",
            targetName: "Saudi Arabia",
            troops: 32_400,
            retreating: false,
            sourceTile: null,
            borderSize: 18,
          },
        ],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          ...Array.from({ length: 5 }, (_, index) => ({
            sequence: index + 1,
            actionID: "expand:terra-nullius:20",
            actionKind: "attack" as const,
            accepted: true,
            expansion: true,
            reason: "expanded neutral land",
          })),
        ],
      }),
      endgame: {
        winner: null,
        leaderID: "SAUDI02",
        leaderName: "Saudi Arabia",
        leaderTileShare: 0.19,
        ownTileShare: 0.13,
        turnsToTimer: 4_000,
      },
      strategic: {
        ...base.strategic,
        priority: "expand",
        urgency: "medium",
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand into neutral land with 20%",
        intent: { type: "attack", targetID: null, troops: 64_800 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.2 },
      },
      hardNationAttackAction("CANADA01", "Canada", 10, 32_400, 2.67, 0.1),
      hardNationAttackAction("CANADA01", "Canada", 25, 81_000, 2.67, 0.1),
      hardNationAttackAction("SAUDI02", "Saudi Arabia", 10, 32_400, 1.97, 0.19),
      hardNationAttackAction("SAUDI02", "Saudi Arabia", 25, 81_000, 1.97, 0.19),
      hold(),
    ];
    const affordance = buildAgentTacticalAffordances({
      observation,
      legalActions,
    }).frontierConversionTiming;
    const plan: StrategicPlan = {
      planID: "agent-1:conversion-target-switch",
      objective: "expand_territory",
      turnIntent: "growth",
      targetPlayerId: null,
      rationale: "conversion handoff should use the weak executor-ready rival",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["convert weak rival"],
      failureCriteria: ["stick to stale current front"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(affordance?.bestExecutorReadyTargetID).toBe("CANADA01");
    expect(decision.actionID).toBe("attack:CANADA01:10");
  });

  it("does not keep taking tiny conversion probes after repetition stop signal", () => {
    const base = closeLeaderConversionObservation();
    const observation: AgentObservation = {
      ...base,
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          ...Array.from({ length: 4 }, (_, index) => ({
            sequence: index + 1,
            actionID: "attack:CHAD01:10",
            actionKind: "attack" as const,
            targetID: "CHAD01",
            targetName: "Chad",
            accepted: true,
            expansion: false,
            reason: "weak conversion probe",
          })),
        ],
      }),
      combat: {
        ...base.combat,
        outgoingAttackPlayerIDs: ["CHAD01"],
      },
    };
    const legalActions = closeLeaderConversionLegalActions().filter(
      (action) =>
        action.id !== "attack:CHAD01:25" && action.id !== "attack:CHAD01:40",
    );
    const plan: StrategicPlan = {
      planID: "agent-1:repeated-conversion-probe",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "CHAD01",
      rationale: "stop tiny conversion probes when they are stale",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["pause or escalate"],
      failureCriteria: ["repeat 10% probe"],
      preferredActionKinds: ["attack", "build", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "expansion", "economy"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:20");
  });

  it("does not let stale probes on one rival block a fresh conversion target", () => {
    const base = closeLeaderConversionObservation();
    const freshRival: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "SAUDI02",
      clientID: "SAUDI02",
      name: "Saudi Arabia",
      troops: 150_000,
      tilesOwned: 12_000,
      tileShare: 0.12,
      relativeTroopRatio: 3.25,
      canAttack: true,
    };
    const observation: AgentObservation = {
      ...base,
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          ...Array.from({ length: 4 }, (_, index) => ({
            sequence: index + 1,
            actionID: "attack:CHAD01:10",
            actionKind: "attack" as const,
            targetID: "CHAD01",
            targetName: "Chad",
            accepted: true,
            expansion: false,
            reason: "stale weak probe",
          })),
        ],
      }),
      visiblePlayers: [base.visiblePlayers[0]!, freshRival],
      combat: {
        ...base.combat,
        outgoingAttackPlayerIDs: ["CHAD01"],
        attackablePlayerIDs: ["CHAD01", "SAUDI02"],
        borderedPlayerIDs: ["CHAD01", "SAUDI02"],
        weakestAttackableTargetID: "SAUDI02",
        strongestAttackableTargetID: "CHAD01",
      },
    };
    const legalActions: LegalAction[] = [
      closeLeaderConversionLegalActions()[0]!,
      closeLeaderConversionLegalActions()[1]!,
      {
        id: "attack:SAUDI02:10",
        kind: "attack",
        label: "Probe Saudi Arabia with 10%",
        intent: { type: "attack", targetID: "SAUDI02", troops: 56_600 },
        risk: { level: "medium", score: 0.25 },
        metadata: {
          targetID: "SAUDI02",
          targetName: "Saudi Arabia",
          targetTroops: 150_000,
          targetTiles: 12_000,
          targetTileShare: 0.12,
          troopPercentage: 0.1,
          relativeTroopRatio: 3.25,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:fresh-conversion-after-stale-probe",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "CHAD01",
      rationale:
        "fresh weak rival should remain legal despite stale Chad probes",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["convert fresh rival"],
      failureCriteria: ["let stale probe memory block all pressure"],
      preferredActionKinds: ["attack", "build", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "expansion"],
      plannerSource: "mock-llm",
    };

    const affordance = buildAgentTacticalAffordances({
      observation,
      legalActions,
    }).frontierConversionTiming;
    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(affordance?.bestExecutorReadyTargetID).toBe("SAUDI02");
    expect(decision.actionID).toBe("attack:SAUDI02:10");
  });

  it("escalates a proven conversion probe before another defense post", () => {
    const base = closeLeaderConversionObservation();
    const observation: AgentObservation = {
      ...base,
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "attack:CHAD01:10",
            actionKind: "attack" as const,
            targetID: "CHAD01",
            targetName: "Chad",
            accepted: true,
            expansion: false,
            reason: "conversion probe",
          },
          {
            sequence: 2,
            actionID: "attack:CHAD01:10",
            actionKind: "attack" as const,
            targetID: "CHAD01",
            targetName: "Chad",
            accepted: true,
            expansion: false,
            reason: "conversion probe",
          },
        ],
      }),
      combat: {
        ...base.combat,
        outgoingAttackPlayerIDs: ["CHAD01"],
        outgoingAttacks: [
          {
            attackID: "probe-1",
            targetID: "CHAD01",
            targetName: "Chad",
            troops: 56_600,
            retreating: false,
            sourceTile: null,
            borderSize: 120,
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      closeLeaderConversionLegalActions()[0]!,
      closeLeaderConversionLegalActions()[1]!,
      closeLeaderConversionLegalActions()[2]!,
      {
        id: "build:Defense Post:100",
        kind: "build",
        label: "Build Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 100 },
        risk: { level: "low", score: 0.15 },
        metadata: {
          unit: "Defense Post",
          role: "defensive",
          isBorderBuild: true,
          frontierValue: 1,
          defensiveValue: 1,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survive-but-convert",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: null,
      rationale: "survival planner should not waste a proven conversion window",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["convert weak rival"],
      failureCriteria: ["probe forever"],
      preferredActionKinds: ["build", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:CHAD01:25");
  });

  it("does not escalate conversion probes during high home danger", () => {
    const base = closeLeaderConversionObservation();
    const observation: AgentObservation = {
      ...base,
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "attack:CHAD01:10",
            actionKind: "attack" as const,
            targetID: "CHAD01",
            targetName: "Chad",
            accepted: true,
            expansion: false,
            reason: "conversion probe",
          },
          {
            sequence: 2,
            actionID: "attack:CHAD01:10",
            actionKind: "attack" as const,
            targetID: "CHAD01",
            targetName: "Chad",
            accepted: true,
            expansion: false,
            reason: "conversion probe",
          },
        ],
      }),
      combat: {
        ...base.combat,
        incomingAttackPlayerIDs: ["CHAD01"],
        incomingAttacks: [
          {
            attackID: "incoming-collapse",
            targetID: "CHAD01",
            targetName: "Chad",
            troops: 450_000,
            retreating: false,
            sourceTile: null,
            borderSize: 400,
          },
        ],
      },
    };
    const legalActions = closeLeaderConversionLegalActions();
    const plan: StrategicPlan = {
      planID: "agent-1:danger-blocks-conversion",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: null,
      rationale: "home collapse should block conversion escalation",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["survive"],
      failureCriteria: ["overcommit"],
      preferredActionKinds: ["hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).not.toBe("attack:CHAD01:25");
  });

  it("uses neutral catch-up when low share is behind despite visible conversion", () => {
    const base = closeLeaderConversionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2401,
      tick: 2401,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              tilesOwned: 9_000,
              tileShare: 0.09,
              troops: 360_000,
              maxTroops: 720_000,
              troopRatio: 0.5,
            },
      combat: {
        ...base.combat,
        ownTroops: 360_000,
        maxTroops: 720_000,
        troopRatio: 0.5,
        canExpandIntoNeutral: true,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "CHAD01",
        leaderName: "Chad",
        leaderTileShare: 0.38,
        ownTileShare: 0.09,
        turnsToTimer: 3_000,
      },
    };
    const plan: StrategicPlan = {
      planID: "agent-1:low-share-catch-up",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "CHAD01",
      rationale: "low-share recovery should still take free neutral land",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["recover land share"],
      failureCriteria: ["probe while neutral is free"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "expansion"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions: closeLeaderConversionLegalActions() },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:20");
  });

  it("does not force conversion when the executor-ready attack is high risk", () => {
    const observation = closeLeaderConversionObservation();
    const legalActions = closeLeaderConversionLegalActions().map((action) =>
      action.id.startsWith("attack:CHAD01")
        ? { ...action, risk: { level: "high" as const, score: 0.95 } }
        : action,
    );
    const plan: StrategicPlan = {
      planID: "agent-1:blocked-conversion",
      objective: "expand_territory",
      turnIntent: "growth",
      targetPlayerId: null,
      rationale: "do not force unsafe conversion",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["use safe growth"],
      failureCriteria: ["force high-risk attack"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).not.toMatch(/^attack:CHAD01/);
  });

  it("lets executor-ready frontier conversion override stale growth intent", () => {
    const observation = closeLeaderConversionObservation();
    const legalActions = closeLeaderConversionLegalActions();
    const plan: StrategicPlan = {
      planID: "agent-1:growth:stale",
      objective: "expand_territory",
      turnIntent: "growth",
      targetPlayerId: null,
      rationale: "keep expanding while neutral land is visible",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["grow land"],
      failureCriteria: ["feed a leader"],
      preferredActionKinds: ["retreat", "boat_retreat", "build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "combat", "naval"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(["attack:CHAD01:10", "attack:CHAD01:25"]).toContain(
      decision.actionID,
    );
    expect(decision.selectedModules).toContain("combat_attack:combat");
  });

  it("does not let stale fortify hold block executor-ready conversion", () => {
    const observation = closeLeaderConversionObservation();
    const legalActions = closeLeaderConversionLegalActions();
    const plan: StrategicPlan = {
      planID: "agent-1:fortify:stale",
      objective: "fortify_border",
      turnIntent: "fortify",
      targetPlayerId: null,
      rationale: "wait behind defenses",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["stabilize"],
      failureCriteria: ["lose front"],
      preferredActionKinds: ["build", "upgrade_structure", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["defense", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(["attack:CHAD01:10", "attack:CHAD01:25"]).toContain(
      decision.actionID,
    );
    expect(decision.selectedModules).toContain("combat_attack:combat");
  });

  it("launches an escape transport instead of holding while boxed by hard nations", () => {
    const observation = boxedEscapeTransportObservation();
    const legalActions = boxedEscapeTransportLegalActions();
    const plan: StrategicPlan = {
      planID: "agent-1:pressure:boxed",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "LEADER01",
      rationale: "pressure the leader if possible",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["survive pressure"],
      failureCriteria: ["feed stronger leader"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["emergency_survival", "combat", "naval"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:94770:16");
    expect(decision.selectedModules).toContain("neutral_expansion:naval");
  });

  it("does not treat a hostile invasion as a boxed escape transport", () => {
    const observation = boxedEscapeTransportObservation();
    const legalActions: LegalAction[] = [
      {
        id: "attack:LEADER01:10",
        kind: "attack",
        label: "Probe Leader with 10%",
        intent: { type: "attack", targetID: "LEADER01", troops: 34_371 },
        risk: { level: "medium", score: 0.4 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          targetTroops: 1_600_000,
          targetTileShare: 0.57,
          troopPercentage: 0.1,
          relativeTroopRatio: 0.5,
        },
      },
      {
        id: "boat:enemy:16",
        kind: "boat",
        label: "Send 16% transport to Leader",
        intent: { type: "boat", troops: 54_994, dst: 94_770 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 94_770,
          targetID: "LEADER01",
          targetName: "Leader Coast",
          troops: 54_994,
          troopPercentage: 0.16,
          troopPercent: 16,
          relativeTroopRatio: 0.5,
          expansion: false,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure:boxed-no-hostile-escape",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "LEADER01",
      rationale: "do not mistake hostile invasion for escape",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["survive pressure"],
      failureCriteria: ["feed stronger leader"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["emergency_survival", "combat", "naval"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).not.toBe("boat:enemy:16");
  });

  it("launches a rebase transport before a collapsing hard-nation front is terminal", () => {
    const observation = collapsingEscapeTransportObservation();
    const legalActions: LegalAction[] = [
      ...boxedEscapeTransportLegalActions(),
      {
        id: "boat:94770:25",
        kind: "boat",
        label: "Send 25% transport",
        intent: { type: "boat", troops: 140_286, dst: 94_770 },
        risk: { level: "medium", score: 0.25 },
        metadata: {
          targetTile: 94_770,
          targetID: null,
          targetName: "Safe Shore",
          troops: 140_286,
          troopPercentage: 0.25,
          troopPercent: 25,
          expansion: true,
        },
      },
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:fortify:collapsing",
      objective: "fortify_border",
      turnIntent: "fortify",
      targetPlayerId: "LEADER01",
      rationale: "front is collapsing, open a second base",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["transport creates another front"],
      failureCriteria: ["wait until boxed out"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: ["embargo", "embargo_all"],
      enabledModules: ["emergency_survival", "defense", "naval"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:94770:25");
  });

  it("lets a fresh escape transport try to land instead of immediately retreating it", () => {
    const observation = boxedEscapeTransportCrossingObservation();
    const legalActions: LegalAction[] = [
      {
        id: "boat_retreat:99",
        kind: "boat_retreat",
        label: "Retreat transport 99",
        intent: { type: "cancel_boat", unitID: 99 },
        risk: { level: "low", score: 0.15 },
        metadata: {
          unitID: 99,
          tile: 110_228,
          targetTile: 94_770,
          troops: 54_994,
        },
      },
      ...boxedEscapeTransportLegalActions(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survive:fresh-escape",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "LEADER01",
      rationale: "do not cancel the only rebase attempt",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["escape transport lands"],
      failureCriteria: ["cancel transport before landfall"],
      preferredActionKinds: ["boat_retreat", "hold"],
      forbiddenActionKinds: ["attack", "boat"],
      enabledModules: ["emergency_survival", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.actionID).not.toBe("boat_retreat:99");
  });

  it("keeps protecting the escape transport after intervening holds and builds", () => {
    const base = boxedEscapeTransportCrossingObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 4201,
      tick: 4201,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 247_470,
              maxTroops: 410_000,
              troopRatio: 0.6,
              tilesOwned: 3_390,
              tileShare: 0.03,
            },
      combat: {
        ...base.combat,
        ownTroops: 247_470,
        maxTroops: 410_000,
        troopRatio: 0.6,
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "hold",
            actionKind: "hold" as const,
            accepted: true,
            reason: "boxed and waiting",
          },
          {
            sequence: 2,
            actionID: "hold",
            actionKind: "hold" as const,
            accepted: true,
            reason: "boxed and waiting",
          },
          {
            sequence: 3,
            actionID: "boat:94770:16",
            actionKind: "boat" as const,
            targetID: "SECOND02",
            targetName: "Second",
            accepted: true,
            reason: "escape transport",
            expansion: false,
          },
          {
            sequence: 4,
            actionID: "hold",
            actionKind: "hold" as const,
            accepted: true,
            reason: "let transport land",
          },
          {
            sequence: 5,
            actionID: "hold",
            actionKind: "hold" as const,
            accepted: true,
            reason: "let transport land",
          },
          {
            sequence: 6,
            actionID: "hold",
            actionKind: "hold" as const,
            accepted: true,
            reason: "let transport land",
          },
          {
            sequence: 7,
            actionID: "hold",
            actionKind: "hold" as const,
            accepted: true,
            reason: "let transport land",
          },
          {
            sequence: 8,
            actionID: "build:Defense Post:97152",
            actionKind: "build" as const,
            unit: "Defense Post",
            accepted: true,
            reason: "stabilize home front",
          },
        ],
      }),
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat_retreat:99",
        kind: "boat_retreat",
        label: "Retreat transport 99",
        intent: { type: "cancel_boat", unitID: 99 },
        risk: { level: "low", score: 0.15 },
        metadata: {
          unitID: 99,
          tile: 110_228,
          targetTile: 94_770,
          troops: 54_994,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survive:aged-escape",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "LEADER01",
      rationale: "keep the rebase transport active",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["escape transport lands"],
      failureCriteria: ["cancel transport before landfall"],
      preferredActionKinds: ["boat_retreat", "hold"],
      forbiddenActionKinds: ["attack", "boat"],
      enabledModules: ["emergency_survival", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.actionID).not.toBe("boat_retreat:99");
  });

  it("protects an early collapse rebase transport before the nation is below 10k tiles", () => {
    const base = collapsingEscapeTransportObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 3726,
      tick: 3726,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 492_909,
              maxTroops: 1_020_000,
              troopRatio: 0.48,
              tilesOwned: 16_059,
              tileShare: 0.16,
            },
      combat: {
        ...base.combat,
        ownTroops: 492_909,
        maxTroops: 1_020_000,
        troopRatio: 0.48,
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          ...base.memory.recentActions,
          {
            sequence: 8,
            actionID: "boat:94770:16",
            actionKind: "boat" as const,
            targetID: "SECOND02",
            targetName: "Second",
            accepted: true,
            reason: "early collapse rebase",
            ownTiles: 16_930,
            ownTroops: 561_142,
            expansion: false,
          },
        ],
      }),
      nonCombat: {
        ...base.nonCombat,
        boatRetreatOptions: [
          {
            unitID: 99,
            tile: 110_228,
            targetTile: 94_770,
            troops: 89_782,
            legalReason:
              "owned transport ship is active and not already retreating",
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat_retreat:99",
        kind: "boat_retreat",
        label: "Retreat transport 99",
        intent: { type: "cancel_boat", unitID: 99 },
        risk: { level: "low", score: 0.15 },
        metadata: {
          unitID: 99,
          tile: 110_228,
          targetTile: 94_770,
          troops: 89_782,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survive:early-collapse-transport",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "LEADER01",
      rationale: "let the early rebase transport land",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["escape transport lands"],
      failureCriteria: ["cancel transport before landfall"],
      preferredActionKinds: ["boat_retreat", "hold"],
      forbiddenActionKinds: ["attack", "boat"],
      enabledModules: ["emergency_survival", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.actionID).not.toBe("boat_retreat:99");
  });

  it("lets a high-value hard-nation transport land instead of canceling it", () => {
    const base = leaderPressureObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 3401,
      tick: 3401,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 1_123_250,
              maxTroops: 1_731_452,
              troopRatio: 0.65,
              tilesOwned: 31_971,
              tileShare: 0.31,
            },
      combat: {
        ...base.combat,
        ownTroops: 1_123_250,
        maxTroops: 1_731_452,
        troopRatio: 0.65,
        incomingAttackPlayerIDs: ["LEADER01"],
        incomingAttacks: [
          {
            attackID: "leader-push",
            targetID: "LEADER01",
            targetName: "Leader",
            troops: 850_000,
            retreating: false,
            sourceTile: null,
            borderSize: 220,
          },
        ],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "boat:231200:25",
            actionKind: "boat" as const,
            targetID: "MAD001",
            targetName: "Madagascar",
            accepted: true,
            reason: "side transport",
            ownTiles: 31_971,
            ownTroops: 1_315_305,
          },
        ],
      }),
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      nonCombat: {
        ...base.nonCombat,
        boatRetreatOptions: [
          {
            unitID: 74,
            tile: 180_000,
            targetTile: 231_200,
            troops: 328_826,
            legalReason:
              "owned transport ship is active and not already retreating",
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat_retreat:74",
        kind: "boat_retreat",
        label: "Retreat transport 74",
        intent: { type: "cancel_boat", unitID: 74 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          unitID: 74,
          tile: 180_000,
          targetTile: 231_200,
          troops: 328_826,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survive:high-value-transport",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "LEADER01",
      rationale: "large transport should land before canceling",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["transport lands"],
      failureCriteria: ["cancel high-value transport"],
      preferredActionKinds: ["boat_retreat", "hold"],
      forbiddenActionKinds: ["attack", "boat"],
      enabledModules: ["emergency_survival", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.actionID).not.toBe("boat_retreat:74");
  });

  it("takes a recovery turn after retreating a hard-nation front", () => {
    const base = leaderPressureObservation();
    const ukraine: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "UKR001",
      clientID: "UKR001",
      name: "Ukraine",
      troops: 408_906,
      maxTroops: 1_200_000,
      troopRatio: 0.34,
      tilesOwned: 30_000,
      tileShare: 0.3,
      sharesBorder: true,
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: true,
      incomingAttack: true,
      relativeTroopRatio: 2.5,
    };
    const kazakhstan: AgentVisiblePlayer = {
      ...ukraine,
      playerID: "KAZ001",
      clientID: "KAZ001",
      name: "Kazakhstan",
      troops: 920_000,
      troopRatio: 0.62,
      tilesOwned: 36_000,
      tileShare: 0.36,
      incomingAttack: false,
      relativeTroopRatio: 1.1,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 3501,
      tick: 3501,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 1_023_654,
              maxTroops: 1_731_452,
              troopRatio: 0.59,
              tilesOwned: 38_697,
              tileShare: 0.38,
            },
      visiblePlayers: [ukraine, kazakhstan],
      combat: {
        ...base.combat,
        ownTroops: 1_023_654,
        maxTroops: 1_731_452,
        troopRatio: 0.59,
        borderedPlayerIDs: ["UKR001", "KAZ001"],
        attackablePlayerIDs: ["UKR001", "KAZ001"],
        weakestAttackableTargetID: "UKR001",
        strongestAttackableTargetID: "KAZ001",
        incomingAttackPlayerIDs: ["UKR001"],
        incomingAttacks: [
          {
            attackID: "ukraine-push",
            targetID: "UKR001",
            targetName: "Ukraine",
            troops: 895_432,
            retreating: false,
            sourceTile: null,
            borderSize: 220,
          },
        ],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "attack:UKR001:25",
            actionKind: "attack" as const,
            targetID: "UKR001",
            targetName: "Ukraine",
            accepted: true,
            reason: "pressure Ukraine",
            ownTiles: 41_632,
            ownTroops: 1_561_631,
          },
          {
            sequence: 2,
            actionID: "attack:UKR001:25",
            actionKind: "attack" as const,
            targetID: "UKR001",
            targetName: "Ukraine",
            accepted: true,
            reason: "pressure Ukraine",
            ownTiles: 41_597,
            ownTroops: 1_223_022,
          },
          {
            sequence: 3,
            actionID: "attack:UKR001:25",
            actionKind: "attack" as const,
            targetID: "UKR001",
            targetName: "Ukraine",
            accepted: true,
            reason: "pressure Ukraine",
            ownTiles: 41_752,
            ownTroops: 984_105,
          },
          {
            sequence: 4,
            actionID: "retreat:UKR001",
            actionKind: "retreat" as const,
            targetID: "UKR001",
            targetName: "Ukraine",
            accepted: true,
            reason: "front overextended",
            ownTiles: 40_990,
            ownTroops: 789_499,
          },
        ],
      }),
      endgame: {
        winner: null,
        leaderID: "KAZ001",
        leaderName: "Kazakhstan",
        leaderTileShare: 0.38,
        ownTileShare: 0.38,
        turnsToTimer: 2_500,
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
    };
    const legalActions: LegalAction[] = [
      hardNationAttackAction("UKR001", "Ukraine", 10, 102_365, 2.5, 0.3),
      hardNationAttackAction("UKR001", "Ukraine", 25, 255_913, 2.5, 0.3),
      hardNationAttackAction("KAZ001", "Kazakhstan", 10, 102_365, 1.1, 0.36),
      hold(),
    ];
    const plan = pressurePlan(observation, "KAZ001");

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
  });

  it("cools down after a two-hit medium attack wave before firing again", () => {
    const base = leaderPressureObservation();
    const ukraine: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "UKR001",
      clientID: "UKR001",
      name: "Ukraine",
      troops: 496_000,
      maxTroops: 1_100_000,
      troopRatio: 0.45,
      tilesOwned: 30_000,
      tileShare: 0.3,
      sharesBorder: true,
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: true,
      relativeTroopRatio: 1.98,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 3451,
      tick: 3451,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 984_105,
              maxTroops: 1_731_452,
              troopRatio: 0.57,
              tilesOwned: 41_752,
              tileShare: 0.4,
            },
      visiblePlayers: [ukraine],
      combat: {
        ...base.combat,
        ownTroops: 984_105,
        maxTroops: 1_731_452,
        troopRatio: 0.57,
        borderedPlayerIDs: ["UKR001"],
        attackablePlayerIDs: ["UKR001"],
        weakestAttackableTargetID: "UKR001",
        strongestAttackableTargetID: "UKR001",
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: ["UKR001"],
        outgoingAttacks: [
          {
            attackID: "ukraine-front",
            targetID: "UKR001",
            targetName: "Ukraine",
            troops: 220_000,
            retreating: false,
            sourceTile: null,
            borderSize: 260,
          },
        ],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "attack:UKR001:25",
            actionKind: "attack" as const,
            targetID: "UKR001",
            targetName: "Ukraine",
            accepted: true,
            reason: "first medium pressure",
            ownTiles: 41_632,
            ownTroops: 1_561_631,
          },
          {
            sequence: 2,
            actionID: "attack:UKR001:25",
            actionKind: "attack" as const,
            targetID: "UKR001",
            targetName: "Ukraine",
            accepted: true,
            reason: "second medium pressure",
            ownTiles: 41_597,
            ownTroops: 1_223_022,
          },
        ],
      }),
      endgame: {
        winner: null,
        leaderID: "UKR001",
        leaderName: "Ukraine",
        leaderTileShare: 0.4,
        ownTileShare: 0.4,
        turnsToTimer: 2_500,
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
    };
    const legalActions: LegalAction[] = [
      hardNationAttackAction("UKR001", "Ukraine", 10, 98_410, 1.98, 0.3),
      hardNationAttackAction("UKR001", "Ukraine", 25, 246_026, 1.98, 0.3),
      hardNationAttackAction("UKR001", "Ukraine", 40, 393_642, 1.98, 0.3),
      hold(),
    ];
    const plan = pressurePlan(observation, "UKR001");

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
  });

  it("blocks repeated tiny counterpressure probes under hard-nation danger", () => {
    const base = leaderPressureObservation();
    const kazakhstan: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "KAZ001",
      clientID: "KAZ001",
      name: "Kazakhstan",
      troops: 1_250_000,
      maxTroops: 1_700_000,
      troopRatio: 0.74,
      tilesOwned: 38_000,
      tileShare: 0.38,
      sharesBorder: true,
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: true,
      incomingAttack: true,
      relativeTroopRatio: 0.92,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 3426,
      tick: 3426,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 996_560,
              maxTroops: 1_731_452,
              troopRatio: 0.58,
              tilesOwned: 30_863,
              tileShare: 0.31,
            },
      visiblePlayers: [kazakhstan],
      combat: {
        ...base.combat,
        ownTroops: 996_560,
        maxTroops: 1_731_452,
        troopRatio: 0.58,
        borderedPlayerIDs: ["KAZ001"],
        attackablePlayerIDs: ["KAZ001"],
        weakestAttackableTargetID: "KAZ001",
        strongestAttackableTargetID: "KAZ001",
        incomingAttackPlayerIDs: ["KAZ001"],
        incomingAttacks: [
          {
            attackID: "kazakhstan-push",
            targetID: "KAZ001",
            targetName: "Kazakhstan",
            troops: 850_000,
            retreating: false,
            sourceTile: null,
            borderSize: 200,
          },
        ],
        outgoingAttackPlayerIDs: ["KAZ001"],
        outgoingAttacks: [
          {
            attackID: "kazakhstan-probe",
            targetID: "KAZ001",
            targetName: "Kazakhstan",
            troops: 70_000,
            retreating: false,
            sourceTile: null,
            borderSize: 200,
          },
        ],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "attack:KAZ001:10",
            actionKind: "attack" as const,
            targetID: "KAZ001",
            targetName: "Kazakhstan",
            accepted: true,
            reason: "tiny counterpressure",
            ownTiles: 37_504,
            ownTroops: 1_354_307,
          },
          {
            sequence: 2,
            actionID: "attack:KAZ001:10",
            actionKind: "attack" as const,
            targetID: "KAZ001",
            targetName: "Kazakhstan",
            accepted: true,
            reason: "tiny counterpressure",
            ownTiles: 34_158,
            ownTroops: 1_158_397,
          },
        ],
      }),
      endgame: {
        winner: null,
        leaderID: "KAZ001",
        leaderName: "Kazakhstan",
        leaderTileShare: 0.38,
        ownTileShare: 0.31,
        turnsToTimer: 2_500,
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
    };
    const legalActions: LegalAction[] = [
      hardNationAttackAction("KAZ001", "Kazakhstan", 10, 99_656, 0.92, 0.38),
      hardNationAttackAction("KAZ001", "Kazakhstan", 25, 249_140, 0.92, 0.38),
      hold(),
    ];
    const plan = pressurePlan(observation, "KAZ001");

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
  });

  it("recovers instead of taking first unsafe survival panic probes", () => {
    const base = leaderPressureObservation();
    const canada: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "CAN001",
      clientID: "CAN001",
      name: "Canada",
      troops: 290_000,
      tilesOwned: 10_000,
      tileShare: 0.1,
      sharesBorder: true,
      canAttack: true,
      incomingAttack: true,
      relativeTroopRatio: 1.2,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1251,
      tick: 1251,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 340_000,
              maxTroops: 648_000,
              troopRatio: 0.52,
              tilesOwned: 11_547,
              tileShare: 0.11,
            },
      visiblePlayers: [canada],
      combat: {
        ...base.combat,
        ownTroops: 340_000,
        maxTroops: 648_000,
        troopRatio: 0.52,
        borderedPlayerIDs: ["CAN001"],
        attackablePlayerIDs: ["CAN001"],
        incomingAttackPlayerIDs: ["CAN001"],
        incomingAttacks: [
          {
            attackID: "canada-push",
            targetID: "CAN001",
            targetName: "Canada",
            troops: 136_000,
            retreating: false,
            sourceTile: null,
            borderSize: 80,
          },
        ],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
    };
    const boatRetreatAction: LegalAction = {
      id: "boat_retreat:15",
      kind: "boat_retreat",
      label: "Retreat transport 15",
      intent: { type: "cancel_boat", unitID: 15 },
      risk: { level: "low", score: 0.1 },
      metadata: { unitID: 15, troops: 100_000 },
    };
    const legalActions: LegalAction[] = [
      boatRetreatAction,
      hardNationAttackAction("CAN001", "Canada", 10, 34_000, 1.2, 0.1),
      hardNationAttackAction("CAN001", "Canada", 25, 85_000, 1.2, 0.1),
      hold(),
    ].map((action) =>
      action.metadata?.["targetID"] === "CAN001"
        ? {
            ...action,
            metadata: { ...action.metadata, incomingAttack: true },
          }
        : action,
    );
    const plan: StrategicPlan = {
      planID: "agent-1:survive:first-panic-probe",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "CAN001",
      rationale: "survive without symbolic pressure",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["stabilize"],
      failureCriteria: ["panic probe"],
      preferredActionKinds: ["boat_retreat", "build", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "defense", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat_retreat:15");
  });

  it("recalls a transport instead of holding during critical home collapse", () => {
    const base = leaderPressureObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_876,
      tick: 1_876,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 425_000,
              maxTroops: 560_000,
              troopRatio: 0.76,
              tilesOwned: 8_600,
              tileShare: 0.08,
            },
      combat: {
        ...base.combat,
        ownTroops: 425_000,
        maxTroops: 560_000,
        troopRatio: 0.76,
        borderedPlayerIDs: ["RIVAL02"],
        attackablePlayerIDs: ["RIVAL02"],
        incomingAttackPlayerIDs: ["RIVAL02"],
        incomingAttacks: [
          {
            attackID: "rival-push",
            targetID: "RIVAL02",
            targetName: "Rival",
            troops: 244_000,
            retreating: false,
            sourceTile: null,
            borderSize: 160,
          },
        ],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      nonCombat: {
        ...base.nonCombat,
        boatRetreatOptions: [
          {
            unitID: 28,
            tile: 180_582,
            targetTile: 199_155,
            troops: 220_000,
            legalReason:
              "owned transport ship is active and not already retreating",
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat_retreat:28",
        kind: "boat_retreat",
        label: "Retreat transport 28",
        intent: { type: "cancel_boat", unitID: 28 },
        risk: { level: "low", score: 0.12 },
        metadata: {
          unitID: 28,
          tile: 180_582,
          targetTile: 199_155,
          troops: 220_000,
        },
      },
      hardNationAttackAction("RIVAL02", "Rival", 10, 42_500, 0.75, 0.1),
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survive:critical-transport-recall",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "RIVAL02",
      rationale: "home front is collapsing; recall banked troops",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["stabilize"],
      failureCriteria: ["hold through collapse"],
      preferredActionKinds: ["boat_retreat", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat_retreat:28");
  });

  it("recalls a modest fresh transport when the home core is almost gone", () => {
    const base = leaderPressureObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2_401,
      tick: 2_401,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 140_047,
              maxTroops: 169_382,
              troopRatio: 0.83,
              tilesOwned: 369,
              tileShare: 0.004,
            },
      combat: {
        ...base.combat,
        ownTroops: 140_047,
        maxTroops: 169_382,
        troopRatio: 0.83,
        borderedPlayerIDs: ["RIVAL02"],
        attackablePlayerIDs: ["RIVAL02"],
        incomingAttackPlayerIDs: ["RIVAL02"],
        incomingAttacks: [
          {
            attackID: "rival-overrun",
            targetID: "RIVAL02",
            targetName: "Rival",
            troops: 168_944,
            retreating: false,
            sourceTile: null,
            borderSize: 80,
          },
        ],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "boat:65183:25",
            actionKind: "boat" as const,
            accepted: true,
            reason: "late escape launch",
            ownTiles: 1_681,
            ownTroops: 106_558,
          },
        ],
      }),
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      nonCombat: {
        ...base.nonCombat,
        boatRetreatOptions: [
          {
            unitID: 41,
            tile: 65_176,
            targetTile: 65_183,
            troops: 27_599,
            legalReason:
              "owned transport ship is active and not already retreating",
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat_retreat:41",
        kind: "boat_retreat",
        label: "Retreat transport 41",
        intent: { type: "cancel_boat", unitID: 41 },
        risk: { level: "low", score: 0.12 },
        metadata: {
          unitID: 41,
          tile: 65_176,
          targetTile: 65_183,
          troops: 27_599,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survive:tiny-core-transport-recall",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "RIVAL02",
      rationale: "home core is too small to keep a fresh transport protected",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["stabilize"],
      failureCriteria: ["hold while core collapses"],
      preferredActionKinds: ["boat_retreat", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat_retreat:41");
  });

  it("recalls a protected banked transport when a tiny core is under medium collapse pressure", () => {
    const base = leaderPressureObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 5_401,
      tick: 5_401,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 259_697,
              maxTroops: 539_775,
              troopRatio: 0.48,
              tilesOwned: 1_974,
              tileShare: 0.019,
            },
      combat: {
        ...base.combat,
        ownTroops: 259_697,
        maxTroops: 539_775,
        troopRatio: 0.48,
        borderedPlayerIDs: ["SAU001"],
        attackablePlayerIDs: ["SAU001"],
        incomingAttackPlayerIDs: ["SAU001"],
        incomingAttacks: [
          {
            attackID: "saudi-medium-collapse",
            targetID: "SAU001",
            targetName: "Saudi Arabia",
            troops: 22_000,
            retreating: false,
            sourceTile: null,
            borderSize: 58,
          },
        ],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "boat:176591:16",
            actionKind: "boat" as const,
            accepted: true,
            reason: "banked escape transport",
            ownTiles: 2_840,
            ownTroops: 272_000,
          },
        ],
      }),
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      nonCombat: {
        ...base.nonCombat,
        boatRetreatOptions: [
          {
            unitID: 92,
            tile: 176_591,
            targetTile: 199_155,
            troops: 81_092,
            legalReason:
              "owned transport ship is active and not already retreating",
          },
        ],
      },
    };
    const boatRetreatAction: LegalAction = {
      id: "boat_retreat:92",
      kind: "boat_retreat",
      label: "Retreat transport 92",
      intent: { type: "cancel_boat", unitID: 92 },
      risk: { level: "low", score: 0.12 },
      metadata: {
        unitID: 92,
        tile: 176_591,
        targetTile: 199_155,
        troops: 81_092,
      },
    };
    const legalActions: LegalAction[] = [
      boatRetreatAction,
      hardNationAttackAction("SAU001", "Saudi Arabia", 10, 25_969, 2.17, 0.1),
      hardNationAttackAction("SAU001", "Saudi Arabia", 25, 64_924, 2.17, 0.1),
      hold(),
    ].map((action) =>
      action.metadata?.["targetID"] === "SAU001"
        ? {
            ...action,
            metadata: { ...action.metadata, incomingAttack: true },
          }
        : action,
    );
    const plan: StrategicPlan = {
      planID: "agent-1:pressure-rival:tiny-core-transport-recall",
      objective: "pressure_rival",
      turnIntent: "survive",
      targetPlayerId: "SAU001",
      rationale:
        "pressure plan has switched to survival while a banked transport can still save the core",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["stabilize"],
      failureCriteria: ["probe while core collapses"],
      preferredActionKinds: ["boat_retreat", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat_retreat:92");
  });

  it("retreats a collapsing land front before asking for alliances", () => {
    const base = leaderPressureObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2_201,
      tick: 2_201,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 86_400,
              maxTroops: 272_000,
              troopRatio: 0.32,
              tilesOwned: 1_681,
              tileShare: 0.02,
            },
      combat: {
        ...base.combat,
        ownTroops: 86_400,
        maxTroops: 272_000,
        troopRatio: 0.32,
        borderedPlayerIDs: ["RIVAL02"],
        attackablePlayerIDs: ["RIVAL02"],
        incomingAttackPlayerIDs: ["RIVAL02"],
        incomingAttacks: [
          {
            attackID: "rival-finish",
            targetID: "RIVAL02",
            targetName: "Rival",
            troops: 205_000,
            retreating: false,
            sourceTile: null,
            borderSize: 180,
          },
        ],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "retreat:rival-finish",
        kind: "retreat",
        label: "Retreat from Rival",
        intent: { type: "cancel_attack", attackID: "rival-finish" },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          incomingAttack: true,
          troops: 15_000,
        },
      },
      {
        id: "alliance:ALLY01",
        kind: "alliance_request",
        label: "Request alliance",
        intent: { type: "allianceRequest", recipient: "ALLY01" },
        risk: { level: "low", score: 0.05 },
        metadata: { recipientID: "ALLY01", recipientName: "Potential ally" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survive:critical-land-retreat",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "RIVAL02",
      rationale: "use legal survival action before diplomacy",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["stabilize"],
      failureCriteria: ["diplomacy while dying"],
      preferredActionKinds: ["retreat", "alliance_request", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "diplomacy", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("retreat:rival-finish");
  });

  it("recalls a neutral expansion attack instead of holding during critical collapse", () => {
    const base = leaderPressureObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2_201,
      tick: 2_201,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 86_400,
              maxTroops: 272_000,
              troopRatio: 0.32,
              tilesOwned: 1_681,
              tileShare: 0.02,
            },
      combat: {
        ...base.combat,
        ownTroops: 86_400,
        maxTroops: 272_000,
        troopRatio: 0.32,
        borderedPlayerIDs: ["RIVAL02"],
        attackablePlayerIDs: ["RIVAL02"],
        incomingAttackPlayerIDs: ["RIVAL02"],
        incomingAttacks: [
          {
            attackID: "rival-finish",
            targetID: "RIVAL02",
            targetName: "Rival",
            troops: 205_000,
            retreating: false,
            sourceTile: null,
            borderSize: 180,
          },
        ],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "retreat:neutral-expansion",
        kind: "retreat",
        label: "Retreat from Terra Nullius",
        intent: { type: "cancel_attack", attackID: "neutral-expansion" },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetName: "Terra Nullius",
          troops: 15_000,
        },
      },
      {
        id: "alliance:ALLY01",
        kind: "alliance_request",
        label: "Request alliance",
        intent: { type: "allianceRequest", recipient: "ALLY01" },
        risk: { level: "low", score: 0.05 },
        metadata: { recipientID: "ALLY01", recipientName: "Potential ally" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survive:critical-neutral-retreat",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "RIVAL02",
      rationale: "cancel nonessential land grabs before dying",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["stabilize"],
      failureCriteria: ["hold through collapse"],
      preferredActionKinds: ["retreat", "alliance_request", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "diplomacy", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("retreat:neutral-expansion");
  });

  it("uses safe neutral boats as survival recovery when opening tempo is collapsing", () => {
    const base = leaderPressureObservation();
    const canada: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "CAN001",
      clientID: "CAN001",
      name: "Canada",
      troops: 290_000,
      tilesOwned: 10_000,
      tileShare: 0.1,
      sharesBorder: true,
      canAttack: true,
      relativeTroopRatio: 1.2,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2_126,
      tick: 2_126,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 170_000,
              maxTroops: 330_000,
              troopRatio: 0.52,
              tilesOwned: 2_700,
              tileShare: 0.03,
            },
      visiblePlayers: [canada],
      combat: {
        ...base.combat,
        ownTroops: 170_000,
        maxTroops: 330_000,
        troopRatio: 0.52,
        borderedPlayerIDs: ["CAN001"],
        attackablePlayerIDs: ["CAN001"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        canExpandIntoNeutral: false,
      },
      endgame: {
        winner: null,
        leaderID: "CAN001",
        leaderName: "Canada",
        leaderTileShare: 0.32,
        ownTileShare: 0.03,
        turnsToTimer: 5_000,
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
    };
    const legalActions: LegalAction[] = [
      hardNationAttackAction("CAN001", "Canada", 10, 17_000, 1.2, 0.1),
      hardNationAttackAction("CAN001", "Canada", 25, 42_500, 1.2, 0.1),
      {
        id: "boat:neutral:16",
        kind: "boat",
        label: "Send 16% transport to Terra Nullius",
        intent: { type: "boat", troops: 27_200, dst: 910 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetID: null,
          targetName: "Terra Nullius",
          troopPercentage: 0.16,
          troops: 27_200,
          expansion: true,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survive:neutral-boat-recovery",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "CAN001",
      rationale: "avoid symbolic probes while keeping growth alive",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["stabilize and keep growing"],
      failureCriteria: ["panic probe"],
      preferredActionKinds: ["boat", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:neutral:16");
  });

  it("escalates stale survival probes into a real counterattack on the repeated target", () => {
    const base = leaderPressureObservation();
    const canada: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "CAN001",
      clientID: "CAN001",
      name: "Canada",
      troops: 260_000,
      maxTroops: 850_000,
      troopRatio: 0.31,
      tilesOwned: 10_000,
      tileShare: 0.1,
      sharesBorder: true,
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: true,
      incomingAttack: true,
      relativeTroopRatio: 1.44,
    };
    const egypt: AgentVisiblePlayer = {
      ...base.visiblePlayers[1]!,
      playerID: "EGY001",
      clientID: "EGY001",
      name: "Egypt",
      troops: 640_000,
      tilesOwned: 29_000,
      tileShare: 0.29,
      sharesBorder: true,
      canAttack: true,
      incomingAttack: false,
      relativeTroopRatio: 0.58,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1351,
      tick: 1351,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 374_000,
              maxTroops: 640_000,
              troopRatio: 0.58,
              tilesOwned: 10_743,
              tileShare: 0.11,
            },
      visiblePlayers: [canada, egypt],
      combat: {
        ...base.combat,
        ownTroops: 374_000,
        maxTroops: 640_000,
        troopRatio: 0.58,
        borderedPlayerIDs: ["CAN001", "EGY001"],
        attackablePlayerIDs: ["CAN001", "EGY001"],
        incomingAttackPlayerIDs: ["CAN001"],
        incomingAttacks: [
          {
            attackID: "canada-push",
            targetID: "CAN001",
            targetName: "Canada",
            troops: 105_000,
            retreating: false,
            sourceTile: null,
            borderSize: 80,
          },
        ],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "attack:CAN001:10",
            actionKind: "attack" as const,
            targetID: "CAN001",
            targetName: "Canada",
            accepted: true,
            reason: "tiny counterpressure",
          },
          {
            sequence: 2,
            actionID: "attack:CAN001:10",
            actionKind: "attack" as const,
            targetID: "CAN001",
            targetName: "Canada",
            accepted: true,
            reason: "tiny counterpressure",
          },
          {
            sequence: 3,
            actionID: "attack:CAN001:10",
            actionKind: "attack" as const,
            targetID: "CAN001",
            targetName: "Canada",
            accepted: true,
            reason: "tiny counterpressure",
          },
        ],
      }),
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      endgame: {
        winner: null,
        leaderID: "EGY001",
        leaderName: "Egypt",
        leaderTileShare: 0.29,
        ownTileShare: 0.11,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      hardNationAttackAction("CAN001", "Canada", 10, 37_400, 1.44, 0.1),
      hardNationAttackAction("CAN001", "Canada", 25, 93_500, 1.44, 0.1),
      hardNationAttackAction("CAN001", "Canada", 40, 149_600, 1.44, 0.1),
      hardNationAttackAction("EGY001", "Egypt", 10, 37_400, 0.58, 0.29),
      hold(),
    ].map((action) =>
      action.metadata?.targetID === "CAN001"
        ? {
            ...action,
            metadata: { ...action.metadata, incomingAttack: true },
          }
        : action,
    );
    const plan: StrategicPlan = {
      planID: "agent-1:survive:stale-probe",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "EGY001",
      rationale: "survive plan should clean up the repeated probe target",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["stop stale probes"],
      failureCriteria: ["repeat 10% probe"],
      preferredActionKinds: ["retreat", "boat_retreat", "build", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "defense", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:CAN001:25");
  });

  it("recovers instead of repeating survival probes when no safe escalation exists", () => {
    const base = leaderPressureObservation();
    const canada: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "CAN001",
      clientID: "CAN001",
      name: "Canada",
      troops: 410_000,
      tilesOwned: 11_000,
      tileShare: 0.11,
      sharesBorder: true,
      canAttack: true,
      incomingAttack: true,
      relativeTroopRatio: 1.05,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1451,
      tick: 1451,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 314_000,
              maxTroops: 540_000,
              troopRatio: 0.58,
              tilesOwned: 7_980,
              tileShare: 0.08,
            },
      visiblePlayers: [canada],
      combat: {
        ...base.combat,
        ownTroops: 314_000,
        maxTroops: 540_000,
        troopRatio: 0.58,
        borderedPlayerIDs: ["CAN001"],
        attackablePlayerIDs: ["CAN001"],
        incomingAttackPlayerIDs: ["CAN001"],
        incomingAttacks: [
          {
            attackID: "canada-heavy-push",
            targetID: "CAN001",
            targetName: "Canada",
            troops: 260_000,
            retreating: false,
            sourceTile: null,
            borderSize: 90,
          },
        ],
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [1, 2, 3].map((sequence) => ({
          sequence,
          actionID: "attack:CAN001:10",
          actionKind: "attack" as const,
          targetID: "CAN001",
          targetName: "Canada",
          accepted: true,
          reason: "tiny counterpressure",
        })),
      }),
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
    };
    const boatRetreatAction: LegalAction = {
      id: "boat_retreat:15",
      kind: "boat_retreat",
      label: "Retreat transport 15",
      intent: { type: "cancel_boat", unitID: 15 },
      risk: { level: "low", score: 0.1 },
      metadata: { unitID: 15, troops: 100_000 },
    };
    const legalActions: LegalAction[] = [
      boatRetreatAction,
      hardNationAttackAction("CAN001", "Canada", 10, 31_400, 1.05, 0.11),
      hardNationAttackAction("CAN001", "Canada", 25, 78_500, 1.05, 0.11),
      hold(),
    ].map((action) =>
      action.metadata?.["targetID"] === "CAN001"
        ? {
            ...action,
            metadata: { ...action.metadata, incomingAttack: true },
          }
        : action,
    );
    const plan: StrategicPlan = {
      planID: "agent-1:survive:probe-recovery",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "CAN001",
      rationale: "recover after repeated probes",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["stabilize"],
      failureCriteria: ["repeat 10% probe"],
      preferredActionKinds: ["boat_retreat", "build", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "defense", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat_retreat:15");
  });

  it("treats expansion streaks as recent instead of lifetime memory", () => {
    const memory = new AgentMemoryBuilder().build({
      recentDecisions: [
        {
          sequence: 1,
          actionID: "expand:terra-nullius:10",
          actionKind: "attack",
          accepted: true,
          reason: "expanded",
          expansion: true,
        },
        {
          sequence: 2,
          actionID: "expand:terra-nullius:20",
          actionKind: "attack",
          accepted: true,
          reason: "expanded again",
          expansion: true,
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          sequence: index + 3,
          actionID: "hold",
          actionKind: "hold" as const,
          accepted: true,
          reason: "waited",
        })),
      ],
    });

    expect(memory.recentExpansionCount).toBe(0);
    expect(memory.recentHoldCount).toBe(8);
  });

  it("refreshes stale pressure plans when urgent defense appears", async () => {
    const pressureObservation = activeObservation("pressure_rival");
    const defenseObservation: AgentObservation = {
      ...pressureObservation,
      strategic: {
        ...pressureObservation.strategic,
        priority: "build_defense",
        urgency: "high",
        recommendedActionKinds: ["build", "alliance_request", "hold"],
      },
    };
    const brain = new PlannerExecutorAgentBrain({
      profile: "opportunistic",
      planner: new MockLlmPlanner("opportunistic"),
      planEveryDecisionSteps: 10,
    });

    await brain.decide({
      observation: pressureObservation,
      legalActions: [
        {
          id: "attack:RIVAL001:10",
          kind: "attack",
          label: "Attack Rival",
          intent: { type: "attack", targetID: "RIVAL001", troops: 100 },
          risk: { level: "medium", score: 0.3 },
          metadata: { targetID: "RIVAL001", troopPercentage: 0.1 },
        },
        hold(),
      ],
    });
    const second = await brain.decide({
      observation: defenseObservation,
      legalActions: [
        {
          id: "build:DefensePost:20",
          kind: "build",
          label: "Build Defense Post",
          intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 20 },
          risk: { level: "low", score: 0.1 },
          metadata: {
            role: "defensive",
            unit: UnitType.DefensePost,
            defensiveValue: 0.8,
            frontierValue: 0.9,
            nearbyEnemyCount: 2,
            hostileBorderDistance: 2,
            buildPlacementReason: "Defense Post covers an active frontier.",
          },
        },
        hold(),
      ],
    });

    expect(second.metadata?.plannerRan).toBe(true);
    expect(second.metadata?.plannerRefreshReason).toBe("urgent_defense");
    expect(second.metadata?.planObjective).toBe("fortify_border");
    expect(second.actionID).toBe("build:DefensePost:20");
  });

  it("refreshes stale alliance plans when a dominant conversion attack is available", async () => {
    const allianceObservation = activeObservation("build_alliance");
    const conversionObservation: AgentObservation = {
      ...dominantConversionObservation(),
      strategic: {
        ...dominantConversionObservation().strategic,
        priority: "attack",
        urgency: "high",
        recommendedActionKinds: ["attack", "target_player", "hold"],
      },
      objective:
        allianceObservation.objective === null
          ? null
          : {
              ...allianceObservation.objective,
              kind: "build_alliance",
              status: "active",
              preferredActionKinds: ["alliance_request", "donate_gold", "hold"],
            },
    };
    let plannerCalls = 0;
    const planner = {
      plannerType: "mock-llm" as const,
      async plan(input: { observation: AgentObservation }) {
        plannerCalls += 1;
        const objective: AgentObjectiveKind =
          plannerCalls === 1 ? "build_alliance" : "pressure_rival";
        const plan: StrategicPlan = {
          planID: `test:${objective}:${plannerCalls}`,
          objective,
          targetPlayerId: objective === "pressure_rival" ? "RIVAL001" : null,
          rationale: `test ${objective}`,
          startedAtTick: input.observation.tick,
          maxDecisionCycles: 10,
          successCriteria: [],
          failureCriteria: [],
          preferredActionKinds:
            objective === "build_alliance"
              ? ["alliance_request", "donate_gold", "hold"]
              : ["attack", "embargo_all", "target_player", "hold"],
          forbiddenActionKinds: [],
          enabledModules:
            objective === "build_alliance"
              ? ["diplomacy", "utility_social"]
              : ["combat", "utility_social"],
          plannerSource: "mock-llm",
        };
        return {
          plan,
          reason: plan.rationale,
          latencyMs: 0,
          fallbackUsed: false,
          rawPlannerOutput: JSON.stringify({ objective }),
          parseOk: true,
        };
      },
    };
    const brain = new PlannerExecutorAgentBrain({
      profile: "diplomatic",
      planner,
      planEveryDecisionSteps: 10,
    });

    await brain.decide({
      observation: allianceObservation,
      legalActions: [
        {
          id: "alliance:RIVAL001",
          kind: "alliance_request",
          label: "Request alliance",
          intent: { type: "allianceRequest", recipient: "RIVAL001" },
          risk: { level: "low", score: 0.1 },
          metadata: { recipientID: "RIVAL001" },
        },
        hold(),
      ],
    });
    const second = await brain.decide({
      observation: conversionObservation,
      legalActions: [
        {
          id: "attack:RIVAL001:25",
          kind: "attack",
          label: "Attack Rival with 25%",
          intent: { type: "attack", targetID: "RIVAL001", troops: 250_000 },
          risk: { level: "medium", score: 0.3 },
          metadata: {
            targetID: "RIVAL001",
            targetName: "Rival",
            troopPercentage: 0.25,
            relativeTroopRatio: 1.6,
          },
        },
        {
          id: "embargo_all:start",
          kind: "embargo_all",
          label: "Embargo all",
          intent: { type: "embargo_all", action: "start" },
          risk: { level: "low", score: 0.1 },
        },
        hold(),
      ],
    });

    expect(second.metadata?.plannerRan).toBe(true);
    expect(second.metadata?.plannerRefreshReason).toBe("alliance_plan_stale");
    expect(second.metadata?.planObjective).toBe("pressure_rival");
    expect(second.actionID).toBe("attack:RIVAL001:25");
  });

  it("schedules compatible nation-style modules in one executor decision", () => {
    const observation = activeObservation("expand_territory");
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand",
        intent: { type: "attack", targetID: null, troops: 100 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.15 },
      },
      {
        id: "build:City:100",
        kind: "build",
        label: "Build City",
        intent: { type: "build_unit", unit: UnitType.City, tile: 100 },
        risk: { level: "medium", score: 0.3 },
        metadata: { role: "economic", unit: "City" },
      },
      {
        id: "alliance:request:RIVAL001",
        kind: "alliance_request",
        label: "Request Alliance",
        intent: { type: "allianceRequest", recipient: "RIVAL001" },
        risk: { level: "low", score: 0.1 },
        metadata: { recipientID: "RIVAL001" },
      },
      {
        id: "embargo:RIVAL002",
        kind: "embargo",
        label: "Embargo Rival",
        intent: { type: "embargo", targetID: "RIVAL002", action: "start" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL002" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:batch",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "expand while running independent nation modules",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["expand and compound"],
      failureCriteria: ["hold"],
      preferredActionKinds: ["attack", "build", "alliance_request", "embargo"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "economy", "diplomacy", "combat"],
      tacticalSettings: { maxActionsPerDecision: 4 },
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic", {
      settings: { openingExpansionTempoEnabled: true },
    }).decide({ observation, legalActions }, plan);

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.actionIDs).toEqual([
      "expand:terra-nullius:10",
      "build:City:100",
    ]);
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
    expect(decision.selectedModules).toContain("economic_structure:economy");
  });

  it("uses opening tempo to expand before static defense while tiny", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 751,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 500_000,
              maxTroops: 900_000,
              troopRatio: 0.56,
              tilesOwned: 1_000,
              tileShare: 0.01,
            },
      combat: {
        ...base.combat,
        ownTroops: 500_000,
        maxTroops: 900_000,
        troopRatio: 0.56,
        canExpandIntoNeutral: true,
        attackablePlayerIDs: [],
        borderedPlayerIDs: [],
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.025,
        ownTileShare: 0.01,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand 20%",
        intent: { type: "attack", targetID: null, troops: 100_000 },
        risk: { level: "low", score: 0.2 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.2,
        },
      },
      {
        id: "expand:terra-nullius:35",
        kind: "attack",
        label: "Expand 35%",
        intent: { type: "attack", targetID: null, troops: 175_000 },
        risk: { level: "low", score: 0.35 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.35,
        },
      },
      {
        id: "build:Defense Post:100",
        kind: "build",
        label: "Build Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 100 },
        risk: { level: "low", score: 0.15 },
        metadata: {
          unit: "Defense Post",
          role: "defensive",
          isBorderBuild: true,
          hostileBorderDistance: 1,
          frontierValue: 1,
          defensiveValue: 0.9,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:fortify",
      objective: "fortify_border",
      targetPlayerId: null,
      rationale: "fortify but do not miss the opening land grab",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["survive"],
      failureCriteria: ["fall behind"],
      preferredActionKinds: ["build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["defense"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("defensive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:35");
    expect(decision.actionIDs).toContain("build:Defense Post:100");
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
  });

  it("keeps growing safely instead of fortifying during the human replay opening window", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 850,
      memory: {
        ...base.memory,
        recentExpansionCount: 7,
        repeatedActionKind: "attack",
        repeatedActionCount: 7,
      },
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 190_000,
              maxTroops: 590_000,
              troopRatio: 0.32,
              tilesOwned: 9_500,
              tileShare: 0.09,
            },
      combat: {
        ...base.combat,
        ownTroops: 190_000,
        maxTroops: 590_000,
        troopRatio: 0.32,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        canExpandIntoNeutral: true,
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "medium",
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.13,
        ownTileShare: 0.09,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand 20%",
        intent: { type: "attack", targetID: null, troops: 38_000 },
        risk: { level: "low", score: 0.2 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.2,
        },
      },
      {
        id: "build:Defense Post:100",
        kind: "build",
        label: "Build Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 100 },
        risk: { level: "low", score: 0.15 },
        metadata: {
          unit: "Defense Post",
          role: "defensive",
          isBorderBuild: true,
          hostileBorderDistance: 1,
          frontierValue: 1,
          defensiveValue: 0.9,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:fortify-opening",
      objective: "fortify_border",
      targetPlayerId: null,
      rationale: "safe opening growth should not stall into static defense",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["keep pace with human openings"],
      failureCriteria: ["stall on a safe border"],
      preferredActionKinds: ["build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["defense"],
      tacticalSettings: { maxActionsPerDecision: 1 },
      plannerSource: "mock-llm",
    };

    expect(
      buildAgentTacticalAffordances({
        observation,
        legalActions,
      }).openingExpansionTempo,
    ).toMatchObject({
      openingWindow: true,
      neutralExpansionAvailable: true,
      homeDanger: "low",
    });

    const decision = new FrontierPolicyExecutor("defensive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:20");
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
  });

  it("keeps late opening neutral land ahead of static defense while still small", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 850,
      memory: {
        ...base.memory,
        recentExpansionCount: 8,
        repeatedActionKind: "attack",
        repeatedActionCount: 8,
      },
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 260_000,
              maxTroops: 700_000,
              troopRatio: 0.37,
              tilesOwned: 12_500,
              tileShare: 0.145,
            },
      combat: {
        ...base.combat,
        ownTroops: 260_000,
        maxTroops: 700_000,
        troopRatio: 0.37,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        canExpandIntoNeutral: true,
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "medium",
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.16,
        ownTileShare: 0.145,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand neutral land",
        intent: { type: "attack", targetID: null, troops: 26_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      {
        id: "build:Defense Post:100",
        kind: "build",
        label: "Build Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 100 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          unit: "Defense Post",
          role: "defensive",
          isBorderBuild: true,
          hostileBorderDistance: 1,
          frontierValue: 1,
          defensiveValue: 0.9,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:late-opening-fortify",
      objective: "fortify_border",
      targetPlayerId: null,
      rationale: "static defense can wait until direct neutral is gone",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["keep opening tempo"],
      failureCriteria: ["leave legal neutral land behind"],
      preferredActionKinds: ["build", "attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["defense", "expansion"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("defensive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
  });

  it("keeps stale opening pressure from interrupting safe neutral capture", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 976,
      memory: {
        ...base.memory,
        recentExpansionCount: 7,
        repeatedActionKind: "attack",
        repeatedActionCount: 7,
      },
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 380_000,
              maxTroops: 900_000,
              troopRatio: 0.42,
              tilesOwned: 10_500,
              tileShare: 0.1,
            },
      combat: {
        ...base.combat,
        ownTroops: 380_000,
        maxTroops: 900_000,
        troopRatio: 0.42,
        canExpandIntoNeutral: true,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.14,
        ownTileShare: 0.1,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand neutral land",
        intent: { type: "attack", targetID: null, troops: 38_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Probe Rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 38_000 },
        risk: { level: "medium", score: 0.45 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          relativeTroopRatio: 0.9,
          troopPercentage: 0.1,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:stale-pressure",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "RIVAL02",
      rationale: "pressure plan should not waste the human replay opening",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["capture open land first"],
      failureCriteria: ["stall while neutral exists"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "expansion"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
  });

  it("keeps early neutral capture ahead of shallow frontier conversion", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 826,
      memory: {
        ...base.memory,
        recentExpansionCount: 8,
        repeatedActionKind: "attack",
        repeatedActionCount: 8,
      },
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 260_000,
              maxTroops: 520_000,
              troopRatio: 0.5,
              tilesOwned: 7_800,
              tileShare: 0.08,
            },
      combat: {
        ...base.combat,
        ownTroops: 260_000,
        maxTroops: 520_000,
        troopRatio: 0.5,
        attackablePlayerIDs: ["RIVAL02"],
        borderedPlayerIDs: ["RIVAL02"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        canExpandIntoNeutral: true,
      },
      visiblePlayers: base.visiblePlayers.map((player, index) =>
        index === 0
          ? {
              ...player,
              playerID: "RIVAL02",
              clientID: "RIVAL02",
              name: "Border Rival",
              troops: 208_000,
              tileShare: 0.1,
              relativeTroopRatio: 1.25,
              canAttack: true,
              sharesBorder: true,
            }
          : player,
      ),
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Border Rival",
        leaderTileShare: 0.1,
        ownTileShare: 0.08,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand neutral land",
        intent: { type: "attack", targetID: null, troops: 26_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Probe Border Rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 26_000 },
        risk: { level: "medium", score: 0.4 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Border Rival",
          relativeTroopRatio: 1.25,
          targetTileShare: 0.1,
          troopPercentage: 0.1,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:shallow-conversion",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "RIVAL02",
      rationale: "a shallow border probe is not worth leaving open land",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["take neutral first"],
      failureCriteria: ["fight before the opening is filled"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "expansion"],
      plannerSource: "mock-llm",
    };

    const affordances = buildAgentTacticalAffordances({
      observation,
      legalActions,
    });

    expect(affordances.frontierConversionTiming).toMatchObject({
      recommended: true,
      executorReady: true,
    });

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
  });

  it("tapers repeated opening expansion instead of overcommitting 35 percent", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 525,
      memory: {
        ...base.memory,
        recentExpansionCount: 7,
        repeatedActionKind: "attack",
        repeatedActionCount: 7,
      },
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 70_000,
              maxTroops: 500_000,
              troopRatio: 0.14,
              tilesOwned: 4_500,
              tileShare: 0.04,
            },
      combat: {
        ...base.combat,
        ownTroops: 70_000,
        maxTroops: 500_000,
        troopRatio: 0.14,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        canExpandIntoNeutral: true,
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.08,
        ownTileShare: 0.04,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand 10%",
        intent: { type: "attack", targetID: null, troops: 7_000 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.1,
        },
      },
      {
        id: "expand:terra-nullius:35",
        kind: "attack",
        label: "Expand 35%",
        intent: { type: "attack", targetID: null, troops: 24_500 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.35,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:taper-opening",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "keep expanding without draining reserves",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["grow"],
      failureCriteria: ["overcommit"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion"],
      tacticalSettings: { maxActionsPerDecision: 1 },
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:10");
  });

  it("uses direct neutral land before human replay opening boat tempo", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 720,
      memory: {
        ...base.memory,
        recentExpansionCount: 3,
        repeatedActionKind: "attack",
        repeatedActionCount: 3,
      },
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 500_000,
              maxTroops: 1_000_000,
              troopRatio: 0.5,
              tilesOwned: 1_500,
              tileShare: 0.012,
            },
      combat: {
        ...base.combat,
        ownTroops: 500_000,
        maxTroops: 1_000_000,
        troopRatio: 0.5,
        borderedPlayerIDs: [],
        attackablePlayerIDs: [],
        canExpandIntoNeutral: true,
      },
      nonCombat: {
        ...base.nonCombat,
        boatRetreatOptions: [],
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.035,
        ownTileShare: 0.012,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:25",
        kind: "attack",
        label: "Expand 25%",
        intent: { type: "attack", targetID: null, troops: 125_000 },
        risk: { level: "low", score: 0.2 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.25,
        },
      },
      {
        id: "boat:555:25",
        kind: "boat",
        label: "Send 25% transport",
        intent: { type: "boat", troops: 125_000, dst: 555 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: null,
          troopPercentage: 0.25,
          troops: 125_000,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:human-opening-boat",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "match human replay opening tempo",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["expand like top human openings"],
      failureCriteria: ["stall opening"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic", {
      settings: { territoryFirstNeutralLandEnabled: true },
    }).decide({ observation, legalActions }, plan);

    expect(decision.actionID).toBe("expand:terra-nullius:25");
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
  });

  it("keeps launching neutral boats after land expansion saturates later in the opening", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2_400,
      memory: {
        ...base.memory,
        recentExpansionCount: 7,
        repeatedActionKind: "attack",
        repeatedActionCount: 7,
      },
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 650_000,
              maxTroops: 1_100_000,
              troopRatio: 0.59,
              tilesOwned: 3_800,
              tileShare: 0.03,
            },
      combat: {
        ...base.combat,
        ownTroops: 650_000,
        maxTroops: 1_100_000,
        troopRatio: 0.59,
        borderedPlayerIDs: [],
        attackablePlayerIDs: [],
        canExpandIntoNeutral: true,
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.07,
        ownTileShare: 0.03,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:25",
        kind: "attack",
        label: "Expand 25%",
        intent: { type: "attack", targetID: null, troops: 162_500 },
        risk: { level: "low", score: 0.2 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.25,
        },
      },
      {
        id: "boat:777:20",
        kind: "boat",
        label: "Send 20% transport",
        intent: { type: "boat", troops: 130_000, dst: 777 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: null,
          troopPercentage: 0.2,
          troops: 130_000,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:late-opening-neutral-boat",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "land expansion is saturating; launch neutral transports",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["grow faster than the field"],
      failureCriteria: ["stall with neutral islands open"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:777:20");
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
  });

  it("uses neutral boats for opening catch-up even after expansion memory resets", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2_150,
      memory: {
        ...base.memory,
        recentExpansionCount: 0,
        repeatedActionKind: "hold",
        repeatedActionCount: 2,
      },
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 360_000,
              maxTroops: 720_000,
              troopRatio: 0.5,
              tilesOwned: 3_200,
              tileShare: 0.032,
            },
      combat: {
        ...base.combat,
        ownTroops: 360_000,
        maxTroops: 720_000,
        troopRatio: 0.5,
        borderedPlayerIDs: [],
        attackablePlayerIDs: [],
        canExpandIntoNeutral: true,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.31,
        ownTileShare: 0.032,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:35",
        kind: "attack",
        label: "Expand 35%",
        intent: { type: "attack", targetID: null, troops: 126_000 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.35,
        },
      },
      {
        id: "boat:909:16",
        kind: "boat",
        label: "Send 16% transport",
        intent: { type: "boat", troops: 57_600, dst: 909 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetID: null,
          troopPercentage: 0.16,
          troops: 57_600,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survival-neutral-boat-catchup",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "RIVAL02",
      rationale: "catch up while hostile attacks remain unsafe",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["survive without giving up neutral islands"],
      failureCriteria: ["stall opening tempo"],
      preferredActionKinds: ["boat", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:909:16");
    expect(decision.selectedModules).toContain("neutral_expansion:naval");
  });

  it("keeps taking neutral land during opening catch-up despite a high generic risk label", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_926,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 385_000,
              maxTroops: 510_000,
              troopRatio: 0.75,
              tilesOwned: 7_100,
              tileShare: 0.07,
            },
      combat: {
        ...base.combat,
        ownTroops: 385_000,
        maxTroops: 510_000,
        troopRatio: 0.75,
        borderedPlayerIDs: ["RIVAL02"],
        attackablePlayerIDs: ["RIVAL02"],
        canExpandIntoNeutral: true,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.31,
        ownTileShare: 0.07,
        turnsToTimer: 5_000,
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
    };
    const legalActions: LegalAction[] = [
      hardNationAttackAction("RIVAL02", "Rival", 10, 38_500, 1.2, 0.1),
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand 20%",
        intent: { type: "attack", targetID: null, troops: 77_000 },
        risk: { level: "high", score: 0.75 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.2,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survival-neutral-land-catchup",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "RIVAL02",
      rationale: "behind tempo but hostile attacks are unsafe",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["keep growing"],
      failureCriteria: ["stall while neutral land is legal"],
      preferredActionKinds: ["hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:20");
  });

  it("uses neutral land as survival recovery even when stale-expansion penalties made it unattractive", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_926,
      memory: {
        ...base.memory,
        recentExpansionCount: 6,
        repeatedActionKind: "attack",
        repeatedActionCount: 5,
      },
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 385_000,
              maxTroops: 510_000,
              troopRatio: 0.75,
              tilesOwned: 7_100,
              tileShare: 0.07,
            },
      combat: {
        ...base.combat,
        ownTroops: 385_000,
        maxTroops: 510_000,
        troopRatio: 0.75,
        borderedPlayerIDs: ["RIVAL02"],
        attackablePlayerIDs: ["RIVAL02"],
        canExpandIntoNeutral: true,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.31,
        ownTileShare: 0.07,
        turnsToTimer: 5_000,
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
    };
    const legalActions: LegalAction[] = [
      hardNationAttackAction("RIVAL02", "Rival", 10, 38_500, 0.85, 0.09),
      {
        id: "expand:terra-nullius:35",
        kind: "attack",
        label: "Expand 35%",
        intent: { type: "attack", targetID: null, troops: 134_750 },
        risk: { level: "high", score: 0.82 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.35,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survival-neutral-land-stale-recovery",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "RIVAL02",
      rationale: "survival plan should not turn free neutral land into a hold",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["recover land"],
      failureCriteria: ["stall while neutral land is legal"],
      preferredActionKinds: ["hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:35");
  });

  it("does not block catch-up neutral boats after an intervening transport retreat", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2_150,
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "boat:older:25",
            actionKind: "boat",
            accepted: true,
            reason: "launched previous neutral boat",
            expansion: true,
          },
          {
            sequence: 2,
            actionID: "boat_retreat:32",
            actionKind: "boat_retreat",
            accepted: true,
            reason: "retreated a transport under pressure",
          },
        ],
      }),
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 360_000,
              maxTroops: 720_000,
              troopRatio: 0.5,
              tilesOwned: 3_200,
              tileShare: 0.032,
            },
      combat: {
        ...base.combat,
        ownTroops: 360_000,
        maxTroops: 720_000,
        troopRatio: 0.5,
        borderedPlayerIDs: [],
        attackablePlayerIDs: [],
        canExpandIntoNeutral: true,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.31,
        ownTileShare: 0.032,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:35",
        kind: "attack",
        label: "Expand 35%",
        intent: { type: "attack", targetID: null, troops: 126_000 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.35,
        },
      },
      {
        id: "boat:910:16",
        kind: "boat",
        label: "Send 16% transport",
        intent: { type: "boat", troops: 57_600, dst: 910 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetID: null,
          troopPercentage: 0.16,
          troops: 57_600,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survival-neutral-boat-after-retreat",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "RIVAL02",
      rationale: "resume neutral sea expansion after retreating a transport",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["keep neutral islands in play"],
      failureCriteria: ["let one boat launch freeze the opening"],
      preferredActionKinds: ["boat", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:910:16");
  });

  it("does not treat hostile player transports as early neutral boat tempo", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 720,
      memory: {
        ...base.memory,
        recentExpansionCount: 3,
        repeatedActionKind: "attack",
        repeatedActionCount: 3,
      },
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 500_000,
              maxTroops: 1_000_000,
              troopRatio: 0.5,
              tilesOwned: 1_500,
              tileShare: 0.012,
            },
      combat: {
        ...base.combat,
        ownTroops: 500_000,
        maxTroops: 1_000_000,
        troopRatio: 0.5,
        canExpandIntoNeutral: true,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:25",
        kind: "attack",
        label: "Expand 25%",
        intent: { type: "attack", targetID: null, troops: 125_000 },
        risk: { level: "low", score: 0.2 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.25,
        },
      },
      {
        id: "boat:RIVAL02:25",
        kind: "boat",
        label: "Send 25% transport to Rival",
        intent: { type: "boat", troops: 125_000, dst: 555 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          troopPercentage: 0.25,
          troops: 125_000,
          navalInvasion: true,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:no-player-opening-boat",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "neutral tempo should not become a player invasion",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["take neutral land"],
      failureCriteria: ["launch hostile boat"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:25");
  });

  it("uses human replay economy foundation before another safe Defense Post", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_326,
      memory: {
        ...base.memory,
        recentBuildCount: 1,
      },
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 450_000,
              maxTroops: 1_000_000,
              troopRatio: 0.45,
              tilesOwned: 10_000,
              tileShare: 0.08,
              unitCounts: {
                ...base.ownState.unitCounts,
                [UnitType.City]: 0,
                [UnitType.Factory]: 0,
                [UnitType.Port]: 0,
              },
            },
      combat: {
        ...base.combat,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "medium",
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "build:Defense Post:100",
        kind: "build",
        label: "Build Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 100 },
        risk: { level: "low", score: 0.15 },
        metadata: {
          unit: "Defense Post",
          role: "defensive",
          defensiveValue: 0.95,
          frontierValue: 0.9,
          hostileBorderDistance: 1,
        },
      },
      {
        id: "build:City:200",
        kind: "build",
        label: "Build City",
        intent: { type: "build_unit", unit: UnitType.City, tile: 200 },
        risk: { level: "medium", score: 0.35 },
        metadata: { unit: "City", role: "economic" },
      },
      {
        id: "build:Factory:200",
        kind: "build",
        label: "Build Factory",
        intent: { type: "build_unit", unit: UnitType.Factory, tile: 200 },
        risk: { level: "medium", score: 0.35 },
        metadata: { unit: "Factory", role: "economic" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:fortify-stale",
      objective: "fortify_border",
      targetPlayerId: null,
      rationale: "fortify frontier",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["survive"],
      failureCriteria: ["fall behind"],
      preferredActionKinds: ["build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["defense"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("build:City:200");
    expect(decision.selectedModules).toContain("economic_structure:economy");
  });

  it("uses the winner-corpus flag to place a first Port before first Factory after City", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_526,
      memory: {
        ...base.memory,
        recentBuildCount: 0,
      },
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 520_000,
              maxTroops: 1_000_000,
              troopRatio: 0.52,
              tilesOwned: 12_000,
              tileShare: 0.1,
              unitCounts: {
                ...base.ownState.unitCounts,
                [UnitType.City]: 1,
                [UnitType.Factory]: 0,
                [UnitType.Port]: 0,
              },
            },
      combat: {
        ...base.combat,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "medium",
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "build:Defense Post:100",
        kind: "build",
        label: "Build Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 100 },
        risk: { level: "low", score: 0.15 },
        metadata: {
          unit: "Defense Post",
          role: "defensive",
          defensiveValue: 0.95,
          frontierValue: 0.9,
          hostileBorderDistance: 1,
        },
      },
      {
        id: "build:Factory:200",
        kind: "build",
        label: "Build Factory",
        intent: { type: "build_unit", unit: UnitType.Factory, tile: 200 },
        risk: { level: "medium", score: 0.35 },
        metadata: { unit: "Factory", role: "economic" },
      },
      {
        id: "build:Port:201",
        kind: "build",
        label: "Build Port",
        intent: { type: "build_unit", unit: UnitType.Port, tile: 201 },
        risk: { level: "medium", score: 0.35 },
        metadata: { unit: "Port", role: "economic" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:post-city-economy",
      objective: "fortify_border",
      targetPlayerId: null,
      rationale: "fortify frontier",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["survive"],
      failureCriteria: ["fall behind"],
      preferredActionKinds: ["build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["defense"],
      plannerSource: "mock-llm",
    };

    const winnerCorpusDecision = new FrontierPolicyExecutor("opportunistic", {
      settings: { humanReplayEconomyCadenceEnabled: true },
    }).decide({ observation, legalActions }, plan);
    const legacyDecision = new FrontierPolicyExecutor("opportunistic", {
      settings: { humanReplayEconomyCadenceEnabled: false },
    }).decide({ observation, legalActions }, plan);

    expect(winnerCorpusDecision.actionID).toBe("build:Port:201");
    expect(legacyDecision.actionID).toBe("build:Factory:200");
  });

  it("uses winner-corpus economy cadence to add ports during safe pressure", () => {
    const base = activeObservation("pressure_rival");
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2_600,
      tick: 2_600,
      memory: {
        ...base.memory,
        recentExpansionCount: 6,
        recentBuildCount: 0,
      },
      ownState: {
        playerID: "AGENT001",
        clientID: "CLIENT01",
        smallID: 1,
        name: "Frontier",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 820_000,
        maxTroops: 1_200_000,
        troopRatio: 0.68,
        gold: "950000",
        tilesOwned: 26_000,
        tileShare: 0.24,
        borderTiles: 420,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
        unitCounts: {
          [UnitType.City]: 1,
          [UnitType.Factory]: 1,
          [UnitType.Port]: 1,
        },
      },
      visiblePlayers: [
        {
          playerID: "RIVAL001",
          clientID: "RIVAL001",
          smallID: 2,
          name: "Rival",
          type: PlayerType.Nation,
          isAlive: true,
          isDisconnected: false,
          hasSpawned: true,
          troops: 780_000,
          maxTroops: 1_200_000,
          troopRatio: 0.65,
          gold: "10000",
          tilesOwned: 20_000,
          tileShare: 0.18,
          sharesBorder: true,
          isAllied: false,
          isFriendly: false,
          relation: Relation.Neutral,
          canAttack: true,
          canRequestAlliance: false,
          canDonateGold: false,
          canDonateTroops: false,
          canEmbargo: true,
          hasEmbargoAgainst: false,
          outgoingAttack: false,
          incomingAttack: false,
          hasOutgoingAllianceRequest: false,
          hasIncomingAllianceRequest: false,
          relativeTroopRatio: 1.05,
        },
      ],
      combat: {
        ...base.combat,
        ownTroops: 820_000,
        maxTroops: 1_200_000,
        troopRatio: 0.68,
        canExpandIntoNeutral: false,
        neutralExpansionLegalReason: null,
        borderedPlayerIDs: ["RIVAL001"],
        attackablePlayerIDs: ["RIVAL001"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        weakestAttackableTargetID: "RIVAL001",
        strongestAttackableTargetID: "RIVAL001",
      },
      endgame: {
        winner: null,
        leaderID: "AGENT001",
        leaderName: "Frontier",
        leaderTileShare: 0.24,
        ownTileShare: 0.24,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      hardNationAttackAction("RIVAL001", "Rival", 10, 82_000, 1.05, 0.18),
      {
        id: "build:City:300",
        kind: "build",
        label: "Build City",
        intent: { type: "build_unit", unit: UnitType.City, tile: 300 },
        risk: { level: "low", score: 0.1 },
        metadata: { unit: "City", role: "economic" },
      },
      {
        id: "build:Factory:301",
        kind: "build",
        label: "Build Factory",
        intent: { type: "build_unit", unit: UnitType.Factory, tile: 301 },
        risk: { level: "low", score: 0.1 },
        metadata: { unit: "Factory", role: "economic" },
      },
      {
        id: "build:Port:302",
        kind: "build",
        label: "Build Port",
        intent: { type: "build_unit", unit: UnitType.Port, tile: 302 },
        risk: { level: "low", score: 0.1 },
        metadata: { unit: "Port", role: "economic" },
      },
      hold(),
    ];

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      pressurePlan(observation, "RIVAL001"),
    );

    expect(decision.actionID).toBe("build:Port:302");
    expect(decision.selectedModules).toContain("economic_structure:economy");
  });

  it("does not delay a decisive weak-rival finish for economy cadence", () => {
    const base = activeObservation("pressure_rival");
    const observation: AgentObservation = {
      ...base,
      turnNumber: 3_200,
      tick: 3_200,
      memory: {
        ...base.memory,
        recentExpansionCount: 6,
        recentBuildCount: 0,
      },
      ownState: {
        playerID: "AGENT001",
        clientID: "CLIENT01",
        smallID: 1,
        name: "Frontier",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 900_000,
        maxTroops: 1_300_000,
        troopRatio: 0.69,
        gold: "950000",
        tilesOwned: 28_000,
        tileShare: 0.28,
        borderTiles: 420,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
        unitCounts: {
          [UnitType.City]: 1,
          [UnitType.Factory]: 1,
          [UnitType.Port]: 1,
        },
      },
      visiblePlayers: [
        {
          playerID: "RIVAL001",
          clientID: "RIVAL001",
          smallID: 2,
          name: "Rival",
          type: PlayerType.Nation,
          isAlive: true,
          isDisconnected: false,
          hasSpawned: true,
          troops: 260_000,
          maxTroops: 900_000,
          troopRatio: 0.29,
          gold: "10000",
          tilesOwned: 2_500,
          tileShare: 0.025,
          sharesBorder: true,
          isAllied: false,
          isFriendly: false,
          relation: Relation.Neutral,
          canAttack: true,
          canRequestAlliance: false,
          canDonateGold: false,
          canDonateTroops: false,
          canEmbargo: true,
          hasEmbargoAgainst: false,
          outgoingAttack: false,
          incomingAttack: false,
          hasOutgoingAllianceRequest: false,
          hasIncomingAllianceRequest: false,
          relativeTroopRatio: 3.2,
        },
      ],
      combat: {
        ...base.combat,
        ownTroops: 900_000,
        maxTroops: 1_300_000,
        troopRatio: 0.69,
        canExpandIntoNeutral: false,
        neutralExpansionLegalReason: null,
        borderedPlayerIDs: ["RIVAL001"],
        attackablePlayerIDs: ["RIVAL001"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        weakestAttackableTargetID: "RIVAL001",
        strongestAttackableTargetID: "RIVAL001",
      },
      endgame: {
        winner: null,
        leaderID: "AGENT001",
        leaderName: "Frontier",
        leaderTileShare: 0.28,
        ownTileShare: 0.28,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      hardNationAttackAction("RIVAL001", "Rival", 25, 225_000, 3.2, 0.025),
      {
        id: "build:Port:302",
        kind: "build",
        label: "Build Port",
        intent: { type: "build_unit", unit: UnitType.Port, tile: 302 },
        risk: { level: "low", score: 0.1 },
        metadata: { unit: "Port", role: "economic" },
      },
      hold(),
    ];

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      pressurePlan(observation, "RIVAL001"),
    );

    expect(decision.actionID).toBe("attack:RIVAL001:25");
    expect(decision.selectedModules).toContain("combat");
  });

  it("does not add social chatter to neutral expansion batches", () => {
    const observation = earlyExpansionObservation();
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand 20%",
        intent: { type: "attack", targetID: null, troops: 100_000 },
        risk: { level: "low", score: 0.2 },
        metadata: {
          expansion: true,
          targetID: null,
          troopPercentage: 0.2,
        },
      },
      {
        id: "quick_chat:RIVAL001:misc.team_up",
        kind: "quick_chat",
        label: "Ask Rival to team up",
        intent: {
          type: "quick_chat",
          recipient: "RIVAL001",
          quickChatKey: "misc.team_up",
        },
        risk: { level: "low", score: 0.1 },
        metadata: { recipientID: "RIVAL001" },
      },
      {
        id: "emoji:RIVAL001:25",
        kind: "emoji",
        label: "Send emoji",
        intent: { type: "emoji", recipient: "RIVAL001", emoji: 25 },
        risk: { level: "low", score: 0.1 },
        metadata: { recipientID: "RIVAL001" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:quiet-expansion",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "expand without empty chatter",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["gain land"],
      failureCriteria: ["spam chat"],
      preferredActionKinds: ["attack", "quick_chat", "emoji", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "utility_social"],
      tacticalSettings: { maxActionsPerDecision: 3 },
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:20");
    expect(decision.actionIDs ?? [decision.actionID]).toEqual([
      "expand:terra-nullius:20",
    ]);
  });

  it("batches social flavor after real pressure actions", () => {
    const observation = activeObservation("pressure_rival");
    const legalActions: LegalAction[] = [
      {
        id: "quick_chat:RIVAL001:attack",
        kind: "quick_chat",
        label: "Tell Rival to attack",
        intent: {
          type: "quick_chat",
          recipient: "RIVAL001",
          quickChatKey: "attack.attack",
        },
        risk: { level: "low", score: 0.1 },
        metadata: { recipientID: "RIVAL001" },
      },
      {
        id: "emoji:RIVAL001:11",
        kind: "emoji",
        label: "Clown Rival",
        intent: {
          type: "emoji",
          recipient: "RIVAL001",
          emoji: 11,
        },
        risk: { level: "none", score: 0 },
        metadata: {
          recipientID: "RIVAL001",
          recipientName: "Rival",
          emojiText: "🤡",
          emojiContext: "mock_overextended_target",
        },
      },
      {
        id: "target:RIVAL001",
        kind: "target_player",
        label: "Target Rival",
        intent: { type: "targetPlayer", target: "RIVAL001" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL001" },
      },
      {
        id: "attack:RIVAL001:10",
        kind: "attack",
        label: "Attack Rival with 10%",
        intent: { type: "attack", targetID: "RIVAL001", troops: 100_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "RIVAL001",
          targetName: "Rival",
          troopPercentage: 0.1,
          relativeTroopRatio: 1.8,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL001",
      rationale: "pressure the rival",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["damage rival"],
      failureCriteria: ["send empty signals"],
      preferredActionKinds: ["attack", "target_player", "embargo", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "diplomacy", "utility_social"],
      tacticalSettings: { maxActionsPerDecision: 4 },
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(["target:RIVAL001", "attack:RIVAL001:10"]).toContain(
      decision.actionID,
    );
    expect(decision.actionIDs ?? [decision.actionID]).toContain(
      "quick_chat:RIVAL001:attack",
    );
    expect(decision.actionIDs ?? [decision.actionID]).toContain(
      "emoji:RIVAL001:11",
    );
  });

  it("answers teammate focus calls with real pressure instead of staying on economy", () => {
    const observation: AgentObservation = {
      ...activeObservation("secure_economy"),
      ownState: {
        playerID: "AGENT001",
        clientID: "client-agent",
        smallID: 1,
        name: "Planner Agent",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 500_000,
        maxTroops: 700_000,
        troopRatio: 0.71,
        gold: "250000",
        tilesOwned: 35_000,
        tileShare: 0.22,
        borderTiles: 300,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      visiblePlayers: [
        {
          playerID: "RIVAL001",
          clientID: null,
          smallID: 7,
          name: "Rival Nation",
          type: PlayerType.Nation,
          isAlive: true,
          isDisconnected: false,
          hasSpawned: true,
          troops: 280_000,
          maxTroops: 500_000,
          troopRatio: 0.56,
          gold: "100000",
          tilesOwned: 18_000,
          tileShare: 0.1,
          sharesBorder: true,
          isAllied: false,
          isFriendly: false,
          relation: Relation.Hostile,
          canAttack: true,
          attackLegalReason: "shares border",
          canRequestAlliance: false,
          canDonateGold: false,
          canDonateTroops: false,
          canEmbargo: true,
          canTarget: true,
          canBreakAlliance: false,
          canExtendAlliance: false,
          canRejectAlliance: false,
          hasEmbargoAgainst: false,
          outgoingAttack: false,
          incomingAttack: false,
          hasOutgoingAllianceRequest: false,
          hasIncomingAllianceRequest: false,
          relativeTroopRatio: 1.78,
        },
      ],
      recentCommunications: [
        {
          sequence: 12,
          turnNumber: 800,
          senderAgentID: "ally-agent",
          senderPlayerID: "ALLY001",
          senderName: "Signal Ally",
          senderProfile: "diplomatic",
          actionKind: "quick_chat",
          intent: "coordinate_attack",
          recipientID: "AGENT001",
          recipientName: "Planner Agent",
          targetID: "RIVAL001",
          targetName: "Rival Nation",
          quickChatKey: "attack.focus",
          message: "Focus Rival Nation!",
          directToAgent: true,
        },
      ],
    };
    const legalActions: LegalAction[] = [
      {
        id: "build:City:100",
        kind: "build",
        label: "Build City",
        intent: { type: "build_unit", unit: UnitType.City, tile: 100 },
        risk: { level: "low", score: 0.1 },
        metadata: { role: "economic", unit: "City" },
      },
      {
        id: "target:RIVAL001",
        kind: "target_player",
        label: "Target Rival Nation",
        intent: { type: "targetPlayer", target: "RIVAL001" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL001", targetName: "Rival Nation" },
      },
      hardNationAttackAction(
        "RIVAL001",
        "Rival Nation",
        25,
        125_000,
        1.78,
        0.1,
      ),
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:economy",
      objective: "secure_economy",
      targetPlayerId: null,
      rationale: "economy unless a teammate calls focus",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["scale"],
      failureCriteria: ["ignore focus calls"],
      preferredActionKinds: ["build", "attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["economy", "combat", "diplomacy"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(["attack:RIVAL001:25", "target:RIVAL001"]).toContain(
      decision.actionID,
    );
  });

  it("sends focus chat to another agent when pressuring a shared target", () => {
    const observation = activeObservation("pressure_rival");
    const legalActions: LegalAction[] = [
      {
        id: "target:RIVAL001",
        kind: "target_player",
        label: "Target Rival",
        intent: { type: "targetPlayer", target: "RIVAL001" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL001", targetName: "Rival" },
      },
      {
        id: "quick_chat:ALLY001:attack.focus",
        kind: "quick_chat",
        label: "Ask ally to focus Rival",
        intent: {
          type: "quick_chat",
          recipient: "ALLY001",
          quickChatKey: "attack.focus",
          target: "RIVAL001",
        },
        risk: { level: "none", score: 0 },
        metadata: {
          recipientID: "ALLY001",
          recipientName: "Ally Agent",
          targetID: "RIVAL001",
          targetName: "Rival",
          quickChatKey: "attack.focus",
        },
      },
      {
        id: "quick_chat:RIVAL001:attack.focus",
        kind: "quick_chat",
        label: "Taunt Rival",
        intent: {
          type: "quick_chat",
          recipient: "RIVAL001",
          quickChatKey: "attack.focus",
          target: "RIVAL001",
        },
        risk: { level: "none", score: 0 },
        metadata: {
          recipientID: "RIVAL001",
          recipientName: "Rival",
          targetID: "RIVAL001",
          targetName: "Rival",
          quickChatKey: "attack.focus",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL001",
      rationale: "pressure with public coordination",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["focus rival"],
      failureCriteria: ["silent pressure"],
      preferredActionKinds: ["target_player", "quick_chat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "diplomacy", "utility_social"],
      tacticalSettings: { maxActionsPerDecision: 3 },
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("target:RIVAL001");
    expect(decision.actionIDs ?? [decision.actionID]).toContain(
      "quick_chat:ALLY001:attack.focus",
    );
  });

  it("breaks saturated spawn-score ties using strategic spawn quality", () => {
    const observation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Planner Agent",
      profile: "opportunistic",
      gameID: "PLAN",
      turnNumber: 0,
      phaseOverride: "spawn",
    });
    const legalActions: LegalAction[] = [
      {
        id: "spawn:10",
        kind: "spawn",
        label: "Low quality spawn",
        intent: { type: "spawn", tile: 10 },
        risk: { level: "medium", score: 0.4 },
        metadata: {
          pressureScore: 0.2,
          safetyScore: 0.4,
          diplomacyScore: 0.3,
          opportunityScore: 0.4,
        },
      },
      {
        id: "spawn:999999",
        kind: "spawn",
        label: "High quality spawn",
        intent: { type: "spawn", tile: 999999 },
        risk: { level: "medium", score: 0.2 },
        metadata: {
          pressureScore: 0.5,
          safetyScore: 0.8,
          diplomacyScore: 0.7,
          opportunityScore: 0.9,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:spawn",
      objective: "choose_spawn",
      targetPlayerId: null,
      rationale: "choose best opening",
      startedAtTick: observation.tick,
      maxDecisionCycles: 1,
      successCriteria: ["spawn"],
      failureCriteria: ["bad spawn"],
      preferredActionKinds: ["spawn", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["spawn_opening"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("spawn:999999");
  });

  it("uses the agent spawn scout seed when many strong starts are viable", () => {
    const baseObservation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: "client-alpha",
      username: "Planner Agent",
      profile: "opportunistic",
      gameID: "PLAN",
      turnNumber: 0,
      phaseOverride: "spawn",
    });
    const legalActions: LegalAction[] = [
      ...Array.from({ length: 25 }, (_, index) => {
        const col = index % 5;
        const row = Math.floor(index / 5);
        const tile = 10_000 + index;
        return {
          id: `spawn:${tile}`,
          kind: "spawn" as const,
          label: `Strong spawn ${tile}`,
          intent: { type: "spawn" as const, tile },
          risk: { level: "medium" as const, score: 0.35 },
          metadata: {
            x: 20 + col * 45,
            y: 20 + row * 45,
            pressureScore: 0.58,
            safetyScore: 0.36,
            diplomacyScore: 0.78,
            opportunityScore: 0.88,
            localLandScore: 0.98,
          },
        };
      }),
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:spawn",
      objective: "choose_spawn",
      targetPlayerId: null,
      rationale: "choose best opening",
      startedAtTick: baseObservation.tick,
      maxDecisionCycles: 1,
      successCriteria: ["spawn"],
      failureCriteria: ["bad spawn"],
      preferredActionKinds: ["spawn", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["spawn_opening"],
      plannerSource: "mock-llm",
    };

    const alphaDecision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation: baseObservation, legalActions },
      plan,
    );
    const betaDecision = new FrontierPolicyExecutor("opportunistic").decide(
      {
        observation: {
          ...baseObservation,
          clientID: "client-beta",
          agentID: "agent-2",
          username: "Second Planner",
        },
        legalActions,
      },
      plan,
    );

    expect(alphaDecision.actionID).toMatch(/^spawn:/);
    expect(betaDecision.actionID).toMatch(/^spawn:/);
    expect(alphaDecision.actionID).not.toBe(betaDecision.actionID);
  });

  it("keeps scouting for roomy spawn regions instead of overfitting a crowded cluster", () => {
    const observation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: "client-alpha",
      username: "Scout Agent",
      profile: "opportunistic",
      gameID: "PLAN",
      turnNumber: 0,
      phaseOverride: "spawn",
    });
    const crowdedCluster: LegalAction[] = Array.from(
      { length: 24 },
      (_, index) => {
        const tile = 1_000 + index;
        return {
          id: `spawn:${tile}`,
          kind: "spawn",
          label: `Crowded spawn ${tile}`,
          intent: { type: "spawn", tile },
          risk: { level: "medium", score: 0.7 },
          metadata: {
            x: 100 + (index % 4),
            y: 100 + Math.floor(index / 4),
            pressureScore: 0.83,
            safetyScore: 0.21,
            diplomacyScore: 0.96,
            opportunityScore: 0.96,
            localLandScore: 0.93,
          },
        };
      },
    );
    const roomyScout: LegalAction = {
      id: "spawn:9001",
      kind: "spawn",
      label: "Roomy scout spawn",
      intent: { type: "spawn", tile: 9_001 },
      risk: { level: "medium", score: 0.3 },
      metadata: {
        x: 320,
        y: 330,
        pressureScore: 0.6,
        safetyScore: 0.38,
        diplomacyScore: 0.9,
        opportunityScore: 0.86,
        localLandScore: 0.99,
      },
    };
    const plan: StrategicPlan = {
      planID: "agent-1:spawn",
      objective: "choose_spawn",
      targetPlayerId: null,
      rationale: "choose best opening",
      startedAtTick: observation.tick,
      maxDecisionCycles: 1,
      successCriteria: ["spawn"],
      failureCriteria: ["bad spawn"],
      preferredActionKinds: ["spawn", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["spawn_opening"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions: [...crowdedCluster, roomyScout, hold()] },
      plan,
    );

    expect(decision.actionID).toBe("spawn:9001");
  });

  it("keeps attacking instead of retreating in a dominant one-on-one finish", () => {
    const observation = finishModeObservation();
    const legalActions: LegalAction[] = [
      {
        id: "retreat:late-attack",
        kind: "retreat",
        label: "Retreat from Rival",
        intent: { type: "cancel_attack", attackID: "late-attack" },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          attackID: "late-attack",
          targetID: "RIVAL001",
          targetName: "Rival",
          troops: 50_000,
        },
      },
      {
        id: "attack:RIVAL001:25",
        kind: "attack",
        label: "Attack Rival with 25%",
        intent: { type: "attack", targetID: "RIVAL001", troops: 250_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "RIVAL001",
          targetName: "Rival",
          troopPercentage: 0.25,
          relativeTroopRatio: 1.7,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:finish",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL001",
      rationale: "finish the last rival",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["win the last duel"],
      failureCriteria: ["stall"],
      preferredActionKinds: ["attack", "target_player", "embargo_all", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["emergency_survival", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:RIVAL001:25");
    expect(decision.reason).toContain("primary Attack Rival");
  });

  it("converts a large multi-rival lead with direct attacks before pressure-only actions", () => {
    const observation = dominantConversionObservation();
    const legalActions: LegalAction[] = [
      {
        id: "embargo_all:start",
        kind: "embargo_all",
        label: "Embargo everyone",
        intent: { type: "embargo_all", action: "start" },
        risk: { level: "low", score: 0.1 },
      },
      {
        id: "target:RIVAL001",
        kind: "target_player",
        label: "Target Rival",
        intent: { type: "targetPlayer", target: "RIVAL001" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL001" },
      },
      {
        id: "attack:RIVAL001:25",
        kind: "attack",
        label: "Attack Rival with 25%",
        intent: { type: "attack", targetID: "RIVAL001", troops: 250_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "RIVAL001",
          targetName: "Rival",
          troopPercentage: 0.25,
          relativeTroopRatio: 1.6,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:convert",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL001",
      rationale: "convert the map lead",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["finish rival"],
      failureCriteria: ["stall with signals"],
      preferredActionKinds: ["attack", "target_player", "embargo_all", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      tacticalSettings: { maxActionsPerDecision: 4 },
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:RIVAL001:25");
    expect(decision.selectedModules).toContain("combat_attack:combat");
    expect(decision.selectedModules).not.toContain("combat_pressure:combat");
  });

  it("reports why offered hostile attacks were blocked when pressure is selected", () => {
    const observation: AgentObservation = {
      ...activeObservation("pressure_rival"),
      ownState: {
        ...activeObservation("pressure_rival").ownState!,
        troops: 100_000,
        troopRatio: 0.25,
        tilesOwned: 8_000,
        tileShare: 0.2,
      },
      visiblePlayers: [
        {
          playerID: "RIVAL001",
          clientID: "RIVAL001",
          smallID: 2,
          name: "Rival",
          type: PlayerType.Nation,
          isAlive: true,
          isDisconnected: false,
          hasSpawned: true,
          troops: 180_000,
          maxTroops: 400_000,
          troopRatio: 0.45,
          gold: "20000",
          tilesOwned: 12_000,
          tileShare: 0.3,
          sharesBorder: true,
          isAllied: false,
          isFriendly: false,
          relation: Relation.Neutral,
          canAttack: true,
          canRequestAlliance: false,
          canDonateGold: false,
          canDonateTroops: false,
          canEmbargo: true,
          canStopEmbargo: false,
          canTarget: true,
          canBreakAlliance: false,
          canExtendAlliance: false,
          canRejectAlliance: false,
          hasEmbargoAgainst: false,
          outgoingAttack: false,
          incomingAttack: false,
          hasOutgoingAllianceRequest: false,
          hasIncomingAllianceRequest: false,
          relativeTroopRatio: 0.55,
        },
      ],
      combat: {
        ...activeObservation("pressure_rival").combat,
        ownTroops: 100_000,
        troopRatio: 0.25,
        borderedPlayerIDs: ["RIVAL001"],
        attackablePlayerIDs: ["RIVAL001"],
        weakestAttackableTargetID: "RIVAL001",
        strongestAttackableTargetID: "RIVAL001",
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL001:25",
        kind: "attack",
        label: "Attack Rival with 25%",
        intent: { type: "attack", targetID: "RIVAL001", troops: 25_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "RIVAL001",
          targetName: "Rival",
          troopPercentage: 0.25,
          relativeTroopRatio: 0.55,
        },
      },
      {
        id: "embargo:RIVAL001:start",
        kind: "embargo",
        label: "Embargo Rival",
        intent: { type: "embargo", targetID: "RIVAL001", action: "start" },
        risk: { level: "medium", score: 0.3 },
        metadata: { targetID: "RIVAL001", targetName: "Rival" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL001",
      rationale: "pressure while conserving troops",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["pressure rival"],
      failureCriteria: ["stall"],
      preferredActionKinds: ["attack", "embargo", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("embargo:RIVAL001:start");
    expect(decision.blockedHostileAttackSummary).toContain(
      "attack:RIVAL001:25",
    );
    expect(decision.blockedHostileAttackSummary).toContain(
      "attacking a stronger rival",
    );
  });

  it("avoids weak enemy transport loops when safer growth is legal", () => {
    const observation = leaderPressureObservation();
    const legalActions: LegalAction[] = [
      {
        id: "boat:777:20",
        kind: "boat",
        label: "Send transport to Leader",
        intent: { type: "boat", troops: 200_000, dst: 777 },
        risk: { level: "medium", score: 0.45 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          troops: 200_000,
          troopPercent: 20,
        },
      },
      {
        id: "boat_retreat:15",
        kind: "boat_retreat",
        label: "Retreat transport 15",
        intent: { type: "cancel_boat", unitID: 15 },
        risk: { level: "low", score: 0.15 },
        metadata: {
          unitID: 15,
          troops: 200_000,
        },
      },
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand",
        intent: { type: "attack", targetID: null, troops: 100_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:naval-loop",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "grow without wasting transports",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["expand safely"],
      failureCriteria: ["naval loop"],
      preferredActionKinds: ["boat", "attack", "boat_retreat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "naval", "emergency_survival"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "boat:777:20",
    );
    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "boat_retreat:15",
    );
    expect(decision.actionID).not.toBe("attack:RIVAL02:10");
  });

  it("uses player-targeted transports to reconnect with a last rival", async () => {
    const observation = navalConversionObservation();
    const legalActions: LegalAction[] = [
      {
        id: "boat:777:8",
        kind: "boat",
        label: "Send transport to Rival",
        intent: { type: "boat", troops: 120_000, dst: 777 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "RIVAL001",
          targetName: "Rival",
          targetTile: 777,
          troops: 120_000,
          troopPercent: 8,
          relativeTroopRatio: 2.1,
          navalInvasion: true,
        },
      },
      {
        id: "target:RIVAL001",
        kind: "target_player",
        label: "Target Rival",
        intent: { type: "targetPlayer", target: "RIVAL001" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL001" },
      },
      {
        id: "embargo_all:start",
        kind: "embargo_all",
        label: "Embargo all",
        intent: { type: "embargo_all", action: "start" },
        risk: { level: "medium", score: 0.4 },
      },
      hold(),
    ];
    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions },
      null,
    );
    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan.plan,
    );

    expect(plan.plan.objective).toBe("pressure_rival");
    expect(plan.plan.preferredActionKinds).toContain("boat");
    expect(decision.actionID).toBe("boat:777:8");
    expect(decision.selectedModules).toContain("naval:naval");
  });

  it("does not spam new transports while several invasions are already active", async () => {
    const observation: AgentObservation = {
      ...navalConversionObservation(),
      nonCombat: {
        ...navalConversionObservation().nonCombat,
        boatRetreatOptions: [
          {
            unitID: 1,
            tile: 10,
            targetTile: 20,
            troops: 100_000,
            legalReason: "transport active",
          },
          {
            unitID: 2,
            tile: 11,
            targetTile: 21,
            troops: 100_000,
            legalReason: "transport active",
          },
          {
            unitID: 3,
            tile: 12,
            targetTile: 22,
            troops: 100_000,
            legalReason: "transport active",
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat:777:8",
        kind: "boat",
        label: "Send transport to Rival",
        intent: { type: "boat", troops: 120_000, dst: 777 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "RIVAL001",
          targetName: "Rival",
          targetTile: 777,
          troops: 120_000,
          troopPercent: 8,
          relativeTroopRatio: 2.1,
          navalInvasion: true,
        },
      },
      {
        id: "target:RIVAL001",
        kind: "target_player",
        label: "Target Rival",
        intent: { type: "targetPlayer", target: "RIVAL001" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL001" },
      },
      hold(),
    ];
    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions },
      null,
    );
    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan.plan,
    );

    expect(decision.actionID).not.toBe("boat:777:8");
    expect(decision.actionID).toBe("target:RIVAL001");
  });

  it("explains transport-wait holds when an invasion is already active", async () => {
    const base = navalConversionObservation();
    const observation: AgentObservation = {
      ...base,
      nonCombat: {
        ...base.nonCombat,
        boatRetreatOptions: [
          {
            unitID: 1,
            tile: 10,
            targetTile: 20,
            troops: 100_000,
            legalReason: "transport active",
          },
          {
            unitID: 2,
            tile: 11,
            targetTile: 21,
            troops: 100_000,
            legalReason: "transport active",
          },
          {
            unitID: 3,
            tile: 12,
            targetTile: 22,
            troops: 100_000,
            legalReason: "transport active",
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat:777:8",
        kind: "boat",
        label: "Send transport to Rival",
        intent: { type: "boat", troops: 120_000, dst: 777 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "RIVAL001",
          targetName: "Rival",
          targetTile: 777,
          troops: 120_000,
          troopPercent: 8,
          relativeTroopRatio: 2.1,
          navalInvasion: true,
        },
      },
      hold(),
    ];
    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions },
      null,
    );
    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan.plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.reason).toContain("waiting for active transport to land");
  });

  it("pressures the current leader instead of donating to a non-leader ally", async () => {
    const observation = leaderPressureObservation();
    const legalActions: LegalAction[] = [
      {
        id: "donate_gold:ALLY001",
        kind: "donate_gold",
        label: "Donate gold to Ally",
        intent: { type: "donate_gold", recipient: "ALLY001", gold: 10_000 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          recipientID: "ALLY001",
          recipientName: "Ally",
        },
      },
      {
        id: "target:LEADER01",
        kind: "target_player",
        label: "Target Leader",
        intent: { type: "targetPlayer", target: "LEADER01" },
        risk: { level: "low", score: 0.1 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
        },
      },
      {
        id: "attack:LEADER01:25",
        kind: "attack",
        label: "Attack Leader with 25%",
        intent: { type: "attack", targetID: "LEADER01", troops: 250_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          troopPercentage: 0.25,
          relativeTroopRatio: 1.45,
        },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions },
      null,
    );
    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan.plan,
    );

    expect(plan.plan.objective).toBe("pressure_rival");
    expect(plan.plan.targetPlayerId).toBe("LEADER01");
    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "donate_gold:ALLY001",
    );
    expect(["attack:LEADER01:25", "target:LEADER01"]).toContain(
      decision.actionID,
    );
  });

  it("keeps hostile actions focused on the active plan target", () => {
    const observation = leaderPressureObservation();
    const legalActions: LegalAction[] = [
      {
        id: "attack:LEADER01:25",
        kind: "attack",
        label: "Attack Leader with 25%",
        intent: { type: "attack", targetID: "LEADER01", troops: 250_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          troopPercentage: 0.25,
          relativeTroopRatio: 1.45,
        },
      },
      {
        id: "attack:RIVAL02:25",
        kind: "attack",
        label: "Attack Rival with 25%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 250_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          troopPercentage: 0.25,
          relativeTroopRatio: 1.8,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:focus",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "focus the leader",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["pressure leader"],
      failureCriteria: ["split fire"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:LEADER01:25");
  });

  it("falls back to hold instead of forbidden low-value pressure while surviving", () => {
    const observation = leaderPressureObservation();
    const legalActions: LegalAction[] = [
      {
        id: "embargo_all:start",
        kind: "embargo_all",
        label: "Embargo all",
        intent: { type: "embargo_all", action: "start" },
        risk: { level: "medium", score: 0.5 },
      },
      {
        id: "quick_chat:LEADER01:attack",
        kind: "quick_chat",
        label: "Send quick chat to Leader",
        intent: {
          type: "quick_chat",
          recipient: "LEADER01",
          quickChatKey: "attack.attack",
        },
        risk: { level: "low", score: 0.1 },
        metadata: {
          recipientID: "LEADER01",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survive",
      objective: "survive",
      targetPlayerId: null,
      rationale: "avoid waste while under pressure",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["stay alive"],
      failureCriteria: ["waste action"],
      preferredActionKinds: ["retreat", "build", "hold"],
      forbiddenActionKinds: ["attack", "embargo", "embargo_all", "nuke"],
      enabledModules: ["emergency_survival", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.actionIDs).toBeUndefined();
  });

  it("uses productive neutral expansion fallback instead of stalling on hold", () => {
    const observation = leaderPressureObservation();
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand into neutral land with 10%",
        intent: { type: "attack", targetID: null, troops: 100_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      {
        id: "attack:LEADER01:25",
        kind: "attack",
        label: "Attack Leader with 25%",
        intent: { type: "attack", targetID: "LEADER01", troops: 250_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          troopPercentage: 0.25,
          relativeTroopRatio: 0.7,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "pressure the leader but avoid bad attacks",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["pressure leader"],
      failureCriteria: ["stall"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.reason).toContain("neutral_expansion");
  });

  it("does not treat support as a productive fallback during pressure conversion", () => {
    const observation = leaderPressureObservation();
    const legalActions: LegalAction[] = [
      {
        id: "donate_gold:ALLY001",
        kind: "donate_gold",
        label: "Donate gold to Ally",
        intent: { type: "donate_gold", recipient: "ALLY001", gold: 1000 },
        risk: { level: "low", score: 0.2 },
        metadata: {
          recipientID: "ALLY001",
          recipientName: "Ally",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "convert a lead into pressure",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["pressure leader"],
      failureCriteria: ["feed rival"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.reason).toContain("no map-progress action is legal");
  });

  it("uses gold support for a hard-nation buffer when no conquest action is legal", () => {
    const base = leaderPressureObservation();
    const bufferLeader: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      tileShare: 0.34,
      canAttack: false,
      canDonateGold: true,
      canDonateTroops: true,
      incomingAttack: true,
      outgoingAttack: false,
      relativeTroopRatio: 1.35,
    };
    const rival: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      playerID: "RIVAL003",
      clientID: "RIVAL003",
      smallID: 4,
      name: "Rival Nation",
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: false,
      canDonateGold: true,
      canDonateTroops: true,
      tileShare: 0.22,
      troops: 900_000,
      maxTroops: 1_400_000,
      relativeTroopRatio: 1.6,
    };
    const thirdNation: AgentVisiblePlayer = {
      ...rival,
      playerID: "RIVAL004",
      clientID: "RIVAL004",
      smallID: 5,
      name: "Third Nation",
      tileShare: 0.16,
    };
    const observation: AgentObservation = {
      ...base,
      visiblePlayers: [bufferLeader, rival, thirdNation],
      combat: {
        ...base.combat,
        attackablePlayerIDs: [],
        borderedPlayerIDs: ["LEADER01"],
        canExpandIntoNeutral: false,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      nonCombat: {
        ...base.nonCombat,
        supportOptions: [
          {
            recipientID: "LEADER01",
            recipientName: "Leader",
            canDonateGold: true,
            canDonateTroops: true,
            suggestedGold: 10_000,
            suggestedTroops: 80_000,
            legalReasons: ["test support"],
          },
          {
            recipientID: "RIVAL003",
            recipientName: "Rival Nation",
            canDonateGold: true,
            canDonateTroops: true,
            suggestedGold: 10_000,
            suggestedTroops: 80_000,
            legalReasons: ["test support"],
          },
        ],
      },
      endgame: {
        winner: null,
        leaderID: "LEADER01",
        leaderName: "Leader",
        leaderTileShare: 0.34,
        ownTileShare: 0.27,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "donate_troops:LEADER01",
        kind: "donate_troops",
        label: "Donate troops to Leader",
        intent: {
          type: "donate_troops",
          recipient: "LEADER01",
          troops: 80_000,
        },
        risk: { level: "medium", score: 0.3 },
        metadata: { recipientID: "LEADER01", recipientName: "Leader" },
      },
      {
        id: "donate_gold:LEADER01",
        kind: "donate_gold",
        label: "Donate gold to Leader",
        intent: { type: "donate_gold", recipient: "LEADER01", gold: 10_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { recipientID: "LEADER01", recipientName: "Leader" },
      },
      {
        id: "embargo_all:start",
        kind: "embargo_all",
        label: "Embargo all",
        intent: { type: "embargo_all", action: "start" },
        risk: { level: "medium", score: 0.3 },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:buffer-support",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "support the buffer while waiting for a front",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["slow snowball"],
      failureCriteria: ["idle while leader is eaten"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("donate_gold:LEADER01");
  });

  it("explains attack-safety holds when hostile attacks are blocked", () => {
    const observation = leaderPressureObservation();
    const legalActions: LegalAction[] = [
      {
        id: "attack:LEADER01:25",
        kind: "attack",
        label: "Attack Leader with 25%",
        intent: { type: "attack", targetID: "LEADER01", troops: 250_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          troopPercentage: 0.25,
          relativeTroopRatio: 0.65,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "pressure safely",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["pressure leader"],
      failureCriteria: ["bad attack"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.reason).toContain("hostile attacks offered but blocked");
    expect(decision.blockedHostileAttackSummary).toContain(
      "attack:LEADER01:25",
    );
  });

  it("prioritizes survival over leader pressure during incoming attacks", async () => {
    const observation: AgentObservation = {
      ...leaderPressureObservation(),
      combat: {
        ...leaderPressureObservation().combat,
        incomingAttackPlayerIDs: ["LEADER01"],
        incomingAttacks: [
          {
            attackID: "incoming-1",
            targetID: "LEADER01",
            targetName: "Leader",
            troops: 250_000,
            retreating: false,
            sourceTile: null,
            borderSize: 20,
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "retreat:bad-war",
        kind: "retreat",
        label: "Retreat from Leader",
        intent: { type: "cancel_attack", attackID: "bad-war" },
        risk: { level: "low", score: 0.2 },
        metadata: {
          attackID: "bad-war",
          targetID: "LEADER01",
          troops: 120_000,
        },
      },
      {
        id: "attack:LEADER01:25",
        kind: "attack",
        label: "Attack Leader with 25%",
        intent: { type: "attack", targetID: "LEADER01", troops: 250_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          troopPercentage: 0.25,
          relativeTroopRatio: 1.45,
        },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions },
      null,
    );
    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan.plan,
    );

    expect(plan.plan.objective).toBe("survive");
    expect(decision.actionID).toBe("retreat:bad-war");
    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "attack:LEADER01:25",
    );
  });

  it("uses a fortify plan when strategic state marks defense as urgent", async () => {
    const observation: AgentObservation = {
      ...leaderPressureObservation(),
      strategic: {
        ...leaderPressureObservation().strategic,
        priority: "build_defense",
        urgency: "high",
        recommendedActionKinds: ["build", "alliance_request", "hold"],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:LEADER01:25",
        kind: "attack",
        label: "Attack Leader with 25%",
        intent: { type: "attack", targetID: "LEADER01", troops: 250_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          troopPercentage: 0.25,
          relativeTroopRatio: 1.45,
        },
      },
      {
        id: "build:DefensePost:20",
        kind: "build",
        label: "Build Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 20 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "defensive",
          unit: UnitType.DefensePost,
          defensiveValue: 0.8,
          frontierValue: 0.9,
          nearbyEnemyCount: 2,
          hostileBorderDistance: 2,
          buildPlacementReason: "Defense Post covers an active frontier.",
        },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions },
      null,
    );
    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan.plan,
    );

    expect(plan.plan.objective).toBe("fortify_border");
    expect(decision.actionID).toBe("build:DefensePost:20");
    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "attack:LEADER01:25",
    );
  });

  it("honors urgent fortify plans before hard-nation pressure overrides", () => {
    const base = leaderPressureObservation();
    const rival: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "RIVAL02",
      clientID: "RIVAL02",
      smallID: 4,
      name: "Rival",
      troops: 240_000,
      maxTroops: 900_000,
      troopRatio: 0.27,
      tilesOwned: 15_000,
      tileShare: 0.13,
      sharesBorder: true,
      relativeTroopRatio: 2.7,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 650_000,
              troopRatio: 0.32,
              tilesOwned: 20_263,
              tileShare: 0.19,
              unitCounts: {
                [UnitType.City]: 0,
                [UnitType.Factory]: 0,
                [UnitType.DefensePost]: 0,
              },
            },
      visiblePlayers: [base.visiblePlayers[0]!, rival, base.visiblePlayers[1]!],
      combat: {
        ...base.combat,
        ownTroops: 650_000,
        troopRatio: 0.32,
        borderedPlayerIDs: ["RIVAL02"],
        attackablePlayerIDs: ["RIVAL02"],
        weakestAttackableTargetID: "RIVAL02",
        strongestAttackableTargetID: "RIVAL02",
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
        recommendedActionKinds: ["build", "retreat", "hold"],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:25",
        kind: "attack",
        label: "Attack Rival with 25%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 162_500 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          targetTiles: 15_000,
          targetTileShare: 0.13,
          targetTroops: 240_000,
          troopPercentage: 0.25,
          relativeTroopRatio: 2.7,
        },
      },
      {
        id: "build:Defense Post:75689",
        kind: "build",
        label: "Build Defense Post",
        intent: {
          type: "build_unit",
          unit: UnitType.DefensePost,
          tile: 75_689,
        },
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "defensive",
          unit: "Defense Post",
          isBorderBuild: true,
          hostileBorderDistance: 0,
          nearbyEnemyCount: 1,
          frontierValue: 0.92,
          defensiveValue: 0.88,
          buildPlacementReason: "Defense Post covers the active frontier.",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:urgent-fortify",
      objective: "fortify_border",
      targetPlayerId: "RIVAL02",
      rationale: "build the frontier post before trading more troops",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["stabilize border"],
      failureCriteria: ["ignore build"],
      preferredActionKinds: ["build", "retreat", "hold", "attack"],
      forbiddenActionKinds: [],
      enabledModules: ["emergency_survival", "defense", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("build:Defense Post:75689");
    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "attack:RIVAL02:25",
    );
  });

  it("uses a planned defensive build instead of holding when pressure is blocked", () => {
    const base = leaderPressureObservation();
    const rival: AgentVisiblePlayer = {
      ...base.visiblePlayers[0]!,
      playerID: "RIVAL02",
      clientID: "RIVAL02",
      smallID: 4,
      name: "Rival",
      troops: 500_000,
      maxTroops: 900_000,
      troopRatio: 0.56,
      tilesOwned: 18_000,
      tileShare: 0.16,
      sharesBorder: true,
      relativeTroopRatio: 0.72,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 360_000,
              troopRatio: 0.31,
              tilesOwned: 12_000,
              tileShare: 0.11,
              unitCounts: {
                [UnitType.City]: 0,
                [UnitType.Factory]: 0,
                [UnitType.DefensePost]: 0,
              },
            },
      visiblePlayers: [rival, base.visiblePlayers[1]!],
      combat: {
        ...base.combat,
        ownTroops: 360_000,
        troopRatio: 0.31,
        borderedPlayerIDs: ["RIVAL02"],
        attackablePlayerIDs: ["RIVAL02"],
        weakestAttackableTargetID: "RIVAL02",
        strongestAttackableTargetID: "RIVAL02",
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:25",
        kind: "attack",
        label: "Attack Rival with 25%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 90_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          targetTiles: 18_000,
          targetTileShare: 0.16,
          targetTroops: 500_000,
          troopPercentage: 0.25,
          relativeTroopRatio: 0.72,
        },
      },
      {
        id: "build:Defense Post:103133",
        kind: "build",
        label: "Build Defense Post",
        intent: {
          type: "build_unit",
          unit: UnitType.DefensePost,
          tile: 103_133,
        },
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "defensive",
          unit: "Defense Post",
          isBorderBuild: true,
          hostileBorderDistance: 0,
          nearbyEnemyCount: 1,
          frontierValue: 0.8,
          defensiveValue: 0.78,
          buildPlacementReason:
            "Defense Post covers the stalled pressure frontier.",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure-with-build",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL02",
      rationale: "pressure if safe, otherwise harden the frontier",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["gain safe pressure"],
      failureCriteria: ["idle while build is legal"],
      preferredActionKinds: ["attack", "target_player", "build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "defense"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("build:Defense Post:103133");
  });

  it("does not fall back to combat when a fortify plan has no useful defense action", () => {
    const observation = leaderPressureObservation();
    const legalActions: LegalAction[] = [
      {
        id: "attack:LEADER01:25",
        kind: "attack",
        label: "Attack Leader with 25%",
        intent: { type: "attack", targetID: "LEADER01", troops: 250_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          troopPercentage: 0.25,
          relativeTroopRatio: 1.45,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:fortify-no-defense",
      objective: "fortify_border",
      targetPlayerId: null,
      rationale: "fortify but no fortify action is legal",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["avoid bad pressure"],
      failureCriteria: ["combat fallback"],
      preferredActionKinds: ["retreat", "build", "alliance_request", "hold"],
      forbiddenActionKinds: [
        "embargo",
        "embargo_all",
        "break_alliance",
        "nuke",
      ],
      enabledModules: ["emergency_survival", "defense", "economy", "diplomacy"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
  });

  it("keeps early turns focused on neutral expansion instead of pressure markers", () => {
    const observation = earlyExpansionObservation();
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand",
        intent: { type: "attack", targetID: null, troops: 80_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.08 },
      },
      {
        id: "embargo:RIVAL02",
        kind: "embargo",
        label: "Embargo Rival",
        intent: { type: "embargo", targetID: "RIVAL02", action: "start" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL02" },
      },
      {
        id: "target:RIVAL02",
        kind: "target_player",
        label: "Target Rival",
        intent: { type: "targetPlayer", target: "RIVAL02" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL02" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:opening",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "take safe land before pressure noise",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["grow land"],
      failureCriteria: ["dilute opening"],
      preferredActionKinds: ["attack", "embargo", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "embargo:RIVAL02",
    );
    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "target:RIVAL02",
    );
  });

  it("keeps early resources for scaling instead of donating", () => {
    const observation = earlyExpansionObservation();
    const legalActions: LegalAction[] = [
      {
        id: "donate_gold:ALLY001",
        kind: "donate_gold",
        label: "Donate gold to Ally",
        intent: { type: "donate_gold", recipient: "ALLY001", gold: 10_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { recipientID: "ALLY001" },
      },
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand",
        intent: { type: "attack", targetID: null, troops: 80_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.08 },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:no-donate-opening",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "use resources locally first",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["grow land"],
      failureCriteria: ["over-support"],
      preferredActionKinds: ["attack", "donate_gold", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "diplomacy"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "donate_gold:ALLY001",
    );
  });

  it("does not break non-leader alliances as pressure filler", () => {
    const observation = leaderPressureObservation();
    const legalActions: LegalAction[] = [
      {
        id: "break_alliance:ALLY001",
        kind: "break_alliance",
        label: "Break alliance with Ally",
        intent: { type: "breakAlliance", recipient: "ALLY001" },
        risk: { level: "medium", score: 0.3 },
        metadata: { recipientID: "ALLY001" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:no-pointless-break",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "pressure the real leader",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["pressure leader"],
      failureCriteria: ["shatter useful alliances"],
      preferredActionKinds: ["break_alliance", "attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
  });

  it("keeps leader alliances in multi-rival games until the endgame", () => {
    const base = leaderPressureObservation();
    const alliedLeader: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      canAttack: false,
      canBreakAlliance: true,
      canExtendAlliance: true,
      relativeTroopRatio: 1.15,
    };
    const thirdNation: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      playerID: "RIVAL003",
      clientID: "RIVAL003",
      smallID: 4,
      name: "Third Nation",
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: false,
      canBreakAlliance: false,
      canExtendAlliance: false,
      tileShare: 0.18,
      relativeTroopRatio: 1.2,
    };
    const observation: AgentObservation = {
      ...base,
      visiblePlayers: [alliedLeader, thirdNation],
      combat: {
        ...base.combat,
        attackablePlayerIDs: [],
        borderedPlayerIDs: ["LEADER01"],
        canExpandIntoNeutral: false,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "break_alliance:LEADER01",
        kind: "break_alliance",
        label: "Break alliance with Leader",
        intent: { type: "breakAlliance", recipient: "LEADER01" },
        risk: { level: "high", score: 0.8 },
        metadata: { recipientID: "LEADER01", targetID: "LEADER01" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:no-multirival-break",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "pressure leader without opening a losing front",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["pressure leader"],
      failureCriteria: ["shatter useful alliances"],
      preferredActionKinds: ["break_alliance", "attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.reason).toContain("primary Hold");
  });

  it("breaks a materially strong hard-nation leader alliance while troop parity can still stop the snowball", () => {
    const base = leaderPressureObservation();
    const alliedLeader: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      tileShare: 0.31,
      tilesOwned: 33_000,
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      canAttack: false,
      canBreakAlliance: true,
      canExtendAlliance: true,
      relativeTroopRatio: 1.35,
    };
    const bufferNation: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      playerID: "BUFFER01",
      clientID: "BUFFER01",
      smallID: 4,
      name: "Buffer Nation",
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      canAttack: false,
      canBreakAlliance: true,
      canExtendAlliance: true,
      tileShare: 0.24,
      relativeTroopRatio: 1.6,
    };
    const thirdNation: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      playerID: "RIVAL003",
      clientID: "RIVAL003",
      smallID: 5,
      name: "Third Nation",
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: false,
      canBreakAlliance: false,
      canExtendAlliance: false,
      tileShare: 0.18,
      relativeTroopRatio: 1.4,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 1_550_000,
              maxTroops: 1_900_000,
              troopRatio: 0.82,
            },
      visiblePlayers: [alliedLeader, bufferNation, thirdNation],
      combat: {
        ...base.combat,
        ownTroops: 1_550_000,
        maxTroops: 1_900_000,
        troopRatio: 0.82,
        attackablePlayerIDs: [],
        borderedPlayerIDs: ["LEADER01"],
        canExpandIntoNeutral: false,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "LEADER01",
        leaderName: "Leader",
        leaderTileShare: 0.31,
        ownTileShare: 0.27,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "break_alliance:LEADER01",
        kind: "break_alliance",
        label: "Break alliance with Leader",
        intent: { type: "breakAlliance", recipient: "LEADER01" },
        risk: { level: "high", score: 0.8 },
        metadata: { recipientID: "LEADER01", targetID: "LEADER01" },
      },
      {
        id: "embargo_all:start",
        kind: "embargo_all",
        label: "Embargo all",
        intent: { type: "embargo_all", action: "start" },
        risk: { level: "medium", score: 0.3 },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:preempt-leader",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "intervene before the leader snowballs",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["open leader front"],
      failureCriteria: ["wait out a losing alliance"],
      preferredActionKinds: ["break_alliance", "attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("break_alliance:LEADER01");
    expect(decision.reason).not.toContain(
      "multi-rival matches should keep alliances",
    );
  });

  it("overrides a stale focus target to break a hard-nation runaway alliance", () => {
    const base = leaderPressureObservation();
    const fadingLeader: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      tileShare: 0.25,
      tilesOwned: 28_000,
      troops: 420_000,
      outgoingAttack: false,
      incomingAttack: true,
      canAttack: false,
      canBreakAlliance: false,
      relativeTroopRatio: 1.6,
    };
    const runawayAlly: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      playerID: "RUNAWAY01",
      clientID: "RUNAWAY01",
      smallID: 4,
      name: "Runaway Nation",
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      canAttack: false,
      canBreakAlliance: true,
      canExtendAlliance: true,
      tileShare: 0.31,
      tilesOwned: 33_000,
      troops: 850_000,
      outgoingAttack: true,
      incomingAttack: false,
      relativeTroopRatio: 1.35,
    };
    const staleFocusAlly: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      playerID: "STALE01",
      clientID: "STALE01",
      smallID: 5,
      name: "Stale Focus",
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      canAttack: false,
      canBreakAlliance: true,
      canExtendAlliance: true,
      tileShare: 0.16,
      tilesOwned: 17_000,
      troops: 520_000,
      relativeTroopRatio: 1.6,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 1_550_000,
              maxTroops: 1_900_000,
              troopRatio: 0.82,
            },
      visiblePlayers: [fadingLeader, runawayAlly, staleFocusAlly],
      combat: {
        ...base.combat,
        ownTroops: 1_550_000,
        maxTroops: 1_900_000,
        troopRatio: 0.82,
        attackablePlayerIDs: [],
        borderedPlayerIDs: ["RUNAWAY01", "STALE01"],
        canExpandIntoNeutral: false,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "RUNAWAY01",
        leaderName: "Runaway Nation",
        leaderTileShare: 0.31,
        ownTileShare: 0.27,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "break_alliance:RUNAWAY01",
        kind: "break_alliance",
        label: "Break alliance with Runaway Nation",
        intent: { type: "breakAlliance", recipient: "RUNAWAY01" },
        risk: { level: "high", score: 0.8 },
        metadata: { recipientID: "RUNAWAY01", targetID: "RUNAWAY01" },
      },
      {
        id: "break_alliance:STALE01",
        kind: "break_alliance",
        label: "Break alliance with Stale Focus",
        intent: { type: "breakAlliance", recipient: "STALE01" },
        risk: { level: "high", score: 0.8 },
        metadata: { recipientID: "STALE01", targetID: "STALE01" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:stale-focus-break",
      objective: "pressure_rival",
      targetPlayerId: "STALE01",
      rationale: "old focus target has not refreshed yet",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["intervene against runaway"],
      failureCriteria: ["wait out a losing alliance"],
      preferredActionKinds: ["break_alliance", "attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("break_alliance:RUNAWAY01");
    expect(decision.reason).toContain(
      "primary Break alliance with Runaway Nation",
    );
  });

  it("breaks a weak frontier alliance to race hard nations through conquest", () => {
    const base = leaderPressureObservation();
    const leader: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      tileShare: 0.34,
      tilesOwned: 36_000,
      troops: 600_000,
      canAttack: false,
      relativeTroopRatio: 1.5,
    };
    const strongChallenger: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      playerID: "CHALLENGER01",
      clientID: "CHALLENGER01",
      smallID: 4,
      name: "Strong Challenger",
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      canAttack: false,
      canBreakAlliance: true,
      canExtendAlliance: true,
      tileShare: 0.25,
      tilesOwned: 26_000,
      troops: 760_000,
      relativeTroopRatio: 1.25,
    };
    const weakFrontier: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      playerID: "WEAK01",
      clientID: "WEAK01",
      smallID: 5,
      name: "Weak Frontier",
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      sharesBorder: true,
      canAttack: false,
      canBreakAlliance: true,
      canExtendAlliance: true,
      tileShare: 0.14,
      tilesOwned: 14_000,
      troops: 380_000,
      relativeTroopRatio: 2.2,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 1_350_000,
              maxTroops: 1_800_000,
              troopRatio: 0.75,
            },
      visiblePlayers: [leader, strongChallenger, weakFrontier],
      combat: {
        ...base.combat,
        ownTroops: 1_350_000,
        maxTroops: 1_800_000,
        troopRatio: 0.75,
        attackablePlayerIDs: [],
        borderedPlayerIDs: ["CHALLENGER01", "WEAK01"],
        canExpandIntoNeutral: false,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "LEADER01",
        leaderName: "Leader",
        leaderTileShare: 0.34,
        ownTileShare: 0.27,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "break_alliance:CHALLENGER01",
        kind: "break_alliance",
        label: "Break alliance with Strong Challenger",
        intent: { type: "breakAlliance", recipient: "CHALLENGER01" },
        risk: { level: "high", score: 0.8 },
        metadata: {
          recipientID: "CHALLENGER01",
          targetID: "CHALLENGER01",
        },
      },
      {
        id: "break_alliance:WEAK01",
        kind: "break_alliance",
        label: "Break alliance with Weak Frontier",
        intent: { type: "breakAlliance", recipient: "WEAK01" },
        risk: { level: "high", score: 0.8 },
        metadata: { recipientID: "WEAK01", targetID: "WEAK01" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:weak-frontier-break",
      objective: "pressure_rival",
      targetPlayerId: "CHALLENGER01",
      rationale: "convert weak frontier land before the leader race ends",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["open weak frontier"],
      failureCriteria: ["stall behind alliances"],
      preferredActionKinds: ["break_alliance", "attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("break_alliance:WEAK01");
    expect(decision.reason).toContain(
      "primary Break alliance with Weak Frontier",
    );
  });

  it("follows through on the frontier opened by a recent alliance break", () => {
    const base = leaderPressureObservation();
    const weakFrontier: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      playerID: "WEAK01",
      clientID: "WEAK01",
      smallID: 4,
      name: "Weak Frontier",
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: true,
      canRequestAlliance: true,
      canBreakAlliance: false,
      tileShare: 0.14,
      tilesOwned: 14_000,
      troops: 380_000,
      relativeTroopRatio: 2.1,
    };
    const heavyweight: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      playerID: "HEAVY01",
      clientID: "HEAVY01",
      name: "Heavyweight",
      tileShare: 0.28,
      tilesOwned: 29_000,
      troops: 520_000,
      canAttack: true,
      relativeTroopRatio: 1.4,
    };
    const thirdNation: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      playerID: "THIRD01",
      clientID: "THIRD01",
      smallID: 5,
      name: "Third Nation",
      tileShare: 0.2,
      tilesOwned: 21_000,
      troops: 640_000,
      canAttack: false,
      relativeTroopRatio: 1.2,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 1_100_000,
              maxTroops: 1_800_000,
              troopRatio: 0.61,
            },
      visiblePlayers: [heavyweight, weakFrontier, thirdNation],
      combat: {
        ...base.combat,
        ownTroops: 1_100_000,
        maxTroops: 1_800_000,
        troopRatio: 0.61,
        attackablePlayerIDs: ["HEAVY01", "WEAK01"],
        borderedPlayerIDs: ["HEAVY01", "WEAK01"],
        canExpandIntoNeutral: false,
      },
      memory: {
        ...base.memory,
        recentActions: [
          {
            sequence: 1,
            actionID: "break_alliance",
            actionKind: "break_alliance",
            reason: "opened weak frontier",
            accepted: true,
          },
        ],
      },
      endgame: {
        winner: null,
        leaderID: "HEAVY01",
        leaderName: "Heavyweight",
        leaderTileShare: 0.28,
        ownTileShare: 0.27,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:HEAVY01:25",
        kind: "attack",
        label: "Attack Heavyweight with 25%",
        intent: { type: "attack", targetID: "HEAVY01", troops: 225_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "HEAVY01",
          targetName: "Heavyweight",
          troopPercentage: 0.25,
          relativeTroopRatio: 1.4,
        },
      },
      {
        id: "attack:WEAK01:25",
        kind: "attack",
        label: "Attack Weak Frontier with 25%",
        intent: { type: "attack", targetID: "WEAK01", troops: 225_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "WEAK01",
          targetName: "Weak Frontier",
          troopPercentage: 0.25,
          relativeTroopRatio: 2.1,
        },
      },
      {
        id: "alliance:WEAK01",
        kind: "alliance_request",
        label: "Request alliance with Weak Frontier",
        intent: { type: "allianceRequest", recipient: "WEAK01" },
        risk: { level: "low", score: 0.1 },
        metadata: { recipientID: "WEAK01", targetID: "WEAK01" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:follow-break",
      objective: "pressure_rival",
      targetPlayerId: "HEAVY01",
      rationale: "stale focus still points at heavyweight",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["finish opened frontier"],
      failureCriteria: ["switch away from opened front"],
      preferredActionKinds: ["attack", "alliance_request", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "diplomacy"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:WEAK01:25");
    expect(decision.reason).not.toContain(
      "do not re-ally with the active conquest target",
    );
  });

  it("breaks a rising hard-nation challenger before it overtakes the leader", () => {
    const base = leaderPressureObservation();
    const threatenedLeader: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      tileShare: 0.32,
      incomingAttack: true,
      outgoingAttack: false,
      canAttack: false,
      canBreakAlliance: true,
      relativeTroopRatio: 1.4,
    };
    const alliedChallenger: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      playerID: "CHALLENGER01",
      clientID: "CHALLENGER01",
      smallID: 4,
      name: "Challenger Nation",
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      canAttack: false,
      canBreakAlliance: true,
      canExtendAlliance: true,
      outgoingAttack: true,
      incomingAttack: false,
      tileShare: 0.3,
      tilesOwned: 33_000,
      troops: 760_000,
      relativeTroopRatio: 1.55,
    };
    const thirdNation: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      playerID: "RIVAL003",
      clientID: "RIVAL003",
      smallID: 5,
      name: "Third Nation",
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: false,
      canBreakAlliance: false,
      canExtendAlliance: false,
      tileShare: 0.16,
      relativeTroopRatio: 1.7,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 1_550_000,
              maxTroops: 1_900_000,
              troopRatio: 0.82,
            },
      visiblePlayers: [threatenedLeader, alliedChallenger, thirdNation],
      combat: {
        ...base.combat,
        ownTroops: 1_550_000,
        maxTroops: 1_900_000,
        troopRatio: 0.82,
        attackablePlayerIDs: [],
        borderedPlayerIDs: ["LEADER01", "CHALLENGER01"],
        canExpandIntoNeutral: false,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "LEADER01",
        leaderName: "Leader",
        leaderTileShare: 0.32,
        ownTileShare: 0.27,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "break_alliance:CHALLENGER01",
        kind: "break_alliance",
        label: "Break alliance with Challenger Nation",
        intent: { type: "breakAlliance", recipient: "CHALLENGER01" },
        risk: { level: "high", score: 0.8 },
        metadata: {
          recipientID: "CHALLENGER01",
          targetID: "CHALLENGER01",
        },
      },
      {
        id: "embargo_all:start",
        kind: "embargo_all",
        label: "Embargo all",
        intent: { type: "embargo_all", action: "start" },
        risk: { level: "medium", score: 0.3 },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:preempt-challenger",
      objective: "pressure_rival",
      targetPlayerId: "CHALLENGER01",
      rationale: "intervene before the challenger snowballs",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["open challenger front"],
      failureCriteria: ["wait out a losing alliance"],
      preferredActionKinds: ["break_alliance", "attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("break_alliance:CHALLENGER01");
    expect(decision.reason).not.toContain("do not break non-leader alliances");
  });

  it("avoids reserve-draining attacks when expansion is safer", () => {
    const observation = reserveDisciplineObservation();
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:40",
        kind: "attack",
        label: "Attack Rival with 40%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 160_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          troopPercentage: 0.4,
          relativeTroopRatio: 1.2,
        },
      },
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand",
        intent: { type: "attack", targetID: null, troops: 40_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:reserve",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "do not spend reserves on marginal attacks",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["keep reserve while growing"],
      failureCriteria: ["feed troops"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "attack:RIVAL02:40",
    );
  });

  it("uses small probes instead of large attacks in multi-rival openings", () => {
    const observation = multiRivalPressureObservation();
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Attack Rival with 10%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 40_000 },
        risk: { level: "medium", score: 0.25 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          troopPercentage: 0.1,
          relativeTroopRatio: 1.8,
        },
      },
      {
        id: "attack:RIVAL02:25",
        kind: "attack",
        label: "Attack Rival with 25%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 100_000 },
        risk: { level: "medium", score: 0.32 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          troopPercentage: 0.25,
          relativeTroopRatio: 1.8,
        },
      },
      {
        id: "attack:RIVAL02:40",
        kind: "attack",
        label: "Attack Rival with 40%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 160_000 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          troopPercentage: 0.4,
          relativeTroopRatio: 1.8,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:probe",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL02",
      rationale: "probe without overcommitting",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["pressure rival"],
      failureCriteria: ["overcommit"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:RIVAL02:10");
    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "attack:RIVAL02:25",
    );
    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "attack:RIVAL02:40",
    );
  });

  it("keeps taking neutral land under stronger border pressure when no attack is incoming", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 900_000,
              tileShare: 0.32,
            },
      visiblePlayers: base.visiblePlayers.map((player, index) =>
        index === 0
          ? {
              ...player,
              troops: 1_350_000,
              relativeTroopRatio: 0.67,
              canAttack: true,
              sharesBorder: true,
            }
          : player,
      ),
      combat: {
        ...base.combat,
        ownTroops: 900_000,
        attackablePlayerIDs: ["RIVAL02"],
        borderedPlayerIDs: ["RIVAL02"],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      endgame: {
        ...base.endgame!,
        ownTileShare: 0.32,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand neutral land",
        intent: { type: "attack", targetID: null, troops: 90_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      {
        id: "build:Defense Post:10",
        kind: "build",
        label: "Build Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 10 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "defensive",
          unit: "Defense Post",
          isBorderBuild: true,
          hostileBorderDistance: 0,
          nearbyEnemyCount: 1,
          frontierValue: 1,
          defensiveValue: 1,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:stabilize",
      objective: "fortify_border",
      targetPlayerId: "RIVAL02",
      rationale: "stabilize against stronger border rival",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["stop losing frontier"],
      failureCriteria: ["waste troops"],
      preferredActionKinds: ["build", "attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["defense", "expansion"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic", {
      settings: { territoryFirstNeutralLandEnabled: true },
    }).decide({ observation, legalActions }, plan);

    expect(decision.actionID).toBe("expand:terra-nullius:10");
  });

  it("preserves troops instead of neutral expanding into a heavy incoming attack", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1400,
      tick: 1400,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 520_000,
              maxTroops: 900_000,
              troopRatio: 0.58,
              tilesOwned: 12_000,
              tileShare: 0.12,
            },
      combat: {
        ...base.combat,
        ownTroops: 520_000,
        maxTroops: 900_000,
        troopRatio: 0.58,
        incomingAttackPlayerIDs: ["RIVAL02"],
        incomingAttacks: [
          {
            attackID: "incoming-rival",
            targetID: "RIVAL02",
            targetName: "Rival",
            troops: 280_000,
            retreating: false,
            sourceTile: null,
            borderSize: 18,
          },
        ],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      endgame: {
        ...base.endgame!,
        ownTileShare: 0.12,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand neutral land",
        intent: { type: "attack", targetID: null, troops: 104_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.2 },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:incoming-preserve",
      objective: "expand_territory",
      turnIntent: "growth",
      targetPlayerId: null,
      rationale: "avoid spending reserves while an incoming attack is landing",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["preserve troops"],
      failureCriteria: ["over-expand under attack"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "emergency_survival"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
  });

  it("keeps neutral expansion ahead of bordered pressure while land is still legal", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      memory: {
        ...base.memory,
        recentExpansionCount: 3,
        repeatedActionKind: "attack",
        repeatedActionCount: 3,
      },
      objective:
        base.objective === null
          ? null
          : {
              ...base.objective,
              kind: "pressure_rival",
              preferredActionKinds: ["attack", "target_player", "hold"],
            },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand neutral land",
        intent: { type: "attack", targetID: null, troops: 50_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Probe Rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 50_000 },
        risk: { level: "medium", score: 0.5 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          relativeTroopRatio: 0.82,
          troopPercentage: 0.1,
        },
      },
      {
        id: "target:RIVAL02",
        kind: "target_player",
        label: "Mark Rival as target",
        intent: { type: "targetPlayer", target: "RIVAL02" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL02", targetName: "Rival" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL02",
      rationale:
        "bordered rival should be pressured instead of stale neutral expansion",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["pressure rival"],
      failureCriteria: ["waste troops on stale expansion"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "expansion", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive", {
      settings: { territoryFirstNeutralLandEnabled: true },
    }).decide({ observation, legalActions }, plan);

    expect(decision.actionID).toBe("expand:terra-nullius:10");
  });

  it("keeps taking neutral land before border probes against a hostile border", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 820_000,
              maxTroops: 1_640_000,
              troopRatio: 0.5,
              tilesOwned: 23_000,
              tileShare: 0.24,
            },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      memory: {
        ...base.memory,
        recentExpansionCount: 3,
        repeatedActionKind: "attack",
        repeatedActionCount: 3,
      },
      endgame: {
        ...base.endgame!,
        ownTileShare: 0.24,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand neutral land",
        intent: { type: "attack", targetID: null, troops: 82_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Probe Rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 82_000 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          relativeTroopRatio: 1.15,
          troopPercentage: 0.1,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:expand-stalled",
      objective: "expand_territory",
      targetPlayerId: "OTHER_TARGET",
      rationale: "neutral expansion was useful but now borders need probing",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["grow while keeping pressure options open"],
      failureCriteria: ["stall against a hostile border"],
      preferredActionKinds: ["attack", "build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive", {
      settings: { territoryFirstNeutralLandEnabled: true },
    }).decide({ observation, legalActions }, plan);

    expect(decision.actionID).toBe("expand:terra-nullius:10");
    expect(decision.reason).toContain("Expand neutral land");
  });

  it("keeps neutral expansion before the large-footprint border-probe threshold", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 420_000,
              maxTroops: 1_200_000,
              troopRatio: 0.35,
              tilesOwned: 14_000,
              tileShare: 0.15,
            },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      memory: {
        ...base.memory,
        recentExpansionCount: 3,
        repeatedActionKind: "attack",
        repeatedActionCount: 3,
      },
      endgame: {
        ...base.endgame!,
        ownTileShare: 0.15,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand neutral land",
        intent: { type: "attack", targetID: null, troops: 42_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Probe Rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 42_000 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          relativeTroopRatio: 1.1,
          troopPercentage: 0.1,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:early-expand",
      objective: "expand_territory",
      targetPlayerId: "OTHER_TARGET",
      rationale: "early neutral land is still valuable",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["keep growing"],
      failureCriteria: ["waste troops too early"],
      preferredActionKinds: ["attack", "build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:10");
  });

  it("does not batch opening alliances when the growth plan leaves diplomacy disabled", () => {
    const observation = earlyExpansionObservation();
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand neutral land",
        intent: { type: "attack", targetID: null, troops: 104_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.2 },
      },
      {
        id: "alliance:RIVAL02",
        kind: "alliance_request",
        label: "Request alliance with Rival",
        intent: { type: "allianceRequest", recipient: "RIVAL02" },
        risk: { level: "low", score: 0.1 },
        metadata: { recipientID: "RIVAL02", targetID: "RIVAL02" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:clean-growth",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "keep safe opening growth clean",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["gain land"],
      failureCriteria: ["dilute growth with future targets"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "defense"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:20");
    expect(decision.actionIDs ?? [decision.actionID]).not.toContain(
      "alliance:RIVAL02",
    );
    expect(decision.selectedModules).not.toContain("diplomacy");
  });

  it("uses small leader probes when a large nation has no clean troop edge", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 700_000,
              maxTroops: 1_400_000,
              troopRatio: 0.5,
              tilesOwned: 28_000,
              tileShare: 0.27,
            },
      visiblePlayers: base.visiblePlayers.map((player, index) =>
        index === 0
          ? {
              ...player,
              troops: 820_000,
              tileShare: 0.32,
              relativeTroopRatio: 0.95,
              canAttack: true,
              sharesBorder: true,
            }
          : player,
      ),
      combat: {
        ...base.combat,
        ownTroops: 700_000,
        troopRatio: 0.5,
        attackablePlayerIDs: ["RIVAL02"],
        borderedPlayerIDs: ["RIVAL02"],
        weakestAttackableTargetID: "RIVAL02",
        strongestAttackableTargetID: "RIVAL02",
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      endgame: {
        ...base.endgame!,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.32,
        ownTileShare: 0.27,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Probe leader",
        intent: { type: "attack", targetID: "RIVAL02", troops: 70_000 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          relativeTroopRatio: 0.95,
          troopPercentage: 0.1,
        },
      },
      {
        id: "target:RIVAL02",
        kind: "target_player",
        label: "Mark leader",
        intent: { type: "targetPlayer", target: "RIVAL02" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL02", targetName: "Rival" },
      },
      {
        id: "embargo_all:start",
        kind: "embargo_all",
        label: "Embargo rivals",
        intent: { type: "embargo_all", action: "start" },
        risk: { level: "medium", score: 0.3 },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:leader-pressure",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL02",
      rationale: "leader pressure should not wait for a perfect edge",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["slow the leader"],
      failureCriteria: ["symbolic pressure only"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:RIVAL02:10");
    expect(decision.reason).toContain("Probe leader");
  });

  it("lets a small leader probe override stale non-leader focus", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 760_000,
              maxTroops: 1_500_000,
              troopRatio: 0.51,
              tilesOwned: 30_000,
              tileShare: 0.28,
            },
      visiblePlayers: [
        {
          ...base.visiblePlayers[0],
          playerID: "LEADER01",
          clientID: "LEADER01",
          name: "Leader",
          troops: 830_000,
          tileShare: 0.34,
          relativeTroopRatio: 0.92,
          canAttack: true,
          sharesBorder: true,
        },
        {
          ...base.visiblePlayers[0],
          playerID: "LOCAL02",
          clientID: "LOCAL02",
          name: "Local Threat",
          troops: 420_000,
          tileShare: 0.12,
          relativeTroopRatio: 1.8,
          canAttack: true,
          sharesBorder: true,
        },
      ],
      combat: {
        ...base.combat,
        ownTroops: 760_000,
        troopRatio: 0.51,
        attackablePlayerIDs: ["LEADER01", "LOCAL02"],
        borderedPlayerIDs: ["LEADER01", "LOCAL02"],
        weakestAttackableTargetID: "LOCAL02",
        strongestAttackableTargetID: "LEADER01",
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      endgame: {
        ...base.endgame!,
        leaderID: "LEADER01",
        leaderName: "Leader",
        leaderTileShare: 0.34,
        ownTileShare: 0.28,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:LEADER01:10",
        kind: "attack",
        label: "Probe leader",
        intent: { type: "attack", targetID: "LEADER01", troops: 76_000 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          relativeTroopRatio: 0.92,
          troopPercentage: 0.1,
        },
      },
      {
        id: "target:LOCAL02",
        kind: "target_player",
        label: "Mark local threat",
        intent: { type: "targetPlayer", target: "LOCAL02" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "LOCAL02", targetName: "Local Threat" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:local-pressure",
      objective: "pressure_rival",
      targetPlayerId: "LOCAL02",
      rationale: "local target is stale while leader grows",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["do not let leader snowball"],
      failureCriteria: ["focus mismatch blocks leader pressure"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:LEADER01:10");
  });

  it("finishes a weaker side rival when direct leader pressure is unsafe", async () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 820_000,
              maxTroops: 1_600_000,
              troopRatio: 0.51,
              tilesOwned: 31_000,
              tileShare: 0.29,
            },
      visiblePlayers: [
        {
          ...base.visiblePlayers[0],
          playerID: "LEADER01",
          clientID: "LEADER01",
          name: "Leader",
          troops: 1_120_000,
          tileShare: 0.37,
          relativeTroopRatio: 0.73,
          canAttack: true,
          sharesBorder: true,
        },
        {
          ...base.visiblePlayers[0],
          playerID: "LOCAL02",
          clientID: "LOCAL02",
          name: "Side Rival",
          troops: 360_000,
          tileShare: 0.1,
          relativeTroopRatio: 2.2,
          canAttack: true,
          sharesBorder: true,
        },
      ],
      combat: {
        ...base.combat,
        ownTroops: 820_000,
        troopRatio: 0.51,
        attackablePlayerIDs: ["LEADER01", "LOCAL02"],
        borderedPlayerIDs: ["LEADER01", "LOCAL02"],
        weakestAttackableTargetID: "LOCAL02",
        strongestAttackableTargetID: "LEADER01",
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      endgame: {
        ...base.endgame!,
        leaderID: "LEADER01",
        leaderName: "Leader",
        leaderTileShare: 0.37,
        ownTileShare: 0.29,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:LEADER01:10",
        kind: "attack",
        label: "Probe leader",
        intent: { type: "attack", targetID: "LEADER01", troops: 82_000 },
        risk: { level: "high", score: 0.65 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          relativeTroopRatio: 0.73,
          troopPercentage: 0.1,
        },
      },
      {
        id: "attack:LOCAL02:10",
        kind: "attack",
        label: "Attack side rival",
        intent: { type: "attack", targetID: "LOCAL02", troops: 82_000 },
        risk: { level: "medium", score: 0.1 },
        metadata: {
          targetID: "LOCAL02",
          targetName: "Side Rival",
          relativeTroopRatio: 2.2,
          troopPercentage: 0.1,
        },
      },
      hold(),
    ];
    const previousPlan: StrategicPlan = {
      planID: "agent-1:leader-pressure",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "leader is the old focus",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["slow the leader"],
      failureCriteria: ["stall on unsafe pressure"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };
    const plan = await new RuleAgentPlanner("aggressive").plan(
      { observation, legalActions },
      previousPlan,
    );

    expect(plan.plan.targetPlayerId).toBe("LOCAL02");

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      previousPlan,
    );

    expect(decision.actionID).toBe("attack:LOCAL02:10");
    expect(decision.blockedHostileAttackSummary).not.toContain(
      "attack:LOCAL02:10:hostile action does not match",
    );
  });

  it("converts a weak hard-nation neighbor before trading into the larger rival", () => {
    const base = earlyExpansionObservation();
    const visiblePlayers: AgentVisiblePlayer[] = [
      {
        ...base.visiblePlayers[0],
        playerID: "BIGGER01",
        clientID: "BIGGER01",
        name: "South Africa",
        type: PlayerType.Nation,
        troops: 560_000,
        tilesOwned: 24_000,
        tileShare: 0.24,
        relativeTroopRatio: 1.25,
        canAttack: true,
        sharesBorder: true,
      },
      {
        ...base.visiblePlayers[0],
        playerID: "WEAK02",
        clientID: "WEAK02",
        name: "Argentina",
        type: PlayerType.Nation,
        troops: 240_000,
        tilesOwned: 7_500,
        tileShare: 0.075,
        relativeTroopRatio: 2.9,
        canAttack: true,
        sharesBorder: true,
        incomingAttack: true,
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        ...base.visiblePlayers[0],
        playerID: `NATION${index}`,
        clientID: `NATION${index}`,
        smallID: index + 4,
        name: `Nation ${index}`,
        type: PlayerType.Nation,
        troops: 430_000 + index * 30_000,
        tilesOwned: 13_000 + index * 2_000,
        tileShare: 0.13 + index * 0.02,
        relativeTroopRatio: 1.1,
        canAttack: false,
        sharesBorder: false,
      })),
    ];
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 700_000,
              maxTroops: 1_400_000,
              troopRatio: 0.5,
              tilesOwned: 14_500,
              tileShare: 0.145,
            },
      visiblePlayers,
      combat: {
        ...base.combat,
        ownTroops: 700_000,
        maxTroops: 1_400_000,
        troopRatio: 0.5,
        canExpandIntoNeutral: false,
        attackablePlayerIDs: ["BIGGER01", "WEAK02"],
        borderedPlayerIDs: ["BIGGER01", "WEAK02"],
        incomingAttackPlayerIDs: ["BIGGER01"],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        weakestAttackableTargetID: "WEAK02",
        strongestAttackableTargetID: "BIGGER01",
      },
      endgame: {
        winner: null,
        leaderID: "BIGGER01",
        leaderName: "South Africa",
        leaderTileShare: 0.24,
        ownTileShare: 0.145,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:BIGGER01:10",
        kind: "attack",
        label: "Probe larger rival",
        intent: { type: "attack", targetID: "BIGGER01", troops: 70_000 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "BIGGER01",
          targetName: "South Africa",
          troopPercentage: 0.1,
          relativeTroopRatio: 1.25,
          targetTiles: 24_000,
          targetTileShare: 0.24,
        },
      },
      {
        id: "attack:WEAK02:10",
        kind: "attack",
        label: "Attack weak neighbor",
        intent: { type: "attack", targetID: "WEAK02", troops: 70_000 },
        risk: { level: "medium", score: 0.18 },
        metadata: {
          targetID: "WEAK02",
          targetName: "Argentina",
          troopPercentage: 0.1,
          relativeTroopRatio: 2.9,
          targetTiles: 7_500,
          targetTileShare: 0.075,
        },
      },
      {
        id: "attack:WEAK02:25",
        kind: "attack",
        label: "Attack weak neighbor",
        intent: { type: "attack", targetID: "WEAK02", troops: 175_000 },
        risk: { level: "medium", score: 0.18 },
        metadata: {
          targetID: "WEAK02",
          targetName: "Argentina",
          troopPercentage: 0.25,
          relativeTroopRatio: 2.9,
          targetTiles: 7_500,
          targetTileShare: 0.075,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:hard-side-conquest",
      objective: "pressure_rival",
      targetPlayerId: "BIGGER01",
      rationale: "leader pressure is less valuable than nearby weak land",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["convert weak neighbor"],
      failureCriteria: ["feed larger rival first"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:WEAK02:10");
    expect(decision.reason).toContain("Attack weak neighbor");
  });

  it("keeps reserve-safe weak-side probes available under repetition pressure", () => {
    const base = earlyExpansionObservation();
    const visiblePlayers: AgentVisiblePlayer[] = [
      {
        ...base.visiblePlayers[0],
        playerID: "LEADER01",
        clientID: "LEADER01",
        name: "Leader",
        type: PlayerType.Nation,
        troops: 620_000,
        tilesOwned: 24_000,
        tileShare: 0.24,
        relativeTroopRatio: 1.05,
        canAttack: true,
        sharesBorder: true,
      },
      {
        ...base.visiblePlayers[0],
        playerID: "WEAK02",
        clientID: "WEAK02",
        name: "Weak Neighbor",
        type: PlayerType.Nation,
        troops: 260_000,
        tilesOwned: 8_000,
        tileShare: 0.08,
        relativeTroopRatio: 2,
        canAttack: true,
        sharesBorder: true,
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        ...base.visiblePlayers[0],
        playerID: `NATION${index}`,
        clientID: `NATION${index}`,
        smallID: index + 4,
        name: `Nation ${index}`,
        type: PlayerType.Nation,
        troops: 420_000 + index * 25_000,
        tilesOwned: 13_000 + index * 1_500,
        tileShare: 0.13 + index * 0.015,
        relativeTroopRatio: 1.1,
        canAttack: false,
        sharesBorder: false,
      })),
    ];
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 700_000,
              maxTroops: 1_400_000,
              troopRatio: 0.5,
              tilesOwned: 15_500,
              tileShare: 0.155,
            },
      visiblePlayers,
      combat: {
        ...base.combat,
        ownTroops: 700_000,
        maxTroops: 1_400_000,
        troopRatio: 0.5,
        canExpandIntoNeutral: false,
        attackablePlayerIDs: ["LEADER01", "WEAK02"],
        borderedPlayerIDs: ["LEADER01", "WEAK02"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: ["WEAK02"],
        outgoingAttacks: [],
        weakestAttackableTargetID: "WEAK02",
        strongestAttackableTargetID: "LEADER01",
      },
      memory: {
        ...base.memory,
        recentActions: Array.from({ length: 4 }, (_, index) => ({
          sequence: index + 1,
          actionID: "attack:WEAK02:10",
          actionKind: "attack",
          targetID: "WEAK02",
          targetName: "Weak Neighbor",
          expansion: false,
          reason: "prior weak-side probe",
          accepted: true,
        })),
        repeatedActionKind: "attack",
        repeatedActionCount: 4,
        avoidActionIDs: ["attack:WEAK02:10"],
      },
      endgame: {
        winner: null,
        leaderID: "LEADER01",
        leaderName: "Leader",
        leaderTileShare: 0.24,
        ownTileShare: 0.155,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:WEAK02:10",
        kind: "attack",
        label: "Probe weak neighbor",
        intent: { type: "attack", targetID: "WEAK02", troops: 70_000 },
        risk: { level: "medium", score: 0.18 },
        metadata: {
          targetID: "WEAK02",
          targetName: "Weak Neighbor",
          troopPercentage: 0.1,
          relativeTroopRatio: 2,
          targetTiles: 8_000,
          targetTileShare: 0.08,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:hard-side-conquest",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "leader pressure is less valuable than nearby weak land",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["convert weak neighbor"],
      failureCriteria: ["feed probes"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:WEAK02:10");
    expect(decision.reason).toContain(
      "repeated low-commitment war probes are stalling conversion",
    );
  });

  it("keeps pressure on the current war before opening another front", async () => {
    const base = multiRivalPressureObservation();
    const observation: AgentObservation = {
      ...base,
      combat: {
        ...base.combat,
        outgoingAttackPlayerIDs: ["RIVAL02"],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Attack active rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 56_000 },
        risk: { level: "medium", score: 0.22 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          troopPercentage: 0.1,
          relativeTroopRatio: 1.8,
        },
      },
      {
        id: "attack:RIVAL03:10",
        kind: "attack",
        label: "Attack second rival",
        intent: { type: "attack", targetID: "RIVAL03", troops: 56_000 },
        risk: { level: "medium", score: 0.18 },
        metadata: {
          targetID: "RIVAL03",
          targetName: "Second Rival",
          troopPercentage: 0.1,
          relativeTroopRatio: 2.4,
        },
      },
      hold(),
    ];
    const previousPlan: StrategicPlan = {
      planID: "agent-1:second-front",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL03",
      rationale: "old focus was the second rival",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["pressure rival"],
      failureCriteria: ["target switching"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions },
      previousPlan,
    );
    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      previousPlan,
    );

    expect(plan.plan.targetPlayerId).toBe("RIVAL02");
    expect(decision.actionID).toBe("attack:RIVAL02:10");
    expect(decision.blockedHostileAttackSummary).toContain(
      "finish current war before opening another front",
    );
  });

  it("blocks medium leader pressure without troop parity", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 820_000,
              maxTroops: 1_600_000,
              troopRatio: 0.51,
              tilesOwned: 31_000,
              tileShare: 0.29,
            },
      visiblePlayers: [
        {
          ...base.visiblePlayers[0],
          playerID: "LEADER01",
          clientID: "LEADER01",
          name: "Leader",
          troops: 1_000_000,
          tileShare: 0.35,
          relativeTroopRatio: 0.82,
          canAttack: true,
          sharesBorder: true,
        },
        {
          ...base.visiblePlayers[0],
          playerID: "LOCAL02",
          clientID: "LOCAL02",
          name: "Local Threat",
          troops: 480_000,
          tileShare: 0.11,
          relativeTroopRatio: 1.7,
          canAttack: true,
          sharesBorder: true,
        },
      ],
      combat: {
        ...base.combat,
        ownTroops: 820_000,
        troopRatio: 0.51,
        attackablePlayerIDs: ["LEADER01", "LOCAL02"],
        borderedPlayerIDs: ["LEADER01", "LOCAL02"],
        weakestAttackableTargetID: "LOCAL02",
        strongestAttackableTargetID: "LEADER01",
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      endgame: {
        ...base.endgame!,
        leaderID: "LEADER01",
        leaderName: "Leader",
        leaderTileShare: 0.35,
        ownTileShare: 0.29,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:LEADER01:25",
        kind: "attack",
        label: "Pressure leader",
        intent: { type: "attack", targetID: "LEADER01", troops: 205_000 },
        risk: { level: "medium", score: 0.42 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          relativeTroopRatio: 0.82,
          troopPercentage: 0.25,
        },
      },
      {
        id: "target:LOCAL02",
        kind: "target_player",
        label: "Mark local threat",
        intent: { type: "targetPlayer", target: "LOCAL02" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "LOCAL02", targetName: "Local Threat" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:medium-leader-pressure",
      objective: "pressure_rival",
      targetPlayerId: "LOCAL02",
      rationale: "leader needs pressure, but not a troop feed",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["slow the leader"],
      failureCriteria: ["feed the leader"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).not.toBe("attack:LEADER01:25");
    expect(decision.blockedHostileAttackSummary).toContain(
      "medium leader pressure needs parity",
    );
  });

  it("fortifies instead of trading troops into a stronger leader during urgent defense", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 900_000,
              tilesOwned: 46_000,
              tileShare: 0.29,
              troopRatio: 0.42,
            },
      visiblePlayers: [
        {
          ...base.visiblePlayers[0],
          playerID: "LEADER01",
          clientID: "LEADER01",
          name: "Leader",
          troops: 1_100_000,
          tileShare: 0.36,
          relativeTroopRatio: 0.82,
          canAttack: true,
          sharesBorder: true,
        },
      ],
      combat: {
        ...base.combat,
        ownTroops: 900_000,
        troopRatio: 0.42,
        attackablePlayerIDs: ["LEADER01"],
        borderedPlayerIDs: ["LEADER01"],
        weakestAttackableTargetID: "LEADER01",
        strongestAttackableTargetID: "LEADER01",
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      endgame: {
        ...base.endgame!,
        leaderID: "LEADER01",
        leaderName: "Leader",
        leaderTileShare: 0.36,
        ownTileShare: 0.29,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:LEADER01:25",
        kind: "attack",
        label: "Trade into leader",
        intent: { type: "attack", targetID: "LEADER01", troops: 225_000 },
        risk: { level: "medium", score: 0.42 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Leader",
          relativeTroopRatio: 0.82,
          troopPercentage: 0.25,
        },
      },
      {
        id: "build:DefensePost:20",
        kind: "build",
        label: "Build Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 20 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "defensive",
          unit: UnitType.DefensePost,
          defensiveValue: 0.8,
          frontierValue: 0.9,
          nearbyEnemyCount: 2,
          hostileBorderDistance: 2,
          buildPlacementReason: "Defense Post covers the leader border.",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:urgent-leader-defense",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "pressure leader without feeding them troops",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["survive leader pressure"],
      failureCriteria: ["feed the leader"],
      preferredActionKinds: ["attack", "build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "defense"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("build:DefensePost:20");
    expect(decision.blockedHostileAttackSummary).toContain(
      "urgent defense should not trade into a stronger leader",
    );
  });

  it("blocks unsafe non-leader attacks during urgent defense", () => {
    const base = earlyExpansionObservation();
    const leader: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      playerID: "LEADER01",
      clientID: "LEADER01",
      name: "Leader",
      troops: 1_100_000,
      tileShare: 0.36,
      relativeTroopRatio: 0.7,
      canAttack: false,
      sharesBorder: false,
    };
    const sideRival: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      playerID: "SIDE02",
      clientID: "SIDE02",
      name: "Side Rival",
      troops: 440_000,
      tileShare: 0.16,
      relativeTroopRatio: 1.2,
      canAttack: true,
      sharesBorder: true,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 520_000,
              tilesOwned: 12_000,
              tileShare: 0.12,
              troopRatio: 0.43,
            },
      visiblePlayers: [leader, sideRival],
      combat: {
        ...base.combat,
        ownTroops: 520_000,
        troopRatio: 0.43,
        attackablePlayerIDs: ["SIDE02"],
        borderedPlayerIDs: ["SIDE02"],
        weakestAttackableTargetID: "SIDE02",
        strongestAttackableTargetID: "SIDE02",
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      endgame: {
        ...base.endgame!,
        leaderID: "LEADER01",
        leaderName: "Leader",
        leaderTileShare: 0.36,
        ownTileShare: 0.12,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:SIDE02:25",
        kind: "attack",
        label: "Trade into side rival",
        intent: { type: "attack", targetID: "SIDE02", troops: 130_000 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "SIDE02",
          targetName: "Side Rival",
          relativeTroopRatio: 1.2,
          troopPercentage: 0.25,
        },
      },
      {
        id: "build:DefensePost:20",
        kind: "build",
        label: "Build Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 20 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "defensive",
          unit: UnitType.DefensePost,
          defensiveValue: 0.8,
          frontierValue: 0.9,
          nearbyEnemyCount: 2,
          hostileBorderDistance: 2,
          buildPlacementReason: "Defense Post covers the active side border.",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:urgent-side-defense",
      objective: "pressure_rival",
      targetPlayerId: "SIDE02",
      rationale: "urgent defense should not trade into side rivals",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["stabilize border"],
      failureCriteria: ["feed side attack"],
      preferredActionKinds: ["attack", "build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "defense"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("build:DefensePost:20");
    expect(decision.blockedHostileAttackSummary).toContain(
      "urgent defense state makes non-leader attacks too risky",
    );
  });

  it("holds instead of using unsafe urgent-defense attacks as a fallback", () => {
    const base = earlyExpansionObservation();
    const leader: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      playerID: "LEADER01",
      clientID: "LEADER01",
      name: "Leader",
      troops: 1_100_000,
      tileShare: 0.36,
      relativeTroopRatio: 0.7,
      canAttack: false,
      sharesBorder: false,
    };
    const sideRival: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      playerID: "SIDE02",
      clientID: "SIDE02",
      name: "Side Rival",
      troops: 440_000,
      tileShare: 0.16,
      relativeTroopRatio: 1.2,
      canAttack: true,
      sharesBorder: true,
    };
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 520_000,
              tilesOwned: 12_000,
              tileShare: 0.12,
              troopRatio: 0.43,
            },
      visiblePlayers: [leader, sideRival],
      combat: {
        ...base.combat,
        ownTroops: 520_000,
        troopRatio: 0.43,
        attackablePlayerIDs: ["SIDE02"],
        borderedPlayerIDs: ["SIDE02"],
        weakestAttackableTargetID: "SIDE02",
        strongestAttackableTargetID: "SIDE02",
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      endgame: {
        ...base.endgame!,
        leaderID: "LEADER01",
        leaderName: "Leader",
        leaderTileShare: 0.36,
        ownTileShare: 0.12,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:SIDE02:25",
        kind: "attack",
        label: "Trade into side rival",
        intent: { type: "attack", targetID: "SIDE02", troops: 130_000 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "SIDE02",
          targetName: "Side Rival",
          relativeTroopRatio: 1.2,
          troopPercentage: 0.25,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:urgent-side-fallback",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "SIDE02",
      rationale: "unsafe attacks should not become fallback actions",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["stabilize border"],
      failureCriteria: ["feed side attack"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.blockedHostileAttackSummary).toContain(
      "urgent defense state makes non-leader attacks too risky",
    );
  });

  it("uses a flank transport when the only land attack feeds a runaway hard-nation leader", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 800_000,
              maxTroops: 1_600_000,
              troopRatio: 0.5,
              tilesOwned: 30_000,
              tileShare: 0.28,
            },
      visiblePlayers: [
        {
          ...base.visiblePlayers[0],
          playerID: "LEADER01",
          clientID: "LEADER01",
          name: "Runaway Leader",
          type: PlayerType.Nation,
          troops: 1_150_000,
          tilesOwned: 42_000,
          tileShare: 0.39,
          relativeTroopRatio: 0.7,
          canAttack: true,
          sharesBorder: true,
        },
        ...Array.from({ length: 2 }, (_, index) => ({
          ...base.visiblePlayers[0],
          playerID: `NATION${index}`,
          clientID: `NATION${index}`,
          smallID: index + 4,
          name: `Nation ${index}`,
          type: PlayerType.Nation,
          troops: 520_000 + index * 40_000,
          tilesOwned: 18_000 + index * 2_000,
          tileShare: 0.17 + index * 0.02,
          relativeTroopRatio: 1.1,
          canAttack: false,
          sharesBorder: false,
        })),
      ],
      combat: {
        ...base.combat,
        ownTroops: 800_000,
        maxTroops: 1_600_000,
        troopRatio: 0.5,
        canExpandIntoNeutral: false,
        attackablePlayerIDs: ["LEADER01"],
        borderedPlayerIDs: ["LEADER01"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        weakestAttackableTargetID: "LEADER01",
        strongestAttackableTargetID: "LEADER01",
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      endgame: {
        winner: null,
        leaderID: "LEADER01",
        leaderName: "Runaway Leader",
        leaderTileShare: 0.39,
        ownTileShare: 0.28,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:LEADER01:10",
        kind: "attack",
        label: "Probe runaway leader",
        intent: { type: "attack", targetID: "LEADER01", troops: 80_000 },
        risk: { level: "medium", score: 0.4 },
        metadata: {
          targetID: "LEADER01",
          targetName: "Runaway Leader",
          troopPercentage: 0.1,
          relativeTroopRatio: 0.7,
          targetTiles: 42_000,
          targetTileShare: 0.39,
        },
      },
      {
        id: "boat:456:16",
        kind: "boat",
        label: "Send 16% transport to neutral shore",
        intent: { type: "boat", troops: 128_000, dst: 456 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 456,
          targetID: null,
          targetName: "Terra Nullius",
          troopPercentage: 0.16,
          troopPercent: 16,
          expansion: true,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:hard-flank-transport",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "find a safer conquest front",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["open side front"],
      failureCriteria: ["feed leader"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "naval", "expansion", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:456:16");
    expect(decision.reason).toContain("primary Send 16% transport");
  });

  it("uses a high-value offshore transport angle before a hard-nation fight stalls", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 552_000,
              maxTroops: 1_400_000,
              troopRatio: 0.39,
              tilesOwned: 24_200,
              tileShare: 0.24,
            },
      visiblePlayers: [
        {
          ...base.visiblePlayers[0],
          playerID: "RIVAL02",
          clientID: "RIVAL02",
          name: "South Africa",
          type: PlayerType.Nation,
          troops: 446_000,
          tilesOwned: 19_000,
          tileShare: 0.19,
          relativeTroopRatio: 1.24,
          canAttack: false,
          sharesBorder: false,
        },
        ...Array.from({ length: 3 }, (_, index) => ({
          ...base.visiblePlayers[0],
          playerID: `NATION${index}`,
          clientID: `NATION${index}`,
          smallID: index + 4,
          name: `Hard Nation ${index}`,
          type: PlayerType.Nation,
          troops: 500_000 + index * 50_000,
          tilesOwned: 20_000 + index * 2_000,
          tileShare: 0.18 + index * 0.02,
          relativeTroopRatio: 1,
          canAttack: false,
          sharesBorder: index === 0,
        })),
      ],
      combat: {
        ...base.combat,
        ownTroops: 552_000,
        maxTroops: 1_400_000,
        troopRatio: 0.39,
        canExpandIntoNeutral: false,
        attackablePlayerIDs: [],
        borderedPlayerIDs: ["NATION0"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        weakestAttackableTargetID: "RIVAL02",
        strongestAttackableTargetID: "RIVAL02",
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      endgame: {
        winner: null,
        leaderID: "NATION2",
        leaderName: "Hard Nation 2",
        leaderTileShare: 0.22,
        ownTileShare: 0.24,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:25",
        kind: "attack",
        label: "Attack South Africa with 25% troops",
        intent: { type: "attack", targetID: "RIVAL02", troops: 138_000 },
        risk: { level: "medium", score: 0.42 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "South Africa",
          targetTroops: 446_000,
          targetTileShare: 0.19,
          troopPercentage: 0.25,
          troopPercent: 25,
          relativeTroopRatio: 1.24,
          sharesBorder: true,
        },
      },
      {
        id: "boat:198717:16",
        kind: "boat",
        label: "Send 16% transport to South Africa",
        intent: { type: "boat", troops: 88_320, dst: 198_717 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 198_717,
          targetID: "RIVAL02",
          targetName: "South Africa",
          targetTroops: 446_000,
          targetTileShare: 0.19,
          relativeTroopRatio: 1.24,
          navalInvasion: true,
          expansion: false,
          troops: 88_320,
          troopPercentage: 0.16,
          troopPercent: 16,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:hard-high-value-transport",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL02",
      rationale: "open a second angle before the land border stalls",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["open side front"],
      failureCriteria: ["stall on direct border"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:198717:16");
    expect(decision.reason).toContain("primary Send 16% transport");
  });

  it("blocks duplicate transports against a land-contact hard-nation rival", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 900_000,
              maxTroops: 1_400_000,
              troopRatio: 0.64,
              tilesOwned: 24_200,
              tileShare: 0.24,
            },
      visiblePlayers: [
        {
          ...base.visiblePlayers[0],
          playerID: "RIVAL02",
          clientID: "RIVAL02",
          name: "Brazil",
          type: PlayerType.Nation,
          troops: 470_000,
          tilesOwned: 19_000,
          tileShare: 0.19,
          relativeTroopRatio: 1.9,
          canAttack: true,
          sharesBorder: true,
        },
        ...Array.from({ length: 3 }, (_, index) => ({
          ...base.visiblePlayers[0],
          playerID: `NATION${index}`,
          clientID: `NATION${index}`,
          smallID: index + 4,
          name: `Hard Nation ${index}`,
          type: PlayerType.Nation,
          troops: 500_000 + index * 50_000,
          tilesOwned: 20_000 + index * 2_000,
          tileShare: 0.18 + index * 0.02,
          relativeTroopRatio: 1,
          canAttack: false,
          sharesBorder: index === 0,
        })),
      ],
      combat: {
        ...base.combat,
        ownTroops: 900_000,
        maxTroops: 1_400_000,
        troopRatio: 0.64,
        canExpandIntoNeutral: false,
        attackablePlayerIDs: ["RIVAL02"],
        borderedPlayerIDs: ["RIVAL02", "NATION0"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        weakestAttackableTargetID: "RIVAL02",
        strongestAttackableTargetID: "RIVAL02",
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      endgame: {
        winner: null,
        leaderID: "NATION2",
        leaderName: "Hard Nation 2",
        leaderTileShare: 0.22,
        ownTileShare: 0.24,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:25",
        kind: "attack",
        label: "Attack Brazil with 25% troops",
        intent: { type: "attack", targetID: "RIVAL02", troops: 225_000 },
        risk: { level: "medium", score: 0.42 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Brazil",
          targetTroops: 470_000,
          targetTileShare: 0.19,
          troopPercentage: 0.25,
          troopPercent: 25,
          relativeTroopRatio: 1.9,
          sharesBorder: true,
        },
      },
      {
        id: "boat:198717:16",
        kind: "boat",
        label: "Send 16% transport to Brazil",
        intent: { type: "boat", troops: 144_000, dst: 198_717 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 198_717,
          targetID: "RIVAL02",
          targetName: "Brazil",
          targetTroops: 470_000,
          targetTileShare: 0.19,
          relativeTroopRatio: 1.9,
          navalInvasion: true,
          expansion: false,
          troops: 144_000,
          troopPercentage: 0.16,
          troopPercent: 16,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:hard-land-contact-before-transport",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL02",
      rationale: "attack the border before launching more transports",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["convert border"],
      failureCriteria: ["waste transport"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).not.toBe("boat:198717:16");
    expect(decision.reason).not.toContain("primary Send 16% transport");
  });

  it("keeps hard-nation transport overrides behind remaining neutral expansion", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 560_000,
              maxTroops: 1_400_000,
              troopRatio: 0.4,
              tilesOwned: 22_000,
              tileShare: 0.22,
            },
      visiblePlayers: [
        {
          ...base.visiblePlayers[0],
          playerID: "RIVAL02",
          clientID: "RIVAL02",
          type: PlayerType.Nation,
          troops: 500_000,
          tilesOwned: 20_000,
          tileShare: 0.2,
          relativeTroopRatio: 1.1,
          canAttack: true,
          sharesBorder: true,
        },
        ...Array.from({ length: 3 }, (_, index) => ({
          ...base.visiblePlayers[0],
          playerID: `NATION${index}`,
          clientID: `NATION${index}`,
          smallID: index + 5,
          name: `Hard Nation ${index}`,
          type: PlayerType.Nation,
          troops: 450_000,
          tilesOwned: 18_000,
          tileShare: 0.18,
          canAttack: false,
          sharesBorder: false,
        })),
      ],
      combat: {
        ...base.combat,
        ownTroops: 560_000,
        maxTroops: 1_400_000,
        troopRatio: 0.4,
        canExpandIntoNeutral: true,
        attackablePlayerIDs: ["RIVAL02"],
        borderedPlayerIDs: ["RIVAL02"],
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.2,
        ownTileShare: 0.22,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand into neutral land",
        intent: { type: "attack", targetID: "terra-nullius", troops: 112_000 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          expansion: true,
          troopPercentage: 0.2,
          troopPercent: 20,
          targetName: "Terra Nullius",
        },
      },
      {
        id: "boat:198717:16",
        kind: "boat",
        label: "Send 16% transport to Rival",
        intent: { type: "boat", troops: 89_600, dst: 198_717 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 198_717,
          targetID: "RIVAL02",
          targetName: "Rival",
          relativeTroopRatio: 1.1,
          navalInvasion: true,
          expansion: false,
          troopPercentage: 0.16,
          troopPercent: 16,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:hard-neutral-before-transport",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL02",
      rationale: "grow before side transport",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["take neutral land"],
      failureCriteria: ["waste transport"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "combat", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:20");
  });

  it("does not ally with a runaway hard-nation leader during the conquest race", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 760_000,
              tilesOwned: 26_000,
              tileShare: 0.25,
              troopRatio: 0.48,
            },
      visiblePlayers: [
        {
          ...base.visiblePlayers[0],
          playerID: "LEADER01",
          clientID: "LEADER01",
          name: "Runaway Leader",
          type: PlayerType.Nation,
          troops: 1_050_000,
          tilesOwned: 41_000,
          tileShare: 0.38,
          relativeTroopRatio: 0.72,
          canAttack: true,
          sharesBorder: true,
          canRequestAlliance: true,
        },
        ...Array.from({ length: 2 }, (_, index) => ({
          ...base.visiblePlayers[0],
          playerID: `NATION${index}`,
          clientID: `NATION${index}`,
          smallID: index + 4,
          name: `Nation ${index}`,
          type: PlayerType.Nation,
          troops: 500_000,
          tilesOwned: 18_000,
          tileShare: 0.17,
          relativeTroopRatio: 1.1,
          canAttack: false,
          sharesBorder: false,
        })),
      ],
      combat: {
        ...base.combat,
        ownTroops: 760_000,
        troopRatio: 0.48,
        attackablePlayerIDs: ["LEADER01"],
        borderedPlayerIDs: ["LEADER01"],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      endgame: {
        winner: null,
        leaderID: "LEADER01",
        leaderName: "Runaway Leader",
        leaderTileShare: 0.38,
        ownTileShare: 0.25,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "alliance:LEADER01",
        kind: "alliance_request",
        label: "Request alliance with Runaway Leader",
        intent: { type: "allianceRequest", recipient: "LEADER01" },
        risk: { level: "low", score: 0.2 },
        metadata: {
          recipientID: "LEADER01",
          recipientName: "Runaway Leader",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:no-runaway-alliance",
      objective: "pressure_rival",
      targetPlayerId: "LEADER01",
      rationale: "avoid protecting the winner",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["keep conquest path open"],
      failureCriteria: ["protect runaway"],
      preferredActionKinds: ["alliance_request", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["diplomacy", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.reason).toContain("primary Hold");
  });

  it("blocks symbolic pressure when a stronger rival is collapsing the frontier", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 120_000,
              tilesOwned: 8_000,
              tileShare: 0.08,
            },
      visiblePlayers: base.visiblePlayers.map((player, index) =>
        index === 0
          ? {
              ...player,
              troops: 190_000,
              relativeTroopRatio: 0.63,
              canAttack: true,
              sharesBorder: true,
            }
          : player,
      ),
      combat: {
        ...base.combat,
        ownTroops: 120_000,
        attackablePlayerIDs: ["RIVAL02"],
        borderedPlayerIDs: ["RIVAL02"],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      endgame: {
        ...base.endgame!,
        ownTileShare: 0.08,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "embargo_all:start",
        kind: "embargo_all",
        label: "Embargo all",
        intent: { type: "embargo_all", action: "start" },
        risk: { level: "medium", score: 0.3 },
      },
      {
        id: "target:RIVAL02",
        kind: "target_player",
        label: "Target rival",
        intent: { type: "targetPlayer", target: "RIVAL02" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "RIVAL02" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:collapse",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL02",
      rationale: "pressure but do not waste survival turns",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["survive"],
      failureCriteria: ["symbolic pressure while collapsing"],
      preferredActionKinds: ["embargo_all", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.reason).toContain("no map-progress action is legal");
  });

  it("uses probe-sized counterattacks instead of passively holding during critical collapse", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 120_000,
              tilesOwned: 8_000,
              tileShare: 0.08,
            },
      visiblePlayers: base.visiblePlayers.map((player, index) =>
        index === 0
          ? {
              ...player,
              troops: 500_000,
              relativeTroopRatio: 0.24,
              canAttack: true,
              sharesBorder: true,
              incomingAttack: true,
            }
          : player,
      ),
      combat: {
        ...base.combat,
        ownTroops: 120_000,
        troopRatio: 0.22,
        attackablePlayerIDs: ["RIVAL02"],
        borderedPlayerIDs: ["RIVAL02"],
        incomingAttackPlayerIDs: ["RIVAL02"],
        incomingAttacks: [
          {
            attackID: "incoming-collapse",
            targetID: "RIVAL02",
            targetName: "Rival",
            troops: 220_000,
            retreating: false,
            sourceTile: null,
            borderSize: 16,
          },
        ],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      endgame: {
        ...base.endgame!,
        ownTileShare: 0.08,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Probe stronger rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 12_000 },
        risk: { level: "medium", score: 0.32 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          troopPercentage: 0.1,
          relativeTroopRatio: 0.78,
          incomingAttack: true,
        },
      },
      {
        id: "attack:RIVAL02:25",
        kind: "attack",
        label: "Attack stronger rival",
        intent: { type: "attack", targetID: "RIVAL02", troops: 30_000 },
        risk: { level: "medium", score: 0.4 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          troopPercentage: 0.25,
          relativeTroopRatio: 0.78,
          incomingAttack: true,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:collapse-counter",
      objective: "survive",
      targetPlayerId: "RIVAL02",
      rationale: "counterattack is the only map-progress action left",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["survive"],
      failureCriteria: ["passive elimination"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["emergency_survival", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:RIVAL02:10");
    expect(decision.reason).toContain("Probe stronger rival");
  });

  it("takes reachable side land when the runaway leader cannot be attacked", () => {
    const base = leaderPressureObservation();
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 1_050_000,
              maxTroops: 1_250_000,
              troopRatio: 0.84,
              tilesOwned: 24_500,
              tileShare: 0.24,
            },
      visiblePlayers: [
        {
          ...base.visiblePlayers[0],
          playerID: "LEADER01",
          clientID: "LEADER01",
          name: "Runaway Leader",
          troops: 2_200_000,
          tilesOwned: 72_000,
          tileShare: 0.72,
          canAttack: false,
          sharesBorder: false,
          relativeTroopRatio: 0.48,
        },
        {
          ...base.visiblePlayers[0],
          playerID: "SIDE01",
          clientID: "SIDE01",
          name: "Reachable Side",
          troops: 95_000,
          tilesOwned: 1_600,
          tileShare: 0.016,
          canAttack: true,
          sharesBorder: true,
          relativeTroopRatio: 11.05,
        },
      ],
      combat: {
        ...base.combat,
        ownTroops: 1_050_000,
        maxTroops: 1_250_000,
        troopRatio: 0.84,
        canExpandIntoNeutral: false,
        attackablePlayerIDs: ["SIDE01"],
        borderedPlayerIDs: ["SIDE01"],
        weakestAttackableTargetID: "SIDE01",
        strongestAttackableTargetID: "SIDE01",
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      endgame: {
        winner: null,
        leaderID: "LEADER01",
        leaderName: "Runaway Leader",
        leaderTileShare: 0.72,
        ownTileShare: 0.24,
        turnsToTimer: 1_200,
      },
    };
    const legalActions: LegalAction[] = [
      hardNationAttackAction(
        "SIDE01",
        "Reachable Side",
        10,
        105_000,
        11.05,
        0.016,
      ),
      hardNationAttackAction(
        "SIDE01",
        "Reachable Side",
        25,
        262_500,
        11.05,
        0.016,
      ),
      hardNationAttackAction(
        "SIDE01",
        "Reachable Side",
        40,
        420_000,
        11.05,
        0.016,
      ),
      hold(),
    ];
    const plan = pressurePlan(observation, "LEADER01");

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:SIDE01:25");
    expect(decision.reason).toContain("Reachable Side");
  });

  it("fortifies instead of feeding a much larger hard nation while behind", () => {
    const base = earlyExpansionObservation();
    const visiblePlayers: AgentVisiblePlayer[] = Array.from(
      { length: 5 },
      (_, index) => {
        const isLeader = index === 0;
        return {
          ...base.visiblePlayers[0],
          playerID: isLeader ? "NATION_LEADER" : `NATION${index}`,
          clientID: isLeader ? "NATION_LEADER" : `NATION${index}`,
          smallID: index + 2,
          name: isLeader ? "South Africa" : `Nation ${index}`,
          type: PlayerType.Nation,
          troops: isLeader ? 540_000 : 410_000 + index * 20_000,
          maxTroops: 1_000_000,
          troopRatio: isLeader ? 0.54 : 0.45,
          tilesOwned: isLeader ? 29_000 : 13_000 + index * 1_500,
          tileShare: isLeader ? 0.29 : 0.13 + index * 0.015,
          sharesBorder: isLeader || index === 1,
          canAttack: isLeader || index === 1,
          incomingAttack: isLeader,
          relativeTroopRatio: isLeader ? 0.72 : 0.95,
        };
      },
    );
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 390_000,
              maxTroops: 1_000_000,
              troopRatio: 0.39,
              tilesOwned: 10_500,
              tileShare: 0.105,
            },
      visiblePlayers,
      combat: {
        ...base.combat,
        ownTroops: 390_000,
        maxTroops: 1_000_000,
        troopRatio: 0.39,
        canExpandIntoNeutral: false,
        neutralExpansionLegalReason: null,
        attackablePlayerIDs: ["NATION_LEADER", "NATION1"],
        borderedPlayerIDs: ["NATION_LEADER", "NATION1"],
        incomingAttackPlayerIDs: ["NATION_LEADER"],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        weakestAttackableTargetID: "NATION1",
        strongestAttackableTargetID: "NATION_LEADER",
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      endgame: {
        winner: null,
        leaderID: "NATION_LEADER",
        leaderName: "South Africa",
        leaderTileShare: 0.29,
        ownTileShare: 0.105,
        turnsToTimer: 4_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:NATION_LEADER:10",
        kind: "attack",
        label: "Probe South Africa",
        intent: { type: "attack", targetID: "NATION_LEADER", troops: 39_000 },
        risk: { level: "high", score: 0.72 },
        metadata: {
          targetID: "NATION_LEADER",
          targetName: "South Africa",
          troopPercentage: 0.1,
          relativeTroopRatio: 0.72,
          targetTiles: 29_000,
          targetTileShare: 0.29,
        },
      },
      {
        id: "build:DefensePost:20",
        kind: "build",
        label: "Build Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 20 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "defensive",
          unit: UnitType.DefensePost,
          defensiveValue: 0.9,
          frontierValue: 0.95,
          nearbyEnemyCount: 2,
          hostileBorderDistance: 1,
          nearbyIncomingAttack: true,
          buildPlacementReason:
            "Defense Post covers the collapsing hard-nation border.",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:hard-underdog-defense",
      objective: "pressure_rival",
      targetPlayerId: "NATION_LEADER",
      rationale: "do not feed a much larger hard nation",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["stabilize"],
      failureCriteria: ["feed stronger rival"],
      preferredActionKinds: ["attack", "build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["emergency_survival", "combat", "defense"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("build:DefensePost:20");
    expect(decision.blockedHostileAttackSummary).toContain(
      "attacking a stronger rival feeds them troops",
    );
  });

  it("uses proven pressure over stale opening expansion when a weak rival is available", async () => {
    const observation: AgentObservation = {
      ...earlyExpansionObservation(),
      memory: {
        ...earlyExpansionObservation().memory,
        recentExpansionCount: 3,
      },
      objective: {
        objectiveID: "agent-1:pressure_rival",
        kind: "pressure_rival",
        label: "Pressure rival",
        status: "active",
        createdTurn: 8,
        updatedTurn: 8,
        preferredActionKinds: ["attack", "embargo", "target_player", "hold"],
        progress: {
          recentDecisionCount: 1,
          alignedRecentDecisionCount: 1,
          consecutiveAlignedDecisionCount: 1,
        },
        summary: "stale pressure plan",
        notes: [],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Attack Rival with 10%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 40_000 },
        risk: { level: "low", score: 0.18 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          troopPercentage: 0.1,
          relativeTroopRatio: 1.4,
        },
      },
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand",
        intent: { type: "attack", targetID: null, troops: 40_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions },
      null,
    );
    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan.plan,
    );

    expect(plan.plan.objective).toBe("pressure_rival");
    expect(decision.actionID).toBe("attack:RIVAL02:10");
  });

  it("does not enter survival mode just because a neutral transport can retreat", async () => {
    const observation = earlyExpansionObservation();
    const legalActions: LegalAction[] = [
      {
        id: "boat_retreat:2",
        kind: "boat_retreat",
        label: "Retreat transport 2",
        intent: { type: "cancel_boat", unitID: 2 },
        risk: { level: "low", score: 0.1 },
        metadata: { unitID: 2, troops: 20_000 },
      },
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand",
        intent: { type: "attack", targetID: null, troops: 40_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions },
      null,
    );

    expect(plan.plan.objective).toBe("expand_territory");
  });

  it("keeps crowded hard-nation openings in expansion until it has a land base", async () => {
    const base = earlyExpansionObservation();
    const visiblePlayers: AgentVisiblePlayer[] = Array.from(
      { length: 10 },
      (_, index) => ({
        ...base.visiblePlayers[0],
        playerID: `NATION${index}`,
        clientID: `NATION${index}`,
        smallID: index + 2,
        name: `Nation ${index}`,
        type: PlayerType.Nation,
        sharesBorder: index < 2,
        canAttack: index < 2,
        troops: 100_000 + index * 5_000,
        tilesOwned: 900 + index * 100,
        tileShare: 0.02,
        relativeTroopRatio: 0.9,
      }),
    );
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 96_000,
              maxTroops: 900_000,
              troopRatio: 0.11,
              tilesOwned: 780,
              tileShare: 0.012,
            },
      visiblePlayers,
      objective: {
        objectiveID: "agent-1:pressure_rival",
        kind: "pressure_rival",
        label: "Pressure rival",
        status: "active",
        createdTurn: 12,
        updatedTurn: 12,
        preferredActionKinds: ["attack", "embargo", "target_player", "hold"],
        progress: {
          recentDecisionCount: 1,
          alignedRecentDecisionCount: 1,
          consecutiveAlignedDecisionCount: 1,
        },
        summary: "pressure appeared before land base",
        notes: [],
      },
      combat: {
        ...base.combat,
        ownTroops: 96_000,
        maxTroops: 900_000,
        troopRatio: 0.11,
        canExpandIntoNeutral: true,
        borderedPlayerIDs: ["NATION0", "NATION1"],
        attackablePlayerIDs: ["NATION0", "NATION1"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        weakestAttackableTargetID: "NATION0",
        strongestAttackableTargetID: "NATION1",
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      endgame: {
        winner: null,
        leaderID: "NATION9",
        leaderName: "Nation 9",
        leaderTileShare: 0.18,
        ownTileShare: 0.012,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:NATION0:10",
        kind: "attack",
        label: "Attack Nation 0",
        intent: { type: "attack", targetID: "NATION0", troops: 9_600 },
        risk: { level: "medium", score: 0.3 },
        metadata: {
          targetID: "NATION0",
          targetName: "Nation 0",
          troopPercentage: 0.1,
          relativeTroopRatio: 0.9,
        },
      },
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand",
        intent: { type: "attack", targetID: null, troops: 9_600 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("aggressive").plan(
      { observation, legalActions },
      null,
    );
    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan.plan,
    );

    expect(plan.plan.objective).toBe("expand_territory");
    expect(decision.actionID).toBe("expand:terra-nullius:10");
  });

  it("treats neutral transports as hard-nation opening growth when land borders are blocked", async () => {
    const base = earlyExpansionObservation();
    const visiblePlayers: AgentVisiblePlayer[] = Array.from(
      { length: 3 },
      (_, index) => ({
        ...base.visiblePlayers[0],
        playerID: `NATION${index}`,
        clientID: `NATION${index}`,
        smallID: index + 2,
        name: `Nation ${index}`,
        type: PlayerType.Nation,
        sharesBorder: index < 2,
        canAttack: index < 2,
        troops: 180_000 + index * 12_000,
        tilesOwned: 2_200 + index * 350,
        tileShare: 0.06,
        relativeTroopRatio: 0.72,
      }),
    );
    const observation: AgentObservation = {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 150_000,
              maxTroops: 900_000,
              troopRatio: 0.17,
              tilesOwned: 2_600,
              tileShare: 0.052,
            },
      visiblePlayers,
      objective: {
        objectiveID: "agent-1:pressure_rival",
        kind: "pressure_rival",
        label: "Pressure rival",
        status: "active",
        createdTurn: 12,
        updatedTurn: 12,
        preferredActionKinds: ["attack", "embargo", "target_player", "hold"],
        progress: {
          recentDecisionCount: 1,
          alignedRecentDecisionCount: 1,
          consecutiveAlignedDecisionCount: 1,
        },
        summary: "pressure appeared before transport growth",
        notes: [],
      },
      combat: {
        ...base.combat,
        ownTroops: 150_000,
        maxTroops: 900_000,
        troopRatio: 0.17,
        canExpandIntoNeutral: false,
        borderedPlayerIDs: ["NATION0", "NATION1"],
        attackablePlayerIDs: ["NATION0", "NATION1"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        weakestAttackableTargetID: "NATION0",
        strongestAttackableTargetID: "NATION1",
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      endgame: {
        winner: null,
        leaderID: "NATION2",
        leaderName: "Nation 2",
        leaderTileShare: 0.22,
        ownTileShare: 0.052,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:NATION0:25",
        kind: "attack",
        label: "Attack Nation 0",
        intent: { type: "attack", targetID: "NATION0", troops: 37_500 },
        risk: { level: "medium", score: 0.42 },
        metadata: {
          targetID: "NATION0",
          targetName: "Nation 0",
          troopPercentage: 0.25,
          relativeTroopRatio: 0.72,
        },
      },
      {
        id: "boat:neutral:16",
        kind: "boat",
        label: "Send transport to neutral coast",
        intent: { type: "boat", troops: 24_000, dst: 777 },
        risk: { level: "medium", score: 0.25 },
        metadata: {
          targetID: null,
          targetName: "Terra Nullius",
          troops: 24_000,
          troopPercent: 16,
        },
      },
      {
        id: "target:NATION0",
        kind: "target_player",
        label: "Target Nation 0",
        intent: { type: "targetPlayer", target: "NATION0" },
        risk: { level: "low", score: 0.1 },
        metadata: { targetID: "NATION0" },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions },
      null,
    );
    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan.plan,
    );

    expect(plan.plan.objective).toBe("expand_territory");
    expect(decision.actionID).toBe("boat:neutral:16");
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
  });

  it("does not cancel safe neutral expansion just because troop ratio is low", async () => {
    const observation = reserveDisciplineObservation();
    const legalActions: LegalAction[] = [
      {
        id: "retreat:neutral-expansion",
        kind: "retreat",
        label: "Retreat neutral expansion",
        intent: { type: "cancel_attack", attackID: "neutral-expansion" },
        risk: { level: "low", score: 0.1 },
        metadata: {
          attackID: "neutral-expansion",
          targetID: null,
          targetName: "Terra Nullius",
          troops: 20_000,
        },
      },
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand",
        intent: { type: "attack", targetID: null, troops: 40_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      hold(),
    ];

    const plan = await new RuleAgentPlanner("opportunistic").plan(
      { observation, legalActions },
      null,
    );
    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan.plan,
    );

    expect(plan.plan.objective).toBe("expand_territory");
    expect(decision.actionID).toBe("expand:terra-nullius:10");
  });

  it("banks capped troops with the largest safe transport action", () => {
    const base = activeObservation("expand_territory");
    const observation: AgentObservation = {
      ...base,
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "boat:older:16",
            actionKind: "boat",
            accepted: true,
            reason: "previous transport already cleared the cap",
          },
        ],
      }),
      ownState: {
        playerID: "AGENT001",
        clientID: "CLIENT01",
        smallID: 1,
        name: "Frontier",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 190_000,
        maxTroops: 200_000,
        troopRatio: 0.95,
        gold: "250000",
        tilesOwned: 2_000,
        tileShare: 0.35,
        borderTiles: 120,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: {
        ...base.combat,
        ownTroops: 190_000,
        maxTroops: 200_000,
        troopRatio: 0.95,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        attackablePlayerIDs: [],
        borderedPlayerIDs: [],
        canExpandIntoNeutral: false,
      },
      nonCombat: {
        ...base.nonCombat,
        boatRetreatOptions: [],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat:555:8",
        kind: "boat",
        label: "Send 8% transport",
        intent: { type: "boat", troops: 15_200, dst: 555 },
        risk: { level: "low", score: 0.08 },
        metadata: {
          targetTile: 555,
          targetID: null,
          targetName: "Safe Shore",
          troops: 15_200,
          troopPercentage: 0.08,
          troopPercent: 8,
          expansion: true,
        },
      },
      {
        id: "boat:555:16",
        kind: "boat",
        label: "Send 16% transport",
        intent: { type: "boat", troops: 30_400, dst: 555 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 555,
          targetID: null,
          targetName: "Safe Shore",
          troops: 30_400,
          troopPercentage: 0.16,
          troopPercent: 16,
          expansion: true,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:transport-banking",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "bank troops before capped growth is wasted",
      startedAtTick: observation.tick,
      maxDecisionCycles: 1,
      successCriteria: ["bank a transport"],
      failureCriteria: ["waste capped growth"],
      preferredActionKinds: ["boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["naval", "expansion"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:555:16");
    expect(decision.planFollowed).toBe(true);
    expect(decision.selectedModules).toContain("neutral_expansion:naval");
  });

  it("continues troop banking while an earlier transport is still crossing", () => {
    const base = activeObservation("secure_economy");
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2101,
      tick: 2101,
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "boat:227853:16",
            actionKind: "boat",
            accepted: true,
            reason: "banked the first transport",
          },
          {
            sequence: 2,
            actionID: "hold",
            actionKind: "hold",
            accepted: true,
            reason: "waited for growth",
          },
          {
            sequence: 3,
            actionID: "target:rival-1",
            actionKind: "target_player",
            accepted: true,
            reason: "marked rival",
            targetID: "rival-1",
          },
        ],
      }),
      ownState: {
        playerID: "AGENT001",
        clientID: "CLIENT01",
        smallID: 1,
        name: "Frontier",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 1_364_625,
        maxTroops: 1_587_066,
        troopRatio: 0.86,
        gold: "250000",
        tilesOwned: 33_000,
        tileShare: 0.33,
        borderTiles: 120,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: {
        ...base.combat,
        ownTroops: 1_364_625,
        maxTroops: 1_587_066,
        troopRatio: 0.86,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        attackablePlayerIDs: [],
        borderedPlayerIDs: [],
        canExpandIntoNeutral: false,
      },
      nonCombat: {
        ...base.nonCombat,
        boatOptions: [
          {
            targetTile: 33753,
            sourceTile: 111,
            targetID: null,
            targetName: "Safe Shore",
            troops: 341_156,
            legalReason: "bank another transport",
          },
        ],
        boatRetreatOptions: [
          {
            unitID: 38,
            tile: 222,
            targetTile: 444,
            troops: 200_385,
            legalReason: "first banked transport is still crossing",
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat_retreat:38",
        kind: "boat_retreat",
        label: "Retreat transport 38",
        intent: { type: "cancel_boat", unitID: 38 },
        risk: { level: "low", score: 0.15 },
        metadata: {
          unitID: 38,
          troops: 200_385,
        },
      },
      {
        id: "boat:33753:8",
        kind: "boat",
        label: "Send 8% transport",
        intent: { type: "boat", troops: 109_170, dst: 33753 },
        risk: { level: "low", score: 0.08 },
        metadata: {
          targetTile: 33753,
          targetID: null,
          targetName: "Safe Shore",
          troopPercentage: 0.08,
          troopPercent: 8,
          expansion: true,
        },
      },
      {
        id: "boat:33753:16",
        kind: "boat",
        label: "Send 16% transport",
        intent: { type: "boat", troops: 218_340, dst: 33753 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 33753,
          targetID: null,
          targetName: "Safe Shore",
          troopPercentage: 0.16,
          troopPercent: 16,
          expansion: true,
        },
      },
      {
        id: "boat:33753:25",
        kind: "boat",
        label: "Send 25% transport",
        intent: { type: "boat", troops: 341_156, dst: 33753 },
        risk: { level: "low", score: 0.25 },
        metadata: {
          targetTile: 33753,
          targetID: null,
          targetName: "Safe Shore",
          troopPercentage: 0.25,
          troopPercent: 25,
          expansion: true,
        },
      },
      {
        id: "target:rival-1",
        kind: "target_player",
        label: "Mark rival",
        intent: { type: "targetPlayer", target: "rival-1" },
        risk: { level: "low", score: 0.05 },
        metadata: { targetID: "rival-1" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure-while-banking",
      objective: "pressure_rival",
      targetPlayerId: "rival-1",
      rationale: "pressure target while capped",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["pressure rival"],
      failureCriteria: ["waste capped growth"],
      preferredActionKinds: ["attack", "embargo_all", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:33753:25");
    expect(decision.selectedModules).toContain("naval");
  });

  it("promotes safe near-cap transport banking above pressure-only actions", () => {
    const base = activeObservation("pressure_rival");
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2501,
      tick: 2501,
      ownState: {
        playerID: "AGENT001",
        clientID: "CLIENT01",
        smallID: 1,
        name: "Frontier",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 1_504_177,
        maxTroops: 1_587_066,
        troopRatio: 0.948,
        gold: "900000",
        tilesOwned: 34_000,
        tileShare: 0.33,
        borderTiles: 140,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: {
        ...base.combat,
        ownTroops: 1_504_177,
        maxTroops: 1_587_066,
        troopRatio: 0.948,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        attackablePlayerIDs: [],
        borderedPlayerIDs: [],
        canExpandIntoNeutral: false,
      },
      nonCombat: {
        ...base.nonCombat,
        boatOptions: [
          {
            targetTile: 33753,
            sourceTile: 111,
            targetID: null,
            targetName: "Safe Shore",
            troops: 376_044,
            legalReason: "bank capped troops",
          },
        ],
        boatRetreatOptions: [
          {
            unitID: 41,
            tile: 222,
            targetTile: 444,
            troops: 682_000,
            legalReason: "previous transport is still crossing",
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat:33753:25",
        kind: "boat",
        label: "Send 25% transport",
        intent: { type: "boat", troops: 376_044, dst: 33753 },
        risk: { level: "low", score: 0.25 },
        metadata: {
          targetTile: 33753,
          targetID: null,
          targetName: "Safe Shore",
          troopPercentage: 0.25,
          troopPercent: 25,
          expansion: true,
        },
      },
      {
        id: "target:rival-1",
        kind: "target_player",
        label: "Mark rival",
        intent: { type: "targetPlayer", target: "rival-1" },
        risk: { level: "low", score: 0.05 },
        metadata: { targetID: "rival-1" },
      },
      {
        id: "build:Factory:150733",
        kind: "build",
        label: "Build Factory",
        intent: { type: "build_unit", unit: UnitType.Factory, tile: 150733 },
        risk: { level: "medium", score: 0.3 },
        metadata: { role: "economic", unit: "Factory", tile: 150733 },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure-bank",
      objective: "pressure_rival",
      targetPlayerId: "rival-1",
      rationale: "pressure rival while banking capped troops",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["pressure rival"],
      failureCriteria: ["waste capped growth"],
      preferredActionKinds: [
        "boat",
        "attack",
        "target_player",
        "build",
        "hold",
      ],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "naval", "economy", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:33753:25");
  });

  it("banks from a low-scored replay-like near-cap window instead of holding", () => {
    const base = activeObservation("pressure_rival");
    const rival: AgentVisiblePlayer = {
      playerID: "rival-1",
      clientID: "rival-1",
      smallID: 2,
      name: "Rival",
      type: PlayerType.Nation,
      isAlive: true,
      isDisconnected: false,
      hasSpawned: true,
      troops: 420_000,
      maxTroops: 600_000,
      troopRatio: 0.7,
      gold: "10000",
      tilesOwned: 24_000,
      tileShare: 0.24,
      sharesBorder: true,
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: true,
      canRequestAlliance: false,
      canDonateGold: false,
      canDonateTroops: false,
      canEmbargo: true,
      canStopEmbargo: true,
      canTarget: true,
      canBreakAlliance: false,
      canExtendAlliance: false,
      canRejectAlliance: false,
      hasEmbargoAgainst: true,
      outgoingAttack: false,
      incomingAttack: false,
      hasOutgoingAllianceRequest: false,
      hasIncomingAllianceRequest: false,
      relativeTroopRatio: 0.4,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2801,
      tick: 2801,
      visiblePlayers: [rival],
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "boat:57157:25",
            actionKind: "boat",
            accepted: true,
            reason: "banked first transport",
          },
          {
            sequence: 2,
            actionID: "boat:54169:25",
            actionKind: "boat",
            accepted: true,
            reason: "banked second transport",
          },
          {
            sequence: 3,
            actionID: "boat:58178:25",
            actionKind: "boat",
            accepted: true,
            reason: "banked third transport",
          },
        ],
      }),
      ownState: {
        playerID: "AGENT001",
        clientID: "CLIENT01",
        smallID: 1,
        name: "Frontier",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 158_394,
        maxTroops: 181_545,
        troopRatio: 0.87,
        gold: "250000",
        tilesOwned: 10_000,
        tileShare: 0.1,
        borderTiles: 120,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: {
        ...base.combat,
        ownTroops: 158_394,
        maxTroops: 181_545,
        troopRatio: 0.87,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        attackablePlayerIDs: ["rival-1"],
        borderedPlayerIDs: ["rival-1"],
        canExpandIntoNeutral: false,
        weakestAttackableTargetID: "rival-1",
        strongestAttackableTargetID: "rival-1",
      },
      nonCombat: {
        ...base.nonCombat,
        boatOptions: [
          {
            targetTile: 237_750,
            sourceTile: 111,
            targetID: null,
            targetName: "Safe Shore",
            troops: 25_343,
            legalReason: "bank capped troops",
          },
        ],
        boatRetreatOptions: [],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:rival-1:10",
        kind: "attack",
        label: "Probe Rival",
        intent: { type: "attack", targetID: "rival-1", troops: 15_839 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          targetID: "rival-1",
          targetName: "Rival",
          targetTroops: 420_000,
          targetTiles: 24_000,
          targetTileShare: 0.24,
          troopPercentage: 0.1,
          troopPercent: 10,
          relativeTroopRatio: 0.4,
        },
      },
      {
        id: "attack:rival-1:25",
        kind: "attack",
        label: "Attack Rival with 25%",
        intent: { type: "attack", targetID: "rival-1", troops: 39_599 },
        risk: { level: "medium", score: 0.45 },
        metadata: {
          targetID: "rival-1",
          targetName: "Rival",
          targetTroops: 420_000,
          targetTiles: 24_000,
          targetTileShare: 0.24,
          troopPercentage: 0.25,
          troopPercent: 25,
          relativeTroopRatio: 0.4,
        },
      },
      {
        id: "boat:237750:8",
        kind: "boat",
        label: "Send 8% transport",
        intent: { type: "boat", troops: 12_671, dst: 237_750 },
        risk: { level: "low", score: 0.08 },
        metadata: {
          targetTile: 237_750,
          targetID: null,
          targetName: "Safe Shore",
          troops: 12_671,
          troopPercentage: 0.08,
          troopPercent: 8,
          expansion: true,
        },
      },
      {
        id: "boat:237750:16",
        kind: "boat",
        label: "Send 16% transport",
        intent: { type: "boat", troops: 25_343, dst: 237_750 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 237_750,
          targetID: null,
          targetName: "Safe Shore",
          troops: 25_343,
          troopPercentage: 0.16,
          troopPercent: 16,
          expansion: true,
        },
      },
      {
        id: "quick_chat:rival-1:attack.focus",
        kind: "quick_chat",
        label: "Focus Rival",
        intent: {
          type: "quick_chat",
          recipient: "rival-1",
          quickChatKey: "attack.focus",
        },
        risk: { level: "low", score: 0.1 },
        metadata: { recipientID: "rival-1" },
      },
      {
        id: "emoji:rival-1:41",
        kind: "emoji",
        label: "Signal Rival",
        intent: { type: "emoji", recipient: "rival-1", emoji: 41 },
        risk: { level: "none", score: 0 },
        metadata: { recipientID: "rival-1" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:replay-bank-window",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "rival-1",
      rationale: "pressure rival while banking capped troops",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["pressure rival"],
      failureCriteria: ["waste capped growth"],
      preferredActionKinds: ["attack", "quick_chat", "emoji", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "naval", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:237750:16");
  });

  it("banks a replay-like near-cap transport before waiting on a blocked front", () => {
    const base = activeObservation("pressure_rival");
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1651,
      tick: 1651,
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "boat:237750:16",
            actionKind: "boat",
            accepted: true,
            reason: "banked first transport",
          },
        ],
      }),
      ownState: {
        playerID: "AGENT001",
        clientID: "CLIENT01",
        smallID: 1,
        name: "Frontier",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 299_695,
        maxTroops: 343_902,
        troopRatio: 0.87,
        gold: "250000",
        tilesOwned: 3_800,
        tileShare: 0.04,
        borderTiles: 120,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: {
        ...base.combat,
        ownTroops: 299_695,
        maxTroops: 343_902,
        troopRatio: 0.87,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        attackablePlayerIDs: ["rival-1"],
        borderedPlayerIDs: ["rival-1"],
        canExpandIntoNeutral: false,
      },
      nonCombat: {
        ...base.nonCombat,
        boatOptions: [
          {
            targetTile: 237750,
            sourceTile: 111,
            targetID: null,
            targetName: "Safe Shore",
            troops: 47_951,
            legalReason: "bank capped troops",
          },
        ],
        boatRetreatOptions: [
          {
            unitID: 13,
            tile: 222,
            targetTile: 444,
            troops: 61_788,
            legalReason: "first banked transport is still crossing",
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat:237750:16",
        kind: "boat",
        label: "Send 16% transport",
        intent: { type: "boat", troops: 47_951, dst: 237750 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 237750,
          targetID: null,
          targetName: "Safe Shore",
          troops: 47_951,
          troopPercentage: 0.16,
          troopPercent: 16,
          expansion: true,
        },
      },
      {
        id: "attack:rival-1:25",
        kind: "attack",
        label: "Attack Rival",
        intent: { type: "attack", targetID: "rival-1", troops: 74_924 },
        risk: { level: "medium", score: 0.45 },
        metadata: {
          targetID: "rival-1",
          targetName: "Rival",
          relativeTroopRatio: 0.7,
          troopPercentage: 0.25,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:bank-blocked-front",
      objective: "pressure_rival",
      targetPlayerId: "rival-1",
      rationale: "blocked front should bank capped troops",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["bank transport"],
      failureCriteria: ["waste capped growth"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "naval"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:237750:16");
  });

  it("banks troops instead of taking a high-risk player probe near cap", () => {
    const base = activeObservation("pressure_rival");
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2151,
      tick: 2151,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 417_964,
              maxTroops: 478_966,
              troopRatio: 0.87,
              tilesOwned: 6_000,
              tileShare: 0.06,
            },
      combat: {
        ...base.combat,
        ownTroops: 417_964,
        maxTroops: 478_966,
        troopRatio: 0.87,
        canExpandIntoNeutral: false,
        attackablePlayerIDs: ["rival-1"],
        borderedPlayerIDs: ["rival-1"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
      },
      nonCombat: {
        ...base.nonCombat,
        boatOptions: [
          {
            targetTile: 199155,
            sourceTile: 111,
            targetID: "rival-1",
            targetName: "Rival Coast",
            troops: 66_874,
            legalReason: "bank capped troops by sea",
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:rival-1:10",
        kind: "attack",
        label: "Probe Rival",
        intent: { type: "attack", targetID: "rival-1", troops: 41_796 },
        risk: { level: "high", score: 0.8 },
        metadata: {
          targetID: "rival-1",
          targetName: "Rival",
          troopPercentage: 0.1,
          relativeTroopRatio: 0.8,
        },
      },
      {
        id: "boat:199155:16",
        kind: "boat",
        label: "Send 16% transport",
        intent: { type: "boat", troops: 66_874, dst: 199155 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 199155,
          targetID: "rival-1",
          targetName: "Rival Coast",
          troops: 66_874,
          troopPercentage: 0.16,
          troopPercent: 16,
          relativeTroopRatio: 1.35,
          expansion: false,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:bank-over-bad-probe",
      objective: "pressure_rival",
      targetPlayerId: "rival-1",
      rationale: "do not waste a near-cap banking window on a bad probe",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["bank transport"],
      failureCriteria: ["bad 10% attack"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "naval"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:199155:16");
  });

  it("continues replay-style troop banking on a blocked land front", () => {
    const base = activeObservation("pressure_rival");
    const rival: AgentVisiblePlayer = {
      playerID: "rival-1",
      clientID: "rival-1",
      smallID: 2,
      name: "Rival",
      type: PlayerType.Nation,
      isAlive: true,
      isDisconnected: false,
      hasSpawned: true,
      troops: 545_000,
      maxTroops: 700_000,
      troopRatio: 0.78,
      gold: "10000",
      tilesOwned: 36_000,
      tileShare: 0.35,
      sharesBorder: true,
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: true,
      canRequestAlliance: false,
      canDonateGold: false,
      canDonateTroops: false,
      canEmbargo: true,
      canStopEmbargo: false,
      canTarget: true,
      canBreakAlliance: false,
      canExtendAlliance: false,
      canRejectAlliance: false,
      hasEmbargoAgainst: true,
      outgoingAttack: false,
      incomingAttack: false,
      hasOutgoingAllianceRequest: false,
      hasIncomingAllianceRequest: false,
      relativeTroopRatio: 1.25,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 4251,
      tick: 4251,
      visiblePlayers: [rival],
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "high",
      },
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "boat:160313:25",
            actionKind: "boat",
            accepted: true,
            targetID: "rival-1",
            reason: "first troop bank transport",
          },
          {
            sequence: 2,
            actionID: "hold",
            actionKind: "hold",
            accepted: true,
            reason: "waited while front was blocked",
          },
          {
            sequence: 3,
            actionID: "hold",
            actionKind: "hold",
            accepted: true,
            reason: "waited while front was blocked",
          },
        ],
      }),
      ownState: {
        playerID: "AGENT001",
        clientID: "CLIENT01",
        smallID: 1,
        name: "Frontier",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 666_912,
        maxTroops: 774_746,
        troopRatio: 0.86,
        gold: "47400",
        tilesOwned: 16_350,
        tileShare: 0.16,
        borderTiles: 120,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: {
        ...base.combat,
        ownTroops: 666_912,
        maxTroops: 774_746,
        troopRatio: 0.86,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        attackablePlayerIDs: ["rival-1"],
        borderedPlayerIDs: ["rival-1"],
        canExpandIntoNeutral: false,
      },
      nonCombat: {
        ...base.nonCombat,
        boatOptions: [
          {
            targetTile: 147270,
            sourceTile: 117225,
            targetID: "rival-1",
            targetName: "Rival Coast",
            troops: 166_728,
            legalReason:
              "bank another transport before capped growth is wasted",
          },
        ],
        boatRetreatOptions: [
          {
            unitID: 67,
            tile: 141830,
            targetTile: 160313,
            troops: 175_757,
            legalReason: "first banked transport is still crossing",
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:rival-1:25",
        kind: "attack",
        label: "Attack Rival",
        intent: { type: "attack", targetID: "rival-1", troops: 166_728 },
        risk: { level: "medium", score: 0.45 },
        metadata: {
          targetID: "rival-1",
          targetName: "Rival",
          targetTroops: 545_000,
          targetTileShare: 0.35,
          troopPercentage: 0.25,
          troopPercent: 25,
          relativeTroopRatio: 1.25,
        },
      },
      {
        id: "boat:147270:16",
        kind: "boat",
        label: "Send 16% transport",
        intent: { type: "boat", troops: 106_706, dst: 147270 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 147270,
          targetID: "rival-1",
          targetName: "Rival Coast",
          troops: 106_706,
          troopPercentage: 0.16,
          troopPercent: 16,
          relativeTroopRatio: 1.25,
          expansion: false,
        },
      },
      {
        id: "boat:147270:25",
        kind: "boat",
        label: "Send 25% transport",
        intent: { type: "boat", troops: 166_728, dst: 147270 },
        risk: { level: "low", score: 0.25 },
        metadata: {
          targetTile: 147270,
          targetID: "rival-1",
          targetName: "Rival Coast",
          troops: 166_728,
          troopPercentage: 0.25,
          troopPercent: 25,
          relativeTroopRatio: 1.25,
          expansion: false,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:survival-bank-window",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: "rival-1",
      rationale: "survival front is blocked, so bank capped troops",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["survive"],
      failureCriteria: ["waste capped growth"],
      preferredActionKinds: ["retreat", "boat_retreat", "build", "hold"],
      forbiddenActionKinds: ["attack"],
      enabledModules: ["emergency_survival", "defense", "naval"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:147270:25");
  });

  it("spends near-cap troops on a clean weak-rival conversion before banking", () => {
    const base = activeObservation("pressure_rival");
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2926,
      tick: 2926,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 141_331,
              maxTroops: 158_540,
              troopRatio: 0.89,
              tilesOwned: 9_000,
              tileShare: 0.09,
            },
      combat: {
        ...base.combat,
        ownTroops: 141_331,
        maxTroops: 158_540,
        troopRatio: 0.89,
        canExpandIntoNeutral: false,
        attackablePlayerIDs: ["rival-1"],
        borderedPlayerIDs: ["rival-1"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: ["rival-1"],
        outgoingAttacks: [],
      },
      nonCombat: {
        ...base.nonCombat,
        boatOptions: [
          {
            targetTile: 66_662,
            sourceTile: 111,
            targetID: "rival-1",
            targetName: "Rival Coast",
            troops: 35_332,
            legalReason: "bank capped troops by sea",
          },
        ],
        boatRetreatOptions: [
          {
            unitID: 13,
            tile: 222,
            targetTile: 444,
            troops: 23_450,
            legalReason: "active banked transport is still crossing",
          },
        ],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "attack:rival-1:10",
        kind: "attack",
        label: "Probe Rival",
        intent: { type: "attack", targetID: "rival-1", troops: 14_133 },
        risk: { level: "medium", score: 0.15 },
        metadata: {
          targetID: "rival-1",
          targetName: "Rival",
          targetTroops: 48_573,
          troopPercentage: 0.1,
          relativeTroopRatio: 2.91,
          outgoingAttack: true,
        },
      },
      {
        id: "attack:rival-1:25",
        kind: "attack",
        label: "Attack Rival",
        intent: { type: "attack", targetID: "rival-1", troops: 35_333 },
        risk: { level: "medium", score: 0.28 },
        metadata: {
          targetID: "rival-1",
          targetName: "Rival",
          targetTroops: 48_573,
          troopPercentage: 0.25,
          relativeTroopRatio: 2.91,
          outgoingAttack: true,
        },
      },
      {
        id: "boat:66662:25",
        kind: "boat",
        label: "Send 25% transport",
        intent: { type: "boat", troops: 35_332, dst: 66_662 },
        risk: { level: "medium", score: 0.22 },
        metadata: {
          targetTile: 66_662,
          targetID: "rival-1",
          targetName: "Rival Coast",
          troops: 35_332,
          troopPercentage: 0.25,
          troopPercent: 25,
          relativeTroopRatio: 2.91,
          expansion: false,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:near-cap-convert-before-bank",
      objective: "pressure_rival",
      targetPlayerId: "rival-1",
      rationale: "near cap should spend troops on clean current-rival land",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["convert weak rival"],
      failureCriteria: ["repeat tiny probe"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "naval"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:rival-1:25");
  });

  it("lets finish pressure outrank transport troop banking", () => {
    const base = activeObservation("pressure_rival");
    const rival: AgentVisiblePlayer = {
      playerID: "rival-1",
      clientID: "rival-1",
      smallID: 2,
      name: "Rival",
      type: PlayerType.Nation,
      isAlive: true,
      isDisconnected: false,
      hasSpawned: true,
      troops: 120_000,
      maxTroops: 300_000,
      troopRatio: 0.4,
      gold: "10000",
      tilesOwned: 7_000,
      tileShare: 0.08,
      sharesBorder: true,
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: true,
      canRequestAlliance: false,
      canDonateGold: false,
      canDonateTroops: false,
      canEmbargo: true,
      hasEmbargoAgainst: false,
      outgoingAttack: false,
      incomingAttack: false,
      hasOutgoingAllianceRequest: false,
      hasIncomingAllianceRequest: false,
      relativeTroopRatio: 1.5,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2301,
      tick: 2301,
      visiblePlayers: [rival],
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "attack:rival-1:10",
            actionKind: "attack",
            accepted: true,
            reason: "probe",
            targetID: "rival-1",
          },
          {
            sequence: 2,
            actionID: "attack:rival-1:10",
            actionKind: "attack",
            accepted: true,
            reason: "probe",
            targetID: "rival-1",
          },
          {
            sequence: 3,
            actionID: "attack:rival-1:10",
            actionKind: "attack",
            accepted: true,
            reason: "probe",
            targetID: "rival-1",
          },
        ],
      }),
      ownState: {
        playerID: "AGENT001",
        clientID: "CLIENT01",
        smallID: 1,
        name: "Frontier",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 190_000,
        maxTroops: 200_000,
        troopRatio: 0.95,
        gold: "250000",
        tilesOwned: 12_000,
        tileShare: 0.16,
        borderTiles: 140,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: {
        ...base.combat,
        ownTroops: 190_000,
        maxTroops: 200_000,
        troopRatio: 0.95,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
        attackablePlayerIDs: ["rival-1"],
        borderedPlayerIDs: ["rival-1"],
        canExpandIntoNeutral: false,
      },
      nonCombat: {
        ...base.nonCombat,
        boatRetreatOptions: [],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat:555:16",
        kind: "boat",
        label: "Send 16% transport",
        intent: { type: "boat", troops: 30_400, dst: 555 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 555,
          targetID: null,
          targetName: "Safe Shore",
          troops: 30_400,
          troopPercentage: 0.16,
          troopPercent: 16,
          expansion: true,
        },
      },
      {
        id: "attack:rival-1:25",
        kind: "attack",
        label: "Attack Rival 25%",
        intent: { type: "attack", targetID: "rival-1", troops: 47_500 },
        risk: { level: "medium", score: 0.25 },
        metadata: {
          targetID: "rival-1",
          targetName: "Rival",
          targetTroops: 120_000,
          targetTiles: 7_000,
          targetTileShare: 0.08,
          relativeTroopRatio: 1.5,
          troopPercentage: 0.25,
          troopPercent: 25,
        },
      },
      {
        id: "attack:rival-1:10",
        kind: "attack",
        label: "Attack Rival 10%",
        intent: { type: "attack", targetID: "rival-1", troops: 19_000 },
        risk: { level: "medium", score: 0.1 },
        metadata: {
          targetID: "rival-1",
          targetName: "Rival",
          targetTroops: 120_000,
          targetTiles: 7_000,
          targetTileShare: 0.08,
          relativeTroopRatio: 1.5,
          troopPercentage: 0.1,
          troopPercent: 10,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:finish-before-bank",
      objective: "pressure_rival",
      targetPlayerId: "rival-1",
      rationale: "finish weakened rival before banking transport troops",
      startedAtTick: observation.tick,
      maxDecisionCycles: 3,
      successCriteria: ["finish rival"],
      failureCriteria: ["waste capped growth"],
      preferredActionKinds: ["boat", "attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "naval"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(
      buildAgentTacticalAffordances({ observation, legalActions })
        .frontierFinishPressure?.recommended,
    ).toBe(true);
    expect(decision.actionID).toBe("attack:rival-1:25");
  });

  it("prioritizes opening tempo expansion over stalling actions", () => {
    const base = activeObservation("expand_territory");
    const observation: AgentObservation = {
      ...base,
      turnNumber: 900,
      ownState: {
        playerID: "AGENT001",
        clientID: "CLIENT01",
        smallID: 1,
        name: "Frontier",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 120_000,
        maxTroops: 250_000,
        troopRatio: 0.48,
        gold: "250000",
        tilesOwned: 1_200,
        tileShare: 0.015,
        borderTiles: 90,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: {
        ...base.combat,
        ownTroops: 120_000,
        maxTroops: 250_000,
        troopRatio: 0.48,
        canExpandIntoNeutral: true,
        neutralExpansionLegalReason: "test neutral growth",
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand into neutral land",
        intent: { type: "attack", targetID: null, troops: 24_000 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          expansion: true,
          troopPercentage: 0.2,
          troopPercent: 20,
        },
      },
      {
        id: "build:Defense Post:148252",
        kind: "build",
        label: "Build Defense Post",
        intent: {
          type: "build_unit",
          unit: UnitType.DefensePost,
          tile: 148252,
        },
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "defensive",
          unit: "Defense Post",
          defensiveValue: 100,
          isBorderBuild: true,
          nearbyEnemyCount: 2,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:opening-tempo",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "grow before the opening closes",
      startedAtTick: observation.tick,
      maxDecisionCycles: 1,
      successCriteria: ["gain land"],
      failureCriteria: ["stall while neutral land is legal"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "defense"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:20");
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
  });

  it("treats legal neutral land as a standing priority over fortifying", () => {
    const base = activeObservation("fortify_border");
    const observation: AgentObservation = {
      ...base,
      turnNumber: 401,
      tick: 401,
      ownState: {
        playerID: "AGENT001",
        clientID: "CLIENT01",
        smallID: 1,
        name: "Frontier",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 240_000,
        maxTroops: 500_000,
        troopRatio: 0.48,
        gold: "250000",
        tilesOwned: 13_000,
        tileShare: 0.13,
        borderTiles: 220,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: {
        ...base.combat,
        ownTroops: 240_000,
        maxTroops: 500_000,
        troopRatio: 0.48,
        canExpandIntoNeutral: true,
        neutralExpansionLegalReason: "neutral land still borders us",
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      strategic: {
        ...base.strategic,
        priority: "build_defense",
        urgency: "medium",
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL001",
        leaderName: "Rival",
        leaderTileShare: 0.16,
        ownTileShare: 0.13,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand into neutral land with 10%",
        intent: { type: "attack", targetID: null, troops: 24_000 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          expansion: true,
          targetID: null,
          targetName: "Terra Nullius",
          troopPercentage: 0.1,
          troopPercent: 10,
        },
      },
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand into neutral land with 20%",
        intent: { type: "attack", targetID: null, troops: 48_000 },
        risk: { level: "low", score: 0.2 },
        metadata: {
          expansion: true,
          targetID: null,
          targetName: "Terra Nullius",
          troopPercentage: 0.2,
          troopPercent: 20,
        },
      },
      {
        id: "expand:terra-nullius:35",
        kind: "attack",
        label: "Expand into neutral land with 35%",
        intent: { type: "attack", targetID: null, troops: 84_000 },
        risk: { level: "medium", score: 0.35 },
        metadata: {
          expansion: true,
          targetID: null,
          targetName: "Terra Nullius",
          troopPercentage: 0.35,
          troopPercent: 35,
        },
      },
      {
        id: "build:Defense Post:164146",
        kind: "build",
        label: "Build Defense Post",
        intent: {
          type: "build_unit",
          unit: UnitType.DefensePost,
          tile: 164146,
        },
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "defensive",
          unit: "Defense Post",
          defensiveValue: 100,
          isBorderBuild: true,
          nearbyEnemyCount: 2,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:fortify-while-neutral-visible",
      objective: "fortify_border",
      targetPlayerId: null,
      rationale: "planner wants defense, executor should not ignore free land",
      startedAtTick: observation.tick,
      maxDecisionCycles: 1,
      successCriteria: ["stabilize border"],
      failureCriteria: ["stall while neutral land is legal"],
      preferredActionKinds: ["build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["defense", "economy"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:20");
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
  });

  it("sends a neutral island transport when direct neutral land is gone", () => {
    const base = activeObservation("pressure_rival");
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1201,
      tick: 1201,
      ownState: {
        playerID: "AGENT001",
        clientID: "CLIENT01",
        smallID: 1,
        name: "Frontier",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 360_000,
        maxTroops: 600_000,
        troopRatio: 0.6,
        gold: "250000",
        tilesOwned: 11_000,
        tileShare: 0.11,
        borderTiles: 180,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: {
        ...base.combat,
        ownTroops: 360_000,
        maxTroops: 600_000,
        troopRatio: 0.6,
        canExpandIntoNeutral: false,
        neutralExpansionLegalReason: null,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        borderedPlayerIDs: ["RIVAL001"],
        attackablePlayerIDs: ["RIVAL001"],
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL001",
        leaderName: "Rival",
        leaderTileShare: 0.18,
        ownTileShare: 0.11,
        turnsToTimer: 5_000,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat:neutral:8",
        kind: "boat",
        label: "Send 8% transport to Terra Nullius",
        intent: { type: "boat", troops: 28_800, dst: 777 },
        risk: { level: "low", score: 0.08 },
        metadata: {
          targetTile: 777,
          targetID: null,
          targetName: "Terra Nullius",
          troops: 28_800,
          troopPercentage: 0.08,
          troopPercent: 8,
          expansion: true,
        },
      },
      {
        id: "boat:neutral:16",
        kind: "boat",
        label: "Send 16% transport to Terra Nullius",
        intent: { type: "boat", troops: 57_600, dst: 777 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 777,
          targetID: null,
          targetName: "Terra Nullius",
          troops: 57_600,
          troopPercentage: 0.16,
          troopPercent: 16,
          expansion: true,
        },
      },
      {
        id: "boat:neutral:25",
        kind: "boat",
        label: "Send 25% transport to Terra Nullius",
        intent: { type: "boat", troops: 90_000, dst: 777 },
        risk: { level: "medium", score: 0.25 },
        metadata: {
          targetTile: 777,
          targetID: null,
          targetName: "Terra Nullius",
          troops: 90_000,
          troopPercentage: 0.25,
          troopPercent: 25,
          expansion: true,
        },
      },
      {
        id: "build:City:100",
        kind: "build",
        label: "Build City",
        intent: { type: "build_unit", unit: UnitType.City, tile: 100 },
        risk: { level: "low", score: 0.1 },
        metadata: { role: "economic", unit: "City" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:economy-but-island-neutral",
      objective: "secure_economy",
      targetPlayerId: null,
      rationale: "planner wants economy, executor should still take islands",
      startedAtTick: observation.tick,
      maxDecisionCycles: 1,
      successCriteria: ["build economy"],
      failureCriteria: ["leave neutral islands empty"],
      preferredActionKinds: ["build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["economy"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("boat:neutral:25");
    expect(decision.selectedModules).toContain("neutral_expansion:naval");
  });

  it("launches neutral island transports during the first three minutes even while mainland neutral land remains", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 901,
      tick: 901,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 600_000,
              maxTroops: 1_000_000,
              troopRatio: 0.6,
              tilesOwned: 9_000,
              tileShare: 0.09,
            },
      combat: {
        ...base.combat,
        ownTroops: 600_000,
        maxTroops: 1_000_000,
        troopRatio: 0.6,
        canExpandIntoNeutral: true,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      nonCombat: {
        ...base.nonCombat,
        boatRetreatOptions: [],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:35",
        kind: "attack",
        label: "Expand 35%",
        intent: { type: "attack", targetID: null, troops: 210_000 },
        risk: { level: "low", score: 0.2 },
        metadata: {
          targetID: null,
          targetName: "Terra Nullius",
          expansion: true,
          troopPercentage: 0.35,
          troopPercent: 35,
        },
      },
      {
        id: "boat:777:8",
        kind: "boat",
        label: "Send 8% transport to Terra Nullius",
        intent: { type: "boat", troops: 48_000, dst: 777 },
        risk: { level: "low", score: 0.08 },
        metadata: {
          targetTile: 777,
          sourceTile: 111,
          targetID: null,
          targetName: "Terra Nullius",
          troops: 48_000,
          troopPercentage: 0.08,
          troopPercent: 8,
          expansion: true,
        },
      },
      {
        id: "boat:777:16",
        kind: "boat",
        label: "Send 16% transport to Terra Nullius",
        intent: { type: "boat", troops: 96_000, dst: 777 },
        risk: { level: "low", score: 0.16 },
        metadata: {
          targetTile: 777,
          sourceTile: 111,
          targetID: null,
          targetName: "Terra Nullius",
          troops: 96_000,
          troopPercentage: 0.16,
          troopPercent: 16,
          expansion: true,
        },
      },
      {
        id: "boat:777:25",
        kind: "boat",
        label: "Send 25% transport to Terra Nullius",
        intent: { type: "boat", troops: 150_000, dst: 777 },
        risk: { level: "medium", score: 0.25 },
        metadata: {
          targetTile: 777,
          sourceTile: 111,
          targetID: null,
          targetName: "Terra Nullius",
          troops: 150_000,
          troopPercentage: 0.25,
          troopPercent: 25,
          expansion: true,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:island-rush",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "claim mainland and island neutral land before rivals",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["take all neutral land"],
      failureCriteria: ["leave island neutral"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "naval"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic", {
      settings: { territoryFirstNeutralLandEnabled: true },
    }).decide({ observation, legalActions }, plan);

    expect(decision.actionID).toBe("boat:777:25");
    expect(decision.actionIDs).toContain("boat:777:25");
    expect(decision.actionIDs).toContain("expand:terra-nullius:35");
    expect(decision.selectedModules).toContain("neutral_expansion:naval");
  });

  it("maximizes neutral territory before hostile attacks when neutral land is legal", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_501,
      tick: 1_501,
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
      },
      combat: {
        ...base.combat,
        canExpandIntoNeutral: true,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
    };
    const legalActions: LegalAction[] = [
      hardNationAttackAction("RIVAL02", "Rival", 25, 130_000, 1.4, 0.16),
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand 20%",
        intent: { type: "attack", targetID: null, troops: 104_000 },
        risk: { level: "low", score: 0.2 },
        metadata: {
          targetID: null,
          targetName: "Terra Nullius",
          expansion: true,
          troopPercentage: 0.2,
          troopPercent: 20,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure-but-neutral-open",
      objective: "pressure_rival",
      targetPlayerId: "RIVAL02",
      rationale: "pressure is available, but neutral land is still free",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["gain land"],
      failureCriteria: ["waste troops"],
      preferredActionKinds: ["attack", "target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "expansion"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("expand:terra-nullius:20");
    expect(decision.selectedModules).toContain("neutral_expansion:expansion");
  });

  it("batches alliance or trade and visible social actions after neutral growth", () => {
    const observation = earlyExpansionObservation();
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand 20%",
        intent: { type: "attack", targetID: null, troops: 104_000 },
        risk: { level: "low", score: 0.2 },
        metadata: {
          targetID: null,
          targetName: "Terra Nullius",
          expansion: true,
          troopPercentage: 0.2,
          troopPercent: 20,
        },
      },
      {
        id: "donate_gold:ALLY01",
        kind: "donate_gold",
        label: "Donate gold to Ally",
        intent: { type: "donate_gold", recipient: "ALLY01", gold: 12_000 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          recipientID: "ALLY01",
          recipientName: "Ally",
          gold: 12_000,
        },
      },
      {
        id: "alliance:ALLY01",
        kind: "alliance_request",
        label: "Request alliance with Ally",
        intent: { type: "allianceRequest", recipient: "ALLY01" },
        risk: { level: "low", score: 0.1 },
        metadata: { recipientID: "ALLY01", recipientName: "Ally" },
      },
      {
        id: "quick_chat:ALLY01:attack.focus",
        kind: "quick_chat",
        label: "Coordinate with Ally",
        intent: {
          type: "quick_chat",
          recipient: "ALLY01",
          quickChatKey: "attack.focus",
          target: "RIVAL02",
        },
        risk: { level: "none", score: 0 },
        metadata: {
          recipientID: "ALLY01",
          recipientName: "Ally",
          targetID: "RIVAL02",
          targetName: "Rival",
          message: "Ally, focus Rival!",
        },
      },
      {
        id: "emoji:ALLY01:41",
        kind: "emoji",
        label: "Send target emoji",
        intent: { type: "emoji", recipient: "ALLY01", emoji: 41 },
        risk: { level: "none", score: 0 },
        metadata: {
          recipientID: "ALLY01",
          recipientName: "Ally",
          emoji: 41,
          emojiText: "target",
          emojiContext: "pressure_target",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:territory-social",
      objective: "build_alliance",
      targetPlayerId: null,
      rationale: "grow first, then coordinate",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["gain land", "coordinate"],
      failureCriteria: ["stall"],
      preferredActionKinds: [
        "attack",
        "donate_gold",
        "alliance_request",
        "quick_chat",
        "emoji",
      ],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "diplomacy", "utility_social"],
      tacticalSettings: { maxActionsPerDecision: 4 },
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("diplomatic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionIDs).toEqual([
      "expand:terra-nullius:20",
      "donate_gold:ALLY01",
      "quick_chat:ALLY01:attack.focus",
      "emoji:ALLY01:41",
    ]);
  });

  it("adds missile silo construction to agents-only neutral growth batches", () => {
    const base = earlyExpansionObservation();
    const humanRival = {
      ...base.visiblePlayers[0],
      type: PlayerType.Human,
    };
    const humanAlly = {
      ...base.visiblePlayers[1],
      type: PlayerType.Human,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_801,
      tick: 1_801,
      visiblePlayers: [humanRival, humanAlly],
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              tilesOwned: 18_000,
              tileShare: 0.18,
              unitCounts: {
                [UnitType.City]: 1,
                [UnitType.Factory]: 1,
                [UnitType.MissileSilo]: 0,
              },
            },
      memory: {
        ...base.memory,
        recentActions: [],
        recentBuildCount: 0,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand 20%",
        intent: { type: "attack", targetID: null, troops: 104_000 },
        risk: { level: "low", score: 0.2 },
        metadata: {
          targetID: null,
          targetName: "Terra Nullius",
          expansion: true,
          troopPercentage: 0.2,
          troopPercent: 20,
        },
      },
      {
        id: "build:Missile Silo:555",
        kind: "build",
        label: "Build Missile Silo",
        intent: {
          type: "build_unit",
          unit: UnitType.MissileSilo,
          tile: 555,
        },
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "infrastructure",
          unit: UnitType.MissileSilo,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:agents-only-growth-silo",
      objective: "expand_territory",
      targetPlayerId: null,
      rationale: "take land while preparing late-game weapons",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["gain land", "unlock deterrence"],
      failureCriteria: ["stay low-tech"],
      preferredActionKinds: ["attack", "build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "economy", "nuclear_endgame"],
      tacticalSettings: { maxActionsPerDecision: 3 },
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic", {
      settings: {
        territoryFirstNeutralLandEnabled: true,
        maxActionsPerDecision: 3,
      },
    }).decide({ observation, legalActions }, plan);

    expect(decision.actionIDs).toContain("expand:terra-nullius:20");
    expect(decision.actionIDs).toContain("build:Missile Silo:555");
    expect(decision.selectedModules).toContain("nuclear_endgame");
  });

  it("selects a legal nuke during agents-only late political play", () => {
    const base = earlyExpansionObservation();
    const humanLeader = {
      ...base.visiblePlayers[0],
      type: PlayerType.Human,
      playerID: "HUMAN02",
      clientID: "HUMAN02",
      name: "Human Leader",
      canAttack: true,
    };
    const humanRival = {
      ...base.visiblePlayers[1],
      type: PlayerType.Human,
      playerID: "HUMAN03",
      clientID: "HUMAN03",
      name: "Human Rival",
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: true,
      canTarget: true,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 3_001,
      tick: 3_001,
      visiblePlayers: [humanLeader, humanRival],
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              tilesOwned: 32_000,
              tileShare: 0.32,
              unitCounts: {
                [UnitType.City]: 2,
                [UnitType.Factory]: 2,
                [UnitType.MissileSilo]: 1,
              },
            },
      combat: {
        ...base.combat,
        canExpandIntoNeutral: false,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "HUMAN02",
        leaderName: "Human Leader",
        leaderTileShare: 0.34,
        ownTileShare: 0.32,
        turnsToTimer: 5_000,
      },
      memory: {
        ...base.memory,
        recentActions: [],
        recentBuildCount: 0,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "nuke:MIRV:HUMAN02:777",
        kind: "nuke",
        label: "Launch MIRV at Human Leader",
        intent: {
          type: "build_unit",
          unit: UnitType.MIRV,
          tile: 777,
        },
        risk: { level: "medium", score: 0.45 },
        metadata: {
          unit: UnitType.MIRV,
          targetID: "HUMAN02",
          targetName: "Human Leader",
        },
      },
      {
        id: "target:HUMAN02",
        kind: "target_player",
        label: "Target Human Leader",
        intent: { type: "targetPlayer", target: "HUMAN02" },
        risk: { level: "low", score: 0.05 },
        metadata: { targetID: "HUMAN02", targetName: "Human Leader" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:agents-only-nuke",
      objective: "pressure_rival",
      targetPlayerId: "HUMAN02",
      rationale: "late politics escalates when a legal strike exists",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["stop leader"],
      failureCriteria: ["ignore legal deterrence"],
      preferredActionKinds: ["target_player", "hold"],
      forbiddenActionKinds: ["nuke"],
      enabledModules: ["combat", "nuclear_endgame", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("nuke:MIRV:HUMAN02:777");
    expect(decision.selectedModules).toContain("nuclear_endgame");
  });

  it("prioritizes a leader silo nuke during late hard-nation pressure", () => {
    const base = earlyExpansionObservation();
    const nationLeader: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      type: PlayerType.Nation,
      playerID: "NATION02",
      clientID: "NATION02",
      name: "Hard Leader",
      tilesOwned: 36_000,
      tileShare: 0.36,
      troops: 1_100_000,
      relativeTroopRatio: 0.82,
      canAttack: true,
      canTarget: true,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2_200,
      tick: 2_200,
      visiblePlayers: [nationLeader],
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              tilesOwned: 24_000,
              tileShare: 0.24,
              troops: 900_000,
              unitCounts: {
                [UnitType.City]: 2,
                [UnitType.Factory]: 1,
                [UnitType.MissileSilo]: 1,
                [UnitType.SAMLauncher]: 1,
              },
            },
      combat: {
        ...base.combat,
        canExpandIntoNeutral: false,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "NATION02",
        leaderName: "Hard Leader",
        leaderTileShare: 0.36,
        ownTileShare: 0.24,
        turnsToTimer: 4_000,
      },
      memory: {
        ...base.memory,
        recentActions: [],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "nuke:Hydrogen Bomb:NATION02:777",
        kind: "nuke",
        label: "Launch Hydrogen Bomb at Hard Leader silo",
        intent: {
          type: "build_unit",
          unit: UnitType.HydrogenBomb,
          tile: 777,
        },
        risk: { level: "high", score: 0.75 },
        metadata: {
          unit: UnitType.HydrogenBomb,
          targetID: "NATION02",
          targetName: "Hard Leader",
          targetTileShare: 0.36,
          targetStructureUnit: UnitType.MissileSilo,
          targetStructurePriority: 120,
          nuclearTargetPriority: 210,
        },
      },
      {
        id: "target:NATION02",
        kind: "target_player",
        label: "Target Hard Leader",
        intent: { type: "targetPlayer", target: "NATION02" },
        risk: { level: "low", score: 0.05 },
        metadata: { targetID: "NATION02", targetName: "Hard Leader" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:nuclear-leader-denial",
      objective: "pressure_rival",
      targetPlayerId: "NATION02",
      rationale: "leader has a strikeable silo",
      startedAtTick: observation.tick,
      maxDecisionCycles: 1,
      successCriteria: ["remove counterstrike"],
      failureCriteria: ["let leader snowball"],
      preferredActionKinds: ["target_player", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["combat", "nuclear_endgame"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("nuke:Hydrogen Bomb:NATION02:777");
    expect(decision.selectedModules).toContain("nuclear_endgame");
  });

  it("builds SAM coverage once a silo and valuable economy exist", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_900,
      tick: 1_900,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              tilesOwned: 18_000,
              tileShare: 0.18,
              unitCounts: {
                [UnitType.City]: 2,
                [UnitType.Factory]: 1,
                [UnitType.Port]: 1,
                [UnitType.MissileSilo]: 1,
                [UnitType.SAMLauncher]: 0,
              },
            },
      combat: {
        ...base.combat,
        canExpandIntoNeutral: false,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.28,
        ownTileShare: 0.18,
        turnsToTimer: 5_000,
      },
      memory: {
        ...base.memory,
        recentActions: [],
        recentBuildCount: 0,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "build:SAM Launcher:888",
        kind: "build",
        label: "Build SAM Launcher",
        intent: {
          type: "build_unit",
          unit: UnitType.SAMLauncher,
          tile: 888,
        },
        risk: { level: "low", score: 0.1 },
        metadata: {
          role: "defensive",
          unit: UnitType.SAMLauncher,
        },
      },
      {
        id: "build:City:555",
        kind: "build",
        label: "Build City",
        intent: { type: "build_unit", unit: UnitType.City, tile: 555 },
        risk: { level: "medium", score: 0.25 },
        metadata: { role: "economic", unit: UnitType.City },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:nuclear-deterrence",
      objective: "secure_economy",
      targetPlayerId: null,
      rationale: "protect silo and economy before nuclear exchange",
      startedAtTick: observation.tick,
      maxDecisionCycles: 1,
      successCriteria: ["add air defense"],
      failureCriteria: ["leave silo naked"],
      preferredActionKinds: ["build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["economy", "defense", "nuclear_endgame"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("defensive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("build:SAM Launcher:888");
    expect(decision.selectedModules).toContain("nuclear_endgame");
  });

  it("forms temporary pacts during agents-only political theatre", () => {
    const base = earlyExpansionObservation();
    const humanNeighbor: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      type: PlayerType.Human,
      playerID: "HUMAN02",
      clientID: "HUMAN02",
      name: "Useful Neighbor",
      isAlive: true,
      canRequestAlliance: true,
      hasIncomingAllianceRequest: true,
      tilesOwned: 22_000,
      tileShare: 0.22,
    };
    const humanRival: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      type: PlayerType.Human,
      playerID: "HUMAN03",
      clientID: "HUMAN03",
      name: "Quiet Rival",
      isAlive: true,
      canAttack: true,
      tilesOwned: 16_000,
      tileShare: 0.16,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_000,
      tick: 1_000,
      visiblePlayers: [humanNeighbor, humanRival],
      combat: {
        ...base.combat,
        canExpandIntoNeutral: false,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      memory: {
        ...base.memory,
        recentActions: [],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "alliance:HUMAN02",
        kind: "alliance_request",
        label: "Request alliance with Useful Neighbor",
        intent: { type: "allianceRequest", recipient: "HUMAN02" },
        risk: { level: "low", score: 0.2 },
        metadata: {
          recipientID: "HUMAN02",
          recipientName: "Useful Neighbor",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:temporary-pact",
      objective: "pressure_rival",
      targetPlayerId: "HUMAN03",
      rationale: "agent-only politics should form temporary blocs",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["create pact"],
      failureCriteria: ["stay isolated"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: ["alliance_request"],
      enabledModules: ["combat", "diplomacy"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("diplomatic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("alliance:HUMAN02");
    expect(decision.selectedModules).toContain("diplomacy");
  });

  it("breaks a fragile alliance during agents-only political theatre", () => {
    const base = earlyExpansionObservation();
    const allyLeader: AgentVisiblePlayer = {
      ...base.visiblePlayers[0],
      type: PlayerType.Human,
      playerID: "ALLY02",
      clientID: "ALLY02",
      name: "Too Useful Ally",
      isAlive: true,
      isAllied: true,
      isFriendly: true,
      canAttack: false,
      canBreakAlliance: true,
      tilesOwned: 34_000,
      tileShare: 0.34,
      troops: 760_000,
      relativeTroopRatio: 0.9,
    };
    const humanRival: AgentVisiblePlayer = {
      ...base.visiblePlayers[1],
      type: PlayerType.Human,
      playerID: "HUMAN03",
      clientID: "HUMAN03",
      name: "Quiet Rival",
      isAlive: true,
      isAllied: false,
      isFriendly: false,
      relation: Relation.Neutral,
      canAttack: true,
      canTarget: true,
      tilesOwned: 18_000,
      tileShare: 0.18,
      troops: 410_000,
      relativeTroopRatio: 1.35,
    };
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2_200,
      tick: 2_200,
      visiblePlayers: [allyLeader, humanRival],
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 900_000,
              tilesOwned: 28_000,
              tileShare: 0.28,
            },
      combat: {
        ...base.combat,
        ownTroops: 900_000,
        canExpandIntoNeutral: false,
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
      },
      endgame: {
        winner: null,
        leaderID: "ALLY02",
        leaderName: "Too Useful Ally",
        leaderTileShare: 0.34,
        ownTileShare: 0.28,
        turnsToTimer: 6_000,
      },
      memory: {
        ...base.memory,
        recentActions: [],
        recentBuildCount: 0,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "break_alliance:ALLY02",
        kind: "break_alliance",
        label: "Break alliance with Too Useful Ally",
        intent: { type: "breakAlliance", recipient: "ALLY02" },
        risk: { level: "high", score: 0.7 },
        metadata: {
          targetID: "ALLY02",
          targetName: "Too Useful Ally",
          action: "break",
        },
      },
      {
        id: "quick_chat:ALLY02:misc.team_up",
        kind: "quick_chat",
        label: "Public chat",
        intent: {
          type: "quick_chat",
          recipient: "ALLY02",
          quickChatKey: "misc.team_up" as never,
        },
        risk: { level: "none", score: 0 },
        metadata: {
          recipientID: "ALLY02",
          recipientName: "Too Useful Ally",
          message:
            "Too Useful Ally, I can keep this pact or open your border. Convince me.",
        },
      },
      {
        id: "emoji:ALLY02:10",
        kind: "emoji",
        label: "Send evil emoji",
        intent: { type: "emoji", recipient: "ALLY02", emoji: 10 },
        risk: { level: "none", score: 0 },
        metadata: {
          recipientID: "ALLY02",
          recipientName: "Too Useful Ally",
          emoji: 10,
          emojiText: "evil",
          emojiContext: "betrayal_signal",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:political-theatre",
      objective: "build_alliance",
      targetPlayerId: "ALLY02",
      rationale: "agent-only showcase should create visible politics",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["create drama"],
      failureCriteria: ["stay boring"],
      preferredActionKinds: ["quick_chat", "emoji", "hold"],
      forbiddenActionKinds: ["break_alliance"],
      enabledModules: ["diplomacy", "combat", "utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("break_alliance:ALLY02");
    expect(decision.actionIDs).toContain("quick_chat:ALLY02:misc.team_up");
    expect(decision.actionIDs).toContain("emoji:ALLY02:10");
    expect(decision.selectedModules).toContain("combat");
  });
});

function activeObservation(
  objectiveKind: AgentObjectiveKind,
): AgentObservation {
  const observation = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: null,
    username: "Planner Agent",
    profile: "opportunistic",
    gameID: "PLAN",
    turnNumber: 4,
    phaseOverride: "active",
  });
  return {
    ...observation,
    objective: {
      objectiveID: `agent-1:${objectiveKind}`,
      kind: objectiveKind,
      label: objectiveKind,
      status: "active",
      createdTurn: 4,
      updatedTurn: 4,
      preferredActionKinds:
        objectiveKind === "secure_economy"
          ? ["build", "hold"]
          : ["attack", "hold"],
      progress: {
        recentDecisionCount: 0,
        alignedRecentDecisionCount: 0,
        consecutiveAlignedDecisionCount: 0,
      },
      summary: `${objectiveKind} active`,
      notes: [],
    },
  };
}

function buildLegalActions(): LegalAction[] {
  return [
    {
      id: "expand:terra-nullius:10",
      kind: "attack",
      label: "Expand",
      intent: { type: "attack", targetID: null, troops: 100 },
      risk: { level: "low", score: 0.1 },
      metadata: { expansion: true },
    },
    {
      id: "build:City:100",
      kind: "build",
      label: "Build City",
      intent: { type: "build_unit", unit: UnitType.City, tile: 100 },
      risk: { level: "medium", score: 0.3 },
      metadata: { role: "economic", unit: "City" },
    },
    hold(),
  ];
}

function hold(): LegalAction {
  return {
    id: "hold",
    kind: "hold",
    label: "Hold",
    intent: null,
    risk: { level: "none", score: 0 },
  };
}

function hardNationAttackAction(
  targetID: string,
  targetName: string,
  troopPercent: number,
  troops: number,
  relativeTroopRatio: number,
  targetTileShare: number,
): LegalAction {
  return {
    id: `attack:${targetID}:${troopPercent}`,
    kind: "attack",
    label: `Attack ${targetName} with ${troopPercent}%`,
    intent: { type: "attack", targetID, troops },
    risk: { level: "medium", score: 0.35 },
    metadata: {
      targetID,
      targetName,
      troops,
      troopPercent,
      troopPercentage: troopPercent / 100,
      relativeTroopRatio,
      targetTileShare,
      sharesBorder: true,
    },
  };
}

function pressurePlan(
  observation: AgentObservation,
  targetPlayerId: string,
): StrategicPlan {
  return {
    planID: `agent-1:pressure:${observation.tick}`,
    objective: "pressure_rival",
    turnIntent: "pressure",
    targetPlayerId,
    rationale: "pressure the chosen hard-nation rival",
    startedAtTick: observation.tick,
    maxDecisionCycles: 3,
    successCriteria: ["convert rival land"],
    failureCriteria: ["overextend the front"],
    preferredActionKinds: ["attack", "boat", "build", "hold"],
    forbiddenActionKinds: [],
    enabledModules: ["emergency_survival", "defense", "economy", "combat"],
    plannerSource: "mock-llm",
  };
}

function finishModeObservation(): AgentObservation {
  const observation = activeObservation("pressure_rival");
  const rival: AgentVisiblePlayer = {
    playerID: "RIVAL001",
    clientID: "RIVAL001",
    smallID: 2,
    name: "Rival",
    type: PlayerType.Nation,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 320_000,
    maxTroops: 650_000,
    troopRatio: 0.49,
    gold: "10000",
    tilesOwned: 22_000,
    tileShare: 0.2,
    sharesBorder: true,
    isAllied: false,
    isFriendly: false,
    relation: Relation.Neutral,
    canAttack: true,
    canRequestAlliance: false,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: true,
    canStopEmbargo: false,
    canTarget: true,
    canBreakAlliance: false,
    canExtendAlliance: false,
    canRejectAlliance: false,
    hasEmbargoAgainst: true,
    outgoingAttack: false,
    incomingAttack: true,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    relativeTroopRatio: 1.7,
  };
  return {
    ...observation,
    ownState: {
      playerID: "AGENT001",
      clientID: "CLIENT01",
      smallID: 1,
      name: "Frontier",
      type: PlayerType.Human,
      isAlive: true,
      isDisconnected: false,
      isTraitor: false,
      hasSpawned: true,
      troops: 1_000_000,
      maxTroops: 4_000_000,
      troopRatio: 0.25,
      gold: "250000",
      tilesOwned: 78_000,
      tileShare: 0.78,
      borderTiles: 1_000,
      outgoingAttacks: 1,
      incomingAttacks: 0,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
      spawnTile: 12,
    },
    visiblePlayers: [rival],
    combat: {
      ownTroops: 1_000_000,
      maxTroops: 4_000_000,
      troopRatio: 0.25,
      borderedPlayerIDs: ["RIVAL001"],
      attackablePlayerIDs: ["RIVAL001"],
      canExpandIntoNeutral: false,
      neutralExpansionLegalReason: null,
      incomingAttackPlayerIDs: [],
      outgoingAttackPlayerIDs: ["RIVAL001"],
      outgoingAttacks: [
        {
          attackID: "late-attack",
          targetID: "RIVAL001",
          targetName: "Rival",
          troops: 50_000,
          retreating: false,
          sourceTile: null,
          borderSize: 260,
        },
      ],
      incomingAttacks: [],
      weakestAttackableTargetID: "RIVAL001",
      strongestAttackableTargetID: "RIVAL001",
      blockerNotes: [],
    },
    endgame: {
      winner: null,
      leaderID: "AGENT001",
      leaderName: "Frontier",
      leaderTileShare: 0.78,
      ownTileShare: 0.78,
      turnsToTimer: 2_000,
    },
  };
}

function dominantConversionObservation(): AgentObservation {
  const observation = finishModeObservation();
  const secondRival: AgentVisiblePlayer = {
    ...(observation.visiblePlayers[0] as AgentVisiblePlayer),
    playerID: "RIVAL002",
    clientID: "RIVAL002",
    smallID: 3,
    name: "Second Rival",
    troops: 260_000,
    tilesOwned: 14_000,
    tileShare: 0.14,
    relativeTroopRatio: 2.1,
    incomingAttack: false,
  };
  return {
    ...observation,
    ownState:
      observation.ownState === null
        ? null
        : {
            ...observation.ownState,
            tileShare: 0.58,
            tilesOwned: 58_000,
            troopRatio: 0.28,
          },
    visiblePlayers: [...observation.visiblePlayers, secondRival],
    combat: {
      ...observation.combat,
      troopRatio: 0.28,
      attackablePlayerIDs: ["RIVAL001", "RIVAL002"],
      borderedPlayerIDs: ["RIVAL001", "RIVAL002"],
      incomingAttackPlayerIDs: [],
      incomingAttacks: [],
      outgoingAttackPlayerIDs: ["RIVAL002"],
      weakestAttackableTargetID: "RIVAL001",
      strongestAttackableTargetID: "RIVAL002",
    },
    endgame: {
      winner: observation.endgame?.winner ?? null,
      ownTileShare: 0.58,
      leaderID: "AGENT001",
      leaderName: "Frontier",
      leaderTileShare: 0.58,
      turnsToTimer: observation.endgame?.turnsToTimer ?? null,
    },
  };
}

function navalConversionObservation(): AgentObservation {
  const observation = finishModeObservation();
  return {
    ...observation,
    ownState:
      observation.ownState === null
        ? null
        : {
            ...observation.ownState,
            tileShare: 0.64,
            tilesOwned: 64_000,
            troops: 1_500_000,
            troopRatio: 0.74,
          },
    visiblePlayers: observation.visiblePlayers.map((player) => ({
      ...player,
      sharesBorder: false,
      canAttack: false,
      attackBlocker: "no shared border; transport is needed",
      relativeTroopRatio: 2.1,
    })),
    combat: {
      ...observation.combat,
      attackablePlayerIDs: [],
      borderedPlayerIDs: [],
      incomingAttackPlayerIDs: [],
      incomingAttacks: [],
      outgoingAttackPlayerIDs: [],
      outgoingAttacks: [],
    },
    endgame: {
      winner: null,
      leaderID: "AGENT001",
      leaderName: "Frontier",
      leaderTileShare: 0.64,
      ownTileShare: 0.64,
      turnsToTimer: observation.endgame?.turnsToTimer ?? null,
    },
  };
}

function leaderPressureObservation(): AgentObservation {
  const observation = activeObservation("build_alliance");
  const leader: AgentVisiblePlayer = {
    playerID: "LEADER01",
    clientID: "LEADER01",
    smallID: 2,
    name: "Leader",
    type: PlayerType.Nation,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 700_000,
    maxTroops: 1_400_000,
    troopRatio: 0.5,
    gold: "200000",
    tilesOwned: 48_000,
    tileShare: 0.42,
    sharesBorder: true,
    isAllied: false,
    isFriendly: false,
    relation: Relation.Neutral,
    canAttack: true,
    canRequestAlliance: false,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: true,
    canStopEmbargo: false,
    canTarget: true,
    canBreakAlliance: false,
    canExtendAlliance: false,
    canRejectAlliance: false,
    hasEmbargoAgainst: false,
    outgoingAttack: false,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    relativeTroopRatio: 1.1,
  };
  const ally: AgentVisiblePlayer = {
    ...leader,
    playerID: "ALLY001",
    clientID: "ALLY001",
    smallID: 3,
    name: "Ally",
    type: PlayerType.Nation,
    troops: 180_000,
    maxTroops: 500_000,
    tileShare: 0.12,
    isAllied: true,
    isFriendly: true,
    relation: Relation.Friendly,
    canAttack: false,
    canDonateGold: true,
    canDonateTroops: true,
    canEmbargo: false,
    canTarget: false,
    relativeTroopRatio: 3.1,
  };
  return {
    ...observation,
    ownState: {
      playerID: "AGENT001",
      clientID: "CLIENT01",
      smallID: 1,
      name: "Frontier",
      type: PlayerType.Human,
      isAlive: true,
      isDisconnected: false,
      isTraitor: false,
      hasSpawned: true,
      troops: 900_000,
      maxTroops: 1_800_000,
      troopRatio: 0.5,
      gold: "400000",
      tilesOwned: 31_000,
      tileShare: 0.27,
      borderTiles: 900,
      outgoingAttacks: 0,
      incomingAttacks: 0,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
      spawnTile: 12,
    },
    visiblePlayers: [leader, ally],
    combat: {
      ownTroops: 900_000,
      maxTroops: 1_800_000,
      troopRatio: 0.5,
      borderedPlayerIDs: ["LEADER01"],
      attackablePlayerIDs: ["LEADER01"],
      canExpandIntoNeutral: true,
      neutralExpansionLegalReason: "neutral land is reachable",
      incomingAttackPlayerIDs: [],
      outgoingAttackPlayerIDs: [],
      outgoingAttacks: [],
      incomingAttacks: [],
      weakestAttackableTargetID: "LEADER01",
      strongestAttackableTargetID: "LEADER01",
      blockerNotes: [],
    },
    endgame: {
      winner: null,
      leaderID: "LEADER01",
      leaderName: "Leader",
      leaderTileShare: 0.42,
      ownTileShare: 0.27,
      turnsToTimer: 4_000,
    },
  };
}

function earlyExpansionObservation(): AgentObservation {
  const base = leaderPressureObservation();
  const rival = {
    ...base.visiblePlayers[0],
    playerID: "RIVAL02",
    clientID: "RIVAL02",
    name: "Rival",
    tileShare: 0.16,
    canAttack: true,
    canEmbargo: true,
    canTarget: true,
    relativeTroopRatio: 1.05,
  };
  const ally = {
    ...base.visiblePlayers[1],
    tileShare: 0.1,
  };
  return {
    ...base,
    ownState:
      base.ownState === null
        ? null
        : {
            ...base.ownState,
            troops: 520_000,
            maxTroops: 1_200_000,
            troopRatio: 0.43,
            tilesOwned: 12_000,
            tileShare: 0.12,
          },
    visiblePlayers: [rival, ally],
    combat: {
      ...base.combat,
      ownTroops: 520_000,
      maxTroops: 1_200_000,
      troopRatio: 0.43,
      borderedPlayerIDs: ["RIVAL02"],
      attackablePlayerIDs: ["RIVAL02"],
      weakestAttackableTargetID: "RIVAL02",
      strongestAttackableTargetID: "RIVAL02",
      canExpandIntoNeutral: true,
      incomingAttackPlayerIDs: [],
      incomingAttacks: [],
    },
    endgame: {
      winner: null,
      leaderID: "RIVAL02",
      leaderName: "Rival",
      leaderTileShare: 0.16,
      ownTileShare: 0.12,
      turnsToTimer: 5_000,
    },
    strategic: {
      ...base.strategic,
      priority: "expand",
      urgency: "medium",
      recommendedActionKinds: ["attack", "build", "hold"],
    },
  };
}

function closeLeaderConversionObservation(): AgentObservation {
  const base = leaderPressureObservation();
  const leader: AgentVisiblePlayer = {
    ...base.visiblePlayers[0]!,
    playerID: "CHAD01",
    clientID: "CHAD01",
    name: "Chad",
    troops: 200_000,
    maxTroops: 900_000,
    troopRatio: 0.22,
    tilesOwned: 23_000,
    tileShare: 0.23,
    relativeTroopRatio: 2.83,
    canAttack: true,
    canEmbargo: true,
    canTarget: true,
  };
  const sideRival: AgentVisiblePlayer = {
    ...base.visiblePlayers[1]!,
    playerID: "SIDE02",
    clientID: "SIDE02",
    name: "Side Rival",
    isAllied: false,
    isFriendly: false,
    relation: Relation.Neutral,
    troops: 420_000,
    maxTroops: 900_000,
    troopRatio: 0.47,
    tilesOwned: 15_000,
    tileShare: 0.15,
    sharesBorder: true,
    canAttack: false,
    canRequestAlliance: true,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: true,
    canTarget: true,
    relativeTroopRatio: 1.35,
  };
  return {
    ...base,
    turnNumber: 1176,
    tick: 1176,
    ownState:
      base.ownState === null
        ? null
        : {
            ...base.ownState,
            troops: 566_000,
            maxTroops: 800_000,
            troopRatio: 0.71,
            tilesOwned: 17_377,
            tileShare: 0.17,
          },
    visiblePlayers: [leader, sideRival],
    combat: {
      ...base.combat,
      ownTroops: 566_000,
      maxTroops: 800_000,
      troopRatio: 0.71,
      borderedPlayerIDs: ["CHAD01", "SIDE02"],
      attackablePlayerIDs: ["CHAD01"],
      weakestAttackableTargetID: "CHAD01",
      strongestAttackableTargetID: "CHAD01",
      canExpandIntoNeutral: true,
      incomingAttackPlayerIDs: [],
      incomingAttacks: [],
      outgoingAttackPlayerIDs: [],
      outgoingAttacks: [],
    },
    memory: new AgentMemoryBuilder().build({
      recentDecisions: [
        {
          sequence: 1,
          actionID: "expand:terra-nullius:20",
          actionKind: "attack",
          accepted: true,
          expansion: true,
          reason: "expanded",
        },
      ],
    }),
    endgame: {
      winner: null,
      leaderID: "CHAD01",
      leaderName: "Chad",
      leaderTileShare: 0.23,
      ownTileShare: 0.17,
      turnsToTimer: 4_000,
    },
    strategic: {
      ...base.strategic,
      priority: "attack",
      urgency: "medium",
      recommendedActionKinds: ["attack", "boat", "hold"],
    },
  };
}

function closeLeaderConversionLegalActions(): LegalAction[] {
  return [
    {
      id: "expand:terra-nullius:20",
      kind: "attack",
      label: "Expand into neutral land with 20%",
      intent: { type: "attack", targetID: null, troops: 113_200 },
      risk: { level: "low", score: 0.1 },
      metadata: {
        expansion: true,
        troopPercentage: 0.2,
        neutralTiles: 2_400,
      },
    },
    {
      id: "attack:CHAD01:10",
      kind: "attack",
      label: "Probe Chad with 10%",
      intent: { type: "attack", targetID: "CHAD01", troops: 56_600 },
      risk: { level: "medium", score: 0.25 },
      metadata: {
        targetID: "CHAD01",
        targetName: "Chad",
        targetTroops: 200_000,
        targetTiles: 23_000,
        targetTileShare: 0.23,
        troopPercentage: 0.1,
        relativeTroopRatio: 2.83,
      },
    },
    {
      id: "attack:CHAD01:25",
      kind: "attack",
      label: "Attack Chad with 25%",
      intent: { type: "attack", targetID: "CHAD01", troops: 141_500 },
      risk: { level: "medium", score: 0.35 },
      metadata: {
        targetID: "CHAD01",
        targetName: "Chad",
        targetTroops: 200_000,
        targetTiles: 23_000,
        targetTileShare: 0.23,
        troopPercentage: 0.25,
        relativeTroopRatio: 2.83,
      },
    },
    {
      id: "attack:CHAD01:40",
      kind: "attack",
      label: "Attack Chad with 40%",
      intent: { type: "attack", targetID: "CHAD01", troops: 226_400 },
      risk: { level: "medium", score: 0.48 },
      metadata: {
        targetID: "CHAD01",
        targetName: "Chad",
        targetTroops: 200_000,
        targetTiles: 23_000,
        targetTileShare: 0.23,
        troopPercentage: 0.4,
        relativeTroopRatio: 2.83,
      },
    },
    hold(),
  ];
}

function boxedEscapeTransportObservation(): AgentObservation {
  const base = leaderPressureObservation();
  const leader: AgentVisiblePlayer = {
    ...base.visiblePlayers[0]!,
    playerID: "LEADER01",
    clientID: "LEADER01",
    name: "Leader",
    troops: 1_600_000,
    maxTroops: 2_000_000,
    troopRatio: 0.8,
    tilesOwned: 57_000,
    tileShare: 0.57,
    relativeTroopRatio: 0.5,
    canAttack: true,
    canEmbargo: true,
    canTarget: true,
  };
  const second: AgentVisiblePlayer = {
    ...base.visiblePlayers[1]!,
    playerID: "SECOND02",
    clientID: "SECOND02",
    name: "Second",
    isAllied: false,
    isFriendly: false,
    relation: Relation.Neutral,
    troops: 900_000,
    maxTroops: 1_400_000,
    troopRatio: 0.64,
    tilesOwned: 32_000,
    tileShare: 0.32,
    sharesBorder: false,
    canAttack: false,
    canRequestAlliance: true,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: true,
    canTarget: true,
    relativeTroopRatio: 0.8,
  };
  return {
    ...base,
    turnNumber: 4051,
    tick: 4051,
    ownState:
      base.ownState === null
        ? null
        : {
            ...base.ownState,
            troops: 343_714,
            maxTroops: 456_474,
            troopRatio: 0.75,
            tilesOwned: 5_645,
            tileShare: 0.06,
          },
    visiblePlayers: [leader, second],
    combat: {
      ...base.combat,
      ownTroops: 343_714,
      maxTroops: 456_474,
      troopRatio: 0.75,
      borderedPlayerIDs: ["LEADER01"],
      attackablePlayerIDs: ["LEADER01"],
      weakestAttackableTargetID: "LEADER01",
      strongestAttackableTargetID: "LEADER01",
      canExpandIntoNeutral: false,
      incomingAttackPlayerIDs: ["LEADER01"],
      incomingAttacks: [
        {
          attackID: "incoming-leader",
          targetID: "LEADER01",
          targetName: "Leader",
          troops: 690_198,
          retreating: false,
          sourceTile: null,
          borderSize: 40,
        },
      ],
      outgoingAttackPlayerIDs: [],
      outgoingAttacks: [],
    },
    memory: new AgentMemoryBuilder().build({
      recentDecisions: Array.from({ length: 7 }, (_, index) => ({
        sequence: index + 1,
        actionID: "hold",
        actionKind: "hold" as const,
        accepted: true,
        reason: "boxed and waiting",
      })),
    }),
    endgame: {
      winner: null,
      leaderID: "LEADER01",
      leaderName: "Leader",
      leaderTileShare: 0.57,
      ownTileShare: 0.06,
      turnsToTimer: 2_000,
    },
    strategic: {
      ...base.strategic,
      priority: "build_defense",
      urgency: "high",
      recommendedActionKinds: ["boat", "attack", "hold"],
    },
    nonCombat: {
      ...base.nonCombat,
      boatOptions: [],
      boatRetreatOptions: [],
    },
  };
}

function boxedEscapeTransportLegalActions(): LegalAction[] {
  return [
    {
      id: "attack:LEADER01:10",
      kind: "attack",
      label: "Probe Leader with 10%",
      intent: { type: "attack", targetID: "LEADER01", troops: 34_371 },
      risk: { level: "medium", score: 0.4 },
      metadata: {
        targetID: "LEADER01",
        targetName: "Leader",
        targetTroops: 1_600_000,
        targetTileShare: 0.57,
        troopPercentage: 0.1,
        relativeTroopRatio: 0.5,
      },
    },
    {
      id: "boat:94770:8",
      kind: "boat",
      label: "Send 8% transport",
      intent: { type: "boat", troops: 27_497, dst: 94_770 },
      risk: { level: "low", score: 0.08 },
      metadata: {
        targetTile: 94_770,
        targetID: null,
        targetName: "Safe Shore",
        troops: 27_497,
        troopPercentage: 0.08,
        troopPercent: 8,
        expansion: true,
      },
    },
    {
      id: "boat:94770:16",
      kind: "boat",
      label: "Send 16% transport",
      intent: { type: "boat", troops: 54_994, dst: 94_770 },
      risk: { level: "low", score: 0.16 },
      metadata: {
        targetTile: 94_770,
        targetID: null,
        targetName: "Safe Shore",
        troops: 54_994,
        troopPercentage: 0.16,
        troopPercent: 16,
        expansion: true,
      },
    },
    hold(),
  ];
}

function collapsingEscapeTransportObservation(): AgentObservation {
  const base = boxedEscapeTransportObservation();
  return {
    ...base,
    turnNumber: 3701,
    tick: 3701,
    ownState:
      base.ownState === null
        ? null
        : {
            ...base.ownState,
            troops: 561_142,
            maxTroops: 1_050_000,
            troopRatio: 0.53,
            tilesOwned: 16_930,
            tileShare: 0.17,
          },
    combat: {
      ...base.combat,
      ownTroops: 561_142,
      maxTroops: 1_050_000,
      troopRatio: 0.53,
      incomingAttackPlayerIDs: ["LEADER01"],
      incomingAttacks: [
        {
          attackID: "incoming-leader",
          targetID: "LEADER01",
          targetName: "Leader",
          troops: 720_000,
          retreating: false,
          sourceTile: null,
          borderSize: 48,
        },
      ],
    },
    memory: new AgentMemoryBuilder().build({
      recentDecisions: [
        {
          sequence: 1,
          actionID: "attack:SECOND02:10",
          actionKind: "attack" as const,
          targetID: "SECOND02",
          targetName: "Second",
          accepted: true,
          reason: "counterattack",
          ownTiles: 38_697,
          ownTroops: 1_023_654,
        },
        {
          sequence: 2,
          actionID: "attack:LEADER01:10",
          actionKind: "attack" as const,
          targetID: "LEADER01",
          targetName: "Leader",
          accepted: true,
          reason: "counterattack",
          ownTiles: 36_009,
          ownTroops: 920_557,
        },
        {
          sequence: 3,
          actionID: "attack:LEADER01:10",
          actionKind: "attack" as const,
          targetID: "LEADER01",
          targetName: "Leader",
          accepted: true,
          reason: "counterattack",
          ownTiles: 31_637,
          ownTroops: 790_571,
        },
        {
          sequence: 4,
          actionID: "embargo_all:start",
          actionKind: "embargo_all" as const,
          accepted: true,
          reason: "pressure",
          ownTiles: 27_079,
          ownTroops: 661_526,
        },
        {
          sequence: 5,
          actionID: "target:LEADER01",
          actionKind: "target_player" as const,
          targetID: "LEADER01",
          targetName: "Leader",
          accepted: true,
          reason: "mark leader",
          ownTiles: 23_201,
          ownTroops: 616_217,
        },
        {
          sequence: 6,
          actionID: "build:Defense Post:83575",
          actionKind: "build" as const,
          unit: "Defense Post",
          accepted: true,
          reason: "defend",
          ownTiles: 19_253,
          ownTroops: 602_338,
        },
        {
          sequence: 7,
          actionID: "attack:SECOND02:10",
          actionKind: "attack" as const,
          targetID: "SECOND02",
          targetName: "Second",
          accepted: true,
          reason: "counterattack",
          ownTiles: 17_963,
          ownTroops: 608_271,
        },
      ],
    }),
    endgame: {
      winner: null,
      leaderID: "LEADER01",
      leaderName: "Leader",
      leaderTileShare: 0.48,
      ownTileShare: 0.17,
      turnsToTimer: 2_350,
    },
    nonCombat: {
      ...base.nonCombat,
      boatRetreatOptions: [],
    },
  };
}

function boxedEscapeTransportCrossingObservation(): AgentObservation {
  const base = boxedEscapeTransportObservation();
  return {
    ...base,
    turnNumber: 4076,
    tick: 4076,
    ownState:
      base.ownState === null
        ? null
        : {
            ...base.ownState,
            troops: 306_004,
            maxTroops: 453_587,
            troopRatio: 0.67,
            tilesOwned: 5_569,
            tileShare: 0.05,
          },
    combat: {
      ...base.combat,
      ownTroops: 306_004,
      maxTroops: 453_587,
      troopRatio: 0.67,
      incomingAttackPlayerIDs: ["LEADER01"],
      incomingAttacks: [
        {
          attackID: "incoming-leader",
          targetID: "LEADER01",
          targetName: "Leader",
          troops: 669_236,
          retreating: false,
          sourceTile: null,
          borderSize: 40,
        },
      ],
    },
    memory: new AgentMemoryBuilder().build({
      recentDecisions: [
        ...Array.from({ length: 7 }, (_, index) => ({
          sequence: index + 1,
          actionID: "hold",
          actionKind: "hold" as const,
          accepted: true,
          reason: "boxed and waiting",
        })),
        {
          sequence: 8,
          actionID: "boat:94770:16",
          actionKind: "boat" as const,
          targetID: "SECOND02",
          targetName: "Second",
          accepted: true,
          reason: "escape transport",
          expansion: false,
        },
      ],
    }),
    nonCombat: {
      ...base.nonCombat,
      boatRetreatOptions: [
        {
          unitID: 99,
          tile: 110_228,
          targetTile: 94_770,
          troops: 54_994,
          legalReason:
            "owned transport ship is active and not already retreating",
        },
      ],
    },
  };
}

function reserveDisciplineObservation(): AgentObservation {
  const base = earlyExpansionObservation();
  return {
    ...base,
    ownState:
      base.ownState === null
        ? null
        : {
            ...base.ownState,
            troops: 400_000,
            maxTroops: 1_200_000,
            troopRatio: 0.33,
            tileShare: 0.2,
          },
    combat: {
      ...base.combat,
      ownTroops: 400_000,
      maxTroops: 1_200_000,
      troopRatio: 0.33,
    },
    endgame: {
      winner: null,
      leaderID: "RIVAL02",
      leaderName: "Rival",
      leaderTileShare: 0.22,
      ownTileShare: 0.2,
      turnsToTimer: 5_000,
    },
  };
}

function multiRivalPressureObservation(): AgentObservation {
  const base = earlyExpansionObservation();
  const secondRival: AgentVisiblePlayer = {
    ...base.visiblePlayers[0],
    playerID: "RIVAL03",
    clientID: "RIVAL03",
    name: "Second Rival",
    tileShare: 0.18,
    relativeTroopRatio: 1.2,
  };
  return {
    ...base,
    visiblePlayers: [...base.visiblePlayers, secondRival],
    ownState:
      base.ownState === null
        ? null
        : {
            ...base.ownState,
            tileShare: 0.22,
            troops: 560_000,
            maxTroops: 900_000,
            troopRatio: 0.62,
          },
    combat: {
      ...base.combat,
      ownTroops: 560_000,
      maxTroops: 900_000,
      troopRatio: 0.62,
      canExpandIntoNeutral: false,
      attackablePlayerIDs: ["RIVAL02", "RIVAL03"],
      borderedPlayerIDs: ["RIVAL02", "RIVAL03"],
      weakestAttackableTargetID: "RIVAL02",
      strongestAttackableTargetID: "RIVAL03",
    },
    endgame: {
      winner: null,
      leaderID: "RIVAL03",
      leaderName: "Second Rival",
      leaderTileShare: 0.24,
      ownTileShare: 0.22,
      turnsToTimer: 5_000,
    },
  };
}

function duelModeExpansionObservation(): AgentObservation {
  const observation = finishModeObservation();
  return {
    ...observation,
    ownState:
      observation.ownState === null
        ? null
        : {
            ...observation.ownState,
            tileShare: 0.62,
            tilesOwned: 62_000,
          },
    endgame: {
      winner: null,
      leaderID: "AGENT001",
      leaderName: "Frontier",
      leaderTileShare: 0.62,
      ownTileShare: 0.62,
      turnsToTimer: 2_000,
    },
    objective:
      observation.objective === null
        ? null
        : {
            ...observation.objective,
            objectiveID: "agent-1:expand_territory",
            kind: "expand_territory",
            label: "expand_territory",
            preferredActionKinds: ["attack", "boat", "hold"],
            summary: "expand_territory active",
          },
  };
}

describe("Planner/executor demo-quality behavior gates", () => {
  it("after repeated neutral expansion, safe City beats another neutral expansion", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 2_000,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 700_000,
              maxTroops: 1_000_000,
              troopRatio: 0.7,
              tilesOwned: 32_000,
              tileShare: 0.32,
              unitCounts: {},
            },
      combat: {
        ...base.combat,
        ownTroops: 700_000,
        maxTroops: 1_000_000,
        troopRatio: 0.7,
        attackablePlayerIDs: ["RIVAL02"],
        borderedPlayerIDs: ["RIVAL02"],
        incomingAttackPlayerIDs: [],
        incomingAttacks: [],
        canExpandIntoNeutral: true,
      },
      endgame: {
        winner: null,
        leaderID: "RIVAL02",
        leaderName: "Rival",
        leaderTileShare: 0.24,
        ownTileShare: 0.32,
        turnsToTimer: 3_000,
      },
      memory: {
        ...base.memory,
        recentExpansionCount: 2,
        recentBuildCount: 0,
        repeatedActionKind: "attack",
        repeatedActionCount: 2,
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand neutral land",
        intent: { type: "attack", targetID: null, troops: 140_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.2 },
      },
      {
        id: "build:City:100",
        kind: "build",
        label: "Build City",
        intent: { type: "build_unit", unit: UnitType.City, tile: 100 },
        risk: { level: "medium", score: 0.3 },
        metadata: { role: "economic", unit: "City" },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:expand",
      objective: "expand_territory",
      turnIntent: "growth",
      targetPlayerId: null,
      rationale: "growth plan should hand off after expansion streak",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["grow"],
      failureCriteria: ["stall"],
      preferredActionKinds: ["attack", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "economy"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("build:City:100");
    expect(decision.profileRepairRerankOpportunity).toBe(true);
    expect(decision.profileRepairRerankSelected).toBe(true);
    expect(decision.profileRepairRerankSuggestedActionID).toBe("build:City:100");
    expect(decision.profileRepairRerankCandidates).toContain("build:City:100");
  });

  it("executor-ready weak-rival attack beats neutral expansion, hold, and social", () => {
    const observation = closeLeaderConversionObservation();
    const legalActions: LegalAction[] = [
      closeLeaderConversionLegalActions()[0]!,
      closeLeaderConversionLegalActions()[1]!,
      {
        id: "quick_chat:CHAD01:misc.team_up",
        kind: "quick_chat",
        label: "Chat to Chad",
        intent: {
          type: "quick_chat",
          recipient: "CHAD01",
          quickChatKey: "misc.team_up",
        },
        risk: { level: "none", score: 0 },
        metadata: {
          targetID: "CHAD01",
          targetName: "Chad",
          quickChatKey: "misc.team_up",
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:expand",
      objective: "expand_territory",
      turnIntent: "growth",
      targetPlayerId: null,
      rationale: "stale growth should yield to executor-ready conversion",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["convert weak rival"],
      failureCriteria: ["miss window"],
      preferredActionKinds: ["attack", "quick_chat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "diplomacy", "combat"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:CHAD01:10");
  });

  it("takes a moderate executor-ready conversion window instead of batching neutral boats", () => {
    const base = earlyExpansionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_401,
      tick: 1_401,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              troops: 720_000,
              maxTroops: 1_000_000,
              troopRatio: 0.72,
              tilesOwned: 34_000,
              tileShare: 0.34,
            },
      visiblePlayers: [
        {
          ...base.visiblePlayers[0]!,
          troops: 520_000,
          tilesOwned: 7_000,
          tileShare: 0.07,
          relativeTroopRatio: 1.38,
          canAttack: true,
        },
        ...base.visiblePlayers.slice(1),
      ],
      combat: {
        ...base.combat,
        ownTroops: 720_000,
        maxTroops: 1_000_000,
        troopRatio: 0.72,
        canExpandIntoNeutral: true,
      },
      memory: {
        ...base.memory,
        recentExpansionCount: 2,
        recentBuildCount: 1,
      },
      endgame: {
        winner: null,
        leaderID: "AGENT001",
        leaderName: "Frontier",
        leaderTileShare: 0.34,
        ownTileShare: 0.34,
        turnsToTimer: 4_000,
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
        recommendedActionKinds: ["attack", "boat", "hold"],
      },
    };
    const legalActions: LegalAction[] = [
      {
        id: "boat:neutral:16",
        kind: "boat",
        label: "Send transport to Terra Nullius",
        intent: { type: "boat", dst: 1000, troops: 115_200 },
        risk: { level: "low", score: 0.1 },
        metadata: {
          targetName: "Terra Nullius",
          targetTile: 1000,
          expansion: true,
          troopPercentage: 0.16,
        },
      },
      {
        id: "expand:terra-nullius:10",
        kind: "attack",
        label: "Expand into neutral land",
        intent: { type: "attack", targetID: null, troops: 72_000 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercentage: 0.1 },
      },
      {
        id: "attack:RIVAL02:10",
        kind: "attack",
        label: "Probe Rival with 10%",
        intent: { type: "attack", targetID: "RIVAL02", troops: 72_000 },
        risk: { level: "medium", score: 0.25 },
        metadata: {
          targetID: "RIVAL02",
          targetName: "Rival",
          targetTroops: 520_000,
          targetTiles: 7_000,
          targetTileShare: 0.07,
          troopPercentage: 0.1,
          relativeTroopRatio: 1.38,
        },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:pressure",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: "RIVAL02",
      rationale: "pressure should convert a ready weak neighbor",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["convert weak rival"],
      failureCriteria: ["farm neutral forever"],
      preferredActionKinds: ["attack", "boat", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["expansion", "combat", "naval"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("defensive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("attack:RIVAL02:10");
  });

  it("poor Defense Post loses to City when no hostile frontier exists", () => {
    const observation = activeObservation("fortify_border");
    const legalActions: LegalAction[] = [
      {
        id: "build:Defense Post:10",
        kind: "build",
        label: "Build poor Defense Post",
        intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 10 },
        risk: { level: "low", score: 0.15 },
        metadata: {
          role: "defensive",
          unit: UnitType.DefensePost,
          defensiveValue: 0.1,
          frontierValue: 0.05,
          nearbyEnemyCount: 0,
          nearbyIncomingAttack: false,
          hostileBorderDistance: 80,
        },
      },
      {
        id: "build:City:100",
        kind: "build",
        label: "Build City",
        intent: { type: "build_unit", unit: UnitType.City, tile: 100 },
        risk: { level: "medium", score: 0.3 },
        metadata: { role: "economic", unit: UnitType.City },
      },
      hold(),
    ];
    const plan: StrategicPlan = {
      planID: "agent-1:fortify",
      objective: "fortify_border",
      targetPlayerId: null,
      rationale: "only build real defense when it has frontier value",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["build useful structure"],
      failureCriteria: ["waste gold"],
      preferredActionKinds: ["build", "hold"],
      forbiddenActionKinds: [],
      enabledModules: ["defense", "economy"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("defensive").decide(
      { observation, legalActions },
      plan,
    );

    expect(decision.actionID).toBe("build:City:100");
  });

  it("hold decisions include a non-empty hold reason category", () => {
    const observation = activeObservation("survive");
    const plan: StrategicPlan = {
      planID: "agent-1:survive",
      objective: "survive",
      targetPlayerId: null,
      rationale: "nothing useful is legal",
      startedAtTick: observation.tick,
      maxDecisionCycles: 2,
      successCriteria: ["wait"],
      failureCriteria: ["busy work"],
      preferredActionKinds: ["hold"],
      forbiddenActionKinds: [],
      enabledModules: ["utility_social"],
      plannerSource: "mock-llm",
    };

    const decision = new FrontierPolicyExecutor("defensive").decide(
      { observation, legalActions: [hold()] },
      plan,
    );

    expect(decision.actionID).toBe("hold");
    expect(decision.holdReasonCategory).toBe("no_safe_non_hold");
  });
});
