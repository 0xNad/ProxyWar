import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { MarketSettlement } from "../types";

type Outcome = "won" | "lost" | "void";

/**
 * Post-settlement view for one seat the viewer held: final shares, cost
 * basis, whether the market paid out, the payout, and the bankroll delta.
 * Winning and losing are deliberately asymmetric: a win gets a large,
 * saturated, bordered card that visibly "arrives" (a brief fade/rise on
 * first paint); a loss gets a quieter, smaller-scale acknowledgement.
 * Treating both the same would flatten the one moment the whole session
 * built toward.
 */
@customElement("premiere-market-settlement")
export class PremiereMarketSettlement extends LitElement {
  @property({ attribute: false }) settlement: MarketSettlement | null = null;
  @property({ type: String, attribute: "seat-label" }) seatLabel = "";

  /** Drives the entrance transition — false on first paint, true one frame later. */
  @state() private landed = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    requestAnimationFrame(() => {
      this.landed = true;
    });
  }

  render() {
    const settlement = this.settlement;
    if (settlement === null) {
      return html`
        <p class="text-sm text-ink-muted">You held no position on this seat.</p>
      `;
    }
    const outcome: Outcome =
      settlement.outcome.kind === "void" ? "void" : settlement.payout > 0 ? "won" : "lost";

    const transitionClass = `transition-all duration-500 ease-out motion-reduce:transition-none ${
      this.landed ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
    }`;

    if (outcome === "won") {
      return html`
        <div
          class="flex flex-col gap-2 rounded-lg border border-positive/50 bg-positive/12 px-4 py-4 shadow-[0_0_0_1px_rgba(52,211,153,0.08)] ${transitionClass}"
          aria-label="Market settlement"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="flex items-center gap-2 text-base font-bold text-positive">
              <span aria-hidden="true">▲</span>
              Won
            </span>
            <span class="text-xs text-ink-muted">${this.heldLine(settlement)}</span>
          </div>
          <div class="flex items-baseline gap-2">
            <span class="font-mono text-3xl font-extrabold tabular-nums text-positive"
              >+${settlement.bankrollDelta.toLocaleString()}</span
            >
            <span class="text-sm font-semibold text-positive/80">cr</span>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
            <span>Cost basis: ${settlement.costBasis.toLocaleString()} cr</span>
            <span>Payout: <span class="font-semibold tabular-nums text-ink">${settlement.payout.toLocaleString()} cr</span></span>
          </div>
        </div>
      `;
    }

    if (outcome === "lost") {
      return html`
        <div
          class="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 px-4 py-3 ${transitionClass}"
          aria-label="Market settlement"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="flex items-center gap-1.5 text-sm font-semibold text-ink-dim">
              <span aria-hidden="true" class="text-danger">▼</span>
              Lost
            </span>
            <span class="text-xs text-ink-muted">${this.heldLine(settlement)}</span>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span class="text-ink-muted">Cost basis: ${settlement.costBasis.toLocaleString()} cr</span>
            <span class="font-mono font-semibold tabular-nums text-danger"
              >${settlement.bankrollDelta.toLocaleString()} cr</span
            >
          </div>
        </div>
      `;
    }

    return html`
      <div
        class="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 px-4 py-3 ${transitionClass}"
        aria-label="Market settlement"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-sm text-ink">${this.heldLine(settlement)}</span>
          <span class="rounded-full bg-caution/15 px-2 py-0.5 text-xs font-semibold text-caution"
            >Void — refunded</span
          >
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span class="text-ink-muted">Cost basis: ${settlement.costBasis.toLocaleString()} cr</span>
          <span class="font-semibold tabular-nums text-ink"
            >Payout: ${settlement.payout.toLocaleString()} cr</span
          >
        </div>
        ${settlement.outcome.kind === "void"
          ? html`<p class="text-xs text-ink-muted">
              Voided (${settlement.outcome.reason.replace(/_/g, " ")}) — your cost basis was
              refunded in full.
            </p>`
          : nothing}
      </div>
    `;
  }

  private heldLine(settlement: MarketSettlement): string {
    const of = this.seatLabel !== "" ? ` of ${this.seatLabel}` : "";
    return `Held ${settlement.finalShares} sh${of}`;
  }
}
