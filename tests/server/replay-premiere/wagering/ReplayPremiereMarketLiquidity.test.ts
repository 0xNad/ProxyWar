/**
 * LMSR liquidity (`b`) sizing. Two testers converged on the same finding
 * from opposite directions: Quant found b=10 let a single ordinary order
 * whipsaw a fresh 4-seat book by 50%+ in one fill; Grinder separately
 * exploited the flip side — a market that consequently never moved off its
 * 25/25/25/25 priors carries free information a naive reader can beat by
 * over 100%. This file pins down the replacement liquidity constant
 * against both a "median" order (an ordinary stake, nowhere near either
 * bound) and a "large" order (the platform's own 500cr max-stake ceiling)
 * on a fresh, uniform-priced 4-seat book — the exact shape of the reported
 * 23.75/26.25/26.25/23.75 market.
 */
import { describe, expect, it } from "vitest";
import { ReplayPremiereLedger } from "../../../../src/server/replay-premiere/wagering/ReplayPremiereLedger";
import {
  applyBuy,
  computeMarketPrices,
  liquidityForOutcomeCount,
  maxSharesForBudget,
} from "../../../../src/server/replay-premiere/wagering/ReplayPremiereMarket";
import { STARTING_BANKROLL, maxStake } from "../../../../src/server/replay-premiere/wagering/ReplayPremiereMarketRules";
import type { ReplayPremiereMarket } from "../../../../src/server/replay-premiere/wagering/ReplayPremiereWageringTypes";

const SEAT_IDS = ["seat-1", "seat-2", "seat-3", "seat-4"];

function freshMarket(b: number): ReplayPremiereMarket {
  return {
    premiereId: "premiere-1",
    outcomeSeatIds: SEAT_IDS,
    b,
    q: SEAT_IDS.map(() => 0),
    status: "open",
    winnerSeatId: null,
    holdings: {},
    costBasis: {},
    ledgerBalances: {},
    ledgerGranted: {},
  };
}

/** Buys `budgetCredits` of `seatId` and returns the resulting display price for that seat. */
function priceAfterBuy(market: ReplayPremiereMarket, seatId: string, budgetCredits: number): number {
  const ledger = new ReplayPremiereLedger();
  ledger.grant("buyer", STARTING_BANKROLL);
  const shares = Math.max(1, maxSharesForBudget(market, seatId, budgetCredits));
  const applied = applyBuy({ market, ledger, participantId: "buyer", seatId, shares });
  return computeMarketPrices(applied.market)[market.outcomeSeatIds.indexOf(seatId)];
}

describe("liquidityForOutcomeCount", () => {
  it("raises b from the old thin-book tuning (10 for 4 seats) to 20", () => {
    // Old: max(10, round(1.5*4)) = max(10, 6) = 10.
    // New: max(20, round(5*4)) = max(20, 20) = 20.
    expect(liquidityForOutcomeCount(4)).toBe(20);
  });
});

describe("single-order price impact on a fresh 4-seat book (25/25/25/25)", () => {
  // "Median" order: 150cr — 15% of the 1,000cr starting bankroll, well
  // clear of both MIN_STAKE (10cr) and the 500cr max-stake ceiling, i.e.
  // an ordinary, non-maxed-out bet.
  const MEDIAN_ORDER_CREDITS = 150;
  // "Large" order: the platform's own ceiling — 50% of the bankroll.
  const LARGE_ORDER_CREDITS = maxStake(STARTING_BANKROLL);

  it("at the new b=20, a median order moves the book meaningfully but not violently", () => {
    const b = liquidityForOutcomeCount(SEAT_IDS.length);
    const before = computeMarketPrices(freshMarket(b))[0];
    const after = priceAfterBuy(freshMarket(b), SEAT_IDS[0], MEDIAN_ORDER_CREDITS);
    const absoluteSwing = after - before;
    const relativeSwing = absoluteSwing / before;
    // Meaningful: the trade is visibly not a no-op.
    expect(absoluteSwing).toBeGreaterThan(2);
    // Not violent: nowhere near the 50%+ single-fill whipsaws Quant found
    // at b=10. 10 points / 40% relative is a generous ceiling with real
    // margin over the measured ~5pt / ~20% move.
    expect(absoluteSwing).toBeLessThan(10);
    expect(relativeSwing).toBeLessThan(0.4);
  });

  it("at the new b=20, a large (max-stake) order still moves the price a lot", () => {
    const b = liquidityForOutcomeCount(SEAT_IDS.length);
    const before = computeMarketPrices(freshMarket(b))[0];
    const after = priceAfterBuy(freshMarket(b), SEAT_IDS[0], LARGE_ORDER_CREDITS);
    const absoluteSwing = after - before;
    // A genuinely large move — a whale can still meaningfully move the
    // book, just not corner it in one fill the way b=10 allowed.
    expect(absoluteSwing).toBeGreaterThan(12);
    expect(after).toBeLessThan(60); // doesn't corner the market outright
  });

  it("large orders still move price substantially more than median orders (liquidity isn't so thick trading is pointless)", () => {
    const b = liquidityForOutcomeCount(SEAT_IDS.length);
    const before = computeMarketPrices(freshMarket(b))[0];
    const afterMedian = priceAfterBuy(freshMarket(b), SEAT_IDS[0], MEDIAN_ORDER_CREDITS);
    const afterLarge = priceAfterBuy(freshMarket(b), SEAT_IDS[0], LARGE_ORDER_CREDITS);
    expect(afterLarge - before).toBeGreaterThan((afterMedian - before) * 2);
  });

  it("documents what the OLD b=10 tuning did to the same median order — the regression this fix closes", () => {
    const OLD_B = 10;
    const before = computeMarketPrices(freshMarket(OLD_B))[0];
    const after = priceAfterBuy(freshMarket(OLD_B), SEAT_IDS[0], MEDIAN_ORDER_CREDITS);
    // At the old b=10, even a merely "median" 150cr order already swings
    // the book harder than a max-stake order does at the new b=20.
    expect(after - before).toBeGreaterThan(10);
  });
});
