import fs from "fs/promises";
import path from "path";
import { AgentBrainType, LegalActionKind } from "./AgentTypes";

export interface AgentEvaluationRunArtifact {
  runID: string;
  directory: string;
  decisionsPath: string;
  summaryPath: string;
  reportPath: string;
  visualReportPath: string;
  scorecardJsonPath?: string;
  scorecardMarkdownPath?: string;
}

export interface AgentEvaluationInput {
  evalID: string;
  brain: AgentBrainType;
  scenario: string;
  startedAt: number;
  completedAt: number;
  runs: AgentEvaluationRunArtifact[];
  rootDir?: string;
}

export interface AgentEvaluationPaths {
  evalID: string;
  directory: string;
  summaryPath: string;
  reportPath: string;
}

interface RunSummary {
  runID: string;
  scenario: string;
  brainMode: AgentBrainType;
  runnerMode: string;
  decisionCount: number;
  acceptedCount: number;
  rejectedCount: number;
  fallbackCount: number;
  parseFailureCount: number;
  postSpawnNonHoldActionCount: number;
  confirmedEffectCount?: number;
  unknownEffectCount?: number;
  failedEffectCount?: number;
  notApplicableEffectCount?: number;
  averageDecisionLatencyMs: number;
  actionCounts: Partial<Record<LegalActionKind, number>>;
  objectiveScore?: number;
  objectiveScoreGrade?: string;
}

interface ObjectiveScorecardSummary {
  aggregate: {
    totalObjectiveScore: number;
    grade: string;
    objectiveAlignmentRate: number;
    acceptedIntentRate: number;
    auditedEffectRate: number;
    nonHoldRate: number;
  };
}

interface DecisionEntry {
  sequence: number;
  turnNumber: number;
  username: string;
  selectedLegalActionId: string;
  selectedActionKind: LegalActionKind;
  reason: string;
  fallbackUsed: boolean;
  parseSuccess?: boolean;
  parseFailureReason?: string;
  decisionLatencyMs: number;
  result: { accepted: boolean; reason: string };
}

export async function writeAgentEvaluationArtifacts(
  input: AgentEvaluationInput,
): Promise<AgentEvaluationPaths> {
  const directory = path.join(
    input.rootDir ?? path.join(process.cwd(), "artifacts", "ai-league-evals"),
    safePathSegment(input.evalID),
  );
  await fs.mkdir(directory, { recursive: true });

  const runResults = await Promise.all(input.runs.map(loadRunResult));
  const summary = evaluationSummary(input, runResults);
  const summaryPath = path.join(directory, "evaluation-summary.json");
  const reportPath = path.join(directory, "evaluation-report.md");

  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(reportPath, evaluationReport(summary));

  return {
    evalID: input.evalID,
    directory,
    summaryPath,
    reportPath,
  };
}

async function loadRunResult(artifact: AgentEvaluationRunArtifact) {
  const summary = JSON.parse(
    await fs.readFile(artifact.summaryPath, "utf8"),
  ) as RunSummary;
  const decisions = (await fs.readFile(artifact.decisionsPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DecisionEntry);
  const visualReportExists = await exists(artifact.visualReportPath);
  const scorecardPath =
    artifact.scorecardJsonPath ??
    path.join(artifact.directory, "objective-scorecard.json");
  const scorecard = await readOptionalJson<ObjectiveScorecardSummary>(
    scorecardPath,
  );

  return {
    artifact,
    summary,
    decisions,
    visualReportExists,
    scorecard,
    scorecardPath,
  };
}

function evaluationSummary(
  input: AgentEvaluationInput,
  runs: Awaited<ReturnType<typeof loadRunResult>>[],
) {
  const decisions = runs.flatMap((run) => run.decisions);
  const actionCounts = runs.reduce<Partial<Record<LegalActionKind, number>>>(
    (counts, run) => {
      for (const [kind, count] of Object.entries(run.summary.actionCounts)) {
        const actionKind = kind as LegalActionKind;
        counts[actionKind] = (counts[actionKind] ?? 0) + Number(count ?? 0);
      }
      return counts;
    },
    {},
  );
  const accepted = decisions.filter((decision) => decision.result.accepted);
  const rejected = decisions.filter((decision) => !decision.result.accepted);
  const fallbacks = decisions.filter((decision) => decision.fallbackUsed);
  const parserFailures = decisions.filter(
    (decision) => decision.parseSuccess === false,
  );
  const providerErrors = decisions.filter((decision) =>
    providerFailureReason(decision.parseFailureReason),
  );
  const nonHold = decisions.filter(
    (decision) =>
      decision.selectedActionKind !== "hold" &&
      decision.selectedActionKind !== "spawn",
  );
  const latencies = decisions.map((decision) => decision.decisionLatencyMs);

  return {
    evalID: input.evalID,
    brain: input.brain,
    scenario: input.scenario,
    startedAt: new Date(input.startedAt).toISOString(),
    completedAt: new Date(input.completedAt).toISOString(),
    durationMs: input.completedAt - input.startedAt,
    runCount: runs.length,
    decisionCount: decisions.length,
    actionCounts,
    nonHoldRate: rate(nonHold.length, decisions.length),
    acceptedRate: rate(accepted.length, decisions.length),
    rejectedRate: rate(rejected.length, decisions.length),
    fallbackRate: rate(fallbacks.length, decisions.length),
    parserFailureRate: rate(parserFailures.length, decisions.length),
    providerTimeoutOrErrorCount: providerErrors.length,
    latencyStats: latencyStats(latencies),
    visualReportCount: runs.filter((run) => run.visualReportExists).length,
    objectiveScoreStats: numericStats(
      runs
        .map(
          (run) =>
            run.scorecard?.aggregate.totalObjectiveScore ??
            run.summary.objectiveScore,
        )
        .filter((value): value is number => typeof value === "number"),
    ),
    objectiveAlignmentRate: average(
      runs
        .map((run) => run.scorecard?.aggregate.objectiveAlignmentRate)
        .filter((value): value is number => typeof value === "number"),
    ),
    auditStats: {
      confirmed: runs.reduce(
        (sum, run) => sum + (run.summary.confirmedEffectCount ?? 0),
        0,
      ),
      unknown: runs.reduce(
        (sum, run) => sum + (run.summary.unknownEffectCount ?? 0),
        0,
      ),
      failed: runs.reduce(
        (sum, run) => sum + (run.summary.failedEffectCount ?? 0),
        0,
      ),
      notApplicable: runs.reduce(
        (sum, run) => sum + (run.summary.notApplicableEffectCount ?? 0),
        0,
      ),
    },
    runs: runs.map((run) => ({
      runID: run.artifact.runID,
      directory: run.artifact.directory,
      decisionsPath: run.artifact.decisionsPath,
      summaryPath: run.artifact.summaryPath,
      reportPath: run.artifact.reportPath,
      visualReportPath: run.artifact.visualReportPath,
      scorecardJsonPath: run.scorecardPath,
      scorecardExists: run.scorecard !== null,
      visualReportExists: run.visualReportExists,
      decisionCount: run.summary.decisionCount,
      acceptedCount: run.summary.acceptedCount,
      rejectedCount: run.summary.rejectedCount,
      fallbackCount: run.summary.fallbackCount,
      parseFailureCount: run.summary.parseFailureCount,
      postSpawnNonHoldActionCount: run.summary.postSpawnNonHoldActionCount,
      confirmedEffectCount: run.summary.confirmedEffectCount ?? 0,
      unknownEffectCount: run.summary.unknownEffectCount ?? 0,
      failedEffectCount: run.summary.failedEffectCount ?? 0,
      actionCounts: run.summary.actionCounts,
      averageDecisionLatencyMs: run.summary.averageDecisionLatencyMs,
      runnerMode: run.summary.runnerMode,
      objectiveScore:
        run.scorecard?.aggregate.totalObjectiveScore ?? run.summary.objectiveScore ?? 0,
      objectiveScoreGrade:
        run.scorecard?.aggregate.grade ?? run.summary.objectiveScoreGrade ?? "unknown",
    })),
    notableDecisions: decisions
      .filter(
        (decision) =>
          decision.selectedActionKind !== "hold" &&
          decision.selectedActionKind !== "spawn",
      )
      .slice(0, 12)
      .map((decision) => ({
        sequence: decision.sequence,
        turnNumber: decision.turnNumber,
        agent: decision.username,
        kind: decision.selectedActionKind,
        selectedLegalActionId: decision.selectedLegalActionId,
        accepted: decision.result.accepted,
        reason: decision.reason,
      })),
  };
}

function evaluationReport(
  summary: ReturnType<typeof evaluationSummary>,
): string {
  return [
    `# Proxy War Evaluation ${summary.evalID}`,
    "",
    "## Overview",
    "",
    `- Brain: ${summary.brain}`,
    `- Scenario: ${summary.scenario}`,
    `- Runs: ${summary.runCount}`,
    `- Decisions: ${summary.decisionCount}`,
    `- Non-hold rate: ${percent(summary.nonHoldRate)}`,
    `- Accepted rate: ${percent(summary.acceptedRate)}`,
    `- Rejected rate: ${percent(summary.rejectedRate)}`,
    `- Fallback rate: ${percent(summary.fallbackRate)}`,
    `- Parser failure rate: ${percent(summary.parserFailureRate)}`,
    `- Provider timeout/error count: ${summary.providerTimeoutOrErrorCount}`,
    `- Latency: min ${summary.latencyStats.minMs}ms / avg ${summary.latencyStats.avgMs}ms / max ${summary.latencyStats.maxMs}ms`,
    `- Visual reports: ${summary.visualReportCount}/${summary.runCount}`,
    `- Objective score: min ${summary.objectiveScoreStats.min} / avg ${summary.objectiveScoreStats.avg} / max ${summary.objectiveScoreStats.max}`,
    `- Objective alignment: ${percent(summary.objectiveAlignmentRate)}`,
    `- Effect audits: ${summary.auditStats.confirmed} confirmed / ${summary.auditStats.unknown} unknown / ${summary.auditStats.failed} failed / ${summary.auditStats.notApplicable} not applicable`,
    "",
    "## Action Counts",
    "",
    "```json",
    JSON.stringify(summary.actionCounts, null, 2),
    "```",
    "",
    "## Runs",
    "",
    markdownTable(
      [
        "Run",
        "Runner",
        "Decisions",
        "Accepted",
        "Fallbacks",
        "Parse Failures",
        "Non-hold",
        "Objective Score",
        "Audit C/U/F",
        "Visual",
        "Scorecard",
        "Report",
      ],
      summary.runs.map((run) => [
        run.runID,
        run.runnerMode,
        String(run.decisionCount),
        String(run.acceptedCount),
        String(run.fallbackCount),
        String(run.parseFailureCount),
        String(run.postSpawnNonHoldActionCount),
        `${run.objectiveScore} (${run.objectiveScoreGrade})`,
        `${run.confirmedEffectCount}/${run.unknownEffectCount}/${run.failedEffectCount}`,
        run.visualReportExists ? "yes" : "no",
        run.scorecardExists ? run.scorecardJsonPath : "missing",
        run.reportPath,
      ]),
    ),
    "",
    "## Notable Decisions",
    "",
    summary.notableDecisions.length === 0
      ? "No non-hold notable decisions were recorded."
      : markdownTable(
          ["Turn", "Agent", "Kind", "LegalAction.id", "Accepted", "Reason"],
          summary.notableDecisions.map((decision) => [
            String(decision.turnNumber),
            decision.agent,
            decision.kind,
            decision.selectedLegalActionId,
            decision.accepted ? "yes" : "no",
            decision.reason,
          ]),
        ),
    "",
  ].join("\n");
}

function latencyStats(values: number[]) {
  if (values.length === 0) {
    return { minMs: 0, avgMs: 0, maxMs: 0 };
  }
  return {
    minMs: Math.min(...values),
    avgMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    maxMs: Math.max(...values),
  };
}

function numericStats(values: number[]) {
  if (values.length === 0) {
    return { min: 0, avg: 0, max: 0 };
  }
  return {
    min: Math.min(...values),
    avg: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
    max: Math.max(...values),
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function providerFailureReason(reason: string | undefined): boolean {
  return /provider|timeout|timed out|Codex CLI|HTTP|unavailable|failed/i.test(
    reason ?? "",
  );
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

function safePathSegment(value: string): string {
  const segment = value.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    !/[A-Za-z0-9]/.test(segment)
  ) {
    throw new Error(`Invalid AI league evaluation id: ${value}`);
  }
  return segment;
}
