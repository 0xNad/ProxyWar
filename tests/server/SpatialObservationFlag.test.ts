import { afterEach, describe, expect, it, vi } from "vitest";
import { AttackExecution } from "../../src/core/execution/AttackExecution";
import {
  Game,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import {
  createAgentSpatialSnapshot,
  resetSpatialObservationEmissionCount,
  SPATIAL_MINIMAP_HEIGHT,
  SPATIAL_MINIMAP_WIDTH,
  SPATIAL_NOTE_PREFIX,
  SPATIAL_REGION_RUN_BUDGET,
  SPATIAL_REGION_TILE_BUDGET,
  SPATIAL_VISIBILITY_MODEL,
  spatialObservationEmissionCount,
} from "../../src/server/agents/AgentSpatialObservation";
import type {
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import { LlmPromptBuilder } from "../../src/server/agents/LlmPromptBuilder";
import { setup } from "../util/Setup";

const SPATIAL_FLAG = "PROXYWAR_TUNE_SPATIAL_OBSERVATION";
const MINIMAP_FLAG = "PROXYWAR_TUNE_SPATIAL_MINIMAP";

const PLAYERS = [
  new PlayerInfo("Agent", PlayerType.Human, "CLNT_AGENT", "P_AGENT"),
  new PlayerInfo("Rival A", PlayerType.Human, "CLNT_A", "P_A"),
  new PlayerInfo("Rival B", PlayerType.Human, "CLNT_B", "P_B"),
  new PlayerInfo("Rival C", PlayerType.Human, "CLNT_C", "P_C"),
];

const HOLD_ACTIONS: LegalAction[] = [
  {
    id: "hold",
    kind: "hold",
    label: "Hold this turn",
    intent: null,
    risk: { level: "none", score: 0 },
  },
];

async function shapedGame(): Promise<Game> {
  const game = await setup(
    "plains",
    { nations: "disabled", instantBuild: true },
    PLAYERS,
  );
  conquerRectangle(game, "P_AGENT", 20, 20, 59, 59);
  conquerRectangle(game, "P_A", 60, 20, 79, 59);
  conquerRectangle(game, "P_B", 20, 60, 59, 79);
  conquerRectangle(game, "P_C", 80, 20, 99, 59);
  while (game.inSpawnPhase()) game.executeNextTick();

  const post = game
    .player("P_AGENT")
    .buildUnit(UnitType.DefensePost, game.ref(55, 20), {});
  post.setUnderConstruction(false);
  return game;
}

function conquerRectangle(
  game: Game,
  playerID: string,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): void {
  const player = game.player(playerID);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      player.conquer(game.ref(x, y));
    }
  }
}

function observe(
  game: Game,
  player: PlayerInfo = PLAYERS[0],
  builder = new AgentObservationBuilder(),
): AgentObservation {
  return builder.build({
    agentID: `agent-${player.id}`,
    clientID: player.clientID,
    username: player.name,
    profile: "aggressive",
    gameID: "SPATIAL_OBSERVATION",
    turnNumber: game.ticks(),
    gameState: game,
  });
}

function stripSpatialAdditions(parsed: AgentObservation): AgentObservation {
  delete parsed.spatial;
  for (const rival of parsed.visiblePlayers) {
    delete rival.bearing;
    delete rival.distanceClass;
    delete rival.borderWithYou;
    delete rival.bordersWith;
  }
  parsed.notes = parsed.notes.filter(
    (note) => !note.startsWith(SPATIAL_NOTE_PREFIX),
  );
  return parsed;
}

function promptObservation(prompt: string): Record<string, unknown> {
  const lines = prompt.split("\n");
  const marker = lines.indexOf("OBSERVATION_JSON:");
  expect(marker).toBeGreaterThanOrEqual(0);
  return JSON.parse(lines[marker + 1]) as Record<string, unknown>;
}

describe("spatial observation flags", () => {
  afterEach(() => {
    delete process.env[SPATIAL_FLAG];
    delete process.env[MINIMAP_FLAG];
  });

  it("counts only observations that actually carried a spatial block", async () => {
    const game = await shapedGame();
    resetSpatialObservationEmissionCount();

    observe(game);
    expect(spatialObservationEmissionCount()).toBe(0);

    process.env[SPATIAL_FLAG] = "1";
    observe(game);
    observe(game);
    expect(spatialObservationEmissionCount()).toBe(2);

    // A seat with no land emits nothing even with the flag on, so the count
    // tracks real emission rather than the flag reading.
    const landless = new PlayerInfo(
      "Landless",
      PlayerType.Human,
      "CLNT_NONE",
      "P_NONE",
    );
    game.addPlayer(landless);
    const landlessObservation = observe(game, landless);
    // Assert the seat was actually resolved before asserting it emitted
    // nothing, so this cannot pass because the player lookup silently failed.
    expect(landlessObservation.ownState).not.toBeNull();
    expect(landlessObservation.ownState?.tilesOwned).toBe(0);
    expect(landlessObservation.spatial).toBeUndefined();
    expect(spatialObservationEmissionCount()).toBe(2);
  });

  it("keeps serialized observations byte-identical when the parent flag is off", async () => {
    const game = await shapedGame();
    const baseline = JSON.stringify(observe(game));

    process.env[MINIMAP_FLAG] = "1";
    expect(JSON.stringify(observe(game))).toBe(baseline);

    process.env[SPATIAL_FLAG] = "0";
    expect(JSON.stringify(observe(game))).toBe(baseline);
  });

  it("keeps in-server prompt bytes identical when spatial is absent", async () => {
    const game = await shapedGame();
    const promptBuilder = new LlmPromptBuilder();
    const baseline = promptBuilder.build({
      observation: observe(game),
      legalActions: HOLD_ACTIONS,
    });

    process.env[MINIMAP_FLAG] = "1";
    expect(
      promptBuilder.build({
        observation: observe(game),
        legalActions: HOLD_ACTIONS,
      }),
    ).toBe(baseline);
  });

  it("fails closed on unknown spatial provenance in the in-server prompt", async () => {
    process.env[SPATIAL_FLAG] = "1";
    process.env[MINIMAP_FLAG] = "1";
    const observation = observe(await shapedGame());
    expect(observation.spatial).toBeDefined();
    (observation.spatial as { visibilityModel?: string }).visibilityModel =
      "private-fog-bypass";

    const view = promptObservation(
      new LlmPromptBuilder().build({
        observation,
        legalActions: HOLD_ACTIONS,
      }),
    ) as {
      spatial?: unknown;
      visiblePlayers: Array<Record<string, unknown>>;
      notes: string[];
    };
    expect(view.spatial).toBeUndefined();
    for (const rival of view.visiblePlayers) {
      expect(rival).not.toHaveProperty("bearing");
      expect(rival).not.toHaveProperty("distanceClass");
      expect(rival).not.toHaveProperty("borderWithYou");
      expect(rival).not.toHaveProperty("bordersWith");
    }
    expect(
      view.notes.some((note) => note.startsWith(SPATIAL_NOTE_PREFIX)),
    ).toBe(false);
  });

  it("adds only the spatial block, rival fields, and bounded notes in Stage 1", async () => {
    const game = await shapedGame();
    const offJson = JSON.stringify(observe(game));

    process.env[SPATIAL_FLAG] = "1";
    const on = observe(game);
    expect(on.spatial).toBeDefined();
    expect(on.spatial?.visibilityModel).toBe(SPATIAL_VISIBILITY_MODEL);
    expect(on.spatial?.minimap).toBeUndefined();
    expect(
      on.notes.filter((note) => note.startsWith(SPATIAL_NOTE_PREFIX)),
    ).toHaveLength(3);

    const stripped = stripSpatialAdditions(
      JSON.parse(JSON.stringify(on)) as AgentObservation,
    );
    expect(JSON.stringify(stripped)).toBe(offJson);
  });

  it("computes exact shape, exposure, defense, bearing, and rival-rival borders", async () => {
    process.env[SPATIAL_FLAG] = "1";
    const observation = observe(await shapedGame());
    expect(observation.spatial?.ownShape).toMatchObject({
      quadrant: "center",
      compactness: "compact",
      regionCount: 1,
      largestRegionShare: 100,
      regionAnalysis: "complete",
      centroidBasis: "largest_region_border",
      coastShare: 0,
    });

    const rivalA = observation.visiblePlayers.find(
      (rival) => rival.playerID === "P_A",
    );
    const rivalB = observation.visiblePlayers.find(
      (rival) => rival.playerID === "P_B",
    );
    expect(rivalA).toMatchObject({
      bearing: "east",
      distanceClass: "adjacent",
      borderWithYou: {
        tiles: 40,
        shareOfYourBorder: 51,
        terrain: "land",
        defensePostsCovering: 1,
        underAttackHere: false,
      },
      bordersWith: [{ playerID: "P_C", sizeClass: "major" }],
    });
    expect(rivalB).toMatchObject({
      bearing: "south",
      distanceClass: "adjacent",
      borderWithYou: {
        tiles: 40,
        shareOfYourBorder: 51,
        defensePostsCovering: 0,
      },
      bordersWith: [],
    });
  });

  it("marks and ranks a live incoming attack on the shared rival border", async () => {
    process.env[SPATIAL_FLAG] = "1";
    const game = await shapedGame();
    game.addExecution(
      new AttackExecution(100, game.player("P_A"), game.player("P_AGENT").id()),
    );
    game.executeNextTick();

    const observation = observe(game);
    const rivalA = observation.visiblePlayers.find(
      (rival) => rival.playerID === "P_A",
    );
    expect(rivalA?.borderWithYou?.underAttackHere).toBe(true);
    expect(
      observation.notes.find((note) => note.startsWith(SPATIAL_NOTE_PREFIX)),
    ).toContain("Rival A");
    expect(observation.notes.join("\n")).toContain("active incoming attack");
  });

  it("renders the exact separately gated 24x12 minimap and stable legend", async () => {
    process.env[SPATIAL_FLAG] = "1";
    process.env[MINIMAP_FLAG] = "1";
    const minimap = observe(await shapedGame()).spatial?.minimap;
    expect(minimap).toMatchObject({
      schemaVersion: 1,
      width: SPATIAL_MINIMAP_WIDTH,
      height: SPATIAL_MINIMAP_HEIGHT,
    });
    expect(minimap?.rows).toHaveLength(SPATIAL_MINIMAP_HEIGHT);
    expect(
      minimap?.rows.every((row) => row.length === SPATIAL_MINIMAP_WIDTH),
    ).toBe(true);
    expect(
      minimap?.legend.map(({ glyph, playerID, isYou }) => ({
        glyph,
        playerID,
        isYou,
      })),
    ).toEqual([
      { glyph: "A", playerID: "P_AGENT", isYou: true },
      { glyph: "B", playerID: "P_A", isYou: false },
      { glyph: "C", playerID: "P_B", isYou: false },
      { glyph: "D", playerID: "P_C", isYou: false },
    ]);
  });

  it("resolves minimap ties by player smallID, then neutral, then water", async () => {
    const first = new PlayerInfo(
      "First",
      PlayerType.Human,
      "CLNT_FIRST",
      "P_FIRST",
    );
    const second = new PlayerInfo(
      "Second",
      PlayerType.Human,
      "CLNT_SECOND",
      "P_SECOND",
    );
    const plains = await setup("plains", { nations: "disabled" }, [
      first,
      second,
    ]);
    const plainsCell: number[] = [];
    const plainsXEnd = Math.floor(plains.width() / SPATIAL_MINIMAP_WIDTH);
    const plainsYEnd = Math.floor(plains.height() / SPATIAL_MINIMAP_HEIGHT);
    for (let y = 0; y < plainsYEnd; y++) {
      for (let x = 0; x < plainsXEnd; x++) {
        plainsCell.push(plains.ref(x, y));
      }
    }
    expect(plainsCell.length % 2).toBe(0);
    plainsCell.slice(0, plainsCell.length / 2).forEach((tile) => {
      plains.player(first.id).conquer(tile);
    });
    plainsCell.slice(plainsCell.length / 2).forEach((tile) => {
      plains.player(second.id).conquer(tile);
    });
    expect(createAgentSpatialSnapshot(plains, true).minimap?.rows[0][0]).toBe(
      "A",
    );

    const coastPlayer = new PlayerInfo(
      "Coast",
      PlayerType.Human,
      "CLNT_COAST",
      "P_COAST",
    );
    const world = await setup("world", { nations: "disabled" }, [coastPlayer]);
    let tieCell:
      | { cx: number; cy: number; landTiles: number[]; waterCount: number }
      | undefined;
    for (let cy = 0; cy < SPATIAL_MINIMAP_HEIGHT && !tieCell; cy++) {
      for (let cx = 0; cx < SPATIAL_MINIMAP_WIDTH && !tieCell; cx++) {
        const landTiles: number[] = [];
        let waterCount = 0;
        const xStart = Math.floor((cx * world.width()) / SPATIAL_MINIMAP_WIDTH);
        const xEnd = Math.floor(
          ((cx + 1) * world.width()) / SPATIAL_MINIMAP_WIDTH,
        );
        const yStart = Math.floor(
          (cy * world.height()) / SPATIAL_MINIMAP_HEIGHT,
        );
        const yEnd = Math.floor(
          ((cy + 1) * world.height()) / SPATIAL_MINIMAP_HEIGHT,
        );
        for (let y = yStart; y < yEnd; y++) {
          for (let x = xStart; x < xEnd; x++) {
            const tile = world.ref(x, y);
            if (world.isWater(tile)) waterCount += 1;
            else landTiles.push(tile);
          }
        }
        if (
          waterCount > 0 &&
          landTiles.length >= waterCount &&
          landTiles.length - waterCount < waterCount
        ) {
          tieCell = { cx, cy, landTiles, waterCount };
        }
      }
    }
    expect(tieCell).toBeDefined();
    const cell = tieCell!;
    const player = world.player(coastPlayer.id);
    const neutralWaterTiePlayerTiles = cell.landTiles.length - cell.waterCount;
    cell.landTiles
      .slice(0, neutralWaterTiePlayerTiles)
      .forEach((tile) => player.conquer(tile));
    expect(
      createAgentSpatialSnapshot(world, true).minimap?.rows[cell.cy][cell.cx],
    ).toBe(".");

    cell.landTiles
      .slice(neutralWaterTiePlayerTiles, cell.waterCount)
      .forEach((tile) => player.conquer(tile));
    expect(
      createAgentSpatialSnapshot(world, true).minimap?.rows[cell.cy][cell.cx],
    ).toBe("A");
  });

  it("pins unequal components and stable equal-size largest-region centroids", async () => {
    const unequal = new PlayerInfo(
      "Unequal",
      PlayerType.Human,
      "CLNT_UNEQUAL",
      "P_UNEQUAL",
    );
    const equal = new PlayerInfo(
      "Equal",
      PlayerType.Human,
      "CLNT_EQUAL",
      "P_EQUAL",
    );
    const game = await setup("plains", { nations: "disabled" }, [
      unequal,
      equal,
    ]);
    conquerRectangle(game, unequal.id, 10, 10, 13, 13);
    conquerRectangle(game, unequal.id, 20, 20, 21, 21);
    conquerRectangle(game, equal.id, 70, 70, 71, 71);
    conquerRectangle(game, equal.id, 80, 80, 81, 81);

    const snapshot = createAgentSpatialSnapshot(game, false);
    expect(snapshot.geometryByPlayerID.get(unequal.id)?.ownShape).toMatchObject(
      {
        compactness: "fragmented",
        regionCount: 2,
        largestRegionShare: 80,
        centroidBasis: "largest_region_border",
        centroid: { xPct: 12, yPct: 12 },
      },
    );
    expect(snapshot.geometryByPlayerID.get(equal.id)?.ownShape).toMatchObject({
      compactness: "fragmented",
      regionCount: 2,
      largestRegionShare: 50,
      centroidBasis: "largest_region_border",
      centroid: { xPct: 71, yPct: 71 },
    });
  });

  it("renders sanitized spatial fields through the in-server prompt", async () => {
    process.env[SPATIAL_FLAG] = "1";
    process.env[MINIMAP_FLAG] = "1";
    const observation = observe(await shapedGame());
    observation.notes.push("Spatial exposure 3:\u0000 unsafe bytes");
    const prompt = new LlmPromptBuilder().build({
      observation,
      legalActions: HOLD_ACTIONS,
    });
    expect(prompt).toContain('"spatial":{"schemaVersion":1');
    expect(prompt).toContain('"minimap":{"schemaVersion":1');
    expect(prompt).not.toContain("\\u0000");
    expect(prompt).not.toContain("\\u200b");
  });

  it("omits every spatial field for a no-land observer", async () => {
    process.env[SPATIAL_FLAG] = "1";
    process.env[MINIMAP_FLAG] = "1";
    const game = await shapedGame();
    const player = game.player("P_AGENT");
    for (const tile of player.tiles()) player.relinquish(tile);

    const observation = observe(game);
    expect(observation.spatial).toBeUndefined();
    for (const rival of observation.visiblePlayers) {
      expect(rival.bearing).toBeUndefined();
      expect(rival.distanceClass).toBeUndefined();
      expect(rival.borderWithYou).toBeUndefined();
      expect(rival.bordersWith).toBeUndefined();
    }
  });

  it("recomputes outside batches after same-tick territory mutation", async () => {
    process.env[SPATIAL_FLAG] = "1";
    const game = await shapedGame();
    const tick = game.ticks();
    expect(observe(game).spatial?.ownShape.regionCount).toBe(1);

    const island = game.ref(game.width() - 10, game.height() - 10);
    expect(game.isLand(island)).toBe(true);
    game.player("P_AGENT").conquer(island);
    expect(game.ticks()).toBe(tick);
    expect(observe(game).spatial?.ownShape.regionCount).toBe(2);
  });

  it("shares one geometry build per synchronous observation batch", async () => {
    process.env[SPATIAL_FLAG] = "1";
    const game = await shapedGame();
    const builder = new AgentObservationBuilder();
    const ownerID = vi.spyOn(game, "ownerID");
    createAgentSpatialSnapshot(game, false);
    const callsPerSnapshot = ownerID.mock.calls.length;
    ownerID.mockClear();

    builder.withObservationBatch(game, () => {
      for (const player of PLAYERS) observe(game, player, builder);
    });
    const batched = ownerID.mock.calls.length;

    ownerID.mockClear();
    for (const player of PLAYERS) observe(game, player, builder);
    const unbatched = ownerID.mock.calls.length;
    expect(unbatched - batched).toBe((PLAYERS.length - 1) * callsPerSnapshot);
  });

  it("keeps deterministic work bounded and skips minimap scanning in Stage 1", async () => {
    const game = await shapedGame();
    const snapshot = createAgentSpatialSnapshot(game, false);
    const totalBorders = game
      .players()
      .reduce((sum, player) => sum + player.borderTiles().size, 0);
    const totalTiles = game
      .players()
      .reduce((sum, player) => sum + player.numTilesOwned(), 0);
    expect(snapshot.metrics).toEqual({
      borderTilesVisited: totalBorders,
      regionTilesVisited: totalTiles,
      regionMapTilesScanned: game.width() * game.height(),
      regionRunsCreated: expect.any(Number),
      regionRunBudgetExceeded: false,
      minimapTilesVisited: 0,
    });
    expect(snapshot.metrics.regionRunsCreated).toBeGreaterThan(0);
  });

  it("checks the region budget before copying a large player's tiles", async () => {
    const game = await shapedGame();
    const player = game.player("P_AGENT");
    vi.spyOn(player, "numTilesOwned").mockReturnValue(
      SPATIAL_REGION_TILE_BUDGET + 1,
    );
    const tiles = vi.spyOn(player, "tiles").mockImplementation(() => {
      throw new Error("large territory must not be copied");
    });

    const shape = createAgentSpatialSnapshot(
      game,
      false,
    ).geometryByPlayerID.get("P_AGENT")?.ownShape;
    expect(tiles).not.toHaveBeenCalled();
    expect(shape).toMatchObject({
      regionAnalysis: "omitted_budget",
      centroidBasis: "all_border_budget_fallback",
    });
    expect(shape?.compactness).toBeUndefined();
    expect(shape?.regionCount).toBeUndefined();
    expect(shape?.largestRegionShare).toBeUndefined();
  });

  it("omits exact region metrics before pathological run counts grow unbounded", async () => {
    const first = new PlayerInfo(
      "Checker A",
      PlayerType.Human,
      "CLNT_CHECK_A",
      "P_CHECK_A",
    );
    const second = new PlayerInfo(
      "Checker B",
      PlayerType.Human,
      "CLNT_CHECK_B",
      "P_CHECK_B",
    );
    const game = await setup("big_plains", { nations: "disabled" }, [
      first,
      second,
    ]);
    for (let y = 0; y < game.height(); y++) {
      for (let x = 0; x < game.width(); x++) {
        const player = (x + y) % 2 === 0 ? first : second;
        game.player(player.id).conquer(game.ref(x, y));
      }
    }

    const snapshot = createAgentSpatialSnapshot(game, false);
    expect(snapshot.metrics.regionRunBudgetExceeded).toBe(true);
    expect(snapshot.metrics.regionRunsCreated).toBe(SPATIAL_REGION_RUN_BUDGET);
    expect(snapshot.metrics.regionMapTilesScanned).toBeLessThanOrEqual(
      game.width() * game.height(),
    );
    for (const player of [first, second]) {
      expect(
        snapshot.geometryByPlayerID.get(player.id)?.ownShape,
      ).toMatchObject({
        regionAnalysis: "omitted_budget",
        centroidBasis: "all_border_budget_fallback",
      });
    }
  });
});
