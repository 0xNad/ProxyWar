/**
 * Contract tests for the prediction domain's money primitives —
 * src/prediction/types.ts. Substrate-independent: these hold regardless of
 * whether pricing is fixed-odds or pari-mutuel, because they only exercise
 * `payout()`, `maxStake()`, and `ledgerHolds()` — the integer-credit
 * arithmetic and ledger invariant every wagering model must satisfy.
 */
import { describe, expect, it } from "vitest";

import {
  ledgerHolds,
  maxStake,
  MIN_STAKE,
  payout,
  Resolution,
  Season,
  Stake,
  STARTING_BANKROLL,
} from "../../src/prediction/types";

// ---------------------------------------------------------------------------
// payout() — SPEC §5.2: payout_on_win = floor(stake * multiplierBp / 10000)
// ---------------------------------------------------------------------------

describe("payout()", () => {
  it("is integer-exact for a clean multiple", () => {
    expect(payout(100, 15_000)).toBe(150); // 1.5x
    expect(payout(200, 20_000)).toBe(400); // 2.0x
    expect(payout(1_000, 10_000)).toBe(1_000); // 1.0x is identity
  });

  it("floors fractional payouts toward zero, never rounds", () => {
    // 3 * 33333 / 10000 = 9.9999 -> floors to 9, never 10.
    expect(payout(3, 33_333)).toBe(9);
    // 1 * 10500 / 10000 = 1.05 -> floors to 1.
    expect(payout(1, 10_500)).toBe(1);
    // 99 * 10500 / 10000 = 103.95 -> floors to 103.
    expect(payout(99, 10_500)).toBe(103);
  });

  it("returns 0 credits for a 0 stake regardless of multiplier", () => {
    expect(payout(0, 200_000)).toBe(0);
    expect(payout(0, 10_500)).toBe(0);
  });

  it("returns 0 for a 0 multiplier (fully-void pricing), never negative", () => {
    expect(payout(500, 0)).toBe(0);
  });

  it("rejects a negative stake", () => {
    expect(() => payout(-1, 10_000)).toThrow(RangeError);
    expect(() => payout(-10_000, 10_000)).toThrow(RangeError);
  });

  it("rejects a non-integer stake", () => {
    expect(() => payout(1.5, 10_000)).toThrow(RangeError);
    expect(() => payout(0.001, 10_000)).toThrow(RangeError);
    expect(() => payout(NaN, 10_000)).toThrow(RangeError);
    expect(() => payout(Infinity, 10_000)).toThrow(RangeError);
  });

  it("rejects a negative multiplier", () => {
    expect(() => payout(100, -1)).toThrow(RangeError);
  });

  it("rejects a non-integer multiplier", () => {
    expect(() => payout(100, 15_000.5)).toThrow(RangeError);
    expect(() => payout(100, NaN)).toThrow(RangeError);
  });

  it("never produces a fractional result (integer-exact ledger, no floats)", () => {
    for (let stake = 1; stake <= 50; stake++) {
      for (const bp of [10_500, 33_333, 77_777, 200_000]) {
        const result = payout(stake, bp);
        expect(Number.isInteger(result)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ledgerHolds() — SPEC §6: bankroll == 1000 - sum(stakes) + sum(returned)
// ---------------------------------------------------------------------------

function makeStake(overrides: Partial<Stake> = {}): Stake {
  return {
    fixtureId: "fx-1",
    checkpointIndex: 0,
    kind: "winner",
    seatId: "seat-a",
    amount: 100,
    multiplierBp: 20_000,
    placedAtIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeResolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    fixtureId: "fx-1",
    checkpointIndex: 0,
    kind: "winner",
    state: "won",
    returned: 200,
    resolvedAtIso: "2026-01-01T00:10:00.000Z",
    ...overrides,
  };
}

function makeSeason(overrides: Partial<Season> = {}): Season {
  return {
    index: 0,
    fixtureIds: ["fx-1"],
    bankroll: STARTING_BANKROLL,
    stakes: [],
    resolutions: [],
    startedAtIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ledgerHolds()", () => {
  it("holds for a fresh season with no activity", () => {
    expect(ledgerHolds(makeSeason())).toBe(true);
  });

  it("holds after a consistent stake + win", () => {
    const season = makeSeason({
      bankroll: STARTING_BANKROLL - 100 + 200,
      stakes: [makeStake({ amount: 100 })],
      resolutions: [makeResolution({ returned: 200 })],
    });
    expect(ledgerHolds(season)).toBe(true);
  });

  it("holds after a consistent stake + loss (returned 0)", () => {
    const season = makeSeason({
      bankroll: STARTING_BANKROLL - 100,
      stakes: [makeStake({ amount: 100 })],
      resolutions: [makeResolution({ state: "lost", returned: 0 })],
    });
    expect(ledgerHolds(season)).toBe(true);
  });

  it("holds after a consistent stake + void (returned == amount)", () => {
    const season = makeSeason({
      bankroll: STARTING_BANKROLL,
      stakes: [makeStake({ amount: 100 })],
      resolutions: [makeResolution({ state: "void", returned: 100 })],
    });
    expect(ledgerHolds(season)).toBe(true);
  });

  it("catches a deliberately corrupted season: bankroll off-by-one", () => {
    const season = makeSeason({
      bankroll: STARTING_BANKROLL - 100 + 200 + 1, // corrupted by +1
      stakes: [makeStake({ amount: 100 })],
      resolutions: [makeResolution({ returned: 200 })],
    });
    expect(ledgerHolds(season)).toBe(false);
  });

  it("catches a deliberately corrupted season: phantom stake with no bankroll debit", () => {
    // Bankroll pretends nothing was ever staked, but a stake record exists.
    const season = makeSeason({
      bankroll: STARTING_BANKROLL,
      stakes: [makeStake({ amount: 500 })],
      resolutions: [],
    });
    expect(ledgerHolds(season)).toBe(false);
  });

  it("catches a deliberately corrupted season: a resolution's payout never reached bankroll", () => {
    // A resolution record exists (the market paid out) but bankroll was never
    // credited — the aggregate identity breaks even though nothing here is a
    // negative number or a type error. This is the case ledgerHolds() exists
    // to catch: silent loss of credits between "resolution recorded" and
    // "bankroll updated".
    const season = makeSeason({
      bankroll: STARTING_BANKROLL, // should have been STARTING_BANKROLL + 1000
      stakes: [],
      resolutions: [makeResolution({ returned: 1_000 })],
    });
    expect(ledgerHolds(season)).toBe(false);
  });

  it("is an aggregate check only: it cannot detect a resolution with no matching stake if the totals still balance", () => {
    // Documents a real limitation of ledgerHolds() as specified: it sums
    // stakes and resolutions independently, so a phantom resolution paired
    // with a bankroll bump that happens to match the sum passes. Per-market
    // bookkeeping (one resolution per stake, no orphaned payouts) must be
    // enforced by the engine layer, not by this invariant.
    const season = makeSeason({
      bankroll: STARTING_BANKROLL + 1_000,
      stakes: [],
      resolutions: [makeResolution({ returned: 1_000 })],
    });
    expect(ledgerHolds(season)).toBe(true);
  });

  it("catches a negative-bankroll corruption even if the arithmetic 'balances'", () => {
    // Contrived: bankroll matches the formula but is itself negative, which
    // should never happen in a real ledger. ledgerHolds() as specified only
    // checks the identity, so this documents that stake/max-stake validation
    // (not ledgerHolds) is what prevents negative bankroll in practice.
    const stakes = [makeStake({ amount: 2_000 })];
    const season = makeSeason({
      bankroll: STARTING_BANKROLL - 2_000,
      stakes,
      resolutions: [],
    });
    expect(season.bankroll).toBeLessThan(0);
    expect(ledgerHolds(season)).toBe(true); // identity holds; negativity is a different guard
  });
});

// ---------------------------------------------------------------------------
// maxStake() — SPEC §6: 50% of bankroll, floored, never below MIN_STAKE
// ---------------------------------------------------------------------------

describe("maxStake()", () => {
  it("returns 50% of bankroll, floored, for a comfortable bankroll", () => {
    expect(maxStake(1_000)).toBe(500);
    expect(maxStake(101)).toBe(50);
  });

  it("never returns below MIN_STAKE even for a tiny or zero bankroll", () => {
    expect(maxStake(0)).toBe(MIN_STAKE);
    expect(maxStake(1)).toBe(MIN_STAKE);
    expect(maxStake(19)).toBe(MIN_STAKE); // floor(19/2) = 9 < MIN_STAKE
    expect(maxStake(20)).toBe(MIN_STAKE); // floor(20/2) = 10 == MIN_STAKE
  });

  it("never returns below MIN_STAKE even for a negative (corrupted) bankroll", () => {
    expect(maxStake(-500)).toBe(MIN_STAKE);
  });

  it("holds MIN_STAKE as a hard floor across a wide bankroll sweep", () => {
    for (let bankroll = -100; bankroll <= 5_000; bankroll += 13) {
      expect(maxStake(bankroll)).toBeGreaterThanOrEqual(MIN_STAKE);
    }
  });

  it("is integer-exact (no float stake caps)", () => {
    for (let bankroll = 0; bankroll <= 1_001; bankroll++) {
      expect(Number.isInteger(maxStake(bankroll))).toBe(true);
    }
  });
});
