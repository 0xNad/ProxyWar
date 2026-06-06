import fs from "fs/promises";
import path from "path";
import { gameRecordFileIsRenderable } from "./AgentSpectatorReplay";
import type {
  ExternalAgentCoachingExample,
  ExternalAgentFeedback,
} from "./ExternalAgentFeedback";

interface RunIndexSummary {
  runID: string;
  matchID?: string;
  scenario?: string;
  brainMode?: string;
  runnerMode?: string;
  decisionCount?: number;
  acceptedCount?: number;
  rejectedCount?: number;
  fallbackCount?: number;
  parseFailureCount?: number;
  postSpawnNonHoldActionCount?: number;
  confirmedEffectCount?: number;
  unknownEffectCount?: number;
  failedEffectCount?: number;
  objectiveScore?: number;
  objectiveScoreGrade?: string;
  externalAgentCount?: number;
  externalAgentReadyForDeveloperReview?: boolean;
  behaviorQuality?: {
    score?: number;
    grade?: string;
    severeIssueCount?: number;
    pass?: boolean;
    topIssues?: string[];
  };
  matchStory?: {
    entertainmentScore?: number;
    grade?: string;
    boringnessWarnings?: string[];
  };
  spectator?: {
    snapshotCount?: number;
  } | null;
  completedAt?: string;
}

export interface AgentDemoRunFeedbackPreview {
  runID: string;
  summary: string;
  status: string;
  externalAgentCount: number;
  decisionCount: number;
  acceptedRate: number;
  nonHoldRate: number;
  fallbackCount: number;
  parserFailureCount: number;
  readyForDeveloperReview: boolean;
  topSuggestions: string[];
  priorityFixes: string[];
  exampleTurns: Array<{
    sequence: number;
    username: string;
    issue: string;
    chosenActionID: string;
    recommendedActionKinds: string[];
    policyHint: string;
  }>;
  practicePrompts: string[];
  agents: AgentDemoExternalAgentFeedbackPreview[];
}

export interface AgentDemoExternalAgentFeedbackPreview {
  agentID: string;
  username: string;
  profile: string;
  status: string;
  decisionCount: number;
  acceptedRate: number;
  nonHoldRate: number;
  fallbackCount: number;
  parserFailureCount: number;
  repeatedActionKindCount: number;
  repeatedExactActionCount: number;
  topSuggestion: string;
}

export interface AgentDemoRunIndexEntry extends RunIndexSummary {
  directory: string;
  visualReportPath: string;
  matchReportPath: string;
  decisionsPath: string;
  summaryPath: string;
  spectatorPath: string;
  scorecardJsonPath: string;
  scorecardMarkdownPath: string;
  externalFeedbackJsonPath: string;
  externalFeedbackMarkdownPath: string;
  behaviorQualityJsonPath?: string;
  behaviorQualityMarkdownPath?: string;
  matchStoryJsonPath: string;
  matchStoryMarkdownPath: string;
  matchPackageJsonPath: string;
  matchPackageMarkdownPath: string;
  matchPackageHtmlPath: string;
  matchPackageLinkFileName: "match-package.html" | "match-package.md";
  hasSpectatorReplay: boolean;
  hasOpenFrontReplay: boolean;
  hasScorecard: boolean;
  hasExternalFeedback: boolean;
  hasBehaviorQuality?: boolean;
  hasMatchStory: boolean;
  hasMatchPackage: boolean;
  externalFeedbackPreview?: AgentDemoRunFeedbackPreview;
}

export interface WriteAgentDemoIndexOptions {
  runsRootDir?: string;
  outputPath?: string;
  limit?: number;
}

export async function writeAgentDemoIndex(
  options: WriteAgentDemoIndexOptions = {},
): Promise<{ indexPath: string; runs: AgentDemoRunIndexEntry[] }> {
  const runsRootDir =
    options.runsRootDir ?? path.join(process.cwd(), "artifacts", "ai-league-runs");
  await fs.mkdir(runsRootDir, { recursive: true });

  const runs = await discoverRuns(runsRootDir, options.limit ?? 50);
  const indexPath = options.outputPath ?? path.join(runsRootDir, "index.html");
  await fs.writeFile(indexPath, demoIndexHtml(runs, runsRootDir));
  return { indexPath, runs };
}

async function discoverRuns(
  runsRootDir: string,
  limit: number,
): Promise<AgentDemoRunIndexEntry[]> {
  const dirents = await fs.readdir(runsRootDir, { withFileTypes: true });
  const directoryCandidates = recentDirectoryCandidates(dirents, limit);
  const candidates = await Promise.all(
    directoryCandidates
      .map(async (dirent) => {
        const directory = path.join(runsRootDir, dirent.name);
        const summaryPath = path.join(directory, "match-summary.json");
        const summary = await readSummary(summaryPath);
        if (summary === null) {
          return null;
        }
        const spectatorPath = path.join(directory, "spectator.html");
        const hasSpectatorReplay = await fileExists(spectatorPath);
        const hasOpenFrontReplay = await gameRecordFileIsRenderable(
          path.join(directory, "game-record.json"),
        );
        const scorecardJsonPath = path.join(directory, "objective-scorecard.json");
        const scorecardMarkdownPath = path.join(
          directory,
          "objective-scorecard.md",
        );
        const hasScorecard = await fileExists(scorecardJsonPath);
        const externalFeedbackJsonPath = path.join(
          directory,
          "external-agent-feedback.json",
        );
        const externalFeedbackMarkdownPath = path.join(
          directory,
          "external-agent-feedback.md",
        );
        const hasExternalFeedback = await fileExists(externalFeedbackMarkdownPath);
        const externalFeedbackPreview = await readExternalFeedbackPreview(
          externalFeedbackJsonPath,
        );
        const behaviorQualityJsonPath = path.join(
          directory,
          "behavior-quality-report.json",
        );
        const behaviorQualityMarkdownPath = path.join(
          directory,
          "behavior-quality-report.md",
        );
        const hasBehaviorQuality = await fileExists(behaviorQualityMarkdownPath);
        const matchStoryJsonPath = path.join(directory, "match-story.json");
        const matchStoryMarkdownPath = path.join(directory, "match-story.md");
        const hasMatchStory = await fileExists(matchStoryMarkdownPath);
        const matchPackageJsonPath = path.join(directory, "match-package.json");
        const matchPackageMarkdownPath = path.join(directory, "match-package.md");
        const matchPackageHtmlPath = path.join(directory, "match-package.html");
        const hasMatchPackageHtml = await fileExists(matchPackageHtmlPath);
        const hasMatchPackageMarkdown = await fileExists(matchPackageMarkdownPath);
        const hasMatchPackage = hasMatchPackageHtml || hasMatchPackageMarkdown;
        const entry: AgentDemoRunIndexEntry = {
          ...summary,
          runID: summary.runID ?? dirent.name,
          directory,
          visualReportPath: path.join(directory, "visual-report.html"),
          matchReportPath: path.join(directory, "match-report.md"),
          decisionsPath: path.join(directory, "decisions.jsonl"),
          summaryPath,
          spectatorPath,
          scorecardJsonPath,
          scorecardMarkdownPath,
          externalFeedbackJsonPath,
          externalFeedbackMarkdownPath,
          behaviorQualityJsonPath,
          behaviorQualityMarkdownPath,
          matchStoryJsonPath,
          matchStoryMarkdownPath,
          matchPackageJsonPath,
          matchPackageMarkdownPath,
          matchPackageHtmlPath,
          matchPackageLinkFileName: hasMatchPackageHtml
            ? "match-package.html"
            : "match-package.md",
          hasSpectatorReplay,
          hasOpenFrontReplay,
          hasScorecard,
          hasExternalFeedback,
          hasBehaviorQuality,
          hasMatchStory,
          hasMatchPackage,
        };
        if (externalFeedbackPreview !== undefined) {
          entry.externalFeedbackPreview = externalFeedbackPreview;
        }
        return entry;
      }),
  );

  return candidates
    .filter((entry): entry is AgentDemoRunIndexEntry => entry !== null)
    .sort((a, b) => timestamp(b.completedAt) - timestamp(a.completedAt))
    .slice(0, Math.max(1, limit));
}

function recentDirectoryCandidates<T extends { isDirectory(): boolean; name: string }>(
  dirents: T[],
  limit: number,
): T[] {
  const poolSize = Math.max(limit * 8, 160);
  return dirents
    .filter((dirent) => dirent.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, poolSize);
}

async function readExternalFeedbackPreview(
  feedbackPath: string,
): Promise<AgentDemoRunFeedbackPreview | undefined> {
  try {
    const feedback = JSON.parse(
      await fs.readFile(feedbackPath, "utf8"),
    ) as Partial<ExternalAgentFeedback>;
    const aggregate = feedback.aggregate;
    if (aggregate === undefined) {
      return undefined;
    }
    const coach = aggregate.iterationCoach;
    return {
      runID: stringValue(feedback.runID, "unknown"),
      summary: stringValue(aggregate.summary, "No summary available."),
      status: stringValue(coach?.status, "unknown"),
      externalAgentCount: numberValue(aggregate.externalAgentCount),
      decisionCount: numberValue(aggregate.decisionCount),
      acceptedRate: numberValue(aggregate.acceptedRate),
      nonHoldRate: numberValue(aggregate.nonHoldRate),
      fallbackCount: numberValue(aggregate.fallbackCount),
      parserFailureCount: numberValue(aggregate.parserFailureCount),
      readyForDeveloperReview: aggregate.readyForDeveloperReview === true,
      topSuggestions: stringArray(aggregate.topSuggestions, 4),
      priorityFixes: stringArray(coach?.priorityFixes, 4),
      exampleTurns: exampleTurns(coach?.exampleTurns, 2),
      practicePrompts: stringArray(coach?.practicePrompts, 2),
      agents: agentFeedbackPreviews(feedback.agents),
    };
  } catch {
    return undefined;
  }
}

function agentFeedbackPreviews(
  agents: ExternalAgentFeedback["agents"] | undefined,
): AgentDemoExternalAgentFeedbackPreview[] {
  if (!Array.isArray(agents)) {
    return [];
  }
  return agents.slice(0, 8).map((agent) => ({
    agentID: stringValue(agent.agentID, "agent"),
    username: stringValue(agent.username, "Agent"),
    profile: stringValue(agent.profile, "profile"),
    status: stringValue(agent.iterationCoach?.status, "unknown"),
    decisionCount: numberValue(agent.decisionCount),
    acceptedRate: numberValue(agent.acceptedRate),
    nonHoldRate: numberValue(agent.nonHoldRate),
    fallbackCount: numberValue(agent.fallbackCount),
    parserFailureCount: numberValue(agent.parserFailureCount),
    repeatedActionKindCount: numberValue(agent.repeatedActionKindCount),
    repeatedExactActionCount: numberValue(agent.repeatedExactActionCount),
    topSuggestion: stringValue(
      agent.iterationCoach?.priorityFixes[0] ??
        agent.improvementSuggestions[0] ??
        agent.warnings[0],
      "Keep testing longer matches.",
    ),
  }));
}

function exampleTurns(
  examples: ExternalAgentCoachingExample[] | undefined,
  limit: number,
): AgentDemoRunFeedbackPreview["exampleTurns"] {
  if (!Array.isArray(examples)) {
    return [];
  }
  return examples.slice(0, limit).map((example) => ({
    sequence: numberValue(example.sequence),
    username: stringValue(example.username, "agent"),
    issue: stringValue(example.issue, "Review this turn."),
    chosenActionID: stringValue(example.chosenActionID, "unknown"),
    recommendedActionKinds: stringArray(example.recommendedActionKinds, 4),
    policyHint: stringValue(example.policyHint, "Prefer a higher-impact legal action."),
  }));
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => stringValue(entry, ""))
    .filter((entry) => entry.length > 0)
    .slice(0, limit);
}

function stringValue(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  return trimmed.length > 360 ? `${trimmed.slice(0, 357)}...` : trimmed;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function readSummary(
  summaryPath: string,
): Promise<RunIndexSummary | null> {
  try {
    return JSON.parse(await fs.readFile(summaryPath, "utf8")) as RunIndexSummary;
  } catch {
    return null;
  }
}

function demoIndexHtml(
  runs: AgentDemoRunIndexEntry[],
  runsRootDir: string,
): string {
  const rows = runs
    .map(
      (run) => `
        <tr>
          <td><code>${escapeHtml(run.runID)}</code><span>${escapeHtml(run.completedAt ?? "unknown completion time")}</span></td>
          <td>${escapeHtml(run.brainMode ?? "unknown")}</td>
          <td>${escapeHtml(run.scenario ?? "unknown")}</td>
          <td>${escapeHtml(run.runnerMode ?? "unknown")}</td>
          <td>${numberCell(run.decisionCount)}</td>
          <td>${numberCell(run.postSpawnNonHoldActionCount)}</td>
          <td>${numberCell(run.acceptedCount)} / ${numberCell(run.rejectedCount)}</td>
          <td>${numberCell(run.parseFailureCount)} / ${numberCell(run.fallbackCount)}</td>
          <td>${numberCell(run.confirmedEffectCount)} / ${numberCell(run.unknownEffectCount)} / ${numberCell(run.failedEffectCount)}</td>
          <td>${behaviorQualityCell(run)}</td>
          <td>${matchStoryCell(run)}</td>
          <td>${numberCell(run.objectiveScore)}${run.objectiveScoreGrade ? ` (${escapeHtml(run.objectiveScoreGrade)})` : ""}</td>
          <td>${externalAgentCell(run)}</td>
          <td>${run.hasSpectatorReplay ? `${numberCell(run.spectator?.snapshotCount)} snapshots` : "none"}</td>
          <td class="links">
            <a href="./${encodeURIComponent(run.runID)}/visual-report.html">visual</a>
            ${
              run.hasSpectatorReplay
                ? `<a href="./${encodeURIComponent(run.runID)}/spectator.html">spectator</a>`
                : ""
            }
            ${
              run.hasOpenFrontReplay
                ? `<a href="/ai-league-replay/${encodeURIComponent(run.runID)}">Proxy War render</a>`
                : ""
            }
            <a href="./${encodeURIComponent(run.runID)}/match-report.md">markdown</a>
            ${
              run.hasScorecard
                ? `<a href="./${encodeURIComponent(run.runID)}/objective-scorecard.md">scorecard</a>`
                : ""
            }
            ${
              run.hasMatchPackage
                ? `<a href="./${encodeURIComponent(run.runID)}/${run.matchPackageLinkFileName}">package</a>`
                : ""
            }
            ${
              run.hasBehaviorQuality
                ? `<a href="./${encodeURIComponent(run.runID)}/behavior-quality-report.md">behavior</a>`
                : ""
            }
            ${
              run.hasMatchStory
                ? `<a href="./${encodeURIComponent(run.runID)}/match-story.md">story</a>`
                : ""
            }
            ${
              run.hasExternalFeedback
                ? `<a href="./${encodeURIComponent(run.runID)}/external-agent-feedback.md">external feedback</a>`
                : ""
            }
            <a href="./${encodeURIComponent(run.runID)}/decisions.jsonl">jsonl</a>
            <a href="./${encodeURIComponent(run.runID)}/match-summary.json">summary</a>
          </td>
        </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy War Runs</title>
  <style>
    :root { color-scheme: light; --ink:#17202a; --muted:#627084; --line:#d9e2ec; --paper:#f7f9fc; --accent:#215a9c; --good:#19764b; --bad:#a32135; }
    * { box-sizing:border-box; }
    body { margin:0; font:14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:var(--paper); }
    header { background:#fff; border-bottom:1px solid var(--line); padding:28px 32px 20px; }
    main { max-width:1400px; margin:0 auto; padding:24px 32px 40px; }
    h1 { margin:0; font-size:28px; }
    .subtitle, span { color:var(--muted); display:block; font-size:12px; margin-top:2px; }
    .metric-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom:18px; }
    .metric { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; }
    .metric strong { display:block; font-size:24px; margin-top:4px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { background:#eef3f8; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:#475569; }
    tr:last-child td { border-bottom:0; }
    code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break:break-word; }
    a { color:var(--accent); font-weight:700; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .links { display:flex; gap:10px; flex-wrap:wrap; }
    .empty { background:#fff; border:1px solid var(--line); border-radius:8px; padding:18px; color:var(--muted); }
  </style>
</head>
<body>
  <header>
    <h1>Proxy War Runs</h1>
    <div class="subtitle">${escapeHtml(runsRootDir)}</div>
  </header>
  <main>
    <section class="metric-grid">
      <div class="metric">Recent Runs<strong>${runs.length}</strong></div>
      <div class="metric">Accepted Decisions<strong>${sum(runs, "acceptedCount")}</strong></div>
      <div class="metric">Post-spawn Non-hold<strong>${sum(runs, "postSpawnNonHoldActionCount")}</strong></div>
      <div class="metric">Audit Failures<strong>${sum(runs, "failedEffectCount")}</strong></div>
    </section>
    ${
      runs.length === 0
        ? '<div class="empty">No Proxy War runs have been written yet.</div>'
        : `<table>
            <thead>
              <tr>
                <th>Run</th><th>Brain</th><th>Scenario</th><th>Runner</th>
                <th>Decisions</th><th>Non-hold</th><th>Accepted / Rejected</th>
                <th>Parser / Fallback</th><th>Audit C / U / F</th><th>Behavior</th><th>Story</th><th>Objective</th><th>External</th><th>Spectator</th><th>Artifacts</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`
    }
  </main>
</body>
</html>
`;
}

function numberCell(value: number | undefined): string {
  return String(value ?? 0);
}

function externalAgentCell(run: AgentDemoRunIndexEntry): string {
  const count = run.externalAgentCount ?? 0;
  if (count === 0) {
    return "none";
  }
  const status =
    run.externalAgentReadyForDeveloperReview === true
      ? "ready"
      : "needs review";
  return `${count} external · ${status}`;
}

function matchStoryCell(run: AgentDemoRunIndexEntry): string {
  const score = run.matchStory?.entertainmentScore;
  if (score === undefined) {
    return "none";
  }
  const warnings = run.matchStory?.boringnessWarnings?.length ?? 0;
  const grade = run.matchStory?.grade ?? "unknown";
  return `${score}/100 (${escapeHtml(grade)})${warnings > 0 ? ` · ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`;
}

function behaviorQualityCell(run: AgentDemoRunIndexEntry): string {
  const score = run.behaviorQuality?.score;
  if (score === undefined) {
    return "none";
  }
  const grade = run.behaviorQuality?.grade ?? "unknown";
  const severe = run.behaviorQuality?.severeIssueCount ?? 0;
  const gate = run.behaviorQuality?.pass === true ? "pass" : "fail";
  return `${score}/100 (${escapeHtml(grade)}) · ${gate}${severe > 0 ? ` · ${severe} severe` : ""}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sum(
  runs: AgentDemoRunIndexEntry[],
  key: keyof Pick<
    AgentDemoRunIndexEntry,
    | "acceptedCount"
    | "postSpawnNonHoldActionCount"
    | "failedEffectCount"
  >,
): number {
  return runs.reduce((total, run) => total + (run[key] ?? 0), 0);
}

function timestamp(value: string | undefined): number {
  return value === undefined ? 0 : new Date(value).getTime();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
