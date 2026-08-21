import { UnitType } from "../../src/core/game/Game";
import type {
  AgentBrainInput,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import type { ActiveCommanderPlan } from "../../src/server/agents/CommanderPlanLifecycle";
import type {
  StrategicOptionCandidate,
  StrategicOptionFamily,
  StrategicOptionId,
} from "../../src/server/agents/StrategicCommanderTypes";
import {
  commanderHardEmergencyConditions,
  executeStrategicOption,
} from "../../src/server/agents/StrategicOptionExecutor";
import { summarizeCommanderFidelity } from "../../src/server/agents/StrategicOptionFidelity";
import {
  makeCommanderStage2Fixture,
  RAW_ATTACK_ACTION_ID,
  RAW_BUILD_ACTION_ID,
  RAW_EXPANSION_ACTION_ID,
} from "./StrategicCommanderStage2TestHarness";

const HOLD_ID = "hold";

function plan(
  selectedStrategicOptionId: StrategicOptionId,
  family: StrategicOptionFamily,
  targetPlayerID: string | null = null,
): ActiveCommanderPlan {
  return {
    planID: `plan:${selectedStrategicOptionId}`,
    selectedStrategicOptionId,
    family,
    targetPlayerID,
    horizonDecisions: 4,
    replanTriggers: [],
    intent: "fixture plan",
    selector: "commander",
    fallbackReason: null,
    fallbackDegradationCause: null,
    origin: {
      gameID: "GAME",
      agentID: "AGENT",
      decisionSequence: 0,
      turnNumber: 1,
      tick: 1,
      exposedOptionIDs: [selectedStrategicOptionId],
      exposedOptionSetFingerprint: "aaaaaaaaaaaaaaaa",
      materialStateFingerprint: "bbbbbbbbbbbbbbbb",
    },
    start: {
      decisionSequence: 0,
      turnNumber: 1,
      tick: 1,
      tilesOwned: 1,
      troops: 1,
      incomingAttackerIDs: [],
    },
  };
}

function input(actions?: LegalAction[]): AgentBrainInput {
  const fixture = makeCommanderStage2Fixture();
  return {
    observation: fixture.observation,
    legalActions: actions ?? fixture.legalActions,
  };
}

function candidate(
  id: StrategicOptionId,
  family: StrategicOptionFamily,
  targetPlayerID: string | null,
  primary: string[],
  support: string[] = [],
): StrategicOptionCandidate {
  return {
    id,
    family,
    targetPlayerID,
    targetName: targetPlayerID,
    binding: {
      alignedPrimaryActionIDs: primary,
      alignedSupportActionIDs: support,
    },
    evidence: {} as StrategicOptionCandidate["evidence"],
  };
}

function execute(args: {
  brainInput?: AgentBrainInput;
  plan: ActiveCommanderPlan;
  candidate: StrategicOptionCandidate | null;
  age?: number;
}) {
  return executeStrategicOption({
    brainInput: args.brainInput ?? input(),
    plan: args.plan,
    candidate: args.candidate,
    planAgeDecisions: args.age ?? 0,
  });
}

function hostileAttack(
  id: string,
  targetID: string,
  score: number,
): LegalAction {
  return {
    id,
    kind: "attack",
    label: id,
    intent: { type: "attack", targetID, troops: 4_000 },
    risk: { level: "medium", score: 0.5 },
    metadata: {
      targetID,
      expansion: false,
      troopPercentage: 0.25,
      totalScore: score,
    },
  };
}

describe("StrategicOptionExecutor — binding-first authority", () => {
  it("pressure P7 cannot retarget to a much higher-scoring P3 attack", () => {
    const brainInput = input();
    const p3 = hostileAttack("attack-p3-high-score", "P3", 999_999_999);
    brainInput.legalActions.push(p3);
    const result = execute({
      brainInput,
      plan: plan("pressure_rival:P7", "pressure_rival", "P7"),
      candidate: candidate("pressure_rival:P7", "pressure_rival", "P7", [
        p3.id,
        RAW_ATTACK_ACTION_ID,
      ]),
    });

    expect(result.actionID).toBe(RAW_ATTACK_ACTION_ID);
    expect(result.actions).toEqual([
      {
        actionID: RAW_ATTACK_ACTION_ID,
        fidelity: "aligned_primary",
        emergencyCondition: null,
      },
    ]);
  });

  it("uses the same first duplicate-id object as AgentDecisionValidator", () => {
    const duplicateID = "attack-colliding-id";
    const firstOffTarget = hostileAttack(duplicateID, "P3", 1);
    const laterOnTarget = hostileAttack(duplicateID, "P7", 999);
    const brainInput = input([
      firstOffTarget,
      laterOnTarget,
      input().legalActions.find((action) => action.id === HOLD_ID)!,
    ]);
    const result = execute({
      brainInput,
      plan: plan("pressure_rival:P7", "pressure_rival", "P7"),
      candidate: candidate("pressure_rival:P7", "pressure_rival", "P7", [
        duplicateID,
      ]),
    });

    expect(result).toMatchObject({
      actionID: HOLD_ID,
      blockedReason: "primary_action_unavailable",
      immediateReplan: true,
    });
  });

  it("rejects effect-bearing intents that contradict aligned metadata", () => {
    const pressureInput = input();
    const disguisedPressure: LegalAction = {
      ...pressureInput.legalActions.find(
        (action) => action.id === RAW_ATTACK_ACTION_ID,
      )!,
      id: "attack-disguised-off-target",
      intent: { type: "attack", targetID: "P3", troops: 4_000 },
      metadata: { targetID: "P7", expansion: false },
    };
    pressureInput.legalActions.push(disguisedPressure);
    expect(
      execute({
        brainInput: pressureInput,
        plan: plan("pressure_rival:P7", "pressure_rival", "P7"),
        candidate: candidate("pressure_rival:P7", "pressure_rival", "P7", [
          disguisedPressure.id,
        ]),
      }),
    ).toMatchObject({
      actionID: HOLD_ID,
      blockedReason: "primary_action_unavailable",
      immediateReplan: true,
    });

    const expansionInput = input();
    const disguisedExpansion: LegalAction = {
      ...expansionInput.legalActions.find(
        (action) => action.id === RAW_EXPANSION_ACTION_ID,
      )!,
      id: "expand-disguised-hostile",
      intent: { type: "attack", targetID: "P3", troops: 2_000 },
      metadata: { targetID: null, expansion: true },
    };
    expansionInput.legalActions.push(disguisedExpansion);
    expect(
      execute({
        brainInput: expansionInput,
        plan: plan("expand", "expand"),
        candidate: candidate("expand", "expand", null, [disguisedExpansion.id]),
      }).actionID,
    ).toBe(HOLD_ID);

    const economyInput = input();
    const disguisedEconomy: LegalAction = {
      ...economyInput.legalActions.find(
        (action) => action.id === RAW_BUILD_ACTION_ID,
      )!,
      id: "build-disguised-unit",
      intent: { type: "build_unit", unit: UnitType.MissileSilo, tile: 102 },
      metadata: { unit: UnitType.City, role: "economic" },
    };
    economyInput.legalActions.push(disguisedEconomy);
    expect(
      execute({
        brainInput: economyInput,
        plan: plan("develop_economy", "develop_economy"),
        candidate: candidate("develop_economy", "develop_economy", null, [
          disguisedEconomy.id,
        ]),
      }).actionID,
    ).toBe(HOLD_ID);

    const survivalInput = input();
    const disguisedDefense: LegalAction = {
      id: "build-disguised-defense",
      kind: "build",
      label: "claims defense but builds economy",
      intent: { type: "build_unit", unit: UnitType.City, tile: 103 },
      risk: { level: "low", score: 0.1 },
      metadata: { unit: UnitType.DefensePost, role: "defensive" },
    };
    survivalInput.legalActions.push(disguisedDefense);
    expect(
      execute({
        brainInput: survivalInput,
        plan: plan("survive", "survive"),
        candidate: candidate("survive", "survive", null, [disguisedDefense.id]),
      }).actionID,
    ).toBe(HOLD_ID);
  });

  it("pressure cannot attack an allied selected target", () => {
    const brainInput = input();
    const p7 = brainInput.observation.visiblePlayers.find(
      (player) => player.playerID === "P7",
    )!;
    p7.isAllied = true;
    const result = execute({
      brainInput,
      plan: plan("pressure_rival:P7", "pressure_rival", "P7"),
      candidate: candidate("pressure_rival:P7", "pressure_rival", "P7", [
        RAW_ATTACK_ACTION_ID,
      ]),
    });

    expect(result.actionID).toBe(HOLD_ID);
    expect(result.blockedReason).toBe("primary_action_unavailable");
    expect(result.immediateReplan).toBe(true);
  });

  it("pressure cannot continue against a disconnected selected target", () => {
    const brainInput = input();
    const p7 = brainInput.observation.visiblePlayers.find(
      (player) => player.playerID === "P7",
    )!;
    p7.isDisconnected = true;
    const result = execute({
      brainInput,
      plan: plan("pressure_rival:P7", "pressure_rival", "P7"),
      candidate: candidate("pressure_rival:P7", "pressure_rival", "P7", [
        RAW_ATTACK_ACTION_ID,
      ]),
    });
    expect(result).toMatchObject({
      actionID: HOLD_ID,
      blockedReason: "primary_action_unavailable",
      immediateReplan: true,
    });
  });

  it("pressure cannot silently select unrelated economy", () => {
    const result = execute({
      plan: plan("pressure_rival:P7", "pressure_rival", "P7"),
      candidate: candidate("pressure_rival:P7", "pressure_rival", "P7", [
        RAW_BUILD_ACTION_ID,
      ]),
    });
    expect(result.actionID).toBe(HOLD_ID);
    expect(result.actions[0]!.fidelity).toBe("hold_plan_blocked");
  });

  it("economy cannot launch an unrelated attack even when injected into the binding", () => {
    const result = execute({
      plan: plan("develop_economy", "develop_economy"),
      candidate: candidate("develop_economy", "develop_economy", null, [
        RAW_ATTACK_ACTION_ID,
        RAW_BUILD_ACTION_ID,
      ]),
    });
    expect(result.actionID).toBe(RAW_BUILD_ACTION_ID);
  });

  it("economy excludes missile and SAM builds", () => {
    const brainInput = input();
    const missile: LegalAction = {
      ...brainInput.legalActions.find(
        (action) => action.id === RAW_BUILD_ACTION_ID,
      )!,
      id: "build-missile-high-value",
      intent: { type: "build_unit", unit: UnitType.MissileSilo, tile: 102 },
      metadata: {
        unit: UnitType.MissileSilo,
        role: "economic",
        economicValue: 999_999,
      },
    };
    brainInput.legalActions.push(missile);
    const result = execute({
      brainInput,
      plan: plan("develop_economy", "develop_economy"),
      candidate: candidate("develop_economy", "develop_economy", null, [
        missile.id,
        RAW_BUILD_ACTION_ID,
      ]),
    });
    expect(result.actionID).toBe(RAW_BUILD_ACTION_ID);
  });

  it("expand cannot become hostile pressure", () => {
    const result = execute({
      plan: plan("expand", "expand"),
      candidate: candidate("expand", "expand", null, [
        RAW_ATTACK_ACTION_ID,
        RAW_EXPANSION_ACTION_ID,
      ]),
    });
    expect(result.actionID).toBe(RAW_EXPANSION_ACTION_ID);
  });

  it("survive cannot choose a generic useful hostile action", () => {
    const result = execute({
      plan: plan("survive", "survive"),
      candidate: candidate("survive", "survive", null, [
        RAW_ATTACK_ACTION_ID,
        HOLD_ID,
      ]),
    });
    expect(result.actionID).toBe(HOLD_ID);
    expect(result.actions[0]!.fidelity).toBe("aligned_primary");
  });

  it("allows only one same-target pressure support action on plan decision zero", () => {
    const brainInput = input();
    const support: LegalAction = {
      id: "embargo-p7-start",
      kind: "embargo",
      label: "embargo P7",
      intent: { type: "embargo", targetID: "P7", action: "start" },
      risk: { level: "none", score: 0 },
      metadata: { action: "start", targetID: "P7" },
    };
    const broad: LegalAction = {
      id: "build-support-smuggling",
      kind: "build",
      label: "not pressure support",
      intent: { type: "build_unit", unit: UnitType.City, tile: 200 },
      risk: { level: "none", score: 0 },
      metadata: { role: "economic", targetID: "P7" },
    };
    const disguisedOffTargetSupport: LegalAction = {
      id: "embargo-disguised-off-target",
      kind: "embargo",
      label: "claims P7 but embargoes P3",
      intent: { type: "embargo", targetID: "P3", action: "start" },
      risk: { level: "none", score: 0 },
      metadata: { action: "start", targetID: "P7" },
    };
    brainInput.legalActions.push(support, broad, disguisedOffTargetSupport);
    const bound = candidate(
      "pressure_rival:P7",
      "pressure_rival",
      "P7",
      [RAW_ATTACK_ACTION_ID],
      [broad.id, disguisedOffTargetSupport.id, support.id],
    );
    const first = execute({
      brainInput,
      plan: plan("pressure_rival:P7", "pressure_rival", "P7"),
      candidate: bound,
    });
    const later = execute({
      brainInput,
      plan: plan("pressure_rival:P7", "pressure_rival", "P7"),
      candidate: bound,
      age: 1,
    });

    expect(first.actionIDs).toEqual([RAW_ATTACK_ACTION_ID, support.id]);
    expect(first.actions.map((entry) => entry.fidelity)).toEqual([
      "aligned_primary",
      "aligned_support",
    ]);
    expect(later.actionIDs).toBeUndefined();
  });

  it("holds and arms immediate replanning when no compatible primary exists", () => {
    const result = execute({
      plan: plan("expand", "expand"),
      candidate: candidate("expand", "expand", null, []),
    });
    expect(result).toMatchObject({
      actionID: HOLD_ID,
      blockedReason: "primary_binding_empty",
      immediateReplan: true,
      actions: [{ actionID: HOLD_ID, fidelity: "hold_plan_blocked" }],
    });
  });

  it("has no V0 emergency escape hatch regardless of score or danger", () => {
    expect(commanderHardEmergencyConditions).toEqual([]);
    const brainInput = input();
    brainInput.observation.combat.incomingAttackPlayerIDs = ["P3", "P4"];
    const result = execute({
      brainInput,
      plan: plan("expand", "expand"),
      candidate: candidate("expand", "expand", null, [
        RAW_EXPANSION_ACTION_ID,
        RAW_ATTACK_ACTION_ID,
      ]),
    });
    expect(result.actionID).toBe(RAW_EXPANSION_ACTION_ID);
    expect(
      result.actions.every((entry) => entry.emergencyCondition === null),
    ).toBe(true);
  });

  it("returns only ids offered in the same decision and is menu-order invariant", () => {
    const brainInput = input();
    const selected = plan("pressure_rival:P7", "pressure_rival", "P7");
    const bound = candidate("pressure_rival:P7", "pressure_rival", "P7", [
      RAW_ATTACK_ACTION_ID,
    ]);
    const forward = execute({ brainInput, plan: selected, candidate: bound });
    const reversed = execute({
      brainInput: {
        ...brainInput,
        legalActions: [...brainInput.legalActions].reverse(),
      },
      plan: selected,
      candidate: bound,
    });
    const offered = new Set(brainInput.legalActions.map((action) => action.id));
    expect(forward).toEqual(reversed);
    expect(forward.actions.every((entry) => offered.has(entry.actionID))).toBe(
      true,
    );
  });
});

describe("StrategicOptionFidelity", () => {
  it("fails closed on missing or unknown classifications and excludes emergencies", () => {
    const summary = summarizeCommanderFidelity([
      {
        decisionMetadata: {
          planID: "plan-a",
          commanderFidelity: "aligned_primary",
        },
      },
      {
        decisionMetadata: {
          planID: "plan-a",
          commanderFidelity: "aligned_support",
        },
      },
      {
        decisionMetadata: {
          planID: "plan-a",
          commanderFidelity: "hold_plan_blocked",
        },
      },
      {
        decisionMetadata: {
          planID: "plan-a",
          commanderFidelity: "hard_emergency_override",
        },
      },
      {
        decisionMetadata: {
          planID: "plan-a",
          commanderFidelity: "invented",
        },
      },
      { decisionMetadata: { planID: "plan-a" } },
    ]);
    expect(summary.counts).toEqual({
      aligned_primary: 1,
      aligned_support: 1,
      hard_emergency_override: 1,
      hold_plan_blocked: 1,
    });
    expect(summary.fidelityRate).toBeCloseTo(2 / 3);
    expect(summary.unknownDecisions).toBe(2);
    expect(summary.interpretable).toBe(false);
  });

  it("treats zero denominator as unknown rather than perfect", () => {
    expect(
      summarizeCommanderFidelity([
        {
          decisionMetadata: {
            planID: "plan-a",
            commanderFidelity: "hard_emergency_override",
          },
        },
      ]),
    ).toMatchObject({ fidelityRate: null, interpretable: false });
  });

  it("counts zero-aligned plans and fails closed on silent replacement", () => {
    const summary = summarizeCommanderFidelity([
      {
        decisionMetadata: {
          planID: "plan-a",
          commanderFidelity: "aligned_primary",
        },
      },
      {
        decisionMetadata: {
          planID: "plan-b",
          commanderPreviousPlanID: "plan-a",
          commanderReplanReason: "horizon_expiry",
          commanderFidelity: "hold_plan_blocked",
        },
      },
      {
        decisionMetadata: {
          planID: "plan-c",
          commanderPreviousPlanID: "plan-b",
          commanderFidelity: "aligned_primary",
        },
      },
    ]);
    expect(summary).toMatchObject({
      actionsUnderCommanderPlans: 3,
      planCount: 3,
      plansWithZeroAlignedActions: 1,
      planTransitions: 2,
      silentlyAbandonedPlans: 1,
      interpretable: false,
    });
  });

  it("does not count engine-rejected actions as executed fidelity", () => {
    const summary = summarizeCommanderFidelity([
      {
        decisionMetadata: {
          planID: "plan-a",
          commanderFidelity: "aligned_primary",
        },
        result: { accepted: false },
      },
      {
        decisionMetadata: {
          planID: "plan-a",
          commanderFidelity: "aligned_support",
        },
        result: { accepted: false },
      },
    ]);
    expect(summary).toMatchObject({
      actionsUnderCommanderPlans: 0,
      classifiedDecisions: 0,
      rejectedDecisions: 2,
      planCount: 1,
      plansWithZeroAlignedActions: 1,
      fidelityRate: null,
      interpretable: false,
    });
  });

  it("never derives a negative action count from rejected unattributed records", () => {
    const summary = summarizeCommanderFidelity([
      {
        agentID: "agent-a",
        sequence: 1,
        decisionMetadata: { commanderFidelity: "aligned_primary" },
        result: { accepted: false },
      },
    ]);
    expect(summary).toMatchObject({
      actionsUnderCommanderPlans: 0,
      classifiedDecisions: 0,
      rejectedDecisions: 1,
      unattributedDecisions: 1,
      interpretable: false,
    });
  });

  it("detects an unstamped direct plan switch from ordered records", () => {
    const summary = summarizeCommanderFidelity([
      {
        agentID: "agent-a",
        sequence: 10,
        decisionMetadata: {
          planID: "plan-a",
          commanderFidelity: "aligned_primary",
        },
      },
      {
        agentID: "agent-a",
        sequence: 11,
        decisionMetadata: {
          planID: "plan-b",
          commanderFidelity: "aligned_primary",
        },
      },
    ]);
    expect(summary).toMatchObject({
      planTransitions: 1,
      silentlyAbandonedPlans: 1,
      interpretable: false,
    });
  });
});
