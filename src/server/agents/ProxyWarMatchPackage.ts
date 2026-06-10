import fs from "fs/promises";
import path from "path";

export type ProxyWarMatchPackageArtifactKind =
  | "rendered_replay"
  | "demo_replay"
  | "replay_data"
  | "telemetry"
  | "decision_log"
  | "decision_report"
  | "timeline"
  | "scorecard"
  | "match_story"
  | "behavior_quality"
  | "external_agent_feedback"
  | "summary";

export type ProxyWarMatchPackageArtifactAudience =
  | "spectator"
  | "builder"
  | "coach"
  | "technical";

export interface ProxyWarMatchPackageArtifact {
  kind: ProxyWarMatchPackageArtifactKind;
  label: string;
  href: string;
  audience: ProxyWarMatchPackageArtifactAudience;
  present: boolean;
  description: string;
}

export interface ProxyWarMatchPackageSummary {
  runID: string;
  matchID?: string;
  scenario?: string;
  brainMode?: string;
  runnerMode?: string;
  completedAt?: string;
  decisionCount?: number;
  acceptedCount?: number;
  rejectedCount?: number;
  fallbackCount?: number;
  parseFailureCount?: number;
  postSpawnNonHoldActionCount?: number;
  objectiveScore?: number;
  objectiveScoreGrade?: string;
  objectiveScorecardMarkdownPath?: string;
  externalAgentCount?: number;
  externalAgentReadyForDeveloperReview?: boolean;
  externalAgentFeedbackMarkdownPath?: string;
  behaviorQualityPath?: string;
  behaviorQualityMarkdownPath?: string;
  behaviorQuality?: {
    score?: number;
    grade?: string;
    severeIssueCount?: number;
    reportPath?: string;
    pass?: boolean;
    topIssues?: string[];
    highlights?: string[];
  };
  matchStoryMarkdownPath?: string;
  spectatorTelemetryPath?: string;
  spectator?: {
    snapshotCount?: number;
    spectatorPath?: string | null;
    spectatorReplayPath?: string | null;
    spectatorTelemetryPath?: string | null;
    gameRecordPath?: string | null;
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

export interface ProxyWarMatchPackage {
  schemaVersion: 1;
  packageKind: "proxywar-match-package";
  generatedAt: string;
  runID: string;
  matchID: string | null;
  title: string;
  routes: {
    renderedReplayUrl: string | null;
    demoHubReplayUrl: string | null;
  };
  metrics: {
    decisionCount: number;
    acceptedCount: number;
    rejectedCount: number;
    fallbackCount: number;
    parseFailureCount: number;
    postSpawnNonHoldActionCount: number;
    objectiveScore: number | null;
    objectiveScoreGrade: string | null;
    externalAgentCount: number;
    externalAgentReadyForDeveloperReview: boolean;
    entertainmentScore: number | null;
    entertainmentGrade: string | null;
    behaviorQualityScore: number | null;
    behaviorQualityGrade: string | null;
    behaviorQualityPass: boolean | null;
    behaviorQualitySevereIssueCount: number;
  };
  behaviorQuality: {
    score: number | null;
    grade: string | null;
    pass: boolean | null;
    severeIssueCount: number;
    reportPath: string;
  } | null;
  topBehaviorIssues: string[];
  intentionalHighlights: string[];
  highlights: string[];
  warnings: string[];
  nextImprovements: string[];
  artifacts: ProxyWarMatchPackageArtifact[];
  recommendedOpenOrder: ProxyWarMatchPackageArtifactKind[];
  protocolBoundary: string;
}

export interface ProxyWarMatchPackagePaths {
  jsonPath: string;
  markdownPath: string;
  htmlPath: string;
}

export function buildProxyWarMatchPackage(
  summary: ProxyWarMatchPackageSummary,
  now: Date = new Date(),
): ProxyWarMatchPackage {
  const encodedRunID = encodeURIComponent(summary.runID);
  const renderedReplayUrl =
    summary.spectator?.openFrontReplayUrl ?? `/ai-league-replay/${encodedRunID}`;
  const hasGameRecord = hasValue(summary.spectator?.gameRecordPath);
  const artifacts = [
    artifact({
      kind: "rendered_replay",
      label: "Rendered Proxy War replay",
      href: renderedReplayUrl,
      audience: "spectator",
      present: hasGameRecord,
      description: "The primary watch artifact: the match rendered in Proxy War.",
    }),
    artifact({
      kind: "demo_replay",
      label: "Demo hub replay route",
      href: `/proxywar-replay/${encodedRunID}`,
      audience: "spectator",
      present: hasGameRecord,
      description: "The same replay through the Proxy War demo/beta hub.",
    }),
    artifact({
      kind: "match_story",
      label: "Match story and highlights",
      href: summary.matchStoryMarkdownPath ?? "match-story.md",
      audience: "spectator",
      present: hasValue(summary.matchStoryMarkdownPath),
      description: "Spectator-facing recap, highlights, warnings, and next edits.",
    }),
    artifact({
      kind: "behavior_quality",
      label: "Behavior quality gate",
      href:
        summary.behaviorQuality?.reportPath ??
        summary.behaviorQualityMarkdownPath ??
        "behavior-quality-report.md",
      audience: "coach",
      present:
        hasValue(summary.behaviorQuality) ||
        hasValue(summary.behaviorQualityMarkdownPath),
      description:
        "Demo-readiness gate covering loops, unexplained holds, bad defense posts, weak-rival misses, diplomacy follow-through, and midgame arc.",
    }),
    artifact({
      kind: "timeline",
      label: "Static timeline replay",
      href: summary.spectator?.spectatorPath ?? "spectator.html",
      audience: "builder",
      present: hasValue(summary.spectator?.spectatorPath),
      description: "Read-only snapshot replay with no player socket or intent path.",
    }),
    artifact({
      kind: "decision_report",
      label: "Decision report",
      href: "visual-report.html",
      audience: "builder",
      present: true,
      description: "Readable report of actions, reasons, objective alignment, and audits.",
    }),
    artifact({
      kind: "scorecard",
      label: "Objective scorecard",
      href: summary.objectiveScorecardMarkdownPath ?? "objective-scorecard.md",
      audience: "coach",
      present: hasValue(summary.objectiveScorecardMarkdownPath),
      description: "Per-agent objective quality and warnings.",
    }),
    artifact({
      kind: "external_agent_feedback",
      label: "External-agent feedback",
      href:
        summary.externalAgentFeedbackMarkdownPath ??
        "external-agent-feedback.md",
      audience: "coach",
      present: hasValue(summary.externalAgentFeedbackMarkdownPath),
      description: "Parser, fallback, repetition, and policy coaching for HTTP agents.",
    }),
    artifact({
      kind: "telemetry",
      label: "Spectator telemetry",
      href:
        summary.spectator?.spectatorTelemetryPath ??
        summary.spectatorTelemetryPath ??
        "spectator-telemetry.json",
      audience: "technical",
      present:
        hasValue(summary.spectator?.spectatorTelemetryPath) ||
        hasValue(summary.spectatorTelemetryPath),
      description: "Relationships, communication threads, and spectator events.",
    }),
    artifact({
      kind: "decision_log",
      label: "Decision log",
      href: "decisions.jsonl",
      audience: "technical",
      present: true,
      description: "The canonical per-decision LegalAction.id audit trail.",
    }),
    artifact({
      kind: "replay_data",
      label: "Game record",
      href: summary.spectator?.gameRecordPath ?? "game-record.json",
      audience: "technical",
      present: hasGameRecord,
      description: "Turn stream consumed by the native Proxy War replay renderer.",
    }),
    artifact({
      kind: "summary",
      label: "Machine summary",
      href: "match-summary.json",
      audience: "technical",
      present: true,
      description: "Compact machine-readable run summary.",
    }),
  ];

  return {
    schemaVersion: 1,
    packageKind: "proxywar-match-package",
    generatedAt: now.toISOString(),
    runID: summary.runID,
    matchID: summary.matchID ?? null,
    title: `Proxy War Match ${summary.runID}`,
    routes: {
      renderedReplayUrl: hasGameRecord ? renderedReplayUrl : null,
      demoHubReplayUrl: hasGameRecord ? `/proxywar-replay/${encodedRunID}` : null,
    },
    metrics: {
      decisionCount: summary.decisionCount ?? 0,
      acceptedCount: summary.acceptedCount ?? 0,
      rejectedCount: summary.rejectedCount ?? 0,
      fallbackCount: summary.fallbackCount ?? 0,
      parseFailureCount: summary.parseFailureCount ?? 0,
      postSpawnNonHoldActionCount: summary.postSpawnNonHoldActionCount ?? 0,
      objectiveScore: summary.objectiveScore ?? null,
      objectiveScoreGrade: summary.objectiveScoreGrade ?? null,
      externalAgentCount: summary.externalAgentCount ?? 0,
      externalAgentReadyForDeveloperReview:
        summary.externalAgentReadyForDeveloperReview ?? false,
      entertainmentScore: summary.matchStory?.entertainmentScore ?? null,
      entertainmentGrade: summary.matchStory?.grade ?? null,
      behaviorQualityScore: summary.behaviorQuality?.score ?? null,
      behaviorQualityGrade: summary.behaviorQuality?.grade ?? null,
      behaviorQualityPass: summary.behaviorQuality?.pass ?? null,
      behaviorQualitySevereIssueCount:
        summary.behaviorQuality?.severeIssueCount ?? 0,
    },
    behaviorQuality:
      summary.behaviorQuality !== undefined
        ? {
            score: summary.behaviorQuality.score ?? null,
            grade: summary.behaviorQuality.grade ?? null,
            pass: summary.behaviorQuality.pass ?? null,
            severeIssueCount: summary.behaviorQuality.severeIssueCount ?? 0,
            reportPath:
              summary.behaviorQuality.reportPath ??
              summary.behaviorQualityMarkdownPath ??
              "behavior-quality-report.md",
          }
        : null,
    topBehaviorIssues: (summary.behaviorQuality?.topIssues ?? []).slice(0, 3),
    intentionalHighlights: summary.behaviorQuality?.highlights ?? [],
    highlights: [
      ...(summary.matchStory?.spectatorHighlights ?? []),
      ...(summary.behaviorQuality?.highlights ?? []),
    ],
    warnings: [
      ...(summary.matchStory?.boringnessWarnings ?? []),
      ...(summary.behaviorQuality?.topIssues ?? []),
    ],
    nextImprovements: summary.matchStory?.improvementSuggestions ?? [],
    artifacts,
    recommendedOpenOrder: [
      "rendered_replay",
      "match_story",
      "behavior_quality",
      "decision_report",
      "external_agent_feedback",
      "scorecard",
      "telemetry",
      "decision_log",
    ],
    protocolBoundary:
      "Agents select one existing LegalAction.id. The validator and AgentRunner remain the only path to GameServer intents.",
  };
}

export async function writeProxyWarMatchPackageArtifacts(input: {
  directory: string;
  summary: ProxyWarMatchPackageSummary;
  now?: Date;
}): Promise<ProxyWarMatchPackagePaths> {
  const matchPackage = buildProxyWarMatchPackage(input.summary, input.now);
  const jsonPath = path.join(input.directory, "match-package.json");
  const markdownPath = path.join(input.directory, "match-package.md");
  const htmlPath = path.join(input.directory, "match-package.html");
  await fs.writeFile(jsonPath, `${JSON.stringify(matchPackage, null, 2)}\n`);
  await fs.writeFile(markdownPath, proxyWarMatchPackageMarkdown(matchPackage));
  await fs.writeFile(htmlPath, proxyWarMatchPackageHtml(matchPackage));
  return { jsonPath, markdownPath, htmlPath };
}

export function proxyWarMatchPackageHtml(
  matchPackage: ProxyWarMatchPackage,
): string {
  const presentArtifacts = matchPackage.artifacts.filter(
    (artifactItem) => artifactItem.present,
  );
  const missingArtifacts = matchPackage.artifacts.filter(
    (artifactItem) => !artifactItem.present,
  );
  const openOrder = matchPackage.recommendedOpenOrder
    .map((kind) => presentArtifacts.find((artifactItem) => artifactItem.kind === kind))
    .filter(
      (artifactItem): artifactItem is ProxyWarMatchPackageArtifact =>
        artifactItem !== undefined,
    );
  const spectatorArtifacts = presentArtifacts.filter(
    (artifactItem) => artifactItem.audience === "spectator",
  );
  const builderArtifacts = presentArtifacts.filter(
    (artifactItem) => artifactItem.audience === "builder",
  );
  const coachArtifacts = presentArtifacts.filter(
    (artifactItem) => artifactItem.audience === "coach",
  );
  const technicalArtifacts = presentArtifacts.filter(
    (artifactItem) => artifactItem.audience === "technical",
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(matchPackage.title)}</title>
  <style>
    :root { color-scheme: light; --ink:#17202b; --muted:#627286; --line:#d8e1e8; --paper:#f5f8f6; --panel:#fff; --soft:#f9fcfa; --accent:#176358; --accent-2:#27455d; --warn:#8b640f; --bad:#a13a4b; --good:#1f744e; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    a { color:var(--accent); font-weight:850; text-decoration:none; }
    a:hover { text-decoration:underline; }
    code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break:break-word; }
    .shell { width:min(1180px, calc(100% - 32px)); margin:0 auto; padding:22px 0 56px; }
    .topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; }
    .brand { display:flex; align-items:center; gap:10px; font-weight:950; }
    .brand-mark { width:34px; height:34px; display:grid; place-items:center; border-radius:8px; background:var(--accent-2); color:#fff; }
    nav { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
    nav a, .button { min-height:38px; display:inline-flex; align-items:center; justify-content:center; padding:9px 12px; border:1px solid var(--line); border-radius:7px; background:#fff; color:#29465d; }
    .button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
    .hero { display:grid; grid-template-columns:minmax(0, 1.05fr) minmax(280px, .75fr); gap:16px; align-items:stretch; }
    .panel, .hero-copy, .hero-side { background:rgba(255,255,255,.97); border:1px solid var(--line); border-radius:10px; box-shadow:0 14px 36px rgba(28,43,58,.06); }
    .hero-copy { padding:26px; display:flex; flex-direction:column; justify-content:space-between; gap:22px; }
    .hero-side { padding:18px; display:grid; gap:12px; }
    .eyebrow { color:var(--accent); font-size:12px; font-weight:950; letter-spacing:.08em; text-transform:uppercase; }
    h1 { margin:8px 0 10px; font-size:clamp(34px, 5.8vw, 62px); line-height:1; letter-spacing:0; }
    h2 { margin:0 0 10px; font-size:22px; letter-spacing:0; }
    h3 { margin:0 0 6px; font-size:16px; letter-spacing:0; }
    p { margin:0; }
    .lede { max-width:720px; color:#536174; font-size:17px; }
    .actions { display:flex; flex-wrap:wrap; gap:10px; }
    .metric-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; }
    .metric { border:1px solid #e0e8ee; background:var(--soft); border-radius:8px; padding:12px; min-width:0; }
    .metric span { display:block; color:var(--muted); font-size:11px; font-weight:850; text-transform:uppercase; letter-spacing:.05em; }
    .metric strong { display:block; font-size:24px; margin-top:2px; }
    main { display:grid; gap:16px; margin-top:16px; }
    .panel { padding:18px; }
    .section-head { display:flex; justify-content:space-between; align-items:flex-start; gap:14px; margin-bottom:12px; }
    .two-col { display:grid; grid-template-columns:minmax(0, 1fr) minmax(280px, .7fr); gap:16px; align-items:start; }
    .list { margin:0; padding-left:20px; color:#405166; }
    .list li { margin:6px 0; }
    .artifact-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:10px; }
    .artifact { border:1px solid var(--line); border-radius:8px; background:#fff; padding:13px; display:grid; gap:8px; min-width:0; }
    .artifact header { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
    .artifact strong { font-size:15px; }
    .artifact p { color:var(--muted); font-size:13px; }
    .pill { display:inline-flex; align-items:center; min-height:22px; padding:2px 8px; border-radius:999px; background:#e8f4ef; color:var(--good); font-weight:850; font-size:12px; white-space:nowrap; }
    .pill.builder { background:#eef4fb; color:#315474; }
    .pill.coach { background:#fff4d8; color:var(--warn); }
    .pill.technical { background:#eef1f5; color:#526274; }
    .pill.bad { background:#fdebf0; color:var(--bad); }
    .open-order { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px; }
    .open-step { border:1px solid #d8e7df; background:#fbfffc; border-radius:8px; padding:12px; display:grid; grid-template-columns:28px 1fr; gap:10px; align-items:start; }
    .open-step b { width:24px; height:24px; border-radius:999px; display:grid; place-items:center; background:var(--accent); color:#fff; font-size:12px; }
    .boundary { border:1px solid #cfe0d9; background:#f7fbf8; border-radius:8px; padding:13px; color:#29455d; }
    footer { color:var(--muted); font-size:12px; margin-top:18px; }
    @media (max-width: 860px) { .hero, .two-col { grid-template-columns:1fr; } .topbar { align-items:flex-start; flex-direction:column; } nav { justify-content:flex-start; } }
    @media (max-width: 560px) { .shell { width:min(100% - 24px, 1180px); } .actions, nav { flex-direction:column; } nav a, .button { width:100%; } .metric-grid { grid-template-columns:1fr; } h1 { font-size:36px; } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">PW</span>
        <span>Proxy War Match Package</span>
      </div>
      <nav aria-label="Match package navigation">
        ${matchPackage.routes.demoHubReplayUrl ? `<a href="${escapeAttribute(matchPackage.routes.demoHubReplayUrl)}">Replay</a>` : ""}
        <a href="#open-order">Open order</a>
        <a href="#artifacts">Artifacts</a>
        <a href="match-package.md">Markdown</a>
      </nav>
    </header>

    <section class="hero">
      <div class="hero-copy">
        <div>
          <div class="eyebrow">Generated match package</div>
          <h1>Match Package</h1>
          <p class="lede"><code>${escapeHtml(matchPackage.runID)}</code><br>${escapeHtml(matchPackage.matchID ?? "Saved Proxy War match")} · generated ${escapeHtml(matchPackage.generatedAt)}</p>
        </div>
        <div class="actions">
          ${
            matchPackage.routes.demoHubReplayUrl
              ? `<a class="button primary" href="${escapeAttribute(matchPackage.routes.demoHubReplayUrl)}">Watch rendered replay</a>`
              : '<span class="button">Rendered replay unavailable</span>'
          }
          <a class="button" href="match-story.md">Match story</a>
          <a class="button" href="behavior-quality-report.md">Behavior quality</a>
          <a class="button" href="visual-report.html">Decision report</a>
          <a class="button" href="external-agent-feedback.md">Agent feedback</a>
        </div>
      </div>
      <aside class="hero-side">
        <h2>Run Metrics</h2>
        <div class="metric-grid">
          ${metric("Decisions", String(matchPackage.metrics.decisionCount))}
          ${metric("Accepted", `${matchPackage.metrics.acceptedCount}/${matchPackage.metrics.rejectedCount}`)}
          ${metric("Non-hold", String(matchPackage.metrics.postSpawnNonHoldActionCount))}
          ${metric("Fallbacks", `${matchPackage.metrics.fallbackCount}/${matchPackage.metrics.parseFailureCount}`)}
          ${metric("Objective", scoreLabel(matchPackage.metrics.objectiveScore, matchPackage.metrics.objectiveScoreGrade))}
          ${metric("Entertainment", scoreLabel(matchPackage.metrics.entertainmentScore, matchPackage.metrics.entertainmentGrade))}
          ${metric("Behavior", scoreLabel(matchPackage.metrics.behaviorQualityScore, matchPackage.metrics.behaviorQualityGrade))}
          ${metric("Behavior Gate", matchPackage.metrics.behaviorQualityPass === null ? "n/a" : matchPackage.metrics.behaviorQualityPass ? "pass" : "fail")}
        </div>
      </aside>
    </section>

    <main>
      <section id="open-order" class="panel">
        <div class="section-head">
          <div>
            <h2>Open Order</h2>
            <p class="lede">Use this sequence to understand the match without digging through raw files.</p>
          </div>
        </div>
        <div class="open-order">
          ${openOrder
            .map(
              (artifactItem, index) => `
                <a class="open-step" href="${escapeAttribute(artifactItem.href)}">
                  <b>${index + 1}</b>
                  <span>
                    <strong>${escapeHtml(artifactItem.label)}</strong><br>
                    <small>${escapeHtml(artifactItem.description)}</small>
                  </span>
                </a>`,
            )
            .join("")}
        </div>
      </section>

      <section class="two-col">
        <article class="panel">
          <h2>Highlights</h2>
          <ul class="list">
            ${listItems(matchPackage.highlights, "No highlights were generated.")}
          </ul>
        </article>
        <article class="panel">
          <h2>Next Improvements</h2>
          <ul class="list">
            ${listItems(matchPackage.nextImprovements, "Run another match and inspect the decision report.")}
          </ul>
        </article>
      </section>

      <section class="panel">
        <h2>Watchability Warnings</h2>
        <ul class="list">
          ${listItems(matchPackage.warnings, "No watchability warnings were generated.")}
        </ul>
      </section>

      <section id="artifacts" class="panel">
        <div class="section-head">
          <div>
            <h2>Package Artifacts</h2>
            <p class="lede">Grouped by who should open them first.</p>
          </div>
        </div>
        ${artifactSection("Spectator", spectatorArtifacts)}
        ${artifactSection("Builder", builderArtifacts)}
        ${artifactSection("Coach", coachArtifacts)}
        ${artifactSection("Technical", technicalArtifacts)}
      </section>

      ${
        missingArtifacts.length === 0
          ? ""
          : `<section class="panel">
              <h2>Missing Artifacts</h2>
              <div class="artifact-grid">
                ${missingArtifacts.map((artifactItem) => artifactCard(artifactItem)).join("")}
              </div>
            </section>`
      }

      <section class="boundary">
        <h2>Protocol Boundary</h2>
        <p>${escapeHtml(matchPackage.protocolBoundary)}</p>
      </section>
    </main>
    <footer>
      <code>${escapeHtml(matchPackage.runID)}</code>
    </footer>
  </div>
</body>
</html>`;
}

export function proxyWarMatchPackageMarkdown(
  matchPackage: ProxyWarMatchPackage,
): string {
  const presentArtifacts = matchPackage.artifacts.filter(
    (artifactItem) => artifactItem.present,
  );
  const missingArtifacts = matchPackage.artifacts.filter(
    (artifactItem) => !artifactItem.present,
  );
  return [
    `# ${matchPackage.title}`,
    "",
    "## Open First",
    "",
    matchPackage.routes.demoHubReplayUrl
      ? `- [Watch rendered replay](${matchPackage.routes.demoHubReplayUrl})`
      : "- Rendered replay is not available for this run.",
    "- [Read match story](match-story.md)",
    "- [Review behavior quality](behavior-quality-report.md)",
    "- [Open decision report](visual-report.html)",
    "",
    "## Metrics",
    "",
    `- Decisions: ${matchPackage.metrics.decisionCount}`,
    `- Accepted/rejected: ${matchPackage.metrics.acceptedCount}/${matchPackage.metrics.rejectedCount}`,
    `- Fallback/parser failures: ${matchPackage.metrics.fallbackCount}/${matchPackage.metrics.parseFailureCount}`,
    `- Post-spawn non-hold actions: ${matchPackage.metrics.postSpawnNonHoldActionCount}`,
    `- Objective score: ${displayNullable(matchPackage.metrics.objectiveScore)}${matchPackage.metrics.objectiveScoreGrade ? ` (${matchPackage.metrics.objectiveScoreGrade})` : ""}`,
    `- Entertainment score: ${displayNullable(matchPackage.metrics.entertainmentScore)}${matchPackage.metrics.entertainmentGrade ? ` (${matchPackage.metrics.entertainmentGrade})` : ""}`,
    `- Behavior quality: ${displayNullable(matchPackage.metrics.behaviorQualityScore)}${matchPackage.metrics.behaviorQualityGrade ? ` (${matchPackage.metrics.behaviorQualityGrade})` : ""}`,
    `- Behavior gate: ${matchPackage.metrics.behaviorQualityPass === null ? "n/a" : matchPackage.metrics.behaviorQualityPass ? "pass" : "fail"}`,
    `- Behavior severe issues: ${matchPackage.metrics.behaviorQualitySevereIssueCount}`,
    `- External agents: ${matchPackage.metrics.externalAgentCount}`,
    "",
    "## Highlights",
    "",
    ...(matchPackage.highlights.length === 0
      ? ["- No highlights were generated."]
      : matchPackage.highlights.map((highlight) => `- ${highlight}`)),
    "",
    "## Watchability Warnings",
    "",
    ...(matchPackage.warnings.length === 0
      ? ["- No watchability warnings were generated."]
      : matchPackage.warnings.map((warning) => `- ${warning}`)),
    "",
    "## Next Improvements",
    "",
    ...(matchPackage.nextImprovements.length === 0
      ? ["- Run another match and inspect the decision report."]
      : matchPackage.nextImprovements.map((improvement) => `- ${improvement}`)),
    "",
    "## Package Artifacts",
    "",
    ...presentArtifacts.map(
      (artifactItem) =>
        `- [${artifactItem.label}](${artifactItem.href}) - ${artifactItem.audience}: ${artifactItem.description}`,
    ),
    ...(missingArtifacts.length === 0
      ? []
      : [
          "",
          "## Missing Artifacts",
          "",
          ...missingArtifacts.map(
            (artifactItem) =>
              `- ${artifactItem.label}: ${artifactItem.description}`,
          ),
        ]),
    "",
    "## Protocol Boundary",
    "",
    matchPackage.protocolBoundary,
    "",
  ].join("\n");
}

function artifact(
  value: ProxyWarMatchPackageArtifact,
): ProxyWarMatchPackageArtifact {
  return value;
}

function hasValue<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function displayNullable(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function artifactSection(
  label: string,
  artifacts: ProxyWarMatchPackageArtifact[],
): string {
  if (artifacts.length === 0) return "";
  return [
    `<h3>${escapeHtml(label)}</h3>`,
    '<div class="artifact-grid">',
    ...artifacts.map((artifactItem) => artifactCard(artifactItem)),
    "</div>",
  ].join("\n");
}

function artifactCard(artifactItem: ProxyWarMatchPackageArtifact): string {
  const className = artifactItem.present
    ? `pill ${escapeAttribute(artifactItem.audience)}`
    : "pill bad";
  return `<article class="artifact">
    <header>
      <strong>${escapeHtml(artifactItem.label)}</strong>
      <span class="${className}">${escapeHtml(artifactItem.present ? artifactItem.audience : "missing")}</span>
    </header>
    <p>${escapeHtml(artifactItem.description)}</p>
    ${
      artifactItem.present
        ? `<a href="${escapeAttribute(artifactItem.href)}">${escapeHtml(artifactItem.href)}</a>`
        : `<code>${escapeHtml(artifactItem.href)}</code>`
    }
  </article>`;
}

function listItems(values: string[], empty: string): string {
  const items = values.length === 0 ? [empty] : values;
  return items.map((value) => `<li>${escapeHtml(value)}</li>`).join("");
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function scoreLabel(value: number | null, grade: string | null): string {
  return `${displayNullable(value)}${grade ? ` ${grade}` : ""}`;
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
