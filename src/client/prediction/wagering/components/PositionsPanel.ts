import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { formatSignedCredits, formatSignedPercent, pnlPercent, pnlTier } from "./pnlDisplay";
import type { MarketSeatOption, MarketState } from "../types";

/**
 * Per-seat detail behind the headline `premiere-position-summary` figure:
 * what the viewer holds, marked to market at the CURRENT price, with
 * unrealized P&L (magnitude-tiered, not flat red/green) per seat. This is
 * the "press, cut, or ride" view — at checkpoint 2 the viewer sees
 * checkpoint 1's position up or down before deciding what to do next.
 * Purely presentational — recomputes from `market` every render.
 */
@customElement("premiere-positions-panel")
export class PremierePositionsPanel extends LitElement {
  @property({ attribute: false }) seats: readonly MarketSeatOption[] = [];
  @property({ attribute: false }) market: MarketState | null = null;

  createRenderRoot() {
    return this;
  }

  private displayNameFor(seatId: string): string {
    return this.seats.find((seat) => seat.seatId === seatId)?.displayName ?? seatId;
  }

  render() {
    const positions = (this.market?.positions ?? []).filter((p) => p.shares > 0);
    return html`
      <div class="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
        <h3 class="text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Your positions
        </h3>
        ${positions.length === 0
          ? html`<p class="text-sm text-ink-muted">No open positions.</p>`
          : html`<div class="flex flex-col gap-1.5">
              ${positions.map((position) => {
                const percent = pnlPercent(position.unrealizedPnl, position.costBasis);
                const tier = pnlTier(position.unrealizedPnl, percent);
                return html`
                  <div
                    class="flex items-center justify-between gap-2 rounded-md border ${tier.borderClass} ${tier.bgClass} px-3 py-2 text-sm transition-colors duration-500 motion-reduce:transition-none"
                  >
                    <span class="min-w-0 truncate text-ink">${this.displayNameFor(position.seatId)}</span>
                    <span class="flex shrink-0 items-center gap-3">
                      <span class="text-xs text-ink-muted">${position.shares} sh</span>
                      <span class="font-mono tabular-nums text-ink"
                        >${position.currentValue.toLocaleString()} cr</span
                      >
                      <span
                        class="flex w-24 items-center justify-end gap-1 font-mono text-xs font-semibold tabular-nums ${tier.colorClass}"
                      >
                        <span aria-hidden="true">${tier.icon}</span>
                        <span>${formatSignedCredits(position.unrealizedPnl)}</span>
                        ${percent !== null
                          ? html`<span class="opacity-70">(${formatSignedPercent(percent)})</span>`
                          : nothing}
                      </span>
                    </span>
                  </div>
                `;
              })}
            </div>`}
      </div>
    `;
  }
}
