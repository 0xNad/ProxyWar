/**
 * Ledger — SPEC §6, §8, §9.
 *
 * Pure, immutable transitions over `Season`. Every function returns a new
 * `Season`; none of them touch storage. `ledgerHolds()` (from the shared
 * contract) must be true after every transition here — that's the property
 * the tests in tests/prediction hammer on.
 *
 * Idempotency: replaying the identical `Stake`/`Resolution` for a market key
 * that has already been applied is a safe no-op (refresh-mid-action safety,
 * SPEC §9). Applying a *different* stake/resolution for an already-used key
 * is a `LedgerError` — that is the double-stake/double-pay guard.
 */
import {
  type Credits,
  type CheckpointIndex,
  type FixtureId,
  type MarketKind,
  type Resolution,
  type ResolutionState,
  type Season,
  type Stake,
  BUST_THRESHOLD,
  MIN_STAKE,
  STARTING_BANKROLL,
  marketId,
  maxStake,
  payout,
} from "../types";

export class LedgerError extends Error {}

/** `STARTING_BANKROLL - Σstakes + Σreturns` — the same formula `ledgerHolds()` checks. */
export function computeBankroll(
  season: Pick<Season, "stakes" | "resolutions">,
): Credits {
  const staked = season.stakes.reduce((a, s) => a + s.amount, 0);
  const returned = season.resolutions.reduce((a, r) => a + r.returned, 0);
  return STARTING_BANKROLL - staked + returned;
}

function findStake(
  season: Season,
  fixtureId: FixtureId,
  checkpointIndex: CheckpointIndex,
  kind: MarketKind,
): Stake | undefined {
  return season.stakes.find(
    (s) =>
      s.fixtureId === fixtureId &&
      s.checkpointIndex === checkpointIndex &&
      s.kind === kind,
  );
}

/** No existing stake occupies this market's key yet. */
export function canStake(
  season: Season,
  fixtureId: FixtureId,
  checkpointIndex: CheckpointIndex,
  kind: MarketKind,
): boolean {
  return findStake(season, fixtureId, checkpointIndex, kind) === undefined;
}

export function stakesEqual(a: Stake, b: Stake): boolean {
  return (
    a.fixtureId === b.fixtureId &&
    a.checkpointIndex === b.checkpointIndex &&
    a.kind === b.kind &&
    a.seatId === b.seatId &&
    a.amount === b.amount &&
    a.multiplierBp === b.multiplierBp &&
    a.placedAtIso === b.placedAtIso
  );
}

export function applyStake(season: Season, stake: Stake): Season {
  if (!Number.isInteger(stake.amount)) {
    throw new LedgerError(`stake amount must be an integer, got ${stake.amount}`);
  }
  if (season.bankroll < BUST_THRESHOLD) {
    throw new LedgerError("season is busted; no further stakes are allowed");
  }
  if (stake.amount < MIN_STAKE) {
    throw new LedgerError(
      `stake amount ${stake.amount} is below MIN_STAKE (${MIN_STAKE})`,
    );
  }
  const cap = Math.min(maxStake(season.bankroll), season.bankroll);
  if (stake.amount > cap) {
    throw new LedgerError(
      `stake amount ${stake.amount} exceeds the cap ${cap} (bankroll ${season.bankroll})`,
    );
  }

  const existing = findStake(
    season,
    stake.fixtureId,
    stake.checkpointIndex,
    stake.kind,
  );
  if (existing !== undefined) {
    if (stakesEqual(existing, stake)) return season; // idempotent replay
    throw new LedgerError(
      `double-stake on market ${marketId(stake.fixtureId, stake.checkpointIndex, stake.kind)}`,
    );
  }

  const stakes = [...season.stakes, stake];
  return { ...season, stakes, bankroll: computeBankroll({ ...season, stakes }) };
}

/** `returned` per SPEC §5.2/§6: payout on win, the stake back on void, 0 on loss. */
export function buildResolution(
  stake: Stake,
  state: ResolutionState,
  resolvedAtIso: string,
): Resolution {
  const returned =
    state === "won"
      ? payout(stake.amount, stake.multiplierBp)
      : state === "void"
        ? stake.amount
        : 0;
  return {
    fixtureId: stake.fixtureId,
    checkpointIndex: stake.checkpointIndex,
    kind: stake.kind,
    state,
    returned,
    resolvedAtIso,
  };
}

function findResolution(
  season: Season,
  fixtureId: FixtureId,
  checkpointIndex: CheckpointIndex,
  kind: MarketKind,
): Resolution | undefined {
  return season.resolutions.find(
    (r) =>
      r.fixtureId === fixtureId &&
      r.checkpointIndex === checkpointIndex &&
      r.kind === kind,
  );
}

export function resolutionsEqual(a: Resolution, b: Resolution): boolean {
  return (
    a.fixtureId === b.fixtureId &&
    a.checkpointIndex === b.checkpointIndex &&
    a.kind === b.kind &&
    a.state === b.state &&
    a.returned === b.returned &&
    a.resolvedAtIso === b.resolvedAtIso
  );
}

export function applyResolution(season: Season, resolution: Resolution): Season {
  const stake = findStake(
    season,
    resolution.fixtureId,
    resolution.checkpointIndex,
    resolution.kind,
  );
  if (stake === undefined) {
    throw new LedgerError(
      `no stake found for market ${marketId(resolution.fixtureId, resolution.checkpointIndex, resolution.kind)}; cannot resolve`,
    );
  }

  const existing = findResolution(
    season,
    resolution.fixtureId,
    resolution.checkpointIndex,
    resolution.kind,
  );
  if (existing !== undefined) {
    if (resolutionsEqual(existing, resolution)) return season; // idempotent replay
    throw new LedgerError(
      `double-resolution on market ${marketId(resolution.fixtureId, resolution.checkpointIndex, resolution.kind)}`,
    );
  }

  // Defense in depth: `returned` must match what this stake+state actually
  // pays out, so a corrupt/forged Resolution can never break ledgerHolds().
  const expected = buildResolution(stake, resolution.state, resolution.resolvedAtIso);
  if (expected.returned !== resolution.returned) {
    throw new LedgerError(
      `resolution.returned (${resolution.returned}) does not match the amount computed from the stake (${expected.returned})`,
    );
  }

  const resolutions = [...season.resolutions, resolution];
  return {
    ...season,
    resolutions,
    bankroll: computeBankroll({ ...season, resolutions }),
  };
}
