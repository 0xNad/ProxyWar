import { describe, expect, it, vi } from "vitest";
import {
  directorCutSpeedForSegment,
  mountDirectorCutController,
  normalizeDirectorCutPlan,
  segmentForTurn,
  type DirectorCutPlan,
  type DirectorCutSegment,
} from "../../src/client/DirectorCutController";
import { ReplaySpeedMultiplier } from "../../src/client/utilities/ReplaySpeedMultiplier";

function segment(overrides: Partial<DirectorCutSegment>): DirectorCutSegment {
  return {
    startTurn: 0,
    endTurn: 99,
    speed: "fast",
    eventReason: "quiet_interval",
    importance: 0,
    participatingAgents: [],
    ...overrides,
  };
}

function plan(segments: DirectorCutSegment[]): DirectorCutPlan {
  return {
    schemaVersion: 1,
    reportKind: "director-cut-plan",
    runID: "run-1",
    matchID: "match-1",
    generatedAt: "2026-07-31T00:00:00.000Z",
    totalTurns: segments.length > 0 ? segments[segments.length - 1].endTurn : 0,
    segments,
    importantTurnCount: 0,
    estimatedDurationSeconds: 300,
    degraded: false,
    notes: [],
  };
}

const THREE_SEGMENT_PLAN = plan([
  segment({ startTurn: 0, endTurn: 199, speed: "fast", eventReason: "quiet_interval" }),
  segment({ startTurn: 200, endTurn: 249, speed: "slow", eventReason: "nuke", importance: 95 }),
  segment({ startTurn: 250, endTurn: 999, speed: "normal", eventReason: "major_attack", importance: 70 }),
]);

describe("segmentForTurn", () => {
  it("finds the segment covering the first turn, an interior turn, and the last turn of a range", () => {
    expect(segmentForTurn(THREE_SEGMENT_PLAN, 0)?.index).toBe(0);
    expect(segmentForTurn(THREE_SEGMENT_PLAN, 150)?.index).toBe(0);
    expect(segmentForTurn(THREE_SEGMENT_PLAN, 199)?.index).toBe(0);
  });

  it("resolves exact segment boundaries to the correct neighbor", () => {
    expect(segmentForTurn(THREE_SEGMENT_PLAN, 200)?.index).toBe(1);
    expect(segmentForTurn(THREE_SEGMENT_PLAN, 249)?.index).toBe(1);
    expect(segmentForTurn(THREE_SEGMENT_PLAN, 250)?.index).toBe(2);
  });

  it("returns null for a turn outside every segment's range", () => {
    expect(segmentForTurn(THREE_SEGMENT_PLAN, 1_000)).toBeNull();
    expect(segmentForTurn(THREE_SEGMENT_PLAN, -1)).toBeNull();
  });
});

describe("directorCutSpeedForSegment", () => {
  it("maps slow and normal directly to their same-named client speed", () => {
    expect(directorCutSpeedForSegment(segment({ speed: "slow" }))).toBe(
      ReplaySpeedMultiplier.slow,
    );
    expect(directorCutSpeedForSegment(segment({ speed: "normal" }))).toBe(
      ReplaySpeedMultiplier.normal,
    );
  });

  it("maps the plan's fast tier to the client's fastest (zero-delay) speed, not its own fast", () => {
    expect(directorCutSpeedForSegment(segment({ speed: "fast" }))).toBe(
      ReplaySpeedMultiplier.fastest,
    );
    expect(directorCutSpeedForSegment(segment({ speed: "fast" }))).not.toBe(
      ReplaySpeedMultiplier.fast,
    );
  });
});

describe("normalizeDirectorCutPlan", () => {
  it("accepts a well-formed plan", () => {
    expect(normalizeDirectorCutPlan(THREE_SEGMENT_PLAN)).not.toBeNull();
  });

  it("rejects null, non-objects, wrong schemaVersion/reportKind, and an empty segments array", () => {
    expect(normalizeDirectorCutPlan(null)).toBeNull();
    expect(normalizeDirectorCutPlan("plan")).toBeNull();
    expect(
      normalizeDirectorCutPlan({ ...THREE_SEGMENT_PLAN, schemaVersion: 2 }),
    ).toBeNull();
    expect(
      normalizeDirectorCutPlan({
        ...THREE_SEGMENT_PLAN,
        reportKind: "something-else",
      }),
    ).toBeNull();
    expect(normalizeDirectorCutPlan({ ...THREE_SEGMENT_PLAN, segments: [] })).toBeNull();
  });

  it("rejects a plan whose segments carry an invalid speed tier", () => {
    expect(
      normalizeDirectorCutPlan(
        plan([segment({ speed: "ludicrous" as DirectorCutSegment["speed"] })]),
      ),
    ).toBeNull();
  });
});

function dispatchFrame(doc: Document, tick: number) {
  doc.dispatchEvent(
    new CustomEvent("ai-league-replay-frame", { detail: { tick } }),
  );
}

describe("mountDirectorCutController", () => {
  it("applies the opening segment's speed immediately when mounted enabled", () => {
    const onSpeedChange = vi.fn();
    const handle = mountDirectorCutController({
      plan: THREE_SEGMENT_PLAN,
      enabledByDefault: true,
      onSpeedChange,
      documentRef: document,
    });
    expect(onSpeedChange).toHaveBeenCalledExactlyOnceWith(
      ReplaySpeedMultiplier.fastest,
    );
    handle.dispose();
  });

  it("emits a speed change only when the turn crosses into a new segment, never every frame", () => {
    const onSpeedChange = vi.fn();
    const onSegmentChange = vi.fn();
    const handle = mountDirectorCutController({
      plan: THREE_SEGMENT_PLAN,
      enabledByDefault: true,
      onSpeedChange,
      onSegmentChange,
      documentRef: document,
    });
    onSpeedChange.mockClear();
    onSegmentChange.mockClear();

    dispatchFrame(document, 50);
    dispatchFrame(document, 120);
    expect(onSpeedChange).not.toHaveBeenCalled();

    dispatchFrame(document, 200);
    expect(onSpeedChange).toHaveBeenCalledExactlyOnceWith(
      ReplaySpeedMultiplier.slow,
    );
    expect(onSegmentChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ eventReason: "nuke" }),
    );

    onSpeedChange.mockClear();
    dispatchFrame(document, 230);
    expect(onSpeedChange).not.toHaveBeenCalled();

    dispatchFrame(document, 250);
    expect(onSpeedChange).toHaveBeenCalledExactlyOnceWith(
      ReplaySpeedMultiplier.normal,
    );
    handle.dispose();
  });

  it("does nothing while disabled, and never emits a speed change", () => {
    const onSpeedChange = vi.fn();
    const handle = mountDirectorCutController({
      plan: THREE_SEGMENT_PLAN,
      enabledByDefault: false,
      onSpeedChange,
      documentRef: document,
    });
    expect(onSpeedChange).not.toHaveBeenCalled();
    dispatchFrame(document, 200);
    expect(onSpeedChange).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("resets to normal speed and clears the current segment when disabled mid-playback", () => {
    const onSpeedChange = vi.fn();
    const onSegmentChange = vi.fn();
    const handle = mountDirectorCutController({
      plan: THREE_SEGMENT_PLAN,
      enabledByDefault: true,
      onSpeedChange,
      onSegmentChange,
      documentRef: document,
    });
    dispatchFrame(document, 200);
    onSpeedChange.mockClear();
    onSegmentChange.mockClear();

    handle.setEnabled(false);
    expect(onSpeedChange).toHaveBeenCalledExactlyOnceWith(
      ReplaySpeedMultiplier.normal,
    );
    expect(onSegmentChange).toHaveBeenCalledExactlyOnceWith(null);
    expect(handle.isEnabled()).toBe(false);

    onSpeedChange.mockClear();
    dispatchFrame(document, 250);
    expect(onSpeedChange).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("re-syncs to the plan's current segment when re-enabled", () => {
    const onSpeedChange = vi.fn();
    const handle = mountDirectorCutController({
      plan: THREE_SEGMENT_PLAN,
      enabledByDefault: false,
      onSpeedChange,
      documentRef: document,
    });
    handle.setEnabled(true);
    expect(onSpeedChange).toHaveBeenCalledExactlyOnceWith(
      ReplaySpeedMultiplier.fastest,
    );
    handle.dispose();
  });

  it("applies the segment covering a nonzero currentTurn when mounted enabled — late plan hydration, not the opening segment", () => {
    const onSpeedChange = vi.fn();
    const handle = mountDirectorCutController({
      plan: THREE_SEGMENT_PLAN,
      enabledByDefault: true,
      onSpeedChange,
      documentRef: document,
      currentTurn: 230,
    });
    // Plan JSON can resolve well after playback started; turn 230 is in
    // the "slow" (nuke) segment, not the opening "fastest" one — mounting
    // enabled must never apply turn 0's segment regardless of where
    // playback actually is.
    expect(onSpeedChange).toHaveBeenCalledExactlyOnceWith(
      ReplaySpeedMultiplier.slow,
    );
    handle.dispose();
  });

  it("re-syncs to the CURRENT turn's segment when re-enabled mid-match, not the opening segment — the masking bug the turn-0 case above cannot catch", () => {
    const onSpeedChange = vi.fn();
    const handle = mountDirectorCutController({
      plan: THREE_SEGMENT_PLAN,
      enabledByDefault: false,
      onSpeedChange,
      documentRef: document,
    });
    // Turn 0's segment is coincidentally "fastest", the same value a
    // hardcoded-to-0 bug would also produce — passing a currentTurn whose
    // segment DIFFERS from turn 0's is what actually proves setEnabled
    // reads the passed turn instead of always resyncing to the opening
    // segment.
    handle.setEnabled(true, 230);
    expect(onSpeedChange).toHaveBeenCalledExactlyOnceWith(
      ReplaySpeedMultiplier.slow,
    );
    handle.dispose();
  });

  it("stops reacting to frames after dispose", () => {
    const onSpeedChange = vi.fn();
    const handle = mountDirectorCutController({
      plan: THREE_SEGMENT_PLAN,
      enabledByDefault: true,
      onSpeedChange,
      documentRef: document,
    });
    onSpeedChange.mockClear();
    handle.dispose();
    dispatchFrame(document, 200);
    expect(onSpeedChange).not.toHaveBeenCalled();
  });
});
