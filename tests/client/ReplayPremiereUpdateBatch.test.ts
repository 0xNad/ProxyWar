import { describe, expect, it, vi } from "vitest";
import { FxLayer } from "../../src/client/graphics/layers/FxLayer";
import { coalesceReplayPremiereGameUpdates } from "../../src/client/ReplayPremiereUpdateBatch";
import { GameUpdates, UnitType } from "../../src/core/game/Game";
import { GameMapImpl } from "../../src/core/game/GameMap";
import {
  GameUpdateType,
  GameUpdateViewData,
  UnitUpdate,
} from "../../src/core/game/GameUpdates";
import { GameView } from "../../src/core/game/GameView";
import {
  packMotionPlans,
  unpackMotionPlans,
} from "../../src/core/game/MotionPlans";

function emptyUpdates(): GameUpdates {
  return Object.fromEntries(
    Object.values(GameUpdateType)
      .filter((value): value is GameUpdateType => typeof value === "number")
      .map((type) => [type, []]),
  ) as unknown as GameUpdates;
}

function update(tick: number, packedTileUpdates: number[]): GameUpdateViewData {
  return {
    tick,
    updates: emptyUpdates(),
    packedTileUpdates: Uint32Array.from(packedTileUpdates),
    playerNameViewData: {},
    tickExecutionDuration: tick,
    pendingTurns: 10 - tick,
  };
}

function unitUpdate(id: number, pos: number, isActive: boolean): UnitUpdate {
  return {
    type: GameUpdateType.Unit,
    unitType: UnitType.City,
    troops: 1,
    id,
    ownerID: 1,
    pos,
    lastPos: pos,
    isActive,
    reachedTarget: false,
    targetable: true,
    markedForDeletion: false,
    missileTimerQueue: [],
    level: 1,
    hasTrainStation: false,
  };
}

describe("coalesceReplayPremiereGameUpdates", () => {
  it("preserves ordered events while keeping stateful updates final", () => {
    const first = update(2, [3, 30, 4, 40]);
    const second = update(3, [3, 31, 5, 50]);
    const earlyUnit = { type: GameUpdateType.Unit, id: 7 } as never;
    const lateUnit = { type: GameUpdateType.Unit, id: 8 } as never;
    const earlyEvent = {
      type: GameUpdateType.DisplayEvent,
      message: "early",
    } as never;
    const earlyPlayer = {
      type: GameUpdateType.Player,
      id: "player-one",
      tilesOwned: 10,
    } as never;
    const latePlayer = {
      type: GameUpdateType.Player,
      id: "player-one",
      tilesOwned: 20,
    } as never;
    first.updates[GameUpdateType.Unit].push(earlyUnit);
    first.updates[GameUpdateType.Player].push(earlyPlayer);
    first.updates[GameUpdateType.DisplayEvent].push(earlyEvent);
    second.updates[GameUpdateType.Unit].push(lateUnit);
    second.updates[GameUpdateType.Player].push(latePlayer);
    first.playerNameViewData = { player: { x: 1, y: 2 } as never };
    second.playerNameViewData = { player: { x: 3, y: 4 } as never };
    first.packedMotionPlans = packMotionPlans([
      {
        kind: "grid",
        unitId: 7,
        planId: 1,
        startTick: 2,
        ticksPerStep: 1,
        path: [3, 4, 5],
      },
    ]);

    const coalesced = coalesceReplayPremiereGameUpdates([first, second]);

    expect(coalesced.completedTurns).toBe(2);
    expect(coalesced.tickExecutionDurations).toEqual([2, 3]);
    expect(coalesced.update).toMatchObject({
      tick: 3,
      tickExecutionDuration: 2.5,
      pendingTurns: 7,
      playerNameViewData: { player: { x: 3, y: 4 } },
    });
    expect(Array.from(coalesced.update.packedTileUpdates)).toEqual([
      3, 31, 4, 40, 5, 50,
    ]);
    expect(coalesced.update.updates[GameUpdateType.Unit]).toEqual([
      earlyUnit,
      lateUnit,
    ]);
    expect(coalesced.update.updates[GameUpdateType.DisplayEvent]).toEqual([
      earlyEvent,
    ]);
    expect(coalesced.update.updates[GameUpdateType.Player]).toEqual([
      latePlayer,
    ]);
    expect(unpackMotionPlans(coalesced.update.packedMotionPlans!)).toEqual([
      expect.objectContaining({
        kind: "grid",
        unitId: 7,
        planId: 1,
        path: Uint32Array.from([3, 4, 5]),
      }),
    ]);
  });

  it("rejects an empty batch", () => {
    expect(() => coalesceReplayPremiereGameUpdates([])).toThrow(
      "Cannot coalesce an empty replay update batch",
    );
  });

  it("collapses stateful updates before a real GameView renderer consumer sees them", () => {
    const gameMap = new GameMapImpl(4, 4, new Uint8Array(16), 0);
    const gameView = new GameView(
      {} as never,
      { theme: () => ({}) } as never,
      { gameMap, miniGameMap: gameMap, nations: [] },
      undefined,
      "spectator",
      null,
      "PREM0001" as never,
      [],
    );
    const initial = update(1, []);
    initial.updates[GameUpdateType.Unit].push(unitUpdate(7, 1, true));
    gameView.update(initial);

    const first = update(2, []);
    first.updates[GameUpdateType.Unit].push(unitUpdate(7, 2, true));
    first.updates[GameUpdateType.GamePaused].push({
      type: GameUpdateType.GamePaused,
      paused: true,
    });
    const second = update(3, []);
    second.updates[GameUpdateType.Unit].push(unitUpdate(7, 3, false));
    second.updates[GameUpdateType.GamePaused].push({
      type: GameUpdateType.GamePaused,
      paused: false,
    });

    const coalesced = coalesceReplayPremiereGameUpdates([first, second]);
    expect(coalesced.update.updates[GameUpdateType.Unit]).toEqual([
      expect.objectContaining({ id: 7, pos: 3, isActive: false }),
    ]);
    expect(coalesced.update.updates[GameUpdateType.GamePaused]).toEqual([
      { type: GameUpdateType.GamePaused, paused: false },
    ]);

    gameView.update(coalesced.update);
    const fxLayer = new FxLayer(gameView, {} as never, {} as never);
    const onUnitEvent = vi
      .spyOn(fxLayer, "onUnitEvent")
      .mockImplementation(() => undefined);
    fxLayer.tick();

    expect(onUnitEvent).toHaveBeenCalledOnce();
    expect(onUnitEvent.mock.calls[0][0].id()).toBe(7);
    expect(onUnitEvent.mock.calls[0][0].isActive()).toBe(false);
  });
});
