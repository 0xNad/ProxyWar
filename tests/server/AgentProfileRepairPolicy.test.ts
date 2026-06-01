import { describe, expect, it } from "vitest";
import { PlayerType, Relation, UnitType } from "../../src/core/game/Game";
import { scoreProfileRepairRerankAction } from "../../src/server/agents/AgentProfileRepairPolicy";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import {
  AgentObservation,
  AgentVisiblePlayer,
  LegalAction,
} from "../../src/server/agents/AgentTypes";

describe("AgentProfileRepairPolicy", () => {
  it("boosts an aggressive weak-border attack and penalizes repeated neutral expansion", () => {
    const observation = repairedObservation("aggressive");
    const legalActions = [
      neutralExpansion(),
      weakBorderAttack(),
      targetPlayer(),
      hold(),
    ];

    expect(
      scoreProfileRepairRerankAction({
        profile: "aggressive",
        observation,
        legalActions,
        action: weakBorderAttack(),
      }),
    ).toMatchObject({
      module: "combat",
      score: 58,
    });
    expect(
      scoreProfileRepairRerankAction({
        profile: "aggressive",
        observation,
        legalActions,
        action: neutralExpansion(),
      }),
    ).toMatchObject({
      penaltyScore: 24,
    });
    expect(
      scoreProfileRepairRerankAction({
        profile: "aggressive",
        observation,
        legalActions,
        action: hold(),
      }),
    ).toMatchObject({
      penaltyScore: 46,
    });
  });

  it("uses profile-specific alternatives for defensive and diplomatic repairs", () => {
    const defensiveObservation = repairedObservation("defensive");
    const defensiveActions = [neutralExpansion(), defensePost(), hold()];
    const diplomaticObservation = repairedObservation("diplomatic");
    const diplomaticActions = [neutralExpansion(), allianceRequest(), hold()];

    expect(
      scoreProfileRepairRerankAction({
        profile: "defensive",
        observation: defensiveObservation,
        legalActions: defensiveActions,
        action: defensePost(),
      }),
    ).toMatchObject({
      module: "defense",
      score: 56,
    });
    expect(
      scoreProfileRepairRerankAction({
        profile: "diplomatic",
        observation: diplomaticObservation,
        legalActions: diplomaticActions,
        action: allianceRequest(),
      }),
    ).toMatchObject({
      module: "diplomacy",
      score: 58,
    });
  });

  it("does not interfere with early opening expansion", () => {
    const observation = {
      ...repairedObservation("opportunistic"),
      turnNumber: 200,
      ownState: {
        ...repairedObservation("opportunistic").ownState!,
        tileShare: 0.02,
        tilesOwned: 1_000,
      },
    };
    const legalActions = [neutralExpansion(), weakBorderAttack(), hold()];

    expect(
      scoreProfileRepairRerankAction({
        profile: "opportunistic",
        observation,
        legalActions,
        action: weakBorderAttack(),
      }),
    ).toBeNull();
  });
});

function repairedObservation(
  profile: AgentObservation["profile"],
): AgentObservation {
  const rival: AgentVisiblePlayer = {
    playerID: "RIVAL01",
    clientID: "RIVAL01",
    smallID: 2,
    name: "Weak Rival",
    type: PlayerType.Human,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 120_000,
    maxTroops: 220_000,
    troopRatio: 0.55,
    gold: "10000",
    tilesOwned: 5_000,
    tileShare: 0.05,
    sharesBorder: true,
    isAllied: false,
    isFriendly: false,
    relation: Relation.Neutral,
    canAttack: true,
    canRequestAlliance: true,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: true,
    canStopEmbargo: false,
    canTarget: true,
    canBreakAlliance: false,
    canExtendAlliance: false,
    canRejectAlliance: false,
    hasEmbargoAgainst: false,
    outgoingAttack: false,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    relativeTroopRatio: 1.6,
  };
  const base = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: null,
    username: "Repair Agent",
    profile,
    gameID: "REPAIR",
    turnNumber: 2_000,
    phaseOverride: "active",
  });
  return {
    ...base,
    visiblePlayers: [rival],
    ownState: {
      ...base.ownState!,
      troops: 260_000,
      maxTroops: 500_000,
      troopRatio: 0.52,
      tilesOwned: 12_000,
      tileShare: 0.12,
    },
    combat: {
      ...base.combat,
      ownTroops: 260_000,
      maxTroops: 500_000,
      troopRatio: 0.52,
      borderedPlayerIDs: ["RIVAL01"],
      attackablePlayerIDs: ["RIVAL01"],
      canExpandIntoNeutral: true,
      incomingAttackPlayerIDs: [],
      outgoingAttackPlayerIDs: [],
      weakestAttackableTargetID: "RIVAL01",
      strongestAttackableTargetID: "RIVAL01",
    },
    memory: {
      ...base.memory,
      recentExpansionCount: 3,
      recentBuildCount: 0,
      recentHoldCount: 0,
      repeatedActionKind: "attack",
      repeatedActionCount: 3,
    },
  };
}

function neutralExpansion(): LegalAction {
  return {
    id: "expand:terra-nullius:12",
    kind: "attack",
    label: "Expand to Terra Nullius",
    intent: { type: "attack", targetID: null, troops: 20_000 },
    risk: { level: "low", score: 0.1 },
    metadata: { expansion: true, targetID: null, troopPercent: 12 },
  };
}

function weakBorderAttack(): LegalAction {
  return {
    id: "attack:RIVAL01:20",
    kind: "attack",
    label: "Attack Weak Rival",
    intent: { type: "attack", targetID: "RIVAL01", troops: 52_000 },
    risk: { level: "medium", score: 0.3 },
    metadata: {
      targetID: "RIVAL01",
      targetName: "Weak Rival",
      troopPercent: 20,
      relativeTroopRatio: 1.6,
      sharesBorder: true,
    },
  };
}

function targetPlayer(): LegalAction {
  return {
    id: "target:RIVAL01",
    kind: "target_player",
    label: "Target Weak Rival",
    intent: null,
    risk: { level: "low", score: 0.1 },
    metadata: { targetID: "RIVAL01", targetName: "Weak Rival" },
  };
}

function defensePost(): LegalAction {
  return {
    id: "build:Defense Post:40",
    kind: "build",
    label: "Build Defense Post",
    intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 40 },
    risk: { level: "low", score: 0.1 },
    metadata: { role: "defensive", unit: "Defense Post", frontierValue: 0.8 },
  };
}

function allianceRequest(): LegalAction {
  return {
    id: "alliance:RIVAL01",
    kind: "alliance_request",
    label: "Request Alliance",
    intent: null,
    risk: { level: "low", score: 0.1 },
    metadata: { recipientID: "RIVAL01", recipientName: "Weak Rival" },
  };
}

function hold(): LegalAction {
  return {
    id: "hold",
    kind: "hold",
    label: "Hold",
    intent: null,
    risk: { level: "none", score: 0 },
  };
}
