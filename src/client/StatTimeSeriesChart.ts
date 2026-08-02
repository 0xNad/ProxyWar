import { html, nothing, TemplateResult } from "lit";
import { translateText } from "./Utils";

/**
 * Dependency-free inline SVG line chart for a single time series (product
 * overhaul: stats graphs). No charting library exists in this codebase and
 * adding one is out of reach (`npm ci --ignore-scripts`, bundle
 * discipline) — this module is the whole chart surface: pure geometry
 * (`computeChartGeometry`, unit-testable without a DOM) plus a thin Lit
 * render function.
 *
 * Accessibility: the `<svg>` carries `role="img"` + a full `aria-label`
 * summary (never relies on visually reading the line), and every render
 * ALSO emits a real `<table>` of the same points behind a `<details>`
 * disclosure — the same collapsed-by-default pattern
 * `AgentStatsSections.ts`'s `renderAnalysisTab` already uses — so a
 * keyboard/screen-reader user gets the exact same data a sighted mouse user
 * gets from hovering a point, never a degraded experience. Per-point hover
 * tooltips use a native SVG `<title>` (zero JS, zero extra a11y tree
 * nodes); no interactive tab stop is added per point, since the `<table>`
 * already covers keyboard access to every value.
 */

export interface TimeSeriesPoint {
  /** ISO timestamp — the point's x-axis position. */
  readonly at: string;
  readonly value: number;
  /** A non-null, translated label marks this point as a version-boundary marker (a vertical dashed line + tooltip); omitted/`null` for an ordinary point. */
  readonly marker?: string | null;
}

export interface TimeSeriesChartProps {
  readonly points: readonly TimeSeriesPoint[];
  /** Fixed axis bounds (e.g. `[0, 1]` for a winrate ratio) — `null` to auto-fit the y-axis to the data's own min/max, which is the honest choice for an arbitrary rating scale that has no fixed 0-baseline. */
  readonly yDomain: readonly [number, number] | null;
  readonly formatValue: (value: number) => string;
  readonly formatX: (at: string) => string;
  /** A CSS color value (e.g. `var(--pw-accent)`) for the line and points. */
  readonly color: string;
  readonly ariaLabel: string;
  /** Plain-text methodology/provenance note rendered under the chart — never translated (matches `AgentMetric.methodology`'s own convention of shipping as generated, not localized, text). */
  readonly captionText: string;
  readonly tableCaption: string;
  readonly columnValueLabel: string;
}

const CHART_WIDTH = 480;
const CHART_HEIGHT = 160;
const CHART_PADDING = { top: 12, right: 12, bottom: 12, left: 12 };

export interface PlottedPoint extends TimeSeriesPoint {
  readonly x: number;
  readonly y: number;
}

export interface ChartGeometry {
  readonly plotted: readonly PlottedPoint[];
  readonly yMin: number;
  readonly yMax: number;
  readonly path: string;
}

const EMPTY_GEOMETRY: ChartGeometry = { plotted: [], yMin: 0, yMax: 0, path: "" };

/**
 * Pure coordinate computation, split out from the Lit template so it's
 * unit-testable without a DOM (same pure-computation/thin-render split as
 * `AgentStatsPipeline.ts`/`AgentStatsSections.ts`). `points` need not be
 * sorted — plotted left-to-right in the order given, matching every series
 * computation upstream (`AgentTimeSeries.ts`) which already returns
 * chronological order.
 */
export function computeChartGeometry(
  points: readonly TimeSeriesPoint[],
  yDomain: readonly [number, number] | null,
): ChartGeometry {
  if (points.length === 0) return EMPTY_GEOMETRY;
  const values = points.map((point) => point.value);
  const [yMin, yMax] = yDomain ?? [Math.min(...values), Math.max(...values)];
  // A flat series (every value identical, or a fixed domain with zero span)
  // would divide by zero — fall back to a span of 1 so a single-valued
  // series still renders as a flat centered line instead of NaN geometry.
  const span = yMax - yMin || 1;
  const innerWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const innerHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const plotted = points.map((point, index) => {
    const x =
      CHART_PADDING.left +
      (points.length === 1
        ? innerWidth / 2
        : (index / (points.length - 1)) * innerWidth);
    const y =
      CHART_PADDING.top +
      innerHeight -
      ((point.value - yMin) / span) * innerHeight;
    return { ...point, x, y };
  });
  const path = plotted
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
  return { plotted, yMin, yMax, path };
}

/**
 * Renders one chart. `nothing` for an empty series — callers already gate
 * on their own sample threshold (`WinrateSeries`/`ScoreSeries` being
 * non-null) before calling this, so an empty `points` array here would only
 * happen on a genuine bug upstream; rendering nothing is still the honest,
 * non-crashing choice.
 */
export function renderTimeSeriesChart(
  props: TimeSeriesChartProps,
): TemplateResult | typeof nothing {
  if (props.points.length === 0) return nothing;
  const { plotted, path } = computeChartGeometry(props.points, props.yDomain);
  return html`
    <figure class="stat-chart">
      <svg
        class="stat-chart-svg"
        viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}"
        role="img"
        aria-label=${props.ariaLabel}
        preserveAspectRatio="none"
      >
        ${plotted
          .filter((point) => point.marker !== null && point.marker !== undefined)
          .map(
            (point) => html`
              <line
                class="stat-chart-marker"
                x1=${point.x}
                y1=${CHART_PADDING.top}
                x2=${point.x}
                y2=${CHART_HEIGHT - CHART_PADDING.bottom}
              >
                <title>${point.marker}</title>
              </line>
            `,
          )}
        <path class="stat-chart-line" d=${path} style=${`stroke: ${props.color}`}></path>
        ${plotted.map(
          (point) => html`
            <circle
              class="stat-chart-point"
              cx=${point.x}
              cy=${point.y}
              r="3"
              style=${`fill: ${props.color}`}
            >
              <title>${props.formatX(point.at)}: ${props.formatValue(point.value)}</title>
            </circle>
          `,
        )}
      </svg>
      <p class="stat-chart-caption">${props.captionText}</p>
      <details class="stat-chart-table">
        <summary>${translateText("stat_chart.data_table_toggle")}</summary>
        <table>
          <caption class="stat-chart-table-caption">${props.tableCaption}</caption>
          <thead>
            <tr>
              <th scope="col">${translateText("stat_chart.column_date")}</th>
              <th scope="col">${props.columnValueLabel}</th>
            </tr>
          </thead>
          <tbody>
            ${props.points.map(
              (point) => html`
                <tr>
                  <td>${props.formatX(point.at)}</td>
                  <td>
                    ${props.formatValue(point.value)}
                    ${point.marker
                      ? html`<span class="stat-chart-table-marker"
                          >(${point.marker})</span
                        >`
                      : nothing}
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </details>
    </figure>
  `;
}
