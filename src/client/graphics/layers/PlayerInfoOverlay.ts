import { html, LitElement, PropertyValues, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { assetUrl } from "../../../core/AssetUrls";
import { EventBus } from "../../../core/EventBus";
import {
  PlayerProfile,
  PlayerType,
  Relation,
  Unit,
  UnitType,
} from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { AllianceView } from "../../../core/game/GameUpdates";
import { GameView, PlayerView, UnitView } from "../../../core/game/GameView";
import { isAiLeagueReplayRoute } from "../../AiLeagueReplayMode";
import {
  ContextMenuEvent,
  MouseMoveEvent,
  TouchEvent,
} from "../../InputHandler";
import {
  getTranslatedPlayerTeamLabel,
  renderDuration,
  renderNumber,
  renderTroops,
  translateText,
} from "../../Utils";
import {
  EMOJI_ICON_KIND,
  getFirstPlacePlayer,
  getPlayerIcons,
  IMAGE_ICON_KIND,
} from "../PlayerIcons";
import { TransformHandler } from "../TransformHandler";
import { ImmunityBarVisibleEvent } from "./ImmunityTimer";
import { Layer } from "./Layer";
import "./RelationSmiley";
import { SpawnBarVisibleEvent } from "./SpawnTimer";
const soldierIconAquarius = assetUrl("images/SoldierIconAquarius.svg");
const allianceIcon = assetUrl("images/AllianceIcon.svg");
const warshipIcon = assetUrl("images/BattleshipIconWhite.svg");
const cityIcon = assetUrl("images/CityIconWhite.svg");
const factoryIcon = assetUrl("images/FactoryIconWhite.svg");
const goldCoinIcon = assetUrl("images/GoldCoinIcon.svg");
const missileSiloIcon = assetUrl("images/MissileSiloIconWhite.svg");
const portIcon = assetUrl("images/PortIcon.svg");
const samLauncherIcon = assetUrl("images/SamLauncherIconWhite.svg");
const soldierIcon = assetUrl("images/SoldierIcon.svg");

/* THE BROADCAST GATE — read this before touching any call site below.
 * Everything this overlay shows beyond upstream's bare "Health: N" and
 * "Troops: N" is intel the engine never handed a player, and for one
 * release it shipped UNGATED. The water branch of maybeShow() hit-tests
 * ships with no ownership filter whatsoever, so hovering any hull on the
 * board — an enemy's included — answered with:
 *   - renderWarshipStatus: the ship's posture straight out of the engine's
 *     own state machine (in combat / on patrol / withdrawing to port for
 *     repairs / docked), i.e. whether an enemy warship can still fight;
 *   - renderTransportMission: a THIRD PARTY's boat naming its destination
 *     and its outcome ("Invading <name> — troops attack on landing")
 *     before it ever landed;
 *   - renderTradeShipInfo: an enemy trade ship's partner, its remaining
 *     tiles to port, and whether its cargo had been captured.
 * renderNearbyStructures then appended the two structures nearest the
 * cursor to the PLAYER card with their levels — MissileSilo and
 * SAMLauncher among them, an opponent's nuclear order of battle read off
 * a hover — and the fallout branch was inserted AHEAD of the owner branch
 * in maybeShow, so a live player hovering their own irradiated ground got
 * the fallout card where upstream gave them the owner card.
 * The concrete harm in ranked play: hover an enemy transport, learn it is
 * aimed at someone else, and redeploy your reserve on information the game
 * deliberately withheld. A broadcast viewer is a spectator of a FINISHED
 * recording and may see all of it; a live player may see none of it. With
 * this gate closed every call site below emits exactly what upstream
 * emitted, which is why the helpers stay in the file but stay unreachable.
 *
 * EVALUATED PER CALL, not once at module scope, and that is load-bearing:
 * a replay is routinely entered by history.pushState AFTER the bundle has
 * already booted on "/" (Main.ts handleJoinLobby, the ai-league-replay
 * join branch — "a genuine in-app join arriving from a DIFFERENT path...
 * still gets its first real pushState here"), so a const evaluated at
 * module load would latch false for every homepage-initiated replay and
 * silently strip the broadcast of the whole enriched card. Main.ts states
 * the same requirement for the other live callers: isAiLeagueReplayRoute()
 * "reads window.location.pathname fresh on every call". The cost is a
 * handful of string prefix tests per hover render. */
function enriched(): boolean {
  return isAiLeagueReplayRoute();
}

function euclideanDistWorld(
  coord: { x: number; y: number },
  tileRef: TileRef,
  game: GameView,
): number {
  const x = game.x(tileRef);
  const y = game.y(tileRef);
  const dx = coord.x - x;
  const dy = coord.y - y;
  return Math.sqrt(dx * dx + dy * dy);
}

function distSortUnitWorld(coord: { x: number; y: number }, game: GameView) {
  return (a: Unit | UnitView, b: Unit | UnitView) => {
    const distA = euclideanDistWorld(coord, a.tile(), game);
    const distB = euclideanDistWorld(coord, b.tile(), game);
    return distA - distB;
  };
}

@customElement("player-info-overlay")
export class PlayerInfoOverlay extends LitElement implements Layer {
  @property({ type: Object })
  public game!: GameView;

  @property({ type: Object })
  public eventBus!: EventBus;

  @property({ type: Object })
  public transform!: TransformHandler;

  @state()
  private player: PlayerView | null = null;

  @state()
  private playerProfile: PlayerProfile | null = null;

  @state()
  private unit: UnitView | null = null;

  /* The hovered tile itself, kept alongside `player`/`unit`, because two of
   * the enriched cards are TILE-anchored, not view-anchored:
   *   - the fallout card (fallout tiles have no owner, so `player` is null
   *     there and the tile is the only handle we have), and
   *   - the nearby-structure lines under the player card (we need the hover
   *     point to ask "which structure is the cursor actually on?").
   * Staleness: a TileRef is a plain index into the map grid, and a replay
   * rewind swaps the GameView but never the map, so unlike PlayerView/
   * UnitView this value cannot dangle — everything derived from it
   * (hasFallout, nearby units) is re-read from the CURRENT `this.game` on
   * every render, so a rewind mid-hover just re-evaluates the truth. */
  @state()
  private hoverTile: TileRef | null = null;

  @state()
  private _isInfoVisible: boolean = false;

  @state()
  private spawnBarVisible = false;
  @state()
  private immunityBarVisible = false;

  private _isActive = false;

  private get barOffset(): number {
    return (this.spawnBarVisible ? 7 : 0) + (this.immunityBarVisible ? 7 : 0);
  }

  private lastMouseUpdate = 0;

  /* The GameView `player`/`unit` were resolved from. This element is a
   * singleton the renderer QUERIES, not creates, so an in-place replay
   * rewind reassigns `.game` while retained views keep pointing at the
   * torn-down run. PlayerView holds its GameView privately, so we track the
   * origin ourselves and re-resolve on mismatch (see willUpdate). */
  private resolvedFromGame: GameView | null = null;

  init() {
    /* BROADCAST: CLEAR STATE THE PREVIOUS RUN LEFT BEHIND. This element is a
     * singleton the renderer QUERIES, not creates, and `init()` re-runs on
     * every createRenderer pass — including an in-place replay rewind. Lit
     * @state survives that pass: after a rewind the card was still visible
     * (`_isInfoVisible === true`) holding a PlayerView from the TORN-DOWN
     * run, frozen at seek-time numbers (measured: 3.50M gold held across a
     * rewind to turn 2000 while `.game` had already been reassigned to the
     * new GameView). hide() nulls `player`/`unit` too, which also releases
     * the old run's view graph. Gated on the spectator body class so live
     * play is byte-for-byte untouched. */
    if (document.body.classList.contains("ai-league-native-spectator-ui")) {
      this.hide();
    }
    this.eventBus.on(MouseMoveEvent, (e: MouseMoveEvent) =>
      this.onMouseEvent(e),
    );
    this.eventBus.on(ContextMenuEvent, (e: ContextMenuEvent) =>
      this.maybeShow(e.x, e.y),
    );
    this.eventBus.on(TouchEvent, (e: TouchEvent) => this.maybeShow(e.x, e.y));
    this.eventBus.on(SpawnBarVisibleEvent, (e) => {
      this.spawnBarVisible = e.visible;
    });
    this.eventBus.on(ImmunityBarVisibleEvent, (e) => {
      this.immunityBarVisible = e.visible;
    });
    this._isActive = true;
  }

  private onMouseEvent(event: MouseMoveEvent) {
    const now = Date.now();
    if (now - this.lastMouseUpdate < 100) {
      return;
    }
    this.lastMouseUpdate = now;
    this.maybeShow(event.x, event.y);
  }

  public hide() {
    this.setVisible(false);
    this.unit = null;
    this.player = null;
    this.hoverTile = null;
  }

  public maybeShow(x: number, y: number) {
    this.hide();
    const worldCoord = this.transform.screenToWorldCoordinates(x, y);
    if (!this.game.isValidCoord(worldCoord.x, worldCoord.y)) {
      return;
    }

    const tile = this.game.ref(worldCoord.x, worldCoord.y);
    if (!tile) return;

    const owner = this.game.owner(tile);

    /* FALLOUT FIRST, before the owner check: a nuked tile keeps no owner, so
     * the owner branch below never fires there and — pre-enrichment — the
     * most dramatic thing on the whole board answered a hover with nothing.
     * The card contents (current attack penalty, irradiated share of the
     * map) are computed in renderFalloutInfo() from the LIVE `this.game` at
     * render time, never cached here, so a scrub/rewind mid-hover cannot
     * show a stale multiplier: if the rewound tick predates the detonation,
     * hasFallout() is false and render()'s content guard hides the card.
     * BROADCAST ONLY (see enriched()): reordering upstream's branches is a
     * behaviour change in itself — a live player hovering their own nuked
     * ground would get this card instead of their owner card — so with the
     * gate closed the whole condition short-circuits on its first term and
     * the live path evaluates owner-first, exactly as upstream did. */
    if (enriched() && this.game.isLand(tile) && this.game.hasFallout(tile)) {
      this.hoverTile = tile;
      this.setVisible(true);
    } else if (owner && owner.isPlayer()) {
      this.player = owner as PlayerView;
      /* Keep the hover point too: the player card adds a line for the
       * specific structure under the cursor (renderNearbyStructures). */
      this.hoverTile = tile;
      this.resolvedFromGame = this.game;
      this.player.profile().then((p) => {
        this.playerProfile = p;
      });
      this.setVisible(true);
    } else if (!this.game.isLand(tile)) {
      const units = this.game
        .units(UnitType.Warship, UnitType.TradeShip, UnitType.TransportShip)
        .filter((u) => euclideanDistWorld(worldCoord, u.tile(), this.game) < 50)
        .sort(distSortUnitWorld(worldCoord, this.game));

      if (units.length > 0) {
        this.unit = units[0];
        this.resolvedFromGame = this.game;
        this.setVisible(true);
      }
    }
    /* DELIBERATE: bare unclaimed land still shows NO card. We considered a
     * one-liner ("UNCLAIMED — magnitude N terrain") and rejected it: the
     * broadcast viewer's cursor rests on empty terrain constantly while
     * panning, so a top-center card would flicker in and out with no
     * decision-relevant payload (tile magnitude is not a number the engine
     * ever surfaces to players as such). A hover card that says nothing
     * useful should stay hidden — same judgement the panels follow
     * ("panels never render empty"). */
  }

  /* STALENESS GUARD, second belt to init()'s brace. History, so nobody
   * re-deletes this card to fix a staleness report: on the broadcast an
   * in-place rewind reassigns `.game` on this singleton while Lit @state
   * kept the previous run's PlayerView — the card showed frozen mixed-era
   * numbers for minutes (measured 233K gold on the strip vs the true 157K).
   * The r58 "fix" display:none'd the card wholesale, which amputated hover
   * info the owner wants; the real fix is (1) init() clears retained state
   * on every createRenderer pass, and (2) this hook: before ANY render, if
   * the retained views were resolved from a different GameView than the
   * current one, re-resolve them by stable id against `this.game` — smallID
   * for players, unit id for units — and stand down if they no longer
   * exist. A retained view from a dead game can therefore never reach
   * render(). willUpdate is the Lit-sanctioned place to mutate reactive
   * state without scheduling an extra update cycle. Live play is untouched
   * in behaviour: outside a rewind `resolvedFromGame === this.game` and
   * this is two identity checks. */
  protected willUpdate(changedProperties: PropertyValues): void {
    if (
      this.resolvedFromGame !== this.game &&
      (this.player !== null || this.unit !== null)
    ) {
      if (this.player !== null) {
        let current: PlayerView | null = null;
        try {
          const owner = this.game.playerBySmallID(this.player.smallID());
          current = owner.isPlayer() ? (owner as PlayerView) : null;
        } catch {
          // smallID not registered in the current game (e.g. rewound to
          // before this player entered the recording): stand down.
        }
        this.player = current;
      }
      if (this.unit !== null) {
        this.unit = this.game.unit(this.unit.id()) ?? null;
      }
      if (this.player === null && this.unit === null) {
        this._isInfoVisible = false;
      }
      this.resolvedFromGame = this.game;
    }
    super.willUpdate(changedProperties);
  }

  tick() {
    this.requestUpdate();
  }

  renderLayer(context: CanvasRenderingContext2D) {
    // Implementation for Layer interface
  }

  shouldTransform(): boolean {
    return false;
  }

  setVisible(visible: boolean) {
    this._isInfoVisible = visible;
    this.requestUpdate();
  }

  private getPlayerNameColor(isFriendly: boolean): string {
    if (isFriendly) return "text-green-500";
    return "text-white";
  }

  private getRelationSmiley(
    player: PlayerView,
    myPlayer: PlayerView | null | undefined,
  ): TemplateResult | string {
    if (!myPlayer || myPlayer === player || player.type() !== PlayerType.Nation)
      return "";
    const relation =
      this.playerProfile?.relations[myPlayer.smallID()] ?? Relation.Neutral;
    if (relation === Relation.Neutral) return "";
    return html`<relation-smiley .relation=${relation}></relation-smiley>`;
  }

  private getRelationName(relation: Relation): string {
    switch (relation) {
      case Relation.Hostile:
        return translateText("relation.hostile");
      case Relation.Distrustful:
        return translateText("relation.distrustful");
      case Relation.Neutral:
        return translateText("relation.neutral");
      case Relation.Friendly:
        return translateText("relation.friendly");
      default:
        return translateText("relation.default");
    }
  }

  private displayUnitCount(player: PlayerView, type: UnitType, icon: string) {
    return !this.game.config().isUnitDisabled(type)
      ? html`<div
          class="flex items-center justify-center gap-0.5 lg:gap-1 p-0.5 lg:p-1 border rounded-md border-gray-500 text-[10px] lg:text-xs w-9 lg:w-12 h-6 lg:h-7"
          translate="no"
        >
          <img
            src=${icon}
            class="w-3 h-3 lg:w-4 lg:h-4 object-contain shrink-0"
          />
          <span>${player.totalUnitLevels(type)}</span>
        </div>`
      : "";
  }

  private allianceExpirationText(alliance: AllianceView) {
    const { expiresAt } = alliance;
    const remainingTicks = expiresAt - this.game.ticks();
    let remainingSeconds = 0;
    if (remainingTicks > 0) {
      remainingSeconds = Math.max(0, Math.floor(remainingTicks / 10)); // 10 ticks per second
    }
    return renderDuration(remainingSeconds);
  }

  private renderPlayerNameIcons(player: PlayerView) {
    const firstPlace = getFirstPlacePlayer(this.game);
    const icons = getPlayerIcons({
      game: this.game,
      player,
      // Because we already show the alliance icon next to the alliance expiration timer, we don't need to show it a second time in this render
      includeAllianceIcon: false,
      firstPlace,
      alliancesDisabled: this.game.config().disableAlliances(),
    });

    if (icons.length === 0) {
      return html``;
    }

    return html`<span class="flex items-center gap-1 ml-1 shrink-0">
      ${icons.map((icon) =>
        icon.kind === EMOJI_ICON_KIND && icon.text
          ? html`<span class="text-sm shrink-0" translate="no"
              >${icon.text}</span
            >`
          : icon.kind === IMAGE_ICON_KIND && icon.src
            ? html`<img src=${icon.src} alt="" class="w-4 h-4 shrink-0" />`
            : html``,
      )}
    </span>`;
  }

  private renderPlayerInfo(player: PlayerView) {
    const myPlayer = this.game.myPlayer();
    const isFriendly = myPlayer?.isFriendly(player);
    const isAllied = myPlayer?.isAlliedWith(player);
    let allianceHtml: TemplateResult | null = null;
    const maxTroops = this.game.config().maxTroops(player);
    const attackingTroops = player
      .outgoingAttacks()
      .map((a) => a.troops)
      .reduce((a, b) => a + b, 0);
    const totalTroops = player.troops();

    if (isAllied) {
      const alliance = myPlayer
        ?.alliances()
        .find((alliance) => alliance.other === player.id());
      if (alliance !== undefined) {
        allianceHtml = html` <div
          class="flex items-center ml-auto mr-0 gap-1 text-sm font-bold leading-tight"
        >
          <img src=${allianceIcon} width="20" height="20" />
          ${this.allianceExpirationText(alliance)}
        </div>`;
      }
    }
    let playerType = "";
    switch (player.type()) {
      case PlayerType.Bot:
        playerType = translateText("player_type.bot");
        break;
      case PlayerType.Nation:
        playerType = translateText("player_type.nation");
        break;
      case PlayerType.Human:
        playerType = translateText("player_type.player");
        break;
    }
    const playerTeam = getTranslatedPlayerTeamLabel(player.team());

    return html`
      <div class="flex items-start gap-1 lg:gap-2 p-1 lg:p-1.5">
        <!-- Left: Gold & Troop bar -->
        <div class="flex flex-col gap-1 shrink-0 w-28 md:w-36">
          <div class="flex items-center gap-1">
            <div
              class="flex flex-1 items-center justify-center px-1 py-0.5 border rounded-md border-yellow-400 font-bold text-yellow-400 text-sm lg:gap-1"
              translate="no"
            >
              <img src=${goldCoinIcon} width="13" height="13" />
              <span class="px-0.5">${renderNumber(player.gold())}</span>
            </div>
            <div
              class="flex flex-1 flex-col items-center justify-center text-xs font-bold ${attackingTroops >
              0
                ? "text-aquarius"
                : "text-white/40"} drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]"
              translate="no"
            >
              <span class="flex items-center gap-px leading-none text-xs"
                ><img
                  class="w-2.5 h-2.5 inline-block ${attackingTroops > 0
                    ? ""
                    : "brightness-0 invert opacity-40"}"
                  src=${attackingTroops > 0 ? soldierIconAquarius : soldierIcon}
                  alt=""
                  aria-hidden="true"
                />↑</span
              >
              <span class="tabular-nums leading-none text-sm mt-0.5"
                >${renderTroops(attackingTroops)}</span
              >
            </div>
          </div>
          <div class="w-28 md:w-36" translate="no">
            ${this.renderTroopBar(totalTroops, attackingTroops, maxTroops)}
          </div>
        </div>
        <!-- Right: Player identity + Units below -->
        <div class="flex flex-col justify-between self-stretch">
          <div
            class="flex items-center gap-2 font-bold text-sm lg:text-lg ${this.getPlayerNameColor(
              isFriendly ?? false,
            )}"
          >
            ${player.cosmetics.flag
              ? html`<img
                  class="h-6 object-contain"
                  src=${assetUrl(player.cosmetics.flag!)}
                />`
              : html``}
            <span>${player.displayName()}</span>
            ${this.getRelationSmiley(player, myPlayer)}
            ${playerTeam !== "" && player.type() !== PlayerType.Bot
              ? html`<div class="flex flex-col leading-tight">
                  <span class="text-gray-400 text-xs font-normal"
                    >${playerType}</span
                  >
                  <span class="text-xs font-normal text-gray-400"
                    >[<span
                      style="color: ${this.game
                        .config()
                        .theme()
                        .teamColor(player.team()!)
                        .toHex()}"
                      >${playerTeam}</span
                    >]</span
                  >
                </div>`
              : html`<span class="text-gray-400 text-xs font-normal"
                  >${playerType}</span
                >`}
            ${this.renderPlayerNameIcons(player)} ${allianceHtml ?? ""}
          </div>
          <div class="flex gap-0.5 lg:gap-1 items-center mt-0.5">
            ${this.displayUnitCount(player, UnitType.City, cityIcon)}
            ${this.displayUnitCount(player, UnitType.Factory, factoryIcon)}
            ${this.displayUnitCount(player, UnitType.Port, portIcon)}
            ${this.displayUnitCount(
              player,
              UnitType.MissileSilo,
              missileSiloIcon,
            )}
            ${this.displayUnitCount(
              player,
              UnitType.SAMLauncher,
              samLauncherIcon,
            )}
            ${this.displayUnitCount(player, UnitType.Warship, warshipIcon)}
          </div>
        </div>
      </div>
      ${
        /* What the cursor is ON, not just whose land it is: the structure
         * under the hover point, named with its level and its one-clause
         * engine meaning (see renderNearbyStructures). Broadcast only —
         * this card is shown for ANY owner, so ungated it read out an
         * opponent's silo and SAM levels on hover (see enriched()). */
        enriched() ? this.renderNearbyStructures() : ""
      }
    `;
  }

  private renderTroopBar(
    totalTroops: number,
    attackingTroops: number,
    maxTroops: number,
  ) {
    const base = Math.max(maxTroops, 1);
    const greenPercentRaw = (totalTroops / base) * 100;
    const orangePercentRaw = (attackingTroops / base) * 100;

    const greenPercent = Math.max(0, Math.min(100, greenPercentRaw));
    const orangePercent = Math.max(
      0,
      Math.min(100 - greenPercent, orangePercentRaw),
    );

    return html`
      <div
        class="w-full h-5 lg:h-6 border border-gray-600 rounded-md bg-gray-900/60 overflow-hidden relative"
      >
        <div class="h-full flex">
          ${greenPercent > 0
            ? html`<div
                class="h-full bg-sky-700 transition-[width] duration-200"
                style="width: ${greenPercent}%;"
              ></div>`
            : ""}
          ${orangePercent > 0
            ? html`<div
                class="h-full bg-malibu-blue transition-[width] duration-200"
                style="width: ${orangePercent}%;"
              ></div>`
            : ""}
        </div>
        <div
          class="absolute inset-0 flex items-center justify-between px-1.5 text-sm font-bold leading-none pointer-events-none"
          translate="no"
        >
          <span class="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]"
            >${renderTroops(totalTroops)}</span
          >
          <span class="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]"
            >${renderTroops(maxTroops)}</span
          >
        </div>
        <img
          src=${soldierIcon}
          alt=""
          aria-hidden="true"
          width="14"
          height="14"
          class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 brightness-0 invert drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)] pointer-events-none"
        />
      </div>
    `;
  }

  /* Numbers on the enriched lines read in the broadcast's numeral face.
   * The reskin (GameRenderer.ts ~1140) themes this card by [class*=...]
   * selectors over the Tailwind classes the template emits, but none of its
   * player-info-overlay rules apply --pw-num, so mono comes via an inline
   * font-family: var(--pw-num) resolves on the broadcast (defined on
   * body.ai-league-native-spectator-ui, GameRenderer.ts:518) and the
   * declared fallback stack serves the live game, where the var is unset. */
  private mono(value: string | number): TemplateResult {
    return html`<span
      class="tabular-nums"
      translate="no"
      style="font-family: var(--pw-num, ui-monospace, 'SF Mono', Menlo, monospace);"
      >${value}</span
    >`;
  }

  /* One clause per structure type, every claim read out of the engine:
   *  - City: each level adds cityTroopIncrease() = 250,000 to maxTroops
   *    (DefaultConfig.ts:194-196 for the constant, 816-826 for the sum over
   *    city levels).
   *  - Port: spawns trade ships toward other ports (PortExecution.ts:59 →
   *    TradeShipExecution); each arrival pays gold to BOTH port owners
   *    (TradeShipExecution.ts:191-218).
   *  - Missile Silo: launches nukes; its level is its launch-tube count
   *    (missileReadinesss treats level as maxMissiles, GameView.ts:173-181)
   *    and SiloCooldown() = 90 ticks = 9s at 10 ticks/s
   *    (DefaultConfig.ts:206-208; tick rate per warshipShellLifetime's
   *    "one tick is 100ms" comment, DefaultConfig.ts:771-773).
   *  - Defense Post: within defensePostRange() = 30 tiles the defender's
   *    attackLogic multiplies attacker losses x5 and per-tile time x3
   *    (DefaultConfig.ts:210-220 constants, 657-668 application).
   *  - SAM Launcher: intercepts incoming nukes (SAMLauncherExecution
   *    computeInterceptionTile), SAMCooldown() = 90 ticks = 9s
   *    (DefaultConfig.ts:203-205).
   *  - Factory: spawns trains that deliver gold when they arrive
   *    (trainSpawnRate DefaultConfig.ts:274-278, trainGold 279-302). */
  private structureMeaning(unit: UnitView): TemplateResult | null {
    switch (unit.type()) {
      case UnitType.City:
        return html`${translateText(
          "hover_inspect.structure_city",
          undefined,
          "grows the army cap — +",
        )}${this.mono("250K")}${translateText(
          "hover_inspect.structure_city_suffix",
          undefined,
          " max troops per level",
        )}`;
      case UnitType.Port:
        return html`${translateText(
          "hover_inspect.structure_port",
          undefined,
          "sea trade hub — sends trade ships; every arrival pays gold to both ports",
        )}`;
      case UnitType.MissileSilo:
        return html`${translateText(
          "hover_inspect.structure_silo",
          undefined,
          "launches nukes — ",
        )}${this.mono(unit.level())}
        ${translateText(
          "hover_inspect.structure_silo_suffix",
          undefined,
          `launch tube${unit.level() === 1 ? "" : "s"}, `,
        )}${this.mono("9")}${translateText(
          "hover_inspect.structure_silo_reload",
          undefined,
          "s reload",
        )}`;
      case UnitType.DefensePost:
        return html`${translateText(
          "hover_inspect.structure_defense_post",
          undefined,
          "fortifies a ",
        )}${this.mono("30")}${translateText(
          "hover_inspect.structure_defense_post_mid",
          undefined,
          "-tile radius — attackers there lose ",
        )}${this.mono("×5")}${translateText(
          "hover_inspect.structure_defense_post_speed",
          undefined,
          " troops and advance ",
        )}${this.mono("×3")}${translateText(
          "hover_inspect.structure_defense_post_suffix",
          undefined,
          " slower",
        )}`;
      case UnitType.SAMLauncher:
        return html`${translateText(
          "hover_inspect.structure_sam",
          undefined,
          "intercepts incoming nukes — ",
        )}${this.mono("9")}${translateText(
          "hover_inspect.structure_sam_suffix",
          undefined,
          "s reload between shots",
        )}`;
      case UnitType.Factory:
        return html`${translateText(
          "hover_inspect.structure_factory",
          undefined,
          "sends freight trains that deliver gold along railroads",
        )}`;
      default:
        return null;
    }
  }

  /* The structure lines under the player card. The tile owner was always
   * shown; WHAT the cursor is on never was — a city, a silo and a defense
   * post all read as anonymous dots. Same lookup pattern as the water
   * branch (units-of-types filtered by euclideanDistWorld). The radius is
   * SCREEN-derived, not a fixed world constant: the owner reported city
   * hover as "unreliable, the hover area is too small", and the arithmetic
   * agrees — structure icons draw at a fixed ~20 SCREEN pixels, so at the
   * whole-board fit (scale ~0.59) a 3-tile world radius is under 2 screen
   * pixels of forgiveness. 14 screen pixels divided by the live camera scale
   * keeps the hit area matched to the icon the viewer is actually aiming at,
   * at every zoom (floor 3 tiles so close zoom never goes sub-icon).
   * Max two lines so the card stays a
   * glance, nearest first. Re-queried from the live `this.game` on every
   * render — never cached — so levels, construction state and existence are
   * always current-tick truth. */
  private renderNearbyStructures(): TemplateResult | "" {
    if (this.hoverTile === null) return "";
    const worldCoord = {
      x: this.game.x(this.hoverTile),
      y: this.game.y(this.hoverTile),
    };
    const structures = this.game
      .units(
        UnitType.City,
        UnitType.Port,
        UnitType.MissileSilo,
        UnitType.DefensePost,
        UnitType.SAMLauncher,
        UnitType.Factory,
      )
      .filter(
        (u) =>
          euclideanDistWorld(worldCoord, u.tile(), this.game) <=
          Math.max(3, 14 / Math.max(this.transform.scale, 0.0001)),
      )
      .sort(distSortUnitWorld(worldCoord, this.game))
      .slice(0, 2);
    if (structures.length === 0) return "";
    return html`<div class="border-t border-gray-600 px-2 py-1">
      ${structures.map(
        (u) =>
          html`<div class="text-sm leading-snug">
            <span class="font-bold text-yellow-400 uppercase" translate="no"
              >${u.type()}
              ${
                /* Level only where the engine can raise it: unitInfo marks
                 * City/Port/MissileSilo/SAMLauncher/Factory upgradable
                 * (DefaultConfig.ts:338-479); DefensePost is not, so
                 * "LV 1" there would be dead ink. */
                u.type() !== UnitType.DefensePost
                  ? html`&middot;
                    ${translateText(
                      "hover_inspect.level_abbrev",
                      undefined,
                      "LV",
                    )}
                    ${this.mono(u.level())}`
                  : ""
              }</span
            >
            ${u.isUnderConstruction()
              ? html`<span class="text-gray-400">
                  ${translateText(
                    "hover_inspect.under_construction",
                    undefined,
                    "(under construction)",
                  )}</span
                >`
              : ""}
            <span class="text-gray-400"> — ${this.structureMeaning(u)}</span>
          </div>`,
      )}
    </div>`;
  }

  /* CONTAMINATED GROUND. Fallout tiles have no owner, so before this card
   * existed the most visually alarming thing on the board answered a hover
   * with nothing. Every number here is the engine's own, computed at render
   * time from the live game:
   *  - attackLogic multiplies BOTH the attacker's troop losses (mag) and
   *    the per-tile conquest time (speed) by falloutDefenseModifier when
   *    the conquered tile has fallout (DefaultConfig.ts:671-675),
   *  - falloutDefenseModifier(ratio) = 5 - 2*ratio where ratio is the
   *    irradiated share of all land (DefaultConfig.ts:198-202 — note the
   *    "[5, 2.5]" comment there is stale, the formula's range is [3, 5]),
   *  - ratio = numTilesWithFallout() / numLandTiles(), exactly as
   *    attackLogic computes it (DefaultConfig.ts:672).
   * The eyebrow wears the hazard tone via an inline var(--pw-hazard)
   * (defined GameRenderer.ts:515) — coral is reserved for lines that MEAN
   * nuke, and this card is the one place on this overlay that genuinely
   * does; the fallback hex keeps the same meaning on the live game where
   * the broadcast vars are unset. */
  private renderFalloutInfo(tile: TileRef): TemplateResult {
    const falloutRatio =
      this.game.numTilesWithFallout() / this.game.numLandTiles();
    const modifier = this.game.config().falloutDefenseModifier(falloutRatio);
    return html`
      <div class="p-2">
        <div
          class="font-bold mb-1 text-sm uppercase tracking-wide"
          style="color: var(--pw-hazard, #ff6b4a);"
        >
          ${translateText(
            "hover_inspect.fallout_title",
            undefined,
            "Contaminated ground",
          )}
        </div>
        <div class="text-sm">
          ${translateText(
            "hover_inspect.fallout_body",
            undefined,
            "Irradiated by a nuclear detonation.",
          )}
          <span class="text-gray-400"
            >${translateText(
              "hover_inspect.fallout_effect_prefix",
              undefined,
              "Attacking through it right now: troop losses ",
            )}${this.mono(`×${modifier.toFixed(1)}`)}${translateText(
              "hover_inspect.fallout_effect_mid",
              undefined,
              ", advance ",
            )}${this.mono(`×${modifier.toFixed(1)}`)}${translateText(
              "hover_inspect.fallout_effect_suffix",
              undefined,
              " slower.",
            )}</span
          >
        </div>
        <div class="text-sm text-gray-400">
          ${this.mono(renderNumber(this.game.numTilesWithFallout()))}
          ${translateText(
            "hover_inspect.fallout_tiles_mid",
            undefined,
            "tiles irradiated — ",
          )}${this.mono(`${(falloutRatio * 100).toFixed(1)}%`)}
          ${translateText(
            "hover_inspect.fallout_tiles_suffix",
            undefined,
            "of all land",
          )}
        </div>
      </div>
    `;
  }

  /* Trade ship: who is trading with whom, and what the voyage is worth.
   *  - The partner: targetUnitId() is the DESTINATION PORT's unit id — set
   *    from targetUnit at build (TradeShipExecution.ts:55-58, serialized
   *    UnitImpl.ts:147, noted "Only for trade ships" GameUpdates.ts:146) —
   *    so game.unit(id).owner() is the other side of the trade; the ship's
   *    own owner is the source side.
   *  - Capture: a captured trade ship is re-pointed at the CAPTOR's own
   *    nearest port (TradeShipExecution.ts:94-118) and on delivery the
   *    captor alone collects the full payout (175-190). A legitimate route
   *    can never target a port of the ship's own owner — the execution
   *    deletes the ship the moment destination and source owners match
   *    (76-80) — so destination-owner == ship-owner IS the captured state,
   *    no extra flag needed.
   *  - The payout: on a normal arrival BOTH port owners are paid the SAME
   *    amount (TradeShipExecution.ts:192-193), tradeShipGold(tilesTraveled)
   *    — a sigmoid plus 50 gold per tile actually sailed
   *    (DefaultConfig.ts:314-320). tilesTraveled lives only inside the
   *    server-side execution and never reaches a client update, so the card
   *    states the mechanic (equal payout, longer routes pay more) and shows
   *    the straight-line tiles still to sail — which IS client-computable —
   *    rather than inventing a gold figure. */
  private renderTradeShipInfo(unit: UnitView): TemplateResult | "" {
    const targetId = unit.targetUnitId();
    const dstPort =
      targetId !== undefined ? this.game.unit(targetId) : undefined;
    if (dstPort === undefined) {
      // Destination port no longer resolvable (destroyed / pre-spawn after a
      // rewind): show nothing rather than a guess.
      return "";
    }
    const partner = dstPort.owner();
    const captured = partner.id() === unit.owner().id();
    const worldCoord = {
      x: this.game.x(unit.tile()),
      y: this.game.y(unit.tile()),
    };
    const tilesToGo = Math.round(
      euclideanDistWorld(worldCoord, dstPort.tile(), this.game),
    );
    if (captured) {
      return html`
        <div class="text-sm">
          <span class="text-gray-400"
            >${translateText(
              "hover_inspect.trade_captured",
              undefined,
              "Captured cargo — sailing to its captor's port; the captor keeps the full payout",
            )}</span
          >
        </div>
        <div class="text-sm text-gray-400">
          &asymp; ${this.mono(renderNumber(tilesToGo))}
          ${translateText(
            "hover_inspect.trade_tiles_to_port",
            undefined,
            "tiles (straight line) to port",
          )}
        </div>
      `;
    }
    return html`
      <div class="text-sm">
        <span class="text-gray-400"
          >${translateText(
            "hover_inspect.trading_with",
            undefined,
            "Trading with",
          )}</span
        >
        <span class="font-bold" translate="no">${partner.displayName()}</span>
      </div>
      <div class="text-sm text-gray-400">
        &asymp; ${this.mono(renderNumber(tilesToGo))}
        ${translateText(
          "hover_inspect.trade_tiles_to_port",
          undefined,
          "tiles (straight line) to port",
        )}
      </div>
      <div class="text-sm text-gray-400">
        ${translateText(
          "hover_inspect.trade_payout",
          undefined,
          "On arrival both sides collect the same gold payout — longer routes pay more",
        )}
      </div>
    `;
  }

  /* Transport ship: where those troops are actually going.
   *  - targetTile() is real for transports: the boat is built with
   *    targetTile = the landing tile (TransportShipExecution.ts:126-129)
   *    and every UnitUpdate serializes it (UnitImpl.ts:148 — the "Only for
   *    nukes" comment at GameUpdates.ts:147 predates that and is stale).
   *    On retreat it is re-pointed home (TransportShipExecution.ts:223-227).
   *  - Retreat: transportShipState().isRetreating is the engine's own flag
   *    (Game.ts:37-40); a retreat landing kills malusForRetreat = 25% of
   *    the carried troops (TransportShipExecution.ts:19, 234-237).
   *  - Landing outcomes, from the COMPLETE branch: the boat conquers its
   *    landing tile (256), then a FRIENDLY target means the carried troops
   *    rejoin the ship owner's own reserve (257-258 — attacker.addTroops,
   *    NOT a gift to the ally); any other player target spawns an
   *    AttackExecution with the carried troops (260-268). */
  private renderTransportMission(unit: UnitView): TemplateResult | "" {
    if (unit.transportShipState().isRetreating) {
      return html`<div class="text-sm">
        <span class="text-gray-400"
          >${translateText(
            "hover_inspect.transport_retreating_prefix",
            undefined,
            "Retreating — returning home; ",
          )}${this.mono("25%")}${translateText(
            "hover_inspect.transport_retreating_suffix",
            undefined,
            " of the carried troops are lost on the way back",
          )}</span
        >
      </div>`;
    }
    const dest = unit.targetTile();
    if (dest === undefined) return "";
    const destOwner = this.game.owner(dest);
    if (!destOwner.isPlayer()) {
      return html`<div class="text-sm text-gray-400">
        ${translateText(
          "hover_inspect.transport_unclaimed",
          undefined,
          "Landing on unclaimed territory",
        )}
      </div>`;
    }
    const defender = destOwner as PlayerView;
    if (defender.id() === unit.owner().id()) {
      return html`<div class="text-sm text-gray-400">
        ${translateText(
          "hover_inspect.transport_home",
          undefined,
          "Returning to home territory",
        )}
      </div>`;
    }
    if (unit.owner().isFriendly(defender)) {
      return html`<div class="text-sm">
        <span class="text-gray-400"
          >${translateText(
            "hover_inspect.transport_friendly",
            undefined,
            "Friendly landing on",
          )}</span
        >
        <span class="font-bold" translate="no">${defender.displayName()}</span>
        <span class="text-gray-400"
          >${translateText(
            "hover_inspect.transport_friendly_suffix",
            undefined,
            "— the troops rejoin their owner's reserve ashore",
          )}</span
        >
      </div>`;
    }
    return html`<div class="text-sm">
      <span class="text-gray-400"
        >${translateText(
          "hover_inspect.transport_invading",
          undefined,
          "Invading",
        )}</span
      >
      <span class="font-bold" translate="no">${defender.displayName()}</span>
      <span class="text-gray-400"
        >${translateText(
          "hover_inspect.transport_invading_suffix",
          undefined,
          "— troops attack on landing",
        )}</span
      >
    </div>`;
  }

  /* Warship: condition and posture.
   *  - Health out of unitInfo(Warship).maxHealth = 1000
   *    (DefaultConfig.ts:351-358) — the bare "Health: 640" the card used to
   *    show was a number with no scale.
   *  - Posture from the engine's own state machine (Game.ts:29-35):
   *    isInCombat is the live-fire flag; "retreating" is specifically a
   *    repair retreat to the nearest port (WarshipExecution.ts:314-325) and
   *    "docked" is healing at that port (386-398), so the labels say so.
   *    warshipState() throws on a UnitView whose update carried no state
   *    (GameView UnitView.warshipState), and warships built without a
   *    patrolTile param never get one (UnitImpl.ts:69-75), so the read is
   *    guarded — a missing state renders nothing instead of crashing the
   *    card. */
  private renderWarshipStatus(unit: UnitView): TemplateResult | "" {
    let stateLabel = "";
    if (unit.isInCombat()) {
      stateLabel = translateText(
        "hover_inspect.warship_combat",
        undefined,
        "In combat",
      );
    } else {
      try {
        switch (unit.warshipState().state) {
          case "patrolling":
            stateLabel = translateText(
              "hover_inspect.warship_patrolling",
              undefined,
              "On patrol",
            );
            break;
          case "retreating":
            stateLabel = translateText(
              "hover_inspect.warship_retreating",
              undefined,
              "Withdrawing to port for repairs",
            );
            break;
          case "docked":
            stateLabel = translateText(
              "hover_inspect.warship_docked",
              undefined,
              "Docked — repairing",
            );
            break;
        }
      } catch {
        // No warshipState in this unit's update: omit the posture line.
      }
    }
    if (stateLabel === "") return "";
    return html`<div class="text-sm text-gray-400">${stateLabel}</div>`;
  }

  private renderUnitInfo(unit: UnitView) {
    const isAlly =
      (unit.owner() === this.game.myPlayer() ||
        this.game.myPlayer()?.isFriendly(unit.owner())) ??
      false;

    /* Health with its scale: max from unitInfo (Warship 1000,
     * DefaultConfig.ts:351-358). Falls back to the bare number for any
     * healthed type whose info carries no maxHealth. Gated alongside its
     * own call site so the live path performs no config lookup upstream
     * never performed — a hover must not reach code upstream never ran. */
    const maxHealth =
      enriched() && unit.hasHealth()
        ? this.game.config().unitInfo(unit.type()).maxHealth
        : undefined;

    return html`
      <div class="p-2">
        <div class="font-bold mb-1 ${isAlly ? "text-green-500" : "text-white"}">
          ${unit.owner().displayName()}
        </div>
        <div class="mt-1">
          <div class="text-sm opacity-80">${unit.type()}</div>
          ${unit.hasHealth()
            ? enriched()
              ? html`<div class="text-sm">
                  <span class="text-gray-400"
                    >${translateText(
                      "hover_inspect.health",
                      undefined,
                      "Health",
                    )}</span
                  >
                  ${this.mono(
                    maxHealth !== undefined
                      ? `${Math.round(unit.health())} / ${maxHealth}`
                      : `${Math.round(unit.health())}`,
                  )}
                </div>`
              : /* Upstream's line, character for character. The enriched
                 * form above leaks no intel — maxHealth is public config,
                 * identical for every hull of a type — but it still changes
                 * what a live match RENDERS (a scale, a translated label, a
                 * monospace numeral face), and the contract this patch ships
                 * under is that a live match looks exactly as it did. */
                html` <div class="text-sm">Health: ${unit.health()}</div> `
            : ""}
          ${enriched() && unit.type() === UnitType.Warship
            ? this.renderWarshipStatus(unit)
            : ""}
          ${unit.type() === UnitType.TransportShip
            ? enriched()
              ? html`
                  <div class="text-sm">
                    <span class="text-gray-400"
                      >${translateText(
                        "hover_inspect.troops",
                        undefined,
                        "Troops",
                      )}</span
                    >
                    ${this.mono(renderTroops(unit.troops()))}
                  </div>
                  ${this.renderTransportMission(unit)}
                `
              : // Upstream's line, character for character (see the health
                // line above for why presentation alone is enough to gate).
                html`
                  <div class="text-sm">
                    Troops: ${renderTroops(unit.troops())}
                  </div>
                `
            : ""}
          ${enriched() && unit.type() === UnitType.TradeShip
            ? this.renderTradeShipInfo(unit)
            : ""}
        </div>
      </div>
    `;
  }

  render() {
    if (!this._isActive) {
      return html``;
    }

    /* The fallout card is tile-anchored and re-proven against the CURRENT
     * game every render (maybeShow only recorded the tile): if a rewind
     * lands on a tick before the detonation, hasFallout() is false here and
     * the card simply has nothing to say.
     * The gate is repeated here rather than inherited from maybeShow's
     * branch, because hoverTile is set by the OWNER branch too and outlives
     * `player`: willUpdate can null a retained PlayerView on a
     * createRenderer pass without clearing the tile, which would leave the
     * live path one state transition away from rendering this card. Gating
     * the render keeps "no fallout card off the broadcast" a local fact
     * instead of a proof about maybeShow. */
    const falloutCard =
      enriched() &&
      this.player === null &&
      this.unit === null &&
      this.hoverTile !== null &&
      this.game.hasFallout(this.hoverTile)
        ? this.renderFalloutInfo(this.hoverTile)
        : null;

    /* NEVER RENDER AN EMPTY GLASS: _isInfoVisible alone is no longer proof
     * there is content — the fallout card can evaporate under a rewind (see
     * above) while the visibility flag is still true. A hover card with
     * nothing to say stays hidden, same rule the broadcast panels follow. */
    const hasContent =
      this.player !== null || this.unit !== null || falloutCard !== null;

    const containerClasses =
      this._isInfoVisible && hasContent
        ? "opacity-100 visible"
        : "opacity-0 invisible pointer-events-none";

    return html`
      <div
        class="fixed top-0 left-0 right-0 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-[1001]"
        style="margin-top: ${this.barOffset}px;"
        @click=${() => this.hide()}
        @contextmenu=${(e: MouseEvent) => e.preventDefault()}
      >
        <div
          class="bg-gray-800/92 backdrop-blur-sm shadow-xs min-[1200px]:rounded-lg sm:rounded-b-lg shadow-lg text-white text-lg lg:text-base w-full sm:w-[500px] overflow-hidden ${containerClasses}"
        >
          ${this.player !== null ? this.renderPlayerInfo(this.player) : ""}
          ${this.unit !== null ? this.renderUnitInfo(this.unit) : ""}
          ${falloutCard ?? ""}
        </div>
      </div>
    `;
  }

  createRenderRoot() {
    return this; // Disable shadow DOM to allow Tailwind styles
  }
}
