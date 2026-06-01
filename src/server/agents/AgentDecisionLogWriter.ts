import fs from "fs/promises";
import path from "path";
import type { GameRecord } from "../../core/Schemas";
import {
  AgentBehaviorQualityReport,
  AgentBehaviorQualityReportPaths,
  behaviorQualitySummary,
  buildAgentBehaviorQualityReport,
  writeAgentBehaviorQualityArtifacts,
} from "./AgentBehaviorQualityReport";
import {
  AgentMatchStory,
  AgentMatchStoryPaths,
  buildAgentMatchStory,
  writeAgentMatchStoryArtifacts,
} from "./AgentMatchStory";
import {
  AgentObjectiveScorecard,
  AgentObjectiveScorecardPaths,
  buildAgentObjectiveScorecard,
  writeAgentObjectiveScorecardArtifacts,
} from "./AgentObjectiveScorecard";
import {
  AgentSpectatorReplay,
  AgentSpectatorReplayPaths,
  writeAgentSpectatorReplayArtifacts,
} from "./AgentSpectatorReplay";
import {
  buildAgentSpectatorTelemetry,
  SpectatorTelemetry,
} from "./AgentSpectatorTelemetry";
import {
  AgentActionAudit,
  AgentBrainType,
  AgentDecisionRecord,
  AgentEconomyCadenceAffordance,
  AgentFrontierConversionTimingAffordance,
  AgentFrontierFinishPressureAffordance,
  AgentLateGameStrikeTargetingAffordance,
  AgentNavalControlAffordance,
  AgentObjectiveKind,
  AgentOpeningExpansionTempoAffordance,
  AgentPersonalityDiplomacyPressureAffordance,
  AgentRuntimeMode,
  AgentStrategyProfile,
  AgentTacticalAffordances,
  AgentTransportTroopBankingAffordance,
  LegalActionKind,
} from "./AgentTypes";
import {
  buildExternalAgentFeedback,
  ExternalAgentFeedback,
  ExternalAgentFeedbackPaths,
  writeExternalAgentFeedbackArtifacts,
} from "./ExternalAgentFeedback";
import {
  ProxyWarMatchPackagePaths,
  writeProxyWarMatchPackageArtifacts,
} from "./ProxyWarMatchPackage";
import { isPersonalityDiplomacyActionKind } from "./AgentPersonalityDiplomacyPolicy";

export interface AgentRunRosterEntry {
  agentID: string;
  username: string;
  profile: AgentStrategyProfile;
  clientID: string | null;
  brainType: AgentBrainType;
}

export interface AgentRunFinalPlayerState {
  agentID: string;
  username: string;
  profile: AgentStrategyProfile;
  type?: string | null;
  playerID: string | null;
  isAlive: boolean | null;
  tilesOwned: number | null;
  troops: number | null;
  gold: string | null;
}

export interface AgentRunFinalState {
  phase: string;
  tick: number | null;
  turnCount: number | null;
  players: AgentRunFinalPlayerState[];
  opponents?: AgentRunFinalPlayerState[];
}

export interface WriteAgentLeagueRunArtifactsInput {
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: AgentBrainType;
  runnerMode?: "realtime" | "step-locked";
  runnerConfig?: {
    turnsPerDecisionStep?: number | null;
    turnsPerDecisionSchedule?: number[] | null;
    maxDecisionMs?: number | null;
    maxSteps?: number | null;
    stepsCompleted?: number | null;
    mirrorCatchupSucceeded?: boolean | null;
    onlyHoldReason?: string | null;
    replayTailTurns?: number | null;
    agents?: number | null;
    bots?: number | null;
    nations?: number | string | null;
    map?: string | null;
    mapSize?: string | null;
    difficulty?: string | null;
    variedSpawns?: boolean | null;
  };
  startedAt: number;
  completedAt: number;
  records: AgentDecisionRecord[];
  roster: AgentRunRosterEntry[];
  finalState?: AgentRunFinalState;
  spectatorReplay?: AgentSpectatorReplay;
  gameRecord?: GameRecord | null;
  rootDir?: string;
  notes?: string[];
}

export interface AgentLeagueRunArtifactPaths {
  runID: string;
  directory: string;
  decisionsPath: string;
  summaryPath: string;
  reportPath: string;
  visualReportPath: string;
  scorecardJsonPath: string;
  scorecardMarkdownPath: string;
  externalAgentFeedbackJsonPath: string;
  externalAgentFeedbackMarkdownPath: string;
  behaviorQualityJsonPath: string;
  behaviorQualityMarkdownPath: string;
  matchStoryJsonPath: string;
  matchStoryMarkdownPath: string;
  matchPackageJsonPath: string;
  matchPackageMarkdownPath: string;
  matchPackageHtmlPath: string;
  spectatorTelemetryPath: string;
  spectatorPath: string | null;
  spectatorReplayPath: string | null;
  gameRecordPath: string | null;
}

interface DecisionLogEntry {
  runID: string;
  matchID: string;
  sequence: number;
  timestamp: string;
  turnNumber: number;
  agentID: string;
  username: string;
  profile: AgentStrategyProfile;
  brainType: AgentBrainType;
  runtimeMode?: AgentRuntimeMode;
  plannerSource?: string;
  executorSource?: string;
  actionSelectionSource?: string;
  externalPlannerCall?: boolean;
  externalActionCall?: boolean;
  rawProviderOutputPresent?: boolean;
  decisionLatencyMs: number;
  observationSummary: string;
  strategicPriority?: AgentDecisionRecord["strategicPriority"];
  strategicUrgency?: AgentDecisionRecord["strategicUrgency"];
  strategicSummary?: string;
  memorySummary?: string;
  objectiveKind?: AgentObjectiveKind;
  objectiveSummary?: string;
  objectiveAligned?: boolean;
  planObjective?: string;
  planRationale?: string;
  planFollowed?: boolean;
  plannerRan?: boolean;
  plannerLatencyMs?: number;
  plannerFallbackUsed?: boolean;
  plannerRefreshReason?: string;
  plannerRawOutput?: string;
  plannerParseSuccess?: boolean;
  plannerParseFailureReason?: string;
  selectedSkill?: string;
  selectedSkillScore?: number;
  skillSummary?: string;
  alternativesConsidered?: string;
  blockedHostileAttackSummary?: string;
  holdReasonCategory?: string;
  legalActionIDsByKind: Partial<Record<LegalActionKind, string[]>>;
  batchActionIDs?: string[];
  batchIndex?: number;
  selectedLegalActionId: string;
  selectedActionKind: LegalActionKind;
  selectedActionMetadata?: Record<string, string | number | boolean | null>;
  tacticalAffordances?: AgentTacticalAffordances;
  reason: string;
  confidence?: number;
  rawLlmPrompt?: string;
  rawLlmOutput?: string;
  parseSuccess?: boolean;
  parseFailureReason?: string;
  fallbackUsed: boolean;
  fallbackActionID?: string;
  generatedIntent: AgentDecisionRecord["intent"];
  result: AgentDecisionRecord["result"];
  auditStatus: AgentActionAudit["auditStatus"];
  auditReason: string;
  auditBefore?: AgentActionAudit["before"];
  auditAfter?: AgentActionAudit["after"];
  auditTargetBefore?: AgentActionAudit["targetBefore"];
  auditTargetAfter?: AgentActionAudit["targetAfter"];
}

interface FrontierConversionTimingLogGroup {
  entries: DecisionLogEntry[];
  affordances: AgentFrontierConversionTimingAffordance[];
  strategicWindow: boolean;
  executorReady: boolean;
  recommended: boolean;
  actedOn: boolean;
  ownTileShare: number | null;
  bestTargetRelativeTroopRatio: number | null;
  bestExecutorReadyRelativeTroopRatio: number | null;
}

interface FrontierFinishPressureLogGroup {
  entries: DecisionLogEntry[];
  affordances: AgentFrontierFinishPressureAffordance[];
  repeatedLowCommitmentProbe: boolean;
  recommended: boolean;
  actedOn: boolean;
  bestTargetRelativeTroopRatio: number | null;
  bestAttackTroopPercent: number | null;
}

interface OpeningExpansionTempoLogGroup {
  entries: DecisionLogEntry[];
  affordances: AgentOpeningExpansionTempoAffordance[];
  openingWindow: boolean;
  recommended: boolean;
  actedOn: boolean;
  ownTileShare: number | null;
  leaderTileShareGap: number | null;
}

interface TransportTroopBankingLogGroup {
  entries: DecisionLogEntry[];
  affordances: AgentTransportTroopBankingAffordance[];
  nearCap: boolean;
  recommended: boolean;
  actedOn: boolean;
  activeBank: boolean;
  maxEffectiveFutureTroopRatio: number | null;
}

interface EconomyCadenceLogGroup {
  entries: DecisionLogEntry[];
  affordances: AgentEconomyCadenceAffordance[];
  recommended: boolean;
  actedOn: boolean;
  ownTileShare: number | null;
  recentExpansionCount: number | null;
  safeEconomyBuildActionCount: number | null;
}

interface NavalControlLogGroup {
  entries: DecisionLogEntry[];
  affordances: AgentNavalControlAffordance[];
  recommended: boolean;
  actedOn: boolean;
  activeTransportCount: number | null;
  safeNavalActionCount: number | null;
}

interface LateGameStrikeTargetingLogGroup {
  entries: DecisionLogEntry[];
  affordances: AgentLateGameStrikeTargetingAffordance[];
  recommended: boolean;
  actedOn: boolean;
  bestStrikeScore: number | null;
  highValueStrikeActionCount: number | null;
}

interface PersonalityDiplomacyPressureLogGroup {
  entries: DecisionLogEntry[];
  affordances: AgentPersonalityDiplomacyPressureAffordance[];
  recommended: boolean;
  actedOn: boolean;
  socialActionCount: number | null;
  bestSocialScore: number | null;
}

export async function writeAgentLeagueRunArtifacts(
  input: WriteAgentLeagueRunArtifactsInput,
): Promise<AgentLeagueRunArtifactPaths> {
  const directory = path.join(
    input.rootDir ?? path.join(process.cwd(), "artifacts", "ai-league-runs"),
    safePathSegment(input.runID),
  );
  await fs.mkdir(directory, { recursive: true });

  const decisionsPath = path.join(directory, "decisions.jsonl");
  const summaryPath = path.join(directory, "match-summary.json");
  const reportPath = path.join(directory, "match-report.md");
  const visualReportPath = path.join(directory, "visual-report.html");
  const entries = input.records.map((record) =>
    decisionLogEntry(input, record),
  );
  const scorecard = buildAgentObjectiveScorecard({
    runID: input.runID,
    matchID: input.matchID,
    scenario: input.scenario,
    brainMode: input.brainMode,
    records: input.records,
  });
  const scorecardPaths = await writeAgentObjectiveScorecardArtifacts({
    scorecard,
    directory,
  });
  const externalFeedback = buildExternalAgentFeedback({
    runID: input.runID,
    matchID: input.matchID,
    scenario: input.scenario,
    brainMode: input.brainMode,
    records: input.records,
    scorecard,
  });
  const externalFeedbackPaths = await writeExternalAgentFeedbackArtifacts({
    feedback: externalFeedback,
    directory,
  });
  const matchStory = buildAgentMatchStory({
    runID: input.runID,
    matchID: input.matchID,
    scenario: input.scenario,
    brainMode: input.brainMode,
    records: input.records,
  });
  const matchStoryPaths = await writeAgentMatchStoryArtifacts({
    story: matchStory,
    directory,
  });
  const behaviorQuality = buildAgentBehaviorQualityReport({
    runID: input.runID,
    matchID: input.matchID,
    scenario: input.scenario,
    brainMode: input.brainMode,
    records: input.records,
  });
  const behaviorQualityPaths = await writeAgentBehaviorQualityArtifacts({
    report: behaviorQuality,
    directory,
  });
  const spectatorPaths =
    input.spectatorReplay === undefined
      ? null
      : await writeAgentSpectatorReplayArtifacts({
          replay: input.spectatorReplay,
          directory,
          gameRecord: input.gameRecord,
        });
  const spectatorTelemetry = buildAgentSpectatorTelemetry({
    runID: input.runID,
    records: input.records,
    roster: input.roster,
    finalState: input.finalState,
  });
  const spectatorTelemetryPath = path.join(
    directory,
    "spectator-telemetry.json",
  );
  const summary = matchSummary(
    input,
    entries,
    scorecard,
    externalFeedback,
    matchStory,
    behaviorQuality,
    spectatorPaths,
    spectatorTelemetry,
  );
  const matchPackagePaths = await writeProxyWarMatchPackageArtifacts({
    directory,
    summary,
  });

  await fs.writeFile(
    decisionsPath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  await fs.writeFile(
    spectatorTelemetryPath,
    `${JSON.stringify(spectatorTelemetry, null, 2)}\n`,
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(
    reportPath,
    matchReport(
      input,
      summary,
      entries,
      scorecard,
      externalFeedback,
      matchStory,
      behaviorQuality,
    ),
  );
  await fs.writeFile(
    visualReportPath,
    visualReport(
      input,
      summary,
      entries,
      scorecard,
      externalFeedback,
      matchStory,
      behaviorQuality,
      {
        decisionsPath,
        summaryPath,
        reportPath,
        scorecardPaths,
        externalFeedbackPaths,
        behaviorQualityPaths,
        matchStoryPaths,
        matchPackagePaths,
        spectatorTelemetryPath,
        spectatorPaths,
      },
    ),
  );

  return {
    runID: input.runID,
    directory,
    decisionsPath,
    summaryPath,
    reportPath,
    visualReportPath,
    scorecardJsonPath: scorecardPaths.jsonPath,
    scorecardMarkdownPath: scorecardPaths.markdownPath,
    externalAgentFeedbackJsonPath: externalFeedbackPaths.jsonPath,
    externalAgentFeedbackMarkdownPath: externalFeedbackPaths.markdownPath,
    behaviorQualityJsonPath: behaviorQualityPaths.jsonPath,
    behaviorQualityMarkdownPath: behaviorQualityPaths.markdownPath,
    matchStoryJsonPath: matchStoryPaths.jsonPath,
    matchStoryMarkdownPath: matchStoryPaths.markdownPath,
    matchPackageJsonPath: matchPackagePaths.jsonPath,
    matchPackageMarkdownPath: matchPackagePaths.markdownPath,
    matchPackageHtmlPath: matchPackagePaths.htmlPath,
    spectatorTelemetryPath,
    spectatorPath: spectatorPaths?.spectatorPath ?? null,
    spectatorReplayPath: spectatorPaths?.replayDataPath ?? null,
    gameRecordPath: spectatorPaths?.gameRecordPath ?? null,
  };
}

function decisionLogEntry(
  input: WriteAgentLeagueRunArtifactsInput,
  record: AgentDecisionRecord,
): DecisionLogEntry {
  const metadata = record.decisionMetadata ?? {};
  const audit = record.audit ?? fallbackAudit(record);
  return {
    runID: input.runID,
    matchID: input.matchID,
    sequence: record.sequence,
    timestamp: new Date(record.decidedAt).toISOString(),
    turnNumber: record.turnNumber,
    agentID: record.agentID,
    username: record.username,
    profile: record.profile,
    brainType: record.brainType,
    ...(stringMetadata(metadata, "runtimeMode") !== undefined
      ? {
          runtimeMode: stringMetadata(
            metadata,
            "runtimeMode",
          ) as AgentRuntimeMode,
        }
      : {}),
    ...(stringMetadata(metadata, "plannerSource") !== undefined
      ? { plannerSource: stringMetadata(metadata, "plannerSource") }
      : {}),
    ...(stringMetadata(metadata, "executorSource") !== undefined
      ? { executorSource: stringMetadata(metadata, "executorSource") }
      : {}),
    ...(stringMetadata(metadata, "actionSelectionSource") !== undefined
      ? {
          actionSelectionSource: stringMetadata(
            metadata,
            "actionSelectionSource",
          ),
        }
      : {}),
    ...(booleanMetadata(metadata, "externalPlannerCall") !== undefined
      ? {
          externalPlannerCall: booleanMetadata(metadata, "externalPlannerCall"),
        }
      : {}),
    ...(booleanMetadata(metadata, "externalActionCall") !== undefined
      ? { externalActionCall: booleanMetadata(metadata, "externalActionCall") }
      : {}),
    ...(booleanMetadata(metadata, "rawProviderOutputPresent") !== undefined
      ? {
          rawProviderOutputPresent: booleanMetadata(
            metadata,
            "rawProviderOutputPresent",
          ),
        }
      : {}),
    decisionLatencyMs: record.decisionLatencyMs,
    observationSummary: record.observationSummary,
    ...(record.strategicPriority !== undefined
      ? { strategicPriority: record.strategicPriority }
      : {}),
    ...(record.strategicUrgency !== undefined
      ? { strategicUrgency: record.strategicUrgency }
      : {}),
    ...(record.strategicSummary !== undefined
      ? { strategicSummary: record.strategicSummary }
      : {}),
    ...(record.memorySummary !== undefined
      ? { memorySummary: record.memorySummary }
      : {}),
    ...(record.objectiveKind !== undefined
      ? { objectiveKind: record.objectiveKind }
      : {}),
    ...(record.objectiveSummary !== undefined
      ? { objectiveSummary: record.objectiveSummary }
      : {}),
    ...(record.objectiveAligned !== undefined
      ? { objectiveAligned: record.objectiveAligned }
      : {}),
    ...(stringMetadata(metadata, "planObjective") !== undefined
      ? { planObjective: stringMetadata(metadata, "planObjective") }
      : {}),
    ...(stringMetadata(metadata, "planRationale") !== undefined
      ? { planRationale: stringMetadata(metadata, "planRationale") }
      : {}),
    ...(booleanMetadata(metadata, "planFollowed") !== undefined
      ? { planFollowed: booleanMetadata(metadata, "planFollowed") }
      : {}),
    ...(stringMetadata(metadata, "planPlannerSource") !== undefined &&
    stringMetadata(metadata, "plannerSource") === undefined
      ? { plannerSource: stringMetadata(metadata, "planPlannerSource") }
      : {}),
    ...(booleanMetadata(metadata, "plannerRan") !== undefined
      ? { plannerRan: booleanMetadata(metadata, "plannerRan") }
      : {}),
    ...(numberMetadata(metadata, "plannerLatencyMs") !== undefined
      ? { plannerLatencyMs: numberMetadata(metadata, "plannerLatencyMs") }
      : {}),
    ...(booleanMetadata(metadata, "plannerFallbackUsed") !== undefined
      ? {
          plannerFallbackUsed: booleanMetadata(metadata, "plannerFallbackUsed"),
        }
      : {}),
    ...(stringMetadata(metadata, "plannerRefreshReason") !== undefined
      ? {
          plannerRefreshReason: stringMetadata(
            metadata,
            "plannerRefreshReason",
          ),
        }
      : {}),
    ...(stringMetadata(metadata, "plannerRawOutput") !== undefined
      ? { plannerRawOutput: stringMetadata(metadata, "plannerRawOutput") }
      : {}),
    ...(booleanMetadata(metadata, "plannerParseOk") !== undefined
      ? { plannerParseSuccess: booleanMetadata(metadata, "plannerParseOk") }
      : {}),
    ...(stringMetadata(metadata, "plannerParseFailureReason") !== undefined
      ? {
          plannerParseFailureReason: stringMetadata(
            metadata,
            "plannerParseFailureReason",
          ),
        }
      : {}),
    ...(stringMetadata(metadata, "selectedSkill") !== undefined
      ? { selectedSkill: stringMetadata(metadata, "selectedSkill") }
      : {}),
    ...(numberMetadata(metadata, "selectedSkillScore") !== undefined
      ? { selectedSkillScore: numberMetadata(metadata, "selectedSkillScore") }
      : {}),
    ...(stringMetadata(metadata, "skillSummary") !== undefined
      ? { skillSummary: stringMetadata(metadata, "skillSummary") }
      : {}),
    ...(stringMetadata(metadata, "alternativesConsidered") !== undefined
      ? {
          alternativesConsidered: stringMetadata(
            metadata,
            "alternativesConsidered",
          ),
        }
      : {}),
    ...(stringMetadata(metadata, "blockedHostileAttackSummary") !== undefined
      ? {
          blockedHostileAttackSummary: stringMetadata(
            metadata,
            "blockedHostileAttackSummary",
          ),
        }
      : {}),
    ...(stringMetadata(metadata, "holdReasonCategory") !== undefined
      ? { holdReasonCategory: stringMetadata(metadata, "holdReasonCategory") }
      : {}),
    legalActionIDsByKind: record.legalActionIDsByKind,
    ...(stringMetadata(metadata, "batchActionIDs") !== undefined
      ? {
          batchActionIDs:
            stringMetadata(metadata, "batchActionIDs")
              ?.split(",")
              .map((actionID) => actionID.trim())
              .filter((actionID) => actionID.length > 0) ?? [],
        }
      : {}),
    ...(numberMetadata(metadata, "batchIndex") !== undefined
      ? { batchIndex: numberMetadata(metadata, "batchIndex") }
      : {}),
    selectedLegalActionId: record.chosenActionID,
    selectedActionKind: record.chosenActionKind,
    ...(record.chosenActionMetadata
      ? { selectedActionMetadata: record.chosenActionMetadata }
      : {}),
    ...(record.tacticalAffordances
      ? { tacticalAffordances: record.tacticalAffordances }
      : {}),
    reason: record.reason,
    ...(numberMetadata(metadata, "llmConfidence") !== undefined ||
    numberMetadata(metadata, "confidence") !== undefined
      ? {
          confidence:
            numberMetadata(metadata, "llmConfidence") ??
            numberMetadata(metadata, "confidence"),
        }
      : {}),
    ...(stringMetadata(metadata, "llmPrompt") !== undefined
      ? { rawLlmPrompt: stringMetadata(metadata, "llmPrompt") }
      : {}),
    ...(stringMetadata(metadata, "llmRawOutput") !== undefined ||
    stringMetadata(metadata, "externalRawOutput") !== undefined
      ? {
          rawLlmOutput:
            stringMetadata(metadata, "llmRawOutput") ??
            stringMetadata(metadata, "externalRawOutput"),
        }
      : {}),
    ...(booleanMetadata(metadata, "llmParseOk") !== undefined ||
    booleanMetadata(metadata, "parseSuccess") !== undefined
      ? {
          parseSuccess:
            booleanMetadata(metadata, "llmParseOk") ??
            booleanMetadata(metadata, "parseSuccess"),
        }
      : {}),
    ...(stringMetadata(metadata, "llmParseFailureReason") !== undefined ||
    stringMetadata(metadata, "externalFailureReason") !== undefined
      ? {
          parseFailureReason:
            stringMetadata(metadata, "llmParseFailureReason") ??
            stringMetadata(metadata, "externalFailureReason"),
        }
      : {}),
    fallbackUsed: booleanMetadata(metadata, "fallbackUsed") ?? false,
    ...(stringMetadata(metadata, "fallbackActionID") !== undefined
      ? { fallbackActionID: stringMetadata(metadata, "fallbackActionID") }
      : {}),
    generatedIntent: record.intent,
    result: record.result,
    auditStatus: audit.auditStatus,
    auditReason: audit.auditReason,
    ...(audit.before !== undefined ? { auditBefore: audit.before } : {}),
    ...(audit.after !== undefined ? { auditAfter: audit.after } : {}),
    ...(audit.targetBefore !== undefined
      ? { auditTargetBefore: audit.targetBefore }
      : {}),
    ...(audit.targetAfter !== undefined
      ? { auditTargetAfter: audit.targetAfter }
      : {}),
  };
}

function matchSummary(
  input: WriteAgentLeagueRunArtifactsInput,
  entries: DecisionLogEntry[],
  scorecard: AgentObjectiveScorecard,
  externalFeedback: ExternalAgentFeedback,
  matchStory: AgentMatchStory,
  behaviorQuality: AgentBehaviorQualityReport,
  spectatorPaths: AgentSpectatorReplayPaths | null = null,
  spectatorTelemetry: SpectatorTelemetry | null = null,
) {
  const actionCounts = entries.reduce<Partial<Record<LegalActionKind, number>>>(
    (counts, entry) => {
      counts[entry.selectedActionKind] =
        (counts[entry.selectedActionKind] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const strategicPriorityCounts = entries.reduce<Record<string, number>>(
    (counts, entry) => {
      const priority = entry.strategicPriority ?? "unknown";
      counts[priority] = (counts[priority] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const objectiveCounts = entries.reduce<Record<string, number>>(
    (counts, entry) => {
      const objective = entry.objectiveKind ?? "none";
      counts[objective] = (counts[objective] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const objectiveEntries = entries.filter(
    (entry) => entry.objectiveAligned !== undefined,
  );
  const objectiveAlignedDecisionCount = entries.filter(
    (entry) => entry.objectiveAligned === true,
  ).length;
  const frontierConversionTiming = frontierConversionTimingSummary(entries);
  const frontierFinishPressure = frontierFinishPressureSummary(entries);
  const openingExpansionTempo = openingExpansionTempoSummary(entries);
  const economyCadence = economyCadenceSummary(entries);
  const navalControl = navalControlSummary(entries);
  const lateGameStrikeTargeting = lateGameStrikeTargetingSummary(entries);
  const personalityDiplomacyPressure =
    personalityDiplomacyPressureSummary(entries);
  const transportTroopBanking = transportTroopBankingSummary(entries);

  return {
    runID: input.runID,
    matchID: input.matchID,
    scenario: input.scenario,
    brainMode: input.brainMode,
    runnerMode: input.runnerMode ?? "realtime",
    runnerConfig: input.runnerConfig ?? null,
    startedAt: new Date(input.startedAt).toISOString(),
    completedAt: new Date(input.completedAt).toISOString(),
    durationMs: input.completedAt - input.startedAt,
    roster: input.roster,
    decisionCount: entries.length,
    acceptedCount: entries.filter((entry) => entry.result.accepted).length,
    rejectedCount: entries.filter((entry) => !entry.result.accepted).length,
    fallbackCount: entries.filter((entry) => entry.fallbackUsed).length,
    parseFailureCount: entries.filter(
      (entry) =>
        entry.parseSuccess === false || entry.plannerParseSuccess === false,
    ).length,
    postSpawnNonHoldActionCount: entries.filter(
      (entry) =>
        entry.turnNumber > 0 &&
        entry.selectedActionKind !== "hold" &&
        entry.selectedActionKind !== "spawn",
    ).length,
    confirmedEffectCount: entries.filter(
      (entry) => entry.auditStatus === "confirmed",
    ).length,
    unknownEffectCount: entries.filter(
      (entry) => entry.auditStatus === "unknown",
    ).length,
    failedEffectCount: entries.filter((entry) => entry.auditStatus === "failed")
      .length,
    notApplicableEffectCount: entries.filter(
      (entry) => entry.auditStatus === "not_applicable",
    ).length,
    averageDecisionLatencyMs:
      entries.length === 0
        ? 0
        : Math.round(
            entries.reduce((sum, entry) => sum + entry.decisionLatencyMs, 0) /
              entries.length,
          ),
    actionCounts,
    strategicPriorityCounts,
    objectiveCounts,
    objectiveAlignedDecisionCount,
    objectiveAlignmentRate:
      objectiveEntries.length === 0
        ? 0
        : Math.round(
            (objectiveAlignedDecisionCount / objectiveEntries.length) * 100,
          ) / 100,
    tacticalAffordances: {
      frontierConversionTiming,
      frontierFinishPressure,
      openingExpansionTempo,
      economyCadence,
      navalControl,
      lateGameStrikeTargeting,
      personalityDiplomacyPressure,
      transportTroopBanking,
    },
    objectiveScore: scorecard.aggregate.totalObjectiveScore,
    objectiveScoreGrade: scorecard.aggregate.grade,
    objectiveScoreSummary: scorecard.aggregate.summary,
    objectiveScorecardPath: "objective-scorecard.json",
    objectiveScorecardMarkdownPath: "objective-scorecard.md",
    externalAgentFeedbackPath: "external-agent-feedback.json",
    externalAgentFeedbackMarkdownPath: "external-agent-feedback.md",
    externalAgentFeedbackSummary: externalFeedback.aggregate.summary,
    externalAgentCount: externalFeedback.aggregate.externalAgentCount,
    externalAgentReadyForDeveloperReview:
      externalFeedback.aggregate.readyForDeveloperReview,
    externalAgentTopSuggestions: externalFeedback.aggregate.topSuggestions,
    behaviorQuality: behaviorQualitySummary(
      behaviorQuality,
      "behavior-quality-report.md",
    ),
    behaviorQualityPath: "behavior-quality-report.json",
    behaviorQualityMarkdownPath: "behavior-quality-report.md",
    matchStoryPath: "match-story.json",
    matchStoryMarkdownPath: "match-story.md",
    matchPackagePath: "match-package.json",
    matchPackageMarkdownPath: "match-package.md",
    matchPackageHtmlPath: "match-package.html",
    spectatorTelemetryPath: "spectator-telemetry.json",
    spectatorTelemetry: {
      agentCount: spectatorTelemetry?.agents.length ?? 0,
      relationshipCount: spectatorTelemetry?.relationships.length ?? 0,
      eventCount: spectatorTelemetry?.events.length ?? 0,
      communicationThreadCount:
        spectatorTelemetry?.communicationThreads.length ?? 0,
      timelineBucketCount: spectatorTelemetry?.timelineBuckets.length ?? 0,
      majorEventCount: (spectatorTelemetry?.events ?? []).filter(
        (event) => event.importance >= 80,
      ).length,
    },
    matchStory: {
      entertainmentScore: matchStory.entertainmentScore,
      grade: matchStory.grade,
      summary: matchStory.summary,
      actionDiversityCount: matchStory.actionDiversityCount,
      profileDifferentiation: matchStory.profileDifferentiation,
      boringnessWarnings: matchStory.boringnessWarnings,
      spectatorHighlights: matchStory.spectatorHighlights,
      improvementSuggestions: matchStory.improvementSuggestions,
    },
    plannerRunCount: entries.filter((entry) => entry.plannerRan).length,
    plannerFallbackCount: entries.filter((entry) => entry.plannerFallbackUsed)
      .length,
    planFollowedCount: entries.filter((entry) => entry.planFollowed === true)
      .length,
    runtimeModes: entries.reduce<Record<string, number>>((counts, entry) => {
      const mode = entry.runtimeMode ?? "unknown";
      counts[mode] = (counts[mode] ?? 0) + 1;
      return counts;
    }, {}),
    externalPlannerCallCount: entries.filter(
      (entry) => entry.externalPlannerCall === true,
    ).length,
    externalActionCallCount: entries.filter(
      (entry) => entry.externalActionCall === true,
    ).length,
    rawProviderOutputRecordCount: entries.filter(
      (entry) => entry.rawProviderOutputPresent === true,
    ).length,
    spectator:
      input.spectatorReplay === undefined
        ? null
        : {
            replayKind: input.spectatorReplay.replayKind,
            readOnly: input.spectatorReplay.readOnly,
            spectatorOccupiesPlayerSlot:
              input.spectatorReplay.spectatorOccupiesPlayerSlot,
            snapshotCount: input.spectatorReplay.snapshots.length,
            spectatorPath:
              spectatorPaths === undefined ? null : "spectator.html",
            spectatorReplayPath:
              spectatorPaths === undefined ? null : "spectator-replay.json",
            spectatorTelemetryPath: "spectator-telemetry.json",
            gameRecordPath:
              spectatorPaths?.gameRecordPath === null ||
              spectatorPaths?.gameRecordPath === undefined
                ? null
                : "game-record.json",
            openFrontReplayUrl: `/ai-league-replay/${encodeURIComponent(
              input.runID,
            )}`,
          },
    finalState: input.finalState ?? null,
    notes: input.notes ?? [],
  };
}

function frontierConversionTimingSummary(entries: DecisionLogEntry[]) {
  const observed = frontierConversionTimingLogGroups(entries);
  const strategicWindow = observed.filter((group) => group.strategicWindow);
  const executorReady = observed.filter((group) => group.executorReady);
  const recommended = observed.filter((group) => group.recommended);
  const actedOn = recommended.filter((group) => group.actedOn);
  const missed = recommended.filter((group) => !group.actedOn);
  return {
    observedDecisionCount: observed.length,
    strategicWindowDecisionCount: strategicWindow.length,
    executorReadyDecisionCount: executorReady.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    averageRecommendedOwnTileShare: averageRounded(
      recommended.map((group) => group.ownTileShare),
    ),
    averageRecommendedBestTroopRatio: averageRounded(
      recommended.map((group) => group.bestTargetRelativeTroopRatio),
    ),
    averageRecommendedExecutorReadyTroopRatio: averageRounded(
      recommended.map((group) => group.bestExecutorReadyRelativeTroopRatio),
    ),
  };
}

function frontierConversionTimingLogGroups(
  entries: DecisionLogEntry[],
): FrontierConversionTimingLogGroup[] {
  const groups = new Map<string, DecisionLogEntry[]>();
  for (const entry of entries) {
    const affordance = entry.tacticalAffordances?.frontierConversionTiming;
    if (affordance === undefined) {
      continue;
    }
    const key = `${entry.agentID}:${entry.turnNumber}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((groupEntries) => {
    const affordances = groupEntries
      .map((entry) => entry.tacticalAffordances?.frontierConversionTiming)
      .filter(
        (affordance): affordance is AgentFrontierConversionTimingAffordance =>
          affordance !== undefined,
      );
    return {
      entries: groupEntries,
      affordances,
      strategicWindow: affordances.some(
        (affordance) => affordance.strategicWindow,
      ),
      executorReady: affordances.some((affordance) => affordance.executorReady),
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: groupEntries.some(isFrontierConversionEntry),
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

function isFrontierConversionEntry(entry: DecisionLogEntry): boolean {
  return (
    entry.selectedActionKind === "attack" &&
    entry.selectedActionMetadata?.expansion !== true
  );
}

function frontierFinishPressureSummary(entries: DecisionLogEntry[]) {
  const observed = frontierFinishPressureLogGroups(entries);
  const repeatedProbe = observed.filter(
    (group) => group.repeatedLowCommitmentProbe,
  );
  const recommended = observed.filter((group) => group.recommended);
  const actedOn = recommended.filter((group) => group.actedOn);
  const missed = recommended.filter((group) => !group.actedOn);
  return {
    observedDecisionCount: observed.length,
    repeatedProbeDecisionCount: repeatedProbe.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    averageRecommendedBestTroopRatio: averageRounded(
      recommended.map((group) => group.bestTargetRelativeTroopRatio),
    ),
    averageRecommendedBestAttackTroopPercent: averageRounded(
      recommended.map((group) => group.bestAttackTroopPercent),
    ),
  };
}

function frontierFinishPressureLogGroups(
  entries: DecisionLogEntry[],
): FrontierFinishPressureLogGroup[] {
  const groups = new Map<string, DecisionLogEntry[]>();
  for (const entry of entries) {
    const affordance = entry.tacticalAffordances?.frontierFinishPressure;
    if (affordance === undefined) {
      continue;
    }
    const key = `${entry.agentID}:${entry.turnNumber}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((groupEntries) => {
    const affordances = groupEntries
      .map((entry) => entry.tacticalAffordances?.frontierFinishPressure)
      .filter(
        (affordance): affordance is AgentFrontierFinishPressureAffordance =>
          affordance !== undefined,
      );
    return {
      entries: groupEntries,
      affordances,
      repeatedLowCommitmentProbe: affordances.some(
        (affordance) => affordance.repeatedLowCommitmentProbe,
      ),
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: groupEntries.some((entry) =>
        isFrontierFinishPressureEntry(entry, affordances),
      ),
      bestTargetRelativeTroopRatio: maxRounded(
        affordances.map(
          (affordance) => affordance.bestTargetRelativeTroopRatio,
        ),
      ),
      bestAttackTroopPercent: averageRounded(
        affordances.map((affordance) => affordance.bestAttackTroopPercent),
      ),
    };
  });
}

function isFrontierFinishPressureEntry(
  entry: DecisionLogEntry,
  affordances: AgentFrontierFinishPressureAffordance[],
): boolean {
  if (
    entry.selectedActionKind !== "attack" ||
    entry.selectedActionMetadata?.expansion === true
  ) {
    return false;
  }
  const targetID = selectedTargetID(entry);
  return affordances.some(
    (affordance) =>
      affordance.recommended &&
      affordance.bestTargetID !== null &&
      targetID === affordance.bestTargetID,
  );
}

function selectedTargetID(entry: DecisionLogEntry): string | null {
  const metadataTarget = entry.selectedActionMetadata?.targetID;
  if (typeof metadataTarget === "string" && metadataTarget.trim() !== "") {
    return metadataTarget;
  }
  const match = entry.selectedLegalActionId.match(/^attack:([^:]+):/);
  return match?.[1] ?? null;
}

function openingExpansionTempoSummary(entries: DecisionLogEntry[]) {
  const observed = openingExpansionTempoLogGroups(entries);
  const openingWindow = observed.filter((group) => group.openingWindow);
  const recommended = observed.filter((group) => group.recommended);
  const actedOn = recommended.filter((group) => group.actedOn);
  const missed = recommended.filter((group) => !group.actedOn);
  return {
    observedDecisionCount: observed.length,
    openingWindowDecisionCount: openingWindow.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    averageRecommendedOwnTileShare: averageRounded(
      recommended.map((group) => group.ownTileShare),
    ),
    averageRecommendedLeaderGap: averageRounded(
      recommended.map((group) => group.leaderTileShareGap),
    ),
  };
}

function openingExpansionTempoLogGroups(
  entries: DecisionLogEntry[],
): OpeningExpansionTempoLogGroup[] {
  const groups = new Map<string, DecisionLogEntry[]>();
  for (const entry of entries) {
    const affordance = entry.tacticalAffordances?.openingExpansionTempo;
    if (affordance === undefined) {
      continue;
    }
    const key = `${entry.agentID}:${entry.turnNumber}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((groupEntries) => {
    const affordances = groupEntries
      .map((entry) => entry.tacticalAffordances?.openingExpansionTempo)
      .filter(
        (affordance): affordance is AgentOpeningExpansionTempoAffordance =>
          affordance !== undefined,
      );
    return {
      entries: groupEntries,
      affordances,
      openingWindow: affordances.some((affordance) => affordance.openingWindow),
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: groupEntries.some(isOpeningExpansionEntry),
      ownTileShare: averageRounded(
        affordances.map((affordance) => affordance.ownTileShare),
      ),
      leaderTileShareGap: maxRounded(
        affordances.map((affordance) => affordance.leaderTileShareGap),
      ),
    };
  });
}

function isOpeningExpansionEntry(entry: DecisionLogEntry): boolean {
  return (
    (entry.selectedActionKind === "attack" &&
      entry.selectedActionMetadata?.expansion === true) ||
    (entry.selectedActionKind === "boat" &&
      entry.selectedActionMetadata?.targetID === null)
  );
}

function economyCadenceSummary(entries: DecisionLogEntry[]) {
  const observed = economyCadenceLogGroups(entries);
  const recommended = observed.filter((group) => group.recommended);
  const actedOn = recommended.filter((group) => group.actedOn);
  const missed = recommended.filter((group) => !group.actedOn);
  return {
    observedDecisionCount: observed.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    averageRecommendedOwnTileShare: averageRounded(
      recommended.map((group) => group.ownTileShare),
    ),
    averageRecommendedRecentExpansionCount: averageRounded(
      recommended.map((group) => group.recentExpansionCount),
    ),
    averageRecommendedSafeBuildActions: averageRounded(
      recommended.map((group) => group.safeEconomyBuildActionCount),
    ),
  };
}

function economyCadenceLogGroups(
  entries: DecisionLogEntry[],
): EconomyCadenceLogGroup[] {
  const groups = new Map<string, DecisionLogEntry[]>();
  for (const entry of entries) {
    const affordance = entry.tacticalAffordances?.economyCadence;
    if (affordance === undefined) {
      continue;
    }
    const key = `${entry.agentID}:${entry.turnNumber}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((groupEntries) => {
    const affordances = groupEntries
      .map((entry) => entry.tacticalAffordances?.economyCadence)
      .filter(
        (affordance): affordance is AgentEconomyCadenceAffordance =>
          affordance !== undefined,
      );
    return {
      entries: groupEntries,
      affordances,
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: groupEntries.some(isEconomyCadenceEntry),
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

function isEconomyCadenceEntry(entry: DecisionLogEntry): boolean {
  if (entry.selectedActionKind !== "build") {
    return false;
  }
  const unit = String(entry.selectedActionMetadata?.unit ?? "");
  return (
    entry.selectedActionMetadata?.role === "economic" ||
    unit === "City" ||
    unit === "Factory" ||
    unit === "Port"
  );
}

function navalControlSummary(entries: DecisionLogEntry[]) {
  const observed = navalControlLogGroups(entries);
  const recommended = observed.filter((group) => group.recommended);
  const actedOn = recommended.filter((group) => group.actedOn);
  const missed = recommended.filter((group) => !group.actedOn);
  return {
    observedDecisionCount: observed.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    averageRecommendedActiveTransportCount: averageRounded(
      recommended.map((group) => group.activeTransportCount),
    ),
    averageRecommendedSafeNavalActions: averageRounded(
      recommended.map((group) => group.safeNavalActionCount),
    ),
  };
}

function navalControlLogGroups(
  entries: DecisionLogEntry[],
): NavalControlLogGroup[] {
  const groups = new Map<string, DecisionLogEntry[]>();
  for (const entry of entries) {
    const affordance = entry.tacticalAffordances?.navalControl;
    if (affordance === undefined) {
      continue;
    }
    const key = `${entry.agentID}:${entry.turnNumber}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((groupEntries) => {
    const affordances = groupEntries
      .map((entry) => entry.tacticalAffordances?.navalControl)
      .filter(
        (affordance): affordance is AgentNavalControlAffordance =>
          affordance !== undefined,
      );
    return {
      entries: groupEntries,
      affordances,
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: groupEntries.some(isNavalControlEntry),
      activeTransportCount: averageRounded(
        affordances.map((affordance) => affordance.activeTransportCount),
      ),
      safeNavalActionCount: averageRounded(
        affordances.map((affordance) => affordance.safeNavalActionCount),
      ),
    };
  });
}

function isNavalControlEntry(entry: DecisionLogEntry): boolean {
  return (
    entry.selectedActionKind === "boat" ||
    entry.selectedActionKind === "boat_retreat" ||
    entry.selectedActionKind === "warship" ||
    entry.selectedActionKind === "move_warship"
  );
}

function lateGameStrikeTargetingSummary(entries: DecisionLogEntry[]) {
  const observed = lateGameStrikeTargetingLogGroups(entries);
  const recommended = observed.filter((group) => group.recommended);
  const actedOn = recommended.filter((group) => group.actedOn);
  const missed = recommended.filter((group) => !group.actedOn);
  return {
    observedDecisionCount: observed.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    averageRecommendedBestStrikeScore: averageRounded(
      recommended.map((group) => group.bestStrikeScore),
    ),
    averageRecommendedHighValueStrikes: averageRounded(
      recommended.map((group) => group.highValueStrikeActionCount),
    ),
  };
}

function lateGameStrikeTargetingLogGroups(
  entries: DecisionLogEntry[],
): LateGameStrikeTargetingLogGroup[] {
  const groups = new Map<string, DecisionLogEntry[]>();
  for (const entry of entries) {
    const affordance = entry.tacticalAffordances?.lateGameStrikeTargeting;
    if (affordance === undefined) {
      continue;
    }
    const key = `${entry.agentID}:${entry.turnNumber}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((groupEntries) => {
    const affordances = groupEntries
      .map((entry) => entry.tacticalAffordances?.lateGameStrikeTargeting)
      .filter(
        (affordance): affordance is AgentLateGameStrikeTargetingAffordance =>
          affordance !== undefined,
      );
    return {
      entries: groupEntries,
      affordances,
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: groupEntries.some(
        (entry) => entry.selectedActionKind === "nuke",
      ),
      bestStrikeScore: maxRounded(
        affordances.map((affordance) => affordance.bestStrikeScore),
      ),
      highValueStrikeActionCount: averageRounded(
        affordances.map((affordance) => affordance.highValueStrikeActionCount),
      ),
    };
  });
}

function personalityDiplomacyPressureSummary(entries: DecisionLogEntry[]) {
  const observed = personalityDiplomacyPressureLogGroups(entries);
  const recommended = observed.filter((group) => group.recommended);
  const actedOn = recommended.filter((group) => group.actedOn);
  const missed = recommended.filter((group) => !group.actedOn);
  return {
    observedDecisionCount: observed.length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    averageRecommendedSocialActions: averageRounded(
      recommended.map((group) => group.socialActionCount),
    ),
    averageRecommendedBestSocialScore: averageRounded(
      recommended.map((group) => group.bestSocialScore),
    ),
  };
}

function personalityDiplomacyPressureLogGroups(
  entries: DecisionLogEntry[],
): PersonalityDiplomacyPressureLogGroup[] {
  const groups = new Map<string, DecisionLogEntry[]>();
  for (const entry of entries) {
    const affordance = entry.tacticalAffordances?.personalityDiplomacyPressure;
    if (affordance === undefined) {
      continue;
    }
    const key = `${entry.agentID}:${entry.turnNumber}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((groupEntries) => {
    const affordances = groupEntries
      .map((entry) => entry.tacticalAffordances?.personalityDiplomacyPressure)
      .filter(
        (
          affordance,
        ): affordance is AgentPersonalityDiplomacyPressureAffordance =>
          affordance !== undefined,
      );
    return {
      entries: groupEntries,
      affordances,
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: groupEntries.some((entry) =>
        isPersonalityDiplomacyActionKind(entry.selectedActionKind),
      ),
      socialActionCount: averageRounded(
        affordances.map((affordance) => affordance.socialActionCount),
      ),
      bestSocialScore: maxRounded(
        affordances.map((affordance) => affordance.bestSocialScore),
      ),
    };
  });
}

function transportTroopBankingSummary(entries: DecisionLogEntry[]) {
  const observed = transportTroopBankingLogGroups(entries);
  const recommended = observed.filter((group) => group.recommended);
  const actedOn = recommended.filter((group) => group.actedOn);
  const missed = recommended.filter((group) => !group.actedOn);
  return {
    observedDecisionCount: observed.length,
    nearCapDecisionCount: observed.filter((group) => group.nearCap).length,
    recommendedDecisionCount: recommended.length,
    actedOnDecisionCount: actedOn.length,
    missedDecisionCount: missed.length,
    activeBankDecisionCount: observed.filter((group) => group.activeBank)
      .length,
    maxEffectiveFutureTroopRatio: maxRounded(
      observed.map((group) => group.maxEffectiveFutureTroopRatio),
    ),
  };
}

function transportTroopBankingLogGroups(
  entries: DecisionLogEntry[],
): TransportTroopBankingLogGroup[] {
  const groups = new Map<string, DecisionLogEntry[]>();
  for (const entry of entries) {
    const affordance = entry.tacticalAffordances?.transportTroopBanking;
    if (affordance === undefined) {
      continue;
    }
    const key = `${entry.agentID}:${entry.turnNumber}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((groupEntries) => {
    const affordances = groupEntries
      .map((entry) => entry.tacticalAffordances?.transportTroopBanking)
      .filter(
        (affordance): affordance is AgentTransportTroopBankingAffordance =>
          affordance !== undefined,
      );
    return {
      entries: groupEntries,
      affordances,
      nearCap: affordances.some((affordance) => affordance.nearCap),
      recommended: affordances.some((affordance) => affordance.recommended),
      actedOn: groupEntries.some(
        (entry) => entry.selectedActionKind === "boat",
      ),
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

function matchReport(
  input: WriteAgentLeagueRunArtifactsInput,
  summary: ReturnType<typeof matchSummary>,
  entries: DecisionLogEntry[],
  scorecard: AgentObjectiveScorecard,
  externalFeedback: ExternalAgentFeedback,
  matchStory: AgentMatchStory,
  behaviorQuality: AgentBehaviorQualityReport,
): string {
  const notable = entries.filter((entry) =>
    [
      "alliance_request",
      "attack",
      "build",
      "donate_gold",
      "donate_troops",
      "embargo",
    ].includes(entry.selectedActionKind),
  );
  const fallbacks = entries.filter(
    (entry) =>
      entry.fallbackUsed ||
      (entry.plannerFallbackUsed ?? false) ||
      !entry.result.accepted,
  );

  return [
    `# ProxyWar Run ${input.runID}`,
    "",
    "## Match Overview",
    "",
    `- Match id: ${input.matchID}`,
    `- Scenario: ${input.scenario}`,
    `- Brain mode: ${input.brainMode}`,
    `- Runner mode: ${summary.runnerMode}`,
    ...(summary.runnerConfig?.turnsPerDecisionStep !== undefined &&
    summary.runnerConfig.turnsPerDecisionStep !== null
      ? [
          `- Turns per decision step: ${summary.runnerConfig.turnsPerDecisionStep}`,
        ]
      : []),
    ...(summary.runnerConfig?.turnsPerDecisionSchedule !== undefined &&
    summary.runnerConfig.turnsPerDecisionSchedule !== null
      ? [
          `- Turns per decision schedule: ${summarizeTurnSchedule(
            summary.runnerConfig.turnsPerDecisionSchedule,
          )}`,
        ]
      : []),
    ...(summary.runnerConfig?.replayTailTurns !== undefined &&
    summary.runnerConfig.replayTailTurns !== null
      ? [`- Replay tail turns: ${summary.runnerConfig.replayTailTurns}`]
      : []),
    ...(summary.runnerConfig?.mirrorCatchupSucceeded !== undefined &&
    summary.runnerConfig.mirrorCatchupSucceeded !== null
      ? [
          `- Mirror catch-up succeeded: ${summary.runnerConfig.mirrorCatchupSucceeded ? "yes" : "no"}`,
        ]
      : []),
    `- Started: ${summary.startedAt}`,
    `- Completed: ${summary.completedAt}`,
    `- Decisions: ${summary.decisionCount}`,
    `- Accepted: ${summary.acceptedCount}`,
    `- Rejected: ${summary.rejectedCount}`,
    `- Fallbacks: ${summary.fallbackCount}`,
    `- Post-spawn non-hold actions: ${summary.postSpawnNonHoldActionCount}`,
    `- Behavior quality: ${behaviorQuality.score}/100 (${behaviorQuality.grade}, ${behaviorQuality.pass ? "demo gate passed" : "demo gate failed"})`,
    `- Match story score: ${matchStory.entertainmentScore}/100 (${matchStory.grade})`,
    `- Profile differentiation: ${matchStory.profileDifferentiation.distinctEnough ? "distinct" : "needs review"} (${matchStory.profileDifferentiation.evaluatedProfileCount}/${matchStory.profileDifferentiation.profileCount} profiles, stall risk ${matchStory.profileDifferentiation.stallRisk})`,
    `- Objective alignment: ${summary.objectiveAlignedDecisionCount}/${summary.decisionCount} decisions (${summary.objectiveAlignmentRate})`,
    `- Objective score: ${summary.objectiveScore}/100 (${summary.objectiveScoreGrade})`,
    `- Frontier conversion: ${summary.tacticalAffordances.frontierConversionTiming.actedOnDecisionCount}/${summary.tacticalAffordances.frontierConversionTiming.recommendedDecisionCount} recommended opportunities acted on`,
    `- Frontier finish pressure: ${summary.tacticalAffordances.frontierFinishPressure.actedOnDecisionCount}/${summary.tacticalAffordances.frontierFinishPressure.recommendedDecisionCount} recommended opportunities acted on`,
    `- Opening tempo: ${summary.tacticalAffordances.openingExpansionTempo.actedOnDecisionCount}/${summary.tacticalAffordances.openingExpansionTempo.recommendedDecisionCount} recommended opportunities acted on`,
    `- Economy cadence: ${summary.tacticalAffordances.economyCadence.actedOnDecisionCount}/${summary.tacticalAffordances.economyCadence.recommendedDecisionCount} recommended opportunities acted on`,
    `- Naval control: ${summary.tacticalAffordances.navalControl.actedOnDecisionCount}/${summary.tacticalAffordances.navalControl.recommendedDecisionCount} recommended opportunities acted on`,
    `- Late-game strike targeting: ${summary.tacticalAffordances.lateGameStrikeTargeting.actedOnDecisionCount}/${summary.tacticalAffordances.lateGameStrikeTargeting.recommendedDecisionCount} recommended opportunities acted on`,
    `- Personality diplomacy pressure: ${summary.tacticalAffordances.personalityDiplomacyPressure.actedOnDecisionCount}/${summary.tacticalAffordances.personalityDiplomacyPressure.recommendedDecisionCount} recommended opportunities acted on`,
    `- Transport banking: ${summary.tacticalAffordances.transportTroopBanking.actedOnDecisionCount}/${summary.tacticalAffordances.transportTroopBanking.recommendedDecisionCount} recommended opportunities acted on`,
    `- Planner runs: ${summary.plannerRunCount}`,
    `- Plan-following actions: ${summary.planFollowedCount}`,
    `- Planner fallbacks: ${summary.plannerFallbackCount}`,
    `- Runtime modes: ${JSON.stringify(summary.runtimeModes)}`,
    `- External planner calls: ${summary.externalPlannerCallCount}`,
    `- External action calls: ${summary.externalActionCallCount}`,
    `- External agents: ${summary.externalAgentCount}`,
    `- External-agent feedback: ${summary.externalAgentReadyForDeveloperReview ? "ready" : "needs review"}`,
    `- Raw provider output records: ${summary.rawProviderOutputRecordCount}`,
    `- Effect audits: ${summary.confirmedEffectCount} confirmed / ${summary.unknownEffectCount} unknown / ${summary.failedEffectCount} failed / ${summary.notApplicableEffectCount} not applicable`,
    ...(summary.spectator
      ? [
          `- Spectator replay: spectator.html (${summary.spectator.snapshotCount} snapshots, read-only: ${summary.spectator.readOnly ? "yes" : "no"})`,
        ]
      : []),
    ...(summary.runnerConfig?.onlyHoldReason
      ? [`- Only-hold reason: ${summary.runnerConfig.onlyHoldReason}`]
      : []),
    "",
    "## Agent Roster",
    "",
    markdownTable(
      ["Agent", "Profile", "Brain", "Client"],
      input.roster.map((agent) => [
        agent.username,
        agent.profile,
        agent.brainType,
        agent.clientID ?? "none",
      ]),
    ),
    "",
    "## Behavior Quality Gate",
    "",
    `Full behavior-quality artifacts: [behavior-quality-report.json](behavior-quality-report.json) and [behavior-quality-report.md](behavior-quality-report.md).`,
    "",
    markdownTable(
      [
        "Score",
        "Grade",
        "Gate",
        "Severe",
        "Conversion Miss Rate",
        "Diplomacy Follow-through",
      ],
      [
        [
          `${behaviorQuality.score}/100`,
          behaviorQuality.grade,
          behaviorQuality.pass ? "pass" : "fail",
          String(behaviorQuality.severeIssueCount),
          `${behaviorQuality.aggregate.weakRivalConversionMissCount}/${behaviorQuality.aggregate.weakRivalConversionOpportunityCount} (${Math.round(behaviorQuality.aggregate.weakRivalConversionMissRate * 100)}%)`,
          `${behaviorQuality.aggregate.diplomacyFollowThroughCount}/${behaviorQuality.aggregate.diplomacyActionCount} (${Math.round(behaviorQuality.aggregate.diplomacyFollowThroughRate * 100)}%)`,
        ],
      ],
    ),
    "",
    "**Top behavior issues**",
    "",
    ...(behaviorQuality.topIssues.length === 0
      ? ["- No top behavior issues were detected."]
      : behaviorQuality.topIssues.map((issue) => `- ${issue}`)),
    "",
    "**Why it looked intentional**",
    "",
    ...(behaviorQuality.highlights.length === 0
      ? ["- No intentional-behavior highlights were detected."]
      : behaviorQuality.highlights.map((highlight) => `- ${highlight}`)),
    "",
    "## Objective Scorecard",
    "",
    `Full scorecard artifacts: [objective-scorecard.json](objective-scorecard.json) and [objective-scorecard.md](objective-scorecard.md).`,
    "",
    markdownTable(
      [
        "Agent",
        "Score",
        "Aligned",
        "Accepted",
        "Non-hold",
        "Audit C/U/F",
        "Warnings",
      ],
      scorecard.agents.map((agent) => [
        agent.username,
        `${agent.totalObjectiveScore}/100 (${agent.grade})`,
        `${agent.objectiveAlignedCount}/${agent.objectiveTrackedCount}`,
        `${agent.acceptedCount}/${agent.decisionCount}`,
        `${agent.nonHoldCount}/${agent.postSpawnDecisionCount}`,
        `${agent.confirmedAuditCount}/${agent.unknownAuditCount}/${agent.failedAuditCount}`,
        agent.warnings.join("; ") || "none",
      ]),
    ),
    "",
    "## Match Story",
    "",
    `Full story artifacts: [match-story.json](match-story.json) and [match-story.md](match-story.md).`,
    "",
    `Entertainment score: ${matchStory.entertainmentScore}/100 (${matchStory.grade}).`,
    "",
    matchStory.summary,
    "",
    "**Profile differentiation**",
    "",
    `- Gate: ${matchStory.profileDifferentiation.distinctEnough ? "distinct" : "needs review"}`,
    `- Profiles evaluated: ${matchStory.profileDifferentiation.evaluatedProfileCount}/${matchStory.profileDifferentiation.profileCount}`,
    `- Average action-mix distance: ${matchStory.profileDifferentiation.averagePairwiseDistance ?? "n/a"}`,
    `- Stall risk: ${matchStory.profileDifferentiation.stallRisk}`,
    "",
    "**Spectator highlights**",
    "",
    ...(matchStory.spectatorHighlights.length === 0
      ? ["- No spectator highlights were generated."]
      : matchStory.spectatorHighlights.map((highlight) => `- ${highlight}`)),
    "",
    "**Boringness warnings**",
    "",
    ...(matchStory.boringnessWarnings.length === 0
      ? ["- No major boringness warnings were detected."]
      : matchStory.boringnessWarnings.map((warning) => `- ${warning}`)),
    "",
    "## External Agent Feedback",
    "",
    `Full feedback artifacts: [external-agent-feedback.json](external-agent-feedback.json) and [external-agent-feedback.md](external-agent-feedback.md).`,
    "",
    externalFeedback.agents.length === 0
      ? "No external-http agents were present in this run."
      : markdownTable(
          [
            "Agent",
            "Accepted",
            "Non-hold",
            "Fallbacks",
            "Parser",
            "Top suggestion",
          ],
          externalFeedback.agents.map((agent) => [
            agent.username,
            `${agent.acceptedCount}/${agent.decisionCount}`,
            `${agent.nonHoldCount}/${agent.postSpawnDecisionCount}`,
            String(agent.fallbackCount),
            String(agent.parserFailureCount),
            agent.improvementSuggestions[0] ?? "Keep testing longer matches.",
          ]),
        ),
    "",
    ...(externalFeedback.aggregate.topSuggestions.length === 0
      ? []
      : [
          "Top external-agent suggestions:",
          "",
          ...externalFeedback.aggregate.topSuggestions.map(
            (suggestion) => `- ${suggestion}`,
          ),
          "",
        ]),
    "## Decision Timeline",
    "",
    markdownTable(
      [
        "#",
        "Turn",
        "Agent",
        "Kind",
        "Strategy",
        "Memory",
        "Objective",
        "Aligned",
        "Plan",
        "Skill",
        "Selected",
        "Latency ms",
        "Accepted",
        "Audit",
        "Reason",
      ],
      entries.map((entry) => [
        String(entry.sequence),
        String(entry.turnNumber),
        entry.username,
        entry.selectedActionKind,
        entry.strategicPriority
          ? `${entry.strategicPriority}/${entry.strategicUrgency ?? "unknown"}`
          : "unknown",
        entry.memorySummary ?? "unknown",
        entry.objectiveSummary ?? entry.objectiveKind ?? "none",
        entry.objectiveAligned === undefined
          ? "n/a"
          : entry.objectiveAligned
            ? "yes"
            : "no",
        planLabel(entry),
        skillLabel(entry),
        entry.selectedLegalActionId,
        String(entry.decisionLatencyMs),
        entry.result.accepted ? "yes" : "no",
        `${entry.auditStatus}: ${entry.auditReason}`,
        entry.reason,
      ]),
    ),
    "",
    "## Notable Actions",
    "",
    notable.length === 0
      ? "No non-hold notable actions were selected."
      : markdownTable(
          ["#", "Agent", "Kind", "Action", "Intent"],
          notable.map((entry) => [
            String(entry.sequence),
            entry.username,
            entry.selectedActionKind,
            entry.selectedLegalActionId,
            entry.generatedIntent === null
              ? "none"
              : JSON.stringify(entry.generatedIntent),
          ]),
        ),
    "",
    "## Invalid Or Fallback Decisions",
    "",
    fallbacks.length === 0
      ? "No rejected or fallback decisions were recorded."
      : markdownTable(
          ["#", "Agent", "Selected", "Fallback", "Result"],
          fallbacks.map((entry) => [
            String(entry.sequence),
            entry.username,
            entry.selectedLegalActionId,
            entry.fallbackActionID ?? "none",
            entry.result.reason,
          ]),
        ),
    "",
    "## Action Effect Audits",
    "",
    markdownTable(
      ["#", "Agent", "Kind", "Status", "Reason"],
      entries.map((entry) => [
        String(entry.sequence),
        entry.username,
        entry.selectedActionKind,
        entry.auditStatus,
        entry.auditReason,
      ]),
    ),
    "",
    "## Spectator Replay",
    "",
    summary.spectator
      ? [
          "A local read-only spectator replay is available at `spectator.html`.",
          "",
          `- Snapshot replay data: ${summary.spectator.spectatorReplayPath ?? "not written"}`,
          `- Spectator telemetry: ${summary.spectator.spectatorTelemetryPath ?? summary.spectatorTelemetryPath}`,
          `- Native ProxyWar GameRecord hook: ${summary.spectator.gameRecordPath ?? "not written"}`,
          "- This artifact viewer does not open a GameServer socket, does not create a player, and cannot submit intents.",
          `- Real ProxyWar renderer route: /ai-league-replay/${encodeURIComponent(input.runID)}`,
        ].join("\n")
      : "Spectator replay was not generated for this run.",
    "",
    "## Final Known State",
    "",
    "```json",
    JSON.stringify(input.finalState ?? null, null, 2),
    "```",
    "",
    "## Limitations",
    "",
    ...(input.notes?.length
      ? input.notes.map((note) => `- ${note}`)
      : [
          "- Artifacts record the local in-process smoke path, not a distributed worker match.",
          "- Final state is a compact snapshot, not a full replay file.",
          "- LLM output is still constrained to selecting an offered LegalAction.id.",
        ]),
    "",
  ].join("\n");
}

function visualReport(
  input: WriteAgentLeagueRunArtifactsInput,
  summary: ReturnType<typeof matchSummary>,
  entries: DecisionLogEntry[],
  scorecard: AgentObjectiveScorecard,
  externalFeedback: ExternalAgentFeedback,
  matchStory: AgentMatchStory,
  behaviorQuality: AgentBehaviorQualityReport,
  paths: {
    decisionsPath: string;
    summaryPath: string;
    reportPath: string;
    scorecardPaths: AgentObjectiveScorecardPaths;
    externalFeedbackPaths: ExternalAgentFeedbackPaths;
    behaviorQualityPaths: AgentBehaviorQualityReportPaths;
    matchStoryPaths: AgentMatchStoryPaths;
    matchPackagePaths: ProxyWarMatchPackagePaths;
    spectatorTelemetryPath: string;
    spectatorPaths: AgentSpectatorReplayPaths | null;
  },
): string {
  const timelineSections = groupedTimeline(entries)
    .map(
      (group) => `
        <section class="timeline-phase">
          <h3>${escapeHtml(group.label)}</h3>
          ${group.entries
            .map(
              (entry) => `
                <article class="decision-card">
                  <div class="decision-head">
                    <div>
                      <strong>${escapeHtml(entry.username)}</strong>
                      <span>${escapeHtml(entry.profile)} · turn ${entry.turnNumber}</span>
                    </div>
                    <div class="badges">
                      ${actionBadge(entry.selectedActionKind)}
                      ${statusBadge(entry.result.accepted ? "accepted" : "rejected")}
                      ${entry.fallbackUsed ? statusBadge("fallback") : ""}
                      ${auditBadge(entry.auditStatus)}
                    </div>
                  </div>
                  <p class="reason">${escapeHtml(entry.reason)}</p>
                  <div class="decision-meta">
                    <div><span>LegalAction.id</span><code>${escapeHtml(entry.selectedLegalActionId)}</code></div>
                    <div><span>Strategy</span><b>${escapeHtml(strategyLabel(entry))}</b></div>
                    <div><span>Memory</span><b>${escapeHtml(entry.memorySummary ?? "unknown")}</b></div>
                    <div><span>Objective</span><b>${escapeHtml(objectiveLabel(entry))}</b></div>
                    <div><span>Objective aligned</span><b>${entry.objectiveAligned === undefined ? "n/a" : entry.objectiveAligned ? "yes" : "no"}</b></div>
                    <div><span>Plan</span><b>${escapeHtml(planLabel(entry))}</b></div>
                    <div><span>Plan followed</span><b>${entry.planFollowed === undefined ? "n/a" : entry.planFollowed ? "yes" : "no"}</b></div>
                    <div><span>Skill</span><b>${escapeHtml(skillLabel(entry))}</b></div>
                    <div><span>Intent</span><code>${escapeHtml(intentSummary(entry.generatedIntent))}</code></div>
                    <div><span>Latency</span><b>${entry.decisionLatencyMs} ms</b></div>
                    <div><span>Audit</span><b>${escapeHtml(entry.auditStatus)}</b></div>
                  </div>
                  <p class="audit-reason">${escapeHtml(entry.auditReason)}</p>
                  <details>
                    <summary>Raw decision details</summary>
                    <pre><code>${escapeHtml(JSON.stringify(entry, null, 2))}</code></pre>
                  </details>
                </article>`,
            )
            .join("\n")}
        </section>`,
    )
    .join("\n");
  const actionRows = entries
    .map(
      (entry) => `
        <tr>
          <td>${entry.sequence}</td>
          <td>${entry.turnNumber}</td>
          <td>${escapeHtml(entry.username)}<span>${escapeHtml(entry.profile)}</span></td>
          <td>${actionBadge(entry.selectedActionKind)}</td>
          <td>${escapeHtml(strategyLabel(entry))}</td>
          <td>${escapeHtml(entry.memorySummary ?? "unknown")}</td>
          <td>${escapeHtml(objectiveLabel(entry))}</td>
          <td>${entry.objectiveAligned === undefined ? "n/a" : entry.objectiveAligned ? statusBadge("aligned") : statusBadge("off-objective")}</td>
          <td>${escapeHtml(planLabel(entry))}</td>
          <td>${entry.planFollowed === undefined ? "n/a" : entry.planFollowed ? statusBadge("aligned") : statusBadge("off-objective")}</td>
          <td>${escapeHtml(skillLabel(entry))}</td>
          <td><code>${escapeHtml(entry.selectedLegalActionId)}</code></td>
          <td>${escapeHtml(entry.reason)}</td>
          <td><code>${escapeHtml(intentSummary(entry.generatedIntent))}</code></td>
          <td>${statusBadge(entry.result.accepted ? "accepted" : "rejected")}<span>${escapeHtml(entry.result.reason)}</span></td>
          <td>${entry.fallbackUsed ? statusBadge("fallback") : "no"}</td>
          <td>${parserBadge(entry)}</td>
          <td>${auditBadge(entry.auditStatus)}<span>${escapeHtml(entry.auditReason)}</span></td>
          <td>${entry.decisionLatencyMs}</td>
        </tr>`,
    )
    .join("\n");
  const storyCards = entries
    .filter((entry) => entry.selectedActionKind !== "hold")
    .map(
      (entry) => `
        <article class="story-card">
          <div class="story-top">
            <b class="kind kind-${escapeHtml(entry.selectedActionKind)}">${escapeHtml(entry.selectedActionKind)}</b>
            <span>Turn ${entry.turnNumber} · ${escapeHtml(entry.username)} · ${entry.result.accepted ? "accepted" : "rejected"}</span>
          </div>
          <p>${escapeHtml(humanAction(entry))}</p>
          <code>${escapeHtml(entry.selectedLegalActionId)}</code>
        </article>`,
    )
    .join("\n");
  const rosterRows = input.roster
    .map(
      (agent) => `
        <tr>
          <td>${escapeHtml(agent.username)}</td>
          <td>${escapeHtml(agent.profile)}</td>
          <td>${escapeHtml(agent.brainType)}</td>
          <td><code>${escapeHtml(agent.clientID ?? "none")}</code></td>
        </tr>`,
    )
    .join("\n");
  const rosterCards = input.roster
    .map(
      (agent) => `
        <article class="roster-card">
          <strong>${escapeHtml(agent.username)}</strong>
          <span>${escapeHtml(agent.profile)}</span>
          <b>${escapeHtml(agent.brainType)}</b>
          <code>${escapeHtml(agent.clientID ?? "none")}</code>
        </article>`,
    )
    .join("\n");
  const notable = entries.filter(
    (entry) =>
      entry.selectedActionKind !== "hold" &&
      entry.selectedActionKind !== "spawn",
  );
  const scorecardRows = scorecard.agents
    .map(
      (agent) => `
        <tr>
          <td>${escapeHtml(agent.username)}<span>${escapeHtml(agent.profile)}</span></td>
          <td><strong>${agent.totalObjectiveScore}/100</strong><span>${escapeHtml(agent.grade)}</span></td>
          <td>${agent.objectiveAlignedCount}/${agent.objectiveTrackedCount}<span>${percent(agent.objectiveAlignmentRate)}</span></td>
          <td>${agent.acceptedCount}/${agent.decisionCount}<span>${percent(agent.acceptedIntentRate)}</span></td>
          <td>${agent.nonHoldCount}/${agent.postSpawnDecisionCount}<span>${percent(agent.nonHoldRate)}</span></td>
          <td>${agent.confirmedAuditCount}/${agent.unknownAuditCount}/${agent.failedAuditCount}</td>
          <td>${escapeHtml(agent.warnings.join("; ") || "none")}</td>
        </tr>`,
    )
    .join("\n");
  const externalFeedbackRows = externalFeedback.agents
    .map(
      (agent) => `
        <tr>
          <td>${escapeHtml(agent.username)}<span>${escapeHtml(agent.profile)}</span></td>
          <td>${agent.acceptedCount}/${agent.decisionCount}<span>${percent(agent.acceptedRate)}</span></td>
          <td>${agent.nonHoldCount}/${agent.postSpawnDecisionCount}<span>${percent(agent.nonHoldRate)}</span></td>
          <td>${agent.fallbackCount}</td>
          <td>${agent.parserFailureCount}</td>
          <td>${agent.confirmedAuditCount}/${agent.unknownAuditCount}/${agent.failedAuditCount}</td>
          <td>${escapeHtml(agent.improvementSuggestions[0] ?? "Keep testing longer matches.")}</td>
        </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ProxyWar Run ${escapeHtml(input.runID)}</title>
  <style>
    :root { color-scheme: light; --ink:#17202a; --muted:#627084; --line:#d9e2ec; --paper:#f7f9fc; --accent:#215a9c; --good:#19764b; --warn:#a55b00; --bad:#a32135; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--paper); }
    header { background: #ffffff; border-bottom: 1px solid var(--line); padding: 28px 32px 20px; }
    main { padding: 24px 32px 40px; max-width: 1400px; margin: 0 auto; }
    h1 { margin: 0 0 10px; font-size: 28px; }
    h2 { margin: 28px 0 12px; font-size: 18px; }
    .subtitle, span { color: var(--muted); display: block; font-size: 12px; margin-top: 2px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
    .metric, .panel { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .metric strong { display: block; font-size: 24px; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #eef3f8; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #475569; }
    tr:last-child td { border-bottom: 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
    a { color: var(--accent); }
    .badge, .kind { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; background: #e7eef7; color: var(--accent); font-size: 12px; font-weight: 700; white-space: nowrap; }
    .kind-attack, .kind-embargo { background: #fee7df; color: #923018; }
    .kind-build { background: #e7f5ee; color: var(--good); }
    .kind-spawn { background: #f5ecff; color: #6d3c99; }
    .kind-hold { background: #eef2f7; color: #475569; }
    .kind-alliance_request, .kind-donate_gold, .kind-donate_troops { background: #edf7ff; color: #1c5d87; }
    .badge-accepted, .badge-parser-ok, .badge-confirmed, .badge-aligned { background: #e5f8ef; color: var(--good); }
    .badge-rejected, .badge-parser-failed, .badge-failed, .badge-off-objective { background: #fde8ed; color: var(--bad); }
    .badge-fallback, .badge-unknown { background: #fff2dc; color: var(--warn); }
    .badge-not_applicable { background: #eef2f7; color: #475569; }
    .paths li { margin: 6px 0; }
    .notes { color: var(--muted); }
    .story-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .story-card { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .story-card p { margin: 10px 0; }
    .story-top { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
    .roster-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 14px; }
    .roster-card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; display:grid; gap:6px; }
    .roster-card b { color: var(--accent); }
    .timeline { display: grid; gap: 18px; }
    .timeline-phase { display: grid; gap: 10px; }
    .timeline-phase h3 { margin: 0; font-size: 15px; color:#334155; }
    .decision-card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; display:grid; gap:10px; }
    .decision-head { display:flex; gap:10px; justify-content:space-between; align-items:flex-start; }
    .badges { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
    .reason { margin:0; font-size:15px; }
    .audit-reason { margin:0; color:var(--muted); }
    .decision-meta { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:8px; }
    .decision-meta div { border:1px solid var(--line); border-radius:8px; padding:8px; min-width:0; }
    details { border-top:1px solid var(--line); padding-top:8px; }
    details summary { cursor:pointer; color:var(--accent); font-weight:700; }
    pre { overflow:auto; max-height:360px; background:#f3f6fa; padding:10px; border-radius:8px; }
  </style>
</head>
<body>
  <header>
    <h1>ProxyWar Run</h1>
    <div class="subtitle">${escapeHtml(input.runID)}</div>
  </header>
  <main>
    <section class="grid">
      <div class="metric">Scenario<strong>${escapeHtml(input.scenario)}</strong></div>
      <div class="metric">Brain<strong>${escapeHtml(input.brainMode)}</strong></div>
      <div class="metric">Runner<strong>${escapeHtml(summary.runnerMode)}</strong></div>
      <div class="metric">Decisions<strong>${summary.decisionCount}</strong></div>
      <div class="metric">Accepted<strong>${summary.acceptedCount}</strong></div>
      <div class="metric">Rejected<strong>${summary.rejectedCount}</strong></div>
      <div class="metric">Fallbacks<strong>${summary.fallbackCount}</strong></div>
      <div class="metric">Parser Failures<strong>${summary.parseFailureCount}</strong></div>
      <div class="metric">Post-spawn Non-hold<strong>${summary.postSpawnNonHoldActionCount}</strong></div>
      <div class="metric">Avg Latency<strong>${summary.averageDecisionLatencyMs} ms</strong></div>
      <div class="metric">Audits Confirmed<strong>${summary.confirmedEffectCount}</strong></div>
      <div class="metric">Audits Unknown<strong>${summary.unknownEffectCount}</strong></div>
      <div class="metric">Audit Failures<strong>${summary.failedEffectCount}</strong></div>
      <div class="metric">Behavior Quality<strong>${behaviorQuality.score}/100</strong></div>
      <div class="metric">Behavior Grade<strong>${escapeHtml(behaviorQuality.grade)}</strong></div>
      <div class="metric">Story Score<strong>${matchStory.entertainmentScore}/100</strong></div>
      <div class="metric">Story Grade<strong>${escapeHtml(matchStory.grade)}</strong></div>
      <div class="metric">Profile Gate<strong>${matchStory.profileDifferentiation.distinctEnough ? "distinct" : "review"}</strong></div>
      <div class="metric">Objective Score<strong>${scorecard.aggregate.totalObjectiveScore}/100</strong></div>
      <div class="metric">Objective Grade<strong>${escapeHtml(scorecard.aggregate.grade)}</strong></div>
    </section>

    <section class="panel">
      <h2>Match Summary</h2>
      <p>Match <code>${escapeHtml(input.matchID)}</code> ran from ${escapeHtml(summary.startedAt)} to ${escapeHtml(summary.completedAt)}.</p>
      <p>Action counts: <code>${escapeHtml(JSON.stringify(summary.actionCounts))}</code></p>
      <p>Strategic priorities: <code>${escapeHtml(JSON.stringify(summary.strategicPriorityCounts))}</code></p>
      <p>Objectives: <code>${escapeHtml(JSON.stringify(summary.objectiveCounts))}</code></p>
      <p>Match story: <code>${matchStory.entertainmentScore}/100 (${escapeHtml(matchStory.grade)})</code></p>
      <p>Profile differentiation: <code>${matchStory.profileDifferentiation.evaluatedProfileCount}/${matchStory.profileDifferentiation.profileCount} profiles, ${matchStory.profileDifferentiation.distinctEnough ? "distinct" : "needs review"}, stall risk ${escapeHtml(matchStory.profileDifferentiation.stallRisk)}</code></p>
      <p>Behavior quality: <code>${behaviorQuality.score}/100 (${escapeHtml(behaviorQuality.grade)}, ${behaviorQuality.pass ? "gate passed" : "gate failed"})</code></p>
      <p>Objective alignment: <code>${summary.objectiveAlignedDecisionCount}/${summary.decisionCount} (${summary.objectiveAlignmentRate})</code></p>
      <p>Objective score: <code>${scorecard.aggregate.totalObjectiveScore}/100 (${escapeHtml(scorecard.aggregate.grade)})</code></p>
      <p>Planner: <code>${summary.plannerRunCount} runs, ${summary.planFollowedCount} followed actions, ${summary.plannerFallbackCount} planner fallbacks</code></p>
      <p>External-agent feedback: <code>${externalFeedback.aggregate.externalAgentCount} external agents, ${externalFeedback.aggregate.readyForDeveloperReview ? "ready for developer review" : "needs review"}</code></p>
      <p>Audit counts: <code>${escapeHtml(JSON.stringify(auditCounts(summary)))}</code></p>
      <p>Step config: <code>${escapeHtml(JSON.stringify(summary.runnerConfig ?? {}))}</code></p>
      ${summary.runnerConfig?.onlyHoldReason ? `<p class="notes">Only-hold reason: ${escapeHtml(summary.runnerConfig.onlyHoldReason)}</p>` : ""}
      ${
        summary.spectator
          ? `<p><a href="./spectator.html">Open spectator replay</a></p><p class="notes">Static read-only artifact replay with ${summary.spectator.snapshotCount} snapshots. It occupies no player slot and has no intent submission path.</p>`
          : '<p class="notes">Spectator replay was not generated for this run.</p>'
      }
      ${
        summary.spectator
          ? `<p><a href="/ai-league-replay/${encodeURIComponent(input.runID)}">Open real ProxyWar replay renderer</a></p><p class="notes">Requires the local demo/beta server; this route is proxied for remote viewers.</p>`
          : ""
      }
    </section>

    <h2>Behavior Quality</h2>
    <section class="panel">
      <p><strong>${behaviorQuality.score}/100 · ${escapeHtml(behaviorQuality.grade)} · ${behaviorQuality.pass ? "demo gate passed" : "demo gate failed"}</strong></p>
      <div class="story-grid">
        <article class="story-card">
          <div class="story-top"><b class="kind">top issues</b><span>${behaviorQuality.topIssues.length}</span></div>
          <ul>${
            behaviorQuality.topIssues
              .slice(0, 3)
              .map((issue) => `<li>${escapeHtml(issue)}</li>`)
              .join("") || "<li>No top behavior issues were detected.</li>"
          }</ul>
        </article>
        <article class="story-card">
          <div class="story-top"><b class="kind">intentional beats</b><span>${behaviorQuality.highlights.length}</span></div>
          <ul>${
            behaviorQuality.highlights
              .slice(0, 4)
              .map((highlight) => `<li>${escapeHtml(highlight)}</li>`)
              .join("") ||
            "<li>No intentional-behavior highlights were detected.</li>"
          }</ul>
        </article>
        <article class="story-card">
          <div class="story-top"><b class="kind">gate</b><span>${behaviorQuality.severeIssueCount} severe</span></div>
          <ul>
            <li>Weak-rival misses: ${behaviorQuality.aggregate.weakRivalConversionMissCount}/${behaviorQuality.aggregate.weakRivalConversionOpportunityCount}</li>
            <li>Diplomacy follow-through: ${behaviorQuality.aggregate.diplomacyFollowThroughCount}/${behaviorQuality.aggregate.diplomacyActionCount}</li>
            <li>Visible arc: ${behaviorQuality.aggregate.visibleArc.expansion ? "expansion " : ""}${behaviorQuality.aggregate.visibleArc.build ? "build " : ""}${behaviorQuality.aggregate.visibleArc.combat ? "combat " : ""}${behaviorQuality.aggregate.visibleArc.diplomacy ? "diplomacy" : ""}</li>
          </ul>
        </article>
      </div>
      <p><a href="./behavior-quality-report.md">Open behavior quality report</a></p>
    </section>

    <h2>Match Story</h2>
    <section class="panel">
      <p><strong>${matchStory.entertainmentScore}/100 · ${escapeHtml(matchStory.grade)}</strong></p>
      <p>${escapeHtml(matchStory.summary)}</p>
      <div class="story-grid">
        <article class="story-card">
          <div class="story-top"><b class="kind">highlights</b><span>${matchStory.spectatorHighlights.length}</span></div>
          <ul>${
            matchStory.spectatorHighlights
              .slice(0, 5)
              .map((highlight) => `<li>${escapeHtml(highlight)}</li>`)
              .join("") || "<li>No spectator highlights were generated.</li>"
          }</ul>
        </article>
        <article class="story-card">
          <div class="story-top"><b class="kind">warnings</b><span>${matchStory.boringnessWarnings.length}</span></div>
          <ul>${
            matchStory.boringnessWarnings
              .slice(0, 5)
              .map((warning) => `<li>${escapeHtml(warning)}</li>`)
              .join("") ||
            "<li>No major boringness warnings were detected.</li>"
          }</ul>
        </article>
        <article class="story-card">
          <div class="story-top"><b class="kind">profiles</b><span>${matchStory.profileDifferentiation.distinctEnough ? "distinct" : "review"}</span></div>
          <ul>
            <li>${escapeHtml(matchStory.profileDifferentiation.summary)}</li>
            <li>Average distance: ${matchStory.profileDifferentiation.averagePairwiseDistance ?? "n/a"}</li>
            <li>Stall risk: ${escapeHtml(matchStory.profileDifferentiation.stallRisk)}</li>
          </ul>
        </article>
        <article class="story-card">
          <div class="story-top"><b class="kind">next edits</b><span>${matchStory.improvementSuggestions.length}</span></div>
          <ul>${
            matchStory.improvementSuggestions
              .slice(0, 5)
              .map((suggestion) => `<li>${escapeHtml(suggestion)}</li>`)
              .join("") || "<li>Run a longer match and inspect the replay.</li>"
          }</ul>
        </article>
      </div>
      <p><a href="./match-story.md">Open match story report</a></p>
    </section>

    <h2>Objective Scorecard</h2>
    <table>
      <thead>
        <tr><th>Agent</th><th>Score</th><th>Aligned</th><th>Accepted</th><th>Non-hold</th><th>Audit C/U/F</th><th>Warnings</th></tr>
      </thead>
      <tbody>${scorecardRows}</tbody>
    </table>

    <h2>External Agent Feedback</h2>
    ${
      externalFeedback.agents.length === 0
        ? '<section class="panel">No external-http agents were present in this run.</section>'
        : `<table>
      <thead>
        <tr><th>Agent</th><th>Accepted</th><th>Non-hold</th><th>Fallbacks</th><th>Parser failures</th><th>Audit C/U/F</th><th>Top suggestion</th></tr>
      </thead>
      <tbody>${externalFeedbackRows}</tbody>
    </table>`
    }
    <section class="panel">
      <p>${escapeHtml(externalFeedback.aggregate.summary)}</p>
      ${
        externalFeedback.aggregate.topSuggestions.length === 0
          ? '<p class="notes">No external-agent-specific suggestions were generated.</p>'
          : `<ul>${externalFeedback.aggregate.topSuggestions
              .map((suggestion) => `<li>${escapeHtml(suggestion)}</li>`)
              .join("")}</ul>`
      }
      <p><a href="./external-agent-feedback.md">Open external-agent feedback</a></p>
    </section>

    <h2>Agent Roster</h2>
    <section class="roster-grid">${rosterCards}</section>
    <table>
      <thead><tr><th>Agent</th><th>Profile</th><th>Brain</th><th>Client</th></tr></thead>
      <tbody>${rosterRows}</tbody>
    </table>

    <h2>Product Timeline</h2>
    <section class="timeline">
      ${timelineSections || '<div class="panel">No decisions were recorded.</div>'}
    </section>

    <h2>Notable Action Cards</h2>
    <section class="story-grid">
      ${storyCards || '<div class="panel">No non-hold actions were selected.</div>'}
    </section>

    <h2>Action Timeline</h2>
    <table>
      <thead>
        <tr><th>#</th><th>Turn</th><th>Agent</th><th>Kind</th><th>Strategy</th><th>Memory</th><th>Objective</th><th>Aligned</th><th>Plan</th><th>Plan followed</th><th>Skill</th><th>LegalAction.id</th><th>Reason</th><th>Intent</th><th>Result</th><th>Fallback</th><th>Parse</th><th>Audit</th><th>Latency ms</th></tr>
      </thead>
      <tbody>${actionRows}</tbody>
    </table>

    <section class="panel">
      <h2>Notable Decisions</h2>
      ${
        notable.length === 0
          ? "<p>No non-hold post-spawn decisions were selected.</p>"
          : `<ul>${notable
              .map(
                (entry) =>
                  `<li><b>${escapeHtml(entry.username)}</b> selected <code>${escapeHtml(entry.selectedLegalActionId)}</code>: ${escapeHtml(entry.reason)}</li>`,
              )
              .join("")}</ul>`
      }
    </section>

    <section class="panel">
      <h2>Artifact Links</h2>
      <ul class="paths">
        <li><a href="./match-package.html">match-package.html</a></li>
        <li><a href="./match-package.md">match-package.md</a></li>
        <li><a href="./match-package.json">match-package.json</a></li>
        <li><a href="./decisions.jsonl">decisions.jsonl</a></li>
        <li><a href="./match-summary.json">match-summary.json</a></li>
        <li><a href="./match-report.md">match-report.md</a></li>
        <li><a href="./objective-scorecard.json">objective-scorecard.json</a></li>
        <li><a href="./objective-scorecard.md">objective-scorecard.md</a></li>
        <li><a href="./external-agent-feedback.json">external-agent-feedback.json</a></li>
        <li><a href="./external-agent-feedback.md">external-agent-feedback.md</a></li>
        <li><a href="./behavior-quality-report.json">behavior-quality-report.json</a></li>
        <li><a href="./behavior-quality-report.md">behavior-quality-report.md</a></li>
        <li><a href="./match-story.json">match-story.json</a></li>
        <li><a href="./match-story.md">match-story.md</a></li>
        <li><a href="./spectator-telemetry.json">spectator-telemetry.json</a></li>
        ${
          paths.spectatorPaths
            ? `<li><a href="./spectator.html">spectator.html</a></li>
        <li><a href="./spectator-replay.json">spectator-replay.json</a></li>
        <li><a href="/ai-league-replay/${encodeURIComponent(input.runID)}">real ProxyWar replay renderer</a> <code>/ai-league-replay/${escapeHtml(input.runID)}</code></li>
        ${
          paths.spectatorPaths.gameRecordPath
            ? `<li><a href="./game-record.json">game-record.json</a></li>`
            : ""
        }`
            : ""
        }
      </ul>
    </section>

    <section class="panel">
      <h2>Final Known State</h2>
      <pre><code>${escapeHtml(JSON.stringify(input.finalState ?? null, null, 2))}</code></pre>
    </section>
  </main>
</body>
  </html>
`;
}

function groupedTimeline(entries: DecisionLogEntry[]): Array<{
  label: string;
  entries: DecisionLogEntry[];
}> {
  const groups: Array<{ label: string; entries: DecisionLogEntry[] }> = [];
  const postSpawnLabels = new Map<number, string>();
  for (const entry of entries) {
    const label = phaseLabel(entry, postSpawnLabels);
    const group = groups.find((candidate) => candidate.label === label);
    if (group) {
      group.entries.push(entry);
    } else {
      groups.push({ label, entries: [entry] });
    }
  }
  return groups;
}

function phaseLabel(
  entry: DecisionLogEntry,
  postSpawnLabels: Map<number, string>,
): string {
  if (entry.selectedActionKind === "spawn" || entry.turnNumber === 0) {
    return "Spawn";
  }
  const existing = postSpawnLabels.get(entry.turnNumber);
  if (existing !== undefined) {
    return existing;
  }
  const label = `Post-spawn cycle ${postSpawnLabels.size + 1}`;
  postSpawnLabels.set(entry.turnNumber, label);
  return label;
}

function actionBadge(kind: LegalActionKind): string {
  return `<b class="kind kind-${escapeHtml(kind)}">${escapeHtml(kind)}</b>`;
}

function statusBadge(status: string): string {
  return `<b class="badge badge-${escapeHtml(status)}">${escapeHtml(status)}</b>`;
}

function auditBadge(status: AgentActionAudit["auditStatus"]): string {
  return `<b class="badge badge-${escapeHtml(status)}">audit ${escapeHtml(status)}</b>`;
}

function parserBadge(entry: DecisionLogEntry): string {
  const actionParseFailed = entry.parseSuccess === false;
  const plannerParseFailed = entry.plannerParseSuccess === false;
  if (actionParseFailed || plannerParseFailed) {
    return statusBadge("parser-failed");
  }
  if (entry.parseSuccess === true || entry.plannerParseSuccess === true) {
    return statusBadge("parser-ok");
  }
  return "n/a";
}

function auditCounts(summary: ReturnType<typeof matchSummary>) {
  return {
    confirmed: summary.confirmedEffectCount,
    unknown: summary.unknownEffectCount,
    failed: summary.failedEffectCount,
    notApplicable: summary.notApplicableEffectCount,
  };
}

function strategyLabel(entry: DecisionLogEntry): string {
  if (entry.strategicPriority === undefined) {
    return "unknown";
  }
  return `${entry.strategicPriority}/${entry.strategicUrgency ?? "unknown"}`;
}

function objectiveLabel(entry: DecisionLogEntry): string {
  if (entry.objectiveSummary !== undefined) {
    return entry.objectiveSummary;
  }
  return entry.objectiveKind ?? "none";
}

function planLabel(entry: DecisionLogEntry): string {
  if (entry.planObjective === undefined) {
    return "none";
  }
  return `${entry.planObjective}${entry.plannerSource ? `/${entry.plannerSource}` : ""}: ${entry.planRationale ?? "no rationale"}`;
}

function skillLabel(entry: DecisionLogEntry): string {
  if (entry.selectedSkill === undefined) {
    return "none";
  }
  return `${entry.selectedSkill}${entry.selectedSkillScore === undefined ? "" : ` ${entry.selectedSkillScore}`}`;
}

function summarizeTurnSchedule(schedule: number[]): string {
  if (schedule.length === 0) {
    return "empty";
  }
  const ranges: string[] = [];
  let current = schedule[0];
  let count = 1;
  for (let index = 1; index < schedule.length; index += 1) {
    if (schedule[index] === current) {
      count += 1;
      continue;
    }
    ranges.push(`${current}x${count}`);
    current = schedule[index];
    count = 1;
  }
  ranges.push(`${current}x${count}`);
  return ranges.join(", ");
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

function fallbackAudit(record: AgentDecisionRecord): AgentActionAudit {
  if (!record.result.accepted) {
    return {
      auditStatus: "not_applicable",
      auditReason: "intent was rejected before effect auditing",
    };
  }
  if (record.intent === null || record.chosenActionKind === "hold") {
    return {
      auditStatus: "not_applicable",
      auditReason: "hold selected; no game intent was submitted",
    };
  }
  return {
    auditStatus: "unknown",
    auditReason:
      "no before/after mirror snapshots were captured for this runner mode",
  };
}

function intentSummary(intent: AgentDecisionRecord["intent"]): string {
  return intent === null ? "none" : JSON.stringify(intent);
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
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

function humanAction(entry: DecisionLogEntry): string {
  const metadata = entry.selectedActionMetadata ?? {};
  switch (entry.selectedActionKind) {
    case "spawn":
      return `${entry.username} spawned at tile ${String(metadata.tile ?? entry.selectedLegalActionId.replace("spawn:", ""))}.`;
    case "attack":
      return `${entry.username} attacked ${String(metadata.targetName ?? metadata.targetID ?? "a target")} with ${String(metadata.troops ?? "some")} troops.`;
    case "retreat":
      return `${entry.username} retreated from ${String(metadata.targetName ?? metadata.targetID ?? "an attack")}.`;
    case "boat":
      return `${entry.username} sent a transport toward ${String(metadata.targetName ?? metadata.targetTile ?? "a shore")}.`;
    case "boat_retreat":
      return `${entry.username} retreated a transport.`;
    case "alliance_request":
      return `${entry.username} requested an alliance with ${String(metadata.recipientName ?? metadata.recipientID ?? "another agent")}.`;
    case "alliance_reject":
      return `${entry.username} rejected an alliance request from ${String(metadata.targetName ?? metadata.targetID ?? "another player")}.`;
    case "alliance_extend":
      return `${entry.username} extended an alliance with ${String(metadata.targetName ?? metadata.targetID ?? "another player")}.`;
    case "break_alliance":
      return `${entry.username} broke an alliance with ${String(metadata.targetName ?? metadata.targetID ?? "another player")}.`;
    case "target_player":
      return `${entry.username} marked ${String(metadata.targetName ?? metadata.targetID ?? "a rival")} as a target.`;
    case "emoji":
      return `${entry.username} reacted to ${String(metadata.recipientName ?? metadata.recipientID ?? "another player")} with ${String(metadata.emojiText ?? metadata.emoji ?? "an emoji")}${metadata.emojiContext ? ` (${String(metadata.emojiContext)})` : ""}.`;
    case "quick_chat":
      return `${entry.username} publicly said "${String(metadata.message ?? metadata.quickChatKey ?? "quick chat")}" to ${String(metadata.recipientName ?? metadata.recipientID ?? "another player")}.`;
    case "build":
    case "warship":
    case "nuke":
      return `${entry.username} built ${String(metadata.unit ?? "a structure")} at tile ${String(metadata.buildTile ?? metadata.targetTile ?? "unknown")}.`;
    case "upgrade_structure":
      return `${entry.username} upgraded ${String(metadata.unit ?? "a structure")}.`;
    case "delete_unit":
      return `${entry.username} deleted ${String(metadata.unit ?? "a unit")}.`;
    case "move_warship":
      return `${entry.username} moved warship patrols toward tile ${String(metadata.targetTile ?? "unknown")}.`;
    case "donate_gold":
      return `${entry.username} donated ${String(metadata.gold ?? "some")} gold to ${String(metadata.recipientName ?? metadata.recipientID ?? "an ally")}.`;
    case "donate_troops":
      return `${entry.username} donated ${String(metadata.troops ?? "some")} troops to ${String(metadata.recipientName ?? metadata.recipientID ?? "an ally")}.`;
    case "embargo":
      return `${entry.username} started an embargo against ${String(metadata.targetName ?? metadata.targetID ?? "another agent")}.`;
    case "embargo_stop":
      return `${entry.username} stopped an embargo against ${String(metadata.targetName ?? metadata.targetID ?? "another agent")}.`;
    case "embargo_all":
      return `${entry.username} embargoed all eligible rivals.`;
    case "hold":
      return `${entry.username} held position.`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function numberMetadata(
  metadata: Record<string, string | number | boolean | null>,
  key: string,
): number | undefined {
  const value = metadata[key];
  return typeof value === "number" ? value : undefined;
}

function stringMetadata(
  metadata: Record<string, string | number | boolean | null>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function booleanMetadata(
  metadata: Record<string, string | number | boolean | null>,
  key: string,
): boolean | undefined {
  const value = metadata[key];
  return typeof value === "boolean" ? value : undefined;
}

function safePathSegment(value: string): string {
  const segment = value.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    !/[A-Za-z0-9]/.test(segment)
  ) {
    throw new Error(`Invalid AI league artifact id: ${value}`);
  }
  return segment;
}
