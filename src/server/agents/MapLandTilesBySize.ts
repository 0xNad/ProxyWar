import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../Logger";

const log = logger.child({ component: "MapLandTilesBySize" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resourcesDir = path.join(__dirname, "../../../resources");

/**
 * Product overhaul spec Stage 6: real land-tile-count resolver for the
 * `AgentStatsPipeline.ts` territory-share denominator, honoring the
 * archived match's own `mapSize` — unlike `MapLandTiles.ts`'s
 * `getMapLandTiles` (used for live lobby-sizing, always the `Normal`/full
 * tier), a retained match can be either `Normal` or `Compact`, and using
 * the wrong tier's tile count would silently misreport every Compact
 * match's territory share. Picks the exact same manifest tier
 * `TerrainMapLoader.ts`'s own `loadTerrainMap` picks at live-game load
 * time: `manifest.map.num_land_tiles` for `Normal`,
 * `manifest.map4x.num_land_tiles` for `Compact`.
 *
 * Map NAME here is the mirror's own display string (`CoworldLeagueEpisodeRow.map`,
 * e.g. "Asia", "BlackSea") — resolved to a manifest directory by
 * lowercasing and stripping everything but `[a-z0-9]`, matching every
 * `resources/maps/<dir>/` directory name observed in this repo (verified:
 * `Bering Sea` -> `beringsea`, `Baikal (Nuke Wars)` -> `baikalnukewars`,
 * etc.). `resources/maps` is deleted in production Docker images
 * (`MapLandTiles.ts`'s own doc), so this is best-effort and MUST tolerate
 * a missing directory tree — the stats pipeline degrades to the
 * absolute-tiles/rank fallback rather than fabricating a denominator.
 */

const landTilesCache = new Map<string, number | null>();

function manifestDirName(mapDisplayName: string): string {
  return mapDisplayName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function getMapLandTilesBySize(
  mapDisplayName: string,
  mapSize: string,
): Promise<number | null> {
  const cacheKey = `${mapDisplayName}|${mapSize}`;
  const cached = landTilesCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = await resolve(mapDisplayName, mapSize);
  landTilesCache.set(cacheKey, result);
  return result;
}

async function resolve(
  mapDisplayName: string,
  mapSize: string,
): Promise<number | null> {
  try {
    const dir = manifestDirName(mapDisplayName);
    const raw = await fs.readFile(
      path.join(resourcesDir, "maps", dir, "manifest.json"),
      "utf8",
    );
    const manifest = JSON.parse(raw) as {
      map?: { num_land_tiles?: number };
      map4x?: { num_land_tiles?: number };
    };
    const tiles =
      mapSize === "Compact"
        ? manifest.map4x?.num_land_tiles
        : manifest.map?.num_land_tiles;
    if (typeof tiles !== "number" || !Number.isFinite(tiles) || tiles <= 0) {
      return null;
    }
    return tiles;
  } catch (error) {
    log.debug(
      `land-tile manifest unresolved for map=${mapDisplayName} size=${mapSize}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
