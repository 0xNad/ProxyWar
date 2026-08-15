import { Game, Player, UnitType } from "../../core/game/Game";
import {
  spatialMinimapEnabled,
  spatialObservationEnabled,
} from "./AgentTunables";
import {
  AgentOwnShape,
  AgentSpatialBearing,
  AgentSpatialMinimap,
  AgentSpatialObservation,
  AgentSpatialQuadrant,
  AgentVisiblePlayer,
} from "./AgentTypes";

export const SPATIAL_REGION_TILE_BUDGET = 100_000;
export const SPATIAL_REGION_RUN_BUDGET = 25_000;
export const SPATIAL_MINIMAP_WIDTH = 24 as const;
export const SPATIAL_MINIMAP_HEIGHT = 12 as const;
export const SPATIAL_NOTE_PREFIX = "Spatial ";

const MINIMAP_GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#";

interface SpatialCentroid {
  x: number;
  y: number;
}

interface SpatialPlayerGeometry {
  player: Player;
  borderTiles: readonly number[];
  coastalBorderTiles: ReadonlySet<number>;
  sharedBorderTiles: ReadonlyMap<string, ReadonlySet<number>>;
  playerContactTileCount: number;
  centroid: SpatialCentroid;
  ownShape: AgentOwnShape;
}

interface SpatialMinimapBase {
  rows: string[];
  legend: Array<{
    glyph: string;
    playerID: string;
    name: string;
  }>;
}

interface CompleteRegionAnalysis {
  regionCount: number;
  largestRegionSize: number;
  centroid: SpatialCentroid;
}

export interface AgentSpatialSnapshotMetrics {
  borderTilesVisited: number;
  regionTilesVisited: number;
  regionMapTilesScanned: number;
  regionRunsCreated: number;
  regionRunBudgetExceeded: boolean;
  minimapTilesVisited: number;
}

export interface AgentSpatialSnapshot {
  gameState: Game;
  players: readonly Player[];
  geometryByPlayerID: ReadonlyMap<string, SpatialPlayerGeometry>;
  minimap?: SpatialMinimapBase;
  metrics: AgentSpatialSnapshotMetrics;
}

export interface BuildSpatialObservationInput {
  gameState: Game;
  player: Player;
  visiblePlayers: AgentVisiblePlayer[];
  snapshot?: AgentSpatialSnapshot;
}

export interface SpatialObservationExtension {
  spatial: AgentSpatialObservation;
  notes: string[];
}

/**
 * Build one immutable read-side geometry snapshot. Callers may share it only
 * inside AgentObservationBuilder.withObservationBatch's synchronous boundary.
 */
export function createAgentSpatialSnapshot(
  gameState: Game,
  includeMinimap: boolean = spatialMinimapEnabled(),
): AgentSpatialSnapshot {
  const players = [...gameState.players()].sort(
    (a, b) => a.smallID() - b.smallID() || a.id().localeCompare(b.id()),
  );
  const metrics: AgentSpatialSnapshotMetrics = {
    borderTilesVisited: 0,
    regionTilesVisited: 0,
    regionMapTilesScanned: 0,
    regionRunsCreated: 0,
    regionRunBudgetExceeded: false,
    minimapTilesVisited: 0,
  };
  const geometryByPlayerID = new Map<string, SpatialPlayerGeometry>();
  const regionAnalysisByPlayerID = analyzeRegions(gameState, players, metrics);

  for (const player of players) {
    if (player.numTilesOwned() === 0) continue;
    const borderTiles = [...player.borderTiles()];
    const coastalBorderTiles = new Set<number>();
    const sharedBorderTiles = new Map<string, Set<number>>();
    const playerContactTiles = new Set<number>();

    for (const tile of borderTiles) {
      metrics.borderTilesVisited += 1;
      let touchesWater = false;
      gameState.forEachNeighbor(tile, (neighbor) => {
        if (gameState.isWater(neighbor)) {
          touchesWater = true;
          return;
        }
        if (!gameState.isLand(neighbor)) return;
        const owner = gameState.owner(neighbor);
        if (!owner.isPlayer() || owner.id() === player.id()) return;
        playerContactTiles.add(tile);
        let pairTiles = sharedBorderTiles.get(owner.id());
        if (pairTiles === undefined) {
          pairTiles = new Set<number>();
          sharedBorderTiles.set(owner.id(), pairTiles);
        }
        pairTiles.add(tile);
      });
      if (touchesWater) coastalBorderTiles.add(tile);
    }

    const shape = playerShape(
      gameState,
      player,
      borderTiles,
      coastalBorderTiles.size,
      regionAnalysisByPlayerID.get(player.id()),
    );
    geometryByPlayerID.set(player.id(), {
      player,
      borderTiles,
      coastalBorderTiles,
      sharedBorderTiles,
      playerContactTileCount: playerContactTiles.size,
      centroid: shape.centroid,
      ownShape: shape.ownShape,
    });
  }

  return {
    gameState,
    players,
    geometryByPlayerID,
    ...(includeMinimap
      ? { minimap: buildMinimap(gameState, players, metrics) }
      : {}),
    metrics,
  };
}

/**
 * Flag-gated observation decoration. When disabled (the default), this returns
 * undefined before touching the visible-player entries.
 */
export function buildSpatialObservationExtension(
  input: BuildSpatialObservationInput,
): SpatialObservationExtension | undefined {
  if (!spatialObservationEnabled() || input.player.numTilesOwned() === 0) {
    return undefined;
  }

  const includeMinimap = spatialMinimapEnabled();
  const snapshot =
    input.snapshot ??
    createAgentSpatialSnapshot(input.gameState, includeMinimap);
  if (snapshot.gameState !== input.gameState) {
    throw new Error("spatial snapshot belongs to a different game");
  }
  const ownGeometry = snapshot.geometryByPlayerID.get(input.player.id());
  if (ownGeometry === undefined) return undefined;

  const defensePosts = input.player
    .units(UnitType.DefensePost)
    .filter((unit) => unit.isActive() && !unit.isUnderConstruction());
  const defenseRangeSquared = input.gameState.config().defensePostRange() ** 2;

  for (const visible of input.visiblePlayers) {
    const otherGeometry = snapshot.geometryByPlayerID.get(visible.playerID);
    if (otherGeometry === undefined) continue;
    const sharedTiles = ownGeometry.sharedBorderTiles.get(visible.playerID);
    const centroidRelation = relationBetweenCentroids(
      input.gameState,
      ownGeometry.centroid,
      otherGeometry.centroid,
      (sharedTiles?.size ?? 0) > 0,
    );
    Object.assign(visible, centroidRelation);

    if (sharedTiles !== undefined && sharedTiles.size > 0) {
      visible.borderWithYou = {
        tiles: sharedTiles.size,
        shareOfYourBorder: percentage(
          sharedTiles.size,
          ownGeometry.playerContactTileCount,
        ),
        terrain: sharedBorderTerrain(
          sharedTiles,
          ownGeometry.coastalBorderTiles,
        ),
        defensePostsCovering: defensePosts.filter((post) =>
          [...sharedTiles].some(
            (tile) =>
              input.gameState.euclideanDistSquared(post.tile(), tile) <=
              defenseRangeSquared,
          ),
        ).length,
        // OpenFront attacks are pooled by player. This is observer-relative
        // live combat, not a claim about a finer sub-segment of the front.
        underAttackHere: visible.incomingAttack,
      };
    }

    visible.bordersWith = [...otherGeometry.sharedBorderTiles.entries()]
      .filter(
        ([playerID, tiles]) =>
          playerID !== input.player.id() &&
          tiles.size > 0 &&
          snapshot.geometryByPlayerID.has(playerID),
      )
      .map(([playerID, tiles]) => {
        const neighbor = snapshot.geometryByPlayerID.get(playerID)!;
        return {
          playerID,
          sizeClass:
            4 * tiles.size >
            Math.min(
              otherGeometry.playerContactTileCount,
              neighbor.playerContactTileCount,
            )
              ? ("major" as const)
              : ("minor" as const),
          smallID: neighbor.player.smallID(),
        };
      })
      .sort(
        (a, b) => a.smallID - b.smallID || a.playerID.localeCompare(b.playerID),
      )
      .map(({ playerID, sizeClass }) => ({ playerID, sizeClass }));
  }

  const spatial: AgentSpatialObservation = {
    schemaVersion: 1,
    ownShape: ownGeometry.ownShape,
    ...(includeMinimap && snapshot.minimap !== undefined
      ? {
          minimap: {
            schemaVersion: 1,
            width: SPATIAL_MINIMAP_WIDTH,
            height: SPATIAL_MINIMAP_HEIGHT,
            rows: [...snapshot.minimap.rows],
            legend: snapshot.minimap.legend.map((entry) => ({
              ...entry,
              isYou: entry.playerID === input.player.id(),
            })),
          } satisfies AgentSpatialMinimap,
        }
      : {}),
  };
  return {
    spatial,
    notes: spatialBriefing(input.player, input.visiblePlayers),
  };
}

interface RegionRun {
  startX: number;
  endX: number;
  label: number;
  ownerSmallID: number;
}

/**
 * Exact 4-neighbor connected components via row runs. This scans the owner grid
 * once and unions overlapping same-owner runs in adjacent rows. It avoids the
 * defensive Player.tiles() copies and per-tile Set churn that made the direct
 * flood-fill exceed the World/16-player budget by an order of magnitude.
 */
function analyzeRegions(
  gameState: Game,
  players: readonly Player[],
  metrics: AgentSpatialSnapshotMetrics,
): Map<string, CompleteRegionAnalysis> {
  const eligibleBySmallID = new Map<number, Player>();
  for (const player of players) {
    const tileCount = player.numTilesOwned();
    if (tileCount > 0 && tileCount <= SPATIAL_REGION_TILE_BUDGET) {
      eligibleBySmallID.set(player.smallID(), player);
    }
  }
  if (eligibleBySmallID.size === 0) return new Map();

  const width = gameState.width();
  const height = gameState.height();
  const labelByTile = new Int32Array(width * height);
  const parent = [0];
  const runSize = [0];
  const runOwner = [0];
  let previousRuns: RegionRun[] = [];

  const find = (label: number): number => {
    let root = label;
    while (parent[root] !== root) root = parent[root];
    while (parent[label] !== label) {
      const next = parent[label];
      parent[label] = root;
      label = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    if (rootA < rootB) parent[rootB] = rootA;
    else parent[rootA] = rootB;
  };

  for (let y = 0; y < height; y++) {
    const currentRuns: RegionRun[] = [];
    let x = 0;
    while (x < width) {
      const tile = y * width + x;
      const ownerSmallID = gameState.ownerID(tile);
      if (!eligibleBySmallID.has(ownerSmallID)) {
        x += 1;
        continue;
      }
      const startX = x;
      x += 1;
      while (x < width) {
        if (gameState.ownerID(y * width + x) !== ownerSmallID) break;
        x += 1;
      }
      const endX = x;
      if (metrics.regionRunsCreated >= SPATIAL_REGION_RUN_BUDGET) {
        metrics.regionMapTilesScanned += y * width + endX;
        metrics.regionRunBudgetExceeded = true;
        return new Map();
      }
      const label = parent.length;
      const size = endX - startX;
      parent.push(label);
      runSize.push(size);
      runOwner.push(ownerSmallID);
      labelByTile.fill(label, y * width + startX, y * width + endX);
      metrics.regionTilesVisited += size;
      metrics.regionRunsCreated += 1;
      currentRuns.push({ startX, endX, label, ownerSmallID });
    }

    let currentIndex = 0;
    let previousIndex = 0;
    while (
      currentIndex < currentRuns.length &&
      previousIndex < previousRuns.length
    ) {
      const current = currentRuns[currentIndex];
      const previous = previousRuns[previousIndex];
      if (current.endX <= previous.startX) {
        currentIndex += 1;
        continue;
      }
      if (previous.endX <= current.startX) {
        previousIndex += 1;
        continue;
      }
      if (current.ownerSmallID === previous.ownerSmallID) {
        union(current.label, previous.label);
      }
      if (current.endX <= previous.endX) currentIndex += 1;
      if (previous.endX <= current.endX) previousIndex += 1;
    }
    previousRuns = currentRuns;
  }
  metrics.regionMapTilesScanned += width * height;

  const componentSize = new Array<number>(parent.length).fill(0);
  for (let label = 1; label < parent.length; label++) {
    const root = find(label);
    componentSize[root] += runSize[label];
  }

  const regionCountBySmallID = new Map<number, number>();
  const largestRootBySmallID = new Map<number, number>();
  for (let root = 1; root < parent.length; root++) {
    if (componentSize[root] === 0) continue;
    const ownerSmallID = runOwner[root];
    regionCountBySmallID.set(
      ownerSmallID,
      (regionCountBySmallID.get(ownerSmallID) ?? 0) + 1,
    );
    const largestRoot = largestRootBySmallID.get(ownerSmallID);
    if (
      largestRoot === undefined ||
      componentSize[root] > componentSize[largestRoot] ||
      (componentSize[root] === componentSize[largestRoot] && root < largestRoot)
    ) {
      largestRootBySmallID.set(ownerSmallID, root);
    }
  }

  const result = new Map<string, CompleteRegionAnalysis>();
  for (const [smallID, player] of eligibleBySmallID) {
    const largestRoot = largestRootBySmallID.get(smallID);
    if (largestRoot === undefined) continue;
    let borderCount = 0;
    let borderX = 0;
    let borderY = 0;
    for (const tile of player.borderTiles()) {
      const label = labelByTile[tile];
      if (label === 0 || find(label) !== largestRoot) continue;
      borderCount += 1;
      borderX += gameState.x(tile);
      borderY += gameState.y(tile);
    }
    result.set(player.id(), {
      regionCount: regionCountBySmallID.get(smallID) ?? 1,
      largestRegionSize: componentSize[largestRoot],
      centroid:
        borderCount > 0
          ? { x: borderX / borderCount, y: borderY / borderCount }
          : regionTileCentroid(gameState, labelByTile, parent, largestRoot),
    });
  }
  return result;
}

function regionTileCentroid(
  gameState: Game,
  labelByTile: Int32Array,
  parent: number[],
  targetRoot: number,
): SpatialCentroid {
  let count = 0;
  let x = 0;
  let y = 0;
  for (let tile = 0; tile < labelByTile.length; tile++) {
    let root = labelByTile[tile];
    if (root === 0) continue;
    while (parent[root] !== root) root = parent[root];
    if (root !== targetRoot) continue;
    count += 1;
    x += gameState.x(tile);
    y += gameState.y(tile);
  }
  return count > 0
    ? { x: x / count, y: y / count }
    : {
        x: (gameState.width() - 1) / 2,
        y: (gameState.height() - 1) / 2,
      };
}

function playerShape(
  gameState: Game,
  player: Player,
  borderTiles: readonly number[],
  coastalBorderTileCount: number,
  regionAnalysis: CompleteRegionAnalysis | undefined,
): { centroid: SpatialCentroid; ownShape: AgentOwnShape } {
  const fallbackCentroid = meanCentroid(gameState, borderTiles);
  const coastShare = percentage(coastalBorderTileCount, borderTiles.length);
  if (regionAnalysis === undefined) {
    return {
      centroid: fallbackCentroid,
      ownShape: {
        quadrant: quadrant(gameState, fallbackCentroid),
        regionAnalysis: "omitted_budget",
        centroidBasis: "all_border_budget_fallback",
        coastShare,
        centroid: centroidPercentage(gameState, fallbackCentroid),
      },
    };
  }
  const centroid = regionAnalysis.centroid;
  const compactness =
    regionAnalysis.regionCount > 1
      ? ("fragmented" as const)
      : borderTiles.length / Math.sqrt(Math.max(player.numTilesOwned(), 1)) <= 4
        ? ("compact" as const)
        : ("stretched" as const);
  return {
    centroid,
    ownShape: {
      quadrant: quadrant(gameState, centroid),
      compactness,
      regionCount: regionAnalysis.regionCount,
      largestRegionShare: percentage(
        regionAnalysis.largestRegionSize,
        player.numTilesOwned(),
      ),
      regionAnalysis: "complete",
      centroidBasis: "largest_region_border",
      coastShare,
      centroid: centroidPercentage(gameState, centroid),
    },
  };
}

function meanCentroid(
  gameState: Game,
  tiles: readonly number[],
): SpatialCentroid {
  if (tiles.length === 0) {
    return {
      x: (gameState.width() - 1) / 2,
      y: (gameState.height() - 1) / 2,
    };
  }
  let x = 0;
  let y = 0;
  for (const tile of tiles) {
    x += gameState.x(tile);
    y += gameState.y(tile);
  }
  return { x: x / tiles.length, y: y / tiles.length };
}

function centroidPercentage(
  gameState: Game,
  centroid: SpatialCentroid,
): { xPct: number; yPct: number } {
  return {
    xPct: clampPercentage(
      Math.round((centroid.x / Math.max(gameState.width() - 1, 1)) * 100),
    ),
    yPct: clampPercentage(
      Math.round((centroid.y / Math.max(gameState.height() - 1, 1)) * 100),
    ),
  };
}

function quadrant(
  gameState: Game,
  centroid: SpatialCentroid,
): AgentSpatialQuadrant {
  const xBand = band(centroid.x / Math.max(gameState.width(), 1));
  const yBand = band(centroid.y / Math.max(gameState.height(), 1));
  return [
    ["northwest", "north", "northeast"],
    ["west", "center", "east"],
    ["southwest", "south", "southeast"],
  ][yBand][xBand] as AgentSpatialQuadrant;
}

function band(value: number): 0 | 1 | 2 {
  if (value < 1 / 3) return 0;
  if (value < 2 / 3) return 1;
  return 2;
}

function relationBetweenCentroids(
  gameState: Game,
  own: SpatialCentroid,
  other: SpatialCentroid,
  adjacent: boolean,
): Pick<AgentVisiblePlayer, "bearing" | "distanceClass"> {
  const dx = (other.x - own.x) / Math.max(gameState.width(), 1);
  const dy = (other.y - own.y) / Math.max(gameState.height(), 1);
  const distance = Math.hypot(dx, dy);
  const distanceClass = adjacent
    ? ("adjacent" as const)
    : distance <= 0.35
      ? ("near" as const)
      : ("far" as const);
  if (dx === 0 && dy === 0) return { distanceClass };
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const sector = Math.floor(((angle + 22.5 + 360) % 360) / 45);
  const directions: AgentSpatialBearing[] = [
    "east",
    "southeast",
    "south",
    "southwest",
    "west",
    "northwest",
    "north",
    "northeast",
  ];
  return { bearing: directions[sector], distanceClass };
}

function sharedBorderTerrain(
  sharedTiles: ReadonlySet<number>,
  coastalTiles: ReadonlySet<number>,
): "land" | "coastal" | "mixed" {
  let coastal = 0;
  for (const tile of sharedTiles) {
    if (coastalTiles.has(tile)) coastal += 1;
  }
  if (coastal === 0) return "land";
  return coastal === sharedTiles.size ? "coastal" : "mixed";
}

function spatialBriefing(
  player: Player,
  visiblePlayers: readonly AgentVisiblePlayer[],
): string[] {
  const exposures = visiblePlayers
    .filter((visible) => visible.borderWithYou !== undefined)
    .map((visible) => ({
      visible,
      border: visible.borderWithYou!,
      troopMultiple: visible.troops / Math.max(player.troops(), 1),
    }))
    .sort(
      (a, b) =>
        Number(b.border.underAttackHere) - Number(a.border.underAttackHere) ||
        b.border.shareOfYourBorder - a.border.shareOfYourBorder ||
        a.border.defensePostsCovering - b.border.defensePostsCovering ||
        b.troopMultiple - a.troopMultiple ||
        a.visible.playerID.localeCompare(b.visible.playerID),
    );
  const notes = exposures.slice(0, 3).map(({ visible, border }, index) => {
    const direction = visible.bearing ? `${visible.bearing} ` : "";
    const troopText = troopComparison(player.troops(), visible.troops);
    const attackText = border.underAttackHere ? ", active incoming attack" : "";
    return `Spatial exposure ${index + 1}: your ${direction}border with ${visible.name} spans ${border.tiles} tiles (${border.shareOfYourBorder}% of your player frontier, ${border.defensePostsCovering} defense posts${attackText}; ${troopText}).`;
  });

  if (notes.length < 3) {
    const leader = [...visiblePlayers]
      .filter(
        (visible) =>
          visible.borderWithYou === undefined &&
          visible.distanceClass !== undefined &&
          visible.tilesOwned > 0,
      )
      .sort(
        (a, b) =>
          b.tilesOwned - a.tilesOwned || a.playerID.localeCompare(b.playerID),
      )[0];
    if (leader !== undefined) {
      notes.push(
        `Spatial leader: ${leader.name} is ${leader.bearing ? `${leader.bearing} and ` : ""}${leader.distanceClass} relative to you.`,
      );
    }
  }
  return notes.slice(0, 3);
}

function troopComparison(ownTroops: number, rivalTroops: number): string {
  const rivalMultiple = rivalTroops / Math.max(ownTroops, 1);
  if (rivalMultiple >= 1.05) {
    return `they field ${roundOne(rivalMultiple)}x your troops`;
  }
  if (rivalMultiple <= 0.95 && rivalTroops > 0) {
    return `you field ${roundOne(1 / rivalMultiple)}x their troops`;
  }
  return "troops are near parity";
}

function buildMinimap(
  gameState: Game,
  players: readonly Player[],
  metrics: AgentSpatialSnapshotMetrics,
): SpatialMinimapBase | undefined {
  if (players.length > MINIMAP_GLYPHS.length) return undefined;
  const glyphBySmallID = new Map<number, string>();
  const legend = players.map((player, index) => {
    const glyph = MINIMAP_GLYPHS[index];
    glyphBySmallID.set(player.smallID(), glyph);
    return {
      glyph,
      playerID: player.id(),
      name: player.name(),
    };
  });
  const smallIDByGlyph = new Map(
    legend.map((entry, index) => [entry.glyph, players[index].smallID()]),
  );
  const rows: string[] = [];
  for (let cy = 0; cy < SPATIAL_MINIMAP_HEIGHT; cy++) {
    const yStart = Math.floor(
      (cy * gameState.height()) / SPATIAL_MINIMAP_HEIGHT,
    );
    const yEnd = Math.floor(
      ((cy + 1) * gameState.height()) / SPATIAL_MINIMAP_HEIGHT,
    );
    let row = "";
    for (let cx = 0; cx < SPATIAL_MINIMAP_WIDTH; cx++) {
      const xStart = Math.floor(
        (cx * gameState.width()) / SPATIAL_MINIMAP_WIDTH,
      );
      const xEnd = Math.floor(
        ((cx + 1) * gameState.width()) / SPATIAL_MINIMAP_WIDTH,
      );
      const counts = new Map<string, number>();
      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          metrics.minimapTilesVisited += 1;
          const tile = gameState.ref(x, y);
          let glyph: string;
          if (gameState.isWater(tile)) {
            glyph = "~";
          } else {
            const owner = gameState.owner(tile);
            glyph = owner.isPlayer()
              ? (glyphBySmallID.get(owner.smallID()) ?? ".")
              : ".";
          }
          counts.set(glyph, (counts.get(glyph) ?? 0) + 1);
        }
      }
      row +=
        [...counts.entries()].sort(
          (a, b) =>
            b[1] - a[1] ||
            minimapTiePriority(a[0], smallIDByGlyph) -
              minimapTiePriority(b[0], smallIDByGlyph),
        )[0]?.[0] ?? "~";
    }
    rows.push(row);
  }
  return { rows, legend };
}

function minimapTiePriority(
  glyph: string,
  smallIDByGlyph: ReadonlyMap<string, number>,
): number {
  if (smallIDByGlyph.has(glyph)) return smallIDByGlyph.get(glyph)!;
  if (glyph === ".") return Number.MAX_SAFE_INTEGER - 1;
  return Number.MAX_SAFE_INTEGER;
}

function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return clampPercentage(Math.round((numerator / denominator) * 100));
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}
