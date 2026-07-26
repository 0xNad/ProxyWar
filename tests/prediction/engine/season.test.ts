/**
 * Unit tests for src/prediction/engine/season.ts — SPEC §2.1: a season is 25
 * fixtures drawn from the unseen pool; a bust draws 25 fresh unseen
 * fixtures, never unlocking seen ones; pool exhaustion is terminal.
 */
import { describe, expect, it } from "vitest";

import {
  isBusted,
  markFixtureSeen,
  startSeason,
  type SeasonPool,
} from "../../../src/prediction/engine/season";
import {
  BUST_THRESHOLD,
  SEASON_FIXTURE_COUNT,
  STARTING_BANKROLL,
  type FixtureId,
  type Season,
} from "../../../src/prediction/types";

function fixtureIds(count: number, prefix = "fx"): FixtureId[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}

describe("startSeason()", () => {
  it("draws exactly SEASON_FIXTURE_COUNT unseen fixtures with a fresh bankroll", () => {
    const pool: SeasonPool = { allFixtureIds: fixtureIds(50), seenFixtureIds: new Set() };
    const result = startSeason(pool, 0, "2026-01-01T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.season.fixtureIds).toHaveLength(SEASON_FIXTURE_COUNT);
    expect(result.season.bankroll).toBe(STARTING_BANKROLL);
    expect(result.season.index).toBe(0);
    expect(result.season.stakes).toEqual([]);
    expect(result.season.resolutions).toEqual([]);
  });

  it("never draws a fixture already marked seen", () => {
    const all = fixtureIds(60);
    const seen = new Set(all.slice(0, 30));
    const pool: SeasonPool = { allFixtureIds: all, seenFixtureIds: seen };
    const result = startSeason(pool, 1, "2026-01-01T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const id of result.season.fixtureIds) {
      expect(seen.has(id)).toBe(false);
    }
  });

  it("is a terminal pool_exhausted result when fewer than 25 unseen fixtures remain", () => {
    const all = fixtureIds(30);
    const seen = new Set(all.slice(0, 10)); // 20 unseen left, short of 25
    const pool: SeasonPool = { allFixtureIds: all, seenFixtureIds: seen };
    const result = startSeason(pool, 2, "2026-01-01T00:00:00.000Z");
    expect(result).toEqual({ ok: false, reason: "pool_exhausted", unseenCount: 20 });
  });

  it("is exhausted at exactly zero unseen fixtures remaining", () => {
    const all = fixtureIds(25);
    const seen = new Set(all);
    const pool: SeasonPool = { allFixtureIds: all, seenFixtureIds: seen };
    const result = startSeason(pool, 3, "2026-01-01T00:00:00.000Z");
    expect(result).toEqual({ ok: false, reason: "pool_exhausted", unseenCount: 0 });
  });

  it("succeeds at exactly SEASON_FIXTURE_COUNT unseen fixtures remaining", () => {
    const all = fixtureIds(30);
    const seen = new Set(all.slice(0, 5)); // exactly 25 unseen left
    const pool: SeasonPool = { allFixtureIds: all, seenFixtureIds: seen };
    const result = startSeason(pool, 4, "2026-01-01T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.season.fixtureIds).toHaveLength(SEASON_FIXTURE_COUNT);
  });
});

describe("isBusted()", () => {
  const base: Season = {
    index: 0,
    fixtureIds: [],
    bankroll: STARTING_BANKROLL,
    stakes: [],
    resolutions: [],
    startedAtIso: "2026-01-01T00:00:00.000Z",
  };

  it("is false at or above BUST_THRESHOLD", () => {
    expect(isBusted({ ...base, bankroll: BUST_THRESHOLD })).toBe(false);
    expect(isBusted({ ...base, bankroll: BUST_THRESHOLD + 1 })).toBe(false);
  });

  it("is true below BUST_THRESHOLD", () => {
    expect(isBusted({ ...base, bankroll: BUST_THRESHOLD - 1 })).toBe(true);
    expect(isBusted({ ...base, bankroll: 0 })).toBe(true);
  });
});

describe("markFixtureSeen()", () => {
  it("adds the fixture id, immutably", () => {
    const seen = new Set<FixtureId>(["fx-0"]);
    const next = markFixtureSeen(seen, "fx-1");
    expect(seen.has("fx-1")).toBe(false); // original untouched
    expect(next.has("fx-0")).toBe(true);
    expect(next.has("fx-1")).toBe(true);
  });

  it("is idempotent — marking an already-seen fixture returns an equivalent set", () => {
    const seen = new Set<FixtureId>(["fx-0"]);
    const next = markFixtureSeen(seen, "fx-0");
    expect(next).toBe(seen); // no-op, same reference
  });
});

describe("bust-reset lifecycle — SPEC §2.1", () => {
  it("a fixture burned at first-checkpoint-close is excluded from every future season, including after a bust", () => {
    const all = fixtureIds(60);
    let seen: ReadonlySet<FixtureId> = new Set<FixtureId>();

    const season1 = startSeason({ allFixtureIds: all, seenFixtureIds: seen }, 0, "t0");
    expect(season1.ok).toBe(true);
    if (!season1.ok) return;

    // The player glimpses fixture[0]'s first checkpoint and abandons —
    // still burned, per SPEC §2.1.
    seen = markFixtureSeen(seen, season1.season.fixtureIds[0]);
    // A bust: bankroll fell below threshold, start season 2 from the same
    // (now-updated) seenFixtureIds — never unlocking what season 1 saw.
    const season2 = startSeason({ allFixtureIds: all, seenFixtureIds: seen }, 1, "t1");
    expect(season2.ok).toBe(true);
    if (!season2.ok) return;

    expect(season2.season.fixtureIds).not.toContain(season1.season.fixtureIds[0]);
    // Every fixture in the fresh season is genuinely unseen.
    for (const id of season2.season.fixtureIds) expect(seen.has(id)).toBe(false);
  });
});
