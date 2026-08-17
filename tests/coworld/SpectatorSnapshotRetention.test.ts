import { describe, expect, it } from "vitest";

import {
  createSnapshotRetention,
  finalizeSnapshotRetention,
  offerSnapshot,
} from "../../coworld-adapter/src/spectator-snapshot-retention";

/**
 * The retained spectator snapshots must cover the WHOLE match evenly, not just
 * its tail.
 *
 * The previous inline rule halved the array on overflow and called that "an even
 * temporal spread". It is not: halving thins what is already retained while new
 * snapshots keep arriving at the raw cadence, so each overflow doubles the stride
 * of older regions and leaves the newest at stride 1. Measured on live league
 * episodes served 2026-08-17:
 *
 *   36,400-turn match — 25 frames, first at 400, second at 25,200 (68% of the
 *                       match with no frame); 20,100-turn — 40%; 17,000 — 19%.
 *
 * These tests assert the property that was missing (bounded WORST gap relative to
 * the median), not a fixed frame list, because the cap and cadence are tunable.
 */

/** Runs a whole episode's worth of snapshots through retention. */
function retainedTurns(input: {
  totalTurns: number;
  step: number;
  cap: number;
  finalize?: boolean;
}): number[] {
  const state = createSnapshotRetention<number>(input.cap);
  for (let turn = input.step; turn <= input.totalTurns; turn += input.step) {
    offerSnapshot(state, turn);
  }
  if (input.finalize !== false) finalizeSnapshotRetention(state);
  return [...state.retained];
}

function gaps(turns: readonly number[]): number[] {
  return turns.slice(1).map((turn, index) => turn - turns[index]);
}

describe("spectator snapshot retention", () => {
  const cases = [
    { totalTurns: 36_400, step: 200, cap: 48 },
    { totalTurns: 20_100, step: 200, cap: 48 },
    { totalTurns: 17_000, step: 200, cap: 48 },
    // 16-seat league variants step 100 turns per decision and run long.
    { totalTurns: 50_000, step: 100, cap: 48 },
    // Short match: nothing should be dropped at all.
    { totalTurns: 2_000, step: 200, cap: 48 },
  ];

  it.each(cases)(
    "keeps an even spread across a $totalTurns-turn match",
    ({ totalTurns, step, cap }) => {
      const turns = retainedTurns({ totalTurns, step, cap });
      expect(turns.length).toBeLessThanOrEqual(cap);
      expect(turns.length).toBeGreaterThan(1);

      // The reserved terminal frame deliberately makes the LAST gap short, so
      // the spread property is measured over the spine, not that edge.
      const spine = gaps(turns).slice(0, -1);
      const worst = Math.max(...spine);
      const best = Math.min(...spine);
      // The defect was a worst gap orders of magnitude above the typical one
      // (24,800 vs 400 live). Uniform spacing means every gap is equal, so allow
      // only the one-step ragged edge from the newest arrivals.
      expect(worst).toBeLessThanOrEqual(best * 2);

      // The opening frame is kept, and the LAST offered frame is always kept —
      // the artifact must not end before the match does.
      expect(turns[0]).toBe(step);
      expect(turns[turns.length - 1]).toBe(
        Math.floor(totalTurns / step) * step,
      );
    },
  );

  it("reproduces the defect when incoming snapshots are not thinned", () => {
    // Exact port of the shipped halve-only loop, to show what these tests catch.
    const halveOnly = (totalTurns: number, step: number, cap: number) => {
      let kept: number[] = [];
      for (let turn = step; turn <= totalTurns; turn += step) {
        kept.push(turn);
        if (kept.length > cap) {
          kept = kept.filter((_, index) => index % 2 === 0);
        }
      }
      return kept;
    };
    const legacy = halveOnly(36_400, 200, 48);
    const legacyGaps = gaps(legacy);
    // Front-sparse, back-dense: the very property the fix removes.
    expect(Math.max(...legacyGaps)).toBeGreaterThan(
      Math.min(...legacyGaps) * 10,
    );

    // Spine only: the reserved terminal frame makes the last gap deliberately
    // short, which is not the grading this test is about.
    const fixedSpine = gaps(
      retainedTurns({ totalTurns: 36_400, step: 200, cap: 48 }),
    ).slice(0, -1);
    expect(Math.max(...fixedSpine)).toBeLessThanOrEqual(
      Math.min(...fixedSpine) * 2,
    );
  });

  it("never exceeds the cap however long the episode runs", () => {
    const state = createSnapshotRetention<number>(16);
    for (let turn = 100; turn <= 500_000; turn += 100) {
      offerSnapshot(state, turn);
    }
    expect(state.retained.length).toBeLessThanOrEqual(16);
    // Still spans the match rather than hugging the end.
    expect(state.retained[0]).toBe(100);
    expect(state.retained[state.retained.length - 1]).toBeGreaterThan(200_000);
  });

  it("reports whether a snapshot was kept, and keeps the first one", () => {
    const state = createSnapshotRetention<string>(4);
    expect(offerSnapshot(state, "a")).toBe(true);
    expect(state.retained[0]).toBe("a");
    // Below the cap nothing is thinned yet.
    expect(offerSnapshot(state, "b")).toBe(true);
    expect(state.stride).toBe(1);
  });

  it("rejects a nonsensical cap instead of silently degrading", () => {
    expect(() => createSnapshotRetention<number>(1)).toThrow(/cap/);
    expect(() => createSnapshotRetention<number>(2.5)).toThrow(/cap/);
  });
});

describe("terminal frame reservation", () => {
  // buildAgentSpectatorReplay passes `snapshots` verbatim and reads
  // `finalGameState` for map metadata only, so losing the last frame loses the
  // end-of-match state. Episodes essentially never end on a stride boundary.
  const cases = [
    { totalTurns: 36_400, step: 200, cap: 48 },
    { totalTurns: 20_100, step: 200, cap: 48 },
    { totalTurns: 17_000, step: 200, cap: 48 },
    { totalTurns: 49_950, step: 100, cap: 48 },
    { totalTurns: 7_350, step: 350, cap: 16 },
  ];

  it.each(cases)(
    "keeps the last offered snapshot for a $totalTurns-turn match",
    ({ totalTurns, step, cap }) => {
      const lastOffered = Math.floor(totalTurns / step) * step;
      const withFinalize = retainedTurns({ totalTurns, step, cap });
      expect(withFinalize[withFinalize.length - 1]).toBe(lastOffered);
      expect(withFinalize.length).toBeLessThanOrEqual(cap);

      // Without finalize the terminal frame is genuinely lost — this is what the
      // reservation exists to prevent, and it must stay observable.
      const withoutFinalize = retainedTurns({
        totalTurns,
        step,
        cap,
        finalize: false,
      });
      const lostWithout =
        withoutFinalize[withoutFinalize.length - 1] !== lastOffered;
      expect(lostWithout || withoutFinalize.length < cap).toBe(true);
    },
  );

  it("is idempotent and never exceeds the cap", () => {
    const state = createSnapshotRetention<number>(8);
    for (let turn = 100; turn <= 10_050; turn += 100)
      offerSnapshot(state, turn);
    const once = [...finalizeSnapshotRetention(state)];
    const twice = [...finalizeSnapshotRetention(state)];
    expect(twice).toEqual(once);
    expect(once.length).toBeLessThanOrEqual(8);
    expect(once[once.length - 1]).toBe(10_000);
    expect(once[0]).toBe(100);
  });

  it("does nothing when no snapshot was ever offered", () => {
    const state = createSnapshotRetention<number>(4);
    expect(finalizeSnapshotRetention(state)).toEqual([]);
  });
});

describe("terminal frame at the cap boundary", () => {
  // Parameters chosen so the retained array is EXACTLY at cap when the episode
  // ends off-stride, which is the only path that has to drop a frame to make
  // room. Without a case like this the cap guard is never exercised.
  const boundary = [
    { totalTurns: 1_600, step: 100, cap: 8, lastOffered: 1_600 },
    { totalTurns: 19_200, step: 200, cap: 48, lastOffered: 19_200 },
    { totalTurns: 33_600, step: 350, cap: 48, lastOffered: 33_600 },
  ];

  it.each(boundary)(
    "makes room for the terminal frame without exceeding cap ($totalTurns turns)",
    ({ totalTurns, step, cap, lastOffered }) => {
      const state = createSnapshotRetention<number>(cap);
      for (let turn = step; turn <= totalTurns; turn += step) {
        offerSnapshot(state, turn);
      }
      // Precondition for this case to mean anything.
      expect(state.retained.length).toBe(cap);
      expect(state.retained[state.retained.length - 1]).not.toBe(lastOffered);

      const finalized = finalizeSnapshotRetention(state);
      expect(finalized.length).toBeLessThanOrEqual(cap);
      expect(finalized[finalized.length - 1]).toBe(lastOffered);
      // The opening frame survives the drop — only the second-to-last goes.
      expect(finalized[0]).toBe(step);
    },
  );
});
