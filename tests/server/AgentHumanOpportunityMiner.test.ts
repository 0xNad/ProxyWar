import { describe, expect, it } from "vitest";
import {
  AgentDecisionRecordLike,
  AgentHumanOpportunityBaseline,
  buildAgentHumanOpportunityReport,
  humanBaselineFromOpportunityAtlas,
} from "../../src/server/agents/AgentHumanOpportunityMiner";
import type { AgentHomeDangerLevel } from "../../src/server/agents/AgentTypes";

const humanBaseline: AgentHumanOpportunityBaseline = {
  firstNeutralAttackMinute: 0.52,
  firstPlayerAttackMinute: 1.31,
  firstBoatMinute: 1.07,
  firstBuildMinute: 1.88,
  neutralAttacksFirstTwoMinutes: 9,
  neutralAttacksFirstFiveMinutes: 9,
  playerAttacksFirstFiveMinutes: 22,
  boatsFirstFiveMinutes: 7,
  tradeShips: 544,
  tradeGold: 37_449_800,
  capturedCities: 153,
  capturedFactories: 55,
  capturedPorts: 49,
};

describe("AgentHumanOpportunityMiner", () => {
  it("compares agent opening choices to human replay baselines", () => {
    const report = buildAgentHumanOpportunityReport({
      reportID: "gap-run",
      generatedAt: Date.UTC(2026, 0, 1),
      source: "test",
      humanCorpusID: "human-corpus",
      humanBaseline,
      runs: [
        {
          runID: "run-1",
          records: [
            record(1, 0, "spawn", "spawn:123"),
            record(2, 300, "alliance_request", "alliance:rival", {
              neutralLand: 3,
              legalBuilds: ["build:City:10"],
              legalAttacks: [],
            }),
            record(6, 330, "hold", "hold", {
              neutralBoat: 2,
              legalAttacks: [],
            }),
            record(3, 360, "attack", "expand:terra-nullius:35", {
              expansion: true,
              targetID: null,
              targetName: "Terra Nullius",
              neutralLand: 2,
            }),
            record(4, 900, "hold", "hold", {
              legalBuilds: ["build:Factory:20"],
              legalAttacks: ["attack:rival:10"],
            }),
            record(5, 2100, "attack", "attack:rival:25", {
              targetID: "rival",
              targetName: "Rival",
            }),
          ],
        },
      ],
    });

    expect(report.aggregate.firstNeutralExpansionMinute).toBe(0.6);
    expect(report.aggregate.firstPlayerAttackMinute).toBe(3.5);
    expect(report.aggregate.missedNeutralLandCyclesFirstTwoMinutes).toBe(1);
    expect(report.aggregate.missedNeutralBoatCyclesFirstFiveMinutes).toBe(1);
    expect(report.aggregate.missedEconomyBuildCyclesFirstThreeMinutes).toBe(2);
    expect(report.aggregate.missedPressureCyclesFirstThreeMinutes).toBe(1);
    expect(report.gaps.map((gap) => [gap.gapID, gap.severity])).toContainEqual([
      "opening_neutral_saturation",
      "high",
    ]);
    expect(
      report.gaps.find((gap) => gap.gapID === "pressure_handoff"),
    ).toMatchObject({
      severity: "high",
      missedDecisionCycleCount: 1,
    });
  });

  it("does not report gaps when visible opportunities are acted on", () => {
    const report = buildAgentHumanOpportunityReport({
      reportID: "clean-run",
      generatedAt: Date.UTC(2026, 0, 1),
      source: "test",
      humanBaseline,
      runs: [
        {
          runID: "run-1",
          records: [
            record(1, 0, "spawn", "spawn:123"),
            ...Array.from({ length: 9 }, (_, index) =>
              record(
                index + 2,
                300 + index * 10,
                "attack",
                "expand:terra-nullius:35",
                {
                  expansion: true,
                  targetID: null,
                  targetName: "Terra Nullius",
                  neutralLand: 2,
                },
              ),
            ),
            record(20, 660, "boat", "boat:456:25", {
              expansion: true,
              targetID: null,
              targetName: "Terra Nullius",
              neutralBoat: 2,
            }),
            record(21, 960, "build", "build:City:10", {
              unit: "City",
              legalBuilds: ["build:City:10"],
            }),
            record(22, 840, "attack", "attack:rival:10", {
              targetID: "rival",
              legalAttacks: ["attack:rival:10"],
            }),
          ],
        },
      ],
    });

    expect(report.subjects[0].gaps).toEqual([]);
    expect(report.gaps.every((gap) => gap.severity === "none")).toBe(true);
  });

  it("loads winner baselines from an opportunity atlas", () => {
    expect(
      humanBaselineFromOpportunityAtlas({
        baselines: {
          winners: {
            firstNeutralAttackMedian: 0.52,
            firstPlayerAttackMedian: 1.31,
            firstBoatMedian: 1.07,
            firstBuildMedian: 1.88,
            neutralAttacks0to2Median: 9,
            neutralAttacks0to5Median: 9,
            playerAttacks0to5Median: 22,
            boats0to5Median: 7,
            tradeShipsMedian: 544,
            tradeGoldMedian: 37_449_800,
            capturedCitiesMedian: 153,
            capturedFactoriesMedian: 55,
            capturedPortsMedian: 49,
          },
        },
      }),
    ).toMatchObject(humanBaseline);
  });

  it("mines conversion, banking, repeated-probe, and attack-safety misses", () => {
    const report = buildAgentHumanOpportunityReport({
      reportID: "midgame-gaps",
      generatedAt: Date.UTC(2026, 0, 1),
      source: "test",
      humanBaseline,
      runs: [
        {
          runID: "run-1",
          records: [
            record(1, 1200, "hold", "hold", {
              legalAttacks: ["attack:rival:25"],
              conversionTargetID: "rival",
              reason: "waited despite conversion window",
            }),
            record(2, 1300, "attack", "attack:rival:10", {
              targetID: "rival",
              targetName: "Rival",
              troopPercentage: 0.1,
              banking: true,
              reason: "tiny probe while capped",
            }),
            record(3, 1400, "attack", "attack:rival:10", {
              targetID: "rival",
              targetName: "Rival",
              troopPercentage: 0.1,
              neutralLand: 2,
              repeatedProbe: true,
              reason:
                "repeated low-commitment war probes are stalling conversion",
            }),
            record(4, 1500, "hold", "hold", {
              legalAttacks: ["attack:rival:10"],
              neutralLand: 2,
              reason: "attack-safety hold: reserve blocker",
            }),
            record(5, 1600, "attack", "attack:rival:25", {
              targetID: "rival",
              targetName: "Rival",
              troopPercentage: 0.25,
              reason: "urgent defense state makes non-leader attacks too risky",
            }),
          ],
        },
      ],
    });

    expect(report.aggregate.missedConversionCycles).toBe(1);
    expect(report.aggregate.missedBankingCycles).toBe(1);
    expect(report.aggregate.missedRepeatedProbeCycles).toBe(1);
    expect(report.aggregate.repeatedProbeGrowthAlternativeCycles).toBe(1);
    expect(
      report.gaps.find((gap) => gap.gapID === "repeated_probe_discipline")
        ?.examples[0]?.repeatedProbeClass,
    ).toBe("growth_or_economy_alternative");
    expect(report.aggregate.attackSafetyOpportunityCycles).toBe(1);
    expect(report.aggregate.attackSafetyNeutralGrowthOpportunityCycles).toBe(1);
    expect(report.aggregate.unsafeUrgentDefenseAttackCycles).toBe(1);
    expect(report.subjects[0].gaps).toEqual(
      expect.arrayContaining([
        "weak_rival_conversion",
        "transport_troop_banking",
        "repeated_probe_discipline",
        "attack_safety_opportunity",
        "unsafe_urgent_defense_attack",
      ]),
    );
    expect(
      report.gaps.find((gap) => gap.gapID === "weak_rival_conversion"),
    ).toMatchObject({
      severity: "high",
      missedDecisionCycleCount: 1,
    });
    expect(
      report.gaps.find((gap) => gap.gapID === "unsafe_urgent_defense_attack"),
    ).toMatchObject({
      severity: "high",
      missedDecisionCycleCount: 1,
    });
  });

  it("does not count conversion misses when safety blockers explain every attack", () => {
    const report = buildAgentHumanOpportunityReport({
      reportID: "blocked-conversion",
      generatedAt: Date.UTC(2026, 0, 1),
      source: "test",
      humanBaseline,
      runs: [
        {
          runID: "run-1",
          records: [
            record(1, 1200, "hold", "hold", {
              legalAttacks: ["attack:rival:25"],
              conversionTargetID: "rival",
              blockedHostileAttackSummary:
                "attack:rival:25:active pressure makes new wars unsafe+urgent defense state makes non-leader attacks too risky",
              reason: "waited because conversion attack was blocked",
            }),
          ],
        },
      ],
    });

    expect(report.aggregate.missedConversionCycles).toBe(0);
    expect(report.subjects[0].missedConversionCycles).toBe(0);
  });

  it("does not label a clean executor-ready conversion attack as unsafe defense", () => {
    const report = buildAgentHumanOpportunityReport({
      reportID: "conversion-is-actionable",
      generatedAt: Date.UTC(2026, 0, 1),
      source: "test",
      humanBaseline,
      runs: [
        {
          runID: "run-1",
          records: [
            record(1, 1500, "attack", "attack:rival:10", {
              targetID: "rival",
              targetName: "Rival",
              troopPercentage: 0.1,
              relativeTroopRatio: 2,
              conversionTargetID: "rival",
              reason:
                "active pressure makes new wars unsafe|urgent defense state makes non-leader attacks too risky",
            }),
          ],
        },
      ],
    });

    expect(report.aggregate.missedConversionCycles).toBe(0);
    expect(report.aggregate.unsafeUrgentDefenseAttackCycles).toBe(0);
    expect(
      report.gaps.find((gap) => gap.gapID === "unsafe_urgent_defense_attack"),
    ).toMatchObject({ severity: "none", missedDecisionCycleCount: 0 });
  });

  it("classifies repeated probes that are only buying time instead of actionable misses", () => {
    const report = buildAgentHumanOpportunityReport({
      reportID: "buy-time-probes",
      generatedAt: Date.UTC(2026, 0, 1),
      source: "test",
      humanBaseline,
      runs: [
        {
          runID: "run-1",
          records: [
            record(1, 1800, "attack", "attack:rival:10", {
              targetID: "rival",
              targetName: "Rival",
              troopPercentage: 0.1,
              repeatedProbe: true,
              homeDanger: "high",
              reason:
                "counterpressure probe is too small to stop an invasion",
            }),
          ],
        },
      ],
    });

    expect(report.aggregate.missedRepeatedProbeCycles).toBe(0);
    expect(report.aggregate.repeatedProbeBuyingTimeCycles).toBe(1);
    expect(
      report.gaps.find((gap) => gap.gapID === "repeated_probe_discipline"),
    ).toMatchObject({ severity: "none", missedDecisionCycleCount: 0 });
  });

  it("does not count neutral alternatives during high-defense repeated probes", () => {
    const report = buildAgentHumanOpportunityReport({
      reportID: "defense-probes",
      generatedAt: Date.UTC(2026, 0, 1),
      source: "test",
      humanBaseline,
      runs: [
        {
          runID: "run-1",
          records: [
            record(1, 1800, "attack", "attack:rival:10", {
              targetID: "rival",
              targetName: "Rival",
              troopPercentage: 0.1,
              neutralLand: 3,
              repeatedProbe: true,
              strategicPriority: "build_defense",
              strategicUrgency: "high",
              reason:
                "repeated low-commitment war probes are stalling conversion",
            }),
          ],
        },
      ],
    });

    expect(report.aggregate.missedRepeatedProbeCycles).toBe(0);
    expect(report.aggregate.repeatedProbeGrowthAlternativeCycles).toBe(0);
    expect(report.aggregate.repeatedProbeBuyingTimeCycles).toBe(1);
  });

  it("does not count a neutral expansion as missed banking right after a transport launch", () => {
    const report = buildAgentHumanOpportunityReport({
      reportID: "banking-spacing",
      generatedAt: Date.UTC(2026, 0, 1),
      source: "test",
      humanBaseline,
      runs: [
        {
          runID: "run-1",
          records: [
            record(1, 1800, "boat", "boat:shore:25", {
              targetID: null,
              targetName: "Terra Nullius",
              expansion: true,
              banking: true,
            }),
            record(2, 1825, "attack", "expand:terra-nullius:35", {
              targetID: null,
              targetName: "Terra Nullius",
              expansion: true,
              neutralLand: 3,
              banking: true,
              reason: "spaced the next bank launch after a transport",
            }),
          ],
        },
      ],
    });

    expect(report.aggregate.missedBankingCycles).toBe(0);
    expect(report.subjects[0].missedBankingCycles).toBe(0);
  });

  it("does not count decisive weak-rival conversion as missed banking", () => {
    const report = buildAgentHumanOpportunityReport({
      reportID: "banking-conversion-spend",
      generatedAt: Date.UTC(2026, 0, 1),
      source: "test",
      humanBaseline,
      runs: [
        {
          runID: "run-1",
          records: [
            record(1, 1800, "attack", "attack:rival:25", {
              targetID: "rival",
              targetName: "Rival",
              troopPercentage: 0.25,
              relativeTroopRatio: 2.4,
              banking: true,
              reason: "spent capped troops on a clean conversion attack",
            }),
          ],
        },
      ],
    });

    expect(report.aggregate.missedBankingCycles).toBe(0);
    expect(report.subjects[0].missedBankingCycles).toBe(0);
  });

  it("counts neutral boat misses only after direct neutral land thins out", () => {
    const report = buildAgentHumanOpportunityReport({
      reportID: "neutral-boat-clarity",
      generatedAt: Date.UTC(2026, 0, 1),
      source: "test",
      humanBaseline,
      runs: [
        {
          runID: "run-1",
          records: [
            record(1, 1800, "hold", "hold", {
              neutralLand: 3,
              neutralBoat: 9,
              homeDanger: "high",
              reason: "danger makes island launch noisy",
            }),
            record(2, 1900, "attack", "expand:terra-nullius:20", {
              expansion: true,
              neutralLand: 3,
              neutralBoat: 9,
              homeDanger: "low",
              reason: "land neutral is still the cleaner expansion",
            }),
            record(3, 2000, "hold", "hold", {
              neutralLand: 0,
              neutralBoat: 3,
              homeDanger: "low",
              reason: "clear island tempo miss",
            }),
          ],
        },
      ],
    });

    expect(report.subjects[0].legalNeutralBoatCyclesFirstFiveMinutes).toBe(1);
    expect(report.subjects[0].missedNeutralBoatCyclesFirstFiveMinutes).toBe(1);
  });
});

function record(
  sequence: number,
  turnNumber: number,
  kind: string,
  id: string,
  options: {
    expansion?: boolean;
    targetID?: string | null;
    targetName?: string;
    unit?: string;
    neutralLand?: number;
    neutralBoat?: number;
    legalBuilds?: string[];
    legalAttacks?: string[];
    conversionTargetID?: string;
    banking?: boolean;
    repeatedProbe?: boolean;
    decisiveFinishAttackCount?: number;
    troopPercentage?: number;
    relativeTroopRatio?: number;
    blockedHostileAttackSummary?: string;
    homeDanger?: AgentHomeDangerLevel;
    strategicPriority?: string;
    strategicUrgency?: string;
    reason?: string;
  } = {},
): AgentDecisionRecordLike {
  return {
    sequence,
    turnNumber,
    gameID: "GAME01",
    agentID: "agent-1",
    username: "Frontier",
    profile: "aggressive",
    strategicPriority: options.strategicPriority,
    strategicUrgency: options.strategicUrgency,
    chosenActionKind: kind,
    chosenActionID: id,
    chosenActionMetadata: {
      expansion: options.expansion ?? null,
      targetID: options.targetID ?? null,
      targetName: options.targetName ?? null,
      unit: options.unit ?? null,
      troopPercentage: options.troopPercentage ?? null,
      relativeTroopRatio: options.relativeTroopRatio ?? null,
    },
    legalActionIDsByKind: {
      attack: options.legalAttacks ?? [],
      build: options.legalBuilds ?? [],
    },
    decisionMetadata:
      options.blockedHostileAttackSummary === undefined
        ? undefined
        : {
            blockedHostileAttackSummary: options.blockedHostileAttackSummary,
          },
    tacticalAffordances: {
      notes: [],
      transportTroopBanking: {
        tacticID: "transport_troop_banking",
        nearCap: options.banking === true,
        recommended: options.banking === true,
        ownTroops: null,
        maxTroops: null,
        troopRatio: null,
        activeTransportCount: 0,
        activeTransportTroops: 0,
        largestActiveTransportTroops: 0,
        activeBankRatio: 0,
        continuationReady: false,
        availableBoatLaunchActionCount: options.banking === true ? 1 : 0,
        availableBoatLaunchTroops: options.banking === true ? [50_000] : [],
        largestAvailableBoatLaunchTroops: options.banking === true ? 50_000 : 0,
        incomingThreatTroops: 0,
        incomingThreatRatio: null,
        homeDanger: options.homeDanger ?? "low",
        effectiveFutureTroops: null,
        effectiveFutureTroopRatio: null,
        reasons: [],
      },
      openingExpansionTempo: {
        tacticID: "opening_expansion_tempo",
        openingWindow: true,
        recommended: (options.neutralLand ?? 0) > 0,
        turnNumber,
        ownTiles: 100,
        ownTileShare: 0.01,
        expectedTileShare: 0.03,
        leaderTileShare: 0.05,
        leaderTileShareGap: 0.04,
        neutralExpansionAvailable:
          (options.neutralLand ?? 0) + (options.neutralBoat ?? 0) > 0,
        neutralLandExpansionActionCount: options.neutralLand ?? 0,
        neutralBoatExpansionActionCount: options.neutralBoat ?? 0,
        largestExpansionTroopPercent: 35,
        economicBuildActionCount: options.legalBuilds?.length ?? 0,
        incomingThreatRatio: 0,
        homeDanger: options.homeDanger ?? "low",
        behindExpectedTempo: true,
        leaderGapDanger: false,
        reasons: [],
      },
      ...(options.conversionTargetID === undefined
        ? {}
        : {
            frontierConversionTiming: {
              tacticID: "frontier_conversion_timing",
              recommended: true,
              strategicWindow: true,
              executorReady: true,
              turnNumber,
              ownTiles: 10_000,
              ownTileShare: 0.12,
              troopRatio: 0.65,
              enoughLandBase: true,
              recentExpansionCount: 4,
              neutralExpansionAvailable: true,
              neutralExpansionActionCount: 1,
              hostileAttackActionCount: 1,
              favorableHostileAttackActionCount: 1,
              executorReadyHostileAttackActionCount: 1,
              bestTargetID: options.conversionTargetID,
              bestTargetName: "Rival",
              bestTargetRelativeTroopRatio: 2,
              bestTargetTileShare: 0.08,
              bestAttackTroopPercent: 25,
              bestExecutorReadyTargetID: options.conversionTargetID,
              bestExecutorReadyTargetName: "Rival",
              bestExecutorReadyRelativeTroopRatio: 2,
              bestExecutorReadyTileShare: 0.08,
              bestExecutorReadyAttackTroopPercent: 25,
              leaderTileShare: 0.2,
              leaderTileShareGap: 0.08,
              incomingThreatRatio: 0,
              homeDanger: "low",
              reasons: [],
            },
          }),
      ...(options.repeatedProbe === true
        ? {
            frontierFinishPressure: {
              tacticID: "frontier_finish_pressure",
              recommended: true,
              turnNumber,
              ownTileShare: 0.2,
              troopRatio: 0.7,
              homeDanger: options.homeDanger ?? "low",
              activeTargetID: "rival",
              activeTargetName: "Rival",
              recentTargetAttackCount: 4,
              recentLowCommitmentAttackCount: 4,
              repeatedLowCommitmentProbe: true,
              finishingAttackActionCount: 1,
              decisiveAttackActionCount: options.decisiveFinishAttackCount ?? 0,
              bestTargetID: "rival",
              bestTargetName: "Rival",
              bestTargetRelativeTroopRatio: 1.4,
              bestTargetTileShare: 0.08,
              bestTargetTroops: 100_000,
              bestAttackTroopPercent: 10,
              bestAttackID: "attack:rival:10",
              reasons: [],
            },
          }
        : {}),
    },
    reason: options.reason ?? "test",
  };
}
