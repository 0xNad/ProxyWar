import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("../../src/client/analytics/AnalyticsClient", () => ({
  analytics: { track: trackMock, trackVisitStart: vi.fn() },
}));

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => {
    const translations: Record<string, string> = {
      "ai_league_replay.loading_replay": "Loading replay…",
      "ai_league_replay.waiting_for_replay": "Waiting for Proxy War replay…",
      "ai_league_replay.loading_slow": "Replay is taking longer than expected…",
      "ai_league_replay.loading_failed": "Replay unavailable.",
      "ai_league_replay.retry": "Retry",
      "ai_league_replay.back_to_league": "Back to league",
    };
    return translations[key] ?? key;
  }),
}));

import {
  createJoinSyncWatchdog,
  holdReplayLoadingScreenUntilFirstFrame,
  runReplayStartup,
  setReplayLoadingProgress,
  showReplayLoadingFailure,
  showReplayLoadingScreen,
} from "../../src/client/ReplayLoadingScreen";

describe("ReplayLoadingScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.className = "preload proxywar-replay-route";
    document.body.innerHTML = `
      <div id="proxywar-coworld-splash"></div>
      <div id="proxywar-replay-loading" role="status" aria-busy="true">
        <div class="proxywar-replay-loading-content">
          <div class="proxywar-replay-loading-spinner" aria-hidden="true"></div>
          <p data-replay-loading-message></p>
          <div class="proxywar-replay-loading-actions">
            <button type="button" data-replay-loading-retry hidden></button>
            <a href="/league" data-replay-loading-back hidden></a>
          </div>
        </div>
      </div>
      <div id="page-play"></div>
    `;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    trackMock.mockClear();
  });

  it("takes ownership of the static first-paint screen without duplicating it", () => {
    const first = showReplayLoadingScreen();
    const second = showReplayLoadingScreen();

    expect(second).toBe(first);
    expect(document.querySelectorAll("#proxywar-replay-loading")).toHaveLength(
      1,
    );
    expect(document.documentElement.classList).toContain(
      "proxywar-replay-booting",
    );
    expect(first.getAttribute("aria-busy")).toBe("true");
    expect(
      first.querySelector("[data-replay-loading-message]")?.textContent,
    ).toBe("Loading replay…");
    expect(document.getElementById("proxywar-coworld-splash")).toBeNull();
  });

  it("shows the premiere-specific boot message on premiere routes", () => {
    holdReplayLoadingScreenUntilFirstFrame(
      undefined,
      "replay_premiere.loading_premiere",
    );
    expect(document.documentElement.classList).toContain(
      "proxywar-replay-booting",
    );
    expect(
      document.querySelector<HTMLElement>("[data-replay-loading-message]")
        ?.dataset.i18n,
    ).toBe("replay_premiere.loading_premiere");
  });

  it("shows and clears the join-sync progress subline", () => {
    showReplayLoadingScreen("replay_premiere.joining_live");
    const progress = document.querySelector<HTMLElement>(
      "[data-replay-loading-progress]",
    );
    expect(progress).not.toBeNull();
    expect(progress?.hidden).toBe(true);

    setReplayLoadingProgress("Syncing to turn 17,000…");
    expect(progress?.hidden).toBe(false);
    expect(progress?.textContent).toBe("Syncing to turn 17,000…");

    setReplayLoadingProgress(null);
    expect(progress?.hidden).toBe(true);
    expect(progress?.textContent).toBe("");

    // A fresh veil never inherits a stale progress line.
    setReplayLoadingProgress("stale");
    showReplayLoadingScreen("replay_premiere.loading_premiere");
    expect(
      document.querySelector<HTMLElement>("[data-replay-loading-progress]")
        ?.hidden,
    ).toBe(true);
  });

  it("keeps the cover up when loading takes longer than the threshold", () => {
    holdReplayLoadingScreenUntilFirstFrame(1_000);

    vi.advanceTimersByTime(1_000);

    expect(document.getElementById("proxywar-replay-loading")).not.toBeNull();
    expect(document.documentElement.classList).toContain(
      "proxywar-replay-booting",
    );
    expect(
      document.querySelector("[data-replay-loading-message]")?.textContent,
    ).toBe("Replay is taking longer than expected…");
  });

  it("offers Retry once loading is taking longer than expected, not just on terminal failure", () => {
    holdReplayLoadingScreenUntilFirstFrame(1_000);

    vi.advanceTimersByTime(1_000);

    const screen = document.getElementById("proxywar-replay-loading");
    const retry = screen?.querySelector<HTMLButtonElement>(
      "[data-replay-loading-retry]",
    );
    expect(retry?.hidden).toBe(false);
    expect(retry?.textContent).toBe("Retry");
  });

  it("uncovers the game only after the first rendered replay frame", () => {
    holdReplayLoadingScreenUntilFirstFrame();

    document.dispatchEvent(new CustomEvent("ai-league-replay-frame"));

    expect(document.getElementById("proxywar-replay-loading")).toBeNull();
    expect(document.documentElement.classList).not.toContain(
      "proxywar-replay-booting",
    );
    expect(document.documentElement.classList).toContain(
      "proxywar-replay-route",
    );
  });

  it("keeps an opaque retry state when rendering fails before a frame", () => {
    holdReplayLoadingScreenUntilFirstFrame();

    document.dispatchEvent(new CustomEvent("ai-league-replay-load-error"));
    document.dispatchEvent(new CustomEvent("ai-league-replay-frame"));

    const screen = document.getElementById("proxywar-replay-loading");
    expect(screen).not.toBeNull();
    expect(screen?.getAttribute("aria-busy")).toBe("false");
    expect(
      screen?.querySelector("[data-replay-loading-message]")?.textContent,
    ).toBe("Replay unavailable.");
    const retry = screen?.querySelector<HTMLButtonElement>(
      "[data-replay-loading-retry]",
    );
    expect(retry?.hidden).toBe(false);
    expect(retry?.textContent).toBe("Retry");
    expect(document.activeElement).toBe(retry);
    expect(screen?.getAttribute("role")).toBe("alert");
    const back = screen?.querySelector<HTMLAnchorElement>(
      "[data-replay-loading-back]",
    );
    expect(back?.hidden).toBe(false);
    expect(back?.textContent).toBe("Back to league");
    expect(back?.getAttribute("href")).toBe("/league");
  });

  it("tells the embedding host about first frame and failure", () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "parent", {
      value: { postMessage },
      configurable: true,
      writable: true,
    });
    try {
      holdReplayLoadingScreenUntilFirstFrame();
      document.dispatchEvent(new CustomEvent("ai-league-replay-frame"));
      expect(postMessage).not.toHaveBeenCalled();
      vi.runOnlyPendingTimers();
      expect(postMessage).toHaveBeenCalledWith(
        { src: "coworld-replay", type: "ready" },
        "*",
      );

      showReplayLoadingFailure("Replay bytes were corrupt");
      expect(postMessage).toHaveBeenLastCalledWith(
        {
          src: "coworld-replay",
          type: "error",
          message: "Replay bytes were corrupt",
        },
        "*",
      );
    } finally {
      Object.defineProperty(window, "parent", {
        value: window,
        configurable: true,
        writable: true,
      });
    }
  });

  it("does not let a cancelled first-frame listener remove a failure screen", () => {
    const cleanup = holdReplayLoadingScreenUntilFirstFrame();
    cleanup();
    showReplayLoadingFailure();

    document.dispatchEvent(new CustomEvent("ai-league-replay-frame"));

    expect(document.getElementById("proxywar-replay-loading")).not.toBeNull();
    expect(
      document.querySelector("[data-replay-loading-message]")?.textContent,
    ).toBe("Replay unavailable.");
  });

  it("turns an early replay startup rejection into the failure state", async () => {
    showReplayLoadingScreen();

    await runReplayStartup(
      async () => Promise.reject(new Error("runtime config unavailable")),
      () => showReplayLoadingFailure(),
    );

    const screen = document.getElementById("proxywar-replay-loading");
    expect(screen?.getAttribute("aria-busy")).toBe("false");
    expect(
      screen?.querySelector("[data-replay-loading-message]")?.textContent,
    ).toBe("Replay unavailable.");
  });

  it("hides retry but keeps an escape route when a new replay attempt starts", () => {
    showReplayLoadingFailure();

    showReplayLoadingScreen();

    const screen = document.getElementById("proxywar-replay-loading");
    expect(screen?.getAttribute("role")).toBe("status");
    expect(
      screen?.querySelector<HTMLButtonElement>("[data-replay-loading-retry]")
        ?.hidden,
    ).toBe(true);
    // Back-to-league stays reachable for the whole loading sequence: a join can
    // hang without ever raising an error, so gating the only escape on a failure
    // state left keyboard users with nothing focusable but the status region.
    expect(
      screen?.querySelector<HTMLAnchorElement>("[data-replay-loading-back]")
        ?.hidden,
    ).toBe(false);
  });
});

describe("ReplayLoadingScreen analytics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.className = "preload proxywar-replay-route";
    document.body.innerHTML = `
      <div id="proxywar-coworld-splash"></div>
      <div id="proxywar-replay-loading" role="status" aria-busy="true">
        <div class="proxywar-replay-loading-content">
          <div class="proxywar-replay-loading-spinner" aria-hidden="true"></div>
          <p data-replay-loading-message></p>
          <div class="proxywar-replay-loading-actions">
            <button type="button" data-replay-loading-retry hidden></button>
            <a href="/league" data-replay-loading-back hidden></a>
          </div>
        </div>
      </div>
    `;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    trackMock.mockClear();
  });

  it("tracks replay_load_started with the matchId as soon as loading begins", () => {
    const cleanup = holdReplayLoadingScreenUntilFirstFrame(
      undefined,
      undefined,
      "run-abc123",
    );
    expect(trackMock).toHaveBeenCalledWith("replay_load_started", {
      matchId: "run-abc123",
    });
    cleanup();
  });

  it("tracks replay_load_started with no context when no matchId is supplied", () => {
    const cleanup = holdReplayLoadingScreenUntilFirstFrame();
    expect(trackMock).toHaveBeenCalledWith("replay_load_started", undefined);
    cleanup();
  });

  it("tracks replay_load_succeeded exactly once when the first frame lands", () => {
    holdReplayLoadingScreenUntilFirstFrame(undefined, undefined, "run-abc123");
    trackMock.mockClear();
    document.dispatchEvent(new CustomEvent("ai-league-replay-frame"));
    expect(trackMock).toHaveBeenCalledExactlyOnceWith("replay_load_succeeded", {
      matchId: "run-abc123",
    });

    // {once:true} listeners: a second frame event must not refire it.
    document.dispatchEvent(new CustomEvent("ai-league-replay-frame"));
    expect(trackMock).toHaveBeenCalledOnce();
  });

  it("tracks replay_load_failed with a bounded reason code when loading errors out", () => {
    holdReplayLoadingScreenUntilFirstFrame(undefined, undefined, "run-abc123");
    trackMock.mockClear();
    document.dispatchEvent(new CustomEvent("ai-league-replay-load-error"));
    expect(trackMock).toHaveBeenCalledExactlyOnceWith("replay_load_failed", {
      reason: "load_error",
      matchId: "run-abc123",
    });

    // Success can never land after a reported failure ({once:true} cleanup).
    document.dispatchEvent(new CustomEvent("ai-league-replay-frame"));
    expect(trackMock).toHaveBeenCalledOnce();
  });
});

describe("createJoinSyncWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("never fires while forward progress keeps arriving faster than the timeout", () => {
    const onStalled = vi.fn();
    const onRecovered = vi.fn();
    const watchdog = createJoinSyncWatchdog({ onStalled, onRecovered }, 1_000);
    watchdog.arm();

    // Ten steps of progress, each inside the window, spanning far more
    // real time in total than the timeout alone would tolerate -- the
    // regression this pins: a fixed one-shot deadline used to fire here
    // regardless of this ongoing progress.
    for (let turn = 1; turn <= 10; turn += 1) {
      vi.advanceTimersByTime(900);
      watchdog.recordProgress(turn);
    }

    expect(onStalled).not.toHaveBeenCalled();
    expect(watchdog.stalled).toBe(false);
  });

  it("fires after a genuine stall -- no progress at all for the full window", () => {
    const onStalled = vi.fn();
    const onRecovered = vi.fn();
    const watchdog = createJoinSyncWatchdog({ onStalled, onRecovered }, 1_000);
    watchdog.arm();

    vi.advanceTimersByTime(1_000);

    expect(onStalled).toHaveBeenCalledOnce();
    expect(watchdog.stalled).toBe(true);
  });

  it("clears a latched stall and notifies recovery the moment progress resumes", () => {
    const onStalled = vi.fn();
    const onRecovered = vi.fn();
    const watchdog = createJoinSyncWatchdog({ onStalled, onRecovered }, 1_000);
    watchdog.arm();

    vi.advanceTimersByTime(1_000);
    expect(watchdog.stalled).toBe(true);

    watchdog.recordProgress(5);

    expect(onRecovered).toHaveBeenCalledOnce();
    expect(watchdog.stalled).toBe(false);
  });

  it("ignores a null or non-advancing turn -- never rearms, never clears a latched stall", () => {
    const onStalled = vi.fn();
    const onRecovered = vi.fn();
    const watchdog = createJoinSyncWatchdog({ onStalled, onRecovered }, 1_000);
    watchdog.arm();
    // Establish a baseline turn so subsequent null/repeat calls are
    // genuinely non-advancing rather than a first sighting.
    watchdog.recordProgress(3);

    vi.advanceTimersByTime(500);
    watchdog.recordProgress(null);
    watchdog.recordProgress(3);
    vi.advanceTimersByTime(500);

    expect(onStalled).toHaveBeenCalledOnce();
    expect(watchdog.stalled).toBe(true);

    watchdog.recordProgress(null);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(watchdog.stalled).toBe(true);
  });

  it("clear() cancels the pending timer so it never fires after disposal", () => {
    const onStalled = vi.fn();
    const onRecovered = vi.fn();
    const watchdog = createJoinSyncWatchdog({ onStalled, onRecovered }, 1_000);
    watchdog.arm();

    watchdog.clear();
    vi.advanceTimersByTime(5_000);

    expect(onStalled).not.toHaveBeenCalled();
  });
});
