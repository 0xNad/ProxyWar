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

function buildRowLandPrefix(gameMap: GameMap): Int32Array {
  const width = gameMap.width();
  const height = gameMap.height();
  const stride = width + 1;
  const prefix = new Int32Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    let running = 0;
    const base = y * stride;
    prefix[base] = 0;
    for (let x = 0; x < width; x += 1) {
      if (gameMap.isLand(gameMap.ref(x, y))) {
        running += 1;
      }
      prefix[base + x + 1] = running;
    }
  }
  return prefix;
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
  const rowLandPrefix = buildRowLandPrefix(gameMap);
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
      rowLandPrefix,
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

// Provably exact "largest integer r with r*r <= n" — the O(r) row-prefix
// rewrite below needs this to solve the disk-membership boundary
// analytically instead of the naive version's per-cell dx*dx+dy*dy<=r*r
// scan. `Math.floor(Math.sqrt(n))` alone cannot be trusted at the exact
// boundary (float rounding can be off by one for large n); the correction
// loop verifies/adjusts with pure integer multiplication, so this is
// exact, not approximate.
function exactIntegerSqrtFloor(n: number): number {
  if (n <= 0) {
    return 0;
  }
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) {
    r -= 1;
  }
  while ((r + 1) * (r + 1) <= n) {
    r += 1;
  }
  return r;
}

// Row-prefix rewrite of `localLandRatioRefNaive` below: for each row of
// the disk, the naive per-cell dx*dx+dy*dy<=r*r test is solved
// analytically for that row's exact [xStart,xEnd] land-tile span (dxMax
// via `exactIntegerSqrtFloor`), then that span's land count is read in
// O(1) from `rowLandPrefix` (a horizontal running land-count per row,
// built once per `refBuildSpawnCandidates` call via `buildRowLandPrefix`).
// land/total are sums of the exact same 0/1 indicator terms as the naive
// version, just reassociated by row instead of accumulated cell-by-cell —
// integer sums are exactly reorderable, so this returns the bit-identical
// land/total (and thus bit-identical IEEE-754 quotient) as
// `localLandRatioRefNaive`, O(r) per call instead of O(r^2). This was the
// dominant cost of the isolated 875s (measured) / ~2713s (projected GH)
// runtime that motivated the 3,000,000ms timeout below — see the
// `localLandRatioRef===localLandRatioRefNaive` contract test for the
// regression proof this rewrite is exact, not just fast.
function localLandRatioRef(
  gameMap: GameMap,
  tile: TileRef,
  radius: number,
  rowLandPrefix: Int32Array,
): number {
  const width = gameMap.width();
  const height = gameMap.height();
  const stride = width + 1;
  const centerX = gameMap.x(tile);
  const centerY = gameMap.y(tile);
  const radiusSquared = radius * radius;
  let land = 0;
  let total = 0;
  const yStart = Math.max(0, centerY - radius);
  const yEnd = Math.min(height - 1, centerY + radius);
  for (let y = yStart; y <= yEnd; y += 1) {
    const dy = y - centerY;
    const dxMax = exactIntegerSqrtFloor(radiusSquared - dy * dy);
    const xStart = Math.max(0, centerX - dxMax);
    const xEnd = Math.min(width - 1, centerX + dxMax);
    if (xEnd < xStart) {
      continue;
    }
    total += xEnd - xStart + 1;
    const base = y * stride;
    land += rowLandPrefix[base + xEnd + 1] - rowLandPrefix[base + xStart];
  }
  return total === 0 ? 0 : land / total;
}

// Original O(r^2) per-cell scan, kept verbatim (only renamed) as a
// private oracle for the contract test below — no longer called from
// `refBuildSpawnCandidates`, which is the entire point of the rewrite
// above.
function localLandRatioRefNaive(
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

  // Cheap, synchronous, decoupled from the full columnar-pipeline
  // equivalence checks below: proves the O(r) `localLandRatioRef` rewrite
  // is bit-identical to the original O(r^2) `localLandRatioRefNaive` scan
  // it replaced, across small maps and radii deliberately chosen to force
  // heavy edge/corner clamping (including radius far larger than the map
  // extent) — the exact boundary conditions the row-prefix analytic
  // rewrite (`exactIntegerSqrtFloor`) has to get exactly right, not just
  // approximately right.
  it("localLandRatioRef's O(r) row-prefix rewrite matches the naive O(r^2) scan exactly", () => {
    const mixedTerrain = new Uint8Array(9 * 7);
    for (let i = 0; i < mixedTerrain.length; i += 1) {
      mixedTerrain[i] = i % 3 === 0 ? 0 : 1 << 7; // ~2/3 land, 1/3 water
    }
    const allLandTerrain = new Uint8Array(4 * 4).fill(1 << 7);
    const maps = [
      new GameMapImpl(9, 7, mixedTerrain, mixedTerrain.length),
      new GameMapImpl(4, 4, allLandTerrain, allLandTerrain.length),
    ];
    for (const map of maps) {
      for (const radius of [1, 2, 5, 16, 100]) {
        const rowLandPrefix = buildRowLandPrefix(map);
        map.forEachTile((tile) => {
          if (!map.isLand(tile)) {
            return;
          }
          expect(localLandRatioRef(map, tile, radius, rowLandPrefix)).toBe(
            localLandRatioRefNaive(map, tile, radius),
          );
        });
      }
    }
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

  // Previously assumed "far below" its 300_000ms budget and left
  // untouched when the sibling 12P case's timeout was set (86e707f19) —
  // GH Actions actually measured this case at 623639ms in that same PR's
  // CI run (job 92113985755, PR #16), a real failure against the old
  // budget. Raised to 900_000ms (real measurement + ~44% headroom) rather
  // than left at the disproven "never observed" assumption. Not
  // reprofiled against the row-prefix optimization above yet — this
  // budget stays until a fresh isolated `npm run test:coverage`
  // measurement justifies changing it again, per this file's own
  // evidence-based timeout discipline.
  it(
    "matches on world when scouts dominate a tiny pool",
    { timeout: 900_000 },
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
