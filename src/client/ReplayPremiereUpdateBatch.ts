import { GameUpdates } from "../core/game/Game";
import {
  GamePausedUpdate,
  GameUpdate,
  GameUpdateType,
  GameUpdateViewData,
  PlayerUpdate,
  UnitUpdate,
  WinUpdate,
} from "../core/game/GameUpdates";
import {
  MotionPlanRecord,
  packMotionPlans,
  unpackMotionPlans,
} from "../core/game/MotionPlans";

export interface ReplayPremiereCoalescedUpdate {
  update: GameUpdateViewData;
  completedTurns: number;
  tickExecutionDurations: number[];
}

/**
 * Collapses sequential simulation updates into one renderer-safe update.
 *
 * Event updates remain ordered, while state snapshots (units, players, pause,
 * win, and tiles) collapse to their final value. Renderer layers commonly map
 * a Unit update back to the final UnitView, so retaining intermediate Unit
 * snapshots would replay the same final effect many times.
 */
export function coalesceReplayPremiereGameUpdates(
  source: readonly GameUpdateViewData[],
): ReplayPremiereCoalescedUpdate {
  if (source.length === 0) {
    throw new Error("Cannot coalesce an empty replay update batch");
  }
  const updateTypes = Object.values(GameUpdateType).filter(
    (value): value is GameUpdateType => typeof value === "number",
  );
  const updates = Object.fromEntries(
    updateTypes.map((type) => [type, []]),
  ) as unknown as GameUpdates;
  const tileStates = new Map<number, number>();
  const motionPlans: MotionPlanRecord[] = [];
  const playerNameViewData: GameUpdateViewData["playerNameViewData"] = {};
  const tickExecutionDurations: number[] = [];
  const finalUnitUpdates = new Map<number, UnitUpdate>();
  const finalPlayerUpdates = new Map<PlayerUpdate["id"], PlayerUpdate>();
  let finalPausedUpdate: GamePausedUpdate | undefined;
  let finalWinUpdate: WinUpdate | undefined;

  for (const gameUpdate of source) {
    for (const type of updateTypes) {
      if (
        type === GameUpdateType.Unit ||
        type === GameUpdateType.Player ||
        type === GameUpdateType.GamePaused ||
        type === GameUpdateType.Win
      ) {
        continue;
      }
      (updates[type] as GameUpdate[]).push(
        ...(gameUpdate.updates[type] as GameUpdate[]),
      );
    }
    for (const unitUpdate of gameUpdate.updates[GameUpdateType.Unit]) {
      finalUnitUpdates.delete(unitUpdate.id);
      finalUnitUpdates.set(unitUpdate.id, unitUpdate);
    }
    for (const playerUpdate of gameUpdate.updates[GameUpdateType.Player]) {
      finalPlayerUpdates.delete(playerUpdate.id);
      finalPlayerUpdates.set(playerUpdate.id, playerUpdate);
    }
    finalPausedUpdate =
      gameUpdate.updates[GameUpdateType.GamePaused].at(-1) ?? finalPausedUpdate;
    finalWinUpdate =
      gameUpdate.updates[GameUpdateType.Win].at(-1) ?? finalWinUpdate;
    for (
      let offset = 0;
      offset + 1 < gameUpdate.packedTileUpdates.length;
      offset += 2
    ) {
      tileStates.set(
        gameUpdate.packedTileUpdates[offset],
        gameUpdate.packedTileUpdates[offset + 1],
      );
    }
    if (gameUpdate.packedMotionPlans !== undefined) {
      motionPlans.push(...unpackMotionPlans(gameUpdate.packedMotionPlans));
    }
    Object.assign(playerNameViewData, gameUpdate.playerNameViewData);
    if (gameUpdate.tickExecutionDuration !== undefined) {
      tickExecutionDurations.push(gameUpdate.tickExecutionDuration);
    }
  }

  const packedTileUpdates = new Uint32Array(tileStates.size * 2);
  let tileOffset = 0;
  for (const [tile, state] of tileStates) {
    packedTileUpdates[tileOffset++] = tile;
    packedTileUpdates[tileOffset++] = state;
  }
  const last = source[source.length - 1];
  updates[GameUpdateType.Unit].push(...finalUnitUpdates.values());
  updates[GameUpdateType.Player].push(...finalPlayerUpdates.values());
  if (finalPausedUpdate !== undefined) {
    updates[GameUpdateType.GamePaused].push(finalPausedUpdate);
  }
  if (finalWinUpdate !== undefined) {
    updates[GameUpdateType.Win].push(finalWinUpdate);
  }
  const tickExecutionDuration =
    tickExecutionDurations.length === 0
      ? undefined
      : tickExecutionDurations.reduce((sum, duration) => sum + duration, 0) /
        tickExecutionDurations.length;
  return {
    completedTurns: source.length,
    tickExecutionDurations,
    update: {
      tick: last.tick,
      updates,
      packedTileUpdates,
      ...(motionPlans.length === 0
        ? {}
        : { packedMotionPlans: packMotionPlans(motionPlans) }),
      playerNameViewData,
      ...(tickExecutionDuration === undefined ? {} : { tickExecutionDuration }),
      ...(last.pendingTurns === undefined
        ? {}
        : { pendingTurns: last.pendingTurns }),
    },
  };
}
