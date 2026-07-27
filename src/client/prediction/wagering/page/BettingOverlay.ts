import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  ReplayPremiereOverlayCallbacks,
  ReplayPremiereOverlayHandle,
  ReplayPremiereOverlayModel,
  ReplayPremierePublicState,
} from "src/client/ReplayPremiereOverlay";
import "../components/MarketBankrollBadge";
import "../components/MarketPriceBoard";
import "../components/PriceAnnouncer";
import "../components/MarketPositionSummary";
import "../components/MarketSettlementPanel";
import "../components/PositionsPanel";
import "../components/TradeTicket";
import { formatSignedCredits } from "../components/pnlDisplay";
import { settlementForSeat } from "../serviceMapping";
import type { MarketSeatOption, MarketState, TradeSide } from "../types";
import { MIN_STAKE } from "src/prediction/types";

/** Live states where the replay is actually on screen behind the sheet. */
const LIVE_STATES: ReadonlySet<ReplayPremierePublicState> = new Set(["playing", "checkpoint"]);

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
 *
 * On narrow viewports this is a bottom sheet over the replay, so it
 * defaults to a COLLAPSED peek strip (title + live P&L) while the match is
 * actually playing — the replay is the content, not the trading UI — and
 * expands on tap. It defaults OPEN for every other state (scheduled/
 * settled/failed/cancelled), where there's no video underneath being
 * covered and, once settled, the outcome should land immediately rather
 * than hide behind a tap. `sheetOverride` is the viewer's own explicit
 * choice, once made; it's cleared automatically the moment the premiere
 * settles so a win/loss is never left tucked away behind a peek strip the
 * viewer collapsed earlier while trading.
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

  @state() private sheetOverride: boolean | null = null;
  private previousModelState: ReplayPremierePublicState | null = null;

  createRenderRoot() {
    return this;
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has("model") || this.model === undefined) return;
    const state = this.model.state;
    // A settlement landing supersedes whatever the viewer left the sheet at
    // while trading — the outcome should be visible without a tap.
    if (
      this.previousModelState !== null &&
      this.previousModelState !== state &&
      (state === "revealed" || state === "archived")
    ) {
      this.sheetOverride = null;
    }
    this.previousModelState = state;
  }

  /** Peek-strip default: open unless the match is actually live (replay on screen, protect it). */
  private defaultSheetOpen(): boolean {
    return !LIVE_STATES.has(this.model.state);
  }

  private get sheetOpen(): boolean {
    return this.sheetOverride ?? this.defaultSheetOpen();
  }

  private totalUnrealizedPnl(): number | null {
    const positions = this.market?.positions;
    if (positions === null || positions === undefined || positions.length === 0) {
      return null;
    }
    return positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
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
      policyIdentity: policy.policyIdentity,
    }));
  }

  private renderPeekStrip() {
    const model = this.model;
    const live = LIVE_STATES.has(model.state);
    const open = this.sheetOpen;
    const totalPnl = this.totalUnrealizedPnl();
    return html`
      <button
        type="button"
        class="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset lg:hidden"
        aria-expanded=${open}
        aria-controls="betting-sheet-panel"
        @click=${() => {
          this.sheetOverride = !this.sheetOpen;
        }}
      >
        <span class="flex min-w-0 items-center gap-2">
          ${live
            ? html`<span
                aria-hidden="true"
                class="h-1.5 w-1.5 shrink-0 rounded-full bg-live motion-safe:animate-pulse"
              ></span>`
            : nothing}
          ${totalPnl !== null
            ? html`<span
                class="font-mono text-sm font-bold tabular-nums ${totalPnl >= 0
                  ? "text-positive"
                  : "text-danger"}"
                >${totalPnl >= 0 ? "▲" : "▼"} ${formatSignedCredits(totalPnl)} cr</span
              >`
            : html`<span class="truncate text-sm font-semibold text-ink">${model.title}</span>`}
        </span>
        <span class="flex shrink-0 items-center gap-1 text-xs font-semibold text-accent">
          Trade
          <span aria-hidden="true">${open ? "▴" : "▾"}</span>
        </span>
      </button>
    `;
  }

  /**
   * Desktop analog of the mobile peek strip. Without this, the fixed
   * right-hand trading column has no width cap and shrink-to-fits its
   * OWN content (the 3-column seat grid, quick-amount chips, etc.) —
   * which reliably balloons to roughly half a 1200px viewport, for a
   * product whose hook is watching the match. While the match is live
   * and the sheet is collapsed (same `sheetOpen` state the mobile peek
   * strip already uses), the column shrinks to a narrow rail instead of
   * staying pinned open at content width; hidden whenever `open` (the
   * full ticket occupies the same slot then).
   */
  private renderDesktopRail() {
    if (this.sheetOpen) return nothing;
    const model = this.model;
    const live = LIVE_STATES.has(model.state);
    const totalPnl = this.totalUnrealizedPnl();
    return html`
      <button
        type="button"
        class="hidden w-full flex-1 flex-col items-center justify-between gap-3 px-1.5 py-4 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset lg:flex"
        aria-expanded="false"
        aria-controls="betting-sheet-panel"
        aria-label="Expand trading panel"
        @click=${() => {
          this.sheetOverride = !this.sheetOpen;
        }}
      >
        <span class="flex flex-col items-center gap-2">
          ${live
            ? html`<span
                aria-hidden="true"
                class="h-1.5 w-1.5 shrink-0 rounded-full bg-live motion-safe:animate-pulse"
              ></span>`
            : nothing}
          <span
            aria-hidden="true"
            class="text-[10px] font-semibold uppercase tracking-wide text-accent [writing-mode:vertical-lr] rotate-180"
            >Trade</span
          >
        </span>
        ${totalPnl !== null
          ? html`<span
              aria-hidden="true"
              class="flex flex-col items-center font-mono text-xs font-bold tabular-nums ${totalPnl >= 0
                ? "text-positive"
                : "text-danger"}"
            >
              <span>${totalPnl >= 0 ? "▲" : "▼"}</span>
              <span>${Math.abs(Math.round(totalPnl))}</span>
            </span>`
          : nothing}
        <span aria-hidden="true" class="text-ink-muted">‹</span>
      </button>
    `;
  }

  private renderHeader() {
    const model = this.model;
    const live = LIVE_STATES.has(model.state);
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
    const seats = this.allSeats();
    // Trading is live for the whole "playing"/"checkpoint" phase — a
    // checkpoint window opening/closing is a content beat, not a trading
    // gate (operator override: no pause, continuous book for the match).
    const windowOpen =
      this.model.state === "playing" || this.model.state === "checkpoint";
    return html`
      <div class="flex flex-col gap-3 px-4 py-4">
        <premiere-position-summary .market=${this.market}></premiere-position-summary>
        <premiere-market-price-board
          .seats=${seats}
          .market=${this.market}
        ></premiere-market-price-board>
        <premiere-price-announcer
          .seats=${seats}
          .market=${this.market}
        ></premiere-price-announcer>
        ${this.renderMarketFacts()}
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

  /**
   * Three facts a first-time viewer needs and had no way to learn short
   * of reading source (Newcomer/Grinder personas, respectively): what the
   * price number means, what a share is worth at settlement, and that
   * there is no hidden edge — buy-then-immediate-sell nets exactly zero
   * (verified over 2,000 simulated round trips). Static copy, given
   * always-visible screen space rather than a one-time tooltip nobody
   * finds twice.
   */
  private renderMarketFacts() {
    return html`
      <div
        class="flex flex-col gap-1 rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-[11px] leading-snug text-ink-muted"
      >
        <p>Price = the crowd's implied chance (0–100%) — always sums to 100 across every agent.</p>
        <p>A winning share pays <strong class="text-ink">100 cr</strong> at settlement; a losing share pays 0.</p>
        <p>No house edge: buying then immediately selling the same shares back nets exactly 0 cr.</p>
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
        <div
          class="flex flex-1 items-center justify-center px-4 py-10 text-sm text-ink-muted lg:w-[380px]"
          role="status"
        >
          Loading premiere…
        </div>
      `;
    }
    const open = this.sheetOpen;
    const desktopWidthClass = open ? "lg:w-[380px]" : "lg:w-16";
    return html`
      <aside
        class="fixed inset-x-0 bottom-0 z-[52000] flex flex-col overflow-hidden rounded-t-xl border-t border-line bg-surface shadow-2xl ${open
          ? "max-h-[75vh]"
          : "max-h-fit"} lg:inset-y-0 lg:right-0 lg:left-auto lg:h-full lg:max-h-none lg:rounded-none lg:border-t-0 lg:border-l lg:transition-[width] lg:duration-200 ${desktopWidthClass}"
        role="complementary"
        aria-label="Premiere market"
      >
        ${this.renderPeekStrip()}
        ${this.renderDesktopRail()}
        <div
          id="betting-sheet-panel"
          class="${open ? "flex" : "hidden"} min-h-0 flex-1 flex-col overflow-y-auto"
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
        </div>
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
