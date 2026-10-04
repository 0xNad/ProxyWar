import { html, nothing } from "lit";
import { translateText } from "../Utils";
import { contrastRatio } from "./HomePresentation";
import { CROWN_GLYPH } from "./WorldGlyphs";
import type { WorldDay, WorldTheatreId } from "./WorldModelSchema";
import { WORLD_REGION_IDS } from "./WorldPresentation";
import { formatLeagueDay, frontInText, modeKey, pageLocale } from "./WorldText";
import type { WorldView } from "./WorldView";

/**
 * "The war so far": who held each front at the end of every day, one row
 * per front with the Crown first. Each reign is a block as long as it
 * lasted, in its holder's colour and named when there is room, so a front
 * changing hands reads as a change of colour along its row. Pointing at a
 * reign says who held it and when; the keyboard steps through the days and
 * hears each one in words.
 */

/** Where the history is being read: a day, and a front when a pointer is on one. */
export interface HistoryFocus {
  readonly day: number;
  readonly front: WorldTheatreId | null;
}

/** One unbroken stretch of days with the same holder (or none). */
export interface HistoryReign {
  readonly holder: string | null;
  /** First and last day index, inclusive. */
  readonly from: number;
  readonly to: number;
}

export interface HistoryRow {
  readonly id: WorldTheatreId;
  readonly reigns: readonly HistoryReign[];
}

const ROW_ORDER: readonly WorldTheatreId[] = ["crown", ...WORLD_REGION_IDS];
/** Text on a banner: dark ink where it reads, light ink otherwise. */
const DARK_INK = "#0b1220";
const LIGHT_INK = "#edf1f7";

/** Each front's reigns, in row order (the Crown, then west to east). */
export function historyRows(days: readonly WorldDay[]): HistoryRow[] {
  return ROW_ORDER.map((id) => {
    const reigns: HistoryReign[] = [];
    days.forEach((day, index) => {
      const holder = day.holders[id] ?? null;
      const last = reigns[reigns.length - 1];
      if (last !== undefined && last.holder === holder) {
        reigns[reigns.length - 1] = { ...last, to: index };
      } else {
        reigns.push({ holder, from: index, to: index });
      }
    });
    return { id, reigns };
  });
}

export function renderHistory(
  view: WorldView,
  focus: HistoryFocus | null,
  onFocus: (focus: HistoryFocus | null) => void,
) {
  const days = view.model.timeline;
  const n = days.length;
  if (n < 2) return nothing;
  const rows = historyRows(days);
  const dateOf = (index: number) => formatLeagueDay(days[index].day);
  // Without a pointer or focus on it, the history reads as its latest day.
  const current = focus?.day ?? n - 1;
  const step = (day: number) =>
    onFocus({ day: Math.max(0, Math.min(n - 1, day)), front: null });
  const at = (event: PointerEvent): HistoryFocus | null => {
    const bar = (event.target as Element).closest<HTMLElement>(".wp-tl-bar");
    if (bar === null) return null;
    const rect = bar.getBoundingClientRect();
    if (rect.width === 0) return null;
    const day = Math.floor(((event.clientX - rect.left) / rect.width) * n);
    return {
      day: Math.max(0, Math.min(n - 1, day)),
      front: bar.dataset.front as WorldTheatreId,
    };
  };
  const position = (day: number) => (day + 0.5) / n;
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
    <div class="wp-tl">
      <ul class="wp-tl-fronts" role="list">
        ${rows.map(
          (row) =>
            html`<li>
              <button
                type="button"
                class="wp-tl-front"
                aria-haspopup="dialog"
                tabindex="-1"
                @click=${() => view.openFront(row.id)}
              >
                ${row.id === "crown"
                  ? html`<span class="wp-tl-crown">${CROWN_GLYPH}</span>`
                  : nothing}${view.frontName(row.id)}
              </button>
            </li>`,
        )}
      </ul>
      <div
        class="wp-tl-grid"
        tabindex="0"
        role="slider"
        aria-label=${translateText("world_page.history_aria")}
        aria-valuemin="0"
        aria-valuemax=${n - 1}
        aria-valuenow=${current}
        aria-valuetext=${daySummary(view, days[current], dateOf(current))}
        @pointermove=${(event: PointerEvent) => {
          const next = at(event);
          if (next !== null) onFocus(next);
        }}
        @pointerdown=${(event: PointerEvent) => {
          const next = at(event);
          if (next !== null) onFocus(next);
        }}
        @pointerleave=${(event: PointerEvent) => {
          // A finger lifting is a leave too; a tapped reign stays shown.
          if (event.pointerType === "mouse") onFocus(null);
        }}
        @focus=${(event: FocusEvent) => {
          // Keyboard focus shows the latest day; a click already picked one.
          if (focusVisible(event.currentTarget as Element)) step(current);
        }}
        @blur=${() => onFocus(null)}
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
        ${rows.map((row) => renderBar(view, row, n, focus, dateOf, position))}
        ${focus !== null
          ? html`<i
              class="wp-tl-cursor"
              style="--at:${position(focus.day)}"
              aria-hidden="true"
            ></i>`
          : nothing}
      </div>
      <div class="wp-tl-axis" aria-hidden="true">
        ${monthTicks(days).map(
          (tick) =>
            html`<span style="--at:${tick.index / n}">${tick.label}</span>`,
        )}
      </div>
      ${focus !== null && focus.front === null
        ? html`<p class="wp-tl-readout" aria-hidden="true">
            ${daySummary(view, days[focus.day], dateOf(focus.day))}
          </p>`
        : nothing}
    </div>
  </section>`;
}

/**
 * One front's reigns as a single bar with month ticks, for its sheet: the
 * blocks of its row in "The war so far". Its caption says in words what the
 * bar shows, so the bar itself is decoration. The sheet's list of rulers
 * cannot stand in for it: it keeps only the latest reigns, and a reign
 * within one day never reaches an end-of-day bar.
 */
export function renderFrontTimeline(view: WorldView, id: WorldTheatreId) {
  const days = view.model.timeline;
  const n = days.length;
  if (n < 2) return nothing;
  const row = historyRows(days).find((entry) => entry.id === id);
  const held = (row?.reigns ?? []).filter(
    (reign): reign is HistoryReign & { holder: string } =>
      reign.holder !== null,
  );
  if (row === undefined || held.length === 0) return nothing;
  // The longest reign; of equals, the latest.
  const longest = held.reduce((best, reign) =>
    reign.to - reign.from >= best.to - best.from ? reign : best,
  );
  const holders = new Set(held.map((reign) => reign.holder)).size;
  const params = {
    date: formatLeagueDay(days[0].day),
    count: holders,
    name: view.label(longest.holder),
    days: longest.to - longest.from + 1,
    from: formatLeagueDay(days[longest.from].day),
  };
  return html`<figure class="wp-tl-solo">
    <div aria-hidden="true">
      ${renderBar(
        view,
        row,
        n,
        null,
        () => "",
        () => 0,
      )}
      <div class="wp-tl-axis">
        ${monthTicks(days).map(
          (tick) =>
            html`<span style="--at:${tick.index / n}">${tick.label}</span>`,
        )}
      </div>
    </div>
    <figcaption class="wp-tl-caption">
      ${translateText(
        holders === 1
          ? "world_page.sheet_days_one"
          : longest.to === n - 1
            ? modeKey(view.model, "world_page.sheet_days_ongoing")
            : modeKey(view.model, "world_page.sheet_days"),
        params,
      )}
    </figcaption>
  </figure>`;
}

function renderBar(
  view: WorldView,
  row: HistoryRow,
  n: number,
  focus: HistoryFocus | null,
  dateOf: (index: number) => string,
  position: (day: number) => number,
) {
  const pointed =
    focus !== null && focus.front === row.id
      ? row.reigns.find(
          (reign) => focus.day >= reign.from && focus.day <= reign.to,
        )
      : undefined;
  return html`<div class="wp-tl-bar" data-front=${row.id}>
    ${row.reigns.map((reign) => {
      const color =
        reign.holder === null ? null : view.bannerColor(reign.holder);
      const ink = color === null ? null : bannerInk(color);
      return html`<span
        class="wp-tl-run ${reign.holder === null
          ? "wp-tl-open"
          : ""} ${reign === pointed ? "wp-tl-pointed" : ""} ${ink?.plated
          ? "wp-tl-plated"
          : ""}"
        style="flex-grow:${reign.to - reign.from + 1}${color === null ||
        ink === null
          ? ""
          : `;--c:${color};--t:${ink.ink}`}"
        ><span class="wp-tl-name"
          >${reign.holder !== null
            ? view.label(reign.holder)
            : reign.to === n - 1
              ? // Named only where a front is still unclaimed: before the
                // war reached a front, the slate says enough.
                translateText("world_page.status_unclaimed")
              : nothing}</span
        ></span
      >`;
    })}
    ${pointed !== undefined && focus !== null
      ? html`<span
          class="wp-tl-tip"
          style="--at:${position(focus.day)}"
          aria-hidden="true"
          >${reignSentence(view, row.id, pointed, n, dateOf)}</span
        >`
      : nothing}
  </div>`;
}

/** "Matt Van held the Black Sea from Sep 27 to Oct 1", and the like. */
function reignSentence(
  view: WorldView,
  id: WorldTheatreId,
  reign: HistoryReign,
  n: number,
  dateOf: (index: number) => string,
): string {
  const params = {
    front: frontInText(id),
    from: dateOf(reign.from),
    to: dateOf(reign.to),
    date: dateOf(reign.from),
  };
  const ongoing = reign.to === n - 1;
  if (reign.holder === null) {
    if (ongoing) {
      // Held fronts never fall back to no one, so an empty stretch that
      // started the history and is still going is a front never held.
      return translateText(
        reign.from === 0
          ? "world_page.history_open_never"
          : "world_page.history_open_since",
        params,
      );
    }
    return translateText(
      reign.from === reign.to
        ? "world_page.history_open_day"
        : "world_page.history_open",
      params,
    );
  }
  const holder = view.label(reign.holder);
  if (ongoing) {
    return translateText("world_page.history_holding", { ...params, holder });
  }
  return translateText(
    reign.from === reign.to
      ? "world_page.history_held_day"
      : "world_page.history_held",
    { ...params, holder },
  );
}

/** One day in words, for the keyboard readout and screen readers. */
function daySummary(view: WorldView, day: WorldDay, date: string): string {
  const parts = ROW_ORDER.flatMap((id) => {
    const holder = day.holders[id] ?? null;
    return holder === null
      ? []
      : [
          translateText("world_page.history_day_front", {
            front: frontInText(id),
            name: view.label(holder),
          }),
        ];
  });
  return translateText("world_page.history_day", {
    date,
    summary:
      parts.length === 0
        ? translateText("world_page.history_day_none")
        : view.list(parts),
  });
}

/** The first day of each month in range, named in the page's language. */
function monthTicks(
  days: readonly WorldDay[],
): Array<{ index: number; label: string }> {
  const month = new Intl.DateTimeFormat(pageLocale(), {
    month: "short",
    timeZone: "UTC",
  });
  const ticks: Array<{ index: number; label: string }> = [];
  days.forEach((day, index) => {
    if (index === 0 || day.day.endsWith("-01")) {
      ticks.push({
        index,
        label: month.format(new Date(`${day.day}T12:00:00Z`)),
      });
    }
  });
  // A month with only a few days in range has no room for its name: at the
  // start it would collide with the next, at the end run off the page.
  if (ticks.length > 1 && ticks[1].index - ticks[0].index < 5) ticks.shift();
  const last = ticks[ticks.length - 1];
  if (ticks.length > 1 && days.length - last.index < 5) ticks.pop();
  return ticks;
}

/**
 * A name written on a holder's banner: in whichever ink reads at 4.5:1 or
 * better, or, on a mid-tone banner where neither does, in light ink on a
 * small dark plate.
 */
export function bannerInk(color: string): {
  readonly ink: string;
  readonly plated: boolean;
} {
  const dark = contrastRatio(color, DARK_INK) ?? 0;
  const light = contrastRatio(color, LIGHT_INK) ?? 0;
  if (dark >= 4.5 && dark >= light) return { ink: DARK_INK, plated: false };
  if (light >= 4.5) return { ink: LIGHT_INK, plated: false };
  return { ink: LIGHT_INK, plated: true };
}

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}
