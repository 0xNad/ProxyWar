/**
 * Component-level smoke tests, following the convention established at
 * tests/client/prediction/components.test.ts: mount the real custom element
 * into jsdom and read its light DOM (these components render without shadow
 * DOM via `createRenderRoot() { return this; }`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../../src/client/prediction/wagering/components/MarketBankrollBadge";
import "../../../../src/client/prediction/wagering/components/MarketPriceBoard";
import "../../../../src/client/prediction/wagering/components/TradeTicket";
import "../../../../src/client/prediction/wagering/components/PositionsPanel";
import "../../../../src/client/prediction/wagering/components/MarketSettlementPanel";
import type { PremiereMarketBankrollBadge } from "../../../../src/client/prediction/wagering/components/MarketBankrollBadge";
import type { PremiereMarketPriceBoard } from "../../../../src/client/prediction/wagering/components/MarketPriceBoard";
import type { PremiereTradeTicket } from "../../../../src/client/prediction/wagering/components/TradeTicket";
import type { PremierePositionsPanel } from "../../../../src/client/prediction/wagering/components/PositionsPanel";
import type { PremiereMarketSettlement } from "../../../../src/client/prediction/wagering/components/MarketSettlementPanel";
import type { MarketSeatOption, MarketState } from "../../../../src/client/prediction/wagering/types";

function mount<T extends HTMLElement>(tag: string): T {
  const el = document.createElement(tag) as T;
  document.body.append(el);
  return el;
}

/** Drains pending microtasks — deterministic, not a real-time wait. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const SEATS: readonly MarketSeatOption[] = [
  { seatId: "seat-a", displayName: "Nation A" },
  { seatId: "seat-b", displayName: "Nation B" },
];

function market(overrides: Partial<MarketState> = {}): MarketState {
  return {
    outcomeSeatIds: ["seat-a", "seat-b"],
    q: [10, -10],
    b: 100,
    prices: { "seat-a": 55, "seat-b": 45 },
    status: "open",
    winnerSeatId: null,
    positions: null,
    ...overrides,
  };
}

describe("premiere-market-bankroll-badge", () => {
  it("shows a loading state while bankroll is null", async () => {
    const el = mount<PremiereMarketBankrollBadge>(
      "premiere-market-bankroll-badge",
    );
    await el.updateComplete;
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      "Loading balance",
    );
  });

  it("flags bankroll below the minimum stake", async () => {
    const el = mount<PremiereMarketBankrollBadge>(
      "premiere-market-bankroll-badge",
    );
    el.bankroll = 5;
    el.minStake = 10;
    await el.updateComplete;
    expect(el.querySelector(".text-danger")).not.toBeNull();
    expect(el.textContent).toContain("below min stake");
  });
});

describe("premiere-market-price-board", () => {
  it("renders an explicit loading state with no market", async () => {
    const el = mount<PremiereMarketPriceBoard>("premiere-market-price-board");
    el.seats = SEATS;
    el.market = null;
    await el.updateComplete;
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      "Loading market",
    );
  });

  it("shows a price row per seat, live (not cached)", async () => {
    const el = mount<PremiereMarketPriceBoard>("premiere-market-price-board");
    el.seats = SEATS;
    el.market = market();
    await el.updateComplete;
    expect(el.textContent).toContain("Nation A");
    expect(el.textContent).toContain("55.0");

    // A live poll landing a fresh snapshot must change the rendered price,
    // not repeat a value computed once at mount.
    el.market = market({ prices: { "seat-a": 62, "seat-b": 38 } });
    await el.updateComplete;
    expect(el.textContent).toContain("62.0");
  });

  it("visibly flashes a row whose price just moved, then clears the flash", async () => {
    vi.useFakeTimers();
    const el = mount<PremiereMarketPriceBoard>("premiere-market-price-board");
    el.seats = SEATS;
    el.market = market({ prices: { "seat-a": 50, "seat-b": 50 } });
    await el.updateComplete;

    el.market = market({ prices: { "seat-a": 70, "seat-b": 30 } });
    await el.updateComplete;
    expect(el.querySelector(".ring-accent\\/60")).not.toBeNull();

    vi.advanceTimersByTime(1000);
    await el.updateComplete;
    expect(el.querySelector(".ring-accent\\/60")).toBeNull();
  });

  it("marks the winning seat once the market settles", async () => {
    const el = mount<PremiereMarketPriceBoard>("premiere-market-price-board");
    el.seats = SEATS;
    el.market = market({ status: "settled", winnerSeatId: "seat-a" });
    el.frozen = true;
    await el.updateComplete;
    expect(el.querySelector(".border-positive\\/50")).not.toBeNull();
  });
});

describe("premiere-positions-panel", () => {
  it("renders an explicit empty state with no positions", async () => {
    const el = mount<PremierePositionsPanel>("premiere-positions-panel");
    el.seats = SEATS;
    el.market = market({ positions: [] });
    await el.updateComplete;
    expect(el.textContent).toContain("No open positions");
  });

  it("shows shares, mark-to-market value, and unrealized P&L per seat", async () => {
    const el = mount<PremierePositionsPanel>("premiere-positions-panel");
    el.seats = SEATS;
    el.market = market({
      positions: [
        { seatId: "seat-a", shares: 4, costBasis: 180, currentValue: 220, unrealizedPnl: 40 },
      ],
    });
    await el.updateComplete;
    expect(el.textContent).toContain("Nation A");
    expect(el.textContent).toContain("4 sh");
    expect(el.textContent).toContain("220");
    expect(el.textContent).toContain("+40");
    expect(el.querySelector(".text-positive")).not.toBeNull();
  });

  it("colors a negative unrealized P&L distinctly", async () => {
    const el = mount<PremierePositionsPanel>("premiere-positions-panel");
    el.seats = SEATS;
    el.market = market({
      positions: [
        { seatId: "seat-a", shares: 4, costBasis: 180, currentValue: 100, unrealizedPnl: -80 },
      ],
    });
    await el.updateComplete;
    expect(el.textContent).toContain("-80");
    expect(el.querySelector(".text-danger")).not.toBeNull();
  });
});

describe("premiere-market-settlement", () => {
  it("renders an explicit empty state when no position was held", async () => {
    const el = mount<PremiereMarketSettlement>("premiere-market-settlement");
    el.settlement = null;
    await el.updateComplete;
    expect(el.textContent).toContain("held no position");
  });

  it("shows a paid win with payout and positive bankroll delta", async () => {
    const el = mount<PremiereMarketSettlement>("premiere-market-settlement");
    el.settlement = {
      outcome: { kind: "paid", winnerSeatId: "seat-a" },
      seatId: "seat-a",
      finalShares: 4,
      costBasis: 180,
      payout: 400,
      bankrollDelta: 220,
    };
    el.seatLabel = "Nation A";
    await el.updateComplete;
    expect(el.textContent).toContain("Won");
    expect(el.textContent).toContain("400");
    expect(el.textContent).toContain("+220");
  });

  it("shows a void refund distinctly from a paid outcome", async () => {
    const el = mount<PremiereMarketSettlement>("premiere-market-settlement");
    el.settlement = {
      outcome: { kind: "void", reason: "checkpoint_voided" },
      seatId: "seat-a",
      finalShares: 4,
      costBasis: 180,
      payout: 180,
      bankrollDelta: 0,
    };
    await el.updateComplete;
    expect(el.textContent).toContain("Void");
    expect(el.textContent).toContain("checkpoint voided");
  });
});

describe("premiere-trade-ticket", () => {
  it("renders a loading state", async () => {
    const el = mount<PremiereTradeTicket>("premiere-trade-ticket");
    el.loading = true;
    await el.updateComplete;
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      "Loading market",
    );
  });

  it("renders an explicit error state", async () => {
    const el = mount<PremiereTradeTicket>("premiere-trade-ticket");
    el.loadError = "Could not reach the server.";
    await el.updateComplete;
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not reach",
    );
  });

  it("shows a closed message with no form when the window isn't open", async () => {
    const el = mount<PremiereTradeTicket>("premiere-trade-ticket");
    el.seats = SEATS;
    el.market = market();
    el.windowOpen = false;
    await el.updateComplete;
    expect(el.textContent).toContain("Trading is closed");
    expect(el.querySelector("select")).toBeNull();
  });

  it("blocks submit with a visible error when no seat is chosen", async () => {
    const el = mount<PremiereTradeTicket>("premiere-trade-ticket");
    el.seats = SEATS;
    el.market = market();
    el.windowOpen = true;
    el.bankroll = 1000;
    const onTrade = vi.fn().mockResolvedValue(undefined);
    el.onTrade = onTrade;
    await el.updateComplete;

    const submit = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Buy shares"),
    );
    submit?.click();
    await el.updateComplete;

    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "Choose a seat",
    );
    expect(onTrade).not.toHaveBeenCalled();
  });

  it("rejects a budget below MIN_STAKE client-side, without calling onTrade", async () => {
    const el = mount<PremiereTradeTicket>("premiere-trade-ticket");
    el.seats = SEATS;
    el.market = market();
    el.windowOpen = true;
    el.bankroll = 1000;
    const onTrade = vi.fn().mockResolvedValue(undefined);
    el.onTrade = onTrade;
    await el.updateComplete;

    const select = el.querySelector("select");
    if (!select) throw new Error("seat select not rendered");
    select.value = "seat-a";
    select.dispatchEvent(new Event("change"));
    const input = el.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) throw new Error("amount input not rendered");
    input.value = "1";
    input.dispatchEvent(new Event("input"));
    await el.updateComplete;

    const submit = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Buy shares"),
    );
    submit?.click();
    await el.updateComplete;

    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "Minimum stake",
    );
    expect(onTrade).not.toHaveBeenCalled();
  });

  it("shows a live buy quote that recomputes as the draft amount changes", async () => {
    const el = mount<PremiereTradeTicket>("premiere-trade-ticket");
    el.seats = SEATS;
    el.market = market({ q: [0, 0], b: 100, prices: { "seat-a": 50, "seat-b": 50 } });
    el.windowOpen = true;
    el.bankroll = 1000;
    await el.updateComplete;

    const select = el.querySelector("select");
    if (!select) throw new Error("seat select not rendered");
    select.value = "seat-a";
    select.dispatchEvent(new Event("change"));
    const input = el.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) throw new Error("amount input not rendered");
    input.value = "50";
    input.dispatchEvent(new Event("input"));
    await el.updateComplete;

    // b=100, q=[0,0]: the first share on a 50/50 book costs exactly 50 chips.
    expect(el.textContent).toContain("1 sh");

    input.value = "150";
    input.dispatchEvent(new Event("input"));
    await el.updateComplete;
    expect(el.textContent).toContain("2 sh");
  });

  it("rejects selling more shares than held, without calling onTrade", async () => {
    const el = mount<PremiereTradeTicket>("premiere-trade-ticket");
    el.seats = SEATS;
    el.market = market({
      positions: [
        { seatId: "seat-a", shares: 2, costBasis: 100, currentValue: 110, unrealizedPnl: 10 },
      ],
    });
    el.windowOpen = true;
    el.bankroll = 1000;
    const onTrade = vi.fn().mockResolvedValue(undefined);
    el.onTrade = onTrade;
    await el.updateComplete;

    const sellButton = [...el.querySelectorAll("button")].find(
      (b) => b.textContent?.trim().toLowerCase() === "sell",
    );
    sellButton?.click();
    await el.updateComplete;

    const select = el.querySelector("select");
    if (!select) throw new Error("seat select not rendered");
    select.value = "seat-a";
    select.dispatchEvent(new Event("change"));
    const input = el.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) throw new Error("amount input not rendered");
    input.value = "5";
    input.dispatchEvent(new Event("input"));
    await el.updateComplete;

    const submit = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Sell shares"),
    );
    submit?.click();
    await el.updateComplete;

    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    expect(onTrade).not.toHaveBeenCalled();
  });

  it("rapid double-clicking submit only applies one order", async () => {
    const el = mount<PremiereTradeTicket>("premiere-trade-ticket");
    el.seats = SEATS;
    el.market = market({ q: [0, 0], b: 100, prices: { "seat-a": 50, "seat-b": 50 } });
    el.windowOpen = true;
    el.bankroll = 1000;
    let resolveTrade: (() => void) | undefined;
    const onTrade = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTrade = resolve;
        }),
    );
    el.onTrade = onTrade;
    await el.updateComplete;

    const select = el.querySelector("select");
    if (!select) throw new Error("seat select not rendered");
    select.value = "seat-a";
    select.dispatchEvent(new Event("change"));
    const input = el.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) throw new Error("amount input not rendered");
    input.value = "100";
    input.dispatchEvent(new Event("input"));
    await el.updateComplete;

    const submit = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Buy shares"),
    );
    // Two synchronous clicks before the first onTrade promise resolves.
    submit?.click();
    submit?.click();
    await el.updateComplete;

    expect(onTrade).toHaveBeenCalledTimes(1);
    expect(submit?.disabled).toBe(true);

    resolveTrade?.();
    await flushMicrotasks();
    await el.updateComplete;
    expect(submit?.disabled).toBe(false);
  });
});
