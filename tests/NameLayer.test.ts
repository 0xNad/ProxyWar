import {
  computeElementScale,
  computeLabelFontSizePx,
} from "../src/client/graphics/layers/NameLayer";

import { computeAllianceClipPath } from "../src/client/graphics/PlayerIcons";

describe("PlayerIcons", () => {
  describe("computeAllianceClipPath", () => {
    test("returns full visibility (20% top cut) when alliance time is at 100%", () => {
      const result = computeAllianceClipPath(1.0);
      // topCut = 20 + (1 - 1.0) * 80 * 0.78 = 20 + 0 = 20.00
      expect(result).toBe("inset(20.00% -2px 0 -2px)");
    });

    test("returns maximum cut (82.40% top cut) when alliance time is at 0%", () => {
      const result = computeAllianceClipPath(0.0);
      // topCut = 20 + (1 - 0.0) * 80 * 0.78 = 20 + 62.4 = 82.40
      expect(result).toBe("inset(82.40% -2px 0 -2px)");
    });

    test("returns 51.20% top cut when alliance time is at 50%", () => {
      const result = computeAllianceClipPath(0.5);
      // topCut = 20 + (1 - 0.5) * 80 * 0.78 = 20 + 31.2 = 51.20
      expect(result).toBe("inset(51.20% -2px 0 -2px)");
    });

    test("returns 27.80% top cut when alliance time is at 87.5%", () => {
      const result = computeAllianceClipPath(0.875);
      // topCut = 20 + (1 - 0.875) * 80 * 0.78 = 20 + 7.8 = 27.80
      expect(result).toBe("inset(27.80% -2px 0 -2px)");
    });

    test("returns 74.60% top cut when alliance time is at 12.5%", () => {
      const result = computeAllianceClipPath(0.125);
      // topCut = 20 + (1 - 0.125) * 80 * 0.78 = 20 + 54.6 = 74.60
      expect(result).toBe("inset(74.60% -2px 0 -2px)");
    });

    test("includes -2px horizontal overscan to prevent subpixel gaps", () => {
      const result = computeAllianceClipPath(0.5);
      expect(result).toContain("-2px");
      expect(result.match(/-2px/g)).toHaveLength(2); // Should appear twice (left and right)
    });
  });
});

describe("NameLayer label sizing (spec 01: territory-strength label sizing & collision rule)", () => {
  describe("computeLabelFontSizePx", () => {
    test("caps large territories to the viewport-relative ceiling (3.5% of shorter dimension), not territory value", () => {
      // Spec's own worked example: 1440x900 desktop (shorter dim 900) ->
      // ceiling ~31px cap-height, regardless of how large the territory is.
      const fontSize = computeLabelFontSizePx(200, 1, 900);
      expect(fontSize).toBe(31);
      // An even larger territory must NOT grow the label past the same ceiling.
      expect(computeLabelFontSizePx(5000, 1, 900)).toBe(31);
    });

    test("caps to a smaller ceiling on a narrow portrait viewport (390x844, shorter dim 390)", () => {
      const fontSize = computeLabelFontSizePx(200, 1, 390);
      expect(fontSize).toBe(13); // 390 * 0.035 = 13.65, floored
      expect(fontSize).toBeLessThan(computeLabelFontSizePx(200, 1, 900));
    });

    test("never renders below the legibility floor (11px) for a tiny territory", () => {
      expect(computeLabelFontSizePx(1, 1, 900)).toBe(11);
    });

    test("fits-to-shape (35% of territory screen size) when that lands between the floor and the ceiling", () => {
      // territoryScreenPx = 40, fit target = 40*0.35 = 14, within [11, 31.5].
      expect(computeLabelFontSizePx(40, 1, 900)).toBe(14);
    });

    test("divides the clamped on-screen target back down by the camera zoom scale, since the container applies scale() separately", () => {
      // Same on-screen target (28px, within the clamp range) reached via
      // double the baseSize at double the zoom -- the CSS px result must
      // land at half, so that container-level scale(2) reproduces the
      // correct final on-screen size.
      const atScale1 = computeLabelFontSizePx(28 / 0.35, 1, 900);
      const atScale2 = computeLabelFontSizePx(28 / 0.35 / 2, 2, 900);
      expect(atScale1).toBe(28);
      expect(atScale2).toBe(14);
    });
  });

  describe("computeElementScale", () => {
    test("clamps to the 0.6 floor for a tiny territory", () => {
      expect(computeElementScale(1)).toBe(0.6);
    });

    test("clamps to the 1.2 ceiling for a large territory, never the old 3x", () => {
      expect(computeElementScale(1000)).toBe(1.2);
    });

    test("scales linearly with baseSize inside the clamp range", () => {
      expect(computeElementScale(6)).toBeCloseTo(0.9, 5); // 6 * 0.15
    });
  });
});
