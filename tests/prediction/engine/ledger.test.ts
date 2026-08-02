/**
 * Unit tests for src/prediction/engine/ledger.ts — SPEC §6/§8/§9: stake
 * validation, resolution application, and the idempotency/no-double-stake
 * guarantees refresh-safety depends on.
 */
import { describe, expect, it } from "vitest";

import {
  applyResolution,
  applyStake,
  buildResolution,
  canStake,
  computeBankroll,
  LedgerError,
} from "../../../src/prediction/engine/ledger";
import {
  ledgerHolds,
  maxStake,
  MIN_STAKE,
  payout,
  STARTING_BANKROLL,
  type Resolution,
  type Season,
  type Stake,
} from "../../../src/prediction/types";

function makeStake(overrides: Partial<Stake> = {}): Stake {
  return {
    fixtureId: "fx-1",
    checkpointIndex: 0,
    kind: "winner",
    seatId: "a",
    amount: 20,
    multiplierBp: 20_000, // 2.0x
    placedAtIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSeason(overrides: Partial<Season> = {}): Season {
  return {
    index: 0,
    fixtureIds: ["fx-1", "fx-2"],
    bankroll: STARTING_BANKROLL,
    stakes: [],
    resolutions: [],
    startedAtIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyStake()", () => {
  it("appends the stake and debits the bankroll", () => {
    const season = makeSeason();
    const stake = makeStake({ amount: 30 });
    const next = applyStake(season, stake);
    expect(next.stakes).toEqual([stake]);
    expect(next.bankroll).toBe(STARTING_BANKROLL - 30);
    expect(ledgerHolds(next)).toBe(true);
  });

  it("rejects a non-integer amount", () => {
    const season = makeSeason();
    expect(() => applyStake(season, makeStake({ amount: 10.5 }))).toThrow(LedgerError);
  });

  it("rejects an amount below MIN_STAKE", () => {
    const season = makeSeason();
    expect(() => applyStake(season, makeStake({ amount: MIN_STAKE - 1 }))).toThrow(LedgerError);
  });

  it("accepts exactly MIN_STAKE", () => {
    const season = makeSeason();
    const next = applyStake(season, makeStake({ amount: MIN_STAKE }));
    expect(next.bankroll).toBe(STARTING_BANKROLL - MIN_STAKE);
  });

  it("rejects an amount above maxStake(bankroll)", () => {
    const season = makeSeason({ bankroll: 100 });
    const cap = maxStake(100);
    expect(() => applyStake(season, makeStake({ amount: cap + 1 }))).toThrow(LedgerError);
  });

  it("accepts exactly maxStake(bankroll)", () => {
    // Reach bankroll 100 through a real sequence of stake-then-lose steps
    // (each respecting the cap at the time), since bankroll is always
    // derived from STARTING_BANKROLL - Σstakes + Σreturns — it can't be set
    // independently of ledger history.
    let season = makeSeason();
    let fixture = 0;
    for (const amount of [500, 250, 125, 25]) {
      const lossStake = makeStake({ fixtureId: `prior-${fixture++}`, amount });
      season = applyStake(season, lossStake);
      season = applyResolution(
        season,
        buildResolution(lossStake, "lost", "2026-01-02T00:00:00.000Z"),
      );
    }
    expect(season.bankroll).toBe(100);
    const cap = maxStake(100);
    const next = applyStake(season, makeStake({ fixtureId: "fx-final", amount: cap }));
    expect(next.bankroll).toBe(100 - cap);
  });

  it("rejects any stake once the season is busted", () => {
    const season = makeSeason({ bankroll: MIN_STAKE - 1 });
    expect(() => applyStake(season, makeStake({ amount: MIN_STAKE }))).toThrow(LedgerError);
  });

  it("rejects a second, different stake on the same market key (double-stake)", () => {
    const season = applyStake(makeSeason(), makeStake({ amount: 20 }));
    expect(() =>
      applyStake(season, makeStake({ amount: 25, placedAtIso: "2026-01-02T00:00:00.000Z" })),
    ).toThrow(LedgerError);
  });

  it("is idempotent: replaying the identical stake is a no-op", () => {
    const stake = makeStake({ amount: 20 });
    const season = applyStake(makeSeason(), stake);
    const replayed = applyStake(season, stake);
    expect(replayed).toBe(season); // same reference, not just equal
    expect(replayed.bankroll).toBe(STARTING_BANKROLL - 20);
  });

  it("allows two stakes on the same fixture at different checkpoints/kinds", () => {
    let season = makeSeason();
    season = applyStake(season, makeStake({ checkpointIndex: 0, kind: "winner", amount: 20 }));
    season = applyStake(season, makeStake({ checkpointIndex: 1, kind: "winner", amount: 20 }));
    season = applyStake(season, makeStake({ checkpointIndex: 0, kind: "survives", amount: 20 }));
    expect(season.stakes).toHaveLength(3);
    expect(ledgerHolds(season)).toBe(true);
  });
});

describe("canStake()", () => {
  it("is true before a stake exists for the key and false after", () => {
    const season = makeSeason();
    expect(canStake(season, "fx-1", 0, "winner")).toBe(true);
    const next = applyStake(season, makeStake());
    expect(canStake(next, "fx-1", 0, "winner")).toBe(false);
  });
});

describe("buildResolution()", () => {
  const stake = makeStake({ amount: 20, multiplierBp: 30_000 });

  it("returns floor(stake * multiplierBp / BP_ONE) on win", () => {
    const resolution = buildResolution(stake, "won", "2026-01-02T00:00:00.000Z");
    expect(resolution.returned).toBe(payout(20, 30_000));
    expect(resolution.returned).toBe(60);
  });

  it("returns the stake back on void", () => {
    const resolution = buildResolution(stake, "void", "2026-01-02T00:00:00.000Z");
    expect(resolution.returned).toBe(20);
  });

  it("returns zero on loss", () => {
    const resolution = buildResolution(stake, "lost", "2026-01-02T00:00:00.000Z");
    expect(resolution.returned).toBe(0);
  });
});

describe("applyResolution()", () => {
  it("appends the resolution and credits the bankroll", () => {
    const stake = makeStake({ amount: 20, multiplierBp: 30_000 });
    const season = applyStake(makeSeason(), stake);
    const resolution = buildResolution(stake, "won", "2026-01-02T00:00:00.000Z");
    const next = applyResolution(season, resolution);
    expect(next.bankroll).toBe(STARTING_BANKROLL - 20 + 60);
    expect(ledgerHolds(next)).toBe(true);
  });

  it("rejects a resolution with no matching stake", () => {
    const season = makeSeason();
    const resolution: Resolution = {
      fixtureId: "fx-1",
      checkpointIndex: 0,
      kind: "winner",
      state: "won",
      returned: 40,
      resolvedAtIso: "2026-01-02T00:00:00.000Z",
    };
    expect(() => applyResolution(season, resolution)).toThrow(LedgerError);
  });

  it("rejects a resolution whose returned amount doesn't match the stake", () => {
    const stake = makeStake({ amount: 20, multiplierBp: 30_000 });
    const season = applyStake(makeSeason(), stake);
    const forged: Resolution = {
      fixtureId: stake.fixtureId,
      checkpointIndex: stake.checkpointIndex,
      kind: stake.kind,
      state: "won",
      returned: 1_000_000, // does not match payout(20, 30000) = 60
      resolvedAtIso: "2026-01-02T00:00:00.000Z",
    };
    expect(() => applyResolution(season, forged)).toThrow(LedgerError);
  });

  it("is idempotent: replaying the identical resolution is a no-op", () => {
    const stake = makeStake({ amount: 20, multiplierBp: 30_000 });
    let season = applyStake(makeSeason(), stake);
    const resolution = buildResolution(stake, "won", "2026-01-02T00:00:00.000Z");
    season = applyResolution(season, resolution);
    const replayed = applyResolution(season, resolution);
    expect(replayed).toBe(season);
  });

  it("rejects a second, different resolution for an already-resolved market (double-pay)", () => {
    const stake = makeStake({ amount: 20, multiplierBp: 30_000 });
    let season = applyStake(makeSeason(), stake);
    season = applyResolution(season, buildResolution(stake, "won", "2026-01-02T00:00:00.000Z"));
    expect(() =>
      applyResolution(season, buildResolution(stake, "lost", "2026-01-03T00:00:00.000Z")),
    ).toThrow(LedgerError);
  });
});

describe("computeBankroll()", () => {
  it("matches the ledgerHolds() formula", () => {
    const season = { stakes: [makeStake({ amount: 20 })], resolutions: [] as Resolution[] };
    expect(computeBankroll(season)).toBe(STARTING_BANKROLL - 20);
  });
});
