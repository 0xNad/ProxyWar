import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * Compact bankroll readout for the trade ticket header. Visual conventions
 * (surface-2 pill, tabular-nums, danger-tinted when below the minimum
 * stake) carry forward from the standalone prediction page's
 * `prediction-bankroll-header`, sized down for the betting page's rail
 * rather than a full-width page header.
 */
@customElement("premiere-market-bankroll-badge")
export class PremiereMarketBankrollBadge extends LitElement {
  /** `null` while the session bankroll has not loaded yet. */
  @property({ type: Number }) bankroll: number | null = null;
  @property({ type: Number, attribute: "min-stake" }) minStake = 0;

  createRenderRoot() {
    return this;
  }

  render() {
    if (this.bankroll === null) {
      return html`
        <span
          class="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-ink-muted"
          role="status"
        >
          Loading balance…
        </span>
      `;
    }
    const short = this.bankroll < this.minStake;
    return html`
      <span
        class="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold tabular-nums ${short
          ? "text-danger"
          : "text-ink"}"
        title="Play-money bankroll for this session"
      >
        ${this.bankroll.toLocaleString()} cr
        ${short
          ? html`<span class="text-danger/80">· below min stake</span>`
          : nothing}
      </span>
    `;
  }
}
