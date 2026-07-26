/**
 * Logarithmic Market Scoring Rule (LMSR) pricing.
 *
 * Ported verbatim (same function names/signatures) from the prior single-player
 * client-side engine at `/tmp/markets-prior/engine/lmsr.ts` — see
 * `docs/2026-06-12-proxywar-writeup.md` context and the operator's LMSR-pivot
 * directive. This module is unchanged in spirit: pure, stateless functions over
 * an INTEGER share vector `q` and a liquidity constant `b`. Every price/cost is
 * re-derived from the current `q` (never accumulated), so there is no
 * floating-point drift across a checkpoint window: identical `q` always yields
 * identical numbers.
 *
 * Money charged to participants is integer chips (see the stateful market
 * built on top of this in ReplayPremiereInteractions.ts); the floating-point
 * values here are intermediate and must be quantised by the caller at the
 * moment of a trade — this module never rounds to an integer itself.
 *
 * Zero server coupling: no imports from ReplayPremiereInteractions or any
 * other premiere module, so this stays independently unit-testable and
 * cannot drift into the stateful concurrency machinery, mirroring the
 * pari-mutuel pricing module it replaces (ReplayPremiereWagerSettlement.ts).
 */

/** Numerically stable log-sum-exp of (q_i / b). Returns natural log. */
function logSumExp(q: readonly number[], b: number): number {
  let max = -Infinity;
  for (const qi of q) {
    const v = qi / b;
    if (v > max) {
      max = v;
    }
  }
  if (!isFinite(max)) {
    return 0;
  }
  let sum = 0;
  for (const qi of q) {
    sum += Math.exp(qi / b - max);
  }
  return max + Math.log(sum);
}

/** LMSR cost function C(q) = b * ln( Σ exp(q_i / b) ), in (fractional) chips. */
export function lmsrCost(q: readonly number[], b: number): number {
  return b * logSumExp(q, b);
}

/**
 * Outcome probabilities (softmax of q/b). Sum to 1 (within float epsilon).
 * Multiply by 100 for display odds/price.
 */
export function lmsrPrices(q: readonly number[], b: number): number[] {
  let max = -Infinity;
  for (const qi of q) {
    const v = qi / b;
    if (v > max) {
      max = v;
    }
  }
  const exps = q.map((qi) => Math.exp(qi / b - max));
  const sum = exps.reduce((a, c) => a + c, 0);
  if (sum === 0) {
    return q.map(() => 1 / q.length);
  }
  return exps.map((e) => e / sum);
}

/** Display price (0..100) per outcome. */
export function lmsrDisplayPrices(q: readonly number[], b: number): number[] {
  return lmsrPrices(q, b).map((p) => p * 100);
}

/**
 * Fractional-chip cost to change outcome `i` by `deltaShares` (positive = buy, negative =
 * sell). Positive return = chips the trader pays; negative = chips the trader receives.
 */
export function lmsrCostOfTrade(
  q: readonly number[],
  b: number,
  outcome: number,
  deltaShares: number,
): number {
  const before = lmsrCost(q, b);
  const q2 = q.slice();
  q2[outcome] += deltaShares;
  const after = lmsrCost(q2, b);
  return after - before;
}
