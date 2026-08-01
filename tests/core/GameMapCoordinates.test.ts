import { describe, expect, it } from "vitest";
import { GameMapImpl } from "../../src/core/game/GameMap";

// The coordinate accessors are pure row-major arithmetic (ref = y*width + x).
// These tests pin the exact contract the former refToX/refToY/yToRef lookup
// tables provided, on asymmetric dimensions so a width/height swap cannot pass.

function makeMap(width: number, height: number): GameMapImpl {
  const terrain = new Uint8Array(width * height);
  terrain.fill(1 << 7); // all land
  return new GameMapImpl(width, height, terrain, width * height);
}

describe("GameMapImpl coordinate arithmetic", () => {
  it("roundtrips ref(x,y) -> x()/y() across the whole grid", () => {
    const width = 7;
    const height = 4;
    const map = makeMap(width, height);
    let expectedRef = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const ref = map.ref(x, y);
        expect(ref).toBe(expectedRef);
        expect(map.x(ref)).toBe(x);
        expect(map.y(ref)).toBe(y);
        expectedRef++;
      }
    }
  });

  it("keeps isValidRef bounds semantics (0 <= ref < width*height)", () => {
    const map = makeMap(5, 3);
    expect(map.isValidRef(0)).toBe(true);
    expect(map.isValidRef(14)).toBe(true);
    expect(map.isValidRef(15)).toBe(false);
    expect(map.isValidRef(-1)).toBe(false);
  });

  it("throws on out-of-bounds ref(x,y) like before", () => {
    const map = makeMap(5, 3);
    expect(() => map.ref(5, 0)).toThrow();
    expect(() => map.ref(0, 3)).toThrow();
    expect(() => map.ref(-1, 0)).toThrow();
    expect(() => map.ref(0.5, 0)).toThrow();
  });

  it("computes neighbors from row-major refs at edges and interior", () => {
    const width = 5;
    const height = 3;
    const map = makeMap(width, height);
    // interior (2,1) = ref 7: all four neighbors
    expect(new Set(map.neighbors(map.ref(2, 1)))).toEqual(
      new Set([map.ref(2, 0), map.ref(2, 2), map.ref(1, 1), map.ref(3, 1)]),
    );
    // top-left corner (0,0): right + down only
    expect(new Set(map.neighbors(map.ref(0, 0)))).toEqual(
      new Set([map.ref(1, 0), map.ref(0, 1)]),
    );
    // bottom-right corner: left + up only
    expect(new Set(map.neighbors(map.ref(4, 2)))).toEqual(
      new Set([map.ref(3, 2), map.ref(4, 1)]),
    );
  });

  it("circleSearch enumerates the same tiles as brute-force distance check", () => {
    const width = 11;
    const height = 9;
    const map = makeMap(width, height);
    const center = map.ref(5, 4);
    const radius = 3;
    const got = map.circleSearch(center, radius);
    const expected = new Set<number>();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - 5;
        const dy = y - 4;
        if (dx * dx + dy * dy <= radius * radius) {
          expected.add(map.ref(x, y));
        }
      }
    }
    expect(got).toEqual(expected);
  });

  it("manhattan and euclidean distances stay coordinate-correct", () => {
    const map = makeMap(8, 6);
    const a = map.ref(1, 2);
    const b = map.ref(6, 5);
    expect(map.manhattanDist(a, b)).toBe(5 + 3);
    expect(map.euclideanDistSquared(a, b)).toBe(25 + 9);
  });
});
