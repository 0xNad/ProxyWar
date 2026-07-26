import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { marketRows } from "../marketMath";
import type { MarketSeatOption, MarketState } from "../types";

const FLASH_DURATION_MS = 900;
/** A price move below this (0..100 points) is float noise, not a real tick. */
const FLASH_THRESHOLD = 0.05;

/**
 * Live per-seat LMSR price board: a horizontal-fill bar per seat, the
 * display price (0..100 = implied probability), and the viewer's own
 * unrealized P&L when they hold a position — the "press, cut, or ride"
 * decision Main called out as load-bearing. Purely presentational —
 * recomputes rows from `market` on every render (never caches), so a
 * poll/push landing a fresh snapshot changes what's on screen. A seat
 * whose price just moved briefly pulses so odds genuinely read as LIVE,
 * not a static table. Reused both for the live, open market and — with
 * `frozen` set — for a closed/settled snapshot.
 */
@customElement("premiere-market-price-board")
export class PremiereMarketPriceBoard extends LitElement {
  @property({ attribute: false }) seats: readonly MarketSeatOption[] = [];
  @property({ attribute: false }) market: MarketState | null = null;
  @property({ type: Boolean }) frozen = false;

  @state() private flashingSeatIds = new Set<string>();
  private previousPrices: Readonly<Record<string, number>> | null = null;
  private flashTimers = new Map<string, number>();

  createRenderRoot() {
    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const timer of this.flashTimers.values()) {
      window.clearTimeout(timer);
    }
    this.flashTimers.clear();
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has("market") || this.frozen) {
      return;
    }
    const prices = this.market?.prices ?? null;
    const previous = this.previousPrices;
    this.previousPrices = prices;
    if (previous === null || prices === null) {
      return;
    }
    const moved = new Set(this.flashingSeatIds);
    let changedAny = false;
    for (const seatId of new Set([
      ...Object.keys(previous),
      ...Object.keys(prices),
    ])) {
      const delta = Math.abs((prices[seatId] ?? 0) - (previous[seatId] ?? 0));
      if (delta <= FLASH_THRESHOLD) continue;
      changedAny = true;
      moved.add(seatId);
      const existing = this.flashTimers.get(seatId);
      window.clearTimeout(existing);
      this.flashTimers.set(
        seatId,
        window.setTimeout(() => {
          const next = new Set(this.flashingSeatIds);
          next.delete(seatId);
          this.flashingSeatIds = next;
          this.flashTimers.delete(seatId);
        }, FLASH_DURATION_MS),
      );
    }
    if (changedAny) {
      this.flashingSeatIds = moved;
    }
  }

  render() {
    const market = this.market;
    if (market === null) {
      return html`
        <div
          class="flex items-center justify-center rounded-lg border border-line bg-surface-2 px-4 py-6 text-sm text-ink-muted"
          role="status"
        >
          Loading market…
        </div>
      `;
    }
    const rows = marketRows(this.seats, market);
    return html`
      <div class="flex flex-col gap-1.5" role="list" aria-label="Market prices">
        ${rows.map((row) => {
          const flashing = this.flashingSeatIds.has(row.seatId);
          const isWinner =
            market.status === "settled" && market.winnerSeatId === row.seatId;
          return html`
            <div
              role="listitem"
              class="flex flex-col gap-1 rounded-lg border ${isWinner
                ? "border-positive/50 bg-positive/10"
                : "border-line bg-surface-2"} px-3 py-2 transition-colors duration-500 ${flashing
                ? "ring-1 ring-accent/60"
                : ""}"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="truncate text-sm text-ink">${row.displayName}</span>
                <span class="flex items-center gap-2">
                  ${row.myShares > 0
                    ? html`<span class="text-[11px] text-ink-muted"
                        >${row.myShares} sh</span
                      >`
                    : nothing}
                  <span
                    class="font-mono text-sm font-semibold tabular-nums text-ink transition-all duration-500 ${flashing
                      ? "scale-110 text-accent"
                      : ""}"
                    >${row.price.toFixed(1)}</span
                  >
                </span>
              </div>
              <div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                <div
                  class="h-full rounded-full bg-accent transition-[width] duration-700 ease-out"
                  style="width:${Math.max(0, Math.min(100, row.price))}%"
                ></div>
              </div>
              ${row.myShares > 0 && row.myUnrealizedPnl !== null
                ? html`<div class="text-right text-xs font-semibold tabular-nums ${row.myUnrealizedPnl >= 0 ? "text-positive" : "text-danger"}">
                    ${row.myUnrealizedPnl >= 0 ? "+" : ""}${row.myUnrealizedPnl.toLocaleString()} cr
                  </div>`
                : nothing}
            </div>
          `;
        })}
      </div>
    `;
  }
}
