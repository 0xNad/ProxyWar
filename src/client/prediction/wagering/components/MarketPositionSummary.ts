import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { formatSignedCredits, formatSignedPercent, pnlPercent, pnlTier } from "./pnlDisplay";
import type { MarketState } from "../types";

const PULSE_DURATION_MS = 900;

/**
 * The single most legible number on the whole betting page: total
 * unrealized P&L across every seat the viewer holds, mark-to-market at the
 * CURRENT price. Sits above the price board — the "press, cut, or ride"
 * decision starts here, not buried in a per-seat list. Renders nothing
 * when the viewer holds no position, so it never competes for space before
 * there's anything to show. A pulse on the headline number (direction-
 * aware, not just a colour flash) makes a live mark-to-market update
 * register without needing to re-read the whole card.
 */
@customElement("premiere-position-summary")
export class PremiereMarketPositionSummary extends LitElement {
  @property({ attribute: false }) market: MarketState | null = null;

  @state() private pulse: "up" | "down" | null = null;
  private previousTotal: number | null = null;
  private pulseTimer: number | null = null;

  createRenderRoot() {
    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.pulseTimer !== null) window.clearTimeout(this.pulseTimer);
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has("market")) return;
    const total = this.totalPnl();
    const previous = this.previousTotal;
    this.previousTotal = total;
    if (previous === null || total === null || total === previous) return;
    window.clearTimeout(this.pulseTimer ?? undefined);
    this.pulse = total > previous ? "up" : "down";
    this.pulseTimer = window.setTimeout(() => {
      this.pulse = null;
    }, PULSE_DURATION_MS);
  }

  private totalPnl(): number | null {
    const positions = this.market?.positions;
    if (positions === null || positions === undefined || positions.length === 0) {
      return null;
    }
    return positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  }

  render() {
    const total = this.totalPnl();
    if (total === null) return nothing;
    const positions = this.market?.positions ?? [];
    const costBasis = positions.reduce((sum, position) => sum + position.costBasis, 0);
    const percent = pnlPercent(total, costBasis);
    const tier = pnlTier(total, percent);
    return html`
      <div
        class="flex flex-col gap-1 rounded-lg border ${tier.borderClass} ${tier.bgClass} px-4 py-3 transition-colors duration-500 motion-reduce:transition-none"
      >
        <span class="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          Unrealized P&amp;L
        </span>
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span aria-hidden="true" class="${tier.colorClass} text-base leading-none">${tier.icon}</span>
          <span
            class="font-mono text-2xl font-bold tabular-nums ${tier.colorClass} transition-transform duration-300 ease-out motion-reduce:transition-none ${this
              .pulse !== null
              ? "scale-[1.04]"
              : ""}"
          >
            ${formatSignedCredits(total)} cr
          </span>
          ${percent !== null
            ? html`<span class="font-mono text-sm font-semibold tabular-nums ${tier.colorClass} opacity-80"
                >${formatSignedPercent(percent)}</span
              >`
            : nothing}
        </div>
        <span class="text-xs text-ink-muted">
          ${positions.length === 1 ? "1 open position" : `${positions.length} open positions`}
        </span>
      </div>
    `;
  }
}
