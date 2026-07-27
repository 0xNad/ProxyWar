import { describe, expect, it } from "vitest";
import { MIN_STAKE } from "src/prediction/types";
import {
  maxSharesForBudget,
  minTradeableStake,
  quoteBuy,
  quoteSell,
} from "../../../../src/client/prediction/wagering/marketMath";
import { lmsrDisplayPrices } from "../../../../src/client/prediction/wagering/lmsr";
import type { MarketState } from "../../../../src/client/prediction/wagering/types";

function market(overrides: Partial<MarketState> = {}): MarketState {
  const q = overrides.q ?? [0, 0];
  const b = overrides.b ?? 100;
  return {
    outcomeSeatIds: ["seat-a", "seat-b"],
    q,
    b,
    prices: Object.fromEntries(
      ["seat-a", "seat-b"].map((seatId, i) => [seatId, lmsrDisplayPrices(q, b)[i]]),
    ),
    status: "open",
    winnerSeatId: null,
    liveVisibleSequence: 0,
    positions: null,
    balance: 1_000,
    ...overrides,
  };
}

/** The book state immediately after buying `shares` of `seatId` — what an immediate follow-up sell quote must be computed against for a real round trip. */
function afterBuy(mkt: MarketState, seatId: string, shares: number): MarketState {
  const index = mkt.outcomeSeatIds.indexOf(seatId);
  const q2 = mkt.q.slice();
  q2[index] += shares;
  return market({ ...mkt, q: q2 });
}

describe("no house edge, including the long-shot floor edge case", () => {
  it("buying then immediately selling the same shares back nets exactly 0 chips on an ordinary (near-50/50) market", () => {
    const mkt = market();
    const buy = quoteBuy(mkt, "seat-a", 200);
    expect(buy).not.toBeNull();
    const sell = quoteSell(afterBuy(mkt, "seat-a", buy!.shares), "seat-a", buy!.shares);
    expect(sell).not.toBeNull();
    expect(sell!.chips).toBe(buy!.chips);
  });

  it("buying then immediately selling ONE share nets exactly 0 chips on a genuine long shot (< 1cr raw LMSR cost before any floor)", () => {
    // q heavily skewed against seat-a: its true LMSR price is under 1%, so
    // the true (unrounded) cost of 1 share is well under 1 chip — exactly
    // the regime the old asymmetric floor (buy floors at 1, sell floors
    // at 0) leaked 1 chip on every round trip. 2 shares' raw cost already
    // clears 1.5 (rounds to 2), so a 1-chip budget buys exactly 1 share.
    const mkt = market({ q: [0, 48], b: 10 });
    expect(mkt.prices["seat-a"]).toBeLessThan(1);
    const stake = minTradeableStake(mkt, "seat-a");
    expect(stake).toBe(MIN_STAKE); // floors at the platform minimum, not the (sub-1cr) true cost
    const buy = quoteBuy(mkt, "seat-a", 1);
    expect(buy).not.toBeNull();
    expect(buy!.shares).toBe(1);
    expect(buy!.chips).toBe(1); // floored buy cost
    const sell = quoteSell(afterBuy(mkt, "seat-a", 1), "seat-a", 1);
    expect(sell).not.toBeNull();
    // The bug this closes: sell used to floor at 0 while buy floored at
    // 1, leaking 1 chip on exactly this outcome shape.
    expect(sell!.chips).toBe(buy!.chips);
    expect(sell!.chips).toBe(1);
  });

  it("a sell can never return 0 chips for a positive share count on an open market — the floor that used to make the round trip lossy", () => {
    const mkt = market({ q: [0, 1_000], b: 10 });
    const sell = quoteSell(mkt, "seat-a", 1);
    expect(sell).not.toBeNull();
    expect(sell!.chips).toBeGreaterThanOrEqual(1);
  });
});

describe("minTradeableStake — the dynamic quick-pick minimum", () => {
  it("returns the platform floor once the true 1-share cost is below it", () => {
    const mkt = market({ q: [0, 48], b: 10 });
    expect(minTradeableStake(mkt, "seat-a")).toBe(MIN_STAKE);
  });

  it("returns the real 1-share cost once it exceeds the platform floor — the reported '10cr quick-pick always fails' regime (a seat near its 25% opening prices its first share around 25cr)", () => {
    const mkt = market(); // fresh 25/25/25/25-equivalent 2-outcome 50/50 book
    const min = minTradeableStake(mkt, "seat-a");
    expect(min).toBeGreaterThan(MIN_STAKE);
    expect(maxSharesForBudget(mkt, "seat-a", min)).toBeGreaterThanOrEqual(1);
    expect(maxSharesForBudget(mkt, "seat-a", min - 1)).toBe(0);
  });

  it("falls back to the platform floor for an unknown seat rather than throwing", () => {
    const mkt = market();
    expect(minTradeableStake(mkt, "not-a-real-seat")).toBe(MIN_STAKE);
  });
});
