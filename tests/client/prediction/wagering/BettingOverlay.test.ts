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
    competitorRailSeats: [],
    warRoomEvents: [],
    timelineMarkers: [],
    totalTurns: 1,
    maxSeekableTurn: 0,
    analystEvents: [],
    analystActionKindCounts: [],
    analystDecisionsUnavailableReason: "premiere_sealed",
    matchStateStrip: null,
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

describe("premiere-betting-overlay trade draft survives poll refreshes and ticket rebuilds", () => {
  const POLICIES: ReplayPremiereOverlayModel["policies"] = [
    {
      seatId: "seat-a",
      displayName: "Nation A",
      policyIdentity: { namespace: "local_manifest", manifestName: "a", declaredVersion: "v1", manifestSha256: "sha", contentSha256: "sha" },
    },
  ];

  it("keeps seat/side/amount when the ticket subtree is torn down and rebuilt (e.g. a transient connection-loss state that recovers)", async () => {
    const el = mount();
    el.model = model({ state: "playing", policies: POLICIES });
    el.market = market(null);
    await el.updateComplete;

    const ticket = el.querySelector("premiere-trade-ticket");
    if (!ticket) throw new Error("ticket not rendered");
    await (ticket as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    const sellButton = [...ticket.querySelectorAll("button")].find(
      (b) => b.textContent?.trim().toLowerCase() === "sell",
    );
    sellButton?.click();
    await (ticket as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    const seatButton = [...ticket.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Nation A"),
    );
    seatButton?.click();
    await (ticket as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    const input = ticket.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) throw new Error("amount input not rendered");
    input.value = "7";
    input.dispatchEvent(new Event("input"));
    await (ticket as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    // Simulate the exact remount trigger: `model.state` briefly reports a
    // non-live state (e.g. the self-healing "runtime_failure" connection
    // blip) — `renderBody()` swaps to a completely different template,
    // which tears down `<premiere-trade-ticket>` — then recovers.
    el.model = model({ state: "failed", failureCode: "runtime_failure" });
    await el.updateComplete;
    expect(el.querySelector("premiere-trade-ticket")).toBeNull();

    el.model = model({ state: "playing", policies: POLICIES });
    await el.updateComplete;

    const ticketAfter = el.querySelector("premiere-trade-ticket");
    if (!ticketAfter) throw new Error("ticket not rebuilt");
    await (ticketAfter as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    // A brand-new DOM node — but the draft survives because it lives on
    // the overlay (created once, never rebuilt), not on the ticket.
    expect(ticketAfter).not.toBe(ticket);
    const sellAfter = [...ticketAfter.querySelectorAll("button")].find(
      (b) => b.textContent?.trim().toLowerCase() === "sell",
    );
    expect(sellAfter?.getAttribute("aria-pressed")).toBe("true");
    const seatAfter = [...ticketAfter.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Nation A"),
    );
    expect(seatAfter?.getAttribute("aria-pressed")).toBe("true");
    const inputAfter = ticketAfter.querySelector<HTMLInputElement>('input[type="number"]');
    expect(inputAfter?.value).toBe("7");

    el.remove();
  });

  it("preserves seat/amount, DOM node identity and focus across ordinary market/bankroll poll refreshes", async () => {
    const el = mount();
    el.model = model({ state: "playing", policies: POLICIES });
    el.market = market(null);
    el.bankroll = 1000;
    await el.updateComplete;

    const ticket = el.querySelector("premiere-trade-ticket");
    if (!ticket) throw new Error("ticket not rendered");
    await (ticket as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    const seatButton = [...ticket.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Nation A"),
    );
    seatButton?.click();
    await (ticket as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    const input = ticket.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) throw new Error("amount input not rendered");
    input.focus();
    input.value = "42";
    input.dispatchEvent(new Event("input"));
    await (ticket as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    // Several fresh `MarketState` snapshots, exactly like
    // `BettingPremiereMarketController.applyMarket` on its 2.5s poll.
    for (let i = 0; i < 3; i++) {
      el.market = market(null);
      el.bankroll = 1000 - i;
      await el.updateComplete;
    }

    const ticketAfter = el.querySelector("premiere-trade-ticket");
    expect(ticketAfter).toBe(ticket);
    const inputAfter = ticketAfter?.querySelector<HTMLInputElement>('input[type="number"]');
    expect(inputAfter).toBe(input);
    expect(inputAfter?.value).toBe("42");
    expect(document.activeElement).toBe(input);

    el.remove();
  });
});

describe("premiere-betting-overlay provenance and play-money honesty", () => {
  it("labels a house exhibition match as not a league round", async () => {
    const el = mount();
    el.model = model({
      state: "scheduled",
      sourceKind: "controlled_exhibition",
    });
    el.market = market(null);
    await el.updateComplete;
    expect(el.textContent).toContain("House exhibition — not a league round");
    el.remove();
  });

  it("shows no exhibition label for a rated league premiere", async () => {
    const el = mount();
    el.model = model({ state: "scheduled", sourceKind: "rated_coworld" });
    el.market = market(null);
    await el.updateComplete;
    expect(el.textContent).not.toContain("House exhibition");
    el.remove();
  });

  it("discloses play money and the simulated house crowd in the market facts", async () => {
    const el = mount();
    el.model = model({ state: "scheduled" });
    el.market = market(null);
    await el.updateComplete;
    expect(el.textContent).toContain("Play money only");
    expect(el.textContent).toContain("simulated house crowd");
    expect(el.textContent).toContain("ranks real visitors only");
    el.remove();
  });
});
