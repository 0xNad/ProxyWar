/**
 * P1 t3-01/t3-02 (pass-8 QA): after a market voids, the origin process
 * behind `bet.proxywar.xyz` restarts and mints a brand-new random
 * premiereId for the next cycle — unconditionally, void or not
 * (`cycle-premiere.sh`'s `restart_origin`; confirmed live, not inferred).
 * An already-joined betting page's own poll then 404s
 * `PREMIERE_UNAVAILABLE` against its own (now-gone) premiereId forever,
 * stuck showing the voided match's stale odds/positions while the
 * world map has already moved on. Two things are covered here:
 *
 * 1. `BettingPremiereMarketController.onPremiereGone` fires on exactly
 *    the unambiguous "this premiere is gone for good" signal (404 +
 *    `PREMIERE_UNAVAILABLE`), never on a transient use of the same
 *    public error code (503, "try again later" — `TradeTicket.ts`'s own
 *    doc) or an unrelated failure.
 * 2. `resolveCurrentBettingPremiereId` against a REAL local HTTP fixture
 *    (port 8815, simulating the server's own `GET /bet` -> 302
 *    `/bet/<currentId>` redirect the "Go to the live market" CTA
 *    already relies on) — proving the id-reuse-restart recovery signal
 *    resolves correctly end-to-end, not just against a mock.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PremiereBettingOverlay } from "../../../../../src/client/prediction/wagering/page/BettingOverlay";
import {
  BettingPremiereMarketController,
  resolveCurrentBettingPremiereId,
} from "../../../../../src/client/prediction/wagering/page/BettingPremierePage";
import {
  ReplayPremiereServiceError,
  type ReplayPremiereRuntimeController,
  type ReplayPremiereServiceMarketStateResponse,
} from "../../../../../src/client/ReplayPremiereRuntime";

const FIXTURE_PORT = 8815;

function stubOverlay(): PremiereBettingOverlay {
  return {} as PremiereBettingOverlay;
}

function stubRuntime(
  readMarketSelf: () => Promise<ReplayPremiereServiceMarketStateResponse>,
): ReplayPremiereRuntimeController {
  return {
    readMarketSelf,
  } as unknown as ReplayPremiereRuntimeController;
}

describe("BettingPremiereMarketController.onPremiereGone", () => {
  let controller: BettingPremiereMarketController;

  afterEach(() => {
    controller.dispose();
  });

  it("fires when the poll 404s with the catalog's own PREMIERE_UNAVAILABLE code", async () => {
    const runtime = stubRuntime(() =>
      Promise.reject(
        new ReplayPremiereServiceError(
          "request_rejected",
          404,
          "PREMIERE_UNAVAILABLE",
        ),
      ),
    );
    controller = new BettingPremiereMarketController(
      runtime,
      "prem_deadaaaaaaaaaaaaaaaa",
    );
    controller.attachOverlay(stubOverlay());
    const onPremiereGone = vi.fn();
    controller.onPremiereGone = onPremiereGone;

    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onPremiereGone).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire for the same public code on a transient 503 (market temporarily unavailable, not gone)", async () => {
    const runtime = stubRuntime(() =>
      Promise.reject(
        new ReplayPremiereServiceError(
          "request_rejected",
          503,
          "PREMIERE_UNAVAILABLE",
        ),
      ),
    );
    controller = new BettingPremiereMarketController(
      runtime,
      "prem_liveaaaaaaaaaaaaaaaa",
    );
    const overlay = stubOverlay();
    controller.attachOverlay(overlay);
    const onPremiereGone = vi.fn();
    controller.onPremiereGone = onPremiereGone;

    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onPremiereGone).not.toHaveBeenCalled();
    expect(overlay.marketLoadError).not.toBeNull();
  });

  it("does NOT fire for an unrelated 404 (e.g. a genuinely missing sub-route, not PREMIERE_UNAVAILABLE)", async () => {
    const runtime = stubRuntime(() =>
      Promise.reject(
        new ReplayPremiereServiceError("request_rejected", 404, null),
      ),
    );
    controller = new BettingPremiereMarketController(
      runtime,
      "prem_otheraaaaaaaaaaaaaaa",
    );
    controller.attachOverlay(stubOverlay());
    const onPremiereGone = vi.fn();
    controller.onPremiereGone = onPremiereGone;

    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onPremiereGone).not.toHaveBeenCalled();
  });
});

describe("resolveCurrentBettingPremiereId against a real local fixture", () => {
  let server: http.Server;
  let baseUrl: string;
  let currentPremiereId = "prem_freshaaaaaaaaaaaaaaa";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/bet") {
        res.writeHead(302, { Location: `/bet/${currentPremiereId}` });
        res.end();
        return;
      }
      if (req.url?.startsWith("/bet/")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!doctype html><title>fixture</title>");
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
    });
    await new Promise<void>((resolve) => {
      server.listen(FIXTURE_PORT, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  /** Rewrites the module's own relative `/bet` request onto the fixture's real base URL. */
  const fixtureFetch: typeof fetch = (input, init) =>
    fetch(`${baseUrl}${String(input)}`, init);

  it("resolves to whatever premiere the fixture's redirect currently points at", async () => {
    currentPremiereId = "prem_cycle1aaaaaaaaaaaaaa";
    await expect(resolveCurrentBettingPremiereId(fixtureFetch)).resolves.toBe(
      "prem_cycle1aaaaaaaaaaaaaa",
    );
  });

  it("re-resolves to a DIFFERENT premiere once the fixture simulates the next id-reuse restart cycle", async () => {
    currentPremiereId = "prem_cycle1aaaaaaaaaaaaaa";
    const first = await resolveCurrentBettingPremiereId(fixtureFetch);

    // Simulates exactly what pass-8 QA hit live: the origin restarts and
    // the next cycle mints an entirely new random id.
    currentPremiereId = "prem_cycle2bbbbbbbbbbbbbb";
    const second = await resolveCurrentBettingPremiereId(fixtureFetch);

    expect(first).toBe("prem_cycle1aaaaaaaaaaaaaa");
    expect(second).toBe("prem_cycle2bbbbbbbbbbbbbb");
    expect(second).not.toBe(first);
  });

  it("returns null (never a fabricated id) when the fixture is unreachable", async () => {
    const unreachableFetch: typeof fetch = (input, init) =>
      fetch(`http://127.0.0.1:1${input}`, init);
    await expect(
      resolveCurrentBettingPremiereId(unreachableFetch),
    ).resolves.toBeNull();
  });
});
