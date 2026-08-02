/**
 * Server-side LMSR prediction market on the replay-premiere premiere.
 * Ported from the prior single-player client-side engine at
 * `/tmp/markets-prior/engine/` (see the operator's LMSR-pivot directive).
 *
 * ONE continuous market spans the whole premiere. Trading is **live and
 * continuous** — open from match start to reveal, not gated to prediction
 * checkpoints. Checkpoints still exist as content beats the UI may
 * highlight, but they gate nothing about the market.
 *
 * Integrity is synchronised progressive release, not pausing: every viewer
 * must be on the same authoritative frame at the same time, or a holder
 * with a read-ahead advantage trades on information others don't have yet.
 * `ReplayPremiereInteractions.submitMarketOrder` requires both that the
 * premiere be live (not scheduled, not yet revealed) AND that the order's
 * claimed `sequence` is <=
 * `ReplayPremiereRuntimeCoordinator.readLiveVisibleSequence()` — the
 * server's own fine-grained release clock, computed independent of chunk
 * storage/release batching (`readLiveProjection` is the matching "tap"
 * read). `observedSequence`-style client-reported markers are never a
 * trust boundary for this — only the server's own release clock is.
 *
 * Types only here — no dependency on ReplayPremiereInteractions, so the
 * market/pricing modules stay independently testable and substrate-agnostic.
 */

/** Outcome index is the position in `outcomeSeatIds` / `q` — fixed for the market's lifetime. */
export interface ReplayPremiereMarket {
  readonly premiereId: string;
  /** Fixed at market creation from the full seat roster; a seat eliminated later just trades toward 0, it is never removed. */
  readonly outcomeSeatIds: readonly string[];
  /** LMSR liquidity constant, fixed at creation. */
  readonly b: number;
  /** Integer share vector, index-aligned to `outcomeSeatIds`. */
  readonly q: readonly number[];
  readonly status: "open" | "settled";
  readonly winnerSeatId: string | null;
  /** participantId -> shares held per outcome index. */
  readonly holdings: Readonly<Record<string, readonly number[]>>;
  /** participantId -> credits paid for the currently-held shares per outcome index (cost basis). */
  readonly costBasis: Readonly<Record<string, readonly number[]>>;
  readonly ledgerBalances: Readonly<Record<string, number>>;
  readonly ledgerGranted: Readonly<Record<string, number>>;
}

export type ReplayPremiereMarketOrderSide = "buy" | "sell";

export type ReplayPremiereMarketParticipantKind = "real" | "synthetic";

export type ReplayPremiereMarketOrderRejectReason =
  | "market_not_open"
  | "below_min_stake"
  | "above_max_stake"
  | "insufficient_funds"
  | "invalid_amount"
  | "no_shares_to_sell"
  | "zero_shares"
  | "slippage_exceeded"
  | "unknown_seat";

/** One executed trade — the durable, idempotent, recoverable unit of the market. */
export interface ReplayPremiereMarketTrade {
  readonly id: string;
  readonly premiereId: string;
  readonly participantId: string;
  readonly participantKind: ReplayPremiereMarketParticipantKind;
  readonly seatId: string;
  readonly side: ReplayPremiereMarketOrderSide;
  readonly shares: number;
  readonly chips: number;
  readonly avgPrice: number;
  readonly executedAt: string;
  /**
   * The highest sequence the trader's order claimed was live-visible when
   * submitted (`ReplayPremiereRuntimeCoordinator.readLiveVisibleSequence()`
   * at accept time, never client-trusted — see `submitMarketOrder`). Purely
   * an audit/staleness marker; not re-derived at recovery.
   */
  readonly sequence: number;
  readonly idempotencyKey: string;
}

/** A participant's position in one outcome, valued for liquidation. */
export interface ReplayPremiereMarketPosition {
  readonly seatId: string;
  readonly shares: number;
  readonly costBasis: number;
  /**
   * The EXECUTABLE liquidation value: what an immediate full sell of
   * `shares` would actually pay on the LMSR cost curve (`sellProceeds`,
   * the same function every real sell fill uses) — never `shares` times
   * the marginal per-share price, which overstates it since selling moves
   * price against the seller along the curve.
   */
  readonly currentValue: number;
  readonly unrealizedPnl: number;
}

/** Result of executing (or quoting) a buy or sell against the current authoritative `q`. */
export interface ReplayPremiereMarketFill {
  readonly shares: number;
  readonly chips: number;
  readonly avgPrice: number;
  readonly pricesAfter: readonly number[];
}

/**
 * Live, poll-friendly market state — the premiere-wide sibling read. Trading
 * is continuous, so `status` is simply "open" (the premiere is live and
 * accepting orders) until it flips to "settled" at reveal; there is no
 * checkpoint-window concept to fold in.
 */
export interface ReplayPremiereMarketStateView {
  readonly outcomeSeatIds: readonly string[];
  readonly b: number;
  readonly q: readonly number[];
  readonly prices: readonly number[];
  readonly status: "open" | "settled";
  readonly winnerSeatId: string | null;
  /**
   * Highest sequence currently live-visible — independent of chunk-release
   * batching (see `ReplayPremiereRuntimeCoordinator.readLiveVisibleSequence`).
   * The value a client should stamp on its next `submitMarketOrder` call.
   */
  readonly liveVisibleSequence: number;
  /** The caller's own positions, mark-to-market. Null when no participant was specified. */
  readonly positions: readonly ReplayPremiereMarketPosition[] | null;
  /**
   * The caller's own available (spendable) ledger balance — the single
   * money-authoritative number for bankroll display and buy-stake
   * validation; the client must never re-derive it locally (that's the
   * two-authorities drift this field exists to eliminate). Null only when
   * no participant was specified. A participant who has never traded yet
   * reads as `STARTING_BANKROLL` (the exact amount their first order would
   * be lazily granted and charged against), not 0.
   */
  readonly balance: number | null;
}
