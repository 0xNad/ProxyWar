import { getMapName, translateText } from "../Utils";
import type { WorldEvent, WorldTheatreId } from "./WorldModelSchema";
import { battlefieldKey } from "./WorldPresentation";

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
