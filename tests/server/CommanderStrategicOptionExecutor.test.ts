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
import {
  summarizeCommanderFidelity,
  type CommanderFidelityRecord,
} from "../../src/server/agents/StrategicOptionFidelity";
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

function fidelityRecord(input: {
  sequence: number;
  planID?: string;
  objective?: string;
  action: LegalAction;
  batchIndex?: number;
  batchActions?: LegalAction[];
  planAge?: number;
  stamp?: string;
  accepted?: boolean;
  previousPlanID?: string | null;
  replanReason?: string;
}): CommanderFidelityRecord {
  const batchActions = input.batchActions ?? [input.action];
  return {
    agentID: "agent-a",
    sequence: input.sequence,
    legalActionIDs: batchActions.map((action) => action.id),
    chosenActionID: input.action.id,
    chosenActionKind: input.action.kind,
    chosenActionMetadata: input.action.metadata,
    intent: input.action.intent,
    result: {
      accepted: input.accepted ?? true,
      submittedIntent: input.accepted === false ? null : input.action.intent,
    },
    decisionMetadata: {
      planID: input.planID ?? "plan-a",
      planObjective: input.objective ?? "expand",
      commanderFidelity: input.stamp ?? "aligned_primary",
      commanderPlanAgeDecisions: input.planAge ?? 0,
      batchIndex: input.batchIndex ?? 0,
      batchSize: batchActions.length,
      batchActionIDs: batchActions.map((action) => action.id).join(","),
      commanderPreviousPlanID: input.previousPlanID ?? null,
      commanderReplanReason: input.replanReason ?? "within_horizon",
    },
  };
}

describe("StrategicOptionFidelity", () => {
  const expansion = () =>
    input().legalActions.find(
      (action) => action.id === RAW_EXPANSION_ACTION_ID,
    )!;
  const pressure = () =>
    input().legalActions.find((action) => action.id === RAW_ATTACK_ACTION_ID)!;
  const economy = () =>
    input().legalActions.find((action) => action.id === RAW_BUILD_ACTION_ID)!;
  const hold = () =>
    input().legalActions.find((action) => action.id === HOLD_ID)!;
  const support = (): LegalAction => ({
    id: "embargo:P7:start",
    kind: "embargo",
    label: "embargo P7",
    intent: { type: "embargo", targetID: "P7", action: "start" },
    risk: { level: "low" },
    metadata: { targetID: "P7", action: "start" },
  });

  it("recomputes primary, support, blocked, and emergency classes without trusting stamps", () => {
    const primary = pressure();
    const sameTargetSupport = support();
    const summary = summarizeCommanderFidelity([
      fidelityRecord({
        sequence: 1,
        objective: "pressure_rival:P7",
        action: primary,
        batchActions: [primary, sameTargetSupport],
      }),
      fidelityRecord({
        sequence: 2,
        objective: "pressure_rival:P7",
        action: sameTargetSupport,
        batchIndex: 1,
        batchActions: [primary, sameTargetSupport],
        stamp: "aligned_support",
      }),
      fidelityRecord({
        sequence: 3,
        planID: "plan-b",
        objective: "expand",
        action: hold(),
        stamp: "hold_plan_blocked",
        previousPlanID: "plan-a",
        replanReason: "horizon_expiry",
      }),
      fidelityRecord({
        sequence: 4,
        planID: "plan-c",
        objective: "develop_economy",
        action: economy(),
        stamp: "hard_emergency_override",
        previousPlanID: "plan-b",
        replanReason: "horizon_expiry",
      }),
    ]);
    expect(summary.counts).toEqual({
      aligned_primary: 1,
      aligned_support: 1,
      hard_emergency_override: 1,
      hold_plan_blocked: 1,
    });
    expect(summary.primaryDecisionCycles).toBe(3);
    expect(summary.supportActions).toBe(1);
    expect(summary.fidelityRate).toBe(0.5);
    expect(summary.interpretable).toBe(false);
  });

  it("rejects forged aligned stamps on off-target and off-family actions", () => {
    const offTarget = hostileAttack("attack:P3", "P3", 999);
    const cases = [
      fidelityRecord({
        sequence: 1,
        objective: "pressure_rival:P7",
        action: offTarget,
      }),
      fidelityRecord({
        sequence: 2,
        planID: "economy",
        objective: "develop_economy",
        action: offTarget,
      }),
      fidelityRecord({
        sequence: 3,
        planID: "expand",
        objective: "expand",
        action: offTarget,
      }),
      fidelityRecord({
        sequence: 4,
        planID: "survive",
        objective: "survive",
        action: offTarget,
      }),
    ];
    const summary = summarizeCommanderFidelity(cases);
    expect(summary.counts.aligned_primary).toBe(0);
    expect(summary.offFamilyActionViolations).toBe(4);
    expect(summary.zeroPrimaryDecisionCycles).toBe(4);
    expect(summary.fidelityStampViolations).toBe(4);
    expect(summary.interpretable).toBe(false);
  });

  it("rejects unrelated or late support and detects support dilution", () => {
    const primary = pressure();
    const unrelated = {
      ...support(),
      id: "embargo:P3:start",
      intent: { type: "embargo", targetID: "P3", action: "start" } as const,
      metadata: { targetID: "P3", action: "start" },
    } satisfies LegalAction;
    const records = [
      fidelityRecord({
        sequence: 1,
        objective: "pressure_rival:P7",
        action: primary,
        batchActions: [primary, unrelated],
      }),
      fidelityRecord({
        sequence: 2,
        objective: "pressure_rival:P7",
        action: unrelated,
        batchIndex: 1,
        batchActions: [primary, unrelated],
        stamp: "aligned_support",
      }),
    ];
    const summary = summarizeCommanderFidelity(records);
    expect(summary.laterLayerActionViolations).toBe(1);
    expect(summary.offFamilyActionViolations).toBe(1);
    expect(summary.supportActions).toBe(0);
    expect(summary.interpretable).toBe(false);
  });

  it("counts cycles, blocked rate, and option_not_executable dominance", () => {
    const records = Array.from({ length: 20 }, (_unused, index) =>
      fidelityRecord({
        sequence: index + 1,
        action: index < 18 ? expansion() : hold(),
        stamp: index < 18 ? "aligned_primary" : "hold_plan_blocked",
        replanReason:
          index === 18
            ? "option_not_executable"
            : index === 19
              ? "horizon_expiry"
              : "within_horizon",
      }),
    );
    const summary = summarizeCommanderFidelity(records);
    expect(summary.fidelityRate).toBe(0.9);
    expect(summary.blockedCycleRate).toBe(0.1);
    expect(summary.optionNotExecutableReplans).toEqual({
      count: 1,
      opportunities: 2,
      rate: 0.5,
      dominates: true,
    });
    expect(summary.interpretable).toBe(false);
  });

  it("counts a multi-action batch once in option_not_executable dominance", () => {
    const primary = pressure();
    const sameTargetSupport = support();
    const batch = [primary, sameTargetSupport];
    const summary = summarizeCommanderFidelity([
      fidelityRecord({
        sequence: 1,
        objective: "pressure_rival:P7",
        action: primary,
        batchActions: batch,
        replanReason: "option_not_executable",
      }),
      fidelityRecord({
        sequence: 2,
        objective: "pressure_rival:P7",
        action: sameTargetSupport,
        batchIndex: 1,
        batchActions: batch,
        stamp: "aligned_support",
        replanReason: "option_not_executable",
      }),
      fidelityRecord({
        sequence: 3,
        planID: "plan-b",
        action: expansion(),
        previousPlanID: "plan-a",
        replanReason: "horizon_expiry",
      }),
    ]);

    expect(summary.optionNotExecutableReplans).toEqual({
      count: 1,
      opportunities: 2,
      rate: 0.5,
      dominates: true,
    });
  });

  it("does not count engine-rejected actions as executed fidelity", () => {
    const summary = summarizeCommanderFidelity([
      fidelityRecord({ sequence: 1, action: expansion(), accepted: false }),
    ]);
    expect(summary).toMatchObject({
      actionsUnderCommanderPlans: 0,
      classifiedDecisions: 0,
      rejectedDecisions: 1,
      planCount: 1,
      plansWithZeroAlignedActions: 1,
      fidelityRate: 0,
      zeroPrimaryDecisionCycles: 1,
      interpretable: false,
    });
  });

  it("detects an unstamped direct plan switch from ordered records", () => {
    const summary = summarizeCommanderFidelity([
      fidelityRecord({ sequence: 10, planID: "plan-a", action: expansion() }),
      fidelityRecord({ sequence: 11, planID: "plan-b", action: expansion() }),
    ]);
    expect(summary).toMatchObject({
      planTransitions: 1,
      silentlyAbandonedPlans: 1,
      interpretable: false,
    });
  });
});
