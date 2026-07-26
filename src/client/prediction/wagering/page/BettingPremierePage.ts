import type { ReplayPremiereOverlayHandle } from "src/client/ReplayPremiereOverlay";
import type { ReplayPremiereReadyProjection } from "src/client/ReplayPremiereNetwork";
import {
  ReplayPremiereRuntimeController,
  type ReplayPremiereJoinRequest,
  type ReplayPremiereJoinSyncUpdate,
} from "src/client/ReplayPremiereRuntime";
import { mountBettingOverlay, type PremiereBettingOverlay } from "./BettingOverlay";
import { marketStateFromService } from "../serviceMapping";
import { SessionBankroll } from "../sessionBankroll";
import type { MarketState, TradeSide } from "../types";

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
 * to cover, now that trading is a standalone concern (see
 * `ReplayPremiereRuntime.ts`'s `readMarketState`/`submitMarketOrder`): a
 * continuous poll of the LMSR market (live for the WHOLE match per the
 * operator's continuous-trading override — not gated to a checkpoint
 * window), the client-local `SessionBankroll`, and wiring the mounted
 * overlay's `market`/`bankroll`/`onTrade` properties. One instance per
 * premiere attempt; `dispose()` stops the poll.
 */
export class BettingPremiereMarketController {
  private readonly bankroll = new SessionBankroll();
  private overlay: PremiereBettingOverlay | null = null;
  private pollTimer: number | null = null;
  private polling = false;
  private started = false;
  private disposed = false;

  constructor(
    private readonly runtime: ReplayPremiereRuntimeController,
    private readonly premiereId: string,
  ) {}

  attachOverlay(overlay: PremiereBettingOverlay): void {
    if (this.disposed) return;
    this.overlay = overlay;
    overlay.bankroll = this.bankroll.balance;
    overlay.onTrade = (checkpointId, seatId, side, amount, limitPrice) =>
      this.submitTrade(checkpointId, seatId, side, amount, limitPrice);
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
    checkpointId: string,
    seatId: string,
    side: TradeSide,
    amount: number,
    limitPrice: number,
  ): Promise<void> {
    const response = await this.runtime.submitMarketOrder({
      premiereId: this.premiereId,
      checkpointId,
      seatId,
      side,
      amount,
      limitPrice,
    });
    if (this.disposed) return;
    // Debit a buy's cost / credit a sell's proceeds — straight off the
    // server's own `chips` figure, never a client preview.
    this.bankroll.applyTrade(side === "buy" ? -response.trade.chips : response.trade.chips);
    this.applyMarket(marketStateFromService(response.market));
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

  private applyMarket(market: MarketState): void {
    if (this.disposed) return;
    // Credit a settlement payout exactly once per seat the viewer held —
    // guarded by `SessionBankroll.creditSettlementOnce` itself, safe to
    // call on every subsequent poll/trade response after settlement.
    if (market.status === "settled" && market.positions !== null) {
      for (const position of market.positions) {
        this.bankroll.creditSettlementOnce(
          `market-settlement:${position.seatId}`,
          position.currentValue,
        );
      }
    }
    if (this.overlay !== null) {
      this.overlay.market = market;
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
