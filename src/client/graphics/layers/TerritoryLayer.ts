import { PriorityQueue } from "@datastructures-js/priority-queue";
import { Colord } from "colord";
import { Theme } from "../../../core/configuration/Config";
import { EventBus } from "../../../core/EventBus";
import {
  Cell,
  ColoredTeams,
  PlayerType,
  Team,
  UnitType,
} from "../../../core/game/Game";
import { euclDistFN, TileRef } from "../../../core/game/GameMap";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import { GameView, PlayerView } from "../../../core/game/GameView";
import { PseudoRandom } from "../../../core/PseudoRandom";
import {
  AlternateViewEvent,
  DragEvent,
  MouseOverEvent,
} from "../../InputHandler";
import { FrameProfiler } from "../FrameProfiler";
import { PointOfViewChangeEvent } from "../PointOfView";
import { TransformHandler } from "../TransformHandler";
import { Layer } from "./Layer";

// Alpha a non-followed agent's territory/border paint down to when a PoV
// is set (see `povPlayer`) — well below the normal 150/255, but never 0:
// ownership must stay legible, just visually secondary to whoever the
// viewer is following.
const POV_DIMMED_FILL_ALPHA = 60;
const POV_DIMMED_BORDER_ALPHA = 130;
// Diplomacy emphasis (product overhaul spec Stage 4 item 6): the followed
// player's CURRENT allies/war targets get a LESS aggressive dim than
// everyone else — "related but not the focus", legible as distinct from
// both the followed player (full strength) and genuinely unrelated nations
// (the base dimmed alpha above). Still opt-in-only: this tier only ever
// applies once a PoV is already set by a direct viewer click (see
// `PointOfViewSelector`'s own doc) — never on its own, never automatic.
const POV_RELATED_FILL_ALPHA = 105;
const POV_RELATED_BORDER_ALPHA = 190;

export class TerritoryLayer implements Layer {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private imageData: ImageData;
  private alternativeImageData: ImageData;
  private borderAnimTime = 0;

  private cachedTerritoryPatternsEnabled: boolean | undefined;

  private tileToRenderQueue: PriorityQueue<{
    tile: TileRef;
    lastUpdate: number;
  }> = new PriorityQueue((a, b) => {
    return a.lastUpdate - b.lastUpdate;
  });
  private random = new PseudoRandom(123);
  private theme: Theme;

  // Used for spawn highlighting
  private highlightCanvas: HTMLCanvasElement;
  private highlightContext: CanvasRenderingContext2D;

  private highlightedTerritory: PlayerView | null = null;

  private alternativeView = false;
  private lastDragTime = 0;
  private nodrawDragDuration = 200;
  private lastMousePosition: { x: number; y: number } | null = null;

  private refreshRate = 10; //refresh every 10ms
  private lastRefresh = 0;

  private lastFocusedPlayer: PlayerView | null = null;
  // Set only via `PointOfViewChangeEvent` (see `PointOfViewSelector`).
  // `null` on every route that never mounts that picker (live play, and
  // a spectator route before/without a PoV pick) — `paintTerritory`
  // reads this to dim every other nation's territory alpha so the
  // followed agent's holdings read at full strength, without moving the
  // camera or changing anyone's actual color.
  private povPlayer: PlayerView | null = null;
  // Diplomacy emphasis: `povPlayer`'s current ally/target smallIDs, recomputed
  // every `tick()` while a PoV is set (cheap — `allies()`/`targets()` are
  // small arrays) so it stays current as alliances form/break and new war
  // targets appear, without a per-tile relationship recomputation cost (see
  // `recomputeRelatedToPov`/`paintTerritory`).
  private relatedToPovIds: ReadonlySet<number> | null = null;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private transformHandler: TransformHandler,
  ) {
    this.theme = game.config().theme();
    this.cachedTerritoryPatternsEnabled = undefined;
  }

  shouldTransform(): boolean {
    return true;
  }

  async paintPlayerBorder(player: PlayerView) {
    const tiles = await player.borderTiles();
    tiles.borderTiles.forEach((tile: TileRef) => {
      this.paintTerritory(tile, true); // Immediately paint the tile instead of enqueueing
    });
  }

  tick() {
    if (this.game.inSpawnPhase()) {
      this.spawnHighlight();
    }
    // Diplomacy emphasis: cheap (small arrays) every tick a PoV is set;
    // a no-op allocation-free check otherwise. A changed relationship set
    // (new alliance, new war target, a broken alliance) needs a full
    // repaint — unlike an ownership change, nothing else already triggers
    // one for tiles that didn't change hands but DID change relationship
    // to the followed player.
    if (this.povPlayer !== null && this.recomputeRelatedToPov()) {
      this.game.forEachTile((t) => this.paintTerritory(t));
    }

    this.game.recentlyUpdatedTiles().forEach((t) => {
      this.enqueueTile(t);
      // Immediately clear territory overlay for water tiles so old
      // borders/territory don't persist visually (e.g. after nuke turns land to water)
      if (this.game.isWater(t)) {
        this.clearTile(t);
      }
    });
    const updates = this.game.updatesSinceLastTick();
    const unitUpdates = updates !== null ? updates[GameUpdateType.Unit] : [];
    unitUpdates.forEach((update) => {
      if (update.unitType === UnitType.DefensePost) {
        // Only update borders if the defense post is not under construction
        if (update.underConstruction) {
          return; // Skip barrier creation while under construction
        }

        const tile = update.pos;
        this.game
          .bfs(tile, euclDistFN(tile, this.game.config().defensePostRange()))
          .forEach((t) => {
            if (
              this.game.isBorder(t) &&
              (this.game.ownerID(t) === update.ownerID ||
                this.game.ownerID(t) === update.lastOwnerID)
            ) {
              this.enqueueTile(t);
            }
          });
      }
    });

    // Detect alliance mutations
    const myPlayer = this.game.myPlayer();
    if (myPlayer) {
      updates?.[GameUpdateType.BrokeAlliance]?.forEach((update) => {
        const territory = this.game.playerBySmallID(update.betrayedID);
        if (territory && territory instanceof PlayerView) {
          this.redrawBorder(territory);
        }
      });

      updates?.[GameUpdateType.AllianceRequestReply]?.forEach((update) => {
        if (
          update.accepted &&
          (update.request.requestorID === myPlayer.smallID() ||
            update.request.recipientID === myPlayer.smallID())
        ) {
          const territoryId =
            update.request.requestorID === myPlayer.smallID()
              ? update.request.recipientID
              : update.request.requestorID;
          const territory = this.game.playerBySmallID(territoryId);
          if (territory && territory instanceof PlayerView) {
            this.redrawBorder(territory);
          }
        }
      });
      updates?.[GameUpdateType.EmbargoEvent]?.forEach((update) => {
        const player = this.game.playerBySmallID(update.playerID) as PlayerView;
        const embargoed = this.game.playerBySmallID(
          update.embargoedID,
        ) as PlayerView;

        if (
          player.id() === myPlayer?.id() ||
          embargoed.id() === myPlayer?.id()
        ) {
          this.redrawBorder(player, embargoed);
        }
      });
    }

    const focusedPlayer = this.game.focusedPlayer();
    if (focusedPlayer !== this.lastFocusedPlayer) {
      if (this.lastFocusedPlayer) {
        this.paintPlayerBorder(this.lastFocusedPlayer);
      }
      if (focusedPlayer) {
        this.paintPlayerBorder(focusedPlayer);
      }
      this.lastFocusedPlayer = focusedPlayer;
    }
  }

  private spawnHighlight() {
    this.highlightContext.clearRect(
      0,
      0,
      this.game.width(),
      this.game.height(),
    );

    this.drawFocusedPlayerHighlight();

    const humans = this.game
      .playerViews()
      .filter((p) => p.type() === PlayerType.Human);

    const focusedPlayer = this.game.focusedPlayer();
    const teamColors = Object.values(ColoredTeams);
    for (const human of humans) {
      if (human === focusedPlayer) {
        continue;
      }
      const center = human.nameLocation();
      if (!center) {
        continue;
      }
      const centerTile = this.game.ref(center.x, center.y);
      if (!centerTile) {
        continue;
      }
      let color = this.theme.spawnHighlightColor();
      const myPlayer = this.game.myPlayer();
      if (myPlayer !== null && myPlayer !== human && myPlayer.team() === null) {
        // In FFA games (when team === null), use default yellow spawn highlight color
        color = this.theme.spawnHighlightColor();
      } else if (myPlayer !== null && myPlayer !== human) {
        // In Team games, the spawn highlight color becomes that player's team color
        // Optionally, this could be broken down to teammate or enemy and simplified to green and red, respectively
        const team = human.team();
        if (team !== null && teamColors.includes(team)) {
          color = this.theme.teamColor(team);
        } else {
          if (myPlayer.isFriendly(human)) {
            color = this.theme.spawnHighlightTeamColor();
          } else {
            color = this.theme.spawnHighlightColor();
          }
        }
      }

      for (const tile of this.game.bfs(
        centerTile,
        euclDistFN(centerTile, 9, true),
      )) {
        if (!this.game.hasOwner(tile)) {
          this.paintHighlightTile(tile, color, 255);
        }
      }
    }
  }

  private drawFocusedPlayerHighlight() {
    const focusedPlayer = this.game.focusedPlayer();

    if (!focusedPlayer) {
      return;
    }
    const center = focusedPlayer.nameLocation();
    if (!center) {
      return;
    }
    // Breathing border animation
    this.borderAnimTime += 0.5;
    const minRad = 8;
    const maxRad = 24;
    // Range: [minPadding..maxPadding]
    const radius =
      minRad + (maxRad - minRad) * (0.5 + 0.5 * Math.sin(this.borderAnimTime));

    const baseColor = this.theme.spawnHighlightSelfColor(); //white
    let teamColor: Colord;

    const team: Team | null = focusedPlayer.team();
    if (team !== null && Object.values(ColoredTeams).includes(team)) {
      teamColor = this.theme.teamColor(team).alpha(0.5);
    } else {
      teamColor = baseColor;
    }

    this.drawBreathingRing(
      center.x,
      center.y,
      minRad,
      maxRad,
      radius,
      baseColor, // Always draw white static semi-transparent ring
      teamColor, // Pass the breathing ring color. White for FFA, Duos, Trios, Quads. Transparent team color for TEAM games.
    );

    // Draw breathing rings for teammates in team games (helps colorblind players identify teammates)
    this.drawTeammateHighlights(minRad, maxRad, radius);
  }

  private drawTeammateHighlights(
    minRad: number,
    maxRad: number,
    radius: number,
  ) {
    const myPlayer = this.game.myPlayer();
    if (myPlayer === null || myPlayer.team() === null) {
      return;
    }

    const teammates = this.game
      .playerViews()
      .filter((p) => p !== myPlayer && myPlayer.isOnSameTeam(p));

    // Smaller radius for teammates (more subtle than self highlight)
    const teammateMinRad = 5;
    const teammateMaxRad = 14;
    const teammateRadius =
      teammateMinRad +
      (teammateMaxRad - teammateMinRad) *
        ((radius - minRad) / (maxRad - minRad));

    const teamColors = Object.values(ColoredTeams);
    for (const teammate of teammates) {
      const center = teammate.nameLocation();
      if (!center) {
        continue;
      }

      const team = teammate.team();
      let baseColor: Colord;
      let breathingColor: Colord;

      if (team !== null && teamColors.includes(team)) {
        baseColor = this.theme.teamColor(team).alpha(0.5);
        breathingColor = this.theme.teamColor(team).alpha(0.5);
      } else {
        baseColor = this.theme.spawnHighlightTeamColor();
        breathingColor = this.theme.spawnHighlightTeamColor();
      }

      this.drawBreathingRing(
        center.x,
        center.y,
        teammateMinRad,
        teammateMaxRad,
        teammateRadius,
        baseColor,
        breathingColor,
      );
    }
  }

  init() {
    this.eventBus.on(MouseOverEvent, (e) => this.onMouseOver(e));
    this.eventBus.on(AlternateViewEvent, (e) => {
      this.alternativeView = e.alternateView;
    });
    this.eventBus.on(DragEvent, (e) => {
      // TODO: consider re-enabling this on mobile or low end devices for smoother dragging.
      // this.lastDragTime = Date.now();
    });
    this.eventBus.on(PointOfViewChangeEvent, (e) => this.onPointOfViewChange(e));
    this.redraw();
  }
  private onPointOfViewChange(event: PointOfViewChangeEvent) {
    if (this.povPlayer === event.player) {
      return;
    }
    this.povPlayer = event.player;
    this.recomputeRelatedToPov();
    // Every owned tile's alpha depends on `povPlayer` now (see
    // `paintTerritory`), so a change here has to repaint everything, not
    // just future updates — mirrors `redraw()`'s own full-map pass, just
    // without recreating the canvases. Rare (a viewer picking/clearing a
    // PoV), never a per-tick cost.
    this.game.forEachTile((t) => this.paintTerritory(t));
  }

  /**
   * Recomputes `relatedToPovIds` from `povPlayer`'s CURRENT allies/targets.
   * Returns whether the set actually changed (callers use this to decide
   * whether a full repaint is warranted) — `null` -> non-null, a changed
   * membership, or non-null -> `null` (PoV cleared) all count as a change;
   * an unchanged set (the common per-tick case) returns `false` cheaply.
   */
  private recomputeRelatedToPov(): boolean {
    if (this.povPlayer === null) {
      if (this.relatedToPovIds === null) return false;
      this.relatedToPovIds = null;
      return true;
    }
    const next = new Set<number>();
    for (const ally of this.povPlayer.allies()) next.add(ally.smallID());
    for (const target of this.povPlayer.targets()) next.add(target.smallID());
    const previous = this.relatedToPovIds;
    const changed =
      previous === null ||
      next.size !== previous.size ||
      [...next].some((id) => !previous.has(id));
    this.relatedToPovIds = next;
    return changed;
  }

  onMouseOver(event: MouseOverEvent) {
    this.lastMousePosition = { x: event.x, y: event.y };
    this.updateHighlightedTerritory();
  }

  private updateHighlightedTerritory() {
    if (!this.alternativeView) {
      return;
    }

    if (!this.lastMousePosition) {
      return;
    }

    const cell = this.transformHandler.screenToWorldCoordinates(
      this.lastMousePosition.x,
      this.lastMousePosition.y,
    );
    if (!this.game.isValidCoord(cell.x, cell.y)) {
      return;
    }

    const previousTerritory = this.highlightedTerritory;
    const territory = this.getTerritoryAtCell(cell);

    if (territory) {
      this.highlightedTerritory = territory;
    } else {
      this.highlightedTerritory = null;
    }

    if (previousTerritory?.id() !== this.highlightedTerritory?.id()) {
      const territories: PlayerView[] = [];
      if (previousTerritory) {
        territories.push(previousTerritory);
      }
      if (this.highlightedTerritory) {
        territories.push(this.highlightedTerritory);
      }
      this.redrawBorder(...territories);
    }
  }

  private getTerritoryAtCell(cell: { x: number; y: number }) {
    const tile = this.game.ref(cell.x, cell.y);
    if (!tile) {
      return null;
    }
    // If the tile has no owner, it is either a fallout tile or a terra nullius tile.
    if (!this.game.hasOwner(tile)) {
      return null;
    }
    const owner = this.game.owner(tile);
    return owner instanceof PlayerView ? owner : null;
  }

  redraw() {
    console.log("redrew territory layer");
    this.canvas = document.createElement("canvas");
    const context = this.canvas.getContext("2d");
    if (context === null) throw new Error("2d context not supported");
    this.context = context;
    this.canvas.width = this.game.width();
    this.canvas.height = this.game.height();

    this.imageData = this.context.getImageData(
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );
    this.alternativeImageData = this.context.getImageData(
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );
    this.initImageData();

    this.context.putImageData(
      this.alternativeView ? this.alternativeImageData : this.imageData,
      0,
      0,
    );

    // Add a second canvas for highlights
    this.highlightCanvas = document.createElement("canvas");
    const highlightContext = this.highlightCanvas.getContext("2d", {
      alpha: true,
    });
    if (highlightContext === null) throw new Error("2d context not supported");
    this.highlightContext = highlightContext;
    this.highlightCanvas.width = this.game.width();
    this.highlightCanvas.height = this.game.height();

    this.game.forEachTile((t) => {
      this.paintTerritory(t);
    });
  }

  redrawBorder(...players: PlayerView[]) {
    return Promise.all(
      players.map(async (player) => {
        const tiles = await player.borderTiles();
        tiles.borderTiles.forEach((tile: TileRef) => {
          this.paintTerritory(tile, true);
        });
      }),
    );
  }

  initImageData() {
    this.game.forEachTile((tile) => {
      const cell = new Cell(this.game.x(tile), this.game.y(tile));
      const index = cell.y * this.game.width() + cell.x;
      const offset = index * 4;
      this.imageData.data[offset + 3] = 0;
      this.alternativeImageData.data[offset + 3] = 0;
    });
  }

  renderLayer(context: CanvasRenderingContext2D) {
    const now = Date.now();
    if (
      now > this.lastDragTime + this.nodrawDragDuration &&
      now > this.lastRefresh + this.refreshRate
    ) {
      this.lastRefresh = now;
      const renderTerritoryStart = FrameProfiler.start();
      this.renderTerritory();
      FrameProfiler.end("TerritoryLayer:renderTerritory", renderTerritoryStart);

      const [topLeft, bottomRight] = this.transformHandler.screenBoundingRect();
      const vx0 = Math.max(0, topLeft.x);
      const vy0 = Math.max(0, topLeft.y);
      const vx1 = Math.min(this.game.width() - 1, bottomRight.x);
      const vy1 = Math.min(this.game.height() - 1, bottomRight.y);

      const w = vx1 - vx0 + 1;
      const h = vy1 - vy0 + 1;

      if (w > 0 && h > 0) {
        const putImageStart = FrameProfiler.start();
        this.context.putImageData(
          this.alternativeView ? this.alternativeImageData : this.imageData,
          0,
          0,
          vx0,
          vy0,
          w,
          h,
        );
        FrameProfiler.end("TerritoryLayer:putImageData", putImageStart);
      }
    }

    const drawCanvasStart = FrameProfiler.start();
    context.drawImage(
      this.canvas,
      -this.game.width() / 2,
      -this.game.height() / 2,
      this.game.width(),
      this.game.height(),
    );
    FrameProfiler.end("TerritoryLayer:drawCanvas", drawCanvasStart);
    if (this.game.inSpawnPhase()) {
      const highlightDrawStart = FrameProfiler.start();
      context.drawImage(
        this.highlightCanvas,
        -this.game.width() / 2,
        -this.game.height() / 2,
        this.game.width(),
        this.game.height(),
      );
      FrameProfiler.end(
        "TerritoryLayer:drawHighlightCanvas",
        highlightDrawStart,
      );
    }
  }

  renderTerritory() {
    let numToRender = Math.floor(this.tileToRenderQueue.size() / 10);
    if (numToRender === 0 || this.game.inSpawnPhase()) {
      numToRender = this.tileToRenderQueue.size();
    }

    while (numToRender > 0) {
      numToRender--;

      const entry = this.tileToRenderQueue.pop();
      if (!entry) {
        break;
      }

      const tile = entry.tile;
      this.paintTerritory(tile);
      for (const neighbor of this.game.neighbors(tile)) {
        this.paintTerritory(neighbor, true);
      }
    }
  }

  paintTerritory(tile: TileRef, isBorder: boolean = false) {
    if (isBorder && !this.game.hasOwner(tile)) {
      return;
    }

    if (!this.game.hasOwner(tile)) {
      if (this.game.hasFallout(tile)) {
        this.paintTile(this.imageData, tile, this.theme.falloutColor(), 150);
        this.paintTile(
          this.alternativeImageData,
          tile,
          this.theme.falloutColor(),
          150,
        );
        return;
      }
      this.clearTile(tile);
      return;
    }
    const owner = this.game.owner(tile) as PlayerView;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const isHighlighted =
      this.highlightedTerritory &&
      this.highlightedTerritory.id() === owner.id();
    const myPlayer = this.game.myPlayer();
    // Dim every OTHER agent's territory so the followed one reads at full
    // strength — never recolors anything, just pulls back the alpha this
    // layer already paints with. `null` when no PoV is set (the default,
    // and every non-spectator route) leaves every tile exactly as before.
    const isDimmedByPov = this.povPlayer !== null && owner !== this.povPlayer;
    // Diplomacy emphasis (spec item 6): among the dimmed nations, the
    // followed player's CURRENT allies/war targets get the lighter
    // "related" dim instead of the base one — visually distinct from both
    // the followed player (full strength) and genuinely unrelated nations.
    const isRelatedToPov =
      isDimmedByPov &&
      this.relatedToPovIds !== null &&
      this.relatedToPovIds.has(owner.smallID());

    if (this.game.isBorder(tile)) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const playerIsFocused = owner && this.game.focusedPlayer() === owner;
      if (myPlayer) {
        const alternativeColor = this.alternateViewColor(owner);
        this.paintTile(this.alternativeImageData, tile, alternativeColor, 255);
      }
      const isDefended = this.game.hasUnitNearby(
        tile,
        this.game.config().defensePostRange(),
        UnitType.DefensePost,
        owner.id(),
      );

      this.paintTile(
        this.imageData,
        tile,
        owner.borderColor(tile, isDefended),
        isDimmedByPov
          ? isRelatedToPov
            ? POV_RELATED_BORDER_ALPHA
            : POV_DIMMED_BORDER_ALPHA
          : 255,
      );
    } else {
      // Alternative view only shows borders.
      this.clearAlternativeTile(tile);

      this.paintTile(
        this.imageData,
        tile,
        owner.territoryColor(tile),
        isDimmedByPov
          ? isRelatedToPov
            ? POV_RELATED_FILL_ALPHA
            : POV_DIMMED_FILL_ALPHA
          : 150,
      );
    }
  }

  alternateViewColor(other: PlayerView): Colord {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) {
      return this.theme.neutralColor();
    }
    if (other.smallID() === myPlayer.smallID()) {
      return this.theme.selfColor();
    }
    if (other.isFriendly(myPlayer)) {
      return this.theme.allyColor();
    }
    if (!other.hasEmbargo(myPlayer)) {
      return this.theme.neutralColor();
    }
    return this.theme.enemyColor();
  }

  paintAlternateViewTile(tile: TileRef, other: PlayerView) {
    const color = this.alternateViewColor(other);
    this.paintTile(this.alternativeImageData, tile, color, 255);
  }

  paintTile(imageData: ImageData, tile: TileRef, color: Colord, alpha: number) {
    const offset = tile * 4;
    imageData.data[offset] = color.rgba.r;
    imageData.data[offset + 1] = color.rgba.g;
    imageData.data[offset + 2] = color.rgba.b;
    imageData.data[offset + 3] = alpha;
  }

  clearTile(tile: TileRef) {
    const offset = tile * 4;
    this.imageData.data[offset + 3] = 0; // Set alpha to 0 (fully transparent)
    this.alternativeImageData.data[offset + 3] = 0; // Set alpha to 0 (fully transparent)
  }

  clearAlternativeTile(tile: TileRef) {
    const offset = tile * 4;
    this.alternativeImageData.data[offset + 3] = 0; // Set alpha to 0 (fully transparent)
  }

  enqueueTile(tile: TileRef) {
    this.tileToRenderQueue.push({
      tile: tile,
      lastUpdate: this.game.ticks() + this.random.nextFloat(0, 0.5),
    });
  }

  async enqueuePlayerBorder(player: PlayerView) {
    const playerBorderTiles = await player.borderTiles();
    playerBorderTiles.borderTiles.forEach((tile: TileRef) => {
      this.enqueueTile(tile);
    });
  }

  paintHighlightTile(tile: TileRef, color: Colord, alpha: number) {
    this.clearTile(tile);
    const x = this.game.x(tile);
    const y = this.game.y(tile);
    this.highlightContext.fillStyle = color.alpha(alpha / 255).toRgbString();
    this.highlightContext.fillRect(x, y, 1, 1);
  }

  clearHighlightTile(tile: TileRef) {
    const x = this.game.x(tile);
    const y = this.game.y(tile);
    this.highlightContext.clearRect(x, y, 1, 1);
  }

  private drawBreathingRing(
    cx: number,
    cy: number,
    minRad: number,
    maxRad: number,
    radius: number,
    transparentColor: Colord,
    breathingColor: Colord,
  ) {
    const ctx = this.highlightContext;
    if (!ctx) return;

    // Draw a semi-transparent ring around the starting location
    ctx.beginPath();
    // Transparency matches the highlight color provided
    const transparent = transparentColor.alpha(0);
    const radGrad = ctx.createRadialGradient(cx, cy, minRad, cx, cy, maxRad);

    // Pixels with radius < minRad are transparent
    radGrad.addColorStop(0, transparent.toRgbString());
    // The ring then starts with solid highlight color
    radGrad.addColorStop(0.01, transparentColor.toRgbString());
    radGrad.addColorStop(0.1, transparentColor.toRgbString());
    // The outer edge of the ring is transparent
    radGrad.addColorStop(1, transparent.toRgbString());

    // Draw an arc at the max radius and fill with the created radial gradient
    ctx.arc(cx, cy, maxRad, 0, Math.PI * 2);
    ctx.fillStyle = radGrad;
    ctx.closePath();
    ctx.fill();

    const breatheInner = breathingColor.alpha(0);
    // Draw a solid ring around the starting location with outer radius = the breathing radius
    ctx.beginPath();
    const radGrad2 = ctx.createRadialGradient(cx, cy, minRad, cx, cy, radius);
    // Pixels with radius < minRad are transparent
    radGrad2.addColorStop(0, breatheInner.toRgbString());
    // The ring then starts with solid highlight color
    radGrad2.addColorStop(0.01, breathingColor.toRgbString());
    // The ring is solid throughout
    radGrad2.addColorStop(1, breathingColor.toRgbString());

    // Draw an arc at the current breathing radius and fill with the created "gradient"
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = radGrad2;
    ctx.fill();
  }
}
