import type { SyntheticCrowdActivityCurve } from "./SyntheticCrowdTypes";

/**
 * Density multiplier for one released frame at `matchProgress` (0 = match
 * start, 1 = match end). Multiplied against `activityProbability` to get a
 * bot's actual per-frame trade-attempt chance. Every curve averages to a
 * density of exactly 1 over the whole match, so `activityProbability`
 * keeps its meaning as the base rate regardless of curve choice.
 */
export function syntheticCrowdActivityDensity(
  curve: SyntheticCrowdActivityCurve,
  matchProgress: number,
): number {
  const p = Math.min(1, Math.max(0, matchProgress));
  if (curve === "steady") return 1;
  if (curve === "early-heavy") return 2 * (1 - p);
  if (curve === "late-heavy") return 2 * p;
  // "u-shaped": bathtub — density(p) = 1 + 6*((0.5-p)^2 - 1/12). Peaks at
  // 2x at both ends (p=0 or p=1), dips to 0.5x mid-match (p=0.5), and
  // integrates to exactly 1 over [0,1] (∫(0.5-p)^2 dp = 1/12) — early
  // birds plus a late pile-in, the shape a flat activity rate can never
  // produce.
  const centered = 0.5 - p;
  return 1 + 6 * (centered * centered - 1 / 12);
}
