import { getSpawnTiles } from "../../core/execution/Util";
import { GameMap, TileRef } from "../../core/game/GameMap";
import { SpawnCandidate } from "./LegalActionBuilder";

export interface AttackScenarioSpawnPlan {
  spawnCandidates: SpawnCandidate[];
  attackerTile: TileRef;
  targetTile: TileRef;
  notes: string[];
}

export interface BuildAttackScenarioSpawnPlanOptions {
  agentCount?: number;
  maxCenters?: number;
  stride?: number;
}

interface SpawnCluster {
  candidate: SpawnCandidate;
  tiles: Set<TileRef>;
}

export function buildAttackScenarioSpawnPlan(
  gameMap: GameMap,
  options: BuildAttackScenarioSpawnPlanOptions = {},
): AttackScenarioSpawnPlan {
  const agentCount = options.agentCount ?? 4;
  const centers = collectSpawnCenters(gameMap, {
    maxCenters: options.maxCenters ?? 3_000,
    stride: options.stride ?? 1,
  });

  const pair = findBorderingPair(gameMap, centers);
  if (pair === null) {
    throw new Error(
      "Could not find deterministic bordering spawn pair for attack scenario",
    );
  }

  const extras = findExtraClusters(
    gameMap,
    centers,
    [pair.attacker, pair.target],
    Math.max(0, agentCount - 2),
  );

  if (extras.length < agentCount - 2) {
    throw new Error(
      `Could not find enough extra spawn candidates for ${agentCount} agents`,
    );
  }

  return {
    spawnCandidates: [
      pair.attacker.candidate,
      pair.target.candidate,
      ...extras.map((cluster) => cluster.candidate),
    ],
    attackerTile: pair.attacker.candidate.tile,
    targetTile: pair.target.candidate.tile,
    notes: [
      "first two spawn candidates produce adjacent owned territories after explicit spawn intents",
      "attack scenario should use low minSpawnDistance so both nearby candidates remain available",
    ],
  };
}

function collectSpawnCenters(
  gameMap: GameMap,
  options: { maxCenters: number; stride: number },
): SpawnCluster[] {
  const clusters: SpawnCluster[] = [];

  gameMap.forEachTile((tile) => {
    if (clusters.length >= options.maxCenters) {
      return;
    }
    if (tile % options.stride !== 0) {
      return;
    }
    if (!gameMap.isLand(tile) || gameMap.isBorder(tile)) {
      return;
    }

    const tiles = getSpawnTiles(gameMap, tile, false);
    if (tiles.length === 0) {
      return;
    }

    clusters.push({
      candidate: candidateFromTile(gameMap, tile),
      tiles: new Set(tiles),
    });
  });

  return clusters;
}

function findBorderingPair(
  gameMap: GameMap,
  centers: SpawnCluster[],
): { attacker: SpawnCluster; target: SpawnCluster } | null {
  for (const attacker of centers) {
    for (const target of centers) {
      if (attacker.candidate.tile === target.candidate.tile) {
        continue;
      }

      const distance = gameMap.manhattanDist(
        attacker.candidate.tile,
        target.candidate.tile,
      );
      if (distance < 5 || distance > 9) {
        continue;
      }

      const targetTilesAfterAttackerSpawn = withoutTiles(
        target.tiles,
        attacker.tiles,
      );
      if (targetTilesAfterAttackerSpawn.size === 0) {
        continue;
      }
      if (clustersTouch(gameMap, attacker.tiles, targetTilesAfterAttackerSpawn)) {
        return {
          attacker,
          target: {
            candidate: target.candidate,
            tiles: targetTilesAfterAttackerSpawn,
          },
        };
      }
    }
  }

  return null;
}

function findExtraClusters(
  gameMap: GameMap,
  centers: SpawnCluster[],
  reserved: SpawnCluster[],
  count: number,
): SpawnCluster[] {
  const extras: SpawnCluster[] = [];
  const reservedTiles = mergeTiles(reserved);
  const reservedCenters = new Set(
    reserved.map((cluster) => cluster.candidate.tile),
  );

  for (const candidate of centers) {
    if (extras.length >= count) {
      break;
    }
    if (reservedCenters.has(candidate.candidate.tile)) {
      continue;
    }
    if (gameMap.manhattanDist(candidate.candidate.tile, reserved[0].candidate.tile) < 12) {
      continue;
    }
    if (overlaps(candidate.tiles, reservedTiles)) {
      continue;
    }
    if (extras.some((extra) => overlaps(candidate.tiles, extra.tiles))) {
      continue;
    }

    extras.push(candidate);
  }

  return extras;
}

function clustersTouch(
  gameMap: GameMap,
  first: Set<TileRef>,
  second: Set<TileRef>,
): boolean {
  for (const tile of first) {
    if (gameMap.neighbors(tile).some((neighbor) => second.has(neighbor))) {
      return true;
    }
  }
  return false;
}

function withoutTiles(
  tiles: Set<TileRef>,
  excluded: Set<TileRef>,
): Set<TileRef> {
  const next = new Set<TileRef>();
  for (const tile of tiles) {
    if (!excluded.has(tile)) {
      next.add(tile);
    }
  }
  return next;
}

function mergeTiles(clusters: SpawnCluster[]): Set<TileRef> {
  const tiles = new Set<TileRef>();
  for (const cluster of clusters) {
    for (const tile of cluster.tiles) {
      tiles.add(tile);
    }
  }
  return tiles;
}

function overlaps(first: Set<TileRef>, second: Set<TileRef>): boolean {
  for (const tile of first) {
    if (second.has(tile)) {
      return true;
    }
  }
  return false;
}

function candidateFromTile(gameMap: GameMap, tile: TileRef): SpawnCandidate {
  const centerX = (gameMap.width() - 1) / 2;
  const centerY = (gameMap.height() - 1) / 2;
  const x = gameMap.x(tile);
  const y = gameMap.y(tile);
  const maxCenterDistance = Math.max(
    1,
    Math.hypot(centerX, centerY),
    Math.hypot(gameMap.width() - 1 - centerX, gameMap.height() - 1 - centerY),
  );
  const centerDistance = Math.hypot(x - centerX, y - centerY);
  const edgeDistance = Math.min(
    x,
    y,
    gameMap.width() - 1 - x,
    gameMap.height() - 1 - y,
  );
  const maxEdgeDistance = Math.max(
    1,
    Math.min(gameMap.width(), gameMap.height()) / 2,
  );

  return {
    tile,
    x,
    y,
    pressureScore: 1 - centerDistance / maxCenterDistance,
    safetyScore: centerDistance / maxCenterDistance,
    diplomacyScore:
      1 -
      Math.abs(y - centerY) /
        Math.max(centerY, gameMap.height() - 1 - centerY, 1),
    opportunityScore: edgeDistance / maxEdgeDistance,
  };
}
