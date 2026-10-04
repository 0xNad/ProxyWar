import { html } from "lit";
import { translateText } from "../Utils";
import { legendFront } from "./WorldLegend";
import { formatNumber, modeKey } from "./WorldText";
import type { WorldView } from "./WorldView";

/**
 * "Powers": the agents holding fronts or the Crown, then the strongest of
 * the rest, with what they hold and their conquests and wins.
 */
export function renderPowers(view: WorldView) {
  const model = view.model;
  const crownHolder =
    view.model.theatres.find((entry) => entry.id === "crown")?.holder ?? null;
  const rows = model.agents
    .filter(
      (agent) =>
        agent.theatres.some((id) => id !== "crown") ||
        agent.name === crownHolder,
    )
    .concat(
      model.agents
        .filter(
          (agent) =>
            !agent.theatres.some((id) => id !== "crown") &&
            agent.name !== crownHolder,
        )
        .sort(
          (a, b) => b.conquests - a.conquests || b.battlesWon - a.battlesWon,
        )
        .slice(0, 4),
    );
  return html`<section class="wp-panel" aria-labelledby="wp-powers-title">
    <h2 id="wp-powers-title" class="wp-section-title">
      ${translateText("world_page.powers_title")}
    </h2>
    <p class="wp-panel-intro">
      ${translateText("world_page.powers_intro", {
        date:
          model.firstBattleAt === null ? "—" : view.date(model.firstBattleAt),
      })}
    </p>
    <table class="wp-powers">
      <thead>
        <tr>
          <th scope="col">
            ${translateText(modeKey(model, "world_page.powers_agent"))}
          </th>
          <th scope="col">${translateText("world_page.powers_fronts")}</th>
          <th scope="col" class="wp-num wp-powers-conquests">
            ${translateText("world_page.powers_conquests")}
          </th>
          <th scope="col" class="wp-num">
            ${translateText("world_page.powers_wins")}
          </th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((agent) => {
          // The Crown last, after the land; the same links as the legend.
          const holdings = [
            ...agent.theatres.filter((id) => id !== "crown"),
            ...(agent.name === crownHolder ? (["crown"] as const) : []),
          ].flatMap((id) => {
            const theatre = view.model.theatres.find(
              (entry) => entry.id === id,
            );
            return theatre === undefined ? [] : [theatre];
          });
          return html`<tr style="--banner:${view.bannerColor(agent.name)}">
            <th scope="row">
              <span class="wp-power-agent">
                ${view.emblem(agent.name, 26)} ${view.agentLink(agent.name)}
              </span>
            </th>
            <td>
              ${holdings.length === 0
                ? html`<span class="wp-muted">—</span>`
                : html`<span class="wp-power-fronts"
                    >${holdings.map((theatre) =>
                      legendFront(view, theatre),
                    )}</span
                  >`}
            </td>
            <td class="wp-num wp-powers-conquests">
              ${formatNumber(agent.conquests)}
            </td>
            <td class="wp-num">${formatNumber(agent.battlesWon)}</td>
          </tr>`;
        })}
      </tbody>
    </table>
  </section>`;
}
