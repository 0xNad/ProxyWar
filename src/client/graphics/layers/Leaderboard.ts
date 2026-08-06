import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { renderTroops, translateText } from "../../../client/Utils";
import { EventBus } from "../../../core/EventBus";
import { GameView, PlayerView } from "../../../core/game/GameView";
import { aiLeagueSpectatorDisplayName } from "../../AiLeagueReplayMode";
import { formatPercentage, renderNumber } from "../../Utils";
import { GoToPlayerEvent } from "../TransformHandler";
import { Layer } from "./Layer";

// Sort-direction caret. Replaces the ⬆️/⬇️ emoji so the indicator matches the
// UI font, inherits the header text color, and renders identically across
// platforms (emoji glyphs vary and read as clip-art in a data table).
const sortCaret = (order: "asc" | "desc") =>
  html`<svg
    viewBox="0 0 10 10"
    width="9"
    height="9"
    fill="currentColor"
    aria-hidden="true"
    class="inline-block ml-0.5 align-middle opacity-80"
  >
    <path d=${order === "asc" ? "M5 3 1.5 7h7z" : "M5 7 1.5 3h7z"} />
  </svg>`;

interface Entry {
  name: string;
  position: number;
  score: string;
  gold: string;
  maxTroops: string;
  isMyPlayer: boolean;
  isOnSameTeam: boolean;
  player: PlayerView;
  /** Territory trend since the previous tick — compact view only; "flat" until a second tick has run. */
  territoryDelta: "up" | "down" | "flat";
  /** Live market price for this seat (`priceLookup(player.clientID())`); `null` when no lookup is wired — compact view only. */
  price: number | null;
}

@customElement("leader-board")
export class Leaderboard extends LitElement implements Layer {
  public game: GameView | null = null;
  public eventBus: EventBus | null = null;

  players: Entry[] = [];

  @property({ type: Boolean }) visible = false;
  private showTopFive = true;

  @state()
  private _sortKey: "tiles" | "gold" | "maxtroops" = "tiles";

  @state()
  private _sortOrder: "asc" | "desc" = "desc";

  /**
   * Denser, betting-focused row layout — rank/name/territory/trend/price,
   * no gold or max-troops columns, no sortable headers. Opt-in: every
   * existing consumer (the in-game sidebar's embedded instance, the
   * AI-league promo overlay's standalone instance) leaves this `false`
   * and renders exactly the original five-column table.
   */
  @property({ type: Boolean }) compact = false;

  /**
   * Live per-seat market price, keyed by the player's `clientID()` — the
   * same id the betting market uses as `seatId` (see
   * `PremiereWageringSourceBundle.ts`). Unset for every consumer except
   * the betting page's standalone standings panel; the price column only
   * renders when this is set.
   */
  @property({ attribute: false }) priceLookup:
    | ((clientID: string) => number | null)
    | null = null;

  @state() private standingsAnnouncement = "";

  /** Previous tick's tiles-owned per player id — compact view's trend arrow only. */
  private previousTilesOwned = new Map<string, number>();

  createRenderRoot() {
    return this; // use light DOM for Tailwind support
  }

  willUpdate(changed: Map<string, unknown>) {
    if (changed.has("visible") && this.visible) {
      this.updateLeaderboard();
    }
  }

  getTickIntervalMs() {
    return 1000;
  }

  tick() {
    if (this.game === null) throw new Error("Not initialized");
    if (!this.visible) return;
    this.updateLeaderboard();
  }

  private setSort(key: "tiles" | "gold" | "maxtroops") {
    if (this._sortKey === key) {
      this._sortOrder = this._sortOrder === "asc" ? "desc" : "asc";
    } else {
      this._sortKey = key;
      this._sortOrder = "desc";
    }
    this.updateLeaderboard();
  }

  private updateLeaderboard() {
    if (this.game === null) throw new Error("Not initialized");
    const myPlayer = this.game.myPlayer();

    let sorted = this.game.playerViews();

    const compare = (a: number, b: number) =>
      this._sortOrder === "asc" ? a - b : b - a;

    const maxTroops = (p: PlayerView) => this.game!.config().maxTroops(p);

    switch (this._sortKey) {
      case "gold":
        sorted = sorted.sort((a, b) =>
          compare(Number(a.gold()), Number(b.gold())),
        );
        break;
      case "maxtroops":
        sorted = sorted.sort((a, b) => compare(maxTroops(a), maxTroops(b)));
        break;
      default:
        sorted = sorted.sort((a, b) =>
          compare(a.numTilesOwned(), b.numTilesOwned()),
        );
    }

    const numTilesWithoutFallout =
      this.game.numLandTiles() - this.game.numTilesWithFallout();

    const alivePlayers = sorted.filter((player) => player.isAlive());
    const playersToShow = this.showTopFive
      ? alivePlayers.slice(0, 5)
      : alivePlayers;

    // Territory-direction and price correlation are compact-view-only
    // reads, but computing them here (not in render) keeps `Entry` a
    // plain snapshot the template never has to reach past.
    const territoryTrend = (
      playerID: string,
      tilesOwned: number,
    ): "up" | "down" | "flat" => {
      const previous = this.previousTilesOwned.get(playerID);
      if (previous === undefined || tilesOwned === previous) return "flat";
      return tilesOwned > previous ? "up" : "down";
    };
    const seatPrice = (player: PlayerView): number | null => {
      if (this.priceLookup === null) return null;
      const clientID = player.clientID();
      return clientID === null ? null : this.priceLookup(clientID);
    };

    this.players = playersToShow.map((player, index) => {
      const maxTroops = this.game!.config().maxTroops(player);
      const tilesOwned = player.numTilesOwned();
      return {
        name: aiLeagueSpectatorDisplayName(player.displayName()),
        position: index + 1,
        score: formatPercentage(tilesOwned / numTilesWithoutFallout),
        gold: renderNumber(player.gold()),
        maxTroops: renderTroops(maxTroops),
        isMyPlayer: player === myPlayer,
        isOnSameTeam:
          myPlayer !== null &&
          (player === myPlayer || player.isOnSameTeam(myPlayer)),
        player: player,
        territoryDelta: territoryTrend(player.id(), tilesOwned),
        price: seatPrice(player),
      };
    });

    if (
      myPlayer !== null &&
      this.players.find((p) => p.isMyPlayer) === undefined
    ) {
      let place = 0;
      for (const p of sorted) {
        place++;
        if (p === myPlayer) {
          break;
        }
      }

      if (myPlayer.isAlive()) {
        const myPlayerMaxTroops = this.game!.config().maxTroops(myPlayer);
        const myTilesOwned = myPlayer.numTilesOwned();
        this.players.pop();
        this.players.push({
          name: aiLeagueSpectatorDisplayName(myPlayer.displayName()),
          position: place,
          score: formatPercentage(myTilesOwned / this.game.numLandTiles()),
          gold: renderNumber(myPlayer.gold()),
          maxTroops: renderTroops(myPlayerMaxTroops),
          isMyPlayer: true,
          isOnSameTeam: true,
          player: myPlayer,
          territoryDelta: territoryTrend(myPlayer.id(), myTilesOwned),
          price: seatPrice(myPlayer),
        });
      }
    }

    this.previousTilesOwned = new Map(
      this.players.map((entry) => [
        entry.player.id(),
        entry.player.numTilesOwned(),
      ]),
    );

    this.requestUpdate();
  }

  private handleRowClickPlayer(player: PlayerView) {
    if (this.eventBus === null) return;
    this.eventBus.emit(new GoToPlayerEvent(player));
  }

  renderLayer(context: CanvasRenderingContext2D) {}

  shouldTransform(): boolean {
    return false;
  }

  render() {
    if (!this.visible) {
      return html``;
    }
    return this.compact ? this.renderCompact() : this.renderStandard();
  }

  /** On-demand snapshot for keyboard/screen-reader users — never fires on the 1s tick itself (see `PriceAnnouncer.ts` for the identical rationale). */
  private announceStandings(): void {
    this.standingsAnnouncement = "";
    requestAnimationFrame(() => {
      this.standingsAnnouncement =
        this.players.length === 0
          ? "No standings yet."
          : `Standings: ${this.players
              .map(
                (p) =>
                  `${p.position}. ${p.name}, ${p.score} territory${
                    p.price === null ? "" : `, price ${p.price.toFixed(0)}`
                  }`,
              )
              .join("; ")}.`;
    });
  }

  private renderCompact() {
    const hasPrice = this.priceLookup !== null;
    const columns = hasPrice
      ? "minmax(18px, 22px) minmax(64px, 1fr) minmax(48px, 60px) minmax(16px, 20px) minmax(38px, 50px)"
      : "minmax(18px, 22px) minmax(64px, 1fr) minmax(48px, 60px) minmax(16px, 20px)";
    return html`
      <div
        class="max-h-[35vh] overflow-y-auto text-white text-[11px] md:text-xs"
        @contextmenu=${(e: Event) => e.preventDefault()}
      >
        <div
          class="grid bg-gray-800/85 w-full rounded-lg overflow-hidden"
          style="grid-template-columns: ${columns};"
        >
          <div class="contents font-bold bg-gray-700/60">
            <div class="py-1 text-center border-b border-slate-500">#</div>
            <div
              class="py-1 pl-1.5 text-left border-b border-slate-500 truncate"
            >
              Player
            </div>
            <div class="py-1 text-center border-b border-slate-500 truncate">
              Territory
            </div>
            <div
              class="py-1 text-center border-b border-slate-500"
              aria-hidden="true"
            >
              Δ
            </div>
            ${hasPrice
              ? html`<div
                  class="py-1 text-center border-b border-slate-500 truncate"
                >
                  Price
                </div>`
              : nothing}
          </div>

          ${repeat(
            this.players,
            (p) => p.player.id(),
            (player, index) => html`
              <div
                class="contents hover:bg-slate-600/60 ${player.isOnSameTeam
                  ? "font-bold"
                  : ""} cursor-pointer"
                @click=${() => this.handleRowClickPlayer(player.player)}
              >
                <div
                  class="py-1 text-center ${index < this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""}"
                >
                  ${player.position}
                </div>
                <div
                  class="py-1 pl-1.5 text-left ${index < this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""} truncate"
                >
                  ${player.name}
                </div>
                <div
                  class="py-1 text-center tabular-nums ${index <
                  this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""}"
                >
                  ${player.score}
                </div>
                <div
                  class="py-1 text-center ${index < this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""}"
                  aria-hidden="true"
                  title=${player.territoryDelta === "up"
                    ? "Territory rising"
                    : player.territoryDelta === "down"
                      ? "Territory falling"
                      : "Territory unchanged"}
                >
                  ${player.territoryDelta === "up"
                    ? "▲"
                    : player.territoryDelta === "down"
                      ? "▼"
                      : "–"}
                </div>
                ${hasPrice
                  ? html`<div
                      class="py-1 text-center font-mono tabular-nums text-info ${index <
                      this.players.length - 1
                        ? "border-b border-slate-500"
                        : ""}"
                    >
                      ${player.price === null
                        ? "—"
                        : player.price.toFixed(0)}
                    </div>`
                  : nothing}
              </div>
            `,
          )}
        </div>

        <div class="mt-1 flex items-center justify-between gap-2">
          <button
            type="button"
            class="p-0.5 px-1.5 text-[11px] border rounded-md border-slate-500 transition-colors text-white hover:bg-white/10 bg-gray-700/50"
            @click=${() => {
              this.showTopFive = !this.showTopFive;
              this.updateLeaderboard();
            }}
          >
            ${this.showTopFive ? "+" : "-"}
          </button>
          <button
            type="button"
            @click=${() => this.announceStandings()}
            class="rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-300 underline decoration-dotted underline-offset-2 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-slate-300"
          >
            Read standings
          </button>
        </div>
        <div class="sr-only" role="status" aria-live="polite">
          ${this.standingsAnnouncement}
        </div>
      </div>
    `;
  }

  private renderStandard() {
    return html`
      <div
        class="max-h-[35vh] overflow-y-auto text-white text-xs md:text-xs lg:text-sm md:max-h-[50vh] mt-2 ${this
          .visible
          ? ""
          : "hidden"}"
        @contextmenu=${(e: Event) => e.preventDefault()}
      >
        <div
          class="grid bg-gray-800/85 w-full text-xs md:text-xs lg:text-sm rounded-lg overflow-hidden"
          style="grid-template-columns: minmax(24px, 30px) minmax(60px, 100px) minmax(45px, 70px) minmax(40px, 55px) minmax(55px, 105px);"
        >
          <div class="contents font-bold bg-gray-700/60">
            <div class="py-1 md:py-2 text-center border-b border-slate-500">
              #
            </div>
            <div
              class="py-1 md:py-2 text-center border-b border-slate-500 truncate"
            >
              ${translateText("leaderboard.player")}
            </div>
            <div
              class="py-1 md:py-2 text-center border-b border-slate-500 cursor-pointer whitespace-nowrap truncate"
              @click=${() => this.setSort("tiles")}
            >
              ${translateText("leaderboard.owned")}
              ${this._sortKey === "tiles" ? sortCaret(this._sortOrder) : ""}
            </div>
            <div
              class="py-1 md:py-2 text-center border-b border-slate-500 cursor-pointer whitespace-nowrap truncate"
              @click=${() => this.setSort("gold")}
            >
              ${translateText("leaderboard.gold")}
              ${this._sortKey === "gold" ? sortCaret(this._sortOrder) : ""}
            </div>
            <div
              class="py-1 md:py-2 text-center border-b border-slate-500 cursor-pointer whitespace-nowrap truncate"
              @click=${() => this.setSort("maxtroops")}
            >
              ${translateText("leaderboard.maxtroops")}
              ${this._sortKey === "maxtroops" ? sortCaret(this._sortOrder) : ""}
            </div>
          </div>

          ${repeat(
            this.players,
            (p) => p.player.id(),
            (player, index) => html`
              <div
                class="contents hover:bg-slate-600/60 ${player.isOnSameTeam
                  ? "font-bold"
                  : ""} cursor-pointer"
                @click=${() => this.handleRowClickPlayer(player.player)}
              >
                <div
                  class="py-1 md:py-2 text-center ${index <
                  this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""}"
                >
                  ${player.position}
                </div>
                <div
                  class="py-1 md:py-2 text-center ${index <
                  this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""} truncate"
                >
                  ${player.name}
                </div>
                <div
                  class="py-1 md:py-2 text-center ${index <
                  this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""}"
                >
                  ${player.score}
                </div>
                <div
                  class="py-1 md:py-2 text-center ${index <
                  this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""}"
                >
                  ${player.gold}
                </div>
                <div
                  class="py-1 md:py-2 text-center ${index <
                  this.players.length - 1
                    ? "border-b border-slate-500"
                    : ""}"
                >
                  ${player.maxTroops}
                </div>
              </div>
            `,
          )}
        </div>
      </div>

      <button
        class="mt-2 p-0.5 px-1.5 md:px-2 text-xs md:text-xs lg:text-sm 
        border rounded-md border-slate-500 transition-colors
        text-white mx-auto block hover:bg-white/10 bg-gray-700/50"
        @click=${() => {
          this.showTopFive = !this.showTopFive;
          this.updateLeaderboard();
        }}
      >
        ${this.showTopFive ? "+" : "-"}
      </button>
    `;
  }
}
