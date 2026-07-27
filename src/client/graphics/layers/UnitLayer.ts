import { colord, Colord } from "colord";
import { EventBus } from "../../../core/EventBus";
import { Theme } from "../../../core/configuration/Config";
import { Cell, UnitType } from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { GameView, UnitView } from "../../../core/game/GameView";
import { BezenhamLine } from "../../../core/utilities/Line";
import {
  AlternateViewEvent,
  CloseViewEvent,
  ContextMenuEvent,
  MouseUpEvent,
  ReplaySpeedChangeEvent,
  SelectAllWarshipsEvent,
  TouchEvent,
  UnitSelectionEvent,
  WarshipSelectionBoxCancelEvent,
  WarshipSelectionBoxCompleteEvent,
} from "../../InputHandler";
import { MoveWarshipIntentEvent } from "../../Transport";
import { defaultReplaySpeedMultiplier } from "../../utilities/ReplaySpeedMultiplier";
import {
  ReplayPresentationCadenceEvent,
  replayPresentationTransitionDurationForIntervalMs,
  replayPresentationTransitionDurationMs,
  ReplayUnitPresentationMotion,
  retargetReplayUnitPresentationMotion,
  retimeReplayUnitPresentationMotion,
  sampleReplayUnitPresentationMotion,
} from "../ReplayPresentationSmoothing";
import { TransformHandler } from "../TransformHandler";
import { Layer } from "./Layer";

import { GameUpdateType } from "../../../core/game/GameUpdates";
import {
  getColoredSprite,
  isSpriteReady,
  loadAllSprites,
} from "../SpriteLoader";

enum Relationship {
  Self,
  Ally,
  Enemy,
}

export class UnitLayer implements Layer {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private transportShipTrailCanvas: HTMLCanvasElement;
  private unitTrailContext: CanvasRenderingContext2D;

  private unitToTrail = new Map<UnitView, TileRef[]>();
  private pendingTrailClears: UnitView[] = [];

  private theme: Theme;

  private alternateView = false;

  private oldShellTile = new Map<UnitView, TileRef>();

  private transformHandler: TransformHandler;

  // Selected unit property as suggested in the review comment
  private selectedUnit: UnitView | null = null;

  // Multi-selected warships (from selection box)
  private selectedWarships: UnitView[] = [];

  private readonly replayPresentationEnabled: boolean;
  private replayUnitTransitionMs: number;
  private progressivePresentationIntervalMs: number | null = null;
  private replaySpriteUnits = new Map<number, UnitView>();
  private replayUnitMotions = new Map<number, ReplayUnitPresentationMotion>();

  // Configuration for unit selection
  private readonly WARSHIP_SELECTION_RADIUS = 10; // Radius in game cells for warship selection hit zone

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    transformHandler: TransformHandler,
  ) {
    this.theme = game.config().theme();
    this.transformHandler = transformHandler;
    this.replayPresentationEnabled = game.config().isReplay();
    this.replayUnitTransitionMs = this.replayPresentationEnabled
      ? replayPresentationTransitionDurationMs(defaultReplaySpeedMultiplier)
      : 0;
  }

  shouldTransform(): boolean {
    return true;
  }

  tick() {
    const updatedUnitIds =
      this.game
        .updatesSinceLastTick()
        ?.[GameUpdateType.Unit]?.map((unit) => unit.id) ?? [];

    const motionPlanUnitIds = this.game.motionPlannedUnitIds();

    if (updatedUnitIds.length === 0) {
      this.updateUnitsSprites(motionPlanUnitIds);
      return;
    }
    if (motionPlanUnitIds.length === 0) {
      this.updateUnitsSprites(updatedUnitIds);
      return;
    }

    const unitIds = new Set<number>(updatedUnitIds);
    for (const id of motionPlanUnitIds) {
      unitIds.add(id);
    }
    this.updateUnitsSprites(Array.from(unitIds));
  }

  init() {
    this.eventBus.on(AlternateViewEvent, (e) => this.onAlternativeViewEvent(e));
    this.eventBus.on(MouseUpEvent, (e) => this.onMouseUp(e));
    this.eventBus.on(TouchEvent, (e) => this.onTouch(e));
    this.eventBus.on(UnitSelectionEvent, (e) => this.onUnitSelectionChange(e));
    this.eventBus.on(WarshipSelectionBoxCompleteEvent, (e) =>
      this.onSelectionBoxComplete(e),
    );
    this.eventBus.on(WarshipSelectionBoxCancelEvent, () =>
      this.onSelectionBoxCancel(),
    );
    this.eventBus.on(CloseViewEvent, () => this.onSelectionBoxCancel());
    this.eventBus.on(SelectAllWarshipsEvent, () => this.onSelectAllWarships());
    if (this.replayPresentationEnabled) {
      this.eventBus.on(ReplaySpeedChangeEvent, (event) =>
        this.onReplaySpeedChange(event),
      );
      this.eventBus.on(ReplayPresentationCadenceEvent, (event) =>
        this.onReplayPresentationCadence(event),
      );
    }
    this.redraw();

    loadAllSprites();
  }

  /**
   * Find player-owned warships near the given cell within a configurable radius
   * @param clickRef The tile to check
   * @returns Array of player's warships in range, sorted by distance (closest first)
   */
  private findWarshipsNearCell(clickRef: TileRef): UnitView[] {
    // Only select warships owned by the player
    return this.game
      .units(UnitType.Warship)
      .filter(
        (unit) =>
          unit.isActive() &&
          unit.owner() === this.game.myPlayer() && // Only allow selecting own warships
          this.game.manhattanDist(unit.tile(), clickRef) <=
            this.WARSHIP_SELECTION_RADIUS,
      )
      .sort((a, b) => {
        // Sort by distance (closest first)
        const distA = this.game.manhattanDist(a.tile(), clickRef);
        const distB = this.game.manhattanDist(b.tile(), clickRef);
        return distA - distB;
      });
  }

  private onMouseUp(
    event: MouseUpEvent,
    clickRef?: TileRef,
    nearbyWarships?: UnitView[],
  ) {
    if (clickRef === undefined) {
      // Convert screen coordinates to world coordinates
      const cell = this.transformHandler.screenToWorldCoordinates(
        event.x,
        event.y,
      );
      if (!this.game.isValidCoord(cell.x, cell.y)) return;

      clickRef = this.game.ref(cell.x, cell.y);
    }
    if (!this.game.isWater(clickRef)) return;

    // If we have multi-selected warships, send them all to this tile
    if (this.selectedWarships.length > 0) {
      const myPlayer = this.game.myPlayer();
      const activeIds = this.selectedWarships
        .filter((u) => u.isActive() && u.owner() === myPlayer)
        .map((u) => u.id());

      if (activeIds.length > 0) {
        this.eventBus.emit(new MoveWarshipIntentEvent(activeIds, clickRef));
      }
      this.selectedWarships = [];
      this.eventBus.emit(new UnitSelectionEvent(null, false));
      return;
    }

    if (this.selectedUnit) {
      this.eventBus.emit(
        new MoveWarshipIntentEvent([this.selectedUnit.id()], clickRef),
      );
      // Deselect
      this.eventBus.emit(new UnitSelectionEvent(this.selectedUnit, false));
      return;
    }

    // Find warships near this tile, sorted by distance
    nearbyWarships ??= this.findWarshipsNearCell(clickRef);
    if (nearbyWarships.length > 0) {
      // Toggle selection of the closest warship
      this.eventBus.emit(new UnitSelectionEvent(nearbyWarships[0], true));
    }
  }

  private onTouch(event: TouchEvent) {
    const cell = this.transformHandler.screenToWorldCoordinates(
      event.x,
      event.y,
    );

    if (!this.game.isValidCoord(cell.x, cell.y)) {
      return;
    }

    const clickRef = this.game.ref(cell.x, cell.y);
    if (this.game.inSpawnPhase()) {
      // No Radial Menu during spawn phase, only spawn point selection
      if (!this.game.isWater(clickRef)) {
        this.eventBus.emit(new MouseUpEvent(event.x, event.y));
      }
      return;
    }

    if (!this.game.isWater(clickRef)) {
      // No warship to find because no Ocean tile, open Radial Menu
      this.eventBus.emit(new ContextMenuEvent(event.x, event.y));
      return;
    }

    if (this.selectedUnit) {
      // Reuse the mouse logic, send clickRef to avoid fetching it again
      this.onMouseUp(new MouseUpEvent(event.x, event.y), clickRef);
      return;
    }

    // Also delegate if we have multi-selected warships
    if (this.selectedWarships.length > 0) {
      this.onMouseUp(new MouseUpEvent(event.x, event.y), clickRef);
      return;
    }

    const nearbyWarships = this.findWarshipsNearCell(clickRef);

    if (nearbyWarships.length > 0) {
      this.onMouseUp(
        new MouseUpEvent(event.x, event.y),
        clickRef,
        nearbyWarships,
      );
    } else {
      // No warships selected or nearby, open Radial Menu
      this.eventBus.emit(new ContextMenuEvent(event.x, event.y));
    }
  }

  /**
   * Handle unit selection changes
   */
  private onUnitSelectionChange(event: UnitSelectionEvent) {
    if (event.isSelected) {
      this.selectedUnit = event.unit;
    } else if (this.selectedUnit === event.unit) {
      this.selectedUnit = null;
    }
  }

  /**
   * Handle completion of shift+drag selection box.
   * Finds all player-owned warships within the screen rectangle.
   */
  private onSelectionBoxComplete(event: WarshipSelectionBoxCompleteEvent) {
    const x1 = Math.min(event.startX, event.endX);
    const y1 = Math.min(event.startY, event.endY);
    const x2 = Math.max(event.startX, event.endX);
    const y2 = Math.max(event.startY, event.endY);

    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;

    this.selectedWarships = this.game.units(UnitType.Warship).filter((unit) => {
      if (!unit.isActive() || unit.owner() !== myPlayer) return false;
      const screen = this.transformHandler.worldToScreenCoordinates(
        new Cell(this.game.x(unit.tile()), this.game.y(unit.tile())),
      );
      return (
        screen.x >= x1 && screen.x <= x2 && screen.y >= y1 && screen.y <= y2
      );
    });

    // Clear single selection if we got a box selection
    if (this.selectedWarships.length > 0 && this.selectedUnit) {
      this.eventBus.emit(new UnitSelectionEvent(this.selectedUnit, false));
    }

    // Notify UILayer to draw selection boxes for all selected warships
    this.eventBus.emit(
      new UnitSelectionEvent(null, true, this.selectedWarships),
    );
  }

  private onSelectionBoxCancel() {
    this.selectedWarships = [];
    this.eventBus.emit(new UnitSelectionEvent(null, false));
  }

  private onSelectAllWarships() {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;

    const allWarships = this.game
      .units(UnitType.Warship)
      .filter((u) => u.isActive() && u.owner() === myPlayer);

    if (allWarships.length === 0) return;

    // Clear single selection if active
    if (this.selectedUnit) {
      this.eventBus.emit(new UnitSelectionEvent(this.selectedUnit, false));
    }

    this.selectedWarships = allWarships;
    this.eventBus.emit(
      new UnitSelectionEvent(null, true, this.selectedWarships),
    );
  }

  /**
   * Handle unit deactivation or destruction
   * If the selected unit is removed from the game, deselect it
   */
  private handleUnitDeactivation(unit: UnitView) {
    if (this.selectedUnit === unit && !unit.isActive()) {
      this.eventBus.emit(new UnitSelectionEvent(unit, false));
    }
  }

  renderLayer(context: CanvasRenderingContext2D) {
    context.drawImage(
      this.transportShipTrailCanvas,
      -this.game.width() / 2,
      -this.game.height() / 2,
      this.game.width(),
      this.game.height(),
    );
    context.drawImage(
      this.canvas,
      -this.game.width() / 2,
      -this.game.height() / 2,
      this.game.width(),
      this.game.height(),
    );
    this.renderReplayUnits(context);
  }

  private onReplaySpeedChange(event: ReplaySpeedChangeEvent) {
    if (this.progressivePresentationIntervalMs !== null) {
      return;
    }
    this.retimeReplayUnitPresentation(
      replayPresentationTransitionDurationMs(event.replaySpeedMultiplier),
    );
  }

  private onReplayPresentationCadence(event: ReplayPresentationCadenceEvent) {
    if (
      !Number.isFinite(event.presentationIntervalMs) ||
      event.presentationIntervalMs <= 0
    ) {
      return;
    }
    this.progressivePresentationIntervalMs = event.presentationIntervalMs;
    this.retimeReplayUnitPresentation(
      replayPresentationTransitionDurationForIntervalMs(
        event.presentationIntervalMs,
      ),
    );
  }

  private retimeReplayUnitPresentation(durationMs: number) {
    const nowMs = performance.now();
    this.replayUnitTransitionMs = durationMs;
    for (const [unitId, motion] of this.replayUnitMotions) {
      this.replayUnitMotions.set(
        unitId,
        retimeReplayUnitPresentationMotion(
          motion,
          nowMs,
          this.replayUnitTransitionMs,
        ),
      );
    }
  }

  private renderReplayUnits(context: CanvasRenderingContext2D) {
    if (!this.replayPresentationEnabled) {
      return;
    }

    const nowMs = performance.now();
    const transitionMs = this.game.isCatchingUp()
      ? 0
      : this.replayUnitTransitionMs;

    for (const [unitId, unit] of this.replaySpriteUnits) {
      if (!unit.isActive()) {
        this.replaySpriteUnits.delete(unitId);
        this.replayUnitMotions.delete(unitId);
        continue;
      }
      if (!isSpriteReady(unit)) {
        continue;
      }

      const previousTile = unit.lastTile();
      const targetTile = unit.tile();
      const authoritativePrevious = {
        x: this.game.x(previousTile),
        y: this.game.y(previousTile),
      };
      const authoritativeTarget = {
        x: this.game.x(targetTile),
        y: this.game.y(targetTile),
      };
      const existingMotion = this.replayUnitMotions.get(unitId);
      const targetChanged =
        existingMotion === undefined ||
        existingMotion.target.x !== authoritativeTarget.x ||
        existingMotion.target.y !== authoritativeTarget.y;
      let motion: ReplayUnitPresentationMotion;
      if (targetChanged) {
        motion = retargetReplayUnitPresentationMotion(
          existingMotion ?? null,
          authoritativePrevious,
          authoritativeTarget,
          nowMs,
          transitionMs,
        );
      } else if (existingMotion.durationMs !== transitionMs) {
        motion = retimeReplayUnitPresentationMotion(
          existingMotion,
          nowMs,
          transitionMs,
        );
      } else {
        motion = existingMotion;
      }
      this.replayUnitMotions.set(unitId, motion);

      const position = sampleReplayUnitPresentationMotion(motion, nowMs);
      const renderX = position.x - this.game.width() / 2;
      const renderY = position.y - this.game.height() / 2;
      const customTerritoryColor =
        unit.type() === UnitType.Warship && unit.isInCombat()
          ? colord("rgb(200,0,0)")
          : undefined;
      this.drawSpriteAt(
        context,
        unit,
        renderX,
        renderY,
        customTerritoryColor,
        false,
      );
      if (
        unit.type() === UnitType.Warship &&
        unit.warshipState().state !== "patrolling"
      ) {
        this.drawRetreatCrossAt(context, renderX, renderY);
      }
    }
  }

  onAlternativeViewEvent(event: AlternateViewEvent) {
    this.alternateView = event.alternateView;
    this.redraw();
  }

  redraw() {
    this.canvas = document.createElement("canvas");
    const context = this.canvas.getContext("2d");
    if (context === null) throw new Error("2d context not supported");
    this.context = context;
    this.transportShipTrailCanvas = document.createElement("canvas");
    const trailContext = this.transportShipTrailCanvas.getContext("2d");
    if (trailContext === null) throw new Error("2d context not supported");
    this.unitTrailContext = trailContext;

    this.canvas.width = this.game.width();
    this.canvas.height = this.game.height();
    this.transportShipTrailCanvas.width = this.game.width();
    this.transportShipTrailCanvas.height = this.game.height();

    if (this.replayPresentationEnabled) {
      this.replaySpriteUnits.clear();
      this.replayUnitMotions.clear();
    }
    this.updateUnitsSprites(this.game.units().map((unit) => unit.id()));
    if (this.replayPresentationEnabled) {
      this.seedReplayUnitsAtAuthoritativeTargets();
    }

    this.unitToTrail.forEach((trail, unit) => {
      for (const t of trail) {
        this.paintCell(
          this.game.x(t),
          this.game.y(t),
          this.relationship(unit),
          unit.owner().territoryColor(),
          150,
          this.unitTrailContext,
        );
      }
    });
  }

  private updateUnitsSprites(unitIds: number[]) {
    const unitsToUpdate = unitIds
      ?.map((id) => this.game.unit(id))
      .filter((unit) => unit !== undefined);

    if (unitsToUpdate) {
      // the clearing and drawing of unit sprites need to be done in 2 passes
      // otherwise the sprite of a unit can be drawn on top of another unit
      this.clearUnitsCells(unitsToUpdate);
      this.drawUnitsCells(unitsToUpdate);
      this.flushTrailClears();
    }
  }

  private clearUnitsCells(unitViews: UnitView[]) {
    unitViews
      .filter((unitView) => isSpriteReady(unitView))
      .forEach((unitView) => {
        const sprite = getColoredSprite(unitView, this.theme);
        const clearsize = sprite.width + 1;
        const lastX = this.game.x(unitView.lastTile());
        const lastY = this.game.y(unitView.lastTile());
        this.context.clearRect(
          lastX - clearsize / 2,
          lastY - clearsize / 2,
          clearsize,
          clearsize,
        );
      });
  }

  private drawUnitsCells(unitViews: UnitView[]) {
    unitViews.forEach((unitView) => this.onUnitEvent(unitView));
  }

  private relationship(unit: UnitView): Relationship {
    const myPlayer = this.game.myPlayer();
    if (myPlayer === null) {
      return Relationship.Enemy;
    }
    if (myPlayer === unit.owner()) {
      return Relationship.Self;
    }
    if (myPlayer.isFriendly(unit.owner())) {
      return Relationship.Ally;
    }
    return Relationship.Enemy;
  }

  onUnitEvent(unit: UnitView) {
    // Check if unit was deactivated
    if (!unit.isActive()) {
      this.handleUnitDeactivation(unit);
    }

    switch (unit.type()) {
      case UnitType.TransportShip:
        this.handleBoatEvent(unit);
        break;
      case UnitType.Warship:
        this.handleWarShipEvent(unit);
        break;
      case UnitType.Shell:
        this.handleShellEvent(unit);
        break;
      case UnitType.SAMMissile:
        this.handleMissileEvent(unit);
        break;
      case UnitType.TradeShip:
        this.handleTradeShipEvent(unit);
        break;
      case UnitType.Train:
        this.handleTrainEvent(unit);
        break;
      case UnitType.MIRVWarhead:
        this.handleMIRVWarhead(unit);
        break;
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
      case UnitType.MIRV:
        this.handleNuke(unit);
        break;
    }
  }

  private handleWarShipEvent(unit: UnitView) {
    if (unit.warshipState().state !== "patrolling" && unit.isActive()) {
      if (unit.warshipState().isInCombat) {
        this.drawSprite(unit, colord("rgb(200,0,0)"));
      } else {
        this.drawSprite(unit);
      }
      this.drawRetreatCross(unit);
      return;
    }

    if (unit.warshipState().isInCombat) {
      this.drawSprite(unit, colord("rgb(200,0,0)"));
      return;
    }

    this.drawSprite(unit);
  }

  private drawRetreatCross(unit: UnitView) {
    if (this.replayPresentationEnabled) {
      return;
    }
    this.drawRetreatCrossAt(
      this.context,
      this.game.x(unit.tile()),
      this.game.y(unit.tile()),
    );
  }

  private drawRetreatCrossAt(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
  ) {
    // Blink: 500ms on, 500ms off
    if (Math.floor(Date.now() / 500) % 2 === 0) return;
    context.save();
    const cx = x + 0.5;
    const cy = y + 0.5;
    context.lineCap = "square";
    context.strokeStyle = "rgb(36,36,36)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(cx, cy - 1.5);
    context.lineTo(cx, cy + 1.5);
    context.moveTo(cx - 1.5, cy);
    context.lineTo(cx + 1.5, cy);
    context.stroke();
    context.restore();
  }

  private handleShellEvent(unit: UnitView) {
    const rel = this.relationship(unit);

    // Clear current and previous positions
    this.clearCell(this.game.x(unit.lastTile()), this.game.y(unit.lastTile()));
    const oldTile = this.oldShellTile.get(unit);
    if (oldTile !== undefined) {
      this.clearCell(this.game.x(oldTile), this.game.y(oldTile));
    }

    this.oldShellTile.set(unit, unit.lastTile());
    if (!unit.isActive()) {
      return;
    }

    // Paint current and previous positions
    this.paintCell(
      this.game.x(unit.tile()),
      this.game.y(unit.tile()),
      rel,
      unit.owner().borderColor(),
      255,
    );
    this.paintCell(
      this.game.x(unit.lastTile()),
      this.game.y(unit.lastTile()),
      rel,
      unit.owner().borderColor(),
      255,
    );
  }

  // interception missile from SAM
  private handleMissileEvent(unit: UnitView) {
    this.drawSprite(unit);
  }

  private drawTrail(trail: number[], color: Colord, rel: Relationship) {
    // Paint new trail
    for (const t of trail) {
      this.paintCell(
        this.game.x(t),
        this.game.y(t),
        rel,
        color,
        150,
        this.unitTrailContext,
      );
    }
  }

  private flushTrailClears() {
    if (this.pendingTrailClears.length === 0) return;

    const clearedTiles = new Set<TileRef>();
    for (const unit of this.pendingTrailClears) {
      const trail = this.unitToTrail.get(unit);
      if (trail) {
        for (const t of trail) {
          if (!clearedTiles.has(t)) {
            this.clearCell(
              this.game.x(t),
              this.game.y(t),
              this.unitTrailContext,
            );
            clearedTiles.add(t);
          }
        }
        this.unitToTrail.delete(unit);
      }
    }
    this.pendingTrailClears = [];

    // Single repaint pass for all remaining units
    for (const [other, trail] of this.unitToTrail) {
      const rel = this.relationship(other);
      for (const t of trail) {
        if (clearedTiles.has(t)) {
          this.paintCell(
            this.game.x(t),
            this.game.y(t),
            rel,
            other.owner().territoryColor(),
            150,
            this.unitTrailContext,
          );
        }
      }
    }
  }

  private handleNuke(unit: UnitView) {
    const rel = this.relationship(unit);

    if (!this.unitToTrail.has(unit)) {
      this.unitToTrail.set(unit, []);
    }

    let newTrailSize = 1;
    const trail = this.unitToTrail.get(unit) ?? [];
    // It can move faster than 1 pixel, draw a line for the trail or else it will be dotted
    if (trail.length >= 1) {
      const cur = {
        x: this.game.x(unit.lastTile()),
        y: this.game.y(unit.lastTile()),
      };
      const prev = {
        x: this.game.x(trail[trail.length - 1]),
        y: this.game.y(trail[trail.length - 1]),
      };
      const line = new BezenhamLine(prev, cur);
      let point = line.increment();
      while (point !== true) {
        trail.push(this.game.ref(point.x, point.y));
        point = line.increment();
      }
      newTrailSize = line.size();
    } else {
      trail.push(unit.lastTile());
    }

    this.drawTrail(
      trail.slice(-newTrailSize),
      unit.owner().territoryColor(),
      rel,
    );
    this.drawSprite(unit);
    if (!unit.isActive()) {
      this.pendingTrailClears.push(unit);
    }
  }

  private handleMIRVWarhead(unit: UnitView) {
    const rel = this.relationship(unit);

    this.clearCell(this.game.x(unit.lastTile()), this.game.y(unit.lastTile()));

    if (unit.isActive()) {
      // Paint area
      this.paintCell(
        this.game.x(unit.tile()),
        this.game.y(unit.tile()),
        rel,
        unit.owner().borderColor(),
        255,
      );
    }
  }

  private handleTradeShipEvent(unit: UnitView) {
    this.drawSprite(unit);
  }

  private handleTrainEvent(unit: UnitView) {
    this.drawSprite(unit);
  }

  private handleBoatEvent(unit: UnitView) {
    const rel = this.relationship(unit);

    if (!this.unitToTrail.has(unit)) {
      this.unitToTrail.set(unit, []);
    }
    const trail = this.unitToTrail.get(unit) ?? [];
    trail.push(unit.lastTile());

    // Paint trail
    this.drawTrail(trail.slice(-1), unit.owner().territoryColor(), rel);
    this.drawSprite(unit);

    if (!unit.isActive()) {
      this.pendingTrailClears.push(unit);
    }
  }

  paintCell(
    x: number,
    y: number,
    relationship: Relationship,
    color: Colord,
    alpha: number,
    context: CanvasRenderingContext2D = this.context,
  ) {
    this.clearCell(x, y, context);
    if (this.alternateView) {
      switch (relationship) {
        case Relationship.Self:
          context.fillStyle = this.theme.selfColor().toRgbString();
          break;
        case Relationship.Ally:
          context.fillStyle = this.theme.allyColor().toRgbString();
          break;
        case Relationship.Enemy:
          context.fillStyle = this.theme.enemyColor().toRgbString();
          break;
      }
    } else {
      context.fillStyle = color.alpha(alpha / 255).toRgbString();
    }
    context.fillRect(x, y, 1, 1);
  }

  clearCell(
    x: number,
    y: number,
    context: CanvasRenderingContext2D = this.context,
  ) {
    context.clearRect(x, y, 1, 1);
  }

  drawSprite(unit: UnitView, customTerritoryColor?: Colord) {
    if (this.replayPresentationEnabled) {
      if (unit.isActive()) {
        this.replaySpriteUnits.set(unit.id(), unit);
      } else {
        this.replaySpriteUnits.delete(unit.id());
        this.replayUnitMotions.delete(unit.id());
      }
      return;
    }

    const x = this.game.x(unit.tile());
    const y = this.game.y(unit.tile());

    this.drawSpriteAt(this.context, unit, x, y, customTerritoryColor, true);
  }

  private seedReplayUnitsAtAuthoritativeTargets() {
    const nowMs = performance.now();
    for (const [unitId, unit] of this.replaySpriteUnits) {
      const target = {
        x: this.game.x(unit.tile()),
        y: this.game.y(unit.tile()),
      };
      this.replayUnitMotions.set(unitId, {
        source: target,
        target,
        startedAtMs: nowMs,
        durationMs: 0,
      });
    }
  }

  private drawSpriteAt(
    context: CanvasRenderingContext2D,
    unit: UnitView,
    x: number,
    y: number,
    customTerritoryColor: Colord | undefined,
    snapToPixel: boolean,
  ) {
    if (!unit.isActive()) {
      return;
    }

    let alternateViewColor: Colord | null = null;

    if (this.alternateView) {
      let rel = this.relationship(unit);
      const dstPortId = unit.targetUnitId();
      if (unit.type() === UnitType.TradeShip && dstPortId !== undefined) {
        const target = this.game.unit(dstPortId)?.owner();
        const myPlayer = this.game.myPlayer();
        if (myPlayer !== null && target !== undefined) {
          if (myPlayer === target) {
            rel = Relationship.Self;
          } else if (myPlayer.isFriendly(target)) {
            rel = Relationship.Ally;
          }
        }
      }
      switch (rel) {
        case Relationship.Self:
          alternateViewColor = this.theme.selfColor();
          break;
        case Relationship.Ally:
          alternateViewColor = this.theme.allyColor();
          break;
        case Relationship.Enemy:
          alternateViewColor = this.theme.enemyColor();
          break;
      }
    }

    const sprite = getColoredSprite(
      unit,
      this.theme,
      alternateViewColor ?? customTerritoryColor,
      alternateViewColor ?? undefined,
    );

    const targetable = unit.targetable();
    if (!targetable) {
      context.save();
      context.globalAlpha = 0.5;
    }
    const drawX = x - sprite.width / 2;
    const drawY = y - sprite.height / 2;
    context.drawImage(
      sprite,
      snapToPixel ? Math.round(drawX) : drawX,
      snapToPixel ? Math.round(drawY) : drawY,
      sprite.width,
      sprite.width,
    );
    if (!targetable) {
      context.restore();
    }
  }
}
