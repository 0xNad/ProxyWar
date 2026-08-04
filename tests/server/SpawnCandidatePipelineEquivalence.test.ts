import fs from "fs";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { getSpawnTiles, isValidSpawnSite } from "../../src/core/execution/Util";
import { GameMap, GameMapImpl, TileRef } from "../../src/core/game/GameMap";
import { genTerrainFromBin } from "../../src/core/game/TerrainMapLoader";
import {
  buildSpawnCandidates,
  SpawnCandidate,
} from "../../src/server/agents/AgentLeagueMatch";

// The columnar spawn-candidate pipeline must be BYTE-IDENTICAL to the object
// pipeline it replaced (same tiles, same scores, same order): league spawn
// behavior and downstream determinism proofs depend on it. The reference
// implementation below is the pre-columnar pipeline copied verbatim from git
// history (getSpawnTiles filter, per-tile objects, object comparator,
// object spatial scouts, object pool selection).

interface RefBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

function refQuality(candidate: SpawnCandidate): number {
  const safetyScore = candidate.safetyScore;
  const middleSafetyBand = Math.max(0, 1 - Math.abs(safetyScore - 0.32) / 0.24);
  const lowSafetyPenalty =
    safetyScore < 0.18
      ? (0.18 - safetyScore) * 2.4 + 0.16
      : safetyScore < 0.23
        ? (0.23 - safetyScore) * 1.1
        : 0;
  return (
    candidate.opportunityScore * 0.32 +
    candidate.pressureScore * 0.18 +
    middleSafetyBand * 0.03 +
    (candidate.localLandScore ?? 0) * 0.5 +
    safetyScore * 0.25 +
    candidate.diplomacyScore * 0.28 -
    lowSafetyPenalty
  );
}

function refCompare(a: SpawnCandidate, b: SpawnCandidate): number {
  return (
    refQuality(b) - refQuality(a) ||
    b.opportunityScore - a.opportunityScore ||
    (b.localLandScore ?? 0) - (a.localLandScore ?? 0) ||
    a.tile - b.tile
  );
}

function refCoordinateBounds(
  candidates: readonly SpawnCandidate[],
): RefBounds | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let found = false;
  for (const candidate of candidates) {
    if (typeof candidate.x !== "number" || typeof candidate.y !== "number") {
      continue;
    }
    found = true;
    if (candidate.x < minX) minX = candidate.x;
    if (candidate.x > maxX) maxX = candidate.x;
    if (candidate.y < minY) minY = candidate.y;
    if (candidate.y > maxY) maxY = candidate.y;
  }
  if (!found) {
    return null;
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: Math.max(1, maxX - minX + 1),
    height: Math.max(1, maxY - minY + 1),
  };
}

function refSpatialScouts(
  candidates: readonly SpawnCandidate[],
  columns: number,
  rows: number,
): SpawnCandidate[] {
  const bounds = refCoordinateBounds(candidates);
  if (bounds === null || columns <= 0 || rows <= 0) {
    return [];
  }
  const bestByCell = new Map<string, SpawnCandidate>();
  for (const candidate of candidates) {
    if (typeof candidate.x !== "number" || typeof candidate.y !== "number") {
      continue;
    }
    const cellX = Math.max(
      0,
      Math.min(
        columns - 1,
        Math.floor(((candidate.x - bounds.minX) / bounds.width) * columns),
      ),
    );
    const cellY = Math.max(
      0,
      Math.min(
        rows - 1,
        Math.floor(((candidate.y - bounds.minY) / bounds.height) * rows),
      ),
    );
    const key = `${cellX}:${cellY}`;
    const current = bestByCell.get(key);
    if (current === undefined || refCompare(candidate, current) < 0) {
      bestByCell.set(key, candidate);
    }
  }
  return [...bestByCell.values()].sort(refCompare);
}

function refSelectPool(
  candidates: SpawnCandidate[],
  maxCandidates: number,
): SpawnCandidate[] {
  if (maxCandidates <= 0) {
    return [];
  }
  if (candidates.length <= maxCandidates) {
    return candidates.sort(refCompare);
  }
  const selected: SpawnCandidate[] = [];
  const selectedTiles = new Set<TileRef>();
  const addCandidate = (candidate: SpawnCandidate): void => {
    if (selected.length >= maxCandidates || selectedTiles.has(candidate.tile)) {
      return;
    }
    selected.push(candidate);
    selectedTiles.add(candidate.tile);
  };
  const qualitySorted = [...candidates].sort(refCompare);
  const coreTarget = Math.min(
    maxCandidates,
    Math.max(200, Math.floor(maxCandidates * 0.72)),
  );
  for (const candidate of qualitySorted) {
    if (selected.length >= coreTarget) {
      break;
    }
    addCandidate(candidate);
  }
  for (const candidate of refSpatialScouts(candidates, 24, 16)) {
    addCandidate(candidate);
  }
  for (const candidate of qualitySorted) {
    addCandidate(candidate);
  }
  return selected;
}

function refDeterministicFraction(value: number): number {
  const x = Math.sin(value * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function refBuildSpawnCandidates(
  gameMap: GameMap,
  options: { maxCandidates?: number; stride?: number } = {},
): SpawnCandidate[] {
  const maxCandidates = options.maxCandidates ?? 2_000;
  const stride = options.stride ?? 1;
  const centerX = (gameMap.width() - 1) / 2;
  const centerY = (gameMap.height() - 1) / 2;
  const maxCenterDistance = Math.max(
    1,
    Math.hypot(centerX, centerY),
    Math.hypot(gameMap.width() - 1 - centerX, gameMap.height() - 1 - centerY),
  );
  const maxEdgeDistance = Math.max(
    1,
    Math.min(gameMap.width(), gameMap.height()) / 2,
  );
  const candidates: SpawnCandidate[] = [];
  gameMap.forEachTile((tile) => {
    if (tile % stride !== 0) {
      return;
    }
    if (!gameMap.isLand(tile) || gameMap.isBorder(tile)) {
      return;
    }
    if (getSpawnTiles(gameMap, tile, true) === null) {
      return;
    }
    const x = gameMap.x(tile);
    const y = gameMap.y(tile);
    const centerDistance = Math.hypot(x - centerX, y - centerY);
    const edgeDistance = Math.min(
      x,
      y,
      gameMap.width() - 1 - x,
      gameMap.height() - 1 - y,
    );
    const pressureScore = 1 - centerDistance / maxCenterDistance;
    const safetyScore = centerDistance / maxCenterDistance;
    const diplomacyScore =
      1 -
      Math.abs(y - centerY) /
        Math.max(centerY, gameMap.height() - 1 - centerY, 1);
    const localLandScore = localLandRatioRef(
      gameMap,
      tile,
      Math.max(
        16,
        Math.round(Math.min(gameMap.width(), gameMap.height()) * 0.096),
      ),
    );
    const opportunityScore =
      edgeDistance / maxEdgeDistance + refDeterministicFraction(tile);
    candidates.push({
      tile,
      x,
      y,
      pressureScore,
      safetyScore,
      diplomacyScore,
      opportunityScore,
      localLandScore,
    });
  });
  return refSelectPool(candidates, maxCandidates);
}

function localLandRatioRef(
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

describe("spawn candidate pipeline equivalence", () => {
  let world: GameMap;
  let plains: GameMap;
  let halfAndHalf: GameMap;

  beforeAll(async () => {
    world = await loadFixtureMap("world");
    plains = await loadFixtureMap("plains");
    halfAndHalf = await loadFixtureMap("half_land_half_ocean");
  });

  // Synchronous, CPU-bound equivalence check over the full production
  // `world` map at production 12P settings (maxCandidates: 1000). Isolated
  // local measurement under the repo's required `npm run test:coverage`
  // (V8 coverage instrumentation, no sibling files, no shard contention)
  // put this case at 875s; the same GitHub Actions runner independently
  // showed ~3.1x its local CPU speed on another CPU-bound coverage case
  // (AgentLeagueMatch's runSpawnPhase: ~74s local vs ~253s on GH — see
  // PR #16 CI history). 875s * 3.1 ~= 2713s, so 3_000_000ms (50 min) is a
  // real expected-runtime budget with headroom, not an arbitrary raise —
  // the workload/assertions are unchanged; only this one case's declared
  // budget moved to match its actual, measured cost under coverage. The
  // sibling "scouts dominate a tiny pool" case below stays at 300_000ms —
  // its own maxCandidates:24/stride:9 workload is far smaller and was
  // never observed to approach that budget.
  it(
    "matches the object pipeline on world at production 12P settings",
    { timeout: 3_000_000 },
    () => {
      const expected = refBuildSpawnCandidates(world, {
        maxCandidates: 1000,
        stride: 2,
      });
      const actual = buildSpawnCandidates(world, {
        maxCandidates: 1000,
        stride: 2,
      });
      expect(actual.length).toBe(expected.length);
      expect(actual).toEqual(expected);
    },
  );

  it(
    "matches on world when scouts dominate a tiny pool",
    { timeout: 300_000 },
    () => {
      const expected = refBuildSpawnCandidates(world, {
        maxCandidates: 24,
        stride: 9,
      });
      const actual = buildSpawnCandidates(world, {
        maxCandidates: 24,
        stride: 9,
      });
      expect(actual).toEqual(expected);
    },
  );

  it("matches on plains in the small-pool branch (count <= max)", () => {
    const expected = refBuildSpawnCandidates(plains, { maxCandidates: 50000 });
    const actual = buildSpawnCandidates(plains, { maxCandidates: 50000 });
    expect(expected.length).toBeGreaterThan(0);
    expect(actual).toEqual(expected);
  });

  it("matches on the mixed land/ocean micro map", () => {
    const expected = refBuildSpawnCandidates(halfAndHalf, {
      maxCandidates: 6,
    });
    const actual = buildSpawnCandidates(halfAndHalf, { maxCandidates: 6 });
    expect(actual).toEqual(expected);
  });

  it("returns empty for maxCandidates <= 0", () => {
    expect(buildSpawnCandidates(plains, { maxCandidates: 0 })).toEqual([]);
  });
});

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
