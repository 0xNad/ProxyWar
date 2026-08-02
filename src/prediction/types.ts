/**
 * Proxy War — Prediction Competition: shared domain contract.
 *
 * Spec: docs/project-state/2026-07-25-BETTING-SPEC.md
 *
 * INVARIANTS THIS MODULE EXISTS TO ENFORCE
 *  - All money is integer play-credits. No floats anywhere in the ledger.
 *  - Multipliers are integer basis points (10000 == 1.0x).
 *  - Every market is per-seat; the player chooses the seat.
 *  - Markets are only offered for seats alive at the checkpoint.
 *  - A fixture, once seen, is never replayed.
 */

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Integer play-credits. Never a float. */
export type Credits = number;

/** Integer basis points. 10000 === 1.0x. */
export type BasisPoints = number;

export const BP_ONE = 10_000;

/** Payout for a winning stake. Integer in, integer out, floor semantics. */
export function payout(stake: Credits, multiplierBp: BasisPoints): Credits {
  if (!Number.isInteger(stake) || stake < 0) {
    throw new RangeError(`stake must be a non-negative integer, got ${stake}`);
  }
  if (!Number.isInteger(multiplierBp) || multiplierBp < 0) {
    throw new RangeError(
      `multiplierBp must be a non-negative integer, got ${multiplierBp}`,
    );
  }
  return Math.floor((stake * multiplierBp) / BP_ONE);
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

export const MARKET_KINDS = [
  "winner",
  "survives",
  "next_elimination",
  "gains_share",
] as const;

export type MarketKind = (typeof MARKET_KINDS)[number];

/** Stable identifier: `${fixtureId}:${checkpointIndex}:${kind}`. */
export type MarketId = string;

export function marketId(
  fixtureId: FixtureId,
  checkpointIndex: CheckpointIndex,
  kind: MarketKind,
): MarketId {
  return `${fixtureId}:${checkpointIndex}:${kind}`;
}

export type FixtureId = string;
export type SeatId = string;

/** v1 has exactly two checkpoints, at ~35% and ~65%. */
export type CheckpointIndex = 0 | 1;

export const CHECKPOINT_FRACTIONS = [0.35, 0.65] as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface SeatSnapshot {
  readonly seatId: SeatId;
  readonly name: string;
  /** Territory share in basis points of total owned land. Integer. */
  readonly shareBp: BasisPoints;
  readonly alive: boolean;
}

export interface Checkpoint {
  readonly index: CheckpointIndex;
  readonly turn: number;
  /** Seats as they stood at this checkpoint. */
  readonly seats: readonly SeatSnapshot[];
  /**
   * Resolution turn for `survives` and `gains_share`.
   * = checkpoint turn + 40% of remaining turns, fixed at build time.
   */
  readonly resolutionTurn: number;
}

export interface FixtureOutcome {
  readonly winnerSeatId: SeatId | null;
  /** Elimination order, earliest first. Seats never eliminated are absent. */
  readonly eliminationOrder: readonly { seatId: SeatId; turn: number }[];
  /** shareBp per seat at each checkpoint's resolutionTurn, keyed by checkpoint index. */
  readonly shareAtResolution: readonly Readonly<Record<SeatId, BasisPoints>>[];
  readonly finalTurn: number;
}

/**
 * One playback keyframe: territory share and alive status per seat, in the
 * same seat order as `Fixture.checkpoints[*].seats`. Downsampled from the
 * full per-tick simulation (~200 frames per match, evenly spaced, with both
 * checkpoint turns always included exactly) — smooth enough for playback,
 * bounded in size regardless of match length. See `src/prediction/generate`
 * generation report for why a full-fidelity per-tick game-record replay
 * wasn't used instead (map-catalog mismatch between the local headless
 * generator and the client's production map loader).
 */
export interface ReplayFrame {
  readonly turn: number;
  readonly shareBp: readonly BasisPoints[];
  readonly alive: readonly boolean[];
}

export interface FixtureReplay {
  readonly frames: readonly ReplayFrame[];
}

export interface Fixture {
  readonly id: FixtureId;
  readonly seed: number;
  readonly map: string;
  readonly mapSize: string;
  readonly nationCount: number;
  /**
   * How many of `nationCount` requested nations actually spawned onto the
   * map (held territory at the end of the spawn phase). Equal to
   * `nationCount` for a healthy match; generation-time diagnostic for
   * map/nation-count compatibility — see the generation report. A fixture
   * with `nationsSpawned < nationCount` still passed the quality gate (>= 3
   * seats alive at both checkpoints, no seat over ~80% at checkpoint 0), it
   * just started with fewer live seats than requested. Optional so hand-
   * written stub fixtures (tests, dev fixtures) don't need to set it.
   */
  readonly nationsSpawned?: number;
  readonly checkpoints: readonly [Checkpoint, Checkpoint];
  /**
   * Ground truth. MUST NOT be reachable from view-layer state before the
   * relevant checkpoint closes — see SPEC §9.
   */
  readonly outcome: FixtureOutcome;
  /**
   * Playback data for "replay plays from turn 0 to checkpoint 1... resumes
   * to checkpoint 2... resumes to the end" (SPEC §4). Present only on play-
   * pool fixtures — calibration/validation are fit/scored from
   * `checkpoints`/`outcome` alone and never rendered, so they omit it to
   * stay small and fast to generate.
   */
  readonly replay?: FixtureReplay;
}

// ---------------------------------------------------------------------------
// Eligibility — applies identically to the UI and the calibration pipeline.
// A test asserts both call this. SPEC §3.
// ---------------------------------------------------------------------------

export function eligibleSeats(
  checkpoint: Checkpoint,
): readonly SeatSnapshot[] {
  return checkpoint.seats.filter((s) => s.alive);
}

// ---------------------------------------------------------------------------
// Player actions and ledger
// ---------------------------------------------------------------------------

export interface Stake {
  readonly fixtureId: FixtureId;
  readonly checkpointIndex: CheckpointIndex;
  readonly kind: MarketKind;
  readonly seatId: SeatId;
  readonly amount: Credits;
  readonly multiplierBp: BasisPoints;
  readonly placedAtIso: string;
}

export type ResolutionState = "won" | "lost" | "void";

export interface Resolution {
  readonly fixtureId: FixtureId;
  readonly checkpointIndex: CheckpointIndex;
  readonly kind: MarketKind;
  readonly state: ResolutionState;
  /** Credits returned: payout on win, stake on void, 0 on loss. */
  readonly returned: Credits;
  readonly resolvedAtIso: string;
}

export const STARTING_BANKROLL: Credits = 1_000;
export const MIN_STAKE: Credits = 10;
export const BUST_THRESHOLD: Credits = MIN_STAKE;
export const SEASON_FIXTURE_COUNT = 25;

/** Max stake is 50% of current bankroll, floored, but never below MIN_STAKE. */
export function maxStake(bankroll: Credits): Credits {
  return Math.max(MIN_STAKE, Math.floor(bankroll / 2));
}

export interface Season {
  readonly index: number;
  readonly fixtureIds: readonly FixtureId[];
  readonly bankroll: Credits;
  readonly stakes: readonly Stake[];
  readonly resolutions: readonly Resolution[];
  readonly startedAtIso: string;
}

/**
 * The ledger invariant. Holds at all times, for every season.
 * SPEC §6 — property-tested over randomised action sequences.
 */
export function ledgerHolds(season: Season): boolean {
  const staked = season.stakes.reduce((a, s) => a + s.amount, 0);
  const returned = season.resolutions.reduce((a, r) => a + r.returned, 0);
  return season.bankroll === STARTING_BANKROLL - staked + returned;
}

export interface SeasonSummary {
  readonly index: number;
  readonly finalBankroll: Credits;
  /** (returned − staked) / staked, in basis points. Null when nothing staked. */
  readonly roiBp: BasisPoints | null;
  /** correct / resolved, voids excluded, in basis points. Null when none resolved. */
  readonly accuracyBp: BasisPoints | null;
  readonly resolvedCount: number;
  readonly startedAtIso: string;
}
