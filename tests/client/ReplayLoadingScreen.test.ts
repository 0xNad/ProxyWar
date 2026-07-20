import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  holdReplayLoadingScreenUntilFirstFrame,
  runReplayStartup,
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

  it("hides recovery actions when a new replay attempt starts", () => {
    showReplayLoadingFailure();

    showReplayLoadingScreen();

    const screen = document.getElementById("proxywar-replay-loading");
    expect(screen?.getAttribute("role")).toBe("status");
    expect(
      screen?.querySelector<HTMLButtonElement>("[data-replay-loading-retry]")
        ?.hidden,
    ).toBe(true);
    expect(
      screen?.querySelector<HTMLAnchorElement>("[data-replay-loading-back]")
        ?.hidden,
    ).toBe(true);
  });
});
