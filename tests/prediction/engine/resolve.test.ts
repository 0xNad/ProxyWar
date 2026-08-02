/**
 * Unit tests for src/prediction/engine/resolve.ts — SPEC §3, every market's
 * resolution rule, including void, tie, and the strictly-after-checkpoint
 * constraint on next_elimination.
 */
import { describe, expect, it } from "vitest";

import { isEligibleToStake, resolveMarket } from "../../../src/prediction/engine/resolve";
import type {
  Checkpoint,
  Fixture,
  FixtureOutcome,
  SeatSnapshot,
} from "../../../src/prediction/types";

function seat(
  seatId: string,
  shareBp: number,
  alive = true,
): SeatSnapshot {
  return { seatId, name: seatId, shareBp, alive };
}

function checkpoint(
  index: 0 | 1,
  turn: number,
  resolutionTurn: number,
  seats: readonly SeatSnapshot[],
): Checkpoint {
  return { index, turn, resolutionTurn, seats };
}

function makeFixture(
  checkpoints: readonly [Checkpoint, Checkpoint],
  outcome: FixtureOutcome,
): Fixture {
  return {
    id: "fx-1",
    seed: 1,
    map: "testmap",
    mapSize: "Compact",
    nationCount: 4,
    checkpoints,
    outcome,
  };
}

describe("resolveMarket() — winner", () => {
  it("wins when the chosen seat is the outcome's winner", () => {
    const fixture = makeFixture(
      [checkpoint(0, 10, 50, [seat("a", 3000)]), checkpoint(1, 30, 80, [seat("a", 3000)])],
      { winnerSeatId: "a", eliminationOrder: [], shareAtResolution: [{}, {}], finalTurn: 100 },
    );
    expect(resolveMarket(fixture, 0, "winner", "a")).toBe("won");
  });

  it("loses when the chosen seat is not the winner", () => {
    const fixture = makeFixture(
      [checkpoint(0, 10, 50, [seat("a", 3000)]), checkpoint(1, 30, 80, [seat("a", 3000)])],
      { winnerSeatId: "b", eliminationOrder: [], shareAtResolution: [{}, {}], finalTurn: 100 },
    );
    expect(resolveMarket(fixture, 0, "winner", "a")).toBe("lost");
  });

  it("loses every seat when there is no winner (draw)", () => {
    const fixture = makeFixture(
      [checkpoint(0, 10, 50, [seat("a", 3000)]), checkpoint(1, 30, 80, [seat("a", 3000)])],
      { winnerSeatId: null, eliminationOrder: [], shareAtResolution: [{}, {}], finalTurn: 100 },
    );
    expect(resolveMarket(fixture, 0, "winner", "a")).toBe("lost");
  });
});

describe("resolveMarket() — survives", () => {
  const cps: readonly [Checkpoint, Checkpoint] = [
    checkpoint(0, 10, 100, [seat("a", 3000), seat("b", 2000)]),
    checkpoint(1, 60, 130, [seat("a", 3000), seat("b", 2000)]),
  ];

  it("wins when the seat is never eliminated", () => {
    const fixture = makeFixture(cps, {
      winnerSeatId: "a",
      eliminationOrder: [],
      shareAtResolution: [{}, {}],
      finalTurn: 200,
    });
    expect(resolveMarket(fixture, 0, "survives", "a")).toBe("won");
  });

  it("wins when eliminated strictly after the resolution turn", () => {
    const fixture = makeFixture(cps, {
      winnerSeatId: "a",
      eliminationOrder: [{ seatId: "b", turn: 101 }],
      shareAtResolution: [{}, {}],
      finalTurn: 200,
    });
    expect(resolveMarket(fixture, 0, "survives", "b")).toBe("won");
  });

  it("loses when eliminated before the resolution turn", () => {
    const fixture = makeFixture(cps, {
      winnerSeatId: "a",
      eliminationOrder: [{ seatId: "b", turn: 50 }],
      shareAtResolution: [{}, {}],
      finalTurn: 200,
    });
    expect(resolveMarket(fixture, 0, "survives", "b")).toBe("lost");
  });

  it("loses when eliminated exactly at the resolution turn (boundary)", () => {
    const fixture = makeFixture(cps, {
      winnerSeatId: "a",
      eliminationOrder: [{ seatId: "b", turn: 100 }],
      shareAtResolution: [{}, {}],
      finalTurn: 200,
    });
    expect(resolveMarket(fixture, 0, "survives", "b")).toBe("lost");
  });
});

describe("resolveMarket() — next_elimination", () => {
  const cp = checkpoint(0, 50, 90, [seat("a", 3000), seat("b", 2000), seat("c", 0, false)]);
  const cps: readonly [Checkpoint, Checkpoint] = [cp, checkpoint(1, 70, 100, cp.seats)];

  it("wins the seat that is eliminated first among those alive at the checkpoint", () => {
    const fixture = makeFixture(cps, {
      winnerSeatId: "b",
      eliminationOrder: [
        { seatId: "c", turn: 10 },
        { seatId: "a", turn: 80 },
        { seatId: "b", turn: 120 },
      ],
      shareAtResolution: [{}, {}],
      finalTurn: 200,
    });
    expect(resolveMarket(fixture, 0, "next_elimination", "a")).toBe("won");
    expect(resolveMarket(fixture, 0, "next_elimination", "b")).toBe("lost");
  });

  it("is void when no further elimination occurs among seats alive at the checkpoint", () => {
    const fixture = makeFixture(cps, {
      winnerSeatId: "a",
      eliminationOrder: [{ seatId: "c", turn: 10 }],
      shareAtResolution: [{}, {}],
      finalTurn: 200,
    });
    expect(resolveMarket(fixture, 0, "next_elimination", "a")).toBe("void");
    expect(resolveMarket(fixture, 0, "next_elimination", "b")).toBe("void");
  });

  it("excludes an elimination recorded exactly at the checkpoint's turn (strictly-after constraint)", () => {
    const fixture = makeFixture(cps, {
      winnerSeatId: "b",
      // "a" eliminated AT the checkpoint turn (50) — not strictly after it,
      // so it must not count as the next elimination; nothing else follows.
      eliminationOrder: [{ seatId: "a", turn: 50 }],
      shareAtResolution: [{}, {}],
      finalTurn: 200,
    });
    expect(resolveMarket(fixture, 0, "next_elimination", "a")).toBe("void");
    expect(resolveMarket(fixture, 0, "next_elimination", "b")).toBe("void");
  });

  it("ignores eliminations of seats that were already dead at the checkpoint", () => {
    const fixture = makeFixture(cps, {
      winnerSeatId: "a",
      // "c" was already dead at the checkpoint; a later (bogus) record for it
      // must never be picked as the next elimination for the alive set.
      eliminationOrder: [
        { seatId: "c", turn: 10 },
        { seatId: "b", turn: 95 },
      ],
      shareAtResolution: [{}, {}],
      finalTurn: 200,
    });
    expect(resolveMarket(fixture, 0, "next_elimination", "b")).toBe("won");
  });
});

describe("resolveMarket() — gains_share", () => {
  const cps: readonly [Checkpoint, Checkpoint] = [
    checkpoint(0, 10, 60, [seat("a", 2000)]),
    checkpoint(1, 40, 90, [seat("a", 2000)]),
  ];

  it("wins when the resolution share is strictly greater", () => {
    const fixture = makeFixture(cps, {
      winnerSeatId: "a",
      eliminationOrder: [],
      shareAtResolution: [{ a: 2500 }, {}],
      finalTurn: 200,
    });
    expect(resolveMarket(fixture, 0, "gains_share", "a")).toBe("won");
  });

  it("loses on an exact tie", () => {
    const fixture = makeFixture(cps, {
      winnerSeatId: "a",
      eliminationOrder: [],
      shareAtResolution: [{ a: 2000 }, {}],
      finalTurn: 200,
    });
    expect(resolveMarket(fixture, 0, "gains_share", "a")).toBe("lost");
  });

  it("loses when the resolution share is lower", () => {
    const fixture = makeFixture(cps, {
      winnerSeatId: "a",
      eliminationOrder: [],
      shareAtResolution: [{ a: 500 }, {}],
      finalTurn: 200,
    });
    expect(resolveMarket(fixture, 0, "gains_share", "a")).toBe("lost");
  });
});

describe("isEligibleToStake()", () => {
  const cp = checkpoint(0, 10, 50, [seat("a", 3000, true), seat("b", 0, false)]);

  it("is eligible for a seat alive at the checkpoint", () => {
    expect(isEligibleToStake(cp, "a")).toBe(true);
  });

  it("is ineligible for a seat already dead at the checkpoint", () => {
    expect(isEligibleToStake(cp, "b")).toBe(false);
  });

  it("is ineligible for an unknown seat id", () => {
    expect(isEligibleToStake(cp, "does-not-exist")).toBe(false);
  });
});
