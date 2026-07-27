/**
 * "No house edge" is a UI claim (`BettingOverlay.ts`: "buying then
 * immediately selling the same shares back nets exactly 0 cr"). It used to
 * be false in a reachable edge case: `buyCost` floors at 1cr for >=1 share
 * but `sellProceeds` floored at 0cr, so a round trip on any outcome cheap
 * enough that its true (unrounded) cost rounds to 0 leaked 1cr, guaranteed,
 * every time. This file proves the claim actually holds now, including at
 * that exact edge, through the real `applyBuy`/`applySell` execution path
 * (not just the pure quote functions) and the ledger those functions post
 * through.
 */
import { describe, expect, it } from "vitest";
import { ReplayPremiereLedger } from "../../../../src/server/replay-premiere/wagering/ReplayPremiereLedger";
import {
  applyBuy,
  applySell,
  quoteBuy,
  quoteSell,
} from "../../../../src/server/replay-premiere/wagering/ReplayPremiereMarket";
import type { ReplayPremiereMarket } from "../../../../src/server/replay-premiere/wagering/ReplayPremiereWageringTypes";

const SEAT_IDS = ["seat-1", "seat-2"];

function freshMarket(q: readonly number[], b: number): ReplayPremiereMarket {
  return {
    premiereId: "premiere-1",
    outcomeSeatIds: SEAT_IDS,
    b,
    q: [...q],
    status: "open",
    winnerSeatId: null,
    holdings: {},
    costBasis: {},
    ledgerBalances: {},
    ledgerGranted: {},
  };
}

describe("no house edge, including the long-shot floor edge case", () => {
  it("buy then immediately sell nets exactly 0 credits on an ordinary (near 50/50) market, and leaves the ledger balanced", () => {
    const ledger = new ReplayPremiereLedger();
    ledger.grant("trader", 1_000);
    let market = freshMarket([0, 0], 100);
    const bought = applyBuy({ market, ledger, participantId: "trader", seatId: "seat-1", shares: 5 });
    market = bought.market;
    const sold = applySell({ market, ledger, participantId: "trader", seatId: "seat-1", shares: 5 });
    expect(sold.chips).toBe(bought.chips);
    expect(ledger.balanceOf("trader")).toBe(1_000);
    expect(ledger.total()).toBe(0);
  });

  it("buy then immediately sell ONE share nets exactly 0 credits on a genuine long shot — the bug this closes", () => {
    // seat-1 priced under 1%: true (unrounded) 1-share cost is well below
    // 1cr, exactly the regime where the old asymmetric floor (buy >= 1,
    // sell >= 0) leaked 1cr per round trip.
    const q = [0, 48];
    const b = 10;
    const preview = quoteBuy(freshMarket(q, b), "seat-1", 1);
    expect(preview.chips).toBe(1); // floored buy cost, not the true sub-1cr cost
    const ledger = new ReplayPremiereLedger();
    ledger.grant("trader", 1_000);
    let market = freshMarket(q, b);
    const bought = applyBuy({ market, ledger, participantId: "trader", seatId: "seat-1", shares: 1 });
    expect(bought.chips).toBe(1);
    market = bought.market;
    const sold = applySell({ market, ledger, participantId: "trader", seatId: "seat-1", shares: 1 });
    expect(sold.chips).toBe(1); // NOT 0 — the fix
    expect(ledger.balanceOf("trader")).toBe(1_000); // exactly the starting bankroll: no leak either direction
    expect(ledger.total()).toBe(0);
  });

  it("a sell quote never returns 0 credits for a positive share count while the market is open", () => {
    const preview = quoteSell(freshMarket([0, 1_000], 10), "seat-1", 1);
    expect(preview.chips).toBeGreaterThanOrEqual(1);
  });
});
