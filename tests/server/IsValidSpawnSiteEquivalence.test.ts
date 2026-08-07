import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { getSpawnTiles, isValidSpawnSite } from "../../src/core/execution/Util";
import { GameMap, GameMapImpl } from "../../src/core/game/GameMap";
import { genTerrainFromBin } from "../../src/core/game/TerrainMapLoader";

async function loadFixtureMap(name: string): Promise<GameMap> {
  const base = path.join(__dirname, "..", "testdata", "maps", name);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(base, "manifest.json"), "utf8"),
  );
  return await genTerrainFromBin(
    manifest.map,
    fs.readFileSync(path.join(base, "map.bin")),
  );
}

describe("isValidSpawnSite equivalence with getSpawnTiles", () => {
  it("agrees on every tile of the small fixture maps", async () => {
    for (const name of ["plains", "half_land_half_ocean"]) {
      const map = await loadFixtureMap(name);
      map.forEachTile((tile) => {
        expect(isValidSpawnSite(map, tile)).toBe(
          getSpawnTiles(map, tile, true) !== null,
        );
      });
    }
  });

  it("agrees on a dense sample of world tiles", async () => {
    const map = await loadFixtureMap("world");
    let checked = 0;
    map.forEachTile((tile) => {
      if (tile % 37 !== 0) {
        return;
      }
      checked++;
      expect(isValidSpawnSite(map, tile)).toBe(
        getSpawnTiles(map, tile, true) !== null,
      );
    });
    expect(checked).toBeGreaterThan(10_000);
  });

  it("sees ownership: an owned tile inside the disk invalidates the site", () => {
    const width = 24;
    const height = 20;
    const terrain = new Uint8Array(width * height);
    terrain.fill(1 << 7); // all land
    const map = new GameMapImpl(width, height, terrain, width * height);
    const center = map.ref(12, 10);
    expect(isValidSpawnSite(map, center)).toBe(true);
    expect(getSpawnTiles(map, center, true)).not.toBeNull();
    // Own a tile at euclidean distance ~2 from the shifted center.
    const owned = map.ref(13, 11);
    map.setOwnerID(owned, 7);
    expect(getSpawnTiles(map, center, true)).toBeNull();
    expect(isValidSpawnSite(map, center)).toBe(false);
  });
});
