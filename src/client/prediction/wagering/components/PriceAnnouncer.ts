import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { marketRows } from "../marketMath";
import type { MarketSeatOption, MarketState } from "../types";

/**
 * A screen-reader user gets no free price updates: sighted users glance at
 * the price board, but nothing here spams a screen reader with a `polite`
 * announcement on every 1-3s tick — that's the right call (`role="alert"`
 * stays reserved for one-shot rejections), and every seat button's own
 * accessible name already carries its live price for on-demand reading.
 * The gap that leaves is a snapshot of the WHOLE book without re-tabbing
 * off and back onto every seat button. This closes it with the minimum
 * interruption: a low-frequency (20s) autonomous `polite` summary, plus an
 * explicit "Read current prices" button for reading it on demand.
 */
const AUTO_ANNOUNCE_INTERVAL_MS = 20_000;

@customElement("premiere-price-announcer")
export class PremiereMarketPriceAnnouncer extends LitElement {
  @property({ attribute: false }) seats: readonly MarketSeatOption[] = [];
  @property({ attribute: false }) market: MarketState | null = null;

  @state() private announcement = "";
  private intervalId: number | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.intervalId = window.setInterval(() => {
      this.announceNow();
    }, AUTO_ANNOUNCE_INTERVAL_MS);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Clears the live region first so a repeat announcement (the market
   * hasn't moved since the last read) still fires — a `polite` region only
   * speaks on a text CHANGE, not a re-render with identical content.
   */
  private announceNow(): void {
    const market = this.market;
    if (market === null) return;
    const rows = marketRows(this.seats, market);
    const summary =
      rows.length === 0
        ? "No seats to trade."
        : `Current prices: ${rows.map((row) => `${row.displayName} ${row.price.toFixed(1)}`).join(", ")}.`;
    this.announcement = "";
    requestAnimationFrame(() => {
      this.announcement = summary;
    });
  }

  render() {
    return html`
      <div class="flex items-center justify-end">
        <button
          type="button"
          @click=${() => this.announceNow()}
          class="rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-muted underline decoration-dotted underline-offset-2 outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
        >
          Read current prices
        </button>
      </div>
      <div class="sr-only" role="status" aria-live="polite">${this.announcement}</div>
    `;
  }
}
