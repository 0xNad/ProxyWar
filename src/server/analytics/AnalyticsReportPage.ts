import type { AnalyticsRingEntry } from "./AnalyticsRecentRing";
import type {
  AnalyticsReportModel,
  CountMetric,
  FunnelStageMetric,
  MetricStatus,
  RankingMetric,
  RateMetric,
  RouteBreakdownMetric,
} from "./AnalyticsReport";

/**
 * Operator-facing HTML for the Phase 7 analytics report. Registered in
 * `ai-agent-demo-server.ts` AFTER the beta-session gate middleware, exactly
 * like `/tester-dashboard` — never anonymous, per the phase brief. Visual
 * language (dark panel, `.stat`/`.panel`/`.pill` classes) intentionally
 * matches `renderProxyWarTesterDashboardHtml` in `AgentDemoHub.ts` so an
 * operator recognizes it as the same family of internal tool; duplicated
 * here rather than imported since this module owns its own file tree.
 */

export interface AnalyticsReportPageModel {
  report: AnalyticsReportModel;
  recentEvents: AnalyticsRingEntry[];
}

export function renderAnalyticsReportHtml(model: AnalyticsReportPageModel): string {
  const { report } = model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy War Analytics Report</title>
  <style>
    :root { color-scheme: dark; --paper:#07090d; --panel:#11151e; --line:#252d3c; --ink:#e8edf5; --muted:#93a0b4; --accent:#f4a64a; --good:#7ee0a8; --bad:#ff7a6b; --warn:#f0c869; }
    * { box-sizing:border-box; }
    body { margin:0; background:radial-gradient(900px 420px at 20% 0%, rgba(244,166,74,.08), transparent 60%), var(--paper); color:var(--ink); font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif; }
    header, main { width:min(1180px, calc(100% - 32px)); margin:0 auto; }
    header { padding:26px 0 14px; }
    h1 { margin:0; font-size:34px; letter-spacing:-.03em; }
    h2 { margin:0 0 10px; font-size:18px; }
    p { margin:0; }
    a { color:#7ad7f0; font-weight:800; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .hint { color:var(--muted); font-size:13px; margin-top:6px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin:12px 0; }
    .stat, .panel { background:rgba(17,21,30,.94); border:1px solid var(--line); border-radius:8px; padding:16px; box-shadow:0 24px 60px -35px #000; }
    .stat span { display:block; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.05em; font-weight:850; }
    .stat strong { display:block; margin-top:3px; font-size:26px; }
    .stat .sub { display:block; margin-top:4px; color:var(--muted); font-size:12px; }
    main { display:grid; gap:16px; padding-bottom:42px; }
    table { width:100%; border-collapse:collapse; overflow:hidden; border-radius:8px; }
    th, td { border-bottom:1px solid var(--line); padding:9px 10px; text-align:left; vertical-align:top; }
    th { color:#bcc6d7; background:#161c28; font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
    code { color:#dce6f6; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .pill { display:inline-flex; min-height:22px; align-items:center; padding:2px 8px; border-radius:999px; background:#202838; color:#c9d3e3; font-size:12px; font-weight:850; }
    .pill.good { background:rgba(126,224,168,.14); color:var(--good); }
    .pill.warn { background:rgba(240,200,105,.14); color:var(--warn); }
    .pill.muted { background:rgba(147,160,180,.14); color:var(--muted); }
    .empty { color:var(--muted); border:1px dashed var(--line); border-radius:8px; padding:14px; }
    .methodology { color:var(--muted); font-size:12px; margin-top:6px; }
  </style>
</head>
<body>
  <header>
    <h1>Analytics Report</h1>
    <p class="hint">Invite-gated operator view of the Phase 7 first-party product funnel. Generated ${escapeHtml(report.generatedAt)}. Raw counts, not universal truths — see <code>docs/SEASON_ZERO_ANALYTICS.md</code> for methodology and decision thresholds.</p>
  </header>
  <main>
    <section class="panel">
      <h2>Top-of-funnel</h2>
      <div class="grid">
        ${rateStatCard(report.homepageToWatchCtr)}
        ${rateStatCard(report.replayLoadSuccessRate)}
        ${rateStatCard(report.sevenDayReturnRate)}
        ${rateStatCard(report.agentBuilderProfileCtr)}
      </div>
    </section>

    <section class="panel">
      <h2>Director Cut milestones</h2>
      <div class="grid">
        ${report.directorCutMilestones.map(rateStatCard).join("\n")}
      </div>
    </section>

    <section class="panel">
      <h2>Full Replay milestones (raw counts — no "started" baseline to divide by)</h2>
      <div class="grid">
        ${report.fullReplayMilestones.map(countStatCard).join("\n")}
      </div>
    </section>

    <section class="panel">
      <h2>Build flow funnel</h2>
      ${funnelStageTable(report.builderFunnel)}
    </section>

    <section class="panel">
      <h2>Most-watched matches</h2>
      ${rankingTable(report.mostWatchedEvents, "Match")}
    </section>

    <section class="panel">
      <h2>Claims and version releases</h2>
      <div class="grid">
        ${report.claimsAndReleases.map(countStatCard).join("\n")}
      </div>
    </section>

    <section class="panel">
      <h2>Failures by route</h2>
      ${routeBreakdownTable(report.failuresByRoute)}
    </section>

    <section class="panel">
      <h2>Failure reasons</h2>
      ${rankingTable(report.failureReasons, "Reason")}
    </section>

    <section class="panel">
      <h2>Recent activity</h2>
      ${recentEventsTable(model.recentEvents)}
    </section>
  </main>
</body>
</html>`;
}

function statusPill(status: MetricStatus): string {
  if (status === "measured") return `<span class="pill good">measured</span>`;
  if (status === "insufficient_traffic") return `<span class="pill warn">insufficient traffic</span>`;
  return `<span class="pill muted">not yet instrumented</span>`;
}

function rateStatCard(metric: RateMetric): string {
  const value =
    metric.status === "measured"
      ? `${metric.ratePercent}%`
      : `${metric.numerator} / ${metric.denominator}`;
  return `<div class="stat">
    <span>${escapeHtml(metric.label)}</span>
    <strong>${value}</strong>
    <span class="sub">${statusPill(metric.status)}</span>
    <p class="methodology">${escapeHtml(metric.methodology)}</p>
  </div>`;
}

function countStatCard(metric: CountMetric): string {
  return `<div class="stat">
    <span>${escapeHtml(metric.label)}</span>
    <strong>${metric.count}</strong>
    <span class="sub">${statusPill(metric.status)}</span>
    <p class="methodology">${escapeHtml(metric.methodology)}</p>
  </div>`;
}

function funnelStageTable(metric: FunnelStageMetric): string {
  const rows = metric.stages
    .map((stage) => `<tr><td>${escapeHtml(stage.stage)}</td><td>${stage.count}</td></tr>`)
    .join("\n");
  return `<p class="methodology">${escapeHtml(metric.methodology)} ${statusPill(metric.status)}</p>
  <table><thead><tr><th>Stage</th><th>Count</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function rankingTable(metric: RankingMetric, keyLabel: string): string {
  if (metric.items.length === 0) {
    return `<p class="empty">No data yet. ${statusPill(metric.status)}</p><p class="methodology">${escapeHtml(metric.methodology)}</p>`;
  }
  const rows = metric.items
    .map((item) => `<tr><td>${escapeHtml(item.key)}</td><td>${item.count}</td></tr>`)
    .join("\n");
  return `<table><thead><tr><th>${escapeHtml(keyLabel)}</th><th>Count</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="methodology">${escapeHtml(metric.methodology)}</p>`;
}

function routeBreakdownTable(metric: RouteBreakdownMetric): string {
  if (metric.items.length === 0) {
    return `<p class="empty">No data yet. ${statusPill(metric.status)}</p><p class="methodology">${escapeHtml(metric.methodology)}</p>`;
  }
  const rows = metric.items
    .map((item) => `<tr><td><code>${escapeHtml(item.route)}</code></td><td>${item.count}</td></tr>`)
    .join("\n");
  return `<table><thead><tr><th>Route</th><th>Count</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="methodology">${escapeHtml(metric.methodology)}</p>`;
}

function recentEventsTable(entries: readonly AnalyticsRingEntry[]): string {
  if (entries.length === 0) {
    return `<p class="empty">No events received yet.</p>`;
  }
  const rows = entries
    .slice()
    .reverse()
    .slice(0, 50)
    .map(
      (entry) => `<tr>
        <td>${escapeHtml(entry.occurredAt)}</td>
        <td><code>${escapeHtml(entry.name)}</code></td>
        <td><code>${escapeHtml(entry.route)}</code></td>
        <td>${entry.reason ? escapeHtml(entry.reason) : ""}</td>
      </tr>`,
    )
    .join("\n");
  return `<table><thead><tr><th>Received</th><th>Event</th><th>Route</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
