import { html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { GameEndInfo } from "../core/Schemas";
import { GameMapType, UnitType } from "../core/game/Game";
import { fetchGameById } from "./Api";
import { terrainMapFileLoader } from "./TerrainMapFileLoader";
import { renderDuration, translateText } from "./Utils";
import { BaseModal } from "./components/BaseModal";
import {
  PlayerInfo,
  Ranking,
  RankType,
} from "./components/baseComponents/ranking/GameInfoRanking";
import "./components/baseComponents/ranking/PlayerRow";
import "./components/baseComponents/ranking/RankingControls";
import "./components/baseComponents/ranking/RankingHeader";
import { requestUpdateWhenTranslationsReady } from "./publicapp/AppShellChrome";

@customElement("game-info-modal")
export class GameInfoModal extends BaseModal {
  @state() private mapImage: string | null = null;
  @state() private gameInfo: GameEndInfo | null = null;
  @state() private rankedPlayers: Array<PlayerInfo> = [];
  @property({ type: String }) gameId: string | null = null;
  @property({ type: String }) rankType = RankType.Lifetime;

  @state() private currentClientID: string | null = null;
  /**
   * Replaces the old `isLoadingGame: boolean` (defaulted `true`, only
   * ever cleared by `loadGame()`'s `finally`): a bare `.open()` call with
   * no preceding/concurrent `loadGame(id)` — exactly QA's repro — used to
   * spin forever with no honest fallback. `"idle"` is the new honest
   * default; `loadGame()` walks idle -> loading -> loaded|failed.
   */
  @state() private loadState: "idle" | "loading" | "loaded" | "failed" = "idle";

  private ranking: Ranking | null = null;

  /**
   * Third instance of the raw-i18n-key leak class QA has now reported
   * (`chat.cat.help` pass-5b, nav pass-2, `game_info_modal.title` here,
   * pass-8): `translateText()` reads `<lang-selector>`'s own translation
   * state at call time with no subscription of its own (see
   * `waitForTranslationsReady`'s doc), so this modal's title — evaluated
   * every `render()` — shows the raw key verbatim until SOMETHING
   * re-renders after translations finish loading. The 11 `publicapp/`
   * pages already fixed this by re-requesting an update once translations
   * are ready; this modal lives outside `publicapp/` and never got that
   * fix applied. Same root, same fix, reused verbatim rather than
   * reimplemented.
   */
  connectedCallback() {
    super.connectedCallback();
    this.updateRanking();
    requestUpdateWhenTranslationsReady(this);
  }

  render() {
    return html`
      <o-modal
        id="gameInfoModal"
        title="${translateText("game_info_modal.title")}"
        translationKey="main.game_info"
      >
        <div
          class="h-full flex flex-col items-center px-25 text-center mb-4 scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent"
        >
          <div class="w-75 sm:w-125">${this.renderContent()}</div>
        </div>
      </o-modal>
    `;
  }

  private renderContent() {
    switch (this.loadState) {
      case "loading":
        return this.renderLoadingAnimation();
      case "failed":
        return this.renderFailedState();
      case "loaded":
        return this.renderRanking();
      case "idle":
      default:
        return this.renderIdleState();
    }
  }

  private renderRanking() {
    if (this.rankedPlayers.length === 0) {
      return html`
        <div class="flex flex-col items-center justify-center p-6 text-white">
          <p class="mb-2">❌ ${translateText("game_info_modal.no_winner")}</p>
        </div>
      `;
    }
    return html`
      ${this.renderGameInfo()}
      <ranking-controls
        .rankType=${this.rankType}
        .warshipsDisabled=${this.gameInfo?.config.disabledUnits?.includes(
          UnitType.Warship,
        ) ?? false}
        @sort=${this.sort}
      ></ranking-controls>
      ${this.renderSummaryTable()}
    `;
  }

  private renderLoadingAnimation() {
    return html` <div
      class="flex flex-col items-center justify-center p-6 text-white"
    >
      <p class="mb-2">${translateText("game_info_modal.loading_game_info")}</p>
      <div
        class="w-6 h-6 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"
      ></div>
    </div>`;
  }

  private renderIdleState() {
    return html`
      <div class="flex flex-col items-center justify-center p-6 text-white">
        <p class="mb-2">${translateText("game_info_modal.no_data")}</p>
      </div>
    `;
  }

  private renderFailedState() {
    return html`
      <div class="flex flex-col items-center justify-center p-6 text-white">
        <p class="mb-2">❌ ${translateText("game_info_modal.load_failed")}</p>
      </div>
    `;
  }

  private sort(e: CustomEvent<RankType>) {
    this.rankType = e.detail;
    this.updateRanking();
  }

  private updateRanking() {
    if (this.ranking) {
      this.rankedPlayers = this.ranking.sortedBy(this.rankType);
    }
  }

  private renderGameInfo() {
    const info = this.gameInfo;
    if (!info) {
      return html``;
    }
    return html`
      <div
        class="h-37.5 flex relative justify-between rounded-xl bg-black/20 items-center"
      >
        ${this.mapImage
          ? html`<img
              src="${this.mapImage}"
              class="absolute place-self-start col-span-full row-span-full h-full rounded-xl mask-[linear-gradient(to_left,transparent,#fff)] object-cover object-center"
            />`
          : html`<div
              class="place-self-start col-span-full row-span-full h-full rounded-xl bg-gray-300"
            ></div>`}
        <div class="text-right p-3 w-full">
          <div class="font-normal pl-1 pr-1">
            <span class="bg-white text-blue-800 font-normal pl-1 pr-1"
              >${info.config.gameMode}</span
            >
            <span class="font-bold">${info.config.gameMap}</span>
          </div>
          <div>${renderDuration(info.duration)}</div>
          <div>
            ${info.players.length} ${translateText("game_info_modal.players")}
          </div>
        </div>
      </div>
    `;
  }

  private renderSummaryTable() {
    const bestScore =
      this.rankedPlayers.length > 0 ? this.score(this.rankedPlayers[0]) : 0;
    return html`
      <ul>
        <ranking-header
          .rankType=${this.rankType}
          @sort=${this.sort}
        ></ranking-header>
        ${this.rankedPlayers.map(
          (player: PlayerInfo, index) => html`
            <player-row
              .player=${player}
              .rank=${index + 1}
              .score=${this.ranking?.score(player, this.rankType) ?? 0}
              .rankType=${this.rankType}
              .bestScore=${bestScore}
              .currentPlayer=${this.currentClientID === player.id}
            ></player-row>
          `,
        )}
      </ul>
    `;
  }

  private score(player: PlayerInfo): number {
    if (!this.ranking) return 0;
    return this.ranking.score(player, this.rankType);
  }

  private async loadMapImage(gameMap: string) {
    try {
      const mapType = gameMap as GameMapType;
      const data = terrainMapFileLoader.getMapData(mapType);
      this.mapImage = data.webpPath;
    } catch (error) {
      console.error("Failed to load map image:", error);
    }
  }

  public async loadGame(gameId: string, currentClientID: string | null = null) {
    this.loadState = "loading";
    this.currentClientID = currentClientID;
    try {
      const session = await fetchGameById(gameId);
      if (!session) {
        this.loadState = "failed";
        return;
      }

      this.gameInfo = session.info;
      if (
        session.info.config.disabledUnits?.includes(UnitType.Warship) &&
        this.rankType === RankType.StolenGold
      ) {
        this.rankType = RankType.TotalGold;
      }
      this.ranking = new Ranking(session);
      this.updateRanking();
      await this.loadMapImage(session.info.config.gameMap);
      this.loadState = "loaded";
    } catch (err) {
      console.error("Failed to load game:", err);
      this.loadState = "failed";
    }
  }
}
