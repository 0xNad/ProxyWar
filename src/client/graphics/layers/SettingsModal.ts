import { html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { crazyGamesSDK } from "src/client/CrazyGamesSDK";
import { PauseGameIntentEvent } from "src/client/Transport";
import { assetUrl } from "../../../core/AssetUrls";
import { EventBus } from "../../../core/EventBus";
import { UserSettings } from "../../../core/game/UserSettings";
import { AlternateViewEvent, RefreshGraphicsEvent } from "../../InputHandler";
import { translateText } from "../../Utils";
import {
  activateFocusTrap,
  type FocusTrapHandle,
} from "../../components/FocusTrap";
import { Layer } from "./Layer";
const structureIcon = assetUrl("images/CityIconWhite.svg");
const cursorPriceIcon = assetUrl("images/CursorPriceIconWhite.svg");
const darkModeIcon = assetUrl("images/DarkModeIconWhite.svg");
const emojiIcon = assetUrl("images/EmojiIconWhite.svg");
const exitIcon = assetUrl("images/ExitIconWhite.svg");
const explosionIcon = assetUrl("images/ExplosionIconWhite.svg");
const mouseIcon = assetUrl("images/MouseIconWhite.svg");
const ninjaIcon = assetUrl("images/NinjaIconWhite.svg");
const settingsIcon = assetUrl("images/SettingIconWhite.svg");
const sirenIcon = assetUrl("images/SirenIconWhite.svg");
const swordIcon = assetUrl("images/SwordIconWhite.svg");
const treeIcon = assetUrl("images/TreeIconWhite.svg");

export class ShowSettingsModalEvent {
  constructor(
    public readonly isVisible: boolean = true,
    public readonly shouldPause: boolean = false,
    public readonly isPaused: boolean = false,
  ) {}
}

@customElement("settings-modal")
export class SettingsModal extends LitElement implements Layer {
  public eventBus: EventBus;
  public userSettings: UserSettings;

  @state()
  private isVisible: boolean = false;

  @state()
  private alternateView: boolean = false;

  @query(".modal-overlay")
  private modalOverlay!: HTMLElement;

  private focusTrapHandle: FocusTrapHandle | null = null;

  @property({ type: Boolean })
  shouldPause = false;

  @property({ type: Boolean })
  wasPausedWhenOpened = false;

  init() {
    this.eventBus.on(ShowSettingsModalEvent, (event) => {
      this.isVisible = event.isVisible;
      this.shouldPause = event.shouldPause;
      this.wasPausedWhenOpened = event.isPaused;
      this.pauseGame(true);
    });
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("click", this.handleOutsideClick, true);
    window.addEventListener("keydown", this.handleKeyDown);
  }

  disconnectedCallback() {
    window.removeEventListener("click", this.handleOutsideClick, true);
    window.removeEventListener("keydown", this.handleKeyDown);
    this.focusTrapHandle?.deactivate();
    this.focusTrapHandle = null;
    super.disconnectedCallback();
  }

  /**
   * Traps Tab/Shift+Tab within the modal and restores focus to whatever
   * invoked it on close (P1 t1-02, pass-8 QA: tabbed through all 12
   * toggle rows, then focus landed on "Sign in" in the page header while
   * the modal stayed visually open). Covers BOTH ways `isVisible` can
   * flip true — `openModal()` and the `ShowSettingsModalEvent` listener
   * in `init()` — from one place rather than duplicating the hookup in
   * each.
   */
  protected updated(changedProperties: Map<string, unknown>): void {
    if (!changedProperties.has("isVisible")) return;
    if (this.isVisible) {
      queueMicrotask(() => {
        if (!this.isVisible) return;
        this.focusTrapHandle = activateFocusTrap(this);
      });
    } else {
      this.focusTrapHandle?.deactivate();
      this.focusTrapHandle = null;
    }
  }

  private handleOutsideClick = (event: MouseEvent) => {
    if (
      this.isVisible &&
      this.modalOverlay &&
      event.target === this.modalOverlay
    ) {
      this.closeModal();
    }
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (this.isVisible && event.key === "Escape") {
      this.closeModal();
    }
  };

  public openModal() {
    this.isVisible = true;
    this.requestUpdate();
  }

  public closeModal() {
    this.isVisible = false;
    this.requestUpdate();
    this.pauseGame(false);
  }

  private pauseGame(pause: boolean) {
    if (this.shouldPause && !this.wasPausedWhenOpened) {
      if (pause) {
        crazyGamesSDK.gameplayStop();
      } else {
        crazyGamesSDK.gameplayStart();
      }
      this.eventBus.emit(new PauseGameIntentEvent(pause));
    }
  }

  private onTerrainButtonClick() {
    this.alternateView = !this.alternateView;
    this.eventBus.emit(new AlternateViewEvent(this.alternateView));
    this.requestUpdate();
  }

  private onToggleEmojisButtonClick() {
    this.userSettings.toggleEmojis();
    this.requestUpdate();
  }

  private onToggleStructureSpritesButtonClick() {
    this.userSettings.toggleStructureSprites();
    this.requestUpdate();
  }

  private onToggleSpecialEffectsButtonClick() {
    this.userSettings.toggleFxLayer();
    this.requestUpdate();
  }

  private onToggleAlertFrameButtonClick() {
    this.userSettings.toggleAlertFrame();
    this.requestUpdate();
  }

  private onToggleDarkModeButtonClick() {
    this.userSettings.toggleDarkMode();
    this.eventBus.emit(new RefreshGraphicsEvent());
    this.requestUpdate();
  }

  private onToggleRandomNameModeButtonClick() {
    this.userSettings.toggleRandomName();
    this.requestUpdate();
  }

  private onToggleLeftClickOpensMenu() {
    this.userSettings.toggleLeftClickOpenMenu();
    this.requestUpdate();
  }

  private onToggleCursorCostLabelButtonClick() {
    this.userSettings.toggleCursorCostLabel();
    this.requestUpdate();
  }

  private onToggleAttackingTroopsOverlayButtonClick() {
    this.userSettings.toggleAttackingTroopsOverlay();
    this.requestUpdate();
  }

  private onTogglePerformanceOverlayButtonClick() {
    this.userSettings.togglePerformanceOverlay();
    this.requestUpdate();
  }

  private onExitButtonClick() {
    // redirect to the home page
    window.location.href = "/";
  }

  render() {
    if (!this.isVisible) {
      return null;
    }

    // P1 ghost-modal fix (pass-10 t1-03): this used to be `z-2000`, which
    // sat BELOW every high-z feature overlay this app has grown since
    // (`AiLeagueReplayOverlay.ts`'s broadcast panels top out
    // at z-[50010] for the Analyst-mode centered panel, while account/sign-in
    // surfaces reach z-[52000]-z-[54000]). With Analyst mode on,
    // that promoted panel renders fixed and CENTERED — the exact same
    // screen region this modal opens into — so this modal's own
    // computed styles looked correct (z-index 2000, opacity 1, display
    // block) while being fully painted over AND non-blocking
    // (`elementFromPoint` over it returned a `<span>` from the replay
    // overlay's standings rail instead). A modal is meant to be the
    // single topmost layer regardless of whatever feature overlay is
    // active underneath it, so this now sits above every z-index band
    // in the app rather than trying to out-guess each new overlay's own
    // ceiling.
    return html`
      <div
        class="modal-overlay fixed inset-0 bg-black/60 backdrop-blur-xs z-[60000] flex items-center justify-center p-4"
        @contextmenu=${(e: Event) => e.preventDefault()}
      >
        <div
          class="bg-slate-800 border border-slate-600 rounded-lg max-w-md w-full max-h-[80vh] overflow-y-auto"
        >
          <div
            class="flex items-center justify-between p-4 border-b border-slate-600"
          >
            <div class="flex items-center gap-2">
              <img
                src=${settingsIcon}
                alt="settings"
                width="24"
                height="24"
                class="align-middle"
              />
              <h2 class="text-xl font-semibold text-white">
                ${translateText("user_setting.tab_basic")}
              </h2>
            </div>
            <button
              class="text-slate-400 hover:text-white text-2xl font-bold leading-none"
              @click=${this.closeModal}
            >
              ×
            </button>
          </div>

          <div class="p-4 flex flex-col gap-3">
            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              @click="${this.onTerrainButtonClick}"
            >
              <img src=${treeIcon} alt="treeIcon" width="20" height="20" />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText("user_setting.toggle_terrain")}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.toggle_view_desc")}
                </div>
              </div>
              <div class="text-sm text-slate-400">
                ${this.alternateView
                  ? translateText("user_setting.on")
                  : translateText("user_setting.off")}
              </div>
            </button>

            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              @click="${this.onToggleEmojisButtonClick}"
            >
              <img src=${emojiIcon} alt="emojiIcon" width="20" height="20" />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText("user_setting.emojis_label")}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.emojis_desc")}
                </div>
              </div>
              <div class="text-sm text-slate-400">
                ${this.userSettings.emojis()
                  ? translateText("user_setting.on")
                  : translateText("user_setting.off")}
              </div>
            </button>

            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              @click="${this.onToggleDarkModeButtonClick}"
            >
              <img
                src=${darkModeIcon}
                alt="darkModeIcon"
                width="20"
                height="20"
              />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText("user_setting.dark_mode_label")}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.dark_mode_desc")}
                </div>
              </div>
              <div class="text-sm text-slate-400">
                ${this.userSettings.darkMode()
                  ? translateText("user_setting.on")
                  : translateText("user_setting.off")}
              </div>
            </button>

            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              @click="${this.onToggleSpecialEffectsButtonClick}"
            >
              <img
                src=${explosionIcon}
                alt="specialEffects"
                width="20"
                height="20"
              />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText("user_setting.special_effects_label")}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.special_effects_desc")}
                </div>
              </div>
              <div class="text-sm text-slate-400">
                ${this.userSettings.fxLayer()
                  ? translateText("user_setting.on")
                  : translateText("user_setting.off")}
              </div>
            </button>

            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              @click="${this.onToggleAlertFrameButtonClick}"
            >
              <img src=${sirenIcon} alt="alertFrame" width="20" height="20" />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText("user_setting.alert_frame_label")}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.alert_frame_desc")}
                </div>
              </div>
              <div class="text-sm text-slate-400">
                ${this.userSettings.alertFrame()
                  ? translateText("user_setting.on")
                  : translateText("user_setting.off")}
              </div>
            </button>

            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              @click="${this.onToggleStructureSpritesButtonClick}"
            >
              <img
                src=${structureIcon}
                alt="structureSprites"
                width="20"
                height="20"
              />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText("user_setting.structure_sprites_label")}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.structure_sprites_desc")}
                </div>
              </div>
              <div class="text-sm text-slate-400">
                ${this.userSettings.structureSprites()
                  ? translateText("user_setting.on")
                  : translateText("user_setting.off")}
              </div>
            </button>

            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              @click="${this.onToggleAttackingTroopsOverlayButtonClick}"
            >
              <img src=${swordIcon} alt="swordIcon" width="20" height="20" />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText(
                    "user_setting.attacking_troops_overlay_label",
                  )}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.attacking_troops_overlay_desc")}
                </div>
              </div>
              <div class="text-sm text-slate-400">
                ${this.userSettings.attackingTroopsOverlay()
                  ? translateText("user_setting.on")
                  : translateText("user_setting.off")}
              </div>
            </button>

            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              @click="${this.onToggleCursorCostLabelButtonClick}"
            >
              <img
                src=${cursorPriceIcon}
                alt="cursorCostLabel"
                width="20"
                height="20"
              />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText("user_setting.cursor_cost_label_label")}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.cursor_cost_label_desc")}
                </div>
              </div>
              <div class="text-sm text-slate-400">
                ${this.userSettings.cursorCostLabel()
                  ? translateText("user_setting.on")
                  : translateText("user_setting.off")}
              </div>
            </button>

            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              @click="${this.onToggleRandomNameModeButtonClick}"
            >
              <img src=${ninjaIcon} alt="ninjaIcon" width="20" height="20" />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText("user_setting.anonymous_names_label")}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.anonymous_names_desc")}
                </div>
              </div>
              <div class="text-sm text-slate-400">
                ${this.userSettings.anonymousNames()
                  ? translateText("user_setting.on")
                  : translateText("user_setting.off")}
              </div>
            </button>

            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              @click="${this.onToggleLeftClickOpensMenu}"
            >
              <img src=${mouseIcon} alt="mouseIcon" width="20" height="20" />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText("user_setting.left_click_menu")}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.left_click_desc")}
                </div>
              </div>
              <div class="text-sm text-slate-400">
                ${this.userSettings.leftClickOpensMenu()
                  ? translateText("user_setting.on")
                  : translateText("user_setting.off")}
              </div>
            </button>

            <button
              class="flex gap-3 items-center w-full text-left p-3 hover:bg-slate-700 rounded-sm text-white transition-colors"
              @click="${this.onTogglePerformanceOverlayButtonClick}"
            >
              <img
                src=${settingsIcon}
                alt="performanceIcon"
                width="20"
                height="20"
              />
              <div class="flex-1">
                <div class="font-medium">
                  ${translateText("user_setting.performance_overlay_label")}
                </div>
                <div class="text-sm text-slate-400">
                  ${translateText("user_setting.performance_overlay_desc")}
                </div>
              </div>
              <div class="text-sm text-slate-400">
                ${this.userSettings.performanceOverlay()
                  ? translateText("user_setting.on")
                  : translateText("user_setting.off")}
              </div>
            </button>

            <div class="border-t border-slate-600 pt-3 mt-4">
              <button
                class="flex gap-3 items-center w-full text-left p-3 hover:bg-red-600/20 rounded-sm text-red-400 transition-colors"
                @click="${this.onExitButtonClick}"
              >
                <img src=${exitIcon} alt="exitIcon" width="20" height="20" />
                <div class="flex-1">
                  <div class="font-medium">
                    ${translateText("user_setting.exit_game_label")}
                  </div>
                  <div class="text-sm text-slate-400">
                    ${translateText("user_setting.exit_game_info")}
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
