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
import { marketStateFromService } from "../serviceMapping";
import type { MarketState, TradeSide } from "../types";

/** How often the standalone market poll refreshes prices while the market is live. */
const MARKET_POLL_INTERVAL_MS = 2_500;

/**
 * Retry delay for a poll that raced the join session's own bootstrap (see
 * `pollOnce`'s `session_required` handling) — short, since it's a one-shot
 * startup race, not a steady-state failure worth the full poll interval.
 */
const SESSION_RETRY_DELAY_MS = 200;

/**
 * The betting page joins through the exact same client game engine as a
 * live multiplayer match (`handleJoinLobby` → `ClientGameRunner`) — there
 * is no premiere-specific renderer, so every local-player HUD surface
 * mounts unconditionally: the "Choose a starting location" spawn banner,
 * build menu, attack-ratio control panel, chat/emoji/moderation modals,
 * the "your nation" sidebar. A visitor here is a spectator/bettor with no
 * seat and nothing to spawn, so all of that is dead — at best confusing
 * ("am I supposed to pick a spawn point?"), at worst actively misleading
 * about what this page is for. This is the SAME declutter list
 * `AiLeagueReplayOverlay.ts` already applies for its own (unrelated,
 * static-replay) viewer, reimplemented here under a class scoped to this
 * route — reusing that file's body class would depend on its `<style>`
 * tag having been injected by an unrelated code path that never runs on
 * `/bet/<id>`, so it wouldn't actually hide anything.
 */
const BETTING_SPECTATOR_BODY_CLASS = "premiere-betting-spectator-mode";
const BETTING_SPECTATOR_STYLE_ID = "premiere-betting-spectator-style";

function ensureBettingSpectatorStyleInjected(): void {
  if (document.getElementById(BETTING_SPECTATOR_STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = BETTING_SPECTATOR_STYLE_ID;
  style.textContent = `
    body.${BETTING_SPECTATOR_BODY_CLASS} heads-up-message,
    body.${BETTING_SPECTATOR_BODY_CLASS} control-panel,
    body.${BETTING_SPECTATOR_BODY_CLASS} unit-display,
    body.${BETTING_SPECTATOR_BODY_CLASS} build-menu,
    body.${BETTING_SPECTATOR_BODY_CLASS} emoji-table,
    body.${BETTING_SPECTATOR_BODY_CLASS} player-panel,
    body.${BETTING_SPECTATOR_BODY_CLASS} chat-display,
    body.${BETTING_SPECTATOR_BODY_CLASS} chat-modal,
    body.${BETTING_SPECTATOR_BODY_CLASS} send-resource-modal,
    body.${BETTING_SPECTATOR_BODY_CLASS} player-moderation-modal,
    body.${BETTING_SPECTATOR_BODY_CLASS} spawn-timer,
    body.${BETTING_SPECTATOR_BODY_CLASS} immunity-timer,
    body.${BETTING_SPECTATOR_BODY_CLASS} game-left-sidebar {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

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
 * replay content, never the market) and pushing fresh market snapshots
 * into the overlay. There is no client-local bankroll or position
 * arithmetic anywhere in this class — every figure it shows (bankroll,
 * shares, cost basis, current value, unrealized P&L) is the server's own
 * number off the wire, verbatim, never recomputed or accumulated
 * client-side.
 *
 * `GET .../market/me` (`readMarketSelf`) is the ONE source of truth for
 * this participant's own positions and available ledger balance —
 * authenticated the same way every write is (guest cookie + CSRF +
 * Origin), reconciled fresh on every poll tick and after every trade.
 * This is what makes a reload or a second tab agree with the first: there
 * is nothing client-local left to disagree. `positionsFor`
 * (`ReplayPremiereMarket.ts`) keeps serving each seat's final shares/cost
 * basis/real payout after settlement too (settlement freezes holdings
 * rather than zeroing them — see that function's doc comment), so this
 * stays a plain passthrough in every market state, including settled.
 */
export class BettingPremiereMarketController {
  private overlay: PremiereBettingOverlay | null = null;
  private pollTimer: number | null = null;
  private polling = false;
  private started = false;
  private disposed = false;
  // Freshest observed anti-replay freshness bound — echoed back on the
  // NEXT order only (never cached across multiple orders); updated from
  // every poll AND every trade response's own market snapshot.
  private latestLiveVisibleSequence = 0;

  constructor(
    private readonly runtime: ReplayPremiereRuntimeController,
    private readonly premiereId: string,
  ) {}

  attachOverlay(overlay: PremiereBettingOverlay): void {
    if (this.disposed) return;
    this.overlay = overlay;
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
    const response = await this.submitTradeWithRetry(seatId, side, amount, limitPrice);
    if (this.disposed) return;
    // The order response's own `market` field already carries this
    // participant's positions and available balance, freshly recomputed
    // server-side by the trade that just executed — apply it verbatim.
    this.applyMarket(marketStateFromService(response.market));
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
        const refreshed = await this.runtime.readMarketSelf();
        if (this.disposed) throw error;
        this.applyMarket(marketStateFromService(refreshed.market));
      }
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.disposed || this.polling) return;
    this.polling = true;
    try {
      const response = await this.runtime.readMarketSelf();
      if (this.disposed) return;
      this.applyMarket(marketStateFromService(response.market));
      if (this.overlay !== null) this.overlay.marketLoadError = null;
    } catch (error) {
      if (this.disposed) return;
      if (
        error instanceof ReplayPremiereServiceError &&
        error.code === "session_required"
      ) {
        // Startup race: this poll starts the instant the projection is
        // ready, concurrently with the join session's own CSRF bootstrap
        // — not a real failure. Retry shortly, without flashing an error.
        window.setTimeout(() => void this.pollOnce(), SESSION_RETRY_DELAY_MS);
        return;
      }
      if (this.overlay === null) return;
      this.overlay.marketLoadError =
        error instanceof Error ? error.message : "Could not reach the market.";
    } finally {
      this.polling = false;
    }
  }

  private applyMarket(market: MarketState): void {
    if (this.disposed) return;
    this.latestLiveVisibleSequence = market.liveVisibleSequence;
    if (this.overlay !== null) {
      this.overlay.market = market;
      this.overlay.bankroll = market.balance;
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
  ensureBettingSpectatorStyleInjected();
  document.body.classList.add(BETTING_SPECTATOR_BODY_CLASS);
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
      document.body.classList.remove(BETTING_SPECTATOR_BODY_CLASS);
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
