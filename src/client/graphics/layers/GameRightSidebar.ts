import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { assetUrl } from "../../../core/AssetUrls";
import { EventBus } from "../../../core/EventBus";
import { GameType } from "../../../core/game/Game";
import { GameView } from "../../../core/game/GameView";
import { crazyGamesSDK } from "../../CrazyGamesSDK";
import {
  CloseViewEvent,
  ReplaySpeedChangeEvent,
  TogglePauseIntentEvent,
} from "../../InputHandler";
import {
  AI_LEAGUE_REPLAY_CATCHUP_EVENT,
  AI_LEAGUE_REPLAY_PROGRESS_EVENT,
  type ReplayTurnProgress,
} from "../../LocalServer";
import { PauseGameIntentEvent, SendWinnerEvent } from "../../Transport";
import { defaultReplaySpeedMultiplier } from "../../utilities/ReplaySpeedMultiplier";
import { translateText } from "../../Utils";
import { ImmunityBarVisibleEvent } from "./ImmunityTimer";
import { Layer } from "./Layer";
import { ShowReplayPanelEvent } from "./ReplayPanel";
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
/**
 * Bare numeral/word for the "Playback speed — now {speed}×" sentence --
 * that i18n string already supplies its own trailing "×", so passing
 * `playbackSpeedLabel`'s own ×-suffixed value here doubles it up (harmless
 * at the rare manual 2×/0.5× picks that were the only way to reach this
 * template before; this incident's always-show-for-replays fix makes the
 * far more common 1×-paced case take this same path,
 * surfacing what was a dormant string bug). `playbackSpeedLabel` itself
 * stays as-is for the standalone fast-forward badge below, which has no
 * surrounding sentence and needs its own "×".
 */
function playbackSpeedNumeral(multiplier: number): string {
  if (multiplier <= 0) return translateText("game_controls.speed_max");
  const speed = 1 / multiplier;
  return Number.isInteger(speed) ? String(speed) : speed.toFixed(1);
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

const FastForwardIconSolid = assetUrl("images/FastForwardIconSolidWhite.svg");
const pauseIcon = assetUrl("images/PauseIconWhite.svg");
const playIcon = assetUrl("images/PlayIconWhite.svg");
const fullscreenIcon = assetUrl("images/FullscreenIconWhite.svg");
const exitFullscreenIcon = assetUrl("images/ExitFullscreenIconWhite.svg");
const hideUiIcon = assetUrl("images/HideUiIconWhite.svg");
const showUiIcon = assetUrl("images/ShowUiIconWhite.svg");

/**
 * Body class that hides every HUD element except this sidebar (which
 * collapses to a lone restore button). The matching CSS is injected by
 * GameRenderer.mountHudVisibilityStyles.
 */
export const HUD_HIDDEN_BODY_CLASS = "proxywar-hud-hidden";

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

  // "Hide interface" mode: everything vanishes except the restore button.
  @state()
  private hudHidden: boolean = false;

  @state()
  private timer: number = 0;

  // Mirrors ReplayPanel's speed so the collapsed cluster can show the current
  // multiplier without the panel being open.
  @state()
  private _replaySpeedMultiplier: number = defaultReplaySpeedMultiplier;

  // Real turn-count catch-up progress from LocalServer.reportReplayCatchUp()
  // -- null whenever the replay isn't behind its own dispatched position.
  @state()
  private _catchUpProgress: ReplayTurnProgress | null = null;

  // Steady playhead position from LocalServer.reportReplayProgress() --
  // archived replays only, present from boot through the final turn.
  @state()
  private _replayProgress: ReplayTurnProgress | null = null;

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
    // This element outlives games (static in index.html; leaving a lobby is
    // an SPA transition, no reload) -- drop the previous game's counters.
    this._replayProgress = null;
    this._catchUpProgress = null;
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

    // Escape restores a hidden interface.
    this.eventBus.on(CloseViewEvent, () => {
      if (this.hudHidden) {
        this.setHudHidden(false);
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
    document.addEventListener(
      AI_LEAGUE_REPLAY_CATCHUP_EVENT,
      this.onReplayCatchUpEvent,
    );
    document.addEventListener(
      AI_LEAGUE_REPLAY_PROGRESS_EVENT,
      this.onReplayProgressEvent,
    );
    this.onFullscreenChange();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    document.removeEventListener(
      AI_LEAGUE_REPLAY_CATCHUP_EVENT,
      this.onReplayCatchUpEvent,
    );
    document.removeEventListener(
      AI_LEAGUE_REPLAY_PROGRESS_EVENT,
      this.onReplayProgressEvent,
    );
    document.body.classList.remove(HUD_HIDDEN_BODY_CLASS);
  }

  private onReplayCatchUpEvent = (
    e: CustomEvent<ReplayTurnProgress | null>,
  ) => {
    this._catchUpProgress = e.detail;
  };

  private onReplayProgressEvent = (e: CustomEvent<ReplayTurnProgress>) => {
    this._replayProgress = e.detail;
  };

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

  private setHudHidden(hidden: boolean) {
    this.hudHidden = hidden;
    document.body.classList.toggle(HUD_HIDDEN_BODY_CLASS, hidden);
  }

  private onToggleHudClick() {
    this.setHudHidden(!this.hudHidden);
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

    if (this.hudHidden) {
      // Everything else is CSS-hidden; only this restore chip stays.
      return html`
        <aside
          class="w-fit flex flex-row items-center py-2 px-3 text-white opacity-50 hover:opacity-100 transition-opacity"
          @contextmenu=${(e: Event) => e.preventDefault()}
        >
          <button
            type="button"
            class=${CONTROL_BUTTON_CLASS}
            title=${translateText("game_controls.show_hud")}
            aria-label=${translateText("game_controls.show_hud")}
            @click=${this.onToggleHudClick}
          >
            <img
              src=${showUiIcon}
              alt=""
              aria-hidden="true"
              width="20"
              height="20"
            />
          </button>
        </aside>
      `;
    }

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

        <!-- Steady "rendered / total" turn counter (archived replays only).
             Kiosk watchdogs (leaguecast) detect end-of-replay by parsing the
             first "N / M" digit pair in body text, so the numbers must stay
             plain digits — no locale separators. -->
        ${this._replayProgress !== null
          ? html`
              <div
                class="text-xs text-white/70 whitespace-nowrap tabular-nums"
                title=${translateText("game_controls.replay_progress_tip")}
                aria-label=${translateText("game_controls.replay_progress_tip")}
              >
                ${this._replayProgress.turnsRendered} /
                ${this._replayProgress.turnsTotal}
              </div>
            `
          : ""}

        <!-- Real turn-count catch-up progress (P2 incident follow-up):
             honest, from LocalServer's own dispatched/rendered counters --
             never a fake spinner, never shown once the playhead itself has
             moved past the gap it describes. -->
        ${this._catchUpProgress !== null
          ? html`
              <div
                class="text-xs text-white/70 whitespace-nowrap"
                aria-live="polite"
                title=${translateText("game_controls.replay_catching_up_tip")}
              >
                ${translateText("game_controls.replay_catching_up", {
                  rendered:
                    this._catchUpProgress.turnsRendered.toLocaleString(),
                  total: this._catchUpProgress.turnsTotal.toLocaleString(),
                })}
              </div>
            `
          : ""}

        <!-- Playback controls (replay / singleplayer only) -->
        ${this.maybeRenderReplayButtons()}

        <!-- Session controls, separated from playback so "leave" never sits
             flush against "pause". -->
        <span class="w-px self-stretch bg-white/15" aria-hidden="true"></span>

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
          class=${CONTROL_BUTTON_CLASS}
          title=${translateText("game_controls.hide_hud")}
          aria-label=${translateText("game_controls.hide_hud")}
          @click=${this.onToggleHudClick}
        >
          <img
            src=${hideUiIcon}
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
    // open that panel. Surface it inline, hidden at 1x for a LIVE game (the
    // expected/only sensible speed there) -- but ALWAYS shown for a replay
    // (archived Full Replay or Premiere), where 1x/slow is frequently a
    // deliberate pacing choice, not the assumed default, and a silent
    // "Playback speed" label at that pace is exactly what read as a frozen
    // replay in the P2 incident.
    const isReplay = this.game?.config()?.isReplay() ?? false;
    const speedLabel =
      this._replaySpeedMultiplier === 1 && !isReplay
        ? translateText("game_controls.playback_speed")
        : translateText("game_controls.playback_speed_current", {
            speed: playbackSpeedNumeral(this._replaySpeedMultiplier),
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
              ${this._replaySpeedMultiplier !== 1 || isReplay
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
