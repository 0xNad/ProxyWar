/**
 * The reconnect path: a participant who closes a tab (or crashes, or
 * re-clicks a shared link) mid-match, and again after the match has
 * settled. `sessionStorage` — where the client caches its session pointer
 * — is scoped per browsing context and does NOT survive a tab close, only
 * a same-tab reload. A genuinely new tab/window has no persisted pointer
 * at all: the client falls back to a cold `POST /sessions` carrying only
 * the durable, HttpOnly guest cookie and a brand-new idempotencyKey —
 * exactly what `openNewTab` below drives.
 *
 * Live-browser reproduction of this exact scenario (kill the whole Chrome
 * process, relaunch against the same profile — a harder case than a plain
 * tab close, since it also loses in-memory CDP/network state) found the
 * session layer itself sound: the cold `POST /sessions` call always
 * carried a valid `X-Idempotency-Key` (the client sets it unconditionally
 * in `postJson`, confirmed by direct `Network.requestWillBeSentExtraInfo`
 * inspection) and always converged on the participant's existing live
 * session. The one real failure mode found live was `remote_address_unavailable`
 * — the LOCAL-ONLY `CF-Connecting-IP` header (RUNBOOK §12: a stand-in for
 * the real Cloudflare tunnel, which attaches this header at the transport
 * layer on every request in production and cannot "go missing" the way a
 * page-level CDP header injection can after a reload) not being
 * re-applied to the reattached target — a test-harness artifact, not a
 * product bug. This test pins down the actual server-side contract so
 * that class of confusion can't recur: a cold reconnect, with correct
 * headers, must always converge on the same session with intact position
 * and bankroll, before AND after the market settles.
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
  STARTING_BANKROLL,
  SHARE_PAYOUT,
} from "../../../../src/server/replay-premiere/wagering";

const ORIGIN = "https://beta.proxywar.xyz";
const premiereId = "prem_abcdefghijklmnop";
const SEAT_WINNER = "seat-1";
const SEAT_LOSER = "SEAT0001";

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
        seatId: SEAT_WINNER,
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "alpha",
          declaredVersion: "1",
          manifestSha256: "1".repeat(64),
          contentSha256: "2".repeat(64),
        },
      },
      {
        seatId: SEAT_LOSER,
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
    // Deliberately small: a reconnect that (bug) minted a fresh session
    // record instead of converging would burn this cap fast and fail
    // loudly with a 429, not silently pass.
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
 * Simulates one "cold, brand-new tab/window" opening the premiere: a fresh
 * `POST /sessions` call with a fresh idempotencyKey (nothing persists
 * across a real tab close except the HttpOnly guest cookie) carrying
 * whatever guest cookie the caller already has (or none, for the very
 * first landing).
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
    cookie: setCookie !== null ? setCookie.split(";")[0] : existingCookie,
    csrfToken: body.csrfToken,
    sessionId: body.session.id,
  };
}

async function placeOrder(
  baseUrl: string,
  tab: TabOpen,
  options: { seatId: string; amount: number; idempotencyKey: string },
): Promise<{ trade: { chips: number; shares: number } }> {
  const response = await fetch(
    `${baseUrl}/api/premieres/${premiereId}/market-orders`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: tab.cookie!,
        "X-CSRF-Token": tab.csrfToken!,
        "X-Idempotency-Key": options.idempotencyKey,
      },
      body: JSON.stringify({
        sessionId: tab.sessionId,
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
  tab: TabOpen,
): Promise<{
  market: {
    status: string;
    positions:
      | { seatId: string; shares: number; costBasis: number; currentValue: number; unrealizedPnl: number }[]
      | null;
    balance: number | null;
  } | null;
}> {
  const response = await fetch(`${baseUrl}/api/premieres/${premiereId}/market/me`, {
    headers: { Origin: ORIGIN, Cookie: tab.cookie!, "X-CSRF-Token": tab.csrfToken! },
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("reconnecting to a premiere the client already knows about", () => {
  it("closing the tab mid-match and re-clicking the link converges on the same session with position and bankroll intact", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity();
    await withServer(interactions, security, async (baseUrl) => {
      const firstTab = await openNewTab(baseUrl, null);
      expect(firstTab.status).toBe(201);
      const guestCookie = firstTab.cookie!;

      const buy = await placeOrder(baseUrl, firstTab, {
        seatId: SEAT_WINNER,
        amount: 150,
        idempotencyKey: "idem_trade_close_001",
      });
      expect(buy.trade.shares).toBeGreaterThan(0);
      const selfBeforeClose = await readMarketSelf(baseUrl, firstTab);
      expect(selfBeforeClose.market!.balance).toBe(
        STARTING_BANKROLL - buy.trade.chips,
      );

      // Tab closed (sessionStorage lost); the shared link is re-clicked in
      // a genuinely new browsing context — same guest cookie (HttpOnly,
      // survives), fresh idempotencyKey (never seen this premiere before
      // from this context's point of view).
      const reconnected = await openNewTab(baseUrl, guestCookie);
      expect(reconnected.status).toBe(201);
      expect(reconnected.sessionId).toBe(firstTab.sessionId);
      // Never more than one live session record for this participant —
      // the reuse check converged, it didn't mint a second record.
      expect(interactions.readState().sessions).toHaveLength(1);

      const selfAfterReconnect = await readMarketSelf(baseUrl, reconnected);
      expect(selfAfterReconnect.market!.balance).toBe(
        selfBeforeClose.market!.balance,
      );
      expect(selfAfterReconnect.market!.positions).toEqual(
        selfBeforeClose.market!.positions,
      );
    });
  });

  it("reconnecting AFTER the market has settled still converges on the same session and shows the real, final payout — never a rejection", async () => {
    const interactions = buildInteractions();
    const security = buildSecurity();
    await withServer(interactions, security, async (baseUrl) => {
      const firstTab = await openNewTab(baseUrl, null);
      expect(firstTab.status).toBe(201);
      const guestCookie = firstTab.cookie!;

      const buy = await placeOrder(baseUrl, firstTab, {
        seatId: SEAT_WINNER,
        amount: 200,
        idempotencyKey: "idem_trade_win_001",
      });
      expect(buy.trade.shares).toBeGreaterThan(0);

      // Settle the market with the seat this participant holds as the
      // winner — mirrors what `applyReplayPremierePredictionResolutionTransition`
      // does at reveal, restored back into the live interactions instance
      // exactly like a real settlement would leave it.
      const snapshot = interactions.readState();
      const market = snapshot.market!;
      const ledger = ReplayPremiereLedger.restore({
        balances: market.ledgerBalances,
        granted: market.ledgerGranted,
      });
      const settled = settleMarket({ market, ledger, winnerSeatId: SEAT_WINNER });
      const ledgerSnapshot = ledger.snapshot();
      snapshot.market = {
        ...settled,
        ledgerBalances: ledgerSnapshot.balances,
        ledgerGranted: ledgerSnapshot.granted,
      };
      interactions.restoreState(snapshot);
      expect(interactions.readState().market!.status).toBe("settled");

      // The tab was never reloaded through settlement (crash, or simply
      // closed and re-opened well after the match ended) — a genuinely
      // cold reconnect against an already-settled market.
      const reconnected = await openNewTab(baseUrl, guestCookie);
      expect(reconnected.status).toBe(201);
      expect(reconnected.sessionId).toBe(firstTab.sessionId);
      expect(interactions.readState().sessions).toHaveLength(1);

      const self = await readMarketSelf(baseUrl, reconnected);
      expect(self.market!.status).toBe("settled");
      expect(self.market!.positions).toEqual([
        {
          seatId: SEAT_WINNER,
          shares: buy.trade.shares,
          costBasis: buy.trade.chips,
          currentValue: buy.trade.shares * SHARE_PAYOUT,
          unrealizedPnl: buy.trade.shares * SHARE_PAYOUT - buy.trade.chips,
        },
      ]);
      // The real payout landed in the participant's own ledger account —
      // readable through the reconnected session, not lost behind it.
      expect(self.market!.balance).toBe(
        STARTING_BANKROLL - buy.trade.chips + buy.trade.shares * SHARE_PAYOUT,
      );
    });
  });
});
