/**
 * The authenticated participant market-state read: GET .../market/me.
 *
 * Positions are participant-private and durable (held in the same
 * server-side interaction snapshot every trade already persists through).
 * The anonymous GET .../market route strips them (readMarketState(null)) so
 * the public surface never leaks anyone's holdings; this route is the
 * authenticated sibling that returns the CALLING participant's own
 * positions only, under the exact same guest-cookie + CSRF + Origin
 * discipline every write already enforces — a private read is not exempt
 * from it just because it is a GET.
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
import {
  ReplayPremiereInteractions,
  type ReplayPremiereInteractionsSnapshot,
} from "../../../../src/server/replay-premiere/ReplayPremiereInteractions";
import { STARTING_BANKROLL } from "../../../../src/server/replay-premiere/wagering";

const ORIGIN = "https://beta.proxywar.xyz";
const premiereId = "prem_abcdefghijklmnop";

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

function buildInteractions(options?: {
  initialState?: ReplayPremiereInteractionsSnapshot;
}): ReplayPremiereInteractions {
  let randomValue = 1;
  return new ReplayPremiereInteractions({
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
    initialState: options?.initialState,
  });
}

/** The same guest-auth secret that would survive a real server restart. */
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
      resolveClientAddress: () => "127.0.0.1",
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
}

/** Drives the real POST /sessions handshake — no cookie in, a fresh guest out. */
async function createGuest(baseUrl: string): Promise<Guest> {
  const response = await fetch(`${baseUrl}/api/premieres/${premiereId}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
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
    session: { id: string };
  };
  return { cookie, csrfToken: body.csrfToken, sessionId: body.session.id };
}

async function placeOrder(
  baseUrl: string,
  guest: Guest,
  options: {
    seatId: string;
    amount: number;
    idempotencyKey: string;
  },
): Promise<{ trade: { chips: number }; market: { balance: number | null } }> {
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
  guest: Guest | null,
): Promise<{
  schemaVersion: 1;
  market: {
    positions: { seatId: string; shares: number }[] | null;
    balance: number | null;
  } | null;
} | null> {
  const response = await fetch(`${baseUrl}/api/premieres/${premiereId}/market/me`, {
    headers:
      guest === null
        ? { Origin: ORIGIN }
        : {
            Origin: ORIGIN,
            Cookie: guest.cookie,
            "X-CSRF-Token": guest.csrfToken,
          },
  });
  if (response.status !== 200) return null;
  return response.json();
}

describe("GET /api/premieres/:id/market/me", () => {
  it("returns the calling participant's own positions after a trade", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity(1);
    await withServer(interactions, security, async (baseUrl) => {
      const guestA = await createGuest(baseUrl);
      const order = await placeOrder(baseUrl, guestA, {
        seatId: "seat-1",
        amount: 100,
        idempotencyKey: "idem_order_00000000000001",
      });
      const body = await readMarketSelf(baseUrl, guestA);
      expect(body?.market?.positions).toEqual([
        expect.objectContaining({ seatId: "seat-1" }),
      ]);
      // The single money-authoritative balance: STARTING_BANKROLL debited
      // by exactly what the trade actually charged (order.market.balance
      // from the trade response itself confirms the two paths agree).
      expect(body?.market?.balance).toBe(STARTING_BANKROLL - order.trade.chips);
      expect(body?.market?.balance).toBe(order.market.balance);
    });
  });

  it("a participant who has never traded reads balance as STARTING_BANKROLL, not 0", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity(1);
    await withServer(interactions, security, async (baseUrl) => {
      const guestA = await createGuest(baseUrl);
      const body = await readMarketSelf(baseUrl, guestA);
      expect(body?.market?.positions).toEqual([]);
      expect(body?.market?.balance).toBe(STARTING_BANKROLL);
    });
  });

  it("anonymous GET /market keeps returning no positions, unchanged", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity(1);
    await withServer(interactions, security, async (baseUrl) => {
      const guestA = await createGuest(baseUrl);
      await placeOrder(baseUrl, guestA, {
        seatId: "seat-1",
        amount: 100,
        idempotencyKey: "idem_order_00000000000002",
      });
      const response = await fetch(`${baseUrl}/api/premieres/${premiereId}/market`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { market: { positions: unknown } };
      expect(body.market.positions).toBeNull();

      // A cookie-less, CSRF-less GET to /market/me itself is rejected outright
      // (401 — the same "guest cookie required" the write path enforces),
      // never silently degraded into the anonymous view.
      const anonymousSelf = await fetch(
        `${baseUrl}/api/premieres/${premiereId}/market/me`,
        { headers: { Origin: ORIGIN } },
      );
      expect(anonymousSelf.status).toBe(401);
    });
  });

  it("participant A cannot read participant B's positions, and vice versa", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity(1);
    await withServer(interactions, security, async (baseUrl) => {
      const guestA = await createGuest(baseUrl);
      const guestB = await createGuest(baseUrl);
      expect(guestA.cookie).not.toBe(guestB.cookie);

      const orderA = await placeOrder(baseUrl, guestA, {
        seatId: "seat-1",
        amount: 100,
        idempotencyKey: "idem_order_00000000000003",
      });
      const orderB = await placeOrder(baseUrl, guestB, {
        seatId: "SEAT0001",
        amount: 150,
        idempotencyKey: "idem_order_00000000000004",
      });

      const bodyA = await readMarketSelf(baseUrl, guestA);
      expect(bodyA?.market?.positions).toEqual([
        expect.objectContaining({ seatId: "seat-1" }),
      ]);
      const seatIdsForA = bodyA!.market!.positions!.map((p) => p.seatId);
      expect(seatIdsForA).not.toContain("SEAT0001");

      const bodyB = await readMarketSelf(baseUrl, guestB);
      expect(bodyB?.market?.positions).toEqual([
        expect.objectContaining({ seatId: "SEAT0001" }),
      ]);
      const seatIdsForB = bodyB!.market!.positions!.map((p) => p.seatId);
      expect(seatIdsForB).not.toContain("seat-1");

      // guestB's own (valid, signed) credentials never expose guestA's data
      // and vice versa — no cross-participant leak via a stolen/forged token
      // shape, only via legitimately owning that exact signed cookie.
      expect(seatIdsForA).not.toEqual(seatIdsForB);

      // Balances are per-participant too: A's spend never appears on B's
      // ledger line and vice versa, each independently STARTING_BANKROLL
      // minus exactly (and only) their own trade's actual chips.
      expect(bodyA?.market?.balance).toBe(STARTING_BANKROLL - orderA.trade.chips);
      expect(bodyB?.market?.balance).toBe(STARTING_BANKROLL - orderB.trade.chips);
      expect(bodyA?.market?.balance).not.toBe(bodyB?.market?.balance);
    });
  });

  it("a position AND balance survive a simulated cold reload (fresh interactions instance recovered from persisted state)", async () => {
    const security = buildSecurity(1);
    let guestA!: Guest;
    let balanceBeforeRestart!: number | null;

    // "Before restart": place the trade, capture exactly what the durable
    // snapshot looks like — this is the same state every mutate() already
    // persists, not a special path for this test.
    const before = buildInteractions();
    await withServer(before, security, async (baseUrl) => {
      guestA = await createGuest(baseUrl);
      const order = await placeOrder(baseUrl, guestA, {
        seatId: "seat-1",
        amount: 100,
        idempotencyKey: "idem_order_00000000000005",
      });
      balanceBeforeRestart = order.market.balance;
    });
    const persistedSnapshot = before.readState();
    expect(persistedSnapshot.market?.holdings[guestA.sessionId] ?? null).toBe(
      null,
    ); // sanity: holdings are keyed by participantId, not sessionId
    expect(persistedSnapshot.trades).toHaveLength(1);

    // "After restart": a BRAND NEW ReplayPremiereInteractions instance,
    // recovered purely from that persisted snapshot — same guest-auth
    // secret (config surviving a restart), completely different in-memory
    // object. The same signed cookie from before the "restart" must still
    // authenticate and see the position AND the exact balance — the bug
    // this test exists to catch is a client-local bankroll number that
    // silently resets to STARTING_BANKROLL on reload while the server
    // still holds the real, debited balance.
    const after = buildInteractions({ initialState: persistedSnapshot });
    await withServer(after, security, async (baseUrl) => {
      const body = await readMarketSelf(baseUrl, guestA);
      expect(body?.market?.positions).toEqual([
        expect.objectContaining({ seatId: "seat-1", shares: expect.any(Number) }),
      ]);
      expect(body?.market?.balance).toBe(balanceBeforeRestart);
      expect(body?.market?.balance).toBeLessThan(STARTING_BANKROLL);
    });
  });
});

describe("GET /api/premieres/:id/market/me origin fallback (real-browser GET semantics)", () => {
  // A real browser correctly omits `Origin` on a same-origin GET/HEAD
  // fetch (it's a forbidden header no page script can set, and the Fetch
  // spec only appends it there for non-GET/HEAD same-origin requests —
  // Origin is ALWAYS sent for a cross-origin fetch, any method, which the
  // strict-Origin-when-present branch below still covers). Reproduces the
  // exact wire-level shape Chrome sends, confirmed via CDP
  // Network.requestWillBeSentExtraInfo — Origin absent, Sec-Fetch-Site
  // present.
  it("a real-browser same-origin GET (no Origin, Sec-Fetch-Site: same-origin) is accepted", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity(1);
    await withServer(interactions, security, async (baseUrl) => {
      const guestA = await createGuest(baseUrl);
      await placeOrder(baseUrl, guestA, {
        seatId: "seat-1",
        amount: 100,
        idempotencyKey: "idem_order_00000000000006",
      });
      const response = await fetch(
        `${baseUrl}/api/premieres/${premiereId}/market/me`,
        {
          headers: {
            Cookie: guestA.cookie,
            "X-CSRF-Token": guestA.csrfToken,
            "Sec-Fetch-Site": "same-origin",
          },
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        market: { positions: { seatId: string }[] };
      };
      expect(body.market.positions).toEqual([
        expect.objectContaining({ seatId: "seat-1" }),
      ]);
    });
  });

  it("no Origin, no Sec-Fetch-Site, but a matching Referer is accepted (old-browser fallback)", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity(1);
    await withServer(interactions, security, async (baseUrl) => {
      const guestA = await createGuest(baseUrl);
      const response = await fetch(
        `${baseUrl}/api/premieres/${premiereId}/market/me`,
        {
          headers: {
            Cookie: guestA.cookie,
            "X-CSRF-Token": guestA.csrfToken,
            Referer: `${ORIGIN}/premiere/${premiereId}`,
          },
        },
      );
      expect(response.status).toBe(200);
    });
  });

  it("no Origin, no Sec-Fetch-Site, no Referer at all is rejected — no same-origin proof, never silently allowed", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity(1);
    await withServer(interactions, security, async (baseUrl) => {
      const guestA = await createGuest(baseUrl);
      const response = await fetch(
        `${baseUrl}/api/premieres/${premiereId}/market/me`,
        {
          headers: {
            Cookie: guestA.cookie,
            "X-CSRF-Token": guestA.csrfToken,
          },
        },
      );
      expect(response.status).toBe(403);
    });
  });

  it("no Origin, Sec-Fetch-Site: cross-site is rejected — the real cross-site GET this whole check exists to catch", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity(1);
    await withServer(interactions, security, async (baseUrl) => {
      const guestA = await createGuest(baseUrl);
      const response = await fetch(
        `${baseUrl}/api/premieres/${premiereId}/market/me`,
        {
          headers: {
            Cookie: guestA.cookie,
            "X-CSRF-Token": guestA.csrfToken,
            "Sec-Fetch-Site": "cross-site",
          },
        },
      );
      expect(response.status).toBe(403);
    });
  });

  it("an explicitly wrong Origin is still rejected, even with Sec-Fetch-Site: same-origin present — Origin, when sent, is never overridden by a weaker signal", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity(1);
    await withServer(interactions, security, async (baseUrl) => {
      const guestA = await createGuest(baseUrl);
      const response = await fetch(
        `${baseUrl}/api/premieres/${premiereId}/market/me`,
        {
          headers: {
            Cookie: guestA.cookie,
            "X-CSRF-Token": guestA.csrfToken,
            Origin: "https://evil.example.com",
            "Sec-Fetch-Site": "same-origin",
          },
        },
      );
      expect(response.status).toBe(403);
    });
  });

  it("writes still require Origin unconditionally — the GET relaxation never reaches submitMarketOrder", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity(1);
    await withServer(interactions, security, async (baseUrl) => {
      const guestA = await createGuest(baseUrl);
      const response = await fetch(
        `${baseUrl}/api/premieres/${premiereId}/market-orders`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: guestA.cookie,
            "X-CSRF-Token": guestA.csrfToken,
            "X-Idempotency-Key": "idem_order_00000000000007",
            "Sec-Fetch-Site": "same-origin",
          },
          body: JSON.stringify({
            sessionId: guestA.sessionId,
            seatId: "seat-1",
            side: "buy",
            sequence: 0,
            amount: 100,
            limitPrice: 100,
          }),
        },
      );
      expect(response.status).toBe(403);
    });
  });
});
