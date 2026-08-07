import type { ReplayPremiereReadyProjection } from "src/client/ReplayPremiereNetwork";
import type { ReplayPremiereOverlayHandle } from "src/client/ReplayPremiereOverlay";
import {
  ReplayPremiereRuntimeController,
  ReplayPremiereServiceError,
  type ReplayPremiereJoinRequest,
  type ReplayPremiereJoinSyncUpdate,
  type ReplayPremiereServiceTradeResponse,
} from "src/client/ReplayPremiereRuntime";
import { WAGERING_BUILD_SENTINEL } from "../buildSentinel";
import { marketStateFromService } from "../serviceMapping";
import type { MarketState, TradeSide } from "../types";
import {
  mountBettingOverlay,
  type PremiereBettingOverlay,
} from "./BettingOverlay";

/** How often the standalone market poll refreshes prices while the market is live. */
const MARKET_POLL_INTERVAL_MS = 2_500;

/**
 * Retry delay for a poll that raced the join session's own bootstrap (see
 * `pollOnce`'s `session_required`/startup-auth handling) — short, since
 * it's a one-shot startup race, not a steady-state failure worth the full
 * poll interval.
 */
const SESSION_RETRY_DELAY_MS = 200;

/**
 * Cap on silent startup-auth retries (see `pollOnce`) — bounds a race that
 * should self-resolve within one or two ticks of `SESSION_RETRY_DELAY_MS`
 * to a fixed ~1s window, so a GENUINELY broken guest identity (never
 * recovers) still surfaces as a real, visible error instead of retrying
 * forever in silence.
 */
const STARTUP_AUTH_RETRY_LIMIT = 5;

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

/**
 * Window-global bridge for `GameRenderer.ts`'s standalone betting standings
 * leaderboard (`readBettingSeatPrice`) — that shared rendering module can't
 * statically import this wagering-feature type without coupling core game
 * rendering to a demo feature, so the market controller below writes its
 * prices here on every poll/trade instead. Set only while a betting page
 * is mounted; cleared on dispose so a leftover value can never leak into
 * an unrelated route navigated to next in the same tab.
 */
type BettingSeatPriceWindow = typeof window & {
  __bettingSeatPrices?: Readonly<Record<string, number>>;
};

function writeBettingSeatPrices(
  prices: Readonly<Record<string, number>>,
): void {
  (window as BettingSeatPriceWindow).__bettingSeatPrices = prices;
}

function clearBettingSeatPrices(): void {
  delete (window as BettingSeatPriceWindow).__bettingSeatPrices;
}

export class BettingPremiereMarketController {
  private overlay: PremiereBettingOverlay | null = null;
  private pollTimer: number | null = null;
  private polling = false;
  private started = false;
  private disposed = false;
  // Bounded count of silent startup-auth retries (see `pollOnce`) — reset
  // the instant a poll succeeds, so it only ever measures ONE continuous
  // startup race, never accumulates across the page's whole lifetime.
  private startupAuthRetryCount = 0;
  // Freshest observed anti-replay freshness bound — echoed back on the
  // NEXT order only (never cached across multiple orders); updated from
  // every poll AND every trade response's own market snapshot.
  private latestLiveVisibleSequence = 0;
  /**
   * Fires (once) when the ongoing poll proves THIS premiereId no longer
   * exists on the server at all — status 404 with the catalog's own
   * `PREMIERE_UNAVAILABLE` code (`registry.get(premiereId) === null` in
   * `ReplayPremiereHttp.ts`), never a transient 503 use of the same
   * public code (see `pollOnce`). Real cause: the origin process behind
   * `bet.proxywar.xyz` restarts on every premiere cycle (`cycle-
   * premiere.sh`'s `restart_origin`, "admission never hot-registers, the
   * catalog is rebuilt at boot") and mints a brand-new random premiereId
   * every time — this page's own premiereId is simply gone once that
   * happens, regardless of whether it voided or won. The runtime's own
   * manifest/reveal state has no way to notice this (nothing about it is
   * malformed FOR THAT premiere — it stays validly, permanently
   * terminal), so the caller (`Main.ts`) is the one place that can
   * honestly recover: re-resolve and rejoin whatever premiere is
   * actually live now (P1 t3-01/t3-02).
   */
  public onPremiereGone?: () => void;

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
    clearBettingSeatPrices();
  }

  private async submitTrade(
    seatId: string,
    side: TradeSide,
    amount: number,
    limitPrice: number,
  ): Promise<void> {
    const response = await this.submitTradeWithRetry(
      seatId,
      side,
      amount,
      limitPrice,
    );
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
      this.startupAuthRetryCount = 0;
    } catch (error) {
      if (this.disposed) return;
      const isStartupAuthRace =
        error instanceof ReplayPremiereServiceError &&
        (error.code === "session_required" ||
          // The join session's own POST .../sessions and this poll's GET
          // .../market/me can land in either order on a cold boot — a
          // 401/403 here as often means "the guest cookie/CSRF the
          // session bootstrap is about to (re)establish hasn't landed on
          // THIS request yet" as it means a real rejection. Indistinguishable
          // from the outside, so treat it exactly like `session_required`:
          // a bounded, silent retry, never a flashed raw error code, for
          // the first `STARTUP_AUTH_RETRY_LIMIT` attempts. Mirrors
          // `ReplayPremiereRuntime.sendHeartbeat`'s identical 401/403
          // recovery for the exact same race, one level up the stack.
          (error.code === "request_rejected" &&
            (error.status === 401 || error.status === 403)));
      if (
        isStartupAuthRace &&
        this.startupAuthRetryCount < STARTUP_AUTH_RETRY_LIMIT
      ) {
        this.startupAuthRetryCount += 1;
        window.setTimeout(() => void this.pollOnce(), SESSION_RETRY_DELAY_MS);
        return;
      }
      // Distinct from `isStartupAuthRace` above and from the generic
      // `marketLoadError` fallback below: a 404 carrying the catalog's
      // own "not registered" public code is never transient (unlike the
      // SAME public code's 503 uses elsewhere for "temporarily
      // unavailable, try again") — it is proof this premiereId was
      // dropped from the server's registry entirely (see
      // `onPremiereGone`'s own doc). Fire at most once; the caller
      // disposes this controller in response, so further polls never
      // reach here anyway, but a same-tick double-fire is guarded
      // regardless.
      const premiereGone =
        error instanceof ReplayPremiereServiceError &&
        error.status === 404 &&
        error.publicCode === "PREMIERE_UNAVAILABLE";
      if (premiereGone) {
        this.onPremiereGone?.();
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
    writeBettingSeatPrices(market.prices);
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
  /** See `BettingPremiereMarketController.onPremiereGone`'s own doc. */
  onPremiereGone?: () => void;
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
  // Inspectable build-provenance stamp (see `../buildSentinel.ts`): a live
  // observable USE of the sentinel literal, so no minification pass can
  // argue the marker is dead. League builds never reach this code — this
  // whole module is aliased to a stub there.
  document.body.dataset.proxywarWageringBuild = WAGERING_BUILD_SENTINEL;
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
  market.onPremiereGone = callbacks.onPremiereGone;
  return {
    runtime,
    dispose: () => {
      market?.dispose();
      runtime.dispose();
      document.body.classList.remove(BETTING_SPECTATOR_BODY_CLASS);
      delete document.body.dataset.proxywarWageringBuild;
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

/**
 * Re-resolves "whichever premiere is live right now" via the EXACT same
 * server-side redirect the "Go to the live market" CTA on the themed
 * ended page already relies on (`GET /bet` 302s to `/bet/<currentId>` —
 * `PremiereEndedPage.ts`'s primary link, `href="/bet"`) — never a client
 * guess, never a second source of truth. Used to recover automatically
 * when an already-joined betting page's poll discovers its own
 * premiereId is gone (`BettingPremiereMarketController.onPremiereGone`,
 * P1 t3-01/t3-02: the origin process restarts and mints a fresh random
 * premiereId on every single premiere cycle, void or not — see that
 * field's doc). Returns `null` on any network failure or if `/bet`
 * didn't resolve to a betting-premiere route — never fabricates an id.
 * `fetchImpl` is injectable for tests, same pattern as this module's own
 * `runtime`/`overlay` seams.
 */
export async function resolveCurrentBettingPremiereId(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl("/bet", {
      method: "GET",
      redirect: "follow",
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    });
    void response.body?.cancel();
    if (!response.ok) return null;
    return parseBettingPremiereRoute(new URL(response.url).pathname);
  } catch {
    return null;
  }
}
