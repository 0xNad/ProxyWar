import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type {
  ReplayPremiereCheckpointView,
  ReplayPremiereOverlayCallbacks,
  ReplayPremiereOverlayHandle,
  ReplayPremiereOverlayModel,
} from "src/client/ReplayPremiereOverlay";
import "../components/MarketBankrollBadge";
import "../components/MarketPriceBoard";
import "../components/MarketSettlementPanel";
import "../components/PositionsPanel";
import "../components/TradeTicket";
import { settlementForSeat } from "../serviceMapping";
import type { MarketSeatOption, MarketState, TradeSide } from "../types";
import { MIN_STAKE } from "src/prediction/types";

/**
 * The dedicated betting premiere's own overlay — NOT `ReplayPremiereOverlay`.
 * Reuses the premiere runtime's session/lifecycle/integrity machinery via
 * `ReplayPremiereRuntimeController`'s `overlayFactory` seam (see
 * `BettingPremierePage.ts`); this module owns only what's on screen.
 * Market/position/settlement/bankroll data does not travel through
 * `ReplayPremiereOverlayModel` (that public view intentionally has no
 * market fields — it also backs the untouched `ReplayPremiereOverlay`), so
 * the page controller feeds it in on the side via `market`/`bankroll`.
 * Trading is ONE continuous LMSR market for the whole premiere, open for
 * the ENTIRE live phase of the match (not gated to a checkpoint window —
 * per operator override, checkpoints are content beats the UI highlights,
 * they gate nothing). `windowOpen` reflects whether the premiere itself is
 * currently live, not any particular checkpoint's own state.
 */
@customElement("premiere-betting-overlay")
export class PremiereBettingOverlay extends LitElement {
  @property({ attribute: false }) model!: ReplayPremiereOverlayModel;
  @property({ attribute: false }) callbacks: ReplayPremiereOverlayCallbacks =
    {};
  @property({ attribute: false }) market: MarketState | null = null;
  @property({ type: Number }) bankroll: number | null = null;
  @property({ type: String, attribute: "market-load-error" })
  marketLoadError: string | null = null;
  @property({ attribute: false }) onTrade?: (
    seatId: string,
    side: TradeSide,
    amount: number,
    limitPrice: number,
  ) => Promise<void>;

  createRenderRoot() {
    return this;
  }

  /**
   * Trading isn't gated by any checkpoint window, but a trade still needs
   * SOME checkpoint id to tag as its nearest content beat (for audit/
   * display) — the earliest one not yet resolved, falling back to the
   * active one if the model happens to have it set.
   */
  private nearestUnresolvedCheckpoint(): ReplayPremiereCheckpointView | null {
    const activeId = this.model.activeCheckpointId;
    const active =
      activeId === null || activeId === undefined
        ? undefined
        : this.model.checkpoints.find((c) => c.id === activeId);
    if (active !== undefined) return active;
    const unresolved = [...this.model.checkpoints]
      .filter((c) => c.state !== "closed")
      .sort((a, b) => a.sequence - b.sequence);
    return unresolved[0] ?? this.model.checkpoints[0] ?? null;
  }

  /**
   * Every seat in the match — sourced from the policy roster, not
   * `checkpoints[].options` (that list stays empty until a checkpoint's
   * prediction window opens; continuous LMSR trading isn't gated to one).
   */
  private allSeats(): readonly MarketSeatOption[] {
    return this.model.policies.map((policy) => ({
      seatId: policy.seatId,
      displayName: policy.displayName,
    }));
  }

  private renderHeader() {
    const model = this.model;
    const live = model.state === "playing" || model.state === "checkpoint";
    return html`
      <header
        class="flex flex-col gap-1 border-b border-line bg-surface/95 px-4 py-3"
      >
        <div class="flex items-center justify-between gap-2">
          <h2 class="truncate text-base font-bold text-ink">${model.title}</h2>
          ${live
            ? html`<span
                class="inline-flex shrink-0 items-center gap-1 rounded-full bg-live/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-live"
              >
                <span
                  class="h-1.5 w-1.5 animate-pulse rounded-full bg-live"
                ></span>
                Live
              </span>`
            : nothing}
        </div>
        <p class="text-xs text-ink-muted">
          ${model.mapName} · ${model.matchFormat}
        </p>
      </header>
    `;
  }

  private renderBody() {
    switch (this.model.state) {
      case "scheduled":
        return html`
          <div class="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <p class="text-sm text-ink-dim">The market opens when this premiere starts.</p>
            <p class="text-xs text-ink-muted">
              Scheduled for ${new Date(this.model.scheduledAt).toLocaleString()}
            </p>
          </div>
        `;
      case "playing":
      case "checkpoint":
        return this.renderMarket();
      case "revealed":
      case "archived":
        return this.renderSettlement();
      case "failed":
        return html`
          <div class="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center" role="alert">
            <p class="text-sm font-semibold text-danger">This premiere could not continue.</p>
            <p class="text-xs text-ink-muted">Any open positions were voided and refunded.</p>
          </div>
        `;
      case "cancelled":
        return html`
          <div class="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <p class="text-sm font-semibold text-ink">This premiere was cancelled.</p>
            <p class="text-xs text-ink-muted">Any open positions were voided and refunded.</p>
          </div>
        `;
      default:
        return nothing;
    }
  }

  private renderMarket() {
    const view = this.nearestUnresolvedCheckpoint();
    const seats = this.allSeats();
    // Trading is live for the whole "playing"/"checkpoint" phase — a
    // checkpoint window opening/closing is a content beat, not a trading
    // gate (operator override: no pause, continuous book for the match).
    const windowOpen =
      this.model.state === "playing" || this.model.state === "checkpoint";
    return html`
      <div class="flex flex-col gap-3 px-4 py-4">
        ${view !== null
          ? html`<p class="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Next checkpoint: ${view.sequence}
            </p>`
          : nothing}
        <premiere-market-price-board
          .seats=${seats}
          .market=${this.market}
        ></premiere-market-price-board>
        <premiere-trade-ticket
          .seats=${seats}
          .market=${this.market}
          ?window-open=${windowOpen}
          .bankroll=${this.bankroll}
          ?loading=${this.market === null && this.marketLoadError === null}
          load-error=${this.marketLoadError ?? nothing}
          .onTrade=${(seatId: string, side: TradeSide, amount: number, limitPrice: number) =>
            this.onTrade?.(seatId, side, amount, limitPrice) ?? Promise.resolve()}
        ></premiere-trade-ticket>
        <premiere-positions-panel
          .seats=${seats}
          .market=${this.market}
        ></premiere-positions-panel>
      </div>
    `;
  }

  private renderSettlement() {
    const reveal = this.model.reveal;
    const seats = this.allSeats();
    const market = this.market;
    return html`
      <div class="flex flex-col gap-4 px-4 py-4">
        ${reveal !== null && reveal !== undefined
          ? html`
              <p class="text-sm text-ink">
                ${reveal.outcome === "winner"
                  ? html`Winner: <strong>${this.seatLabel(reveal.winnerSeatId ?? null)}</strong>`
                  : "Voided — no winner declared."}
              </p>
            `
          : nothing}
        <premiere-market-price-board
          .seats=${seats}
          .market=${market}
          frozen
        ></premiere-market-price-board>
        ${market !== null
          ? html`<div class="flex flex-col gap-2">
              ${seats.map((seat) => {
                const settlement = settlementForSeat(market, seat.seatId);
                return settlement === null
                  ? nothing
                  : html`<premiere-market-settlement
                      .settlement=${settlement}
                      seat-label=${seat.displayName}
                    ></premiere-market-settlement>`;
              })}
            </div>`
          : nothing}
      </div>
    `;
  }

  private seatLabel(seatId: string | null): string {
    if (seatId === null) return "";
    const policy = this.model.policies.find((p) => p.seatId === seatId);
    return policy?.displayName ?? seatId;
  }

  render() {
    if (this.model === undefined) {
      return html`
        <div class="flex flex-1 items-center justify-center px-4 py-10 text-sm text-ink-muted" role="status">
          Loading premiere…
        </div>
      `;
    }
    return html`
      <aside
        class="fixed inset-x-0 bottom-0 z-[52000] flex max-h-[75vh] flex-col overflow-y-auto rounded-t-xl border-t border-line bg-surface shadow-2xl lg:inset-y-0 lg:right-0 lg:left-auto lg:max-h-none lg:h-full lg:w-[420px] lg:rounded-none lg:border-t-0 lg:border-l"
        role="complementary"
        aria-label="Premiere market"
      >
        ${this.renderHeader()}
        <div class="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
          <span class="text-xs text-ink-muted">Your bankroll</span>
          <premiere-market-bankroll-badge
            .bankroll=${this.bankroll}
            min-stake=${MIN_STAKE}
          ></premiere-market-bankroll-badge>
        </div>
        ${this.renderBody()}
      </aside>
    `;
  }
}

/**
 * `ReplayPremiereRuntimeController`-compatible overlay factory. Matches
 * `typeof mountReplayPremiereOverlay`'s exact signature so it drops into
 * `dependencies.overlayFactory` — the runtime keeps driving session
 * bootstrap, heartbeat, playback pacing and the sealed checkpoint window;
 * only what renders on screen changes.
 */
export function mountBettingOverlay(
  initialModel: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks = {},
): ReplayPremiereOverlayHandle {
  const host = document.createElement(
    "premiere-betting-overlay",
  ) as PremiereBettingOverlay;
  host.model = initialModel;
  host.callbacks = callbacks;
  document.body.appendChild(host);
  return {
    element: host,
    hydrate(nextModel: ReplayPremiereOverlayModel) {
      host.model = nextModel;
    },
    dispose() {
      host.remove();
    },
  };
}
