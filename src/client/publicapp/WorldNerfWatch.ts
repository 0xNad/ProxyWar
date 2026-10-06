import { html, nothing, type TemplateResult } from "lit";
import { translateText } from "../Utils";
import type {
  FormDay,
  FormModel,
  FrontierForm,
  WorldModel,
} from "./WorldModelSchema";
import {
  FORM_MIN_PLANS,
  FORM_MIN_TRAILING_BATTLES,
  latestFormDay,
  nonEmpty,
  scanWindowDays,
  trailingFailureRate,
  utcDay,
} from "./WorldSeason";
import { renderBuildCta } from "./WorldSeasonHero";
import {
  formatDecimal,
  formatLeagueDay,
  formatNumber,
  formatPercent,
} from "./WorldText";
import type { WorldView } from "./WorldView";

/**
 * "Nerf Watch": did a model change, or was it a bad day? One card per
 * model sets its latest day on the battlefield against its own trailing
 * record, with the chance of a day that bad at its usual win rate, and its
 * planner telemetry — think time, answer length, failed plans — against
 * the week before. Read from `frontier-form.json`; a battlefield result is
 * only ever called luck or not, and a telemetry shift is called by what it
 * is (slower, longer answers), never "nerfed" or "weaker". Every sentence
 * is built here from the file's numbers, so it is translated like the rest
 * of the page; the publisher's own English `sentence` is not shown.
 */

/** Literal keys, so the translation check sees every one. */
const VERDICT_KEYS: Record<NonNullable<FormModelVerdict>, string> = {
  normal: "world_page.form_tag_normal",
  slower: "world_page.form_tag_slower",
  faster: "world_page.form_tag_faster",
  wordier: "world_page.form_tag_wordier",
  terser: "world_page.form_tag_terser",
  flakier: "world_page.form_tag_flakier",
  too_few: "world_page.form_tag_too_few",
};
type FormModelVerdict = NonNullable<FormModel["today"]>["verdictKind"];

/** The world's roster order, then any model only the form file knows. */
function orderedModels(form: FrontierForm, model: WorldModel): FormModel[] {
  const order = model.teams?.map((team) => team.label) ?? [];
  const rank = (label: string) => {
    const index = order.indexOf(label);
    return index === -1 ? order.length : index;
  };
  return [...form.models].sort(
    (a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label),
  );
}

export function renderNerfWatch(
  view: WorldView,
  form: FrontierForm | null,
): TemplateResult | typeof nothing {
  if (form === null || form.models.length === 0) return nothing;
  const cta = renderBuildCta(view);
  return html`<section
    class="wp-wrap wp-section"
    aria-labelledby="wp-form-title"
  >
    <div class="wp-section-head">
      <h2 id="wp-form-title" class="wp-section-title">
        ${translateText("world_page.form_title")}
      </h2>
      <p class="wp-section-intro">${translateText("world_page.form_intro")}</p>
    </div>
    <p class="wp-form-method">${translateText("world_page.form_method")}</p>
    <ul class="wp-form-cards" role="list">
      ${orderedModels(form, view.model).map((entry) => renderCard(view, entry))}
    </ul>
    <p class="wp-data-note">
      ${translateText("world_page.form_as_of", {
        age: view.age(form.generatedAt),
      })}
    </p>
    ${cta ?? nothing}
  </section>`;
}

function renderCard(view: WorldView, entry: FormModel) {
  const name = nonEmpty(entry.displayName) ?? view.label(entry.label);
  const provider = nonEmpty(entry.provider) ?? view.provider(entry.label);
  const day = latestFormDay(entry);
  // "Thinking as usual" only when the publisher had enough plans to check.
  const kind = entry.today?.verdictKind ?? null;
  const verdict =
    kind === "normal" && (day?.plans ?? 0) < FORM_MIN_PLANS ? null : kind;
  return html`<li
    class="wp-form-card"
    style="--banner:${view.bannerColor(entry.label)}"
  >
    <div class="wp-form-head">
      <h3 class="wp-form-name">${name}</h3>
      ${provider === null
        ? nothing
        : html`<span class="wp-form-provider">${provider}</span>`}
      ${verdict === null
        ? nothing
        : html`<span class="wp-form-tag" data-kind=${verdict}
            >${translateText(VERDICT_KEYS[verdict])}</span
          >`}
    </div>
    <p class="wp-form-day">${dayLine(view, day)}</p>
    <p class="wp-form-chance">${chanceSentence(entry, day)}</p>
    ${renderScan(view, entry, day)}
  </li>`;
}

/** "Today" for the visitor's UTC today, else the league day ("Oct 5"). */
function dayName(view: WorldView, day: string): string {
  return day === utcDay(view.now)
    ? translateText("world_page.day_today")
    : formatLeagueDay(day);
}

/** "Today: 1 win in 2 battles, 31% of the land on average." */
function dayLine(view: WorldView, day: FormDay | null): string {
  if (day === null) return translateText("world_page.form_no_battles");
  const params = {
    day: dayName(view, day.day),
    wins: day.wins,
    battles: day.battles,
  };
  return day.meanLandShare === null
    ? translateText("world_page.form_day_no_share", params)
    : translateText("world_page.form_day", {
        ...params,
        share: formatPercent(day.meanLandShare),
      });
}

/**
 * The day's result against the model's usual win rate: at or above it, or
 * how often a day this bad or worse happens anyway (the publisher's
 * binomial chance), or that the record is too short to tell.
 */
function chanceSentence(entry: FormModel, day: FormDay | null): string {
  const trailing = entry.trailing ?? null;
  const winRate = trailing?.winRate ?? null;
  if (
    entry.today?.verdictKind === "too_few" ||
    trailing === null ||
    trailing.battles < FORM_MIN_TRAILING_BATTLES ||
    winRate === null
  ) {
    return translateText("world_page.form_chance_too_few", {
      count: trailing?.battles ?? 0,
      needed: FORM_MIN_TRAILING_BATTLES,
    });
  }
  if (day === null) return "";
  const rate = formatPercent(winRate);
  if (day.wins >= day.battles * winRate) {
    return translateText("world_page.form_chance_ordinary", { rate });
  }
  const chance = entry.today?.chanceOfResult ?? null;
  if (chance === null) return "";
  return chance < 0.01
    ? translateText("world_page.form_chance_rare", { rate })
    : translateText("world_page.form_chance", {
        rate,
        chance: formatPercent(chance),
      });
}

/**
 * The "brain scan": median think time per plan, median answer length and
 * failed plans on the day shown, each beside the days before it (the
 * publisher's speed window, a week). Length is in tokens as the model's
 * provider counted them, thinking included, so a model that reasons at
 * length reads long; the label says so.
 */
function renderScan(view: WorldView, entry: FormModel, day: FormDay | null) {
  const trailing = entry.trailing ?? null;
  if (day === null && trailing === null) return nothing;
  const seconds = (ms: number | null | undefined) =>
    ms === null || ms === undefined
      ? "—"
      : translateText("world_page.form_seconds", {
          value: formatDecimal(ms / 1000),
        });
  const tokens = (count: number | null | undefined) =>
    count === null || count === undefined ? "—" : formatNumber(count);
  const failedToday =
    day === null || day.plans === null || day.plans === 0
      ? "—"
      : translateText("world_page.form_failed", {
          failed: day.planFailures ?? 0,
          plans: day.plans,
        });
  const rate = trailingFailureRate(entry, day);
  const failedBefore = rate === null ? "—" : formatPercent(rate);
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    [
      translateText("world_page.form_scan_think"),
      seconds(day?.latencyMsMedian),
      seconds(trailing?.latencyMsMedian),
    ],
    [
      translateText("world_page.form_scan_tokens"),
      tokens(day?.outputTokensMedian),
      tokens(trailing?.outputTokensMedian),
    ],
    [translateText("world_page.form_scan_failed"), failedToday, failedBefore],
  ];
  return html`<table class="wp-form-scan">
    <caption>
      ${translateText("world_page.form_scan_title")}
    </caption>
    <thead>
      <tr>
        <td></td>
        <th scope="col">${day === null ? "—" : dayName(view, day.day)}</th>
        <th scope="col">
          ${translateText("world_page.form_scan_trailing", {
            days: scanWindowDays(entry),
          })}
        </th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(
        ([label, today, before]) =>
          html`<tr>
            <th scope="row">${label}</th>
            <td>${today}</td>
            <td>${before}</td>
          </tr>`,
      )}
    </tbody>
  </table>`;
}
