import {
  PlatformAccountSecurity,
  PlatformSecurityError,
} from "../../../src/server/platform/PlatformAccountSecurity";

function key(): Uint8Array {
  return new Uint8Array(32).fill(7);
}

function harness(overrides?: Partial<{ production: boolean }>): PlatformAccountSecurity {
  return new PlatformAccountSecurity({
    hmacKey: key(),
    expectedOrigin: "https://app.proxywar.xyz",
    production: overrides?.production ?? true,
  });
}

describe("PlatformAccountSecurity", () => {
  test("bootstrap mints a fresh host-only cookie with no Domain attribute and Path=/", () => {
    const security = harness();
    const bootstrap = security.bootstrap(undefined);
    expect(bootstrap.setCookie).not.toBeNull();
    expect(bootstrap.setCookie).toContain(`${security.accountCookieName}=`);
    expect(bootstrap.setCookie).toContain("Path=/");
    expect(bootstrap.setCookie).not.toContain("Domain=");
    expect(bootstrap.setCookie).toContain("HttpOnly");
    expect(bootstrap.setCookie).toContain("SameSite=Lax");
    expect(bootstrap.setCookie).toContain("Secure");
    expect(bootstrap.account.accountId).toMatch(/^acct_[a-f0-9]{32}$/);
  });

  test("a non-production instance omits Secure (so it works over plain http in dev)", () => {
    const security = harness({ production: false });
    const bootstrap = security.bootstrap(undefined);
    expect(bootstrap.setCookie).not.toContain("Secure");
  });

  test("re-bootstrapping with the minted cookie reuses the SAME account id and mints no new cookie", () => {
    const security = harness();
    const first = security.bootstrap(undefined);
    const cookieValue = first.setCookie!.split(";")[0];
    const second = security.bootstrap(cookieValue);
    expect(second.setCookie).toBeNull();
    expect(second.account.accountId).toBe(first.account.accountId);
  });

  test("authorizeWrite requires a strict Origin match", () => {
    const security = harness();
    const bootstrap = security.bootstrap(undefined);
    const cookieValue = bootstrap.setCookie!.split(";")[0];
    expect(() =>
      security.authorizeWrite({
        cookie: cookieValue,
        origin: "https://evil.example.com",
        csrfToken: bootstrap.csrfToken,
      }),
    ).toThrow(PlatformSecurityError);
    const authorized = security.authorizeWrite({
      cookie: cookieValue,
      origin: "https://app.proxywar.xyz",
      csrfToken: bootstrap.csrfToken,
    });
    expect(authorized.account.accountId).toBe(bootstrap.account.accountId);
  });

  test("authorizeWrite rejects a missing or wrong CSRF token", () => {
    const security = harness();
    const bootstrap = security.bootstrap(undefined);
    const cookieValue = bootstrap.setCookie!.split(";")[0];
    expect(() =>
      security.authorizeWrite({
        cookie: cookieValue,
        origin: "https://app.proxywar.xyz",
        csrfToken: "wrong-token",
      }),
    ).toThrow(PlatformSecurityError);
  });

  test("a CSRF token minted under one HMAC key is rejected by a security instance with a different key", () => {
    const securityA = new PlatformAccountSecurity({
      hmacKey: new Uint8Array(32).fill(1),
      expectedOrigin: "https://app.proxywar.xyz",
      production: true,
    });
    const securityB = new PlatformAccountSecurity({
      hmacKey: new Uint8Array(32).fill(2),
      expectedOrigin: "https://app.proxywar.xyz",
      production: true,
    });
    const bootstrap = securityA.bootstrap(undefined);
    const cookieValue = bootstrap.setCookie!.split(";")[0];
    expect(() =>
      securityB.authorizeWrite({
        cookie: cookieValue,
        origin: "https://app.proxywar.xyz",
        csrfToken: bootstrap.csrfToken,
      }),
    ).toThrow(PlatformSecurityError);
  });

  test("link-intent cookie round-trips its nonce and rejects a mismatched account id", () => {
    const security = harness();
    const { cookie, nonce } = security.mintLinkIntentCookie(`acct_${"a".repeat(32)}`);
    const verified = security.verifyLinkIntentCookie(
      cookie.split(";")[0],
      `acct_${"a".repeat(32)}`,
    );
    expect(verified?.nonce).toBe(nonce);
    expect(
      security.verifyLinkIntentCookie(cookie.split(";")[0], `acct_${"b".repeat(32)}`),
    ).toBeNull();
  });

  test("mintCookieForAccount rejects a malformed account id", () => {
    const security = harness();
    expect(() => security.mintCookieForAccount("not-an-id")).toThrow();
  });

  test("bootstrapRead relaxes Origin to same-origin proof (Sec-Fetch-Site) but still rejects a cross-site probe", () => {
    const security = harness();
    const sameOrigin = security.bootstrapRead({ secFetchSite: "same-origin" });
    expect(sameOrigin.account.accountId).toMatch(/^acct_/);
    expect(() => security.bootstrapRead({ secFetchSite: "cross-site" })).toThrow(
      PlatformSecurityError,
    );
  });
});
