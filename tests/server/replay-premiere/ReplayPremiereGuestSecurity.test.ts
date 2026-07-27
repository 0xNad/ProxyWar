import { ReplayPremiereError } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import {
  isReplayPremiereBotUserAgent,
  ReplayPremiereGuestSecurity,
} from "../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";

describe("ReplayPremiereGuestSecurity", () => {
  const origin = "https://beta.proxywar.xyz";

  function harness(production = true) {
    let nowMs = Date.parse("2026-07-20T12:00:00.000Z");
    let randomByte = 1;
    const security = new ReplayPremiereGuestSecurity({
      hmacKey: new Uint8Array(32).fill(7),
      expectedOrigin: origin,
      production,
      now: () => new Date(nowMs),
      randomBytes: (size) => {
        const bytes = new Uint8Array(size).fill(randomByte);
        randomByte += 1;
        return bytes;
      },
    });
    return {
      security,
      advance(ms: number) {
        nowMs += ms;
      },
    };
  }

  it("issues a production-safe HttpOnly cookie and authorizes exact Origin plus CSRF", () => {
    const { security } = harness();
    const bootstrap = security.bootstrap(undefined);
    expect(bootstrap.setCookie).toContain("Secure");
    expect(bootstrap.setCookie).toContain("HttpOnly");
    expect(bootstrap.setCookie).toContain("SameSite=Lax");
    expect(bootstrap.setCookie).toContain("Path=/api/premieres");
    const cookie = bootstrap.setCookie?.split(";", 1)[0];
    expect(cookie).toBeDefined();

    expect(
      security.authorizeWrite({
        cookie,
        origin,
        csrfToken: bootstrap.csrfToken,
      }).participant,
    ).toEqual(bootstrap.participant);

    for (const headers of [
      {
        cookie,
        origin: "https://evil.example",
        csrfToken: bootstrap.csrfToken,
      },
      { cookie, origin, csrfToken: `${bootstrap.csrfToken}x` },
      { cookie, origin },
      { origin, csrfToken: bootstrap.csrfToken },
    ]) {
      expect(() => security.authorizeWrite(headers)).toThrow(
        ReplayPremiereError,
      );
    }
  });

  it("rejects duplicate cookie smuggling and expired CSRF tokens", () => {
    const { security, advance } = harness(false);
    const bootstrap = security.bootstrap(undefined);
    const cookie = bootstrap.setCookie?.split(";", 1)[0] ?? "";
    expect(bootstrap.setCookie).not.toContain("Secure");

    expect(() =>
      security.authorizeWrite({
        cookie: `${cookie}; ${cookie}`,
        origin,
        csrfToken: bootstrap.csrfToken,
      }),
    ).toThrow(ReplayPremiereError);

    advance(4 * 60 * 60 * 1_000);
    expect(() =>
      security.authorizeWrite({
        cookie,
        origin,
        csrfToken: bootstrap.csrfToken,
      }),
    ).toThrow(ReplayPremiereError);
  });

  it("bootstraps the first same-origin session but requires CSRF for an existing cookie", () => {
    const { security } = harness();
    const first = security.authorizeSessionCreation({ origin });
    const cookie = first.setCookie?.split(";", 1)[0] ?? "";
    expect(first.setCookie).not.toBeNull();

    const reloadBootstrap = security.authorizeSessionCreation({
      cookie,
      origin,
    });
    expect(reloadBootstrap.participant).toEqual(first.participant);
    expect(reloadBootstrap.setCookie).toBeNull();
    expect(reloadBootstrap.csrfToken).toEqual(expect.any(String));
    expect(
      security.authorizeWrite({
        cookie,
        origin,
        csrfToken: reloadBootstrap.csrfToken,
      }).participant,
    ).toEqual(first.participant);
    expect(() =>
      security.authorizeSessionCreation({ origin: "https://evil.example" }),
    ).toThrow(ReplayPremiereError);
  });

  it("signs a tamper-evident seven-day share attribution token", () => {
    const { security, advance } = harness();
    const token = security.signShareAttribution({
      attributionId: `guest_${"a".repeat(32)}`,
      shareId: `share_${"b".repeat(32)}`,
      premiereId: "prem_abcdefghijklmnop",
    });
    expect(security.verifyShareAttribution(token)).toMatchObject({
      attributionId: `guest_${"a".repeat(32)}`,
      shareId: `share_${"b".repeat(32)}`,
      premiereId: "prem_abcdefghijklmnop",
    });
    expect(
      security.verifyShareAttribution(`${token.slice(0, -1)}0`),
    ).toBeNull();

    advance(7 * 24 * 60 * 60 * 1_000);
    expect(security.verifyShareAttribution(token)).toBeNull();
  });

  it("derives stable opaque requester buckets from trusted transport addresses", () => {
    const { security } = harness();
    const first = security.deriveRequesterBucketId("203.0.113.7");
    expect(first).toMatch(/^ip_[a-f0-9]{64}$/);
    expect(security.deriveRequesterBucketId("203.0.113.7")).toBe(first);
    expect(security.deriveRequesterBucketId("203.0.113.8")).not.toBe(first);
    expect(first).not.toContain("203.0.113.7");
    expect(() =>
      security.deriveRequesterBucketId("203.0.113.7\nforwarded"),
    ).toThrow(ReplayPremiereError);
  });

  it("accepts normal comma-bearing browser user agents and fails closed on unclassifiable values", () => {
    const browserUserAgent =
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    expect(isReplayPremiereBotUserAgent(browserUserAgent)).toBe(false);
    expect(
      isReplayPremiereBotUserAgent(`${browserUserAgent} Twitterbot/1.0`),
    ).toBe(true);
    for (const unclassifiable of [
      undefined,
      [],
      [browserUserAgent],
      "",
      "   ",
      "Mozilla/5.0\u0000Safari/537.36",
      "x".repeat(1_025),
    ]) {
      expect(isReplayPremiereBotUserAgent(unclassifiable)).toBe(true);
    }
  });

  it("mints a signed, short-lived link-intent cookie bound to one participant, and rejects a mismatched or expired one", () => {
    const { security, advance } = harness();
    const bootstrap = security.bootstrap(undefined);
    const guestCookie = bootstrap.setCookie?.split(";", 1)[0] ?? "";
    const otherBootstrap = security.bootstrap(undefined);
    const otherCookie = otherBootstrap.setCookie?.split(";", 1)[0] ?? "";

    const { cookie: linkCookieHeader, nonce } = security.mintLinkIntentCookie(
      bootstrap.participant.participantId,
    );
    expect(linkCookieHeader).toContain("HttpOnly");
    expect(linkCookieHeader).toContain("SameSite=Lax");
    expect(linkCookieHeader).toContain("Path=/api/premieres");
    const linkCookie = linkCookieHeader.split(";", 1)[0];

    const verified = security.verifyLinkIntentCookie(
      linkCookie,
      bootstrap.participant.participantId,
    );
    expect(verified).toEqual({ nonce });

    // Bound to the participant that minted it — a DIFFERENT current guest
    // cookie must never be able to consume someone else's link intent.
    expect(
      security.verifyLinkIntentCookie(
        linkCookie,
        otherBootstrap.participant.participantId,
      ),
    ).toBeNull();
    expect(otherCookie).not.toBe(guestCookie);

    // Missing, tampered, or expired cookie all reject.
    expect(
      security.verifyLinkIntentCookie(undefined, bootstrap.participant.participantId),
    ).toBeNull();
    const lastChar = linkCookie.at(-1) ?? "0";
    const tampered = `${linkCookie.slice(0, -1)}${lastChar === "0" ? "1" : "0"}`;
    expect(
      security.verifyLinkIntentCookie(tampered, bootstrap.participant.participantId),
    ).toBeNull();
    advance(6 * 60 * 1_000);
    expect(
      security.verifyLinkIntentCookie(linkCookie, bootstrap.participant.participantId),
    ).toBeNull();

    const clearHeader = security.clearLinkIntentCookieHeader();
    expect(clearHeader).toContain("Max-Age=0");
  });

  it("identifyGuest reads the guest cookie with no Origin/Referer requirement, for the cross-site OAuth callback", () => {
    const { security } = harness();
    const bootstrap = security.bootstrap(undefined);
    const guestCookie = bootstrap.setCookie?.split(";", 1)[0] ?? "";

    // No Origin, no Sec-Fetch-Site, no Referer at all — exactly what a
    // cross-site redirect back from github.com looks like — must still work.
    const identified = security.identifyGuest(guestCookie);
    expect(identified).toEqual(bootstrap.participant);

    expect(security.identifyGuest(undefined)).toBeNull();
    expect(security.identifyGuest(`${guestCookie}x`)).toBeNull();
  });
});
