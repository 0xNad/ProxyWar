import { AllUnitParams, UnitType } from "./Game";
import type { GameImpl } from "./GameImpl";
import { TileRef } from "./GameMap";

const INVALID_WARSHIP_PATROL_TILE =
  "Warship constructed with invalid patrolTile: expected an own, safe-integer, in-map TileRef";

export function validateAndSnapshotUnitParams(
  type: UnitType,
  game: GameImpl,
  params: AllUnitParams,
): AllUnitParams {
  if (type !== UnitType.Warship) {
    return params;
  }

  const hasOwnPatrolTile = Object.prototype.hasOwnProperty.call(
    params,
    "patrolTile",
  );
  const patrolTile: unknown = hasOwnPatrolTile
    ? (params as { patrolTile?: unknown }).patrolTile
    : undefined;
  if (
    !hasOwnPatrolTile ||
    typeof patrolTile !== "number" ||
    !Number.isSafeInteger(patrolTile) ||
    !game.isValidRef(patrolTile)
  ) {
    throw new Error(INVALID_WARSHIP_PATROL_TILE);
  }

  // Return a plain snapshot so an accessor cannot change the validated value
  // between deterministic preflight and construction.
  return { patrolTile: patrolTile as TileRef };
}
