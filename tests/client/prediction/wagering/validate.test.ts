import { describe, expect, it } from "vitest";
import {
  validateBuyDraft,
  validateSellDraft,
  type BuyDraftInput,
  type SellDraftInput,
} from "../../../../src/client/prediction/wagering/validate";
import type { MarketState } from "../../../../src/client/prediction/wagering/types";

function market(overrides: Partial<MarketState> = {}): MarketState {
  return {
    outcomeSeatIds: ["seat-a", "seat-b"],
    q: [0, 0],
    b: 100,
    prices: { "seat-a": 50, "seat-b": 50 },
    status: "open",
    winnerSeatId: null,
    liveVisibleSequence: 0,
    positions: null,
    ...overrides,
  };
}

function buyDraft(overrides: Partial<BuyDraftInput> = {}): BuyDraftInput {
  return {
    seatId: "seat-a",
    budgetText: "50",
    bankroll: 1000,
    windowOpen: true,
    market: market(),
    ...overrides,
  };
}

function sellDraft(overrides: Partial<SellDraftInput> = {}): SellDraftInput {
  return {
    seatId: "seat-a",
    sharesText: "3",
    heldShares: 5,
    windowOpen: true,
    ...overrides,
  };
}

describe("validateBuyDraft", () => {
  it("accepts a well-formed buy", () => {
    expect(validateBuyDraft(buyDraft())).toEqual({ ok: true });
  });

  it("rejects when the market is closed", () => {
    const result = validateBuyDraft(buyDraft({ windowOpen: false }));
    expect(result).toEqual({
      ok: false,
      reason: "market-closed",
      message: expect.stringContaining("closed"),
    });
  });

  it("rejects when no seat is chosen", () => {
    const result = validateBuyDraft(buyDraft({ seatId: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-seat-selected");
  });

  it("rejects an empty amount", () => {
    expect(validateBuyDraft(buyDraft({ budgetText: "" })).ok).toBe(false);
  });

  it("rejects a non-integer amount", () => {
    expect(validateBuyDraft(buyDraft({ budgetText: "12.5" })).ok).toBe(false);
    expect(validateBuyDraft(buyDraft({ budgetText: "abc" })).ok).toBe(false);
    expect(validateBuyDraft(buyDraft({ budgetText: "-5" })).ok).toBe(false);
  });

  it("rejects a budget below MIN_STAKE", () => {
    const result = validateBuyDraft(buyDraft({ budgetText: "1" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("below-min-stake");
  });

  it("rejects a budget above maxStake(bankroll)", () => {
    // bankroll 100 -> maxStake = 50
    const result = validateBuyDraft(buyDraft({ bankroll: 100, budgetText: "51" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("above-max-stake");
  });

  it("rejects a budget exceeding the bankroll even when under the cap", () => {
    // bankroll 5 -> maxStake floors to MIN_STAKE (10), but only 5 credits exist.
    const result = validateBuyDraft(buyDraft({ bankroll: 5, budgetText: "10" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("insufficient-funds");
  });

  it("accepts exactly the max stake", () => {
    expect(validateBuyDraft(buyDraft({ bankroll: 100, budgetText: "50" }))).toEqual({
      ok: true,
    });
  });

  it("rejects a budget too small to buy even one share at the current price", () => {
    // At b=12 the first share on an even 50/50 market costs 51 chips —
    // MIN_STAKE (10) clears every other check but still can't fill.
    const tightMarket = market({ b: 12, q: [0, 0] });
    const result = validateBuyDraft(
      buyDraft({ market: tightMarket, budgetText: "10" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("zero-shares");
  });
});

describe("validateSellDraft", () => {
  it("accepts a well-formed sell", () => {
    expect(validateSellDraft(sellDraft())).toEqual({ ok: true });
  });

  it("rejects when the market is closed", () => {
    const result = validateSellDraft(sellDraft({ windowOpen: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("market-closed");
  });

  it("rejects when no seat is chosen", () => {
    const result = validateSellDraft(sellDraft({ seatId: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-seat-selected");
  });

  it("rejects selling with no shares held", () => {
    const result = validateSellDraft(sellDraft({ heldShares: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-shares-to-sell");
  });

  it("rejects a non-integer share count", () => {
    expect(validateSellDraft(sellDraft({ sharesText: "1.5" })).ok).toBe(false);
    expect(validateSellDraft(sellDraft({ sharesText: "abc" })).ok).toBe(false);
  });

  it("rejects selling more shares than held", () => {
    const result = validateSellDraft(sellDraft({ heldShares: 2, sharesText: "3" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("above-max-stake");
  });

  it("accepts selling exactly the held amount", () => {
    expect(validateSellDraft(sellDraft({ heldShares: 3, sharesText: "3" }))).toEqual({
      ok: true,
    });
  });
});
