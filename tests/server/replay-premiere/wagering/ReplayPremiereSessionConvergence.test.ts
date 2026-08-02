/**
 * Round-1's most damning reproduction: a participant with a valid, signed
 * guest cookie opens a brand-new tab (fresh page load — no client-side
 * storage carries over, since `sessionStorage` is scoped per browsing
 * context) and gets stuck, because the OLD `createViewerSession` minted a
 * genuinely new session record on every call whose `idempotencyKey` it
 * hadn't seen before — and a fresh tab has no way to know a prior tab's
 * key. Ten tabs meant ten session records, burning a small per-participant
 * allowance and leaving no path back to the session any of the OTHER tabs
 * already held.
 *
 * The fix is server-side, not a client storage trick: `createViewerSession`
 * now returns the participant's existing LIVE session whenever one exists,
 * independent of `idempotencyKey`. Every tab and every reload for the same
 * guest cookie converges on the one session a real participant actually
 * has. `sessionStorage` can still exist client-side as a fast local hint,
 * but it no longer decides whether resumption is possible.
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
    // Small ceiling, deliberately: if convergence didn't work, ten tabs
    // would blow straight through this and the test would fail loudly
    // with a 429 instead of silently passing.
    limits: {
      maxSessionsPerParticipant: 2,
      maxSessionCreatesPerParticipantPerMinute: 2,
    },
  });
}

function buildSecurity(): ReplayPremiereGuestSecurity {
  let counter = 1;
  return new ReplayPremiereGuestSecurity({
    hmacKey: new Uint8Array(32).fill(9),
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

interface TabOpen {
  status: number;
  cookie: string | null;
  csrfToken: string | null;
  sessionId: string | null;
}

/**
 * Simulates one "cold, brand-new tab" opening the premiere: a fresh
 * `POST /sessions` call with its own freshly generated idempotencyKey (a
 * real new tab has no way to know any prior tab's key — nothing persists
 * across browsing contexts) but carrying whatever guest cookie the caller
 * already has (or none, for the very first tab).
 */
async function openNewTab(
  baseUrl: string,
  existingCookie: string | null,
): Promise<TabOpen> {
  const response = await fetch(`${baseUrl}/api/premieres/${premiereId}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(existingCookie === null ? {} : { Cookie: existingCookie }),
      "X-Idempotency-Key": `idem_tab_${Math.random().toString(36).slice(2).padEnd(20, "0")}`,
    },
    body: JSON.stringify({ visible: true, observedSequence: -1 }),
  });
  if (response.status !== 201) {
    return { status: response.status, cookie: null, csrfToken: null, sessionId: null };
  }
  const setCookie = response.headers.get("set-cookie");
  const body = (await response.json()) as {
    csrfToken: string;
    session: { id: string };
  };
  return {
    status: response.status,
    // A tab that already had a cookie keeps using it — the server only
    // issues Set-Cookie for a genuinely new guest, never re-issues one for
    // an already-authenticated request.
    cookie: setCookie !== null ? setCookie.split(";")[0] : existingCookie,
    csrfToken: body.csrfToken,
    sessionId: body.session.id,
  };
}

describe("session-create convergence: ten tabs in sequence, one live session, no lockout", () => {
  it("ten new tabs opened in sequence against one live premiere with the same guest cookie all reach a tradeable market, and the session-record count never grows past one", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity();
    await withServer(interactions, security, async (baseUrl) => {
      // Tab 1: a genuinely new guest — the only call that mints both a
      // cookie and a session record.
      const firstTab = await openNewTab(baseUrl, null);
      expect(firstTab.status).toBe(201);
      expect(firstTab.cookie).not.toBeNull();
      const guestCookie = firstTab.cookie!;
      const sessionIds = new Set<string | null>([firstTab.sessionId]);

      // Tabs 2 through 10: each is a COLD load — same guest cookie (the
      // one thing that persists across tabs/reloads: a real HttpOnly
      // cookie, unlike sessionStorage), but a fresh idempotencyKey every
      // single time, exactly like a brand-new browsing context that has
      // never seen this premiere's session pointer before.
      let lastTab: TabOpen = firstTab;
      for (let tab = 2; tab <= 10; tab += 1) {
        lastTab = await openNewTab(baseUrl, guestCookie);
        expect(lastTab.status).toBe(201);
        sessionIds.add(lastTab.sessionId);
      }

      // The core property: every tab converged on the exact same session
      // id — not ten distinct records for one participant.
      expect(sessionIds.size).toBe(1);
      expect(interactions.readState().sessions).toHaveLength(1);

      // And the tenth tab's own credentials (the LAST cold load, the one
      // that would have been furthest from any in-memory client state)
      // actually reach a tradeable market — this is not just a session
      // pointer surviving, it is genuinely usable to trade.
      const tradeResponse = await fetch(
        `${baseUrl}/api/premieres/${premiereId}/market-orders`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: ORIGIN,
            Cookie: lastTab.cookie!,
            "X-CSRF-Token": lastTab.csrfToken!,
            "X-Idempotency-Key": "idem_trade_00000000000001",
          },
          body: JSON.stringify({
            sessionId: lastTab.sessionId,
            seatId: "seat-1",
            side: "buy",
            sequence: 0,
            amount: 100,
            limitPrice: 100,
          }),
        },
      );
      expect(tradeResponse.status).toBe(200);
      const tradeBody = (await tradeResponse.json()) as {
        trade: { shares: number };
      };
      expect(tradeBody.trade.shares).toBeGreaterThan(0);

      // Still exactly one session record after trading, too.
      expect(interactions.readState().sessions).toHaveLength(1);
    });
  });
});
