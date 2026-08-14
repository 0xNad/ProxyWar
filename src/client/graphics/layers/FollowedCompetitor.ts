import { EventBus } from "../../../core/EventBus";
import { GameView } from "../../../core/game/GameView";
import { aiLeagueSpectatorDisplayName } from "../../AiLeagueReplayMode";
import {
  ContextMenuEvent,
  TouchEvent as InputTouchEvent,
  MouseUpEvent,
} from "../../InputHandler";
import { translateText } from "../../Utils";
import { TransformHandler } from "../TransformHandler";

/**
 * ============================================================================
 * FOLLOWED COMPETITOR — the viewer's standing "I care about this one".
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The broadcast may not move the camera on its own. A viewer watching the
 * whole board is READING it, and yanking the view to narrate a beat they did
 * not ask about is a worse experience than missing the beat — Maxwell's note
 * on the r38 nuke cinema, and it is right: the default has to be that the map
 * stays where the viewer put it.
 *
 * But a viewer who has picked a side wants the opposite. Once you are
 * following someone, a warhead aimed at them IS your story and cutting to it
 * is exactly what a broadcast should do. So the camera is not disabled, it is
 * CONDITIONAL: no follow, no camera movement, ever.
 *
 * THE GESTURE: EITHER BUTTON, ON THE MAP
 * ---------------------------------------
 * Nothing else on this surface can express "this one". The competitor rail is
 * hidden under the native spectator skin (`.broadcast-rail` is display:none),
 * and the scorebug is deliberately `pointer-events: none` — its expander would
 * be a dead end at broadcast sizes.
 *
 * Right-click came first, because `ContextMenuEvent` is what `PlayerInfoOverlay`
 * already listens to and the radial menu is hard-returned for spectators, so
 * there was nothing to conflict with. But right-click is not a gesture a viewer
 * TRIES on a video-shaped surface: every other broadcast player in the world
 * responds to a plain click, and the one that only responds to a secondary
 * button reads as inert. So the primary click selects too, and everything
 * about the selection is identical either way.
 *
 * Left-click is `MouseUpEvent`, which `InputHandler` emits for a press that
 * did not travel far enough to be a drag (`DRAG_THRESHOLD_PX`) — so panning
 * the board never selects anything, which is the whole reason to listen for
 * the UP rather than the down.
 *
 * Both gestures are their own undo: clicking the nation you are already
 * following clears it, and so does clicking open water or unclaimed ground.
 * Nothing here ever needs a close button.
 *
 * WHY LEFT-CLICK HAS TO HIT-TEST AND RIGHT-CLICK DOES NOT
 * -------------------------------------------------------
 * `contextmenu` is bound to the CANVAS, so a right-click can only ever arrive
 * from the board. `pointerup` is bound to the WINDOW (see InputHandler's
 * listener table), so a plain click on the transport cluster's pause button —
 * or on any other genuinely clickable chrome — arrives here too, carrying
 * viewport coordinates that happily resolve to whatever nation is on the board
 * underneath. Pausing the replay would silently change who you are following.
 *
 * `elementFromPoint` settles it: it skips everything that is
 * `pointer-events: none` (which is nearly all of this stage's chrome by
 * design), so if the topmost hit-testable element under the cursor is a
 * canvas, the click really did land on the board.
 *
 * IDENTITY IS `smallID()`, NOT `clientID()`
 * ------------------------------------------
 * `clientID()` is null for every AI agent in a rendered replay — the same trap
 * documented on the end card's winner detection — so it cannot identify a
 * competitor here. `smallID()` is the engine's own per-match player index and
 * is what `GameMap` ownership is keyed on.
 */

/** Nothing is followed by default: the camera stays where the viewer put it. */
let followedSmallId: number | null = null;
let installed: (() => void) | null = null;
/**
 * The live instance's `GameView` and its chip-render closure, held only so
 * `restoreFollowedCompetitor` (below) can re-validate an id against the
 * CURRENT instance and repaint the chip through the exact same path a click
 * does — never a second render implementation that could drift from it.
 * Both are set at the end of `installFollowedCompetitor` and cleared in
 * `dispose()`, same lifetime as `installed` just above.
 */
let currentGame: GameView | null = null;
let currentRender: (() => void) | null = null;

export function followedCompetitorSmallId(): number | null {
  return followedSmallId;
}

/**
 * Re-applies a followed selection that was captured from a PREVIOUS game
 * instance of the same match — the one caller today is `Main.ts`'s in-place
 * rewind, which reads `followedCompetitorSmallId()` before tearing the old
 * instance down (that teardown is what resets `followedSmallId` to null via
 * `installFollowedCompetitor`'s own reset, see its doc) and hands the id
 * back here once the rebuilt instance has fired its first frame.
 *
 * WHY THIS CANNOT JUST BE `followedSmallId = smallId; render();`
 * -----------------------------------------------------------------
 * `GameView.playerBySmallID` does not return `undefined` for an id it does
 * not recognise the way this file's own `render()` guard above appears to
 * assume — it THROWS (`small id ${id} not found`, see `GameView.ts`).
 * `render()` never hits that path in the click flow because every id it is
 * ever given there comes from `owner.smallID()` on a tile in the SAME live
 * instance, which by construction already has it registered. A rewind's
 * saved id comes from a DIFFERENT (pre-rewind) instance of the same match,
 * rebuilt from scratch — and `_players` is insert-only, populated only as
 * the resimulation processes update batches, so a competitor who spawns
 * later in the match may genuinely not be registered yet at the very first
 * frame this is restored on. Catching that is what makes this "no-op safely
 * for an id that does not resolve to a player": following just stays off
 * (exactly the state a fresh install already left it in) instead of an
 * uncaught throw escaping out of a `document` event listener.
 *
 * A `null` id, or a call before any instance has installed, is also a
 * deliberate no-op — there is nothing to restore either way.
 */
/**
 * Returns true once the follow has actually COMMITTED. The caller retries per
 * frame during a resimulation because a later-spawning competitor does not
 * exist in the rebuilt GameView until its first update batch arrives — a
 * false return means "not yet", not "never".
 */
export function restoreFollowedCompetitor(smallId: number | null): boolean {
  if (smallId === null) return true; // nothing to restore — done by definition
  if (currentGame === null || currentRender === null) return false;
  try {
    const candidate = currentGame.playerBySmallID(smallId);
    if (!candidate.isPlayer()) return false;
  } catch {
    return false;
  }
  followedSmallId = smallId;
  currentRender();
  return true;
}

/**
 * Installs the follow gesture and its on-screen marker for one game instance.
 * Returns a disposer, matching this codebase's plain-installer convention
 * (`installCompetitorLocateBridge`, `bindReplaySpeedPersistence`).
 */
export function installFollowedCompetitor(
  game: GameView,
  eventBus: EventBus,
  transformHandler: TransformHandler,
): () => void {
  installed?.();
  followedSmallId = null;
  currentGame = null;
  currentRender = null;

  mountFollowChipStyles();
  // IDEMPOTENT MOUNT. An in-place rewind tears the game down and builds a new
  // one without a page reload, so init() runs again against a document that
  // still holds the previous instance's node. Without this you get two of
  // these stacked on top of each other, the older one frozen forever because
  // its layer is no longer ticked. Adopting-by-removal rather than reusing the
  // node keeps this one line instead of a resurrection path.
  document.querySelector(".pw-following-chip")?.remove();
  const chip = document.createElement("div");
  chip.className = "pw-following-chip";
  document.body.appendChild(chip);

  const render = () => {
    if (followedSmallId === null) {
      chip.textContent = "";
      chip.dataset.on = "0";
      return;
    }
    const player = game.playerBySmallID(followedSmallId);
    if (player === undefined || !player.isPlayer()) {
      chip.textContent = "";
      chip.dataset.on = "0";
      return;
    }
    const name = aiLeagueSpectatorDisplayName(
      player.displayName(),
    ).toUpperCase();
    chip.textContent = translateText(
      "ai_league_replay.following_competitor",
      { name },
      `FOLLOWING · ${name}`,
    );
    chip.dataset.on = "1";
  };
  // Published for `restoreFollowedCompetitor` — see that function's own doc
  // for why it needs both the game (to re-validate a saved id against THIS
  // instance before trusting it) and this exact closure (to repaint the
  // chip through the one render path, rather than a second implementation).
  currentGame = game;
  currentRender = render;

  /** The one selection rule, shared by both buttons. */
  const selectAt = (screenX: number, screenY: number) => {
    const world = transformHandler.screenToWorldCoordinates(screenX, screenY);
    if (!game.isValidCoord(world.x, world.y)) return;
    const owner = game.owner(game.ref(world.x, world.y));
    if (!owner.isPlayer()) {
      // Open water or unclaimed ground: the deliberate way to stop following.
      followedSmallId = null;
      render();
      return;
    }
    // Clicking the nation you are already following clears it, so the gesture
    // is its own undo and never needs a second control.
    followedSmallId =
      followedSmallId === owner.smallID() ? null : owner.smallID();
    render();
  };

  // EVERY path hit-tests, including this one. The assumption that
  // ContextMenuEvent only ever originates from the canvas's own contextmenu
  // listener is FALSE: with the live-play "left click opens menu" setting
  // persisted, InputHandler synthesises ContextMenuEvent from a WINDOW-level
  // pointerup for ordinary left clicks — so without the guard, a click on the
  // pause button would silently re-follow whatever nation sits under the
  // transport cluster. Real right-clicks on the board pass the test trivially.
  const onBoard = (x: number, y: number): boolean => {
    const hit = document.elementFromPoint(x, y);
    return hit !== null && hit.tagName === "CANVAS";
  };

  const onContextMenu = (event: ContextMenuEvent) => {
    if (!onBoard(event.x, event.y)) return;
    selectAt(event.x, event.y);
  };

  const onMouseUp = (event: MouseUpEvent) => {
    if (!onBoard(event.x, event.y)) return;
    selectAt(event.x, event.y);
  };

  // Touch: InputHandler emits its own TouchEvent class for a tap, never
  // MouseUpEvent — without this, following is simply impossible on touch.
  const onTouch = (event: InputTouchEvent) => {
    if (!onBoard(event.x, event.y)) return;
    selectAt(event.x, event.y);
  };

  eventBus.on(ContextMenuEvent, onContextMenu);
  eventBus.on(MouseUpEvent, onMouseUp);
  eventBus.on(InputTouchEvent, onTouch);
  render();

  const dispose = () => {
    // The EventBus is a single page-lifetime instance and nothing else in the
    // game path ever calls off(), so a handler left registered here outlives
    // its GameView. After two in-place restarts three handlers would all
    // toggle the same module-level `followedSmallId`, and a single click
    // would flip it an odd or even number of times — follow would work
    // intermittently, which is worse than not working. Every listener this
    // installer adds has to come back out through here, not just the first one.
    eventBus.off(ContextMenuEvent, onContextMenu);
    eventBus.off(MouseUpEvent, onMouseUp);
    eventBus.off(InputTouchEvent, onTouch);
    chip.remove();
    followedSmallId = null;
    installed = null;
    currentGame = null;
    currentRender = null;
  };
  installed = dispose;
  return dispose;
}

let stylesMounted = false;

function mountFollowChipStyles() {
  if (stylesMounted) return;
  stylesMounted = true;
  const style = document.createElement("style");
  style.id = "pw-following-chip-styles";
  style.textContent = `
    /* Sits directly above the board identity chip, in the same out-of-every-
     * lane corner, and in amber because amber is this stage's only chrome
     * accent. Empty when nothing is followed — a panel never renders empty. */
    .pw-following-chip {
      position: fixed;
      right: 14px;
      bottom: 82px;
      z-index: 50003;
      pointer-events: none;
      display: none;
      padding: 3px 7px;
      font: 600 9px/1.4 var(--pw-display, "Avenir Next", "Futura", system-ui, sans-serif);
      letter-spacing: 0.15em;
      color: var(--pw-accent, #ffc24a);
      background: var(--pw-glass-strong, rgba(24, 20, 17, 0.93));
      border: 1px solid rgba(255, 194, 74, 0.34);
    }
    .pw-following-chip[data-on="1"] { display: block; }
    body.pw-endcard-open .pw-following-chip { display: none; }
  `;
  document.head.appendChild(style);
}
