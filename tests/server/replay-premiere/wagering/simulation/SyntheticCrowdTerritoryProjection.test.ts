import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../../../../src/core/game/Game";
import type { GameStartInfo, Turn } from "../../../../../src/core/Schemas";
import { ReplayPremiereFilesystemMapLoader } from "../../../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import {
  DeterministicSyntheticCrowdTerritoryProjector,
  projectSyntheticCrowdTerritorySamples,
  syntheticCrowdTerritorySampleAtOrBefore,
  SYNTHETIC_CROWD_TERRITORY_SAMPLE_INTERVAL_TURNS,
} from "../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdTerritoryProjection";
import { verifiedPublicationFixture } from "../../ReplayPremiereFixtures";

const SEATS = ["SEAT0001", "SEAT0002", "SEAT0003"] as const;

function randomSpawnGameStart(): GameStartInfo {
  return {
    gameID: "TERR0001",
    lobbyCreatedAt: 1,
    config: {
      gameMap: GameMapType.Asia,
      gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA,
      gameType: GameType.Singleplayer,
      difficulty: Difficulty.Medium,
      nations: "disabled",
      donateGold: false,
      donateTroops: false,
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: true,
    },
    players: SEATS.map((clientID, index) => ({
      clientID,
      username: `Seat ${index + 1}`,
      clanTag: null,
    })),
  };
}

function turns(count: number): Turn[] {
  return Array.from({ length: count }, (_, turnNumber) => ({ turnNumber, intents: [] }));
}

describe("SyntheticCrowdTerritoryProjection", () => {
  test("uses the real GameRunner and tracked filesystem map to sample every seat's real tilesOwned over the whole match", async () => {
    const table = await projectSyntheticCrowdTerritorySamples({
      gameStartInfo: randomSpawnGameStart(),
      turns: turns(25),
      seatIds: SEATS,
      mapLoader: new ReplayPremiereFilesystemMapLoader(path.resolve("resources", "maps")),
      signal: new AbortController().signal,
    });

    // First turn (0), every SYNTHETIC_CROWD_TERRITORY_SAMPLE_INTERVAL_TURNS
    // turns, and the final turn (24) are all present.
    const sequences = table.samples.map((s) => s.sequence);
    expect(sequences[0]).toBe(0);
    expect(sequences.at(-1)).toBe(24);
    for (let s = 0; s < 24; s += SYNTHETIC_CROWD_TERRITORY_SAMPLE_INTERVAL_TURNS) {
      expect(sequences).toContain(s);
    }
    // Every sample carries a real, non-negative tile count for every
    // seat, and every seat has actually spawned (nonzero tiles) by the
    // final sample on a randomSpawn FFA map with no bots/eliminations.
    for (const sample of table.samples) {
      for (const seatId of SEATS) {
        expect(sample.tilesOwned[seatId]).toBeGreaterThanOrEqual(0);
      }
    }
    const lastSample = table.samples.at(-1)!;
    for (const seatId of SEATS) {
      expect(lastSample.tilesOwned[seatId]).toBeGreaterThan(0);
    }
  });

  test("a seat absent from the map (bad clientID) reads 0 tiles rather than throwing", async () => {
    const table = await projectSyntheticCrowdTerritorySamples({
      gameStartInfo: randomSpawnGameStart(),
      turns: turns(3),
      seatIds: [...SEATS, "NOT_A_REAL_SEAT"],
      mapLoader: new ReplayPremiereFilesystemMapLoader(path.resolve("resources", "maps")),
      signal: new AbortController().signal,
    });
    for (const sample of table.samples) {
      expect(sample.tilesOwned["NOT_A_REAL_SEAT"]).toBe(0);
    }
  });

  test("honors an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      projectSyntheticCrowdTerritorySamples({
        gameStartInfo: randomSpawnGameStart(),
        turns: turns(3),
        seatIds: SEATS,
        mapLoader: new ReplayPremiereFilesystemMapLoader(path.resolve("resources", "maps")),
        signal: controller.signal,
      }),
    ).rejects.toThrow("synthetic_crowd_territory_projection_aborted");
  });

  test("DeterministicSyntheticCrowdTerritoryProjector reuses the same chunk-hash-verified turn extraction the checkpoint projector trusts, end to end from a sealed gate/drafts pair", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synthetic-crowd-territory-"));
    try {
      const { gate, drafts } = await verifiedPublicationFixture(root);
      const projector = new DeterministicSyntheticCrowdTerritoryProjector(
        path.resolve("resources", "maps"),
      );
      const seatIds = gate.publicBootstrap().players.map((p) => p.clientID);
      const table = await projector.project({
        gate,
        drafts,
        seatIds,
        signal: new AbortController().signal,
      });
      expect(table.samples.length).toBeGreaterThan(0);
      expect(table.samples[0].sequence).toBe(0);
      expect(table.samples.at(-1)!.sequence).toBe(gate.finalSequence);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("syntheticCrowdTerritorySampleAtOrBefore — the driver's release-point integrity bound", () => {
  const table = {
    samples: [
      { sequence: 0, tilesOwned: { a: 1, b: 0 } },
      { sequence: 10, tilesOwned: { a: 3, b: 1 } },
      { sequence: 20, tilesOwned: { a: 2, b: 4 } },
    ],
  };

  test("returns the latest sample at or before the bound", () => {
    expect(syntheticCrowdTerritorySampleAtOrBefore(table, 15)?.sequence).toBe(10);
    expect(syntheticCrowdTerritorySampleAtOrBefore(table, 20)?.sequence).toBe(20);
    expect(syntheticCrowdTerritorySampleAtOrBefore(table, 1000)?.sequence).toBe(20);
  });

  test("NEVER returns a sample past the bound — the structural rule the whole precompute exists under", () => {
    expect(syntheticCrowdTerritorySampleAtOrBefore(table, 19)?.sequence).toBe(10);
    expect(syntheticCrowdTerritorySampleAtOrBefore(table, 9)?.sequence).toBe(0);
    expect(syntheticCrowdTerritorySampleAtOrBefore(table, -1)).toBeNull();
  });

  test("null before released content reaches the table's first sample, or on an empty table", () => {
    expect(syntheticCrowdTerritorySampleAtOrBefore({ samples: [] }, 100)).toBeNull();
  });
});
