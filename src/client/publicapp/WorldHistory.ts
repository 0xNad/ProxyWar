import { html, nothing, svg } from "lit";
import { translateText } from "../Utils";
import { CROWN_GLYPH } from "./WorldGlyphs";
import type { WorldDay } from "./WorldModelSchema";
import { WORLD_REGION_IDS } from "./WorldPresentation";
import type { WorldView } from "./WorldView";

/**
 * "The war so far": how many fronts each agent held at the end of every
 * day, stacked, with the Crown's holder as a band along the top. Hovering a
 * day lists who held what.
 */
export function renderHistory(
  view: WorldView,
  hover: number | null,
  onHover: (index: number | null) => void,
) {
  const model = view.model;
  const days = model.timeline;
  if (days.length < 2) return nothing;
  const regionIds = WORLD_REGION_IDS as readonly string[];
  const totals = new Map<string, number>();
  for (const day of days) {
    for (const [id, holder] of Object.entries(day.holders)) {
      if (holder === null || !regionIds.includes(id)) continue;
      totals.set(holder, (totals.get(holder) ?? 0) + 1);
    }
  }
  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([name]) => name);
  const series = [...top, "__others"];
  const width = 1000;
  const height = 220;
  const n = days.length;
  const x = (i: number) => (n === 1 ? 0 : (i / (n - 1)) * width);
  const y = (value: number) => height - (value / regionIds.length) * height;
  const stacks: number[][] = days.map((day) => {
    const counts = series.map(() => 0);
    for (const [id, holder] of Object.entries(day.holders)) {
      if (holder === null || !regionIds.includes(id)) continue;
      const index = top.indexOf(holder);
      counts[index === -1 ? series.length - 1 : index] += 1;
    }
    return counts;
  });
  const layers = series.map((name, s) => {
    const lower = stacks.map((counts) =>
      counts.slice(0, s).reduce((a, b) => a + b, 0),
    );
    const upper = stacks.map((counts, i) => lower[i] + counts[s]);
    let d = `M${x(0)},${y(upper[0])}`;
    for (let i = 1; i < n; i++)
      d += ` L${x(i).toFixed(1)},${y(upper[i]).toFixed(1)}`;
    for (let i = n - 1; i >= 0; i--)
      d += ` L${x(i).toFixed(1)},${y(lower[i]).toFixed(1)}`;
    return { name, d: `${d} Z` };
  });
  const crownColor = (holder: string | null | undefined) =>
    holder ? view.bannerColor(holder) : "rgba(148,163,184,0.18)";
  const hoverDay = hover === null ? null : days[hover];
  const step = (index: number) => onHover(Math.max(0, Math.min(n - 1, index)));
  const indexAt = (event: PointerEvent) => {
    const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
    return Math.round(((event.clientX - rect.left) / rect.width) * (n - 1));
  };
  // Without a pointer or focus on it, the chart reads as its latest day.
  const current = hover ?? n - 1;
  return html`<section
    class="wp-wrap wp-section"
    aria-labelledby="wp-history-title"
  >
    <div class="wp-section-head">
      <h2 id="wp-history-title" class="wp-section-title">
        ${translateText("world_page.history_title")}
      </h2>
      <p class="wp-section-intro">
        ${translateText("world_page.history_intro")}
      </p>
    </div>
    <div class="wp-history">
      <div class="wp-history-chart">
        <svg
          viewBox="0 0 ${width} ${height + 26}"
          preserveAspectRatio="none"
          tabindex="0"
          role="slider"
          aria-label=${translateText("world_page.history_aria")}
          aria-valuemin="0"
          aria-valuemax=${n - 1}
          aria-valuenow=${current}
          aria-valuetext=${daySummary(view, days[current])}
          @pointermove=${(event: PointerEvent) => step(indexAt(event))}
          @pointerdown=${(event: PointerEvent) => step(indexAt(event))}
          @pointerleave=${(event: PointerEvent) => {
            // A finger lifting is a leave too; a tapped day stays shown.
            if (event.pointerType === "mouse") onHover(null);
          }}
          @focus=${(event: FocusEvent) => {
            // Keyboard focus shows the latest day; a click already picked one.
            if (focusVisible(event.currentTarget as Element)) step(current);
          }}
          @blur=${() => onHover(null)}
          @keydown=${(event: KeyboardEvent) => {
            const next: Record<string, number> = {
              ArrowLeft: current - 1,
              ArrowDown: current - 1,
              ArrowRight: current + 1,
              ArrowUp: current + 1,
              Home: 0,
              End: n - 1,
            };
            if (!(event.key in next)) return;
            event.preventDefault();
            step(next[event.key]);
          }}
        >
          ${days.map(
            (day, i) =>
              svg`<rect x=${x(i) - width / n / 2} y="0" width=${width / n + 0.5} height="12" style="fill:${crownColor(day.holders.crown)}"></rect>`,
          )}
          <g transform="translate(0 26)">
            ${[0.25, 0.5, 0.75].map(
              (f) =>
                svg`<line class="wp-history-grid" x1="0" x2=${width} y1=${height * f} y2=${height * f}></line>`,
            )}
            ${layers.map(
              (layer) =>
                svg`<path d=${layer.d} style="fill:${layer.name === "__others" ? "rgba(148,163,184,0.28)" : view.bannerColor(layer.name)}" class="wp-history-layer"></path>`,
            )}
            ${hover !== null
              ? svg`<line class="wp-history-cursor" x1=${x(hover)} x2=${x(hover)} y1="0" y2=${height}></line>`
              : nothing}
          </g>
        </svg>
        <div class="wp-history-axis">
          <span>${view.date(days[0].day + "T12:00:00Z")}</span>
          <span>${view.date(days[n - 1].day + "T12:00:00Z")}</span>
        </div>
        ${hoverDay !== null && hover !== null
          ? html`<div
              class="wp-history-tip"
              aria-hidden="true"
              style="left:${Math.min(
                86,
                Math.max(14, (hover / Math.max(1, n - 1)) * 100),
              )}%"
            >
              <b>${view.date(hoverDay.day + "T12:00:00Z")}</b>
              ${hoverDay.holders.crown
                ? html`<span class="wp-tip-row"
                    >${CROWN_GLYPH} ${view.label(hoverDay.holders.crown)}</span
                  >`
                : nothing}
              ${tipRows(view, hoverDay.holders)}
            </div>`
          : nothing}
      </div>
      <ul class="wp-history-legend" role="list">
        <li>
          <i class="wp-history-crown"></i>${translateText(
            "world_page.history_crown",
          )}
        </li>
        ${top.map(
          (name) =>
            html`<li>
              <i style="background:${view.bannerColor(name)}"></i>${view.label(
                name,
              )}
            </li>`,
        )}
        ${totals.size > top.length
          ? html`<li>
              <i class="wp-history-others"></i>${translateText(
                "world_page.history_others",
              )}
            </li>`
          : nothing}
      </ul>
    </div>
  </section>`;
}

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** Fronts held per agent on one day, most first. */
function frontCounts(
  holders: Record<string, string | null>,
): Array<[string, number]> {
  const regionIds = WORLD_REGION_IDS as readonly string[];
  const counts = new Map<string, number>();
  for (const [id, holder] of Object.entries(holders)) {
    if (holder === null || !regionIds.includes(id)) continue;
    counts.set(holder, (counts.get(holder) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}

/** One day in words, for the chart's keyboard and screen-reader readout. */
function daySummary(view: WorldView, day: WorldDay): string {
  const parts: string[] = [];
  const crown = day.holders.crown ?? null;
  if (crown !== null) {
    parts.push(
      translateText("world_page.history_day_crown", {
        name: view.label(crown),
      }),
    );
  }
  for (const [name, count] of frontCounts(day.holders)) {
    parts.push(
      translateText("world_page.history_day_fronts", {
        name: view.label(name),
        count,
      }),
    );
  }
  return translateText("world_page.history_day", {
    date: view.date(`${day.day}T12:00:00Z`),
    summary:
      parts.length === 0
        ? translateText("world_page.history_day_none")
        : view.list(parts),
  });
}

function tipRows(view: WorldView, holders: Record<string, string | null>) {
  return frontCounts(holders).map(
    ([name, count]) =>
      html`<span class="wp-tip-row"
        ><i style="background:${view.bannerColor(name)}"></i>${view.label(name)}
        <b>${count}</b></span
      > `,
  );
}
