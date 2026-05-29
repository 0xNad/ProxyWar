import fs from "fs/promises";
import path from "path";
import {
  AgentActionAuditStatus,
  AgentBrainType,
  AgentDecisionRecord,
  AgentStrategyProfile,
} from "./AgentTypes";

export interface AgentObjectiveScorecardInput {
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: AgentBrainType;
  records: AgentDecisionRecord[];
}

export interface AgentObjectiveScorecardAgent {
  agentID: string;
  username: string;
  profile: AgentStrategyProfile;
  brainType: AgentBrainType;
  decisionCount: number;
  postSpawnDecisionCount: number;
  nonHoldCount: number;
  objectiveAlignedCount: number;
  objectiveTrackedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  confirmedAuditCount: number;
  unknownAuditCount: number;
  failedAuditCount: number;
  notApplicableAuditCount: number;
  fallbackCount: number;
  parserFailureCount: number;
  repeatedActionCount: number;
  repeatedActionPenalty: number;
  rejectedIntentPenalty: number;
  fallbackPenalty: number;
  parserFailurePenalty: number;
  unknownAuditPenalty: number;
  failedAuditPenalty: number;
  objectiveAlignmentRate: number;
  acceptedIntentRate: number;
  auditedEffectRate: number;
  nonHoldRate: number;
  totalObjectiveScore: number;
  grade: "excellent" | "good" | "mixed" | "poor";
  summary: string;
  warnings: string[];
}

export interface AgentObjectiveScorecard {
  schemaVersion: 1;
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: AgentBrainType;
  generatedAt: string;
  aggregate: AgentObjectiveScorecardAgent;
  agents: AgentObjectiveScorecardAgent[];
}

export interface AgentObjectiveScorecardPaths {
  jsonPath: string;
  markdownPath: string;
}

export function buildAgentObjectiveScorecard(
  input: AgentObjectiveScorecardInput,
): AgentObjectiveScorecard {
  const groups = new Map<string, AgentDecisionRecord[]>();
  for (const record of input.records) {
    const records = groups.get(record.agentID) ?? [];
    records.push(record);
    groups.set(record.agentID, records);
  }

  const agents = [...groups.values()].map(scoreAgent);
  const aggregate = scoreAggregate(input.records, agents);

  return {
    schemaVersion: 1,
    runID: input.runID,
    matchID: input.matchID,
    scenario: input.scenario,
    brainMode: input.brainMode,
    generatedAt: new Date().toISOString(),
    aggregate,
    agents,
  };
}

export async function writeAgentObjectiveScorecardArtifacts(input: {
  scorecard: AgentObjectiveScorecard;
  directory: string;
}): Promise<AgentObjectiveScorecardPaths> {
  const jsonPath = path.join(input.directory, "objective-scorecard.json");
  const markdownPath = path.join(input.directory, "objective-scorecard.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(input.scorecard, null, 2)}\n`);
  await fs.writeFile(markdownPath, objectiveScorecardMarkdown(input.scorecard));
  return { jsonPath, markdownPath };
}

export function objectiveScorecardMarkdown(
  scorecard: AgentObjectiveScorecard,
): string {
  return [
    `# Objective Scorecard ${scorecard.runID}`,
    "",
    "## Run Summary",
    "",
    `- Match id: ${scorecard.matchID}`,
    `- Scenario: ${scorecard.scenario}`,
    `- Brain mode: ${scorecard.brainMode}`,
    `- Aggregate score: ${scorecard.aggregate.totalObjectiveScore}/100 (${scorecard.aggregate.grade})`,
    `- Objective alignment: ${percent(scorecard.aggregate.objectiveAlignmentRate)}`,
    `- Accepted intent rate: ${percent(scorecard.aggregate.acceptedIntentRate)}`,
    `- Audited effect rate: ${percent(scorecard.aggregate.auditedEffectRate)}`,
    `- Non-hold rate: ${percent(scorecard.aggregate.nonHoldRate)}`,
    "",
    "## Per-Agent Scorecard",
    "",
    markdownTable(
      [
        "Agent",
        "Profile",
        "Score",
        "Aligned",
        "Accepted",
        "Audit C/U/F",
        "Non-hold",
        "Repeat Penalty",
        "Warnings",
      ],
      scorecard.agents.map((agent) => [
        agent.username,
        agent.profile,
        `${agent.totalObjectiveScore} (${agent.grade})`,
        `${agent.objectiveAlignedCount}/${agent.objectiveTrackedCount} (${percent(agent.objectiveAlignmentRate)})`,
        `${agent.acceptedCount}/${agent.decisionCount} (${percent(agent.acceptedIntentRate)})`,
        `${agent.confirmedAuditCount}/${agent.unknownAuditCount}/${agent.failedAuditCount}`,
        `${agent.nonHoldCount}/${agent.postSpawnDecisionCount} (${percent(agent.nonHoldRate)})`,
        String(agent.repeatedActionPenalty),
        agent.warnings.join("; ") || "none",
      ]),
    ),
    "",
    "## How To Read This",
    "",
    "- Objective alignment checks whether selected actions matched the active objective attached to the observation.",
    "- Audited effect rate counts confirmed effects over confirmed + unknown + failed audits. Unknown audits are not treated as confirmed.",
    "- Repetition, rejected intents, parser failures, fallbacks, unknown audits, and failed audits reduce the final score.",
    "- A low score does not mean the game command failed; it means the agent behavior was less explainable or less aligned with its plan.",
    "",
  ].join("\n");
}

function scoreAgent(records: AgentDecisionRecord[]): AgentObjectiveScorecardAgent {
  const first = records[0]!;
  const metrics = countMetrics(records);
  const rates = scoreRates(metrics);
  const penalties = scorePenalties(metrics);
  const totalObjectiveScore = totalScore(rates, penalties);
  const warnings = scoreWarnings(metrics, rates);

  return {
    agentID: first.agentID,
    username: first.username,
    profile: first.profile,
    brainType: first.brainType,
    ...metrics,
    ...penalties,
    ...rates,
    totalObjectiveScore,
    grade: grade(totalObjectiveScore),
    summary: `${first.username} scored ${totalObjectiveScore}/100 with ${percent(
      rates.objectiveAlignmentRate,
    )} objective alignment and ${percent(rates.acceptedIntentRate)} accepted intents.`,
    warnings,
  };
}

function scoreAggregate(
  records: AgentDecisionRecord[],
  agents: AgentObjectiveScorecardAgent[],
): AgentObjectiveScorecardAgent {
  const metrics = countMetrics(records);
  const rates = scoreRates(metrics);
  const penalties = scorePenalties(metrics);
  const totalObjectiveScore =
    agents.length === 0
      ? 0
      : round(
          agents.reduce((sum, agent) => sum + agent.totalObjectiveScore, 0) /
            agents.length,
        );
  const warnings = scoreWarnings(metrics, rates);

  return {
    agentID: "aggregate",
    username: "All agents",
    profile: "opportunistic",
    brainType: records[0]?.brainType ?? "rule",
    ...metrics,
    ...penalties,
    ...rates,
    totalObjectiveScore,
    grade: grade(totalObjectiveScore),
    summary: `All agents averaged ${totalObjectiveScore}/100 across ${agents.length} participants.`,
    warnings,
  };
}

function countMetrics(records: AgentDecisionRecord[]) {
  const postSpawn = records.filter(
    (record) => record.turnNumber > 0 && record.chosenActionKind !== "spawn",
  );
  const objectiveTracked = records.filter(
    (record) => record.objectiveAligned !== undefined,
  );
  const audits = records.map((record) => record.audit?.auditStatus ?? auditStatus(record));
  const parserFailures = records.filter(
    (record) =>
      record.decisionMetadata?.llmParseOk === false ||
      record.decisionMetadata?.plannerParseOk === false,
  );

  return {
    decisionCount: records.length,
    postSpawnDecisionCount: postSpawn.length,
    nonHoldCount: postSpawn.filter((record) => record.chosenActionKind !== "hold")
      .length,
    objectiveAlignedCount: objectiveTracked.filter(
      (record) => record.objectiveAligned === true,
    ).length,
    objectiveTrackedCount: objectiveTracked.length,
    acceptedCount: records.filter((record) => record.result.accepted).length,
    rejectedCount: records.filter((record) => !record.result.accepted).length,
    confirmedAuditCount: audits.filter((status) => status === "confirmed").length,
    unknownAuditCount: audits.filter((status) => status === "unknown").length,
    failedAuditCount: audits.filter((status) => status === "failed").length,
    notApplicableAuditCount: audits.filter((status) => status === "not_applicable")
      .length,
    fallbackCount: records.filter(
      (record) =>
        record.decisionMetadata?.fallbackUsed === true ||
        record.decisionMetadata?.plannerFallbackUsed === true,
    ).length,
    parserFailureCount: parserFailures.length,
    repeatedActionCount: repeatedActionCount(postSpawn),
  };
}

function scoreRates(metrics: ReturnType<typeof countMetrics>) {
  const audited = metrics.confirmedAuditCount + metrics.unknownAuditCount + metrics.failedAuditCount;
  return {
    objectiveAlignmentRate: rate(
      metrics.objectiveAlignedCount,
      metrics.objectiveTrackedCount,
    ),
    acceptedIntentRate: rate(metrics.acceptedCount, metrics.decisionCount),
    auditedEffectRate: rate(metrics.confirmedAuditCount, audited),
    nonHoldRate: rate(metrics.nonHoldCount, metrics.postSpawnDecisionCount),
  };
}

function scorePenalties(metrics: ReturnType<typeof countMetrics>) {
  const denominator = Math.max(1, metrics.decisionCount);
  return {
    repeatedActionPenalty: round(Math.min(20, metrics.repeatedActionCount * 4)),
    rejectedIntentPenalty: round((metrics.rejectedCount / denominator) * 25),
    fallbackPenalty: round((metrics.fallbackCount / denominator) * 20),
    parserFailurePenalty: round((metrics.parserFailureCount / denominator) * 25),
    unknownAuditPenalty: round(
      (metrics.unknownAuditCount /
        Math.max(
          1,
          metrics.confirmedAuditCount +
            metrics.unknownAuditCount +
            metrics.failedAuditCount,
        )) *
        10,
    ),
    failedAuditPenalty: round((metrics.failedAuditCount / denominator) * 30),
  };
}

function totalScore(
  rates: ReturnType<typeof scoreRates>,
  penalties: ReturnType<typeof scorePenalties>,
): number {
  const base =
    rates.objectiveAlignmentRate * 35 +
    rates.acceptedIntentRate * 20 +
    rates.auditedEffectRate * 15 +
    rates.nonHoldRate * 15 +
    15;
  const penalty =
    penalties.repeatedActionPenalty +
    penalties.rejectedIntentPenalty +
    penalties.fallbackPenalty +
    penalties.parserFailurePenalty +
    penalties.unknownAuditPenalty +
    penalties.failedAuditPenalty;
  return round(clamp(base - penalty, 0, 100));
}

function repeatedActionCount(records: AgentDecisionRecord[]): number {
  let count = 0;
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]!;
    const current = records[index]!;
    if (
      current.chosenActionKind !== "hold" &&
      current.chosenActionKind === previous.chosenActionKind
    ) {
      count += 1;
    }
    if (
      current.chosenActionID !== "hold" &&
      current.chosenActionID === previous.chosenActionID
    ) {
      count += 1;
    }
  }
  return count;
}

function auditStatus(record: AgentDecisionRecord): AgentActionAuditStatus {
  if (!record.result.accepted) {
    return "not_applicable";
  }
  if (record.intent === null || record.chosenActionKind === "hold") {
    return "not_applicable";
  }
  return "unknown";
}

function scoreWarnings(
  metrics: ReturnType<typeof countMetrics>,
  rates: ReturnType<typeof scoreRates>,
): string[] {
  const warnings: string[] = [];
  if (metrics.unknownAuditCount > 0) {
    warnings.push(`${metrics.unknownAuditCount} accepted effects are audit-unknown`);
  }
  if (metrics.failedAuditCount > 0) {
    warnings.push(`${metrics.failedAuditCount} audits failed`);
  }
  if (metrics.rejectedCount > 0) {
    warnings.push(`${metrics.rejectedCount} intents were rejected`);
  }
  if (metrics.fallbackCount > 0) {
    warnings.push(`${metrics.fallbackCount} decisions used fallback`);
  }
  if (metrics.parserFailureCount > 0) {
    warnings.push(`${metrics.parserFailureCount} parser failures`);
  }
  if (metrics.repeatedActionCount > 0) {
    warnings.push(`${metrics.repeatedActionCount} repeated-action penalties`);
  }
  if (rates.objectiveAlignmentRate < 0.65 && metrics.objectiveTrackedCount > 0) {
    warnings.push("objective alignment below 65%");
  }
  return warnings;
}

function grade(score: number): AgentObjectiveScorecardAgent["grade"] {
  if (score >= 85) return "excellent";
  if (score >= 70) return "good";
  if (score >= 50) return "mixed";
  return "poor";
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
