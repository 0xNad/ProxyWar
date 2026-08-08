import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { GameMap, GameMapImpl, TileRef } from "../../src/core/game/GameMap";
import { genTerrainFromBin } from "../../src/core/game/TerrainMapLoader";
import {
  buildLandPrefixIndex,
  buildSpawnCandidates,
  localLandRatioFromIndex,
} from "../../src/server/agents/LegalActionBuilder";

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

/**
 * Independent brute-force O(radius^2) oracle for `localLandRatioFromIndex`.
 * Deliberately does not share any code with the production implementation
 * (or with `buildLandPrefixIndex`'s prefix-sum math) so this test can't pass
 * by exercising a bug the two share. This is the exact algorithm production
 * used before the 2026-08-08 O(radius) optimization.
 */
function localLandRatioBruteForce(
  gameMap: GameMap,
  tile: TileRef,
  radius: number,
): number {
  const centerX = gameMap.x(tile);
  const centerY = gameMap.y(tile);
  const radiusSquared = radius * radius;
  let land = 0;
  let total = 0;
  for (
    let y = Math.max(0, centerY - radius);
    y <= Math.min(gameMap.height() - 1, centerY + radius);
    y += 1
  ) {
    for (
      let x = Math.max(0, centerX - radius);
      x <= Math.min(gameMap.width() - 1, centerX + radius);
      x += 1
    ) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy > radiusSquared) {
        continue;
      }
      total += 1;
      if (gameMap.isLand(gameMap.ref(x, y))) {
        land += 1;
      }
    }
  }
  return total === 0 ? 0 : land / total;
}

/**
 * Mirrors `buildSpawnCandidates`'s private `defaultLocalLandRadius` formula
 * (~9.6% of the map's shorter dimension, floored at 16). Kept as an
 * independent, test-local computation rather than importing the production
 * helper - `defaultLocalLandRadius` is internal to `buildSpawnCandidates`
 * and this test only needs to reproduce its value, not exercise it
 * directly.
 */
function expectedLocalLandRadius(gameMap: GameMap): number {
  return Math.max(
    16,
    Math.round(Math.min(gameMap.width(), gameMap.height()) * 0.096),
  );
}

/** Wraps a `GameMap` in a `Proxy` that counts `isLand` calls without
 * changing behavior, so a test can assert the *shape* of an algorithm
 * (O(width*height) vs. O(candidates*radius^2)) without a flaky wall-clock
 * threshold. */
function withIsLandCounter(map: GameMap): {
  map: GameMap;
  calls: () => number;
} {
  let count = 0;
  const proxy = new Proxy(map, {
    get(target, prop, receiver) {
      if (prop === "isLand") {
        return (ref: number) => {
          count += 1;
          return target.isLand(ref);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { map: proxy, calls: () => count };
}

describe("localLandRatioFromIndex equivalence with the brute-force reference", () => {
  it("agrees on every tile of small fixture maps across several radii", async () => {
    const radii = [0, 1, 2, 3, 5, 8, 16];
    for (const name of ["plains", "half_land_half_ocean", "ocean_and_land"]) {
      const map = await loadFixtureMap(name);
      const index = buildLandPrefixIndex(map);
      for (const radius of radii) {
        map.forEachTile((tile) => {
          const x = map.x(tile);
          const y = map.y(tile);
          expect(localLandRatioFromIndex(index, x, y, radius)).toBe(
            localLandRatioBruteForce(map, tile, radius),
          );
        });
      }
    }
  });

  it("agrees on a dense sample of world tiles, including the production radius formula", async () => {
    const map = await loadFixtureMap("world");
    const index = buildLandPrefixIndex(map);
    const radii = [1, 16, expectedLocalLandRadius(map)];
    let checked = 0;
    map.forEachTile((tile) => {
      if (tile % 4001 !== 0) {
        return;
      }
      const x = map.x(tile);
      const y = map.y(tile);
      for (const radius of radii) {
        checked++;
        expect(localLandRatioFromIndex(index, x, y, radius)).toBe(
          localLandRatioBruteForce(map, tile, radius),
        );
      }
    });
    expect(checked).toBeGreaterThan(300);
  });

  it("clips at every map edge and corner exactly like the brute-force reference, on mixed land/water terrain", () => {
    // 24x20 checkerboard-ish stripes (not uniform land) so a land-count bug
    // in either the row half-width or the prefix range-sum would change the
    // ratio, not just the total.
    const width = 24;
    const height = 20;
    const terrain = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const isLand = (x + y) % 3 !== 0;
        terrain[y * width + x] = isLand ? 1 << 7 : 0;
      }
    }
    const map = new GameMapImpl(width, height, terrain, width * height);
    const index = buildLandPrefixIndex(map);
    // Radius bigger than half the shorter dimension forces heavy clipping
    // on every corner/edge probe below.
    const radius = 15;

    const probes: Array<[number, number]> = [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
      [Math.floor(width / 2), 0],
      [0, Math.floor(height / 2)],
      [Math.floor(width / 2), Math.floor(height / 2)],
    ];
    for (const [x, y] of probes) {
      const tile = map.ref(x, y);
      const fast = localLandRatioFromIndex(index, x, y, radius);
      const reference = localLandRatioBruteForce(map, tile, radius);
      expect(fast).toBe(reference);
    }

    // Hand-verified corner case: at (0,0) with radius 15 on a 24x20 map,
    // the disk clips to x in [0,15], y in [0,15] intersected with the
    // circle - independently recompute land/total by brute iteration here
    // (deliberately not reusing either implementation's loop shape) so a
    // shared bug in both implementations can't hide behind this assertion.
    let land = 0;
    let total = 0;
    for (let y = 0; y <= Math.min(height - 1, radius); y++) {
      for (let x = 0; x <= Math.min(width - 1, radius); x++) {
        if (x * x + y * y > radius * radius) {
          continue;
        }
        total++;
        if ((x + y) % 3 !== 0) {
          land++;
        }
      }
    }
    expect(localLandRatioFromIndex(index, 0, 0, radius)).toBe(land / total);
  });
});

describe("buildSpawnCandidates wiring", () => {
  it("every returned candidate's localLandScore matches the independent brute-force reference", async () => {
    const map = await loadFixtureMap("half_land_half_ocean");
    const radius = expectedLocalLandRadius(map);
    const candidates = buildSpawnCandidates(map, {
      maxCandidates: 10_000,
      stride: 1,
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.localLandScore).toBe(
        localLandRatioBruteForce(map, candidate.tile, radius),
      );
    }
  });

  it("produces the same candidate pool and scores on repeated calls (deterministic)", async () => {
    const map = await loadFixtureMap("plains");
    const first = buildSpawnCandidates(map, { maxCandidates: 5_000 });
    const second = buildSpawnCandidates(map, { maxCandidates: 5_000 });
    expect(second).toEqual(first);
  });

  it("scans isLand O(width*height) - not O(candidates*radius^2) - regardless of map size", async () => {
    const map = await loadFixtureMap("plains"); // 100x100, all land, radius=16
    const { map: counted, calls } = withIsLandCounter(map);

    const candidates = buildSpawnCandidates(counted, {
      maxCandidates: 100_000,
      stride: 1,
    });
    const width = map.width();
    const height = map.height();
    const area = width * height;

    // The O(width*height) index build plus the outer per-tile isLand/
    // isValidSpawnSite filters are all bounded by a small constant multiple
    // of the map area. A regression that reintroduces a per-candidate
    // O(radius^2) brute-force scan (radius=16 here) would add roughly
    // candidates * pi*16^2 ~= candidates * 800 extra isLand calls - for the
    // ~9k land candidates on this fixture that is several million more
    // calls, blowing past this bound by well over an order of magnitude.
    expect(candidates.length).toBeGreaterThan(1_000);
    expect(calls()).toBeLessThan(area * 100);
  });
});
