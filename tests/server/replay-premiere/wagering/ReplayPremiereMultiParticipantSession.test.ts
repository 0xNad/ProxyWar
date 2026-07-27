/**
 * The participant-session path with TWO genuinely distinct participants
 * trading one live premiere's book at once — the scenario every prior
 * verification round only ever exercised with a single trader.
 *
 * Live-browser reproduction (two real Chrome profiles, distinct
 * `CF-Connecting-IP`, distinct guest cookies, one shared `/bet/<id>`) found
 * NO bug: both participants joined, both traded, both saw each other's
 * price impact, bankrolls/positions stayed fully isolated. This test pins
 * that down at the HTTP layer so it can't regress silently. It also
 * exercises the specific failure mode a prior report suspected — the
 * `createViewerSession` reuse check (`existingLiveSession`, keyed on
 * `participantId`) incorrectly matching participant B against participant
 * A's session — by creating two sessions back-to-back AND concurrently, and
 * proves settlement crediting (`settleMarket`, keyed on `market.holdings`'
 * participantId keys) never conflates the two participants' payouts either.
 */
import express from "express";
import http from "node:http";
import {
  createReplayPremiereRouter,
  ReplayPremiereHttpRegistry,
  type ReplayPremiereHttpTarget,
  type ReplayPremiereRuntimeReader,
} from "../../../../src/server/replay-premiere/ReplayPremiereHttp";
import { ReplayPremiereGuestSecurity } from "../../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";
import { ReplayPremiereInteractions } from "../../../../src/server/replay-premiere/ReplayPremiereInteractions";
import {
  ReplayPremiereLedger,
  settleMarket,
  positionsFor,
  STARTING_BANKROLL,
  SHARE_PAYOUT,
} from "../../../../src/server/replay-premiere/wagering";

const ORIGIN = "https://beta.proxywar.xyz";
const premiereId = "prem_abcdefghijklmnop";
const SEAT_A = "seat-1";
const SEAT_B = "SEAT0001";

function fakeRuntime(premiereId: string): ReplayPremiereRuntimeReader {
  return {
    premiereId,
    readLifecycleState: () => "playing",
    readBootstrap: () => {
      throw new Error("unused in this test");
    },
    readManifest: () => {
      throw new Error("unused in this test");
    },
    readChunk: () => null,
    readReveal: () => null,
    readReleasedContext: () => null,
    readLiveVisibleSequence: () => 1_000_000,
    readLiveProjection: () => [],
  };
}

const ADMIT_ANONYMOUS_WRITE = (): undefined => undefined;

function buildInteractions(): ReplayPremiereInteractions {
  let randomValue = 1;
  return new ReplayPremiereInteractions({
    premiereId,
    checkpointDescriptors: [
      { id: "cp_first0001", sequence: 35 },
      { id: "cp_second001", sequence: 65 },
    ],
    seats: [
      {
        seatId: SEAT_A,
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "alpha",
          declaredVersion: "1",
          manifestSha256: "1".repeat(64),
          contentSha256: "2".repeat(64),
        },
      },
      {
        seatId: SEAT_B,
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "beta",
          declaredVersion: "1",
          manifestSha256: "3".repeat(64),
          contentSha256: "4".repeat(64),
        },
      },
    ],
    getPremiereState: () => "playing",
    getReleasedContext: () => null,
    getLiveVisibleSequence: () => 1_000_000,
    persistence: { async persist() {} },
    signAttribution: ({ shareId }) => `signed-${shareId}`,
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${premiereId}`,
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    randomBytes: (size) => {
      const bytes = new Uint8Array(size).fill(randomValue);
      randomValue += 1;
      return bytes;
    },
    wageringEnabled: true,
    admitAnonymousWrite: ADMIT_ANONYMOUS_WRITE,
    limits: {
      maxSessionsPerParticipant: 2,
      maxSessionCreatesPerParticipantPerMinute: 2,
    },
  });
}

/** Same guest-auth secret across both calls, distinct random source per guest. */
const HMAC_KEY = new Uint8Array(32).fill(9);

function buildSecurity(randomSeed: number): ReplayPremiereGuestSecurity {
  let counter = randomSeed;
  return new ReplayPremiereGuestSecurity({
    hmacKey: HMAC_KEY,
    expectedOrigin: ORIGIN,
    production: true,
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    randomBytes: (size) => new Uint8Array(size).fill(counter++),
  });
}

async function withServer(
  interactions: ReplayPremiereInteractions,
  security: ReplayPremiereGuestSecurity,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const runtime = fakeRuntime(premiereId);
  const target: ReplayPremiereHttpTarget = { runtime, interactions };
  const registry = new ReplayPremiereHttpRegistry(ADMIT_ANONYMOUS_WRITE);
  registry.register(target);
  const app = express();
  app.use(
    createReplayPremiereRouter({
      registry,
      security,
      // Distinct source addresses, exactly like distinct CF-Connecting-IP
      // values from two real browsers behind the trusted proxy boundary —
      // resolved per-request from a header the test sets explicitly below,
      // never from a shared default.
      resolveClientAddress: (request) => {
        const forwarded = request.headers["x-test-remote-addr"];
        return typeof forwarded === "string" ? forwarded : "127.0.0.1";
      },
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind an address");
  }
  try {
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

interface Guest {
  cookie: string;
  csrfToken: string;
  sessionId: string;
  participantId: string;
}

/** Drives the real POST /sessions handshake — no cookie in, a fresh guest out. */
async function createGuest(
  baseUrl: string,
  remoteAddr: string,
): Promise<Guest> {
  const response = await fetch(`${baseUrl}/api/premieres/${premiereId}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "X-Test-Remote-Addr": remoteAddr,
      "X-Idempotency-Key": `idem_session_${Math.random().toString(36).slice(2).padEnd(16, "0")}`,
    },
    body: JSON.stringify({ visible: true, observedSequence: -1 }),
  });
  expect(response.status).toBe(201);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).not.toBeNull();
  const cookie = setCookie!.split(";")[0];
  const body = (await response.json()) as {
    csrfToken: string;
    session: { id: string; participantId: string };
  };
  return {
    cookie,
    csrfToken: body.csrfToken,
    sessionId: body.session.id,
    participantId: body.session.participantId,
  };
}

async function placeOrder(
  baseUrl: string,
  guest: Guest,
  options: { seatId: string; amount: number; idempotencyKey: string },
): Promise<{ trade: { chips: number; shares: number }; market: { balance: number | null } }> {
  const response = await fetch(
    `${baseUrl}/api/premieres/${premiereId}/market-orders`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: guest.cookie,
        "X-CSRF-Token": guest.csrfToken,
        "X-Idempotency-Key": options.idempotencyKey,
      },
      body: JSON.stringify({
        sessionId: guest.sessionId,
        seatId: options.seatId,
        side: "buy",
        sequence: 0,
        amount: options.amount,
        limitPrice: 100,
      }),
    },
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function readMarketSelf(
  baseUrl: string,
  guest: Guest,
): Promise<{
  market: {
    positions:
      | { seatId: string; shares: number; costBasis: number; currentValue: number; unrealizedPnl: number }[]
      | null;
    balance: number | null;
    prices: number[];
  } | null;
}> {
  const response = await fetch(`${baseUrl}/api/premieres/${premiereId}/market/me`, {
    headers: {
      Origin: ORIGIN,
      Cookie: guest.cookie,
      "X-CSRF-Token": guest.csrfToken,
    },
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("two distinct participants trading one live premiere book", () => {
  it("get separate sessions/bankrolls/positions off distinct guest cookies, distinct source addresses, sequentially", async () => {
    const interactions = buildInteractions();
    // A single server-side security instance, exactly like production (one
    // ReplayPremiereGuestSecurity per process) — the two guests below each
    // draw their own fresh random bytes from it via independent
    // POST /sessions calls, exactly like two real, separate browsers
    // hitting the same server. Distinct participantId identity comes from
    // that per-call randomness, never from a per-test security instance.
    const security = buildSecurity(101);
    await withServer(interactions, security, async (baseUrl) => {
      // Participant A and B: distinct cookie jars (no cookie shared between
      // them, exactly like two separate browser profiles), distinct source
      // addresses (like distinct CF-Connecting-IP values).
      const guestA = await createGuest(baseUrl, "203.0.113.51");
      const guestB = await createGuest(baseUrl, "203.0.113.52");

      // The core identity property: two genuinely distinct sessions AND
      // participants, not one participant's session handed back twice.
      expect(guestA.sessionId).not.toBe(guestB.sessionId);
      expect(guestA.participantId).not.toBe(guestB.participantId);
      expect(interactions.readState().sessions).toHaveLength(2);

      // A buys into seat A, B buys into the OTHER seat — different amounts
      // so any accidental swap or merge is immediately visible in the
      // numbers, not just in which seatId shows up.
      const tradeA = await placeOrder(baseUrl, guestA, {
        seatId: SEAT_A,
        amount: 200,
        idempotencyKey: "idem_trade_a_001",
      });
      const tradeB = await placeOrder(baseUrl, guestB, {
        seatId: SEAT_B,
        amount: 90,
        idempotencyKey: "idem_trade_b_001",
      });
      expect(tradeA.trade.shares).toBeGreaterThan(0);
      expect(tradeB.trade.shares).toBeGreaterThan(0);
      // Two different budgets against two different seats of a symmetric
      // starting book must fill for two different chip amounts — if the
      // server had merged the two into one participant's ledger this
      // would either double-count or throw insufficient-funds instead.
      expect(tradeA.trade.chips).not.toBe(tradeB.trade.chips);

      // Each participant's own private read shows ONLY their own position
      // and their own bankroll debited by exactly their own spend — never
      // the other participant's holdings.
      const selfA = await readMarketSelf(baseUrl, guestA);
      const selfB = await readMarketSelf(baseUrl, guestB);
      expect(selfA.market!.positions).toHaveLength(1);
      expect(selfA.market!.positions![0]).toMatchObject({
        seatId: SEAT_A,
        shares: tradeA.trade.shares,
        costBasis: tradeA.trade.chips,
      });
      expect(selfB.market!.positions).toHaveLength(1);
      expect(selfB.market!.positions![0]).toMatchObject({
        seatId: SEAT_B,
        shares: tradeB.trade.shares,
        costBasis: tradeB.trade.chips,
      });
      expect(selfA.market!.balance).toBe(STARTING_BANKROLL - tradeA.trade.chips);
      expect(selfB.market!.balance).toBe(STARTING_BANKROLL - tradeB.trade.chips);

      // But the PRICES both participants read are identical and reflect
      // BOTH orders — one shared book, price impact visible cross-
      // participant, exactly as verified live in real browsers.
      expect(selfA.market!.prices).toEqual(selfB.market!.prices);
      const sumOfPrices = selfA.market!.prices.reduce((a, b) => a + b, 0);
      expect(sumOfPrices).toBeCloseTo(100, 5);
      // Seat A's price moved up from A's buy net of B's buy on the other
      // seat pulling every OTHER seat's price down a little too — the
      // combined book, not either participant's private view of it.
      expect(selfA.market!.prices[0]).toBeGreaterThan(50);

      // Settlement crediting: `settleMarket` iterates `market.holdings`
      // keyed by participantId. Prove it pays A and B independently and
      // correctly when seat A wins — this is the same identity-keying
      // class as the session-reuse bug this test suite is guarding
      // against, just on the payout path instead of the join path.
      const snapshot = interactions.readState();
      const market = snapshot.market!;
      const ledger = ReplayPremiereLedger.restore({
        balances: market.ledgerBalances,
        granted: market.ledgerGranted,
      });
      const settled = settleMarket({ market, ledger, winnerSeatId: SEAT_A });
      const finalA = positionsFor(settled, guestA.participantId);
      const finalB = positionsFor(settled, guestB.participantId);
      expect(finalA).toEqual([
        {
          seatId: SEAT_A,
          shares: tradeA.trade.shares,
          costBasis: tradeA.trade.chips,
          currentValue: tradeA.trade.shares * SHARE_PAYOUT,
          unrealizedPnl: tradeA.trade.shares * SHARE_PAYOUT - tradeA.trade.chips,
        },
      ]);
      expect(finalB).toEqual([
        {
          seatId: SEAT_B,
          shares: tradeB.trade.shares,
          costBasis: tradeB.trade.chips,
          currentValue: 0,
          unrealizedPnl: -tradeB.trade.chips,
        },
      ]);
      // The ledger balance itself, read by each participant's own
      // participantId account — never swapped.
      expect(ledger.balanceOf(guestA.participantId)).toBe(
        STARTING_BANKROLL - tradeA.trade.chips + tradeA.trade.shares * SHARE_PAYOUT,
      );
      expect(ledger.balanceOf(guestB.participantId)).toBe(
        STARTING_BANKROLL - tradeB.trade.chips,
      );
    });
  });

  it("stay distinct even when two brand-new participants POST /sessions concurrently (no race in the reuse check)", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity(201);
    await withServer(interactions, security, async (baseUrl) => {
      const [guestA, guestB] = await Promise.all([
        createGuest(baseUrl, "203.0.113.61"),
        createGuest(baseUrl, "203.0.113.62"),
      ]);
      expect(guestA.sessionId).not.toBe(guestB.sessionId);
      expect(guestA.participantId).not.toBe(guestB.participantId);
      expect(interactions.readState().sessions).toHaveLength(2);
    });
  });
});
