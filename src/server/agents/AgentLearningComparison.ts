import fs from "fs/promises";
import path from "path";
import type {
  AgentLearningReport,
  AgentProfileRepairRerankFamily,
  AgentProfileRepairRerankFamilySummary,
} from "./AgentLearningArtifacts";
import type {
  AgentProfileDifferentiationGate,
  AgentProfileDifferentiationVector,
  AgentProfileStorySummary,
} from "./AgentMatchStory";
import type { AgentStrategyProfile } from "./AgentTypes";

export type AgentLearningComparisonFocusTactic =
  | "frontier-conversion"
  | "frontier-finish-pressure"
  | "opening-expansion-tempo"
  | "economy-cadence"
  | "naval-control"
  | "late-game-strike-targeting"
  | "personality-diplomacy-pressure"
  | "profile-differentiation"
  | "transport-banking";

export interface FrontierBenchmarkSummaryRun {
  won?: boolean;
  survived?: boolean;
  tileShare?: number;
  turns?: number;
  actionCounts?: Record<string, number>;
  profileDifferentiation?: AgentProfileDifferentiationGate;
}

export interface FrontierBenchmarkSummaryForComparison {
  pass?: boolean;
  requiredWins?: number;
  wins?: number;
  runs?: FrontierBenchmarkSummaryRun[];
  config?: {
    runID?: string;
    runs?: number;
    difficulty?: string;
    nations?: number;
    bots?: number;
    profile?: string;
    frontierFinishPressure?: boolean;
    navalControl?: boolean;
    lateGameStrikeTargeting?: boolean;
    personalityDiplomacyPressure?: boolean;
    profileRepairReRank?: boolean;
    openingExpansionTempo?: boolean;
    transportTroopBanking?: boolean;
    humanReplayEconomyCadence?: boolean;
  };
}

export interface AgentLearningComparisonSideInput {
  label: string;
  benchmarkID: string;
  frontierSummary: FrontierBenchmarkSummaryForComparison;
  learningReport?: AgentLearningReport | null;
}

export interface AgentLearningComparisonInput {
  comparisonID: string;
  baseline: AgentLearningComparisonSideInput;
  candidate: AgentLearningComparisonSideInput;
  focusTactic?: AgentLearningComparisonFocusTactic | null;
  generatedAt?: number;
}

export interface WriteAgentLearningComparisonInput extends AgentLearningComparisonInput {
  directory?: string;
  rootDir?: string;
}

export interface AgentLearningComparisonSide {
  label: string;
  benchmarkID: string;
  runCount: number;
  winCount: number;
  winRate: number | null;
  survivalRate: number | null;
  averageTileShare: number | null;
  averageTurns: number | null;
  boatActionCount: number;
  frontierFinishPressureEnabled: boolean | null;
  navalControlEnabled: boolean | null;
  lateGameStrikeTargetingEnabled: boolean | null;
  personalityDiplomacyPressureEnabled: boolean | null;
  profileRepairReRankEnabled: boolean | null;
  openingExpansionTempoEnabled: boolean | null;
  transportTroopBankingEnabled: boolean | null;
  humanReplayEconomyCadenceEnabled: boolean | null;
  profileDifferentiation: AgentLearningProfileDifferentiationSummary;
  profileRepairRerank: {
    opportunityCount: number | null;
    actedOnCount: number | null;
    missedCount: number | null;
    actRate: number | null;
    topMissedFamily: string | null;
    familySummaries: AgentLearningProfileRepairRerankFamilySummary[];
  };
  frontierConversionTiming: {
    recommendedDecisionCount: number | null;
    actedOnDecisionCount: number | null;
    missedDecisionCount: number | null;
    recommendationActRate: number | null;
  };
  frontierFinishPressure: {
    recommendedDecisionCount: number | null;
    actedOnDecisionCount: number | null;
    missedDecisionCount: number | null;
    recommendationActRate: number | null;
  };
  openingExpansionTempo: {
    recommendedDecisionCount: number | null;
    actedOnDecisionCount: number | null;
    missedDecisionCount: number | null;
    recommendationActRate: number | null;
  };
  economyCadence: {
    recommendedDecisionCount: number | null;
    actedOnDecisionCount: number | null;
    missedDecisionCount: number | null;
    recommendationActRate: number | null;
  };
  navalControl: {
    recommendedDecisionCount: number | null;
    actedOnDecisionCount: number | null;
    missedDecisionCount: number | null;
    recommendationActRate: number | null;
  };
  lateGameStrikeTargeting: {
    recommendedDecisionCount: number | null;
    actedOnDecisionCount: number | null;
    missedDecisionCount: number | null;
    recommendationActRate: number | null;
  };
  personalityDiplomacyPressure: {
    recommendedDecisionCount: number | null;
    actedOnDecisionCount: number | null;
    missedDecisionCount: number | null;
    recommendationActRate: number | null;
  };
  transportTroopBanking: {
    recommendedDecisionCount: number | null;
    actedOnDecisionCount: number | null;
    missedDecisionCount: number | null;
    recommendationActRate: number | null;
  };
}

export interface AgentLearningProfileDifferentiationProfileSummary {
  profile: AgentStrategyProfile;
  runCount: number;
  averageSignatureScore: number | null;
  signatureMatchedRate: number | null;
  averageNonHoldRate: number | null;
  averageHoldRate: number | null;
  averageCombatRate: number | null;
  averageEconomyBuildRate: number | null;
  averageSocialActionRate: number | null;
  averageNavalRate: number | null;
  averageStrikeRate: number | null;
  topSignatureLabels: string[];
  vector: AgentProfileDifferentiationVector;
}

export interface AgentLearningProfileDifferentiationSummary {
  runCount: number;
  runWithProfileDataCount: number;
  profileCount: number;
  evaluatedProfileCount: number;
  benchmarkDistinctEnough: boolean;
  distinctRunCount: number;
  distinctRunRate: number | null;
  highStallRiskRunCount: number;
  mediumOrHighStallRiskRunCount: number;
  stallRiskRunRate: number | null;
  averageRunPairwiseDistance: number | null;
  averageProfileDistance: number | null;
  averageSignatureScore: number | null;
  signatureMatchedRate: number | null;
  neutralExpansionConvergenceRunCount: number;
  profileSummaries: AgentLearningProfileDifferentiationProfileSummary[];
}

export interface AgentLearningProfileRepairRerankFamilySummary {
  family: AgentProfileRepairRerankFamily;
  opportunityCount: number;
  actedOnCount: number;
  missedCount: number;
  actRate: number | null;
  profiles: AgentStrategyProfile[];
  topSuggestedActionIDs: string[];
  topSelectedActionIDs: string[];
}

export interface AgentLearningProfileRepairRerankFamilyMetric {
  opportunityCount: number;
  actedOnCount: number;
  missedCount: number;
  actRate: number | null;
}

export interface AgentLearningProfileRepairRerankFamilyDelta {
  family: AgentProfileRepairRerankFamily;
  baseline: AgentLearningProfileRepairRerankFamilyMetric;
  candidate: AgentLearningProfileRepairRerankFamilyMetric;
  deltaOpportunityCount: number;
  deltaActedOnCount: number;
  deltaMissedCount: number;
  deltaActRate: number | null;
  candidateTopSuggestedActionIDs: string[];
  candidateTopSelectedActionIDs: string[];
}

export interface AgentLearningComparisonReport {
  schemaVersion: 1;
  comparisonID: string;
  generatedAt: string;
  focusTactic: AgentLearningComparisonFocusTactic;
  baseline: AgentLearningComparisonSide;
  candidate: AgentLearningComparisonSide;
  profileRepairRerankFamilyDeltas: AgentLearningProfileRepairRerankFamilyDelta[];
  delta: {
    winRate: number | null;
    survivalRate: number | null;
    averageTileShare: number | null;
    boatActionCount: number;
    frontierConversionActRate: number | null;
    frontierFinishPressureActRate: number | null;
    openingExpansionActRate: number | null;
    economyCadenceActRate: number | null;
    navalControlActRate: number | null;
    lateGameStrikeTargetingActRate: number | null;
    personalityDiplomacyPressureActRate: number | null;
    profileDistinctRunRate: number | null;
    profileAverageDistance: number | null;
    profileStallRiskRunRate: number | null;
    profileSignatureMatchedRate: number | null;
    profileRepairRerankActRate: number | null;
    transportBankingActRate: number | null;
    focusActRate: number | null;
  };
  verdict: {
    status: "promote" | "revise" | "discard" | "inconclusive";
    reasons: string[];
    nextMilestone: string;
  };
}

export interface AgentLearningComparisonPaths {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export function buildAgentLearningComparison(
  input: AgentLearningComparisonInput,
): AgentLearningComparisonReport {
  const baseline = comparisonSide(input.baseline);
  const candidate = comparisonSide(input.candidate);
  const focusTactic =
    input.focusTactic ?? inferFocusTactic(baseline, candidate);
  const profileRepairRerankFamilyDeltas =
    profileRepairRerankFamilyDeltasForComparison(baseline, candidate);
  const delta = {
    winRate: nullableDelta(candidate.winRate, baseline.winRate),
    survivalRate: nullableDelta(candidate.survivalRate, baseline.survivalRate),
    averageTileShare: nullableDelta(
      candidate.averageTileShare,
      baseline.averageTileShare,
    ),
    boatActionCount: candidate.boatActionCount - baseline.boatActionCount,
    frontierConversionActRate: nullableDelta(
      candidate.frontierConversionTiming.recommendationActRate,
      baseline.frontierConversionTiming.recommendationActRate,
    ),
    frontierFinishPressureActRate: nullableDelta(
      candidate.frontierFinishPressure.recommendationActRate,
      baseline.frontierFinishPressure.recommendationActRate,
    ),
    openingExpansionActRate: nullableDelta(
      candidate.openingExpansionTempo.recommendationActRate,
      baseline.openingExpansionTempo.recommendationActRate,
    ),
    economyCadenceActRate: nullableDelta(
      candidate.economyCadence.recommendationActRate,
      baseline.economyCadence.recommendationActRate,
    ),
    navalControlActRate: nullableDelta(
      candidate.navalControl.recommendationActRate,
      baseline.navalControl.recommendationActRate,
    ),
    lateGameStrikeTargetingActRate: nullableDelta(
      candidate.lateGameStrikeTargeting.recommendationActRate,
      baseline.lateGameStrikeTargeting.recommendationActRate,
    ),
    personalityDiplomacyPressureActRate: nullableDelta(
      candidate.personalityDiplomacyPressure.recommendationActRate,
      baseline.personalityDiplomacyPressure.recommendationActRate,
    ),
    profileDistinctRunRate: nullableDelta(
      candidate.profileDifferentiation.distinctRunRate,
      baseline.profileDifferentiation.distinctRunRate,
    ),
    profileAverageDistance: nullableDelta(
      candidate.profileDifferentiation.averageProfileDistance,
      baseline.profileDifferentiation.averageProfileDistance,
    ),
    profileStallRiskRunRate: nullableDelta(
      candidate.profileDifferentiation.stallRiskRunRate,
      baseline.profileDifferentiation.stallRiskRunRate,
    ),
    profileSignatureMatchedRate: nullableDelta(
      candidate.profileDifferentiation.signatureMatchedRate,
      baseline.profileDifferentiation.signatureMatchedRate,
    ),
    profileRepairRerankActRate: nullableDelta(
      candidate.profileRepairRerank.actRate,
      baseline.profileRepairRerank.actRate,
    ),
    transportBankingActRate: nullableDelta(
      candidate.transportTroopBanking.recommendationActRate,
      baseline.transportTroopBanking.recommendationActRate,
    ),
    focusActRate: nullableDelta(
      tacticRecommendationActRate(candidate, focusTactic),
      tacticRecommendationActRate(baseline, focusTactic),
    ),
  };
  return {
    schemaVersion: 1,
    comparisonID: input.comparisonID,
    generatedAt: new Date(input.generatedAt ?? Date.now()).toISOString(),
    focusTactic,
    baseline,
    candidate,
    profileRepairRerankFamilyDeltas,
    delta,
    verdict: comparisonVerdict({ baseline, candidate, delta, focusTactic }),
  };
}

export async function writeAgentLearningComparison(
  input: WriteAgentLearningComparisonInput,
): Promise<AgentLearningComparisonPaths> {
  const directory =
    input.directory ??
    path.join(
      input.rootDir ??
        path.join(process.cwd(), "artifacts", "ai-learning-comparisons"),
      safePathSegment(input.comparisonID),
    );
  await fs.mkdir(directory, { recursive: true });
  const report = buildAgentLearningComparison(input);
  const jsonPath = path.join(directory, "ab-comparison.json");
  const markdownPath = path.join(directory, "ab-comparison.md");
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(markdownPath, comparisonMarkdown(report)),
  ]);
  return { directory, jsonPath, markdownPath };
}

function comparisonSide(
  input: AgentLearningComparisonSideInput,
): AgentLearningComparisonSide {
  const runs = input.frontierSummary.runs ?? [];
  const runCount =
    runs.length > 0 ? runs.length : (input.frontierSummary.config?.runs ?? 0);
  const winCount =
    input.frontierSummary.wins ?? runs.filter((run) => run.won === true).length;
  const conversion = input.learningReport?.tactics.frontierConversionTiming;
  const finish = input.learningReport?.tactics.frontierFinishPressure;
  const opening = input.learningReport?.tactics.openingExpansionTempo;
  const economy = input.learningReport?.tactics.economyCadence;
  const naval = input.learningReport?.tactics.navalControl;
  const strike = input.learningReport?.tactics.lateGameStrikeTargeting;
  const personality =
    input.learningReport?.tactics.personalityDiplomacyPressure;
  const banking = input.learningReport?.tactics.transportTroopBanking;
  return {
    label: input.label,
    benchmarkID: input.benchmarkID,
    runCount,
    winCount,
    winRate: rate(winCount, runCount),
    survivalRate: rate(
      runs.filter((run) => run.survived === true).length,
      runs.length,
    ),
    averageTileShare: average(runs.map((run) => run.tileShare)),
    averageTurns: average(runs.map((run) => run.turns)),
    boatActionCount: sum(runs.map((run) => run.actionCounts?.boat ?? 0)),
    frontierFinishPressureEnabled:
      input.frontierSummary.config?.frontierFinishPressure ?? null,
    navalControlEnabled: input.frontierSummary.config?.navalControl ?? null,
    lateGameStrikeTargetingEnabled:
      input.frontierSummary.config?.lateGameStrikeTargeting ?? null,
    personalityDiplomacyPressureEnabled:
      input.frontierSummary.config?.personalityDiplomacyPressure ?? null,
    profileRepairReRankEnabled:
      input.frontierSummary.config?.profileRepairReRank ?? null,
    openingExpansionTempoEnabled:
      input.frontierSummary.config?.openingExpansionTempo ?? null,
    transportTroopBankingEnabled:
      input.frontierSummary.config?.transportTroopBanking ?? null,
    humanReplayEconomyCadenceEnabled:
      input.frontierSummary.config?.humanReplayEconomyCadence ?? null,
    profileDifferentiation: profileDifferentiationSummary(runs),
    profileRepairRerank: {
      opportunityCount:
        input.learningReport?.profileRepair?.rerankOpportunityCount ?? null,
      actedOnCount:
        input.learningReport?.profileRepair?.rerankActedOnCount ?? null,
      missedCount: input.learningReport?.profileRepair?.rerankMissedCount ?? null,
      actRate: input.learningReport?.profileRepair?.rerankActRate ?? null,
      topMissedFamily:
        input.learningReport?.profileRepair?.rerankFamilySummaries.find(
          (summary) => summary.missedCount > 0,
        )?.family ?? null,
      familySummaries: profileRepairRerankFamilySummaries(
        input.learningReport?.profileRepair?.rerankFamilySummaries,
      ),
    },
    frontierConversionTiming: {
      recommendedDecisionCount: conversion?.recommendedDecisionCount ?? null,
      actedOnDecisionCount: conversion?.actedOnDecisionCount ?? null,
      missedDecisionCount: conversion?.missedDecisionCount ?? null,
      recommendationActRate: conversion?.recommendationActRate ?? null,
    },
    frontierFinishPressure: {
      recommendedDecisionCount: finish?.recommendedDecisionCount ?? null,
      actedOnDecisionCount: finish?.actedOnDecisionCount ?? null,
      missedDecisionCount: finish?.missedDecisionCount ?? null,
      recommendationActRate: finish?.recommendationActRate ?? null,
    },
    openingExpansionTempo: {
      recommendedDecisionCount: opening?.recommendedDecisionCount ?? null,
      actedOnDecisionCount: opening?.actedOnDecisionCount ?? null,
      missedDecisionCount: opening?.missedDecisionCount ?? null,
      recommendationActRate: opening?.recommendationActRate ?? null,
    },
    economyCadence: {
      recommendedDecisionCount: economy?.recommendedDecisionCount ?? null,
      actedOnDecisionCount: economy?.actedOnDecisionCount ?? null,
      missedDecisionCount: economy?.missedDecisionCount ?? null,
      recommendationActRate: economy?.recommendationActRate ?? null,
    },
    navalControl: {
      recommendedDecisionCount: naval?.recommendedDecisionCount ?? null,
      actedOnDecisionCount: naval?.actedOnDecisionCount ?? null,
      missedDecisionCount: naval?.missedDecisionCount ?? null,
      recommendationActRate: naval?.recommendationActRate ?? null,
    },
    lateGameStrikeTargeting: {
      recommendedDecisionCount: strike?.recommendedDecisionCount ?? null,
      actedOnDecisionCount: strike?.actedOnDecisionCount ?? null,
      missedDecisionCount: strike?.missedDecisionCount ?? null,
      recommendationActRate: strike?.recommendationActRate ?? null,
    },
    personalityDiplomacyPressure: {
      recommendedDecisionCount: personality?.recommendedDecisionCount ?? null,
      actedOnDecisionCount: personality?.actedOnDecisionCount ?? null,
      missedDecisionCount: personality?.missedDecisionCount ?? null,
      recommendationActRate: personality?.recommendationActRate ?? null,
    },
    transportTroopBanking: {
      recommendedDecisionCount: banking?.recommendedDecisionCount ?? null,
      actedOnDecisionCount: banking?.actedOnDecisionCount ?? null,
      missedDecisionCount: banking?.missedDecisionCount ?? null,
      recommendationActRate: banking?.recommendationActRate ?? null,
    },
  };
}

function profileDifferentiationSummary(
  runs: FrontierBenchmarkSummaryRun[],
): AgentLearningProfileDifferentiationSummary {
  const gates = runs
    .map((run) => run.profileDifferentiation)
    .filter(
      (gate): gate is AgentProfileDifferentiationGate => gate !== undefined,
    );
  const runWithProfileDataCount = gates.filter(
    (gate) => gate.evaluatedProfileCount > 0,
  ).length;
  const distinctRunCount = gates.filter((gate) => gate.distinctEnough).length;
  const highStallRiskRunCount = gates.filter(
    (gate) => gate.stallRisk === "high",
  ).length;
  const mediumOrHighStallRiskRunCount = gates.filter(
    (gate) => gate.stallRisk !== "low",
  ).length;
  const runDistances = gates
    .map((gate) => gate.averagePairwiseDistance)
    .filter((value): value is number => typeof value === "number");
  const profileSummaries = benchmarkProfileSummaries(
    gates.flatMap((gate) => gate.profiles),
  );
  const averageProfileDistance =
    profileSummaries.length < 2
      ? null
      : round(
          averageProfileVectorDistance(
            profileSummaries.map((profile) => profile.vector),
          ),
        );
  const evaluatedProfileCount = sum(
    profileSummaries.map((profile) => profile.runCount),
  );
  const signatureMatchedValues = profileSummaries
    .map((profile) => profile.signatureMatchedRate)
    .filter((value): value is number => value !== null);
  const signatureMatchedRate = averageNullable(signatureMatchedValues);
  const averageSignatureScore = averageNullable(
    profileSummaries
      .map((profile) => profile.averageSignatureScore)
      .filter((value): value is number => value !== null),
  );
  const stallRiskRunRate = rate(mediumOrHighStallRiskRunCount, gates.length);
  const benchmarkDistinctEnough =
    profileSummaries.length >= 2 &&
    averageProfileDistance !== null &&
    averageProfileDistance >= 0.14 &&
    (signatureMatchedRate ?? 0) >= 0.5 &&
    (stallRiskRunRate ?? 1) < 0.5;

  return {
    runCount: runs.length,
    runWithProfileDataCount,
    profileCount: profileSummaries.length,
    evaluatedProfileCount,
    benchmarkDistinctEnough,
    distinctRunCount,
    distinctRunRate: rate(distinctRunCount, gates.length),
    highStallRiskRunCount,
    mediumOrHighStallRiskRunCount,
    stallRiskRunRate,
    averageRunPairwiseDistance: averageNullable(runDistances),
    averageProfileDistance,
    averageSignatureScore,
    signatureMatchedRate,
    neutralExpansionConvergenceRunCount: gates.filter(
      profilesConvergedOnNeutralExpansion,
    ).length,
    profileSummaries,
  };
}

function profileRepairRerankFamilySummaries(
  summaries?: AgentProfileRepairRerankFamilySummary[],
): AgentLearningProfileRepairRerankFamilySummary[] {
  return (summaries ?? []).map((summary) => ({
    family: summary.family,
    opportunityCount: summary.opportunityCount,
    actedOnCount: summary.actedOnCount,
    missedCount: summary.missedCount,
    actRate: summary.actRate,
    profiles: [...summary.profiles],
    topSuggestedActionIDs: [...summary.topSuggestedActionIDs],
    topSelectedActionIDs: [...summary.topSelectedActionIDs],
  }));
}

function profileRepairRerankFamilyDeltasForComparison(
  baseline: AgentLearningComparisonSide,
  candidate: AgentLearningComparisonSide,
): AgentLearningProfileRepairRerankFamilyDelta[] {
  const baselineByFamily = profileRepairRerankFamilyMap(
    baseline.profileRepairRerank.familySummaries,
  );
  const candidateByFamily = profileRepairRerankFamilyMap(
    candidate.profileRepairRerank.familySummaries,
  );
  const families = new Set<AgentProfileRepairRerankFamily>([
    ...baselineByFamily.keys(),
    ...candidateByFamily.keys(),
  ]);
  return [...families]
    .map((family) => {
      const baselineSummary = baselineByFamily.get(family);
      const candidateSummary = candidateByFamily.get(family);
      const baselineMetric =
        profileRepairRerankFamilyMetric(baselineSummary);
      const candidateMetric =
        profileRepairRerankFamilyMetric(candidateSummary);
      return {
        family,
        baseline: baselineMetric,
        candidate: candidateMetric,
        deltaOpportunityCount:
          candidateMetric.opportunityCount - baselineMetric.opportunityCount,
        deltaActedOnCount:
          candidateMetric.actedOnCount - baselineMetric.actedOnCount,
        deltaMissedCount:
          candidateMetric.missedCount - baselineMetric.missedCount,
        deltaActRate: nullableDelta(
          candidateMetric.actRate,
          baselineMetric.actRate,
        ),
        candidateTopSuggestedActionIDs:
          candidateSummary?.topSuggestedActionIDs ?? [],
        candidateTopSelectedActionIDs:
          candidateSummary?.topSelectedActionIDs ?? [],
      };
    })
    .sort(profileRepairRerankFamilyDeltaSort);
}

function profileRepairRerankFamilyMap(
  summaries: AgentLearningProfileRepairRerankFamilySummary[],
): Map<
  AgentProfileRepairRerankFamily,
  AgentLearningProfileRepairRerankFamilySummary
> {
  return new Map(summaries.map((summary) => [summary.family, summary]));
}

function profileRepairRerankFamilyMetric(
  summary?: AgentLearningProfileRepairRerankFamilySummary,
): AgentLearningProfileRepairRerankFamilyMetric {
  if (summary === undefined) {
    return {
      opportunityCount: 0,
      actedOnCount: 0,
      missedCount: 0,
      actRate: null,
    };
  }
  return {
    opportunityCount: summary.opportunityCount,
    actedOnCount: summary.actedOnCount,
    missedCount: summary.missedCount,
    actRate: summary.actRate,
  };
}

function profileRepairRerankFamilyDeltaSort(
  left: AgentLearningProfileRepairRerankFamilyDelta,
  right: AgentLearningProfileRepairRerankFamilyDelta,
): number {
  return (
    right.candidate.missedCount - left.candidate.missedCount ||
    right.baseline.missedCount - left.baseline.missedCount ||
    right.candidate.opportunityCount - left.candidate.opportunityCount ||
    left.family.localeCompare(right.family)
  );
}

function benchmarkProfileSummaries(
  profiles: AgentProfileStorySummary[],
): AgentLearningProfileDifferentiationProfileSummary[] {
  const byProfile = new Map<AgentStrategyProfile, AgentProfileStorySummary[]>();
  for (const profile of profiles) {
    const rows = byProfile.get(profile.profile) ?? [];
    rows.push(profile);
    byProfile.set(profile.profile, rows);
  }
  return [...byProfile.entries()]
    .sort((left, right) => profileOrder(left[0]) - profileOrder(right[0]))
    .map(([profile, rows]) => {
      const matchedCount = rows.filter((row) => row.signatureMatched).length;
      return {
        profile,
        runCount: rows.length,
        averageSignatureScore: averageNullable(
          rows.map((row) => row.signatureScore),
        ),
        signatureMatchedRate: rate(matchedCount, rows.length),
        averageNonHoldRate: averageNullable(rows.map((row) => row.nonHoldRate)),
        averageHoldRate: averageNullable(rows.map((row) => row.holdRate)),
        averageCombatRate: averageNullable(rows.map((row) => row.combatRate)),
        averageEconomyBuildRate: averageNullable(
          rows.map((row) => row.economyBuildRate),
        ),
        averageSocialActionRate: averageNullable(
          rows.map((row) => row.socialActionRate),
        ),
        averageNavalRate: averageNullable(rows.map((row) => row.navalRate)),
        averageStrikeRate: averageNullable(rows.map((row) => row.strikeRate)),
        topSignatureLabels: topValues(rows.map((row) => row.signatureLabel), 3),
        vector: averageProfileVector(rows.map((row) => row.vector)),
      };
    });
}

function averageProfileVector(
  vectors: AgentProfileDifferentiationVector[],
): AgentProfileDifferentiationVector {
  return {
    hold: average(vectors.map((vector) => vector.hold)) ?? 0,
    expansion: average(vectors.map((vector) => vector.expansion)) ?? 0,
    combat: average(vectors.map((vector) => vector.combat)) ?? 0,
    economyBuild: average(vectors.map((vector) => vector.economyBuild)) ?? 0,
    defense: average(vectors.map((vector) => vector.defense)) ?? 0,
    naval: average(vectors.map((vector) => vector.naval)) ?? 0,
    strike: average(vectors.map((vector) => vector.strike)) ?? 0,
    pressureSignal: average(vectors.map((vector) => vector.pressureSignal)) ?? 0,
    diplomacySupport:
      average(vectors.map((vector) => vector.diplomacySupport)) ?? 0,
    communication: average(vectors.map((vector) => vector.communication)) ?? 0,
  };
}

function averageProfileVectorDistance(
  vectors: AgentProfileDifferentiationVector[],
): number {
  let total = 0;
  let count = 0;
  for (let leftIndex = 0; leftIndex < vectors.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < vectors.length;
      rightIndex += 1
    ) {
      total += profileVectorDistance(
        vectors[leftIndex]!,
        vectors[rightIndex]!,
      );
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

function profileVectorDistance(
  left: AgentProfileDifferentiationVector,
  right: AgentProfileDifferentiationVector,
): number {
  const keys: (keyof AgentProfileDifferentiationVector)[] = [
    "hold",
    "expansion",
    "combat",
    "economyBuild",
    "defense",
    "naval",
    "strike",
    "pressureSignal",
    "diplomacySupport",
    "communication",
  ];
  const squaredDistance = keys.reduce((sum, key) => {
    const delta = left[key] - right[key];
    return sum + delta * delta;
  }, 0);
  return Math.sqrt(squaredDistance / keys.length);
}

function profilesConvergedOnNeutralExpansion(
  gate: AgentProfileDifferentiationGate,
): boolean {
  const evaluatedProfiles = gate.profiles.filter(
    (profile) => profile.postSpawnDecisionCount >= 2,
  );
  return (
    evaluatedProfiles.length >= 2 &&
    evaluatedProfiles.every(
      (profile) =>
        profile.expansionRate >= 0.45 &&
        profile.combatRate < 0.2 &&
        profile.economyBuildRate < 0.2 &&
        profile.socialActionRate < 0.2,
    )
  );
}

function topValues(values: string[], limit: number): string[] {
  const counts = values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => `${value}(${count})`);
}

function profileOrder(profile: AgentStrategyProfile): number {
  switch (profile) {
    case "aggressive":
      return 0;
    case "defensive":
      return 1;
    case "diplomatic":
      return 2;
    case "opportunistic":
      return 3;
  }
}

function comparisonVerdict(input: {
  baseline: AgentLearningComparisonSide;
  candidate: AgentLearningComparisonSide;
  delta: AgentLearningComparisonReport["delta"];
  focusTactic: AgentLearningComparisonFocusTactic;
}): AgentLearningComparisonReport["verdict"] {
  const reasons: string[] = [];
  const winDelta = input.delta.winRate ?? 0;
  const tileDelta = input.delta.averageTileShare ?? 0;
  const survivalDelta = input.delta.survivalRate ?? 0;
  const focusDelta = input.delta.focusActRate;
  const candidateFocus = tacticMetrics(input.candidate, input.focusTactic);
  const focusLabel = comparisonFocusMetricLabel(input);
  if (input.baseline.runCount !== input.candidate.runCount) {
    reasons.push(
      "run counts differ; compare with fixed seeds before promoting",
    );
  }
  if (input.candidate.runCount < 3) {
    reasons.push("sample size is too small for a stable conclusion");
  }
  if (winDelta > 0 || tileDelta >= 0.025) {
    reasons.push("candidate improved win rate or average tile share");
  }
  if (focusDelta !== null && focusDelta > 0) {
    reasons.push(`candidate improved ${focusLabel}`);
  }
  if (focusDelta !== null && focusDelta < 0) {
    reasons.push(`candidate regressed ${focusLabel}`);
  }
  if (
    input.focusTactic === "profile-differentiation" &&
    input.candidate.profileDifferentiation.benchmarkDistinctEnough
  ) {
    reasons.push("candidate reached the benchmark profile differentiation gate");
  }
  if (
    input.focusTactic === "profile-differentiation" &&
    !input.candidate.profileDifferentiation.benchmarkDistinctEnough
  ) {
    reasons.push("candidate profile differentiation gate still needs review");
  }
  if (
    input.focusTactic === "profile-differentiation" &&
    (input.candidate.profileDifferentiation.stallRiskRunRate ?? 0) >= 0.5
  ) {
    reasons.push("candidate still has frequent profile stall-risk runs");
  }
  if (winDelta < 0 || tileDelta <= -0.025 || survivalDelta <= -0.05) {
    reasons.push(
      "candidate regressed win rate, survival, or average tile share",
    );
  }
  if (
    candidateFocus.recommendedDecisionCount === 0 ||
    candidateFocus.recommendedDecisionCount === null
  ) {
    reasons.push(
      `candidate benchmark did not expose ${focusTacticLabel(input.focusTactic)} opportunities`,
    );
  }
  if (input.candidate.runCount < 3) {
    return {
      status: "inconclusive",
      reasons,
      nextMilestone:
        "Run at least 3 fixed-seed Hard-nation matches per side before judging the tactic.",
    };
  }
  if (
    candidateFocus.recommendedDecisionCount === 0 ||
    candidateFocus.recommendedDecisionCount === null
  ) {
    return {
      status: "inconclusive",
      reasons,
      nextMilestone: `Run a targeted benchmark that exposes ${focusTacticLabel(
        input.focusTactic,
      )} opportunities before judging this tactic.`,
    };
  }
  if (winDelta < 0 || tileDelta <= -0.025 || survivalDelta <= -0.05) {
    return {
      status: "discard",
      reasons,
      nextMilestone: `Disable or narrow the ${focusTacticLabel(
        input.focusTactic,
      )} trigger, then rerun the same A/B seeds.`,
    };
  }
  const promotionDelta =
    input.focusTactic === "profile-differentiation" ? 0.03 : 0.1;
  if (focusDelta !== null && focusDelta >= promotionDelta) {
    if (
      input.focusTactic === "profile-differentiation" &&
      !input.candidate.profileDifferentiation.benchmarkDistinctEnough
    ) {
      return {
        status: "revise",
        reasons,
        nextMilestone: reviseMilestone(input.focusTactic),
      };
    }
    return {
      status: "promote",
      reasons,
      nextMilestone: promotionMilestone(input.focusTactic),
    };
  }
  if (
    input.focusTactic === "profile-differentiation" &&
    input.candidate.profileDifferentiation.benchmarkDistinctEnough &&
    (input.delta.profileSignatureMatchedRate ?? 0) >= 0.1
  ) {
    return {
      status: "promote",
      reasons,
      nextMilestone: promotionMilestone(input.focusTactic),
    };
  }
  return {
    status: "revise",
    reasons:
      reasons.length > 0
        ? reasons
        : ["candidate was roughly neutral on current benchmark"],
    nextMilestone: reviseMilestone(input.focusTactic),
  };
}

function comparisonMarkdown(report: AgentLearningComparisonReport): string {
  return [
    `# Agent Learning A/B Comparison ${report.comparisonID}`,
    "",
    `Generated: ${report.generatedAt}`,
    `Focus tactic: ${focusTacticLabel(report.focusTactic)}`,
    "",
    markdownTable(
      [
        "Side",
        "Benchmark",
        "Runs",
        "Wins",
        "Win Rate",
        "Survival",
        "Avg Tile Share",
        "Conversion Acted/Recommended",
        "Finish Acted/Recommended",
        "Opening Acted/Recommended",
        "Economy Acted/Recommended",
        "Naval Acted/Recommended",
        "Strike Acted/Recommended",
        "Personality Acted/Recommended",
        "Profile Repair",
        "Profile Gate",
        "Profile Distance",
        "Profile Stall",
        "Boat Actions",
        "Banking Acted/Recommended",
      ],
      [report.baseline, report.candidate].map((side) => [
        side.label,
        side.benchmarkID,
        String(side.runCount),
        String(side.winCount),
        formatNullable(side.winRate),
        formatNullable(side.survivalRate),
        formatNullable(side.averageTileShare),
        `${side.frontierConversionTiming.actedOnDecisionCount ?? "?"}/${side.frontierConversionTiming.recommendedDecisionCount ?? "?"}`,
        `${side.frontierFinishPressure.actedOnDecisionCount ?? "?"}/${side.frontierFinishPressure.recommendedDecisionCount ?? "?"}`,
        `${side.openingExpansionTempo.actedOnDecisionCount ?? "?"}/${side.openingExpansionTempo.recommendedDecisionCount ?? "?"}`,
        `${side.economyCadence.actedOnDecisionCount ?? "?"}/${side.economyCadence.recommendedDecisionCount ?? "?"}`,
        `${side.navalControl.actedOnDecisionCount ?? "?"}/${side.navalControl.recommendedDecisionCount ?? "?"}`,
        `${side.lateGameStrikeTargeting.actedOnDecisionCount ?? "?"}/${side.lateGameStrikeTargeting.recommendedDecisionCount ?? "?"}`,
        `${side.personalityDiplomacyPressure.actedOnDecisionCount ?? "?"}/${side.personalityDiplomacyPressure.recommendedDecisionCount ?? "?"}`,
        formatFlag(side.profileRepairReRankEnabled),
        side.profileDifferentiation.benchmarkDistinctEnough
          ? "distinct"
          : "review",
        formatNullable(side.profileDifferentiation.averageProfileDistance),
        `${side.profileDifferentiation.mediumOrHighStallRiskRunCount}/${side.profileDifferentiation.runWithProfileDataCount}`,
        String(side.boatActionCount),
        `${side.transportTroopBanking.actedOnDecisionCount ?? "?"}/${side.transportTroopBanking.recommendedDecisionCount ?? "?"}`,
      ]),
    ),
    "",
    "## Delta",
    "",
    markdownTable(
      [
        "Win Rate",
        "Survival",
        "Avg Tile Share",
        "Conversion Act Rate",
        "Finish Act Rate",
        "Opening Act Rate",
        "Economy Act Rate",
        "Naval Act Rate",
        "Strike Act Rate",
        "Personality Act Rate",
        "Profile Distance",
        "Profile Distinct Runs",
        "Profile Stall Risk",
        "Profile Signature Match",
        "Repair Act Rate",
        "Boat Actions",
        "Banking Act Rate",
        "Focus Metric",
      ],
      [
        [
          formatSignedNullable(report.delta.winRate),
          formatSignedNullable(report.delta.survivalRate),
          formatSignedNullable(report.delta.averageTileShare),
          formatSignedNullable(report.delta.frontierConversionActRate),
          formatSignedNullable(report.delta.frontierFinishPressureActRate),
          formatSignedNullable(report.delta.openingExpansionActRate),
          formatSignedNullable(report.delta.economyCadenceActRate),
          formatSignedNullable(report.delta.navalControlActRate),
          formatSignedNullable(report.delta.lateGameStrikeTargetingActRate),
          formatSignedNullable(report.delta.personalityDiplomacyPressureActRate),
          formatSignedNullable(report.delta.profileAverageDistance),
          formatSignedNullable(report.delta.profileDistinctRunRate),
          formatSignedNullable(report.delta.profileStallRiskRunRate),
          formatSignedNullable(report.delta.profileSignatureMatchedRate),
          formatSignedNullable(report.delta.profileRepairRerankActRate),
          signed(report.delta.boatActionCount),
          formatSignedNullable(report.delta.transportBankingActRate),
          formatSignedNullable(report.delta.focusActRate),
        ],
      ],
    ),
    "",
    "## Profile Differentiation",
    "",
    markdownTable(
      [
        "Side",
        "Gate",
        "Repair Re-rank",
        "Repair Acted/Opportunity",
        "Repair Act Rate",
        "Top Missed Family",
        "Profiles",
        "Evaluated Signatures",
        "Avg Profile Distance",
        "Signature Match",
        "Distinct Runs",
        "Stall Risk Runs",
      ],
      [report.baseline, report.candidate].map((side) => [
        side.label,
        side.profileDifferentiation.benchmarkDistinctEnough
          ? "distinct"
          : "needs review",
        formatFlag(side.profileRepairReRankEnabled),
        `${side.profileRepairRerank.actedOnCount ?? "?"}/${side.profileRepairRerank.opportunityCount ?? "?"}`,
        formatNullable(side.profileRepairRerank.actRate),
        side.profileRepairRerank.topMissedFamily ?? "none",
        String(side.profileDifferentiation.profileCount),
        String(side.profileDifferentiation.evaluatedProfileCount),
        formatNullable(side.profileDifferentiation.averageProfileDistance),
        formatNullable(side.profileDifferentiation.signatureMatchedRate),
        `${side.profileDifferentiation.distinctRunCount}/${side.profileDifferentiation.runWithProfileDataCount}`,
        `${side.profileDifferentiation.mediumOrHighStallRiskRunCount}/${side.profileDifferentiation.runWithProfileDataCount}`,
      ]),
    ),
    "",
    "## Profile Repair Re-rank Families",
    "",
    profileRepairRerankFamilyMarkdown(report),
    "",
    profileDifferentiationProfileMarkdown(report),
    "",
    "## Verdict",
    "",
    `Status: **${report.verdict.status}**`,
    "",
    ...report.verdict.reasons.map((reason) => `- ${reason}`),
    "",
    `Next milestone: ${report.verdict.nextMilestone}`,
    "",
  ].join("\n");
}

function profileRepairRerankFamilyMarkdown(
  report: AgentLearningComparisonReport,
): string {
  if (report.profileRepairRerankFamilyDeltas.length === 0) {
    return "No profile repair re-rank family summaries were available in the compared learning reports.";
  }
  return markdownTable(
    [
      "Family",
      "Baseline Acted/Opportunity",
      "Candidate Acted/Opportunity",
      "Delta Act Rate",
      "Baseline Missed",
      "Candidate Missed",
      "Delta Missed",
      "Candidate Suggested",
      "Candidate Selected",
    ],
    report.profileRepairRerankFamilyDeltas.map((delta) => [
      delta.family,
      `${delta.baseline.actedOnCount}/${delta.baseline.opportunityCount}`,
      `${delta.candidate.actedOnCount}/${delta.candidate.opportunityCount}`,
      formatSignedNullable(delta.deltaActRate),
      String(delta.baseline.missedCount),
      String(delta.candidate.missedCount),
      signed(delta.deltaMissedCount),
      delta.candidateTopSuggestedActionIDs.join(", ") || "none",
      delta.candidateTopSelectedActionIDs.join(", ") || "none",
    ]),
  );
}

function profileDifferentiationProfileMarkdown(
  report: AgentLearningComparisonReport,
): string {
  const rows = [report.baseline, report.candidate].flatMap((side) =>
    side.profileDifferentiation.profileSummaries.map((profile) => [
      side.label,
      profile.profile,
      String(profile.runCount),
      formatNullable(profile.averageSignatureScore),
      formatNullable(profile.signatureMatchedRate),
      formatNullable(profile.averageNonHoldRate),
      formatNullable(profile.averageCombatRate),
      formatNullable(profile.averageEconomyBuildRate),
      formatNullable(profile.averageSocialActionRate),
      formatNullable(profile.averageNavalRate),
      profile.topSignatureLabels.join(", ") || "none",
    ]),
  );
  if (rows.length === 0) {
    return "No per-profile signatures were available in the compared benchmark summaries.";
  }
  return markdownTable(
    [
      "Side",
      "Profile",
      "Runs",
      "Signature Score",
      "Matched",
      "Non-hold",
      "Combat",
      "Build",
      "Social",
      "Naval",
      "Signatures",
    ],
    rows,
  );
}

function inferFocusTactic(
  baseline: AgentLearningComparisonSide,
  candidate: AgentLearningComparisonSide,
): AgentLearningComparisonFocusTactic {
  if (
    baseline.frontierFinishPressureEnabled !==
    candidate.frontierFinishPressureEnabled
  ) {
    return "frontier-finish-pressure";
  }
  if (baseline.navalControlEnabled !== candidate.navalControlEnabled) {
    return "naval-control";
  }
  if (
    baseline.lateGameStrikeTargetingEnabled !==
    candidate.lateGameStrikeTargetingEnabled
  ) {
    return "late-game-strike-targeting";
  }
  if (
    baseline.personalityDiplomacyPressureEnabled !==
    candidate.personalityDiplomacyPressureEnabled
  ) {
    return "personality-diplomacy-pressure";
  }
  if (
    baseline.profileRepairReRankEnabled !==
    candidate.profileRepairReRankEnabled
  ) {
    return "profile-differentiation";
  }
  if (
    baseline.openingExpansionTempoEnabled !==
    candidate.openingExpansionTempoEnabled
  ) {
    return "opening-expansion-tempo";
  }
  if (
    baseline.humanReplayEconomyCadenceEnabled !==
    candidate.humanReplayEconomyCadenceEnabled
  ) {
    return "economy-cadence";
  }
  if (
    baseline.transportTroopBankingEnabled !==
    candidate.transportTroopBankingEnabled
  ) {
    return "transport-banking";
  }
  if (
    baseline.profileDifferentiation.profileCount > 0 ||
    candidate.profileDifferentiation.profileCount > 0
  ) {
    return "profile-differentiation";
  }
  return "opening-expansion-tempo";
}

function tacticMetrics(
  side: AgentLearningComparisonSide,
  tactic: AgentLearningComparisonFocusTactic,
): AgentLearningComparisonSide["transportTroopBanking"] {
  switch (tactic) {
    case "frontier-conversion":
      return side.frontierConversionTiming;
    case "frontier-finish-pressure":
      return side.frontierFinishPressure;
    case "opening-expansion-tempo":
      return side.openingExpansionTempo;
    case "economy-cadence":
      return side.economyCadence;
    case "naval-control":
      return side.navalControl;
    case "late-game-strike-targeting":
      return side.lateGameStrikeTargeting;
    case "personality-diplomacy-pressure":
      return side.personalityDiplomacyPressure;
    case "profile-differentiation": {
      const profileCount = side.profileDifferentiation.profileCount;
      if (
        profileCount < 2 &&
        side.profileRepairRerank.opportunityCount !== null
      ) {
        return {
          recommendedDecisionCount: side.profileRepairRerank.opportunityCount,
          actedOnDecisionCount: side.profileRepairRerank.actedOnCount,
          missedDecisionCount: side.profileRepairRerank.missedCount,
          recommendationActRate: side.profileRepairRerank.actRate,
        };
      }
      const actedOn = side.profileDifferentiation.benchmarkDistinctEnough
        ? profileCount
        : 0;
      return {
        recommendedDecisionCount: profileCount >= 2 ? profileCount : 0,
        actedOnDecisionCount: actedOn,
        missedDecisionCount: Math.max(0, profileCount - actedOn),
        recommendationActRate: side.profileDifferentiation.averageProfileDistance,
      };
    }
    case "transport-banking":
      return side.transportTroopBanking;
  }
}

function tacticRecommendationActRate(
  side: AgentLearningComparisonSide,
  tactic: AgentLearningComparisonFocusTactic,
): number | null {
  return tacticMetrics(side, tactic).recommendationActRate;
}

function focusTacticLabel(tactic: AgentLearningComparisonFocusTactic): string {
  switch (tactic) {
    case "frontier-conversion":
      return "frontier conversion";
    case "frontier-finish-pressure":
      return "frontier finish pressure";
    case "opening-expansion-tempo":
      return "opening expansion tempo";
    case "economy-cadence":
      return "economy cadence";
    case "naval-control":
      return "naval control";
    case "late-game-strike-targeting":
      return "late-game strike targeting";
    case "personality-diplomacy-pressure":
      return "personality diplomacy pressure";
    case "profile-differentiation":
      return "profile differentiation";
    case "transport-banking":
      return "transport banking";
  }
}

function focusMetricLabel(tactic: AgentLearningComparisonFocusTactic): string {
  if (tactic === "profile-differentiation") {
    return "profile action-mix distance";
  }
  return `${focusTacticLabel(tactic)} act rate`;
}

function comparisonFocusMetricLabel(input: {
  candidate: AgentLearningComparisonSide;
  focusTactic: AgentLearningComparisonFocusTactic;
}): string {
  if (
    input.focusTactic === "profile-differentiation" &&
    input.candidate.profileDifferentiation.profileCount < 2 &&
    input.candidate.profileRepairRerank.opportunityCount !== null
  ) {
    return "profile repair re-rank act rate";
  }
  return focusMetricLabel(input.focusTactic);
}

function promotionMilestone(
  tactic: AgentLearningComparisonFocusTactic,
): string {
  switch (tactic) {
    case "economy-cadence":
      return "Promote economy cadence into the wider 10-run Hard-nation gate, then inspect first City/Factory/Port timing in the best replay.";
    case "opening-expansion-tempo":
      return "Promote opening tempo into the wider 10-run Hard-nation gate, then inspect early tile share and first economy timing.";
    case "transport-banking":
      return "Promote transport banking into the wider 10-run Hard-nation gate, then inspect landed transport conversion and naval loop risk.";
    case "frontier-finish-pressure":
      return "Promote frontier finish pressure into the wider 10-run Hard-nation gate, then inspect whether weak-rival eliminations create momentum without survival regression.";
    case "naval-control":
      return "Promote naval control into the wider 10-run Hard-nation gate, then inspect whether boats, warships, and patrol moves create invasion, defense, or trade-lane story beats without transport loops.";
    case "late-game-strike-targeting":
      return "Promote late-game strike targeting into the wider 10-run Hard-nation gate, then inspect whether nukes hit silos, SAMs, cities, factories, ports, or leader concentrations without survival regression.";
    case "personality-diplomacy-pressure":
      return "Promote personality diplomacy pressure into the wider 10-run Hard-nation gate, then inspect whether profiles create distinct pressure, alliance, support, and communication story beats without lowering survival.";
    case "profile-differentiation":
      return "Promote the profile differentiation candidate into a wider multi-profile fixed-seed gate, then inspect whether aggressive, defensive, diplomatic, and opportunistic replays stay distinct without survival or tile-share regression.";
    case "frontier-conversion":
      return "Promote frontier conversion into the wider 10-run Hard-nation gate, then inspect weak-rival finish pressure and front switching.";
  }
}

function reviseMilestone(tactic: AgentLearningComparisonFocusTactic): string {
  switch (tactic) {
    case "economy-cadence":
      return "Inspect missed economy examples and tighten when City, Factory, or Port should outrank repeated expansion before a larger gate.";
    case "opening-expansion-tempo":
      return "Inspect missed opening examples and tighten early expansion stop conditions before a larger gate.";
    case "transport-banking":
      return "Inspect missed banking examples and tighten transport launch triggers before a larger gate.";
    case "frontier-finish-pressure":
      return "Inspect missed finish-pressure examples and tighten decisive weak-rival attack thresholds before a larger gate.";
    case "naval-control":
      return "Inspect missed naval-control examples and tighten when Port, Warship, boat, and patrol actions should outrank land loops before a larger gate.";
    case "late-game-strike-targeting":
      return "Inspect missed strike examples and tighten when high-value nuke targets should outrank growth, pressure, or hold before a larger gate.";
    case "personality-diplomacy-pressure":
      return "Inspect missed personality examples and tighten profile-specific social scoring before a larger gate.";
    case "profile-differentiation":
      return "Inspect profile summaries for collapsed signatures, high hold rates, and neutral-expansion convergence; then tune profile-specific scoring before rerunning the same multi-profile seeds.";
    case "frontier-conversion":
      return "Inspect missed conversion examples and tighten weak-rival attack handoff before a larger gate.";
  }
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }
  return round(numerator / denominator);
}

function average(values: Array<number | undefined>): number | null {
  const finite = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (finite.length === 0) {
    return null;
  }
  return round(sum(finite) / finite.length);
}

function averageNullable(values: number[]): number | null {
  return average(values);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function nullableDelta(
  candidate: number | null,
  baseline: number | null,
): number | null {
  return candidate === null || baseline === null
    ? null
    : round(candidate - baseline);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeMarkdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`),
  ].join("\n");
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function formatNullable(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function formatFlag(value: boolean | null): string {
  if (value === null) {
    return "n/a";
  }
  return value ? "on" : "off";
}

function formatSignedNullable(value: number | null): string {
  return value === null ? "n/a" : signed(value);
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "comparison";
}
