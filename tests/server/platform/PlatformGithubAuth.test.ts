/**
 * `/api/auth/github/{start,callback,status}` — the sign-in the platform deploy
 * is built around, and the only place in the system GitHub OAuth happens.
 *
 * The router itself had no coverage before this file: the identity link store
 * and the cookie/CSRF layer were each tested in isolation, so nothing defended
 * the part that decides WHETHER to exchange a code at all. That decision is the
 * whole security boundary, because the callback is a deliberate cross-site
 * top-level navigation:
 *
 * - The `redirect_uri` must come from THIS origin's configured public origin.
 *   A classic OAuth app has exactly one registered callback, so a mismatch is
 *   not a cosmetic difference — it is either a dead flow or someone else's.
 * - A callback with no link-intent cookie, or a `state` that does not match the
 *   nonce minted by `start`, must be refused BEFORE any token exchange. A
 *   forged `?code=` that reaches GitHub is a code-injection primitive.
 * - Every failure must land the browser on `/account?github=error` and clear
 *   the link intent, never leak why, and never half-link.
 * - A second sign-in with the same GitHub identity must leave the browser
 *   holding the CANONICAL (merged) account's cookie, or the user silently
 *   loses the history that merge just consolidated.
 */
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  GithubOAuthClient,
  GithubOAuthUser,
} from "../../../src/server/GithubOAuthClient";
import { createPlatformGithubAuthRouter } from "../../../src/server/platform/PlatformGithubAuth";
import { PlatformAccountSecurity } from "../../../src/server/platform/PlatformAccountSecurity";
import { PlatformAccountStore } from "../../../src/server/platform/PlatformAccountStore";
import { PlatformGithubIdentityLinkStore } from "../../../src/server/platform/PlatformGithubIdentityLinkStore";
import { PlatformPolicyClaimStore } from "../../../src/server/platform/PlatformPolicyClaimStore";

/** The live canonical origin as of the 2026-07-30 apex cutover. */
const PLATFORM_ORIGIN = "https://proxywar.xyz";
const STUB_AUTHORIZE = "https://github.test/login/oauth/authorize";

interface Fetched {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

let stateRoot: string;
let server: http.Server;
let baseUrl: string;
let identityLinkStore: PlatformGithubIdentityLinkStore;
/** Every exchange the router attempted — the assertion surface for "refused before exchange". */
let exchanges: { code: string; redirectUri: string }[];
let exchangeFails: boolean;
let githubUser: GithubOAuthUser;

function get(
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<Fetched> {
  // `new Promise` deliberately: this project's tsconfig `lib` predates es2024,
  // so `Promise.withResolvers` does not typecheck here.
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

/** The `Cookie` header a browser would send back, from one or more `Set-Cookie`s. */
function cookieHeader(setCookie: readonly string[]): string {
  return setCookie
    .map((cookie) => cookie.split(";")[0])
    .filter((pair) => pair.includes("="))
    .join("; ");
}

/**
 * Drives `start` the way a browser does — a same-origin top-level navigation
 * sends `Sec-Fetch-Site`, never an `Origin` — and returns the cookies plus the
 * `state` nonce the callback will be checked against.
 */
async function startSignIn(
  headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" },
): Promise<{ cookie: string; state: string | null; location: string }> {
  const started = await get("/api/auth/github/start", headers);
  const location = started.headers.location ?? "";
  const state = location.startsWith(STUB_AUTHORIZE)
    ? new URL(location).searchParams.get("state")
    : null;
  return {
    cookie: cookieHeader(started.headers["set-cookie"] ?? []),
    state,
    location,
  };
}

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(tmpdir(), "pw-github-auth-"));
  exchanges = [];
  exchangeFails = false;
  githubUser = { githubUserId: 4562236, login: "djizus", avatarUrl: null };
  const accounts = await PlatformAccountStore.open(stateRoot);
  const claims = await PlatformPolicyClaimStore.open(stateRoot);
  identityLinkStore = await PlatformGithubIdentityLinkStore.open(
    stateRoot,
    accounts,
    claims,
  );
  const security = new PlatformAccountSecurity({
    hmacKey: new Uint8Array(32).fill(9),
    expectedOrigin: PLATFORM_ORIGIN,
    production: false,
  });
  const oauthClient: GithubOAuthClient = {
    buildAuthorizeUrl({ redirectUri, state }) {
      const url = new URL(STUB_AUTHORIZE);
      url.searchParams.set("client_id", "Ov23likxrRLTNNoQd5Dy");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchangeCodeForToken(code, redirectUri) {
      exchanges.push({ code, redirectUri });
      if (exchangeFails) throw new Error("bad_verification_code");
      return "gho_stub_token";
    },
    async fetchUser() {
      return githubUser;
    },
  };
  const app = express();
  app.use(
    createPlatformGithubAuthRouter({
      security,
      identityLinkStore,
      oauthClient,
      publicOrigin: PLATFORM_ORIGIN,
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

describe("platform GitHub sign-in", () => {
  test("start sends the browser to GitHub with this origin's callback and a state nonce", async () => {
    const { location, state, cookie } = await startSignIn();
    expect(location.startsWith(STUB_AUTHORIZE)).toBe(true);
    // The registered callback, built from publicOrigin — not the request's
    // Host, which an attacker controls.
    expect(new URL(location).searchParams.get("redirect_uri")).toBe(
      `${PLATFORM_ORIGIN}/api/auth/github/callback`,
    );
    expect(state).not.toBeNull();
    expect(state).not.toBe("");
    // Both the session and the short-lived link intent have to come back.
    expect(cookie).toContain("proxywar_platform_account=");
    expect(cookie.split("; ").length).toBeGreaterThanOrEqual(2);
  });

  test("a completed authorization links the identity and lands on the account page", async () => {
    const { cookie, state } = await startSignIn();
    const callback = await get(
      `/api/auth/github/callback?code=real-code&state=${state ?? ""}`,
      { Cookie: cookie },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("/account?github=linked");
    expect(exchanges).toEqual([
      {
        code: "real-code",
        redirectUri: `${PLATFORM_ORIGIN}/api/auth/github/callback`,
      },
    ]);
    const linkedCookie = cookieHeader(callback.headers["set-cookie"] ?? []);
    const status = await get("/api/auth/github/status", {
      Cookie: linkedCookie,
      "Sec-Fetch-Site": "same-origin",
    });
    expect(status.status).toBe(200);
    const identity = JSON.parse(status.body).identity;
    expect(identity.signedIn).toBe(true);
    expect(identity.login).toBe("djizus");
  });

  test("a state that does not match the minted nonce is refused before any exchange", async () => {
    const { cookie } = await startSignIn();
    const callback = await get(
      "/api/auth/github/callback?code=injected&state=attacker-chosen",
      { Cookie: cookie },
    );
    expect(callback.headers.location).toBe("/account?github=error");
    expect(exchanges).toEqual([]);
  });

  test("a callback with no link intent is refused before any exchange, and clears the intent", async () => {
    // A session cookie alone is what a victim's browser carries when it is
    // navigated straight to the callback by a hostile page.
    const { cookie } = await startSignIn();
    const sessionOnly = cookie
      .split("; ")
      .filter((pair) => pair.startsWith("proxywar_platform_account="))
      .join("; ");
    const callback = await get(
      "/api/auth/github/callback?code=injected&state=whatever",
      { Cookie: sessionOnly },
    );
    expect(callback.headers.location).toBe("/account?github=error");
    expect(exchanges).toEqual([]);
    expect(
      (callback.headers["set-cookie"] ?? []).some((cookieValue) =>
        cookieValue.includes("proxywar_platform_link_intent="),
      ),
    ).toBe(true);
  });

  test("a cookieless callback never mints an account to link to", async () => {
    const callback = await get(
      "/api/auth/github/callback?code=injected&state=whatever",
    );
    expect(callback.headers.location).toBe("/account?github=error");
    expect(exchanges).toEqual([]);
  });

  test("a missing code is refused even with a valid intent and state", async () => {
    const { cookie, state } = await startSignIn();
    const callback = await get(
      `/api/auth/github/callback?state=${state ?? ""}`,
      { Cookie: cookie },
    );
    expect(callback.headers.location).toBe("/account?github=error");
    expect(exchanges).toEqual([]);
  });

  test("a failed exchange links nothing — no half-signed-in account", async () => {
    exchangeFails = true;
    const { cookie, state } = await startSignIn();
    const callback = await get(
      `/api/auth/github/callback?code=stale&state=${state ?? ""}`,
      { Cookie: cookie },
    );
    expect(callback.headers.location).toBe("/account?github=error");
    expect(exchanges).toHaveLength(1);
    const status = await get("/api/auth/github/status", {
      Cookie: cookie,
      "Sec-Fetch-Site": "same-origin",
    });
    expect(JSON.parse(status.body).identity.signedIn).toBe(false);
  });

  test("start refuses a foreign origin rather than minting a link intent for it", async () => {
    const { location, state } = await startSignIn({
      Origin: "https://evil.example",
    });
    expect(location).toBe("/account?github=error");
    expect(state).toBeNull();
  });

  test("signing in again from a second browser hands back the merged account's cookie", async () => {
    const first = await startSignIn();
    await get(`/api/auth/github/callback?code=one&state=${first.state ?? ""}`, {
      Cookie: first.cookie,
    });
    const firstStatus = await get("/api/auth/github/status", {
      Cookie: first.cookie,
      "Sec-Fetch-Site": "same-origin",
    });
    const canonical = JSON.parse(firstStatus.body).identity.canonicalAccountId;

    // A different browser: its own fresh anonymous account, same GitHub user.
    const second = await startSignIn();
    const secondCallback = await get(
      `/api/auth/github/callback?code=two&state=${second.state ?? ""}`,
      { Cookie: second.cookie },
    );
    const mergedCookie = cookieHeader(
      secondCallback.headers["set-cookie"] ?? [],
    );
    const mergedStatus = await get("/api/auth/github/status", {
      Cookie: mergedCookie,
      "Sec-Fetch-Site": "same-origin",
    });
    // The cookie the second browser walks away with must resolve to the SAME
    // account as the first, or the person's history splits in two.
    expect(JSON.parse(mergedStatus.body).identity.canonicalAccountId).toBe(
      canonical,
    );
    expect(JSON.parse(mergedStatus.body).identity.login).toBe("djizus");
  });
});
