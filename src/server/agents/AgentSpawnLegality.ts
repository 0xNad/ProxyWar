import { isValidSpawnSite } from "../../core/execution/Util";
import { Game } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";
import { SpawnCandidate } from "./LegalActionBuilder";

/**
 * Everything `evaluateSpawnTileLegality` needs to independently re-derive the
 * legality of an agent-requested tile, purely from state the game/league
 * already tracks. No new legality convention: every check below composes
 * existing, authoritative predicates.
 */
export interface SpawnLegalityContext {
  gameState: Game;
  /** AgentLeagueMatch's own candidate-spacing rule (mirrors minSpawnDistance
   * already enforced against the curated SpawnCandidate pool). */
  minSpawnDistance: number;
  /** Every OTHER agent's current in-progress spawn stake this spawn phase. */
  rivalStakes: readonly SpawnCandidate[];
}

export type SpawnLegalityResult =
  | { legal: true; candidate: SpawnCandidate }
  | { legal: false; reason: string };

/**
 * Authoritative agent-facing spawn-tile legality check for a single
 * arbitrary `TileRef`, composed ENTIRELY from predicates core and the league
 * already enforce elsewhere - never a second/duplicated legality convention:
 *
 *  - isValidRef / isLand / !hasOwner / !isBorder
 *    (src/core/game/GameMap.ts, inherited onto `Game`)
 *  - isValidSpawnSite (src/core/execution/Util.ts) - the exact function
 *    `buildSpawnCandidates()` itself calls to decide curated-pool membership
 *    (src/server/agents/LegalActionBuilder.ts), so an off-menu tile is held
 *    to the identical bar as every offered candidate.
 *  - manhattanDist >= Config.minDistanceBetweenPlayers() vs every already-
 *    spawned player - the exact rule SpawnExecution's own random-placement
 *    branch enforces (src/core/execution/SpawnExecution.ts). Deliberately the
 *    STRICT bar (not the laxer explicit-tile branch, which core allows for
 *    human map-clicks) so a free-choice agent cannot buy a fairness
 *    advantage over the algorithmic/candidate-menu path.
 *  - distance >= the league's own minSpawnDistance vs every OTHER agent's
 *    in-progress spawn stake this tick - the exact rule
 *    `spawnCandidatesAvailableTo`/`removeNearbySpawnCandidates` already
 *    apply to the curated pool (src/server/agents/AgentLeagueMatch.ts).
 *
 * Pure function of (map data, current game state, config, in-progress
 * stakes): no randomness, no wall-clock, no network - safe to call from the
 * validator on every decision.
 */
export function evaluateSpawnTileLegality(
  tile: TileRef,
  ctx: SpawnLegalityContext,
): SpawnLegalityResult {
  const { gameState } = ctx;

  if (!gameState.isValidRef(tile)) {
    return { legal: false, reason: "tile is out of bounds" };
  }
  if (!gameState.isLand(tile)) {
    return { legal: false, reason: "tile is water" };
  }
  if (gameState.hasOwner(tile)) {
    return { legal: false, reason: "tile is occupied" };
  }
  if (gameState.isBorder(tile)) {
    return { legal: false, reason: "tile borders a claimed territory" };
  }

  // Precedence matches SpawnExecution's own random-placement branch exactly
  // (src/core/execution/SpawnExecution.ts): isLand/hasOwner/isBorder, THEN
  // minDistanceBetweenPlayers, THEN the full footprint check - so a tile
  // that fails both surfaces the same reason core's own algorithm would
  // reach first.
  const minDistanceBetweenPlayers = gameState
    .config()
    .minDistanceBetweenPlayers();
  for (const player of gameState.allPlayers()) {
    const spawnTile = player.spawnTile();
    if (spawnTile === undefined) {
      continue;
    }
    if (gameState.manhattanDist(tile, spawnTile) < minDistanceBetweenPlayers) {
      return {
        legal: false,
        reason: `tile is within minDistanceBetweenPlayers (${minDistanceBetweenPlayers}) of an already-spawned player (${player.id()})`,
      };
    }
  }

  if (!isValidSpawnSite(gameState, tile)) {
    return {
      legal: false,
      reason: "tile's surrounding spawn footprint is not fully valid land",
    };
  }

  const x = gameState.x(tile);
  const y = gameState.y(tile);
  for (const stake of ctx.rivalStakes) {
    // The exact-tile case is checked unconditionally, independent of
    // whether coordinates are present: two agents requesting the identical
    // tile is a conflict by definition (distance 0), and must never be
    // silently missed just because a stake happens to lack x/y.
    if (stake.tile === tile) {
      return {
        legal: false,
        reason: `tile conflicts with another agent's reserved spawn (tile ${stake.tile})`,
      };
    }
    if (typeof stake.x !== "number" || typeof stake.y !== "number") {
      // No coordinates to compute a meaningful non-zero distance from; the
      // exact-tile case above already covers the one conflict that matters
      // without them.
      continue;
    }
    const distance = Math.hypot(x - stake.x, y - stake.y);
    if (distance < ctx.minSpawnDistance) {
      return {
        legal: false,
        reason: `tile conflicts with another agent's reserved spawn (tile ${stake.tile})`,
      };
    }
  }

  return {
    legal: true,
    candidate: {
      tile,
      x,
      y,
      // No ranking scores: this candidate was already CHOSEN by the agent,
      // not being ranked against alternatives, so profile-preference scoring
      // (which only matters for picking among several offered candidates)
      // does not apply. Left at neutral 0 rather than invented values.
      pressureScore: 0,
      safetyScore: 0,
      diplomacyScore: 0,
      opportunityScore: 0,
      localLandScore: 0,
    },
  };
}

const SPAWN_ACTION_ID_PATTERN = /^spawn:(\d+)$/;

/** Parses a well-formed `spawn:<tile>` action id. Returns null for any other shape. */
export function parseSpawnTileFromActionID(actionID: string): TileRef | null {
  const match = SPAWN_ACTION_ID_PATTERN.exec(actionID);
  if (match === null) {
    return null;
  }
  const tile = Number(match[1]);
  return Number.isSafeInteger(tile) ? tile : null;
}
