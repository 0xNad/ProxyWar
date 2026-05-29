import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import type { AgentLearningReport } from "../../src/server/agents/AgentLearningArtifacts";
import type {
  AgentProfileDifferentiationGate,
  AgentProfileDifferentiationVector,
} from "../../src/server/agents/AgentMatchStory";
import type { AgentStrategyProfile } from "../../src/server/agents/AgentTypes";
import {
  buildAgentLearningComparison,
  writeAgentLearningComparison,
} from "../../src/server/agents/AgentLearningComparison";

describe("AgentLearningComparison", () => {
  it("compares baseline and candidate benchmark outcomes", () => {
    const report = buildAgentLearningComparison({
      comparisonID: "baseline-vs-candidate",
      generatedAt: Date.UTC(2026, 0, 1),
      baseline: {
        label: "baseline",
        benchmarkID: "baseline",
        frontierSummary: {
          wins: 1,
          config: { runs: 2, transportTroopBanking: false },
          runs: [
            { won: true, survived: true, tileShare: 0.51, turns: 10_000 },
            { won: false, survived: false, tileShare: 0.18, turns: 8_000 },
          ],
        },
        learningReport: {
          schemaVersion: 1,
          benchmarkID: "baseline",
          generatedAt: "2026-01-01T00:00:00.000Z",
          runCount: 2,
          winCount: 1,
          tactics: {
            frontierConversionTiming: {
              tacticID: "frontier_conversion_timing",
              observedDecisionCount: 10,
              strategicWindowDecisionCount: 5,
              executorReadyDecisionCount: 4,
              recommendedDecisionCount: 4,
              actedOnDecisionCount: 1,
              missedDecisionCount: 3,
              recommendationActRate: 0.25,
              averageRecommendedOwnTileShare: 0.08,
              averageRecommendedBestTroopRatio: 1.3,
              averageRecommendedExecutorReadyTroopRatio: 1.32,
              examples: [],
              hypotheses: [],
              nextExperiments: [],
            },
            frontierFinishPressure: {
              tacticID: "frontier_finish_pressure",
              observedDecisionCount: 10,
              repeatedProbeDecisionCount: 3,
              recommendedDecisionCount: 4,
              actedOnDecisionCount: 1,
              missedDecisionCount: 3,
              recommendationActRate: 0.25,
              averageRecommendedBestTroopRatio: 1.4,
              averageRecommendedBestTargetTileShare: 0.06,
              averageRecommendedBestAttackTroopPercent: 25,
              examples: [],
              hypotheses: [],
              nextExperiments: [],
            },
            openingExpansionTempo: {
              tacticID: "opening_expansion_tempo",
              observedDecisionCount: 10,
              openingWindowDecisionCount: 6,
              recommendedDecisionCount: 4,
              actedOnDecisionCount: 1,
              missedDecisionCount: 3,
              recommendationActRate: 0.25,
              averageRecommendedOwnTileShare: 0.03,
              averageRecommendedLeaderGap: 0.05,
              examples: [],
              hypotheses: [],
              nextExperiments: [],
            },
            economyCadence: {
              tacticID: "economy_cadence",
              observedDecisionCount: 10,
              recommendedDecisionCount: 4,
              actedOnDecisionCount: 1,
              missedDecisionCount: 3,
              recommendationActRate: 0.25,
              averageRecommendedOwnTileShare: 0.08,
              averageRecommendedRecentExpansionCount: 2,
              averageRecommendedSafeBuildActions: 1,
              examples: [],
              hypotheses: [],
              nextExperiments: [],
            },
            transportTroopBanking: {
              tacticID: "transport_troop_banking",
              observedDecisionCount: 10,
              nearCapDecisionCount: 2,
              recommendedDecisionCount: 2,
              actedOnDecisionCount: 0,
              missedDecisionCount: 2,
              activeBankDecisionCount: 0,
              recommendationActRate: 0,
              winActRate: 0,
              lossActRate: 0,
              maxEffectiveFutureTroopRatio: 1.2,
              examples: [],
              hypotheses: [],
              nextExperiments: [],
            },
          },
          llmReviewPacket: {
            role: "post_match_tactic_researcher",
            constraints: [],
            focusTactics: [],
            requestedOutput: [],
          },
        },
      },
      candidate: {
        label: "candidate",
        benchmarkID: "candidate",
        frontierSummary: {
          wins: 2,
          config: { runs: 2, transportTroopBanking: true },
          runs: [
            {
              won: true,
              survived: true,
              tileShare: 0.61,
              turns: 9_000,
              actionCounts: { boat: 2 },
            },
            {
              won: true,
              survived: true,
              tileShare: 0.57,
              turns: 8_500,
              actionCounts: { boat: 1 },
            },
          ],
        },
        learningReport: {
          schemaVersion: 1,
          benchmarkID: "candidate",
          generatedAt: "2026-01-01T00:00:00.000Z",
          runCount: 2,
          winCount: 2,
          tactics: {
            frontierConversionTiming: {
              tacticID: "frontier_conversion_timing",
              observedDecisionCount: 10,
              strategicWindowDecisionCount: 5,
              executorReadyDecisionCount: 4,
              recommendedDecisionCount: 4,
              actedOnDecisionCount: 3,
              missedDecisionCount: 1,
              recommendationActRate: 0.75,
              averageRecommendedOwnTileShare: 0.1,
              averageRecommendedBestTroopRatio: 1.45,
              averageRecommendedExecutorReadyTroopRatio: 1.5,
              examples: [],
              hypotheses: [],
              nextExperiments: [],
            },
            frontierFinishPressure: {
              tacticID: "frontier_finish_pressure",
              observedDecisionCount: 10,
              repeatedProbeDecisionCount: 3,
              recommendedDecisionCount: 4,
              actedOnDecisionCount: 3,
              missedDecisionCount: 1,
              recommendationActRate: 0.75,
              averageRecommendedBestTroopRatio: 1.6,
              averageRecommendedBestTargetTileShare: 0.05,
              averageRecommendedBestAttackTroopPercent: 25,
              examples: [],
              hypotheses: [],
              nextExperiments: [],
            },
            openingExpansionTempo: {
              tacticID: "opening_expansion_tempo",
              observedDecisionCount: 10,
              openingWindowDecisionCount: 6,
              recommendedDecisionCount: 4,
              actedOnDecisionCount: 3,
              missedDecisionCount: 1,
              recommendationActRate: 0.75,
              averageRecommendedOwnTileShare: 0.04,
              averageRecommendedLeaderGap: 0.03,
              examples: [],
              hypotheses: [],
              nextExperiments: [],
            },
            economyCadence: {
              tacticID: "economy_cadence",
              observedDecisionCount: 10,
              recommendedDecisionCount: 4,
              actedOnDecisionCount: 3,
              missedDecisionCount: 1,
              recommendationActRate: 0.75,
              averageRecommendedOwnTileShare: 0.1,
              averageRecommendedRecentExpansionCount: 2,
              averageRecommendedSafeBuildActions: 2,
              examples: [],
              hypotheses: [],
              nextExperiments: [],
            },
            transportTroopBanking: {
              tacticID: "transport_troop_banking",
              observedDecisionCount: 10,
              nearCapDecisionCount: 2,
              recommendedDecisionCount: 2,
              actedOnDecisionCount: 2,
              missedDecisionCount: 0,
              activeBankDecisionCount: 2,
              recommendationActRate: 1,
              winActRate: 1,
              lossActRate: null,
              maxEffectiveFutureTroopRatio: 1.55,
              examples: [],
              hypotheses: [],
              nextExperiments: [],
            },
          },
          llmReviewPacket: {
            role: "post_match_tactic_researcher",
            constraints: [],
            focusTactics: [],
            requestedOutput: [],
          },
        },
      },
    });

    expect(report.delta).toMatchObject({
      winRate: 0.5,
      averageTileShare: 0.245,
      boatActionCount: 3,
      frontierConversionActRate: 0.5,
      frontierFinishPressureActRate: 0.5,
      openingExpansionActRate: 0.5,
      economyCadenceActRate: 0.5,
      transportBankingActRate: 1,
      focusActRate: 1,
    });
    expect(report.focusTactic).toBe("transport-banking");
    expect(report.verdict.status).toBe("inconclusive");
    expect(report.verdict.reasons).toContain(
      "sample size is too small for a stable conclusion",
    );
  });

  it("promotes an explicit economy cadence candidate without outcome regression", () => {
    const report = buildAgentLearningComparison({
      comparisonID: "economy-cadence-gate",
      generatedAt: Date.UTC(2026, 0, 1),
      focusTactic: "economy-cadence",
      baseline: {
        label: "baseline",
        benchmarkID: "baseline",
        frontierSummary: {
          wins: 2,
          config: { runs: 3, humanReplayEconomyCadence: false },
          runs: [
            { won: true, survived: true, tileShare: 0.4, turns: 10_000 },
            { won: false, survived: true, tileShare: 0.42, turns: 10_500 },
            { won: true, survived: true, tileShare: 0.43, turns: 9_500 },
          ],
        },
        learningReport: learningReport({
          benchmarkID: "baseline",
          economyRate: 0.25,
        }),
      },
      candidate: {
        label: "candidate",
        benchmarkID: "candidate",
        frontierSummary: {
          wins: 2,
          config: { runs: 3, humanReplayEconomyCadence: true },
          runs: [
            { won: true, survived: true, tileShare: 0.41, turns: 10_000 },
            { won: false, survived: true, tileShare: 0.42, turns: 10_500 },
            { won: true, survived: true, tileShare: 0.44, turns: 9_500 },
          ],
        },
        learningReport: learningReport({
          benchmarkID: "candidate",
          economyRate: 0.75,
        }),
      },
    });

    expect(report.focusTactic).toBe("economy-cadence");
    expect(report.delta.focusActRate).toBe(0.5);
    expect(report.verdict.status).toBe("promote");
    expect(report.verdict.nextMilestone).toContain("economy cadence");
  });

  it("promotes an explicit frontier finish-pressure candidate without outcome regression", () => {
    const report = buildAgentLearningComparison({
      comparisonID: "finish-pressure-gate",
      generatedAt: Date.UTC(2026, 0, 1),
      focusTactic: "frontier-finish-pressure",
      baseline: {
        label: "baseline",
        benchmarkID: "baseline",
        frontierSummary: {
          wins: 2,
          config: { runs: 3, frontierFinishPressure: false },
          runs: [
            { won: true, survived: true, tileShare: 0.43, turns: 10_000 },
            { won: false, survived: true, tileShare: 0.4, turns: 10_500 },
            { won: true, survived: true, tileShare: 0.42, turns: 9_500 },
          ],
        },
        learningReport: learningReport({
          benchmarkID: "baseline",
          economyRate: 0.5,
          finishRate: 0.25,
        }),
      },
      candidate: {
        label: "candidate",
        benchmarkID: "candidate",
        frontierSummary: {
          wins: 2,
          config: { runs: 3, frontierFinishPressure: true },
          runs: [
            { won: true, survived: true, tileShare: 0.44, turns: 10_000 },
            { won: false, survived: true, tileShare: 0.41, turns: 10_500 },
            { won: true, survived: true, tileShare: 0.42, turns: 9_500 },
          ],
        },
        learningReport: learningReport({
          benchmarkID: "candidate",
          economyRate: 0.5,
          finishRate: 0.75,
        }),
      },
    });

    expect(report.focusTactic).toBe("frontier-finish-pressure");
    expect(report.delta.focusActRate).toBe(0.5);
    expect(report.verdict.status).toBe("promote");
    expect(report.verdict.nextMilestone).toContain("frontier finish pressure");
  });

  it("promotes an explicit naval-control candidate without outcome regression", () => {
    const report = buildAgentLearningComparison({
      comparisonID: "naval-control-gate",
      generatedAt: Date.UTC(2026, 0, 1),
      focusTactic: "naval-control",
      baseline: {
        label: "baseline",
        benchmarkID: "baseline",
        frontierSummary: {
          wins: 2,
          config: { runs: 3, navalControl: false },
          runs: [
            { won: true, survived: true, tileShare: 0.42, turns: 10_000 },
            { won: false, survived: true, tileShare: 0.4, turns: 10_500 },
            { won: true, survived: true, tileShare: 0.43, turns: 9_500 },
          ],
        },
        learningReport: learningReport({
          benchmarkID: "baseline",
          economyRate: 0.5,
          navalRate: 0.25,
        }),
      },
      candidate: {
        label: "candidate",
        benchmarkID: "candidate",
        frontierSummary: {
          wins: 2,
          config: { runs: 3, navalControl: true },
          runs: [
            {
              won: true,
              survived: true,
              tileShare: 0.43,
              turns: 10_000,
              actionCounts: { boat: 2, warship: 1 },
            },
            {
              won: false,
              survived: true,
              tileShare: 0.41,
              turns: 10_500,
              actionCounts: { boat: 1 },
            },
            {
              won: true,
              survived: true,
              tileShare: 0.44,
              turns: 9_500,
              actionCounts: { move_warship: 1 },
            },
          ],
        },
        learningReport: learningReport({
          benchmarkID: "candidate",
          economyRate: 0.5,
          navalRate: 0.75,
        }),
      },
    });

    expect(report.focusTactic).toBe("naval-control");
    expect(report.delta.navalControlActRate).toBe(0.5);
    expect(report.delta.focusActRate).toBe(0.5);
    expect(report.verdict.status).toBe("promote");
    expect(report.verdict.nextMilestone).toContain("naval control");
  });

  it("promotes an explicit late-game strike-targeting candidate without outcome regression", () => {
    const report = buildAgentLearningComparison({
      comparisonID: "strike-targeting-gate",
      generatedAt: Date.UTC(2026, 0, 1),
      focusTactic: "late-game-strike-targeting",
      baseline: {
        label: "baseline",
        benchmarkID: "baseline",
        frontierSummary: {
          wins: 2,
          config: { runs: 3, lateGameStrikeTargeting: false },
          runs: [
            { won: true, survived: true, tileShare: 0.42, turns: 10_000 },
            { won: false, survived: true, tileShare: 0.4, turns: 10_500 },
            { won: true, survived: true, tileShare: 0.43, turns: 9_500 },
          ],
        },
        learningReport: learningReport({
          benchmarkID: "baseline",
          economyRate: 0.5,
          strikeRate: 0.25,
        }),
      },
      candidate: {
        label: "candidate",
        benchmarkID: "candidate",
        frontierSummary: {
          wins: 2,
          config: { runs: 3, lateGameStrikeTargeting: true },
          runs: [
            { won: true, survived: true, tileShare: 0.43, turns: 10_000 },
            { won: false, survived: true, tileShare: 0.41, turns: 10_500 },
            { won: true, survived: true, tileShare: 0.44, turns: 9_500 },
          ],
        },
        learningReport: learningReport({
          benchmarkID: "candidate",
          economyRate: 0.5,
          strikeRate: 0.75,
        }),
      },
    });

    expect(report.focusTactic).toBe("late-game-strike-targeting");
    expect(report.delta.lateGameStrikeTargetingActRate).toBe(0.5);
    expect(report.delta.focusActRate).toBe(0.5);
    expect(report.verdict.status).toBe("promote");
    expect(report.verdict.nextMilestone).toContain(
      "late-game strike targeting",
    );
  });

  it("infers late-game strike targeting as the focus when only that gate changes", () => {
    const report = buildAgentLearningComparison({
      comparisonID: "strike-infer",
      generatedAt: Date.UTC(2026, 0, 1),
      baseline: {
        label: "baseline",
        benchmarkID: "baseline",
        frontierSummary: {
          wins: 0,
          config: { runs: 3, lateGameStrikeTargeting: false },
        },
        learningReport: learningReport({
          benchmarkID: "baseline",
          economyRate: 0.5,
          strikeRate: 0.25,
        }),
      },
      candidate: {
        label: "candidate",
        benchmarkID: "candidate",
        frontierSummary: {
          wins: 0,
          config: { runs: 3, lateGameStrikeTargeting: true },
        },
        learningReport: learningReport({
          benchmarkID: "candidate",
          economyRate: 0.5,
          strikeRate: 0.75,
        }),
      },
    });

    expect(report.focusTactic).toBe("late-game-strike-targeting");
  });

  it("infers naval control as the focus when only that gate changes", () => {
    const report = buildAgentLearningComparison({
      comparisonID: "naval-infer",
      generatedAt: Date.UTC(2026, 0, 1),
      baseline: {
        label: "baseline",
        benchmarkID: "baseline",
        frontierSummary: { wins: 0, config: { runs: 3, navalControl: false } },
        learningReport: learningReport({
          benchmarkID: "baseline",
          economyRate: 0.5,
          navalRate: 0.25,
        }),
      },
      candidate: {
        label: "candidate",
        benchmarkID: "candidate",
        frontierSummary: { wins: 0, config: { runs: 3, navalControl: true } },
        learningReport: learningReport({
          benchmarkID: "candidate",
          economyRate: 0.5,
          navalRate: 0.75,
        }),
      },
    });

    expect(report.focusTactic).toBe("naval-control");
  });

  it("infers profile differentiation when only profile repair re-rank changes", () => {
    const report = buildAgentLearningComparison({
      comparisonID: "profile-repair-rerank-infer",
      generatedAt: Date.UTC(2026, 0, 1),
      baseline: {
        label: "baseline",
        benchmarkID: "baseline",
        frontierSummary: {
          wins: 0,
          config: { runs: 3, profileRepairReRank: false },
        },
        learningReport: {
          ...learningReport({
            benchmarkID: "baseline",
            economyRate: 0.5,
          }),
          profileRepair: profileRepairSummary(2, 0),
        },
      },
      candidate: {
        label: "candidate",
        benchmarkID: "candidate",
        frontierSummary: {
          wins: 0,
          config: { runs: 3, profileRepairReRank: true },
        },
        learningReport: {
          ...learningReport({
            benchmarkID: "candidate",
            economyRate: 0.5,
          }),
          profileRepair: profileRepairSummary(3, 2),
        },
      },
    });

    expect(report.focusTactic).toBe("profile-differentiation");
    expect(report.baseline.profileRepairReRankEnabled).toBe(false);
    expect(report.candidate.profileRepairReRankEnabled).toBe(true);
    expect(report.baseline.profileRepairRerank.actRate).toBe(0);
    expect(report.candidate.profileRepairRerank.actRate).toBe(0.667);
    expect(report.candidate.profileRepairRerank.topMissedFamily).toBe(
      "weak_hostile_attack",
    );
    expect(report.profileRepairRerankFamilyDeltas[0]).toMatchObject({
      family: "weak_hostile_attack",
      baseline: {
        opportunityCount: 2,
        actedOnCount: 0,
        missedCount: 2,
        actRate: 0,
      },
      candidate: {
        opportunityCount: 3,
        actedOnCount: 2,
        missedCount: 1,
        actRate: 0.667,
      },
      deltaOpportunityCount: 1,
      deltaActedOnCount: 2,
      deltaMissedCount: -1,
      deltaActRate: 0.667,
      candidateTopSuggestedActionIDs: ["attack:rival-1:25(1)"],
    });
    expect(report.delta.profileRepairRerankActRate).toBe(0.667);
    expect(report.delta.focusActRate).toBe(0.667);
    expect(report.verdict.status).toBe("revise");
    expect(report.verdict.reasons).toContain(
      "candidate improved profile repair re-rank act rate",
    );
  });

  it("compares benchmark-level profile differentiation across profile runs", () => {
    const report = buildAgentLearningComparison({
      comparisonID: "profile-differentiation-gate",
      generatedAt: Date.UTC(2026, 0, 1),
      focusTactic: "profile-differentiation",
      baseline: {
        label: "baseline",
        benchmarkID: "baseline",
        frontierSummary: {
          wins: 2,
          config: { runs: 3, profileRepairReRank: false },
          runs: [
            {
              won: true,
              survived: true,
              tileShare: 0.42,
              turns: 10_000,
              profileDifferentiation: profileGate("aggressive", {
                expansion: 0.7,
                economyBuild: 0.1,
              }),
            },
            {
              won: false,
              survived: true,
              tileShare: 0.4,
              turns: 10_500,
              profileDifferentiation: profileGate("defensive", {
                expansion: 0.7,
                economyBuild: 0.1,
              }),
            },
            {
              won: true,
              survived: true,
              tileShare: 0.43,
              turns: 9_500,
              profileDifferentiation: profileGate("diplomatic", {
                expansion: 0.7,
                economyBuild: 0.1,
              }),
            },
          ],
        },
      },
      candidate: {
        label: "candidate",
        benchmarkID: "candidate",
        frontierSummary: {
          wins: 2,
          config: { runs: 3, profileRepairReRank: true },
          runs: [
            {
              won: true,
              survived: true,
              tileShare: 0.43,
              turns: 10_000,
              profileDifferentiation: profileGate(
                "aggressive",
                { combat: 0.65, pressureSignal: 0.25 },
                { signatureScore: 70, signatureMatched: true },
              ),
            },
            {
              won: false,
              survived: true,
              tileShare: 0.41,
              turns: 10_500,
              profileDifferentiation: profileGate(
                "defensive",
                { defense: 0.65, economyBuild: 0.25 },
                { signatureScore: 68, signatureMatched: true },
              ),
            },
            {
              won: true,
              survived: true,
              tileShare: 0.44,
              turns: 9_500,
              profileDifferentiation: profileGate(
                "diplomatic",
                { diplomacySupport: 0.6, communication: 0.3 },
                { signatureScore: 72, signatureMatched: true },
              ),
            },
          ],
        },
      },
    });

    expect(report.focusTactic).toBe("profile-differentiation");
    expect(report.baseline.profileRepairReRankEnabled).toBe(false);
    expect(report.candidate.profileRepairReRankEnabled).toBe(true);
    expect(report.baseline.profileDifferentiation.benchmarkDistinctEnough).toBe(
      false,
    );
    expect(report.candidate.profileDifferentiation.benchmarkDistinctEnough).toBe(
      true,
    );
    expect(report.delta.profileAverageDistance).toBeGreaterThan(0.03);
    expect(report.delta.focusActRate).toBe(report.delta.profileAverageDistance);
    expect(report.verdict.status).toBe("promote");
    expect(report.verdict.nextMilestone).toContain("profile differentiation");
  });

  it("writes comparison JSON and Markdown artifacts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "comparison-"));
    const paths = await writeAgentLearningComparison({
      comparisonID: "compare-write",
      directory,
      baseline: {
        label: "baseline",
        benchmarkID: "baseline",
        frontierSummary: {
          wins: 0,
          config: { runs: 1, profileRepairReRank: false },
          runs: [],
        },
      },
      candidate: {
        label: "candidate",
        benchmarkID: "candidate",
        frontierSummary: {
          wins: 0,
          config: { runs: 1, profileRepairReRank: true },
          runs: [],
        },
      },
    });

    const json = JSON.parse(await fs.readFile(paths.jsonPath, "utf8"));
    const markdown = await fs.readFile(paths.markdownPath, "utf8");
    expect(json.comparisonID).toBe("compare-write");
    expect(markdown).toContain("A/B Comparison");
    expect(markdown).toContain("Focus tactic:");
    expect(markdown).toContain("Profile Repair");
    expect(markdown).toContain("Profile Repair Re-rank Families");
    expect(markdown).toContain("Next milestone");
  });
});

function profileGate(
  profile: AgentStrategyProfile,
  vectorPatch: Partial<AgentProfileDifferentiationVector>,
  options: {
    signatureScore?: number;
    signatureMatched?: boolean;
    stallRisk?: AgentProfileDifferentiationGate["stallRisk"];
  } = {},
): AgentProfileDifferentiationGate {
  const vector: AgentProfileDifferentiationVector = {
    hold: 0,
    expansion: 0,
    combat: 0,
    economyBuild: 0,
    defense: 0,
    naval: 0,
    strike: 0,
    pressureSignal: 0,
    diplomacySupport: 0,
    communication: 0,
    ...vectorPatch,
  };
  const signatureScore = options.signatureScore ?? 20;
  return {
    profileCount: 1,
    evaluatedProfileCount: 1,
    distinctEnough: false,
    averagePairwiseDistance: null,
    stallRisk: options.stallRisk ?? "low",
    summary: "test profile gate",
    profiles: [
      {
        profile,
        decisionCount: 4,
        postSpawnDecisionCount: 3,
        nonHoldRate: 1 - vector.hold,
        holdRate: vector.hold,
        expansionRate: vector.expansion,
        combatRate: vector.combat,
        economyBuildRate: vector.economyBuild,
        defenseRate: vector.defense,
        navalRate: vector.naval,
        strikeRate: vector.strike,
        pressureSignalRate: vector.pressureSignal,
        diplomacySupportRate: vector.diplomacySupport,
        communicationRate: vector.communication,
        socialActionRate:
          vector.pressureSignal +
          vector.diplomacySupport +
          vector.communication,
        uniqueActionKindCount: 3,
        topActionKinds: [],
        signatureScore,
        signatureMatched: options.signatureMatched ?? false,
        signatureLabel:
          options.signatureMatched === true ? `${profile} signature` : `muted ${profile}`,
        vector,
      },
    ],
  };
}

function learningReport(input: {
  benchmarkID: string;
  economyRate: number;
  finishRate?: number;
  navalRate?: number;
  strikeRate?: number;
}): AgentLearningReport {
  const economyRecommended = 4;
  const economyActed = Math.round(input.economyRate * economyRecommended);
  const finishRecommended = 4;
  const finishRate = input.finishRate ?? 0.5;
  const finishActed = Math.round(finishRate * finishRecommended);
  const navalRecommended = 4;
  const navalRate = input.navalRate ?? 0.5;
  const navalActed = Math.round(navalRate * navalRecommended);
  const strikeRecommended = 4;
  const strikeRate = input.strikeRate ?? 0.5;
  const strikeActed = Math.round(strikeRate * strikeRecommended);
  return {
    schemaVersion: 1,
    benchmarkID: input.benchmarkID,
    generatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 3,
    winCount: 2,
    tactics: {
      frontierConversionTiming: {
        tacticID: "frontier_conversion_timing",
        observedDecisionCount: 12,
        strategicWindowDecisionCount: 6,
        executorReadyDecisionCount: 5,
        recommendedDecisionCount: 4,
        actedOnDecisionCount: 2,
        missedDecisionCount: 2,
        recommendationActRate: 0.5,
        averageRecommendedOwnTileShare: 0.08,
        averageRecommendedBestTroopRatio: 1.3,
        averageRecommendedExecutorReadyTroopRatio: 1.32,
        examples: [],
        hypotheses: [],
        nextExperiments: [],
      },
      frontierFinishPressure: {
        tacticID: "frontier_finish_pressure",
        observedDecisionCount: 12,
        repeatedProbeDecisionCount: 4,
        recommendedDecisionCount: finishRecommended,
        actedOnDecisionCount: finishActed,
        missedDecisionCount: finishRecommended - finishActed,
        recommendationActRate: finishRate,
        averageRecommendedBestTroopRatio: 1.6,
        averageRecommendedBestTargetTileShare: 0.05,
        averageRecommendedBestAttackTroopPercent: 25,
        examples: [],
        hypotheses: [],
        nextExperiments: [],
      },
      openingExpansionTempo: {
        tacticID: "opening_expansion_tempo",
        observedDecisionCount: 12,
        openingWindowDecisionCount: 6,
        recommendedDecisionCount: 4,
        actedOnDecisionCount: 2,
        missedDecisionCount: 2,
        recommendationActRate: 0.5,
        averageRecommendedOwnTileShare: 0.03,
        averageRecommendedLeaderGap: 0.05,
        examples: [],
        hypotheses: [],
        nextExperiments: [],
      },
      economyCadence: {
        tacticID: "economy_cadence",
        observedDecisionCount: 12,
        recommendedDecisionCount: economyRecommended,
        actedOnDecisionCount: economyActed,
        missedDecisionCount: economyRecommended - economyActed,
        recommendationActRate: input.economyRate,
        averageRecommendedOwnTileShare: 0.08,
        averageRecommendedRecentExpansionCount: 2,
        averageRecommendedSafeBuildActions: 1,
        examples: [],
        hypotheses: [],
        nextExperiments: [],
      },
      navalControl: {
        tacticID: "naval_control",
        observedDecisionCount: 12,
        recommendedDecisionCount: navalRecommended,
        actedOnDecisionCount: navalActed,
        missedDecisionCount: navalRecommended - navalActed,
        recommendationActRate: navalRate,
        averageRecommendedActiveTransportCount: 1,
        averageRecommendedSafeNavalActions: 2,
        examples: [],
        hypotheses: [],
        nextExperiments: [],
      },
      lateGameStrikeTargeting: {
        tacticID: "late_game_strike_targeting",
        observedDecisionCount: 12,
        recommendedDecisionCount: strikeRecommended,
        actedOnDecisionCount: strikeActed,
        missedDecisionCount: strikeRecommended - strikeActed,
        recommendationActRate: strikeRate,
        averageRecommendedBestStrikeScore: 210,
        averageRecommendedHighValueStrikes: 1,
        examples: [],
        hypotheses: [],
        nextExperiments: [],
      },
      transportTroopBanking: {
        tacticID: "transport_troop_banking",
        observedDecisionCount: 12,
        nearCapDecisionCount: 2,
        recommendedDecisionCount: 2,
        actedOnDecisionCount: 1,
        missedDecisionCount: 1,
        activeBankDecisionCount: 1,
        recommendationActRate: 0.5,
        winActRate: 0.5,
        lossActRate: 0,
        maxEffectiveFutureTroopRatio: 1.2,
        examples: [],
        hypotheses: [],
        nextExperiments: [],
      },
    },
    llmReviewPacket: {
      role: "post_match_tactic_researcher",
      constraints: [],
      focusTactics: [],
      requestedOutput: [],
    },
  };
}

function profileRepairSummary(
  opportunities: number,
  actedOn: number,
): NonNullable<AgentLearningReport["profileRepair"]> {
  const missed = opportunities - actedOn;
  return {
    runCount: 3,
    runWithProfileDataCount: 0,
    profileCount: 0,
    evaluatedProfileCount: 0,
    benchmarkDistinctEnough: false,
    averageProfileDistance: null,
    signatureMatchedRate: null,
    mediumOrHighStallRiskRunCount: 0,
    stallRiskRunRate: null,
    neutralExpansionConvergenceRunCount: 0,
    collapsedSignatureCount: 0,
    missingProfileExpressionCount: 0,
    rerankOpportunityCount: opportunities,
    rerankActedOnCount: actedOn,
    rerankMissedCount: missed,
    rerankActRate:
      opportunities <= 0
        ? null
        : Math.round((actedOn / opportunities) * 1000) / 1000,
    rerankExamples: [],
    rerankFamilySummaries:
      missed > 0
        ? [
            {
              family: "weak_hostile_attack",
              opportunityCount: opportunities,
              actedOnCount: actedOn,
              missedCount: missed,
              actRate:
                opportunities <= 0
                  ? null
                  : Math.round((actedOn / opportunities) * 1000) / 1000,
              profiles: ["aggressive"],
              topSuggestedActionIDs: ["attack:rival-1:25(1)"],
              topSelectedActionIDs: ["expand:terra-nullius:20(1)"],
            },
          ]
        : [],
    examples: [],
    profileSummaries: [],
    hypotheses: [],
    nextExperiments: [],
  };
}
