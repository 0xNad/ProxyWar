/**
 * P2 fix (2026-08-02): "refresh-resume" for an archived AI League Full
 * Replay — reloading used to lose all playback progress with no scrub
 * bar to manually get back. Coverage for the sessionStorage-backed
 * save/load pair and the `ai-league-replay-frame` watcher that drives it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadResumableReplayTurn,
  watchReplayPositionForResume,
} from "../../src/client/ReplayPositionPersistence";

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

function frameEvent(turnNumber: number): CustomEvent {
  return new CustomEvent("ai-league-replay-frame", { detail: { turnNumber } });
}

describe("loadResumableReplayTurn", () => {
  it("returns null when nothing has been saved for this run id", () => {
    expect(loadResumableReplayTurn("run-a")).toBeNull();
  });

  it("returns the saved turn once it clears the minimum resumable threshold", () => {
    sessionStorage.setItem("proxywar:replay-position:run-a", "42");
    expect(loadResumableReplayTurn("run-a")).toBe(42);
  });

  it("returns null for a position below the minimum resumable threshold — a barely-started replay just plays from the start", () => {
    sessionStorage.setItem("proxywar:replay-position:run-a", "3");
    expect(loadResumableReplayTurn("run-a")).toBeNull();
  });

  it("never leaks a different run's saved position — keyed strictly by run id", () => {
    sessionStorage.setItem("proxywar:replay-position:run-a", "500");
    expect(loadResumableReplayTurn("run-b")).toBeNull();
  });

  it("ignores a corrupt/non-numeric stored value rather than throwing", () => {
    sessionStorage.setItem("proxywar:replay-position:run-a", "not-a-number");
    expect(loadResumableReplayTurn("run-a")).toBeNull();
  });

  it("degrades to null (never throws) when sessionStorage access itself fails", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });
    expect(loadResumableReplayTurn("run-a")).toBeNull();
    spy.mockRestore();
  });
});

describe("watchReplayPositionForResume", () => {
  it("saves the turn number from ai-league-replay-frame events, resumable on the next load", () => {
    const doc = document;
    const stop = watchReplayPositionForResume("run-a", doc);
    doc.dispatchEvent(frameEvent(50));
    expect(loadResumableReplayTurn("run-a")).toBe(50);
    stop();
  });

  it("throttles saves — does not write on every single frame tick, only every SAVE_INTERVAL_TURNS turns", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const doc = document;
    const stop = watchReplayPositionForResume("run-a", doc);
    for (let turn = 0; turn < 25; turn++) {
      doc.dispatchEvent(frameEvent(turn));
    }
    // Turns 0, 10, 20 clear the 10-turn interval — at most 3 writes for 25 ticks.
    expect(setItemSpy.mock.calls.length).toBeLessThanOrEqual(3);
    expect(loadResumableReplayTurn("run-a")).toBe(20);
    stop();
    setItemSpy.mockRestore();
  });

  it("stops saving once the returned cleanup function is called", () => {
    const doc = document;
    const stop = watchReplayPositionForResume("run-a", doc);
    doc.dispatchEvent(frameEvent(50));
    stop();
    doc.dispatchEvent(frameEvent(999));
    expect(loadResumableReplayTurn("run-a")).toBe(50);
  });

  it("ignores a frame event with no turnNumber in its detail — never throws or saves garbage", () => {
    const doc = document;
    const stop = watchReplayPositionForResume("run-a", doc);
    doc.dispatchEvent(new CustomEvent("ai-league-replay-frame", { detail: {} }));
    expect(loadResumableReplayTurn("run-a")).toBeNull();
    stop();
  });
});
