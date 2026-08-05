/**
 * Coverage for `computeSpectatorFitScale` — `TransformHandler.centerAll`'s
 * extracted, pure landing-scale computation (same pure-computation/thin-
 * caller split as `StatTimeSeriesChart.ts`'s `computeChartGeometry`),
 * unit-testable without constructing a real `TransformHandler` (which
 * needs a `GameView`/`HTMLCanvasElement`).
 *
 * P2 fix (found live 2026-08-02, an 844x390 landscape viewport): only a
 * PORTRAIT overzoom branch existed for a spectator viewport too far from
 * square for `cover` to apply — a landscape viewport in the same
 * situation fell all the way through to plain "contain", fitting to its
 * HEIGHT and wasting roughly half its WIDTH as side letterbox bands. The
 * fix adds a symmetric landscape branch; these tests pin both the
 * regression (a wasted-width scenario now overzooms) and that every
 * other landing shape (cover, portrait, live play) is unchanged.
 */
import { describe, expect, it } from "vitest";
import { computeSpectatorFitScale } from "../../../src/client/graphics/TransformHandler";

describe("computeSpectatorFitScale", () => {
  it("lands 'cover' (fills the viewport, no letterboxing) when the viewport and map aspect ratios are close — a typical desktop/tablet spectator viewport", () => {
    // Viewport 1200x800 (aspect 1.5), map 1000x700 (aspect ~1.43) —
    // deviation ~1.05, well inside the (0.5, 2) cover band.
    const result = computeSpectatorFitScale({
      vpWidth: 1200,
      vpHeight: 800,
      mapWidth: 1000,
      mapHeight: 700,
      fit: 1,
      spectator: true,
    });
    const rawScHor = 1200 / 1000;
    const rawScVer = 800 / 700;
    const coverScale = Math.max(rawScHor, rawScVer);
    expect(result.scale).toBeCloseTo(coverScale, 5);
    // Rendered map fills (or exceeds) the viewport on both axes.
    expect(1000 * result.scale).toBeGreaterThanOrEqual(1200 - 0.01);
    expect(700 * result.scale).toBeGreaterThanOrEqual(800 - 0.01);
  });

  it("REGRESSION (P2, 2026-08-02): an 844x390 landscape viewport against a roughly square map now overzooms to fill most of the width, instead of wasting ~55% of it on plain contain", () => {
    const vpWidth = 844;
    const vpHeight = 390;
    const mapWidth = 1000;
    const mapHeight = 1000; // square map: aspect deviation ~2.16, outside the (0.5,2) cover band
    const aspectRatioDeviation =
      vpWidth / vpHeight / (mapWidth / mapHeight);
    expect(aspectRatioDeviation).toBeGreaterThan(2); // confirms this case is NOT eligible for `cover`

    const result = computeSpectatorFitScale({
      vpWidth,
      vpHeight,
      mapWidth,
      mapHeight,
      fit: 0.95,
      spectator: true,
    });

    const renderedWidth = mapWidth * result.scale;
    const wastedWidthFraction = 1 - Math.min(renderedWidth, vpWidth) / vpWidth;
    // Before the fix: plain "contain" landed at containScale = vpHeight/mapHeight
    // = 0.39, rendering 390/844 ≈ 46% of the viewport's width (~54% wasted).
    // After the fix: the map now fills at least 70% of the viewport's width.
    expect(wastedWidthFraction).toBeLessThan(0.3);
    expect(renderedWidth / vpWidth).toBeGreaterThan(0.7);
  });

  it("never overzooms landscape past a true cover fit — clamped at coverScale", () => {
    // A very wide viewport (e.g. an ultrawide monitor) against a modest
    // map: cover would already be a huge zoom; the overzoom target must
    // never exceed it.
    const result = computeSpectatorFitScale({
      vpWidth: 3000,
      vpHeight: 400,
      mapWidth: 1000,
      mapHeight: 1000,
      fit: 1,
      spectator: true,
    });
    const coverScale = Math.max(3000 / 1000, 400 / 1000);
    expect(result.scale).toBeLessThanOrEqual(coverScale + 1e-9);
  });

  it("never overzooms landscape below a whole-map contain fit — clamped at containScale * fit", () => {
    // A landscape viewport barely wider than tall, against a map that's
    // ALREADY wider than the overzoom target would produce — contain
    // itself already exceeds the 0.75 fill target.
    const result = computeSpectatorFitScale({
      vpWidth: 850,
      vpHeight: 800,
      mapWidth: 400,
      mapHeight: 1000,
      fit: 1,
      spectator: true,
    });
    const containScale = Math.min(850 / 400, 800 / 1000);
    expect(result.scale).toBeGreaterThanOrEqual(containScale - 1e-9);
  });

  it("preserves the existing portrait overzoom behavior unchanged (P2-F10)", () => {
    // Viewport 390x844 (portrait phone), map 1000x700 (landscape map) —
    // deviation is far outside cover; the map would otherwise be fit to
    // the narrower WIDTH and waste most of the HEIGHT.
    const vpWidth = 390;
    const vpHeight = 844;
    const mapWidth = 1000;
    const mapHeight = 700;
    const result = computeSpectatorFitScale({
      vpWidth,
      vpHeight,
      mapWidth,
      mapHeight,
      fit: 0.95,
      spectator: true,
    });
    const rawScVer = vpHeight / mapHeight;
    const portraitTarget = rawScVer * 0.75;
    const containScale = Math.min(vpWidth / mapWidth, vpHeight / mapHeight);
    const coverScale = Math.max(vpWidth / mapWidth, vpHeight / mapHeight);
    const expected = Math.min(
      Math.max(containScale * 0.95, portraitTarget),
      coverScale,
    );
    expect(result.scale).toBeCloseTo(expected, 5);
  });

  it("lands plain 'contain' (never overzooms) when spectator is false — live play is untouched", () => {
    // Same wasteful-landscape shape as the regression case above, but with
    // spectator: false (live play) — must land at the plain whole-map
    // contain scale, no overzoom at all.
    const result = computeSpectatorFitScale({
      vpWidth: 844,
      vpHeight: 390,
      mapWidth: 1000,
      mapHeight: 1000,
      fit: 1,
      spectator: false,
    });
    const containScale = Math.min(844 / 1000, 390 / 1000);
    expect(result.scale).toBeCloseTo(containScale, 5);
  });

  it("returns fillScale (coverScale) and zoomFloor (containScale * 0.85) independent of the landing-shape branch taken", () => {
    const vpWidth = 844;
    const vpHeight = 390;
    const mapWidth = 1000;
    const mapHeight = 1000;
    const result = computeSpectatorFitScale({
      vpWidth,
      vpHeight,
      mapWidth,
      mapHeight,
      fit: 0.95,
      spectator: true,
    });
    const containScale = Math.min(vpWidth / mapWidth, vpHeight / mapHeight);
    const coverScale = Math.max(vpWidth / mapWidth, vpHeight / mapHeight);
    expect(result.fillScale).toBeCloseTo(coverScale, 5);
    expect(result.zoomFloor).toBeCloseTo(containScale * 0.85, 5);
  });
});
