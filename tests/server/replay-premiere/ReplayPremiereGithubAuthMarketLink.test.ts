/**
 * Closes the loop between `ReplayPremiereGithubAuth`'s identity-link flow
 * and the LIVE market: linking canonicalises identity, but the trade path
 * uses whatever guest cookie a browser holds — these tests prove the
 * canonical-cookie hand-off plus the atomic retire/release guard actually
 * prevent the Sybil hole (N browsers, N bankrolls, one leaderboard entry)
 * end to end, against a REAL `ReplayPremiereInteractions` market, not a
 * stub.
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
  ReplayPremiereInteractions,
  type ReplayPremiereInteractionsSnapshot,
  type ReplayPremiereSettlementPointsRecorder,
} from "../../../src/server/replay-premiere/ReplayPremiereInteractions";
import {
  pointsMergerFor,
  ReplayPremiereIdentityLinkStore,
} from "../../../src/server/replay-premiere/points/ReplayPremiereIdentityLinkStore";
import { ReplayPremierePointsLedger } from "../../../src/server/replay-premiere/points/ReplayPremierePointsLedger";
import { ReplayPremiereGuestSecurity } from "../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";

const origin = "https://bet.example.test";
const premiereId = "prem_abcdefghijklmnop";
const guestA = `guest_${"a".repeat(32)}`;
const guestB = `guest_${"b".repeat(32)}`;

function interactionsHarness(overrides?: {
  wageringEnabled?: boolean;
  initialState?: ReplayPremiereInteractionsSnapshot;
  pointsLedger?: ReplayPremiereSettlementPointsRecorder;
}) {
  let premiereState: PremiereState = "playing";
  let requestValue = 1;
  let nowMs = Date.parse("2026-07-20T12:00:00.000Z");
  const interactions = new ReplayPremiereInteractions({
    premiereId,
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
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${premiereId}`,
    now: () => new Date(nowMs),
    initialState: overrides?.initialState,
    wageringEnabled: overrides?.wageringEnabled ?? true,
    pointsLedger: overrides?.pointsLedger,
    admitAnonymousWrite: () => undefined,
  });
  return {
    interactions,
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

  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(realTemporaryRoot, "github-market-link-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function buildServer(
    h: Harness,
    oauthState: StubOAuthState,
  ): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const ledger = await ReplayPremierePointsLedger.open(
      path.join(root, "points-ledger"),
    );
    const identityLinkStore = await ReplayPremiereIdentityLinkStore.open(
      path.join(root, "identity-links"),
      pointsMergerFor(ledger),
    );
    const security = new ReplayPremiereGuestSecurity(guestSecurityOptions);
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
    };
  }

  it("ACCEPTANCE: two browsers linked to one GitHub id share one bankroll and one position set — buy in A, sell in B", async () => {
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
    const { baseUrl, close } = await buildServer(h, oauthState);
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
      const cookiesAfterLinkB = setCookiePairs(linkB.headers);
      const canonicalParticipantForB = participantIdOf(
        cookiesAfterLinkB.proxywar_premiere_guest,
      );
      // The Sybil fix, verified: browser B's next request trades as A.
      expect(canonicalParticipantForB).toBe(participantA);

      // Buy in browser A.
      const sessionA = await createSession(h, participantA);
      const buy = await order(h, {
        participantId: participantA,
        sessionId: sessionA.id,
        seatId: "seat-1",
        side: "buy",
        amount: 200,
        limitPrice: 100,
      });
      expect(buy.trade.shares).toBeGreaterThan(0);

      // Browser B — now trading as canonicalParticipantForB, i.e. A — must
      // see that exact position and be able to sell it.
      const marketViewFromB = h.interactions.readMarketState(
        canonicalParticipantForB,
      );
      const heldByB = marketViewFromB?.positions?.[0]?.shares ?? 0;
      expect(heldByB).toBe(buy.trade.shares);

      const sessionB = await createSession(h, canonicalParticipantForB);
      const sell = await order(h, {
        participantId: canonicalParticipantForB,
        sessionId: sessionB.id,
        seatId: "seat-1",
        side: "sell",
        amount: heldByB,
        limitPrice: 0,
      });
      expect(sell.trade.side).toBe("sell");
      expect(sell.trade.shares).toBe(heldByB);
      const marketViewAfterSell = h.interactions.readMarketState(participantA);
      expect(marketViewAfterSell?.positions?.[0]?.shares ?? 0).toBe(0);

      // Original browser B's OWN old id was retired the instant it linked
      // (no participation, so it was released — but it is no longer the
      // id this browser presents, since it already holds the canonical
      // cookie). Confirm the original id never independently accumulated
      // any ledger state of its own.
      const originalBView = h.interactions.readMarketState(
        originalParticipantB,
      );
      expect(originalBView?.balance).toBe(1_000); // STARTING_BANKROLL, never granted
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
    const { baseUrl, close } = await buildServer(h, oauthState);
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
    const { baseUrl, close } = await buildServer(h, oauthState);
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
    await buildServer(h, oauthState).then(({ close }) => close());

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
