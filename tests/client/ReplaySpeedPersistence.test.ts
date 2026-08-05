/**
 * P0 fix (2026-08-03): a viewer's manually-picked replay speed used to
 * reset to 1x across the `?turn=` backward-seek reload path -- the
 * in-memory `LocalServer.userOverrodeReplaySpeed` latch can't survive a
 * real page reload, which makes a fresh instance. Coverage for the
 * sessionStorage-backed save/load pair and the `ReplaySpeedChangeEvent`
 * watcher that drives it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/core/EventBus";
import { ReplaySpeedChangeEvent } from "../../src/client/InputHandler";
import {
  loadPersistedReplaySpeed,
  watchReplaySpeedForResume,
} from "../../src/client/ReplaySpeedPersistence";
import { ReplaySpeedMultiplier } from "../../src/client/utilities/ReplaySpeedMultiplier";

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("loadPersistedReplaySpeed", () => {
  it("returns null when nothing has been saved for this run id", () => {
    expect(loadPersistedReplaySpeed("run-a")).toBeNull();
  });

  it("returns the saved speed once a user-sourced change has been watched", () => {
    const eventBus = new EventBus();
    watchReplaySpeedForResume("run-a", eventBus);
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.fastest, "user"),
    );
    expect(loadPersistedReplaySpeed("run-a")).toBe(
      ReplaySpeedMultiplier.fastest,
    );
  });

  it("never leaks a different run's saved speed — keyed strictly by run id", () => {
    const eventBus = new EventBus();
    watchReplaySpeedForResume("run-a", eventBus);
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.fast, "user"),
    );
    expect(loadPersistedReplaySpeed("run-b")).toBeNull();
  });

  it("ignores a corrupt/unrecognised stored value rather than throwing", () => {
    sessionStorage.setItem("proxywar:replay-speed:run-a", "not-a-speed");
    expect(loadPersistedReplaySpeed("run-a")).toBeNull();
  });

  it("degrades to null (never throws) when sessionStorage access itself fails", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => loadPersistedReplaySpeed("run-a")).not.toThrow();
    expect(loadPersistedReplaySpeed("run-a")).toBeNull();
  });
});

describe("watchReplaySpeedForResume", () => {
  it("persists a user-sourced speed change, resumable on the next load", () => {
    const eventBus = new EventBus();
    watchReplaySpeedForResume("run-a", eventBus);
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.slow, "user"),
    );
    expect(loadPersistedReplaySpeed("run-a")).toBe(
      ReplaySpeedMultiplier.slow,
    );
  });

  it("never persists an 'auto'-sourced speed change — only an explicit user pick should ever be restored", () => {
    const eventBus = new EventBus();
    watchReplaySpeedForResume("run-a", eventBus);
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.fastest, "auto"),
    );
    expect(loadPersistedReplaySpeed("run-a")).toBeNull();
  });

  it("stops persisting once the returned cleanup function is called", () => {
    const eventBus = new EventBus();
    const stopWatching = watchReplaySpeedForResume("run-a", eventBus);
    stopWatching();
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.fast, "user"),
    );
    expect(loadPersistedReplaySpeed("run-a")).toBeNull();
  });

  it("overwrites an earlier persisted pick with the latest user choice", () => {
    const eventBus = new EventBus();
    watchReplaySpeedForResume("run-a", eventBus);
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.slow, "user"),
    );
    eventBus.emit(
      new ReplaySpeedChangeEvent(ReplaySpeedMultiplier.fastest, "user"),
    );
    expect(loadPersistedReplaySpeed("run-a")).toBe(
      ReplaySpeedMultiplier.fastest,
    );
  });
});
