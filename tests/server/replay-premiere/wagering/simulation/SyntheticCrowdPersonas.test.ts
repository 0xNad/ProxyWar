import { describe, expect, it } from "vitest";
import { decideSyntheticCrowdOrder } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdPersonas";
import { Prng } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdPrng";
import type { SyntheticCrowdSignalSnapshot } from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdTypes";

const SNAPSHOT: SyntheticCrowdSignalSnapshot = {
  optionSeatIds: ["seat-a", "seat-b"],
  // seat-a is believed to be a strong (80/20) favorite.
  favorabilityWeights: { "seat-a": 80, "seat-b": 20 },
};

const BASE = {
  minStake: 10,
  maxStake: 200,
  threshold: 3,
  aggressiveness: 0.5,
} as const;

describe("decideSyntheticCrowdOrder", () => {
  it("does nothing when price already matches the crowd signal within threshold", () => {
    // aggressiveness 0 keeps favorite-backer's sharpening a no-op, so its
    // fair value equals the raw snapshot exactly.
    const decision = decideSyntheticCrowdOrder({
      persona: "favorite-backer",
      snapshot: SNAPSHOT,
      marketPrices: { "seat-a": 80, "seat-b": 20 },
      heldShares: {},
      lastSeenPrices: null,
      remainingBudgetHint: 1000,
      minStake: 10,
      maxStake: 200,
      threshold: 3,
      aggressiveness: 0,
      rng: new Prng(1),
    });
    expect(decision).toBeNull();
  });

  it("favorite-backer buys the seat it believes is under-priced relative to a sharpened favorite view", () => {
    const decision = decideSyntheticCrowdOrder({
      persona: "favorite-backer",
      snapshot: SNAPSHOT,
      marketPrices: { "seat-a": 50, "seat-b": 50 },
      heldShares: {},
      lastSeenPrices: null,
      remainingBudgetHint: 1000,
      ...BASE,
      rng: new Prng(1),
    });
    expect(decision).not.toBeNull();
    expect(decision?.side).toBe("buy");
    expect(decision?.seatId).toBe("seat-a");
    expect(decision?.amount).toBeGreaterThanOrEqual(BASE.minStake);
    expect(decision?.limitPrice).toBeGreaterThanOrEqual(50);
  });

  it("value-hunter buys the underdog that favorite-backer would ignore", () => {
    // Three seats so the underdog's mispricing can be the single largest
    // gap on its own (in a 2-outcome market the two gaps are always equal
    // and opposite, so "most mispriced" is a coin flip — not a faithful
    // test of persona behaviour).
    const snapshot: SyntheticCrowdSignalSnapshot = {
      optionSeatIds: ["seat-a", "seat-b", "seat-c"],
      favorabilityWeights: { "seat-a": 70, "seat-b": 20, "seat-c": 10 },
    };
    // Price already reflects the raw 70/20/10 crowd consensus for seat-a
    // and seat-b, but seat-c (the longshot) has been beaten down to 5 —
    // clearly the single most mispriced outcome once value-hunter's
    // flattened-toward-uniform view (which rates seat-c well above 5) is
    // applied.
    const valueHunter = decideSyntheticCrowdOrder({
      persona: "value-hunter",
      snapshot,
      marketPrices: { "seat-a": 53, "seat-b": 28, "seat-c": 5 },
      heldShares: {},
      lastSeenPrices: null,
      remainingBudgetHint: 1000,
      minStake: 10,
      maxStake: 200,
      threshold: 3,
      aggressiveness: 0.9,
      rng: new Prng(1),
    });
    expect(valueHunter).not.toBeNull();
    expect(valueHunter?.side).toBe("buy");
    expect(valueHunter?.seatId).toBe("seat-c");
  });

  it("momentum-chaser extrapolates a recent price move rather than reading the snapshot", () => {
    // Three seats: seat-b rallies from 10 to 30 while seat-a and seat-c
    // each give up a little to fund it — the crowd snapshot still says
    // seat-a/seat-c are the (equal) favorites, but momentum should chase
    // seat-b's rally regardless of what the snapshot claims.
    const snapshot: SyntheticCrowdSignalSnapshot = {
      optionSeatIds: ["seat-a", "seat-b", "seat-c"],
      favorabilityWeights: { "seat-a": 45, "seat-b": 10, "seat-c": 45 },
    };
    const decision = decideSyntheticCrowdOrder({
      persona: "momentum-chaser",
      snapshot,
      marketPrices: { "seat-a": 40, "seat-b": 30, "seat-c": 30 },
      heldShares: {},
      lastSeenPrices: { "seat-a": 45, "seat-b": 10, "seat-c": 45 },
      remainingBudgetHint: 1000,
      ...BASE,
      rng: new Prng(1),
    });
    expect(decision).not.toBeNull();
    expect(decision?.side).toBe("buy");
    expect(decision?.seatId).toBe("seat-b");
  });
  it("sells (trims) a held position when the fair-value gap goes negative past threshold", () => {
    const decision = decideSyntheticCrowdOrder({
      persona: "favorite-backer",
      snapshot: SNAPSHOT,
      // seat-a has run up well past what even a sharpened favorite view supports.
      marketPrices: { "seat-a": 99, "seat-b": 1 },
      heldShares: { "seat-a": 10 },
      lastSeenPrices: null,
      remainingBudgetHint: 1000,
      ...BASE,
      rng: new Prng(1),
    });
    expect(decision).not.toBeNull();
    expect(decision?.side).toBe("sell");
    expect(decision?.seatId).toBe("seat-a");
    expect(decision?.amount).toBe(5); // half of the 10 held shares
    expect(decision?.limitPrice).toBeLessThanOrEqual(99);
  });

  it("never sells a seat it holds nothing in, even when over-priced", () => {
    const decision = decideSyntheticCrowdOrder({
      persona: "favorite-backer",
      snapshot: SNAPSHOT,
      marketPrices: { "seat-a": 99, "seat-b": 1 },
      heldShares: {},
      lastSeenPrices: null,
      remainingBudgetHint: 1000,
      ...BASE,
      rng: new Prng(1),
    });
    expect(decision).toBeNull();
  });

  it("declines to buy when the remaining budget hint is below the minimum stake", () => {
    const decision = decideSyntheticCrowdOrder({
      persona: "favorite-backer",
      snapshot: SNAPSHOT,
      marketPrices: { "seat-a": 50, "seat-b": 50 },
      heldShares: {},
      lastSeenPrices: null,
      remainingBudgetHint: 5,
      ...BASE,
      rng: new Prng(1),
    });
    expect(decision).toBeNull();
  });

  it("is deterministic given identical inputs and RNG seed", () => {
    const make = () =>
      decideSyntheticCrowdOrder({
        persona: "noise-trader",
        snapshot: SNAPSHOT,
        marketPrices: { "seat-a": 55, "seat-b": 45 },
        heldShares: { "seat-b": 4 },
        lastSeenPrices: null,
        remainingBudgetHint: 500,
        ...BASE,
        rng: new Prng(2026),
      });
    expect(make()).toEqual(make());
  });
});
