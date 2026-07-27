import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { marketRows } from "../marketMath";
import { formatSignedCredits, pnlPercent, pnlTier } from "./pnlDisplay";
import type { MarketSeatOption, MarketState } from "../types";

const FLASH_DURATION_MS = 900;
/** A price move below this (0..100 points) is float noise, not a real tick. */
const FLASH_THRESHOLD = 0.05;

interface Flash {
  readonly direction: "up" | "down";
  readonly delta: number;
}

/**
 * Live per-seat LMSR price board: a horizontal-fill bar per seat, the
 * display price (0..100 = implied probability), and the viewer's own
 * unrealized P&L when they hold a position — the "press, cut, or ride"
 * decision Main called out as load-bearing. Purely presentational —
 * recomputes rows from `market` on every render (never caches), so a
 * poll/push landing a fresh snapshot changes what's on screen. A seat
 * whose price just moved briefly washes in the broadcast/info accent
 * (constant hue regardless of direction, so it never fights the
 * green/red vocabulary reserved for P&L) with a signed delta chip and a
 * direction glyph — legible without strobing on every tick. Reused both
 * for the live, open market and — with `frozen` set — for a closed/
 * settled snapshot, where the winner is highlighted and the rest visibly
 * recede.
 */
@customElement("premiere-market-price-board")
export class PremiereMarketPriceBoard extends LitElement {
  @property({ attribute: false }) seats: readonly MarketSeatOption[] = [];
  @property({ attribute: false }) market: MarketState | null = null;
  @property({ type: Boolean }) frozen = false;

  @state() private flashes = new Map<string, Flash>();
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
    const next = new Map(this.flashes);
    let changedAny = false;
    for (const seatId of new Set([...Object.keys(previous), ...Object.keys(prices)])) {
      const before = previous[seatId] ?? 0;
      const after = prices[seatId] ?? 0;
      const delta = after - before;
      if (Math.abs(delta) <= FLASH_THRESHOLD) continue;
      changedAny = true;
      next.set(seatId, { direction: delta > 0 ? "up" : "down", delta });
      const existing = this.flashTimers.get(seatId);
      window.clearTimeout(existing);
      this.flashTimers.set(
        seatId,
        window.setTimeout(() => {
          const cleared = new Map(this.flashes);
          cleared.delete(seatId);
          this.flashes = cleared;
          this.flashTimers.delete(seatId);
        }, FLASH_DURATION_MS),
      );
    }
    if (changedAny) {
      this.flashes = next;
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
    const settled = market.status === "settled";
    return html`
      <div class="flex flex-col gap-1.5" role="list" aria-label="Market prices">
        ${rows.map((row) => {
          const flash = this.flashes.get(row.seatId) ?? null;
          const isWinner = settled && market.winnerSeatId === row.seatId;
          const isLoser = settled && !isWinner && market.winnerSeatId !== null;
          const percent =
            row.myUnrealizedPnl !== null
              ? pnlPercent(
                  row.myUnrealizedPnl,
                  market.positions?.find((p) => p.seatId === row.seatId)?.costBasis ?? 0,
                )
              : null;
          const tier = row.myUnrealizedPnl !== null ? pnlTier(row.myUnrealizedPnl, percent) : null;
          return html`
            <div
              role="listitem"
              class="flex flex-col gap-1 rounded-lg border px-3 py-2 transition-colors duration-500 motion-reduce:transition-none ${isWinner
                ? "border-positive/50 bg-positive/10"
                : isLoser
                  ? "border-line bg-surface-2 opacity-60"
                  : "border-line bg-surface-2"} ${flash !== null ? "bg-info/10 border-info/40" : ""}"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="truncate text-sm text-ink">${row.displayName}</span>
                <span class="flex items-center gap-2">
                  ${row.myShares > 0
                    ? html`<span class="text-[11px] text-ink-muted">${row.myShares} sh</span>`
                    : nothing}
                  ${flash !== null
                    ? html`<span
                        aria-hidden="true"
                        class="font-mono text-[11px] font-semibold tabular-nums text-info"
                        >${flash.direction === "up" ? "▲" : "▼"}${Math.abs(flash.delta).toFixed(1)}</span
                      >`
                    : nothing}
                  <span
                    class="font-mono text-sm font-semibold tabular-nums text-ink transition-colors duration-500 motion-reduce:transition-none ${flash !==
                    null
                      ? "text-info"
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
              ${row.myShares > 0 && row.myUnrealizedPnl !== null && tier !== null
                ? html`<div class="flex items-center justify-end gap-1 text-right text-xs font-semibold tabular-nums ${tier.colorClass}">
                    <span aria-hidden="true">${tier.icon}</span>
                    <span>${formatSignedCredits(row.myUnrealizedPnl)} cr</span>
                  </div>`
                : nothing}
            </div>
          `;
        })}
      </div>
    `;
  }
}
