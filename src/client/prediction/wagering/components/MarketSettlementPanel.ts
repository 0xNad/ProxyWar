import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { MarketSettlement } from "../types";

const OUTCOME_LABEL: Record<"won" | "lost" | "void", string> = {
  won: "Won",
  lost: "Lost",
  void: "Void — refunded",
};

const OUTCOME_CLASS: Record<"won" | "lost" | "void", string> = {
  won: "bg-positive/15 text-positive",
  lost: "bg-danger/15 text-danger",
  void: "bg-caution/15 text-caution",
};

/**
 * Post-settlement view for one seat the viewer held: final shares, cost
 * basis, whether the market paid out, the payout, and the bankroll delta.
 * Mirrors the standalone prediction page's `prediction-resolution-panel`
 * styling conventions for the same "outcome badge + bankroll delta" shape.
 */
@customElement("premiere-market-settlement")
export class PremiereMarketSettlement extends LitElement {
  @property({ attribute: false }) settlement: MarketSettlement | null = null;
  @property({ type: String, attribute: "seat-label" }) seatLabel = "";

  createRenderRoot() {
    return this;
  }

  render() {
    const settlement = this.settlement;
    if (settlement === null) {
      return html`
        <p class="text-sm text-ink-muted">You held no position on this seat.</p>
      `;
    }
    const outcome: "won" | "lost" | "void" =
      settlement.outcome.kind === "void"
        ? "void"
        : settlement.payout > 0
          ? "won"
          : "lost";
    return html`
      <div
        class="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 px-4 py-3"
        aria-label="Market settlement"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-sm text-ink">
            Held
            <span class="font-semibold tabular-nums">${settlement.finalShares} sh</span>
            ${this.seatLabel !== ""
              ? html`of <span class="font-semibold">${this.seatLabel}</span>`
              : nothing}
          </span>
          <span
            class="rounded-full px-2 py-0.5 text-xs font-semibold ${OUTCOME_CLASS[outcome]}"
            >${OUTCOME_LABEL[outcome]}</span
          >
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span class="text-ink-muted"
            >Cost basis: ${settlement.costBasis.toLocaleString()} cr</span
          >
          <span class="text-ink-muted"
            >Payout: <span class="font-semibold tabular-nums text-ink"
              >${settlement.payout.toLocaleString()} cr</span
            ></span
          >
          <span
            class="font-semibold tabular-nums ${settlement.bankrollDelta >= 0
              ? "text-positive"
              : "text-danger"}"
            >${settlement.bankrollDelta >= 0 ? "+" : ""}${settlement.bankrollDelta.toLocaleString()}
            cr</span
          >
        </div>
        ${settlement.outcome.kind === "void"
          ? html`<p class="text-xs text-ink-muted">
              Voided (${settlement.outcome.reason.replace(/_/g, " ")}) — your
              cost basis was refunded in full.
            </p>`
          : nothing}
      </div>
    `;
  }
}
