import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Game, Player } from "../core/game/Game";
import {
  buildSpatialObservationExtension,
  createAgentSpatialSnapshot,
} from "../server/agents/AgentSpatialObservation";
import type { AgentVisiblePlayer } from "../server/agents/AgentTypes";

const WIDTH = 1001;
const HEIGHT = 651;
const PLAYER_COUNT = 16;
const WARMUP_COUNT = 10;
const SAMPLE_COUNT = 50;
const TARGET_P95_MS = 25;
const TARGET_MEMORY_DELTA_BYTES = 32 * 1024 * 1024;
const TARGET_RETAINED_DELTA_BYTES = 1024 * 1024;
const TARGET_STAGE_ONE_BYTES = 16 * 1024;
const TARGET_MINIMAP_BYTES = 2 * 1024;
const TARGET_NORMALIZED_LOAD_1M = 0.75;

interface FixtureConfig {
  layout: "contiguous_vertical_stripes" | "fragmented_vertical_stripes_64";
  bandCount: number;
  gateRole: "acceptance" | "stress_diagnostic";
}

class BenchmarkPlayer {
  private ownedTileCount = 0;
  private readonly frontierTiles = new Set<number>();

  constructor(
    private readonly index: number,
    private readonly width: number,
    private readonly height: number,
    private readonly bandCount: number,
  ) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (ownerIndex(x, width, bandCount) !== index) continue;
        this.ownedTileCount += 1;
        const tile = y * width + x;
        if (
          y === 0 ||
          y === height - 1 ||
          x === 0 ||
          x === width - 1 ||
          (x > 0 && ownerIndex(x - 1, width, bandCount) !== index) ||
          (x + 1 < width && ownerIndex(x + 1, width, bandCount) !== index)
        ) {
          this.frontierTiles.add(tile);
        }
      }
    }
  }

  id(): string {
    return `P_${this.index.toString().padStart(2, "0")}`;
  }

  isPlayer(): true {
    return true;
  }

  smallID(): number {
    return this.index + 1;
  }

  name(): string {
    return `Player ${this.index + 1}`;
  }

  numTilesOwned(): number {
    return this.ownedTileCount;
  }

  borderTiles(): ReadonlySet<number> {
    return this.frontierTiles;
  }

  units(): [] {
    return [];
  }

  troops(): number {
    return 100_000 + this.index * 10_000;
  }
}

function ownerIndex(x: number, width: number, bandCount: number): number {
  const band = Math.min(bandCount - 1, Math.floor((x * bandCount) / width));
  return band % PLAYER_COUNT;
}

function benchmarkGame(config: FixtureConfig): Game {
  const ownerIDs = new Uint16Array(WIDTH * HEIGHT);
  for (let tile = 0; tile < ownerIDs.length; tile++) {
    ownerIDs[tile] = ownerIndex(tile % WIDTH, WIDTH, config.bandCount) + 1;
  }
  const players = Array.from(
    { length: PLAYER_COUNT },
    (_, index) => new BenchmarkPlayer(index, WIDTH, HEIGHT, config.bandCount),
  );
  const game = {
    players: () => players as unknown as Player[],
    width: () => WIDTH,
    height: () => HEIGHT,
    x: (tile: number) => tile % WIDTH,
    y: (tile: number) => Math.floor(tile / WIDTH),
    ref: (x: number, y: number) => y * WIDTH + x,
    isLand: () => true,
    isWater: () => false,
    ownerID: (tile: number) => ownerIDs[tile],
    owner: (tile: number) => players[ownerIDs[tile] - 1] as unknown as Player,
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
    config: () => ({ defensePostRange: () => 30 }),
  };
  return game as unknown as Game;
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
) {
  const snapshot = createAgentSpatialSnapshot(game, false);
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
) {
  const visibleByObserver = visibleMatrix(players);
  globalThis.gc?.();
  const before = process.memoryUsage();
  const batch = completeSpatialBatch(game, players, visibleByObserver);
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
    stageOneIncrementalSerializedBytes: stageOneBytes - baselineBytes,
    minimapIncrementalSerializedBytes: stageTwoBytes - stageOneBytes,
    estimatedMinimapTokenDeltaAtFourCharsPerToken: Math.ceil(
      (stageTwoBytes - stageOneBytes) / 4,
    ),
  };
}

function benchmarkFixture(config: FixtureConfig) {
  const game = benchmarkGame(config);
  const players = game.players() as unknown as BenchmarkPlayer[];

  for (let warmup = 0; warmup < WARMUP_COUNT; warmup++) {
    completeSpatialBatch(game, players, visibleMatrix(players));
  }
  const timings: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    const visibleByObserver = visibleMatrix(players);
    const startedAt = performance.now();
    completeSpatialBatch(game, players, visibleByObserver);
    timings.push(performance.now() - startedAt);
  }

  const memoryMeasurement = measurePostCallMemory(game, players);
  globalThis.gc?.();
  globalThis.gc?.();
  const memoryAfterRelease = process.memoryUsage();

  const p50Ms = percentile(timings, 0.5);
  const p95Ms = percentile(timings, 0.95);
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
  const sizes = payloadSizes(game, players);
  const checks = {
    latency: p95Ms < TARGET_P95_MS,
    memory: postCallMemoryDeltaBytes < TARGET_MEMORY_DELTA_BYTES,
    retainedMemory: retainedMemoryDeltaBytes < TARGET_RETAINED_DELTA_BYTES,
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
      landTiles: WIDTH * HEIGHT,
      players: PLAYER_COUNT,
      layout: config.layout,
      ownershipBands: config.bandCount,
      gateRole: config.gateRole,
    },
    warmups: WARMUP_COUNT,
    samples: SAMPLE_COUNT,
    p50Ms: Math.round(p50Ms * 100) / 100,
    p95Ms: Math.round(p95Ms * 100) / 100,
    postCallMemoryDeltaBytes,
    retainedMemoryDeltaBytes,
    measuredGeometryPlayers: memoryMeasurement.measuredGeometryPlayers,
    metrics: memoryMeasurement.metrics,
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
const fixtures = [
  benchmarkFixture({
    layout: "contiguous_vertical_stripes",
    bandCount: PLAYER_COUNT,
    gateRole: "acceptance",
  }),
  benchmarkFixture({
    layout: "fragmented_vertical_stripes_64",
    bandCount: 64,
    gateRole: "stress_diagnostic",
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
  schemaVersion: 3,
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
    stageOneIncrementalSerializedBytes: TARGET_STAGE_ONE_BYTES,
    minimapIncrementalSerializedBytes: TARGET_MINIMAP_BYTES,
  },
  fixtures,
  attributionMet,
  hostPreconditionMet,
  targetMet:
    attributionMet &&
    hostPreconditionMet &&
    fixtures
      .filter((fixture) => fixture.fixture.gateRole === "acceptance")
      .every((fixture) => fixture.acceptanceTargetMet === true),
};
console.log(JSON.stringify(report, null, 2));
const artifactPath = path.resolve(
  process.cwd(),
  "artifacts/ai-league-benchmarks/spatial-observation-benchmark.json",
);
await fs.mkdir(path.dirname(artifactPath), { recursive: true });
await fs.writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
if (!report.targetMet) process.exitCode = 1;
