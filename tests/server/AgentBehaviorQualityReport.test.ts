import { describe, expect, it } from "vitest";
import { UnitType } from "../../src/core/game/Game";
import {
  buildAgentBehaviorQualityReport,
  AgentHoldReasonCategory,
} from "../../src/server/agents/AgentBehaviorQualityReport";
import {
  AgentDecisionRecord,
  AgentTacticalAffordances,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";

describe("AgentBehaviorQualityReport", () => {
  it("detects repeated neutral expansion loops when a handoff is legal", () => {
    const report = buildAgentBehaviorQualityReport({
      runID: "quality-test",
      matchID: "MATCH",
      scenario: "actions",
      brainMode: "planner-executor",
      records: [
        record({ sequence: 1, chosenActionID: "attack:neutral:1" }),
        record({ sequence: 2, chosenActionID: "attack:neutral:2" }),
        record({
          sequence: 3,
          chosenActionID: "attack:neutral:3",
          legalActionIDsByKind: {
            attack: ["attack:neutral:3"],
            build: ["build:City:9"],
            hold: ["hold"],
          },
        }),
      ],
      now: new Date("2026-05-24T10:00:00.000Z"),
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "repeated_neutral_expansion_loop",
          severity: "medium",
        }),
      ]),
    );
  });

  it("distinguishes explained holds from unexplained holds", () => {
    const report = buildAgentBehaviorQualityReport({
      runID: "quality-test",
      matchID: "MATCH",
      scenario: "actions",
      brainMode: "planner-executor",
      records: [
        holdRecord({
          sequence: 1,
          decisionMetadata: {
            holdReasonCategory: "transport_wait" satisfies AgentHoldReasonCategory,
          },
        }),
        holdRecord({ sequence: 2 }),
      ],
    });

    expect(
      report.issues.filter((issue) => issue.category === "unexplained_hold"),
    ).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      category: "unexplained_hold",
      severity: "severe",
      sequence: 2,
    });
  });

  it("flags bad Defense Post placement using placement metadata", () => {
    const report = buildAgentBehaviorQualityReport({
      runID: "quality-test",
      matchID: "MATCH",
      scenario: "actions",
      brainMode: "planner-executor",
      records: [
        record({
          sequence: 1,
          chosenActionID: "build:Defense Post:10",
          chosenActionKind: "build",
          chosenActionMetadata: {
            unit: UnitType.DefensePost,
            defensiveValue: 0.1,
            frontierValue: 0.05,
            nearbyEnemyCount: 0,
            nearbyIncomingAttack: false,
            hostileBorderDistance: 90,
          },
          legalActionIDsByKind: {
            build: ["build:Defense Post:10", "build:City:12"],
            hold: ["hold"],
          },
        }),
      ],
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "bad_defense_post",
          severity: "severe",
        }),
      ]),
    );
  });

  it("flags missed weak-neighbor attack only when executor-ready attack exists", () => {
    const report = buildAgentBehaviorQualityReport({
      runID: "quality-test",
      matchID: "MATCH",
      scenario: "actions",
      brainMode: "planner-executor",
      records: [
        record({
          sequence: 1,
          legalActionIDsByKind: {
            attack: ["attack:neutral:1", "attack:RIVAL:10"],
            hold: ["hold"],
          },
          tacticalAffordances: tacticalAffordances({
            frontierConversionTiming: {
              recommended: true,
              executorReady: true,
              bestExecutorReadyTargetID: "RIVAL",
              bestExecutorReadyRelativeTroopRatio: 1.6,
              executorReadyHostileAttackActionCount: 1,
            },
          }),
        }),
        record({
          sequence: 2,
          chosenActionID: "attack:neutral:2",
          tacticalAffordances: tacticalAffordances({
            frontierConversionTiming: {
              recommended: true,
              executorReady: false,
              bestExecutorReadyTargetID: null,
              executorReadyHostileAttackActionCount: 0,
            },
          }),
        }),
      ],
    });

    const missedWeakNeighbor = report.issues.filter(
      (issue) => issue.category === "missed_weak_neighbor_attack",
    );
    expect(missedWeakNeighbor).toHaveLength(1);
    expect(report.aggregate.weakRivalConversionOpportunityCount).toBe(1);
    expect(report.aggregate.weakRivalConversionMissCount).toBe(1);
  });

  it("flags empty diplomacy when social actions have no follow-through", () => {
    const report = buildAgentBehaviorQualityReport({
      runID: "quality-test",
      matchID: "MATCH",
      scenario: "actions",
      brainMode: "planner-executor",
      records: [
        socialRecord({ sequence: 1, chosenActionID: "quick_chat:hello" }),
        socialRecord({ sequence: 2, chosenActionID: "emoji:smile" }),
      ],
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "empty_diplomacy" }),
      ]),
    );
    expect(report.aggregate.diplomacyFollowThroughRate).toBe(0);
  });

  it("flags stale objective after repeated unaligned decisions", () => {
    const report = buildAgentBehaviorQualityReport({
      runID: "quality-test",
      matchID: "MATCH",
      scenario: "actions",
      brainMode: "planner-executor",
      records: [
        record({
          sequence: 1,
          chosenActionKind: "build",
          chosenActionID: "build:City:1",
          chosenActionMetadata: { unit: UnitType.City },
          objectiveKind: "pressure_rival",
          objectiveAligned: false,
          decisionMetadata: { plannerRefreshReason: "active_plan_reused" },
        }),
        record({
          sequence: 2,
          chosenActionKind: "build",
          chosenActionID: "build:Factory:2",
          chosenActionMetadata: { unit: UnitType.Factory },
          objectiveKind: "pressure_rival",
          objectiveAligned: false,
          decisionMetadata: { plannerRefreshReason: "active_plan_reused" },
        }),
      ],
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "stale_objective" }),
      ]),
    );
  });

  it("flags early-only arc when expansion never turns into build, combat, or diplomacy", () => {
    const report = buildAgentBehaviorQualityReport({
      runID: "quality-test",
      matchID: "MATCH",
      scenario: "actions",
      brainMode: "planner-executor",
      records: [
        record({ sequence: 1, turnNumber: 10 }),
        record({ sequence: 2, turnNumber: 120 }),
        record({ sequence: 3, turnNumber: 240 }),
        record({ sequence: 4, turnNumber: 400 }),
      ],
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "early_only_arc" }),
      ]),
    );
    expect(report.gate.visibleArcPass).toBe(false);
  });
});

function record(
  overrides: Partial<AgentDecisionRecord> = {},
): AgentDecisionRecord {
  const chosenActionKind = overrides.chosenActionKind ?? "attack";
  const chosenActionID = overrides.chosenActionID ?? "attack:neutral:1";
  return {
    sequence: 1,
    gameID: "MATCH",
    agentID: "agent-1",
    clientID: "CLIENT01",
    username: "Quality Agent",
    profile: "opportunistic",
    brainType: "planner-executor",
    turnNumber: 10,
    decidedAt: Date.UTC(2026, 4, 24),
    decisionLatencyMs: 10,
    observationSummary: "test",
    objectiveKind: "expand_territory",
    objectiveSummary: "Expand territory",
    objectiveAligned: true,
    legalActionIDs: [chosenActionID, "hold"],
    legalActionIDsByKind: {
      [chosenActionKind]: [chosenActionID],
      hold: ["hold"],
    } as Partial<Record<LegalActionKind, string[]>>,
    attackActionIDs: chosenActionKind === "attack" ? [chosenActionID] : [],
    chosenActionID,
    chosenActionKind,
    chosenActionMetadata:
      chosenActionKind === "attack" ? { expansion: true } : undefined,
    reason: "test decision",
    intent: null,
    result: { accepted: true, reason: "accepted", submittedIntent: null },
    ...overrides,
  };
}

function holdRecord(
  overrides: Partial<AgentDecisionRecord> = {},
): AgentDecisionRecord {
  return record({
    chosenActionID: "hold",
    chosenActionKind: "hold",
    chosenActionMetadata: undefined,
    legalActionIDsByKind: {
      attack: ["attack:rival:10"],
      hold: ["hold"],
    },
    ...overrides,
  });
}

function socialRecord(
  overrides: Partial<AgentDecisionRecord> = {},
): AgentDecisionRecord {
  return record({
    chosenActionID: "quick_chat:hello",
    chosenActionKind: "quick_chat",
    chosenActionMetadata: { targetID: "RIVAL" },
    legalActionIDsByKind: {
      quick_chat: ["quick_chat:hello"],
      hold: ["hold"],
    },
    ...overrides,
  });
}

function tacticalAffordances(input: {
  frontierConversionTiming?: Partial<
    AgentTacticalAffordances["frontierConversionTiming"]
  >;
}): AgentTacticalAffordances {
  return {
    transportTroopBanking: {
      tacticID: "transport_troop_banking",
      nearCap: false,
      recommended: false,
      ownTroops: 100_000,
      maxTroops: 200_000,
      troopRatio: 0.5,
      activeTransportCount: 0,
      activeTransportTroops: 0,
      largestActiveTransportTroops: 0,
      activeBankRatio: 0,
      continuationReady: false,
      availableBoatLaunchActionCount: 0,
      availableBoatLaunchTroops: [],
      largestAvailableBoatLaunchTroops: 0,
      incomingThreatTroops: 0,
      incomingThreatRatio: 0,
      homeDanger: "low",
      effectiveFutureTroops: 100_000,
      effectiveFutureTroopRatio: 0.5,
      reasons: [],
    },
    frontierConversionTiming: input.frontierConversionTiming
      ? {
          tacticID: "frontier_conversion_timing",
          recommended: false,
          strategicWindow: false,
          executorReady: false,
          turnNumber: 10,
          ownTiles: 10_000,
          ownTileShare: 0.1,
          troopRatio: 0.7,
          enoughLandBase: true,
          recentExpansionCount: 3,
          neutralExpansionAvailable: true,
          neutralExpansionActionCount: 1,
          hostileAttackActionCount: 1,
          favorableHostileAttackActionCount: 1,
          executorReadyHostileAttackActionCount: 0,
          bestTargetID: "RIVAL",
          bestTargetName: "Rival",
          bestTargetRelativeTroopRatio: 1.5,
          bestTargetTileShare: 0.05,
          bestAttackTroopPercent: 10,
          bestExecutorReadyTargetID: null,
          bestExecutorReadyTargetName: null,
          bestExecutorReadyRelativeTroopRatio: null,
          bestExecutorReadyTileShare: null,
          bestExecutorReadyAttackTroopPercent: null,
          leaderTileShare: 0.2,
          leaderTileShareGap: 0.1,
          incomingThreatRatio: 0,
          homeDanger: "low",
          reasons: [],
          ...input.frontierConversionTiming,
        }
      : undefined,
    notes: [],
  };
}
