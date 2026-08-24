import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  TerrainType,
  UnitType,
  type Game,
  type Player,
} from "../core/game/Game";
import {
  buildSpatialObservationExtension,
  createAgentSpatialSnapshot,
  SPATIAL_MINIMAP_SERIALIZED_MAX_BYTES,
  SPATIAL_SNAPSHOT_P95_MAX_MS,
  SPATIAL_SNAPSHOT_RETAINED_MAX_BYTES,
  SPATIAL_SNAPSHOT_TRANSIENT_MAX_BYTES,
  SPATIAL_STAGE_ONE_SERIALIZED_MAX_BYTES,
} from "../server/agents/AgentSpatialObservation";
import type { AgentVisiblePlayer } from "../server/agents/AgentTypes";

const WIDTH = 1001;
const HEIGHT = 651;
const PLAYER_COUNT = 16;
const WARMUP_COUNT = 10;
const SAMPLE_COUNT = 50;
const TARGET_P95_MS = SPATIAL_SNAPSHOT_P95_MAX_MS;
const TARGET_MEMORY_DELTA_BYTES = SPATIAL_SNAPSHOT_TRANSIENT_MAX_BYTES;
const TARGET_RETAINED_DELTA_BYTES = SPATIAL_SNAPSHOT_RETAINED_MAX_BYTES;
const TARGET_STAGE_ONE_BYTES = SPATIAL_STAGE_ONE_SERIALIZED_MAX_BYTES;
const TARGET_MINIMAP_BYTES = SPATIAL_MINIMAP_SERIALIZED_MAX_BYTES;
const TARGET_NORMALIZED_LOAD_1M = 0.75;

interface FixtureConfig {
  layout:
    | "jagged_coastal_territories"
    | "contiguous_vertical_stripes"
    | "fragmented_vertical_stripes_64";
  bandCount: number;
  gateRole: "acceptance" | "stress_diagnostic";
  /**
   * Per-row drift of each band boundary. Straight stripes minimise border
   * tiles, and border-tile count is the term the whole Stage 1 pass scales
   * with, so a zero-jitter fixture measures the easiest possible map.
   */
  boundaryJitter: number;
  /** Carve seas and lakes so the coastal and terrain paths actually execute. */
  water: boolean;
  /** Late-game build-out: the term `countPostsCovering` scales with. */
  defensePostsPerPlayer: number;
}

/** Deterministic PRNG so every fixture is byte-reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FixtureGrid {
  /** 0 = unowned land or water; otherwise smallID (player index + 1). */
  ownerIDs: Uint16Array;
  water: Uint8Array;
  landTiles: number;
}

function buildGrid(
  config: FixtureConfig,
  playerCount: number = PLAYER_COUNT,
): FixtureGrid {
  const random = mulberry32(0x5a71a1);
  const ownerIDs = new Uint16Array(WIDTH * HEIGHT);
  const water = new Uint8Array(WIDTH * HEIGHT);

  if (config.water) {
    // A drifting north and south coastline plus a few lakes. Real maps put a
    // large share of every border on water; a land-only fixture never runs
    // the coastal branch at all.
    let northDepth = Math.floor(HEIGHT * 0.08);
    let southDepth = Math.floor(HEIGHT * 0.08);
    for (let x = 0; x < WIDTH; x++) {
      northDepth = Math.max(
        4,
        Math.min(
          Math.floor(HEIGHT * 0.18),
          northDepth + (random() < 0.5 ? -1 : 1),
        ),
      );
      southDepth = Math.max(
        4,
        Math.min(
          Math.floor(HEIGHT * 0.18),
          southDepth + (random() < 0.5 ? -1 : 1),
        ),
      );
      for (let y = 0; y < northDepth; y++) water[y * WIDTH + x] = 1;
      for (let y = HEIGHT - southDepth; y < HEIGHT; y++)
        water[y * WIDTH + x] = 1;
    }
    for (let lake = 0; lake < 12; lake++) {
      const cx = Math.floor(random() * WIDTH);
      const cy = Math.floor(random() * HEIGHT);
      const rx = 12 + Math.floor(random() * 26);
      const ry = 8 + Math.floor(random() * 18);
      for (let y = Math.max(0, cy - ry); y < Math.min(HEIGHT, cy + ry); y++) {
        for (let x = Math.max(0, cx - rx); x < Math.min(WIDTH, cx + rx); x++) {
          const nx = (x - cx) / rx;
          const ny = (y - cy) / ry;
          if (nx * nx + ny * ny <= 1) water[y * WIDTH + x] = 1;
        }
      }
    }
  }

  const bandWidth = WIDTH / config.bandCount;
  const offsets = new Array<number>(config.bandCount + 1).fill(0);
  let landTiles = 0;
  for (let y = 0; y < HEIGHT; y++) {
    if (config.boundaryJitter > 0) {
      for (let b = 1; b < config.bandCount; b++) {
        offsets[b] = Math.max(
          -config.boundaryJitter,
          Math.min(
            config.boundaryJitter,
            offsets[b] + Math.round((random() - 0.5) * 4),
          ),
        );
      }
    }
    for (let x = 0; x < WIDTH; x++) {
      const tile = y * WIDTH + x;
      if (water[tile] === 1) continue;
      landTiles += 1;
      let band = Math.min(config.bandCount - 1, Math.floor(x / bandWidth));
      if (config.boundaryJitter > 0) {
        // Re-resolve against the jittered boundaries around the nominal band.
        while (band > 0 && x < band * bandWidth + offsets[band]) band -= 1;
        while (
          band < config.bandCount - 1 &&
          x >= (band + 1) * bandWidth + offsets[band + 1]
        ) {
          band += 1;
        }
      }
      ownerIDs[tile] = (band % playerCount) + 1;
    }
  }
  return { ownerIDs, water, landTiles };
}

interface BenchmarkPost {
  id(): number;
  tile(): number;
  owner(): BenchmarkPlayer;
  type(): UnitType;
  isActive(): boolean;
  isMarkedForDeletion(): boolean;
  isUnderConstruction(): boolean;
}

class BenchmarkPlayer {
  private ownedTileCount = 0;
  private readonly frontierTiles = new Set<number>();
  private readonly posts: BenchmarkPost[] = [];

  constructor(
    private readonly index: number,
    grid: FixtureGrid,
    defensePostCount: number,
    private readonly identityProfile:
      | "benchmark"
      | "coworld_25_seat_boundary" = "benchmark",
  ) {
    const smallID = index + 1;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const tile = y * WIDTH + x;
        if (grid.ownerIDs[tile] !== smallID) continue;
        this.ownedTileCount += 1;
        const borders =
          y === 0 ||
          y === HEIGHT - 1 ||
          x === 0 ||
          x === WIDTH - 1 ||
          grid.ownerIDs[tile - 1] !== smallID ||
          grid.ownerIDs[tile + 1] !== smallID ||
          grid.ownerIDs[tile - WIDTH] !== smallID ||
          grid.ownerIDs[tile + WIDTH] !== smallID;
        if (borders) this.frontierTiles.add(tile);
      }
    }
    // Posts sit on the player's own frontier, which is where they are built
    // and where they cost the most to evaluate against shared borders.
    const frontier = [...this.frontierTiles];
    for (let post = 0; post < defensePostCount && frontier.length > 0; post++) {
      const tile =
        frontier[
          Math.floor((post * frontier.length) / Math.max(defensePostCount, 1))
        ];
      this.posts.push({
        id: () => this.index * 10_000 + post,
        tile: () => tile,
        owner: () => this,
        type: () => UnitType.DefensePost,
        isActive: () => true,
        isMarkedForDeletion: () => false,
        isUnderConstruction: () => false,
      });
    }
  }

  id(): string {
    if (this.identityProfile === "coworld_25_seat_boundary") {
      return `P${this.index.toString().padStart(7, "0")}`;
    }
    return `P_${this.index.toString().padStart(2, "0")}`;
  }

  isPlayer(): true {
    return true;
  }

  smallID(): number {
    return this.index + 1;
  }

  name(): string {
    if (this.identityProfile === "coworld_25_seat_boundary") {
      return `Candidate Seat ${(this.index + 1).toString().padStart(2, "0")} NNNNNNNNN`;
    }
    return `Player ${this.index + 1}`;
  }

  numTilesOwned(): number {
    return this.ownedTileCount;
  }

  borderTiles(): ReadonlySet<number> {
    return this.frontierTiles;
  }

  units(...types: UnitType[]): BenchmarkPost[] {
    return this.posts.filter(
      (post) => types.length === 0 || types.includes(post.type()),
    );
  }

  troops(): number {
    return 100_000 + this.index * 10_000;
  }
}

const TERRA_NULLIUS = {
  isPlayer: () => false,
  id: () => "TERRA_NULLIUS",
  smallID: () => 0,
};

function benchmarkGame(
  config: FixtureConfig,
  playerCount: number = PLAYER_COUNT,
  identityProfile: "benchmark" | "coworld_25_seat_boundary" = "benchmark",
): {
  game: Game;
  players: BenchmarkPlayer[];
  landTiles: number;
} {
  const grid = buildGrid(config, playerCount);
  const players = Array.from(
    { length: playerCount },
    (_, index) =>
      new BenchmarkPlayer(
        index,
        grid,
        config.defensePostsPerPlayer,
        identityProfile,
      ),
  );
  const game = {
    players: () => players as unknown as Player[],
    width: () => WIDTH,
    height: () => HEIGHT,
    x: (tile: number) => tile % WIDTH,
    y: (tile: number) => Math.floor(tile / WIDTH),
    ref: (x: number, y: number) => y * WIDTH + x,
    isLand: (tile: number) => grid.water[tile] === 0,
    isWater: (tile: number) => grid.water[tile] === 1,
    isShore: (tile: number) => {
      if (grid.water[tile] === 1) return false;
      const x = tile % WIDTH;
      const y = Math.floor(tile / WIDTH);
      return (
        (x > 0 && grid.water[tile - 1] === 1) ||
        (x + 1 < WIDTH && grid.water[tile + 1] === 1) ||
        (y > 0 && grid.water[tile - WIDTH] === 1) ||
        (y + 1 < HEIGHT && grid.water[tile + WIDTH] === 1)
      );
    },
    // The acceptance fixture models one connected public ocean. Land tiles
    // adjacent to that ocean deliberately share its component, matching the
    // permissive shore lookup exposed by the real WaterManager API.
    getWaterComponent: (tile: number) => {
      if (grid.water[tile] === 1) return 0;
      const x = tile % WIDTH;
      const y = Math.floor(tile / WIDTH);
      return (x > 0 && grid.water[tile - 1] === 1) ||
        (x + 1 < WIDTH && grid.water[tile + 1] === 1) ||
        (y > 0 && grid.water[tile - WIDTH] === 1) ||
        (y + 1 < HEIGHT && grid.water[tile + WIDTH] === 1)
        ? 0
        : null;
    },
    terrainType: (tile: number) =>
      tile % 19 === 0
        ? TerrainType.Mountain
        : tile % 7 === 0
          ? TerrainType.Highland
          : TerrainType.Plains,
    ownerID: (tile: number) => grid.ownerIDs[tile],
    owner: (tile: number) => {
      const smallID = grid.ownerIDs[tile];
      return (smallID === 0
        ? TERRA_NULLIUS
        : players[smallID - 1]) as unknown as Player;
    },
    forEachNeighbor: (tile: number, callback: (neighbor: number) => void) => {
      const x = tile % WIDTH;
      const y = Math.floor(tile / WIDTH);
      if (x > 0) callback(tile - 1);
      if (x + 1 < WIDTH) callback(tile + 1);
      if (y > 0) callback(tile - WIDTH);
      if (y + 1 < HEIGHT) callback(tile + WIDTH);
    },
    euclideanDistSquared: (a: number, b: number) => {
      const dx = (a % WIDTH) - (b % WIDTH);
      const dy = Math.floor(a / WIDTH) - Math.floor(b / WIDTH);
      return dx * dx + dy * dy;
    },
    config: () => ({
      defensePostRange: () => 30,
      gameConfig: () => ({ gameMap: "World" }),
    }),
  };
  return {
    game: game as unknown as Game,
    players,
    landTiles: grid.landTiles,
  };
}

function visiblePlayer(player: BenchmarkPlayer): AgentVisiblePlayer {
  return {
    playerID: player.id(),
    clientID: null,
    smallID: player.smallID(),
    name: player.name(),
    type: "HUMAN",
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: player.troops(),
    gold: "0",
    tilesOwned: player.numTilesOwned(),
    sharesBorder: false,
    isAllied: false,
    isFriendly: false,
    relation: 0,
    canAttack: false,
    canRequestAlliance: false,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: false,
    hasEmbargoAgainst: false,
    outgoingAttack: false,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
  } as AgentVisiblePlayer;
}

function visibleMatrix(
  players: readonly BenchmarkPlayer[],
): AgentVisiblePlayer[][] {
  return players.map((observer) =>
    players
      .filter((player) => player !== observer)
      .map((player) => visiblePlayer(player)),
  );
}

function completeSpatialBatch(
  game: Game,
  players: readonly BenchmarkPlayer[],
  visibleByObserver: AgentVisiblePlayer[][],
  includeMinimap: boolean,
) {
  const snapshot = createAgentSpatialSnapshot(game, includeMinimap);
  let extensionsBuilt = 0;
  for (let index = 0; index < players.length; index++) {
    const extension = buildSpatialObservationExtension({
      gameState: game,
      player: players[index] as unknown as Player,
      visiblePlayers: visibleByObserver[index],
      snapshot,
    });
    if (extension !== undefined) extensionsBuilt += 1;
  }
  return { snapshot, extensionsBuilt };
}

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[
    Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)
  ];
}

function combinedMemory(memory: NodeJS.MemoryUsage): number {
  return memory.heapUsed + memory.arrayBuffers;
}

function measurePostCallMemory(
  game: Game,
  players: readonly BenchmarkPlayer[],
  includeMinimap: boolean,
) {
  const visibleByObserver = visibleMatrix(players);
  globalThis.gc?.();
  const before = process.memoryUsage();
  const batch = completeSpatialBatch(
    game,
    players,
    visibleByObserver,
    includeMinimap,
  );
  const after = process.memoryUsage();
  return {
    before,
    after,
    measuredGeometryPlayers: batch.snapshot.geometryByPlayerID.size,
    metrics: batch.snapshot.metrics,
  };
}

function payloadSizes(game: Game, players: readonly BenchmarkPlayer[]) {
  delete process.env.PROXYWAR_TUNE_SPATIAL_MINIMAP;
  const baselineVisible = players.slice(1).map(visiblePlayer);
  const baselineBytes = Buffer.byteLength(
    JSON.stringify({ visiblePlayers: baselineVisible }),
  );
  const stageOneSnapshot = createAgentSpatialSnapshot(game, false);
  const stageOneVisible = players.slice(1).map(visiblePlayer);
  const stageOne = buildSpatialObservationExtension({
    gameState: game,
    player: players[0] as unknown as Player,
    visiblePlayers: stageOneVisible,
    snapshot: stageOneSnapshot,
  });
  const stageOneBytes = Buffer.byteLength(
    JSON.stringify({ ...stageOne, visiblePlayers: stageOneVisible }),
  );

  process.env.PROXYWAR_TUNE_SPATIAL_MINIMAP = "1";
  const stageTwoSnapshot = createAgentSpatialSnapshot(game, true);
  const stageTwoVisible = players.slice(1).map(visiblePlayer);
  const stageTwo = buildSpatialObservationExtension({
    gameState: game,
    player: players[0] as unknown as Player,
    visiblePlayers: stageTwoVisible,
    snapshot: stageTwoSnapshot,
  });
  const stageTwoBytes = Buffer.byteLength(
    JSON.stringify({ ...stageTwo, visiblePlayers: stageTwoVisible }),
  );
  delete process.env.PROXYWAR_TUNE_SPATIAL_MINIMAP;

  return {
    spatialSchemaVersion: stageOne?.spatial.schemaVersion ?? null,
    positionedAssets:
      stageOne === undefined
        ? null
        : {
            analysis: stageOne.spatial.positionedAssets.analysis,
            structuresTotal: stageOne.spatial.positionedAssets.structuresTotal,
            structuresReturned:
              stageOne.spatial.positionedAssets.structuresReturned,
            warshipsTotal: stageOne.spatial.positionedAssets.warshipsTotal,
            warshipsReturned:
              stageOne.spatial.positionedAssets.warshipsReturned,
          },
    stageOneIncrementalSerializedBytes: stageOneBytes - baselineBytes,
    minimapIncrementalSerializedBytes: stageTwoBytes - stageOneBytes,
    estimatedMinimapTokenDeltaAtFourCharsPerToken: Math.ceil(
      (stageTwoBytes - stageOneBytes) / 4,
    ),
  };
}

function minimapSerializationBoundary() {
  const { game, players } = benchmarkGame(
    {
      layout: "contiguous_vertical_stripes",
      bandCount: 25,
      gateRole: "acceptance",
      boundaryJitter: 0,
      water: false,
      defensePostsPerPlayer: 0,
    },
    25,
    "coworld_25_seat_boundary",
  );
  const snapshot = createAgentSpatialSnapshot(game, true);
  if (snapshot.minimap === undefined) {
    throw new Error("25-seat serialization fixture did not build a minimap");
  }
  const minimap = {
    schemaVersion: 2,
    width: snapshot.minimap.width,
    height: snapshot.minimap.height,
    ownershipRows: [...snapshot.minimap.ownershipRows],
    terrainRows: [...snapshot.minimap.terrainRows],
    legend: snapshot.minimap.legend.map((entry) => ({
      ...entry,
      isYou: entry.playerID === players[0].id(),
    })),
    markers: snapshot.minimap.markers.map((marker) => ({ ...marker })),
    markersTotal: snapshot.minimap.markersTotal,
    markersReturned: snapshot.minimap.markers.length,
    markersTruncated:
      snapshot.minimap.markers.length < snapshot.minimap.markersTotal,
  };
  const serializedBytes = Buffer.byteLength(JSON.stringify(minimap), "utf8");
  const legacyNamefulMinimap = {
    ...minimap,
    legend: minimap.legend.map((entry, index) => ({
      ...entry,
      name: players[index].name(),
    })),
  };
  const legacyNamefulSerializedBytes = Buffer.byteLength(
    JSON.stringify(legacyNamefulMinimap),
    "utf8",
  );
  const idsAndGlyphsExact = minimap.legend.every(
    (entry, index) =>
      entry.playerID === players[index].id() &&
      entry.glyph ===
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#"[
          index
        ],
  );
  const namesOmitted = minimap.legend.every(
    (entry) => !Object.hasOwn(entry, "name"),
  );
  return {
    players: players.length,
    playerIDLengths: [...new Set(players.map((player) => player.id().length))],
    playerNameLengths: [
      ...new Set(players.map((player) => player.name().length)),
    ],
    serializedBytes,
    legacyNamefulSerializedBytes,
    legacyNamefulWithinCurrentCap:
      legacyNamefulSerializedBytes <= TARGET_MINIMAP_BYTES,
    namesOmitted,
    idsAndGlyphsExact,
    checks: {
      payload: serializedBytes <= TARGET_MINIMAP_BYTES,
      namesOmitted,
      idsAndGlyphsExact,
    },
  };
}

function timeStage(
  game: Game,
  players: readonly BenchmarkPlayer[],
  includeMinimap: boolean,
) {
  for (let warmup = 0; warmup < WARMUP_COUNT; warmup++) {
    completeSpatialBatch(game, players, visibleMatrix(players), includeMinimap);
  }
  const timings: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    const visibleByObserver = visibleMatrix(players);
    const startedAt = performance.now();
    completeSpatialBatch(game, players, visibleByObserver, includeMinimap);
    timings.push(performance.now() - startedAt);
  }
  return {
    p50Ms: Math.round(percentile(timings, 0.5) * 100) / 100,
    p95Ms: Math.round(percentile(timings, 0.95) * 100) / 100,
  };
}

function benchmarkFixture(config: FixtureConfig) {
  const { game, players, landTiles } = benchmarkGame(config);

  // Stage 1 is what ships enabled first; Stage 2 adds the full-map minimap
  // scan. Both are timed and both are gated — an untimed stage is an
  // unmeasured stage, and the minimap is the most expensive single pass here.
  const stageOne = timeStage(game, players, false);
  const stageTwo = timeStage(game, players, true);

  const memoryMeasurement = measurePostCallMemory(game, players, false);
  globalThis.gc?.();
  globalThis.gc?.();
  const memoryAfterRelease = process.memoryUsage();
  const minimapMemoryMeasurement = measurePostCallMemory(game, players, true);
  globalThis.gc?.();
  globalThis.gc?.();
  const minimapMemoryAfterRelease = process.memoryUsage();

  const postCallMemoryDeltaBytes = Math.max(
    0,
    combinedMemory(memoryMeasurement.after) -
      combinedMemory(memoryMeasurement.before),
  );
  const retainedMemoryDeltaBytes = Math.max(
    0,
    combinedMemory(memoryAfterRelease) -
      combinedMemory(memoryMeasurement.before),
  );
  const minimapPostCallMemoryDeltaBytes = Math.max(
    0,
    combinedMemory(minimapMemoryMeasurement.after) -
      combinedMemory(minimapMemoryMeasurement.before),
  );
  const minimapRetainedMemoryDeltaBytes = Math.max(
    0,
    combinedMemory(minimapMemoryAfterRelease) -
      combinedMemory(minimapMemoryMeasurement.before),
  );
  const sizes = payloadSizes(game, players);
  const checks = {
    latency: stageOne.p95Ms < TARGET_P95_MS,
    minimapLatency: stageTwo.p95Ms < TARGET_P95_MS,
    memory: postCallMemoryDeltaBytes < TARGET_MEMORY_DELTA_BYTES,
    minimapMemory: minimapPostCallMemoryDeltaBytes < TARGET_MEMORY_DELTA_BYTES,
    retainedMemory: retainedMemoryDeltaBytes < TARGET_RETAINED_DELTA_BYTES,
    minimapRetainedMemory:
      minimapRetainedMemoryDeltaBytes < TARGET_RETAINED_DELTA_BYTES,
    stageOnePayload:
      sizes.stageOneIncrementalSerializedBytes <= TARGET_STAGE_ONE_BYTES,
    minimapPayload:
      sizes.minimapIncrementalSerializedBytes <= TARGET_MINIMAP_BYTES,
  };
  const meetsReferenceTargets = Object.values(checks).every(Boolean);

  return {
    fixture: {
      width: WIDTH,
      height: HEIGHT,
      landTiles,
      waterTiles: WIDTH * HEIGHT - landTiles,
      players: PLAYER_COUNT,
      layout: config.layout,
      ownershipBands: config.bandCount,
      boundaryJitter: config.boundaryJitter,
      defensePostsPerPlayer: config.defensePostsPerPlayer,
      gateRole: config.gateRole,
    },
    warmups: WARMUP_COUNT,
    samples: SAMPLE_COUNT,
    p50Ms: stageOne.p50Ms,
    p95Ms: stageOne.p95Ms,
    minimapP50Ms: stageTwo.p50Ms,
    minimapP95Ms: stageTwo.p95Ms,
    postCallMemoryDeltaBytes,
    minimapPostCallMemoryDeltaBytes,
    retainedMemoryDeltaBytes,
    minimapRetainedMemoryDeltaBytes,
    measuredGeometryPlayers: memoryMeasurement.measuredGeometryPlayers,
    metrics: memoryMeasurement.metrics,
    minimapMetrics: minimapMemoryMeasurement.metrics,
    ...sizes,
    checks,
    meetsReferenceTargets,
    acceptanceTargetMet:
      config.gateRole === "acceptance" ? meetsReferenceTargets : null,
  };
}

function sourceIdentity() {
  let commit = "unavailable";
  let treeState: "clean" | "dirty" | "unavailable" = "unavailable";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    treeState =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim() === ""
        ? "clean"
        : "dirty";
  } catch {
    // Source archives may lack Git; their benchmark remains explicitly
    // unattributable and cannot satisfy the pre-merge acceptance gate.
  }
  return { commit, treeState };
}

process.env.PROXYWAR_TUNE_SPATIAL_OBSERVATION = "1";
delete process.env.PROXYWAR_TUNE_SPATIAL_MINIMAP;

const cpuCount = os.availableParallelism();
const loadAverage1mBefore = os.loadavg()[0];
const normalizedLoad1mBefore = loadAverage1mBefore / Math.max(cpuCount, 1);
const serializationBoundary = minimapSerializationBoundary();
const fixtures = [
  // Gating fixture: World dimensions, 16 players, jagged land borders, real
  // coastline and lakes, and late-game defense-post build-out. This is the
  // acceptance case because every term the implementation scales with is
  // actually present in it.
  benchmarkFixture({
    layout: "jagged_coastal_territories",
    bandCount: PLAYER_COUNT,
    gateRole: "acceptance",
    boundaryJitter: 24,
    water: true,
    defensePostsPerPlayer: 24,
  }),
  // Retained for continuity with the pre-hardening reports: straight stripes,
  // no water, no posts. It is the easiest possible map, kept as a diagnostic
  // floor rather than a gate so a regression cannot hide behind it.
  benchmarkFixture({
    layout: "contiguous_vertical_stripes",
    bandCount: PLAYER_COUNT,
    gateRole: "stress_diagnostic",
    boundaryJitter: 0,
    water: false,
    defensePostsPerPlayer: 0,
  }),
  // Deliberately impossible stripe fragmentation. Diagnostic only: it exists
  // to expose scaling and the run-budget cutoff, not to define the gate.
  benchmarkFixture({
    layout: "fragmented_vertical_stripes_64",
    bandCount: 64,
    gateRole: "stress_diagnostic",
    boundaryJitter: 0,
    water: false,
    defensePostsPerPlayer: 0,
  }),
];
const loadAverage1mAfter = os.loadavg()[0];
const normalizedLoad1mAfter = loadAverage1mAfter / Math.max(cpuCount, 1);
const source = sourceIdentity();
const attributionMet =
  /^[0-9a-f]{40}$/.test(source.commit) && source.treeState === "clean";
const hostPreconditionMet =
  Math.max(normalizedLoad1mBefore, normalizedLoad1mAfter) <=
  TARGET_NORMALIZED_LOAD_1M;
const report = {
  schemaVersion: 5,
  source,
  referenceRuntime: {
    platform: process.platform,
    architecture: process.arch,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cpuCount,
    node: process.version,
    loadAverage1mBefore: Math.round(loadAverage1mBefore * 100) / 100,
    loadAverage1mAfter: Math.round(loadAverage1mAfter * 100) / 100,
    normalizedLoad1mBefore: Math.round(normalizedLoad1mBefore * 100) / 100,
    normalizedLoad1mAfter: Math.round(normalizedLoad1mAfter * 100) / 100,
  },
  targets: {
    maxNormalizedLoad1m: TARGET_NORMALIZED_LOAD_1M,
    p95Ms: TARGET_P95_MS,
    postCallHeapAndArrayBufferDeltaBytes: TARGET_MEMORY_DELTA_BYTES,
    retainedHeapAndArrayBufferDeltaBytes: TARGET_RETAINED_DELTA_BYTES,
    minimapRetainedHeapAndArrayBufferDeltaBytes: TARGET_RETAINED_DELTA_BYTES,
    stageOneIncrementalSerializedBytes: TARGET_STAGE_ONE_BYTES,
    minimapIncrementalSerializedBytes: TARGET_MINIMAP_BYTES,
  },
  fixtures,
  serializationBoundary,
  attributionMet,
  hostPreconditionMet,
  targetMet:
    attributionMet &&
    hostPreconditionMet &&
    fixtures
      .filter((fixture) => fixture.fixture.gateRole === "acceptance")
      .every((fixture) => fixture.acceptanceTargetMet === true) &&
    Object.values(serializationBoundary.checks).every(Boolean),
};
console.log(JSON.stringify(report, null, 2));
const outputArgument = process.argv.find((argument) =>
  argument.startsWith("--out="),
);
const outputPath = outputArgument?.slice("--out=".length);
const artifactPath = path.resolve(
  process.cwd(),
  outputPath !== undefined && outputPath.length > 0
    ? outputPath
    : "artifacts/ai-league-benchmarks/spatial-observation-benchmark.json",
);
await fs.mkdir(path.dirname(artifactPath), { recursive: true });
await fs.writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
if (!report.targetMet) process.exitCode = 1;
