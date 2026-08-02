/**
 * Property tests for src/prediction/engine/ledger.ts over randomised action
 * sequences — SPEC §6: `ledgerHolds()` must hold after every operation, no
 * sequence produces a negative bankroll, a double-stake, or any float drift.
 *
 * No external property-testing library is added (none is a dependency of
 * this project); a small seeded PRNG drives deterministic, reproducible
 * random sequences instead.
 */
import { describe, expect, it } from "vitest";

import {
  applyResolution,
  applyStake,
  buildResolution,
  LedgerError,
} from "../../../src/prediction/engine/ledger";
import {
  ledgerHolds,
  maxStake,
  MIN_STAKE,
  STARTING_BANKROLL,
  type MarketKind,
  type ResolutionState,
  type Season,
  type Stake,
} from "../../../src/prediction/types";

const MARKET_KINDS: readonly MarketKind[] = [
  "winner",
  "survives",
  "next_elimination",
  "gains_share",
];
const RESOLUTION_STATES: readonly ResolutionState[] = ["won", "lost", "void"];

/** Deterministic, seedable PRNG — mulberry32. Reproducible across runs. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptySeason(): Season {
  return {
    index: 0,
    fixtureIds: [],
    bankroll: STARTING_BANKROLL,
    stakes: [],
    resolutions: [],
    startedAtIso: "2026-01-01T00:00:00.000Z",
  };
}

function assertInvariants(season: Season): void {
  expect(ledgerHolds(season)).toBe(true);
  expect(Number.isInteger(season.bankroll)).toBe(true);
  expect(season.bankroll).toBeGreaterThanOrEqual(0);
  for (const s of season.stakes) expect(Number.isInteger(s.amount)).toBe(true);
  for (const r of season.resolutions) expect(Number.isInteger(r.returned)).toBe(true);

  const keys = season.stakes.map((s) => `${s.fixtureId}:${s.checkpointIndex}:${s.kind}`);
  expect(new Set(keys).size).toBe(keys.length); // no double-stake, ever
}

const STEPS_PER_TRIAL = 80;
const SEEDS = Array.from({ length: 30 }, (_, i) => i * 7919 + 1);

describe("ledger property: randomised action sequences", () => {
  it.each(SEEDS)("seed %i — invariants hold after every step", (seed) => {
    const rng = mulberry32(seed);
    let season = emptySeason();
    let nextFixture = 0;
    const openMarkets: { fixtureId: string; checkpointIndex: 0 | 1; kind: MarketKind; stake: Stake }[] = [];
    const everStaked = new Map<string, Stake>();

    function randomStakePayload(fixtureId: string, checkpointIndex: 0 | 1, kind: MarketKind, step: number): Stake {
      const cap = maxStake(season.bankroll);
      const wantsValid = rng() < 0.7;
      const amount = wantsValid
        ? MIN_STAKE + Math.floor(rng() * Math.max(1, cap - MIN_STAKE + 1))
        : rng() < 0.5
          ? MIN_STAKE - 1 - Math.floor(rng() * 5) // below minimum
          : cap + 1 + Math.floor(rng() * 50); // above cap
      const multiplierBp = 10_500 + Math.floor(rng() * (200_000 - 10_500));
      return {
        fixtureId,
        checkpointIndex,
        kind,
        seatId: "a",
        amount,
        multiplierBp,
        placedAtIso: `2026-01-01T00:00:${String(step).padStart(2, "0")}.000Z`,
      };
    }

    for (let step = 0; step < STEPS_PER_TRIAL; step++) {
      const action = rng();

      if (action < 0.15 && everStaked.size > 0) {
        // Deliberately re-attempt a stake on an already-used market key:
        // either the identical payload (must be an idempotent no-op) or a
        // different one (must be rejected as a double-stake). Either way
        // the ledger must never end up with two stakes for the same key.
        const keys = [...everStaked.keys()];
        const key = keys[Math.floor(rng() * keys.length)];
        const original = everStaked.get(key)!;
        const replayIdentical = rng() < 0.5;
        const attempt = replayIdentical
          ? original
          : { ...original, amount: original.amount + 1 };

        const before = season;
        try {
          season = applyStake(season, attempt);
          expect(replayIdentical).toBe(true);
          expect(season).toBe(before);
        } catch (err) {
          expect(err).toBeInstanceOf(LedgerError);
          expect(season).toBe(before);
        }
      } else if (action < 0.65 || openMarkets.length === 0) {
        // Stake a fresh market key (sometimes with an intentionally invalid
        // amount, to exercise the reject-and-leave-unchanged path).
        const fixtureId = `fx-${nextFixture++}`;
        const checkpointIndex = rng() < 0.5 ? 0 : 1;
        const kind = MARKET_KINDS[Math.floor(rng() * MARKET_KINDS.length)];
        const stake = randomStakePayload(fixtureId, checkpointIndex, kind, step);
        const key = `${stake.fixtureId}:${stake.checkpointIndex}:${stake.kind}`;

        const before = season;
        try {
          season = applyStake(season, stake);
          if (season !== before) {
            openMarkets.push({ fixtureId, checkpointIndex, kind, stake });
            everStaked.set(key, stake);
          }
        } catch (err) {
          expect(err).toBeInstanceOf(LedgerError);
          expect(season).toBe(before); // rejected stake must never mutate state
        }
      } else {
        // Resolve a pending market.
        const idx = Math.floor(rng() * openMarkets.length);
        const [market] = openMarkets.splice(idx, 1);
        const state = RESOLUTION_STATES[Math.floor(rng() * RESOLUTION_STATES.length)];
        const resolution = buildResolution(
          market.stake,
          state,
          `2026-01-02T00:00:${String(step).padStart(2, "0")}.000Z`,
        );
        season = applyResolution(season, resolution);
      }

      assertInvariants(season);
    }
  });
});
