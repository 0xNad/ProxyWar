/**
 * With continuous trading (no checkpoint pause), the existing chunk-release
 * mechanism's normal ceiling — `REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS`,
 * 60s in `ReplayPremiereContracts.ts` — becomes a real read-ahead exploit:
 * a chunk still only releases once the authoritative clock reaches its LAST
 * record, so anyone reading the network payload directly (not watching the
 * rendered map) sees up to a minute of future game state and can trade on
 * it before any other viewer does. Release granularity must approach
 * presentation granularity while wagering is live. 1s bounds the read-ahead
 * to something a human render-vs-fetch race cannot meaningfully exploit,
 * while keeping round-trip volume reasonable (~600 chunks over a 10-minute
 * premiere). Enforced, not advisory: `ReplayPremiereStartup.ts` refuses to
 * assemble a wagering-enabled premiere whose admitted
 * `chunkBuildLimits.maxPresentationSpanMs` exceeds this — the combination is
 * impossible to configure, not merely discouraged.
 */
export const WAGERING_MAX_PRESENTATION_SPAN_MS = 1_000;

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
 * `ReplayPremiereInteractions.submitMarketOrder` only requires the premiere
 * be live (not scheduled, not yet revealed); the actual anti-read-ahead
 * property comes from the release clock itself — see
 * `WAGERING_MAX_PRESENTATION_SPAN_MS` above, which is what bounds how far
 * ahead of the rendered frame the network payload can ever be while
 * wagering is on. `observedSequence`-style client-reported markers are
 * never a trust boundary for this — only the server's own release clock is.
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
  readonly idempotencyKey: string;
}

/** A participant's mark-to-market position in one outcome. */
export interface ReplayPremiereMarketPosition {
  readonly seatId: string;
  readonly shares: number;
  readonly costBasis: number;
  /** Mark-to-market value at current prices. */
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
  /** The caller's own positions, mark-to-market. Null when no participant was specified. */
  readonly positions: readonly ReplayPremiereMarketPosition[] | null;
}
