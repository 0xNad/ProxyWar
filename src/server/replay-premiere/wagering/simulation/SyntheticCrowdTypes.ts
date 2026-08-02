/**
 * Shared types for the synthetic-bettor ("crowd") simulator. See
 * `SyntheticCrowdSimulator.ts` for the module-level design rationale
 * (progressive, never-beyond-released signal, one continuous live market,
 * no bypass of the real order queue) — this is scaffolding for demos and
 * tester sessions, off by default, never for production.
 */

export type SyntheticCrowdPersonaKind =
  | "favorite-backer"
  | "value-hunter"
  | "momentum-chaser"
  | "noise-trader";

/**
 * Shapes per-tick trading-activity density over match progress (0 = match
 * start, 1 = match end) — NOT a scheduled list of offsets, since trading is
 * now continuous and driven one released frame at a time by the caller.
 * Every curve averages to a density of 1 over the whole match, so
 * `activityProbability` stays the base per-tick rate.
 */
export type SyntheticCrowdActivityCurve =
  | "steady"
  | "early-heavy"
  | "late-heavy"
  | "u-shaped";

export interface SyntheticCrowdConfig {
  /** Master switch. Off by default — see module header. */
  readonly enabled: boolean;
  /** Number of synthetic bettors. */
  readonly count: number;
  /** Reproducibility seed — the same seed always produces the same roster and trade sequence for the same sequence of released frames. */
  readonly seed: number;
  /** Average starting budget hint per bot (credits); actual per-bot hints are seeded-jittered 0.5x-1.5x of this. */
  readonly bankrollEach: number;
  /** 0..1. Scales conviction (favorite-backer sharpening / value-hunter flattening / momentum extrapolation) and tolerated slippage. */
  readonly aggressiveness: number;
  readonly minStake: number;
  readonly maxStake: number;
  /** Price-vs-fair-value gap (display points, 0..100 scale) required to trade. */
  readonly threshold: number;
  readonly activityCurve: SyntheticCrowdActivityCurve;
  /** 0..1. Base chance a bot attempts a trade on a given released frame (before the activity curve's density multiplier), matching the ported engine's per-tick `activity` chance. */
  readonly activityProbability: number;
  readonly personaWeights: Readonly<Record<SyntheticCrowdPersonaKind, number>>;
}

/**
 * The ONLY fair-value input the crowd is ever given for one released frame.
 * The caller MUST hand this in progressively, one step at a time, and MUST
 * NEVER include anything beyond what has actually been released as of this
 * call — see `SyntheticCrowdSimulator` for why this is structural rather
 * than a convention: this module has no live accessor of its own, no
 * runtime reference, nothing that could reach past what it is handed.
 *
 * `favorabilityWeights` are non-negative, relative (need not sum to
 * anything in particular) per-seat strength beliefs. This module has zero
 * access to game/replay/territory internals and never should (the wagering
 * domain already draws this boundary deliberately — see
 * ReplayPremiereInteractions.ts's `deriveReplayPremierePredictionOutcome`
 * header); it is entirely the caller's responsibility to derive weights
 * from whatever has legitimately been released as of this frame (e.g. the
 * currently-visible territory share, or league standing/win-rate blended
 * with it).
 */
export interface SyntheticCrowdSignalSnapshot {
  readonly optionSeatIds: readonly string[];
  readonly favorabilityWeights: Readonly<Record<string, number>>;
  /**
   * Seats the caller has structurally ruled out — currently holding zero
   * of whatever "territory" means for this game, per the released data,
   * not merely "priced low." Optional and additive: omitting it (or
   * passing an empty set) changes nothing. Exists so `decideSyntheticCrowdOrder`
   * can refuse to ever BUY a seat the data says cannot win, even if a
   * persona's own derived fair value (e.g. momentum-chaser extrapolating
   * pure price trend) would otherwise manufacture a buy signal on it —
   * `favorabilityWeights` alone can't carry this distinction reliably,
   * since a near-floor weight is ambiguous with "no data yet" (see
   * `SyntheticCrowdLiveDriver`'s baseline-liquidity noise, which
   * legitimately uses the same small range while genuinely uninformed).
   */
  readonly deadSeatIds?: ReadonlySet<string>;
}

export interface SyntheticCrowdMarketState {
  readonly outcomeSeatIds: readonly string[];
  readonly b: number;
  readonly q: readonly number[];
  /** Display prices (0..100), aligned to `outcomeSeatIds`. */
  readonly prices: readonly number[];
  readonly status: "open" | "settled";
  readonly winnerSeatId: string | null;
  /** Highest sequence currently live-visible — pass through to `submitMarketOrder`. */
  readonly liveVisibleSequence: number;
}

export interface SyntheticCrowdTrade {
  readonly id?: string;
  readonly participantId: string;
  readonly seatId: string;
  readonly side: "buy" | "sell";
  readonly shares: number;
  readonly chips: number;
  readonly avgPrice: number;
  readonly executedAt?: string;
}

/**
 * Minimal surface the crowd needs from the live market — duck-typed against
 * the production `ReplayPremiereInteractions` methods of the same name.
 * There is no bot-only path: this is the exact serialized order queue real
 * participants call, with the exact same session-ownership and
 * idempotency-key discipline. A test double MUST implement the same
 * continuous-trading and idempotency semantics to be a faithful stand-in.
 */
export interface SyntheticCrowdMarketTarget {
  /** Pass `null` — the crowd tracks its own holdings locally and never needs the server's positions projection. */
  readMarketState(participantId: string | null): SyntheticCrowdMarketState | null;
  createViewerSession(options: {
    participantId: string;
    idempotencyKey: string;
    requesterBucketId: string;
    visible: boolean;
    observedSequence: number;
    excludedAsOperator: boolean;
    excludedAsBot: boolean;
  }): Promise<{ session: { id: string } }>;
  submitMarketOrder(options: {
    participantId: string;
    participantKind: "real" | "synthetic";
    sessionId: string;
    idempotencyKey: string;
    requesterBucketId: string;
    seatId: string;
    side: "buy" | "sell";
    sequence: number;
    amount: number;
    limitPrice: number;
  }): Promise<{ trade: SyntheticCrowdTrade; idempotent: boolean }>;
}

export type SyntheticCrowdOrderSkipReason =
  | "market_not_open"
  | "inactive"
  | "no_signal"
  | "order_rejected";

interface SyntheticCrowdLogEntryBase {
  readonly botIndex: number;
  readonly participantId: string;
  readonly persona: SyntheticCrowdPersonaKind;
  /** Match progress (0..1) this action attempt happened at. */
  readonly matchProgress: number;
}

export interface SyntheticCrowdOrderLogEntry extends SyntheticCrowdLogEntryBase {
  readonly kind: "order";
  readonly side: "buy" | "sell";
  readonly seatId: string;
  readonly shares: number;
  readonly chips: number;
  readonly avgPrice: number;
}

export interface SyntheticCrowdSkipLogEntry extends SyntheticCrowdLogEntryBase {
  readonly kind: "skip";
  readonly reason: SyntheticCrowdOrderSkipReason;
  readonly detail?: string;
}

export type SyntheticCrowdLogEntry =
  | SyntheticCrowdOrderLogEntry
  | SyntheticCrowdSkipLogEntry;

export interface SyntheticCrowdFrameResult {
  readonly matchProgress: number;
  readonly entries: readonly SyntheticCrowdLogEntry[];
}
