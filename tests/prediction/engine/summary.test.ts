/**
 * Unit tests for src/prediction/engine/summary.ts — SPEC §6 leaderboard
 * fields: final bankroll, ROI (bp), accuracy (bp, voids excluded), resolved
 * count.
 */
import { describe, expect, it } from "vitest";

import { summarizeSeason } from "../../../src/prediction/engine/summary";
import {
  STARTING_BANKROLL,
  type Resolution,
  type Season,
  type Stake,
} from "../../../src/prediction/types";

function makeStake(overrides: Partial<Stake> = {}): Stake {
  return {
    fixtureId: "fx",
    checkpointIndex: 0,
    kind: "winner",
    seatId: "a",
    amount: 100,
    multiplierBp: 20_000,
    placedAtIso: "t",
    ...overrides,
  };
}

function makeResolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    fixtureId: "fx",
    checkpointIndex: 0,
    kind: "winner",
    state: "won",
    returned: 200,
    resolvedAtIso: "t",
    ...overrides,
  };
}

function makeSeason(overrides: Partial<Season> = {}): Season {
  return {
    index: 0,
    fixtureIds: [],
    bankroll: STARTING_BANKROLL,
    stakes: [],
    resolutions: [],
    startedAtIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("summarizeSeason()", () => {
  it("reports null roiBp and accuracyBp when nothing was staked", () => {
    const summary = summarizeSeason(makeSeason());
    expect(summary.roiBp).toBeNull();
    expect(summary.accuracyBp).toBeNull();
    expect(summary.resolvedCount).toBe(0);
    expect(summary.finalBankroll).toBe(STARTING_BANKROLL);
  });

  it("computes ROI as (returned - staked) / staked in basis points", () => {
    const season = makeSeason({
      stakes: [makeStake({ fixtureId: "a", amount: 100 }), makeStake({ fixtureId: "b", amount: 100 })],
      resolutions: [
        makeResolution({ fixtureId: "a", returned: 300, state: "won" }),
        makeResolution({ fixtureId: "b", returned: 0, state: "lost" }),
      ],
    });
    // staked=200, returned=300 -> (300-200)/200 = 0.5 -> 5000bp
    expect(summarizeSeason(season).roiBp).toBe(5_000);
  });

  it("computes a negative ROI when returns fall short of stakes", () => {
    const season = makeSeason({
      stakes: [makeStake({ fixtureId: "a", amount: 100 })],
      resolutions: [makeResolution({ fixtureId: "a", returned: 0, state: "lost" })],
    });
    expect(summarizeSeason(season).roiBp).toBe(-10_000);
  });

  it("excludes voids from accuracy but includes them in ROI and resolvedCount", () => {
    const season = makeSeason({
      stakes: [
        makeStake({ fixtureId: "a", amount: 100 }),
        makeStake({ fixtureId: "b", amount: 100 }),
        makeStake({ fixtureId: "c", amount: 100 }),
      ],
      resolutions: [
        makeResolution({ fixtureId: "a", state: "won", returned: 200 }),
        makeResolution({ fixtureId: "b", state: "lost", returned: 0 }),
        makeResolution({ fixtureId: "c", state: "void", returned: 100 }),
      ],
    });
    const summary = summarizeSeason(season);
    // accuracy over the 2 decided (non-void) resolutions: 1 won / 2 = 5000bp
    expect(summary.accuracyBp).toBe(5_000);
    // resolvedCount counts every resolution, including the void
    expect(summary.resolvedCount).toBe(3);
    // ROI: staked=300, returned=200+0+100=300 -> 0bp
    expect(summary.roiBp).toBe(0);
  });

  it("reports null accuracyBp when every resolution is void", () => {
    const season = makeSeason({
      stakes: [makeStake({ fixtureId: "a", amount: 100 })],
      resolutions: [makeResolution({ fixtureId: "a", state: "void", returned: 100 })],
    });
    expect(summarizeSeason(season).accuracyBp).toBeNull();
    expect(summarizeSeason(season).resolvedCount).toBe(1);
  });

  it("passes through index, finalBankroll and startedAtIso unchanged", () => {
    const season = makeSeason({ index: 4, bankroll: 777, startedAtIso: "2026-02-02T00:00:00.000Z" });
    const summary = summarizeSeason(season);
    expect(summary.index).toBe(4);
    expect(summary.finalBankroll).toBe(777);
    expect(summary.startedAtIso).toBe("2026-02-02T00:00:00.000Z");
  });
});
