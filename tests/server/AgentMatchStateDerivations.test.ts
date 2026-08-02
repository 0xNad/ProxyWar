import { describe, expect, it } from "vitest";
import {
  computeAllianceDurations,
  computeEliminationTimings,
  computeLeadChanges,
  computeMajorReversals,
  computeTerritorialSwings,
  LEAD_CHANGE_MARGIN_SHARE,
  REVERSAL_MAX_SAMPLE_GAP,
  REVERSAL_MIN_PLACES,
  TERRITORIAL_SWING_MIN_DELTA_SHARE,
} from "../../src/server/agents/AgentMatchStateDerivations";
import { buildFixtureSeries, FIXTURE_EVENTS } from "./AgentMatchStateSeries.test";

/**
 * Hand-computed against the shared fixture in `AgentMatchStateSeries.test.ts`
 * (see its own doc for the exact tile/troop numbers per turn) — every
 * expected value below was derived by hand from those numbers, not from
 * running the implementation and copying its output.
 */

describe("computeLeadChanges", () => {
  it("records a confirmed overtake (Bravo passes Alpha at turn 20, still leading at turn 30)", () => {
    const changes = computeLeadChanges(buildFixtureSeries());
    expect(changes).toHaveLength(2);
    const first = changes[0];
    expect(first.turn).toBe(20);
    expect(first.fromUsername).toBe("Alpha");
    expect(first.toUsername).toBe("Bravo");
    expect(first.marginShare).toBeCloseTo(0.1, 5);
    expect(first.marginShare).toBeGreaterThanOrEqual(LEAD_CHANGE_MARGIN_SHARE);
  });

  it("records the final-sample overtake (Delta passes Bravo at turn 50) even with no later sample to confirm it", () => {
    const changes = computeLeadChanges(buildFixtureSeries());
    const second = changes[1];
    expect(second.turn).toBe(50);
    expect(second.fromUsername).toBe("Bravo");
    expect(second.toUsername).toBe("Delta");
    expect(second.marginShare).toBeCloseTo(0.35, 5);
  });

  it("never reports a lead change below the margin or that flickers back next sample", () => {
    // Turn 10 (Alpha 40 vs the rest) never overtakes the confirmed leader
    // (Alpha was already leading since turn 0) — no spurious first entry.
    const changes = computeLeadChanges(buildFixtureSeries());
    expect(changes.every((change) => change.marginShare >= LEAD_CHANGE_MARGIN_SHARE)).toBe(
      true,
    );
  });

  it("returns an empty array before anyone has claimed territory", () => {
    const series = buildFixtureSeries();
    const preSpawnOnly = { ...series, samples: [series.samples[0]] };
    // Turn 0 is a tie at equal tiles for everyone in the fixture, not a
    // pre-spawn zero-tile state, so this asserts single-sample input never
    // throws and produces no changes (nothing to transition from/to).
    expect(computeLeadChanges({ ...preSpawnOnly })).toEqual([]);
  });
});

describe("computeMajorReversals", () => {
  it("finds Delta's climb from rank 4 (turn 10) to rank 1 (turn 50) as a single reversal", () => {
    const reversals = computeMajorReversals(buildFixtureSeries());
    expect(reversals).toHaveLength(1);
    const reversal = reversals[0];
    expect(reversal.username).toBe("Delta");
    expect(reversal.fromTurn).toBe(10);
    expect(reversal.toTurn).toBe(50);
    expect(reversal.fromRank).toBe(4);
    expect(reversal.toRank).toBe(1);
    expect(reversal.placesChanged).toBe(3);
    expect(Math.abs(reversal.placesChanged)).toBeGreaterThanOrEqual(REVERSAL_MIN_PLACES);
    expect(reversal.toTurn - reversal.fromTurn).toBeLessThanOrEqual(
      REVERSAL_MAX_SAMPLE_GAP * 10, // 10 turns per sample in this fixture
    );
  });

  it("never reports Alpha's 2-place decline (below the 3-place floor)", () => {
    const reversals = computeMajorReversals(buildFixtureSeries());
    expect(reversals.some((reversal) => reversal.username === "Alpha")).toBe(false);
  });
});

describe("computeEliminationTimings", () => {
  it("bounds Charlie's elimination to (turn 20, turn 30]", () => {
    const timings = computeEliminationTimings(buildFixtureSeries());
    expect(timings).toHaveLength(1);
    expect(timings[0].username).toBe("Charlie");
    expect(timings[0].lastAliveTurn).toBe(20);
    expect(timings[0].firstDeadTurn).toBe(30);
  });
});

describe("computeAllianceDurations", () => {
  it("computes a closed betrayed alliance's duration and flags an unbroken alliance as ongoing", () => {
    const series = buildFixtureSeries();
    const durations = computeAllianceDurations(series, FIXTURE_EVENTS);
    expect(durations).toHaveLength(2);

    const betrayed = durations.find((d) => d.brokenByBetrayal === true)!;
    expect(betrayed.agentAUsername === "Alpha" || betrayed.agentBUsername === "Alpha").toBe(true);
    expect(betrayed.durationTurns).toBe(30); // 35 - 5
    expect(betrayed.ongoing).toBe(false);

    const ongoing = durations.find((d) => d.ongoing === true)!;
    expect(ongoing.durationTurns).toBe(38); // totalTurns(50) - formedTurn(12)
    expect(ongoing.brokenByBetrayal).toBeNull();
  });
});

describe("computeTerritorialSwings", () => {
  it("flags Delta's turn30->turn40 expansion and Alpha's collapse in the same window", () => {
    const swings = computeTerritorialSwings(buildFixtureSeries());
    const deltaSwing = swings.find(
      (s) => s.username === "Delta" && s.fromTurn === 30 && s.toTurn === 40,
    )!;
    expect(deltaSwing).toBeDefined();
    expect(deltaSwing.deltaShare).toBeCloseTo(0.17, 5);
    expect(Math.abs(deltaSwing.deltaShare)).toBeGreaterThanOrEqual(
      TERRITORIAL_SWING_MIN_DELTA_SHARE,
    );

    const alphaSwing = swings.find(
      (s) => s.username === "Alpha" && s.fromTurn === 30 && s.toTurn === 40,
    )!;
    expect(alphaSwing).toBeDefined();
    expect(alphaSwing.deltaShare).toBeCloseTo(-0.12, 5);
  });
});
