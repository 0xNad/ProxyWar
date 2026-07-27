import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { assetUrl } from "../../../core/AssetUrls";
import { isBettingPremiereRoute } from "../../AiLeagueReplayMode";
import { EventBus } from "../../../core/EventBus";
import { GameType } from "../../../core/game/Game";
import { GameView } from "../../../core/game/GameView";
import { crazyGamesSDK } from "../../CrazyGamesSDK";
import {
  ReplaySpeedChangeEvent,
  TogglePauseIntentEvent,
} from "../../InputHandler";
import { defaultReplaySpeedMultiplier } from "../../utilities/ReplaySpeedMultiplier";
import { PauseGameIntentEvent, SendWinnerEvent } from "../../Transport";
import { translateText } from "../../Utils";
import { ImmunityBarVisibleEvent } from "./ImmunityTimer";
import { Layer } from "./Layer";
import { ShowReplayPanelEvent } from "./ReplayPanel";
import { ShowSettingsModalEvent } from "./SettingsModal";
import { SpawnBarVisibleEvent } from "./SpawnTimer";
/**
 * ReplaySpeedMultiplier is a DELAY multiplier, not a speed one: slow=2 means
 * twice the delay (half speed) and fastest=0 means no delay (max speed).
 * Rendering the raw value therefore labelled max speed as "0x" and half speed
 * as "2x" — the exact inverse of the truth. Map it to what a viewer means.
 */
function playbackSpeedLabel(multiplier: number): string {
  if (multiplier === 0) return translateText("game_controls.speed_max");
  if (multiplier <= 0) return translateText("game_controls.speed_max");
  const speed = 1 / multiplier;
  return `${Number.isInteger(speed) ? speed : speed.toFixed(1)}\u00d7`;
}

// Shared affordance for every control in the top-right cluster. These were bare
// <div class="cursor-pointer"> wrappers: not focusable, no keyboard activation,
// no hover/focus feedback, and 20px hit targets. One class keeps them
// consistent and gives mobile a 44px target.
const CONTROL_BUTTON_CLASS =
  "flex items-center justify-center rounded-md p-1.5 min-w-[34px] min-h-[34px] " +
  "max-[1199px]:min-w-[44px] max-[1199px]:min-h-[44px] transition-colors " +
  "hover:bg-white/10 active:bg-white/15 focus-visible:outline-hidden " +
  "focus-visible:ring-2 focus-visible:ring-info/60";

const exitIcon = assetUrl("images/ExitIconWhite.svg");
const FastForwardIconSolid = assetUrl("images/FastForwardIconSolidWhite.svg");
const pauseIcon = assetUrl("images/PauseIconWhite.svg");
const playIcon = assetUrl("images/PlayIconWhite.svg");
const settingsIcon = assetUrl("images/SettingIconWhite.svg");
const fullscreenIcon = assetUrl("images/FullscreenIconWhite.svg");
const exitFullscreenIcon = assetUrl("images/ExitFullscreenIconWhite.svg");

@customElement("game-right-sidebar")
export class GameRightSidebar extends LitElement implements Layer {
  public game: GameView;
  public eventBus: EventBus;

  @state()
  private _isSinglePlayer: boolean = false;

  @state()
  private _isReplayVisible: boolean = false;

  @state()
  private _isVisible: boolean = true;

  @state()
  private isPaused: boolean = false;

  @state()
  private isFullscreen: boolean = false;

  @state()
  private timer: number = 0;

  // Mirrors ReplayPanel's speed so the collapsed cluster can show the current
  // multiplier without the panel being open.
  @state()
  private _replaySpeedMultiplier: number = defaultReplaySpeedMultiplier;

  private hasWinner = false;
  private isLobbyCreator = false;
  private spawnBarVisible = false;
  private immunityBarVisible = false;

  createRenderRoot() {
    return this;
  }

  init() {
    this._isSinglePlayer =
      this.game?.config()?.gameConfig()?.gameType === GameType.Singleplayer ||
      this.game.config().isReplay();
    this._isVisible = true;
    this.game.inSpawnPhase();

    this.eventBus.on(SpawnBarVisibleEvent, (e) => {
      this.spawnBarVisible = e.visible;
      this.updateParentOffset();
    });
    this.eventBus.on(ImmunityBarVisibleEvent, (e) => {
      this.immunityBarVisible = e.visible;
      this.updateParentOffset();
    });

    this.eventBus.on(SendWinnerEvent, () => {
      this.hasWinner = true;
      this.requestUpdate();
    });

    this.eventBus.on(ReplaySpeedChangeEvent, (e: ReplaySpeedChangeEvent) => {
      this._replaySpeedMultiplier = e.replaySpeedMultiplier;
    });

    this.eventBus.on(TogglePauseIntentEvent, () => {
      const isReplayOrSingleplayer =
        this._isSinglePlayer || this.game?.config()?.isReplay();
      if (isReplayOrSingleplayer || this.isLobbyCreator) {
        this.onPauseButtonClick();
      }
    });

    this.requestUpdate();
  }

  private onFullscreenChange = () => {
    this.isFullscreen = !!document.fullscreenElement;
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    this.onFullscreenChange();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
  }

  getTickIntervalMs() {
    return 250;
  }

  tick() {
    // Timer logic
    // Check if the player is the lobby creator
    if (!this.isLobbyCreator && this.game.myPlayer()?.isLobbyCreator()) {
      this.isLobbyCreator = true;
      this.requestUpdate();
    }

    const maxTimerValue = this.game.config().gameConfig().maxTimerValue;
    const spawnPhaseTurns = this.game.config().numSpawnPhaseTurns();
    const ticks = this.game.ticks();
    const gameTicks = Math.max(0, ticks - spawnPhaseTurns);
    const elapsedSeconds = Math.floor(gameTicks / 10); // 10 ticks per second

    if (this.game.inSpawnPhase()) {
      this.timer =
        maxTimerValue !== null && maxTimerValue !== undefined
          ? maxTimerValue * 60
          : 0;
      return;
    }

    if (this.hasWinner) {
      return;
    }

    if (maxTimerValue !== null && maxTimerValue !== undefined) {
      this.timer = Math.max(0, maxTimerValue * 60 - elapsedSeconds);
    } else {
      this.timer = elapsedSeconds;
    }
  }

  private updateParentOffset(): void {
    const offset =
      (this.spawnBarVisible ? 7 : 0) + (this.immunityBarVisible ? 7 : 0);
    const parent = this.parentElement as HTMLElement;
    if (parent) {
      parent.style.marginTop = `${offset}px`;
    }
  }

  private secondsToHms = (d: number): string => {
    const pad = (n: number) => (n < 10 ? `0${n}` : n);

    const h = Math.floor(d / 3600);
    const m = Math.floor((d % 3600) / 60);
    const s = Math.floor((d % 3600) % 60);

    if (h !== 0) {
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    } else {
      return `${pad(m)}:${pad(s)}`;
    }
  };

  private toggleReplayPanel(): void {
    this._isReplayVisible = !this._isReplayVisible;
    this.eventBus.emit(
      new ShowReplayPanelEvent(this._isReplayVisible, this._isSinglePlayer),
    );
  }

  private onPauseButtonClick() {
    this.isPaused = !this.isPaused;
    if (this.isPaused) {
      crazyGamesSDK.gameplayStop();
    } else {
      crazyGamesSDK.gameplayStart();
    }
    this.eventBus.emit(new PauseGameIntentEvent(this.isPaused));
  }

  private async onExitButtonClick() {
    const isAlive = this.game.myPlayer()?.isAlive();
    // A betting-premiere viewer stakes real chips on this match but is
    // never `isAlive` (they're not a player) — without this, "Leave
    // match" skipped the confirmation entirely for the one context where
    // leaving actually costs something.
    const hasStakeAtRisk = isBettingPremiereRoute();
    if (isAlive || hasStakeAtRisk) {
      const isConfirmed = confirm(
        hasStakeAtRisk
          ? translateText("game_controls.exit_confirmation_betting")
          : translateText("help_modal.exit_confirmation"),
      );
      if (!isConfirmed) return;
    }
    await crazyGamesSDK.requestMidgameAd();
    await crazyGamesSDK.gameplayStop();
    // redirect to the home page
    window.location.href = "/";
  }

  private onSettingsButtonClick() {
    this.eventBus.emit(
      new ShowSettingsModalEvent(true, this._isSinglePlayer, this.isPaused),
    );
  }

  private onFullscreenButtonClick() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.warn("Failed to enter fullscreen:", err);
      });
    } else {
      document.exitFullscreen().catch((err) => {
        console.warn("Failed to exit fullscreen:", err);
      });
    }
  }

  render() {
    if (this.game === undefined) return html``;

    const timerColor =
      this.game.config().gameConfig().maxTimerValue !== undefined &&
      this.game.config().gameConfig().maxTimerValue !== null &&
      this.timer < 60
        ? "text-red-400"
        : "";

    return html`
      <aside
        class=${`w-fit flex flex-row items-center gap-3 py-2 px-3 bg-glass backdrop-blur-sm shadow-xs min-[1200px]:rounded-lg rounded-bl-lg transition-transform duration-300 ease-out transform text-white ${
          this._isVisible ? "translate-x-0" : "translate-x-full"
        }`}
        role="region"
        aria-label=${translateText("game_controls.toolbar_label")}
        @contextmenu=${(e: Event) => e.preventDefault()}
      >
        <!-- In-game time -->
        <div
          class=${timerColor}
          title=${translateText("game_controls.elapsed")}
          aria-label=${translateText("game_controls.elapsed")}
        >
          ${this.secondsToHms(this.timer)}
        </div>

        <!-- Playback controls (replay / singleplayer only) -->
        ${this.maybeRenderReplayButtons()}

        <!-- Session controls, separated from playback so "leave" never sits
             flush against "pause". -->
        <span class="w-px self-stretch bg-white/15" aria-hidden="true"></span>

        <button
          type="button"
          class=${CONTROL_BUTTON_CLASS}
          title=${translateText("game_controls.settings")}
          aria-label=${translateText("game_controls.settings")}
          @click=${this.onSettingsButtonClick}
        >
          <img
            src=${settingsIcon}
            alt=""
            aria-hidden="true"
            width="20"
            height="20"
          />
        </button>

        ${document.fullscreenEnabled
          ? html`<button
              type="button"
              class=${CONTROL_BUTTON_CLASS}
              title=${this.isFullscreen
                ? translateText("fullscreen.exit")
                : translateText("fullscreen.enter")}
              aria-label=${this.isFullscreen
                ? translateText("fullscreen.exit")
                : translateText("fullscreen.enter")}
              @click=${this.onFullscreenButtonClick}
            >
              <img
                src=${this.isFullscreen ? exitFullscreenIcon : fullscreenIcon}
                alt=""
                aria-hidden="true"
                width="20"
                height="20"
              />
            </button>`
          : ""}

        <button
          type="button"
          class=${`${CONTROL_BUTTON_CLASS} hover:bg-danger/25`}
          title=${translateText("game_controls.exit")}
          aria-label=${translateText("game_controls.exit")}
          @click=${this.onExitButtonClick}
        >
          <img
            src=${exitIcon}
            alt=""
            aria-hidden="true"
            width="20"
            height="20"
          />
        </button>
      </aside>
    `;
  }

  maybeRenderReplayButtons() {
    const isReplayOrSingleplayer =
      this._isSinglePlayer || this.game?.config()?.isReplay();
    const showPauseButton = isReplayOrSingleplayer || this.isLobbyCreator;
    // The fast-forward control opens the speed panel; without the current
    // multiplier on its face the only way to know the playback speed was to
    // open that panel. Surface it inline instead (hidden at 1x to stay quiet).
    const speedLabel =
      this._replaySpeedMultiplier === 1
        ? translateText("game_controls.playback_speed")
        : translateText("game_controls.playback_speed_current", {
            speed: playbackSpeedLabel(this._replaySpeedMultiplier),
          });

    return html`
      ${isReplayOrSingleplayer
        ? html`
            <button
              type="button"
              class=${`${CONTROL_BUTTON_CLASS} gap-1 ${
                this._isReplayVisible ? "bg-white/10" : ""
              }`}
              title=${speedLabel}
              aria-label=${speedLabel}
              aria-expanded=${this._isReplayVisible ? "true" : "false"}
              @click=${this.toggleReplayPanel}
            >
              <img
                src=${FastForwardIconSolid}
                alt=""
                aria-hidden="true"
                width="20"
                height="20"
              />
              ${this._replaySpeedMultiplier !== 1
                ? html`<span
                    class="text-[11px] font-bold leading-none tabular-nums"
                    aria-hidden="true"
                    >${playbackSpeedLabel(this._replaySpeedMultiplier)}</span
                  >`
                : ""}
            </button>
          `
        : ""}
      ${showPauseButton
        ? html`
            <button
              type="button"
              class=${CONTROL_BUTTON_CLASS}
              title=${this.isPaused
                ? translateText("game_controls.resume")
                : translateText("game_controls.pause")}
              aria-label=${this.isPaused
                ? translateText("game_controls.resume")
                : translateText("game_controls.pause")}
              @click=${this.onPauseButtonClick}
            >
              <img
                src=${this.isPaused ? playIcon : pauseIcon}
                alt=""
                aria-hidden="true"
                width="20"
                height="20"
              />
            </button>
          `
        : ""}
    `;
  }
}
