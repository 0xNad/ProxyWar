import { html, LitElement, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { aiLeagueSpectatorDisplayName } from "../../../client/AiLeagueReplayMode";
import { translateText } from "../../../client/Utils";
import { EventBus } from "../../../core/EventBus";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import { GameView } from "../../../core/game/GameView";
import {
  ANONYMOUS_NAMES_KEY,
  USER_SETTINGS_CHANGED_EVENT,
} from "../../../core/game/UserSettings";
import { getUserMe } from "../../Api";
import "../../components/CosmeticButton";
import {
  fetchCosmetics,
  purchaseCosmetic,
  resolveCosmetics,
} from "../../Cosmetics";
import { crazyGamesSDK } from "../../CrazyGamesSDK";
import { Platform } from "../../Platform";
import { SendWinnerEvent } from "../../Transport";
import { FitWholeMapEvent } from "../TransformHandler";
import { Layer } from "./Layer";

@customElement("win-modal")
export class WinModal extends LitElement implements Layer {
  public game: GameView;
  public eventBus: EventBus;

  private hasShownDeathModal = false;

  @state()
  isVisible = false;

  @state()
  private isWin = false;

  @state()
  private patternContent: TemplateResult | null = null;

  private _title: string;

  /**
   * P0 fix (2026-08-03): the "other player won" title used to bake in
   * `winner.displayName()` (a real AI League agent's identity — see
   * `AiLeagueReplayMode.ts`'s own doc for why `PlayerView.displayName()`
   * is NOT the safe-by-default value it is in a normal multiplayer game)
   * once, inside `tick()`, and never revisited it. A viewer who toggled
   * "Anonymous Names" ON only AFTER the match had already ended still saw
   * the real winner's name — this modal is a top-level `<win-modal>`
   * element (index.html), entirely outside `AiLeagueReplayOverlay.ts`'s
   * `renderDetails()` rebuild path that every OTHER surface's retoggle fix
   * relies on, so that fix never reached it. Kept so
   * `onAnonymousNamesChange` can re-derive `_title` without needing the
   * original `PlayerView` again. `null` whenever `_title` was set by any
   * OTHER branch (own win, own death, team win, nation win) — none of
   * those carry a real agent identity to anonymize.
   */
  private otherPlayerWinnerRawName: string | null = null;

  private readonly onAnonymousNamesChange = (): void => {
    if (this.otherPlayerWinnerRawName === null) return;
    this._title = translateText("win_modal.other_won", {
      player: aiLeagueSpectatorDisplayName(this.otherPlayerWinnerRawName),
    });
    this.requestUpdate();
  };

  // Override to prevent shadow DOM creation (Tailwind's global stylesheet
  // only reaches light DOM; without this, every class on this modal --
  // fixed positioning, z-[10010], centering, background -- is inert and
  // the "won" banner renders as an unstyled, invisible sliver at 0,0 in
  // an isolated shadow root while `isVisible`/`_title` are still correct.
  // P0 regression (2026-08-03): lost in the anonymize-winner-name edit
  // above when connectedCallback/disconnectedCallback were added in the
  // same spot -- restore alongside those, never remove again.
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${ANONYMOUS_NAMES_KEY}`,
      this.onAnonymousNamesChange,
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${ANONYMOUS_NAMES_KEY}`,
      this.onAnonymousNamesChange,
    );
  }

  render() {
    return html`
      <div
        class="${this.isVisible
          ? "fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-gray-800/95 p-6 shrink-0 rounded-lg z-[10010] shadow-2xl backdrop-blur-xs text-white w-87.5 max-w-[90%] md:w-175"
          : "hidden"}"
      >
        <h2 class="m-0 mb-4 text-[26px] text-center text-white">
          ${this._title || ""}
        </h2>
        ${this.innerHtml()}
      </div>
    `;
  }

  /**
   * True when the client is showing a rendered league/agent replay
   * (`/ai-league-replay/<runID>`) rather than a played game. Replay viewers
   * get the bare result — no tutorials, store upsells, or play-again flows.
   */
  private isLeagueReplay(): boolean {
    return window.location.pathname.startsWith("/ai-league-replay/");
  }

  innerHtml() {
    if (this.isLeagueReplay()) {
      return html``;
    }
    return this.renderPatternButton();
  }

  renderPatternButton() {
    return html`
      <div class="text-center mb-6 bg-black/30 p-2.5 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("win_modal.support_openfront")}
        </h3>
        <p class="text-white mb-3">
          ${translateText("win_modal.territory_pattern")}
        </p>
        <div class="flex justify-center">${this.patternContent}</div>
      </div>
    `;
  }

  async loadPatternContent() {
    const me = await getUserMe();
    const cosmetics = await fetchCosmetics();

    const purchasable = resolveCosmetics(cosmetics, me, null).filter(
      (r) => r.type === "pattern" && r.relationship === "purchasable",
    );

    if (purchasable.length === 0) {
      this.patternContent = html``;
      return;
    }

    // Shuffle the array and take patterns based on screen size
    const shuffled = [...purchasable].sort(() => Math.random() - 0.5);
    const maxPatterns = Platform.isMobileWidth ? 1 : 3;
    const selected = shuffled.slice(0, Math.min(maxPatterns, shuffled.length));

    this.patternContent = html`
      <div class="flex gap-4 flex-wrap justify-start">
        ${selected.map(
          (r) => html`
            <cosmetic-button
              .resolved=${r}
              .onPurchase=${purchaseCosmetic}
            ></cosmetic-button>
          `,
        )}
      </div>
    `;
  }

  async show() {
    crazyGamesSDK.gameplayStop();
    if (!this.isLeagueReplay()) {
      await this.loadPatternContent();
    }
    this.isVisible = true;
    this.requestUpdate();
  }

  hide() {
    this.isVisible = false;
    this.requestUpdate();
  }

  init() {}

  tick() {
    const myPlayer = this.game.myPlayer();
    if (
      !this.hasShownDeathModal &&
      myPlayer &&
      !myPlayer.isAlive() &&
      !this.game.inSpawnPhase() &&
      myPlayer.hasSpawned()
    ) {
      this.hasShownDeathModal = true;
      this._title = translateText("win_modal.died");
      this.otherPlayerWinnerRawName = null;
      this.show();
    }
    const updates = this.game.updatesSinceLastTick();
    const winUpdates = updates !== null ? updates[GameUpdateType.Win] : [];
    winUpdates.forEach((wu) => {
      if (wu.winner === undefined) {
        // ...
      } else if (wu.winner[0] === "team") {
        this.eventBus.emit(new SendWinnerEvent(wu.winner, wu.allPlayersStats));
        this.otherPlayerWinnerRawName = null;
        if (wu.winner[1] === this.game.myPlayer()?.team()) {
          this._title = translateText("win_modal.your_team");
          this.isWin = true;
          crazyGamesSDK.happytime();
        } else {
          this._title = translateText("win_modal.other_team", {
            team: wu.winner[1],
          });
          this.isWin = false;
        }
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        // Spec 02 non-negotiable #2: camera must resolve to a full-board
        // framing at match end, full stop -- a random mid-zoom crop is the
        // last thing a viewer should see after a whole match. Reuses the
        // existing FitWholeMapEvent "whole board" camera machinery (see
        // TransformHandler.centerAll's forceWholeMap branch) -- this is the
        // sole automatic trigger for it.
        this.eventBus.emit(new FitWholeMapEvent());
        this.show();
      } else if (wu.winner[0] === "nation") {
        this._title = translateText("win_modal.nation_won", {
          nation: wu.winner[1],
        });
        this.isWin = false;
        this.otherPlayerWinnerRawName = null;
        this.eventBus.emit(new FitWholeMapEvent());
        this.show();
      } else {
        const winner = this.game.playerByClientID(wu.winner[1]);
        if (!winner?.isPlayer()) return;
        const winnerClient = winner.clientID();
        if (winnerClient !== null) {
          this.eventBus.emit(
            new SendWinnerEvent(["player", winnerClient], wu.allPlayersStats),
          );
        }
        if (
          winnerClient !== null &&
          winnerClient === this.game.myPlayer()?.clientID()
        ) {
          this._title = translateText("win_modal.you_won");
          this.isWin = true;
          this.otherPlayerWinnerRawName = null;
          crazyGamesSDK.happytime();
        } else {
          this.otherPlayerWinnerRawName = winner.displayName();
          this._title = translateText("win_modal.other_won", {
            player: aiLeagueSpectatorDisplayName(this.otherPlayerWinnerRawName),
          });
          this.isWin = false;
        }
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.eventBus.emit(new FitWholeMapEvent());
        this.show();
      }
    });
  }

  renderLayer(/* context: CanvasRenderingContext2D */) {}

  shouldTransform(): boolean {
    return false;
  }
}
