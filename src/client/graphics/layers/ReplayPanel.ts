import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import { GameView } from "../../../core/game/GameView";
import { isAiLeagueReplayRoute } from "../../AiLeagueReplayMode";
import { ReplaySpeedChangeEvent } from "../../InputHandler";
import {
  defaultReplaySpeedMultiplier,
  ReplaySpeedMultiplier,
} from "../../utilities/ReplaySpeedMultiplier";
import { translateText } from "../../Utils";
import { Layer } from "./Layer";

export class ShowReplayPanelEvent {
  constructor(
    public visible: boolean = true,
    public isSingleplayer: boolean = false,
  ) {}
}

@customElement("replay-panel")
export class ReplayPanel extends LitElement implements Layer {
  public game: GameView | undefined;
  public eventBus: EventBus | undefined;

  @property({ type: Boolean })
  visible: boolean = false;

  @state()
  private _replaySpeedMultiplier: number = defaultReplaySpeedMultiplier;

  @property({ type: Boolean })
  isSingleplayer = false;

  createRenderRoot() {
    return this; // Enable Tailwind CSS
  }

  init() {
    if (this.eventBus) {
      // Main.ts's join.then() handler sets the archived-replay broadcast to
      // a watchable 2x (or `fastest` off the plain analyst surface) the
      // instant an AI League replay joins, via a synchronous
      // `eventBus.emit(new ReplaySpeedChangeEvent(..., "auto"))` inside
      // `join.then()` -- before `createClientGame()`'s async layer
      // construction ever reaches this component's own `init()` below and
      // registers the listener. `EventBus.emit()` has zero buffering for a
      // not-yet-registered listener (see EventBus.emit's own doc), so that
      // first "auto" emit is silently dropped here every time, leaving
      // `_replaySpeedMultiplier` stuck at its field-initializer default
      // (1x) while the game is actually already running at 2x -- the ×1
      // button stayed highlighted for the whole match. LocalServer.ts hit
      // the identical race for its own copy of this state and fixed it the
      // same way: derive the SAME starting value directly here instead of
      // depending on catching that one racy emit.
      this._replaySpeedMultiplier = this.resolveInitialReplaySpeedMultiplier();
      this.eventBus.on(ShowReplayPanelEvent, (event: ShowReplayPanelEvent) => {
        this.visible = event.visible;
        this.isSingleplayer = event.isSingleplayer;
      });
      this.eventBus.on(
        ReplaySpeedChangeEvent,
        (event: ReplaySpeedChangeEvent) => {
          this._replaySpeedMultiplier = event.replaySpeedMultiplier;
          this.requestUpdate();
        },
      );
    }
  }

  /**
   * Mirrors Main.ts's "broadcast opens at 2x" rule (see `init()`'s doc for
   * why the emitted event that would normally carry this can't be trusted).
   * Live play is untouched: `isAiLeagueReplayRoute()` is false there, so
   * this always falls through to the ordinary field-initializer default.
   */
  private resolveInitialReplaySpeedMultiplier(): ReplaySpeedMultiplier {
    if (!isAiLeagueReplayRoute() || !this.game?.config()?.isReplay()) {
      return defaultReplaySpeedMultiplier;
    }
    const staticBroadcast =
      (window as typeof window & { __PROXYWAR_STATIC_REPLAY__?: boolean })
        .__PROXYWAR_STATIC_REPLAY__ === true;
    return staticBroadcast
      ? ReplaySpeedMultiplier.fast
      : ReplaySpeedMultiplier.fastest;
  }

  getTickIntervalMs() {
    return 1000;
  }

  tick() {
    if (!this.visible) return;
    this.requestUpdate();
  }

  onReplaySpeedChange(value: ReplaySpeedMultiplier) {
    this._replaySpeedMultiplier = value;
    this.eventBus?.emit(new ReplaySpeedChangeEvent(value, "user"));
  }

  renderLayer(_ctx: CanvasRenderingContext2D) {}
  shouldTransform() {
    return false;
  }

  render() {
    if (!this.visible) return html``;

    return html`
      <div
        class="p-2 bg-glass backdrop-blur-sm shadow-xs min-[1200px]:rounded-lg rounded-l-lg"
        @contextmenu=${(e: Event) => e.preventDefault()}
      >
        <label class="block mb-2 text-white" translate="no">
          ${this.game?.config()?.isReplay()
            ? translateText("replay_panel.replay_speed")
            : translateText("replay_panel.game_speed")}
        </label>
        <div class="grid grid-cols-4 gap-2">
          ${this.renderSpeedButton(ReplaySpeedMultiplier.slow, "×0.5")}
          ${this.renderSpeedButton(ReplaySpeedMultiplier.normal, "×1")}
          ${this.renderSpeedButton(ReplaySpeedMultiplier.fast, "×2")}
          ${this.renderSpeedButton(
            ReplaySpeedMultiplier.fastest,
            translateText("replay_panel.fastest_game_speed"),
          )}
        </div>
      </div>
    `;
  }

  private renderSpeedButton(value: ReplaySpeedMultiplier, label: string) {
    const backgroundColor =
      this._replaySpeedMultiplier === value ? "bg-malibu-blue" : "";

    return html`
      <button
        class="py-0.5 px-1 text-sm text-white rounded-sm border transition border-gray-500 ${backgroundColor} hover:border-gray-200"
        @click=${() => this.onReplaySpeedChange(value)}
      >
        ${label}
      </button>
    `;
  }
}
