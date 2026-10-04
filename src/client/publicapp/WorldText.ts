import { html, nothing, type TemplateResult } from "lit";
import { getMapName, translateText } from "../Utils";
import { preciseAge } from "./HomePresentation";
import type { WorldEvent, WorldTheatreId } from "./WorldModelSchema";
import { battlefieldKey } from "./WorldPresentation";

/** The page's language, for `Intl` formatting. */
export function pageLocale(): string | undefined {
  return typeof document === "undefined"
    ? undefined
    : document.documentElement.lang || undefined;
}

/**
 * One `Intl.DateTimeFormat` per language and option set: building one is
 * far slower than using one, and a render formats hundreds of dates.
 */
const dateFormats = new Map<string, Intl.DateTimeFormat>();
function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = pageLocale();
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, options);
    dateFormats.set(key, format);
  }
  return format;
}

/** "Sep 28", or "Sep 28, 09:37 PM" with the time, in the page's language. */
export function formatDate(iso: string, withTime = false): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return dateFormat({
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(time));
}

/**
 * Two moments as a range in the page's language: "Sep 24 – 27", one date
 * when both fall on the same day, and years when they differ.
 */
export function formatDateRange(from: string, to: string): string {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const format = dateFormat({ month: "short", day: "numeric" });
  try {
    return format.formatRange(new Date(start), new Date(end));
  } catch {
    const first = format.format(new Date(start));
    const last = format.format(new Date(end));
    return first === last ? first : `${first} – ${last}`;
  }
}

/**
 * A league day ("2026-10-01", a UTC date) as "Oct 1" in any time zone:
 * formatting it as a moment in the visitor's zone would call it Oct 2 in
 * Auckland.
 */
export function formatLeagueDay(day: string): string {
  const time = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(time)) return "—";
  return dateFormat({ month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(time),
  );
}

/**
 * How long ago, the same on every world page: "just now", "57 min ago",
 * "1 h 21 min ago", "3 h ago", "2 days ago", then "on Sep 12".
 */
export function formatAge(iso: string, now: number): string {
  const age = preciseAge(iso, now);
  switch (age.key) {
    case "now":
      return translateText("home_page.age_now");
    case "minutes":
      return translateText("home_page.age_minutes", { count: age.minutes });
    case "hours_minutes":
      return translateText("home_page.age_hours_minutes", {
        hours: age.hours,
        minutes: age.minutes,
      });
    case "hours":
      return translateText("home_page.age_hours", { count: age.hours });
    case "days":
      return translateText("home_page.age_days", { count: age.days });
    case "date":
      return translateText("home_page.age_date", { date: formatDate(iso) });
  }
}

/** The time of day in the visitor's zone: "21:47" or "9:47 PM". */
export function formatTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return dateFormat({ hour: "numeric", minute: "2-digit" }).format(
    new Date(time),
  );
}

/** The visitor's calendar day of a moment, for grouping. */
export function localDay(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** A day heading in the visitor's zone: "Today", "Yesterday", "Tuesday, Sep 30". */
export function formatDayHeading(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const day = localDay(time);
  if (day === localDay(now)) return translateText("world_page.day_today");
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === localDay(yesterday.getTime())) {
    return translateText("world_page.day_yesterday");
  }
  return dateFormat({ weekday: "long", month: "short", day: "numeric" }).format(
    new Date(time),
  );
}

/** A count in the page's language: "1,564". */
const numberFormats = new Map<string, Intl.NumberFormat>();
export function formatNumber(value: number): string {
  const locale = pageLocale() ?? "";
  let format = numberFormats.get(locale);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale === "" ? undefined : locale);
    numberFormats.set(locale, format);
  }
  return format.format(value);
}

/** A list in the page's language: "Asia, Europe and Africa". */
export function formatList(items: readonly string[]): string {
  try {
    return new Intl.ListFormat(pageLocale(), {
      style: "long",
      type: "conjunction",
    }).format(items);
  } catch {
    return items.join(", ");
  }
}

/**
 * A battlefield's display name ("GiantWorldMap" → "Giant World Map"),
 * translated the same way everywhere a map is named; falls back to the raw
 * map name when no translation exists.
 */
export function battlefieldName(map: string): string {
  const translated = getMapName(map);
  return translated === null || translated === `map.${battlefieldKey(map)}`
    ? map
    : translated;
}

/**
 * The line above the headline: who fights over this map. The league's
 * world names its builders; the Frontier Four names its teams.
 */
export function contextLine(model: {
  readonly mode?: "league" | "frontier-four";
  readonly teams?: readonly { readonly label: string }[];
}): string {
  if (model.mode === "frontier-four" && (model.teams?.length ?? 0) > 0) {
    return translateText("home_page.context_frontier", {
      teams: formatList(model.teams!.map((team) => team.label)),
    });
  }
  return translateText("home_page.context");
}

/**
 * League strings with a Frontier Four twin. The twin says "team" where the
 * league says "agent" and drops "league", because in that mode the fronts
 * are held by four teams of one model each.
 */
export const FRONTIER_TWINS: Readonly<Record<string, string>> = {
  "home_page.rules_rule": "home_page.rules_rule_frontier",
  "home_page.rule_unclaimed": "home_page.rule_unclaimed_frontier",
  "home_page.rules_stats": "home_page.rules_stats_frontier",
  "home_page.data_as_of": "home_page.data_as_of_frontier",
  "home_page.support_empty": "home_page.support_empty_frontier",
  "home_page.verdict_tied_many": "home_page.verdict_tied_many_frontier",
  "home_page.support_tied": "home_page.support_tied_frontier",
  "home_page.support_tied_many": "home_page.support_tied_many_frontier",
  "home_page.support_scattered": "home_page.support_scattered_frontier",
  "world_page.rule_place_body": "world_page.rule_place_body_frontier",
  "world_page.rule_window_body": "world_page.rule_window_body_frontier",
  "world_page.data_note": "world_page.data_note_frontier",
  "world_page.fronts_intro": "world_page.fronts_intro_frontier",
  "world_page.map_label": "world_page.map_label_frontier",
  "world_page.powers_agent": "world_page.powers_agent_frontier",
  "world_page.sheet_days": "world_page.sheet_days_frontier",
  "world_page.sheet_days_ongoing": "world_page.sheet_days_ongoing_frontier",
  "world_page.front_unclaimed_body": "world_page.front_unclaimed_body_frontier",
};

/** The key to read for this world's mode: the Frontier Four twin where one exists. */
export function modeKey(
  model: { readonly mode?: "league" | "frontier-four" },
  key: string,
): string {
  return model.mode === "frontier-four" ? (FRONTIER_TWINS[key] ?? key) : key;
}

/** A front's name inside a sentence ("the Black Sea", "the Crown"). */
export function frontInText(id: WorldTheatreId): string {
  return translateText(`home_page.in_text_${id}`);
}

/** Event sentences per kind; `onMap` adds "on {map}". */
const EVENT_KEYS: Record<
  WorldEvent["kind"],
  { readonly plain: string; readonly onMap: string }
> = {
  conquest: {
    plain: "home_page.event_conquest",
    onMap: "home_page.event_conquest_on",
  },
  claim: { plain: "home_page.event_claim", onMap: "home_page.event_claim_on" },
  siege: { plain: "home_page.event_siege", onMap: "home_page.event_siege_on" },
  held: { plain: "home_page.event_held", onMap: "home_page.event_held_on" },
};

/** A hold whose last challenger's wins have aged out of the window. */
const HELD_UNOPPOSED_KEYS = {
  plain: "home_page.event_held_unopposed",
  onMap: "home_page.event_held_unopposed_on",
} as const;

/**
 * One league event as a sentence, for the front page's latest takeovers and
 * `/world`'s dispatches: "Auri took Oceania from CYAN HELLSTAR, 2 wins to
 * 1." "On {map}" is added only when the battle was not fought on the
 * front's namesake map. The caller supplies `agent`, so it can splice in a
 * styled name.
 */
export function eventSentence(
  event: WorldEvent,
  label: (name: string) => string,
): { readonly key: string; readonly params: Record<string, string | number> } {
  const onMap = battlefieldKey(event.map) !== event.theatreId.replace(/_/g, "");
  const keys =
    event.rival !== null || event.kind === "claim"
      ? EVENT_KEYS[event.kind]
      : event.kind === "held"
        ? HELD_UNOPPOSED_KEYS
        : EVENT_KEYS.claim;
  return {
    key: onMap ? keys.onMap : keys.plain,
    params: {
      front: frontInText(event.theatreId),
      map: battlefieldName(event.map),
      wins: event.agentWins,
      rival: event.rival === null ? "" : label(event.rival),
      rivalWins: event.rivalWins,
    },
  };
}

/** Invisible-separator markers for templates spliced into translated sentences. */
const NAME_MARKER_PATTERN = /\u2063(\d+)\u2063/;
export function nameMarker(index: number): string {
  return `\u2063${index}\u2063`;
}

/**
 * A translated sentence with templates (styled names, links) spliced in
 * where `nameMarker`s were passed as parameters, so translations keep full
 * control of word order.
 */
export function splice(
  key: string,
  params: Record<string, string | number>,
  parts: readonly TemplateResult[],
): TemplateResult {
  const pieces = translateText(key, params).split(NAME_MARKER_PATTERN);
  return html`${pieces.map((piece, index) =>
    index % 2 === 0 ? piece : (parts[Number(piece)] ?? nothing),
  )}`;
}

/** A list in the page's language whose items are templates (bold names, links). */
export function spliceList(items: readonly TemplateResult[]): TemplateResult {
  const pieces = formatList(items.map((_, index) => nameMarker(index))).split(
    NAME_MARKER_PATTERN,
  );
  return html`${pieces.map((piece, index) =>
    index % 2 === 0 ? piece : (items[Number(piece)] ?? nothing),
  )}`;
}
