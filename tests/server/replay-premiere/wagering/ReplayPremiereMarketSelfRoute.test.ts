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
): Promise<void> {
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
}

async function readMarketSelf(
  baseUrl: string,
  guest: Guest | null,
): Promise<{
  schemaVersion: 1;
  market: { positions: { seatId: string; shares: number }[] | null } | null;
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
      await placeOrder(baseUrl, guestA, {
        seatId: "seat-1",
        amount: 100,
        idempotencyKey: "idem_order_00000000000001",
      });
      const body = await readMarketSelf(baseUrl, guestA);
      expect(body?.market?.positions).toEqual([
        expect.objectContaining({ seatId: "seat-1" }),
      ]);
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

      await placeOrder(baseUrl, guestA, {
        seatId: "seat-1",
        amount: 100,
        idempotencyKey: "idem_order_00000000000003",
      });
      await placeOrder(baseUrl, guestB, {
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
    });
  });

  it("a position survives a simulated cold reload (fresh interactions instance recovered from persisted state)", async () => {
    const security = buildSecurity(1);
    let guestA!: Guest;
    let persistedSnapshot!: ReplayPremiereInteractionsSnapshot;

    // "Before restart": place the trade, capture exactly what the durable
    // snapshot looks like — this is the same state every mutate() already
    // persists, not a special path for this test.
    const before = buildInteractions();
    await withServer(before, security, async (baseUrl) => {
      guestA = await createGuest(baseUrl);
      await placeOrder(baseUrl, guestA, {
        seatId: "seat-1",
        amount: 100,
        idempotencyKey: "idem_order_00000000000005",
      });
    });
    persistedSnapshot = before.readState();
    expect(persistedSnapshot.market?.holdings[guestA.sessionId] ?? null).toBe(
      null,
    ); // sanity: holdings are keyed by participantId, not sessionId
    expect(persistedSnapshot.trades).toHaveLength(1);

    // "After restart": a BRAND NEW ReplayPremiereInteractions instance,
    // recovered purely from that persisted snapshot — same guest-auth
    // secret (config surviving a restart), completely different in-memory
    // object. The same signed cookie from before the "restart" must still
    // authenticate and see the position.
    const after = buildInteractions({ initialState: persistedSnapshot });
    await withServer(after, security, async (baseUrl) => {
      const body = await readMarketSelf(baseUrl, guestA);
      expect(body?.market?.positions).toEqual([
        expect.objectContaining({ seatId: "seat-1", shares: expect.any(Number) }),
      ]);
    });
  });
});
