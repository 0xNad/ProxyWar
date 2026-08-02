/**
 * Pure mappers from the wire-level premiere-scoped market shape
 * (`ReplayPremiereServiceMarketState`, defined in `ReplayPremiereRuntime.ts`)
 * to this module's own view types. Isolated here — not inline in the page
 * controller — so the translation is unit-testable without a live runtime
 * controller or network.
 */
import type { ReplayPremiereServiceMarketState } from "src/client/ReplayPremiereRuntime";
import type { MarketSettlement, MarketState } from "./types";

export function marketStateFromService(
  wire: ReplayPremiereServiceMarketState,
): MarketState {
  const prices: Record<string, number> = {};
  wire.outcomeSeatIds.forEach((seatId, index) => {
    prices[seatId] = wire.prices[index] ?? 0;
  });
  return {
    outcomeSeatIds: wire.outcomeSeatIds,
    q: wire.q,
    b: wire.b,
    prices,
    status: wire.status,
    winnerSeatId: wire.winnerSeatId,
    liveVisibleSequence: wire.liveVisibleSequence,
    balance: wire.balance,
    positions:
      wire.positions?.map((position) => ({
        seatId: position.seatId,
        shares: position.shares,
        costBasis: position.costBasis,
        currentValue: position.currentValue,
        unrealizedPnl: position.unrealizedPnl,
      })) ?? null,
  };
}

/**
 * Post-settlement view for one seat the viewer held. `null` when the
 * market hasn't settled yet, or the viewer never held that seat.
 */
export function settlementForSeat(
  market: MarketState,
  seatId: string,
): MarketSettlement | null {
  if (market.status !== "settled") return null;
  const position = market.positions?.find((p) => p.seatId === seatId);
  if (position === undefined) return null;
  const outcome =
    market.winnerSeatId === null
      ? ({ kind: "void", reason: "checkpoint_voided" } as const)
      : ({ kind: "paid", winnerSeatId: market.winnerSeatId } as const);
  return {
    outcome,
    seatId,
    finalShares: position.shares,
    costBasis: position.costBasis,
    payout: position.currentValue,
    bankrollDelta: position.currentValue - position.costBasis,
  };
}
