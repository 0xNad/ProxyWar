import fs from "fs/promises";
import path from "path";
import {
  AgentDecisionRecord,
  AgentEconomyCadenceAffordance,
  AgentFrontierConversionTimingAffordance,
  AgentFrontierFinishPressureAffordance,
  AgentLateGameStrikeTargetingAffordance,
  AgentNavalControlAffordance,
  AgentOpeningExpansionTempoAffordance,
  AgentPersonalityDiplomacyPressureAffordance,
  AgentStrategyProfile,
  AgentTransportTroopBankingAffordance,
} from "./AgentTypes";
import {
  buildAgentMatchStory,
  AgentProfileDifferentiationGate,
  AgentProfileDifferentiationVector,
  AgentProfileStorySummary,
} from "./AgentMatchStory";
import { isPersonalityDiplomacyActionKind } from "./AgentPersonalityDiplomacyPolicy";

export interface AgentLearningRunInput {
  runID: string;
  benchmarkRunIndex?: number | null;
  won?: boolean | null;
  survived?: boolean | null;
  tileShare?: number | null;
  turns?: number | null;
  records: AgentDecisionRecord[];
}

export interface AgentLearningReportInput {
  benchmarkID: string;
  generatedAt?: number;
  runs: AgentLearningRunInput[];
}

export interface WriteAgentLearningArtifactsInput extends AgentLearningReportInput {
  directory?: string;
  rootDir?: string;
}

export interface AgentLearningArtifactPaths {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export interface AgentTacticOpportunityExample {
  runID: string;
  benchmarkRunIndex: number | null;
  won: boolean | null;
  turnNumber: number;
  selectedActionKind: string;
  selectedLegalActionId: string;
  actedOn: boolean;
  ownTroops: number | null;
  maxTroops: number | null;
  troopRatio: number | null;
  activeTransportTroops: number;
  largestAvailableBoatLaunchTroops: number;
  effectiveFutureTroopRatio: number | null;
  reason: string;
}

export interface AgentOpeningTempoOpportunityExample {
  runID: string;
  benchmarkRunIndex: number | null;
  won: boolean | null;
  turnNumber: number;
  selectedActionKind: string;
  selectedLegalActionId: string;
  actedOn: boolean;
  ownTileShare: number | null;
  expectedTileShare: number | null;
  leaderTileShareGap: number | null;
  neutralLandExpansionActionCount: number;
  neutralBoatExpansionActionCount: number;
  homeDanger: string;
  reason: string;
}

export interface AgentFrontierConversionOpportunityExample {
  runID: string;
  benchmarkRunIndex: number | null;
  won: boolean | null;
  turnNumber: number;
  selectedActionKind: string;
  selectedLegalActionId: string;
  actedOn: boolean;
  ownTileShare: number | null;
  recentExpansionCount: number;
  neutralExpansionActionCount: number;
  favorableHostileAttackActionCount: number;
  executorReadyHostileAttackActionCount: number;
  bestTargetName: string | null;
  bestTargetRelativeTroopRatio: number | null;
  bestExecutorReadyTargetName: string | null;
  bestExecutorReadyRelativeTroopRatio: number | null;
  homeDanger: string;
  reason: string;
}

export interface AgentFrontierFinishPressureOpportunityExample {
  runID: string;
  benchmarkRunIndex: number | null;
  won: boolean | null;
  turnNumber: number;
  selectedActionKind: string;
  selectedLegalActionId: string;
  actedOn: boolean;
  activeTargetName: string | null;
  recentTargetAttackCount: number;
  recentLowCommitmentAttackCount: number;
  repeatedLowCommitmentProbe: boolean;
  finishingAttackActionCount: number;
  decisiveAttackActionCount: number;
  bestTargetName: string | null;
  bestTargetRelativeTroopRatio: number | null;
  bestTargetTileShare: number | null;
  bestAttackTroopPercent: number | null;
  homeDanger: string;
  reason: string;
}

export interface AgentEconomyCadenceOpportunityExample {
  runID: string;
  benchmarkRunIndex: number | null;
  won: boolean | null;
  turnNumber: number;
  selectedActionKind: string;
  selectedLegalActionId: string;
  actedOn: boolean;
  ownTileShare: number | null;
  recentExpansionCount: number;
  recentBuildCount: number;
  cityCount: number;
  factoryCount: number;
  portCount: number;
  safeEconomyBuildActionCount: number;
  bestBuildID: string | null;
  bestBuildUnit: string | null;
  homeDanger: string;
  reason: string;
}

export interface AgentNavalControlOpportunityExample {
  runID: string;
  benchmarkRunIndex: number | null;
  won: boolean | null;
  turnNumber: number;
  selectedActionKind: string;
  selectedLegalActionId: string;
  actedOn: boolean;
  portCount: number;
  warshipCount: number;
  activeTransportCount: number;
  boatLaunchActionCount: number;
  navalInvasionActionCount: number;
  warshipBuildActionCount: number;
  warshipMoveActionCount: number;
  bestNavalActionID: string | null;
  bestNavalActionKind: string | null;
  homeDanger: string;
  reason: string;
}

export interface AgentLateGameStrikeTargetingOpportunityExample {
  runID: string;
  benchmarkRunIndex: number | null;
  won: boolean | null;
  turnNumber: number;
  selectedActionKind: string;
  selectedLegalActionId: string;
  actedOn: boolean;
  legalStrikeActionCount: number;
  highValueStrikeActionCount: number;
  siloTargetActionCount: number;
  samTargetActionCount: number;
  economyTargetActionCount: number;
  coveredNonSamTargetActionCount: number;
  bestStrikeActionID: string | null;
  bestStrikeWeapon: string | null;
  bestStrikeTargetName: string | null;
  bestStrikeTargetStructureUnit: string | null;
  bestStrikeScore: number | null;
  homeDanger: string;
  reason: string;
}

export interface AgentPersonalityDiplomacyPressureOpportunityExample {
  runID: string;
  benchmarkRunIndex: number | null;
  won: boolean | null;
  turnNumber: number;
  selectedActionKind: string;
  selectedLegalActionId: string;
  actedOn: boolean;
  profile: string;
  recentSocialActionCount: number;
  socialActionCount: number;
  pressureActionCount: number;
  allianceActionCount: number;
  supportActionCount: number;
  communicationActionCount: number;
  bestSocialActionID: string | null;
  bestSocialActionKind: string | null;
  bestSocialTargetName: string | null;
  bestSocialScore: number | null;
  personalityMode: string | null;
  homeDanger: string;
  reason: string;
}

export type AgentProfileRepairIssueType =
  | "collapsed_signature"
  | "stall_risk"
  | "neutral_expansion_convergence"
  | "missing_profile_expression";

export interface AgentProfileRepairExample {
  runID: string;
  benchmarkRunIndex: number | null;
  won: boolean | null;
  profile: AgentStrategyProfile;
  issueType: AgentProfileRepairIssueType;
  signatureLabel: string;
  signatureScore: number;
  signatureMatched: boolean;
  postSpawnDecisionCount: number;
  holdRate: number;
  expansionRate: number;
  combatRate: number;
  economyBuildRate: number;
  socialActionRate: number;
  navalRate: number;
  strikeRate: number;
  topActionKinds: string[];
  summary: string;
  suggestedRepair: string;
}

export interface AgentProfileRepairRerankExample {
  runID: string;
  benchmarkRunIndex: number | null;
  won: boolean | null;
  turnNumber: number;
  profile: AgentStrategyProfile;
  family: AgentProfileRepairRerankFamily;
  selectedActionKind: string;
  selectedLegalActionId: string;
  suggestedActionID: string | null;
  suggestedActionKind: string | null;
  suggestedModule: string | null;
  actedOn: boolean;
  candidates: string;
  reason: string | null;
}

export type AgentProfileRepairRerankFamily =
  | "weak_hostile_attack"
  | "economy_build"
  | "defense_build"
  | "naval"
  | "diplomacy"
  | "communication"
  | "pressure_signal"
  | "late_game_strike"
  | "other";

export interface AgentProfileRepairRerankFamilySummary {
  family: AgentProfileRepairRerankFamily;
  opportunityCount: number;
  actedOnCount: number;
  missedCount: number;
  actRate: number | null;
  profiles: AgentStrategyProfile[];
  topSuggestedActionIDs: string[];
  topSelectedActionIDs: string[];
}

export interface AgentProfileRepairProfileSummary {
  profile: AgentStrategyProfile;
  runCount: number;
  averageSignatureScore: number | null;
  signatureMatchedRate: number | null;
  averageHoldRate: number | null;
  averageExpansionRate: number | null;
  averageCombatRate: number | null;
  averageEconomyBuildRate: number | null;
  averageSocialActionRate: number | null;
  averageNavalRate: number | null;
  averageStrikeRate: number | null;
  topIssues: AgentProfileRepairIssueType[];
  vector: AgentProfileDifferentiationVector;
}

export interface AgentProfileRepairReport {
  runCount: number;
  runWithProfileDataCount: number;
  profileCount: number;
  evaluatedProfileCount: number;
  benchmarkDistinctEnough: boolean;
  averageProfileDistance: number | null;
  signatureMatchedRate: number | null;
  mediumOrHighStallRiskRunCount: number;
  stallRiskRunRate: number | null;
  neutralExpansionConvergenceRunCount: number;
  collapsedSignatureCount: number;
  missingProfileExpressionCount: number;
  rerankOpportunityCount: number;
  rerankActedOnCount: number;
  rerankMissedCount: number;
  rerankActRate: number | null;
  rerankExamples: AgentProfileRepairRerankExample[];
  rerankFamilySummaries: AgentProfileRepairRerankFamilySummary[];
  examples: AgentProfileRepairExample[];
  profileSummaries: AgentProfileRepairProfileSummary[];
  hypotheses: string[];
  nextExperiments: string[];
}

export interface AgentLearningReport {
  schemaVersion: 1;
  benchmarkID: string;
  generatedAt: string;
  runCount: number;
  winCount: number;
  tactics: {
    frontierConversionTiming: {
      tacticID: "frontier_conversion_timing";
      observedDecisionCount: number;
      strategicWindowDecisionCount: number;
      executorReadyDecisionCount: number;
      recommendedDecisionCount: number;
      actedOnDecisionCount: number;
      missedDecisionCount: number;
      recommendationActRate: number | null;
      averageRecommendedOwnTileShare: number | null;
      averageRecommendedBestTroopRatio: number | null;
      averageRecommendedExecutorReadyTroopRatio: number | null;
      examples: AgentFrontierConversionOpportunityExample[];
      hypotheses: string[];
      nextExperiments: string[];
    };
    frontierFinishPressure: {
      tacticID: "frontier_finish_pressure";
      observedDecisionCount: number;
      repeatedProbeDecisionCount: number;
      recommendedDecisionCount: number;
      actedOnDecisionCount: number;
      missedDecisionCount: number;
      recommendationActRate: number | null;
      averageRecommendedBestTroopRatio: number | null;
      averageRecommendedBestTargetTileShare: number | null;
      averageRecommendedBestAttackTroopPercent: number | null;
      examples: AgentFrontierFinishPressureOpportunityExample[];
      hypotheses: string[];
      nextExperiments: string[];
    };
    openingExpansionTempo: {
      tacticID: "opening_expansion_tempo";
      observedDecisionCount: number;
      openingWindowDecisionCount: number;
      recommendedDecisionCount: number;
      actedOnDecisionCount: number;
      missedDecisionCount: number;
      recommendationActRate: number | null;
      averageRecommendedOwnTileShare: number | null;
      averageRecommendedLeaderGap: number | null;
      examples: AgentOpeningTempoOpportunityExample[];
      hypotheses: string[];
      nextExperiments: string[];
    };
    economyCadence: {
      tacticID: "economy_cadence";
      observedDecisionCount: number;
      recommendedDecisionCount: number;
      actedOnDecisionCount: number;
      missedDecisionCount: number;
      recommendationActRate: number | null;
      averageRecommendedOwnTileShare: number | null;
      averageRecommendedRecentExpansionCount: number | null;
      averageRecommendedSafeBuildActions: number | null;
      examples: AgentEconomyCadenceOpportunityExample[];
      hypotheses: string[];
      nextExperiments: string[];
    };
    navalControl?: {
      tacticID: "naval_control";
      observedDecisionCount: number;
      recommendedDecisionCount: number;
      actedOnDecisionCount: number;
      missedDecisionCount: number;
      recommendationActRate: number | null;
      averageRecommendedActiveTransportCount: number | null;
      averageRecommendedSafeNavalActions: number | null;
      examples: AgentNavalControlOpportunityExample[];
      hypotheses: string[];
      nextExperiments: string[];
    };
    lateGameStrikeTargeting?: {
      tacticID: "late_game_strike_targeting";
      observedDecisionCount: number;
      recommendedDecisionCount: number;
      actedOnDecisionCount: number;
      missedDecisionCount: number;
      recommendationActRate: number | null;
      averageRecommendedBestStrikeScore: number | null;
      averageRecommendedHighValueStrikes: number | null;
      examples: AgentLateGameStrikeTargetingOpportunityExample[];
      hypotheses: string[];
      nextExperiments: string[];
    };
    personalityDiplomacyPressure?: {
      tacticID: "personality_diplomacy_pressure";
      observedDecisionCount: number;
      recommendedDecisionCount: number;
      actedOnDecisionCount: number;
      missedDecisionCount: number;
      recommendationActRate: number | null;
      averageRecommendedSocialActions: number | null;
      averageRecommendedBestSocialScore: number | null;
      examples: AgentPersonalityDiplomacyPressureOpportunityExample[];
      hypotheses: string[];
      nextExperiments: string[];
    };
    transportTroopBanking: {
      tacticID: "transport_troop_banking";
      observedDecisionCount: number;
      nearCapDecisionCount: number;
      recommendedDecisionCount: number;
      actedOnDecisionCount: number;
      missedDecisionCount: number;
      activeBankDecisionCount: number;
      recommendationActRate: number | null;
      winActRate: number | null;
      lossActRate: number | null;
      maxEffectiveFutureTroopRatio: number | null;
      examples: AgentTacticOpportunityExample[];
      hypotheses: string[];
      nextExperiments: string[];
    };
  };
  profileRepair?: AgentProfileRepairReport;
  llmReviewPacket: {
    role: "post_match_tactic_researcher";
    constraints: string[];
    focusTactics: string[];
    requestedOutput: string[];
  };
}

interface TransportTroopBankingRecordEntry {
  run: AgentLearningRunInput;
  record: AgentDecisionRecord;
  affordance: AgentTransportTroopBankingAffordance;
}

interface TransportTroopBankingOpportunity {
  run: AgentLearningRunInput;
  records: AgentDecisionRecord[];
  affordances: AgentTransportTroopBankingAffordance[];
  representative: AgentDecisionRecord;
  nearCap: boolean;
  recommended: boolean;
  actedOn: boolean;
  activeBank: boolean;
  maxEffectiveFutureTroopRatio: number | null;
}

interface OpeningTempoRecordEntry {
  run: AgentLearningRunInput;
  record: AgentDecisionRecord;
  affordance: AgentOpeningExpansionTempoAffordance;
}

interface OpeningTempoOpportunity {
  run: AgentLearningRunInput;
  records: AgentDecisionRecord[];
  affordances: AgentOpeningExpansionTempoAffordance[];
  representative: AgentDecisionRecord;
  openingWindow: boolean;
  recommended: boolean;
  actedOn: boolean;
  ownTileShare: number | null;
  leaderTileShareGap: number | null;
}

interface FrontierConversionRecordEntry {
  run: AgentLearningRunInput;
  record: AgentDecisionRecord;
  affordance: AgentFrontierConversionTimingAffordance;
}

interface FrontierConversionOpportunity {
  run: AgentLearningRunInput;
  records: AgentDecisionRecord[];
  affordances: AgentFrontierConversionTimingAffordance[];
  representative: AgentDecisionRecord;
  strategicWindow: boolean;
  executorReady: boolean;
  recommended: boolean;
  actedOn: boolean;
  ownTileShare: number | null;
  bestTargetRelativeTroopRatio: number | null;
  bestExecutorReadyRelativeTroopRatio: number | null;
}

interface FrontierFinishPressureRecordEntry {
  run: AgentLearningRunInput;
  record: AgentDecisionRecord;
  affordance: AgentFrontierFinishPressureAffordance;
}

interface FrontierFinishPressureOpportunity {
  run: AgentLearningRunInput;
  records: AgentDecisionRecord[];
  affordances: AgentFrontierFinishPressureAffordance[];
  representative: AgentDecisionRecord;
  repeatedLowCommitmentProbe: boolean;
  recommended: boolean;
  actedOn: boolean;
  bestTargetRelativeTroopRatio: number | null;
  bestTargetTileShare: number | null;
  bestAttackTroopPercent: number | null;
}

interface EconomyCadenceRecordEntry {
  run: AgentLearningRunInput;
  record: AgentDecisionRecord;
  affordance: AgentEconomyCadenceAffordance;
}

interface EconomyCadenceOpportunity {
  run: AgentLearningRunInput;
  records: AgentDecisionRecord[];
  affordances: AgentEconomyCadenceAffordance[];
  representative: AgentDecisionRecord;
  recommended: boolean;
  actedOn: boolean;
  ownTileShare: number | null;
  recentExpansionCount: number | null;
  safeEconomyBuildActionCount: number | null;
}

interface NavalControlRecordEntry {
  run: AgentLearningRunInput;
  record: AgentDecisionRecord;
  affordance: AgentNavalControlAffordance;
}

interface NavalControlOpportunity {
  run: AgentLearningRunInput;
  records: AgentDecisionRecord[];
  affordances: AgentNavalControlAffordance[];
  representative: AgentDecisionRecord;
  recommended: boolean;
  actedOn: boolean;
  activeTransportCount: number | null;
  safeNavalActionCount: number | null;
}

interface LateGameStrikeTargetingRecordEntry {
  run: AgentLearningRunInput;
  record: AgentDecisionRecord;
  affordance: AgentLateGameStrikeTargetingAffordance;
}

interface LateGameStrikeTargetingOpportunity {
  run: AgentLearningRunInput;
  records: AgentDecisionRecord[];
  affordances: AgentLateGameStrikeTargetingAffordance[];
  representative: AgentDecisionRecord;
  recommended: boolean;
  actedOn: boolean;
  bestStrikeScore: number | null;
  highValueStrikeActionCount: number | null;
}

interface PersonalityDiplomacyPressureRecordEntry {
  run: AgentLearningRunInput;
  record: AgentDecisionRecord;
  affordance: AgentPersonalityDiplomacyPressureAffordance;
}

interface PersonalityDiplomacyPressureOpportunity {
  run: AgentLearningRunInput;
  records: AgentDecisionRecord[];
  affordances: AgentPersonalityDiplomacyPressureAffordance[];
  representative: AgentDecisionRecord;
  recommended: boolean;
  actedOn: boolean;
  socialActionCount: number | null;
  bestSocialScore: number | null;
}

export function buildAgentLearningReport(
  input: AgentLearningReportInput,
): AgentLearningReport {
  const frontierConversionTiming = frontierConversionTimingReport(input.runs);
  const frontierFinishPressure = frontierFinishPressureReport(input.runs);
  const openingExpansionTempo = openingExpansionTempoReport(input.runs);
  const economyCadence = economyCadenceReport(input.runs);
  const navalControl = navalControlReport(input.runs);
  const lateGameStrikeTargeting = lateGameStrikeTargetingReport(input.runs);
  const personalityDiplomacyPressure =
    personalityDiplomacyPressureReport(input.runs);
  const transportTroopBanking = transportTroopBankingReport(input.runs);
  const profileRepair = profileRepairReport(input);
  return {
    schemaVersion: 1,
    benchmarkID: input.benchmarkID,
    generatedAt: new Date(input.generatedAt ?? Date.now()).toISOString(),
    runCount: input.runs.length,
    winCount: input.runs.filter((run) => run.won === true).length,
    tactics: {
      frontierConversionTiming,
      frontierFinishPressure,
      openingExpansionTempo,
      economyCadence,
      navalControl,
      lateGameStrikeTargeting,
      personalityDiplomacyPressure,
      transportTroopBanking,
    },
    profileRepair,
    llmReviewPacket: {
      role: "post_match_tactic_researcher",
      constraints: [
        "Analyze benchmark artifacts only; do not invent raw game intents.",
        "Any proposed in-match behavior must still choose one existing LegalAction.id through AgentDecisionValidator.",
        "Keep implementation suggestions under src/server/agents, src/scripts, tests, docs, or artifacts.",
      ],
      focusTactics: [
        "frontier_conversion_timing",
        "frontier_finish_pressure",
        "opening_expansion_tempo",
        "economy_cadence",
        "naval_control",
        "late_game_strike_targeting",
        "personality_diplomacy_pressure",
        "profile_repair_mining",
        "profile_repair_rerank",
        "transport_troop_banking",
      ],
      requestedOutput: [
        "Find where the agent had a favorable rival-conversion window but kept expanding, building, holding, or using pressure-only actions.",
        "Find where the agent had repeated low-commitment probes against a weak bordered rival but failed to finish the target.",
        "Find where the agent had early legal expansion but spent the turn elsewhere.",
        "Find where the agent had safe City, Factory, or Port timing after stable expansion but kept expanding, pressuring, or holding.",
        "Find where the agent had transport, warship, or patrol options but stalled in land loops or held.",
        "Find where the agent had legal high-value nuke targets but held, expanded, or picked lower-impact actions.",
        "Find where the agent had profile-specific social pressure, alliance, support, or communication available but looked personality-flat or stayed in a bland loop.",
        "Find where aggressive, defensive, diplomatic, and opportunistic profiles collapse into the same action mix or neutral-expansion loop.",
        "Find where profile repair re-rank suggested an existing LegalAction.id but the agent still selected hold, repeated neutral expansion, or a lower-expression action.",
        "Find where the agent saw a tactic opportunity but failed to exploit it.",
        "Propose one small executor or planner change and one A/B benchmark to validate it.",
        "Name any missing observation fields that block better judgment.",
      ],
    },
  };
}

export async function writeAgentLearningArtifacts(
  input: WriteAgentLearningArtifactsInput,
): Promise<AgentLearningArtifactPaths> {
  const directory =
    input.directory ??
    path.join(
      input.rootDir ?? path.join(process.cwd(), "artifacts", "ai-learning"),
      safePathSegment(input.benchmarkID),
    );
  await fs.mkdir(directory, { recursive: true });
  const report = buildAgentLearningReport(input);
  const jsonPath = path.join(directory, "learning-report.json");
  const markdownPath = path.join(directory, "learning-report.md");
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(markdownPath, learningReportMarkdown(report)),
  ]);
  return { directory, jsonPath, markdownPath };
}

function frontierConversionTimingReport(
  runs: AgentLearningRunInput[],
): AgentLearningReport["tactics"]["frontierConversionTiming"] {
  const observed = frontierConversionOpportunities(runs);
  const strategicWindow = observed.filter(
    (opportunity) => opportunity.strategicWindow,
  );
  const executorReady = observed.filter(
    (opportunity) => opportunity.executorReady,
  );
  const recommended = observed.filter((opportunity) => opportunity.recommended);
  const actedOn = recommended.filter((opportunity) => opportunity.actedOn);
  const missed = recommended.filter((opportunity) => !opportunity.actedOn);
  return {
    tacticID: "frontier_conversion_timing",
    observedDecisionCount: observed.length,
    strategicWindowDecisionCount: strategicWindow.length,
    executorReadyDecisionCount: executorReady.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    recommendationActRate: rate(actedOn.length, recommended.length),
    averageRecommendedOwnTileShare: averageRounded(
      recommended.map((opportunity) => opportunity.ownTileShare),
    ),
    averageRecommendedBestTroopRatio: averageRounded(
      recommended.map(
        (opportunity) => opportunity.bestTargetRelativeTroopRatio,
      ),
    ),
    averageRecommendedExecutorReadyTroopRatio: averageRounded(
      recommended.map(
        (opportunity) => opportunity.bestExecutorReadyRelativeTroopRatio,
      ),
    ),
    examples: recommended
      .sort(
        (a, b) =>
          Number(a.actedOn) - Number(b.actedOn) ||
          a.representative.turnNumber - b.representative.turnNumber,
      )
      .slice(0, 16)
      .map(frontierConversionExample),
    hypotheses: frontierConversionTimingHypotheses({
      observedCount: observed.length,
      strategicWindowCount: strategicWindow.length,
      executorReadyCount: executorReady.length,
      recommendedCount: recommended.length,
      actedOnCount: actedOn.length,
      missedCount: missed.length,
    }),
    nextExperiments: frontierConversionTimingExperiments({
      recommendedCount: recommended.length,
      missedCount: missed.length,
      actedOnCount: actedOn.length,
    }),
  };
}

function frontierConversionOpportunities(
  runs: AgentLearningRunInput[],
): FrontierConversionOpportunity[] {
  const groups = new Map<string, FrontierConversionRecordEntry[]>();
  for (const run of runs) {
    for (const record of run.records) {
      const affordance = record.tacticalAffordances?.frontierConversionTiming;
      if (affordance === undefined) {
        continue;
      }
      const key = [
        run.runID,
        run.benchmarkRunIndex ?? "unknown",
        record.agentID,
        record.turnNumber,
      ].join(":");
      const group = groups.get(key) ?? [];
      group.push({ run, record, affordance });
      groups.set(key, group);
    }
  }

  return Array.from(groups.values()).map((entries) => {
    const records = entries.map((entry) => entry.record);
    const affordances = entries.map((entry) => entry.affordance);
    const representative =
      records.find(isFrontierConversionAction) ??
      records.find(
        (record) =>
          record.tacticalAffordances?.frontierConversionTiming?.recommended ===
          true,
      ) ??
      records[0];
    return {
      run: entries[0].run,
      records,
      affordances,
      representative,
      strategicWindow: affordances.some(
        (affordance) => affordance.strategicWindow,
      ),
      executorReady: affordances.some((affordance) => affordance.executorReady),
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: records.some(isFrontierConversionAction),
      ownTileShare: averageRounded(
        affordances.map((affordance) => affordance.ownTileShare),
      ),
      bestTargetRelativeTroopRatio: maxRounded(
        affordances.map(
          (affordance) => affordance.bestTargetRelativeTroopRatio,
        ),
      ),
      bestExecutorReadyRelativeTroopRatio: maxRounded(
        affordances.map(
          (affordance) => affordance.bestExecutorReadyRelativeTroopRatio,
        ),
      ),
    };
  });
}

function frontierConversionExample(
  opportunity: FrontierConversionOpportunity,
): AgentFrontierConversionOpportunityExample {
  const record = opportunity.representative;
  const affordance =
    record.tacticalAffordances?.frontierConversionTiming ??
    opportunity.affordances[0];
  return {
    runID: opportunity.run.runID,
    benchmarkRunIndex: opportunity.run.benchmarkRunIndex ?? null,
    won: opportunity.run.won ?? null,
    turnNumber: record.turnNumber,
    selectedActionKind: record.chosenActionKind,
    selectedLegalActionId: record.chosenActionID,
    actedOn: opportunity.actedOn,
    ownTileShare: affordance?.ownTileShare ?? null,
    recentExpansionCount: affordance?.recentExpansionCount ?? 0,
    neutralExpansionActionCount: affordance?.neutralExpansionActionCount ?? 0,
    favorableHostileAttackActionCount:
      affordance?.favorableHostileAttackActionCount ?? 0,
    executorReadyHostileAttackActionCount:
      affordance?.executorReadyHostileAttackActionCount ?? 0,
    bestTargetName: affordance?.bestTargetName ?? null,
    bestTargetRelativeTroopRatio:
      affordance?.bestTargetRelativeTroopRatio ?? null,
    bestExecutorReadyTargetName:
      affordance?.bestExecutorReadyTargetName ?? null,
    bestExecutorReadyRelativeTroopRatio:
      affordance?.bestExecutorReadyRelativeTroopRatio ?? null,
    homeDanger: affordance?.homeDanger ?? "unknown",
    reason: record.reason,
  };
}

function isFrontierConversionAction(record: AgentDecisionRecord): boolean {
  return (
    record.chosenActionKind === "attack" &&
    record.chosenActionMetadata?.expansion !== true
  );
}

function frontierConversionTimingHypotheses(input: {
  observedCount: number;
  strategicWindowCount: number;
  executorReadyCount: number;
  recommendedCount: number;
  actedOnCount: number;
  missedCount: number;
}): string[] {
  const hypotheses: string[] = [];
  if (input.observedCount === 0) {
    hypotheses.push(
      "No frontier-conversion affordance data was present. Run a fresh benchmark after enabling frontierConversionTiming in tacticalAffordances.",
    );
  }
  if (input.recommendedCount === 0) {
    hypotheses.push(
      "The benchmark did not expose executor-ready rival conversion windows, or the ready threshold is too strict.",
    );
  }
  if (input.strategicWindowCount > 0 && input.executorReadyCount === 0) {
    hypotheses.push(
      "Strategic conversion targets appeared, but none passed the executor-ready reserve, target-size, and troop-percent thresholds.",
    );
  }
  if (input.missedCount > 0) {
    hypotheses.push(
      "The executor can see favorable rival-conversion windows but another action type is outranking direct hostile attack.",
    );
  }
  if (input.actedOnCount > 0 && input.missedCount > 0) {
    hypotheses.push(
      "Conversion timing likely needs clearer handoff rules from neutral expansion to weak-rival attacks.",
    );
  }
  if (hypotheses.length === 0) {
    hypotheses.push(
      "Frontier conversion opportunities are currently being acted on in this benchmark slice.",
    );
  }
  return hypotheses;
}

function frontierConversionTimingExperiments(input: {
  recommendedCount: number;
  missedCount: number;
  actedOnCount: number;
}): string[] {
  if (input.recommendedCount === 0) {
    return [
      "Run a short Hard-nation benchmark and confirm frontierConversionTiming recommendedDecisionCount becomes non-zero.",
      "Compare threshold candidates against built-in nation traces: tile-share handoff, recent expansion streak, and relative troop edge.",
    ];
  }
  if (input.missedCount > 0) {
    return [
      "A/B test a conversion-timing planner objective that prefers weak-rival attack when enoughLandBase and favorableHostileAttackActionCount are positive.",
      "Reject the change if survival or average tile share drops, or if repeated war-front switching increases.",
    ];
  }
  return [
    "Keep conversion timing as an observed capability and inspect whether acted-on conversions become finished eliminations.",
  ];
}

function frontierFinishPressureReport(
  runs: AgentLearningRunInput[],
): AgentLearningReport["tactics"]["frontierFinishPressure"] {
  const observed = frontierFinishPressureOpportunities(runs);
  const repeatedProbe = observed.filter(
    (opportunity) => opportunity.repeatedLowCommitmentProbe,
  );
  const recommended = observed.filter((opportunity) => opportunity.recommended);
  const actedOn = recommended.filter((opportunity) => opportunity.actedOn);
  const missed = recommended.filter((opportunity) => !opportunity.actedOn);
  return {
    tacticID: "frontier_finish_pressure",
    observedDecisionCount: observed.length,
    repeatedProbeDecisionCount: repeatedProbe.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    recommendationActRate: rate(actedOn.length, recommended.length),
    averageRecommendedBestTroopRatio: averageRounded(
      recommended.map(
        (opportunity) => opportunity.bestTargetRelativeTroopRatio,
      ),
    ),
    averageRecommendedBestTargetTileShare: averageRounded(
      recommended.map((opportunity) => opportunity.bestTargetTileShare),
    ),
    averageRecommendedBestAttackTroopPercent: averageRounded(
      recommended.map((opportunity) => opportunity.bestAttackTroopPercent),
    ),
    examples: recommended
      .sort(
        (a, b) =>
          Number(a.actedOn) - Number(b.actedOn) ||
          a.representative.turnNumber - b.representative.turnNumber,
      )
      .slice(0, 16)
      .map(frontierFinishPressureExample),
    hypotheses: frontierFinishPressureHypotheses({
      observedCount: observed.length,
      repeatedProbeCount: repeatedProbe.length,
      recommendedCount: recommended.length,
      actedOnCount: actedOn.length,
      missedCount: missed.length,
    }),
    nextExperiments: frontierFinishPressureExperiments({
      recommendedCount: recommended.length,
      missedCount: missed.length,
      actedOnCount: actedOn.length,
    }),
  };
}

function frontierFinishPressureOpportunities(
  runs: AgentLearningRunInput[],
): FrontierFinishPressureOpportunity[] {
  const groups = new Map<string, FrontierFinishPressureRecordEntry[]>();
  for (const run of runs) {
    for (const record of run.records) {
      const affordance = record.tacticalAffordances?.frontierFinishPressure;
      if (affordance === undefined) {
        continue;
      }
      const key = [
        run.runID,
        run.benchmarkRunIndex ?? "unknown",
        record.agentID,
        record.turnNumber,
      ].join(":");
      const group = groups.get(key) ?? [];
      group.push({ run, record, affordance });
      groups.set(key, group);
    }
  }

  return Array.from(groups.values()).map((entries) => {
    const records = entries.map((entry) => entry.record);
    const affordances = entries.map((entry) => entry.affordance);
    const representative =
      records.find((record) =>
        isFrontierFinishPressureAction(record, affordances),
      ) ??
      records.find(
        (record) =>
          record.tacticalAffordances?.frontierFinishPressure?.recommended ===
          true,
      ) ??
      records[0];
    return {
      run: entries[0].run,
      records,
      affordances,
      representative,
      repeatedLowCommitmentProbe: affordances.some(
        (affordance) => affordance.repeatedLowCommitmentProbe,
      ),
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: records.some((record) =>
        isFrontierFinishPressureAction(record, affordances),
      ),
      bestTargetRelativeTroopRatio: maxRounded(
        affordances.map(
          (affordance) => affordance.bestTargetRelativeTroopRatio,
        ),
      ),
      bestTargetTileShare: averageRounded(
        affordances.map((affordance) => affordance.bestTargetTileShare),
      ),
      bestAttackTroopPercent: averageRounded(
        affordances.map((affordance) => affordance.bestAttackTroopPercent),
      ),
    };
  });
}

function frontierFinishPressureExample(
  opportunity: FrontierFinishPressureOpportunity,
): AgentFrontierFinishPressureOpportunityExample {
  const record = opportunity.representative;
  const affordance =
    record.tacticalAffordances?.frontierFinishPressure ??
    opportunity.affordances[0];
  return {
    runID: opportunity.run.runID,
    benchmarkRunIndex: opportunity.run.benchmarkRunIndex ?? null,
    won: opportunity.run.won ?? null,
    turnNumber: record.turnNumber,
    selectedActionKind: record.chosenActionKind,
    selectedLegalActionId: record.chosenActionID,
    actedOn: opportunity.actedOn,
    activeTargetName: affordance?.activeTargetName ?? null,
    recentTargetAttackCount: affordance?.recentTargetAttackCount ?? 0,
    recentLowCommitmentAttackCount:
      affordance?.recentLowCommitmentAttackCount ?? 0,
    repeatedLowCommitmentProbe: affordance?.repeatedLowCommitmentProbe ?? false,
    finishingAttackActionCount: affordance?.finishingAttackActionCount ?? 0,
    decisiveAttackActionCount: affordance?.decisiveAttackActionCount ?? 0,
    bestTargetName: affordance?.bestTargetName ?? null,
    bestTargetRelativeTroopRatio:
      affordance?.bestTargetRelativeTroopRatio ?? null,
    bestTargetTileShare: affordance?.bestTargetTileShare ?? null,
    bestAttackTroopPercent: affordance?.bestAttackTroopPercent ?? null,
    homeDanger: affordance?.homeDanger ?? "unknown",
    reason: record.reason,
  };
}

function isFrontierFinishPressureAction(
  record: AgentDecisionRecord,
  affordances: AgentFrontierFinishPressureAffordance[],
): boolean {
  if (
    record.chosenActionKind !== "attack" ||
    record.chosenActionMetadata?.expansion === true
  ) {
    return false;
  }
  const targetID = actionTargetID(record);
  return affordances.some(
    (affordance) =>
      affordance.recommended &&
      affordance.bestTargetID !== null &&
      targetID === affordance.bestTargetID,
  );
}

function actionTargetID(record: AgentDecisionRecord): string | null {
  const metadataTarget = stringOrNull(record.chosenActionMetadata?.targetID);
  if (metadataTarget !== null) {
    return metadataTarget;
  }
  const match = record.chosenActionID.match(/^attack:([^:]+):/);
  return match?.[1] ?? null;
}

function frontierFinishPressureHypotheses(input: {
  observedCount: number;
  repeatedProbeCount: number;
  recommendedCount: number;
  actedOnCount: number;
  missedCount: number;
}): string[] {
  const hypotheses: string[] = [];
  if (input.observedCount === 0) {
    hypotheses.push(
      "No frontier-finish affordance data was present. Run a fresh benchmark after enabling frontierFinishPressure in tacticalAffordances.",
    );
  }
  if (input.recommendedCount === 0) {
    hypotheses.push(
      "The benchmark did not expose repeated low-commitment probes with a decisive weak-rival attack available.",
    );
  }
  if (input.repeatedProbeCount > 0 && input.recommendedCount === 0) {
    hypotheses.push(
      "Repeated probes appeared, but no target passed the decisive finish pressure thresholds.",
    );
  }
  if (input.missedCount > 0) {
    hypotheses.push(
      "The executor can see finish-pressure windows but neutral growth, economy, diplomacy, or hold choices are outranking the finishing attack.",
    );
  }
  if (input.actedOnCount > 0 && input.missedCount > 0) {
    hypotheses.push(
      "Finish pressure needs clearer stop conditions so it escalates repeated probes without starting unsafe wars.",
    );
  }
  if (hypotheses.length === 0) {
    hypotheses.push(
      "Frontier finish-pressure opportunities are currently being acted on in this benchmark slice.",
    );
  }
  return hypotheses;
}

function frontierFinishPressureExperiments(input: {
  recommendedCount: number;
  missedCount: number;
  actedOnCount: number;
}): string[] {
  if (input.recommendedCount === 0) {
    return [
      "Run a targeted benchmark with repeated 10% attacks against a weak bordered rival and confirm frontierFinishPressure recommendedDecisionCount becomes non-zero.",
      "Compare the decisive threshold against human replay finish windows before loosening attack commitment.",
    ];
  }
  if (input.missedCount > 0) {
    return [
      "A/B test a finish-pressure executor bias that prefers the best safe hostile attack LegalAction.id after repeated low-commitment probes.",
      "Reject the change if survival, average tile share, or economy cadence act rate drops.",
    ];
  }
  return [
    "Keep finish pressure as an observed capability and inspect whether acted-on finish attacks create eliminations or momentum swings.",
  ];
}

function openingExpansionTempoReport(
  runs: AgentLearningRunInput[],
): AgentLearningReport["tactics"]["openingExpansionTempo"] {
  const observed = openingTempoOpportunities(runs);
  const openingWindow = observed.filter(
    (opportunity) => opportunity.openingWindow,
  );
  const recommended = observed.filter((opportunity) => opportunity.recommended);
  const actedOn = recommended.filter((opportunity) => opportunity.actedOn);
  const missed = recommended.filter((opportunity) => !opportunity.actedOn);
  return {
    tacticID: "opening_expansion_tempo",
    observedDecisionCount: observed.length,
    openingWindowDecisionCount: openingWindow.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    recommendationActRate: rate(actedOn.length, recommended.length),
    averageRecommendedOwnTileShare: averageRounded(
      recommended.map((opportunity) => opportunity.ownTileShare),
    ),
    averageRecommendedLeaderGap: averageRounded(
      recommended.map((opportunity) => opportunity.leaderTileShareGap),
    ),
    examples: recommended
      .sort(
        (a, b) =>
          Number(a.actedOn) - Number(b.actedOn) ||
          a.representative.turnNumber - b.representative.turnNumber,
      )
      .slice(0, 16)
      .map(openingTempoExample),
    hypotheses: openingExpansionTempoHypotheses({
      observedCount: observed.length,
      recommendedCount: recommended.length,
      actedOnCount: actedOn.length,
      missedCount: missed.length,
    }),
    nextExperiments: openingExpansionTempoExperiments({
      recommendedCount: recommended.length,
      missedCount: missed.length,
      actedOnCount: actedOn.length,
    }),
  };
}

function openingTempoOpportunities(
  runs: AgentLearningRunInput[],
): OpeningTempoOpportunity[] {
  const groups = new Map<string, OpeningTempoRecordEntry[]>();
  for (const run of runs) {
    for (const record of run.records) {
      const affordance = record.tacticalAffordances?.openingExpansionTempo;
      if (affordance === undefined) {
        continue;
      }
      const key = [
        run.runID,
        run.benchmarkRunIndex ?? "unknown",
        record.agentID,
        record.turnNumber,
      ].join(":");
      const group = groups.get(key) ?? [];
      group.push({ run, record, affordance });
      groups.set(key, group);
    }
  }

  return Array.from(groups.values()).map((entries) => {
    const records = entries.map((entry) => entry.record);
    const affordances = entries.map((entry) => entry.affordance);
    const representative =
      records.find(isOpeningExpansionAction) ??
      records.find(
        (record) =>
          record.tacticalAffordances?.openingExpansionTempo?.recommended ===
          true,
      ) ??
      records[0];
    return {
      run: entries[0].run,
      records,
      affordances,
      representative,
      openingWindow: affordances.some((affordance) => affordance.openingWindow),
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: records.some(isOpeningExpansionAction),
      ownTileShare: averageRounded(
        affordances.map((affordance) => affordance.ownTileShare),
      ),
      leaderTileShareGap: maxRounded(
        affordances.map((affordance) => affordance.leaderTileShareGap),
      ),
    };
  });
}

function openingTempoExample(
  opportunity: OpeningTempoOpportunity,
): AgentOpeningTempoOpportunityExample {
  const record = opportunity.representative;
  const affordance =
    record.tacticalAffordances?.openingExpansionTempo ??
    opportunity.affordances[0];
  return {
    runID: opportunity.run.runID,
    benchmarkRunIndex: opportunity.run.benchmarkRunIndex ?? null,
    won: opportunity.run.won ?? null,
    turnNumber: record.turnNumber,
    selectedActionKind: record.chosenActionKind,
    selectedLegalActionId: record.chosenActionID,
    actedOn: opportunity.actedOn,
    ownTileShare: affordance?.ownTileShare ?? null,
    expectedTileShare: affordance?.expectedTileShare ?? null,
    leaderTileShareGap: affordance?.leaderTileShareGap ?? null,
    neutralLandExpansionActionCount:
      affordance?.neutralLandExpansionActionCount ?? 0,
    neutralBoatExpansionActionCount:
      affordance?.neutralBoatExpansionActionCount ?? 0,
    homeDanger: affordance?.homeDanger ?? "unknown",
    reason: record.reason,
  };
}

function isOpeningExpansionAction(record: AgentDecisionRecord): boolean {
  return (
    (record.chosenActionKind === "attack" &&
      record.chosenActionMetadata?.expansion === true) ||
    (record.chosenActionKind === "boat" &&
      record.chosenActionMetadata?.targetID === null)
  );
}

function openingExpansionTempoHypotheses(input: {
  observedCount: number;
  recommendedCount: number;
  actedOnCount: number;
  missedCount: number;
}): string[] {
  const hypotheses: string[] = [];
  if (input.observedCount === 0) {
    hypotheses.push(
      "No opening-tempo affordance data was present. Run a fresh benchmark after enabling openingExpansionTempo in tacticalAffordances.",
    );
  }
  if (input.recommendedCount === 0) {
    hypotheses.push(
      "The benchmark did not expose early behind-tempo expansion opportunities, or the expected opening target is too loose.",
    );
  }
  if (input.missedCount > 0) {
    hypotheses.push(
      "The executor can see early expansion tempo pressure but another action type is outranking legal neutral growth.",
    );
  }
  if (input.actedOnCount > 0 && input.missedCount > 0) {
    hypotheses.push(
      "Opening tempo needs clearer stop conditions so expansion fires while land is available, then hands off to economy or pressure.",
    );
  }
  if (hypotheses.length === 0) {
    hypotheses.push(
      "Opening tempo opportunities are currently being acted on in this benchmark slice.",
    );
  }
  return hypotheses;
}

function openingExpansionTempoExperiments(input: {
  recommendedCount: number;
  missedCount: number;
  actedOnCount: number;
}): string[] {
  if (input.recommendedCount === 0) {
    return [
      "Run a short Hard-nation opening benchmark and confirm openingExpansionTempo recommendedDecisionCount becomes non-zero.",
      "Tune the expected tile-share schedule against built-in nation opening traces rather than hand-written assumptions.",
    ];
  }
  if (input.missedCount > 0) {
    return [
      "A/B test an opening-tempo executor bias that prioritizes legal neutral expansion while behind expected tile share and home danger is not high.",
      "Reject the change if survival drops or the agent delays the first City/Factory after stable expansion.",
    ];
  }
  return [
    "Keep opening tempo as an observed capability and compare when the agent switches from expansion to economy/pressure.",
  ];
}

function economyCadenceReport(
  runs: AgentLearningRunInput[],
): AgentLearningReport["tactics"]["economyCadence"] {
  const observed = economyCadenceOpportunities(runs);
  const recommended = observed.filter((opportunity) => opportunity.recommended);
  const actedOn = recommended.filter((opportunity) => opportunity.actedOn);
  const missed = recommended.filter((opportunity) => !opportunity.actedOn);
  return {
    tacticID: "economy_cadence",
    observedDecisionCount: observed.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    recommendationActRate: rate(actedOn.length, recommended.length),
    averageRecommendedOwnTileShare: averageRounded(
      recommended.map((opportunity) => opportunity.ownTileShare),
    ),
    averageRecommendedRecentExpansionCount: averageRounded(
      recommended.map((opportunity) => opportunity.recentExpansionCount),
    ),
    averageRecommendedSafeBuildActions: averageRounded(
      recommended.map((opportunity) => opportunity.safeEconomyBuildActionCount),
    ),
    examples: recommended
      .sort(
        (a, b) =>
          Number(a.actedOn) - Number(b.actedOn) ||
          a.representative.turnNumber - b.representative.turnNumber,
      )
      .slice(0, 16)
      .map(economyCadenceExample),
    hypotheses: economyCadenceHypotheses({
      observedCount: observed.length,
      recommendedCount: recommended.length,
      actedOnCount: actedOn.length,
      missedCount: missed.length,
    }),
    nextExperiments: economyCadenceExperiments({
      recommendedCount: recommended.length,
      missedCount: missed.length,
      actedOnCount: actedOn.length,
    }),
  };
}

function economyCadenceOpportunities(
  runs: AgentLearningRunInput[],
): EconomyCadenceOpportunity[] {
  const groups = new Map<string, EconomyCadenceRecordEntry[]>();
  for (const run of runs) {
    for (const record of run.records) {
      const affordance = record.tacticalAffordances?.economyCadence;
      if (affordance === undefined) {
        continue;
      }
      const key = [
        run.runID,
        run.benchmarkRunIndex ?? "unknown",
        record.agentID,
        record.turnNumber,
      ].join(":");
      const group = groups.get(key) ?? [];
      group.push({ run, record, affordance });
      groups.set(key, group);
    }
  }

  return Array.from(groups.values()).map((entries) => {
    const records = entries.map((entry) => entry.record);
    const affordances = entries.map((entry) => entry.affordance);
    const representative =
      records.find(isEconomyCadenceAction) ??
      records.find(
        (record) =>
          record.tacticalAffordances?.economyCadence?.recommended === true,
      ) ??
      records[0];
    return {
      run: entries[0].run,
      records,
      affordances,
      representative,
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: records.some(isEconomyCadenceAction),
      ownTileShare: averageRounded(
        affordances.map((affordance) => affordance.ownTileShare),
      ),
      recentExpansionCount: averageRounded(
        affordances.map((affordance) => affordance.recentExpansionCount),
      ),
      safeEconomyBuildActionCount: averageRounded(
        affordances.map((affordance) => affordance.safeEconomyBuildActionCount),
      ),
    };
  });
}

function economyCadenceExample(
  opportunity: EconomyCadenceOpportunity,
): AgentEconomyCadenceOpportunityExample {
  const record = opportunity.representative;
  const affordance =
    record.tacticalAffordances?.economyCadence ?? opportunity.affordances[0];
  return {
    runID: opportunity.run.runID,
    benchmarkRunIndex: opportunity.run.benchmarkRunIndex ?? null,
    won: opportunity.run.won ?? null,
    turnNumber: record.turnNumber,
    selectedActionKind: record.chosenActionKind,
    selectedLegalActionId: record.chosenActionID,
    actedOn: opportunity.actedOn,
    ownTileShare: affordance?.ownTileShare ?? null,
    recentExpansionCount: affordance?.recentExpansionCount ?? 0,
    recentBuildCount: affordance?.recentBuildCount ?? 0,
    cityCount: affordance?.cityCount ?? 0,
    factoryCount: affordance?.factoryCount ?? 0,
    portCount: affordance?.portCount ?? 0,
    safeEconomyBuildActionCount: affordance?.safeEconomyBuildActionCount ?? 0,
    bestBuildID: affordance?.bestBuildID ?? null,
    bestBuildUnit: affordance?.bestBuildUnit ?? null,
    homeDanger: affordance?.homeDanger ?? "unknown",
    reason: record.reason,
  };
}

function isEconomyCadenceAction(record: AgentDecisionRecord): boolean {
  if (record.chosenActionKind !== "build") {
    return false;
  }
  const unit = String(record.chosenActionMetadata?.unit ?? "");
  return (
    record.chosenActionMetadata?.role === "economic" ||
    unit === "City" ||
    unit === "Factory" ||
    unit === "Port"
  );
}

function economyCadenceHypotheses(input: {
  observedCount: number;
  recommendedCount: number;
  actedOnCount: number;
  missedCount: number;
}): string[] {
  const hypotheses: string[] = [];
  if (input.observedCount === 0) {
    hypotheses.push(
      "No economy-cadence affordance data was present. Run a fresh benchmark after enabling economyCadence in tacticalAffordances.",
    );
  }
  if (input.recommendedCount === 0) {
    hypotheses.push(
      "The benchmark did not expose safe City, Factory, or Port timing windows, or build LegalActions are too sparse.",
    );
  }
  if (input.missedCount > 0) {
    hypotheses.push(
      "The executor can see safe economy timing but expansion, pressure, or hold choices are outranking infrastructure.",
    );
  }
  if (input.actedOnCount > 0 && input.missedCount > 0) {
    hypotheses.push(
      "Economy cadence needs clearer stop conditions so it builds the first City/Factory/Port without freezing expansion or pressure.",
    );
  }
  if (hypotheses.length === 0) {
    hypotheses.push(
      "Economy-cadence opportunities are currently being acted on in this benchmark slice.",
    );
  }
  return hypotheses;
}

function economyCadenceExperiments(input: {
  recommendedCount: number;
  missedCount: number;
  actedOnCount: number;
}): string[] {
  if (input.recommendedCount === 0) {
    return [
      "Run a targeted benchmark with legal City, Factory, and Port actions after two neutral expansions and confirm economyCadence recommendedDecisionCount becomes non-zero.",
      "Compare build availability against human replay economy timing before loosening thresholds.",
    ];
  }
  if (input.missedCount > 0) {
    return [
      "A/B test an economy-cadence executor bias that prefers the best safe City, Factory, or Port LegalAction.id after a stable land base.",
      "Reject the change if survival, average tile share, or weak-rival conversion act rate drops.",
    ];
  }
  return [
    "Keep economy cadence as an observed capability and inspect whether early infrastructure improves factory timing and late-game weapon availability.",
  ];
}

function navalControlReport(
  runs: AgentLearningRunInput[],
): NonNullable<AgentLearningReport["tactics"]["navalControl"]> {
  const observed = navalControlOpportunities(runs);
  const recommended = observed.filter((opportunity) => opportunity.recommended);
  const actedOn = recommended.filter((opportunity) => opportunity.actedOn);
  const missed = recommended.filter((opportunity) => !opportunity.actedOn);
  return {
    tacticID: "naval_control",
    observedDecisionCount: observed.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    recommendationActRate: rate(actedOn.length, recommended.length),
    averageRecommendedActiveTransportCount: averageRounded(
      recommended.map((opportunity) => opportunity.activeTransportCount),
    ),
    averageRecommendedSafeNavalActions: averageRounded(
      recommended.map((opportunity) => opportunity.safeNavalActionCount),
    ),
    examples: recommended
      .sort(
        (a, b) =>
          Number(a.actedOn) - Number(b.actedOn) ||
          a.representative.turnNumber - b.representative.turnNumber,
      )
      .slice(0, 16)
      .map(navalControlExample),
    hypotheses: navalControlHypotheses({
      observedCount: observed.length,
      recommendedCount: recommended.length,
      actedOnCount: actedOn.length,
      missedCount: missed.length,
    }),
    nextExperiments: navalControlExperiments({
      recommendedCount: recommended.length,
      missedCount: missed.length,
      actedOnCount: actedOn.length,
    }),
  };
}

function navalControlOpportunities(
  runs: AgentLearningRunInput[],
): NavalControlOpportunity[] {
  const groups = new Map<string, NavalControlRecordEntry[]>();
  for (const run of runs) {
    for (const record of run.records) {
      const affordance = record.tacticalAffordances?.navalControl;
      if (affordance === undefined) {
        continue;
      }
      const key = [
        run.runID,
        run.benchmarkRunIndex ?? "unknown",
        record.agentID,
        record.turnNumber,
      ].join(":");
      const group = groups.get(key) ?? [];
      group.push({ run, record, affordance });
      groups.set(key, group);
    }
  }

  return Array.from(groups.values()).map((entries) => {
    const records = entries.map((entry) => entry.record);
    const affordances = entries.map((entry) => entry.affordance);
    const representative =
      records.find(isNavalControlActionRecord) ??
      records.find(
        (record) =>
          record.tacticalAffordances?.navalControl?.recommended === true,
      ) ??
      records[0];
    return {
      run: entries[0].run,
      records,
      affordances,
      representative,
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: records.some(isNavalControlActionRecord),
      activeTransportCount: averageRounded(
        affordances.map((affordance) => affordance.activeTransportCount),
      ),
      safeNavalActionCount: averageRounded(
        affordances.map((affordance) => affordance.safeNavalActionCount),
      ),
    };
  });
}

function navalControlExample(
  opportunity: NavalControlOpportunity,
): AgentNavalControlOpportunityExample {
  const record = opportunity.representative;
  const affordance =
    record.tacticalAffordances?.navalControl ?? opportunity.affordances[0];
  return {
    runID: opportunity.run.runID,
    benchmarkRunIndex: opportunity.run.benchmarkRunIndex ?? null,
    won: opportunity.run.won ?? null,
    turnNumber: record.turnNumber,
    selectedActionKind: record.chosenActionKind,
    selectedLegalActionId: record.chosenActionID,
    actedOn: opportunity.actedOn,
    portCount: affordance?.portCount ?? 0,
    warshipCount: affordance?.warshipCount ?? 0,
    activeTransportCount: affordance?.activeTransportCount ?? 0,
    boatLaunchActionCount: affordance?.boatLaunchActionCount ?? 0,
    navalInvasionActionCount: affordance?.navalInvasionActionCount ?? 0,
    warshipBuildActionCount: affordance?.warshipBuildActionCount ?? 0,
    warshipMoveActionCount: affordance?.warshipMoveActionCount ?? 0,
    bestNavalActionID: affordance?.bestNavalActionID ?? null,
    bestNavalActionKind: affordance?.bestNavalActionKind ?? null,
    homeDanger: affordance?.homeDanger ?? "unknown",
    reason: record.reason,
  };
}

function isNavalControlActionRecord(record: AgentDecisionRecord): boolean {
  return (
    record.chosenActionKind === "boat" ||
    record.chosenActionKind === "boat_retreat" ||
    record.chosenActionKind === "warship" ||
    record.chosenActionKind === "move_warship"
  );
}

function navalControlHypotheses(input: {
  observedCount: number;
  recommendedCount: number;
  actedOnCount: number;
  missedCount: number;
}): string[] {
  const hypotheses: string[] = [];
  if (input.observedCount === 0) {
    hypotheses.push(
      "No naval-control affordance data was present. Run a fresh benchmark after enabling navalControl in tacticalAffordances.",
    );
  }
  if (input.recommendedCount === 0) {
    hypotheses.push(
      "The benchmark did not expose safe transport, warship, or patrol windows, or naval legal actions are too sparse.",
    );
  }
  if (input.missedCount > 0) {
    hypotheses.push(
      "The executor can see naval-control windows but land growth, economy, pressure, or hold choices are outranking sea control.",
    );
  }
  if (input.actedOnCount > 0 && input.missedCount > 0) {
    hypotheses.push(
      "Naval control needs clearer stop conditions so boats and warships fire without creating transport loops.",
    );
  }
  if (hypotheses.length === 0) {
    hypotheses.push(
      "Naval-control opportunities are currently being acted on in this benchmark slice.",
    );
  }
  return hypotheses;
}

function navalControlExperiments(input: {
  recommendedCount: number;
  missedCount: number;
  actedOnCount: number;
}): string[] {
  if (input.recommendedCount === 0) {
    return [
      "Run a targeted benchmark with a Port, legal Warship or patrol action, and at least one legal boat action.",
      "Confirm navalControl recommendedDecisionCount becomes non-zero before loosening thresholds.",
    ];
  }
  if (input.missedCount > 0) {
    return [
      "A/B test a naval-control executor bias that prefers the best safe boat, warship, or move_warship LegalAction.id.",
      "Reject the change if survival, average tile share, or finish-pressure act rate drops.",
    ];
  }
  return [
    "Keep naval control as an observed capability and inspect whether naval actions produce invasion, defense, or trade-lane story beats.",
  ];
}

function lateGameStrikeTargetingReport(
  runs: AgentLearningRunInput[],
): NonNullable<AgentLearningReport["tactics"]["lateGameStrikeTargeting"]> {
  const observed = lateGameStrikeTargetingOpportunities(runs);
  const recommended = observed.filter((opportunity) => opportunity.recommended);
  const actedOn = recommended.filter((opportunity) => opportunity.actedOn);
  const missed = recommended.filter((opportunity) => !opportunity.actedOn);
  return {
    tacticID: "late_game_strike_targeting",
    observedDecisionCount: observed.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    recommendationActRate: rate(actedOn.length, recommended.length),
    averageRecommendedBestStrikeScore: averageRounded(
      recommended.map((opportunity) => opportunity.bestStrikeScore),
    ),
    averageRecommendedHighValueStrikes: averageRounded(
      recommended.map((opportunity) => opportunity.highValueStrikeActionCount),
    ),
    examples: recommended
      .sort(
        (a, b) =>
          Number(a.actedOn) - Number(b.actedOn) ||
          (b.bestStrikeScore ?? -Infinity) - (a.bestStrikeScore ?? -Infinity) ||
          a.representative.turnNumber - b.representative.turnNumber,
      )
      .slice(0, 16)
      .map(lateGameStrikeTargetingExample),
    hypotheses: lateGameStrikeTargetingHypotheses({
      observedCount: observed.length,
      recommendedCount: recommended.length,
      actedOnCount: actedOn.length,
      missedCount: missed.length,
    }),
    nextExperiments: lateGameStrikeTargetingExperiments({
      recommendedCount: recommended.length,
      missedCount: missed.length,
      actedOnCount: actedOn.length,
    }),
  };
}

function lateGameStrikeTargetingOpportunities(
  runs: AgentLearningRunInput[],
): LateGameStrikeTargetingOpportunity[] {
  const groups = new Map<string, LateGameStrikeTargetingRecordEntry[]>();
  for (const run of runs) {
    for (const record of run.records) {
      const affordance = record.tacticalAffordances?.lateGameStrikeTargeting;
      if (affordance === undefined) {
        continue;
      }
      const key = [
        run.runID,
        run.benchmarkRunIndex ?? "unknown",
        record.agentID,
        record.turnNumber,
      ].join(":");
      const group = groups.get(key) ?? [];
      group.push({ run, record, affordance });
      groups.set(key, group);
    }
  }

  return Array.from(groups.values()).map((entries) => {
    const records = entries.map((entry) => entry.record);
    const affordances = entries.map((entry) => entry.affordance);
    const representative =
      records.find(isLateGameStrikeTargetingActionRecord) ??
      records.find(
        (record) =>
          record.tacticalAffordances?.lateGameStrikeTargeting?.recommended ===
          true,
      ) ??
      records[0];
    return {
      run: entries[0].run,
      records,
      affordances,
      representative,
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: records.some(isLateGameStrikeTargetingActionRecord),
      bestStrikeScore: maxRounded(
        affordances.map((affordance) => affordance.bestStrikeScore),
      ),
      highValueStrikeActionCount: averageRounded(
        affordances.map((affordance) => affordance.highValueStrikeActionCount),
      ),
    };
  });
}

function lateGameStrikeTargetingExample(
  opportunity: LateGameStrikeTargetingOpportunity,
): AgentLateGameStrikeTargetingOpportunityExample {
  const record = opportunity.representative;
  const affordance =
    record.tacticalAffordances?.lateGameStrikeTargeting ??
    opportunity.affordances[0];
  return {
    runID: opportunity.run.runID,
    benchmarkRunIndex: opportunity.run.benchmarkRunIndex ?? null,
    won: opportunity.run.won ?? null,
    turnNumber: record.turnNumber,
    selectedActionKind: record.chosenActionKind,
    selectedLegalActionId: record.chosenActionID,
    actedOn: opportunity.actedOn,
    legalStrikeActionCount: affordance?.legalStrikeActionCount ?? 0,
    highValueStrikeActionCount: affordance?.highValueStrikeActionCount ?? 0,
    siloTargetActionCount: affordance?.siloTargetActionCount ?? 0,
    samTargetActionCount: affordance?.samTargetActionCount ?? 0,
    economyTargetActionCount: affordance?.economyTargetActionCount ?? 0,
    coveredNonSamTargetActionCount:
      affordance?.coveredNonSamTargetActionCount ?? 0,
    bestStrikeActionID: affordance?.bestStrikeActionID ?? null,
    bestStrikeWeapon: affordance?.bestStrikeWeapon ?? null,
    bestStrikeTargetName: affordance?.bestStrikeTargetName ?? null,
    bestStrikeTargetStructureUnit:
      affordance?.bestStrikeTargetStructureUnit ?? null,
    bestStrikeScore: affordance?.bestStrikeScore ?? null,
    homeDanger: affordance?.homeDanger ?? "unknown",
    reason: record.reason,
  };
}

function isLateGameStrikeTargetingActionRecord(
  record: AgentDecisionRecord,
): boolean {
  return record.chosenActionKind === "nuke";
}

function lateGameStrikeTargetingHypotheses(input: {
  observedCount: number;
  recommendedCount: number;
  actedOnCount: number;
  missedCount: number;
}): string[] {
  const hypotheses: string[] = [];
  if (input.observedCount === 0) {
    hypotheses.push(
      "No late-game strike-targeting affordance data was present. Run a fresh benchmark after enabling lateGameStrikeTargeting in tacticalAffordances.",
    );
  }
  if (input.recommendedCount === 0) {
    hypotheses.push(
      "The benchmark did not expose legal high-value nuke targets, or matches ended before late-game weapons mattered.",
    );
  }
  if (input.missedCount > 0) {
    hypotheses.push(
      "The executor can see high-value strike windows but lower-impact growth, pressure, or hold actions are outranking them.",
    );
  }
  if (input.actedOnCount > 0 && input.missedCount > 0) {
    hypotheses.push(
      "Late-game strike targeting needs sharper target gates so nukes fire on silos, SAMs, cities, factories, ports, or leader concentrations without spam.",
    );
  }
  if (hypotheses.length === 0) {
    hypotheses.push(
      "Late-game strike opportunities are currently being acted on in this benchmark slice.",
    );
  }
  return hypotheses;
}

function lateGameStrikeTargetingExperiments(input: {
  recommendedCount: number;
  missedCount: number;
  actedOnCount: number;
}): string[] {
  if (input.recommendedCount === 0) {
    return [
      "Run a targeted late-game benchmark with legal MIRV/Hydrogen/Atom actions against a leader silo, SAM, city, factory, or port.",
      "Confirm lateGameStrikeTargeting recommendedDecisionCount becomes non-zero before loosening strike thresholds.",
    ];
  }
  if (input.missedCount > 0) {
    return [
      "A/B test a late-game strike-targeting executor bias that prefers the best high-value nuke LegalAction.id.",
      "Reject the change if survival, average tile share, or finish-pressure act rate drops.",
    ];
  }
  return [
    "Keep late-game strike targeting as an observed capability and inspect whether launches create decisive endgame pressure without nuke spam.",
  ];
}

function personalityDiplomacyPressureReport(
  runs: AgentLearningRunInput[],
): NonNullable<
  AgentLearningReport["tactics"]["personalityDiplomacyPressure"]
> {
  const observed = personalityDiplomacyPressureOpportunities(runs);
  const recommended = observed.filter((opportunity) => opportunity.recommended);
  const actedOn = recommended.filter((opportunity) => opportunity.actedOn);
  const missed = recommended.filter((opportunity) => !opportunity.actedOn);
  return {
    tacticID: "personality_diplomacy_pressure",
    observedDecisionCount: observed.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    recommendationActRate: rate(actedOn.length, recommended.length),
    averageRecommendedSocialActions: averageRounded(
      recommended.map((opportunity) => opportunity.socialActionCount),
    ),
    averageRecommendedBestSocialScore: averageRounded(
      recommended.map((opportunity) => opportunity.bestSocialScore),
    ),
    examples: recommended
      .sort(
        (a, b) =>
          Number(a.actedOn) - Number(b.actedOn) ||
          (b.bestSocialScore ?? -Infinity) - (a.bestSocialScore ?? -Infinity) ||
          a.representative.turnNumber - b.representative.turnNumber,
      )
      .slice(0, 16)
      .map(personalityDiplomacyPressureExample),
    hypotheses: personalityDiplomacyPressureHypotheses({
      observedCount: observed.length,
      recommendedCount: recommended.length,
      actedOnCount: actedOn.length,
      missedCount: missed.length,
    }),
    nextExperiments: personalityDiplomacyPressureExperiments({
      recommendedCount: recommended.length,
      missedCount: missed.length,
      actedOnCount: actedOn.length,
    }),
  };
}

function personalityDiplomacyPressureOpportunities(
  runs: AgentLearningRunInput[],
): PersonalityDiplomacyPressureOpportunity[] {
  const groups = new Map<string, PersonalityDiplomacyPressureRecordEntry[]>();
  for (const run of runs) {
    for (const record of run.records) {
      const affordance =
        record.tacticalAffordances?.personalityDiplomacyPressure;
      if (affordance === undefined) {
        continue;
      }
      const key = [
        run.runID,
        run.benchmarkRunIndex ?? "unknown",
        record.agentID,
        record.turnNumber,
      ].join(":");
      const group = groups.get(key) ?? [];
      group.push({ run, record, affordance });
      groups.set(key, group);
    }
  }

  return Array.from(groups.values()).map((entries) => {
    const records = entries.map((entry) => entry.record);
    const affordances = entries.map((entry) => entry.affordance);
    const representative =
      records.find(isPersonalityDiplomacyPressureActionRecord) ??
      records.find(
        (record) =>
          record.tacticalAffordances?.personalityDiplomacyPressure
            ?.recommended === true,
      ) ??
      records[0];
    return {
      run: entries[0].run,
      records,
      affordances,
      representative,
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: records.some(isPersonalityDiplomacyPressureActionRecord),
      socialActionCount: averageRounded(
        affordances.map((affordance) => affordance.socialActionCount),
      ),
      bestSocialScore: maxRounded(
        affordances.map((affordance) => affordance.bestSocialScore),
      ),
    };
  });
}

function personalityDiplomacyPressureExample(
  opportunity: PersonalityDiplomacyPressureOpportunity,
): AgentPersonalityDiplomacyPressureOpportunityExample {
  const record = opportunity.representative;
  const affordance =
    record.tacticalAffordances?.personalityDiplomacyPressure ??
    opportunity.affordances[0];
  return {
    runID: opportunity.run.runID,
    benchmarkRunIndex: opportunity.run.benchmarkRunIndex ?? null,
    won: opportunity.run.won ?? null,
    turnNumber: record.turnNumber,
    selectedActionKind: record.chosenActionKind,
    selectedLegalActionId: record.chosenActionID,
    actedOn: opportunity.actedOn,
    profile: affordance?.profile ?? record.profile,
    recentSocialActionCount: affordance?.recentSocialActionCount ?? 0,
    socialActionCount: affordance?.socialActionCount ?? 0,
    pressureActionCount: affordance?.pressureActionCount ?? 0,
    allianceActionCount: affordance?.allianceActionCount ?? 0,
    supportActionCount: affordance?.supportActionCount ?? 0,
    communicationActionCount: affordance?.communicationActionCount ?? 0,
    bestSocialActionID: affordance?.bestSocialActionID ?? null,
    bestSocialActionKind: affordance?.bestSocialActionKind ?? null,
    bestSocialTargetName: affordance?.bestSocialTargetName ?? null,
    bestSocialScore: affordance?.bestSocialScore ?? null,
    personalityMode: affordance?.personalityMode ?? null,
    homeDanger: affordance?.homeDanger ?? "unknown",
    reason: record.reason,
  };
}

function isPersonalityDiplomacyPressureActionRecord(
  record: AgentDecisionRecord,
): boolean {
  return isPersonalityDiplomacyActionKind(record.chosenActionKind);
}

function personalityDiplomacyPressureHypotheses(input: {
  observedCount: number;
  recommendedCount: number;
  actedOnCount: number;
  missedCount: number;
}): string[] {
  const hypotheses: string[] = [];
  if (input.observedCount === 0) {
    hypotheses.push(
      "No personality-diplomacy affordance data was present. Run a fresh benchmark after enabling personalityDiplomacyPressure in tacticalAffordances.",
    );
  }
  if (input.recommendedCount === 0) {
    hypotheses.push(
      "The benchmark did not expose enough legal social pressure, alliance, support, or communication actions, or the anti-spam throttle stayed active.",
    );
  }
  if (input.missedCount > 0) {
    hypotheses.push(
      "The executor can see profile-specific story beats but growth, combat, build, or hold choices are outranking personality expression.",
    );
  }
  if (input.actedOnCount > 0 && input.missedCount > 0) {
    hypotheses.push(
      "Personality diplomacy pressure needs sharper profile and cooldown gates so visible social actions happen without spam.",
    );
  }
  if (hypotheses.length === 0) {
    hypotheses.push(
      "Personality-diplomacy opportunities are currently being acted on in this benchmark slice.",
    );
  }
  return hypotheses;
}

function personalityDiplomacyPressureExperiments(input: {
  recommendedCount: number;
  missedCount: number;
  actedOnCount: number;
}): string[] {
  if (input.recommendedCount === 0) {
    return [
      "Run a targeted multi-profile benchmark with legal target_player, embargo, alliance_request, quick_chat, and emoji actions.",
      "Confirm personalityDiplomacyPressure recommendedDecisionCount becomes non-zero before loosening social thresholds.",
    ];
  }
  if (input.missedCount > 0) {
    return [
      "A/B test a personality-diplomacy executor bias that prefers the best profile-specific social LegalAction.id after repeated expansion or hold loops.",
      "Reject the change if survival, average tile share, or hostile-conversion act rate drops.",
    ];
  }
  return [
    "Keep personality diplomacy pressure as an observed capability and inspect whether profile action mixes look distinct in replay story reports.",
  ];
}

function transportTroopBankingReport(
  runs: AgentLearningRunInput[],
): AgentLearningReport["tactics"]["transportTroopBanking"] {
  const observed = transportTroopBankingOpportunities(runs);
  const nearCap = observed.filter((opportunity) => opportunity.nearCap);
  const recommended = observed.filter((opportunity) => opportunity.recommended);
  const actedOn = recommended.filter((opportunity) => opportunity.actedOn);
  const missed = recommended.filter((opportunity) => !opportunity.actedOn);
  const wins = recommended.filter(
    (opportunity) => opportunity.run.won === true,
  );
  const losses = recommended.filter(
    (opportunity) => opportunity.run.won === false,
  );
  return {
    tacticID: "transport_troop_banking",
    observedDecisionCount: observed.length,
    nearCapDecisionCount: nearCap.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    activeBankDecisionCount: observed.filter(
      (opportunity) => opportunity.activeBank,
    ).length,
    recommendationActRate: rate(actedOn.length, recommended.length),
    winActRate: rate(
      wins.filter((opportunity) => opportunity.actedOn).length,
      wins.length,
    ),
    lossActRate: rate(
      losses.filter((opportunity) => opportunity.actedOn).length,
      losses.length,
    ),
    maxEffectiveFutureTroopRatio: maxRounded(
      observed.map((opportunity) => opportunity.maxEffectiveFutureTroopRatio),
    ),
    examples: recommended
      .sort(
        (a, b) =>
          Number(a.actedOn) - Number(b.actedOn) ||
          a.representative.turnNumber - b.representative.turnNumber,
      )
      .slice(0, 16)
      .map(opportunityExample),
    hypotheses: transportTroopBankingHypotheses({
      observedCount: observed.length,
      recommendedCount: recommended.length,
      actedOnCount: actedOn.length,
      missedCount: missed.length,
    }),
    nextExperiments: transportTroopBankingExperiments({
      recommendedCount: recommended.length,
      missedCount: missed.length,
      actedOnCount: actedOn.length,
    }),
  };
}

function transportTroopBankingOpportunities(
  runs: AgentLearningRunInput[],
): TransportTroopBankingOpportunity[] {
  const groups = new Map<string, TransportTroopBankingRecordEntry[]>();
  for (const run of runs) {
    for (const record of run.records) {
      const affordance = record.tacticalAffordances?.transportTroopBanking;
      if (affordance === undefined) {
        continue;
      }
      const key = [
        run.runID,
        run.benchmarkRunIndex ?? "unknown",
        record.agentID,
        record.turnNumber,
      ].join(":");
      const group = groups.get(key) ?? [];
      group.push({ run, record, affordance });
      groups.set(key, group);
    }
  }

  return Array.from(groups.values()).map((entries) => {
    const records = entries.map((entry) => entry.record);
    const affordances = entries.map((entry) => entry.affordance);
    const representative =
      records.find((record) => record.chosenActionKind === "boat") ??
      records.find(
        (record) =>
          record.tacticalAffordances?.transportTroopBanking.recommended ===
          true,
      ) ??
      records[0];
    return {
      run: entries[0].run,
      records,
      affordances,
      representative,
      nearCap: affordances.some((affordance) => affordance.nearCap),
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: records.some((record) => record.chosenActionKind === "boat"),
      activeBank: affordances.some(
        (affordance) => affordance.activeTransportTroops > 0,
      ),
      maxEffectiveFutureTroopRatio: maxRounded(
        affordances.map(
          (affordance) => affordance.effectiveFutureTroopRatio ?? null,
        ),
      ),
    };
  });
}

function opportunityExample(
  opportunity: TransportTroopBankingOpportunity,
): AgentTacticOpportunityExample {
  const record = opportunity.representative;
  const affordance = record.tacticalAffordances?.transportTroopBanking;
  return {
    runID: opportunity.run.runID,
    benchmarkRunIndex: opportunity.run.benchmarkRunIndex ?? null,
    won: opportunity.run.won ?? null,
    turnNumber: record.turnNumber,
    selectedActionKind: record.chosenActionKind,
    selectedLegalActionId: record.chosenActionID,
    actedOn: opportunity.actedOn,
    ownTroops: affordance?.ownTroops ?? null,
    maxTroops: affordance?.maxTroops ?? null,
    troopRatio: affordance?.troopRatio ?? null,
    activeTransportTroops: affordance?.activeTransportTroops ?? 0,
    largestAvailableBoatLaunchTroops:
      affordance?.largestAvailableBoatLaunchTroops ?? 0,
    effectiveFutureTroopRatio: affordance?.effectiveFutureTroopRatio ?? null,
    reason: record.reason,
  };
}

function transportTroopBankingHypotheses(input: {
  observedCount: number;
  recommendedCount: number;
  actedOnCount: number;
  missedCount: number;
}): string[] {
  const hypotheses: string[] = [];
  if (input.observedCount === 0) {
    hypotheses.push(
      "No tactical affordance data was present. Run a fresh benchmark after enabling tacticalAffordances in decision records.",
    );
  }
  if (input.recommendedCount === 0) {
    hypotheses.push(
      "The agent rarely reaches near-cap boat opportunities, or boat option generation is too sparse for this tactic to appear.",
    );
  }
  if (input.missedCount > 0) {
    hypotheses.push(
      "The executor can see troop-banking opportunities but another heuristic is outranking transport launch.",
    );
  }
  if (input.actedOnCount > 0 && input.missedCount > 0) {
    hypotheses.push(
      "The tactic needs clearer stop conditions so it fires when capped and stays quiet during unsafe fronts.",
    );
  }
  if (hypotheses.length === 0) {
    hypotheses.push(
      "The current benchmark does not expose a transport troop-banking gap yet.",
    );
  }
  return hypotheses;
}

function transportTroopBankingExperiments(input: {
  recommendedCount: number;
  missedCount: number;
  actedOnCount: number;
}): string[] {
  if (input.recommendedCount === 0) {
    return [
      "Add a targeted scenario with near-cap troops, a legal player transport, low incoming danger, and no land attack.",
      "Run one full Hard-nation benchmark and confirm learning-report recommendedDecisionCount becomes non-zero.",
    ];
  }
  if (input.missedCount > 0) {
    return [
      "A/B test a planner objective named bank_transport_troops when transportTroopBanking.recommended is true.",
      "Bias only existing boat LegalAction.id choices; reject the change if attack survival or tile share drops.",
    ];
  }
  return [
    "Keep the tactic as an observed capability and inspect whether landed transports improve finish pressure.",
  ];
}

interface AgentProfileRepairRunGate {
  run: AgentLearningRunInput;
  gate: AgentProfileDifferentiationGate;
}

interface AgentProfileRepairEntry {
  run: AgentLearningRunInput;
  gate: AgentProfileDifferentiationGate;
  profile: AgentProfileStorySummary;
  issues: AgentProfileRepairIssueType[];
}

function profileRepairReport(
  input: AgentLearningReportInput,
): AgentProfileRepairReport {
  const runGates = input.runs.map((run) => profileRepairRunGate(input, run));
  const profileRows = runGates.flatMap((runGate) =>
    runGate.gate.profiles.map((profile) => ({
      run: runGate.run,
      gate: runGate.gate,
      profile,
    })),
  );
  const evaluatedRows = profileRows.filter(
    (row) => row.profile.postSpawnDecisionCount >= 2,
  );
  const profileCount = new Set(profileRows.map((row) => row.profile.profile)).size;
  const runWithProfileDataCount = runGates.filter(
    (runGate) => runGate.gate.profiles.length > 0,
  ).length;
  const benchmarkNeutralConvergence =
    profilesConvergedOnNeutralExpansionAcrossBenchmark(evaluatedRows);
  const entries: AgentProfileRepairEntry[] = evaluatedRows.map((row) => ({
    ...row,
    issues: profileRepairIssues(row, benchmarkNeutralConvergence),
  }));
  const profileSummaries = profileRepairProfileSummaries(entries);
  const evaluatedProfileCount = profileSummaries.length;
  const averageProfileDistance =
    profileSummaries.length < 2
      ? null
      : roundNumber(
          averageProfileVectorDistance(
            profileSummaries.map((summary) => summary.vector),
          ),
        );
  const signatureMatchedCount = evaluatedRows.filter(
    (row) => row.profile.signatureMatched,
  ).length;
  const signatureMatchedRate = rate(signatureMatchedCount, evaluatedRows.length);
  const mediumOrHighStallRiskRunCount = runGates.filter(
    (runGate) =>
      runGate.gate.evaluatedProfileCount > 0 && runGate.gate.stallRisk !== "low",
  ).length;
  const stallRiskRunRate = rate(
    mediumOrHighStallRiskRunCount,
    runGates.filter((runGate) => runGate.gate.evaluatedProfileCount > 0).length,
  );
  const neutralExpansionConvergenceRunCount = entries.filter((entry) =>
    entry.issues.includes("neutral_expansion_convergence"),
  ).length;
  const collapsedSignatureCount = entries.filter((entry) =>
    entry.issues.includes("collapsed_signature"),
  ).length;
  const missingProfileExpressionCount = entries.filter((entry) =>
    entry.issues.includes("missing_profile_expression"),
  ).length;
  const rerankRows = profileRepairRerankRows(input.runs);
  const rerankExamples = rerankRows.slice(0, 20);
  const rerankFamilySummaries = profileRepairRerankFamilySummaries(rerankRows);
  const topMissedRerankFamily =
    rerankFamilySummaries.find((summary) => summary.missedCount > 0)?.family ??
    null;
  const rerankOpportunityCount = rerankRows.length;
  const rerankActedOnCount = rerankRows.filter((example) => example.actedOn)
    .length;
  const rerankMissedCount = rerankOpportunityCount - rerankActedOnCount;
  const rerankActRate = rate(rerankActedOnCount, rerankOpportunityCount);
  const benchmarkDistinctEnough =
    evaluatedProfileCount >= 2 &&
    averageProfileDistance !== null &&
    averageProfileDistance >= 0.14 &&
    (signatureMatchedRate ?? 0) >= 0.5 &&
    (stallRiskRunRate ?? 0) < 0.5;
  const examples = profileRepairExamples(entries);

  return {
    runCount: input.runs.length,
    runWithProfileDataCount,
    profileCount,
    evaluatedProfileCount,
    benchmarkDistinctEnough,
    averageProfileDistance,
    signatureMatchedRate,
    mediumOrHighStallRiskRunCount,
    stallRiskRunRate,
    neutralExpansionConvergenceRunCount,
    collapsedSignatureCount,
    missingProfileExpressionCount,
    examples,
    profileSummaries,
    hypotheses: profileRepairHypotheses({
      profileCount,
      evaluatedProfileCount,
      averageProfileDistance,
      signatureMatchedRate,
      mediumOrHighStallRiskRunCount,
      neutralExpansionConvergenceRunCount,
      collapsedSignatureCount,
      missingProfileExpressionCount,
      rerankOpportunityCount,
      rerankActedOnCount,
      rerankMissedCount,
      topMissedRerankFamily,
      benchmarkDistinctEnough,
    }),
    nextExperiments: profileRepairExperiments({
      profileCount,
      evaluatedProfileCount,
      benchmarkDistinctEnough,
      collapsedSignatureCount,
      neutralExpansionConvergenceRunCount,
      missingProfileExpressionCount,
      mediumOrHighStallRiskRunCount,
      rerankOpportunityCount,
      rerankMissedCount,
      topMissedRerankFamily,
    }),
    rerankOpportunityCount,
    rerankActedOnCount,
    rerankMissedCount,
    rerankActRate,
    rerankExamples,
    rerankFamilySummaries,
  };
}

function profileRepairRunGate(
  input: AgentLearningReportInput,
  run: AgentLearningRunInput,
): AgentProfileRepairRunGate {
  return {
    run,
    gate: buildAgentMatchStory({
      runID: run.runID,
      matchID: run.runID,
      scenario: input.benchmarkID,
      brainMode: "planner-executor",
      records: run.records,
    }).profileDifferentiation,
  };
}

function profileRepairRerankRows(
  runs: AgentLearningRunInput[],
): AgentProfileRepairRerankExample[] {
  return runs
    .flatMap((run) =>
      run.records
        .filter(
          (record) =>
            booleanDecisionMetadata(
              record,
              "profileRepairRerankOpportunity",
            ) === true,
        )
        .map((record) => ({
          runID: run.runID,
          benchmarkRunIndex: run.benchmarkRunIndex ?? null,
          won: run.won ?? null,
          turnNumber: record.turnNumber,
          profile: record.profile,
          family: profileRepairRerankFamily({
            suggestedActionKind: stringDecisionMetadata(
              record,
              "profileRepairRerankSuggestedActionKind",
            ),
            suggestedModule: stringDecisionMetadata(
              record,
              "profileRepairRerankSuggestedModule",
            ),
          }),
          selectedActionKind: record.chosenActionKind,
          selectedLegalActionId: record.chosenActionID,
          suggestedActionID: stringDecisionMetadata(
            record,
            "profileRepairRerankSuggestedActionID",
          ),
          suggestedActionKind: stringDecisionMetadata(
            record,
            "profileRepairRerankSuggestedActionKind",
          ),
          suggestedModule: stringDecisionMetadata(
            record,
            "profileRepairRerankSuggestedModule",
          ),
          actedOn:
            booleanDecisionMetadata(record, "profileRepairRerankSelected") ===
            true,
          candidates:
            stringDecisionMetadata(record, "profileRepairRerankCandidates") ??
            "",
          reason: stringDecisionMetadata(
            record,
            "profileRepairRerankSelectedReason",
          ),
        })),
    )
    .sort(profileRepairRerankExampleSort);
}

function profileRepairRerankFamilySummaries(
  examples: AgentProfileRepairRerankExample[],
): AgentProfileRepairRerankFamilySummary[] {
  const byFamily = new Map<
    AgentProfileRepairRerankFamily,
    AgentProfileRepairRerankExample[]
  >();
  for (const example of examples) {
    const rows = byFamily.get(example.family) ?? [];
    rows.push(example);
    byFamily.set(example.family, rows);
  }
  return [...byFamily.entries()]
    .map(([family, rows]) => {
      const actedOnCount = rows.filter((row) => row.actedOn).length;
      const missedCount = rows.length - actedOnCount;
      return {
        family,
        opportunityCount: rows.length,
        actedOnCount,
        missedCount,
        actRate: rate(actedOnCount, rows.length),
        profiles: unique(
          rows
            .map((row) => row.profile)
            .sort((left, right) => profileOrder(left) - profileOrder(right)),
        ),
        topSuggestedActionIDs: topStrings(
          rows
            .map((row) => row.suggestedActionID)
            .filter((value): value is string => value !== null),
          4,
        ),
        topSelectedActionIDs: topStrings(
          rows.map((row) => row.selectedLegalActionId),
          4,
        ),
      };
    })
    .sort(
      (left, right) =>
        right.missedCount - left.missedCount ||
        right.opportunityCount - left.opportunityCount ||
        left.family.localeCompare(right.family),
    );
}

function profileRepairRerankFamily(input: {
  suggestedActionKind: string | null;
  suggestedModule: string | null;
}): AgentProfileRepairRerankFamily {
  const kind = input.suggestedActionKind;
  const module = input.suggestedModule;
  if (kind === "attack") {
    return "weak_hostile_attack";
  }
  if (kind === "build" || kind === "upgrade_structure") {
    return module === "defense" ? "defense_build" : "economy_build";
  }
  if (kind === "boat" || kind === "warship" || kind === "move_warship") {
    return "naval";
  }
  if (kind === "nuke") {
    return "late_game_strike";
  }
  if (
    kind === "target_player" ||
    kind === "embargo" ||
    kind === "embargo_all" ||
    kind === "break_alliance" ||
    kind === "alliance_reject"
  ) {
    return "pressure_signal";
  }
  if (
    kind === "alliance_request" ||
    kind === "alliance_extend" ||
    kind === "donate_gold" ||
    kind === "donate_troops" ||
    kind === "embargo_stop"
  ) {
    return "diplomacy";
  }
  if (kind === "quick_chat" || kind === "emoji") {
    return "communication";
  }
  return "other";
}

function profileRepairRerankExampleSort(
  left: AgentProfileRepairRerankExample,
  right: AgentProfileRepairRerankExample,
): number {
  const actedDelta = Number(left.actedOn) - Number(right.actedOn);
  if (actedDelta !== 0) {
    return actedDelta;
  }
  const lossDelta = Number(left.won === true) - Number(right.won === true);
  if (lossDelta !== 0) {
    return lossDelta;
  }
  return (
    (left.benchmarkRunIndex ?? 999_999) -
      (right.benchmarkRunIndex ?? 999_999) ||
    left.turnNumber - right.turnNumber
  );
}

function profileRepairIssues(
  row: {
    gate: AgentProfileDifferentiationGate;
    profile: AgentProfileStorySummary;
  },
  benchmarkNeutralConvergence: boolean,
): AgentProfileRepairIssueType[] {
  const issues: AgentProfileRepairIssueType[] = [];
  if (!row.profile.signatureMatched) {
    issues.push("collapsed_signature");
  }
  if (
    row.profile.holdRate >= 0.45 ||
    row.profile.nonHoldRate < 0.45 ||
    row.profile.uniqueActionKindCount <= 1 ||
    row.gate.stallRisk === "high"
  ) {
    issues.push("stall_risk");
  }
  if (
    benchmarkNeutralConvergence &&
    profileLooksNeutralExpansionHeavy(row.profile)
  ) {
    issues.push("neutral_expansion_convergence");
  }
  if (profileMissingExpression(row.profile)) {
    issues.push("missing_profile_expression");
  }
  return uniqueIssueTypes(issues);
}

function profileLooksNeutralExpansionHeavy(
  profile: AgentProfileStorySummary,
): boolean {
  return (
    profile.expansionRate >= 0.45 &&
    profile.combatRate < 0.2 &&
    profile.economyBuildRate < 0.2 &&
    profile.socialActionRate < 0.2
  );
}

function profilesConvergedOnNeutralExpansionAcrossBenchmark(
  rows: Array<{
    profile: AgentProfileStorySummary;
  }>,
): boolean {
  const profiles = new Set(rows.map((row) => row.profile.profile));
  if (profiles.size < 2) {
    return false;
  }
  const byProfile = new Map<AgentStrategyProfile, AgentProfileStorySummary[]>();
  for (const row of rows) {
    const profileRows = byProfile.get(row.profile.profile) ?? [];
    profileRows.push(row.profile);
    byProfile.set(row.profile.profile, profileRows);
  }
  return [...byProfile.values()].every((profileRows) => {
    const averageExpansionRate =
      averageRounded(profileRows.map((profile) => profile.expansionRate)) ?? 0;
    const averageCombatRate =
      averageRounded(profileRows.map((profile) => profile.combatRate)) ?? 0;
    const averageEconomyBuildRate =
      averageRounded(profileRows.map((profile) => profile.economyBuildRate)) ??
      0;
    const averageSocialActionRate =
      averageRounded(profileRows.map((profile) => profile.socialActionRate)) ??
      0;
    return (
      averageExpansionRate >= 0.45 &&
      averageCombatRate < 0.2 &&
      averageEconomyBuildRate < 0.2 &&
      averageSocialActionRate < 0.2
    );
  });
}

function profileMissingExpression(
  profile: AgentProfileStorySummary,
): boolean {
  switch (profile.profile) {
    case "aggressive":
      return (
        profile.combatRate + profile.pressureSignalRate + profile.strikeRate <
        0.25
      );
    case "defensive":
      return (
        profile.defenseRate +
          profile.economyBuildRate +
          profile.navalRate +
          profile.diplomacySupportRate <
        0.25
      );
    case "diplomatic":
      return (
        profile.diplomacySupportRate +
          profile.communicationRate +
          profile.socialActionRate <
        0.25
      );
    case "opportunistic":
      return (
        profile.uniqueActionKindCount <= 2 ||
        profile.combatRate +
          profile.economyBuildRate +
          profile.navalRate +
          profile.pressureSignalRate <
          0.25
      );
  }
}

function profileRepairExamples(
  entries: AgentProfileRepairEntry[],
): AgentProfileRepairExample[] {
  return entries
    .flatMap((entry) =>
      entry.issues.map((issueType) => ({
        runID: entry.run.runID,
        benchmarkRunIndex: entry.run.benchmarkRunIndex ?? null,
        won: entry.run.won ?? null,
        profile: entry.profile.profile,
        issueType,
        signatureLabel: entry.profile.signatureLabel,
        signatureScore: entry.profile.signatureScore,
        signatureMatched: entry.profile.signatureMatched,
        postSpawnDecisionCount: entry.profile.postSpawnDecisionCount,
        holdRate: entry.profile.holdRate,
        expansionRate: entry.profile.expansionRate,
        combatRate: entry.profile.combatRate,
        economyBuildRate: entry.profile.economyBuildRate,
        socialActionRate: entry.profile.socialActionRate,
        navalRate: entry.profile.navalRate,
        strikeRate: entry.profile.strikeRate,
        topActionKinds: entry.profile.topActionKinds,
        summary: profileRepairExampleSummary(entry.profile, issueType),
        suggestedRepair: profileRepairSuggestion(entry.profile.profile, issueType),
      })),
    )
    .sort(profileRepairExampleSort)
    .slice(0, 16);
}

function profileRepairExampleSummary(
  profile: AgentProfileStorySummary,
  issueType: AgentProfileRepairIssueType,
): string {
  const rates = `hold ${profile.holdRate}, expansion ${profile.expansionRate}, combat ${profile.combatRate}, economy ${profile.economyBuildRate}, social ${profile.socialActionRate}`;
  switch (issueType) {
    case "collapsed_signature":
      return `${profile.profile} signature collapsed (${profile.signatureLabel}); ${rates}.`;
    case "stall_risk":
      return `${profile.profile} has stall risk from holds or low diversity; ${rates}.`;
    case "neutral_expansion_convergence":
      return `${profile.profile} joined a benchmark-wide neutral-expansion pattern; ${rates}.`;
    case "missing_profile_expression":
      return `${profile.profile} did not express its expected profile-specific action mix; ${rates}.`;
  }
}

function profileRepairSuggestion(
  profile: AgentStrategyProfile,
  issueType: AgentProfileRepairIssueType,
): string {
  if (issueType === "stall_risk") {
    return "Audit why hold won against legal alternatives, then add a profile-aware retry or scoring bonus that still selects an existing LegalAction.id.";
  }
  if (issueType === "neutral_expansion_convergence") {
    return "Once opening expansion is healthy, raise profile-specific build, pressure, naval, or diplomacy alternatives above more neutral land farming.";
  }
  if (issueType === "collapsed_signature") {
    return "Check whether universal survival or expansion scores are overpowering profile bonuses, then A/B a small profile-signature score adjustment.";
  }
  switch (profile) {
    case "aggressive":
      return "Prefer favorable bordered-rival attacks, target-player pressure, or legal strike choices when they are already available.";
    case "defensive":
      return "Prefer safe Factory, Port, defense-post, SAM, retreat, or naval-control choices when danger and economy timing support them.";
    case "diplomatic":
      return "Prefer alliance, support, communication, embargo-stop, or pressure-signaling choices when social affordances identify a useful target.";
    case "opportunistic":
      return "Prefer mixed high-value pivots: finish weak rivals, build economy, launch boats, or use pressure when the current loop repeats.";
  }
}

function profileRepairExampleSort(
  left: AgentProfileRepairExample,
  right: AgentProfileRepairExample,
): number {
  const lossDelta = Number(left.won === true) - Number(right.won === true);
  if (lossDelta !== 0) {
    return lossDelta;
  }
  const issueDelta =
    profileRepairIssueRank(left.issueType) - profileRepairIssueRank(right.issueType);
  if (issueDelta !== 0) {
    return issueDelta;
  }
  const holdDelta = right.holdRate - left.holdRate;
  if (holdDelta !== 0) {
    return holdDelta;
  }
  const signatureDelta = left.signatureScore - right.signatureScore;
  if (signatureDelta !== 0) {
    return signatureDelta;
  }
  return (left.benchmarkRunIndex ?? 999_999) - (right.benchmarkRunIndex ?? 999_999);
}

function profileRepairIssueRank(issueType: AgentProfileRepairIssueType): number {
  switch (issueType) {
    case "collapsed_signature":
      return 0;
    case "stall_risk":
      return 1;
    case "neutral_expansion_convergence":
      return 2;
    case "missing_profile_expression":
      return 3;
  }
}

function profileRepairProfileSummaries(
  entries: AgentProfileRepairEntry[],
): AgentProfileRepairProfileSummary[] {
  const byProfile = new Map<AgentStrategyProfile, AgentProfileRepairEntry[]>();
  for (const entry of entries) {
    const profileRows = byProfile.get(entry.profile.profile) ?? [];
    profileRows.push(entry);
    byProfile.set(entry.profile.profile, profileRows);
  }
  return [...byProfile.entries()]
    .sort((left, right) => profileOrder(left[0]) - profileOrder(right[0]))
    .map(([profile, profileEntries]) => {
      const profiles = profileEntries.map((entry) => entry.profile);
      const matchedCount = profiles.filter((row) => row.signatureMatched).length;
      return {
        profile,
        runCount: profileEntries.length,
        averageSignatureScore: averageRounded(
          profiles.map((row) => row.signatureScore),
        ),
        signatureMatchedRate: rate(matchedCount, profiles.length),
        averageHoldRate: averageRounded(profiles.map((row) => row.holdRate)),
        averageExpansionRate: averageRounded(
          profiles.map((row) => row.expansionRate),
        ),
        averageCombatRate: averageRounded(profiles.map((row) => row.combatRate)),
        averageEconomyBuildRate: averageRounded(
          profiles.map((row) => row.economyBuildRate),
        ),
        averageSocialActionRate: averageRounded(
          profiles.map((row) => row.socialActionRate),
        ),
        averageNavalRate: averageRounded(profiles.map((row) => row.navalRate)),
        averageStrikeRate: averageRounded(profiles.map((row) => row.strikeRate)),
        topIssues: topIssueTypes(profileEntries.flatMap((entry) => entry.issues), 4),
        vector: averageProfileVector(profiles.map((row) => row.vector)),
      };
    });
}

function profileRepairHypotheses(input: {
  profileCount: number;
  evaluatedProfileCount: number;
  averageProfileDistance: number | null;
  signatureMatchedRate: number | null;
  mediumOrHighStallRiskRunCount: number;
  neutralExpansionConvergenceRunCount: number;
  collapsedSignatureCount: number;
  missingProfileExpressionCount: number;
  rerankOpportunityCount: number;
  rerankActedOnCount: number;
  rerankMissedCount: number;
  topMissedRerankFamily?: AgentProfileRepairRerankFamily | null;
  benchmarkDistinctEnough: boolean;
}): string[] {
  const hypotheses: string[] = [];
  if (input.evaluatedProfileCount === 0) {
    hypotheses.push(
      "No profile had enough post-spawn decisions for repair mining; widen the benchmark before changing policy.",
    );
    if (input.rerankOpportunityCount === 0) {
      return hypotheses;
    }
  }
  if (input.profileCount < 2) {
    hypotheses.push(
      "The benchmark did not include enough profiles to judge visible personality differences; run a profile sweep first.",
    );
  }
  if (!input.benchmarkDistinctEnough) {
    hypotheses.push(
      `Profile action mixes are not distinct enough yet (distance ${input.averageProfileDistance ?? "n/a"}, signature rate ${input.signatureMatchedRate ?? "n/a"}).`,
    );
  }
  if (input.collapsedSignatureCount > 0) {
    hypotheses.push(
      "Universal expansion, survival, or hold scores are likely overpowering profile-specific scoring.",
    );
  }
  if (input.neutralExpansionConvergenceRunCount > 0) {
    hypotheses.push(
      "Neutral expansion is still winning after the opening, causing different personalities to tell the same match story.",
    );
  }
  if (input.mediumOrHighStallRiskRunCount > 0) {
    hypotheses.push(
      "Some profiles need a clearer legal alternative to hold/build loops, especially when the profile signature is already muted.",
    );
  }
  if (input.missingProfileExpressionCount > 0) {
    hypotheses.push(
      "At least one profile lacks enough profile-specific alternatives, such as pressure for aggressive, defense/economy for defensive, or social choices for diplomatic.",
    );
  }
  if (input.rerankOpportunityCount > 0 && input.rerankMissedCount > 0) {
    hypotheses.push(
      `Profile repair re-rank surfaced ${input.rerankOpportunityCount} legal repair windows, but ${input.rerankMissedCount} still selected a lower-expression action.`,
    );
  }
  if (
    input.topMissedRerankFamily !== undefined &&
    input.topMissedRerankFamily !== null
  ) {
    hypotheses.push(
      `The most common missed repair family is ${input.topMissedRerankFamily}; tune that family before changing unrelated profile scores.`,
    );
  }
  if (input.rerankActedOnCount > 0) {
    hypotheses.push(
      "Profile repair re-rank is changing selected actions in auditable windows; compare those runs against survival, tile share, and profile-distance outcomes.",
    );
  }
  if (hypotheses.length === 0) {
    hypotheses.push(
      "Profile scaffolding looks usable; the next risk is whether distinct action mixes also improve wins, survival, and tile share.",
    );
  }
  return unique(hypotheses);
}

function profileRepairExperiments(input: {
  profileCount: number;
  evaluatedProfileCount: number;
  benchmarkDistinctEnough: boolean;
  collapsedSignatureCount: number;
  neutralExpansionConvergenceRunCount: number;
  missingProfileExpressionCount: number;
  mediumOrHighStallRiskRunCount: number;
  rerankOpportunityCount: number;
  rerankMissedCount: number;
  topMissedRerankFamily?: AgentProfileRepairRerankFamily | null;
}): string[] {
  const experiments: string[] = [];
  if (input.profileCount < 2 || input.evaluatedProfileCount < 2) {
    experiments.push(
      "Run a profile sweep with `--profile=all` and at least four runs before tuning profile-specific policy.",
    );
  }
  if (
    input.collapsedSignatureCount > 0 ||
    input.neutralExpansionConvergenceRunCount > 0 ||
    input.missingProfileExpressionCount > 0
  ) {
    experiments.push(
      "Run `npm run agent:learn:ab-gate -- --tactic=profile-differentiation --runs=4` and compare profile distance, signature rate, win rate, and tile share.",
    );
    experiments.push(
      "Mine the listed examples for one small profile-scoring patch that changes ranking among legal actions without adding a new action schema.",
    );
  }
  if (input.mediumOrHighStallRiskRunCount > 0) {
    experiments.push(
      "Add a focused hold-loop replay review: every high-stall example should name the legal action that should have beaten hold and why.",
    );
  }
  if (input.rerankOpportunityCount > 0) {
    experiments.push(
      "Compare `profileRepairReRank` on/off with fixed seeds and inspect every repair-rerank example where the suggested legal action was missed.",
    );
  }
  if (input.rerankMissedCount > 0) {
    experiments.push(
      "Tune the repair re-rank score only for the missed profile/action family, then rerun the same profile-differentiation gate.",
    );
  }
  if (
    input.topMissedRerankFamily !== undefined &&
    input.topMissedRerankFamily !== null
  ) {
    experiments.push(
      `Start with ${input.topMissedRerankFamily} missed examples: inspect the selected action, suggested legal id, and reason before changing score weights.`,
    );
  }
  if (experiments.length === 0 && input.benchmarkDistinctEnough) {
    experiments.push(
      "Promote profile repair mining into the standard learning report and gate future profile policy changes on before/after benchmark artifacts.",
    );
  }
  return unique(experiments);
}

function averageProfileVector(
  vectors: AgentProfileDifferentiationVector[],
): AgentProfileDifferentiationVector {
  return {
    hold: averageRounded(vectors.map((vector) => vector.hold)) ?? 0,
    expansion: averageRounded(vectors.map((vector) => vector.expansion)) ?? 0,
    combat: averageRounded(vectors.map((vector) => vector.combat)) ?? 0,
    economyBuild:
      averageRounded(vectors.map((vector) => vector.economyBuild)) ?? 0,
    defense: averageRounded(vectors.map((vector) => vector.defense)) ?? 0,
    naval: averageRounded(vectors.map((vector) => vector.naval)) ?? 0,
    strike: averageRounded(vectors.map((vector) => vector.strike)) ?? 0,
    pressureSignal:
      averageRounded(vectors.map((vector) => vector.pressureSignal)) ?? 0,
    diplomacySupport:
      averageRounded(vectors.map((vector) => vector.diplomacySupport)) ?? 0,
    communication:
      averageRounded(vectors.map((vector) => vector.communication)) ?? 0,
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

function topIssueTypes(
  issues: AgentProfileRepairIssueType[],
  limit: number,
): AgentProfileRepairIssueType[] {
  const counts = issues.reduce<Record<AgentProfileRepairIssueType, number>>(
    (acc, issue) => {
      acc[issue] = (acc[issue] ?? 0) + 1;
      return acc;
    },
    {
      collapsed_signature: 0,
      stall_risk: 0,
      neutral_expansion_convergence: 0,
      missing_profile_expression: 0,
    },
  );
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([issue]) => issue as AgentProfileRepairIssueType);
}

function topStrings(values: string[], limit: number): string[] {
  const counts = values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => `${value}(${count})`);
}

function uniqueIssueTypes(
  issues: AgentProfileRepairIssueType[],
): AgentProfileRepairIssueType[] {
  return [...new Set(issues)];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function roundNumber(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function emptyProfileRepairReport(runCount: number): AgentProfileRepairReport {
  return {
    runCount,
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
    rerankOpportunityCount: 0,
    rerankActedOnCount: 0,
    rerankMissedCount: 0,
    rerankActRate: null,
    rerankExamples: [],
    rerankFamilySummaries: [],
    examples: [],
    profileSummaries: [],
    hypotheses: [
      "No profile repair data was captured; regenerate the learning report from current benchmark decision records.",
    ],
    nextExperiments: [
      "Run a profile sweep with `--profile=all` and at least four runs before tuning profile-specific policy.",
    ],
  };
}

function learningReportMarkdown(report: AgentLearningReport): string {
  const conversion = report.tactics.frontierConversionTiming;
  const finish = report.tactics.frontierFinishPressure;
  const opening = report.tactics.openingExpansionTempo;
  const economy = report.tactics.economyCadence;
  const naval = report.tactics.navalControl;
  const strike = report.tactics.lateGameStrikeTargeting;
  const personality = report.tactics.personalityDiplomacyPressure;
  const banking = report.tactics.transportTroopBanking;
  const profileRepair =
    report.profileRepair ?? emptyProfileRepairReport(report.runCount);
  return [
    `# Agent Learning Report ${report.benchmarkID}`,
    "",
    `Generated: ${report.generatedAt}`,
    `Runs: ${report.runCount}`,
    `Wins: ${report.winCount}`,
    "",
    "## Frontier Conversion Timing",
    "",
    markdownTable(
      [
        "Observed",
        "Strategic",
        "Ready",
        "Recommended",
        "Acted",
        "Missed",
        "Act Rate",
        "Avg Tile Share",
        "Avg Ready Ratio",
      ],
      [
        [
          String(conversion.observedDecisionCount),
          String(conversion.strategicWindowDecisionCount),
          String(conversion.executorReadyDecisionCount),
          String(conversion.recommendedDecisionCount),
          String(conversion.actedOnDecisionCount),
          String(conversion.missedDecisionCount),
          formatNullableRate(conversion.recommendationActRate),
          formatNullableRate(conversion.averageRecommendedOwnTileShare),
          formatNullableRate(
            conversion.averageRecommendedExecutorReadyTroopRatio,
          ),
        ],
      ],
    ),
    "",
    "## Conversion Examples",
    "",
    conversion.examples.length === 0
      ? "No frontier-conversion examples were captured."
      : markdownTable(
          [
            "Run",
            "Turn",
            "Won",
            "Selected",
            "Tile Share",
            "Recent Exp.",
            "Neutral",
            "Favorable",
            "Ready",
            "Best Target",
            "Ratio",
            "Ready Target",
            "Ready Ratio",
          ],
          conversion.examples.map((example) => [
            example.runID,
            String(example.turnNumber),
            String(example.won),
            example.selectedLegalActionId,
            String(example.ownTileShare ?? "?"),
            String(example.recentExpansionCount),
            String(example.neutralExpansionActionCount),
            String(example.favorableHostileAttackActionCount),
            String(example.executorReadyHostileAttackActionCount),
            example.bestTargetName ?? "?",
            String(example.bestTargetRelativeTroopRatio ?? "?"),
            example.bestExecutorReadyTargetName ?? "?",
            String(example.bestExecutorReadyRelativeTroopRatio ?? "?"),
          ]),
        ),
    "",
    "## Conversion Hypotheses",
    "",
    ...conversion.hypotheses.map((hypothesis) => `- ${hypothesis}`),
    "",
    "## Conversion Next Experiments",
    "",
    ...conversion.nextExperiments.map((experiment) => `- ${experiment}`),
    "",
    "## Frontier Finish Pressure",
    "",
    markdownTable(
      [
        "Observed",
        "Repeated Probes",
        "Recommended",
        "Acted",
        "Missed",
        "Act Rate",
        "Avg Ratio",
        "Avg Target Share",
        "Avg Attack %",
      ],
      [
        [
          String(finish.observedDecisionCount),
          String(finish.repeatedProbeDecisionCount),
          String(finish.recommendedDecisionCount),
          String(finish.actedOnDecisionCount),
          String(finish.missedDecisionCount),
          formatNullableRate(finish.recommendationActRate),
          formatNullableRate(finish.averageRecommendedBestTroopRatio),
          formatNullableRate(finish.averageRecommendedBestTargetTileShare),
          formatNullableRate(finish.averageRecommendedBestAttackTroopPercent),
        ],
      ],
    ),
    "",
    "## Finish Pressure Examples",
    "",
    finish.examples.length === 0
      ? "No finish-pressure examples were captured."
      : markdownTable(
          [
            "Run",
            "Turn",
            "Won",
            "Selected",
            "Active Target",
            "Low Probes",
            "Decisive",
            "Best Target",
            "Ratio",
            "Attack %",
          ],
          finish.examples.map((example) => [
            example.runID,
            String(example.turnNumber),
            String(example.won),
            example.selectedLegalActionId,
            example.activeTargetName ?? "?",
            String(example.recentLowCommitmentAttackCount),
            String(example.decisiveAttackActionCount),
            example.bestTargetName ?? "?",
            String(example.bestTargetRelativeTroopRatio ?? "?"),
            String(example.bestAttackTroopPercent ?? "?"),
          ]),
        ),
    "",
    "## Finish Pressure Hypotheses",
    "",
    ...finish.hypotheses.map((hypothesis) => `- ${hypothesis}`),
    "",
    "## Finish Pressure Next Experiments",
    "",
    ...finish.nextExperiments.map((experiment) => `- ${experiment}`),
    "",
    "## Opening Expansion Tempo",
    "",
    markdownTable(
      [
        "Observed",
        "Opening Window",
        "Recommended",
        "Acted",
        "Missed",
        "Act Rate",
        "Avg Tile Share",
        "Avg Leader Gap",
      ],
      [
        [
          String(opening.observedDecisionCount),
          String(opening.openingWindowDecisionCount),
          String(opening.recommendedDecisionCount),
          String(opening.actedOnDecisionCount),
          String(opening.missedDecisionCount),
          formatNullableRate(opening.recommendationActRate),
          formatNullableRate(opening.averageRecommendedOwnTileShare),
          formatNullableRate(opening.averageRecommendedLeaderGap),
        ],
      ],
    ),
    "",
    "## Opening Examples",
    "",
    opening.examples.length === 0
      ? "No opening-tempo examples were captured."
      : markdownTable(
          [
            "Run",
            "Turn",
            "Won",
            "Selected",
            "Tile Share",
            "Expected",
            "Leader Gap",
            "Land/Boat",
          ],
          opening.examples.map((example) => [
            example.runID,
            String(example.turnNumber),
            String(example.won),
            example.selectedLegalActionId,
            String(example.ownTileShare ?? "?"),
            String(example.expectedTileShare ?? "?"),
            String(example.leaderTileShareGap ?? "?"),
            `${example.neutralLandExpansionActionCount}/${example.neutralBoatExpansionActionCount}`,
          ]),
        ),
    "",
    "## Opening Hypotheses",
    "",
    ...opening.hypotheses.map((hypothesis) => `- ${hypothesis}`),
    "",
    "## Opening Next Experiments",
    "",
    ...opening.nextExperiments.map((experiment) => `- ${experiment}`),
    "",
    "## Economy Cadence",
    "",
    markdownTable(
      [
        "Observed",
        "Recommended",
        "Acted",
        "Missed",
        "Act Rate",
        "Avg Tile Share",
        "Avg Recent Exp.",
        "Avg Safe Builds",
      ],
      [
        [
          String(economy.observedDecisionCount),
          String(economy.recommendedDecisionCount),
          String(economy.actedOnDecisionCount),
          String(economy.missedDecisionCount),
          formatNullableRate(economy.recommendationActRate),
          formatNullableRate(economy.averageRecommendedOwnTileShare),
          formatNullableRate(economy.averageRecommendedRecentExpansionCount),
          formatNullableRate(economy.averageRecommendedSafeBuildActions),
        ],
      ],
    ),
    "",
    "## Economy Examples",
    "",
    economy.examples.length === 0
      ? "No economy-cadence examples were captured."
      : markdownTable(
          [
            "Run",
            "Turn",
            "Won",
            "Selected",
            "Tile Share",
            "Recent Exp/Build",
            "City/Factory/Port",
            "Safe Builds",
            "Best Build",
            "Home Danger",
          ],
          economy.examples.map((example) => [
            example.runID,
            String(example.turnNumber),
            String(example.won),
            example.selectedLegalActionId,
            String(example.ownTileShare ?? "?"),
            `${example.recentExpansionCount}/${example.recentBuildCount}`,
            `${example.cityCount}/${example.factoryCount}/${example.portCount}`,
            String(example.safeEconomyBuildActionCount),
            example.bestBuildID ?? example.bestBuildUnit ?? "?",
            example.homeDanger,
          ]),
        ),
    "",
    "## Economy Hypotheses",
    "",
    ...economy.hypotheses.map((hypothesis) => `- ${hypothesis}`),
    "",
    "## Economy Next Experiments",
    "",
    ...economy.nextExperiments.map((experiment) => `- ${experiment}`),
    "",
    ...(naval === undefined
      ? []
      : [
          "## Naval Control",
          "",
          markdownTable(
            [
              "Observed",
              "Recommended",
              "Acted",
              "Missed",
              "Act Rate",
              "Avg Active Transports",
              "Avg Safe Naval",
            ],
            [
              [
                String(naval.observedDecisionCount),
                String(naval.recommendedDecisionCount),
                String(naval.actedOnDecisionCount),
                String(naval.missedDecisionCount),
                formatNullableRate(naval.recommendationActRate),
                formatNullableRate(
                  naval.averageRecommendedActiveTransportCount,
                ),
                formatNullableRate(naval.averageRecommendedSafeNavalActions),
              ],
            ],
          ),
          "",
          "## Naval Examples",
          "",
          naval.examples.length === 0
            ? "No naval-control examples were captured."
            : markdownTable(
                [
                  "Run",
                  "Turn",
                  "Won",
                  "Selected",
                  "Port/Warship",
                  "Active Transports",
                  "Boat/Invasion",
                  "Warship/Move",
                  "Best Action",
                  "Home Danger",
                ],
                naval.examples.map((example) => [
                  example.runID,
                  String(example.turnNumber),
                  String(example.won),
                  example.selectedLegalActionId,
                  `${example.portCount}/${example.warshipCount}`,
                  String(example.activeTransportCount),
                  `${example.boatLaunchActionCount}/${example.navalInvasionActionCount}`,
                  `${example.warshipBuildActionCount}/${example.warshipMoveActionCount}`,
                  example.bestNavalActionID ??
                    example.bestNavalActionKind ??
                    "?",
                  example.homeDanger,
                ]),
              ),
          "",
          "## Naval Hypotheses",
          "",
          ...naval.hypotheses.map((hypothesis) => `- ${hypothesis}`),
          "",
          "## Naval Next Experiments",
          "",
          ...naval.nextExperiments.map((experiment) => `- ${experiment}`),
        ]),
    "",
    ...(strike === undefined
      ? []
      : [
          "## Late-Game Strike Targeting",
          "",
          markdownTable(
            [
              "Observed",
              "Recommended",
              "Acted",
              "Missed",
              "Act Rate",
              "Avg Best Score",
              "Avg High-Value",
            ],
            [
              [
                String(strike.observedDecisionCount),
                String(strike.recommendedDecisionCount),
                String(strike.actedOnDecisionCount),
                String(strike.missedDecisionCount),
                formatNullableRate(strike.recommendationActRate),
                formatNullableRate(strike.averageRecommendedBestStrikeScore),
                formatNullableRate(strike.averageRecommendedHighValueStrikes),
              ],
            ],
          ),
          "",
          "## Strike Examples",
          "",
          strike.examples.length === 0
            ? "No late-game strike examples were captured."
            : markdownTable(
                [
                  "Run",
                  "Turn",
                  "Won",
                  "Selected",
                  "Legal/High",
                  "Silo/SAM/Econ/Covered",
                  "Best Strike",
                  "Weapon",
                  "Target",
                  "Structure",
                  "Score",
                ],
                strike.examples.map((example) => [
                  example.runID,
                  String(example.turnNumber),
                  String(example.won),
                  example.selectedLegalActionId,
                  `${example.legalStrikeActionCount}/${example.highValueStrikeActionCount}`,
                  `${example.siloTargetActionCount}/${example.samTargetActionCount}/${example.economyTargetActionCount}/${example.coveredNonSamTargetActionCount}`,
                  example.bestStrikeActionID ?? "?",
                  example.bestStrikeWeapon ?? "?",
                  example.bestStrikeTargetName ?? "?",
                  example.bestStrikeTargetStructureUnit ?? "?",
                  String(example.bestStrikeScore ?? "?"),
                ]),
              ),
          "",
          "## Strike Hypotheses",
          "",
          ...strike.hypotheses.map((hypothesis) => `- ${hypothesis}`),
          "",
          "## Strike Next Experiments",
          "",
          ...strike.nextExperiments.map((experiment) => `- ${experiment}`),
        ]),
    "",
    ...(personality === undefined
      ? []
      : [
          "## Personality Diplomacy Pressure",
          "",
          markdownTable(
            [
              "Observed",
              "Recommended",
              "Acted",
              "Missed",
              "Act Rate",
              "Avg Social Actions",
              "Avg Best Score",
            ],
            [
              [
                String(personality.observedDecisionCount),
                String(personality.recommendedDecisionCount),
                String(personality.actedOnDecisionCount),
                String(personality.missedDecisionCount),
                formatNullableRate(personality.recommendationActRate),
                formatNullableRate(
                  personality.averageRecommendedSocialActions,
                ),
                formatNullableRate(
                  personality.averageRecommendedBestSocialScore,
                ),
              ],
            ],
          ),
          "",
          "## Personality Examples",
          "",
          personality.examples.length === 0
            ? "No personality-diplomacy examples were captured."
            : markdownTable(
                [
                  "Run",
                  "Turn",
                  "Won",
                  "Profile",
                  "Selected",
                  "Best",
                  "Target",
                  "Mode",
                  "Pressure/Ally/Support/Comm",
                  "Score",
                ],
                personality.examples.map((example) => [
                  example.runID,
                  String(example.turnNumber),
                  String(example.won),
                  example.profile,
                  example.selectedLegalActionId,
                  example.bestSocialActionID ??
                    example.bestSocialActionKind ??
                    "?",
                  example.bestSocialTargetName ?? "?",
                  example.personalityMode ?? "?",
                  `${example.pressureActionCount}/${example.allianceActionCount}/${example.supportActionCount}/${example.communicationActionCount}`,
                  String(example.bestSocialScore ?? "?"),
                ]),
              ),
          "",
          "## Personality Hypotheses",
          "",
          ...personality.hypotheses.map((hypothesis) => `- ${hypothesis}`),
          "",
          "## Personality Next Experiments",
          "",
          ...personality.nextExperiments.map((experiment) => `- ${experiment}`),
        ]),
    "",
    "## Transport Troop Banking",
    "",
    markdownTable(
      ["Observed", "Near Cap", "Recommended", "Acted", "Missed", "Act Rate"],
      [
        [
          String(banking.observedDecisionCount),
          String(banking.nearCapDecisionCount),
          String(banking.recommendedDecisionCount),
          String(banking.actedOnDecisionCount),
          String(banking.missedDecisionCount),
          formatNullableRate(banking.recommendationActRate),
        ],
      ],
    ),
    "",
    "## Opportunity Examples",
    "",
    banking.examples.length === 0
      ? "No recommended examples were captured."
      : markdownTable(
          [
            "Run",
            "Turn",
            "Won",
            "Selected",
            "Troops",
            "Bankable",
            "Future Ratio",
          ],
          banking.examples.map((example) => [
            example.runID,
            String(example.turnNumber),
            String(example.won),
            example.selectedLegalActionId,
            `${example.ownTroops ?? "?"}/${example.maxTroops ?? "?"}`,
            String(example.largestAvailableBoatLaunchTroops),
            String(example.effectiveFutureTroopRatio ?? "?"),
          ]),
        ),
    "",
    "## Hypotheses",
    "",
    ...banking.hypotheses.map((hypothesis) => `- ${hypothesis}`),
    "",
    "## Next Experiments",
    "",
    ...banking.nextExperiments.map((experiment) => `- ${experiment}`),
    "",
    "## Profile Repair Mining",
    "",
    markdownTable(
      [
        "Runs",
        "Profile Runs",
        "Profiles",
        "Evaluated",
        "Distinct",
        "Avg Distance",
        "Signature Rate",
        "Stall Runs",
        "Neutral Conv.",
        "Collapsed",
        "Missing Expr.",
        "Rerank Opp.",
        "Rerank Acted",
        "Rerank Act Rate",
      ],
      [
        [
          String(profileRepair.runCount),
          String(profileRepair.runWithProfileDataCount),
          String(profileRepair.profileCount),
          String(profileRepair.evaluatedProfileCount),
          String(profileRepair.benchmarkDistinctEnough),
          formatNullableRate(profileRepair.averageProfileDistance),
          formatNullableRate(profileRepair.signatureMatchedRate),
          String(profileRepair.mediumOrHighStallRiskRunCount),
          String(profileRepair.neutralExpansionConvergenceRunCount),
          String(profileRepair.collapsedSignatureCount),
          String(profileRepair.missingProfileExpressionCount),
          String(profileRepair.rerankOpportunityCount),
          String(profileRepair.rerankActedOnCount),
          formatNullableRate(profileRepair.rerankActRate),
        ],
      ],
    ),
    "",
    "## Profile Repair Profiles",
    "",
    profileRepair.profileSummaries.length === 0
      ? "No profile summaries were captured."
      : markdownTable(
          [
            "Profile",
            "Runs",
            "Sig Score",
            "Sig Rate",
            "Hold",
            "Expansion",
            "Combat",
            "Economy",
            "Social",
            "Naval",
            "Strike",
            "Top Issues",
          ],
          profileRepair.profileSummaries.map((summary) => [
            summary.profile,
            String(summary.runCount),
            formatNullableRate(summary.averageSignatureScore),
            formatNullableRate(summary.signatureMatchedRate),
            formatNullableRate(summary.averageHoldRate),
            formatNullableRate(summary.averageExpansionRate),
            formatNullableRate(summary.averageCombatRate),
            formatNullableRate(summary.averageEconomyBuildRate),
            formatNullableRate(summary.averageSocialActionRate),
            formatNullableRate(summary.averageNavalRate),
            formatNullableRate(summary.averageStrikeRate),
            summary.topIssues.join(", ") || "none",
          ]),
        ),
    "",
    "## Profile Repair Re-rank Families",
    "",
    profileRepair.rerankFamilySummaries.length === 0
      ? "No profile-repair re-rank families were captured."
      : markdownTable(
          [
            "Family",
            "Opp.",
            "Acted",
            "Missed",
            "Act Rate",
            "Profiles",
            "Top Suggested",
            "Top Selected",
          ],
          profileRepair.rerankFamilySummaries.map((summary) => [
            summary.family,
            String(summary.opportunityCount),
            String(summary.actedOnCount),
            String(summary.missedCount),
            formatNullableRate(summary.actRate),
            summary.profiles.join(", ") || "none",
            summary.topSuggestedActionIDs.join(", ") || "none",
            summary.topSelectedActionIDs.join(", ") || "none",
          ]),
        ),
    "",
    "## Profile Repair Re-rank Examples",
    "",
    profileRepair.rerankExamples.length === 0
      ? "No profile-repair re-rank opportunities were captured."
      : markdownTable(
          [
            "Run",
            "Turn",
            "Profile",
            "Acted",
            "Selected",
            "Suggested",
            "Module",
            "Candidates",
            "Reason",
          ],
          profileRepair.rerankExamples.map((example) => [
            example.runID,
            String(example.turnNumber),
            example.profile,
            String(example.actedOn),
            example.selectedLegalActionId,
            example.suggestedActionID ?? "?",
            example.suggestedModule ?? "?",
            example.candidates || "none",
            example.reason ?? "?",
          ]),
        ),
    "",
    "## Profile Repair Examples",
    "",
    profileRepair.examples.length === 0
      ? "No profile-repair examples were captured."
      : markdownTable(
          [
            "Run",
            "Profile",
            "Issue",
            "Won",
            "Score",
            "Hold",
            "Expansion",
            "Combat",
            "Social",
            "Top Actions",
            "Repair",
          ],
          profileRepair.examples.map((example) => [
            example.runID,
            example.profile,
            example.issueType,
            String(example.won),
            String(example.signatureScore),
            String(example.holdRate),
            String(example.expansionRate),
            String(example.combatRate),
            String(example.socialActionRate),
            example.topActionKinds.join(", ") || "none",
            example.suggestedRepair,
          ]),
        ),
    "",
    "## Profile Repair Hypotheses",
    "",
    ...profileRepair.hypotheses.map((hypothesis) => `- ${hypothesis}`),
    "",
    "## Profile Repair Next Experiments",
    "",
    ...profileRepair.nextExperiments.map((experiment) => `- ${experiment}`),
    "",
    "## LLM Review Packet",
    "",
    "```json",
    JSON.stringify(report.llmReviewPacket, null, 2),
    "```",
    "",
  ].join("\n");
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

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }
  return Math.round((numerator / denominator) * 1_000) / 1_000;
}

function averageRounded(values: Array<number | null>): number | null {
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (finite.length === 0) {
    return null;
  }
  return (
    Math.round(
      (finite.reduce((total, value) => total + value, 0) / finite.length) *
        1_000,
    ) / 1_000
  );
}

function maxRounded(values: Array<number | null>): number | null {
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (finite.length === 0) {
    return null;
  }
  return Math.round(Math.max(...finite) * 1_000) / 1_000;
}

function formatNullableRate(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function booleanDecisionMetadata(
  record: AgentDecisionRecord,
  key: string,
): boolean | null {
  const value = record.decisionMetadata?.[key];
  return typeof value === "boolean" ? value : null;
}

function stringDecisionMetadata(
  record: AgentDecisionRecord,
  key: string,
): string | null {
  const value = record.decisionMetadata?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "learning";
}
