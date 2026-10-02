import { getMapName } from "../Utils";
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
