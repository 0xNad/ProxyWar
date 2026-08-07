/**
 * Coverage for `BettingPremiereMarketController.pollOnce`'s startup-auth
 * race handling (P1, 2026-08-02). Live-reproduced symptom: a fresh
 * `/bet/<id>` load briefly flashes the raw `request_rejected` error CODE
 * as if it were a terminal failure, between "Loading market..." and
 * "YOUR POSITIONS" rendering, before self-healing on its own. Root cause:
 * the market poll's `GET .../market/me` and the join session's own
 * `POST .../sessions` bootstrap can land in either order on a cold boot,
 * so a 401/403 on the very first poll(s) is at least as often "the guest
 * cookie/CSRF the session bootstrap is about to establish hasn't landed on
 * THIS request yet" as it is a real rejection — indistinguishable from the
 * outside, so it must retry silently (bounded) rather than flash a raw
 * error code, exactly like the pre-existing `session_required` handling
 * this extends.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PremiereBettingOverlay } from "../../../../../src/client/prediction/wagering/page/BettingOverlay";
import { BettingPremiereMarketController } from "../../../../../src/client/prediction/wagering/page/BettingPremierePage";
import {
  ReplayPremiereServiceError,
  type ReplayPremiereRuntimeController,
  type ReplayPremiereServiceMarketState,
  type ReplayPremiereServiceMarketStateResponse,
} from "../../../../../src/client/ReplayPremiereRuntime";

function marketState(
  overrides: Partial<ReplayPremiereServiceMarketState> = {},
): ReplayPremiereServiceMarketState {
  return {
    outcomeSeatIds: ["seat_a".padEnd(8, "0"), "seat_b".padEnd(8, "0")],
    q: [0, 0],
    b: 10,
    prices: [50, 50],
    status: "open",
    winnerSeatId: null,
    liveVisibleSequence: 1,
    positions: null,
    balance: 1000,
    ...overrides,
  };
}

function marketResponse(
  overrides: Partial<ReplayPremiereServiceMarketState> = {},
): ReplayPremiereServiceMarketStateResponse {
  return { schemaVersion: 1, market: marketState(overrides) };
}

/** Duck-typed runtime stub — the controller only ever calls these two methods on it. */
function stubRuntime(
  readMarketSelf: () => Promise<ReplayPremiereServiceMarketStateResponse>,
): ReplayPremiereRuntimeController {
  return {
    readMarketSelf,
    submitMarketOrder: vi.fn(),
  } as unknown as ReplayPremiereRuntimeController;
}

function stubOverlay(): PremiereBettingOverlay {
  return {
    marketLoadError: null,
    market: null,
    bankroll: null,
    onTrade: undefined,
  } as unknown as PremiereBettingOverlay;
}

/** Reaches the controller's private `pollOnce` through its public `start()` without duplicating its scheduling logic. */
function triggerFirstPoll(controller: BettingPremiereMarketController): void {
  controller.start();
}

describe("BettingPremiereMarketController startup-auth race handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a clean first poll never touches marketLoadError", async () => {
    const overlay = stubOverlay();
    const runtime = stubRuntime(async () => marketResponse({ balance: 991 }));
    const controller = new BettingPremiereMarketController(
      runtime,
      "prem_test",
    );
    controller.attachOverlay(overlay);
    triggerFirstPoll(controller);
    await vi.waitFor(() => expect(overlay.bankroll).toBe(991));
    expect(overlay.marketLoadError).toBeNull();
  });

  test("a 401 request_rejected on the first poll (join-session race) retries silently and never flashes the raw error code", async () => {
    const overlay = stubOverlay();
    let calls = 0;
    const runtime = stubRuntime(async () => {
      calls += 1;
      if (calls === 1) {
        throw new ReplayPremiereServiceError(
          "request_rejected",
          401,
          null,
          "response_status",
        );
      }
      return marketResponse({ balance: 1000 });
    });
    const controller = new BettingPremiereMarketController(
      runtime,
      "prem_test",
    );
    controller.attachOverlay(overlay);
    triggerFirstPoll(controller);

    // First attempt has failed and scheduled a bounded retry -- the raw
    // error code must never have reached the overlay in the meantime.
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(overlay.marketLoadError).toBeNull();

    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(overlay.marketLoadError).toBeNull();
    expect(overlay.bankroll).toBe(1000);
  });

  test("a 403 that never recovers still surfaces as a real, visible error once the retry budget is exhausted -- never retries silently forever", async () => {
    const overlay = stubOverlay();
    let calls = 0;
    const runtime = stubRuntime(async () => {
      calls += 1;
      throw new ReplayPremiereServiceError(
        "request_rejected",
        403,
        null,
        "response_status",
      );
    });
    const controller = new BettingPremiereMarketController(
      runtime,
      "prem_test",
    );
    controller.attachOverlay(overlay);
    triggerFirstPoll(controller);

    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(200);
    }

    await vi.waitFor(() => expect(overlay.marketLoadError).not.toBeNull());
    // Bounded: exactly the initial attempt plus the retry cap, never an
    // unbounded silent loop.
    expect(calls).toBeLessThanOrEqual(7);
    expect(calls).toBeGreaterThan(1);
  });

  test("a genuinely terminal rejection (not 401/403, and not the premiere-gone shape) is never treated as a startup race", async () => {
    const overlay = stubOverlay();
    const runtime = stubRuntime(async () => {
      throw new ReplayPremiereServiceError(
        "request_rejected",
        409,
        "PREMIERE_INVALID_REQUEST",
        "response_status",
      );
    });
    const controller = new BettingPremiereMarketController(
      runtime,
      "prem_test",
    );
    controller.attachOverlay(overlay);
    triggerFirstPoll(controller);
    await vi.waitFor(() => expect(overlay.marketLoadError).not.toBeNull());
  });

  test("a 404 carrying the catalog's own PREMIERE_UNAVAILABLE code fires onPremiereGone instead of a generic marketLoadError (P1 t3-01/t3-02: this specific shape means the premiere is gone for good, not just a transient failure)", async () => {
    const overlay = stubOverlay();
    const runtime = stubRuntime(async () => {
      throw new ReplayPremiereServiceError(
        "request_rejected",
        404,
        "PREMIERE_UNAVAILABLE",
        "response_status",
      );
    });
    const controller = new BettingPremiereMarketController(
      runtime,
      "prem_test",
    );
    controller.attachOverlay(overlay);
    const onPremiereGone = vi.fn();
    controller.onPremiereGone = onPremiereGone;
    triggerFirstPoll(controller);
    await vi.waitFor(() => expect(onPremiereGone).toHaveBeenCalledTimes(1));
    expect(overlay.marketLoadError).toBeNull();
  });
});
