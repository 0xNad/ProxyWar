import { describe, expect, it } from "vitest";
import {
  betaSessionCookieHeader,
  clearBetaSessionCookieHeader,
  createOpenFrontierBetaSessionToken,
  loadOpenFrontierBetaAccessConfig,
  normalizeOpenFrontierBetaReturnTo,
  normalizeOpenFrontierBetaFeedback,
  parseCookieHeader,
  renderOpenFrontierBetaLoginHtml,
  verifyOpenFrontierBetaInviteCode,
  verifyOpenFrontierBetaSessionToken,
} from "../../src/server/agents/OpenFrontierBetaAccess";

describe("OpenFrontierBetaAccess", () => {
  it("loads an opt-in beta invite gate without requiring it by default", () => {
    expect(loadOpenFrontierBetaAccessConfig({}).enabled).toBe(false);

    const config = loadOpenFrontierBetaAccessConfig({
      OPEN_FRONTIER_BETA_ENABLED: "true",
      OPEN_FRONTIER_BETA_CODE: "friends-only",
      OPEN_FRONTIER_BETA_COOKIE_NAME: "of_beta",
      OPEN_FRONTIER_BETA_LABEL: "Friends Beta",
      OPEN_FRONTIER_BETA_SESSION_TTL_MS: "60000",
      OPEN_FRONTIER_PUBLIC_URL: "https://frontier.example.test",
    });

    expect(config).toMatchObject({
      enabled: true,
      inviteCode: "friends-only",
      cookieName: "of_beta",
      label: "Friends Beta",
      sessionTtlMs: 60_000,
      secureCookie: true,
    });
  });

  it("creates and verifies signed beta sessions", () => {
    const config = loadOpenFrontierBetaAccessConfig({
      OPEN_FRONTIER_BETA_ENABLED: "1",
      OPEN_FRONTIER_BETA_CODE: "friends-only",
      OPEN_FRONTIER_BETA_SESSION_TTL_MS: "10000",
    });
    const token = createOpenFrontierBetaSessionToken({
      inviteCode: "friends-only",
      issuedAtMs: 1_000,
    });

    expect(
      verifyOpenFrontierBetaSessionToken({ config, token, nowMs: 2_000 }),
    ).toBe(true);
    expect(
      verifyOpenFrontierBetaSessionToken({
        config,
        token: `${token}tampered`,
        nowMs: 2_000,
      }),
    ).toBe(false);
    expect(
      verifyOpenFrontierBetaSessionToken({ config, token, nowMs: 20_000 }),
    ).toBe(false);
  });

  it("validates invite codes and cookie headers without exposing secrets", () => {
    const config = loadOpenFrontierBetaAccessConfig({
      OPEN_FRONTIER_BETA_ENABLED: "yes",
      OPEN_FRONTIER_BETA_CODE: "friends-only",
    });
    const token = createOpenFrontierBetaSessionToken({
      inviteCode: "friends-only",
      issuedAtMs: 1_000,
    });
    const cookie = betaSessionCookieHeader(config, token);

    expect(verifyOpenFrontierBetaInviteCode(config, "friends-only")).toBe(true);
    expect(verifyOpenFrontierBetaInviteCode(config, "other")).toBe(false);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toContain("friends-only");
    expect(parseCookieHeader(cookie)[config.cookieName]).toBe(token);
    expect(clearBetaSessionCookieHeader(config)).toContain("Max-Age=0");
  });

  it("marks beta cookies secure for public HTTPS deployments", () => {
    const config = loadOpenFrontierBetaAccessConfig({
      OPEN_FRONTIER_BETA_ENABLED: "yes",
      OPEN_FRONTIER_BETA_CODE: "friends-only",
      OPEN_FRONTIER_PUBLIC_URL: "https://frontier.example.test",
    });
    const cookie = betaSessionCookieHeader(config, "token");

    expect(cookie).toContain("Secure");
    expect(clearBetaSessionCookieHeader(config)).toContain("Secure");
  });

  it("renders setup guidance when the invite code is missing", () => {
    const config = loadOpenFrontierBetaAccessConfig({
      OPEN_FRONTIER_BETA_ENABLED: "true",
    });
    const html = renderOpenFrontierBetaLoginHtml(
      config,
      "Nope",
      "/ai-league-replay/run-1",
    );

    expect(html).toContain("Open Frontier");
    expect(html).toContain("OPEN_FRONTIER_BETA_CODE");
    expect(html).toContain("Nope");
    expect(html).toContain('name="returnTo" value="/ai-league-replay/run-1"');
    expect(html).toContain("After login");
  });

  it("normalizes beta return paths without allowing open redirects", () => {
    expect(normalizeOpenFrontierBetaReturnTo("/ai-league-replay/run-1")).toBe(
      "/ai-league-replay/run-1",
    );
    expect(normalizeOpenFrontierBetaReturnTo("/runs/run-1/spectator.html")).toBe(
      "/runs/run-1/spectator.html",
    );
    expect(normalizeOpenFrontierBetaReturnTo("https://evil.example")).toBe(
      "/public",
    );
    expect(normalizeOpenFrontierBetaReturnTo("//evil.example")).toBe("/public");
    expect(normalizeOpenFrontierBetaReturnTo("/api/beta/login")).toBe(
      "/public",
    );
  });

  it("normalizes bounded beta feedback", () => {
    const feedback = normalizeOpenFrontierBetaFeedback(
      {
        testerName: "Ada",
        rating: "confusing",
        runID: "run-1",
        comment: "The replay link was hard to find.",
      },
      new Date("2026-05-11T10:00:00.000Z"),
    );

    expect(feedback).toMatchObject({
      createdAt: "2026-05-11T10:00:00.000Z",
      testerName: "Ada",
      rating: "confusing",
      runID: "run-1",
      comment: "The replay link was hard to find.",
    });
    expect(feedback.feedbackID).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => normalizeOpenFrontierBetaFeedback({})).toThrow(
      "feedback needs a rating or a comment",
    );
  });
});
