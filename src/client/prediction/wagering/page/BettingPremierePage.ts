import type { ReplayPremiereOverlayHandle } from "src/client/ReplayPremiereOverlay";
import type { ReplayPremiereReadyProjection } from "src/client/ReplayPremiereNetwork";
import {
  ReplayPremiereRuntimeController,
  ReplayPremiereServiceError,
  type ReplayPremiereJoinRequest,
  type ReplayPremiereJoinSyncUpdate,
  type ReplayPremiereServiceTradeResponse,
} from "src/client/ReplayPremiereRuntime";
import { mountBettingOverlay, type PremiereBettingOverlay } from "./BettingOverlay";
import { quoteSell } from "../marketMath";
import { marketStateFromService } from "../serviceMapping";
import { SessionBankroll } from "../sessionBankroll";
import { SHARE_PAYOUT, type MarketPosition, type MarketState, type TradeSide } from "../types";

/** How often the standalone market poll refreshes prices while the market is live. */
const MARKET_POLL_INTERVAL_MS = 2_500;

/**
 * Wraps `mountBettingOverlay` so this module can grab the concrete
 * `PremiereBettingOverlay` element the runtime mounts internally — the
 * controller never exposes that handle itself, so capturing it at the
 * factory boundary is the only seam available.
 */
function capturingOverlayFactory(
  onElementReady: (element: PremiereBettingOverlay) => void,
): typeof mountBettingOverlay {
  return (initialModel, callbacks) => {
    const handle: ReplayPremiereOverlayHandle = mountBettingOverlay(
      initialModel,
      callbacks,
    );
    onElementReady(handle.element as PremiereBettingOverlay);
    return handle;
  };
}

/**
 * Owns everything the pari-mutuel-era `onWagerCheckpointsUpdated` hook used
 * to own for the checkpoint prediction flow, rebuilt for continuous LMSR
 * trading: the standalone poll loop (the runtime's own polling only covers
 * replay content, never the market), the session bankroll, and pushing
 * fresh market snapshots into the overlay.
 *
 * `GET .../market` is deliberately anonymous (see
 * `ReplayPremiereInteractions.readMarketState`) — it always reports
 * `positions: null`; only an authenticated `POST .../market-orders`
 * response ever carries this participant's real positions. Left alone,
 * every poll tick would clobber whatever the last trade populated back to
 * null a couple of seconds later, so "Your positions" and unrealised P&L
 * could never durably display, and a settlement payout could never be
 * credited unless the viewer happened to be mid-trade exactly when
 * settlement landed (`settleMarket` zeroes out holdings server-side the
 * instant it runs, so by the time `status: "settled"` is even visible on
 * the wire, nothing shows what was actually held).
 *
 * `knownPositions` is this controller's own client-side-authoritative
 * cache, fixing both: replaced WHOLESALE the instant a trade response
 * reports the server's real view (server truth always wins outright,
 * never merged with anything stale); in between trades, mark-to-marked
 * live against every anonymous poll's fresh prices using the server's own
 * formula (`currentValue = round(shares * price)`, see
 * `ReplayPremiereMarket.positionsFor`) so P&L keeps moving with the
 * market even though the wire goes quiet on position data; and, once
 * settled, snapped to the exact payout `ReplayPremiereMarket.settleMarket`
 * pays (winning shares at `SHARE_PAYOUT` each, a void market's cost basis
 * refunded, everything else worthless) so the credited bankroll delta and
 * the displayed value always agree.
 */
export class BettingPremiereMarketController {
  private readonly bankroll = new SessionBankroll();
  private overlay: PremiereBettingOverlay | null = null;
  private pollTimer: number | null = null;
  private polling = false;
  private started = false;
  private disposed = false;
  // Freshest observed anti-replay freshness bound — echoed back on the
  // NEXT order only (never cached across multiple orders); updated from
  // every poll AND every trade response's own market snapshot.
  private latestLiveVisibleSequence = 0;
  // Client-side-authoritative positions cache — see class doc comment.
  // Keyed by seatId; empty until this participant's first trade response.
  private knownPositions = new Map<string, MarketPosition>();

  constructor(
    private readonly runtime: ReplayPremiereRuntimeController,
    private readonly premiereId: string,
  ) {}

  attachOverlay(overlay: PremiereBettingOverlay): void {
    if (this.disposed) return;
    this.overlay = overlay;
    overlay.bankroll = this.bankroll.balance;
    overlay.onTrade = (seatId, side, amount, limitPrice) =>
      this.submitTrade(seatId, side, amount, limitPrice);
  }

  /** Begin the continuous poll. Idempotent — safe to call more than once. */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    void this.pollOnce();
    this.pollTimer = window.setInterval(
      () => void this.pollOnce(),
      MARKET_POLL_INTERVAL_MS,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearInterval(this.pollTimer ?? undefined);
    this.pollTimer = null;
    this.overlay = null;
  }

  private async submitTrade(
    seatId: string,
    side: TradeSide,
    amount: number,
    limitPrice: number,
  ): Promise<void> {
    const previousShares = this.knownPositions.get(seatId)?.shares ?? 0;
    const response = await this.submitTradeWithRetry(seatId, side, amount, limitPrice);
    if (this.disposed) return;
    // Debit a buy's cost / credit a sell's proceeds — straight off the
    // server's own `chips` figure, never a client preview.
    this.bankroll.applyTrade(side === "buy" ? -response.trade.chips : response.trade.chips);
    const market = marketStateFromService(response.market);
    // Never silently smoothed over: the server's own answer always wins
    // (applied unconditionally below via `applyMarket`) — this only
    // surfaces, in dev, a shares count this trade alone doesn't explain
    // (e.g. a second concurrent session for the same participant).
    const reportedShares =
      market.positions?.find((position) => position.seatId === seatId)?.shares ?? 0;
    const expectedShares =
      previousShares + (side === "buy" ? response.trade.shares : -response.trade.shares);
    if (reportedShares !== expectedShares) {
      console.warn(
        `[betting] position drift on seat ${seatId}: expected ${expectedShares} shares after this trade, server reported ${reportedShares}. Using the server's value.`,
      );
    }
    this.applyMarket(market);
  }

  /**
   * The `sequence` this participant stamps on an order is a snapshot from
   * the last poll/trade response. A live match can advance past it before
   * the order reaches the server, which correctly rejects with a 410 (the
   * server is the sole authority on freshness — never client-trusted).
   * That is an ordinary race, not a failure: re-quote (fetch the current
   * market state for a fresh sequence) and retry once, transparently,
   * instead of surfacing an error the user did nothing wrong to cause. A
   * second consecutive rejection (the market may genuinely have closed)
   * propagates normally — `TradeTicket` already turns that into a visible
   * "Order failed" message.
   */
  private async submitTradeWithRetry(
    seatId: string,
    side: TradeSide,
    amount: number,
    limitPrice: number,
  ): Promise<ReplayPremiereServiceTradeResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.runtime.submitMarketOrder({
          premiereId: this.premiereId,
          seatId,
          side,
          amount,
          limitPrice,
          sequence: this.latestLiveVisibleSequence,
        });
      } catch (error) {
        const staleSequence =
          attempt === 0 &&
          error instanceof ReplayPremiereServiceError &&
          error.status === 410;
        if (!staleSequence) throw error;
        const refreshed = await this.runtime.readMarketState();
        if (this.disposed) throw error;
        this.applyMarket(marketStateFromService(refreshed.market));
      }
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.disposed || this.polling) return;
    this.polling = true;
    try {
      const response = await this.runtime.readMarketState();
      if (this.disposed) return;
      this.applyMarket(marketStateFromService(response.market));
      if (this.overlay !== null) this.overlay.marketLoadError = null;
    } catch (error) {
      if (this.disposed || this.overlay === null) return;
      this.overlay.marketLoadError =
        error instanceof Error ? error.message : "Could not reach the market.";
    } finally {
      this.polling = false;
    }
  }

  /**
   * `open`: what liquidating the WHOLE position would actually pay out
   * right now — NOT `shares × marginal price`. LMSR selling moves the
   * price against the seller, so the marginal-price number is never
   * realisable; the larger the position, the worse that gap gets. Uses
   * the same cost curve the server fills a real sell against
   * (`quoteSell` mirrors `sellProceeds`/`ReplayPremiereMarket` exactly),
   * so the displayed number and the number a "Sell all" would actually
   * receive are the same number. `settled`: the exact payout
   * `settleMarket` pays — a winning seat's shares at `SHARE_PAYOUT` each,
   * a void market's cost basis refunded in full, every other seat
   * worthless — so the value shown here and the amount credited to the
   * bankroll always agree.
   */
  private markToMarket(market: MarketState, position: MarketPosition): number {
    if (market.status === "settled") {
      if (market.winnerSeatId === null) return position.costBasis;
      return position.seatId === market.winnerSeatId
        ? position.shares * SHARE_PAYOUT
        : 0;
    }
    return quoteSell(market, position.seatId, position.shares)?.chips ?? 0;
  }

  private applyMarket(market: MarketState): void {
    if (this.disposed) return;
    this.latestLiveVisibleSequence = market.liveVisibleSequence;
    if (market.positions !== null) {
      // Authenticated snapshot (a trade response) — always the freshest
      // server truth; replaces the cache wholesale, never merged with
      // anything stale.
      this.knownPositions = new Map(
        market.positions.map((position) => [position.seatId, position]),
      );
    } else {
      // Anonymous poll: the server never reports positions on this route,
      // by design. Keep the cached shares/costBasis — the only facts that
      // change are via a trade — and mark them to market (or to the final
      // payout, once settled) against this poll's fresh snapshot.
      for (const [seatId, position] of this.knownPositions) {
        const currentValue = this.markToMarket(market, position);
        this.knownPositions.set(seatId, {
          ...position,
          currentValue,
          unrealizedPnl: currentValue - position.costBasis,
        });
      }
    }
    const positions =
      this.knownPositions.size > 0 ? Array.from(this.knownPositions.values()) : null;
    // Credit a settlement payout exactly once per seat this participant
    // held. `creditSettlementOnce` is itself idempotent, so it is safe to
    // call on every subsequent poll after settlement first lands.
    if (market.status === "settled" && positions !== null) {
      for (const position of positions) {
        this.bankroll.creditSettlementOnce(
          `market-settlement:${position.seatId}`,
          position.currentValue,
        );
      }
    }
    if (this.overlay !== null) {
      this.overlay.market = { ...market, positions };
      this.overlay.bankroll = this.bankroll.balance;
    }
  }
}

export interface BettingPremierePageCallbacks {
  onJoinReady: (request: ReplayPremiereJoinRequest) => void;
  onProjectionReady?: (
    projection: Readonly<ReplayPremiereReadyProjection>,
  ) => void;
  onJoinSync?: (update: ReplayPremiereJoinSyncUpdate) => void;
  onRevealSeek?: (turn: number) => void;
}

export interface BettingPremierePageHandle {
  readonly runtime: ReplayPremiereRuntimeController;
  dispose(): void;
}

/**
 * Bootstraps the dedicated betting page's runtime: the SAME session/
 * lifecycle/integrity machinery `/premiere/<id>` uses
 * (`ReplayPremiereRuntimeController`), with `mountBettingOverlay` swapped
 * in for the rendered surface and a `BettingPremiereMarketController`
 * wired to it. Loading-veil sequencing (show veil → join sync → lift veil)
 * is the caller's concern — same as `Main.ts`'s `openReplayPremiere` — this
 * function only wires what's specific to trading.
 */
export function openBettingPremierePage(
  premiereId: string,
  callbacks: BettingPremierePageCallbacks,
): BettingPremierePageHandle {
  let market: BettingPremiereMarketController | null = null;
  const runtime = new ReplayPremiereRuntimeController({
    premiereId,
    // Live-projection tap, not chunk delivery: a chunk-delivered client
    // holds up to a full chunk span of content the honest viewer hasn't
    // reached yet — see `ReplayPremiereNetworkOptions.contentSource`. The
    // betting page is the one surface where that gap is a real trading
    // advantage, so it alone opts in; `/premiere/<id>` (`Main.ts`) is
    // untouched and stays on chunk delivery.
    contentSource: "tap",
    onJoinReady: callbacks.onJoinReady,
    onJoinSync: callbacks.onJoinSync,
    onRevealSeek: callbacks.onRevealSeek,
    onProjectionReady: (projection) => {
      callbacks.onProjectionReady?.(projection);
      // The overlay (and therefore the market controller's target) only
      // exists once the projection is ready — safe to start the poll here.
      market?.start();
    },
    dependencies: {
      overlayFactory: capturingOverlayFactory((element) => {
        market?.attachOverlay(element);
      }),
    },
  });
  market = new BettingPremiereMarketController(runtime, premiereId);
  return {
    runtime,
    dispose: () => {
      market?.dispose();
      runtime.dispose();
    },
  };
}

/**
 * Matches the dedicated betting page's own route — sibling to (never the
 * same as) `/premiere/<id>`, per Main's directive that betting gets its
 * own page rather than the existing overlay. Same premiere id shape.
 */
export function parseBettingPremiereRoute(pathname: string): string | null {
  const match = pathname.match(/^\/bet\/(prem_[a-z0-9]{16,32})$/);
  return match?.[1] ?? null;
}
