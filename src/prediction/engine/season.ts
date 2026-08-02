/**
 * Season lifecycle — SPEC §2.1, §6.
 *
 * A season is 25 fixtures drawn from the pool of fixtures never seen before
 * by this installation. A fixture is burned (marked seen) the moment its
 * *first* checkpoint closes, not on completion — abandoning a match after a
 * glimpse still burns it. A bust never unlocks seen fixtures; it draws 25
 * fresh unseen ones. Pool exhaustion is a terminal state, not a silent
 * recycle.
 */
import {
  type FixtureId,
  type Season,
  SEASON_FIXTURE_COUNT,
  STARTING_BANKROLL,
  BUST_THRESHOLD,
} from "../types";

export interface SeasonPool {
  /** The full play pool (SPEC §2: 250 fixtures across 10 seasons). */
  readonly allFixtureIds: readonly FixtureId[];
  /** Global to the installation; survives every season reset. */
  readonly seenFixtureIds: ReadonlySet<FixtureId>;
}

export type StartSeasonResult =
  | { readonly ok: true; readonly season: Season }
  | {
      readonly ok: false;
      readonly reason: "pool_exhausted";
      readonly unseenCount: number;
    };

export function startSeason(
  pool: SeasonPool,
  seasonIndex: number,
  nowIso: string,
): StartSeasonResult {
  const unseen = pool.allFixtureIds.filter(
    (id) => !pool.seenFixtureIds.has(id),
  );
  if (unseen.length < SEASON_FIXTURE_COUNT) {
    return { ok: false, reason: "pool_exhausted", unseenCount: unseen.length };
  }
  return {
    ok: true,
    season: {
      index: seasonIndex,
      fixtureIds: unseen.slice(0, SEASON_FIXTURE_COUNT),
      bankroll: STARTING_BANKROLL,
      stakes: [],
      resolutions: [],
      startedAtIso: nowIso,
    },
  };
}

export function isBusted(season: Season): boolean {
  return season.bankroll < BUST_THRESHOLD;
}

export function markFixtureSeen(
  seen: ReadonlySet<FixtureId>,
  fixtureId: FixtureId,
): ReadonlySet<FixtureId> {
  if (seen.has(fixtureId)) return seen;
  return new Set(seen).add(fixtureId);
}
