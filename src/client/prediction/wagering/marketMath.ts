/**
 * Pure LMSR trade math for the client — draft-quote preview and display
 * formatting only. No I/O. The server is authoritative on what a trade
 * actually executes at (see `types.ts`'s `MarketState` doc); this module
 * exists so the trade ticket can show "about N shares for that many chips,
 * price moves to X" as the viewer types, and to derive a sane default
 * `limitPrice` to submit alongside the order — without a round trip per
 * keystroke.
 */
import { MIN_STAKE, type Credits } from "src/prediction/types";
import { lmsrCostOfTrade, lmsrDisplayPrices } from "./lmsr";
import type { MarketSeatOption, MarketState } from "./types";
import { SHARE_PAYOUT } from "./types";

/** Deterministic round-half-up for non-negative chip amounts. */
function roundChips(x: number): number {
  return Math.floor(x + 0.5);
}

/** Points of slippage cushion baked into a derived default `limitPrice`. */
const DEFAULT_LIMIT_CUSHION = 2;

export interface MarketRow {
  readonly seatId: string;
  readonly displayName: string;
  readonly price: number;
  readonly myShares: number;
  readonly myUnrealizedPnl: number | null;
}

/** One row per seat: current price + the viewer's own holding, if any. */
export function marketRows(
  seats: readonly MarketSeatOption[],
  market: MarketState,
): readonly MarketRow[] {
  return seats.map((seat) => {
    const position = market.positions?.find((p) => p.seatId === seat.seatId) ?? null;
    return {
      seatId: seat.seatId,
      displayName: seat.displayName,
      price: market.prices[seat.seatId] ?? 0,
      myShares: position?.shares ?? 0,
      myUnrealizedPnl: position?.unrealizedPnl ?? null,
    };
  });
}

export interface TradeQuote {
  readonly shares: number;
  readonly chips: Credits;
  readonly avgPrice: number;
  readonly pricesAfter: Readonly<Record<string, number>>;
  /** Suggested `limitPrice` to submit with the order (avgPrice + cushion for a buy, - for a sell). */
  readonly suggestedLimitPrice: number;
}

function outcomeIndexOf(market: MarketState, seatId: string): number {
  return market.outcomeSeatIds.indexOf(seatId);
}

/** Chips a buy of `shares` on `outcome` would cost right now (>= 1 for >= 1 share). */
function buyCost(market: MarketState, outcome: number, shares: number): number {
  const raw = SHARE_PAYOUT * lmsrCostOfTrade(market.q, market.b, outcome, shares);
  return Math.max(1, roundChips(raw));
}

/**
 * Chips a sell of `shares` on `outcome` would return right now (>= 1 for >=
 * 1 share — floored the SAME as `buyCost`, not at 0). A round trip (buy N,
 * immediately sell N back with no other market activity in between) must
 * net exactly 0 chips: both directions round the identical LMSR magnitude
 * with the identical `roundChips`, so the only place a mismatch could
 * creep in is the floor. On a long-shot outcome the true cost/return can
 * round to 0 before flooring; flooring the sell at 0 while the buy floors
 * at 1 would leak 1 chip per round trip, guaranteed, on any outcome cheap
 * enough to hit it — silently contradicting the platform's stated "no
 * house edge" guarantee. Flooring both at 1 keeps the guarantee true
 * everywhere: the AMM absorbs a symmetric bounded subsidy in both
 * directions instead of a one-sided one.
 */
function sellProceeds(market: MarketState, outcome: number, shares: number): number {
  const raw = -SHARE_PAYOUT * lmsrCostOfTrade(market.q, market.b, outcome, -shares);
  return Math.max(1, roundChips(raw));
}

function pricesAfterTrade(
  market: MarketState,
  outcome: number,
  deltaShares: number,
): Readonly<Record<string, number>> {
  const q2 = market.q.slice();
  q2[outcome] += deltaShares;
  const after = lmsrDisplayPrices(q2, market.b);
  const out: Record<string, number> = {};
  market.outcomeSeatIds.forEach((seatId, index) => {
    out[seatId] = after[index];
  });
  return out;
}

/**
 * The platform's flat `MIN_STAKE` (10cr) is a policy floor, not a promise
 * that 10cr buys anything — a single share can cost well over 10cr the
 * moment the book has moved off a fresh 25/25/25/25 open (LMSR price ~=
 * probability * SHARE_PAYOUT, so a seat sitting anywhere near its 25%
 * opening already prices its first share around 25cr). A preset amount
 * that can't buy even one whole share always trips `validateBuyDraft`'s
 * `zero-shares` rejection, so a STATIC minimum preset is a button that
 * looks actionable and reliably isn't. This returns what a whole share of
 * `seatId` actually costs RIGHT NOW, floored at the platform's own
 * absolute minimum — the number a quick-pick preset should show instead
 * of the flat constant.
 */
export function minTradeableStake(market: MarketState, seatId: string): Credits {
  const outcome = outcomeIndexOf(market, seatId);
  if (outcome < 0) return MIN_STAKE;
  return Math.max(MIN_STAKE, buyCost(market, outcome, 1));
}

/**
 * Largest integer share count (>= 1) whose buy cost is <= `budget` chips.
 * Returns 0 if even a single share costs more than the budget. Cost is
 * convex-increasing in shares, so expand an upper bound then binary-search
 * — mirrors the server's execution exactly so the preview and the actual
 * fill agree.
 */
export function maxSharesForBudget(
  market: MarketState,
  seatId: string,
  budget: Credits,
): number {
  const outcome = outcomeIndexOf(market, seatId);
  if (outcome < 0 || budget < buyCost(market, outcome, 1)) {
    return 0;
  }
  let hi = 1;
  while (buyCost(market, outcome, hi * 2) <= budget && hi < 1 << 26) {
    hi *= 2;
  }
  let lo = hi;
  hi *= 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (buyCost(market, outcome, mid) <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** Preview quote for spending `budget` chips buying `seatId`. */
export function quoteBuy(
  market: MarketState,
  seatId: string,
  budget: Credits,
): TradeQuote | null {
  const outcome = outcomeIndexOf(market, seatId);
  const shares = outcome < 0 ? 0 : maxSharesForBudget(market, seatId, budget);
  if (shares < 1) return null;
  const chips = buyCost(market, outcome, shares);
  const avgPrice = chips / shares;
  return {
    shares,
    chips,
    avgPrice,
    pricesAfter: pricesAfterTrade(market, outcome, shares),
    suggestedLimitPrice: Math.min(100, Math.ceil(avgPrice) + DEFAULT_LIMIT_CUSHION),
  };
}

/** Preview quote for selling `shares` of `seatId`. */
export function quoteSell(
  market: MarketState,
  seatId: string,
  shares: number,
): TradeQuote | null {
  const outcome = outcomeIndexOf(market, seatId);
  if (outcome < 0 || shares < 1) return null;
  const chips = sellProceeds(market, outcome, shares);
  const avgPrice = shares > 0 ? chips / shares : 0;
  return {
    shares,
    chips,
    avgPrice,
    pricesAfter: pricesAfterTrade(market, outcome, -shares),
    suggestedLimitPrice: Math.max(0, Math.floor(avgPrice) - DEFAULT_LIMIT_CUSHION),
  };
}
