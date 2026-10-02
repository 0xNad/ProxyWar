import { html, nothing } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { assetUrl } from "../../core/AssetUrls";
import { translateText } from "../Utils";
import { contestLine } from "./WorldFronts";
import type { WorldTheatre, WorldTheatreId } from "./WorldModelSchema";
import { battlefieldKey, frontDisplayState } from "./WorldPresentation";
import { battlefieldName } from "./WorldText";
import { ICONS, STATUS_KEYS, type WorldView } from "./WorldView";

/**
 * A front's history in a sheet: who holds it and since when, how close the
 * race is, its last battles, every ruler it has had and the maps it is
 * fought on. Opens from a map label, the legend, a row or `#front-<id>`.
 */
export function renderDrawer(view: WorldView, id: WorldTheatreId) {
  const model = view.model;
  const theatre = model.theatres.find((entry) => entry.id === id);
  if (theatre === undefined) return nothing;
  const display = frontDisplayState(theatre, view.now);
  const name = view.frontName(id);
  const thumb = thumbnail(theatre);
  const maxTally = Math.max(1, ...theatre.tallies.map((tally) => tally.wins));
  const reign = theatre.reigns.find((entry) => entry.to === null);
  return html`<div
      class="wp-drawer-backdrop"
      @click=${() => view.closeFront()}
    ></div>
    <aside
      class="wp-drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wp-drawer-title"
      @keydown=${trapFocus}
      data-state=${display}
      style="--banner:${view.bannerColor(
        theatre.holder,
      )};--rival:${view.bannerColor(theatre.challenger)}"
    >
      <div class="wp-drawer-art" aria-hidden="true">
        ${thumb !== null
          ? html`<img
              src=${thumb}
              alt=""
              @error=${(event: Event) => {
                (event.target as HTMLElement).hidden = true;
              }}
            />`
          : nothing}
      </div>
      <header class="wp-drawer-head">
        <div>
          <span class="wp-chip" data-state=${display}
            >${translateText(STATUS_KEYS[display])}</span
          >
          <h2 id="wp-drawer-title" class="wp-drawer-title">${name}</h2>
        </div>
        <button
          type="button"
          class="wp-drawer-close"
          aria-label=${translateText("world_page.detail_close")}
          @click=${() => view.closeFront()}
        >
          ${unsafeSVG(ICONS.close)}
        </button>
      </header>
      <div class="wp-drawer-body">
        ${theatre.holder === null
          ? html`<p class="wp-front-empty">
              ${translateText(
                theatre.battleCount === 0
                  ? "world_page.front_unclaimed_body"
                  : "world_page.front_unclaimed_tried",
                {
                  count: theatre.battleCount,
                  maps: view.list(
                    theatre.battlefields.map((map) => battlefieldName(map)),
                  ),
                },
              )}
            </p>`
          : html`<div class="wp-drawer-holder">
                ${view.emblem(theatre.holder, 56)}
                <div>
                  <div class="wp-kicker">
                    ${translateText("world_page.detail_holder")}
                  </div>
                  <div class="wp-drawer-holdername">
                    ${view.agentLink(theatre.holder)}
                  </div>
                  ${theatre.heldSince !== null
                    ? html`<div class="wp-drawer-since">
                        ${translateText("world_page.front_held_since", {
                          date: view.date(theatre.heldSince),
                        })}
                      </div>`
                    : nothing}
                  ${reign !== undefined
                    ? html`<div class="wp-drawer-since">
                        ${translateText("world_page.detail_reign_current", {
                          wins: reign.wins,
                          battles: reign.battles,
                        })}
                      </div>`
                    : nothing}
                </div>
              </div>
              <p class="wp-front-line">${contestLine(view, theatre)}</p>`}
        ${theatre.tallies.length > 0
          ? html`<h3 class="wp-drawer-sub">
                ${translateText("world_page.detail_tally", {
                  window: model.windowSize,
                })}
              </h3>
              <ul class="wp-tally" role="list">
                ${theatre.tallies.map(
                  (tally) =>
                    html`<li style="--banner:${view.bannerColor(tally.name)}">
                      <span class="wp-tally-name"
                        >${view.emblem(tally.name, 18)}
                        ${view.agentLink(tally.name)}</span
                      >
                      <span class="wp-tally-bar"
                        ><i style="width:${(tally.wins / maxTally) * 100}%"></i
                      ></span>
                      <b>${tally.wins}</b>
                    </li>`,
                )}
              </ul>`
          : nothing}
        ${theatre.window.length > 0
          ? html`<h3 class="wp-drawer-sub">
                ${translateText("world_page.detail_battles", {
                  count: theatre.window.length,
                })}
              </h3>
              <ol class="wp-battles" role="list">
                ${[...theatre.window].reverse().map(
                  (battle) =>
                    html`<li
                      style="--banner:${view.bannerColor(battle.winner)}"
                    >
                      <a href=${battle.href} class="wp-battle">
                        <span class="wp-battle-when"
                          >${view.date(battle.at, true)}</span
                        >
                        <span class="wp-battle-map"
                          >${battlefieldName(battle.map)}</span
                        >
                        <span class="wp-battle-winner"
                          >${battle.winner !== null
                            ? view.emblem(battle.winner, 16)
                            : nothing}
                          ${view.label(battle.winner)}</span
                        >
                      </a>
                    </li>`,
                )}
              </ol>`
          : nothing}
        ${theatre.reigns.length > 0
          ? html`<h3 class="wp-drawer-sub">
                ${translateText("world_page.detail_reigns")}
              </h3>
              <ol class="wp-reigns" role="list">
                ${theatre.reigns.map(
                  (entry) =>
                    html`<li style="--banner:${view.bannerColor(entry.holder)}">
                      ${view.emblem(entry.holder, 20)}
                      <span class="wp-reign-name"
                        >${view.label(entry.holder)}</span
                      >
                      <span class="wp-reign-span"
                        >${view.date(entry.from)} –
                        ${entry.to === null
                          ? translateText("world_page.detail_reign_now")
                          : view.date(entry.to)}</span
                      >
                      <span class="wp-reign-record"
                        >${translateText("world_page.detail_reign", {
                          wins: entry.wins,
                          battles: entry.battles,
                        })}</span
                      >
                    </li>`,
                )}
              </ol>`
          : nothing}
        ${theatre.maps.length > 0
          ? html`<p class="wp-drawer-maps">
              ${translateText("world_page.detail_battlefields", {
                maps: view.list(
                  theatre.maps.map((entry) =>
                    translateText("world_page.detail_battlefield", {
                      map: battlefieldName(entry.map),
                      count: entry.battles,
                    }),
                  ),
                ),
              })}
            </p>`
          : nothing}
      </div>
    </aside>`;
}

/** Tab and Shift+Tab cycle inside the open sheet, as in any modal dialog. */
function trapFocus(event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const sheet = event.currentTarget as HTMLElement;
  const focusable = [
    ...sheet.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function thumbnail(theatre: WorldTheatre): string | null {
  const key = theatre.maps[0]?.map ?? theatre.battlefields[0];
  if (key === undefined) return null;
  try {
    return assetUrl(`maps/${battlefieldKey(key)}/thumbnail.webp`);
  } catch {
    return null;
  }
}
