/**
 * `GET /api/account/pov-claims` — the ONE cross-origin-readable account
 * route, and the allowlist that governs it.
 *
 * What is actually worth defending here is not "does it return slugs" but the
 * blast radius if it is wrong:
 * - It must never disclose the CSRF token (that would convert a read grant
 *   into an authenticated-write bypass against the sole account authority).
 * - It must never reflect an origin it does not explicitly allow, and its
 *   allowlist must be independent of the handoff's return map, so adding a
 *   handoff child cannot silently grant ambient claim reads.
 * - It must not MINT an account for a cookieless cross-origin reader, or
 *   every league visitor accrues an empty account.
 * - It must send `Vary: Origin` even when it sets no allow header, or a shared
 *   cache can hand one origin's grant to another.
 */
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AnalyticsAggregateStore,
  totalEventCount,
} from "../../src/server/analytics/AnalyticsAggregateStore";
import { createPlatformAccountRouter } from "../../src/server/platform/PlatformAccountHttp";
import { PlatformAccountSecurity } from "../../src/server/platform/PlatformAccountSecurity";
import { PlatformAccountStore } from "../../src/server/platform/PlatformAccountStore";
import { PlatformGithubIdentityLinkStore } from "../../src/server/platform/PlatformGithubIdentityLinkStore";
import { PlatformHandoffStore } from "../../src/server/platform/PlatformHandoffStore";
import { PlatformPolicyClaimStore } from "../../src/server/platform/PlatformPolicyClaimStore";
import { resolvePlatformPovClaimOrigins } from "../../src/server/platform/PlatformPovClaimOrigins";

const PLATFORM_ORIGIN = "https://app.proxywar.xyz";
const LEAGUE_ORIGIN = "https://beta.proxywar.xyz";
const BETTING_ORIGIN = "https://bet.proxywar.xyz";

let stateRoot: string;
let server: http.Server;
let baseUrl: string;
let security: PlatformAccountSecurity;
let claims: PlatformPolicyClaimStore;

interface Fetched {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}
function get(
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<Fetched> {
  // `new Promise` deliberately: this project's tsconfig `lib` predates
  // es2024, so `Promise.withResolvers` does not typecheck here.
  let resolve!: (value: Fetched) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Fetched>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const request = http.get(`${baseUrl}${urlPath}`, { headers }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => (body += chunk));
    response.on("end", () =>
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body,
      }),
    );
  });
  request.on("error", reject);
  return promise;
}
/** A real, signed account cookie for `accountId`, exactly as the browser would send it back. */
function accountCookieFor(setCookie: readonly string[]): string {
  return setCookie
    .map((cookie) => cookie.split(";")[0])
    .filter((pair) => pair.includes("="))
    .join("; ");
}

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(tmpdir(), "pw-pov-claims-"));
  // Every store takes the same state ROOT and appends its own filename; the
  // identity link store also needs the live account and claim stores, because
  // linking merges claims across accounts.
  const accounts = await PlatformAccountStore.open(stateRoot);
  claims = await PlatformPolicyClaimStore.open(stateRoot);
  const identityLinkStore = await PlatformGithubIdentityLinkStore.open(
    stateRoot,
    accounts,
    claims,
  );
  const handoffs = new PlatformHandoffStore();
  security = new PlatformAccountSecurity({
    hmacKey: new Uint8Array(32).fill(7),
    expectedOrigin: PLATFORM_ORIGIN,
    production: false,
  });
  const app = express();
  app.use(
    createPlatformAccountRouter({
      security,
      accounts,
      claims,
      identityLinkStore,
      handoffs,
      returnOrigins: new Map([
        // Betting IS a handoff child. It must NOT thereby become a
        // claim-reader: that independence is the point of the assertion below.
        ["betting", BETTING_ORIGIN],
        ["league", LEAGUE_ORIGIN],
      ]),
      povClaimOrigins: new Set([LEAGUE_ORIGIN]),
      githubSignInAvailable: false,
      artifactsRootDir: stateRoot,
    }),
  );
  server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind a port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(stateRoot, { recursive: true, force: true });
});

/** Establishes a real session with one claim, returning its cookie header. */
async function signedInCookieWithClaim(slug: string): Promise<string> {
  const bootstrap = await get("/api/account", {
    Origin: PLATFORM_ORIGIN,
  });
  const setCookie = bootstrap.headers["set-cookie"] ?? [];
  const cookie = accountCookieFor(setCookie);
  const bootstrapSchema = z.object({
    identity: z.object({ accountId: z.string() }),
  });
  const accountId = bootstrapSchema.parse(JSON.parse(bootstrap.body)).identity
    .accountId;
  // `addClaim` derives the lineage from the label — `<lineage>:v<n>`.
  await claims.addClaim(accountId, `${slug}:v1`);
  return cookie;
}

describe("GET /api/account/pov-claims", () => {
  test("an allowlisted sibling origin reads the viewer's slugs, and gets the credentialed CORS grant", async () => {
    const cookie = await signedInCookieWithClaim("daveey-proxywar");
    const response = await get("/api/account/pov-claims", {
      Origin: LEAGUE_ORIGIN,
      Cookie: cookie,
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      schemaVersion: 1,
      lineageSlugs: ["daveey-proxywar"],
    });
    expect(response.headers["access-control-allow-origin"]).toBe(LEAGUE_ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers.vary).toContain("Origin");
  });

  test("returns slugs ONLY — never the CSRF token, account id, display name or GitHub identity", async () => {
    const cookie = await signedInCookieWithClaim("daveey-proxywar");
    const response = await get("/api/account/pov-claims", {
      Origin: LEAGUE_ORIGIN,
      Cookie: cookie,
    });
    // Why this is a separate route from `/api/account` rather than a CORS
    // header on it: that route returns a CSRF token. A beta-origin script
    // holding one could not actually write today — `authorizeWrite` checks
    // `Origin === expectedOrigin` first, which a browser sets unforgeably,
    // and the custom CSRF header would preflight. So this is least
    // privilege, not a patched exploit: the token is a credential with no
    // legitimate cross-origin consumer, and exporting it would leave the
    // system one refactor of that Origin check away from a real bypass.
    expect(response.body).not.toContain("csrfToken");
    expect(response.body).not.toContain("accountId");
    expect(response.body).not.toContain("githubLogin");
    // `label` is user-supplied free text; it has no consumer across an origin.
    expect(response.body).not.toContain("label");
    expect(Object.keys(JSON.parse(response.body)).sort()).toEqual([
      "lineageSlugs",
      "schemaVersion",
    ]);
  });

  test("a handoff return origin is NOT thereby a claim reader — the two allowlists are independent", async () => {
    const cookie = await signedInCookieWithClaim("daveey-proxywar");
    // `bet.` is a configured handoff audience above. It must still be refused
    // an ambient claim read: registering a handoff child must never widen who
    // can silently harvest viewers' claims.
    const response = await get("/api/account/pov-claims", {
      Origin: BETTING_ORIGIN,
      Cookie: cookie,
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(JSON.parse(response.body).lineageSlugs).toEqual([]);
  });

  test("a disallowed origin is refused the data itself, not merely the header", async () => {
    const cookie = await signedInCookieWithClaim("daveey-proxywar");
    const response = await get("/api/account/pov-claims", {
      Origin: "https://evil.example",
      Cookie: cookie,
    });
    // Never lean on the browser to withhold a body we should not have sent.
    expect(JSON.parse(response.body).lineageSlugs).toEqual([]);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    // Still varies, so a cache cannot serve the allowlisted origin's grant here.
    expect(response.headers.vary).toContain("Origin");
  });

  test("same-origin (no Origin header) still works — the route is not CORS-only", async () => {
    const cookie = await signedInCookieWithClaim("daveey-proxywar");
    const response = await get("/api/account/pov-claims", { Cookie: cookie });
    expect(JSON.parse(response.body).lineageSlugs).toEqual(["daveey-proxywar"]);
  });

  test("a cookieless reader gets an empty set and is NOT issued an account", async () => {
    const response = await get("/api/account/pov-claims", {
      Origin: LEAGUE_ORIGIN,
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).lineageSlugs).toEqual([]);
    // The load-bearing half: a league visitor who has never touched the
    // platform must not walk away holding a freshly minted account cookie.
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  test("a signed-in viewer with no claims resolves to an empty set, not an error", async () => {
    const bootstrap = await get("/api/account", { Origin: PLATFORM_ORIGIN });
    const cookie = accountCookieFor(bootstrap.headers["set-cookie"] ?? []);
    const response = await get("/api/account/pov-claims", {
      Origin: LEAGUE_ORIGIN,
      Cookie: cookie,
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).lineageSlugs).toEqual([]);
  });

  test("never caches — a claim change must not be served stale from an edge", async () => {
    const response = await get("/api/account/pov-claims", {
      Origin: LEAGUE_ORIGIN,
    });
    expect(response.headers["cache-control"]).toContain("no-store");
  });
});

describe("returning_authenticated_visitor (GET /api/account)", () => {
  /** `emitServerAnalyticsEvent` is fire-and-forget (`void`) from the route handler, so the write can land slightly after the HTTP response does — poll briefly rather than assume it's already flushed. */
  async function waitForCount(expected: number, timeoutMs = 2_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    while (Date.now() < deadline) {
      const file = await new AnalyticsAggregateStore(stateRoot).readAll();
      count = totalEventCount(file, "returning_authenticated_visitor");
      if (count >= expected) return count;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return count;
  }

  test("does NOT emit on a visitor's first-ever bootstrap (the cookie is freshly minted, not returning)", async () => {
    const response = await get("/api/account", { Origin: PLATFORM_ORIGIN });
    expect(response.headers["set-cookie"]).toBeDefined();
    // Give any (incorrect) emission a real chance to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const file = await new AnalyticsAggregateStore(stateRoot).readAll();
    expect(totalEventCount(file, "returning_authenticated_visitor")).toBe(0);
  });

  test("emits once a request carries an ALREADY-ESTABLISHED account cookie", async () => {
    const first = await get("/api/account", { Origin: PLATFORM_ORIGIN });
    const cookie = accountCookieFor(first.headers["set-cookie"] ?? []);
    const second = await get("/api/account", {
      Origin: PLATFORM_ORIGIN,
      Cookie: cookie,
    });
    expect(second.status).toBe(200);
    // The cookie already existed, so bootstrapRead must not re-mint it.
    expect(second.headers["set-cookie"]).toBeUndefined();
    expect(await waitForCount(1)).toBe(1);
  });

  test("dedupes to at most one emission per account id per day across repeated requests", async () => {
    const first = await get("/api/account", { Origin: PLATFORM_ORIGIN });
    const cookie = accountCookieFor(first.headers["set-cookie"] ?? []);
    for (let i = 0; i < 5; i++) {
      await get("/api/account", { Origin: PLATFORM_ORIGIN, Cookie: cookie });
    }
    await waitForCount(1);
    // A short real wait to let any (incorrect) extra emissions land before
    // asserting the count never exceeded one.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const file = await new AnalyticsAggregateStore(stateRoot).readAll();
    expect(totalEventCount(file, "returning_authenticated_visitor")).toBe(1);
  });

  test("two distinct returning accounts each emit their own count", async () => {
    const accountA = await get("/api/account", { Origin: PLATFORM_ORIGIN });
    const cookieA = accountCookieFor(accountA.headers["set-cookie"] ?? []);
    const accountB = await get("/api/account", { Origin: PLATFORM_ORIGIN });
    const cookieB = accountCookieFor(accountB.headers["set-cookie"] ?? []);
    await get("/api/account", { Origin: PLATFORM_ORIGIN, Cookie: cookieA });
    await get("/api/account", { Origin: PLATFORM_ORIGIN, Cookie: cookieB });
    expect(await waitForCount(2)).toBe(2);
  });
});

describe("resolvePlatformPovClaimOrigins", () => {
  test("parses a JSON array of origins, normalising each", () => {
    const origins = resolvePlatformPovClaimOrigins({
      PROXYWAR_PLATFORM_POV_CLAIM_ORIGINS: `["https://beta.proxywar.xyz/some/path"]`,
    });
    expect([...origins]).toEqual(["https://beta.proxywar.xyz"]);
  });

  test("fails CLOSED — unset, empty, malformed JSON and a non-array all deny everyone", () => {
    // The failure mode of this list is "who may read viewer data", so every
    // unclear input must mean nobody, never everybody.
    for (const value of [
      undefined,
      "",
      "not json",
      `"a string"`,
      `{"a":"b"}`,
    ]) {
      expect(
        resolvePlatformPovClaimOrigins({
          PROXYWAR_PLATFORM_POV_CLAIM_ORIGINS: value,
        }).size,
      ).toBe(0);
    }
  });

  test("drops one bad entry without discarding the good ones", () => {
    const origins = resolvePlatformPovClaimOrigins({
      PROXYWAR_PLATFORM_POV_CLAIM_ORIGINS: `["not-a-url","ftp://x.example","https://beta.proxywar.xyz",7]`,
    });
    expect([...origins]).toEqual(["https://beta.proxywar.xyz"]);
  });
});
