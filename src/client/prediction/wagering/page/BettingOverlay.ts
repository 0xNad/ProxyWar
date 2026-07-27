import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  ReplayPremiereOverlayCallbacks,
  ReplayPremiereOverlayHandle,
  ReplayPremiereOverlayModel,
  ReplayPremierePublicState,
} from "src/client/ReplayPremiereOverlay";
import { MIN_STAKE } from "src/prediction/types";
import "../components/MarketBankrollBadge";
import "../components/MarketPositionSummary";
import "../components/MarketPriceBoard";
import "../components/MarketSettlementPanel";
import "../components/PositionsPanel";
import "../components/PriceAnnouncer";
import "../components/TradeTicket";
import { formatSignedCredits } from "../components/pnlDisplay";
import { settlementForSeat } from "../serviceMapping";
import type { MarketSeatOption, MarketState, TradeSide } from "../types";

/** Live states where the replay is actually on screen behind the sheet. */
const LIVE_STATES: ReadonlySet<ReplayPremierePublicState> = new Set([
  "playing",
  "checkpoint",
]);

/**
 * Whether the viewer has ever explicitly collapsed the trading sheet
 * before, persisted across sessions. Drives the live-state default below:
 * a first-time viewer starts expanded (the match going live is exactly
 * when the market becomes interesting — collapsing it by default was
 * hiding the one thing this page is for), while a returning viewer who
 * has already made the "collapse it" call once is trusted to have made
 * it deliberately and isn't re-taught the market exists every session.
 * Never set by the automatic failure-state pin (see `willUpdate`) — only
 * by an explicit tap on the peek strip / rail / collapse button — so an
 * involuntary auto-collapse never gets mistaken for a standing
 * preference.
 */
const SHEET_COLLAPSED_STORAGE_KEY = "pw-betting-sheet-collapsed";

function readPersistedSheetCollapsed(): boolean {
  try {
    return localStorage.getItem(SHEET_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function persistSheetCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(
      SHEET_COLLAPSED_STORAGE_KEY,
      collapsed ? "true" : "false",
    );
  } catch {
    // Storage unavailable (private browsing, quota) — falls back to a
    // session-only preference via `sheetOverride`, never a hard failure.
  }
}

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
 * This is also a bottom sheet on narrow viewports, collapsible to a slim
 * peek strip/rail (title or leading agent + price, live P&L) so the
 * replay stays the hero instead of the trading UI. It defaults OPEN for
 * every state except the live phase (see `defaultSheetOpen`): scheduled/
 * settled/failed/cancelled have no video underneath to protect and,
 * once settled, the outcome should land immediately rather than hide
 * behind a tap. During the live phase specifically, the default depends
 * on whether this viewer has ever collapsed it before (persisted via
 * `hasCollapsedBefore`) — open for a first-time viewer, since the match
 * going live is exactly when the market becomes worth seeing; collapsed
 * for a returning viewer who already made that call. `sheetOverride` is
 * the viewer's own explicit choice within THIS session, once made; it's
 * cleared automatically the moment the premiere settles so a win/loss is
 * never left tucked away behind a peek strip the viewer collapsed
 * earlier while trading.
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
  /**
   * The trader's in-progress order — seat/side/amount — lives here, not on
   * `<premiere-trade-ticket>` itself. This overlay element is created once
   * by `mountBettingOverlay` and never recreated for the life of the page;
   * the ticket underneath it is not — `renderBody()` swaps to a different
   * template (and back) whenever `model.state` briefly isn't "playing"/
   * "checkpoint" (e.g. a transient connection-loss screen that self-heals
   * on reload), which tears the ticket down and rebuilds it. Owning the
   * draft up here means that rebuild just re-renders the same values back
   * into the new ticket instance instead of losing them.
   */
  @state() private draftSeatId: string | null = null;
  @state() private draftSide: TradeSide = "buy";
  @state() private draftAmountText = "";
  private previousModelState: ReplayPremierePublicState | null = null;
  /**
   * Read once at construction — this overlay element is created once per
   * page load and never recreated (see the class doc comment), so "has
   * the viewer ever collapsed this before" is exactly "was it collapsed
   * the last time they visited", not something that needs to react to
   * changes mid-session.
   */
  private hasCollapsedBefore = readPersistedSheetCollapsed();

  createRenderRoot() {
    return this;
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has("model") || this.model === undefined) return;
    const state = this.model.state;
    if (this.previousModelState !== null && this.previousModelState !== state) {
      if (state === "revealed" || state === "archived") {
        // A settlement landing supersedes whatever the viewer left the
        // sheet at while trading — the outcome should be visible without
        // a tap.
        this.sheetOverride = null;
      } else if (
        (state === "failed" || state === "cancelled") &&
        LIVE_STATES.has(this.previousModelState) &&
        this.sheetOverride === null
      ) {
        // A mid-match failure shouldn't silently steal the map real
        // estate from a viewer who was implicitly (never explicitly)
        // collapsed while trading — pin the rail/sheet collapsed rather
        // than letting `defaultSheetOpen`'s state-driven default (open
        // for any non-live state) force it wide open. The collapsed
        // view still surfaces the failure via a compact indicator (see
        // `renderDesktopRail`/`renderPeekStrip`); a cold landing
        // directly on a failed premiere is unaffected — there is no
        // prior live collapse to preserve, so it opens as before.
        this.sheetOverride = false;
      }
    }
    this.previousModelState = state;
  }

  /**
   * Peek-strip default. Non-live states (scheduled/settled/failed cold
   * landing) always default open — there's no replay underneath to
   * protect and, once settled, the outcome should land immediately. For
   * the live phase specifically — where the replay IS on screen and does
   * need protecting — a first-time viewer defaults OPEN: the match going
   * live is exactly when this market becomes worth looking at, and a
   * viewer who has never been shown it has no way to know it's there
   * once the panel snaps to a 24px rail. A returning viewer who has
   * already collapsed it once (their own explicit choice, remembered via
   * `hasCollapsedBefore`) defaults collapsed, same as before — they don't
   * need re-teaching every session.
   */
  private defaultSheetOpen(): boolean {
    if (!LIVE_STATES.has(this.model.state)) return true;
    return !this.hasCollapsedBefore;
  }

  private get sheetOpen(): boolean {
    return this.sheetOverride ?? this.defaultSheetOpen();
  }

  /**
   * The one path every EXPLICIT user toggle goes through (peek strip,
   * desktop rail, header collapse button) — as opposed to the automatic
   * failure-state pin in `willUpdate`, which sets `sheetOverride` directly
   * and deliberately does NOT persist, since that's a protective default
   * kicking in, not a preference the viewer stated.
   */
  private setSheetOpen(open: boolean): void {
    this.sheetOverride = open;
    persistSheetCollapsed(!open);
  }

  private totalUnrealizedPnl(): number | null {
    const positions = this.market?.positions;
    if (
      positions === null ||
      positions === undefined ||
      positions.length === 0
    ) {
      return null;
    }
    return positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  }

  /**
   * The single highest-priced seat right now — the "who's winning" signal
   * that has to carry the collapsed strip/rail (Main: "a changing number
   * attracts the eye far better than a static label"). `null` before the
   * market has loaded a first snapshot, so callers fall back to static
   * copy rather than showing a stale or fabricated leader.
   */
  private leadingSeat(): {
    seatId: string;
    displayName: string;
    price: number;
  } | null {
    const market = this.market;
    if (market === null) return null;
    let best: { seatId: string; displayName: string; price: number } | null =
      null;
    for (const seat of this.allSeats()) {
      const price = market.prices[seat.seatId];
      if (price === undefined) continue;
      if (best === null || price > best.price) {
        best = { seatId: seat.seatId, displayName: seat.displayName, price };
      }
    }
    return best;
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
    const failed = model.state === "failed" || model.state === "cancelled";
    const live = LIVE_STATES.has(model.state);
    const open = this.sheetOpen;
    const totalPnl = this.totalUnrealizedPnl();
    // While the match is actually live, the leading agent's price is the
    // headline signal — a number that keeps moving reads as "something is
    // happening here" far better than a static label ever could (Main).
    // Falls back to the old pnl/title copy before the market has loaded
    // its first snapshot.
    const leader = live && !failed ? this.leadingSeat() : null;
    return html`
      <button
        type="button"
        class="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset lg:hidden"
        aria-expanded=${open}
        aria-controls="betting-sheet-panel"
        @click=${() => this.setSheetOpen(!this.sheetOpen)}
      >
        <span class="flex min-w-0 items-center gap-2">
          ${failed
            ? html`<span
                aria-hidden="true"
                class="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
              ></span>`
            : live
              ? html`<span
                  aria-hidden="true"
                  class="h-1.5 w-1.5 shrink-0 rounded-full bg-live motion-safe:animate-pulse"
                ></span>`
              : nothing}
          ${failed
            ? html`<span class="truncate text-sm font-semibold text-danger"
                >Action needed</span
              >`
            : leader !== null
              ? html`<span class="flex min-w-0 items-baseline gap-1.5">
                  <span class="min-w-0 truncate text-sm font-semibold text-ink"
                    >${leader.displayName}</span
                  >
                  <span
                    class="shrink-0 font-mono text-sm font-bold tabular-nums text-ink"
                    >${leader.price.toFixed(1)}%</span
                  >
                </span>`
              : totalPnl !== null
                ? html`<span
                    class="font-mono text-sm font-bold tabular-nums ${totalPnl >=
                    0
                      ? "text-positive"
                      : "text-danger"}"
                    >${totalPnl >= 0 ? "▲" : "▼"}
                    ${formatSignedCredits(totalPnl)} cr</span
                  >`
                : html`<span class="truncate text-sm font-semibold text-ink"
                    >${model.title}</span
                  >`}
        </span>
        <span class="flex shrink-0 items-center gap-2 text-xs font-semibold">
          ${!failed && leader !== null && totalPnl !== null
            ? html`<span
                class="font-mono tabular-nums ${totalPnl >= 0
                  ? "text-positive"
                  : "text-danger"}"
                title="Your unrealized profit/loss, not the price above"
                >${totalPnl >= 0 ? "▲" : "▼"}
                ${formatSignedCredits(totalPnl)}</span
              >`
            : nothing}
          <span class="${failed ? "text-danger" : "text-accent"}"
            >${failed ? "View" : "Trade"}</span
          >
          <span
            aria-hidden="true"
            class="${failed ? "text-danger" : "text-ink-muted"}"
            >${open ? "▴" : "▾"}</span
          >
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
    const failed = model.state === "failed" || model.state === "cancelled";
    const live = LIVE_STATES.has(model.state);
    const totalPnl = this.totalUnrealizedPnl();
    const leader = live && !failed ? this.leadingSeat() : null;
    return html`
      <button
        type="button"
        class="hidden w-full flex-1 flex-col items-center justify-between gap-3 px-1.5 py-4 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset lg:flex"
        aria-expanded="false"
        aria-controls="betting-sheet-panel"
        aria-label=${this.railAriaLabel(failed, leader, totalPnl)}
        @click=${() => this.setSheetOpen(true)}
      >
        <span class="flex flex-col items-center gap-1.5">
          ${failed
            ? html`<span
                aria-hidden="true"
                class="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
              ></span>`
            : live
              ? html`<span
                  aria-hidden="true"
                  class="h-1.5 w-1.5 shrink-0 rounded-full bg-live motion-safe:animate-pulse"
                ></span>`
              : nothing}
          ${leader !== null
            ? html`<span
                aria-hidden="true"
                class="flex flex-col items-center gap-0.5 leading-none"
                title="${leader.displayName} leading at ${leader.price.toFixed(
                  1,
                )}%"
              >
                <span
                  class="max-w-[3.25rem] truncate text-[9px] font-semibold uppercase tracking-wide text-ink-muted"
                  >${leader.displayName}</span
                >
                <span class="font-mono text-sm font-bold tabular-nums text-ink"
                  >${leader.price.toFixed(0)}%</span
                >
              </span>`
            : html`<span
                aria-hidden="true"
                class="text-[10px] font-semibold uppercase tracking-wide ${failed
                  ? "text-danger"
                  : "text-accent"}"
                >${failed ? "Alert" : "Trade"}</span
              >`}
        </span>
        ${!failed && totalPnl !== null
          ? html`<span
              aria-hidden="true"
              class="flex flex-col items-center font-mono text-xs font-bold tabular-nums ${totalPnl >=
              0
                ? "text-positive"
                : "text-danger"}"
            >
              <span>${totalPnl >= 0 ? "▲" : "▼"}</span>
              <span>${Math.abs(Math.round(totalPnl))}</span>
            </span>`
          : nothing}
        <span
          aria-hidden="true"
          class="${failed ? "text-danger" : "text-ink-muted"}"
          >‹</span
        >
      </button>
    `;
  }

  /**
   * The rail's own visual content is entirely `aria-hidden` (see above) —
   * narrow-column layout tricks (truncated names, stacked glyphs) don't
   * translate to a screen reader, so the accessible name carries the same
   * three facts explicitly instead: that expanding opens the trading
   * panel, who's currently leading and at what price, and the viewer's
   * own P&L if they hold a position. Not `aria-live` — this is a static
   * name read once when focus lands here, never re-announced on its own
   * as prices tick (that per-tick spam was already rejected — see
   * `PriceAnnouncer`).
   */
  private railAriaLabel(
    failed: boolean,
    leader: { displayName: string; price: number } | null,
    totalPnl: number | null,
  ): string {
    if (failed) return "Show market status — action needed";
    const parts = ["Expand trading panel"];
    if (leader !== null) {
      parts.push(
        `${leader.displayName} leading at ${leader.price.toFixed(0)}%`,
      );
    }
    if (totalPnl !== null) {
      parts.push(`your position ${formatSignedCredits(totalPnl)} cr`);
    }
    return parts.join(" — ");
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
          <span class="flex shrink-0 items-center gap-2">
            ${live
              ? html`<span
                  class="inline-flex items-center gap-1 rounded-full bg-live/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-live"
                >
                  <span
                    class="h-1.5 w-1.5 animate-pulse rounded-full bg-live"
                  ></span>
                  Live
                </span>`
              : nothing}
            <button
              type="button"
              class="hidden items-center justify-center rounded-md border border-line px-1.5 py-1 text-ink-muted outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent lg:inline-flex"
              aria-label="Collapse trading panel"
              aria-controls="betting-sheet-panel"
              @click=${() => this.setSheetOpen(false)}
            >
              <span aria-hidden="true">›</span>
            </button>
          </span>
        </div>
        <p class="text-xs text-ink-muted">
          ${model.mapName} · ${model.matchFormat}
        </p>
      </header>
    `;
  }

  private renderBody() {
    switch (this.model.state) {
      case "scheduled": {
        const seats = this.allSeats();
        return html`
          <div class="flex flex-col gap-4 px-4 py-6 text-center">
            <div class="flex flex-col gap-1.5">
              <p class="text-sm font-semibold text-ink">
                Live market: which agent wins this match?
              </p>
              <p class="text-xs leading-relaxed text-ink-muted">
                ${seats.length} AI policies are competing here — not
                humans${seats.length > 0
                  ? html`:
                      <span class="text-ink"
                        >${seats
                          .map((seat) => seat.displayName)
                          .join(" · ")}</span
                      >`
                  : nothing}.
                Buy shares in whichever one you think wins; the crowd's own
                trading sets the odds as the match plays out.
              </p>
            </div>
            ${this.renderMarketFacts()}
            <p class="text-xs text-ink-muted">
              Trading opens the moment the match starts — scheduled for
              ${new Date(this.model.scheduledAt).toLocaleString()}.
            </p>
          </div>
        `;
      }
      case "playing":
      case "checkpoint":
        return this.renderMarket();
      case "revealed":
      case "archived":
        return this.renderSettlement();
      case "failed":
        return this.renderTerminalFailure();
      case "cancelled":
        return this.renderTerminalFailure();
      default:
        return nothing;
    }
  }

  /**
   * Honest, bucketed failure copy. Never claims a refund unless it
   * actually happened and is known — the client cannot see server-side
   * settlement from here, so "voided and refunded" (the old unconditional
   * claim) was simply false whenever nothing was staked, and unverified
   * whenever something was. Three distinct situations, three distinct
   * messages:
   *   - `runtime_failure`: a connection/session problem — recoverable,
   *     never data-integrity. Offers a reload, since the client's own
   *     network/service layer is torn down by this point and a reload is
   *     the one action guaranteed to work (and — via session
   *     resumability — reconnects to the same session rather than
   *     starting over).
   *   - `integrity_failure`: the server claimed something the verified
   *     chain cannot support. No retry offered — this state is
   *     deliberately terminal — but still never asserts a refund it
   *     cannot confirm.
   *   - anything else (server-reported `failed`/`cancelled` lifecycle,
   *     not a client-side latch): an operator-level event outside what
   *     this overlay can verify — same discipline, no unconfirmed claim.
   */
  private renderTerminalFailure() {
    const failureCode = this.model.failureCode;
    const hadPosition = (this.market?.positions?.length ?? 0) > 0;
    const positionNote = hadPosition
      ? html`<p class="text-xs text-ink-muted">
          Your position status could not be confirmed here — check your balance
          before assuming anything about it.
        </p>`
      : nothing;
    if (failureCode === "runtime_failure") {
      return html`
        <div
          class="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center"
          role="alert"
        >
          <p class="text-sm font-semibold text-danger">
            Lost connection to the live market.
          </p>
          <p class="text-xs text-ink-muted">
            This is a connection problem, not a match or account issue.
          </p>
          ${positionNote}
          <button
            type="button"
            class="mt-2 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-hover"
            @click=${() => this.ownerDocument.defaultView?.location.reload()}
          >
            Reload to reconnect
          </button>
        </div>
      `;
    }
    if (failureCode === "integrity_failure") {
      return html`
        <div
          class="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center"
          role="alert"
        >
          <p class="text-sm font-semibold text-danger">
            This premiere's data could not be verified.
          </p>
          <p class="text-xs text-ink-muted">
            Something the server reported did not match what this client could
            independently verify.
          </p>
          ${positionNote}
        </div>
      `;
    }
    // Server-reported failed/cancelled, not a client-side latch.
    return html`
      <div
        class="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center"
      >
        <p class="text-sm font-semibold text-ink">
          ${this.model.state === "cancelled"
            ? "This premiere was cancelled."
            : "This premiere could not continue."}
        </p>
        ${positionNote}
      </div>
    `;
  }

  /** Quiet, non-alarming — a transient failure recovers on its own. */
  private renderRecovery() {
    if (this.model.recovery === null || this.model.recovery === undefined) {
      return nothing;
    }
    return html`
      <div
        class="border-b border-line bg-surface/80 px-4 py-1.5 text-center text-[11px] font-medium text-ink-muted"
        role="status"
      >
        Reconnecting…
      </div>
    `;
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
        <premiere-position-summary
          .market=${this.market}
        ></premiere-position-summary>
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
          .draftSeatId=${this.draftSeatId}
          .draftSide=${this.draftSide}
          .draftAmountText=${this.draftAmountText}
          .onDraftSeatChange=${(seatId: string) => {
            this.draftSeatId = seatId;
          }}
          .onDraftSideChange=${(side: TradeSide) => {
            this.draftSide = side;
          }}
          .onDraftAmountChange=${(text: string) => {
            this.draftAmountText = text;
          }}
          .onTrade=${(
            seatId: string,
            side: TradeSide,
            amount: number,
            limitPrice: number,
          ) =>
            this.onTrade?.(seatId, side, amount, limitPrice) ??
            Promise.resolve()}
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
        <p>
          Price = the crowd's implied chance (0–100%) — always sums to 100
          across every agent.
        </p>
        <p>
          A winning share pays <strong class="text-ink">100 cr</strong> at
          settlement; a losing share pays 0.
        </p>
        <p>
          No house edge: buying then immediately selling the same shares back
          nets exactly 0 cr.
        </p>
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
                  ? html`Winner:
                      <strong
                        >${this.seatLabel(reveal.winnerSeatId ?? null)}</strong
                      >`
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
        ${this.renderPeekStrip()} ${this.renderDesktopRail()}
        <div
          id="betting-sheet-panel"
          class="${open
            ? "flex"
            : "hidden"} min-h-0 flex-1 flex-col overflow-y-auto"
        >
          ${this.renderHeader()} ${this.renderRecovery()}
          <div
            class="flex items-center justify-between gap-2 border-b border-line px-4 py-2"
          >
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
