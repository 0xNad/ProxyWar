/**
 * Stateless LMSR market mechanics over a `ReplayPremiereMarket` snapshot,
 * ported from the prior engine's `market.ts` `Market` class. Restructured as
 * pure functions returning a new market object rather than a mutable class,
 * to match this codebase's snapshot-transition style (see
 * `ReplayPremiereInteractions.ts`'s `mutate()` pattern): every function here
 * takes a snapshot (+ a `ReplayPremiereLedger` it posts money through) and
 * returns the next snapshot. All concurrency/atomicity comes from the
 * caller running these inside one `mutate()` transaction — this module has
 * no state of its own.
 *
 * Money: buys/sells move integer credits through the shared ledger; the AMM
 * account absorbs LMSR's bounded rounding/subsidy so the ledger always
 * balances exactly (`ledger.total() === 0` always).
 */
import {
  REPLAY_PREMIERE_MARKET_AMM_ACCOUNT,
  type ReplayPremiereLedger,
} from "./ReplayPremiereLedger";
import { lmsrCostOfTrade, lmsrDisplayPrices } from "./ReplayPremiereLmsr";
import type {
  ReplayPremiereMarket,
  ReplayPremiereMarketFill,
  ReplayPremiereMarketPosition,
} from "./ReplayPremiereWageringTypes";

/** Credits paid out per winning share at settlement — an honest 1/probability multiplier. */
export const SHARE_PAYOUT = 100;

/**
 * LMSR liquidity constant, scaled to outcome count.
 *
 * Was `max(10, round(1.5*outcomeCount))` — b=10 for a typical 4-seat
 * match. At b=10 a single ~450cr trade (well inside the 500cr
 * max-stake ceiling, 50% of the 1,000cr starting bankroll) swung a fresh
 * 25/25/25/25 book past 50% in one fill — thin enough that one real
 * bettor could functionally set the price alone (the "whipsaws of 50%+"
 * finding).
 *
 * Now `max(20, round(5*outcomeCount))` — b=20 for 4 seats. Anchored to
 * the platform's own stake bounds (`ReplayPremiereMarketRules.ts`:
 * MIN_STAKE=10, maxStake=500 on a 1,000cr bankroll): a ~150cr "ordinary"
 * order (15% of bankroll, comfortably inside the min/max band, far from
 * either edge) moves the traded outcome ~5 points (25% -> ~30%, a real
 * but not violent move — see ReplayPremiereMarketLiquidity.test.ts). A
 * max-stake 500cr order moves it ~16 points (25% -> ~41%) — genuinely "a
 * lot" without a single order cornering the book. The synthetic crowd's
 * strengthened conviction (SyntheticCrowdPersonas.ts) still walks the
 * price a long way toward the truth over the course of a match despite
 * the calmer per-trade impact, because dozens of trades compound against
 * the same convex cost curve (SyntheticCrowdSimulator.test.ts).
 *
 * Scales linearly with outcome count, same shape as before, so a larger
 * field keeps comparable per-trade sensitivity: at n outcomes a buy on
 * one competes against n-1 other exp() terms instead of 3, so b must
 * grow with n to hold price impact roughly constant in percentage-point
 * terms as the field gets bigger.
 */
export function liquidityForOutcomeCount(outcomeCount: number): number {
  return Math.max(20, Math.round(5 * outcomeCount));
}

/** Deterministic round-half-up for non-negative credit amounts. */
function roundChips(value: number): number {
  return Math.floor(value + 0.5);
}

function outcomeIndex(market: ReplayPremiereMarket, seatId: string): number {
  return market.outcomeSeatIds.indexOf(seatId);
}

function holdingsOf(market: ReplayPremiereMarket, participantId: string): readonly number[] {
  return market.holdings[participantId] ?? market.outcomeSeatIds.map(() => 0);
}

function costBasisOf(market: ReplayPremiereMarket, participantId: string): readonly number[] {
  return market.costBasis[participantId] ?? market.outcomeSeatIds.map(() => 0);
}

export function computeMarketPrices(market: ReplayPremiereMarket): number[] {
  return lmsrDisplayPrices(market.q, market.b);
}

/** Credits a buy of `shares` on `outcomeIndex` would cost (>= 1 for >= 1 share). */
function buyCost(market: ReplayPremiereMarket, outcome: number, shares: number): number {
  const raw = SHARE_PAYOUT * lmsrCostOfTrade(market.q, market.b, outcome, shares);
  return Math.max(1, roundChips(raw));
}

/** Credits a sell of `shares` on `outcomeIndex` would return (>= 0). */
function sellProceeds(market: ReplayPremiereMarket, outcome: number, shares: number): number {
  const raw = -SHARE_PAYOUT * lmsrCostOfTrade(market.q, market.b, outcome, -shares);
  return Math.max(0, roundChips(raw));
}

export function sharesHeld(market: ReplayPremiereMarket, participantId: string, seatId: string): number {
  const outcome = outcomeIndex(market, seatId);
  if (outcome < 0) return 0;
  return holdingsOf(market, participantId)[outcome] ?? 0;
}

/**
 * Largest integer share count (>= 1) whose buy cost is <= `budget` credits.
 * Returns 0 if even a single share costs more than the budget. Cost is
 * convex-increasing in shares, so an upper bound is expanded then binary-searched.
 */
export function maxSharesForBudget(
  market: ReplayPremiereMarket,
  seatId: string,
  budget: number,
): number {
  const outcome = outcomeIndex(market, seatId);
  if (outcome < 0 || budget < buyCost(market, outcome, 1)) return 0;
  let hi = 1;
  while (buyCost(market, outcome, hi * 2) <= budget && hi < 1 << 26) hi *= 2;
  let lo = hi;
  hi *= 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (buyCost(market, outcome, mid) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Quotes a buy of exactly `shares` on `seatId`, without executing it. */
export function quoteBuy(
  market: ReplayPremiereMarket,
  seatId: string,
  shares: number,
): ReplayPremiereMarketFill {
  const outcome = outcomeIndex(market, seatId);
  const chips = buyCost(market, outcome, shares);
  const q2 = market.q.slice();
  q2[outcome] += shares;
  return {
    shares,
    chips,
    avgPrice: shares > 0 ? chips / shares : 0,
    pricesAfter: lmsrDisplayPrices(q2, market.b),
  };
}

/** Quotes a sell of exactly `shares` on `seatId`, without executing it. */
export function quoteSell(
  market: ReplayPremiereMarket,
  seatId: string,
  shares: number,
): ReplayPremiereMarketFill {
  const outcome = outcomeIndex(market, seatId);
  const chips = sellProceeds(market, outcome, shares);
  const q2 = market.q.slice();
  q2[outcome] -= shares;
  return {
    shares,
    chips,
    avgPrice: shares > 0 ? chips / shares : 0,
    pricesAfter: lmsrDisplayPrices(q2, market.b),
  };
}

/**
 * Executes a buy of exactly `shares` on `seatId`, posting the credit debit
 * through `ledger` and returning the next market snapshot. The caller must
 * have already validated affordability/stake limits/slippage — this is the
 * mechanical execution step, run inside the caller's single mutation.
 */
export function applyBuy(options: {
  readonly market: ReplayPremiereMarket;
  readonly ledger: ReplayPremiereLedger;
  readonly participantId: string;
  readonly seatId: string;
  readonly shares: number;
}): { readonly market: ReplayPremiereMarket; readonly chips: number } {
  const { market, ledger, participantId, seatId, shares } = options;
  const outcome = outcomeIndex(market, seatId);
  const chips = buyCost(market, outcome, shares);
  ledger.post([
    { account: participantId, delta: -chips },
    { account: REPLAY_PREMIERE_MARKET_AMM_ACCOUNT, delta: chips },
  ]);
  const q = market.q.slice();
  q[outcome] += shares;
  const holdings = holdingsOf(market, participantId).slice();
  holdings[outcome] += shares;
  const costBasis = costBasisOf(market, participantId).slice();
  costBasis[outcome] += chips;
  return {
    market: {
      ...market,
      q,
      holdings: { ...market.holdings, [participantId]: holdings },
      costBasis: { ...market.costBasis, [participantId]: costBasis },
    },
    chips,
  };
}

/**
 * Executes a sell of exactly `shares` on `seatId`, posting the credit
 * proceeds through `ledger` and returning the next market snapshot. The
 * caller must have already validated the holding/slippage.
 */
export function applySell(options: {
  readonly market: ReplayPremiereMarket;
  readonly ledger: ReplayPremiereLedger;
  readonly participantId: string;
  readonly seatId: string;
  readonly shares: number;
}): { readonly market: ReplayPremiereMarket; readonly chips: number } {
  const { market, ledger, participantId, seatId, shares } = options;
  const outcome = outcomeIndex(market, seatId);
  const chips = sellProceeds(market, outcome, shares);
  const heldBefore = holdingsOf(market, participantId)[outcome];
  const basisBefore = costBasisOf(market, participantId)[outcome];
  const basisReduction =
    heldBefore > 0 ? Math.round((basisBefore * shares) / heldBefore) : 0;
  ledger.post([
    { account: REPLAY_PREMIERE_MARKET_AMM_ACCOUNT, delta: -chips },
    { account: participantId, delta: chips },
  ]);
  const q = market.q.slice();
  q[outcome] -= shares;
  const holdings = holdingsOf(market, participantId).slice();
  holdings[outcome] -= shares;
  const costBasis = costBasisOf(market, participantId).slice();
  costBasis[outcome] = Math.max(0, costBasis[outcome] - basisReduction);
  return {
    market: {
      ...market,
      q,
      holdings: { ...market.holdings, [participantId]: holdings },
      costBasis: { ...market.costBasis, [participantId]: costBasis },
    },
    chips,
  };
}

/**
 * Every non-empty position a participant currently holds. While the market
 * is open, `currentValue` is the EXECUTABLE liquidation price: exactly
 * what an immediate full sell of the whole position would pay on this same
 * LMSR cost curve (`sellProceeds`, the same function every real sell fill
 * uses) — never the marginal per-share price, which overstates it since
 * selling moves price against the seller along the curve.
 *
 * Once `market.status === "settled"`, `currentValue` is instead the REAL
 * payout already posted to the ledger by `settleMarket` for that exact
 * holding: `shares * SHARE_PAYOUT` for the winning seat, `0` for a losing
 * one, or the full cost-basis refund on a void market — never
 * `sellProceeds`, which is meaningless once the market can no longer be
 * traded into. `settleMarket` deliberately leaves `holdings`/`q` untouched
 * at settlement specifically so this read keeps working forever after —
 * final shares, cost basis, and the real payout, from the server, for a
 * settlement card the client never has to recompute locally.
 */
export function positionsFor(
  market: ReplayPremiereMarket,
  participantId: string,
): ReplayPremiereMarketPosition[] {
  const holdings = holdingsOf(market, participantId);
  const costBasis = costBasisOf(market, participantId);
  const positions: ReplayPremiereMarketPosition[] = [];
  for (const [index, shares] of holdings.entries()) {
    if (shares <= 0) continue;
    const seatId = market.outcomeSeatIds[index];
    const currentValue =
      market.status === "settled"
        ? market.winnerSeatId === null
          ? costBasis[index]
          : seatId === market.winnerSeatId
            ? shares * SHARE_PAYOUT
            : 0
        : sellProceeds(market, index, shares);
    positions.push({
      seatId,
      shares,
      costBasis: costBasis[index],
      currentValue,
      unrealizedPnl: currentValue - costBasis[index],
    });
  }
  return positions;
}

/**
 * Settles the market once, at reveal. `winnerSeatId === null` voids the
 * market (the checkpoint resolution itself voided) — every holder is
 * refunded their cost basis rather than paid a per-share price, since there
 * is no valid winner to pay out to. Otherwise, winning shares pay
 * `SHARE_PAYOUT` credits each from the AMM account; losing shares are
 * simply worthless. Idempotent by construction: settling an already-settled
 * market is a caller-level no-op (see `ReplayPremiereInteractions`), never
 * re-executed here.
 *
 * `holdings` and `q` are deliberately left EXACTLY as they were the instant
 * before settlement — every position was already paid or refunded above
 * through the ledger (the actual money movement), not by zeroing shares.
 * No further order can ever be placed against a settled market (gated by
 * premiere lifecycle state in `submitMarketOrder`, independent of
 * holdings/q), so nothing can be double-spent by leaving them non-zero.
 * Keeping them intact is what lets `positionsFor` still serve an honest,
 * server-truth settlement read after the fact — final shares, cost basis,
 * and the real payout — instead of every participant's history vanishing
 * the instant the market settles.
 */
export function settleMarket(options: {
  readonly market: ReplayPremiereMarket;
  readonly ledger: ReplayPremiereLedger;
  readonly winnerSeatId: string | null;
}): ReplayPremiereMarket {
  const { market, ledger, winnerSeatId } = options;
  const winnerIndex = winnerSeatId === null ? -1 : outcomeIndex(market, winnerSeatId);
  for (const [participantId, holdings] of Object.entries(market.holdings)) {
    if (winnerIndex >= 0) {
      const winShares = holdings[winnerIndex] ?? 0;
      if (winShares > 0) {
        const payout = winShares * SHARE_PAYOUT;
        ledger.post([
          { account: REPLAY_PREMIERE_MARKET_AMM_ACCOUNT, delta: -payout },
          { account: participantId, delta: payout },
        ]);
      }
    } else {
      const costBasis = costBasisOf(market, participantId);
      const refund = costBasis.reduce((sum, value) => sum + value, 0);
      if (refund > 0) {
        ledger.post([
          { account: REPLAY_PREMIERE_MARKET_AMM_ACCOUNT, delta: -refund },
          { account: participantId, delta: refund },
        ]);
      }
    }
  }
  return {
    ...market,
    status: "settled",
    winnerSeatId,
  };
}
