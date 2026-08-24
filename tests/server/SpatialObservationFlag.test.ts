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
  SPATIAL_MINIMAP_LARGE_HEIGHT,
  SPATIAL_MINIMAP_LARGE_TILE_THRESHOLD,
  SPATIAL_MINIMAP_LARGE_WIDTH,
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
  delete parsed.mapInfo;
  for (const rival of parsed.visiblePlayers) {
    delete rival.bearing;
    delete rival.distanceClass;
    delete rival.borderWithYou;
    delete rival.bordersWith;
    delete rival.navalExposure;
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
    expect(landlessObservation.mapInfo).toMatchObject({
      width: game.width(),
      height: game.height(),
      tileRefEncoding: "row-major-y-width-plus-x",
    });
    const landlessPrompt = promptObservation(
      new LlmPromptBuilder().build({
        observation: landlessObservation,
        legalActions: HOLD_ACTIONS,
      }),
    );
    expect(landlessPrompt.mapInfo).toEqual(landlessObservation.mapInfo);
    expect(landlessPrompt.spatial).toBeUndefined();
    const mapInfo = landlessObservation.mapInfo!;
    for (const [tile, x, y] of [
      [0, 0, 0],
      [mapInfo.width - 1, mapInfo.width - 1, 0],
      [(mapInfo.height - 1) * mapInfo.width, 0, mapInfo.height - 1],
      [
        mapInfo.width * mapInfo.height - 1,
        mapInfo.width - 1,
        mapInfo.height - 1,
      ],
    ] as const) {
      expect(tile % mapInfo.width).toBe(x);
      expect(Math.floor(tile / mapInfo.width)).toBe(y);
      expect(y * mapInfo.width + x).toBe(tile);
    }

    const noGameObservation = new AgentObservationBuilder().build({
      agentID: "agent-no-game",
      clientID: null,
      username: "No game",
      profile: "aggressive",
      gameID: "NO_GAME",
      turnNumber: 0,
    });
    expect(noGameObservation.mapInfo).toBeUndefined();
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

  it("fails closed on malformed coordinate, asset, and terrain invariants in the in-server prompt", async () => {
    process.env[SPATIAL_FLAG] = "1";
    process.env[MINIMAP_FLAG] = "1";
    const observation = observe(await shapedGame());
    const badFrame = structuredClone(observation);
    const badFrameMapInfo = badFrame.mapInfo!;
    badFrameMapInfo.coordinateFrame.origin =
      "bottom_left" as typeof badFrameMapInfo.coordinateFrame.origin;
    const badAsset = structuredClone(observation);
    badAsset.spatial!.positionedAssets.structures[0].tile += 1;
    const badTerrain = structuredClone(observation);
    badTerrain.visiblePlayers.find(
      (player) => player.borderWithYou !== undefined,
    )!.borderWithYou!.terrainBreakdown.plains += 1;
    const inconsistentTerrainClass = structuredClone(observation);
    const inconsistentTerrainBorder =
      inconsistentTerrainClass.visiblePlayers.find(
        (player) => player.borderWithYou !== undefined,
      )!.borderWithYou!;
    inconsistentTerrainBorder.terrain = "land";
    inconsistentTerrainBorder.terrainBreakdown.shore = 1;
    const inconsistentDefenseCoverage = structuredClone(observation);
    const inconsistentDefenseBorder =
      inconsistentDefenseCoverage.visiblePlayers.find(
        (player) => player.borderWithYou !== undefined,
      )!.borderWithYou!;
    inconsistentDefenseBorder.defensePostsCovering = 0;
    inconsistentDefenseBorder.defensePostFrontCoverage.covered = 1;
    inconsistentDefenseBorder.defensePostFrontCoverage.uncovered =
      inconsistentDefenseBorder.tiles - 1;
    const badShape = structuredClone(observation);
    badShape.spatial!.ownShape.coastShare = 101;
    const badEncirclement = structuredClone(observation);
    badEncirclement.spatial!.ownShape.largestNeighborBorderShare = 101;
    const inconsistentEncirclement = structuredClone(observation);
    inconsistentEncirclement.spatial!.ownShape.largestNeighborBorderShare = 0;
    const badWeightedEdge = structuredClone(observation);
    const weightedEdgePlayer = badWeightedEdge.visiblePlayers.find(
      (player) => (player.bordersWith?.length ?? 0) > 0,
    )!;
    weightedEdgePlayer.bordersWith![0].tiles = 0;
    const oversizedWeightedEdge = structuredClone(observation);
    const oversizedWeightedEdgePlayer =
      oversizedWeightedEdge.visiblePlayers.find(
        (player) => (player.bordersWith?.length ?? 0) > 0,
      )!;
    oversizedWeightedEdgePlayer.bordersWith![0].tiles = Number.MAX_SAFE_INTEGER;
    const badSelfEdge = structuredClone(observation);
    const selfEdgePlayer = badSelfEdge.visiblePlayers.find(
      (player) => (player.bordersWith?.length ?? 0) > 0,
    )!;
    selfEdgePlayer.bordersWith![0].playerID = selfEdgePlayer.playerID;
    const badDuplicateEdge = structuredClone(observation);
    const duplicateEdgePlayer = badDuplicateEdge.visiblePlayers.find(
      (player) => (player.bordersWith?.length ?? 0) > 0,
    )!;
    duplicateEdgePlayer.bordersWith!.push({
      ...duplicateEdgePlayer.bordersWith![0],
    });
    const asymmetricGraph = structuredClone(observation);
    const asymmetricSource = asymmetricGraph.visiblePlayers.find(
      (player) => (player.bordersWith?.length ?? 0) > 0,
    )!;
    const asymmetricTargetID = asymmetricSource.bordersWith![0].playerID;
    const asymmetricTarget = asymmetricGraph.visiblePlayers.find(
      (player) => player.playerID === asymmetricTargetID,
    )!;
    asymmetricTarget.bordersWith = asymmetricTarget.bordersWith!.filter(
      (edge) => edge.playerID !== asymmetricSource.playerID,
    );
    const badNaval = structuredClone(observation);
    badNaval.visiblePlayers[0].navalExposure!.transportReachableOwnShoreTiles =
      -1;
    const oversizedNaval = structuredClone(observation);
    oversizedNaval.visiblePlayers[0].navalExposure!.transportReachableOwnShoreTiles =
      Number.MAX_SAFE_INTEGER;
    const oversizedDirectBorder = structuredClone(observation);
    oversizedDirectBorder.visiblePlayers.find(
      (player) => player.borderWithYou !== undefined,
    )!.borderWithYou!.tiles = Number.MAX_SAFE_INTEGER;
    const emptyDirectBorder = structuredClone(observation);
    emptyDirectBorder.visiblePlayers.find(
      (player) => player.borderWithYou !== undefined,
    )!.borderWithYou!.tiles = 0;
    const oversizedDefensePostCount = structuredClone(observation);
    oversizedDefensePostCount.visiblePlayers.find(
      (player) => player.borderWithYou !== undefined,
    )!.borderWithYou!.defensePostsCovering = Number.MAX_SAFE_INTEGER;
    const missingDistanceClass = structuredClone(observation);
    delete missingDistanceClass.visiblePlayers[0].distanceClass;
    const missingWeightedGraph = structuredClone(observation);
    delete missingWeightedGraph.visiblePlayers[0].bordersWith;
    const falseOrdinaryBorder = structuredClone(observation);
    falseOrdinaryBorder.visiblePlayers.find(
      (player) => player.borderWithYou !== undefined,
    )!.sharesBorder = false;
    const missingDirectBorder = structuredClone(observation);
    const missingDirectBorderPlayer = missingDirectBorder.visiblePlayers.find(
      (player) => player.borderWithYou !== undefined,
    )!;
    missingDirectBorderPlayer.borderWithYou = undefined;
    missingDirectBorder.spatial!.ownShape.largestNeighborBorderShare = Math.max(
      0,
      ...missingDirectBorder.visiblePlayers.map(
        (player) => player.borderWithYou?.shareOfYourBorder ?? 0,
      ),
    );
    const nonAdjacentDirectBorder = structuredClone(observation);
    nonAdjacentDirectBorder.visiblePlayers.find(
      (player) => player.borderWithYou !== undefined,
    )!.distanceClass = "near";
    const badTotals = structuredClone(observation);
    badTotals.spatial!.positionedAssets.structuresTotal =
      Number.POSITIVE_INFINITY;
    const badPartial = structuredClone(observation);
    const partialSpatial: { positionedAssets?: unknown } = badPartial.spatial!;
    delete partialSpatial.positionedAssets;
    const badMinimap = structuredClone(observation);
    if (badMinimap.spatial!.minimap?.schemaVersion !== 2) {
      throw new Error("expected rich minimap v2");
    }
    badMinimap.spatial!.minimap.ownershipRows[0] = `?${badMinimap.spatial!.minimap.ownershipRows[0].slice(1)}`;
    const hiddenLegend = structuredClone(observation);
    hiddenLegend.spatial!.minimap!.legend[0].playerID = "P_HIDDEN";
    const wrongSelfLegend = structuredClone(observation);
    wrongSelfLegend.spatial!.minimap!.legend[0].isYou =
      !wrongSelfLegend.spatial!.minimap!.legend[0].isYou;
    const badTerrainMinimap = structuredClone(observation);
    const terrainMinimap = badTerrainMinimap.spatial!.minimap;
    if (terrainMinimap?.schemaVersion !== 2) {
      throw new Error("expected rich minimap v2");
    }
    terrainMinimap.terrainRows[0] = `X${terrainMinimap.terrainRows[0].slice(1)}`;
    const badMarkerOwner = structuredClone(observation);
    const markerMinimap = badMarkerOwner.spatial!.minimap;
    if (markerMinimap?.schemaVersion !== 2) {
      throw new Error("expected rich minimap v2");
    }
    markerMinimap.markers[0].ownerPlayerID = "P_HIDDEN";
    const wrongAdaptiveDimensions = structuredClone(observation);
    const wrongAdaptiveMinimap = wrongAdaptiveDimensions.spatial!.minimap;
    if (wrongAdaptiveMinimap?.schemaVersion !== 2) {
      throw new Error("expected rich minimap v2");
    }
    wrongAdaptiveMinimap.width = 32;
    wrongAdaptiveMinimap.height = 16;
    wrongAdaptiveMinimap.ownershipRows = Array.from({ length: 16 }, () =>
      ".".repeat(32),
    );
    wrongAdaptiveMinimap.terrainRows = Array.from({ length: 16 }, () =>
      ".".repeat(32),
    );
    const mismatchedMarkerTotal = structuredClone(observation);
    const mismatchedMarkerMinimap = mismatchedMarkerTotal.spatial!.minimap;
    if (mismatchedMarkerMinimap?.schemaVersion !== 2) {
      throw new Error("expected rich minimap v2");
    }
    mismatchedMarkerMinimap.markersTotal += 1;
    mismatchedMarkerMinimap.markersTruncated = true;
    const nullMinimap = structuredClone(observation);
    (nullMinimap.spatial as { minimap?: unknown }).minimap = null;
    const nullLegendEntry = structuredClone(observation);
    const nullLegendMinimap = nullLegendEntry.spatial!.minimap;
    if (nullLegendMinimap?.schemaVersion !== 2) {
      throw new Error("expected rich minimap v2");
    }
    (nullLegendMinimap.legend as unknown[])[0] = null;
    const nullMarkerEntry = structuredClone(observation);
    const nullMarkerMinimap = nullMarkerEntry.spatial!.minimap;
    if (nullMarkerMinimap?.schemaVersion !== 2) {
      throw new Error("expected rich minimap v2");
    }
    (nullMarkerMinimap.markers as unknown[])[0] = null;
    const arrayMarkerType = structuredClone(observation);
    const arrayMarkerMinimap = arrayMarkerType.spatial!.minimap;
    if (arrayMarkerMinimap?.schemaVersion !== 2) {
      throw new Error("expected rich minimap v2");
    }
    (arrayMarkerMinimap.markers[0] as { type: unknown }).type = ["D"];

    for (const [malformed, mapInfoExpected] of [
      [badFrame, false],
      [badAsset, true],
      [badTerrain, true],
      [inconsistentTerrainClass, true],
      [inconsistentDefenseCoverage, true],
      [badShape, true],
      [badEncirclement, true],
      [inconsistentEncirclement, true],
      [badWeightedEdge, true],
      [oversizedWeightedEdge, true],
      [badSelfEdge, true],
      [badDuplicateEdge, true],
      [asymmetricGraph, true],
      [badNaval, true],
      [oversizedNaval, true],
      [oversizedDirectBorder, true],
      [emptyDirectBorder, true],
      [oversizedDefensePostCount, true],
      [missingDistanceClass, true],
      [missingWeightedGraph, true],
      [falseOrdinaryBorder, true],
      [missingDirectBorder, true],
      [nonAdjacentDirectBorder, true],
      [badTotals, true],
      [badPartial, true],
    ] as const) {
      const view = promptObservation(
        new LlmPromptBuilder().build({
          observation: malformed,
          legalActions: HOLD_ACTIONS,
        }),
      ) as {
        spatial?: unknown;
        mapInfo?: unknown;
        visiblePlayers: Array<Record<string, unknown>>;
        notes: string[];
      };
      expect(view.spatial).toBeUndefined();
      if (mapInfoExpected) expect(view.mapInfo).toBeDefined();
      else expect(view.mapInfo).toBeUndefined();
      expect(
        view.visiblePlayers.some((rival) => "borderWithYou" in rival),
      ).toBe(false);
      expect(
        view.notes.some((note) => note.startsWith(SPATIAL_NOTE_PREFIX)),
      ).toBe(false);
    }

    for (const malformedMinimap of [
      badMinimap,
      hiddenLegend,
      wrongSelfLegend,
      badTerrainMinimap,
      badMarkerOwner,
      wrongAdaptiveDimensions,
      mismatchedMarkerTotal,
      nullMinimap,
      nullLegendEntry,
      nullMarkerEntry,
      arrayMarkerType,
    ]) {
      const minimapView = promptObservation(
        new LlmPromptBuilder().build({
          observation: malformedMinimap,
          legalActions: HOLD_ACTIONS,
        }),
      ) as {
        spatial?: { minimap?: unknown };
        mapInfo?: unknown;
        visiblePlayers: Array<Record<string, unknown>>;
      };
      expect(minimapView.spatial).toBeDefined();
      expect(minimapView.spatial?.minimap).toBeUndefined();
      expect(minimapView.mapInfo).toBeDefined();
      expect(
        minimapView.visiblePlayers.some((rival) => "borderWithYou" in rival),
      ).toBe(true);
    }
  });

  it("omits an L5 minimap attached to a downgraded schema-3 parent", async () => {
    process.env[SPATIAL_FLAG] = "1";
    process.env[MINIMAP_FLAG] = "1";
    const observation = observe(await shapedGame());
    const spatial = observation.spatial! as unknown as {
      schemaVersion: number;
      ownShape: { largestNeighborBorderShare?: number };
    };
    spatial.schemaVersion = 3;
    delete spatial.ownShape.largestNeighborBorderShare;
    for (const rival of observation.visiblePlayers) {
      const downgradedRival = rival as unknown as {
        sharesBorder?: boolean;
        navalExposure?: unknown;
        bordersWith?: Array<{
          playerID: string;
          sizeClass: "minor" | "major";
          tiles?: number;
        }>;
      };
      delete downgradedRival.sharesBorder;
      delete downgradedRival.navalExposure;
      downgradedRival.bordersWith = downgradedRival.bordersWith?.map(
        ({ tiles: _tiles, ...edge }) => edge,
      );
    }

    const view = promptObservation(
      new LlmPromptBuilder().build({
        observation,
        legalActions: HOLD_ACTIONS,
      }),
    ) as { spatial?: { schemaVersion?: number; minimap?: unknown } };
    expect(view.spatial?.schemaVersion).toBe(3);
    expect(view.spatial?.minimap).toBeUndefined();
  });

  it("normalizes the exact public schema and never forwards unknown nested fields", async () => {
    process.env[SPATIAL_FLAG] = "1";
    process.env[MINIMAP_FLAG] = "1";
    const observation = observe(await shapedGame());
    const sentinel = "PRIVATE_SENTINEL";
    Object.assign(observation.mapInfo!, { futureMapSecret: sentinel });
    Object.assign(observation.mapInfo!.coordinateFrame, {
      futureFrameSecret: sentinel,
    });
    Object.assign(observation.spatial!.ownShape, {
      futureShapeSecret: sentinel,
    });
    Object.assign(observation.spatial!.positionedAssets, {
      futurePrivateUnits: [{ secret: sentinel }],
    });
    Object.assign(observation.spatial!.positionedAssets.structures[0], {
      futureAssetSecret: sentinel,
    });
    Object.assign(observation.spatial!.minimap!, {
      futureMinimapSecret: sentinel,
    });
    Object.assign(observation.spatial!.minimap!.legend[0], {
      futureLegendSecret: sentinel,
    });
    const rival = observation.visiblePlayers.find(
      (player) => player.borderWithYou !== undefined,
    )!;
    Object.assign(rival, { futureRivalSecret: sentinel });
    Object.assign(rival.borderWithYou!, { futureBorderSecret: sentinel });
    Object.assign(rival.borderWithYou!.terrainBreakdown, {
      futureTerrainSecret: sentinel,
    });
    Object.assign(rival.borderWithYou!.defensePostFrontCoverage, {
      futureCoverageSecret: sentinel,
    });
    Object.assign(rival.bordersWith![0], { futureEdgeSecret: sentinel });

    const prompt = new LlmPromptBuilder().build({
      observation,
      legalActions: HOLD_ACTIONS,
    });
    const view = promptObservation(prompt) as { spatial?: unknown };
    expect(view.spatial).toBeDefined();
    expect(prompt).not.toContain(sentinel);
    expect(prompt).not.toContain("futurePrivateUnits");
  });

  it("omits a structurally valid minimap above 4 KiB without dropping rich spatial state", async () => {
    process.env[SPATIAL_FLAG] = "1";
    process.env[MINIMAP_FLAG] = "1";
    const observation = observe(await shapedGame());
    const originalVisiblePlayers = structuredClone(observation.visiblePlayers);
    const template = originalVisiblePlayers[0];
    observation.visiblePlayers = [
      ...originalVisiblePlayers,
      ...Array.from({ length: 60 }, (_, index) => ({
        ...structuredClone(template),
        playerID: `P_${String(index).padStart(2, "0")}_${"x".repeat(60)}`,
        bearing: undefined,
        distanceClass: "far" as const,
        sharesBorder: false,
        borderWithYou: undefined,
        bordersWith: [],
      })),
    ];
    const glyphs =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#";
    observation.spatial!.minimap = {
      schemaVersion: 1,
      width: SPATIAL_MINIMAP_WIDTH,
      height: SPATIAL_MINIMAP_HEIGHT,
      rows: Array.from({ length: SPATIAL_MINIMAP_HEIGHT }, () =>
        glyphs[0].repeat(SPATIAL_MINIMAP_WIDTH),
      ),
      legend: [
        {
          glyph: glyphs[0],
          playerID: observation.ownState!.playerID,
          isYou: true,
        },
        ...observation.visiblePlayers.map((player, index) => ({
          glyph: glyphs[index + 1],
          playerID: player.playerID,
          isYou: false,
        })),
      ],
    };
    expect(
      new TextEncoder().encode(JSON.stringify(observation.spatial!.minimap))
        .byteLength,
    ).toBeGreaterThan(4 * 1024);

    const view = promptObservation(
      new LlmPromptBuilder().build({
        observation,
        legalActions: HOLD_ACTIONS,
      }),
    ) as { spatial?: { minimap?: unknown } };
    expect(view.spatial).toBeDefined();
    expect(view.spatial?.minimap).toBeUndefined();
  });

  it("adds only the spatial block, rival fields, and bounded notes in Stage 1", async () => {
    const game = await shapedGame();
    const offJson = JSON.stringify(observe(game));

    process.env[SPATIAL_FLAG] = "1";
    const on = observe(game);
    expect(on.spatial).toBeDefined();
    expect(on.spatial?.schemaVersion).toBe(5);
    expect(on.spatial?.visibilityModel).toBe(SPATIAL_VISIBILITY_MODEL);
    expect(on.spatial?.ownShape.largestNeighborBorderShare).toBe(51);
    expect(on.mapInfo).toMatchObject({
      width: game.width(),
      height: game.height(),
      tileRefEncoding: "row-major-y-width-plus-x",
      coordinateFrame: {
        origin: "top_left",
        xIncreases: "east",
        yIncreases: "south",
      },
    });
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
        terrainBreakdown: {
          plains: 40,
          highland: 0,
          mountain: 0,
          shore: 0,
        },
        defensePostsCovering: 1,
        defensePostFrontCoverage: { covered: 30, uncovered: 10 },
        underAttackHere: false,
      },
      bordersWith: [{ playerID: "P_C", sizeClass: "major", tiles: 40 }],
      navalExposure: { transportReachableOwnShoreTiles: 0 },
    });
    expect(rivalB).toMatchObject({
      bearing: "south",
      distanceClass: "adjacent",
      borderWithYou: {
        tiles: 40,
        shareOfYourBorder: 51,
        terrainBreakdown: {
          plains: 40,
          highland: 0,
          mountain: 0,
          shore: 0,
        },
        defensePostsCovering: 0,
        defensePostFrontCoverage: { covered: 0, uncovered: 40 },
      },
      bordersWith: [],
      navalExposure: { transportReachableOwnShoreTiles: 0 },
    });
  });

  it("emits only completed public L3 structures and warships with exact coordinates", async () => {
    process.env[SPATIAL_FLAG] = "1";
    const game = await shapedGame();
    const own = game.player("P_AGENT");
    const rival = game.player("P_A");
    const cityTile = game.ref(30, 30);
    const portTile = game.ref(65, 30);
    const warshipTile = game.ref(65, 31);
    own.buildUnit(UnitType.City, cityTile, {});
    rival.buildUnit(UnitType.Port, portTile, {});
    rival.buildUnit(UnitType.Warship, warshipTile, {
      patrolTile: warshipTile,
    });
    const unfinishedWarship = rival.buildUnit(
      UnitType.Warship,
      game.ref(65, 32),
      { patrolTile: game.ref(65, 32) },
    );
    unfinishedWarship.setUnderConstruction(true);
    const deletingWarship = rival.buildUnit(
      UnitType.Warship,
      game.ref(65, 33),
      { patrolTile: game.ref(65, 33) },
    );
    deletingWarship.markForDeletion();
    const inactiveWarship = rival.buildUnit(
      UnitType.Warship,
      game.ref(65, 34),
      { patrolTile: game.ref(65, 34) },
    );
    (inactiveWarship as unknown as { _active: boolean })._active = false;
    rival.buildUnit(UnitType.Warship, warshipTile, {
      patrolTile: warshipTile,
    });
    rival.buildUnit(UnitType.Factory, game.ref(66, 30), {});
    const unfinished = rival.buildUnit(UnitType.City, game.ref(67, 30), {});
    unfinished.setUnderConstruction(true);
    const deleting = rival.buildUnit(UnitType.Port, game.ref(68, 30), {});
    deleting.markForDeletion();

    const observation = observe(game);
    const positioned = observation.spatial?.positionedAssets;
    expect(positioned).toMatchObject({
      analysis: "complete",
      structuresTotal: 3,
      structuresReturned: 3,
      structuresTruncated: false,
      warshipsTotal: 2,
      warshipsReturned: 2,
      warshipsTruncated: false,
    });
    expect(positioned?.structures).toEqual(
      expect.arrayContaining([
        {
          ownerPlayerID: "P_AGENT",
          type: UnitType.City,
          tile: cityTile,
          x: 30,
          y: 30,
        },
        {
          ownerPlayerID: "P_A",
          type: UnitType.Port,
          tile: portTile,
          x: 65,
          y: 30,
        },
      ]),
    );
    expect(positioned?.warships).toEqual(
      Array.from({ length: 2 }, () => ({
        ownerPlayerID: "P_A",
        type: UnitType.Warship,
        tile: warshipTile,
        x: 65,
        y: 31,
      })),
    );
    const promptView = promptObservation(
      new LlmPromptBuilder().build({
        observation,
        legalActions: HOLD_ACTIONS,
      }),
    ) as { spatial?: { positionedAssets?: { warships?: unknown[] } } };
    expect(promptView.spatial?.positionedAssets?.warships).toHaveLength(2);
    expect(JSON.stringify(positioned)).not.toContain("Factory");
    expect(JSON.stringify(positioned)).not.toContain(String(game.ref(67, 30)));
    expect(JSON.stringify(positioned)).not.toContain(String(game.ref(68, 30)));
  });

  it("partitions front elevation exactly while shoreline remains overlapping", async () => {
    process.env[SPATIAL_FLAG] = "1";
    const game = await shapedGame();
    const shared = [
      ...(createAgentSpatialSnapshot(game, false)
        .geometryByPlayerID.get("P_AGENT")
        ?.sharedBorderTiles.get("P_A") ?? []),
    ].sort((a, b) => a - b);
    expect(shared).toHaveLength(40);
    for (const tile of shared.slice(0, 10)) game.map().setMagnitude(tile, 12);
    for (const tile of shared.slice(10, 20)) game.map().setMagnitude(tile, 24);
    for (const tile of shared.slice(0, 5)) game.map().setShorelineBit(tile);

    const breakdown = observe(game).visiblePlayers.find(
      (player) => player.playerID === "P_A",
    )?.borderWithYou?.terrainBreakdown;
    expect(breakdown).toEqual({
      plains: 20,
      highland: 10,
      mountain: 10,
      shore: 5,
    });
    expect(
      (breakdown?.plains ?? 0) +
        (breakdown?.highland ?? 0) +
        (breakdown?.mountain ?? 0),
    ).toBe(40);
  });

  it("unions overlapping defense-post coverage instead of double-counting front tiles", async () => {
    process.env[SPATIAL_FLAG] = "1";
    const game = await shapedGame();
    const duplicatePost = game
      .player("P_AGENT")
      .buildUnit(UnitType.DefensePost, game.ref(55, 20), {});
    duplicatePost.setUnderConstruction(false);
    const unfinishedPost = game
      .player("P_AGENT")
      .buildUnit(UnitType.DefensePost, game.ref(54, 20), {});
    unfinishedPost.setUnderConstruction(true);
    const deletingPost = game
      .player("P_AGENT")
      .buildUnit(UnitType.DefensePost, game.ref(53, 20), {});
    deletingPost.markForDeletion();
    const inactivePost = game
      .player("P_AGENT")
      .buildUnit(UnitType.DefensePost, game.ref(52, 20), {});
    (inactivePost as unknown as { _active: boolean })._active = false;

    const border = observe(game).visiblePlayers.find(
      (player) => player.playerID === "P_A",
    )?.borderWithYou;
    expect(border).toMatchObject({
      tiles: 40,
      defensePostsCovering: 2,
      defensePostFrontCoverage: { covered: 30, uncovered: 10 },
    });
  });

  it("uses deterministic tile tie-breaking independent of asset insertion order", async () => {
    process.env[SPATIAL_FLAG] = "1";
    const game = await shapedGame();
    const higherTile = game.ref(40, 39);
    const lowerTile = game.ref(39, 39);
    game.player("P_AGENT").buildUnit(UnitType.City, higherTile, {});
    game.player("P_AGENT").buildUnit(UnitType.City, lowerTile, {});

    const cityTiles = observe(game)
      .spatial!.positionedAssets.structures.filter(
        (asset) => asset.type === UnitType.City,
      )
      .map((asset) => asset.tile);
    expect(cityTiles).toEqual([lowerTile, higherTile]);
  });

  it("caps positioned assets per player before deterministic round-robin admission", async () => {
    process.env[SPATIAL_FLAG] = "1";
    const game = await shapedGame();
    for (const [playerIndex, player] of game.players().entries()) {
      for (let index = 0; index < 9; index += 1) {
        player.buildUnit(
          UnitType.City,
          game.ref(5 + index, 5 + playerIndex),
          {},
        );
      }
    }
    const positioned = observe(game).spatial?.positionedAssets;
    expect(positioned).toMatchObject({
      analysis: "capped",
      structuresTotal: 37,
      structuresReturned: 32,
      structuresTruncated: true,
    });
    const counts = new Map<string, number>();
    for (const asset of positioned?.structures ?? []) {
      counts.set(
        asset.ownerPlayerID,
        (counts.get(asset.ownerPlayerID) ?? 0) + 1,
      );
    }
    expect([...counts.values()].every((count) => count <= 8)).toBe(true);
    expect(
      positioned?.structures.slice(0, 4).map((asset) => asset.ownerPlayerID),
    ).toEqual(["P_AGENT", "P_A", "P_B", "P_C"]);
  });

  it("enforces the global 48-structure cap after per-player admission", async () => {
    process.env[SPATIAL_FLAG] = "1";
    const players = Array.from(
      { length: 7 },
      (_, index) =>
        new PlayerInfo(
          `Seat ${index}`,
          PlayerType.Human,
          `CLNT_${index}`,
          `P_${index}`,
        ),
    );
    const game = await setup(
      "plains",
      { nations: "disabled", instantBuild: true },
      players,
    );
    for (const [playerIndex, playerInfo] of players.entries()) {
      conquerRectangle(
        game,
        playerInfo.id,
        5 + playerIndex * 12,
        5,
        14 + playerIndex * 12,
        14,
      );
    }
    while (game.inSpawnPhase()) game.executeNextTick();
    for (const [playerIndex, player] of game.players().entries()) {
      for (let index = 0; index < 9; index += 1) {
        player.buildUnit(
          UnitType.City,
          game.ref(5 + playerIndex * 12 + index, 7),
          {},
        );
      }
    }

    const positioned = observe(game, players[0]).spatial!.positionedAssets;
    expect(positioned).toMatchObject({
      analysis: "capped",
      structuresTotal: 63,
      structuresReturned: 48,
      structuresTruncated: true,
    });
    expect(positioned.structures).toHaveLength(48);
    expect(
      positioned.structures.slice(0, 7).map((asset) => asset.ownerPlayerID),
    ).toEqual(players.map((player) => player.id));
  });

  it("enforces the independent per-player and global warship caps", async () => {
    process.env[SPATIAL_FLAG] = "1";
    const players = Array.from(
      { length: 7 },
      (_, index) =>
        new PlayerInfo(
          `Fleet ${index}`,
          PlayerType.Human,
          `CLNT_FLEET_${index}`,
          `P_FLEET_${index}`,
        ),
    );
    const game = await setup(
      "plains",
      { nations: "disabled", instantBuild: true },
      players,
    );
    for (const [playerIndex, playerInfo] of players.entries()) {
      conquerRectangle(
        game,
        playerInfo.id,
        5 + playerIndex * 12,
        5,
        14 + playerIndex * 12,
        14,
      );
    }
    while (game.inSpawnPhase()) game.executeNextTick();
    for (const [playerIndex, player] of game.players().entries()) {
      for (let index = 0; index < 9; index += 1) {
        const tile = game.ref(5 + playerIndex * 12 + index, 15);
        player.buildUnit(UnitType.Warship, tile, { patrolTile: tile });
      }
    }

    const positioned = observe(game, players[0]).spatial!.positionedAssets;
    expect(positioned).toMatchObject({
      analysis: "capped",
      warshipsTotal: 63,
      warshipsReturned: 48,
      warshipsTruncated: true,
    });
    expect(positioned.warships).toHaveLength(48);
    const counts = new Map<string, number>();
    for (const asset of positioned.warships) {
      counts.set(
        asset.ownerPlayerID,
        (counts.get(asset.ownerPlayerID) ?? 0) + 1,
      );
    }
    expect([...counts.values()].every((count) => count <= 8)).toBe(true);
    expect(
      positioned.warships.slice(0, 7).map((asset) => asset.ownerPlayerID),
    ).toEqual(players.map((player) => player.id));
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

  it("summarizes exact connected-water transport exposure and nearest rival port", async () => {
    process.env[SPATIAL_FLAG] = "1";
    const ownInfo = new PlayerInfo(
      "Own Coast",
      PlayerType.Human,
      "CLNT_OWN_COAST",
      "P_OWN_COAST",
    );
    const rivalInfo = new PlayerInfo(
      "Rival Coast",
      PlayerType.Human,
      "CLNT_RIVAL_COAST",
      "P_RIVAL_COAST",
    );
    const game = await setup("world", { nations: "disabled" }, [
      ownInfo,
      rivalInfo,
    ]);
    const byComponent = new Map<number, number[]>();
    for (let tile = 0; tile < game.width() * game.height(); tile++) {
      if (!game.isLand(tile) || !game.isShore(tile)) continue;
      const component = game.getWaterComponent(tile);
      if (component === null) continue;
      const entries = byComponent.get(component) ?? [];
      entries.push(tile);
      byComponent.set(component, entries);
    }
    const sharedCoast = [...byComponent.values()].find(
      (tiles) => tiles.length >= 2,
    );
    expect(sharedCoast).toBeDefined();
    const ownTile = sharedCoast![0];
    const rivalTile = sharedCoast![sharedCoast!.length - 1];
    game.player(ownInfo.id).conquer(ownTile);
    const rival = game.player(rivalInfo.id);
    rival.conquer(rivalTile);
    rival.buildUnit(UnitType.Port, rivalTile, {});

    const observation = observe(game, ownInfo);
    const rivalView = observation.visiblePlayers.find(
      (player) => player.playerID === rivalInfo.id,
    );
    expect(
      rivalView?.navalExposure?.transportReachableOwnShoreTiles,
    ).toBeGreaterThan(0);
    expect(rivalView?.navalExposure?.nearestEnemyPort).toMatchObject({
      distanceClass: expect.stringMatching(/^(near|far)$/),
      bearing: expect.stringMatching(
        /^(north|northeast|east|southeast|south|southwest|west|northwest)$/,
      ),
    });
  });

  it("renders the exact separately gated rich minimap and stable legend", async () => {
    process.env[SPATIAL_FLAG] = "1";
    process.env[MINIMAP_FLAG] = "1";
    const minimap = observe(await shapedGame()).spatial?.minimap;
    expect(minimap).toMatchObject({
      schemaVersion: 2,
      width: SPATIAL_MINIMAP_WIDTH,
      height: SPATIAL_MINIMAP_HEIGHT,
    });
    expect(minimap?.schemaVersion).toBe(2);
    if (minimap?.schemaVersion !== 2) throw new Error("expected minimap v2");
    expect(minimap.ownershipRows).toHaveLength(SPATIAL_MINIMAP_HEIGHT);
    expect(
      minimap.ownershipRows.every(
        (row) => row.length === SPATIAL_MINIMAP_WIDTH,
      ),
    ).toBe(true);
    expect(minimap.terrainRows).toHaveLength(SPATIAL_MINIMAP_HEIGHT);
    expect(minimap.terrainRows.every((row) => /^\.+$/.test(row))).toBe(true);
    expect(minimap.markers).toEqual([
      { type: "D", ownerPlayerID: "P_AGENT", x: 13, y: 2 },
    ]);
    expect(minimap).toMatchObject({
      markersTotal: 1,
      markersReturned: 1,
      markersTruncated: false,
    });
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

  it("uses the adaptive 32x16 L5 grid on large public maps", async () => {
    process.env[SPATIAL_FLAG] = "1";
    process.env[MINIMAP_FLAG] = "1";
    const player = new PlayerInfo(
      "Large",
      PlayerType.Human,
      "CLNT_LARGE",
      "P_LARGE",
    );
    const game = await setup("world", { nations: "disabled" }, [player]);
    expect(game.width() * game.height()).toBeGreaterThanOrEqual(
      SPATIAL_MINIMAP_LARGE_TILE_THRESHOLD,
    );
    let firstLand: number | undefined;
    for (let tile = 0; tile < game.width() * game.height(); tile++) {
      if (game.isLand(tile)) {
        firstLand = tile;
        break;
      }
    }
    expect(firstLand).toBeDefined();
    game.player(player.id).conquer(firstLand!);
    const minimap = observe(game, player).spatial?.minimap;
    expect(minimap).toMatchObject({
      schemaVersion: 2,
      width: SPATIAL_MINIMAP_LARGE_WIDTH,
      height: SPATIAL_MINIMAP_LARGE_HEIGHT,
    });
    if (minimap?.schemaVersion !== 2) throw new Error("expected minimap v2");
    expect(minimap.ownershipRows).toHaveLength(SPATIAL_MINIMAP_LARGE_HEIGHT);
    expect(minimap.terrainRows).toHaveLength(SPATIAL_MINIMAP_LARGE_HEIGHT);
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
    expect(
      createAgentSpatialSnapshot(plains, true).minimap?.ownershipRows[0][0],
    ).toBe("A");

    const coastPlayer = new PlayerInfo(
      "Coast",
      PlayerType.Human,
      "CLNT_COAST",
      "P_COAST",
    );
    const world = await setup("world", { nations: "disabled" }, [coastPlayer]);
    const worldMinimap = createAgentSpatialSnapshot(world, true).minimap!;
    const worldMinimapWidth = worldMinimap.width;
    const worldMinimapHeight = worldMinimap.height;
    let tieCell:
      | { cx: number; cy: number; landTiles: number[]; waterCount: number }
      | undefined;
    for (let cy = 0; cy < worldMinimapHeight && !tieCell; cy++) {
      for (let cx = 0; cx < worldMinimapWidth && !tieCell; cx++) {
        const landTiles: number[] = [];
        let waterCount = 0;
        const xStart = Math.floor((cx * world.width()) / worldMinimapWidth);
        const xEnd = Math.floor(((cx + 1) * world.width()) / worldMinimapWidth);
        const yStart = Math.floor((cy * world.height()) / worldMinimapHeight);
        const yEnd = Math.floor(
          ((cy + 1) * world.height()) / worldMinimapHeight,
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
      createAgentSpatialSnapshot(world, true).minimap?.ownershipRows[cell.cy][
        cell.cx
      ],
    ).toBe(".");

    cell.landTiles
      .slice(neutralWaterTiePlayerTiles, cell.waterCount)
      .forEach((tile) => player.conquer(tile));
    expect(
      createAgentSpatialSnapshot(world, true).minimap?.ownershipRows[cell.cy][
        cell.cx
      ],
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
    expect(prompt).toContain('"spatial":{"schemaVersion":5');
    expect(prompt).toContain('"tileRefEncoding":"row-major-y-width-plus-x"');
    expect(prompt).toContain('"minimap":{"schemaVersion":2');
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
