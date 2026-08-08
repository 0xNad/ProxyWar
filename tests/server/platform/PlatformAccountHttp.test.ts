/**
 * `GET /api/account`'s `returning_authenticated_visitor` analytics dedup —
 * extracted verbatim from the deleted `tests/server/PlatformPovClaims.test.ts`
 * (that file's own scope was `/api/account/pov-claims`; this describe block
 * was unrelated coverage for the general account-bootstrap route that
 * happened to live in the same file and must not be lost when the pov-claims
 * feature and its dedicated test file are removed).
 *
 * What is actually worth defending here: the emission must fire exactly once
 * per GENUINELY authenticated (GitHub-linked) returning visitor, never for a
 * first-ever visit (freshly minted cookie), never for a plain returning
 * GUEST (an established cookie alone is not "authenticated" — every visitor,
 * signed in or not, auto-mints an account cookie), and never more than once
 * per account per day even across repeated requests.
 */
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AnalyticsAggregateStore,
  totalEventCount,
} from "../../../src/server/analytics/AnalyticsAggregateStore";
import { createPlatformAccountRouter } from "../../../src/server/platform/PlatformAccountHttp";
import { PlatformAccountSecurity } from "../../../src/server/platform/PlatformAccountSecurity";
import { PlatformAccountStore } from "../../../src/server/platform/PlatformAccountStore";
import { PlatformGithubIdentityLinkStore } from "../../../src/server/platform/PlatformGithubIdentityLinkStore";
import { PlatformPolicyClaimStore } from "../../../src/server/platform/PlatformPolicyClaimStore";

const PLATFORM_ORIGIN = "https://app.proxywar.xyz";

let stateRoot: string;
let server: http.Server;
let baseUrl: string;
let identityLinkStore: PlatformGithubIdentityLinkStore;

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
  stateRoot = await mkdtemp(path.join(tmpdir(), "pw-account-http-"));
  // Every store takes the same state ROOT and appends its own filename; the
  // identity link store also needs the live account and claim stores, because
  // linking merges claims across accounts.
  const accounts = await PlatformAccountStore.open(stateRoot);
  const claims = await PlatformPolicyClaimStore.open(stateRoot);
  identityLinkStore = await PlatformGithubIdentityLinkStore.open(
    stateRoot,
    accounts,
    claims,
  );
  const security = new PlatformAccountSecurity({
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

let nextGithubUserId = 900_000;
/** Establishes a real session and links it to a GitHub identity directly through the store (bypassing OAuth), returning its cookie header. */
async function githubLinkedCookie(login: string): Promise<string> {
  const bootstrap = await get("/api/account", { Origin: PLATFORM_ORIGIN });
  const cookie = accountCookieFor(bootstrap.headers["set-cookie"] ?? []);
  const bootstrapBody = JSON.parse(bootstrap.body) as {
    identity: { accountId: string };
  };
  const accountId = bootstrapBody.identity.accountId;
  nextGithubUserId += 1;
  await identityLinkStore.linkOrMerge(accountId, {
    githubUserId: nextGithubUserId,
    login,
    avatarUrl: null,
  });
  return cookie;
}

describe("returning_authenticated_visitor (GET /api/account)", () => {
  /** `emitServerAnalyticsEvent` is fire-and-forget (`void`) from the route handler, so the write can land slightly after the HTTP response does — poll briefly rather than assume it's already flushed. */
  async function waitForCount(
    expected: number,
    timeoutMs = 2_000,
  ): Promise<number> {
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

  test("does NOT emit for a plain returning GUEST account — regression: every visitor (signed in or not) auto-mints an account cookie, so 'already-established cookie' alone is NOT 'authenticated' and must never double-count the same visit that returning_anonymous_visitor already counts client-side", async () => {
    const first = await get("/api/account", { Origin: PLATFORM_ORIGIN });
    const cookie = accountCookieFor(first.headers["set-cookie"] ?? []);
    const second = await get("/api/account", {
      Origin: PLATFORM_ORIGIN,
      Cookie: cookie,
    });
    expect(second.status).toBe(200);
    // The cookie already existed, so bootstrapRead must not re-mint it —
    // this guest genuinely IS "returning" by the cookie signal alone...
    expect(second.headers["set-cookie"]).toBeUndefined();
    // ...but never having linked GitHub, must NOT be counted as an
    // authenticated return. Give a real chance for an (incorrect)
    // emission to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const file = await new AnalyticsAggregateStore(stateRoot).readAll();
    expect(totalEventCount(file, "returning_authenticated_visitor")).toBe(0);
  });

  test("emits once a request carries an already-established cookie for a GENUINELY GitHub-linked account", async () => {
    const cookie = await githubLinkedCookie("octocat-returner");
    const second = await get("/api/account", {
      Origin: PLATFORM_ORIGIN,
      Cookie: cookie,
    });
    expect(second.status).toBe(200);
    expect(second.headers["set-cookie"]).toBeUndefined();
    expect(await waitForCount(1)).toBe(1);
  });

  test("dedupes to at most one emission per account id per day across repeated requests, for a GitHub-linked account", async () => {
    const cookie = await githubLinkedCookie("octocat-repeat");
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

  test("two distinct GitHub-linked returning accounts each emit their own count", async () => {
    const cookieA = await githubLinkedCookie("octocat-a");
    const cookieB = await githubLinkedCookie("octocat-b");
    await get("/api/account", { Origin: PLATFORM_ORIGIN, Cookie: cookieA });
    await get("/api/account", { Origin: PLATFORM_ORIGIN, Cookie: cookieB });
    expect(await waitForCount(2)).toBe(2);
  });
});
