import { describe, expect, it } from "vitest";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import { Game, PlayerInfo, PlayerType } from "../../src/core/game/Game";
import {
  assignSpawnSlots,
  DEFAULT_SPAWN_QUALITY_FLOOR,
  selectSpawnSlots,
  spawnSlotForRosterIndex,
  validateSpawnSlotLegality,
  validateSpawnSlotUniqueness,
} from "../../src/server/agents/AgentSpawnAssignment";
import { buildSpawnCandidates, SpawnCandidate } from "../../src/server/agents/LegalActionBuilder";
import { setup } from "../util/Setup";

function candidate(
  tile: number,
  x: number,
  y: number,
  localLandScore = 1,
): SpawnCandidate {
  // Fairness selection (selectSpawnSlots/assignSpawnSlots) never reads
  // pressure/safety/diplomacy/opportunity - only localLandScore + x/y - so
  // these are neutral placeholders, not meaningful test inputs.
  return {
    tile,
    x,
    y,
    localLandScore,
    pressureScore: 0,
    safetyScore: 0,
    diplomacyScore: 0,
    opportunityScore: 0,
  };
}

describe("selectSpawnSlots", () => {
  it("selects exactly slotCount candidates, all drawn from the input pool (candidate validity)", async () => {
    const game = await setup("half_land_half_ocean");
    const pool = buildSpawnCandidates(game.map(), { maxCandidates: 500 });
    const slots = selectSpawnSlots(pool, 4);

    expect(slots).toHaveLength(4);
    const poolTiles = new Set(pool.map((c) => c.tile));
    for (const slot of slots) {
      expect(poolTiles.has(slot.tile)).toBe(true);
    }
    // Stable output order: ascending tile ID, independent of selection order.
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].tile).toBeGreaterThan(slots[i - 1].tile);
    }
  });

  it("filters out candidates below the quality floor before spacing", () => {
    const pool = [
      candidate(1, 0, 0, 0.1), // below default floor (0.5)
      candidate(2, 10, 0, 0.4), // below default floor
      candidate(3, 20, 0, 0.6),
      candidate(4, 30, 0, 0.7),
      candidate(5, 40, 0, 0.8),
    ];
    const slots = selectSpawnSlots(pool, 3);
    const tiles = new Set(slots.map((s) => s.tile));
    expect(tiles.has(1)).toBe(false);
    expect(tiles.has(2)).toBe(false);
    expect(slots).toHaveLength(3);
  });

  it("respects a custom qualityFloor option", () => {
    const pool = [
      candidate(1, 0, 0, 0.55),
      candidate(2, 10, 0, 0.55),
      candidate(3, 20, 0, 0.55),
    ];
    // Default floor (0.5) would accept all three.
    expect(selectSpawnSlots(pool, 3)).toHaveLength(3);
    // A stricter floor rejects all of them.
    expect(() => selectSpawnSlots(pool, 3, { qualityFloor: 0.6 })).toThrow(
      /only 0 candidate\(s\) pass the quality floor/,
    );
  });

  it("throws a specific, actionable error when too few candidates pass the floor (insufficient qualifying slots)", () => {
    const pool = [candidate(1, 0, 0, 0.9), candidate(2, 10, 0, 0.9)];
    expect(() => selectSpawnSlots(pool, 5)).toThrow(
      /only 2 candidate\(s\) pass the quality floor \(localLandScore >= 0\.5\) out of 2 offered, but 5 slot\(s\) are required/,
    );
  });

  it("never silently returns fewer than slotCount candidates or an unfiltered pool", () => {
    const pool = [candidate(1, 0, 0, 0.9)];
    expect(() => selectSpawnSlots(pool, 2)).toThrow();
  });

  it("picks the highest-localLandScore candidate as the deterministic first seed", () => {
    const pool = [
      candidate(1, 0, 0, 0.6),
      candidate(2, 100, 100, 0.95), // best quality, should seed first
      candidate(3, 50, 50, 0.7),
    ];
    const slots = selectSpawnSlots(pool, 1);
    expect(slots[0].tile).toBe(2);
  });

  it("breaks a first-seed quality tie by the lowest tile ID", () => {
    const pool = [
      candidate(30, 0, 0, 0.9),
      candidate(10, 100, 0, 0.9), // identical top score, lower tile ID
      candidate(20, 50, 50, 0.9),
    ];
    const slots = selectSpawnSlots(pool, 1);
    expect(slots[0].tile).toBe(10);
  });

  it("greedily maximizes distance to the nearest already-selected slot (maximin)", () => {
    // Seed will be tile 2 (highest score). Tile 1 and tile 3 are both far
    // from the seed; tile 1 is farther (distance 100 vs 60), so it must be
    // selected next.
    const pool = [
      candidate(1, -100, 0, 0.7), // distance 100 from seed
      candidate(2, 0, 0, 0.95), // seed (best score)
      candidate(3, 60, 0, 0.7), // distance 60 from seed
      candidate(4, 10, 0, 0.6), // distance 10 from seed - never picked
    ];
    const slots = selectSpawnSlots(pool, 2);
    const tiles = slots.map((s) => s.tile).sort((a, b) => a - b);
    expect(tiles).toEqual([1, 2]);
  });

  it("breaks a maximin distance tie by the lowest tile ID", () => {
    // Seed at (0,0). Tiles 10 and 20 are BOTH exactly distance 50 away
    // (symmetric on either side) - the tie must resolve to the lower tile ID.
    const pool = [
      candidate(1, 0, 0, 0.9), // seed
      candidate(20, 50, 0, 0.7),
      candidate(10, -50, 0, 0.7),
    ];
    const slots = selectSpawnSlots(pool, 2);
    const tiles = slots.map((s) => s.tile).sort((a, b) => a - b);
    expect(tiles).toEqual([1, 10]);
  });

  it("throws if a qualifying candidate is missing x/y coordinates", () => {
    const pool: SpawnCandidate[] = [
      { tile: 1, localLandScore: 0.9 } as SpawnCandidate,
    ];
    expect(() => selectSpawnSlots(pool, 1)).toThrow(
      /candidate at tile 1 is missing x\/y coordinates/,
    );
  });

  it("throws on a non-positive slotCount", () => {
    expect(() => selectSpawnSlots([candidate(1, 0, 0)], 0)).toThrow(
      /slotCount must be a positive integer/,
    );
    expect(() => selectSpawnSlots([candidate(1, 0, 0)], -1)).toThrow(
      /slotCount must be a positive integer/,
    );
  });

  it("DEFAULT_SPAWN_QUALITY_FLOOR matches the documented default (0.5)", () => {
    expect(DEFAULT_SPAWN_QUALITY_FLOOR).toBe(0.5);
  });
});

describe("spawnSlotForRosterIndex", () => {
  const slots = [candidate(1, 0, 0), candidate(2, 10, 0), candidate(3, 20, 0)];

  it("assigns roster index i to slots[i] when episodeIndex is 0", () => {
    expect(spawnSlotForRosterIndex(slots, 0, 0).tile).toBe(1);
    expect(spawnSlotForRosterIndex(slots, 1, 0).tile).toBe(2);
    expect(spawnSlotForRosterIndex(slots, 2, 0).tile).toBe(3);
  });

  it("rotates via (rosterIndex + episodeIndex) % N", () => {
    expect(spawnSlotForRosterIndex(slots, 0, 1).tile).toBe(2);
    expect(spawnSlotForRosterIndex(slots, 1, 1).tile).toBe(3);
    expect(spawnSlotForRosterIndex(slots, 2, 1).tile).toBe(1);
  });

  it("wraps episodeIndex values larger than N", () => {
    expect(spawnSlotForRosterIndex(slots, 0, 4)).toEqual(
      spawnSlotForRosterIndex(slots, 0, 1),
    );
  });

  it("rotates every roster position through every slot exactly once across N consecutive episodes (exact cyclic assignment)", () => {
    const n = slots.length;
    for (let rosterIndex = 0; rosterIndex < n; rosterIndex++) {
      const visited = new Set<number>();
      for (let episodeIndex = 0; episodeIndex < n; episodeIndex++) {
        visited.add(spawnSlotForRosterIndex(slots, rosterIndex, episodeIndex).tile);
      }
      expect(visited.size).toBe(n);
      expect(visited).toEqual(new Set(slots.map((s) => s.tile)));
    }
  });

  it("throws on an empty slot list", () => {
    expect(() => spawnSlotForRosterIndex([], 0, 0)).toThrow(
      /slots must be non-empty/,
    );
  });

  it("throws on a negative or non-integer rosterIndex", () => {
    expect(() => spawnSlotForRosterIndex(slots, -1, 0)).toThrow(
      /rosterIndex must be a non-negative integer/,
    );
    expect(() => spawnSlotForRosterIndex(slots, 1.5, 0)).toThrow(
      /rosterIndex must be a non-negative integer/,
    );
  });

  it("throws on a negative or non-integer episodeIndex", () => {
    expect(() => spawnSlotForRosterIndex(slots, 0, -1)).toThrow(
      /episodeIndex must be a non-negative integer/,
    );
    expect(() => spawnSlotForRosterIndex(slots, 0, 1.5)).toThrow(
      /episodeIndex must be a non-negative integer/,
    );
  });
});

describe("assignSpawnSlots", () => {
  const pool = [
    candidate(1, 0, 0, 0.9),
    candidate(2, 100, 0, 0.9),
    candidate(3, 0, 100, 0.9),
    candidate(4, 100, 100, 0.9),
  ];

  it("returns one assignment per participant, in roster order", () => {
    const assignment = assignSpawnSlots({
      candidates: pool,
      participantCount: 4,
      episodeIndex: 0,
    });
    expect(assignment).toHaveLength(4);
    expect(new Set(assignment.map((c) => c.tile)).size).toBe(4);
  });

  it("is invariant to the ORDER of the input candidate array (roster-order permutation of the pool)", () => {
    const shuffled = [pool[3], pool[1], pool[0], pool[2]];
    const a = assignSpawnSlots({ candidates: pool, participantCount: 4, episodeIndex: 0 });
    const b = assignSpawnSlots({ candidates: shuffled, participantCount: 4, episodeIndex: 0 });
    expect(a.map((c) => c.tile)).toEqual(b.map((c) => c.tile));
  });

  it("produces a genuinely different roster<->slot mapping for a different episodeIndex, while every roster position visits every slot across N episodes", () => {
    const byEpisode = [0, 1, 2, 3].map((episodeIndex) =>
      assignSpawnSlots({ candidates: pool, participantCount: 4, episodeIndex }).map(
        (c) => c.tile,
      ),
    );
    expect(byEpisode[0]).not.toEqual(byEpisode[1]);
    for (let rosterIndex = 0; rosterIndex < 4; rosterIndex++) {
      const visited = new Set(byEpisode.map((tiles) => tiles[rosterIndex]));
      expect(visited.size).toBe(4);
    }
  });

  it("defaults episodeIndex to 0 when omitted", () => {
    const withDefault = assignSpawnSlots({ candidates: pool, participantCount: 4 });
    const explicit = assignSpawnSlots({
      candidates: pool,
      participantCount: 4,
      episodeIndex: 0,
    });
    expect(withDefault.map((c) => c.tile)).toEqual(explicit.map((c) => c.tile));
  });
});

describe("validateSpawnSlotUniqueness", () => {
  it("passes silently for pairwise-distinct tiles", () => {
    expect(() =>
      validateSpawnSlotUniqueness(
        [candidate(1, 0, 0), candidate(2, 1, 1)],
        ["agent-a", "agent-b"],
      ),
    ).not.toThrow();
  });

  it("throws immediately, naming both agents and the tile, on a duplicate", () => {
    expect(() =>
      validateSpawnSlotUniqueness(
        [candidate(5, 0, 0), candidate(5, 0, 0)],
        ["agent-a", "agent-b"],
      ),
    ).toThrow(/tile 5 is assigned to both agent-a and agent-b/);
  });
});

describe("validateSpawnSlotLegality", () => {
  async function spawnOnePlayer(game: Game, tile: number): Promise<void> {
    const info = new PlayerInfo("seed", PlayerType.Human, "seed_client", "seed_id");
    game.addExecution(new SpawnExecution("game_id", info, tile));
    while (game.inSpawnPhase() && game.playerByClientID("seed_client") === null) {
      game.executeNextTick();
    }
    if (game.inSpawnPhase()) {
      game.executeNextTick();
    }
  }

  it("passes silently for authoritatively-valid, currently-unclaimed tiles", async () => {
    const game = await setup("half_land_half_ocean");
    const pool = buildSpawnCandidates(game.map(), { maxCandidates: 10 });
    expect(() =>
      validateSpawnSlotLegality([pool[0]], ["agent-a"], game),
    ).not.toThrow();
  });

  it("throws naming the agent/tile/reason when a tile is already occupied", async () => {
    const game = await setup("half_land_half_ocean");
    const pool = buildSpawnCandidates(game.map(), { maxCandidates: 10 });
    const seedTile = pool[0].tile;
    await spawnOnePlayer(game, seedTile);
    expect(game.hasOwner(seedTile)).toBe(true);

    expect(() =>
      validateSpawnSlotLegality([pool[0]], ["agent-a"], game),
    ).toThrow(/agent agent-a's assigned tile \d+ is already occupied/);
  });

  it("throws when the tile is water", async () => {
    const game = await setup("half_land_half_ocean");
    let waterTile: number | null = null;
    game.forEachTile((tile) => {
      if (waterTile === null && !game.isLand(tile)) {
        waterTile = tile;
      }
    });
    expect(waterTile).not.toBeNull();
    expect(() =>
      validateSpawnSlotLegality(
        [candidate(waterTile!, game.x(waterTile!), game.y(waterTile!), 0)],
        ["agent-a"],
        game,
      ),
    ).toThrow(/agent agent-a's assigned tile \d+ is not land/);
  });
});

describe("assignSpawnSlots over a real map, participant counts 2..8 at the default quality floor", () => {
  // big_plains: the same fast (200x200, mostly-land) fixture AgentLeagueMatch.test.ts already
  // uses for its own spawn-phase coverage - real terrain/coastline geometry, not synthetic
  // candidates, while staying well within a normal vitest budget.
  it.each([2, 3, 4, 5, 6, 7, 8])(
    "assigns %i participants exactly that many distinct, quality-floored, legal slots",
    async (participantCount) => {
      const game = await setup("big_plains");
      const pool = buildSpawnCandidates(game.map(), { maxCandidates: 500 });
      const agentIDs = Array.from(
        { length: participantCount },
        (_, i) => `agent-${i}`,
      );

      const assignment = assignSpawnSlots({
        candidates: pool,
        participantCount,
        episodeIndex: 0,
      });

      expect(assignment).toHaveLength(participantCount);
      expect(new Set(assignment.map((c) => c.tile)).size).toBe(participantCount);
      for (const slot of assignment) {
        expect(slot.localLandScore ?? 0).toBeGreaterThanOrEqual(
          DEFAULT_SPAWN_QUALITY_FLOOR,
        );
      }
      expect(() =>
        validateSpawnSlotUniqueness(assignment, agentIDs),
      ).not.toThrow();
      expect(() =>
        validateSpawnSlotLegality(assignment, agentIDs, game),
      ).not.toThrow();
    },
  );
});
