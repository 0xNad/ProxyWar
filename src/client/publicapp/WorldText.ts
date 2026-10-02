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

/** "Sep 28", or "Sep 28, 09:37 PM" with the time, in the page's language. */
export function formatDate(iso: string, withTime = false): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return new Intl.DateTimeFormat(pageLocale(), {
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(time));
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
  return new Intl.DateTimeFormat(pageLocale(), {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(time));
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
  return new Intl.DateTimeFormat(pageLocale(), {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(time));
}

/** A count in the page's language: "1,564". */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(pageLocale()).format(value);
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
