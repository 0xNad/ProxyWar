import { html, nothing } from "lit";
import { translateText } from "../Utils";
import { CROWN_GLYPH } from "./WorldGlyphs";
import type { WorldModel, WorldTheatre } from "./WorldModelSchema";
import { frontDisplayState, type FrontDisplayState } from "./WorldPresentation";
import { isSeasonTwo } from "./WorldSeason";
import { modeKey } from "./WorldText";
import { STATUS_KEYS, type WorldView } from "./WorldView";

/**
 * Every front as one row: its state in words, who holds it and how close
 * the race is, its last battles as a strip, and when it was last fought
 * over. The whole row opens the front's history.
 */
export function renderFronts(view: WorldView) {
  const model = view.model;
  const rank: Record<FrontDisplayState, number> = {
    contested: 0,
    held: 1,
    quiet: 2,
    unclaimed: 3,
  };
  const crown = model.theatres.find((theatre) => theatre.id === "crown");
  const regions = model.theatres
    .filter((theatre) => theatre.id !== "crown")
    .sort((a, b) => {
      const byState =
        rank[frontDisplayState(a, view.now)] -
        rank[frontDisplayState(b, view.now)];
      if (byState !== 0) return byState;
      return (b.lastBattleAt ?? "").localeCompare(a.lastBattleAt ?? "");
    });
  return html`<section
    class="wp-wrap wp-section"
    aria-labelledby="wp-fronts-title"
  >
    <div class="wp-section-head">
      <h2 id="wp-fronts-title" class="wp-section-title">
        ${translateText("world_page.fronts_title")}
      </h2>
      <p class="wp-section-intro">
        ${translateText(modeKey(model, "world_page.fronts_intro"), {
          window: model.windowSize,
        })}
        ${translateText(modeKey(model, "world_page.fronts_strip_intro"))}
      </p>
    </div>
    <div class="wp-fronts-head" aria-hidden="true">
      <span>${translateText("world_page.fronts_head_front")}</span>
      <span>${translateText("world_page.fronts_head_holder")}</span>
      <span
        >${translateText(modeKey(model, "world_page.fronts_head_form"), {
          count: model.windowSize,
        })}</span
      >
      <span>${translateText("world_page.fronts_head_last")}</span>
    </div>
    <ol class="wp-fronts" role="list">
      ${crown !== undefined ? renderFrontRow(view, crown, model) : nothing}
      ${regions.map((theatre) => renderFrontRow(view, theatre, model))}
    </ol>
  </section>`;
}

function renderFrontRow(
  view: WorldView,
  theatre: WorldTheatre,
  model: WorldModel,
) {
  const display = frontDisplayState(theatre, view.now);
  const name = view.frontName(theatre.id);
  return html`<li class="wp-row" data-state=${display}>
    <button
      type="button"
      class="wp-row-hit"
      aria-haspopup="dialog"
      aria-label=${translateText("world_page.front_open", { front: name })}
      @click=${() => view.openFront(theatre.id)}
    ></button>
    <div class="wp-row-front">
      ${theatre.id === "crown"
        ? html`<span class="wp-row-crown">${CROWN_GLYPH}</span>`
        : html`<i
            class="wp-sw ${view.lowContrast(theatre.holder) ? "wp-low" : ""}"
            style="--paint:${view.swatch(theatre)}"
          ></i>`}
      <h3 class="wp-row-name">${name}</h3>
      <span class="wp-row-state">${translateText(STATUS_KEYS[display])}</span>
    </div>
    <div class="wp-row-holder">
      ${theatre.holder === null
        ? html`<span class="wp-row-empty">${unclaimedLine(theatre)}</span>`
        : html`${view.emblem(theatre.holder, 28)}
            <span class="wp-row-holdertext">
              <span class="wp-row-holdername"
                ><b>${view.label(theatre.holder)}</b>${theatre.heldSince !==
                null
                  ? html` <span class="wp-row-since"
                      >${translateText("world_page.row_since", {
                        date: view.date(theatre.heldSince),
                      })}</span
                    >`
                  : nothing}</span
              >
              <span class="wp-row-race">${contestLine(view, theatre)}</span>
            </span>`}
    </div>
    <div class="wp-row-form">${renderStrip(view, theatre, model)}</div>
    <div class="wp-row-last">
      ${theatre.lastBattleAt === null
        ? nothing
        : html`<span class="wp-row-age">${view.age(theatre.lastBattleAt)}</span>
            <span class="wp-row-age-phone"
              >${translateText("world_page.row_last_battle", {
                age: view.age(theatre.lastBattleAt),
              })}</span
            >
            <span class="wp-row-count"
              >${translateText("world_page.front_battles", {
                count: theatre.battleCount,
              })}</span
            >`}
    </div>
  </li>`;
}

/**
 * How close the race for a held front is, in words. In Season 2 the
 * latest battle decides a front, so the line says how that battle went.
 */
export function contestLine(view: WorldView, theatre: WorldTheatre): string {
  if (isSeasonTwo(view.model)) {
    const latest = theatre.window[theatre.window.length - 1];
    if (latest !== undefined && latest.winner === theatre.holder) {
      return translateText("world_page.front_won_latest");
    }
    if (latest !== undefined && latest.winner === null) {
      return translateText("world_page.front_kept_no_winner");
    }
  }
  if (theatre.challenger === null) {
    return translateText("world_page.front_unchallenged", {
      wins: theatre.holderWins,
      window: view.model.windowSize,
    });
  }
  // A tie stays a tie when the front goes quiet: decide on the status.
  if (theatre.status === "contested") {
    return translateText("world_page.front_level", {
      challenger: view.label(theatre.challenger),
      wins: theatre.holderWins,
    });
  }
  return translateText("world_page.front_lead", {
    holderWins: theatre.holderWins,
    challengerWins: theatre.challengerWins,
    challenger: view.label(theatre.challenger),
  });
}

/** An unclaimed front either saw no battle or no winner yet. */
export function unclaimedLine(theatre: WorldTheatre): string {
  return theatre.battleCount === 0
    ? translateText("world_page.front_no_battles")
    : translateText("world_page.front_no_winner", {
        count: theatre.battleCount,
      });
}

/** The state a front's name carries in brackets, or none while plainly held. */
export function stateWord(display: FrontDisplayState): string | null {
  if (display === "contested") {
    return translateText("world_page.legend_siege");
  }
  if (display === "quiet") return translateText("world_page.legend_quiet");
  return null;
}

/**
 * A front's last battles, oldest first: the holder's wins in their
 * colour, the nearest challenger's in theirs, anyone else's in slate, and
 * a battle without a winner struck through. Its label gives the counts.
 */
export function renderStrip(
  view: WorldView,
  theatre: WorldTheatre,
  model: WorldModel,
) {
  if (theatre.window.length === 0) return nothing;
  const { holder, challenger } = theatre;
  // Counted from the cells themselves, so the label always matches them.
  let holderWins = 0;
  let challengerWins = 0;
  let others = 0;
  let none = 0;
  for (const battle of theatre.window) {
    if (battle.winner === null) none += 1;
    else if (battle.winner === holder) holderWins += 1;
    else if (battle.winner === challenger) challengerWins += 1;
    else others += 1;
  }
  const counts: string[] = [];
  if (holder !== null) {
    counts.push(
      translateText("world_page.strip_wins", {
        name: view.label(holder),
        count: holderWins,
      }),
    );
  }
  if (challenger !== null) {
    counts.push(
      translateText("world_page.strip_wins", {
        name: view.label(challenger),
        count: challengerWins,
      }),
    );
  }
  if (others > 0) {
    counts.push(translateText("world_page.strip_others", { count: others }));
  }
  if (none > 0) {
    counts.push(translateText("world_page.strip_none", { count: none }));
  }
  const empty = Math.max(0, model.windowSize - theatre.window.length);
  return html`<span
    class="wp-strip"
    role="img"
    aria-label=${translateText("world_page.strip_aria", {
      count: theatre.window.length,
      summary: view.list(counts),
    })}
    style="--cells:${Math.max(model.windowSize, theatre.window.length)}"
  >
    ${Array.from({ length: empty }, () => html`<i class="wp-strip-empty"></i>`)}
    ${theatre.window.map((battle) => {
      if (battle.winner === null) return html`<i class="wp-strip-none"></i>`;
      if (battle.winner !== holder && battle.winner !== challenger) {
        return html`<i class="wp-strip-other"></i>`;
      }
      return html`<i style="--cell:${view.bannerColor(battle.winner)}"></i>`;
    })}
  </span>`;
}
