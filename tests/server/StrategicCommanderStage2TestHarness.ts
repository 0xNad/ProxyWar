import { UnitType } from "../../src/core/game/Game";
import type {
  AgentObservation,
  AgentVisiblePlayer,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import { buildCommanderState } from "../../src/server/agents/CommanderStateBuilder";
import type {
  BuiltCommanderState,
  BuiltStrategicOptions,
  ExposedStrategicOption,
} from "../../src/server/agents/StrategicCommanderTypes";
import { buildStrategicOptions } from "../../src/server/agents/StrategicOptionBuilder";
import {
  stubObservation,
  stubVisiblePlayer,
  type StubSeat,
} from "./DealTestHarness";

export const RAW_EXPANSION_ACTION_ID = "raw-expand-tile-901";
export const RAW_BUILD_ACTION_ID = "raw-build-city-tile-101";
export const RAW_ATTACK_ACTION_ID = "raw-attack-P7-37-percent";
export const LOW_LEVEL_LABEL_CANARY = "LOW_LEVEL_ACTION_LABEL_CANARY";
export const RAW_MENU_CANARY = "RAW_LEGAL_ACTION_MENU_CANARY";
export const TACTICAL_CANARY = "TACTICAL_RECOMMENDATION_CANARY";
export const MINIMAP_CANARY = "RAW_MINIMAP_ROW_CANARY";
export const BASELINE_CANARY = "DETERMINISTIC_BASELINE_CHOICE_CANARY";
export const EVIDENCE_LEAK_CANARY = "EVIDENCE_LEAK_CANARY";

const SELF: StubSeat = {
  agentID: "COMMANDER_AGENT",
  playerID: "SELF",
  username: "Commander fixture",
};

export interface CommanderStage2Fixture {
  observation: AgentObservation;
  legalActions: LegalAction[];
  strategicOptions: BuiltStrategicOptions;
  exposedOptions: ExposedStrategicOption[];
  builtState: BuiltCommanderState;
}

export function makeCommanderStage2Fixture(
  input: {
    reverseSources?: boolean;
    decisionSequence?: number;
    validSpatial?: boolean;
  } = {},
): CommanderStage2Fixture {
  const rivals = makeRivals();
  const observation = stubObservation({
    seat: SELF,
    others: input.reverseSources ? [...rivals].reverse() : rivals,
    turnNumber: 41,
    gameID: "COMMANDER_STAGE_2_TEST",
  });
  observation.profile = "opportunistic";
  observation.tick = 12_345;
  observation.alivePlayerCount = 10;
  Object.assign(observation.ownState!, {
    troops: 20_000,
    maxTroops: 40_000,
    troopRatio: 0.5,
    gold: "750000",
    tilesOwned: 300,
    tileShare: 0.25,
    borderTiles: 42,
    incomingAttacks: 2,
    outgoingAttacks: 1,
    unitCounts: {
      [UnitType.City]: 2,
      [UnitType.Factory]: 3,
      [UnitType.Port]: 1,
      [UnitType.DefensePost]: 4,
      [UnitType.SAMLauncher]: 1,
      [UnitType.MissileSilo]: 99,
    },
  });
  observation.combat.ownTroops = 20_000;
  observation.combat.incomingAttackPlayerIDs = ["P6", "P5"];
  observation.combat.outgoingAttackPlayerIDs = ["P4", "P7"];
  observation.strategic.summary = BASELINE_CANARY;
  observation.strategic.priority = "attack";
  observation.strategic.scores.offense = 987_654;
  observation.memory.summary = "UNBOUNDED_MEMORY_CANARY";
  observation.memory.avoidActionIDs = ["AVOID_RAW_ACTION_CANARY"];
  observation.objective = {
    kind: "attack_player",
    label: "OBJECTIVE_RECOMMENDATION_CANARY",
    targetPlayerID: "P9",
  } as unknown as AgentObservation["objective"];
  observation.tacticalAffordances = {
    recommendation: TACTICAL_CANARY,
  } as unknown as AgentObservation["tacticalAffordances"];
  observation.spatial = {
    schemaVersion: 1,
    ownShape: {
      quadrant: "center",
      regionAnalysis: "complete",
      centroidBasis: "all_border_budget_fallback",
      coastShare: 0.2,
      centroid: { xPct: 50, yPct: 50 },
    },
    minimap: {
      schemaVersion: 1,
      width: 24,
      height: 12,
      rows: [MINIMAP_CANARY, ...Array.from({ length: 11 }, () => "")],
      legend: [],
    },
  } as unknown as AgentObservation["spatial"];
  observation.recentDecisions = [
    {
      canary: "UNBOUNDED_RECENT_DECISION_CANARY",
    } as unknown as AgentObservation["recentDecisions"][number],
  ];
  observation.notes = [RAW_MENU_CANARY];
  if (input.validSpatial) {
    addValidCommanderOrientation(observation);
  }

  const legalActions = makeLegalActions();
  if (input.reverseSources) {
    legalActions.reverse();
    observation.combat.incomingAttackPlayerIDs.reverse();
    observation.combat.outgoingAttackPlayerIDs.reverse();
  }
  const strategicOptions = buildStrategicOptions({
    observation,
    legalActions,
  });
  const exposedOptions = strategicOptions.exposed.map((option) => ({
    ...option,
    evidence: {
      ...option.evidence,
      evidenceLeakCanary: EVIDENCE_LEAK_CANARY,
      alignedPrimaryActionIDs: [RAW_ATTACK_ACTION_ID],
      totalScore: 999_996,
    },
    binding: {
      alignedPrimaryActionIDs: [RAW_ATTACK_ACTION_ID],
      alignedSupportActionIDs: [RAW_BUILD_ACTION_ID],
    },
    totalScore: 999_999,
    policyScore: 999_998,
    skillScore: 999_997,
    recommendation: RAW_MENU_CANARY,
  })) as unknown as ExposedStrategicOption[];
  const builtState = buildCommanderState({
    observation,
    exposedOptions,
    decisionSequence: input.decisionSequence ?? 7,
    recentEvents: [
      ...Array.from({ length: 12 }, (_, index) => ({
        kind: "territory_changed" as const,
        fromTiles: 280 + index,
        toTiles: 281 + index,
      })),
      { kind: "incoming_attacker", playerID: "P6" },
      { kind: "rival_eliminated", playerID: "P9" },
    ],
  });

  return {
    observation,
    legalActions,
    strategicOptions,
    exposedOptions,
    builtState,
  };
}

function addValidCommanderOrientation(observation: AgentObservation): void {
  observation.mapInfo = {
    name: "Commander orientation fixture",
    width: 100,
    height: 100,
    tileRefEncoding: "row-major-y-width-plus-x",
    coordinateFrame: {
      origin: "top_left",
      xIncreases: "east",
      yIncreases: "south",
    },
  };
  observation.spatial = {
    schemaVersion: 5,
    visibilityModel: "global-lockstep-public-map-v1",
    ownShape: {
      quadrant: "northwest",
      compactness: "fragmented",
      regionCount: 2,
      largestRegionShare: 75,
      regionAnalysis: "complete",
      centroidBasis: "largest_region_border",
      coastShare: 18,
      largestNeighborBorderShare: 25,
      centroid: { xPct: 37, yPct: 62 },
    },
    positionedAssets: {
      analysis: "complete",
      structures: [
        {
          ownerPlayerID: "SELF",
          type: UnitType.City,
          tile: 403,
          x: 3,
          y: 4,
        },
      ],
      structuresTotal: 1,
      structuresReturned: 1,
      structuresTruncated: false,
      warships: [],
      warshipsTotal: 0,
      warshipsReturned: 0,
      warshipsTruncated: false,
    },
    minimap: {
      schemaVersion: 1,
      width: 24,
      height: 12,
      rows: [MINIMAP_CANARY, ...Array.from({ length: 11 }, () => "")],
      legend: [],
    },
  };

  const bearings = [
    "north",
    "northeast",
    "east",
    "southeast",
    "south",
    "southwest",
    "west",
    "northwest",
  ] as const;
  for (const player of observation.visiblePlayers) {
    const ordinal = Number.parseInt(player.playerID.slice(1), 10);
    player.bearing = bearings[(ordinal - 1) % bearings.length];
    player.distanceClass = player.sharesBorder
      ? "adjacent"
      : ordinal % 2 === 0
        ? "near"
        : "far";
    player.borderWithYou = player.sharesBorder
      ? {
          tiles: 10 + ordinal,
          shareOfYourBorder: 25,
          terrain: "land",
          terrainBreakdown: {
            plains: 10 + ordinal,
            highland: 0,
            mountain: 0,
            shore: 0,
          },
          defensePostsCovering: 0,
          defensePostFrontCoverage: {
            covered: 0,
            uncovered: 10 + ordinal,
          },
          underAttackHere: false,
        }
      : undefined;
    player.bordersWith = [];
    player.navalExposure = {
      transportReachableOwnShoreTiles: ordinal,
      ...(player.playerID === "P2"
        ? {
            nearestEnemyPort: {
              bearing: "east" as const,
              distanceClass: "near" as const,
            },
          }
        : {}),
    };
  }
}

function makeRivals(): AgentVisiblePlayer[] {
  const data: Array<[string, number, boolean, Partial<AgentVisiblePlayer>?]> = [
    ["P1", 80, true],
    ["P2", 500, true],
    ["P3", 450, true],
    ["P4", 420, false],
    ["P5", 410, false],
    ["P6", 400, false],
    [
      "P7",
      120,
      true,
      { name: `Rival\u0000\u202e ${"N".repeat(80)}`, troops: 9_000 },
    ],
    ["P8", 110, false, { troops: 8_000 }],
    ["P9", 900, false],
  ];
  return data.map(([playerID, tilesOwned, sharesBorder, overrides]) =>
    stubVisiblePlayer(
      {
        agentID: `AGENT_${playerID}`,
        playerID,
        username: `Rival ${playerID}`,
      },
      {
        tilesOwned,
        tileShare: tilesOwned / 2_000,
        sharesBorder,
        ...overrides,
      },
    ),
  );
}

function makeLegalActions(): LegalAction[] {
  return [
    {
      id: RAW_EXPANSION_ACTION_ID,
      kind: "attack",
      label: `${LOW_LEVEL_LABEL_CANARY}: expand 901`,
      intent: { type: "attack", targetID: null, troops: 2_000 },
      risk: { level: "low", score: 0.1 },
      metadata: {
        targetID: null,
        expansion: true,
        troopPercentage: 0.1,
        buildTile: 901,
      },
    },
    {
      id: RAW_BUILD_ACTION_ID,
      kind: "build",
      label: `${LOW_LEVEL_LABEL_CANARY}: city 101`,
      intent: { type: "build_unit", unit: UnitType.City, tile: 101 },
      risk: { level: "low", score: 0.1 },
      metadata: {
        unit: UnitType.City,
        role: "economic",
        buildTile: 101,
        economicValue: 777_777,
      },
    },
    hostileAttack("P7", RAW_ATTACK_ACTION_ID),
    hostileAttack("P8", "raw-attack-P8-19-percent"),
    hostileAttack("P9", "raw-attack-P9-11-percent"),
    {
      id: "hold",
      kind: "hold",
      label: `${LOW_LEVEL_LABEL_CANARY}: hold`,
      intent: null,
      risk: { level: "none", score: 0 },
      metadata: { rawMenu: RAW_MENU_CANARY },
    },
  ];
}

function hostileAttack(targetID: string, id: string): LegalAction {
  return {
    id,
    kind: "attack",
    label: `${LOW_LEVEL_LABEL_CANARY}: attack ${targetID}`,
    intent: { type: "attack", targetID, troops: 5_000 },
    risk: { level: "medium", score: 0.4 },
    metadata: {
      targetID,
      expansion: false,
      troopPercentage: 0.37,
      totalScore: 888_888,
    },
  };
}
