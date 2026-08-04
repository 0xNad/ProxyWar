import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aiLeagueSpectatorDisplayName,
  aiLeagueSpectatorText,
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
