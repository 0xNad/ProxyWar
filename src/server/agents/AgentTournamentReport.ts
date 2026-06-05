import fs from "fs/promises";
import path from "path";
import { AgentManifest } from "./AgentManifest";
import { LegalActionKind } from "./AgentTypes";

export interface AgentTournamentRunArtifact {
  runID: string;
  directory: string;
  summaryPath: string;
  reportPath: string;
  visualReportPath: string;
  scorecardJsonPath: string;
}

export interface AgentTournamentInput {
  tournamentID: string;
  scenario: string;
  brain: string;
  startedAt: number;
  completedAt: number;
  manifests: AgentManifest[];
  runs: AgentTournamentRunArtifact[];
  rootDir?: string;
}

export interface AgentTournamentPaths {
  tournamentID: string;
  directory: string;
  summaryPath: string;
  reportPath: string;
  leaderboardPath: string;
  leaderboardHtmlPath: string;
}

interface RunSummary {
  runID: string;
  scenario: string;
  brainMode: string;
  runnerMode: string;
  decisionCount: number;
  acceptedCount: number;
  rejectedCount: number;
  fallbackCount: number;
  parseFailureCount: number;
  postSpawnNonHoldActionCount: number;
  confirmedEffectCount: number;
  unknownEffectCount: number;
  failedEffectCount: number;
  actionCounts: Partial<Record<LegalActionKind, number>>;
  spectator?: {
    openFrontReplayUrl?: string | null;
  } | null;
  matchStory?: {
    entertainmentScore?: number;
    grade?: string;
    summary?: string;
    spectatorHighlights?: string[];
    boringnessWarnings?: string[];
    improvementSuggestions?: string[];
  };
}

interface ScorecardAgent {
  username: string;
  profile: string;
  totalObjectiveScore: number;
  objectiveAlignmentRate: number;
  acceptedIntentRate: number;
  auditedEffectRate: number;
  nonHoldRate: number;
  fallbackCount: number;
  parserFailureCount: number;
  rejectedCount: number;
  confirmedAuditCount: number;
  unknownAuditCount: number;
  failedAuditCount: number;
}

interface Scorecard {
  aggregate: ScorecardAgent;
  agents: ScorecardAgent[];
}

interface TournamentSummary {
  tournamentID: string;
  scenario: string;
  brain: string;
  runCount: number;
  acceptedCount: number;
  rejectedCount: number;
  fallbackCount: number;
  parserFailureCount: number;
  postSpawnNonHoldActionCount: number;
  auditStats: { confirmed: number; unknown: number; failed: number };
  leaderboard: ReturnType<typeof buildLeaderboard>;
  showcase: ReturnType<typeof buildShowcaseSummary>;
  runs: Array<{
    runID: string;
    visualReportPath: string;
    reportPath: string;
    scorecardJsonPath: string;
    objectiveScore: number;
    entertainmentScore: number;
    replayPath: string;
  }>;
}

export async function writeAgentTournamentArtifacts(
  input: AgentTournamentInput,
): Promise<AgentTournamentPaths> {
  const directory = path.join(
    input.rootDir ?? path.join(process.cwd(), "artifacts", "ai-league-tournaments"),
    safePathSegment(input.tournamentID),
  );
  await fs.mkdir(directory, { recursive: true });
  const loadedRuns = await Promise.all(input.runs.map(loadRun));
  const leaderboard = buildLeaderboard(loadedRuns);
  const showcase = buildShowcaseSummary(input.manifests, loadedRuns);
  const summary = {
    tournamentID: input.tournamentID,
    scenario: input.scenario,
    brain: input.brain,
    startedAt: new Date(input.startedAt).toISOString(),
    completedAt: new Date(input.completedAt).toISOString(),
    durationMs: input.completedAt - input.startedAt,
    runCount: loadedRuns.length,
    manifests: input.manifests,
    actionCounts: aggregateActionCounts(loadedRuns.map((run) => run.summary)),
    acceptedCount: sum(loadedRuns, (run) => run.summary.acceptedCount),
    rejectedCount: sum(loadedRuns, (run) => run.summary.rejectedCount),
    fallbackCount: sum(loadedRuns, (run) => run.summary.fallbackCount),
    parserFailureCount: sum(loadedRuns, (run) => run.summary.parseFailureCount),
    postSpawnNonHoldActionCount: sum(
      loadedRuns,
      (run) => run.summary.postSpawnNonHoldActionCount,
    ),
    auditStats: {
      confirmed: sum(loadedRuns, (run) => run.summary.confirmedEffectCount ?? 0),
      unknown: sum(loadedRuns, (run) => run.summary.unknownEffectCount ?? 0),
      failed: sum(loadedRuns, (run) => run.summary.failedEffectCount ?? 0),
    },
    leaderboard,
    showcase,
    runs: loadedRuns.map((run) => {
      const runID = encodeURIComponent(run.artifact.runID);
      return {
        runID: run.artifact.runID,
        summaryPath: `/runs/${runID}/match-summary.json`,
        reportPath: `/runs/${runID}/match-report.md`,
        visualReportPath: `/runs/${runID}/visual-report.html`,
        scorecardJsonPath: `/runs/${runID}/objective-scorecard.md`,
        objectiveScore: run.scorecard.aggregate.totalObjectiveScore,
        entertainmentScore: storyScore(run.summary),
        replayPath:
          run.summary.spectator?.openFrontReplayUrl ??
          `/ai-league-replay/${runID}`,
      };
    }),
  };
  const summaryPath = path.join(directory, "tournament-summary.json");
  const reportPath = path.join(directory, "tournament-report.md");
  const leaderboardPath = path.join(directory, "leaderboard.json");
  const leaderboardHtmlPath = path.join(directory, "leaderboard.html");

  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(leaderboardPath, `${JSON.stringify(leaderboard, null, 2)}\n`);
  await fs.writeFile(reportPath, tournamentMarkdown(summary));
  await fs.writeFile(leaderboardHtmlPath, leaderboardHtml(summary));

  return {
    tournamentID: input.tournamentID,
    directory,
    summaryPath,
    reportPath,
    leaderboardPath,
    leaderboardHtmlPath,
  };
}

async function loadRun(artifact: AgentTournamentRunArtifact) {
  const summary = JSON.parse(await fs.readFile(artifact.summaryPath, "utf8")) as RunSummary;
  const scorecard = JSON.parse(
    await fs.readFile(artifact.scorecardJsonPath, "utf8"),
  ) as Scorecard;
  return { artifact, summary, scorecard };
}

function buildLeaderboard(
  runs: Awaited<ReturnType<typeof loadRun>>[],
) {
  const byAgent = new Map<string, ScorecardAgent[]>();
  for (const run of runs) {
    for (const agent of run.scorecard.agents) {
      const key = `${agent.username}:${agent.profile}`;
      const values = byAgent.get(key) ?? [];
      values.push(agent);
      byAgent.set(key, values);
    }
  }
  return [...byAgent.entries()]
    .map(([key, agents]) => {
      const [agentName, profile] = key.split(":");
      const objectiveScore = average(
        agents.map((agent) => agent.totalObjectiveScore),
      );
      const acceptedIntentRate = average(
        agents.map((agent) => agent.acceptedIntentRate),
      );
      const nonHoldRate = average(agents.map((agent) => agent.nonHoldRate));
      const auditScore = average(
        agents.map((agent) => agent.auditedEffectRate),
      );
      const penalty =
        sum(agents, (agent) => agent.fallbackCount) * 3 +
        sum(agents, (agent) => agent.parserFailureCount) * 5 +
        sum(agents, (agent) => agent.rejectedCount) * 4 +
        sum(agents, (agent) => agent.failedAuditCount) * 5;
      const totalScore = round(
        objectiveScore * 0.55 +
          acceptedIntentRate * 20 +
          nonHoldRate * 12 +
          auditScore * 13 -
          penalty,
      );
      return {
        agentName: agentName ?? key,
        profile: profile ?? "unknown",
        matches: agents.length,
        objectiveScore,
        acceptedIntentRate,
        nonHoldRate,
        auditScore,
        fallbackCount: sum(agents, (agent) => agent.fallbackCount),
        parserFailureCount: sum(agents, (agent) => agent.parserFailureCount),
        rejectedCount: sum(agents, (agent) => agent.rejectedCount),
        unknownAuditCount: sum(agents, (agent) => agent.unknownAuditCount),
        failedAuditCount: sum(agents, (agent) => agent.failedAuditCount),
        totalScore,
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore);
}

function buildShowcaseSummary(
  manifests: AgentManifest[],
  runs: Awaited<ReturnType<typeof loadRun>>[],
) {
  const storyScores = runs.map((run) => storyScore(run.summary));
  const bestRun = runs
    .slice()
    .sort((a, b) => storyScore(b.summary) - storyScore(a.summary))[0];
  const averageEntertainmentScore = average(storyScores);
  const highlights = uniqueStrings(
    runs.flatMap(
      (run) => run.summary.matchStory?.spectatorHighlights ?? [],
    ),
  ).slice(0, 8);
  const warnings = uniqueStrings(
    runs.flatMap((run) => run.summary.matchStory?.boringnessWarnings ?? []),
  ).slice(0, 6);
  const suggestions = uniqueStrings(
    runs.flatMap(
      (run) => run.summary.matchStory?.improvementSuggestions ?? [],
    ),
  ).slice(0, 6);
  return {
    status: showcaseStatus(averageEntertainmentScore),
    averageEntertainmentScore,
    bestRunID: bestRun?.artifact.runID ?? null,
    bestRunReplayPath:
      bestRun === undefined
        ? null
        : (bestRun.summary.spectator?.openFrontReplayUrl ??
          `/ai-league-replay/${encodeURIComponent(bestRun.artifact.runID)}`),
    agents: manifests.map((manifest) => ({
      agentName: manifest.agentName,
      profile: manifest.profile,
      brainType: manifest.brainType,
      personality: manifest.personality ?? "",
      styleTags: styleTagsForManifest(manifest),
    })),
    highlightReel: highlights,
    watchWarnings: warnings,
    nextImprovements: suggestions,
  };
}

function storyScore(summary: RunSummary): number {
  const score = summary.matchStory?.entertainmentScore;
  return typeof score === "number" && Number.isFinite(score) ? score : 0;
}

function showcaseStatus(score: number): "showcase-ready" | "promising" | "needs-drama" {
  if (score >= 70) {
    return "showcase-ready";
  }
  if (score >= 45) {
    return "promising";
  }
  return "needs-drama";
}

function styleTagsForManifest(manifest: AgentManifest): string[] {
  const skills = Object.entries(manifest.skillPreferences ?? {})
    .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
    .map(([skill]) => skill.replace(/_/g, " "));
  return uniqueStrings([manifest.profile, ...skills]).slice(0, 4);
}

function tournamentMarkdown(summary: TournamentSummary): string {
  return [
    `# Proxy War Tournament ${summary.tournamentID}`,
    "",
    "## Overview",
    "",
    `- Scenario: ${summary.scenario}`,
    `- Brain: ${summary.brain}`,
    `- Runs: ${summary.runCount}`,
    `- Accepted: ${summary.acceptedCount}`,
    `- Rejected: ${summary.rejectedCount}`,
    `- Fallbacks: ${summary.fallbackCount}`,
    `- Parser failures: ${summary.parserFailureCount}`,
    `- Post-spawn non-hold actions: ${summary.postSpawnNonHoldActionCount}`,
    `- Audit C/U/F: ${summary.auditStats.confirmed}/${summary.auditStats.unknown}/${summary.auditStats.failed}`,
    `- Showcase status: ${summary.showcase.status}`,
    `- Average entertainment score: ${summary.showcase.averageEntertainmentScore}/100`,
    ...(summary.showcase.bestRunReplayPath === null
      ? []
      : [`- Best replay: ${summary.showcase.bestRunReplayPath}`]),
    "",
    "## Agent Roster",
    "",
    markdownTable(
      ["Agent", "Profile", "Brain", "Style", "Personality"],
      summary.showcase.agents.map((agent) => [
        agent.agentName,
        agent.profile,
        agent.brainType,
        agent.styleTags.join(", "),
        agent.personality,
      ]),
    ),
    "",
    "## Watchability",
    "",
    ...(summary.showcase.highlightReel.length === 0
      ? ["- No highlight reel yet. Run a longer showcase."]
      : summary.showcase.highlightReel.map((highlight) => `- ${highlight}`)),
    "",
    "## Next Improvements",
    "",
    ...(summary.showcase.nextImprovements.length === 0
      ? ["- Run a longer showcase and inspect the replay."]
      : summary.showcase.nextImprovements.map((item) => `- ${item}`)),
    "",
    "## Leaderboard",
    "",
    markdownTable(
      [
        "Rank",
        "Agent",
        "Profile",
        "Score",
        "Objective",
        "Accepted",
        "Non-hold",
        "Audit",
        "Penalties",
      ],
      summary.leaderboard.map((agent, index) => [
        String(index + 1),
        agent.agentName,
        agent.profile,
        String(agent.totalScore),
        String(agent.objectiveScore),
        percent(agent.acceptedIntentRate),
        percent(agent.nonHoldRate),
        percent(agent.auditScore),
        `fallback=${agent.fallbackCount}, parser=${agent.parserFailureCount}, rejected=${agent.rejectedCount}`,
      ]),
    ),
    "",
    "## Runs",
    "",
    markdownTable(
      ["Run", "Objective", "Entertainment", "Replay", "Visual", "Report", "Scorecard"],
      summary.runs.map((run) => [
        run.runID,
        String(run.objectiveScore),
        String(run.entertainmentScore),
        run.replayPath,
        run.visualReportPath,
        run.reportPath,
        run.scorecardJsonPath,
      ]),
    ),
    "",
  ].join("\n");
}

function leaderboardHtml(summary: TournamentSummary): string {
  const rows = summary.leaderboard
    .map(
      (agent, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(
        agent.agentName,
      )}</td><td>${escapeHtml(agent.profile)}</td><td>${agent.totalScore}</td><td>${agent.objectiveScore}</td><td>${percent(
        agent.acceptedIntentRate,
      )}</td><td>${percent(agent.nonHoldRate)}</td><td>${percent(
        agent.auditScore,
      )}</td></tr>`,
    )
    .join("\n");
  const rosterCards = summary.showcase.agents
    .map(
      (agent) => `<article><strong>${escapeHtml(agent.agentName)}</strong><span>${escapeHtml(
        agent.profile,
      )}</span><small>${escapeHtml(agent.styleTags.join(" · "))}</small><p>${escapeHtml(
        agent.personality || "No personality note yet.",
      )}</p></article>`,
    )
    .join("\n");
  const runRows = summary.runs
    .map(
      (run) => `<tr><td>${escapeHtml(run.runID)}</td><td>${run.objectiveScore}</td><td>${run.entertainmentScore}</td><td><a href="${escapeHtml(
        run.replayPath,
      )}">replay</a></td><td><a href="${escapeHtml(
        run.visualReportPath,
      )}">visual</a></td><td><a href="${escapeHtml(
        run.reportPath,
      )}">report</a></td></tr>`,
    )
    .join("\n");
  const highlights = summary.showcase.highlightReel
    .map((highlight) => `<li>${escapeHtml(highlight)}</li>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy War Tournament ${escapeHtml(summary.tournamentID)}</title>
  <style>
    body{font:14px/1.45 system-ui,sans-serif;margin:0;background:#f7f9fc;color:#17202a}
    header,main{max-width:1100px;margin:0 auto;padding:24px}
    header{background:#fff;border-bottom:1px solid #d9e2ec;max-width:none}
    section{margin:0 0 24px}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
    article{background:#fff;border:1px solid #d9e2ec;border-radius:8px;padding:14px;display:grid;gap:5px}
    article strong{color:#215a9c}
    article span, article small{color:#64748b}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d9e2ec}
    th,td{padding:10px 12px;border-bottom:1px solid #d9e2ec;text-align:left}
    th{background:#eef3f8;color:#475569;text-transform:uppercase;font-size:12px}
    a{color:#215a9c;font-weight:700}
  </style>
</head>
<body>
  <header><h1>Proxy War Tournament</h1><p>${escapeHtml(summary.tournamentID)}</p></header>
  <main>
    <section><p>${summary.runCount} runs · ${summary.postSpawnNonHoldActionCount} post-spawn non-hold actions · ${summary.acceptedCount} accepted · ${summary.showcase.averageEntertainmentScore}/100 entertainment · ${escapeHtml(summary.showcase.status)}</p>${summary.showcase.bestRunReplayPath ? `<p><a href="${escapeHtml(summary.showcase.bestRunReplayPath)}">Watch best replay</a></p>` : ""}</section>
    <section><h2>Agents</h2><div class="cards">${rosterCards}</div></section>
    <section><h2>Highlight Reel</h2><ul>${highlights || "<li>No highlights yet. Run a longer showcase.</li>"}</ul></section>
    <section><h2>Leaderboard</h2><table><thead><tr><th>Rank</th><th>Agent</th><th>Profile</th><th>Score</th><th>Objective</th><th>Accepted</th><th>Non-hold</th><th>Audit</th></tr></thead><tbody>${rows}</tbody></table></section>
    <section><h2>Runs</h2><table><thead><tr><th>Run</th><th>Objective</th><th>Entertainment</th><th>Replay</th><th>Visual</th><th>Report</th></tr></thead><tbody>${runRows}</tbody></table></section>
    <p><a href="./tournament-report.md">tournament-report.md</a> · <a href="./leaderboard.json">leaderboard.json</a></p>
  </main>
</body>
</html>
`;
}

function aggregateActionCounts(summaries: RunSummary[]) {
  return summaries.reduce<Partial<Record<LegalActionKind, number>>>(
    (counts, summary) => {
      for (const [kind, count] of Object.entries(summary.actionCounts)) {
        const actionKind = kind as LegalActionKind;
        counts[actionKind] = (counts[actionKind] ?? 0) + Number(count ?? 0);
      }
      return counts;
    },
    {},
  );
}

function sum<T>(values: T[], fn: (value: T) => number): number {
  return values.reduce((total, value) => total + fn(value), 0);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : round(sum(values, (value) => value) / values.length);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safePathSegment(value: string): string {
  const segment = value.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    !/[A-Za-z0-9]/.test(segment)
  ) {
    throw new Error(`Invalid AI league tournament id: ${value}`);
  }
  return segment;
}
