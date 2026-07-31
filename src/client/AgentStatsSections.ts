import { html, nothing, TemplateResult } from "lit";
import type {
  AgentMetric,
  AgentStatsSlice,
  NamedCount,
  PublicAgentStats,
} from "./AgentStatsSchema";
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
