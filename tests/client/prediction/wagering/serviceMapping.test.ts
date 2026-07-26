import { describe, expect, it } from "vitest";
import {
  marketStateFromService,
  settlementForSeat,
} from "../../../../src/client/prediction/wagering/serviceMapping";
import type { ReplayPremiereServiceMarketState } from "src/client/ReplayPremiereRuntime";

function serviceMarket(
  overrides: Partial<ReplayPremiereServiceMarketState> = {},
): ReplayPremiereServiceMarketState {
  return {
    premiereId: "prem_abcdefghijklmnop",
    outcomeSeatIds: ["seat-a", "seat-b"],
    q: [10, -10],
    b: 100,
    prices: [55, 45],
    status: "open",
    winnerSeatId: null,
    positions: null,
    ...overrides,
  };
}

describe("marketStateFromService", () => {
  it("maps outcomeSeatIds/q/b straight through and builds a price map", () => {
    const result = marketStateFromService(serviceMarket());
    expect(result.outcomeSeatIds).toEqual(["seat-a", "seat-b"]);
    expect(result.q).toEqual([10, -10]);
    expect(result.b).toBe(100);
    expect(result.prices).toEqual({ "seat-a": 55, "seat-b": 45 });
  });

  it("maps null positions through unchanged", () => {
    expect(marketStateFromService(serviceMarket()).positions).toBeNull();
  });

  it("maps each position's server-computed value fields", () => {
    const result = marketStateFromService(
      serviceMarket({
        positions: [
          {
            seatId: "seat-a",
            shares: 4,
            costBasis: 180,
            currentValue: 220,
            unrealizedPnl: 40,
          },
        ],
      }),
    );
    expect(result.positions).toEqual([
      { seatId: "seat-a", shares: 4, costBasis: 180, currentValue: 220, unrealizedPnl: 40 },
    ]);
  });
});

describe("settlementForSeat", () => {
  it("is null before the market has settled", () => {
    const market = marketStateFromService(serviceMarket({ status: "open" }));
    expect(settlementForSeat(market, "seat-a")).toBeNull();
  });

  it("is null when the viewer never held that seat", () => {
    const market = marketStateFromService(
      serviceMarket({ status: "settled", winnerSeatId: "seat-a", positions: [] }),
    );
    expect(settlementForSeat(market, "seat-a")).toBeNull();
  });

  it("reports a paid outcome and positive bankrollDelta for the winning seat", () => {
    const market = marketStateFromService(
      serviceMarket({
        status: "settled",
        winnerSeatId: "seat-a",
        positions: [
          { seatId: "seat-a", shares: 4, costBasis: 180, currentValue: 400, unrealizedPnl: 220 },
        ],
      }),
    );
    const result = settlementForSeat(market, "seat-a");
    expect(result).toEqual({
      outcome: { kind: "paid", winnerSeatId: "seat-a" },
      seatId: "seat-a",
      finalShares: 4,
      costBasis: 180,
      payout: 400,
      bankrollDelta: 220,
    });
  });

  it("reports zero payout and a negative bankrollDelta for a losing seat", () => {
    const market = marketStateFromService(
      serviceMarket({
        status: "settled",
        winnerSeatId: "seat-b",
        positions: [
          { seatId: "seat-a", shares: 4, costBasis: 180, currentValue: 0, unrealizedPnl: -180 },
        ],
      }),
    );
    const result = settlementForSeat(market, "seat-a");
    expect(result?.payout).toBe(0);
    expect(result?.bankrollDelta).toBe(-180);
  });

  it("reports a void outcome when there is no winner", () => {
    const market = marketStateFromService(
      serviceMarket({
        status: "settled",
        winnerSeatId: null,
        positions: [
          { seatId: "seat-a", shares: 4, costBasis: 180, currentValue: 180, unrealizedPnl: 0 },
        ],
      }),
    );
    const result = settlementForSeat(market, "seat-a");
    expect(result?.outcome).toEqual({ kind: "void", reason: "checkpoint_voided" });
    expect(result?.bankrollDelta).toBe(0);
  });
});
