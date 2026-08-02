import { resolveCanonicalHostRedirect } from "../../../src/server/platform/PlatformCanonicalHost";

const APEX = "https://proxywar.xyz";

function redirectFor(
  overrides: Partial<Parameters<typeof resolveCanonicalHostRedirect>[0]> = {},
): string | null {
  return resolveCanonicalHostRedirect({
    canonicalOrigin: APEX,
    host: "app.proxywar.xyz",
    method: "GET",
    originalUrl: "/account",
    ...overrides,
  });
}

describe("resolveCanonicalHostRedirect", () => {
  test("sends a stale hostname to the canonical origin, keeping path and query", () => {
    expect(redirectFor({ originalUrl: "/account?github=linked" })).toBe(
      "https://proxywar.xyz/account?github=linked",
    );
  });

  test("serves the canonical host itself, with or without an explicit port", () => {
    expect(redirectFor({ host: "proxywar.xyz" })).toBeNull();
    expect(redirectFor({ host: "proxywar.xyz:443" })).toBeNull();
    // Host is case-insensitive; a capitalised header must not cause a loop.
    expect(redirectFor({ host: "ProxyWar.XYZ" })).toBeNull();
  });

  test("never redirects a write — a 301/302 would be re-sent as a GET and silently lose it", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(redirectFor({ method })).toBeNull();
    }
    expect(redirectFor({ method: "HEAD" })).toBe("https://proxywar.xyz/account");
    // Method casing comes from the wire, not from us.
    expect(redirectFor({ method: "get" })).toBe("https://proxywar.xyz/account");
  });

  test("exempts loopback callers: health checks and the league refresher must stay local", () => {
    expect(redirectFor({ host: "127.0.0.1:8793" })).toBeNull();
    expect(redirectFor({ host: "localhost:8793" })).toBeNull();
    expect(redirectFor({ host: "[::1]:8793" })).toBeNull();
  });

  test("does nothing when the canonical origin is itself loopback (dev, no public URL)", () => {
    // A LAN-IP request in dev must not be bounced to the developer's own
    // localhost, which would resolve to the visitor's machine, not the server.
    expect(
      redirectFor({
        canonicalOrigin: "http://127.0.0.1:8793",
        host: "192.168.1.20:8793",
      }),
    ).toBeNull();
  });

  test("serves the request as-is when there is nothing to compare or nowhere to send it", () => {
    expect(redirectFor({ host: undefined })).toBeNull();
    expect(redirectFor({ host: "" })).toBeNull();
    // Express types allow an array; a duplicated Host header is malformed and
    // must not be guessed at.
    expect(redirectFor({ host: ["proxywar.xyz", "evil.example"] })).toBeNull();
    expect(redirectFor({ canonicalOrigin: "not a url" })).toBeNull();
  });

  test("keeps the canonical port when the canonical origin carries one", () => {
    expect(
      redirectFor({
        canonicalOrigin: "https://proxywar.xyz:8443",
        host: "app.proxywar.xyz",
        originalUrl: "/api/account",
      }),
    ).toBe("https://proxywar.xyz:8443/api/account");
  });
});
