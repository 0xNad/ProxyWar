/**
 * `positionsFor().currentValue` must be the EXECUTABLE liquidation value —
 * exactly what an immediate full sell of the position would actually pay
 * on the LMSR cost curve (`sellProceeds`/`quoteSell`), never `shares *
 * marginal price`. Selling moves price against the seller along the
 * convex curve, so the marginal-price number overstates what's realisable;
 * a player who saw that number, sold, and got materially less would
 * correctly read it as the product lying about their money.
 */
import { describe, expect, it } from "vitest";
import { ReplayPremiereLedger } from "../../../../src/server/replay-premiere/wagering/ReplayPremiereLedger";
import {
  applyBuy,
  applySell,
  computeMarketPrices,
  liquidityForOutcomeCount,
  positionsFor,
  quoteSell,
  settleMarket,
} from "../../../../src/server/replay-premiere/wagering/ReplayPremiereMarket";
import type { ReplayPremiereMarket } from "../../../../src/server/replay-premiere/wagering/ReplayPremiereWageringTypes";

function freshMarket(outcomeSeatIds: readonly string[]): ReplayPremiereMarket {
  const b = liquidityForOutcomeCount(outcomeSeatIds.length);
  return {
    premiereId: "premiere-1",
    outcomeSeatIds,
    b,
    q: outcomeSeatIds.map(() => 0),
    status: "open",
    winnerSeatId: null,
    holdings: {},
    costBasis: {},
    ledgerBalances: {},
    ledgerGranted: {},
  };
}

describe("positionsFor currentValue is the executable liquidation value", () => {
  it("for a non-trivial position, currentValue equals what an immediate full sell would actually pay, to the credit", () => {
    const ledger = new ReplayPremiereLedger();
    ledger.grant("p1", 10_000);
    // A second participant buys heavily on other seats first, so the curve
    // is genuinely non-flat when p1 buys — a real, non-trivial position
    // whose marginal price has visibly diverged from its liquidation price.
    ledger.grant("noise", 10_000);
    let market = freshMarket(["seat-0", "seat-1", "seat-2"]);
    market = applyBuy({
      market,
      ledger,
      participantId: "noise",
      seatId: "seat-1",
      shares: 40,
    }).market;
    market = applyBuy({
      market,
      ledger,
      participantId: "noise",
      seatId: "seat-2",
      shares: 25,
    }).market;

    const buy = applyBuy({
      market,
      ledger,
      participantId: "p1",
      seatId: "seat-0",
      shares: 30,
    });
    market = buy.market;

    const positions = positionsFor(market, "p1");
    expect(positions).toHaveLength(1);
    const position = positions[0];
    expect(position.seatId).toBe("seat-0");
    expect(position.shares).toBe(30);

    // The independently-computed executable quote for selling the whole
    // position, on the exact same market snapshot.
    const sellQuote = quoteSell(market, "seat-0", 30);
    expect(position.currentValue).toBe(sellQuote.chips);

    // And it genuinely diverges from the marginal-price number a naive
    // `shares * price` computation would have produced — proving this
    // isn't a coincidence of a flat/degenerate curve.
    const marginalPrice = computeMarketPrices(market)[0];
    const marginalPriceValue = Math.round(position.shares * marginalPrice * 100);
    expect(position.currentValue).toBeLessThan(marginalPriceValue);

    // The number is not just consistent with the quote preview — it's what
    // a REAL sell of the whole position actually pays, to the credit.
    const executed = applySell({
      market,
      ledger,
      participantId: "p1",
      seatId: "seat-0",
      shares: 30,
    });
    expect(executed.chips).toBe(position.currentValue);

    // unrealizedPnl is derived from the same executable number, not the
    // marginal one.
    expect(position.unrealizedPnl).toBe(position.currentValue - position.costBasis);
  });

  it("matches an exact full sell to the credit across many position sizes and outcome counts", () => {
    for (const outcomeCount of [2, 3, 5]) {
      for (const shares of [1, 3, 17, 50]) {
        const ledger = new ReplayPremiereLedger();
        ledger.grant("p1", 1_000_000);
        const seats = Array.from({ length: outcomeCount }, (_, i) => `seat-${i}`);
        let market = freshMarket(seats);
        market = applyBuy({
          market,
          ledger,
          participantId: "p1",
          seatId: seats[0],
          shares,
        }).market;

        const [position] = positionsFor(market, "p1");
        const executed = applySell({
          market,
          ledger,
          participantId: "p1",
          seatId: seats[0],
          shares,
        });
        expect(position.currentValue).toBe(executed.chips);
      }
    }
  });

  it("a settled market has no open positions left to value (settlement already paid/refunded through the ledger, not through currentValue)", () => {
    const ledger = new ReplayPremiereLedger();
    ledger.grant("p1", 500);
    let market = freshMarket(["seat-0", "seat-1"]);
    market = applyBuy({
      market,
      ledger,
      participantId: "p1",
      seatId: "seat-0",
      shares: 2,
    }).market;
    market = settleMarket({ market, ledger, winnerSeatId: "seat-0" });
    expect(positionsFor(market, "p1")).toEqual([]);
  });
});
