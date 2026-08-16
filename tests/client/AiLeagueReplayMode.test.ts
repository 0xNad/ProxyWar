import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aiLeagueSpectatorDisplayName,
  aiLeagueSpectatorText,
  isAiLeagueNativeSpectatorUiEnabled,
  isAiLeagueReplayRoute,
  isReplayPremiereRoute,
} from "../../src/client/AiLeagueReplayMode";
import { UserSettings } from "../../src/core/game/UserSettings";

describe("AiLeagueReplayMode", () => {
  it("recognizes only canonical replay premiere routes", () => {
    const premierePath = "/premiere/prem_0123456789abcdef";
    expect(isReplayPremiereRoute(premierePath)).toBe(true);
    expect(isAiLeagueReplayRoute(premierePath)).toBe(true);

    expect(isReplayPremiereRoute("/premiere/prem_short")).toBe(false);
    expect(
      isReplayPremiereRoute("/premiere/prem_0123456789abcdef/manifest"),
    ).toBe(false);
    expect(
      isReplayPremiereRoute("/premiere/prem_0123456789abcdef%2fsecret"),
    ).toBe(false);
    expect(isReplayPremiereRoute("/premiere/prem_0123456789ABCDEF")).toBe(
      false,
    );
  });

  it("forces dark mode only in the standalone static replay viewer", () => {
    const settings = new UserSettings();
    if (settings.darkMode()) settings.toggleDarkMode();
    expect(settings.darkMode()).toBe(false);

    window.__PROXYWAR_STATIC_REPLAY__ = true;
    expect(settings.darkMode()).toBe(true);

    delete window.__PROXYWAR_STATIC_REPLAY__;
    expect(settings.darkMode()).toBe(false);
  });
});

// UserSettings keeps its own static, process-lifetime cache on top of
// localStorage (UserSettings.cache, private) -- localStorage.clear() alone
// does NOT reset it, so a relative toggleRandomName() call can silently
// flip the WRONG direction if an earlier test in this file already changed
// it. Read-then-toggle-only-if-needed sidesteps that cache entirely by
// never assuming what the previous test left behind.
function setAnonymousNames(enabled: boolean): void {
  const settings = new UserSettings();
  if (settings.anonymousNames() !== enabled) {
    settings.toggleRandomName();
  }
}

describe("AiLeagueReplayMode anonymization (P0 fix, deploy 2B: 'Hidden Names' leaking on live feeds)", () => {
  beforeEach(() => {
    setAnonymousNames(false);
  });

  afterEach(() => {
    setAnonymousNames(false);
  });

  it("passes real names through unchanged when Anonymous Names is off (the default)", () => {
    expect(new UserSettings().anonymousNames()).toBe(false);
    expect(aiLeagueSpectatorDisplayName("daveey")).toBe("daveey");
    expect(aiLeagueSpectatorText("daveey strikes relh")).toBe(
      "daveey strikes relh",
    );
  });

  it("anonymizes a display name once Anonymous Names is on, deterministically per real name", () => {
    setAnonymousNames(true);
    expect(new UserSettings().anonymousNames()).toBe(true);

    const first = aiLeagueSpectatorDisplayName("daveey");
    expect(first).not.toBe("daveey");
    expect(first).toMatch(/^Agent \d+$/);
    // Same real name -> same anonymized label, every call, not a per-call
    // random pick (which would make a single event's own actor/target
    // text visibly disagree with itself).
    expect(aiLeagueSpectatorDisplayName("daveey")).toBe(first);

    // A different real name gets its own, distinct label.
    const second = aiLeagueSpectatorDisplayName("relh");
    expect(second).not.toBe("daveey");
    expect(second).not.toBe(first);
  });

  it("also anonymizes an already-seen name inside free text (War Room / social-transcript sentences)", () => {
    setAnonymousNames(true);
    const anonymized = aiLeagueSpectatorDisplayName("daveey");
    const text = aiLeagueSpectatorText("daveey strikes relh");
    expect(text).toContain(anonymized);
    expect(text).not.toContain("daveey");
  });
});

// The broadcast skin (pinned leaderboard, lower third, analyst drawer, and the
// body.ai-league-native-spectator-ui CSS in GameRenderer) shipped default-ON
// keyed on the static-replay bundle and the /client/* Coworld routes. That made
// a Coworld-served replay and a proxywar.xyz-served replay of the SAME match
// look like different products: our own routes fell back to a bare map. These
// pin the skin to the replay route itself.
describe("AiLeagueReplayMode native spectator UI", () => {
  const originalLocation = window.location;

  function atUrl(pathname: string, search = ""): void {
    Object.defineProperty(window, "location", {
      value: { ...originalLocation, pathname, search },
      writable: true,
      configurable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
    delete window.__PROXYWAR_STATIC_REPLAY__;
  });

  it("is on for ProxyWar's own league replay route, not just the Coworld one", () => {
    atUrl("/ai-league-replay/league-coworld-2026-08-15T23-20-11-358Z-f7195ab9");
    expect(isAiLeagueNativeSpectatorUiEnabled()).toBe(true);
  });

  it("stays on for the Coworld-served replay and player routes", () => {
    atUrl("/client/replay");
    expect(isAiLeagueNativeSpectatorUiEnabled()).toBe(true);

    atUrl("/client/player");
    expect(isAiLeagueNativeSpectatorUiEnabled()).toBe(true);
  });

  it("stays on for the static replay bundle, which has no recognizable path", () => {
    atUrl("/index.html");
    window.__PROXYWAR_STATIC_REPLAY__ = true;
    expect(isAiLeagueNativeSpectatorUiEnabled()).toBe(true);
  });

  it("is on for premieres and the legacy replay paths", () => {
    for (const pathname of [
      "/premiere/prem_0123456789abcdef",
      "/proxywar-replay/some-match",
      "/openfront-replay/some-match",
    ]) {
      atUrl(pathname);
      expect(isAiLeagueNativeSpectatorUiEnabled()).toBe(true);
    }
  });

  it("still honors the ?native-spectator-ui=0 opt-out on our own routes", () => {
    atUrl("/ai-league-replay/some-match", "?native-spectator-ui=0");
    expect(isAiLeagueNativeSpectatorUiEnabled()).toBe(false);
  });

  it("is off everywhere that is not a replay", () => {
    for (const pathname of ["/", "/league", "/watch", "/build"]) {
      atUrl(pathname);
      expect(isAiLeagueNativeSpectatorUiEnabled()).toBe(false);
    }
    // Not even with the explicit opt-in — a live game is not a broadcast.
    atUrl("/league", "?native-spectator-ui=1");
    expect(isAiLeagueNativeSpectatorUiEnabled()).toBe(false);
  });
});
