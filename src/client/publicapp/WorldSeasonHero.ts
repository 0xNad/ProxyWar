import { html, nothing, type TemplateResult } from "lit";
import { translateText } from "../Utils";
import type { WorldStanding, WorldVoice } from "./WorldModelSchema";
import { feedState } from "./WorldPresentation";
import {
  battleFront,
  orderedStandings,
  pickVoices,
  publicText,
  RECAP_NOTE_MAX_CHARS,
  scheduleStatus,
  utcClock,
  watchHrefOf,
  wholePublicText,
  type ScheduleStatus,
} from "./WorldSeason";
import {
  battlefieldName,
  formatList,
  formatPercent,
  formatWait,
  nameMarker,
  splice,
} from "./WorldText";
import type { WorldView } from "./WorldView";

/**
 * Season 2's part of `/world`'s first screen: when the next battle is, how
 * the latest one ended in the models' own words, what Season 1 came to,
 * and the way in for a builder. Each piece is absent when the world
 * carries no data for it, so a Season 1 or league world renders as before.
 */

/** The next battle in words, or null when there is no timetable to read. */
export function scheduleLine(
  status: ScheduleStatus | null,
  now: number,
): string | null {
  if (status === null) return null;
  switch (status.kind) {
    case "next":
      return translateText("world_page.schedule_next", {
        time: utcClock(status.at),
        wait: formatWait((Date.parse(status.at) - now) / 60_000),
      });
    case "due":
      return translateText("world_page.schedule_due", {
        time: utcClock(status.at),
      });
    case "times":
      return translateText("world_page.schedule_times", {
        times: formatList(status.times),
      });
  }
}

/**
 * The eyebrow's status for a scheduled world: the next battle, then the
 * last one's age. Battles come twice a day, so the hours between them are
 * a timetable, not a pause. Null when the world has no schedule.
 */
export function renderSchedule(view: WorldView): TemplateResult | null {
  const line = scheduleLine(
    scheduleStatus(view.model.schedule, view.now, view.model.lastBattleAt),
    view.now,
  );
  if (line === null) return null;
  const feed = feedState(view.model, view.now);
  return html`<span class="wp-feed"
    ><span class="wp-pill wp-pill-next">${line}</span>${feed.kind === "empty"
      ? nothing
      : html` <span
          >${translateText("world_page.feed_live", {
            age: view.age(feed.lastBattleAt),
          })}</span
        >`}</span
  >`;
}

/** Literal keys, so the translation check sees every one. */
const RESULT_KEYS = {
  conquest: "world_page.latest_won_conquest",
  points: "world_page.latest_won_points",
  pointsNoShare: "world_page.latest_won_points_no_share",
  plain: "world_page.latest_won",
  none: "world_page.latest_no_winner",
} as const;

/**
 * The latest battle: where and when, who won and how, the final order by
 * land, and two or three things the models said during it.
 */
export function renderLatestBattle(view: WorldView): TemplateResult | null {
  const battle = view.model.latestBattle;
  if (battle === undefined || battle === null) return null;
  const front = battleFront(view.model, battle);
  const frontName =
    front === null
      ? null
      : "id" in front
        ? view.frontName(front.id)
        : front.name;
  const map = battlefieldName(battle.map);
  const where =
    frontName === null
      ? map
      : frontName.toLowerCase() === map.toLowerCase()
        ? frontName
        : translateText("world_page.latest_where", { front: frontName, map });
  const standings = orderedStandings(battle.standings);
  const winner = battle.winnerLabel;
  const winnerShare =
    standings.find((standing) => standing.label === winner)?.landShare ?? null;
  const name = html`<b>${view.label(winner)}</b>`;
  const result =
    winner === null
      ? translateText(RESULT_KEYS.none)
      : battle.winType === "conquest"
        ? splice(RESULT_KEYS.conquest, { name: nameMarker(0) }, [name])
        : battle.winType === "points"
          ? winnerShare === null
            ? splice(RESULT_KEYS.pointsNoShare, { name: nameMarker(0) }, [name])
            : splice(
                RESULT_KEYS.points,
                { name: nameMarker(0), share: formatPercent(winnerShare) },
                [name],
              )
          : splice(RESULT_KEYS.plain, { name: nameMarker(0) }, [name]);
  const href = watchHrefOf(view.model, battle);
  const voices = pickVoices(battle.voices, winner);
  return html`<section class="wp-latest" aria-labelledby="wp-latest-title">
    <h2 id="wp-latest-title" class="wp-latest-title">
      <span>${translateText("world_page.latest_title")}</span>
      <span class="wp-latest-where">${where}</span>
      <time class="wp-latest-when" datetime=${battle.completedAt}
        >${view.age(battle.completedAt)}</time
      >
    </h2>
    <p class="wp-latest-result">
      ${result}
      ${href === null
        ? nothing
        : html`<a
            class="wp-latest-watch"
            href=${href}
            rel=${href.startsWith("/") ? nothing : "noopener"}
            >${translateText("world_page.latest_watch")}</a
          >`}
    </p>
    ${standings.length > 0
      ? html`<ol
          class="wp-standings"
          aria-label=${translateText("world_page.latest_standings_aria")}
        >
          ${standings.map((standing) => renderStanding(view, standing))}
        </ol>`
      : nothing}
    ${voices.length > 0
      ? html`<div class="wp-voices">
          <p class="wp-voices-title">
            ${translateText("world_page.voices_title")}
          </p>
          ${voices.map((voice) => renderVoice(view, voice))}
        </div>`
      : nothing}
  </section>`;
}

function renderStanding(view: WorldView, standing: WorldStanding) {
  const out = standing.isAlive === false;
  return html`<li
    class="wp-standing ${out ? "wp-standing-out" : ""}"
    style="--banner:${view.bannerColor(standing.label)}"
  >
    <i class="wp-standing-chip" aria-hidden="true"></i
    ><span class="wp-standing-name">${view.label(standing.label)}</span>
    <span class="wp-standing-share"
      >${out
        ? translateText("world_page.standing_out")
        : standing.landShare === null
          ? "—"
          : formatPercent(standing.landShare)}</span
    >
  </li>`;
}

function renderVoice(view: WorldView, voice: WorldVoice) {
  const by =
    voice.kind === "message" && voice.to
      ? translateText("world_page.voice_to", {
          name: view.label(voice.label),
          to: view.label(publicText(voice.to, 60)),
        })
      : voice.kind === "message"
        ? translateText("world_page.voice_message", {
            name: view.label(voice.label),
          })
        : translateText("world_page.voice_dispatch", {
            name: view.label(voice.label),
          });
  return html`<figure
    class="wp-voice"
    style="--banner:${view.bannerColor(voice.label)}"
  >
    <blockquote>
      ${translateText("world_page.voice_quote", { text: voice.text })}
    </blockquote>
    <figcaption>${by}</figcaption>
  </figure>`;
}

/**
 * "Season 1: Grok 4.7 won 25 of 37 battles, …", plus the publisher's one
 * plain sentence on what it showed, whole or not at all. No links: it is a
 * footnote.
 */
export function renderSeasonOneRecap(view: WorldView): TemplateResult | null {
  const recap = view.model.seasonOneRecap;
  if (recap === undefined || recap.battles === 0) return null;
  const results = Object.entries(recap.winsByLabel)
    .filter(([, wins]) => wins > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, wins], index) =>
      translateText(
        index === 0
          ? "world_page.season_one_first"
          : "world_page.season_one_wins",
        {
          name: view.label(label),
          count: wins,
          battles: recap.battles,
        },
      ),
    );
  // The publisher's note only says that a note belongs here; the words are
  // ours, translated like every other line on the page.
  const hasNote =
    wholePublicText(recap.note ?? "", RECAP_NOTE_MAX_CHARS) !== "";
  return html`<p class="wp-recap">
    ${results.length === 0
      ? translateText("world_page.season_one_none", {
          battles: recap.battles,
        })
      : translateText("world_page.season_one", {
          results: formatList(results),
        })}
    ${hasNote ? translateText("world_page.season_one_note") : nothing}
  </p>`;
}

/**
 * The way in for a builder: the models share one program with only the
 * model swapped, and anyone can start an agent of their own from the open
 * starter and test it on Softmax Observatory.
 */
export function renderBuildCta(view: WorldView): TemplateResult | null {
  const count = view.model.teams?.length ?? 0;
  if (count < 2) return null;
  return html`<p class="wp-cta">
    ${splice(
      "world_page.cta_build",
      { count, starter: nameMarker(0), observatory: nameMarker(1) },
      [
        html`<a href=${view.links.starter} rel="noopener"
          >${translateText("world_page.cta_starter")}</a
        >`,
        html`<a href=${view.links.observatory} rel="noopener"
          >${translateText("world_page.cta_observatory")}</a
        >`,
      ],
    )}
  </p>`;
}
