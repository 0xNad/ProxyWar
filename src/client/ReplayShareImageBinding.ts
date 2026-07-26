/**
 * Wiring between the replay panel's share button and the live game canvas.
 *
 * The panel is presentational and mounted independently of the renderer, so it
 * asks for a capture by dispatching a DOM event (the same pattern the jump/pause
 * controls already use). This binding lives where the canvas and GameView are
 * both in scope and answers that request.
 */

import type { GameView } from "../core/game/GameView";
import { aiLeagueSpectatorDisplayName } from "./AiLeagueReplayMode";
import {
  composeReplayShareImage,
  deliverReplayShareImage,
  replayShareImageBlob,
  replayShareImageFileName,
  type ReplayShareImageDelivery,
  type ReplayShareStanding,
} from "./ReplayShareImage";

/** Panel -> renderer: "capture the frame the viewer is looking at". */
export const REPLAY_SHARE_IMAGE_REQUEST_EVENT = "ai-league-replay-share-image";
/** Renderer -> panel: outcome, so the button can report what happened. */
export const REPLAY_SHARE_IMAGE_RESULT_EVENT =
  "ai-league-replay-share-image-result";

export interface ReplayShareImageResultDetail {
  ok: boolean;
  delivery?: ReplayShareImageDelivery;
}

/**
 * Territory share denominators must match what the leaderboard shows, or the
 * shared image quietly disagrees with the page it came from. Fallout tiles are
 * excluded there, so they are excluded here.
 */
export function readReplayShareStandings(
  game: GameView,
): ReplayShareStanding[] {
  const contestable = game.numLandTiles() - game.numTilesWithFallout();
  const denominator = contestable > 0 ? contestable : game.numLandTiles();
  return game.playerViews().map((player) => ({
    name: aiLeagueSpectatorDisplayName(player.displayName()),
    share: denominator > 0 ? player.numTilesOwned() / denominator : 0,
    color: game.config().theme().territoryColor(player).toHex(),
    isAlive: player.isAlive(),
  }));
}

/**
 * Caption identity for the image. The map is the one piece of match context a
 * reader outside the league can actually place, so it leads; anything richer
 * (round number, opponents) lives on the page the image links back to.
 */
export function replayShareImageTitle(game: GameView): string {
  // Resolved lazily at capture time and defensively: a caption is cosmetic, and
  // an incomplete or stubbed GameView must never turn a nice-to-have into a
  // thrown error on a path the game depends on.
  try {
    const map = game.config?.().gameConfig?.().gameMap;
    return typeof map === "string" && map.trim() !== "" ? map : "Proxy War";
  } catch {
    return "Proxy War";
  }
}

export interface ReplayShareImageBindingOptions {
  canvas: HTMLCanvasElement;
  game: GameView;
  runId: string;
  /** Injectable for tests. */
  target?: EventTarget;
}

/**
 * Listen for capture requests until disposed. Returns a disposer.
 */
export function mountReplayShareImageCapture(
  options: ReplayShareImageBindingOptions,
): () => void {
  const target = options.target ?? document;
  const onRequest = (): void => {
    void (async () => {
      let detail: ReplayShareImageResultDetail = { ok: false };
      try {
        const turn = options.game.ticks();
        const canvas = composeReplayShareImage({
          source: options.canvas,
          standings: readReplayShareStandings(options.game),
          title: replayShareImageTitle(options.game),
          subtitle: `Turn ${turn.toLocaleString()}`,
        });
        const blob = await replayShareImageBlob(canvas);
        const delivery = await deliverReplayShareImage(
          blob,
          replayShareImageFileName(options.runId, turn),
        );
        detail = { ok: true, delivery };
      } catch (error) {
        // A failed capture must never break playback; report and carry on.
        console.error("[share-image] capture failed", error);
      }
      target.dispatchEvent(
        new CustomEvent<ReplayShareImageResultDetail>(
          REPLAY_SHARE_IMAGE_RESULT_EVENT,
          { detail },
        ),
      );
    })();
  };
  target.addEventListener(REPLAY_SHARE_IMAGE_REQUEST_EVENT, onRequest);
  return () => {
    target.removeEventListener(REPLAY_SHARE_IMAGE_REQUEST_EVENT, onRequest);
  };
}
