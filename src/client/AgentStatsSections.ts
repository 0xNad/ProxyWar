import { html, nothing, TemplateResult } from "lit";
import type {
  AgentMetric,
  AgentStatsSlice,
  NamedCount,
  PublicAgentStats,
} from "./AgentStatsSchema";
import type {
  AgentTimeSeries,
  ScoreSeries,
  WinrateSeries,
} from "./AgentTimeSeriesSchema";
import { renderTimeSeriesChart } from "./StatTimeSeriesChart";
import { translateText } from "./Utils";

/**
 * Shared strategic-fingerprint + social-record rendering for `/agent/:slug`
 * (`AgentProfilePage.ts`) and `/player/:name` (`PlayerProfilePage.ts`) —
 * literally the same render function, not two hand-copied templates, so
 * the two pages can never visually drift on the same underlying numbers
 * (spec Stage 6 item 6). A metric below its own sample threshold is
 * `null` on the wire (see `AgentStatsSchema.ts`) and is skipped here
 * entirely — never rendered as a fake 0%/N/A row. The whole
 * fingerprint/social block is omitted when `stats` is `null` or the
 * player has zero retained episodes.
 */

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatTurns(value: number): string {
  return `${Math.round(value).toLocaleString()} ${translateText("agent_stats.turns_unit")}`;
}

/** One labeled metric row, `title` carrying the methodology string as an accessible tooltip. `null` metric -> entirely absent row (spec item 2: "hide below threshold"). */
function metricRow(
  labelKey: string,
  metric: AgentMetric | null,
  format: (value: number) => string,
): TemplateResult | typeof nothing {
  if (metric === null) return nothing;
  return html`
    <div class="agent-stat-row" title=${metric.methodology}>
      <dt>${translateText(labelKey)}</dt>
      <dd>
        ${format(metric.value)}
        <span class="agent-stat-sample"
          >${translateText("agent_stats.sample_size", {
            count: metric.sampleSize,
          })}</span
        >
      </dd>
    </div>
  `;
}

function territoryRow(
  territory: AgentStatsSlice["fingerprint"]["territory"],
): TemplateResult | typeof nothing {
  if (territory.share !== null) {
    return metricRow(
      "agent_stats.territory_share",
      territory.share,
      formatPercent,
    );
  }
  if (territory.absoluteTiles !== null) {
    return html`
      <div
        class="agent-stat-row"
        title=${translateText("agent_stats.territory_absolute_note")}
      >
        <dt>${translateText("agent_stats.territory_tiles")}</dt>
        <dd>
          ${formatCount(territory.absoluteTiles.mean)}
          ${territory.meanRank !== null
            ? html`<span class="agent-stat-sample"
                >${translateText("agent_stats.mean_rank", {
                  rank: territory.meanRank.value.toFixed(1),
                })}</span
              >`
            : nothing}
        </dd>
      </div>
    `;
  }
  return nothing;
}

function namedCountList(
  headingKey: string,
  entries: readonly NamedCount[],
): TemplateResult | typeof nothing {
  if (entries.length === 0) return nothing;
  return html`
    <div class="agent-stat-list">
      <span class="agent-stat-list-heading">${translateText(headingKey)}</span>
      <ul role="list">
        ${entries.map(
          (entry) => html`<li>
            <span class="agent-stat-list-name">${entry.name}</span>
            <span class="agent-stat-list-count">${entry.count}</span>
          </li>`,
        )}
      </ul>
    </div>
  `;
}

function renderFingerprint(slice: AgentStatsSlice): TemplateResult {
  const f = slice.fingerprint;
  const rows = [
    metricRow("agent_stats.aggression", f.aggression, formatPercent),
    metricRow(
      "agent_stats.diplomacy_initiated",
      f.diplomacyInitiated,
      formatPercent,
    ),
    metricRow("agent_stats.economic_focus", f.economicFocus, formatPercent),
    territoryRow(f.territory),
    metricRow("agent_stats.army_strength", f.armyStrength, formatPercent),
    metricRow("agent_stats.reliability", f.reliability, formatPercent),
  ];
  const anyShown = rows.some((row) => row !== nothing);
  return html`
    <section
      class="agent-stats-section"
      aria-labelledby="agent-stats-fingerprint-heading"
    >
      <h2 id="agent-stats-fingerprint-heading">
        ${translateText("agent_stats.fingerprint_heading")}
      </h2>
      ${anyShown
        ? html`<dl class="agent-stat-grid">${rows}</dl>`
        : html`<p class="agent-stats-empty">
            ${translateText("agent_stats.fingerprint_below_threshold")}
          </p>`}
    </section>
  `;
}

function renderSocial(slice: AgentStatsSlice): TemplateResult {
  const s = slice.social;
  const rows = [
    metricRow(
      "agent_stats.alliances_initiated",
      s.alliancesInitiated,
      formatCount,
    ),
    metricRow(
      "agent_stats.alliance_acceptance_rate",
      s.allianceAcceptanceRate,
      formatPercent,
    ),
    metricRow("agent_stats.betrayal_count", s.betrayalCount, formatCount),
    metricRow("agent_stats.treaty_duration", s.treatyDuration, formatTurns),
  ];
  const lists = [
    namedCountList("agent_stats.frequent_allies", s.frequentAllies),
    namedCountList("agent_stats.primary_adversaries", s.primaryAdversaries),
  ];
  const anyShown =
    rows.some((row) => row !== nothing) || lists.some((list) => list !== nothing);
  return html`
    <section
      class="agent-stats-section"
      aria-labelledby="agent-stats-social-heading"
    >
      <h2 id="agent-stats-social-heading">
        ${translateText("agent_stats.social_heading")}
      </h2>
      ${anyShown
        ? html`<dl class="agent-stat-grid">${rows}</dl>
            ${lists}`
        : html`<p class="agent-stats-empty">
            ${translateText("agent_stats.social_below_threshold")}
          </p>`}
    </section>
  `;
}

/**
 * Renders the full fingerprint + social record block for `stats.career`
 * (the "every retained episode" view — spec item 2's primary Agent-profile
 * scope). Entirely absent (not an empty-state message) when `stats` is
 * `null` or the player has zero retained episodes — a brand-new
 * participant simply has no stats section yet, which is honest, not an
 * error state to explain.
 */
export function renderAgentStatsSections(
  stats: PublicAgentStats | null,
): TemplateResult | typeof nothing {
  if (stats === null || stats.career.episodeCount === 0) return nothing;
  return html`
    ${renderFingerprint(stats.career)} ${renderSocial(stats.career)}
  `;
}

/**
 * "Form" — winrate-over-time and score-over-time charts (product overhaul
 * spec: stats graphs), shared between `/agent/:slug` and `/player/:name`
 * exactly like every other function in this file. Each sub-chart is
 * independently omitted when its own series is `null` (below its own
 * documented sample threshold — see `AgentTimeSeries.ts`), and the whole
 * section disappears when BOTH are, rather than rendering an empty
 * heading.
 */
export function renderAgentFormSection(
  timeSeries: AgentTimeSeries,
): TemplateResult | typeof nothing {
  if (timeSeries.winrate === null && timeSeries.score === null) return nothing;
  return html`
    <section
      class="agent-stats-section"
      aria-labelledby="agent-stats-form-heading"
    >
      <h2 id="agent-stats-form-heading">
        ${translateText("agent_stats.form_heading")}
      </h2>
      ${timeSeries.winrate !== null
        ? renderWinrateChart(timeSeries.winrate)
        : nothing}
      ${timeSeries.score !== null
        ? renderScoreChart(timeSeries.score)
        : nothing}
    </section>
  `;
}

function renderWinrateChart(series: WinrateSeries): TemplateResult {
  const last = series.points[series.points.length - 1];
  return html`
    <div class="agent-stats-chart-block">
      <h3>${translateText("agent_stats.winrate_chart_heading")}</h3>
      ${renderTimeSeriesChart({
        points: series.points.map((point) => ({
          at: point.completedAt,
          value: point.winRate,
        })),
        yDomain: [0, 1],
        formatValue: formatPercent,
        formatX: (at) => new Date(at).toLocaleDateString(),
        color: "var(--pw-accent)",
        ariaLabel: translateText("agent_stats.winrate_chart_aria_label", {
          percent: Math.round(last.winRate * 100),
          count: last.episodesSoFar,
        }),
        captionText: series.methodology,
        tableCaption: translateText("agent_stats.winrate_chart_table_caption"),
        columnValueLabel: translateText("agent_stats.winrate_chart_column"),
      })}
    </div>
  `;
}

function renderScoreChart(series: ScoreSeries): TemplateResult {
  const recordedSinceLabel = new Date(series.recordedSince).toLocaleDateString();
  return html`
    <div class="agent-stats-chart-block">
      <h3>${translateText("agent_stats.score_chart_heading")}</h3>
      <p class="agent-stats-chart-note">
        ${translateText("agent_stats.score_chart_recorded_since", {
          date: recordedSinceLabel,
        })}
      </p>
      ${renderTimeSeriesChart({
        points: series.points.map((point) => ({
          at: point.recordedAt,
          value: point.score,
          marker: point.versionFirstObserved
            ? translateText("agent_stats.version_first_observed_marker", {
                version: point.activeVersionLabel ?? "",
              })
            : null,
        })),
        yDomain: null,
        formatValue: (value) => value.toFixed(2),
        formatX: (at) => new Date(at).toLocaleDateString(),
        color: "var(--pw-info)",
        ariaLabel: translateText("agent_stats.score_chart_aria_label", {
          date: recordedSinceLabel,
        }),
        captionText: series.methodology,
        tableCaption: translateText("agent_stats.score_chart_table_caption"),
        columnValueLabel: translateText("agent_stats.score_chart_column"),
      })}
    </div>
  `;
}

/**
 * Detailed row for the Analysis tab (spec Stage 6 item 5: "the deeper
 * cuts already computed — per-version splits when available, event
 * composition, sample sizes, periods, methodology strings, last-update.
 * Every number carries its sample size; below threshold hidden."). Unlike
 * `metricRow` (the terse summary view, methodology as a hover `title`),
 * this shows sampleSize, threshold, AND the full methodology string as
 * always-visible text — the whole point of an analysis view is that
 * nothing stays hidden behind a hover. Still `null` -> entirely absent,
 * same "hide below threshold" discipline as everywhere else; a hidden
 * metric is never shown here with a placeholder either.
 */
function analysisMetricRow(
  labelKey: string,
  metric: AgentMetric | null,
  format: (value: number) => string,
): TemplateResult | typeof nothing {
  if (metric === null) return nothing;
  return html`
    <div class="agent-analysis-row">
      <dt>${translateText(labelKey)}</dt>
      <dd>
        <span class="agent-analysis-value">${format(metric.value)}</span>
        <span class="agent-analysis-detail"
          >${translateText("agent_stats.analysis_sample_size", {
            count: metric.sampleSize,
          })}</span
        >
        <span class="agent-analysis-detail"
          >${translateText("agent_stats.analysis_threshold", {
            count: metric.threshold,
          })}</span
        >
        <span class="agent-analysis-methodology">${metric.methodology}</span>
      </dd>
    </div>
  `;
}

function analysisRowsForSlice(
  slice: AgentStatsSlice,
): (TemplateResult | typeof nothing)[] {
  const f = slice.fingerprint;
  const s = slice.social;
  return [
    analysisMetricRow("agent_stats.aggression", f.aggression, formatPercent),
    analysisMetricRow(
      "agent_stats.diplomacy_initiated",
      f.diplomacyInitiated,
      formatPercent,
    ),
    analysisMetricRow(
      "agent_stats.economic_focus",
      f.economicFocus,
      formatPercent,
    ),
    analysisMetricRow(
      "agent_stats.territory_share",
      f.territory.share,
      formatPercent,
    ),
    analysisMetricRow("agent_stats.army_strength", f.armyStrength, formatPercent),
    analysisMetricRow("agent_stats.reliability", f.reliability, formatPercent),
    analysisMetricRow(
      "agent_stats.alliances_initiated",
      s.alliancesInitiated,
      formatCount,
    ),
    analysisMetricRow(
      "agent_stats.alliance_acceptance_rate",
      s.allianceAcceptanceRate,
      formatPercent,
    ),
    analysisMetricRow(
      "agent_stats.betrayal_count",
      s.betrayalCount,
      formatCount,
    ),
    analysisMetricRow(
      "agent_stats.treaty_duration",
      s.treatyDuration,
      formatTurns,
    ),
  ];
}

/** One labeled period ("Career" or "Current version vXX") inside the Analysis tab — every metric that clears its own threshold, with sample size/threshold/methodology all visible. Entirely omitted (never an empty section) when nothing in this slice clears any threshold. */
function analysisPeriod(
  headingText: string,
  slice: AgentStatsSlice,
): TemplateResult | typeof nothing {
  const rows = analysisRowsForSlice(slice);
  if (rows.every((row) => row === nothing)) return nothing;
  return html`
    <div class="agent-analysis-period">
      <h3>
        ${headingText}
        ${translateText("agent_stats.analysis_episode_count", {
          count: slice.episodeCount,
        })}
      </h3>
      <dl class="agent-analysis-grid">${rows}</dl>
    </div>
  `;
}

/**
 * The Analysis tab (spec Stage 6 item 5), shared between `/agent/:slug`
 * and `/player/:name` exactly like `renderAgentStatsSections` above —
 * "one computation source, two views, never divergent numbers" (spec
 * item 6) extends to this deeper view too. A `<details>` disclosure
 * (closed by default, same pattern `WatchPage.ts`'s "Reveal result"
 * already establishes) so the terse summary view above stays the
 * default, uncluttered read.
 *
 * Shows the Career period always (when it has anything to show), and the
 * Current-Version period when the pipeline actually produced one
 * (`stats.currentVersion !== null` — see `compute-agent-stats.ts`'s own
 * doc for why this is honestly `null` for most agents today: it needs a
 * registry `firstObservedAt`/`releaseDate` boundary AND at least one
 * qualifying episode after it). When there's no version split yet, says
 * so plainly rather than rendering an empty "Current Version" heading.
 */
export function renderAnalysisTab(
  stats: PublicAgentStats | null,
  generatedAt: string | null,
): TemplateResult | typeof nothing {
  if (stats === null || stats.career.episodeCount === 0) return nothing;
  const careerPeriod = analysisPeriod(
    translateText("agent_stats.analysis_career_heading"),
    stats.career,
  );
  const versionPeriod =
    stats.currentVersion !== null
      ? analysisPeriod(
          translateText("agent_stats.analysis_version_heading", {
            version: stats.currentVersion.versionLabel,
          }),
          stats.currentVersion,
        )
      : nothing;
  return html`
    <details class="agent-stats-section agent-analysis-tab">
      <summary>${translateText("agent_stats.analysis_heading")}</summary>
      ${generatedAt !== null
        ? html`<p class="agent-analysis-updated">
            ${translateText("agent_stats.analysis_last_updated", {
              date: new Date(generatedAt).toLocaleString(),
            })}
          </p>`
        : nothing}
      ${careerPeriod}
      ${versionPeriod !== nothing
        ? versionPeriod
        : html`<p class="agent-analysis-empty">
            ${translateText("agent_stats.analysis_no_version_split")}
          </p>`}
    </details>
  `;
}
