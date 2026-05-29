import fs from "fs/promises";
import path from "path";
import { UnitType } from "../../core/game/Game";
import {
  AgentBrainType,
  AgentDecisionRecord,
  AgentObjectiveKind,
  AgentStrategyProfile,
  LegalActionKind,
} from "./AgentTypes";

export type AgentBehaviorQualityIssueCategory =
  | "repeated_neutral_expansion_loop"
  | "unexplained_hold"
  | "bad_defense_post"
  | "missed_weak_neighbor_attack"
  | "empty_diplomacy"
  | "stale_objective"
  | "early_only_arc";

export type AgentBehaviorQualityIssueSeverity =
  | "low"
  | "medium"
  | "high"
  | "severe";

export type AgentBehaviorQualityGrade =
  | "demo_ready"
  | "watchable"
  | "rough"
  | "embarrassing";

export type AgentHoldReasonCategory =
  | "transport_wait"
  | "attack_safety"
  | "support_cooldown"
  | "no_safe_non_hold"
  | "unexplained";

export interface AgentBehaviorQualityIssue {
  category: AgentBehaviorQualityIssueCategory;
  severity: AgentBehaviorQualityIssueSeverity;
  agentID: string;
  username: string;
  profile?: AgentStrategyProfile;
  turnNumber: number;
  sequence: number;
  selectedAction: {
    id: string;
    kind: LegalActionKind;
    metadata?: Record<string, string | number | boolean | null>;
  };
  legalAlternatives: string[];
  objective: AgentObjectiveKind | string | null;
  objectiveAligned: boolean | null;
  reason: string;
  recommendedPlannerExecutorFix: string;
}

export interface AgentBehaviorQualityAgentSummary {
  agentID: string;
  username: string;
  profile?: AgentStrategyProfile;
  decisionCount: number;
  postSpawnDecisionCount: number;
  expansionCount: number;
  buildCount: number;
  combatCount: number;
  diplomacyCount: number;
  unexplainedHoldCount: number;
  severeIssueCount: number;
  issueCount: number;
  maxExactActionRepeatAfterSpawn: number;
}

export interface AgentBehaviorQualityGate {
  pass: boolean;
  requiredScore: number;
  scorePass: boolean;
  noSevereBadDefensePost: boolean;
  noSevereUnexplainedHold: boolean;
  noAgentRepeatedExactActionOverLimit: boolean;
  weakRivalConversionMissRatePass: boolean;
  diplomacyFollowThroughRatePass: boolean;
  visibleArcPass: boolean;
}

export interface AgentBehaviorQualityAggregate {
  score: number;
  grade: AgentBehaviorQualityGrade;
  severeIssueCount: number;
  issueCount: number;
  topIssueCategories: Array<{
    category: AgentBehaviorQualityIssueCategory;
    count: number;
    maxSeverity: AgentBehaviorQualityIssueSeverity;
  }>;
  weakRivalConversionOpportunityCount: number;
  weakRivalConversionMissCount: number;
  weakRivalConversionMissRate: number;
  diplomacyActionCount: number;
  diplomacyFollowThroughCount: number;
  diplomacyFollowThroughRate: number;
  maxExactActionRepeatAfterSpawn: number;
  repeatedExactActionOffenders: Array<{
    agentID: string;
    username: string;
    maxExactActionRepeatAfterSpawn: number;
  }>;
  visibleArc: {
    expansion: boolean;
    build: boolean;
    combat: boolean;
    diplomacy: boolean;
  };
}

export interface AgentBehaviorQualityReport {
  schemaVersion: 1;
  reportKind: "agent-behavior-quality-report";
  generatedAt: string;
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: AgentBrainType;
  score: number;
  grade: AgentBehaviorQualityGrade;
  severeIssueCount: number;
  pass: boolean;
  gate: AgentBehaviorQualityGate;
  aggregate: AgentBehaviorQualityAggregate;
  agents: AgentBehaviorQualityAgentSummary[];
  issues: AgentBehaviorQualityIssue[];
  topIssues: string[];
  highlights: string[];
  recommendedNextFixes: string[];
}

export interface AgentBehaviorQualitySummary {
  score: number;
  grade: AgentBehaviorQualityGrade;
  severeIssueCount: number;
  reportPath: string;
  pass: boolean;
  topIssues: string[];
  highlights: string[];
}

export interface AgentBehaviorQualityReportPaths {
  jsonPath: string;
  markdownPath: string;
}

export interface BuildAgentBehaviorQualityReportInput {
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: AgentBrainType;
  records: AgentDecisionRecord[];
  now?: Date;
}

const DEMO_QUALITY_REQUIRED_SCORE = 72;
const REPEATED_EXACT_ACTION_LIMIT = 2;

const severityWeight: Record<AgentBehaviorQualityIssueSeverity, number> = {
  low: 2,
  medium: 5,
  high: 10,
  severe: 18,
};

const severityRank: Record<AgentBehaviorQualityIssueSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  severe: 4,
};

export function buildAgentBehaviorQualityReport(
  input: BuildAgentBehaviorQualityReportInput,
): AgentBehaviorQualityReport {
  const records = [...input.records].sort(
    (a, b) => a.sequence - b.sequence || a.turnNumber - b.turnNumber,
  );
  const issues: AgentBehaviorQualityIssue[] = [];
  const agents = recordsByAgent(records);
  const agentSummaries: AgentBehaviorQualityAgentSummary[] = [];
  const conversion = { opportunities: 0, misses: 0 };
  const diplomacy = { actions: 0, followThrough: 0 };
  const visibleArc = {
    expansion: records.some(isNeutralExpansionAction),
    build: records.some(isBuildMoment),
    combat: records.some(isCombatMoment),
    diplomacy: records.some(isDiplomacyMoment),
  };

  for (const agentRecords of agents.values()) {
    const agentIssues: AgentBehaviorQualityIssue[] = [];
    const ordered = [...agentRecords].sort(
      (a, b) => a.sequence - b.sequence || a.turnNumber - b.turnNumber,
    );
    agentIssues.push(...repeatedNeutralExpansionIssues(ordered));
    agentIssues.push(...unexplainedHoldIssues(ordered));
    agentIssues.push(...badDefensePostIssues(ordered));
    const conversionScan = missedWeakNeighborAttackIssues(ordered);
    conversion.opportunities += conversionScan.opportunityCount;
    conversion.misses += conversionScan.missCount;
    agentIssues.push(...conversionScan.issues);
    const diplomacyScan = emptyDiplomacyIssues(ordered);
    diplomacy.actions += diplomacyScan.actionCount;
    diplomacy.followThrough += diplomacyScan.followThroughCount;
    agentIssues.push(...diplomacyScan.issues);
    agentIssues.push(...staleObjectiveIssues(ordered));
    agentIssues.push(...earlyOnlyArcIssues(ordered));
    issues.push(...agentIssues);

    const postSpawn = ordered.filter(isPostSpawnRecord);
    agentSummaries.push({
      agentID: ordered[0]?.agentID ?? "unknown",
      username: ordered[0]?.username ?? "Agent",
      profile: ordered[0]?.profile,
      decisionCount: ordered.length,
      postSpawnDecisionCount: postSpawn.length,
      expansionCount: postSpawn.filter(isNeutralExpansionAction).length,
      buildCount: postSpawn.filter(isBuildMoment).length,
      combatCount: postSpawn.filter(isCombatMoment).length,
      diplomacyCount: postSpawn.filter(isDiplomacyMoment).length,
      unexplainedHoldCount: agentIssues.filter(
        (issue) => issue.category === "unexplained_hold",
      ).length,
      severeIssueCount: agentIssues.filter(
        (issue) => issue.severity === "severe",
      ).length,
      issueCount: agentIssues.length,
      maxExactActionRepeatAfterSpawn: maxExactActionRepeatAfterSpawn(ordered),
    });
  }

  const repeatedExactActionOffenders = agentSummaries
    .filter(
      (agent) =>
        agent.maxExactActionRepeatAfterSpawn > REPEATED_EXACT_ACTION_LIMIT,
    )
    .map((agent) => ({
      agentID: agent.agentID,
      username: agent.username,
      maxExactActionRepeatAfterSpawn: agent.maxExactActionRepeatAfterSpawn,
    }));
  const weakRivalConversionMissRate =
    conversion.opportunities === 0
      ? 0
      : round2(conversion.misses / conversion.opportunities);
  const diplomacyFollowThroughRate =
    diplomacy.actions === 0
      ? 1
      : round2(diplomacy.followThrough / diplomacy.actions);
  const severeIssueCount = issues.filter(
    (issue) => issue.severity === "severe",
  ).length;
  const topIssueCategories = issueCategorySummary(issues);
  const issuePenalty = Math.min(
    70,
    issues.reduce((sum, issue) => sum + severityWeight[issue.severity], 0),
  );
  const gatePenalty =
    (visibleArc.expansion ? 0 : 12) +
    (visibleArc.build ? 0 : 10) +
    (visibleArc.combat ? 0 : 10) +
    (visibleArc.diplomacy ? 0 : 8) +
    (weakRivalConversionMissRate <= 0.25 ? 0 : 12) +
    (diplomacyFollowThroughRate >= 0.6 ? 0 : 8) +
    (repeatedExactActionOffenders.length === 0 ? 0 : 8);
  const score = clampScore(100 - issuePenalty - gatePenalty);
  const gate: AgentBehaviorQualityGate = {
    pass: false,
    requiredScore: DEMO_QUALITY_REQUIRED_SCORE,
    scorePass: score >= DEMO_QUALITY_REQUIRED_SCORE,
    noSevereBadDefensePost: !issues.some(
      (issue) =>
        issue.category === "bad_defense_post" && issue.severity === "severe",
    ),
    noSevereUnexplainedHold: !issues.some(
      (issue) =>
        issue.category === "unexplained_hold" && issue.severity === "severe",
    ),
    noAgentRepeatedExactActionOverLimit:
      repeatedExactActionOffenders.length === 0,
    weakRivalConversionMissRatePass: weakRivalConversionMissRate <= 0.25,
    diplomacyFollowThroughRatePass: diplomacyFollowThroughRate >= 0.6,
    visibleArcPass:
      visibleArc.expansion &&
      visibleArc.build &&
      visibleArc.combat &&
      visibleArc.diplomacy,
  };
  gate.pass =
    gate.scorePass &&
    gate.noSevereBadDefensePost &&
    gate.noSevereUnexplainedHold &&
    gate.noAgentRepeatedExactActionOverLimit &&
    gate.weakRivalConversionMissRatePass &&
    gate.diplomacyFollowThroughRatePass &&
    gate.visibleArcPass;

  const aggregate: AgentBehaviorQualityAggregate = {
    score,
    grade: gradeForScore(score),
    severeIssueCount,
    issueCount: issues.length,
    topIssueCategories,
    weakRivalConversionOpportunityCount: conversion.opportunities,
    weakRivalConversionMissCount: conversion.misses,
    weakRivalConversionMissRate,
    diplomacyActionCount: diplomacy.actions,
    diplomacyFollowThroughCount: diplomacy.followThrough,
    diplomacyFollowThroughRate,
    maxExactActionRepeatAfterSpawn: Math.max(
      0,
      ...agentSummaries.map((agent) => agent.maxExactActionRepeatAfterSpawn),
    ),
    repeatedExactActionOffenders,
    visibleArc,
  };

  return {
    schemaVersion: 1,
    reportKind: "agent-behavior-quality-report",
    generatedAt: (input.now ?? new Date()).toISOString(),
    runID: input.runID,
    matchID: input.matchID,
    scenario: input.scenario,
    brainMode: input.brainMode,
    score,
    grade: aggregate.grade,
    severeIssueCount,
    pass: gate.pass,
    gate,
    aggregate,
    agents: agentSummaries,
    issues: issues.sort(issueSort),
    topIssues: topIssueText(topIssueCategories),
    highlights: behaviorHighlights(aggregate),
    recommendedNextFixes: recommendedNextFixes(issues, aggregate),
  };
}

export function behaviorQualitySummary(
  report: AgentBehaviorQualityReport,
  reportPath = "behavior-quality-report.md",
): AgentBehaviorQualitySummary {
  return {
    score: report.score,
    grade: report.grade,
    severeIssueCount: report.severeIssueCount,
    reportPath,
    pass: report.pass,
    topIssues: report.topIssues.slice(0, 3),
    highlights: report.highlights.slice(0, 4),
  };
}

export async function writeAgentBehaviorQualityArtifacts(input: {
  report: AgentBehaviorQualityReport;
  directory: string;
}): Promise<AgentBehaviorQualityReportPaths> {
  const jsonPath = path.join(input.directory, "behavior-quality-report.json");
  const markdownPath = path.join(input.directory, "behavior-quality-report.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(input.report, null, 2)}\n`);
  await fs.writeFile(
    markdownPath,
    agentBehaviorQualityReportMarkdown(input.report),
  );
  return { jsonPath, markdownPath };
}

export function agentBehaviorQualityReportMarkdown(
  report: AgentBehaviorQualityReport,
): string {
  return [
    `# Behavior Quality Report: ${report.runID}`,
    "",
    "## Summary",
    "",
    `- Score: ${report.score}/100`,
    `- Grade: ${report.grade}`,
    `- Demo gate: ${report.pass ? "pass" : "fail"}`,
    `- Severe issues: ${report.severeIssueCount}`,
    `- Weak-rival conversion misses: ${report.aggregate.weakRivalConversionMissCount}/${report.aggregate.weakRivalConversionOpportunityCount} (${percent(report.aggregate.weakRivalConversionMissRate)})`,
    `- Diplomacy follow-through: ${report.aggregate.diplomacyFollowThroughCount}/${report.aggregate.diplomacyActionCount} (${percent(report.aggregate.diplomacyFollowThroughRate)})`,
    "",
    "## Gate",
    "",
    markdownTable(
      ["Check", "Result"],
      [
        [
          `score >= ${report.gate.requiredScore}`,
          passFail(report.gate.scorePass),
        ],
        [
          "no severe bad Defense Post",
          passFail(report.gate.noSevereBadDefensePost),
        ],
        [
          "no severe unexplained hold",
          passFail(report.gate.noSevereUnexplainedHold),
        ],
        [
          "no agent repeats exact action more than twice after spawn",
          passFail(report.gate.noAgentRepeatedExactActionOverLimit),
        ],
        [
          "weak-rival conversion miss rate <= 25%",
          passFail(report.gate.weakRivalConversionMissRatePass),
        ],
        [
          "diplomacy follow-through rate >= 60%",
          passFail(report.gate.diplomacyFollowThroughRatePass),
        ],
        [
          "visible expansion/build/combat/diplomacy arc",
          passFail(report.gate.visibleArcPass),
        ],
      ],
    ),
    "",
    "## Why It Looked Intentional",
    "",
    ...(report.highlights.length === 0
      ? ["- No intentional-behavior highlights were detected."]
      : report.highlights.map((highlight) => `- ${highlight}`)),
    "",
    "## Top Issues",
    "",
    ...(report.topIssues.length === 0
      ? ["- No top behavior issues were detected."]
      : report.topIssues.map((issue) => `- ${issue}`)),
    "",
    "## Agent Summaries",
    "",
    markdownTable(
      [
        "Agent",
        "Profile",
        "Decisions",
        "Expansion",
        "Build",
        "Combat",
        "Diplomacy",
        "Severe",
        "Max Exact Repeat",
      ],
      report.agents.map((agent) => [
        agent.username,
        agent.profile ?? "unknown",
        String(agent.decisionCount),
        String(agent.expansionCount),
        String(agent.buildCount),
        String(agent.combatCount),
        String(agent.diplomacyCount),
        String(agent.severeIssueCount),
        String(agent.maxExactActionRepeatAfterSpawn),
      ]),
    ),
    "",
    "## Issues",
    "",
    report.issues.length === 0
      ? "No behavior quality issues were detected."
      : markdownTable(
          [
            "Severity",
            "Category",
            "Agent",
            "Turn",
            "Selected",
            "Objective",
            "Reason",
            "Recommended fix",
          ],
          report.issues.map((issue) => [
            issue.severity,
            issue.category,
            issue.username,
            String(issue.turnNumber),
            `${issue.selectedAction.kind}:${issue.selectedAction.id}`,
            issue.objective ?? "none",
            issue.reason,
            issue.recommendedPlannerExecutorFix,
          ]),
        ),
    "",
    "## Recommended Next Fixes",
    "",
    ...(report.recommendedNextFixes.length === 0
      ? ["- Keep running demo-quality gates after planner changes."]
      : report.recommendedNextFixes.map((fix) => `- ${fix}`)),
    "",
  ].join("\n");
}

function recordsByAgent(
  records: AgentDecisionRecord[],
): Map<string, AgentDecisionRecord[]> {
  const byAgent = new Map<string, AgentDecisionRecord[]>();
  for (const record of records) {
    const current = byAgent.get(record.agentID) ?? [];
    current.push(record);
    byAgent.set(record.agentID, current);
  }
  return byAgent;
}

function repeatedNeutralExpansionIssues(
  records: AgentDecisionRecord[],
): AgentBehaviorQualityIssue[] {
  const issues: AgentBehaviorQualityIssue[] = [];
  let neutralStreak = 0;
  for (const record of records) {
    if (!isPostSpawnRecord(record)) {
      neutralStreak = 0;
      continue;
    }
    if (isNeutralExpansionAction(record)) {
      neutralStreak += 1;
    } else {
      neutralStreak = 0;
    }
    if (neutralStreak < 3) {
      continue;
    }
    const hasBetterHandoff =
      hasSafeEconomyBuild(record) || hasExecutorReadyWeakNeighborAttack(record);
    if (!hasBetterHandoff) {
      continue;
    }
    if (hasSameDecisionEconomyHandoff(record)) {
      continue;
    }
    const openingStillRecommended =
      record.tacticalAffordances?.openingExpansionTempo?.recommended === true &&
      !hasExecutorReadyWeakNeighborAttack(record) &&
      !hasSafeEconomyBuild(record);
    if (openingStillRecommended) {
      continue;
    }
    issues.push(
      issue(record, {
        category: "repeated_neutral_expansion_loop",
        severity: neutralStreak >= 4 ? "high" : "medium",
        reason: `Selected neutral expansion for ${neutralStreak} consecutive post-spawn decisions while a safer build or executor-ready pressure handoff was legal.`,
        recommendedPlannerExecutorFix:
          "After two neutral expansions, refresh the objective and score safe economy or executor-ready weak-rival conversion above another neutral grab.",
      }),
    );
  }
  return dedupeIssueWindow(issues, "repeated_neutral_expansion_loop");
}

function unexplainedHoldIssues(
  records: AgentDecisionRecord[],
): AgentBehaviorQualityIssue[] {
  return records
    .filter(isPostSpawnRecord)
    .filter((record) => record.chosenActionKind === "hold")
    .map((record) => ({
      record,
      holdReasonCategory: holdReasonCategory(record),
    }))
    .filter(({ holdReasonCategory }) => holdReasonCategory === "unexplained")
    .filter(({ record }) => hasUsefulNonHoldAlternative(record))
    .map(({ record }) =>
      issue(record, {
        category: "unexplained_hold",
        severity: "severe",
        reason:
          "Selected hold with no transport wait, attack-safety, support-cooldown, or no-safe-action reason while non-hold LegalActions existed.",
        recommendedPlannerExecutorFix:
          "Attach holdReasonCategory to every hold and heavily penalize unexplained holds whenever low or medium risk non-hold actions are available.",
      }),
    );
}

function badDefensePostIssues(
  records: AgentDecisionRecord[],
): AgentBehaviorQualityIssue[] {
  return records
    .filter(isPostSpawnRecord)
    .filter(isDefensePostBuild)
    .filter(isPoorDefensePostRecord)
    .map((record) =>
      issue(record, {
        category: "bad_defense_post",
        severity: "severe",
        reason:
          "Selected Defense Post with low defensive/frontier value and no nearby enemy or incoming attack signal.",
        recommendedPlannerExecutorFix:
          "Treat poor Defense Post placement as a near-hard block and prefer City, Factory, Port, attack, or hold-with-reason when no frontier coverage exists.",
      }),
    );
}

function missedWeakNeighborAttackIssues(records: AgentDecisionRecord[]): {
  issues: AgentBehaviorQualityIssue[];
  opportunityCount: number;
  missCount: number;
} {
  const issues: AgentBehaviorQualityIssue[] = [];
  let opportunityCount = 0;
  let missCount = 0;
  for (const record of records.filter(isPostSpawnRecord).filter(isPrimaryDecisionRecord)) {
    if (!hasExecutorReadyWeakNeighborAttack(record)) {
      continue;
    }
    opportunityCount += 1;
    if (isHostileAttackAction(record)) {
      continue;
    }
    missCount += 1;
    issues.push(
      issue(record, {
        category: "missed_weak_neighbor_attack",
        severity: record.chosenActionKind === "hold" ? "high" : "medium",
        reason:
          "Executor-ready weak-rival conversion or finish pressure was available, but the selected action did not attack the favorable hostile target.",
        recommendedPlannerExecutorFix:
          "When frontierConversionTiming or frontierFinishPressure is recommended and executor-ready, prefer the existing safe attack LegalAction.id over neutral expansion, social actions, builds, or hold.",
      }),
    );
  }
  return { issues, opportunityCount, missCount };
}

function emptyDiplomacyIssues(records: AgentDecisionRecord[]): {
  issues: AgentBehaviorQualityIssue[];
  actionCount: number;
  followThroughCount: number;
} {
  const diplomacyRecords = records.filter(isPostSpawnRecord).filter(isDiplomacyMoment);
  let followThroughCount = 0;
  const emptyRecords: AgentDecisionRecord[] = [];
  for (const record of diplomacyRecords) {
    const hasFollowThrough = diplomacyHasFollowThrough(record, records);
    if (hasFollowThrough) {
      followThroughCount += 1;
    } else {
      emptyRecords.push(record);
    }
  }

  const issues: AgentBehaviorQualityIssue[] = [];
  for (const record of emptyRecords) {
    const nearbyEmptyDiplomacyCount = emptyRecords.filter(
      (candidate) =>
        Math.abs(candidate.sequence - record.sequence) <= 3 &&
        candidate.agentID === record.agentID,
    ).length;
    if (nearbyEmptyDiplomacyCount < 2) {
      continue;
    }
    issues.push(
      issue(record, {
        category: "empty_diplomacy",
        severity: "medium",
        reason:
          "Selected repeated diplomacy or social action without nearby alliance, support, attack, or communication follow-through.",
        recommendedPlannerExecutorFix:
          "Prefer social LegalActions only when they respond to a recent signal or bracket a visible alliance, support, target call, or attack within three decision cycles.",
      }),
    );
  }

  return {
    issues: dedupeIssueWindow(issues, "empty_diplomacy"),
    actionCount: diplomacyRecords.length,
    followThroughCount,
  };
}

function staleObjectiveIssues(
  records: AgentDecisionRecord[],
): AgentBehaviorQualityIssue[] {
  const issues: AgentBehaviorQualityIssue[] = [];
  let unalignedStreak = 0;
  let repeatedKindStreak = 0;
  let previousKind: LegalActionKind | null = null;
  let previousObjective: string | null = null;

  for (const record of records.filter(isPostSpawnRecord).filter(isPrimaryDecisionRecord)) {
    if (plannerRefreshed(record)) {
      unalignedStreak = 0;
      repeatedKindStreak = 0;
      previousKind = record.chosenActionKind;
      previousObjective = record.objectiveKind ?? null;
      continue;
    }
    const objective = effectiveObjectiveKind(record);
    const showsPlanProgress = recordShowsPlanProgress(record);
    if (record.objectiveAligned === true || showsPlanProgress) {
      unalignedStreak = 0;
    } else if (record.objectiveAligned === false) {
      unalignedStreak += 1;
    }
    if (showsPlanProgress) {
      repeatedKindStreak = 0;
      previousKind = record.chosenActionKind;
      previousObjective = objective;
      continue;
    }

    if (
      previousKind === record.chosenActionKind &&
      previousObjective === objective &&
      record.chosenActionKind !== "hold"
    ) {
      repeatedKindStreak += 1;
    } else {
      repeatedKindStreak = 0;
    }
    previousKind = record.chosenActionKind;
    previousObjective = objective;

    if (unalignedStreak >= 2) {
      issues.push(
        issue(record, {
          category: "stale_objective",
          severity: "medium",
          reason:
            "Objective stayed active after two consecutive accepted decisions were not aligned with it.",
          recommendedPlannerExecutorFix:
            "Refresh the planner when the current target has no aligned legal action or when two consecutive accepted decisions miss the objective.",
        }),
      );
      unalignedStreak = 0;
      continue;
    }
    if (repeatedKindStreak >= 2) {
      issues.push(
        issue(record, {
          category: "stale_objective",
          severity: "low",
          reason:
            "Repeated the same action kind three times under the same objective without a planner refresh.",
          recommendedPlannerExecutorFix:
            "Refresh objectives when repeated action kind count reaches three, especially after spawn.",
        }),
      );
      repeatedKindStreak = 0;
    }
  }
  return issues;
}

function earlyOnlyArcIssues(
  records: AgentDecisionRecord[],
): AgentBehaviorQualityIssue[] {
  const postSpawn = records.filter(isPostSpawnRecord);
  if (postSpawn.length === 0 || !postSpawn.some(isNeutralExpansionAction)) {
    return [];
  }
  const postOpening = postSpawn.filter(
    (record, index) => record.turnNumber >= 300 || index >= 3,
  );
  if (
    postOpening.some(isBuildMoment) ||
    postOpening.some(isCombatMoment) ||
    postOpening.some(isDiplomacyMoment)
  ) {
    return [];
  }
  const anchor = postOpening[0] ?? postSpawn[postSpawn.length - 1];
  if (anchor === undefined) {
    return [];
  }
  return [
    issue(anchor, {
      category: "early_only_arc",
      severity: "high",
      reason:
        "Agent expanded after spawn but never produced a visible build, combat, or diplomacy/social beat later in the match.",
      recommendedPlannerExecutorFix:
        "Use phase policy to rotate from opening growth into economy build, weak-rival pressure, purposeful diplomacy, naval reach, or endgame tooling.",
    }),
  ];
}

function issue(
  record: AgentDecisionRecord,
  input: {
    category: AgentBehaviorQualityIssueCategory;
    severity: AgentBehaviorQualityIssueSeverity;
    reason: string;
    recommendedPlannerExecutorFix: string;
  },
): AgentBehaviorQualityIssue {
  return {
    category: input.category,
    severity: input.severity,
    agentID: record.agentID,
    username: record.username,
    profile: record.profile,
    turnNumber: record.turnNumber,
    sequence: record.sequence,
    selectedAction: {
      id: record.chosenActionID,
      kind: record.chosenActionKind,
      ...(record.chosenActionMetadata !== undefined
        ? { metadata: record.chosenActionMetadata }
        : {}),
    },
    legalAlternatives: legalAlternatives(record),
    objective: record.objectiveSummary ?? record.objectiveKind ?? null,
    objectiveAligned: record.objectiveAligned ?? null,
    reason: input.reason,
    recommendedPlannerExecutorFix: input.recommendedPlannerExecutorFix,
  };
}

function isPostSpawnRecord(record: AgentDecisionRecord): boolean {
  return record.turnNumber > 0 && record.chosenActionKind !== "spawn";
}

function isPrimaryDecisionRecord(record: AgentDecisionRecord): boolean {
  const value = record.decisionMetadata?.batchIndex;
  return value === undefined || value === null || value === 0;
}

function effectiveObjectiveKind(record: AgentDecisionRecord): string | null {
  return (
    metadataString(record.decisionMetadata, "planObjective") ??
    metadataString(record.decisionMetadata, "activePolicyObjective") ??
    record.objectiveKind ??
    null
  );
}

function recordShowsPlanProgress(record: AgentDecisionRecord): boolean {
  const objective = effectiveObjectiveKind(record);
  if (objective === null) {
    return false;
  }
  if (isOpeningNeutralProgress(record)) {
    return true;
  }
  if (actionKindMatchesObjective(record.chosenActionKind, record.chosenActionID, objective)) {
    return true;
  }
  const batchActionIDs = metadataString(record.decisionMetadata, "batchActionIDs");
  if (batchActionIDs === null || batchActionIDs.length === 0) {
    return false;
  }
  return batchActionIDs
    .split(",")
    .map((actionID) => actionID.trim())
    .some((actionID) => actionIDMatchesObjective(actionID, objective));
}

function isOpeningNeutralProgress(record: AgentDecisionRecord): boolean {
  const openingTempo = record.tacticalAffordances?.openingExpansionTempo;
  return (
    isNeutralExpansionAction(record) &&
    (openingTempo?.neutralExpansionAvailable === true ||
      record.tacticalAffordances?.frontierConversionTiming
        ?.neutralExpansionAvailable === true) &&
    (record.turnNumber <= 1_400 ||
      (openingTempo?.recommended === true &&
        openingTempo.behindExpectedTempo === true) ||
      !hasExecutorReadyWeakNeighborAttack(record)) &&
    !hasExecutorReadyWeakNeighborAttack(record)
  );
}

function actionKindMatchesObjective(
  kind: LegalActionKind,
  actionID: string,
  objective: string,
): boolean {
  if (objective === "expand_territory") {
    return kind === "boat" || (kind === "attack" && actionID.includes("terra-nullius"));
  }
  if (objective === "pressure_rival") {
    return (
      (kind === "attack" && !actionID.includes("terra-nullius")) ||
      kind === "target_player" ||
      kind === "embargo" ||
      kind === "embargo_all" ||
      kind === "break_alliance"
    );
  }
  if (objective === "build_alliance") {
    return (
      kind === "alliance_request" ||
      kind === "alliance_extend" ||
      kind === "donate_gold" ||
      kind === "donate_troops" ||
      kind === "quick_chat" ||
      kind === "emoji"
    );
  }
  if (objective === "secure_economy") {
    return kind === "build" || kind === "upgrade_structure";
  }
  if (objective === "fortify_border" || objective === "survive") {
    return (
      kind === "retreat" ||
      kind === "boat_retreat" ||
      kind === "build" ||
      kind === "upgrade_structure" ||
      kind === "delete_unit" ||
      kind === "hold"
    );
  }
  if (objective === "choose_spawn") {
    return kind === "spawn";
  }
  return false;
}

function actionIDMatchesObjective(actionID: string, objective: string): boolean {
  if (objective === "expand_territory") {
    return actionID.startsWith("boat:") || actionID.startsWith("expand:terra-nullius");
  }
  if (objective === "pressure_rival") {
    return (
      (actionID.startsWith("attack:") && !actionID.startsWith("expand:")) ||
      actionID.startsWith("target:") ||
      actionID.startsWith("embargo:") ||
      actionID.startsWith("embargo_all:") ||
      actionID.startsWith("break_alliance:") ||
      actionID.includes(":attack.")
    );
  }
  if (objective === "build_alliance") {
    return (
      actionID.startsWith("alliance:") ||
      actionID.startsWith("donate_") ||
      actionID.includes(":misc.team_up") ||
      actionID.startsWith("emoji:")
    );
  }
  if (objective === "secure_economy") {
    return /build:(City|Factory|Port)/i.test(actionID);
  }
  if (objective === "fortify_border" || objective === "survive") {
    return (
      actionID.startsWith("retreat:") ||
      actionID.startsWith("boat_retreat:") ||
      actionID.startsWith("build:") ||
      actionID.startsWith("upgrade_structure:") ||
      actionID.startsWith("delete_unit:") ||
      actionID === "hold"
    );
  }
  if (objective === "choose_spawn") {
    return actionID.startsWith("spawn:");
  }
  return false;
}

function isNeutralExpansionAction(record: AgentDecisionRecord): boolean {
  return (
    (record.chosenActionKind === "attack" &&
      record.chosenActionMetadata?.expansion === true) ||
    (record.chosenActionKind === "boat" &&
      (record.chosenActionMetadata?.targetID === null ||
        record.chosenActionMetadata?.targetID === undefined))
  );
}

function isHostileAttackAction(record: AgentDecisionRecord): boolean {
  return (
    record.chosenActionKind === "attack" &&
    record.chosenActionMetadata?.expansion !== true
  );
}

function isBuildMoment(record: AgentDecisionRecord): boolean {
  return (
    record.turnNumber > 0 &&
    (record.chosenActionKind === "build" ||
      record.chosenActionKind === "upgrade_structure" ||
      record.chosenActionKind === "nuke")
  );
}

function isCombatMoment(record: AgentDecisionRecord): boolean {
  return (
    record.turnNumber > 0 &&
    ((record.chosenActionKind === "attack" &&
      record.chosenActionMetadata?.expansion !== true) ||
      record.chosenActionKind === "nuke" ||
      record.chosenActionKind === "warship" ||
      record.chosenActionKind === "move_warship" ||
      record.chosenActionKind === "break_alliance" ||
      record.chosenActionKind === "embargo" ||
      record.chosenActionKind === "embargo_all")
  );
}

function isDiplomacyMoment(record: AgentDecisionRecord): boolean {
  return socialActionKinds.has(record.chosenActionKind);
}

const socialActionKinds = new Set<LegalActionKind>([
  "alliance_request",
  "alliance_reject",
  "alliance_extend",
  "break_alliance",
  "target_player",
  "emoji",
  "quick_chat",
  "donate_gold",
  "donate_troops",
  "embargo",
  "embargo_stop",
  "embargo_all",
]);

function hasSafeEconomyBuild(record: AgentDecisionRecord): boolean {
  return [
    ...(record.legalActionIDsByKind.build ?? []),
    ...(record.legalActionIDsByKind.upgrade_structure ?? []),
  ].some((actionID) => /City|Factory|Port/i.test(actionID));
}

function hasSameDecisionEconomyHandoff(record: AgentDecisionRecord): boolean {
  const batchActionIDs = metadataString(record.decisionMetadata, "batchActionIDs");
  if (batchActionIDs === null || batchActionIDs.length === 0) {
    return false;
  }
  return batchActionIDs
    .split(",")
    .map((actionID) => actionID.trim())
    .some((actionID) => /build:(City|Factory|Port)/i.test(actionID));
}

function hasUsefulNonHoldAlternative(record: AgentDecisionRecord): boolean {
  return Object.entries(record.legalActionIDsByKind).some(
    ([kind, actionIDs]) =>
      kind !== "hold" &&
      kind !== "spawn" &&
      Array.isArray(actionIDs) &&
      actionIDs.length > 0,
  );
}

function hasExecutorReadyWeakNeighborAttack(record: AgentDecisionRecord): boolean {
  const conversion = record.tacticalAffordances?.frontierConversionTiming;
  const finish = record.tacticalAffordances?.frontierFinishPressure;
  if (
    (record.chosenActionKind === "retreat" ||
      record.chosenActionKind === "boat_retreat") &&
    ((conversion?.homeDanger !== undefined && conversion.homeDanger !== "low") ||
      (finish?.homeDanger !== undefined && finish.homeDanger !== "low"))
  ) {
    return false;
  }
  const conversionTargetID = conversion?.bestExecutorReadyTargetID ?? null;
  const conversionIsStrongEnough =
    conversion?.recommended === true &&
    conversion.executorReady === true &&
    conversionTargetID !== null &&
    conversion.homeDanger !== "high" &&
    (conversion.executorReadyHostileAttackActionCount ?? 0) > 0 &&
    ((conversion.bestExecutorReadyRelativeTroopRatio ?? 0) >= 1.35 ||
      (conversion.bestExecutorReadyTileShare ?? 1) <= 0.05 ||
      conversion.neutralExpansionAvailable !== true);
  const finishTargetID = finish?.bestTargetID ?? null;
  const finishIsStrongEnough =
    finish?.recommended === true &&
    (finish.decisiveAttackActionCount ?? 0) > 0 &&
    finishTargetID !== null &&
    finish.homeDanger !== "high";
  return (
    (record.legalActionIDsByKind.attack?.length ?? 0) > 0 &&
    ((conversionIsStrongEnough &&
      hasUnblockedHighScoringHostileAlternative(record, conversionTargetID)) ||
      (finishIsStrongEnough &&
        hasUnblockedHighScoringHostileAlternative(record, finishTargetID)))
  );
}

function hasUnblockedHighScoringHostileAlternative(
  record: AgentDecisionRecord,
  targetID: string | null,
): boolean {
  const attackIDs = record.legalActionIDsByKind.attack ?? [];
  const targetAttackIDs =
    targetID === null
      ? attackIDs.filter((actionID) => !actionID.includes("terra-nullius"))
      : attackIDs.filter((actionID) => actionID.startsWith(`attack:${targetID}:`));
  if (targetAttackIDs.length === 0) {
    return false;
  }
  const alternatives = metadataString(
    record.decisionMetadata,
    "alternativesConsidered",
  );
  const blocked = metadataString(
    record.decisionMetadata,
    "blockedHostileAttackSummary",
  );
  return targetAttackIDs.some((actionID) => {
    if (hostileActionHasSevereBlocker(actionID, blocked)) {
      return false;
    }
    const score = alternativeScore(actionID, alternatives);
    return score === null || score >= 80;
  });
}

function hostileActionHasSevereBlocker(
  actionID: string,
  blockedSummary: string | null,
): boolean {
  if (blockedSummary === null || blockedSummary.length === 0) {
    return false;
  }
  const entry =
    blockedSummary
      .split(",")
      .find((item) => item.trim().startsWith(`${actionID}:`)) ?? "";
  if (entry.length === 0) {
    return false;
  }
  return [
    "attacking a stronger rival feeds them troops",
    "attack would deplete the reserve",
    "urgent defense",
    "active pressure makes new wars unsafe",
    "blocking policy penalty",
    "max concurrent wars already reached",
    "finish current war before opening another front",
    "finish favorable current war before switching fronts",
  ].some((blocker) => entry.includes(blocker));
}

function alternativeScore(
  actionID: string,
  alternatives: string | null,
): number | null {
  if (alternatives === null || alternatives.length === 0) {
    return null;
  }
  const escaped = actionID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = alternatives.match(new RegExp(`(?:^|,)${escaped}:(\\d+)`));
  if (match === null) {
    return null;
  }
  return Number.parseInt(match[1] ?? "", 10);
}

function holdReasonCategory(record: AgentDecisionRecord): AgentHoldReasonCategory {
  const explicit = metadataString(record.decisionMetadata, "holdReasonCategory");
  if (isHoldReasonCategory(explicit)) {
    return explicit;
  }
  const reason = `${record.reason} ${metadataString(record.decisionMetadata, "blockedHostileAttackSummary") ?? ""}`.toLowerCase();
  if (reason.includes("transport") && reason.includes("wait")) {
    return "transport_wait";
  }
  if (
    reason.includes("blocked hostile") ||
    reason.includes("attack safety") ||
    reason.includes("safety")
  ) {
    return "attack_safety";
  }
  if (reason.includes("support") && reason.includes("cooldown")) {
    return "support_cooldown";
  }
  if (!hasUsefulNonHoldAlternative(record)) {
    return "no_safe_non_hold";
  }
  return "unexplained";
}

function isHoldReasonCategory(value: string | null): value is AgentHoldReasonCategory {
  return (
    value === "transport_wait" ||
    value === "attack_safety" ||
    value === "support_cooldown" ||
    value === "no_safe_non_hold" ||
    value === "unexplained"
  );
}

function isDefensePostBuild(record: AgentDecisionRecord): boolean {
  if (record.chosenActionKind !== "build") {
    return false;
  }
  const unit = metadataString(record.chosenActionMetadata, "unit");
  return normalizeUnit(unit) === normalizeUnit(UnitType.DefensePost);
}

function isPoorDefensePostRecord(record: AgentDecisionRecord): boolean {
  const metadata = record.chosenActionMetadata;
  if (metadata === undefined) {
    return false;
  }
  const hasPlacementMetadata =
    metadata.defensiveValue !== undefined ||
    metadata.frontierValue !== undefined ||
    metadata.hostileBorderDistance !== undefined;
  if (!hasPlacementMetadata) {
    return false;
  }
  const defensiveValue = metadataNumber(metadata, "defensiveValue");
  const nearbyEnemyCount = metadataNumber(metadata, "nearbyEnemyCount");
  const hostileBorderDistance = metadataNumber(
    metadata,
    "hostileBorderDistance",
  );
  return (
    metadata.nearbyIncomingAttack !== true &&
    nearbyEnemyCount === 0 &&
    defensiveValue < 0.28 &&
    (hostileBorderDistance === 0 || hostileBorderDistance > 60)
  );
}

function diplomacyHasFollowThrough(
  record: AgentDecisionRecord,
  allRecords: AgentDecisionRecord[],
): boolean {
  const targetID = metadataString(record.chosenActionMetadata, "targetID")
    ?? metadataString(record.chosenActionMetadata, "recipientID")
    ?? metadataString(record.chosenActionMetadata, "playerID");
  const reason = record.reason.toLowerCase();
  const metadataText = [
    metadataString(record.chosenActionMetadata, "message"),
    metadataString(record.chosenActionMetadata, "legalReason"),
    metadataString(record.chosenActionMetadata, "emojiContext"),
    metadataString(record.chosenActionMetadata, "quickChatKey"),
  ]
    .filter((value): value is string => value !== null)
    .join(" ")
    .toLowerCase();
  if (
    reason.includes("respond") ||
    reason.includes("coordinate") ||
    metadataText.includes("coordinate") ||
    metadataText.includes("alliance_signal") ||
    metadataText.includes("betrayal_signal") ||
    metadataText.includes("disapproval")
  ) {
    return true;
  }
  if (
    record.chosenActionKind === "quick_chat" &&
    (metadataString(record.chosenActionMetadata, "quickChatKey") ===
      "attack.focus" ||
      metadataString(record.chosenActionMetadata, "quickChatKey")?.startsWith(
        "defend.",
      ) === true) &&
    metadataString(record.chosenActionMetadata, "targetID") !== null
  ) {
    return true;
  }
  if (
    record.chosenActionKind === "alliance_request" ||
    record.chosenActionKind === "alliance_extend" ||
    record.chosenActionKind === "donate_gold" ||
    record.chosenActionKind === "donate_troops" ||
    record.chosenActionKind === "break_alliance" ||
    record.chosenActionKind === "target_player" ||
    record.chosenActionKind === "embargo" ||
    record.chosenActionKind === "embargo_stop" ||
    record.chosenActionKind === "embargo_all"
  ) {
    return true;
  }
  return allRecords.some((candidate) => {
    if (
      candidate.agentID !== record.agentID ||
      candidate.sequence === record.sequence ||
      Math.abs(candidate.sequence - record.sequence) > 3
    ) {
      return false;
    }
    if (targetID !== null && targetID !== actionTargetID(candidate)) {
      return false;
    }
    return (
      isHostileAttackAction(candidate) ||
      candidate.chosenActionKind === "alliance_request" ||
      candidate.chosenActionKind === "alliance_extend" ||
      candidate.chosenActionKind === "donate_gold" ||
      candidate.chosenActionKind === "donate_troops" ||
      candidate.chosenActionKind === "break_alliance" ||
      candidate.chosenActionKind === "embargo" ||
      candidate.chosenActionKind === "target_player"
    );
  });
}

function actionTargetID(record: AgentDecisionRecord): string | null {
  return (
    metadataString(record.chosenActionMetadata, "targetID") ??
    metadataString(record.chosenActionMetadata, "recipientID") ??
    metadataString(record.chosenActionMetadata, "playerID")
  );
}

function plannerRefreshed(record: AgentDecisionRecord): boolean {
  return (
    metadataBoolean(record.decisionMetadata, "plannerRan") === true ||
    metadataString(record.decisionMetadata, "plannerRefreshReason") !==
      "active_plan_reused"
  );
}

function maxExactActionRepeatAfterSpawn(records: AgentDecisionRecord[]): number {
  let previousActionID: string | null = null;
  let streak = 0;
  let maxRepeats = 0;
  for (const record of records.filter(isPostSpawnRecord)) {
    if (record.chosenActionID === previousActionID) {
      streak += 1;
    } else {
      previousActionID = record.chosenActionID;
      streak = 0;
    }
    maxRepeats = Math.max(maxRepeats, streak);
  }
  return maxRepeats;
}

function legalAlternatives(record: AgentDecisionRecord): string[] {
  return Object.entries(record.legalActionIDsByKind)
    .flatMap(([kind, actionIDs]) =>
      (actionIDs ?? []).slice(0, 4).map((actionID) => `${kind}:${actionID}`),
    )
    .slice(0, 12);
}

function issueCategorySummary(
  issues: AgentBehaviorQualityIssue[],
): AgentBehaviorQualityAggregate["topIssueCategories"] {
  const counts = new Map<
    AgentBehaviorQualityIssueCategory,
    { count: number; maxSeverity: AgentBehaviorQualityIssueSeverity }
  >();
  for (const issueItem of issues) {
    const current = counts.get(issueItem.category);
    if (current === undefined) {
      counts.set(issueItem.category, {
        count: 1,
        maxSeverity: issueItem.severity,
      });
      continue;
    }
    current.count += 1;
    if (
      severityRank[issueItem.severity] > severityRank[current.maxSeverity]
    ) {
      current.maxSeverity = issueItem.severity;
    }
  }
  return [...counts.entries()]
    .map(([category, value]) => ({
      category,
      count: value.count,
      maxSeverity: value.maxSeverity,
    }))
    .sort(
      (a, b) =>
        severityRank[b.maxSeverity] - severityRank[a.maxSeverity] ||
        b.count - a.count ||
        a.category.localeCompare(b.category),
    );
}

function topIssueText(
  topIssueCategories: AgentBehaviorQualityAggregate["topIssueCategories"],
): string[] {
  return topIssueCategories
    .slice(0, 3)
    .map(
      (issueItem) =>
        `${issueItem.category}: ${issueItem.count} issue${issueItem.count === 1 ? "" : "s"} (max ${issueItem.maxSeverity})`,
    );
}

function behaviorHighlights(
  aggregate: AgentBehaviorQualityAggregate,
): string[] {
  const highlights: string[] = [];
  if (aggregate.visibleArc.expansion) {
    highlights.push("Agents visibly expanded into neutral territory after spawn.");
  }
  if (aggregate.visibleArc.build) {
    highlights.push("Agents produced at least one visible economy or infrastructure beat.");
  }
  if (aggregate.visibleArc.combat) {
    highlights.push("Agents applied at least one visible hostile pressure or combat action.");
  }
  if (aggregate.visibleArc.diplomacy) {
    highlights.push("Agents used at least one visible diplomacy or social action.");
  }
  if (
    aggregate.weakRivalConversionOpportunityCount > 0 &&
    aggregate.weakRivalConversionMissRate <= 0.25
  ) {
    highlights.push("Executor-ready weak-rival pressure was mostly acted on.");
  }
  if (
    aggregate.diplomacyActionCount > 0 &&
    aggregate.diplomacyFollowThroughRate >= 0.6
  ) {
    highlights.push("Most social actions had nearby strategic follow-through.");
  }
  return highlights;
}

function recommendedNextFixes(
  issues: AgentBehaviorQualityIssue[],
  aggregate: AgentBehaviorQualityAggregate,
): string[] {
  const fixes = new Map<AgentBehaviorQualityIssueCategory, string>();
  for (const issueItem of issues) {
    if (!fixes.has(issueItem.category)) {
      fixes.set(issueItem.category, issueItem.recommendedPlannerExecutorFix);
    }
  }
  if (!aggregate.visibleArc.build) {
    fixes.set(
      "early_only_arc",
      "Add a phase-policy scoring bump that turns stable expansion into City, Factory, Port, SAM, or silo when legal and safe.",
    );
  }
  if (!aggregate.visibleArc.combat) {
    fixes.set(
      "missed_weak_neighbor_attack",
      "Increase the direct executor override for safe favorable attacks once opening growth is no longer urgent.",
    );
  }
  if (!aggregate.visibleArc.diplomacy) {
    fixes.set(
      "empty_diplomacy",
      "Schedule one purposeful social beat only when it has a visible target, ally, rival, or follow-through action.",
    );
  }
  return [...fixes.values()].slice(0, 5);
}

function dedupeIssueWindow(
  issues: AgentBehaviorQualityIssue[],
  category: AgentBehaviorQualityIssueCategory,
): AgentBehaviorQualityIssue[] {
  const output: AgentBehaviorQualityIssue[] = [];
  const lastSequenceByAgent = new Map<string, number>();
  for (const issueItem of issues) {
    if (issueItem.category !== category) {
      output.push(issueItem);
      continue;
    }
    const previous = lastSequenceByAgent.get(issueItem.agentID);
    if (previous !== undefined && issueItem.sequence - previous <= 2) {
      continue;
    }
    output.push(issueItem);
    lastSequenceByAgent.set(issueItem.agentID, issueItem.sequence);
  }
  return output;
}

function issueSort(
  a: AgentBehaviorQualityIssue,
  b: AgentBehaviorQualityIssue,
): number {
  return (
    severityRank[b.severity] - severityRank[a.severity] ||
    a.turnNumber - b.turnNumber ||
    a.sequence - b.sequence ||
    a.category.localeCompare(b.category)
  );
}

function gradeForScore(score: number): AgentBehaviorQualityGrade {
  if (score >= 82) {
    return "demo_ready";
  }
  if (score >= 72) {
    return "watchable";
  }
  if (score >= 55) {
    return "rough";
  }
  return "embarrassing";
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function passFail(value: boolean): string {
  return value ? "pass" : "fail";
}

function metadataString(
  metadata: Record<string, string | number | boolean | null> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" ? value : null;
}

function metadataNumber(
  metadata: Record<string, string | number | boolean | null> | undefined,
  key: string,
): number {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function metadataBoolean(
  metadata: Record<string, string | number | boolean | null> | undefined,
  key: string,
): boolean | null {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : null;
}

function normalizeUnit(unit: string | null): string {
  return (unit ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function markdownTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ].join("\n");
}

function markdownCell(value: string | number | boolean | null): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}
