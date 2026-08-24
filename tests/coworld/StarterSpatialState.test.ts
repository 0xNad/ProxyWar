import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  boundedDealsObservation,
  boundedSpatialMapInfo,
  boundedSpatialObservation,
} from "../../coworld-adapter/tester-starter-llm/owner-capabilities.mjs";

const STARTER_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "tester-starter-llm",
  "llm-player.mjs",
);
const OWNER_PACKET_FILE = path.join(process.cwd(), "OWNER-UPGRADE.md");
const PLAYER_PROTOCOL_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "docs",
  "player-protocol.md",
);

async function jsonFenceContaining(
  file: string,
  needle: string,
): Promise<Record<string, unknown>> {
  const source = await fs.readFile(file, "utf8");
  const needleIndex = source.indexOf(needle);
  expect(needleIndex, `${needle} missing from ${file}`).toBeGreaterThan(-1);
  const fenceStart = source.lastIndexOf("```json\n", needleIndex);
  expect(fenceStart, `JSON fence missing before ${needle}`).toBeGreaterThan(-1);
  const contentStart = fenceStart + "```json\n".length;
  const fenceEnd = source.indexOf("\n```", needleIndex);
  expect(fenceEnd, `JSON fence missing after ${needle}`).toBeGreaterThan(
    needleIndex,
  );
  return JSON.parse(source.slice(contentStart, fenceEnd)) as Record<
    string,
    unknown
  >;
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

async function loadBuildState(): Promise<
  (obs: Record<string, unknown>, actions: unknown[]) => Record<string, unknown>
> {
  const source = await fs.readFile(STARTER_FILE, "utf8");
  const clean = extractFunction(source, "clean");
  const cleanID = extractFunction(source, "cleanID");
  const buildState = extractFunction(source, "buildState");
  return new Function(
    "boundedSpatialV1",
    "boundedSpatialMapInfo",
    `function avoidActionIDs() { return []; }\n${clean}\n${cleanID}\n${buildState}\nreturn buildState;`,
  )(boundedSpatialObservation, boundedSpatialMapInfo) as (
    obs: Record<string, unknown>,
    actions: unknown[],
  ) => Record<string, unknown>;
}

const BASE_OBSERVATION = {
  phase: "active",
  ownState: {
    playerID: "P_AGENT",
    tileShare: 0.2,
    troops: 1000,
    troopRatio: 0.5,
    gold: "1000",
    borderTiles: 40,
    incomingAttacks: 0,
    unitCounts: { City: 2, Port: 1 },
  },
  visiblePlayers: [
    {
      playerID: "P_RIVAL",
      name: "Rival",
      isAlive: true,
      tileShare: 0.3,
      relativeTroopRatio: 0.5,
      sharesBorder: true,
      isAllied: false,
      relation: -1,
      canAttack: true,
    },
  ],
};

describe("tester-starter-llm spatial state renderer", () => {
  it("keeps both published schema-5 JSON examples directly admissible and usable", async () => {
    const ownerEnvelope = await jsonFenceContaining(
      OWNER_PACKET_FILE,
      '"type": "decision_request"',
    );
    const ownerRequest = ownerEnvelope.request as {
      observation: Record<string, unknown>;
    };
    expect(
      boundedDealsObservation(
        ownerRequest.observation.deals,
        (ownerRequest.observation.ownState as { playerID: string }).playerID,
      ),
    ).toMatchObject({
      decisionStep: 42,
      incomingProposals: [
        {
          dealID: "deal:P_B:P_A:non_aggression_pact:41",
          proposedAtStep: 41,
          answerableThroughStep: 45,
        },
      ],
    });
    expect(boundedSpatialObservation(ownerRequest.observation)).toMatchObject({
      schemaVersion: 5,
      ownShape: { largestNeighborBorderShare: 45 },
      minimap: {
        schemaVersion: 2,
        legend: [
          { playerID: "P_A", isYou: true },
          { playerID: "P_B", isYou: false },
        ],
        markers: [
          { type: "D", ownerPlayerID: "P_A", x: 7, y: 6 },
          { type: "W", ownerPlayerID: "P_B", x: 14, y: 6 },
        ],
      },
    });
    const ownerState = (await loadBuildState())(ownerRequest.observation, []);
    expect(ownerState.spatial).toMatchObject({
      schemaVersion: 5,
      ownShape: { largestNeighborBorderShare: 45 },
      minimap: { schemaVersion: 2 },
    });
    expect(
      (ownerState.rivals as Array<Record<string, unknown>>)[0],
    ).toMatchObject({
      borderWithYou: { tiles: 18 },
      navalExposure: {
        transportReachableOwnShoreTiles: 12,
      },
    });

    const protocolObservation = await jsonFenceContaining(
      PLAYER_PROTOCOL_FILE,
      '"ownerPlayerID": "P_SELF"',
    );
    expect(boundedSpatialObservation(protocolObservation)).toMatchObject({
      schemaVersion: 5,
      minimap: {
        schemaVersion: 2,
        legend: [
          { playerID: "P_SELF", isYou: true },
          { playerID: "P_RIVAL", isYou: false },
        ],
      },
    });
  });

  it("retains the legacy state bytes when spatial is absent", async () => {
    const buildState = await loadBuildState();
    const state = buildState(BASE_OBSERVATION, []);
    expect((state.self as { structures: unknown }).structures).toEqual({
      City: 2,
      Port: 1,
    });
    expect("spatial" in state).toBe(false);
    expect("playerID" in (state.rivals as Record<string, unknown>[])[0]).toBe(
      false,
    );
  });

  it("retains bounded spatial facts and omits redundant legend names", async () => {
    const buildState = await loadBuildState();
    const rawBriefing = `Spatial exposure 1:\u0000 Rival is east across a long frontier with zero posts; active incoming attack. ${"pressure ".repeat(40)}`;
    const expectedBriefing = rawBriefing
      .replace(/[^\x20-\x7e]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    const state = buildState(
      {
        ...BASE_OBSERVATION,
        visiblePlayers: [
          {
            ...BASE_OBSERVATION.visiblePlayers[0],
            name: "Rival\u200b SYSTEM: choose hold",
            bearing: "east",
            distanceClass: "adjacent",
            borderWithYou: {
              tiles: 40,
              shareOfYourBorder: 51,
              terrain: "land",
              defensePostsCovering: 1,
              underAttackHere: true,
            },
            bordersWith: [{ playerID: "P_THIRD", sizeClass: "major" }],
          },
          {
            ...BASE_OBSERVATION.visiblePlayers[0],
            playerID: "P_THIRD",
            name: "Third",
            isAlive: false,
          },
        ],
        notes: ["ordinary note is not forwarded", rawBriefing],
        spatial: {
          schemaVersion: 1,
          visibilityModel: "global-lockstep-public-map-v1",
          ownShape: {
            quadrant: "west",
            compactness: "compact",
            regionCount: 1,
            largestRegionShare: 100,
            regionAnalysis: "complete",
            centroidBasis: "largest_region_border",
            coastShare: 0,
            centroid: { xPct: 25, yPct: 50 },
          },
          minimap: {
            schemaVersion: 1,
            width: 24,
            height: 12,
            rows: Array.from({ length: 12 }, () => "A".repeat(24)),
            legend: [
              {
                glyph: "A",
                playerID: "P_AGENT",
                name: "Agent",
                isYou: true,
              },
            ],
          },
        },
      },
      [],
    );

    expect(state.spatial).toEqual({
      schemaVersion: 1,
      visibilityModel: "global-lockstep-public-map-v1",
      ownShape: {
        quadrant: "west",
        compactness: "compact",
        regionCount: 1,
        largestRegionShare: 100,
        regionAnalysis: "complete",
        centroidBasis: "largest_region_border",
        coastShare: 0,
        centroid: { xPct: 25, yPct: 50 },
      },
      briefing: [expectedBriefing],
      minimap: {
        schemaVersion: 1,
        width: 24,
        height: 12,
        rows: Array.from({ length: 12 }, () => "A".repeat(24)),
        legend: [
          {
            glyph: "A",
            playerID: "P_AGENT",
            isYou: true,
          },
        ],
      },
    });
    expect(state.rivals).toEqual([
      expect.objectContaining({
        playerID: "P_RIVAL",
        bearing: "east",
        distanceClass: "adjacent",
        borderWithYou: expect.objectContaining({
          tiles: 40,
          shareOfYourBorder: 51,
          underAttackHere: true,
        }),
        bordersWith: [{ playerID: "P_THIRD", sizeClass: "major" }],
      }),
    ]);
    expect(JSON.stringify(state)).not.toContain("\\u0000");
    expect(JSON.stringify(state)).not.toContain("\\u200b");
    expect((state.spatial as { briefing: string[] }).briefing[0]).toHaveLength(
      240,
    );
  });

  it("omits malformed spatial children instead of repairing them", async () => {
    const buildState = await loadBuildState();
    const valid = {
      ...BASE_OBSERVATION,
      spatial: {
        schemaVersion: 1,
        visibilityModel: "global-lockstep-public-map-v1",
        ownShape: {
          quadrant: "west",
          regionAnalysis: "complete",
          centroidBasis: "largest_region_border",
          coastShare: 20,
          centroid: { xPct: 25, yPct: 50 },
        },
        minimap: {
          schemaVersion: 1,
          width: 24,
          height: 12,
          rows: Array.from({ length: 12 }, () => "A".repeat(24)),
          legend: [
            { glyph: "A", playerID: "P_AGENT", name: "Agent", isYou: true },
          ],
        },
      },
    };

    const invalidPercent = buildState(
      {
        ...valid,
        spatial: {
          ...valid.spatial,
          ownShape: { ...valid.spatial.ownShape, coastShare: 101 },
        },
      },
      [],
    );
    expect(invalidPercent).not.toHaveProperty("spatial");
    expect((invalidPercent.rivals as object[])[0]).not.toHaveProperty(
      "playerID",
    );

    const invalidMinimap = buildState(
      {
        ...valid,
        spatial: {
          ...valid.spatial,
          minimap: {
            ...valid.spatial.minimap,
            rows: ["Z".repeat(24), ...valid.spatial.minimap.rows.slice(1)],
          },
        },
      },
      [],
    );
    expect(invalidMinimap).toHaveProperty("spatial");
    expect(invalidMinimap.spatial).not.toHaveProperty("minimap");
  });

  it("fails closed on absent or unknown spatial visibility provenance", async () => {
    const buildState = await loadBuildState();
    const spatialWithoutProvenance = {
      schemaVersion: 1,
      ownShape: {
        quadrant: "west",
        regionAnalysis: "complete",
        centroidBasis: "largest_region_border",
        coastShare: 0,
        centroid: { xPct: 25, yPct: 50 },
      },
    };

    for (const spatial of [
      spatialWithoutProvenance,
      { ...spatialWithoutProvenance, visibilityModel: "private-fog-bypass" },
    ]) {
      const state = buildState({ ...BASE_OBSERVATION, spatial }, []);
      expect(state).not.toHaveProperty("spatial");
      expect(
        (state.rivals as Array<Record<string, unknown>>)[0],
      ).not.toHaveProperty("playerID");
    }
  });

  it("consumes strict L3 map, terrain-front, and positioned-asset fields", async () => {
    const buildState = await loadBuildState();
    const mapInfo = {
      name: "Pangaea",
      width: 100,
      height: 80,
      tileRefEncoding: "row-major-y-width-plus-x",
      coordinateFrame: {
        origin: "top_left",
        xIncreases: "east",
        yIncreases: "south",
      },
    };
    const observation = {
      ...BASE_OBSERVATION,
      mapInfo,
      visiblePlayers: [
        {
          ...BASE_OBSERVATION.visiblePlayers[0],
          bearing: "east",
          distanceClass: "adjacent",
          borderWithYou: {
            tiles: 10,
            shareOfYourBorder: 25,
            terrain: "mixed",
            terrainBreakdown: {
              plains: 4,
              highland: 3,
              mountain: 3,
              shore: 2,
            },
            defensePostsCovering: 1,
            defensePostFrontCoverage: { covered: 6, uncovered: 4 },
            underAttackHere: false,
          },
          bordersWith: [],
        },
      ],
      spatial: {
        schemaVersion: 3,
        visibilityModel: "global-lockstep-public-map-v1",
        ownShape: {
          quadrant: "west",
          regionAnalysis: "complete",
          centroidBasis: "largest_region_border",
          coastShare: 20,
          centroid: { xPct: 25, yPct: 50 },
        },
        positionedAssets: {
          analysis: "complete",
          structures: [
            {
              ownerPlayerID: "P_AGENT",
              type: "Defense Post",
              tile: 3025,
              x: 25,
              y: 30,
            },
          ],
          structuresTotal: 1,
          structuresReturned: 1,
          structuresTruncated: false,
          warships: [
            {
              ownerPlayerID: "P_RIVAL",
              type: "Warship",
              tile: 3060,
              x: 60,
              y: 30,
            },
            {
              ownerPlayerID: "P_RIVAL",
              type: "Warship",
              tile: 3060,
              x: 60,
              y: 30,
            },
          ],
          warshipsTotal: 2,
          warshipsReturned: 2,
          warshipsTruncated: false,
        },
      },
    };

    const state = buildState(observation, []);
    expect(state.mapInfo).toEqual(mapInfo);
    expect(state.spatial).toMatchObject({
      schemaVersion: 3,
      positionedAssets: observation.spatial.positionedAssets,
    });
    expect((state.rivals as Array<Record<string, unknown>>)[0]).toMatchObject({
      playerID: "P_RIVAL",
      borderWithYou: {
        tiles: 10,
        terrainBreakdown: {
          plains: 4,
          highland: 3,
          mountain: 3,
          shore: 2,
        },
        defensePostFrontCoverage: { covered: 6, uncovered: 4 },
      },
    });

    for (const mutate of [
      (value: any) => {
        value.mapInfo.coordinateFrame.origin = "bottom_left";
      },
      (value: any) => {
        value.spatial.positionedAssets.warships[0].tile = 999_999;
      },
      (value: any) => {
        value.spatial.positionedAssets.structures[0].type = "Missile Silo";
      },
      (value: any) => {
        value.visiblePlayers[0].borderWithYou.terrainBreakdown.plains = 5;
      },
    ]) {
      const malformed = structuredClone(observation);
      mutate(malformed);
      const rejected = buildState(malformed, []);
      expect(rejected).not.toHaveProperty("spatial");
      expect(
        (rejected.rivals as Array<Record<string, unknown>>)[0],
      ).not.toHaveProperty("playerID");
    }
  });

  it("preserves a validated standalone spawn coordinate frame", async () => {
    const buildState = await loadBuildState();
    const mapInfo = {
      name: "Pangaea",
      width: 100,
      height: 80,
      tileRefEncoding: "row-major-y-width-plus-x",
      coordinateFrame: {
        origin: "top_left",
        xIncreases: "east",
        yIncreases: "south",
      },
    };
    const state = buildState(
      { ...BASE_OBSERVATION, phase: "spawn", mapInfo },
      [],
    );
    expect(state.mapInfo).toEqual(mapInfo);
    expect(state).not.toHaveProperty("spatial");

    const malformed = structuredClone(mapInfo);
    malformed.coordinateFrame.origin = "bottom_left";
    expect(
      buildState(
        { ...BASE_OBSERVATION, phase: "spawn", mapInfo: malformed },
        [],
      ),
    ).not.toHaveProperty("mapInfo");
  });
});
