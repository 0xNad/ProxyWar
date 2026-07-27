/**
 * Closes the loop between `ReplayPremiereGithubAuth`'s identity-link flow
 * and the LIVE market: linking canonicalises identity, but the trade path
 * uses whatever guest cookie a browser holds — these tests prove the
 * canonical-cookie hand-off plus the atomic retire/release guard actually
 * prevent the Sybil hole (N browsers, N bankrolls, one leaderboard entry)
 * end to end, against a REAL `ReplayPremiereInteractions` market, not a
 * stub.
 *
 * The durable half of that hand-off — `ReplayPremiereHttp`'s
 * `resolveCanonicalParticipantId` applied at every authenticated boundary,
 * not just the process-local retirement guard — is exercised over the
 * REAL HTTP trading router (`createReplayPremiereRouter`), across a
 * simulated origin restart and a later premiere, in the
 * "durable canonical resolution" describe block below.
 */
import express from "express";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { PremiereCanonicalAuthoritativeResult } from "../../../src/server/replay-premiere/ReplayPremiereAuthoritativeResult";
import type { PremiereState } from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import { REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS } from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import {
  createReplayPremiereGithubAuthRouter,
  type ReplayPremiereGithubOAuthClient,
} from "../../../src/server/replay-premiere/ReplayPremiereGithubAuth";
import {
  createReplayPremiereRouter,
  ReplayPremiereHttpRegistry,
  type ReplayPremiereRuntimeReader,
} from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import {
  ReplayPremiereInteractions,
  type ReplayPremiereInteractionsSnapshot,
  type ReplayPremiereSettlementPointsRecorder,
} from "../../../src/server/replay-premiere/ReplayPremiereInteractions";
import {
  pointsMergerFor,
  ReplayPremiereIdentityLinkStore,
  type ReplayPremiereLeagueClaimMerger,
} from "../../../src/server/replay-premiere/points/ReplayPremiereIdentityLinkStore";
import { ReplayPremierePointsLedger } from "../../../src/server/replay-premiere/points/ReplayPremierePointsLedger";
import { ReplayPremiereGuestSecurity } from "../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";

/** A league-claim merger that never has anything to reconcile — this file exercises the market-identity Sybil guard, not claim reconciliation (see `ReplayPremiereIdentityLinkStore.test.ts` for that). */
function noopLeagueClaimMerger(): ReplayPremiereLeagueClaimMerger {
  return {
    async mergeClaim() {
      return { claim: null, sourceClaimReplaced: false };
    },
  };
}

const origin = "https://bet.example.test";
const premiereId = "prem_abcdefghijklmnop";
const guestA = `guest_${"a".repeat(32)}`;
const guestB = `guest_${"b".repeat(32)}`;

const guestSecurityOptions = {
  hmacKey: new Uint8Array(32).fill(9),
  expectedOrigin: origin,
  production: false,
};

interface StubOAuthState {
  tokensByCode: Map<string, string>;
  usersByToken: Map<
    string,
    { githubUserId: number; login: string; avatarUrl: string | null }
  >;
}

function stubOAuthClient(state: StubOAuthState): ReplayPremiereGithubOAuthClient {
  return {
    buildAuthorizeUrl({ redirectUri, state: oauthState }) {
      const url = new URL("https://github.example.test/login/oauth/authorize");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", oauthState);
      return url.toString();
    },
    async exchangeCodeForToken(code) {
      const token = state.tokensByCode.get(code);
      if (token === undefined) throw new Error("invalid_code");
      return token;
    },
    async fetchUser(accessToken) {
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

function participantIdOf(guestCookieValue: string): string {
  return guestCookieValue.split(".")[1];
}

/** Headers for a JSON request against the trading router — every
 * authenticated boundary needs a strict `Origin`; writes additionally need
 * `X-Idempotency-Key`; every request after session creation needs the
 * `X-CSRF-Token` bound to whichever raw cookie is presented. */
function tradeHeaders(options: {
  idempotencyKey?: string;
  cookie?: string;
  csrfToken?: string;
}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: origin,
    ...(options.idempotencyKey === undefined
      ? {}
      : { "X-Idempotency-Key": options.idempotencyKey }),
    ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
    ...(options.csrfToken === undefined
      ? {}
      : { "X-CSRF-Token": options.csrfToken }),
  };
}

function interactionsHarness(overrides?: {
  premiereId?: string;
  wageringEnabled?: boolean;
  initialState?: ReplayPremiereInteractionsSnapshot;
  pointsLedger?: ReplayPremiereSettlementPointsRecorder;
}) {
  const resolvedPremiereId = overrides?.premiereId ?? premiereId;
  let premiereState: PremiereState = "playing";
  let requestValue = 1;
  let nowMs = Date.parse("2026-07-20T12:00:00.000Z");
  const admitAnonymousWrite = () => undefined;
  const interactions = new ReplayPremiereInteractions({
    premiereId: resolvedPremiereId,
    checkpointDescriptors: [
      { id: "cp_first0001", sequence: 35 },
      { id: "cp_second001", sequence: 65 },
    ],
    seats: [
      {
        seatId: "seat-1",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "alpha",
          declaredVersion: "1",
          manifestSha256: "1".repeat(64),
          contentSha256: "2".repeat(64),
        },
      },
      {
        seatId: "SEAT0001",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "beta",
          declaredVersion: "1",
          manifestSha256: "3".repeat(64),
          contentSha256: "4".repeat(64),
        },
      },
    ],
    getPremiereState: () => premiereState,
    getReleasedContext: (sequence) =>
      sequence <= 80
        ? { releasedThroughSequence: 80, turn: sequence, eventContext: null }
        : null,
    getLiveVisibleSequence: () => 80,
    persistence: { async persist() {} },
    signAttribution: ({ shareId }) => `signed-${shareId}`,
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${resolvedPremiereId}`,
    now: () => new Date(nowMs),
    initialState: overrides?.initialState,
    wageringEnabled: overrides?.wageringEnabled ?? true,
    pointsLedger: overrides?.pointsLedger,
    admitAnonymousWrite,
  });
  return {
    interactions,
    premiereId: resolvedPremiereId,
    admitAnonymousWrite,
    getPremiereState: () => premiereState,
    setPremiereState(state: PremiereState) {
      premiereState = state;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    now: () => new Date(nowMs).toISOString(),
    nextIdempotencyKey() {
      const key = `idem_${String(requestValue).padStart(16, "0")}`;
      requestValue += 1;
      return key;
    },
  };
}

type Harness = ReturnType<typeof interactionsHarness>;

/** Minimal `ReplayPremiereRuntimeReader` for these trading-path tests: only
 * `readLifecycleState` (the "archived" write guard, and the session/
 * heartbeat response field) is ever exercised — every other method is
 * unreachable through the routes these tests hit. */
function stubRuntimeReader(
  runtimePremiereId: string,
  readLifecycleState: () => PremiereState,
): ReplayPremiereRuntimeReader {
  return {
    premiereId: runtimePremiereId,
    readLifecycleState,
    readBootstrap: () => {
      throw new Error("not exercised by these trading-path tests");
    },
    readManifest: async () => {
      throw new Error("not exercised by these trading-path tests");
    },
    readChunk: () => null,
    readReveal: () => null,
    readReleasedContext: () => null,
    readLiveVisibleSequence: () => 80,
    readLiveProjection: () => [],
  };
}

/**
 * Mounts BOTH the GitHub sign-in router and the real trading router
 * (`createReplayPremiereRouter`), wired exactly like production —
 * `resolveCanonicalParticipantId` bound to the same
 * `ReplayPremiereIdentityLinkStore` the auth router writes through — so a
 * test can drive the entire link-then-trade flow over real HTTP. `stores`
 * lets a test supply an already-open (or freshly reopened) ledger/store
 * pair, for simulating a restart.
 */
async function buildServer(
  root: string,
  h: Harness,
  oauthState: StubOAuthState,
  stores?: {
    ledger: ReplayPremierePointsLedger;
    identityLinkStore: ReplayPremiereIdentityLinkStore;
  },
): Promise<{
  baseUrl: string;
  identityLinkStore: ReplayPremiereIdentityLinkStore;
  ledger: ReplayPremierePointsLedger;
  close: () => Promise<void>;
}> {
  const ledger =
    stores?.ledger ??
    (await ReplayPremierePointsLedger.open(path.join(root, "points-ledger")));
  const identityLinkStore =
    stores?.identityLinkStore ??
    (await ReplayPremiereIdentityLinkStore.open(
      path.join(root, "identity-links"),
      pointsMergerFor(ledger),
      noopLeagueClaimMerger(),
    ));
  const security = new ReplayPremiereGuestSecurity(guestSecurityOptions);
  const registry = new ReplayPremiereHttpRegistry(h.admitAnonymousWrite);
  registry.register({
    runtime: stubRuntimeReader(h.premiereId, h.getPremiereState),
    interactions: h.interactions,
  });
  const app = express();
  app.use(
    createReplayPremiereGithubAuthRouter({
      security,
      identityLinkStore,
      oauthClient: stubOAuthClient(oauthState),
      publicOrigin: origin,
      // Exactly one live premiere for these tests — the real deploy
      // resolves this the same way (most recently registered id).
      resolveCurrentMarketIdentityGuard: () => h.interactions,
      onOperatorError: () => {},
    }),
  );
  app.use(
    createReplayPremiereRouter({
      registry,
      security,
      resolveClientAddress: () => "127.0.0.1",
      // The fix under test: canonicalise the signed-cookie participant
      // before it ever reaches `interactions`, at every authenticated
      // boundary the trading router exposes.
      resolveCanonicalParticipantId: (participantId) =>
        identityLinkStore.resolveCanonicalParticipantId(participantId),
      onOperatorError: () => {},
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
    identityLinkStore,
    ledger,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function createSession(h: Harness, participantId: string) {
  return h.interactions.createViewerSession({
    participantId,
    idempotencyKey: h.nextIdempotencyKey(),
    requesterBucketId: `ip_${"1".repeat(32)}`,
    visible: true,
    observedSequence: 35,
    excludedAsOperator: false,
    excludedAsBot: false,
  });
}

function order(
  h: Harness,
  options: {
    participantId: string;
    sessionId: string;
    seatId: string;
    side: "buy" | "sell";
    amount: number;
    limitPrice: number;
  },
) {
  return h.interactions.submitMarketOrder({
    participantId: options.participantId,
    participantKind: "real",
    sessionId: options.sessionId,
    seatId: options.seatId,
    side: options.side,
    amount: options.amount,
    limitPrice: options.limitPrice,
    sequence: 80,
    idempotencyKey: h.nextIdempotencyKey(),
    requesterBucketId: `ip_${"1".repeat(64)}`,
  });
}

async function openCheckpoint(h: Harness, checkpointId: string) {
  await h.interactions.openCheckpoint({
    checkpointId,
    opensAt: h.now(),
    closesAt: new Date(
      Date.parse(h.now()) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
    ).toISOString(),
    optionSeatIds: ["seat-1", "SEAT0001"],
  });
}

async function closeCheckpoint(h: Harness, checkpointId: string) {
  h.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);
  await h.interactions.closeCheckpoint(checkpointId, h.now());
}

function authoritativeResult(
  winner: PremiereCanonicalAuthoritativeResult["winner"],
): PremiereCanonicalAuthoritativeResult {
  return {
    schemaVersion: 1,
    sourceKind: "controlled_result",
    sourceRunId: "controlled-run-1",
    sourceId: "controlled-source-1",
    gameId: "game-1",
    completedAt: "2026-07-20T11:55:00.000Z",
    turnCount: 80,
    winner,
    seats: [
      { seatId: "seat-1", displayName: "Alpha", won: false },
      { seatId: "SEAT0001", displayName: "Beta", won: false },
    ],
  };
}

describe("ReplayPremiereInteractions.retireForIdentityLinkIfSafe / releaseIdentityLinkRetirement", () => {
  it("reports safe with nothing to retire when the participant never traded, and blocks the id afterward", async () => {
    const h = interactionsHarness();
    const before = await h.interactions.retireForIdentityLinkIfSafe(guestA);
    expect(before.safe).toBe(true);

    const session = await createSession(h, guestA);
    await expect(
      order(h, {
        participantId: guestA,
        sessionId: session.id,
        seatId: "seat-1",
        side: "buy",
        amount: 100,
        limitPrice: 100,
      }),
    ).rejects.toThrow(/order_rejected_identity_retired/);
  });

  it("reports unsafe once the participant has ANY ledger grant, even after selling every share back to zero", async () => {
    const h = interactionsHarness();
    const session = await createSession(h, guestA);
    await order(h, {
      participantId: guestA,
      sessionId: session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
    });
    const heldWhileHolding = await h.interactions.retireForIdentityLinkIfSafe(
      guestA,
    );
    expect(heldWhileHolding.safe).toBe(false);

    // Sell everything back — zero shares, but the ledger grant (and the
    // now-diverged balance) never resets. Zero shares must not read as
    // zero participation.
    const state = h.interactions.readMarketState(guestA);
    const heldShares = state?.positions?.[0]?.shares ?? 0;
    expect(heldShares).toBeGreaterThan(0);
    await order(h, {
      participantId: guestA,
      sessionId: session.id,
      seatId: "seat-1",
      side: "sell",
      amount: heldShares,
      limitPrice: 0,
    });
    const afterFullSell = h.interactions.readMarketState(guestA);
    expect(afterFullSell?.positions?.[0]?.shares ?? 0).toBe(0);

    const heldAfterSellout = await h.interactions.retireForIdentityLinkIfSafe(
      guestA,
    );
    expect(heldAfterSellout.safe).toBe(false);
  });

  it("releaseIdentityLinkRetirement restores trading under a retired id", async () => {
    const h = interactionsHarness();
    const session = await createSession(h, guestA);
    const retired = await h.interactions.retireForIdentityLinkIfSafe(guestA);
    expect(retired.safe).toBe(true);
    await h.interactions.releaseIdentityLinkRetirement(guestA);
    const trade = await order(h, {
      participantId: guestA,
      sessionId: session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
    });
    expect(trade.trade.participantId).toBe(guestA);
  });

  it("is always safe once the market has settled, even for a participant who traded heavily — settlement can never be stranded", async () => {
    const h = interactionsHarness();
    const session = await createSession(h, guestA);
    await openCheckpoint(h, "cp_first0001");
    await order(h, {
      participantId: guestA,
      sessionId: session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
    });
    await closeCheckpoint(h, "cp_first0001");
    await openCheckpoint(h, "cp_second001");
    await closeCheckpoint(h, "cp_second001");
    h.setPremiereState("revealed");
    await h.interactions.resolvePredictionsFromAuthoritativeResult({
      result: authoritativeResult(["player", "seat-1"]),
      resolvedAt: h.now(),
    });
    const afterSettlement = await h.interactions.retireForIdentityLinkIfSafe(
      guestA,
    );
    expect(afterSettlement.safe).toBe(true);
  });

  it("scoping is per-instance: a brand-new premiere never inherits another premiere's retirement or trading history for the same participant id", async () => {
    const settled = interactionsHarness();
    const settledSession = await createSession(settled, guestA);
    await openCheckpoint(settled, "cp_first0001");
    await order(settled, {
      participantId: guestA,
      sessionId: settledSession.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
    });
    await closeCheckpoint(settled, "cp_first0001");
    await openCheckpoint(settled, "cp_second001");
    await closeCheckpoint(settled, "cp_second001");
    settled.setPremiereState("revealed");
    await settled.interactions.resolvePredictionsFromAuthoritativeResult({
      result: authoritativeResult(["player", "seat-1"]),
      resolvedAt: settled.now(),
    });

    // A different premiere entirely (a fresh interactions instance, exactly
    // what "the next match" is) — the SAME participant id, never having
    // traded here, must link cleanly. The block is per-premiere
    // participation, never a permanent, cross-premiere state.
    const next = interactionsHarness();
    const stillSafe = await next.interactions.retireForIdentityLinkIfSafe(
      guestA,
    );
    expect(stillSafe.safe).toBe(true);
    // Mirrors what the real callback does for a same-id resolution: the
    // hold was transient, release it, then trade normally.
    await next.interactions.releaseIdentityLinkRetirement(guestA);
    const nextSession = await createSession(next, guestA);
    const trade = await order(next, {
      participantId: guestA,
      sessionId: nextSession.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
    });
    expect(trade.trade.participantId).toBe(guestA);
  });

  it("concurrent race, order issued first: the trade lands, and the retirement that follows correctly observes it and refuses", async () => {
    const h = interactionsHarness();
    const session = await createSession(h, guestA);
    const [tradeResult, retireResult] = await Promise.all([
      order(h, {
        participantId: guestA,
        sessionId: session.id,
        seatId: "seat-1",
        side: "buy",
        amount: 100,
        limitPrice: 100,
      }),
      h.interactions.retireForIdentityLinkIfSafe(guestA),
    ]);
    expect(tradeResult.trade.participantId).toBe(guestA);
    expect(retireResult.safe).toBe(false);
  });

  it("concurrent race, retirement issued first: the hold wins, and the racing order under the same id is rejected — never both succeeding", async () => {
    const h = interactionsHarness();
    const session = await createSession(h, guestA);
    const [retireResult, orderOutcome] = await Promise.all([
      h.interactions.retireForIdentityLinkIfSafe(guestA),
      order(h, {
        participantId: guestA,
        sessionId: session.id,
        seatId: "seat-1",
        side: "buy",
        amount: 100,
        limitPrice: 100,
      }).then(
        (trade) => ({ ok: true as const, trade }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);
    expect(retireResult.safe).toBe(true);
    expect(orderOutcome.ok).toBe(false);
    if (!orderOutcome.ok) {
      expect(String(orderOutcome.error)).toMatch(/order_rejected_identity_retired/);
    }
    // The one outcome that must never happen: both winning, which would
    // mean an order landed under an id whose bankroll the link flow just
    // decided was safe to abandon — a stranded, silently-doubled account.
  });
});

describe("ReplayPremiereGithubAuth against a real live market", () => {
  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(realTemporaryRoot, "github-market-link-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("ACCEPTANCE: two browsers linked to one GitHub id share one bankroll and one position set — buy in A, sell in B, verified at the HTTP trading boundary", async () => {
    const h = interactionsHarness();
    const oauthState: StubOAuthState = {
      tokensByCode: new Map([
        ["code-a", "token-a"],
        ["code-b", "token-b"],
      ]),
      usersByToken: new Map([
        ["token-a", { githubUserId: 100, login: "daveey", avatarUrl: null }],
        ["token-b", { githubUserId: 100, login: "daveey", avatarUrl: null }],
      ]),
    };
    const { baseUrl, close } = await buildServer(root, h, oauthState);
    try {
      // Browser A signs in first — no prior GitHub link for this id, so A
      // becomes its own canonical (a same-id resolution).
      const startA = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const cookiesA = setCookiePairs(startA.headers);
      const stateA = new URL(startA.headers.location ?? "").searchParams.get(
        "state",
      );
      const participantA = participantIdOf(cookiesA.proxywar_premiere_guest);
      const linkA = await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=code-a&state=${stateA}`,
        cookieHeader(cookiesA),
      );
      expect(linkA.headers.location).toBe("/bet?github=linked");

      // Browser B — a totally different profile/device — signs in with the
      // SAME GitHub account. It never traded, so nothing blocks it; it
      // must adopt A's canonical id.
      const startB = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const cookiesB = setCookiePairs(startB.headers);
      const stateB = new URL(startB.headers.location ?? "").searchParams.get(
        "state",
      );
      const originalParticipantB = participantIdOf(
        cookiesB.proxywar_premiere_guest,
      );
      expect(originalParticipantB).not.toBe(participantA);
      const linkB = await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=code-b&state=${stateB}`,
        cookieHeader(cookiesB),
      );
      expect(linkB.headers.location).toBe("/bet?github=linked");
      // Deliberately keep using `cookiesB` — browser B's ORIGINAL,
      // now-merged-away cookie from BEFORE the link, never the rewritten
      // one the callback response also set. This is exactly the
      // already-open-second-tab / never-reloaded scenario the durable
      // resolver has to cover; the old test this one replaces used the
      // POST-link cookie instead, which only proved the trivial case.

      // Buy in browser A, over the real HTTP trading boundary.
      const sessionA = await fetch(`${baseUrl}/api/premieres/${premiereId}/sessions`, {
        method: "POST",
        headers: tradeHeaders({
          idempotencyKey: "http_session_a_0000001",
          cookie: cookieHeader(cookiesA),
        }),
        body: JSON.stringify({ visible: true, observedSequence: 80 }),
      }).then((response) => {
        expect(response.status).toBe(201);
        return response.json();
      });
      expect(sessionA.session.participantId).toBe(participantA);

      const buy = await fetch(`${baseUrl}/api/premieres/${premiereId}/market-orders`, {
        method: "POST",
        headers: tradeHeaders({
          idempotencyKey: "http_order_a_00000001",
          cookie: cookieHeader(cookiesA),
          csrfToken: sessionA.csrfToken,
        }),
        body: JSON.stringify({
          sessionId: sessionA.session.id,
          seatId: "seat-1",
          side: "buy",
          amount: 200,
          limitPrice: 100,
          sequence: 80,
        }),
      }).then((response) => {
        expect(response.status).toBe(200);
        return response.json();
      });
      expect(buy.trade.participantId).toBe(participantA);
      expect(buy.trade.shares).toBeGreaterThan(0);

      // Browser B — presenting its OWN, still-signed, pre-link cookie —
      // creates a session over HTTP. The Sybil fix, verified: it
      // converges on A's existing session, not a fresh one of its own,
      // because `interactions` only ever sees the canonical id.
      const sessionB = await fetch(`${baseUrl}/api/premieres/${premiereId}/sessions`, {
        method: "POST",
        headers: tradeHeaders({
          idempotencyKey: "http_session_b_0000001",
          cookie: cookieHeader(cookiesB),
        }),
        body: JSON.stringify({ visible: true, observedSequence: 80 }),
      }).then((response) => {
        expect(response.status).toBe(201);
        return response.json();
      });
      expect(sessionB.session.participantId).toBe(participantA);
      expect(sessionB.session.id).toBe(sessionA.session.id);

      // Browser B reads its "own" market position over HTTP — sees
      // exactly what A just bought, because it is the same account.
      const marketSelfB = await fetch(`${baseUrl}/api/premieres/${premiereId}/market/me`, {
        headers: tradeHeaders({
          cookie: cookieHeader(cookiesB),
          csrfToken: sessionB.csrfToken,
        }),
      }).then((response) => {
        expect(response.status).toBe(200);
        return response.json();
      });
      const heldByB = marketSelfB.market.positions?.[0]?.shares ?? 0;
      expect(heldByB).toBe(buy.trade.shares);

      // Sell the position from browser B, over HTTP.
      const sell = await fetch(`${baseUrl}/api/premieres/${premiereId}/market-orders`, {
        method: "POST",
        headers: tradeHeaders({
          idempotencyKey: "http_order_b_00000001",
          cookie: cookieHeader(cookiesB),
          csrfToken: sessionB.csrfToken,
        }),
        body: JSON.stringify({
          sessionId: sessionB.session.id,
          seatId: "seat-1",
          side: "sell",
          amount: heldByB,
          limitPrice: 0,
          sequence: 80,
        }),
      }).then((response) => {
        expect(response.status).toBe(200);
        return response.json();
      });
      expect(sell.trade.side).toBe("sell");
      expect(sell.trade.shares).toBe(heldByB);
      expect(sell.trade.participantId).toBe(participantA);

      // Confirmed from A's side too — one shared position set, now flat,
      // and one shared bankroll (never two independent 1,000-credit
      // accounts). Both reads are taken at the same point in time, right
      // after the sell, so they must agree exactly.
      const marketSelfA = await fetch(`${baseUrl}/api/premieres/${premiereId}/market/me`, {
        headers: tradeHeaders({
          cookie: cookieHeader(cookiesA),
          csrfToken: sessionA.csrfToken,
        }),
      }).then((response) => response.json());
      const marketSelfBAfterSell = await fetch(
        `${baseUrl}/api/premieres/${premiereId}/market/me`,
        {
          headers: tradeHeaders({
            cookie: cookieHeader(cookiesB),
            csrfToken: sessionB.csrfToken,
          }),
        },
      ).then((response) => response.json());
      expect(marketSelfA.market.positions?.[0]?.shares ?? 0).toBe(0);
      expect(marketSelfA.market.balance).toBe(marketSelfBAfterSell.market.balance);
    } finally {
      await close();
    }
  });

  it("ACCEPTANCE: trade then link mid-premiere is refused with the specific reason, and the position/bankroll are untouched and still sellable", async () => {
    const h = interactionsHarness();
    const oauthState: StubOAuthState = {
      tokensByCode: new Map([["good-code", "token-1"]]),
      usersByToken: new Map([
        ["token-1", { githubUserId: 200, login: "trader", avatarUrl: null }],
      ]),
    };
    const { baseUrl, close } = await buildServer(root, h, oauthState);
    try {
      const start = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const cookies = setCookiePairs(start.headers);
      const state = new URL(start.headers.location ?? "").searchParams.get(
        "state",
      );
      const participant = participantIdOf(cookies.proxywar_premiere_guest);

      const session = await createSession(h, participant);
      const buy = await order(h, {
        participantId: participant,
        sessionId: session.id,
        seatId: "seat-1",
        side: "buy",
        amount: 200,
        limitPrice: 100,
      });
      const balanceAfterBuy = h.interactions.readMarketState(participant)
        ?.balance;

      const callback = await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=good-code&state=${state}`,
        cookieHeader(cookies),
      );
      expect(callback.headers.location).toBe("/bet?github=active_trade");

      // Nothing half-applied: same balance, same position, still theirs to
      // sell under the SAME id (no cookie was ever issued).
      const afterRefusal = h.interactions.readMarketState(participant);
      expect(afterRefusal?.balance).toBe(balanceAfterBuy);
      expect(afterRefusal?.positions?.[0]?.shares).toBe(buy.trade.shares);
      const sell = await order(h, {
        participantId: participant,
        sessionId: session.id,
        seatId: "seat-1",
        side: "sell",
        amount: buy.trade.shares,
        limitPrice: 0,
      });
      expect(sell.trade.shares).toBe(buy.trade.shares);
    } finally {
      await close();
    }
  });

  it("ACCEPTANCE: buy then sell everything, then attempt to link — still refused (zero shares is not zero participation), and the account is untouched", async () => {
    const h = interactionsHarness();
    const oauthState: StubOAuthState = {
      tokensByCode: new Map([["good-code", "token-1"]]),
      usersByToken: new Map([
        ["token-1", { githubUserId: 201, login: "flat-trader", avatarUrl: null }],
      ]),
    };
    const { baseUrl, close } = await buildServer(root, h, oauthState);
    try {
      const start = await rawGet(baseUrl, "/api/premieres/auth/github/start");
      const cookies = setCookiePairs(start.headers);
      const state = new URL(start.headers.location ?? "").searchParams.get(
        "state",
      );
      const participant = participantIdOf(cookies.proxywar_premiere_guest);

      const session = await createSession(h, participant);
      const buy = await order(h, {
        participantId: participant,
        sessionId: session.id,
        seatId: "seat-1",
        side: "buy",
        amount: 200,
        limitPrice: 100,
      });
      await order(h, {
        participantId: participant,
        sessionId: session.id,
        seatId: "seat-1",
        side: "sell",
        amount: buy.trade.shares,
        limitPrice: 0,
      });
      const flatBalance = h.interactions.readMarketState(participant)?.balance;
      expect(
        h.interactions.readMarketState(participant)?.positions?.length,
      ).toBe(0);

      const callback = await rawGet(
        baseUrl,
        `/api/premieres/auth/github/callback?code=good-code&state=${state}`,
        cookieHeader(cookies),
      );
      expect(callback.headers.location).toBe("/bet?github=active_trade");

      const afterRefusal = h.interactions.readMarketState(participant);
      expect(afterRefusal?.balance).toBe(flatBalance);
      // Still fully able to trade under this same, un-swapped id.
      const rebuy = await order(h, {
        participantId: participant,
        sessionId: session.id,
        seatId: "seat-1",
        side: "buy",
        amount: 100,
        limitPrice: 100,
      });
      expect(rebuy.trade.participantId).toBe(participant);
    } finally {
      await close();
    }
  });

  it("a guest who never links is completely unaffected: normal trading, untouched by the identity-link machinery", async () => {
    const h = interactionsHarness();
    const oauthState: StubOAuthState = {
      tokensByCode: new Map(),
      usersByToken: new Map(),
    };
    // Router mounted (as it always is in production once GitHub OAuth is
    // configured) but never called.
    await buildServer(root, h, oauthState).then(({ close }) => close());

    const session = await createSession(h, guestB);
    const buy = await order(h, {
      participantId: guestB,
      sessionId: session.id,
      seatId: "seat-1",
      side: "buy",
      amount: 100,
      limitPrice: 100,
    });
    expect(buy.trade.participantId).toBe(guestB);
    const sell = await order(h, {
      participantId: guestB,
      sessionId: session.id,
      seatId: "seat-1",
      side: "sell",
      amount: buy.trade.shares,
      limitPrice: 0,
    });
    expect(sell.trade.participantId).toBe(guestB);
  });
});

describe("settlement-time canonicalisation (second line of defense)", () => {
  it("two guests who trade a live, unsettled premiere from separate ids and link only AFTER it settles still get summed into one canonical leaderboard entry", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "settlement-canon-"),
    );
    try {
      const ledger = await ReplayPremierePointsLedger.open(
        path.join(root, "points-ledger"),
      );
      const identityLinkStore = await ReplayPremiereIdentityLinkStore.open(
        path.join(root, "identity-links"),
        pointsMergerFor(ledger),
        noopLeagueClaimMerger(),
      );
      const h = interactionsHarness({ pointsLedger: ledger });
      const sessionA = await createSession(h, guestA);
      const sessionB = await createSession(h, guestB);
      await openCheckpoint(h, "cp_first0001");
      await order(h, {
        participantId: guestA,
        sessionId: sessionA.id,
        seatId: "seat-1",
        side: "buy",
        amount: 100,
        limitPrice: 100,
      });
      await order(h, {
        participantId: guestB,
        sessionId: sessionB.id,
        seatId: "SEAT0001",
        side: "buy",
        amount: 100,
        limitPrice: 100,
      });
      await closeCheckpoint(h, "cp_first0001");
      await openCheckpoint(h, "cp_second001");
      await closeCheckpoint(h, "cp_second001");
      h.setPremiereState("revealed");
      await h.interactions.resolvePredictionsFromAuthoritativeResult({
        result: authoritativeResult(["player", "seat-1"]),
        resolvedAt: h.now(),
      });

      // Only NOW, post-settlement, do they link — retirement is trivially
      // safe (market.status === "settled"), and the durable points ledger
      // is what has to reconcile the two histories into one identity.
      await identityLinkStore.linkOrMerge(guestA, {
        githubUserId: 999,
        login: "daveey",
        avatarUrl: null,
      });
      const linkResult = await identityLinkStore.linkOrMerge(guestB, {
        githubUserId: 999,
        login: "daveey",
        avatarUrl: null,
      });
      expect(linkResult.canonicalParticipantId).toBe(guestA);
      expect(linkResult.merged).toBe(true);

      const board = await ledger.readLeaderboard({
        viewerParticipantId: guestA,
      });
      expect(board.viewer?.participantId).toBe(guestA);
      expect(board.viewer?.premieresTraded).toBe(1);
      expect(
        board.entries.some((entry) => entry.participantId === guestB),
      ).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("durable canonical resolution at the HTTP trading boundary (across restarts and premieres)", () => {
  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(
      path.join(realTemporaryRoot, "durable-canonical-"),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const emptyOauthState: StubOAuthState = {
    tokensByCode: new Map(),
    usersByToken: new Map(),
  };

  it("an old, still-valid signed cookie resolves to the canonical account across a simulated origin restart — new interactions instance, reopened identity store", async () => {
    const ledger1 = await ReplayPremierePointsLedger.open(
      path.join(root, "points-ledger"),
    );
    const identityLinkStore1 = await ReplayPremiereIdentityLinkStore.open(
      path.join(root, "identity-links"),
      pointsMergerFor(ledger1),
      noopLeagueClaimMerger(),
    );
    await identityLinkStore1.linkOrMerge(guestA, {
      githubUserId: 600,
      login: "daveey",
      avatarUrl: null,
    });
    const linked = await identityLinkStore1.linkOrMerge(guestB, {
      githubUserId: 600,
      login: "daveey",
      avatarUrl: null,
    });
    expect(linked.merged).toBe(true);
    expect(linked.canonicalParticipantId).toBe(guestA);

    const h1 = interactionsHarness();
    const server1 = await buildServer(root, h1, emptyOauthState, {
      ledger: ledger1,
      identityLinkStore: identityLinkStore1,
    });
    let sessionId: string;
    let boughtShares: number;
    try {
      const security = new ReplayPremiereGuestSecurity(guestSecurityOptions);
      const cookieA = security
        .mintGuestCookieForParticipant(guestA)
        .split(";", 1)[0];

      const sessionBody = await fetch(
        `${server1.baseUrl}/api/premieres/${premiereId}/sessions`,
        {
          method: "POST",
          headers: tradeHeaders({
            idempotencyKey: "restart_session_a_00001",
            cookie: cookieA,
          }),
          body: JSON.stringify({ visible: true, observedSequence: 80 }),
        },
      ).then((response) => {
        expect(response.status).toBe(201);
        return response.json();
      });
      expect(sessionBody.session.participantId).toBe(guestA);
      sessionId = sessionBody.session.id;

      const buy = await fetch(
        `${server1.baseUrl}/api/premieres/${premiereId}/market-orders`,
        {
          method: "POST",
          headers: tradeHeaders({
            idempotencyKey: "restart_order_a_0000001",
            cookie: cookieA,
            csrfToken: sessionBody.csrfToken,
          }),
          body: JSON.stringify({
            sessionId,
            seatId: "seat-1",
            side: "buy",
            amount: 200,
            limitPrice: 100,
            sequence: 80,
          }),
        },
      ).then((response) => {
        expect(response.status).toBe(200);
        return response.json();
      });
      boughtShares = buy.trade.shares;
      expect(boughtShares).toBeGreaterThan(0);
    } finally {
      await server1.close();
    }

    // Simulated origin restart: a brand-new `ReplayPremiereInteractions`
    // recovered from exactly the snapshot the old process would have
    // persisted, and a brand-new `ReplayPremiereIdentityLinkStore` opened
    // cold from disk — nothing in-memory carries over from server1.
    const recoveredState = h1.interactions.readState();
    const h2 = interactionsHarness({ initialState: recoveredState });
    const ledger2 = await ReplayPremierePointsLedger.open(
      path.join(root, "points-ledger"),
    );
    const identityLinkStore2 = await ReplayPremiereIdentityLinkStore.open(
      path.join(root, "identity-links"),
      pointsMergerFor(ledger2),
      noopLeagueClaimMerger(),
    );
    const server2 = await buildServer(root, h2, emptyOauthState, {
      ledger: ledger2,
      identityLinkStore: identityLinkStore2,
    });
    try {
      // Browser B's cookie was signed against guestB and never touched
      // since — exactly the stale credential a browser that never
      // reloaded still presents to a freshly restarted origin.
      const security = new ReplayPremiereGuestSecurity(guestSecurityOptions);
      const cookieB = security
        .mintGuestCookieForParticipant(guestB)
        .split(";", 1)[0];

      const sessionBody = await fetch(
        `${server2.baseUrl}/api/premieres/${premiereId}/sessions`,
        {
          method: "POST",
          headers: tradeHeaders({
            idempotencyKey: "restart_session_b_00001",
            cookie: cookieB,
          }),
          body: JSON.stringify({ visible: true, observedSequence: 80 }),
        },
      ).then((response) => {
        expect(response.status).toBe(201);
        return response.json();
      });
      // Session creation with a merged-away cookie yields a session for
      // the CANONICAL participant, on a process that never held B's
      // identity in memory at all — and converges on the SAME session A
      // already had.
      expect(sessionBody.session.participantId).toBe(guestA);
      expect(sessionBody.session.id).toBe(sessionId);

      const marketBody = await fetch(
        `${server2.baseUrl}/api/premieres/${premiereId}/market/me`,
        {
          headers: tradeHeaders({
            cookie: cookieB,
            csrfToken: sessionBody.csrfToken,
          }),
        },
      ).then((response) => {
        expect(response.status).toBe(200);
        return response.json();
      });
      // The canonical bankroll and position from BEFORE the restart —
      // never a fresh 1,000 credits.
      expect(marketBody.market.positions?.[0]?.shares ?? 0).toBe(
        boughtShares,
      );
      expect(marketBody.market.balance).not.toBe(1_000);
    } finally {
      await server2.close();
    }
  });

  it("the same old cookie still resolves to canonical on a later premiere where ledgerGranted is empty — the case the retirement guard structurally cannot cover", async () => {
    const ledger = await ReplayPremierePointsLedger.open(
      path.join(root, "points-ledger"),
    );
    const identityLinkStore = await ReplayPremiereIdentityLinkStore.open(
      path.join(root, "identity-links"),
      pointsMergerFor(ledger),
      noopLeagueClaimMerger(),
    );
    await identityLinkStore.linkOrMerge(guestA, {
      githubUserId: 700,
      login: "daveey",
      avatarUrl: null,
    });
    await identityLinkStore.linkOrMerge(guestB, {
      githubUserId: 700,
      login: "daveey",
      avatarUrl: null,
    });

    // A brand-new, later premiere: a fresh `ReplayPremiereInteractions`
    // that has never seen either id — `ledgerGranted` is empty, so
    // `retireForIdentityLinkIfSafe` was never even called here, let alone
    // recorded anything against guestB. If durable resolution were
    // missing, this is the exact case nothing else would catch.
    const laterPremiereId = "prem_bbbbbbbbbbbbbbbb";
    const h = interactionsHarness({ premiereId: laterPremiereId });
    const server = await buildServer(root, h, emptyOauthState, {
      ledger,
      identityLinkStore,
    });
    try {
      const security = new ReplayPremiereGuestSecurity(guestSecurityOptions);
      const cookieB = security
        .mintGuestCookieForParticipant(guestB)
        .split(";", 1)[0];

      const sessionBody = await fetch(
        `${server.baseUrl}/api/premieres/${laterPremiereId}/sessions`,
        {
          method: "POST",
          headers: tradeHeaders({
            idempotencyKey: "next_premiere_session_b1",
            cookie: cookieB,
          }),
          body: JSON.stringify({ visible: true, observedSequence: 80 }),
        },
      ).then((response) => {
        expect(response.status).toBe(201);
        return response.json();
      });
      expect(sessionBody.session.participantId).toBe(guestA);

      const buy = await fetch(
        `${server.baseUrl}/api/premieres/${laterPremiereId}/market-orders`,
        {
          method: "POST",
          headers: tradeHeaders({
            idempotencyKey: "next_premiere_order_b001",
            cookie: cookieB,
            csrfToken: sessionBody.csrfToken,
          }),
          body: JSON.stringify({
            sessionId: sessionBody.session.id,
            seatId: "seat-1",
            side: "buy",
            amount: 150,
            limitPrice: 100,
            sequence: 80,
          }),
        },
      ).then((response) => {
        expect(response.status).toBe(200);
        return response.json();
      });
      expect(buy.trade.participantId).toBe(guestA);
    } finally {
      await server.close();
    }
  });

  it("an unlinked guest is completely untouched by the identity-link machinery, and the resolver adds no I/O once warm", async () => {
    const ledger = await ReplayPremierePointsLedger.open(
      path.join(root, "points-ledger"),
    );
    const identityLinkStore = await ReplayPremiereIdentityLinkStore.open(
      path.join(root, "identity-links"),
      pointsMergerFor(ledger),
      noopLeagueClaimMerger(),
    );
    const h = interactionsHarness();
    const server = await buildServer(root, h, emptyOauthState, {
      ledger,
      identityLinkStore,
    });
    const readFileSpy = vi.spyOn(fs, "readFile");
    const linkFileReadCount = () =>
      readFileSpy.mock.calls.filter(([target]) =>
        String(target).includes("github-identity-links"),
      ).length;
    try {
      const sessionResponse = await fetch(
        `${server.baseUrl}/api/premieres/${premiereId}/sessions`,
        {
          method: "POST",
          headers: tradeHeaders({ idempotencyKey: "unlinked_session_0001" }),
          body: JSON.stringify({ visible: true, observedSequence: 80 }),
        },
      );
      expect(sessionResponse.status).toBe(201);
      const cookie = sessionResponse.headers
        .get("set-cookie")
        ?.split(";", 1)[0];
      const sessionBody = await sessionResponse.json();
      const rawParticipantId = sessionBody.session.participantId;
      // Never touched an alias — no link exists for this guest, so it
      // must trade as exactly itself.

      // The very first authenticated boundary crossing pays exactly one
      // cold read to warm the resolver's cache.
      expect(linkFileReadCount()).toBe(1);

      for (let i = 0; i < 5; i += 1) {
        const marketResponse = await fetch(
          `${server.baseUrl}/api/premieres/${premiereId}/market/me`,
          {
            headers: tradeHeaders({ cookie, csrfToken: sessionBody.csrfToken }),
          },
        );
        expect(marketResponse.status).toBe(200);
        const marketBody = await marketResponse.json();
        expect(marketBody.market.balance).toBe(1_000);
      }

      const buyResponse = await fetch(
        `${server.baseUrl}/api/premieres/${premiereId}/market-orders`,
        {
          method: "POST",
          headers: tradeHeaders({
            idempotencyKey: "unlinked_order_0001",
            cookie,
            csrfToken: sessionBody.csrfToken,
          }),
          body: JSON.stringify({
            sessionId: sessionBody.session.id,
            seatId: "seat-1",
            side: "buy",
            amount: 100,
            limitPrice: 100,
            sequence: 80,
          }),
        },
      );
      expect(buyResponse.status).toBe(200);
      const buyBody = await buyResponse.json();
      expect(buyBody.trade.participantId).toBe(rawParticipantId);

      // Five more reads and one write after the cold start — the cache
      // absorbed every one of them: still exactly one real file read
      // against the identity-link file for the whole test.
      expect(linkFileReadCount()).toBe(1);
    } finally {
      readFileSpy.mockRestore();
      await server.close();
    }
  });

  it("GitHub totally unreachable never blocks, delays, or fails a trade — resolution never leaves the local filesystem", async () => {
    const ledger = await ReplayPremierePointsLedger.open(
      path.join(root, "points-ledger"),
    );
    const identityLinkStore = await ReplayPremiereIdentityLinkStore.open(
      path.join(root, "identity-links"),
      pointsMergerFor(ledger),
      noopLeagueClaimMerger(),
    );
    // Established while GitHub was reachable — this is the durable state
    // resolution has to serve, not something being tested here.
    await identityLinkStore.linkOrMerge(guestA, {
      githubUserId: 800,
      login: "daveey",
      avatarUrl: null,
    });
    await identityLinkStore.linkOrMerge(guestB, {
      githubUserId: 800,
      login: "daveey",
      avatarUrl: null,
    });

    const h = interactionsHarness();
    const server = await buildServer(root, h, emptyOauthState, {
      ledger,
      identityLinkStore,
    });
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : String(input);
        if (url.startsWith(server.baseUrl)) {
          return realFetch(input, init);
        }
        // Anything else — GitHub's API, in production — is simulated as
        // completely unreachable: an immediate throw, never a hang.
        throw new Error(
          `GitHub-unreachable simulation: unexpected outbound request to ${url}`,
        );
      });
    try {
      const security = new ReplayPremiereGuestSecurity(guestSecurityOptions);
      const cookieB = security
        .mintGuestCookieForParticipant(guestB)
        .split(";", 1)[0];

      const sessionBody = await fetch(
        `${server.baseUrl}/api/premieres/${premiereId}/sessions`,
        {
          method: "POST",
          headers: tradeHeaders({
            idempotencyKey: "unreachable_session_b001",
            cookie: cookieB,
          }),
          body: JSON.stringify({ visible: true, observedSequence: 80 }),
        },
      ).then((response) => {
        expect(response.status).toBe(201);
        return response.json();
      });
      expect(sessionBody.session.participantId).toBe(guestA);

      const buy = await fetch(
        `${server.baseUrl}/api/premieres/${premiereId}/market-orders`,
        {
          method: "POST",
          headers: tradeHeaders({
            idempotencyKey: "unreachable_order_b0001",
            cookie: cookieB,
            csrfToken: sessionBody.csrfToken,
          }),
          body: JSON.stringify({
            sessionId: sessionBody.session.id,
            seatId: "seat-1",
            side: "buy",
            amount: 100,
            limitPrice: 100,
            sequence: 80,
          }),
        },
      ).then((response) => {
        expect(response.status).toBe(200);
        return response.json();
      });
      expect(buy.trade.participantId).toBe(guestA);

      const sell = await fetch(
        `${server.baseUrl}/api/premieres/${premiereId}/market-orders`,
        {
          method: "POST",
          headers: tradeHeaders({
            idempotencyKey: "unreachable_order_b0002",
            cookie: cookieB,
            csrfToken: sessionBody.csrfToken,
          }),
          body: JSON.stringify({
            sessionId: sessionBody.session.id,
            seatId: "seat-1",
            side: "sell",
            amount: buy.trade.shares,
            limitPrice: 0,
            sequence: 80,
          }),
        },
      ).then((response) => {
        expect(response.status).toBe(200);
        return response.json();
      });
      expect(sell.trade.participantId).toBe(guestA);
      // Nothing above ever reached outside the local loopback server —
      // the mock throws immediately on anything else, so an unreachable
      // GitHub would have failed this test just as loudly as a hang.
    } finally {
      fetchSpy.mockRestore();
      await server.close();
    }
  });
});
