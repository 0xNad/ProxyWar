import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { createRef, ref, type Ref } from "lit/directives/ref.js";
import { ReplayPremiereServiceError } from "src/client/ReplayPremiereRuntime";
import { MIN_STAKE, maxStake } from "src/prediction/types";
import { quoteBuy, quoteSell, type TradeQuote } from "../marketMath";
import { validateBuyDraft, validateSellDraft } from "../validate";
import type { MarketSeatOption, MarketState, TradeSide } from "../types";
import "./MarketBankrollBadge";

/**
 * Maps a rejected/failed order into a sentence a trader can act on. The
 * wire only ever exposes a coarse `publicCode` + HTTP status for a
 * rejected order — the server's specific reason (e.g. "slippage exceeded"
 * vs "invalid amount") is deliberately never sent to the client (see
 * `ReplayPremiereRuntime.ts`) — so this keys off what's actually
 * observable instead of echoing the internal code string.
 */
function describeTradeError(error: unknown): string {
  if (!(error instanceof ReplayPremiereServiceError)) {
    return "Order failed. Try again.";
  }
  if (error.publicCode === "PREMIERE_CAPACITY_EXCEEDED") {
    return "The market is at capacity right now. Try again in a moment.";
  }
  if (error.publicCode === "PREMIERE_UNAVAILABLE") {
    return "The market is temporarily unavailable. Try again shortly.";
  }
  switch (error.status) {
    case 400:
      return "That order was rejected — the price likely moved past your limit, or the amount wasn't valid. Adjust it and try again.";
    case 404:
      return "This market couldn't be found. Reload the page.";
    case 409:
      return "That order conflicts with what's already happened in the market. Try again.";
    case 410:
      return "The market moved on since your last update — try again, the price will refresh automatically.";
    case 429:
      return "Too many requests right now. Wait a moment and try again.";
  }
  if (error.code === "request_failed") {
    return "Couldn't reach the market. Check your connection and try again.";
  }
  if (error.code === "session_required" || error.code === "disposed") {
    return "Your trading session isn't active. Reload the page to reconnect.";
  }
  return "Order failed. Try again.";
}

/**
 * Price-point movement (0..100 scale) since a draft's quote was first
 * shown past which the preview is unmistakably stale — a continuously
 * trading crowd means the quote can drift either favourably or
 * unfavourably between when it renders and when a click lands; this is
 * the threshold past which we stop trusting the viewer to notice on
 * their own and say so explicitly.
 */
const QUOTE_STALE_THRESHOLD = 1.5;

/**
 * The trade ticket: pick a seat, pick buy or sell, enter an amount, see the
 * live quote (shares/avg price/where the book moves to) before submitting.
 * Buy amount is a chip BUDGET (server fills the largest whole-share count
 * that budget affords); sell amount is an exact SHARE count. A `limitPrice`
 * is derived from the quote and sent with every order — the crowd trades
 * the same live book, so the price can move between quote and fill; the
 * server fills or rejects the whole order rather than filling worse. The
 * submit button's own label states the exact cost/proceeds — "what you'll
 * pay" is answered before the click, not after. Submit is disabled while
 * in flight so rapid clicks cannot double-apply.
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
  private submitButtonRef: Ref<HTMLButtonElement> = createRef();
  /** Seat's price the moment the current (seat, side, amount) draft was set — the quote's own baseline, not the match's. */
  @state() private quoteBaselinePrice: number | null = null;
  private draftKeyTracked: string | null = null;

  createRenderRoot() {
    return this;
  }

  willUpdate(): void {
    const seatId = this.draftSeatId;
    const key = `${seatId}|${this.draftSide}|${this.draftAmountText.trim()}`;
    if (key !== this.draftKeyTracked) {
      this.draftKeyTracked = key;
      this.quoteBaselinePrice = seatId !== null ? this.market?.prices[seatId] ?? null : null;
    }
  }

  private heldShares(seatId: string): number {
    return (
      this.market?.positions?.find((p) => p.seatId === seatId)?.shares ?? 0
    );
  }

  /** The quote for the CURRENT draft (seat/side/amount), or `null` if it isn't a valid tradeable amount yet. */
  private currentQuote(): TradeQuote | null {
    const seatId = this.draftSeatId;
    const market = this.market;
    const trimmed = this.draftAmountText.trim();
    if (seatId === null || market === null || trimmed === "" || !/^\d+$/.test(trimmed)) {
      return null;
    }
    const amount = Number(trimmed);
    return this.draftSide === "buy"
      ? quoteBuy(market, seatId, amount)
      : quoteSell(market, seatId, amount);
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
      this.submitError = describeTradeError(error);
    } finally {
      this.submitting = false;
      // Submitting disables this button while in flight; disabling the
      // element that currently holds focus throws focus to `<body>` (a
      // keyboard user then has to re-tab from the top of the page to find
      // out what happened — confirmed this does NOT occur on ordinary
      // price-tick re-renders, only here). Re-enabling and refocusing it —
      // success or failure — keeps the keyboard user exactly where the
      // action they just took happened, right next to the outcome (a
      // fresh quote, or the `role="alert"` rejection message).
      await this.updateComplete;
      this.submitButtonRef.value?.focus();
    }
  }

  private renderQuote(seatId: string, quote: TradeQuote | null) {
    const trimmed = this.draftAmountText.trim();
    if (trimmed === "" || !/^\d+$/.test(trimmed)) return nothing;
    if (quote === null) {
      return html`<p class="text-xs text-caution">
        ${this.draftSide === "buy"
          ? "That budget doesn't buy a whole share yet."
          : "Enter a share count you hold."}
      </p>`;
    }
    const seatLabel = this.seats.find((seat) => seat.seatId === seatId)?.displayName ?? "";
    const currentPrice = this.market?.prices[seatId] ?? 0;
    const nextPrice = quote.pricesAfter[seatId] ?? 0;
    const priceMoved =
      this.quoteBaselinePrice !== null &&
      Math.abs(currentPrice - this.quoteBaselinePrice) > QUOTE_STALE_THRESHOLD;
    return html`
      <div class="flex flex-col gap-2">
        ${priceMoved
          ? html`<p
              class="flex items-center gap-1.5 rounded-md border border-caution/40 bg-caution/10 px-2.5 py-1.5 text-xs font-medium text-caution"
              role="status"
            >
              <span aria-hidden="true">⚠</span>
              Price moved since you set this order — the numbers below have already updated, review before submitting.
            </p>`
          : nothing}
        <div
          class="flex flex-col gap-2 rounded-lg border border-line-strong bg-surface-3 px-3 py-3"
          aria-live="polite"
        >
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-ink-muted"
              >${this.draftSide === "buy" ? "You pay" : "You receive"}</span
            >
            <span class="font-mono text-xl font-bold tabular-nums text-ink"
              >${quote.chips.toLocaleString()} cr</span
            >
          </div>
          <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-ink-muted">
            <span
              >${quote.shares} sh of <span class="font-semibold text-ink">${seatLabel}</span> @ avg
              ${quote.avgPrice.toFixed(1)}%</span
            >
            <span class="flex items-center gap-1 font-mono tabular-nums">
              ${currentPrice.toFixed(1)}%
              <span aria-hidden="true" class="text-ink-muted">→</span>
              <span class="font-semibold text-ink">${nextPrice.toFixed(1)}%</span>
            </span>
          </div>
          <p class="text-[11px] leading-snug text-ink-muted">
            ${this.draftSide === "buy"
              ? "Preview only — a budget order buys as many whole shares as it affords the instant it fills. The share count above can end up higher or lower than this if the price moves first."
              : "Preview only — the credit above is what these shares are worth right now. The instant-of-fill price decides the actual payout."}
          </p>
        </div>
      </div>
    `;
  }

  private renderSeatPicker() {
    const seatId = this.draftSeatId;
    const prices = this.market?.prices ?? {};
    return html`
      <div class="flex flex-col gap-1 text-xs text-ink-muted">
        <span id="trade-seat-label">Seat</span>
        <div
          role="group"
          aria-labelledby="trade-seat-label"
          class="grid grid-cols-2 gap-1.5 sm:grid-cols-3"
        >
          ${this.seats.map((seat) => {
            const selected = seatId === seat.seatId;
            const price = prices[seat.seatId];
            return html`
              <button
                type="button"
                aria-pressed=${selected}
                @click=${() => {
                  this.draftSeatId = seat.seatId;
                  this.submitError = null;
                }}
                class="flex items-center justify-between gap-1.5 rounded-md border px-2.5 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent ${selected
                  ? "border-accent bg-accent/15 text-ink"
                  : "border-line bg-surface-2 text-ink-dim hover:border-line-strong hover:bg-surface-3 hover:text-ink"}"
              >
                <span class="truncate">${seat.displayName}</span>
                ${price !== undefined
                  ? html`<span class="shrink-0 font-mono text-xs tabular-nums text-ink-muted"
                      >${price.toFixed(1)}%</span
                    >`
                  : nothing}
              </button>
            `;
          })}
        </div>
      </div>
    `;
  }

  private renderForm() {
    const seatId = this.draftSeatId;
    const bankroll = this.bankroll ?? 0;
    const quote = this.currentQuote();
    const quickAmounts =
      this.draftSide === "buy"
        ? [MIN_STAKE, 50, 100, maxStake(bankroll)]
        : seatId !== null
          ? [this.heldShares(seatId)]
          : [];
    const submitLabel =
      quote !== null
        ? this.draftSide === "buy"
          ? `Buy ~${quote.shares} sh for ~${quote.chips.toLocaleString()} cr`
          : `Sell ${quote.shares} sh for ~${quote.chips.toLocaleString()} cr`
        : this.draftSide === "buy"
          ? "Buy shares"
          : "Sell shares";
    return html`
      <div class="flex flex-col gap-3">
        <div class="flex overflow-hidden rounded-md border border-line">
          ${(["buy", "sell"] as const).map(
            (side) => html`
              <button
                type="button"
                aria-pressed=${this.draftSide === side}
                @click=${() => {
                  this.draftSide = side;
                  this.submitError = null;
                }}
                class="flex-1 px-3 py-1.5 text-sm font-semibold capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent ${this
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
        ${this.renderSeatPicker()}
        <label for="trade-amount-input" class="flex flex-col gap-1 text-xs text-ink-muted">
          ${this.draftSide === "buy" ? "Budget (chips)" : "Shares"}
          <div class="relative">
            <input
              id="trade-amount-input"
              type="number"
              inputmode="numeric"
              min="1"
              step="1"
              .value=${this.draftAmountText}
              @input=${(event: Event) => {
                this.draftAmountText = (event.target as HTMLInputElement).value;
                this.submitError = null;
              }}
              class="w-full rounded-md border border-line bg-surface-2 px-3 py-1.5 pr-9 font-mono text-base tabular-nums text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent"
            />
            <span
              aria-hidden="true"
              class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-ink-muted"
              >${this.draftSide === "buy" ? "cr" : "sh"}</span
            >
          </div>
        </label>
        <div class="flex flex-wrap gap-1.5">
          ${quickAmounts
            .filter((amount) => amount > 0)
            .map((amount) => {
              const active = this.draftAmountText.trim() === String(amount);
              return html`
                <button
                  type="button"
                  @click=${() => {
                    this.draftAmountText = String(amount);
                    this.submitError = null;
                  }}
                  class="rounded-full border px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent ${active
                    ? "border-accent bg-accent/15 text-ink"
                    : "border-line bg-surface-3 text-ink-muted hover:bg-surface-2 hover:text-ink"}"
                >
                  ${amount.toLocaleString()}
                </button>
              `;
            })}
        </div>
        ${seatId !== null ? this.renderQuote(seatId, quote) : nothing}
        ${this.submitError !== null
          ? html`<p class="text-xs text-danger" role="alert">${this.submitError}</p>`
          : nothing}
        <button
          type="button"
          ${ref(this.submitButtonRef)}
          @click=${() => void this.handleSubmit()}
          ?disabled=${this.submitting}
          class="w-full rounded-md px-3 py-2.5 text-sm font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 ${this
            .draftSide === "buy"
            ? "bg-positive/25 text-positive hover:bg-positive/35"
            : "bg-danger/25 text-danger hover:bg-danger/35"}"
        >
          ${this.submitting ? "Submitting…" : submitLabel}
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
