import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { MarketSeatOption, MarketState } from "../types";

/**
 * Live positions: what the viewer holds, marked to market at the CURRENT
 * price, with unrealized P&L per seat. This is the "press, cut, or ride"
 * view — at checkpoint 2 the viewer sees checkpoint 1's position up or
 * down before deciding what to do next, so `currentValue`/`unrealizedPnl`
 * (server-computed, carried on `MarketState`) are prominent, not buried.
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
              ${positions.map(
                (position) => html`
                  <div
                    class="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm"
                  >
                    <span class="truncate text-ink">${this.displayNameFor(position.seatId)}</span>
                    <span class="flex items-center gap-3">
                      <span class="text-xs text-ink-muted">${position.shares} sh</span>
                      <span class="font-mono tabular-nums text-ink"
                        >${position.currentValue.toLocaleString()} cr</span
                      >
                      <span
                        class="w-16 text-right font-mono text-xs font-semibold tabular-nums ${position.unrealizedPnl >=
                        0
                          ? "text-positive"
                          : "text-danger"}"
                        >${position.unrealizedPnl >= 0 ? "+" : ""}${position.unrealizedPnl.toLocaleString()}</span
                      >
                    </span>
                  </div>
                `,
              )}
            </div>`}
      </div>
    `;
  }
}
