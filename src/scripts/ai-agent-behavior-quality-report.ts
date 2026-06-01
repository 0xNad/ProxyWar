import fs from "fs/promises";
import path from "path";
import {
  behaviorQualitySummary,
  buildAgentBehaviorQualityReport,
  writeAgentBehaviorQualityArtifacts,
} from "../server/agents/AgentBehaviorQualityReport";
import { writeAgentDemoIndex } from "../server/agents/AgentDemoIndexWriter";
import {
  ProxyWarMatchPackageSummary,
  writeProxyWarMatchPackageArtifacts,
} from "../server/agents/ProxyWarMatchPackage";
import {
  AgentBrainType,
  AgentActionAuditSnapshot,
  AgentActionAuditStatus,
  AgentDecisionRecord,
  AgentStrategyProfile,
  AgentTacticalAffordances,
  LegalActionKind,
} from "../server/agents/AgentTypes";

const args = process.argv.slice(2);
const runID = stringArg(args, "--run-id=");
if (runID === null || runID.trim().length === 0) {
  throw new Error("Usage: npm run agent:quality:report -- --run-id=<run-id>");
}

const runsRootDir =
  stringArg(args, "--runs-root=") ??
  path.join(process.cwd(), "artifacts", "ai-league-runs");
const directory = path.join(runsRootDir, runID);
const summaryPath = path.join(directory, "match-summary.json");
const decisionsPath = path.join(directory, "decisions.jsonl");
const summary = JSON.parse(
  await fs.readFile(summaryPath, "utf8"),
) as ExistingMatchSummary;
const decisions = await readDecisionLog(decisionsPath, summary);
const report = buildAgentBehaviorQualityReport({
  runID: summary.runID ?? runID,
  matchID: summary.matchID ?? "unknown",
  scenario: summary.scenario ?? "unknown",
  brainMode: brainType(summary.brainMode),
  records: decisions,
});
const reportPaths = await writeAgentBehaviorQualityArtifacts({
  report,
  directory,
});

const nextSummary = {
  ...summary,
  behaviorQuality: behaviorQualitySummary(report, "behavior-quality-report.md"),
  behaviorQualityPath: "behavior-quality-report.json",
  behaviorQualityMarkdownPath: "behavior-quality-report.md",
};
await fs.writeFile(summaryPath, `${JSON.stringify(nextSummary, null, 2)}\n`);
await writeProxyWarMatchPackageArtifacts({
  directory,
  summary: nextSummary as ProxyWarMatchPackageSummary,
});
await writeAgentDemoIndex({ runsRootDir });

console.log("Behavior quality report generated", {
  runID,
  score: report.score,
  grade: report.grade,
  pass: report.pass,
  jsonPath: reportPaths.jsonPath,
  markdownPath: reportPaths.markdownPath,
});

interface ExistingMatchSummary extends ProxyWarMatchPackageSummary {
  brainMode?: string;
  scenario?: string;
}

interface DecisionLogJson {
  sequence?: number;
  runID?: string;
  matchID?: string;
  turnNumber?: number;
  timestamp?: string;
  agentID?: string;
  clientID?: string | null;
  username?: string;
  profile?: string;
  brainType?: string;
  decisionLatencyMs?: number;
  observationSummary?: string;
  strategicPriority?: AgentDecisionRecord["strategicPriority"];
  strategicUrgency?: AgentDecisionRecord["strategicUrgency"];
  strategicSummary?: string;
  memorySummary?: string;
  objectiveKind?: AgentDecisionRecord["objectiveKind"];
  objectiveSummary?: string;
  objectiveAligned?: boolean;
  legalActionIDsByKind?: Partial<Record<LegalActionKind, string[]>>;
  selectedLegalActionId?: string;
  selectedActionKind?: LegalActionKind;
  selectedActionMetadata?: Record<string, string | number | boolean | null>;
  tacticalAffordances?: AgentTacticalAffordances;
  reason?: string;
  generatedIntent?: AgentDecisionRecord["intent"];
  result?: AgentDecisionRecord["result"];
  auditStatus?: AgentActionAuditStatus;
  auditReason?: string;
  auditBefore?: AgentActionAuditSnapshot | null;
  auditAfter?: AgentActionAuditSnapshot | null;
  auditTargetBefore?: AgentActionAuditSnapshot | null;
  auditTargetAfter?: AgentActionAuditSnapshot | null;
  plannerRefreshReason?: string;
  planObjective?: string;
  activePolicyObjective?: string;
  alternativesConsidered?: string;
  blockedHostileAttackSummary?: string;
  batchActionIDs?: string | string[];
  batchIndex?: number;
  plannerRan?: boolean;
  holdReasonCategory?: string;
  fallbackUsed?: boolean;
}

async function readDecisionLog(
  decisionsPath: string,
  summary: ExistingMatchSummary,
): Promise<AgentDecisionRecord[]> {
  const raw = await fs.readFile(decisionsPath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => decisionRecordFromLog(JSON.parse(line), summary));
}

function decisionRecordFromLog(
  entry: DecisionLogJson,
  summary: ExistingMatchSummary,
): AgentDecisionRecord {
  const legalActionIDsByKind = entry.legalActionIDsByKind ?? {};
  const selectedLegalActionId = stringValue(entry.selectedLegalActionId, "hold");
  const batchActionIDs = Array.isArray(entry.batchActionIDs)
    ? entry.batchActionIDs
    : typeof entry.batchActionIDs === "string"
      ? entry.batchActionIDs
          .split(",")
          .map((actionID) => actionID.trim())
          .filter((actionID) => actionID.length > 0)
      : [];
  const inferredBatchIndex =
    entry.batchIndex ??
    (batchActionIDs.length > 0 ? batchActionIDs.indexOf(selectedLegalActionId) : 0);
  return {
    sequence: numberValue(entry.sequence),
    gameID: stringValue(entry.matchID ?? summary.matchID, "unknown"),
    agentID: stringValue(entry.agentID, "agent"),
    clientID: stringOrNull(entry.clientID),
    username: stringValue(entry.username, "Agent"),
    profile: strategyProfile(entry.profile),
    brainType: brainType(entry.brainType ?? summary.brainMode),
    turnNumber: numberValue(entry.turnNumber),
    decidedAt: timestampValue(entry.timestamp),
    decisionLatencyMs: numberValue(entry.decisionLatencyMs),
    observationSummary: stringValue(entry.observationSummary, ""),
    ...(entry.strategicPriority !== undefined
      ? { strategicPriority: entry.strategicPriority }
      : {}),
    ...(entry.strategicUrgency !== undefined
      ? { strategicUrgency: entry.strategicUrgency }
      : {}),
    ...(entry.strategicSummary !== undefined
      ? { strategicSummary: entry.strategicSummary }
      : {}),
    ...(entry.memorySummary !== undefined
      ? { memorySummary: entry.memorySummary }
      : {}),
    ...(entry.objectiveKind !== undefined
      ? { objectiveKind: entry.objectiveKind }
      : {}),
    ...(entry.objectiveSummary !== undefined
      ? { objectiveSummary: entry.objectiveSummary }
      : {}),
    ...(entry.objectiveAligned !== undefined
      ? { objectiveAligned: entry.objectiveAligned }
      : {}),
    legalActionIDs: Object.values(legalActionIDsByKind).flat(),
    legalActionIDsByKind,
    attackActionIDs: legalActionIDsByKind.attack ?? [],
    chosenActionID: selectedLegalActionId,
    chosenActionKind: entry.selectedActionKind ?? "hold",
    reason: stringValue(entry.reason, ""),
    decisionMetadata: {
      ...(entry.plannerRefreshReason !== undefined
        ? { plannerRefreshReason: entry.plannerRefreshReason }
        : {}),
      ...(entry.planObjective !== undefined
        ? { planObjective: entry.planObjective }
        : {}),
      ...(entry.activePolicyObjective !== undefined
        ? { activePolicyObjective: entry.activePolicyObjective }
        : {}),
      ...(entry.alternativesConsidered !== undefined
        ? { alternativesConsidered: entry.alternativesConsidered }
        : {}),
      ...(entry.blockedHostileAttackSummary !== undefined
        ? { blockedHostileAttackSummary: entry.blockedHostileAttackSummary }
        : {}),
      ...(entry.batchActionIDs !== undefined
        ? {
            batchActionIDs: batchActionIDs.join(","),
          }
        : {}),
      ...(inferredBatchIndex >= 0 ? { batchIndex: inferredBatchIndex } : {}),
      ...(entry.plannerRan !== undefined ? { plannerRan: entry.plannerRan } : {}),
      ...(entry.holdReasonCategory !== undefined
        ? { holdReasonCategory: entry.holdReasonCategory }
        : {}),
      ...(entry.fallbackUsed !== undefined
        ? { fallbackUsed: entry.fallbackUsed }
        : {}),
    },
    ...(entry.selectedActionMetadata !== undefined
      ? { chosenActionMetadata: entry.selectedActionMetadata }
      : {}),
    ...(entry.tacticalAffordances !== undefined
      ? { tacticalAffordances: entry.tacticalAffordances }
      : {}),
    intent: entry.generatedIntent ?? null,
    result: entry.result ?? {
      accepted: true,
      reason: "unknown",
      submittedIntent: entry.generatedIntent ?? null,
    },
    audit:
      entry.auditStatus === undefined
        ? undefined
        : {
            auditStatus: entry.auditStatus,
            auditReason: stringValue(entry.auditReason, "unknown"),
            ...(entry.auditBefore !== undefined
              ? { before: entry.auditBefore }
              : {}),
            ...(entry.auditAfter !== undefined ? { after: entry.auditAfter } : {}),
            ...(entry.auditTargetBefore !== undefined
              ? { targetBefore: entry.auditTargetBefore }
              : {}),
            ...(entry.auditTargetAfter !== undefined
              ? { targetAfter: entry.auditTargetAfter }
              : {}),
          },
  };
}

function stringArg(args: string[], prefix: string): string | null {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timestampValue(value: unknown): number {
  if (typeof value !== "string") {
    return Date.now();
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function brainType(value: unknown): AgentBrainType {
  if (
    value === "rule" ||
    value === "mock-llm" ||
    value === "real-llm" ||
    value === "codex-cli" ||
    value === "external-http" ||
    value === "planner-executor" ||
    value === "llm"
  ) {
    return value;
  }
  return "planner-executor";
}

function strategyProfile(value: unknown): AgentStrategyProfile {
  if (
    value === "aggressive" ||
    value === "defensive" ||
    value === "diplomatic" ||
    value === "opportunistic"
  ) {
    return value;
  }
  return "opportunistic";
}
