import { html, nothing } from "lit";
import { translateText } from "../Utils";
import type { WorldEvent } from "./WorldModelSchema";
import {
  eventSentence,
  formatDayHeading,
  formatTime,
  localDay,
  modeKey,
  nameMarker,
  splice,
} from "./WorldText";
import type { WorldView } from "./WorldView";

/** How many dispatches show before "Show all". */
const DISPATCHES_COLLAPSED = 10;

/**
 * "Dispatches": every front-changing event, newest first and grouped by the
 * visitor's day, each told as a sentence that links to its battle.
 */
export function renderDispatches(
  view: WorldView,
  expanded: boolean,
  onToggle: () => void,
) {
  const model = view.model;
  const events = expanded
    ? model.events
    : model.events.slice(0, DISPATCHES_COLLAPSED);
  return html`<section class="wp-panel" aria-labelledby="wp-dispatches-title">
    <h2 id="wp-dispatches-title" class="wp-section-title">
      ${translateText("world_page.dispatches_title")}
    </h2>
    <p class="wp-panel-intro">
      ${translateText(modeKey(model, "world_page.dispatches_definition"), {
        window: model.windowSize,
      })}
    </p>
    ${model.events.length === 0
      ? html`<p class="wp-muted">
          ${translateText("world_page.dispatches_empty")}
        </p>`
      : dayGroups(events).map(
          (group) =>
            html`<h3 class="wp-dispatch-day">
                ${formatDayHeading(group.events[0].at, view.now)}
              </h3>
              <ol class="wp-dispatches" role="list">
                ${group.events.map((event) => renderDispatch(view, event))}
              </ol>`,
        )}
    ${model.events.length > DISPATCHES_COLLAPSED
      ? html`<button type="button" class="wp-more" @click=${onToggle}>
          ${expanded
            ? translateText("world_page.dispatches_less")
            : translateText("world_page.dispatches_more", {
                count: model.events.length,
              })}
        </button>`
      : nothing}
  </section>`;
}

/** Events in a row by the visitor's calendar day, newest day first. */
function dayGroups(
  events: readonly WorldEvent[],
): Array<{ day: string; events: WorldEvent[] }> {
  const groups: Array<{ day: string; events: WorldEvent[] }> = [];
  for (const event of events) {
    const day = localDay(Date.parse(event.at));
    const last = groups[groups.length - 1];
    if (last !== undefined && last.day === day) last.events.push(event);
    else groups.push({ day, events: [event] });
  }
  return groups;
}

/** One event in the front page's words; the whole row watches the battle. */
function renderDispatch(view: WorldView, event: WorldEvent) {
  const { key, params } = eventSentence(
    event,
    (name) => view.label(name),
    view.model,
  );
  const sentence = translateText(key, {
    ...params,
    agent: view.label(event.agent),
  });
  return html`<li>
    <a
      class="wp-dispatch"
      href=${event.href}
      aria-label=${translateText("world_page.watch_event_aria", {
        event: sentence,
      })}
    >
      <time datetime=${event.at} title=${view.age(event.at)}
        >${formatTime(event.at)}</time
      >
      <span class="wp-dispatch-text"
        ><i
          class="wp-dispatch-chip ${view.lowContrast(event.agent)
            ? "wp-low"
            : ""}"
          style="--chip:${view.bannerColor(event.agent)}"
          aria-hidden="true"
        ></i
        >${splice(key, { ...params, agent: nameMarker(0) }, [
          html`<b>${view.label(event.agent)}</b>`,
        ])}</span
      >
      <span class="wp-dispatch-watch" aria-hidden="true"
        >${translateText("world_page.event_battle_link")}</span
      >
    </a>
  </li>`;
}
