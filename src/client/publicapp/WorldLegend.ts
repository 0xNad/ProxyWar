import { html, nothing, type TemplateResult } from "lit";
import { translateText } from "../Utils";
import {
  clearestSiege,
  crownFront,
  frontsInState,
  holderGroups,
} from "./HomePresentation";
import { stateWord } from "./WorldFronts";
import { CROWN_GLYPH } from "./WorldGlyphs";
import type { WorldTheatre } from "./WorldModelSchema";
import { frontDisplayState, UNCLAIMED_HEX } from "./WorldPresentation";
import { nameMarker, splice } from "./WorldText";
import type { WorldView } from "./WorldView";

/**
 * Who holds what, under the map. Below 1180 px there is no room for
 * placards on the map, so this is how a phone or tablet reads it: every
 * holder named in full, every front's state in words, each front one tap
 * from its history. Same order as the front page's legend.
 */
export function renderLegend(view: WorldView) {
  const model = view.model;
  const crown = crownFront(model);
  const crownHolder = crown?.holder ?? null;
  const open = frontsInState(model, "unclaimed", view.now);
  return html`<ul
    class="wp-legend"
    aria-label=${translateText("world_page.legend_aria")}
  >
    ${holderGroups(model).map(
      (group) =>
        html`<li>
          <span class="wp-legend-who"
            >${view.emblem(group.holder, 22)}${view.agentLink(
              group.holder,
              "wp-legend-name",
            )}</span
          ><span class="wp-legend-fronts"
            >${group.fronts.map((front) => legendFront(view, front))}</span
          >
        </li>`,
    )}
    ${crown !== null
      ? html`<li>
          <span class="wp-legend-who"
            >${view.emblem(crownHolder, 22)}${crownHolder === null
              ? html`<span class="wp-legend-name wp-legend-muted"
                  >${translateText("world_page.crown_vacant")}</span
                >`
              : view.agentLink(crownHolder, "wp-legend-name")}</span
          ><span class="wp-legend-fronts">${legendFront(view, crown)}</span>
        </li>`
      : nothing}
    ${open.length > 0
      ? html`<li>
          <span class="wp-legend-who"
            ><i
              class="wp-sw wp-sw-flag wp-sw-open"
              style="--paint:${UNCLAIMED_HEX}"
            ></i
            ><span class="wp-legend-name wp-legend-muted"
              >${translateText("world_page.legend_unclaimed")}</span
            ></span
          ><span class="wp-legend-fronts"
            >${open.map((front) => legendFront(view, front, false))}</span
          >
        </li>`
      : nothing}
  </ul>`;
}

/** One front in the legend: its map swatch, its name, its state in words. */
export function legendFront(
  view: WorldView,
  front: WorldTheatre,
  withSwatch = true,
) {
  const state = stateWord(frontDisplayState(front, view.now));
  const name = html`<span class="wp-legend-front-name"
    >${view.frontName(front.id)}</span
  >`;
  // The Crown holds no land, so it has nothing on the map to highlight.
  const onMap = front.id !== "crown";
  let mark: TemplateResult | typeof nothing = nothing;
  if (!onMap) {
    mark = html`<span class="wp-legend-front-crown">${CROWN_GLYPH}</span>`;
  } else if (withSwatch) {
    mark = html`<i
      class="wp-sw ${view.lowContrast(front.holder) ? "wp-low" : ""}"
      style="--paint:${view.swatch(front)}"
    ></i>`;
  }
  return html`<button
    type="button"
    class="wp-legend-front"
    aria-haspopup="dialog"
    @click=${() => view.openFront(front.id)}
    @pointerenter=${() => {
      if (onMap) view.focusFront(front.id);
    }}
    @pointerleave=${() => {
      view.focusFront(null);
    }}
    @focus=${() => {
      if (onMap) view.focusFront(front.id);
    }}
    @blur=${() => {
      view.focusFront(null);
    }}
  >
    ${mark}<span class="wp-legend-front-text"
      >${state === null
        ? name
        : splice(
            "world_page.front_with_state",
            { front: nameMarker(0), state },
            [name],
          )}</span
    >
  </button>`;
}

/** How to read the map, with swatches painted like the map itself. */
export function renderKey(view: WorldView) {
  const model = view.model;
  const siege = clearestSiege(
    model,
    (name) => view.bannerColor(name),
    view.now,
  );
  const quiet = frontsInState(model, "quiet", view.now)[0] ?? null;
  const open = frontsInState(model, "unclaimed", view.now).length > 0;
  if (siege === null && quiet === null && !open) return nothing;
  return html`<ul
    class="wp-key"
    aria-label=${translateText("world_page.key_aria")}
  >
    ${siege !== null
      ? html`<li>
          <i class="wp-sw" style="--paint:${view.swatch(siege)}"></i
          >${translateText("world_page.key_siege")}
        </li>`
      : nothing}
    ${quiet !== null
      ? html`<li>
          <i class="wp-sw" style="--paint:${view.swatch(quiet)}"></i
          >${translateText("world_page.key_quiet")}
        </li>`
      : nothing}
    ${open
      ? html`<li>
          <i class="wp-sw wp-sw-open" style="--paint:${UNCLAIMED_HEX}"></i
          >${translateText("world_page.key_open")}
        </li>`
      : nothing}
  </ul>`;
}
