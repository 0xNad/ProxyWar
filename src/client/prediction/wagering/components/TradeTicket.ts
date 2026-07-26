import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { MIN_STAKE, maxStake } from "src/prediction/types";
import { quoteBuy, quoteSell } from "../marketMath";
import { validateBuyDraft, validateSellDraft } from "../validate";
import type { MarketSeatOption, MarketState, TradeSide } from "../types";
import "./MarketBankrollBadge";

/**
 * The trade ticket: pick a seat, pick buy or sell, enter an amount, see the
 * live quote (shares/avg price/where the book moves to) before submitting.
 * Buy amount is a chip BUDGET (server fills the largest whole-share count
 * that budget affords); sell amount is an exact SHARE count. A `limitPrice`
 * is derived from the quote and sent with every order — the crowd trades
 * the same live book, so the price can move between quote and fill; the
 * server fills or rejects the whole order rather than filling worse.
 * Submit is disabled while in flight so rapid clicks cannot double-apply.
 */
@customElement("premiere-trade-ticket")
export class PremiereTradeTicket extends LitElement {
  @property({ attribute: false }) seats: readonly MarketSeatOption[] = [];
  /** `null` while the market hasn't loaded yet. */
  @property({ attribute: false }) market: MarketState | null = null;
  @property({ type: Boolean, attribute: "window-open" }) windowOpen = false;
  /** `null` while the session bankroll hasn't loaded. */
  @property({ type: Number }) bankroll: number | null = null;
  @property({ type: Boolean }) loading = false;
  /** External load failure (e.g. the market poll itself failed). */
  @property({ type: String, attribute: "load-error" }) loadError: string | null =
    null;
  @property({ attribute: false }) onTrade?: (
    seatId: string,
    side: TradeSide,
    amount: number,
    limitPrice: number,
  ) => Promise<void>;

  @state() private draftSeatId: string | null = null;
  @state() private draftSide: TradeSide = "buy";
  @state() private draftAmountText = "";
  @state() private submitting = false;
  @state() private submitError: string | null = null;

  createRenderRoot() {
    return this;
  }

  private heldShares(seatId: string): number {
    return (
      this.market?.positions?.find((p) => p.seatId === seatId)?.shares ?? 0
    );
  }

  private async handleSubmit(): Promise<void> {
    if (this.submitting) return;
    const seatId = this.draftSeatId;
    const market = this.market;
    const validation =
      this.draftSide === "buy"
        ? validateBuyDraft({
            seatId,
            budgetText: this.draftAmountText,
            bankroll: this.bankroll ?? 0,
            windowOpen: this.windowOpen,
            market,
          })
        : validateSellDraft({
            seatId,
            sharesText: this.draftAmountText,
            heldShares: seatId === null ? 0 : this.heldShares(seatId),
            windowOpen: this.windowOpen,
          });
    if (!validation.ok) {
      this.submitError = validation.message;
      return;
    }
    // Validation passing guarantees seatId and (for a buy) market are set.
    if (seatId === null || market === null) return;
    const amount = Number(this.draftAmountText.trim());
    const quote =
      this.draftSide === "buy"
        ? quoteBuy(market, seatId, amount)
        : quoteSell(market, seatId, amount);
    if (quote === null) {
      this.submitError = "That amount doesn't buy a whole share at this price.";
      return;
    }
    this.submitting = true;
    this.submitError = null;
    try {
      await this.onTrade?.(seatId, this.draftSide, amount, quote.suggestedLimitPrice);
      this.draftAmountText = "";
    } catch (error) {
      this.submitError =
        error instanceof Error ? error.message : "Order failed. Try again.";
    } finally {
      this.submitting = false;
    }
  }

  private renderQuote(seatId: string, market: MarketState) {
    const trimmed = this.draftAmountText.trim();
    if (trimmed === "" || !/^\d+$/.test(trimmed)) return nothing;
    const amount = Number(trimmed);
    const quote =
      this.draftSide === "buy"
        ? quoteBuy(market, seatId, amount)
        : quoteSell(market, seatId, amount);
    if (quote === null) {
      return html`<p class="text-xs text-caution">
        ${this.draftSide === "buy"
          ? "That budget doesn't buy a whole share yet."
          : "Enter a share count you hold."}
      </p>`;
    }
    const seatLabel =
      this.seats.find((seat) => seat.seatId === seatId)?.displayName ?? "";
    const nextPrice = quote.pricesAfter[seatId] ?? 0;
    return html`
      <div class="flex flex-col gap-1 rounded-md bg-surface-3 px-3 py-2 text-xs text-ink-muted">
        <p>
          ${this.draftSide === "buy" ? "Buy" : "Sell"}
          <span class="font-semibold text-ink">${quote.shares} sh</span> of
          <span class="font-semibold text-ink">${seatLabel}</span> for
          <span class="font-semibold tabular-nums text-ink"
            >${quote.chips.toLocaleString()} cr</span
          >
          (avg ${quote.avgPrice.toFixed(1)})
        </p>
        <p>
          Price moves to
          <span class="font-semibold tabular-nums text-ink">${nextPrice.toFixed(1)}</span>
          · limit sent
          <span class="font-semibold tabular-nums text-ink">${quote.suggestedLimitPrice}</span>
        </p>
      </div>
    `;
  }

  private renderForm() {
    const market = this.market;
    const seatId = this.draftSeatId;
    const bankroll = this.bankroll ?? 0;
    const quickAmounts =
      this.draftSide === "buy"
        ? [MIN_STAKE, 50, 100, maxStake(bankroll)]
        : seatId !== null
          ? [this.heldShares(seatId)]
          : [];
    return html`
      <div class="flex flex-col gap-3">
        <div class="flex overflow-hidden rounded-md border border-line">
          ${(["buy", "sell"] as const).map(
            (side) => html`
              <button
                type="button"
                @click=${() => {
                  this.draftSide = side;
                  this.submitError = null;
                }}
                class="flex-1 px-3 py-1.5 text-sm font-semibold capitalize ${this
                  .draftSide === side
                  ? side === "buy"
                    ? "bg-positive/20 text-positive"
                    : "bg-danger/20 text-danger"
                  : "bg-surface-2 text-ink-muted hover:bg-surface-3"}"
              >
                ${side}
              </button>
            `,
          )}
        </div>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">
          Seat
          <select
            class="rounded-md border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink"
            .value=${seatId ?? ""}
            @change=${(event: Event) => {
              const value = (event.target as HTMLSelectElement).value;
              this.draftSeatId = value === "" ? null : value;
              this.submitError = null;
            }}
          >
            <option value="">Choose a seat…</option>
            ${this.seats.map(
              (seat) =>
                html`<option value=${seat.seatId}>${seat.displayName}</option>`,
            )}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">
          ${this.draftSide === "buy" ? "Budget (chips)" : "Shares"}
          <input
            type="number"
            inputmode="numeric"
            min="1"
            step="1"
            .value=${this.draftAmountText}
            @input=${(event: Event) => {
              this.draftAmountText = (event.target as HTMLInputElement).value;
              this.submitError = null;
            }}
            class="rounded-md border border-line bg-surface-2 px-3 py-1.5 font-mono tabular-nums text-ink outline-none focus:border-accent"
          />
        </label>
        <div class="flex flex-wrap gap-1.5">
          ${quickAmounts
            .filter((amount) => amount > 0)
            .map(
              (amount) => html`
                <button
                  type="button"
                  @click=${() => {
                    this.draftAmountText = String(amount);
                    this.submitError = null;
                  }}
                  class="rounded bg-surface-3 px-2 py-1 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink"
                >
                  ${amount.toLocaleString()}
                </button>
              `,
            )}
        </div>
        ${seatId !== null && market !== null
          ? this.renderQuote(seatId, market)
          : nothing}
        ${this.submitError !== null
          ? html`<p class="text-xs text-danger" role="alert">${this.submitError}</p>`
          : nothing}
        <button
          type="button"
          @click=${() => void this.handleSubmit()}
          ?disabled=${this.submitting}
          class="w-full rounded-md px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${this
            .draftSide === "buy"
            ? "bg-positive/25 text-positive hover:bg-positive/35"
            : "bg-danger/25 text-danger hover:bg-danger/35"}"
        >
          ${this.submitting
            ? "Submitting…"
            : this.draftSide === "buy"
              ? "Buy shares"
              : "Sell shares"}
        </button>
      </div>
    `;
  }

  render() {
    if (this.loading) {
      return html`
        <div
          class="flex items-center justify-center rounded-lg border border-line bg-surface-2 px-4 py-6 text-sm text-ink-muted"
          role="status"
        >
          Loading market…
        </div>
      `;
    }
    if (this.loadError !== null) {
      return html`
        <div
          class="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
          role="alert"
        >
          ${this.loadError}
        </div>
      `;
    }
    return html`
      <div class="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Trade
          </h3>
          <premiere-market-bankroll-badge
            .bankroll=${this.bankroll}
            min-stake=${MIN_STAKE}
          ></premiere-market-bankroll-badge>
        </div>
        ${this.windowOpen
          ? this.renderForm()
          : html`<p class="text-sm text-ink-muted">
              Trading is closed until the next checkpoint opens.
            </p>`}
      </div>
    `;
  }
}
