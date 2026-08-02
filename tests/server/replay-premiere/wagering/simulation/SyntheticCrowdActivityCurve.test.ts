import { describe, expect, it } from "vitest";
import { syntheticCrowdActivityDensity } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdActivityCurve";
import type { SyntheticCrowdActivityCurve } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdTypes";

function averageDensity(curve: SyntheticCrowdActivityCurve, steps: number): number {
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    sum += syntheticCrowdActivityDensity(curve, i / steps);
  }
  return sum / (steps + 1);
}

describe("syntheticCrowdActivityDensity", () => {
  it("steady is flat at 1 everywhere", () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      expect(syntheticCrowdActivityDensity("steady", p)).toBe(1);
    }
  });

  it("early-heavy is highest at match start and zero at match end", () => {
    expect(syntheticCrowdActivityDensity("early-heavy", 0)).toBeCloseTo(2, 5);
    expect(syntheticCrowdActivityDensity("early-heavy", 1)).toBeCloseTo(0, 5);
    expect(syntheticCrowdActivityDensity("early-heavy", 0.25)).toBeGreaterThan(
      syntheticCrowdActivityDensity("early-heavy", 0.75),
    );
  });

  it("late-heavy is zero at match start and highest at match end", () => {
    expect(syntheticCrowdActivityDensity("late-heavy", 0)).toBeCloseTo(0, 5);
    expect(syntheticCrowdActivityDensity("late-heavy", 1)).toBeCloseTo(2, 5);
    expect(syntheticCrowdActivityDensity("late-heavy", 0.75)).toBeGreaterThan(
      syntheticCrowdActivityDensity("late-heavy", 0.25),
    );
  });

  it("u-shaped peaks at both ends and dips in the middle — a real bathtub, not a flat walk", () => {
    const start = syntheticCrowdActivityDensity("u-shaped", 0);
    const middle = syntheticCrowdActivityDensity("u-shaped", 0.5);
    const end = syntheticCrowdActivityDensity("u-shaped", 1);
    expect(start).toBeGreaterThan(middle);
    expect(end).toBeGreaterThan(middle);
    expect(middle).toBeLessThan(1);
  });

  it("every curve averages to a density of 1 over the whole match, so activityProbability keeps its meaning", () => {
    for (const curve of ["steady", "early-heavy", "late-heavy", "u-shaped"] as const) {
      expect(averageDensity(curve, 2000)).toBeCloseTo(1, 2);
    }
  });

  it("clamps out-of-range progress to [0,1] instead of extrapolating", () => {
    expect(syntheticCrowdActivityDensity("late-heavy", -1)).toBe(
      syntheticCrowdActivityDensity("late-heavy", 0),
    );
    expect(syntheticCrowdActivityDensity("late-heavy", 2)).toBe(
      syntheticCrowdActivityDensity("late-heavy", 1),
    );
  });

  it("never returns a negative density", () => {
    for (const curve of ["steady", "early-heavy", "late-heavy", "u-shaped"] as const) {
      for (let p = 0; p <= 1; p += 0.05) {
        expect(syntheticCrowdActivityDensity(curve, p)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
