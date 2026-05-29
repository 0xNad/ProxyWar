import { describe, expect, it } from "vitest";
import { PlayerType, Relation, UnitType } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import { buildAgentTacticalAffordances } from "../../src/server/agents/AgentTacticalAffordances";
import {
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";

describe("AgentTacticalAffordances", () => {
  it("detects a transport troop-banking opportunity near troop cap", () => {
    const observation = observationWithTroops({
      troops: 190_000,
      maxTroops: 200_000,
      activeTransportTroops: 80_000,
    });
    const affordances = buildAgentTacticalAffordances({
      observation,
      legalActions: [
        boatAction("boat:444:25", 50_000),
        boatAction("boat:444:16", 32_000),
      ],
    });

    expect(affordances.transportTroopBanking).toMatchObject({
      tacticID: "transport_troop_banking",
      nearCap: true,
      recommended: true,
      activeTransportTroops: 80_000,
      largestAvailableBoatLaunchTroops: 50_000,
      homeDanger: "low",
      effectiveFutureTroopRatio: 1.65,
    });
  });

  it("blocks transport troop-banking recommendations under high home danger", () => {
    const observation = observationWithTroops({
      troops: 190_000,
      maxTroops: 200_000,
      incomingThreatTroops: 80_000,
    });
    const affordances = buildAgentTacticalAffordances({
      observation,
      legalActions: [boatAction("boat:444:25", 50_000)],
    });

    expect(affordances.transportTroopBanking).toMatchObject({
      nearCap: true,
      recommended: false,
      homeDanger: "high",
    });
  });

  it("detects an opening expansion tempo opportunity when behind tile-share target", () => {
    const observation = observationWithTroops({
      troops: 80_000,
      maxTroops: 200_000,
    });
    const affordances = buildAgentTacticalAffordances({
      observation: {
        ...observation,
        turnNumber: 900,
        ownState:
          observation.ownState === null
            ? null
            : {
                ...observation.ownState,
                tilesOwned: 120,
                tileShare: 0.015,
              },
        combat: {
          ...observation.combat,
          canExpandIntoNeutral: true,
          neutralExpansionLegalReason: "test neutral land",
        },
      },
      legalActions: [expansionAttackAction("attack:Terra Nullius:15", 15)],
    });

    expect(affordances.openingExpansionTempo).toMatchObject({
      tacticID: "opening_expansion_tempo",
      openingWindow: true,
      recommended: true,
      ownTileShare: 0.015,
      expectedTileShare: 0.045,
      neutralLandExpansionActionCount: 1,
      behindExpectedTempo: true,
      homeDanger: "low",
    });
  });

  it("counts neutral boat actions whose target id is omitted", () => {
    const observation = observationWithTroops({
      troops: 120_000,
      maxTroops: 300_000,
    });
    const affordances = buildAgentTacticalAffordances({
      observation: {
        ...observation,
        turnNumber: 650,
        ownState:
          observation.ownState === null
            ? null
            : {
                ...observation.ownState,
                tilesOwned: 6_000,
                tileShare: 0.06,
              },
      },
      legalActions: [
        expansionAttackAction("expand:terra-nullius:10", 10),
        {
          id: "boat:neutral:16",
          kind: "boat",
          label: "Send 16% transport",
          intent: { type: "boat", troops: 19_200, dst: 444 },
          risk: { level: "low", score: 0.1 },
          metadata: {
            troops: 19_200,
            targetTile: 444,
            targetName: "Terra Nullius",
            troopPercent: 16,
          },
        },
        {
          id: "boat:terra-name:25",
          kind: "boat",
          label: "Send 25% transport",
          intent: { type: "boat", troops: 30_000, dst: 555 },
          risk: { level: "low", score: 0.1 },
          metadata: {
            troops: 30_000,
            targetTile: 555,
            targetID: "terra-nullius",
            targetName: "Terra Nullius",
            troopPercent: 25,
          },
        },
      ],
    });

    expect(affordances.openingExpansionTempo).toMatchObject({
      neutralLandExpansionActionCount: 1,
      neutralBoatExpansionActionCount: 2,
      largestExpansionTroopPercent: 25,
    });
  });

  it("detects a frontier conversion timing opportunity after land base is ready", () => {
    const observation = observationWithTroops({
      troops: 220_000,
      maxTroops: 300_000,
    });
    const affordances = buildAgentTacticalAffordances({
      observation: {
        ...observation,
        turnNumber: 1_400,
        ownState:
          observation.ownState === null
            ? null
            : {
                ...observation.ownState,
                tilesOwned: 12_000,
                tileShare: 0.09,
              },
        visiblePlayers: [
          {
            playerID: "rival-1",
            clientID: "rival-1",
            smallID: 2,
            name: "Weak Rival",
            type: PlayerType.Nation,
            isAlive: true,
            isDisconnected: false,
            hasSpawned: true,
            troops: 150_000,
            maxTroops: 280_000,
            troopRatio: 0.536,
            gold: "10000",
            tilesOwned: 8_000,
            tileShare: 0.06,
            sharesBorder: true,
            isAllied: false,
            isFriendly: false,
            relation: Relation.Neutral,
            canAttack: true,
            canRequestAlliance: false,
            canDonateGold: false,
            canDonateTroops: false,
            canEmbargo: true,
            hasEmbargoAgainst: false,
            outgoingAttack: false,
            incomingAttack: false,
            hasOutgoingAllianceRequest: false,
            hasIncomingAllianceRequest: false,
            relativeTroopRatio: 1.47,
          },
        ],
        combat: {
          ...observation.combat,
          canExpandIntoNeutral: true,
          neutralExpansionLegalReason: "neutral still legal",
          attackablePlayerIDs: ["rival-1"],
          borderedPlayerIDs: ["rival-1"],
        },
      },
      legalActions: [
        expansionAttackAction("expand:terra-nullius:20", 20),
        hostileAttackAction("attack:rival-1:10", "rival-1", 10, 1.47),
      ],
    });

    expect(affordances.frontierConversionTiming).toMatchObject({
      tacticID: "frontier_conversion_timing",
      recommended: true,
      strategicWindow: true,
      executorReady: true,
      enoughLandBase: true,
      neutralExpansionAvailable: true,
      neutralExpansionActionCount: 1,
      hostileAttackActionCount: 1,
      favorableHostileAttackActionCount: 1,
      executorReadyHostileAttackActionCount: 1,
      bestTargetName: "Weak Rival",
      bestTargetRelativeTroopRatio: 1.47,
      bestExecutorReadyTargetName: "Weak Rival",
      bestExecutorReadyRelativeTroopRatio: 1.47,
      homeDanger: "low",
    });
  });

  it("detects economy cadence when stable expansion can become a first Factory", () => {
    const observation = observationWithTroops({
      troops: 180_000,
      maxTroops: 300_000,
    });
    const affordances = buildAgentTacticalAffordances({
      observation: {
        ...observation,
        turnNumber: 1_300,
        ownState:
          observation.ownState === null
            ? null
            : {
                ...observation.ownState,
                tilesOwned: 9_000,
                tileShare: 0.09,
                unitCounts: {
                  [UnitType.City]: 1,
                  [UnitType.Factory]: 0,
                  [UnitType.Port]: 0,
                },
              },
        memory: {
          ...observation.memory,
          recentExpansionCount: 2,
          recentBuildCount: 0,
        },
        strategic: {
          ...observation.strategic,
          priority: "build_economy",
          recommendedActionKinds: ["build", "attack", "hold"],
        },
      },
      legalActions: [
        expansionAttackAction("expand:terra-nullius:20", 20),
        {
          id: "build:Factory:10",
          kind: "build",
          label: "Build Factory",
          intent: { type: "build_unit", unit: UnitType.Factory, tile: 10 },
          risk: { level: "low", score: 0.1 },
          metadata: {
            unit: UnitType.Factory,
            role: "economic",
            economicValue: 0.82,
            buildPlacementReason: "safe interior factory",
          },
        },
      ],
    });

    expect(affordances.economyCadence).toMatchObject({
      tacticID: "economy_cadence",
      recommended: true,
      ownTiles: 9_000,
      ownTileShare: 0.09,
      recentExpansionCount: 2,
      recentBuildCount: 0,
      cityCount: 1,
      factoryCount: 0,
      firstFactoryMissing: true,
      economyBuildActionCount: 1,
      safeEconomyBuildActionCount: 1,
      bestBuildID: "build:Factory:10",
      bestBuildUnit: "Factory",
      bestBuildEconomicValue: 0.82,
      homeDanger: "low",
    });
    expect(affordances.notes.join(" ")).toContain("economy_cadence");
  });

  it("detects naval control when ports can produce a first warship", () => {
    const observation = observationWithTroops({
      troops: 180_000,
      maxTroops: 300_000,
    });
    const affordances = buildAgentTacticalAffordances({
      observation: {
        ...observation,
        turnNumber: 1_800,
        ownState:
          observation.ownState === null
            ? null
            : {
                ...observation.ownState,
                tileShare: 0.11,
                unitCounts: {
                  [UnitType.Port]: 1,
                  [UnitType.Warship]: 0,
                },
              },
        strategic: {
          ...observation.strategic,
          priority: "naval",
          recommendedActionKinds: ["warship", "boat", "hold"],
        },
      },
      legalActions: [
        {
          id: "warship:Port:777",
          kind: "warship",
          label: "Build Warship",
          intent: { type: "build_unit", unit: UnitType.Warship, tile: 777 },
          risk: { level: "low", score: 0.2 },
          metadata: {
            unit: UnitType.Warship,
            role: "defensive",
            targetTile: 777,
          },
        },
        boatAction("boat:444:25", 45_000),
      ],
    });

    expect(affordances.navalControl).toMatchObject({
      tacticID: "naval_control",
      recommended: true,
      portCount: 1,
      warshipCount: 0,
      boatLaunchActionCount: 1,
      warshipBuildActionCount: 1,
      bestNavalActionID: "warship:Port:777",
      bestNavalActionKind: "warship",
      homeDanger: "low",
    });
    expect(affordances.notes.join(" ")).toContain("naval_control");
  });

  it("detects late-game strike targeting for a leader missile silo", () => {
    const observation = observationWithTroops({
      troops: 900_000,
      maxTroops: 1_200_000,
    });
    const affordances = buildAgentTacticalAffordances({
      observation: {
        ...observation,
        turnNumber: 2_200,
        ownState:
          observation.ownState === null
            ? null
            : {
                ...observation.ownState,
                tileShare: 0.24,
                unitCounts: {
                  [UnitType.City]: 2,
                  [UnitType.Factory]: 1,
                  [UnitType.MissileSilo]: 1,
                },
              },
        visiblePlayers: [
          {
            playerID: "leader-1",
            clientID: "leader-1",
            smallID: 2,
            name: "Hard Leader",
            type: PlayerType.Nation,
            isAlive: true,
            isDisconnected: false,
            hasSpawned: true,
            isFriendly: false,
            isAllied: false,
            relation: Relation.Neutral,
            tilesOwned: 36_000,
            tileShare: 0.36,
            troops: 1_100_000,
            gold: "0",
            sharesBorder: true,
            relativeTroopRatio: 0.82,
            canAttack: true,
            canRequestAlliance: false,
            canDonateGold: false,
            canDonateTroops: false,
            canEmbargo: true,
            hasEmbargoAgainst: false,
            outgoingAttack: false,
            incomingAttack: false,
            hasOutgoingAllianceRequest: false,
            hasIncomingAllianceRequest: false,
            canTarget: true,
          },
        ],
        endgame: {
          winner: null,
          leaderID: "leader-1",
          leaderName: "Hard Leader",
          leaderTileShare: 0.36,
          ownTileShare: 0.24,
          turnsToTimer: 4_000,
        },
      },
      legalActions: [
        {
          id: "nuke:Hydrogen Bomb:leader-1:777",
          kind: "nuke",
          label: "Launch Hydrogen Bomb at Hard Leader silo",
          intent: {
            type: "build_unit",
            unit: UnitType.HydrogenBomb,
            tile: 777,
          },
          risk: { level: "high", score: 0.75 },
          metadata: {
            unit: UnitType.HydrogenBomb,
            targetID: "leader-1",
            targetName: "Hard Leader",
            targetTileShare: 0.36,
            targetStructureUnit: UnitType.MissileSilo,
            targetStructurePriority: 120,
            nuclearTargetPriority: 210,
          },
        },
        holdAction(),
      ],
    });

    expect(affordances.lateGameStrikeTargeting).toMatchObject({
      tacticID: "late_game_strike_targeting",
      recommended: true,
      legalStrikeActionCount: 1,
      highValueStrikeActionCount: 1,
      siloTargetActionCount: 1,
      bestStrikeActionID: "nuke:Hydrogen Bomb:leader-1:777",
      bestStrikeTargetName: "Hard Leader",
      bestStrikeTargetStructureUnit: UnitType.MissileSilo,
      homeDanger: "low",
    });
    expect(
      affordances.lateGameStrikeTargeting?.bestStrikeScore ?? 0,
    ).toBeGreaterThanOrEqual(118);
    expect(affordances.notes.join(" ")).toContain("late_game_strike_targeting");
  });

  it("detects personality diplomacy pressure for profile-specific social actions", () => {
    const base = observationWithTroops({
      troops: 240_000,
      maxTroops: 300_000,
    });
    const observation: AgentObservation = {
      ...base,
      profile: "aggressive",
      turnNumber: 1_100,
      visiblePlayers: [
        {
          playerID: "rival-1",
          clientID: "rival-1",
          smallID: 2,
          name: "Weak Rival",
          type: PlayerType.Nation,
          isAlive: true,
          isDisconnected: false,
          hasSpawned: true,
          troops: 120_000,
          maxTroops: 260_000,
          troopRatio: 0.46,
          gold: "10000",
          tilesOwned: 5_000,
          tileShare: 0.05,
          sharesBorder: true,
          isAllied: false,
          isFriendly: false,
          relation: Relation.Neutral,
          canAttack: true,
          canRequestAlliance: false,
          canDonateGold: false,
          canDonateTroops: false,
          canEmbargo: true,
          hasEmbargoAgainst: false,
          outgoingAttack: false,
          incomingAttack: false,
          hasOutgoingAllianceRequest: false,
          hasIncomingAllianceRequest: false,
          relativeTroopRatio: 1.55,
        },
      ],
      memory: {
        ...base.memory,
        recentExpansionCount: 2,
      },
    };
    const affordances = buildAgentTacticalAffordances({
      observation,
      legalActions: [
        {
          id: "target:rival-1",
          kind: "target_player",
          label: "Mark Weak Rival as target",
          intent: null,
          risk: { level: "medium", score: 0.45 },
          metadata: {
            targetID: "rival-1",
            targetName: "Weak Rival",
          },
        },
        {
          id: "emoji:rival-1:41",
          kind: "emoji",
          label: "Send target emoji",
          intent: null,
          risk: { level: "none", score: 0 },
          metadata: {
            recipientID: "rival-1",
            recipientName: "Weak Rival",
            emoji: 41,
          },
        },
        holdAction(),
      ],
    });

    expect(affordances.personalityDiplomacyPressure).toMatchObject({
      tacticID: "personality_diplomacy_pressure",
      recommended: true,
      profile: "aggressive",
      socialActionCount: 2,
      pressureActionCount: 1,
      communicationActionCount: 1,
      bestSocialActionID: "target:rival-1",
      bestSocialActionKind: "target_player",
      bestSocialTargetName: "Weak Rival",
      personalityMode: "aggressive_pressure",
      homeDanger: "low",
    });
    expect(affordances.notes.join(" ")).toContain(
      "personality_diplomacy_pressure",
    );
  });
});

function observationWithTroops(input: {
  troops: number;
  maxTroops: number;
  activeTransportTroops?: number;
  incomingThreatTroops?: number;
}): AgentObservation {
  const troopRatio = input.troops / input.maxTroops;
  const base = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: null,
    username: "Frontier",
    profile: "opportunistic",
    gameID: "TACTIC01",
    turnNumber: 100,
    phaseOverride: "active",
  });
  return {
    ...base,
    ownState: {
      playerID: "player-1",
      clientID: "client-1",
      smallID: 1,
      name: "Frontier",
      type: PlayerType.Human,
      isAlive: true,
      isDisconnected: false,
      isTraitor: false,
      hasSpawned: true,
      troops: input.troops,
      maxTroops: input.maxTroops,
      troopRatio,
      gold: "100000",
      tilesOwned: 1_000,
      tileShare: 0.35,
      borderTiles: 100,
      outgoingAttacks: 0,
      incomingAttacks: input.incomingThreatTroops === undefined ? 0 : 1,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
    },
    combat: {
      ownTroops: input.troops,
      maxTroops: input.maxTroops,
      troopRatio,
      borderedPlayerIDs: [],
      attackablePlayerIDs: [],
      canExpandIntoNeutral: false,
      neutralExpansionLegalReason: null,
      incomingAttackPlayerIDs:
        input.incomingThreatTroops === undefined ? [] : ["rival-1"],
      outgoingAttackPlayerIDs: [],
      outgoingAttacks: [],
      incomingAttacks:
        input.incomingThreatTroops === undefined
          ? []
          : [
              {
                attackID: "attack-1",
                targetID: "rival-1",
                targetName: "Rival",
                troops: input.incomingThreatTroops,
                retreating: false,
                sourceTile: 55,
                borderSize: 20,
              },
            ],
      weakestAttackableTargetID: null,
      strongestAttackableTargetID: null,
      blockerNotes: [],
    },
    nonCombat: {
      ...base.nonCombat,
      boatOptions: [
        {
          targetTile: 444,
          sourceTile: 111,
          targetID: "rival-1",
          targetName: "Rival",
          troops: 15_200,
          legalReason: "test transport",
        },
      ],
      boatRetreatOptions:
        input.activeTransportTroops === undefined
          ? []
          : [
              {
                unitID: 7,
                tile: 222,
                targetTile: 444,
                troops: input.activeTransportTroops,
                legalReason: "test active transport",
              },
            ],
    },
  };
}

function boatAction(id: string, troops: number): LegalAction {
  return {
    id,
    kind: "boat",
    label: id,
    intent: { type: "boat", troops, dst: 444 },
    risk: { level: "medium", score: 0.25 },
    metadata: {
      troops,
      targetTile: 444,
      targetID: "rival-1",
      targetName: "Rival",
      troopPercent: 25,
    },
  };
}

function expansionAttackAction(id: string, troopPercent: number): LegalAction {
  return {
    id,
    kind: "attack",
    label: id,
    intent: null,
    risk: { level: "low", score: 0.1 },
    metadata: {
      expansion: true,
      troopPercent,
      targetName: "Terra Nullius",
    },
  };
}

function hostileAttackAction(
  id: string,
  targetID: string,
  troopPercent: number,
  relativeTroopRatio: number,
): LegalAction {
  return {
    id,
    kind: "attack",
    label: id,
    intent: null,
    risk: { level: "medium", score: 0.2 },
    metadata: {
      targetID,
      targetName: "Weak Rival",
      troopPercent,
      relativeTroopRatio,
      targetTileShare: 0.06,
    },
  };
}

function holdAction(): LegalAction {
  return {
    id: "hold",
    kind: "hold",
    label: "Hold",
    intent: null,
    risk: { level: "none", score: 0 },
  };
}
