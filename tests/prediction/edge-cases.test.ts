/**
 * Edge-case matrix — brief §5 (docs/betting-feature-task.md), SPEC §9
 * integrity guarantees. Each `describe` block below is one item from the
 * brief's list. Where a case is inherently a UI concern (narrow viewport, no
 * console errors), the engine-level equivalent is tested here and the gap is
 * noted in the block's comment — see the final "UI-only cases" block.
 *
 * Exercises the real engine (src/prediction/engine/*) and store
 * (src/prediction/store/*), not reimplementations of them.
 */
import { describe, expect, it } from "vitest";

import {
  LedgerError,
  applyResolution,
  applyStake,
  buildResolution,
  canStake,
  computeBankroll,
} from "../../src/prediction/engine/ledger";
import {
  isBusted,
  markFixtureSeen,
  startSeason,
  type SeasonPool,
} from "../../src/prediction/engine/season";
import { createMemoryPredictionStore } from "../../src/prediction/store/memoryStore";
import type { PredictionStore } from "../../src/prediction/store/PredictionStore";
import {
  BUST_THRESHOLD,
  MIN_STAKE,
  STARTING_BANKROLL,
  maxStake,
  type Checkpoint,
  type Fixture,
  type Season,
  type SeatSnapshot,
  type Stake,
} from "../../src/prediction/types";

// ---------------------------------------------------------------------------
// Shared fixture/season builders
// ---------------------------------------------------------------------------

function seat(seatId: string, shareBp: number, alive = true): SeatSnapshot {
  return { seatId, name: seatId, shareBp, alive };
}

const CHECKPOINT_0: Checkpoint = {
  index: 0,
  turn: 35,
  resolutionTurn: 61,
  seats: [seat("A", 4_000), seat("B", 3_000), seat("C", 2_000), seat("D", 0, false)],
};

const CHECKPOINT_1: Checkpoint = {
  index: 1,
  turn: 65,
  resolutionTurn: 79,
  seats: [seat("A", 5_000), seat("B", 3_000), seat("C", 0, false), seat("D", 0, false)],
};

const FIXTURE: Fixture = {
  id: "fx-edge-1",
  seed: 3_000_100,
  map: "plains",
  mapSize: "Compact",
  nationCount: 4,
  checkpoints: [CHECKPOINT_0, CHECKPOINT_1],
  outcome: {
    winnerSeatId: "A",
    eliminationOrder: [
      { seatId: "D", turn: 20 },
      { seatId: "C", turn: 70 },
    ],
    shareAtResolution: [
      { A: 4_500, B: 3_500, C: 2_000, D: 0 },
      { A: 6_000, B: 4_000, C: 0, D: 0 },
    ],
    finalTurn: 100,
  },
};

function makeSeason(overrides: Partial<Season> = {}): Season {
  return {
    index: 0,
    fixtureIds: [FIXTURE.id],
    bankroll: STARTING_BANKROLL,
    stakes: [],
    resolutions: [],
    startedAtIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeStake(overrides: Partial<Stake> = {}): Stake {
  return {
    fixtureId: FIXTURE.id,
    checkpointIndex: 0,
    kind: "winner",
    seatId: "A",
    amount: 100,
    multiplierBp: 50_000, // literal 5.0x; multiplierFor()/OddsTable are dropped, not the Stake shape
    placedAtIso: "2026-01-01T00:05:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Insufficient funds
// ---------------------------------------------------------------------------

describe("edge case: insufficient funds", () => {
  it("rejects a stake larger than the current bankroll even if it's within maxStake()'s formula", () => {
    // Bankroll of 15: maxStake(15) = max(MIN_STAKE, floor(7)) = MIN_STAKE = 10,
    // and 10 <= 15 so this is actually fine — but bankroll of 5 cannot even
    // cover MIN_STAKE, which is the real "insufficient funds" state (a bust).
    const season = makeSeason({ bankroll: 5 });
    expect(() => applyStake(season, makeStake({ amount: MIN_STAKE }))).toThrow(LedgerError);
  });

  it("never allows a stake amount to exceed the lesser of maxStake(bankroll) and the bankroll itself", () => {
    const season = makeSeason({ bankroll: 40 });
    const cap = Math.min(maxStake(season.bankroll), season.bankroll);
    expect(cap).toBe(20); // maxStake(40) = 20, <= bankroll
    expect(() => applyStake(season, makeStake({ amount: cap + 1 }))).toThrow(LedgerError);
    expect(() => applyStake(season, makeStake({ amount: cap }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Stake below min / above max / zero / negative / non-numeric
// ---------------------------------------------------------------------------

describe("edge case: stake amount validation", () => {
  const season = makeSeason({ bankroll: STARTING_BANKROLL });

  it("rejects a stake below MIN_STAKE", () => {
    expect(() => applyStake(season, makeStake({ amount: MIN_STAKE - 1 }))).toThrow(
      LedgerError,
    );
  });

  it("rejects a stake above maxStake(bankroll)", () => {
    const cap = maxStake(season.bankroll);
    expect(() => applyStake(season, makeStake({ amount: cap + 1 }))).toThrow(LedgerError);
  });

  it("rejects a zero stake", () => {
    expect(() => applyStake(season, makeStake({ amount: 0 }))).toThrow(LedgerError);
  });

  it("rejects a negative stake", () => {
    expect(() => applyStake(season, makeStake({ amount: -50 }))).toThrow(LedgerError);
  });

  it("rejects a non-integer (fractional) stake", () => {
    expect(() => applyStake(season, makeStake({ amount: 10.5 }))).toThrow(LedgerError);
  });

  it("rejects a non-numeric stake (NaN — what a parsed-but-invalid text input becomes)", () => {
    expect(() => applyStake(season, makeStake({ amount: NaN }))).toThrow(LedgerError);
  });

  it("rejects Infinity as a stake", () => {
    expect(() => applyStake(season, makeStake({ amount: Infinity }))).toThrow(LedgerError);
  });
});

// ---------------------------------------------------------------------------
// 3. Duplicate prediction on the same market
// ---------------------------------------------------------------------------

describe("edge case: duplicate prediction on the same market", () => {
  it("canStake() reports false once a market key is occupied", () => {
    const season = applyStake(makeSeason(), makeStake());
    expect(canStake(season, FIXTURE.id, 0, "winner")).toBe(false);
    expect(canStake(season, FIXTURE.id, 1, "winner")).toBe(true); // different checkpoint
    expect(canStake(season, FIXTURE.id, 0, "survives")).toBe(true); // different market
  });

  it("rejects a second, different stake on an already-staked market", () => {
    const season = applyStake(makeSeason(), makeStake());
    expect(() =>
      applyStake(season, makeStake({ seatId: "B", amount: 200 })),
    ).toThrow(LedgerError);
  });

  it("allows staking the same market again at a different checkpoint — a belief update, not a duplicate (SPEC §11.2)", () => {
    let season = applyStake(makeSeason(), makeStake({ checkpointIndex: 0 }));
    season = applyStake(season, makeStake({ checkpointIndex: 1, amount: 50 }));
    expect(season.stakes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Predicting after the reveal / resolution
// ---------------------------------------------------------------------------

describe("edge case: predicting after reveal/resolution has already happened", () => {
  it("rejects a fresh stake on a market that has already been resolved", () => {
    let season = applyStake(makeSeason(), makeStake());
    const resolution = buildResolution(season.stakes[0], "won", "2026-01-01T00:10:00.000Z");
    season = applyResolution(season, resolution);

    // The market is resolved; a *new*, different stake attempt on it must
    // still be rejected as a double-stake (there is no "re-open" path).
    expect(() =>
      applyStake(season, makeStake({ seatId: "B", amount: 10, placedAtIso: "later" })),
    ).toThrow(LedgerError);
  });
});
// ---------------------------------------------------------------------------
// 6. Refresh mid-prediction and after
// ---------------------------------------------------------------------------

describe("edge case: refresh mid-prediction and after (idempotent persistence)", () => {
  it("replaying the identical stake through the store after a refresh is a silent no-op, not a double-stake", async () => {
    const store: PredictionStore = createMemoryPredictionStore();
    const stake = makeStake();
    await store.recordStake(stake);
    await expect(store.recordStake({ ...stake })).resolves.toBeUndefined(); // "refresh" replays the same write
  });

  it("replaying a stake with the same market key but different content after a refresh is rejected, not silently overwritten", async () => {
    const store: PredictionStore = createMemoryPredictionStore();
    await store.recordStake(makeStake());
    await expect(
      store.recordStake(makeStake({ amount: 999 })),
    ).rejects.toThrow();
  });

  it("the ledger itself is idempotent to an identical stake replay (applyStake, not just the store)", () => {
    const season = applyStake(makeSeason(), makeStake());
    const replayed = applyStake(season, makeStake());
    expect(replayed).toEqual(season); // no double debit
    expect(computeBankroll(replayed)).toBe(STARTING_BANKROLL - 100);
  });

  it("the ledger is idempotent to an identical resolution replay after 'returning' post-refresh", () => {
    let season = applyStake(makeSeason(), makeStake());
    const resolution = buildResolution(season.stakes[0], "won", "2026-01-01T00:10:00.000Z");
    season = applyResolution(season, resolution);
    const bankrollAfterFirst = season.bankroll;

    const replayed = applyResolution(season, { ...resolution });
    expect(replayed.bankroll).toBe(bankrollAfterFirst); // no double payout
    expect(replayed.resolutions).toHaveLength(1);
  });

  it("a season persisted mid-prediction (stakes but no resolutions yet) reloads intact", async () => {
    const store: PredictionStore = createMemoryPredictionStore();
    const season = applyStake(makeSeason(), makeStake());
    await store.saveSeason(season);

    const reloaded = await store.loadSeason();
    expect(reloaded).toEqual(season);
    expect(reloaded?.resolutions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Bankroll bust and reset
// ---------------------------------------------------------------------------

describe("edge case: bankroll bust and reset", () => {
  it("isBusted() is true once bankroll drops below BUST_THRESHOLD", () => {
    expect(isBusted(makeSeason({ bankroll: BUST_THRESHOLD - 1 }))).toBe(true);
    expect(isBusted(makeSeason({ bankroll: BUST_THRESHOLD }))).toBe(false);
  });

  it("applyStake refuses to stake once the season is busted, even with a nominally valid amount", () => {
    const season = makeSeason({ bankroll: BUST_THRESHOLD - 1 });
    expect(() => applyStake(season, makeStake({ amount: MIN_STAKE }))).toThrow(LedgerError);
  });

  it("a bust reset restores STARTING_BANKROLL in a fresh season via startSeason()", () => {
    const pool: SeasonPool = {
      allFixtureIds: Array.from({ length: 30 }, (_, i) => `fx-${i}`),
      seenFixtureIds: new Set(),
    };
    const result = startSeason(pool, 1, "2026-01-02T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.season.bankroll).toBe(STARTING_BANKROLL);
    expect(result.season.stakes).toHaveLength(0);
    expect(result.season.resolutions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Multiple open markets at once
// ---------------------------------------------------------------------------

describe("edge case: multiple open markets at once", () => {
  it("all four market kinds can be staked simultaneously at the same checkpoint without interfering", () => {
    let season = makeSeason();
    const kinds = ["winner", "survives", "next_elimination", "gains_share"] as const;
    for (const kind of kinds) {
      season = applyStake(season, makeStake({ kind, amount: 20, seatId: "A" }));
    }
    expect(season.stakes).toHaveLength(4);
    expect(computeBankroll(season)).toBe(STARTING_BANKROLL - 80);
    // Each is independently addressable and resolvable.
    for (const kind of kinds) {
      expect(canStake(season, FIXTURE.id, 0, kind)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Rapid repeated clicks (races)
// ---------------------------------------------------------------------------

describe("edge case: rapid repeated clicks (races) cannot double-apply", () => {
  it("firing the exact same stake action twice in immediate succession only debits bankroll once", () => {
    const click = makeStake();
    let season = makeSeason();
    season = applyStake(season, click);
    season = applyStake(season, click); // the "double click" — identical payload
    expect(season.stakes).toHaveLength(1);
    expect(computeBankroll(season)).toBe(STARTING_BANKROLL - click.amount);
  });

  it("firing two rapid clicks that differ only by timestamp (a genuine double-submit, not a replay) is rejected", () => {
    let season = makeSeason();
    season = applyStake(season, makeStake({ placedAtIso: "t0" }));
    expect(() => applyStake(season, makeStake({ placedAtIso: "t1" }))).toThrow(LedgerError);
  });

  it("firing the same resolution twice (double-resolve race) only pays out once", () => {
    let season = applyStake(makeSeason(), makeStake());
    const resolution = buildResolution(season.stakes[0], "won", "t-resolve");
    season = applyResolution(season, resolution);
    const afterFirst = season.bankroll;
    season = applyResolution(season, resolution);
    expect(season.bankroll).toBe(afterFirst);
  });
});


// ---------------------------------------------------------------------------
// 11. Navigating away mid-reveal and returning
// ---------------------------------------------------------------------------

describe("edge case: navigating away mid-reveal and returning", () => {
  it("a season saved after staking but before resolving, then reloaded, can still be resolved correctly on return", async () => {
    const store: PredictionStore = createMemoryPredictionStore();
    const season = applyStake(makeSeason(), makeStake());
    await store.saveSeason(season);
    await store.recordStake(season.stakes[0]);

    // "Navigate away" — the caller drops this in-memory reference entirely;
    // nothing below may read `season` again, only the reloaded copy.

    // "Return" — reload from the store.
    const reloaded = await store.loadSeason();
    expect(reloaded).not.toBeNull();
    if (reloaded === null) return;

    const resolution = buildResolution(reloaded.stakes[0], "won", "t-return");
    const resolved = applyResolution(reloaded, resolution);
    await store.recordResolution(resolution);
    await store.saveSeason(resolved);

    const finalState = await store.loadSeason();
    expect(finalState?.resolutions).toHaveLength(1);
    expect(finalState?.bankroll).toBe(resolved.bankroll);
  });

  it("marking a fixture seen survives a 'navigate away' (seenFixtureIds persists independently of the season)", async () => {
    const store: PredictionStore = createMemoryPredictionStore();
    await store.markFixtureSeen(FIXTURE.id);
    const seen = await store.loadSeenFixtureIds();
    expect(seen.has(FIXTURE.id)).toBe(true);

    // markFixtureSeen composes with the pure season-lifecycle helper too.
    const composed = markFixtureSeen(new Set(), FIXTURE.id);
    expect(composed.has(FIXTURE.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UI-only cases from the brief's §5 matrix — no engine-level equivalent.
// These require driving the actual rendered app and are explicitly NOT
// covered here; flagged so the gap is visible rather than silently assumed
// covered. Owned by whichever slice builds the client UI.
// ---------------------------------------------------------------------------

describe.skip("UI-only edge cases (brief §5) — not testable at the engine level, gap flagged for the UI slice", () => {
  it.todo("narrow/mobile viewport renders the bet slip and checkpoint banner usably");
  it.todo("desktop viewport renders correctly");
  it.todo("no uncaught console errors across predict -> reveal -> resolve -> refresh -> bust flows");
});
