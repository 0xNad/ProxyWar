/**
 * Regression coverage for the failure-message honesty fix: the betting
 * overlay must never claim a refund it cannot confirm, and must render
 * distinct copy for a connection problem (recoverable) vs. a genuine
 * integrity violation (terminal) vs. a server-reported cancellation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../../src/client/prediction/wagering/page/BettingOverlay";
import type { PremiereBettingOverlay } from "../../../../src/client/prediction/wagering/page/BettingOverlay";
import type { ReplayPremiereOverlayModel } from "../../../../src/client/ReplayPremiereOverlay";
import type { MarketPosition, MarketState } from "../../../../src/client/prediction/wagering/types";

function mount(): PremiereBettingOverlay {
  const el = document.createElement(
    "premiere-betting-overlay",
  ) as PremiereBettingOverlay;
  document.body.append(el);
  return el;
}

function model(
  overrides: Partial<ReplayPremiereOverlayModel> = {},
): ReplayPremiereOverlayModel {
  return {
    premiereId: "prem_0123456789abcdef",
    state: "failed",
    title: "Test Premiere",
    description: "",
    sourceKind: "controlled_exhibition",
    publicLabel: "premiere",
    scheduledAt: "2026-07-25T18:00:00.000Z",
    authoritativeNow: "2026-07-25T18:06:00.000Z",
    playbackRate: 1,
    mapName: "Asia",
    matchFormat: "FFA",
    policies: [],
    releasedSequence: 0,
    checkpoints: [] as unknown as ReplayPremiereOverlayModel["checkpoints"],
    ambient: false,
    ...overrides,
  };
}

const POSITION: MarketPosition = {
  seatId: "seat-a",
  shares: 4,
  costBasis: 120,
  currentValue: 140,
  unrealizedPnl: 20,
};

function market(positions: readonly MarketPosition[] | null): MarketState {
  return {
    outcomeSeatIds: ["seat-a"],
    q: [0],
    b: 100,
    prices: { "seat-a": 50 },
    status: "open",
    winnerSeatId: null,
    liveVisibleSequence: 0,
    positions,
    balance: 1_000,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("premiere-betting-overlay failure messaging", () => {
  it("never claims a refund, for any failure state, with or without a position", async () => {
    const cases: Array<{
      state: ReplayPremiereOverlayModel["state"];
      failureCode: string | null;
      positions: readonly MarketPosition[] | null;
    }> = [
      { state: "failed", failureCode: "runtime_failure", positions: null },
      { state: "failed", failureCode: "runtime_failure", positions: [POSITION] },
      { state: "failed", failureCode: "integrity_failure", positions: null },
      { state: "failed", failureCode: "integrity_failure", positions: [POSITION] },
      { state: "cancelled", failureCode: "cancelled_by_operator", positions: null },
      { state: "cancelled", failureCode: "cancelled_by_operator", positions: [POSITION] },
    ];
    for (const testCase of cases) {
      const el = mount();
      el.model = model({ state: testCase.state, failureCode: testCase.failureCode });
      el.market = market(testCase.positions);
      await el.updateComplete;
      expect(el.textContent).not.toContain("voided and refunded");
      expect(el.textContent).not.toContain("refunded");
      el.remove();
    }
  });

  it("distinguishes a connection problem (recoverable, reload offered) from a genuine integrity violation (terminal, no reload)", async () => {
    const connection = mount();
    connection.model = model({ state: "failed", failureCode: "runtime_failure" });
    connection.market = market(null);
    await connection.updateComplete;
    expect(connection.textContent).toContain("Lost connection");
    expect(
      [...connection.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Reload"),
      ),
    ).toBe(true);
    connection.remove();

    const integrity = mount();
    integrity.model = model({ state: "failed", failureCode: "integrity_failure" });
    integrity.market = market(null);
    await integrity.updateComplete;
    expect(integrity.textContent).toContain("could not be verified");
    expect(integrity.textContent).not.toContain("Lost connection");
    // No reload button for a genuine integrity violation — it is
    // deliberately terminal, not user-retriable.
    expect(
      [...integrity.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Reload"),
      ),
    ).toBe(false);
    integrity.remove();
  });

  it("hedges instead of asserting when the viewer actually held a position", async () => {
    const el = mount();
    el.model = model({ state: "failed", failureCode: "integrity_failure" });
    el.market = market([POSITION]);
    await el.updateComplete;
    expect(el.textContent).toContain("could not be confirmed");
    el.remove();
  });

  it("says nothing about positions when the viewer held none", async () => {
    const el = mount();
    el.model = model({ state: "failed", failureCode: "integrity_failure" });
    el.market = market(null);
    await el.updateComplete;
    expect(el.textContent).not.toContain("could not be confirmed");
    el.remove();
  });

  it("shows a quiet reconnecting indicator, never an alarming one, while a transient retry is in flight", async () => {
    const el = mount();
    el.model = model({
      state: "playing",
      recovery: { attempt: 2, retryInMs: 4_000 },
    });
    el.market = market(null);
    await el.updateComplete;
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      "Reconnecting",
    );
    expect(el.querySelector('[role="alert"]')).toBeNull();
    el.remove();
  });
});
