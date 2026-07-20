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

  it("classifies missing and crawler user agents as non-qualified", () => {
    expect(isReplayPremiereBotUserAgent(undefined)).toBe(true);
    expect(isReplayPremiereBotUserAgent("Twitterbot/1.0")).toBe(true);
    expect(isReplayPremiereBotUserAgent("Mozilla/5.0 Safari/605.1.15")).toBe(
      false,
    );
  });
});
