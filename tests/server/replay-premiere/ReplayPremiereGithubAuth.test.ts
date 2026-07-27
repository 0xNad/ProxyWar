import express from "express";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  pointsMergerFor,
  ReplayPremiereIdentityLinkStore,
  type ReplayPremiereLeagueClaimMerger,
} from "../../../src/server/replay-premiere/points/ReplayPremiereIdentityLinkStore";
import { ReplayPremierePointsLedger } from "../../../src/server/replay-premiere/points/ReplayPremierePointsLedger";
import {
  createReplayPremiereGithubAuthRouter,
  createReplayPremiereGithubOAuthClient,
  resolveReplayPremiereGithubOAuthConfig,
  type ReplayPremiereCurrentMarketIdentityGuard,
  type ReplayPremiereGithubOAuthClient,
} from "../../../src/server/replay-premiere/ReplayPremiereGithubAuth";
import { ReplayPremiereGuestSecurity } from "../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";

const origin = "https://bet.example.test";

function guestSecurityHarness(): ReplayPremiereGuestSecurity {
  return new ReplayPremiereGuestSecurity({
    hmacKey: new Uint8Array(32).fill(9),
    expectedOrigin: origin,
    production: false,
  });
}

/** A league-claim merger that never has anything to reconcile — this file exercises the GitHub-link/callback machinery, not claim reconciliation (see `ReplayPremiereIdentityLinkStore.test.ts` for that). */
function noopLeagueClaimMerger(): ReplayPremiereLeagueClaimMerger {
  return {
    async mergeClaim() {
      return { claim: null, sourceClaimReplaced: false };
    },
  };
}

interface StubOAuthState {
  /** code -> access token */
  tokensByCode: Map<string, string>;
  /** access token -> user */
  usersByToken: Map<
    string,
    { githubUserId: number; login: string; avatarUrl: string | null }
  >;
  exchangeShouldThrow: boolean;
  fetchUserShouldThrow: boolean;
}

function stubOAuthClient(
  state: StubOAuthState,
): ReplayPremiereGithubOAuthClient {
  return {
    buildAuthorizeUrl({ redirectUri, state: oauthState }) {
      const url = new URL("https://github.example.test/login/oauth/authorize");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", oauthState);
      return url.toString();
    },
    async exchangeCodeForToken(code) {
      if (state.exchangeShouldThrow) throw new Error("github_unreachable");
      const token = state.tokensByCode.get(code);
      if (token === undefined) throw new Error("invalid_code");
      return token;
    },
    async fetchUser(accessToken) {
      if (state.fetchUserShouldThrow) throw new Error("github_unreachable");
      const user = state.usersByToken.get(accessToken);
      if (user === undefined) throw new Error("invalid_token");
      return user;
    },
  };
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function rawGet(
  baseUrl: string,
  pathname: string,
  cookie?: string,
): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: pathname,
        method: "GET",
        // Referer stands in for the same-origin proof a real top-level
        // navigation/fetch from the /bet page would send (Origin is
        // omitted on same-origin GETs; see `assertReadOrigin`'s doc).
        headers: {
          referer: `${origin}/bet`,
          ...(cookie === undefined ? {} : { cookie }),
        },
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(parts).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function setCookiePairs(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const raw = headers["set-cookie"] ?? [];
  const pairs: Record<string, string> = {};
  for (const entry of raw) {
    const [pair] = entry.split(";", 1);
    const separator = pair.indexOf("=");
    pairs[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return pairs;
}

function cookieHeader(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

describe("ReplayPremiereGithubAuth", () => {
  let root: string;
  let buildCount: number;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(realTemporaryRoot, "github-auth-"));
    buildCount = 0;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function buildServerWithOAuthClient(
    oauthClient: ReplayPremiereGithubOAuthClient,
    resolveCurrentMarketIdentityGuard: () => ReplayPremiereCurrentMarketIdentityGuard | null = () =>
      null,
  ): Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    identityLinkStore: ReplayPremiereIdentityLinkStore;
    ledger: ReplayPremierePointsLedger;
    errors: Array<{ code: string; error: unknown }>;
  }> {
    buildCount += 1;
    const ledger = await ReplayPremierePointsLedger.open(
      path.join(root, `points-ledger-${buildCount}`),
    );
    const identityLinkStore = await ReplayPremiereIdentityLinkStore.open(
      path.join(root, `identity-links-${buildCount}`),
      pointsMergerFor(ledger),
      noopLeagueClaimMerger(),
    );
    const security = guestSecurityHarness();
    const errors: Array<{ code: string; error: unknown }> = [];
    const app = express();
    app.use(
      createReplayPremiereGithubAuthRouter({
        security,
        identityLinkStore,
        oauthClient,
        publicOrigin: origin,
        resolveCurrentMarketIdentityGuard,
        onOperatorError: (code, error) => errors.push({ code, error }),
      }),
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound TCP address");
    }
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      identityLinkStore,
      ledger,
      errors,
    };
  }

  async function buildServer(
    oauthState: StubOAuthState,
    resolveCurrentMarketIdentityGuard: () => ReplayPremiereCurrentMarketIdentityGuard | null = () =>
      null,
  ) {
    return buildServerWithOAuthClient(
      stubOAuthClient(oauthState),
      resolveCurrentMarketIdentityGuard,
    );
  }

  test("full happy path: start mints link-intent + guest cookies, callback links, status reports the verified identity", async () => {
    const oauthState: StubOAuthState = {
      tokensByCode: new Map([["good-code", "token-1"]]),
      usersByToken: new Map([
        [
          "token-1",
          {
            githubUserId: 42,
            login: "daveey",
            avatarUrl: "https://example.test/a.png",
          },
        ],
      ]),
      exchangeShouldThrow: false,
      fetchUserShouldThrow: false,
    };
    const { baseUrl, close, identityLinkStore } = await buildServer(oauthState);
    try {
      const start = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      expect(start.status).toBe(302);
      const location = new URL(start.headers.location ?? "");
      const state = location.searchParams.get("state") ?? "";
      expect(state.length).toBeGreaterThan(0);
      const cookiesAfterStart = setCookiePairs(start.headers);
      expect(Object.keys(cookiesAfterStart)).toEqual(
        expect.arrayContaining([
          "proxywar_premiere_guest",
          "proxywar_premiere_link_intent",
        ]),
      );

      const callback = await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=good-code&state=${state}`,
        cookieHeader(cookiesAfterStart),
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe("/bet?github=linked");
      // Link-intent cookie is cleared after a successful callback.
      const clearedCookies = setCookiePairs(callback.headers);
      expect(clearedCookies.proxywar_premiere_link_intent).toBe("");

      const status = await rawGet(
        baseUrl,
        "/api/premieres/auth/github/status",
        cookieHeader(cookiesAfterStart),
      );
      expect(status.status).toBe(200);
      const parsed = JSON.parse(status.body) as {
        identity: {
          signedIn: boolean;
          login: string | null;
          avatarUrl: string | null;
          canonicalParticipantId: string;
        };
      };
      expect(parsed.identity).toEqual({
        signedIn: true,
        login: "daveey",
        avatarUrl: "https://example.test/a.png",
        canonicalParticipantId: expect.stringMatching(/^guest_[a-f0-9]{32}$/),
      });
      const directStatus = await identityLinkStore.getStatus(
        parsed.identity.canonicalParticipantId,
      );
      expect(directStatus.login).toBe("daveey");
    } finally {
      await close();
    }
  });

  test("a bare callback link with no link-intent cookie (the force-link attack) is rejected and links nothing", async () => {
    const oauthState: StubOAuthState = {
      tokensByCode: new Map([["good-code", "token-1"]]),
      usersByToken: new Map([
        ["token-1", { githubUserId: 42, login: "attacker", avatarUrl: null }],
      ]),
      exchangeShouldThrow: false,
      fetchUserShouldThrow: false,
    };
    const { baseUrl, close } = await buildServer(oauthState);
    try {
      // Victim has an ordinary guest cookie from browsing, but never
      // clicked "Sign in" — no link-intent cookie exists in their browser.
      const bootstrapOnly = await rawGet(
        baseUrl,
        "/api/premieres/auth/github/status",
      );
      const guestCookie = setCookiePairs(bootstrapOnly.headers);

      const callback = await rawGet(
        baseUrl,
        "/api/premieres/auth/github/callback?code=good-code&state=anything",
        cookieHeader(guestCookie),
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe("/bet?github=error");

      const status = await rawGet(
        baseUrl,
        "/api/premieres/auth/github/status",
        cookieHeader(guestCookie),
      );
      const parsed = JSON.parse(status.body) as {
        identity: { signedIn: boolean };
      };
      expect(parsed.identity.signedIn).toBe(false);
    } finally {
      await close();
    }
  });

  test("a state parameter that doesn't match the link-intent nonce is rejected", async () => {
    const oauthState: StubOAuthState = {
      tokensByCode: new Map([["good-code", "token-1"]]),
      usersByToken: new Map([
        ["token-1", { githubUserId: 1, login: "x", avatarUrl: null }],
      ]),
      exchangeShouldThrow: false,
      fetchUserShouldThrow: false,
    };
    const { baseUrl, close } = await buildServer(oauthState);
    try {
      const start = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const cookies = setCookiePairs(start.headers);
      const callback = await rawGet(
        baseUrl,
        "/api/premieres/auth/github/callback?code=good-code&state=wrong-nonce",
        cookieHeader(cookies),
      );
      expect(callback.headers.location).toBe("/bet?github=error");
    } finally {
      await close();
    }
  });

  test("GitHub unreachable during code exchange fails the sign-in visibly without throwing", async () => {
    const oauthState: StubOAuthState = {
      tokensByCode: new Map(),
      usersByToken: new Map(),
      exchangeShouldThrow: true,
      fetchUserShouldThrow: false,
    };
    const { baseUrl, close, errors } = await buildServer(oauthState);
    try {
      const start = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const location = new URL(start.headers.location ?? "");
      const state = location.searchParams.get("state") ?? "";
      const cookies = setCookiePairs(start.headers);
      const callback = await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=whatever&state=${state}`,
        cookieHeader(cookies),
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe("/bet?github=error");
      expect(
        errors.some((e) => e.code === "github_auth_code_exchange_failed"),
      ).toBe(true);
    } finally {
      await close();
    }
  });

  test("two different guests linking the same GitHub id merge into one canonical identity with summed points", async () => {
    const oauthState: StubOAuthState = {
      tokensByCode: new Map([
        ["code-a", "token-a"],
        ["code-b", "token-b"],
      ]),
      usersByToken: new Map([
        ["token-a", { githubUserId: 7, login: "daveey", avatarUrl: null }],
        ["token-b", { githubUserId: 7, login: "daveey", avatarUrl: null }],
      ]),
      exchangeShouldThrow: false,
      fetchUserShouldThrow: false,
    };
    const { baseUrl, close, ledger } = await buildServer(oauthState);
    try {
      const startA = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const cookiesA = setCookiePairs(startA.headers);
      const stateA = new URL(startA.headers.location ?? "").searchParams.get(
        "state",
      );
      const participantA = cookiesA.proxywar_premiere_guest.split(".")[1];

      const startB = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const cookiesB = setCookiePairs(startB.headers);
      const stateB = new URL(startB.headers.location ?? "").searchParams.get(
        "state",
      );
      const participantB = cookiesB.proxywar_premiere_guest.split(".")[1];
      expect(participantB).not.toBe(participantA);

      // Both traded real premieres BEFORE either signed in — the exact
      // laptop-plus-phone scenario the merge exists for.
      await ledger.recordPremiereSettlement("prem_aaaaaaaaaaaaaaaa", [
        { participantId: participantA, granted: 1_000, balance: 1_200 },
      ]);
      await ledger.recordPremiereSettlement("prem_bbbbbbbbbbbbbbbb", [
        { participantId: participantB, granted: 1_000, balance: 950 },
      ]);

      await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=code-a&state=${stateA}`,
        cookieHeader(cookiesA),
      );
      const linkB = await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=code-b&state=${stateB}`,
        cookieHeader(cookiesB),
      );
      expect(linkB.headers.location).toBe("/bet?github=linked");

      const board = await ledger.readLeaderboard({
        viewerParticipantId: participantA,
      });
      expect(board.viewer).toEqual(
        expect.objectContaining({
          participantId: participantA,
          lifetimePoints: 150, // +200 - 50
          premieresTraded: 2,
        }),
      );
      expect(
        board.entries.some((entry) => entry.participantId === participantB),
      ).toBe(false);

      // Both cookies — including guestB's now-merged-away one — resolve to
      // the same canonical, verified identity.
      const statusA = await rawGet(
        baseUrl,
        "/api/premieres/auth/github/status",
        cookieHeader(cookiesA),
      );
      const statusB = await rawGet(
        baseUrl,
        "/api/premieres/auth/github/status",
        cookieHeader(cookiesB),
      );
      const identityA = (
        JSON.parse(statusA.body) as {
          identity: { canonicalParticipantId: string };
        }
      ).identity;
      const identityB = (
        JSON.parse(statusB.body) as {
          identity: { canonicalParticipantId: string };
        }
      ).identity;
      expect(identityA.canonicalParticipantId).toBe(participantA);
      expect(identityB.canonicalParticipantId).toBe(participantA);
    } finally {
      await close();
    }
  });

  function fakeMarketIdentityGuard(safe: boolean): ReplayPremiereCurrentMarketIdentityGuard & {
    retireCalls: string[];
    releaseCalls: string[];
  } {
    const retireCalls: string[] = [];
    const releaseCalls: string[] = [];
    return {
      retireCalls,
      releaseCalls,
      async retireForIdentityLinkIfSafe(participantId: string) {
        retireCalls.push(participantId);
        return { safe };
      },
      async releaseIdentityLinkRetirement(participantId: string) {
        releaseCalls.push(participantId);
      },
    };
  }

  test("a real identity swap mints a guest cookie for the CANONICAL id, and keeps the source id retired from trading", async () => {
    const oauthState: StubOAuthState = {
      tokensByCode: new Map([
        ["code-a", "token-a"],
        ["code-b", "token-b"],
      ]),
      usersByToken: new Map([
        ["token-a", { githubUserId: 9, login: "daveey", avatarUrl: null }],
        ["token-b", { githubUserId: 9, login: "daveey", avatarUrl: null }],
      ]),
      exchangeShouldThrow: false,
      fetchUserShouldThrow: false,
    };
    const guard = fakeMarketIdentityGuard(true);
    const { baseUrl, close } = await buildServer(oauthState, () => guard);
    try {
      const startA = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const cookiesA = setCookiePairs(startA.headers);
      const stateA = new URL(startA.headers.location ?? "").searchParams.get(
        "state",
      );
      const participantA = cookiesA.proxywar_premiere_guest.split(".")[1];
      await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=code-a&state=${stateA}`,
        cookieHeader(cookiesA),
      );

      const startB = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const cookiesB = setCookiePairs(startB.headers);
      const stateB = new URL(startB.headers.location ?? "").searchParams.get(
        "state",
      );
      const participantB = cookiesB.proxywar_premiere_guest.split(".")[1];
      expect(participantB).not.toBe(participantA);

      const linkB = await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=code-b&state=${stateB}`,
        cookieHeader(cookiesB),
      );
      expect(linkB.headers.location).toBe("/bet?github=linked");
      const cookiesAfterLinkB = setCookiePairs(linkB.headers);
      // Browser B is handed a guest cookie for A's participant id, not its own.
      expect(cookiesAfterLinkB.proxywar_premiere_guest.split(".")[1]).toBe(
        participantA,
      );
      // A's own callback is a first-ever link (self-canonical): retired
      // then immediately released. B's callback is the real swap: retired
      // and — critically — NEVER released, since B is being replaced by
      // A's identity and must stay out of trading under its old id.
      expect(guard.retireCalls).toEqual([participantA, participantB]);
      expect(guard.releaseCalls).toEqual([participantA]);
    } finally {
      await close();
    }
  });

  test("a first-ever link that resolves to the browser's OWN id releases the transient retirement — nothing to strand", async () => {
    const oauthState: StubOAuthState = {
      tokensByCode: new Map([["good-code", "token-1"]]),
      usersByToken: new Map([
        ["token-1", { githubUserId: 55, login: "solo", avatarUrl: null }],
      ]),
      exchangeShouldThrow: false,
      fetchUserShouldThrow: false,
    };
    const guard = fakeMarketIdentityGuard(true);
    const { baseUrl, close } = await buildServer(oauthState, () => guard);
    try {
      const start = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const cookies = setCookiePairs(start.headers);
      const state = new URL(start.headers.location ?? "").searchParams.get(
        "state",
      );
      const participant = cookies.proxywar_premiere_guest.split(".")[1];
      const callback = await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=good-code&state=${state}`,
        cookieHeader(cookies),
      );
      expect(callback.headers.location).toBe("/bet?github=linked");
      const cookiesAfter = setCookiePairs(callback.headers);
      expect(cookiesAfter.proxywar_premiere_guest.split(".")[1]).toBe(
        participant,
      );
      // Retired, then immediately released — this id keeps trading as itself.
      expect(guard.retireCalls).toEqual([participant]);
      expect(guard.releaseCalls).toEqual([participant]);
    } finally {
      await close();
    }
  });

  test("a source guest with an active market account is refused with a distinct reason, and nothing is linked or retired", async () => {
    const oauthState: StubOAuthState = {
      tokensByCode: new Map([["good-code", "token-1"]]),
      usersByToken: new Map([
        ["token-1", { githubUserId: 42, login: "trader", avatarUrl: null }],
      ]),
      exchangeShouldThrow: false,
      fetchUserShouldThrow: false,
    };
    const guard = fakeMarketIdentityGuard(false);
    const { baseUrl, close, identityLinkStore, errors } = await buildServer(
      oauthState,
      () => guard,
    );
    try {
      const start = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const cookies = setCookiePairs(start.headers);
      const state = new URL(start.headers.location ?? "").searchParams.get(
        "state",
      );
      const participant = cookies.proxywar_premiere_guest.split(".")[1];
      const callback = await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=good-code&state=${state}`,
        cookieHeader(cookies),
      );
      // Distinct from the generic `?github=error` banner — testers must
      // never read this as a bug.
      expect(callback.headers.location).toBe("/bet?github=active_trade");
      expect(
        errors.some(
          (e) => e.code === "github_auth_active_market_participation",
        ),
      ).toBe(true);
      // The GitHub round trip never even started, and nothing was retired
      // (there was nothing safe to hold), so release is never called.
      expect(guard.retireCalls).toEqual([participant]);
      expect(guard.releaseCalls).toEqual([]);
      const status = await identityLinkStore.getStatus(participant);
      expect(status.signedIn).toBe(false);
    } finally {
      await close();
    }
  });

  test("GitHub unreachable after a safe retirement releases the hold — the browser keeps trading as itself", async () => {
    const oauthState: StubOAuthState = {
      tokensByCode: new Map(),
      usersByToken: new Map(),
      exchangeShouldThrow: true,
      fetchUserShouldThrow: false,
    };
    const guard = fakeMarketIdentityGuard(true);
    const { baseUrl, close, identityLinkStore } = await buildServer(
      oauthState,
      () => guard,
    );
    try {
      const start = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const cookies = setCookiePairs(start.headers);
      const state = new URL(start.headers.location ?? "").searchParams.get(
        "state",
      );
      const participant = cookies.proxywar_premiere_guest.split(".")[1];
      const callback = await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=whatever&state=${state}`,
        cookieHeader(cookies),
      );
      expect(callback.headers.location).toBe("/bet?github=error");
      expect(guard.retireCalls).toEqual([participant]);
      expect(guard.releaseCalls).toEqual([participant]);
      const status = await identityLinkStore.getStatus(participant);
      expect(status.signedIn).toBe(false);
    } finally {
      await close();
    }
  });

  test("GitHub accepting a connection and never answering times out instead of hanging, and links nothing", async () => {
    const stallingServer = http.createServer(() => {
      // Deliberately never respond — GitHub accepting the TCP connection
      // and then hanging is the real-world failure a rejected fetch
      // Promise does not exercise.
    });
    await new Promise<void>((resolve) =>
      stallingServer.listen(0, "127.0.0.1", resolve),
    );
    const stallingAddress = stallingServer.address();
    if (stallingAddress === null || typeof stallingAddress === "string") {
      throw new Error("expected a bound TCP address");
    }
    const stallingBaseUrl = `http://127.0.0.1:${stallingAddress.port}`;
    // A short injected timeout — real production default is 10s; a test
    // must not stall the suite for it.
    const oauthClient = createReplayPremiereGithubOAuthClient(
      { clientId: "client-id", clientSecret: "client-secret" },
      {
        PROXYWAR_GITHUB_OAUTH_WEB_BASE_URL: stallingBaseUrl,
        PROXYWAR_GITHUB_OAUTH_API_BASE_URL: stallingBaseUrl,
      },
      50,
    );
    const { baseUrl, close, identityLinkStore, errors } =
      await buildServerWithOAuthClient(oauthClient);
    try {
      const start = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const location = new URL(start.headers.location ?? "");
      const state = location.searchParams.get("state") ?? "";
      const cookies = setCookiePairs(start.headers);
      const startedAtMs = Date.now();
      const callback = await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=whatever&state=${state}`,
        cookieHeader(cookies),
      );
      const elapsedMs = Date.now() - startedAtMs;
      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe("/bet?github=error");
      // Well under the real 10s default, comfortably above the injected
      // 50ms bound — proves it timed out rather than merely being fast.
      expect(elapsedMs).toBeLessThan(3_000);
      expect(
        errors.some((e) => e.code === "github_auth_code_exchange_failed"),
      ).toBe(true);
      const status = await rawGet(
        baseUrl,
        "/api/premieres/auth/github/status",
        cookieHeader(cookies),
      );
      const parsed = JSON.parse(status.body) as {
        identity: { signedIn: boolean; canonicalParticipantId: string };
      };
      expect(parsed.identity.signedIn).toBe(false);
      const directStatus = await identityLinkStore.getStatus(
        parsed.identity.canonicalParticipantId,
      );
      expect(directStatus.signedIn).toBe(false);
    } finally {
      await close();
      await new Promise<void>((resolve) => stallingServer.close(() => resolve()));
    }
  });
});

describe("resolveReplayPremiereGithubOAuthConfig", () => {
  let secretFileRoot: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    secretFileRoot = await fs.mkdtemp(
      path.join(realTemporaryRoot, "github-secret-"),
    );
  });

  afterEach(async () => {
    await fs.rm(secretFileRoot, { recursive: true, force: true });
  });

  test("returns null unless BOTH client id and secret are set", async () => {
    expect(await resolveReplayPremiereGithubOAuthConfig({})).toBeNull();
    expect(
      await resolveReplayPremiereGithubOAuthConfig({
        PROXYWAR_GITHUB_OAUTH_CLIENT_ID: "abc",
      }),
    ).toBeNull();
    expect(
      await resolveReplayPremiereGithubOAuthConfig({
        PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET: "xyz",
      }),
    ).toBeNull();
    expect(
      await resolveReplayPremiereGithubOAuthConfig({
        PROXYWAR_GITHUB_OAUTH_CLIENT_ID: "  ",
        PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET: "xyz",
      }),
    ).toBeNull();
    expect(
      await resolveReplayPremiereGithubOAuthConfig({
        PROXYWAR_GITHUB_OAUTH_CLIENT_ID: "abc",
        PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET: "xyz",
      }),
    ).toEqual({ clientId: "abc", clientSecret: "xyz" });
  });

  test("prefers CLIENT_SECRET_FILE over the inline secret, trimming a trailing newline", async () => {
    const secretPath = path.join(secretFileRoot, "secret");
    await fs.writeFile(secretPath, "from-file-secret\n");
    await fs.chmod(secretPath, 0o600);
    const config = await resolveReplayPremiereGithubOAuthConfig({
      PROXYWAR_GITHUB_OAUTH_CLIENT_ID: "abc",
      PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET: "inline-should-be-ignored",
      PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET_FILE: secretPath,
    });
    expect(config).toEqual({
      clientId: "abc",
      clientSecret: "from-file-secret",
    });
  });

  test("refuses a group/world-readable secret file rather than silently accepting it", async () => {
    // The entire reason the secret is passed by path is to keep it away from
    // other local accounts. Accepting a 0644 file gives that up while still
    // looking secure, so this fails closed exactly like an unset secret.
    const secretPath = path.join(secretFileRoot, "loose-secret");
    await fs.writeFile(secretPath, "from-file-secret");
    await fs.chmod(secretPath, 0o644);
    const config = await resolveReplayPremiereGithubOAuthConfig({
      PROXYWAR_GITHUB_OAUTH_CLIENT_ID: "abc",
      PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET_FILE: secretPath,
    });
    expect(config).toBeNull();
  });

  test("refuses a symlink pointing at a world-readable file — lstat, not stat", async () => {
    const target = path.join(secretFileRoot, "world-readable-target");
    const link = path.join(secretFileRoot, "sneaky-link");
    await fs.writeFile(target, "from-file-secret");
    await fs.chmod(target, 0o644);
    await fs.symlink(target, link);
    const config = await resolveReplayPremiereGithubOAuthConfig({
      PROXYWAR_GITHUB_OAUTH_CLIENT_ID: "abc",
      PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET_FILE: link,
    });
    expect(config).toBeNull();
  });

  test("falls back to the inline secret when CLIENT_SECRET_FILE is unset", async () => {
    const config = await resolveReplayPremiereGithubOAuthConfig({
      PROXYWAR_GITHUB_OAUTH_CLIENT_ID: "abc",
      PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET: "inline-secret",
    });
    expect(config).toEqual({ clientId: "abc", clientSecret: "inline-secret" });
  });

  test("an unreadable CLIENT_SECRET_FILE is treated exactly like an unset secret — cleanly absent, never thrown", async () => {
    const config = await resolveReplayPremiereGithubOAuthConfig({
      PROXYWAR_GITHUB_OAUTH_CLIENT_ID: "abc",
      PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET: "inline-should-still-be-ignored",
      PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET_FILE: path.join(
        secretFileRoot,
        "does-not-exist",
      ),
    });
    expect(config).toBeNull();
  });

  test("an empty CLIENT_SECRET_FILE is treated as unset", async () => {
    const secretPath = path.join(secretFileRoot, "empty-secret");
    await fs.writeFile(secretPath, "   \n");
    const config = await resolveReplayPremiereGithubOAuthConfig({
      PROXYWAR_GITHUB_OAUTH_CLIENT_ID: "abc",
      PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET_FILE: secretPath,
    });
    expect(config).toBeNull();
  });
});
