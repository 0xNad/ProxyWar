import { describe, expect, test } from "vitest";
import {
  computeCoverCrop,
  formatSharePercent,
  replayShareImageFileName,
  selectShareStandings,
  SHARE_IMAGE_STANDINGS_LIMIT,
  type ReplayShareStanding,
} from "../../src/client/ReplayShareImage";

const standing = (
  name: string,
  share: number,
  isAlive = true,
): ReplayShareStanding => ({ name, share, color: "#ff0000", isAlive });

describe("computeCoverCrop", () => {
  test("takes a centered square from a landscape viewport", () => {
    // A 1920x1080 window into a 1080x1080 image: the full height is kept and
    // the sides are trimmed evenly, so the map is never squashed or banded.
    const crop = computeCoverCrop(1920, 1080, 1080, 1080);
    expect(crop.sw).toBeCloseTo(1080, 6);
    expect(crop.sh).toBeCloseTo(1080, 6);
    expect(crop.sx).toBeCloseTo(420, 6);
    expect(crop.sy).toBeCloseTo(0, 6);
  });

  test("takes a centered square from a portrait viewport", () => {
    const crop = computeCoverCrop(800, 1400, 1080, 1080);
    expect(crop.sw).toBeCloseTo(800, 6);
    expect(crop.sh).toBeCloseTo(800, 6);
    expect(crop.sx).toBeCloseTo(0, 6);
    expect(crop.sy).toBeCloseTo(300, 6);
  });

  test("never crops a source that already matches the target aspect", () => {
    const crop = computeCoverCrop(1080, 1080, 1080, 1080);
    expect(crop).toEqual({ sx: 0, sy: 0, sw: 1080, sh: 1080 });
  });

  test("never selects a region larger than the source", () => {
    // A window smaller than the output must still yield an in-bounds source
    // rect, or drawImage silently samples transparent pixels beyond the edge.
    const crop = computeCoverCrop(300, 200, 1080, 1080);
    expect(crop.sw).toBeLessThanOrEqual(300);
    expect(crop.sh).toBeLessThanOrEqual(200);
    expect(crop.sx).toBeGreaterThanOrEqual(0);
    expect(crop.sy).toBeGreaterThanOrEqual(0);
    expect(crop.sx + crop.sw).toBeLessThanOrEqual(300);
    expect(crop.sy + crop.sh).toBeLessThanOrEqual(200);
  });

  test("rejects degenerate geometry instead of producing NaN", () => {
    expect(() => computeCoverCrop(0, 100, 1080, 1080)).toThrow();
    expect(() => computeCoverCrop(100, 100, 0, 1080)).toThrow();
  });
});

describe("selectShareStandings", () => {
  test("drops eliminated players and orders by territory", () => {
    const rows = selectShareStandings([
      standing("c", 0.1),
      standing("dead", 0.9, false),
      standing("a", 0.4),
      standing("b", 0.25),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  test("caps at the row limit", () => {
    const rows = selectShareStandings(
      Array.from({ length: 12 }, (_, i) => standing(`p${i}`, i / 100)),
    );
    expect(rows).toHaveLength(SHARE_IMAGE_STANDINGS_LIMIT);
    expect(rows[0].name).toBe("p11");
  });

  test("does not mutate the caller's array", () => {
    // The caller passes live standings derived from the GameView; sorting in
    // place would reorder whatever else is holding that array.
    const input = [standing("c", 0.1), standing("a", 0.4)];
    const before = input.map((r) => r.name);
    selectShareStandings(input);
    expect(input.map((r) => r.name)).toEqual(before);
  });

  test("handles an all-eliminated board", () => {
    expect(selectShareStandings([standing("x", 0.5, false)])).toEqual([]);
  });

  test("rejects a nonsensical limit", () => {
    expect(() => selectShareStandings([], 0)).toThrow();
    expect(() => selectShareStandings([], 1.5)).toThrow();
  });
});

describe("formatSharePercent", () => {
  test("keeps a decimal for small shares so early rows are distinguishable", () => {
    expect(formatSharePercent(0.032)).toBe("3.2%");
    expect(formatSharePercent(0.099)).toBe("9.9%");
  });

  test("rounds to whole numbers once the share is legible", () => {
    expect(formatSharePercent(0.256)).toBe("26%");
    expect(formatSharePercent(1)).toBe("100%");
  });

  test("never renders a real foothold as zero", () => {
    // Early in a 12-player match every share is a fraction of a percent.
    // Rounding them all to "0.0%" makes the image look broken rather than early.
    expect(formatSharePercent(0.0004)).toBe("<0.1%");
    expect(formatSharePercent(0.00099)).toBe("<0.1%");
    expect(formatSharePercent(0.001)).toBe("0.1%");
  });

  test("degrades safely on garbage input", () => {
    expect(formatSharePercent(Number.NaN)).toBe("0%");
    expect(formatSharePercent(-1)).toBe("0%");
    expect(formatSharePercent(0)).toBe("0%");
  });
});

describe("replayShareImageFileName", () => {
  test("carries the run and turn so saved files stay distinguishable", () => {
    expect(replayShareImageFileName("league-coworld-abc", 8004)).toBe(
      "proxywar-league-coworld-abc-turn-8004.png",
    );
  });

  test("strips path separators and shell-hostile characters", () => {
    const name = replayShareImageFileName("../../etc/pa ss;wd", 1);
    expect(name).not.toContain("/");
    expect(name).not.toContain(";");
    expect(name).not.toContain(" ");
    expect(name.endsWith(".png")).toBe(true);
  });

  test("clamps a negative or fractional turn", () => {
    expect(replayShareImageFileName("r", -5)).toContain("turn-0");
    expect(replayShareImageFileName("r", 12.7)).toContain("turn-12");
  });
});
