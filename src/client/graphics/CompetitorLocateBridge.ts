import { EventBus } from "../../core/EventBus";
import { GameView, PlayerView } from "../../core/game/GameView";
import { GoToPlayerEvent } from "./TransformHandler";

/**
 * Dispatched by the Stage 4 broadcast composition's competitor rail (either
 * overlay, `AiLeagueReplayOverlay.ts` / `ReplayPremiereOverlay.ts`) when a
 * viewer clicks a rail seat, with `detail: { playerName: string; clientID:
 * string | null }`. `clientID` is what this module actually resolves the
 * click to a real PlayerView with — a rail seat's human-readable
 * `playerName` lives in a completely disjoint namespace from
 * `PlayerView.name()`/`.displayName()` (procedurally-generated in-game
 * nation names), so matching on `playerName` alone can never resolve a real
 * player; `clientID` (`AiLeagueReplayFramePlayer.clientID` /
 * `ReplayPremiereRailSeatView.seatId`, both === `PlayerView.clientID()`) is
 * the identifier both sides actually share. `playerName` survives as a
 * fallback only for a caller that hasn't been updated to supply it.
 *
 * This is a plain DOM CustomEvent bridge, not an EventBus event, because the
 * rail is rendered by plain DOM-builder functions with no EventBus/GameView
 * access of their own — the same cross-overlay bridge pattern
 * `ai-league-replay-jump-turn` already uses for a different control.
 *
 * A competitor click is a ONE-SHOT camera locate only: no persisted
 * "followed" selection, no territory dimming, no leaderboard pin/highlight,
 * and no further camera movement after the click resolves. See
 * `TransformHandler.onGoToPlayer`'s spectator branch for the one-shot,
 * clamp-bounded destination math this bridge triggers.
 */
export const BROADCAST_RAIL_LOCATE_EVENT = "broadcast-rail-locate-player";

/**
 * The single currently-installed listener, if any — `document` is a page-
 * global, so without this a second `installCompetitorLocateBridge()` call
 * (a genuine re-mount: HMR, or any future caller that re-initializes
 * `GameRenderer` without a full page reload) would stack a SECOND listener
 * closing over the OLD `game`/`eventBus`, alongside the new one, rather
 * than replacing it — every rail click would then resolve against and pan
 * a now-stale `GameView` in addition to the current one. Module-level
 * singleton state (same "one-of-these-per-page" shape as
 * `ReplayPositionPersistence.ts`'s own last-saved-turn tracking) makes each
 * new install first tear down whatever it's replacing.
 */
let activeListener: ((event: Event) => void) | null = null;

/**
 * Installs the rail-click -> camera-locate bridge for one replay/spectator
 * game instance. Mounted once per game load from `GameRenderer.ts`
 * (`isReplaySpectatorView()`-gated, same as the feature it replaces); live
 * play never mounts this and is unaffected.
 *
 * Singleton + returned-cleanup, matching this codebase's existing plain-
 * installer convention (`mountControlClusterGeometrySync`,
 * `bindReplaySpeedPersistence`, `bindReplayShareImageRequests`, all of
 * which return `() => void`): calling this again for a NEW game/eventBus
 * first removes the previous listener (so an old `GameView` can never keep
 * handling clicks, and a click is never double-handled), then returns a
 * disposer for a caller that wants to tear this down explicitly without
 * installing a replacement.
 */
export function installCompetitorLocateBridge(
  game: GameView,
  eventBus: EventBus,
): () => void {
  if (activeListener !== null) {
    document.removeEventListener(BROADCAST_RAIL_LOCATE_EVENT, activeListener);
    activeListener = null;
  }

  const onLocateRequest = (event: Event): void => {
    const detail = (
      event as CustomEvent<{ playerName?: string; clientID?: string | null }>
    ).detail;
    const players = game.playerViews();
    let player: PlayerView | null = null;
    if (typeof detail?.clientID === "string") {
      player = players.find((p) => p.clientID() === detail.clientID) ?? null;
    }
    if (player === null && typeof detail?.playerName === "string") {
      player =
        players.find(
          (p) =>
            p.displayName() === detail.playerName ||
            p.name() === detail.playerName,
        ) ?? null;
    }
    if (player === null) return;
    eventBus.emit(new GoToPlayerEvent(player));
  };

  document.addEventListener(BROADCAST_RAIL_LOCATE_EVENT, onLocateRequest);
  activeListener = onLocateRequest;

  return () => {
    if (activeListener !== onLocateRequest) return;
    document.removeEventListener(BROADCAST_RAIL_LOCATE_EVENT, onLocateRequest);
    activeListener = null;
  };
}
