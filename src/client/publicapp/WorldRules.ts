import { html, nothing } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { translateText } from "../Utils";
import { CROWN_GLYPH } from "./WorldGlyphs";
import { ICONS, type WorldView } from "./WorldView";

/** "How the world works": the three rules, and where the data comes from. */
export function renderRules(view: WorldView) {
  const model = view.model;
  return html`<section
    class="wp-wrap wp-section"
    aria-labelledby="wp-rules-title"
  >
    <div class="wp-section-head">
      <h2 id="wp-rules-title" class="wp-section-title">
        ${translateText("world_page.rules_title")}
      </h2>
    </div>
    <div class="wp-rules">
      <article class="wp-rule">
        <span class="wp-rule-icon">${unsafeSVG(ICONS.pin)}</span>
        <h3>${translateText("world_page.rule_place_title")}</h3>
        <p>${translateText("world_page.rule_place_body")}</p>
      </article>
      <article class="wp-rule">
        <span class="wp-rule-icon">${unsafeSVG(ICONS.flag)}</span>
        <h3>
          ${translateText("world_page.rule_window_title", {
            window: model.windowSize,
          })}
        </h3>
        <p>
          ${translateText("world_page.rule_window_body", {
            window: model.windowSize,
          })}
        </p>
      </article>
      <article class="wp-rule">
        <span class="wp-rule-icon wp-rule-icon-crown">${CROWN_GLYPH}</span>
        <h3>${translateText("world_page.rule_crown_title")}</h3>
        <p>${translateText("world_page.rule_crown_body")}</p>
      </article>
    </div>
    ${model.firstBattleAt !== null
      ? html`<p class="wp-data-note">
          ${translateText("world_page.data_note", {
            count: model.battleCount,
            date: view.date(model.firstBattleAt),
          })}
        </p>`
      : nothing}
  </section>`;
}
