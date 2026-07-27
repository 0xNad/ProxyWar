/**
 * LMSR prediction market — client view types.
 *
 * Sits on top of the EXISTING sealed replay-premiere checkpoint flow
 * (`ReplayPremiereOverlay.ts` / `ReplayPremiereRuntime.ts`): the window that
 * already gates free predictions is reused verbatim to gate trading. Per
 * Main's pivot, this replaces the earlier pari-mutuel "one stake per
 * checkpoint" model with ONE continuous market for the whole premiere
 * (confirmed with PariServer): every seat trades as a share priced 0..100
 * (= implied probability) from market creation through reveal, players may
 * buy AND sell whenever a checkpoint window is open (frozen in the gap
 * between checkpoints, tradeable again at the next one), and price moves
 * with order flow (real trades plus a server-side synthetic crowd). At
 * checkpoint 2 a participant sees checkpoint 1's position mark-to-market —
 * up or down — and decides to press, cut, or ride; that unrealized P&L is
 * load-bearing UI, not decoration. Holding the winning outcome to
 * settlement pays 100 chips/share. See the pricing math in `lmsr.ts` /
 * `marketMath.ts`.
 */
import type { Credits } from "src/prediction/types";

/** Chips paid per winning share at settlement — see `market.ts` server-side. */
export const SHARE_PAYOUT = 100;

/** One seat a participant can trade, as offered by the market. */
export interface MarketSeatOption {
  readonly seatId: string;
  readonly displayName: string;
}

export type TradeSide = "buy" | "sell";

/**
 * A participant's open position in one outcome. `currentValue` and
 * `unrealizedPnl` are SERVER-COMPUTED mark-to-market figures carried on the
 * wire (`currentValue - costBasis`) — the client never recomputes these for
 * display, only for a draft-trade PREVIEW before submit (see
 * `marketMath.ts`), since the server is authoritative on live prices.
 */
export interface MarketPosition {
  readonly seatId: string;
  readonly shares: number;
  /** Total chips paid (net of any sells) to reach the current holding. */
  readonly costBasis: Credits;
  readonly currentValue: Credits;
  readonly unrealizedPnl: Credits;
}

/**
 * The live (or, once the whole premiere's market settles, frozen) LMSR
 * market — ONE per premiere, not per checkpoint. `q` is the current
 * integer share vector server-side, aligned to `outcomeSeatIds` (fixed at
 * market creation from the full seat roster; an eliminated seat just
 * trades toward 0, it never leaves the vector). `prices` is the display
 * price (0..100) per seat, derived from `q`/`b` — the client never
 * recomputes `prices` for display, only for a draft-trade preview. Pushed
 * fresh as other participants (and the synthetic crowd) trade — the caller
 * feeds fresh snapshots in; this type carries no staleness of its own.
 * Whether trading is currently ALLOWED (checkpoint window open vs. the gap
 * between checkpoints vs. post-reveal) is read from the checkpoint's own
 * `state`, not from here.
 */
export interface MarketState {
  readonly outcomeSeatIds: readonly string[];
  readonly q: readonly number[];
  readonly b: number;
  readonly prices: Readonly<Record<string, number>>;
  readonly status: "open" | "settled";
  readonly winnerSeatId: string | null;
  /**
   * Anti-replay freshness bound — echo the latest value back on the NEXT
   * trade request (`ReplayPremiereTradeRequest.sequence`); never cache a
   * stale one across multiple orders.
   */
  readonly liveVisibleSequence: number;
  /** This participant's own open positions, one entry per seat held. */
  readonly positions: readonly MarketPosition[] | null;
  /**
   * The caller's own available (spendable) ledger balance — the SOLE
   * money authority for bankroll display and buy-stake validation. This
   * module never re-derives a bankroll figure locally; the bankroll
   * badge and every stake check read this field, verbatim, off the
   * latest `/market/me` poll or trade response. `null` only when this
   * snapshot was read anonymously (no participant bound) — which never
   * happens on this page, every read here is authenticated.
   */
  readonly balance: number | null;
}

/** Outbound request to trade at an open checkpoint window. */
export interface TradeRequest {
  readonly seatId: string;
  readonly side: TradeSide;
  /** Budget in chips to spend, for a buy; exact share count, for a sell. */
  readonly amount: Credits;
  /** 0..100 — ceiling for a buy, floor for a sell. Required: the crowd trades the same live book. */
  readonly limitPrice: number;
}

/** Reasons a draft trade can be rejected client-side, for a clear UI state. */
export type TradeRejectReason =
  | "market-closed"
  | "no-seat-selected"
  | "invalid-amount"
  | "below-min-stake"
  | "above-max-stake"
  | "insufficient-funds"
  | "no-shares-to-sell"
  | "zero-shares";

/** Server-authoritative resolution of the whole premiere's market. */
export type MarketOutcome =
  | { readonly kind: "paid"; readonly winnerSeatId: string }
  | { readonly kind: "void"; readonly reason: string };

/**
 * Post-resolution settlement for one seat's final position.
 * `bankrollDelta` (`payout - costBasis`) is this seat's own net effect —
 * self-contained, independent of the viewer's overall running bankroll
 * (that's `MarketState.balance`, the server's authoritative ledger
 * figure — there is no client-local wallet in this module).
 */
export interface MarketSettlement {
  readonly outcome: MarketOutcome;
  readonly seatId: string;
  readonly finalShares: number;
  readonly costBasis: Credits;
  readonly payout: Credits;
  readonly bankrollDelta: Credits;
}
