/**
 * Logarithmic Market Scoring Rule (LMSR) pricing — pure, stateless functions
 * over an integer share vector `q` and a liquidity constant `b`. Ported from
 * the prior single-player market engine (`/tmp/markets-prior/engine/lmsr.ts`,
 * per Main's LMSR pivot) with the same numerically-stable log-sum-exp so a
 * given `(q, b)` always reprices identically.
 *
 * This client copy exists ONLY for a live quote preview — "if I spend N
 * chips, roughly how many shares and where does the price land" — computed
 * locally so the buy/sell ticket doesn't need a round trip per keystroke.
 * The server is the sole source of truth for what a trade actually executes
 * at; every trade response's `shares`/`chips`/`avgPrice` overrides whatever
 * this module predicted. Money is quantised to integer chips at the moment
 * of a trade (`roundChips` in `marketMath.ts`), never here — these
 * intermediate floats never touch the ledger directly.
 */

function logSumExp(q: readonly number[], b: number): number {
  let max = -Infinity;
  for (const qi of q) {
    const v = qi / b;
    if (v > max) max = v;
  }
  if (!isFinite(max)) return 0;
  let sum = 0;
  for (const qi of q) {
    sum += Math.exp(qi / b - max);
  }
  return max + Math.log(sum);
}

/** LMSR cost function C(q) = b * ln( sum(exp(q_i / b)) ), in fractional chip-units. */
export function lmsrCost(q: readonly number[], b: number): number {
  return b * logSumExp(q, b);
}

/** Outcome probabilities (softmax of q/b). Sum to 1 within float epsilon. */
export function lmsrPrices(q: readonly number[], b: number): number[] {
  let max = -Infinity;
  for (const qi of q) {
    const v = qi / b;
    if (v > max) max = v;
  }
  const exps = q.map((qi) => Math.exp(qi / b - max));
  const sum = exps.reduce((a, c) => a + c, 0);
  if (sum === 0) {
    return q.map(() => 1 / q.length);
  }
  return exps.map((e) => e / sum);
}

/** Display price per outcome, 0..100 (= probability * 100). */
export function lmsrDisplayPrices(q: readonly number[], b: number): number[] {
  return lmsrPrices(q, b).map((p) => p * 100);
}

/**
 * Fractional-chip-unit cost to move `outcome` by `deltaShares` (positive =
 * buy, negative = sell). Positive return = chips the trader pays; negative
 * = chips the trader receives. Scale by a share-payout constant (100) to
 * get real chips — see `marketMath.ts`.
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
