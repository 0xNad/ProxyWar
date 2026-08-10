import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { GameType } from "../../../core/game/Game";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import { GameView } from "../../../core/game/GameView";
import { translateText } from "../../Utils";
import { isReplaySpectatorView } from "../TransformHandler";
import { Layer } from "./Layer";

@customElement("heads-up-message")
export class HeadsUpMessage extends LitElement implements Layer {
  public game: GameView;

  @state()
  private isVisible = false;

  @state()
  private isPaused = false;

  @state()
  private isImmunityActive = false;

  @state()
  private isCatchingUp = false;
  private catchingUpTicks = 0;

  private static readonly CATCHING_UP_SHOW_THRESHOLD = 10;

  @state()
  private toastMessage: string | import("lit").TemplateResult | null = null;
  @state()
  private toastColor: "green" | "red" = "green";
  private toastTimeout: number | null = null;
  // P0 fix (2026-08-03, item 3a): combat toasts (build/attack/etc.
  // "show-message" events) kept firing and stacking up over the win
  // banner once a match ended -- the toast (z-[800], top-6) and WinModal's
  // centered banner (z-[10010], top-1/2) don't overlap, so a toast was
  // fully VISIBLE alongside the banner regardless of z-index, reading as a
  // frozen HUD rather than a finished match. Cleared once and suppressed
  // thereafter (`show-message` is a global window event fired by anything
  // still resolving post-match cleanup ticks).
  private matchEnded = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(
      "show-message",
      this.handleShowMessage as EventListener,
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(
      "show-message",
      this.handleShowMessage as EventListener,
    );
    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
    }
  }

  private handleShowMessage = (event: CustomEvent) => {
    if (this.matchEnded) return;
    const { message, duration, color } = event.detail ?? {};
    if (
      typeof message === "string" ||
      (message && typeof message.values === "object")
    ) {
      this.toastMessage = message;
      this.toastColor = color === "red" ? "red" : "green";
      this.requestUpdate();
      if (this.toastTimeout) {
        clearTimeout(this.toastTimeout);
      }
      this.toastTimeout = window.setTimeout(
        () => {
          this.toastMessage = null;
          this.requestUpdate();
        },
        typeof duration === "number" ? (duration ?? 2000) : 2000,
      );
    }
  };

  init() {
    this.isVisible = true;
    this.requestUpdate();
  }

  tick() {
    const updates = this.game.updatesSinceLastTick();
    if (updates && updates[GameUpdateType.GamePaused].length > 0) {
      const pauseUpdate = updates[GameUpdateType.GamePaused][0];
      this.isPaused = pauseUpdate.paused;
    }
    if (updates && updates[GameUpdateType.Win].length > 0) {
      this.matchEnded = true;
      this.toastMessage = null;
      clearTimeout(this.toastTimeout ?? undefined);
      this.toastTimeout = null;
    }

    const showImmunityHudDuration = 10 * 10;
    const spawnEnd = this.game.config().numSpawnPhaseTurns();
    const ticksSinceSpawnEnd = this.game.ticks() - spawnEnd;

    this.isImmunityActive =
      this.game.config().hasExtendedSpawnImmunity() &&
      !this.game.inSpawnPhase() &&
      this.game.isSpawnImmunityActive() &&
      ticksSinceSpawnEnd < showImmunityHudDuration;

    const currentlyCatchingUp =
      !this.game.config().isReplay() && this.game.isCatchingUp();

    if (currentlyCatchingUp) {
      this.catchingUpTicks++;
    } else {
      this.catchingUpTicks = 0;
    }

    this.isCatchingUp =
      this.catchingUpTicks >= HeadsUpMessage.CATCHING_UP_SHOW_THRESHOLD;

    // "Choose a starting location" is a player instruction — spectators on
    // replay/premiere routes can't spawn, so the spawn-phase banner stays
    // hidden for them (pause/immunity/catch-up notices still show).
    this.isVisible =
      (this.game.inSpawnPhase() && !isReplaySpectatorView()) ||
      this.isPaused ||
      this.isImmunityActive ||
      this.isCatchingUp;
    this.requestUpdate();
  }

  private getMessage(): string {
    if (this.isCatchingUp) {
      return translateText("heads_up_message.catching_up");
    }
    if (this.isPaused) {
      if (this.game.config().gameConfig().gameType === GameType.Singleplayer) {
        return translateText("heads_up_message.singleplayer_game_paused");
      } else {
        return translateText("heads_up_message.multiplayer_game_paused");
      }
    }
    if (this.isImmunityActive) {
      return translateText("heads_up_message.pvp_immunity_active", {
        seconds: Math.round(this.game.config().spawnImmunityDuration() / 10),
      });
    }
    return this.game.config().isRandomSpawn()
      ? translateText("heads_up_message.random_spawn")
      : translateText("heads_up_message.choose_spawn");
  }

  render() {
    return html`
      <div style="pointer-events: none;">
        ${this.toastMessage
          ? html`
              <div
                class="fixed top-6 left-1/2 -translate-x-1/2 z-[800] px-6 py-4 rounded-xl transition-all duration-300 animate-fade-in-out"
                style="max-width: 90vw; min-width: 200px; text-align: center;
                  background: ${this.toastColor === "red"
                  ? "rgba(239,68,68,0.1)"
                  : "rgba(34,197,94,0.1)"};
                  border: 1px solid ${this.toastColor === "red"
                  ? "rgba(239,68,68,0.5)"
                  : "rgba(34,197,94,0.5)"};
                  color: white;
                  box-shadow: 0 0 30px 0 ${this.toastColor === "red"
                  ? "rgba(239,68,68,0.3)"
                  : "rgba(34,197,94,0.3)"};
                  backdrop-filter: blur(12px);"
                @contextmenu=${(e: MouseEvent) => e.preventDefault()}
              >
                ${typeof this.toastMessage === "string"
                  ? html`<span class="font-medium">${this.toastMessage}</span>`
                  : this.toastMessage}
              </div>
            `
          : null}
        ${this.isVisible
          ? html`
              <div
                class="fixed top-[15%] left-1/2 -translate-x-1/2 z-[799]
                            inline-flex items-center justify-center min-h-8 lg:min-h-10
                            w-fit max-w-[90vw]
                            bg-gray-800/70 rounded-md lg:rounded-lg
                            backdrop-blur-xs text-white text-md lg:text-xl px-3 lg:px-4 py-1
                            text-center break-words"
                style="word-wrap: break-word; hyphens: auto;"
                @contextmenu=${(e: MouseEvent) => e.preventDefault()}
              >
                ${this.getMessage()}
              </div>
            `
          : null}
      </div>
    `;
  }
}
