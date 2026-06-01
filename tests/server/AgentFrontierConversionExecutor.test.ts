import { describe, expect, it } from "vitest";
import { PlayerType, Relation } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import {
  FrontierPolicyExecutor,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import { buildAgentTacticalAffordances } from "../../src/server/agents/AgentTacticalAffordances";
import {
  AgentObservation,
  AgentVisiblePlayer,
  LegalAction,
} from "../../src/server/agents/AgentTypes";

describe("frontier conversion executor handoff", () => {
  it("uses the calibrated ready window to select a legal weak-rival attack", () => {
    const observation = hardNationConversionObservation();
    const legalActions: LegalAction[] = [
      hostileAttack("attack:rival-1:10", "rival-1", "Weak Rival", 10, 2.2),
      hold(),
    ];

    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      pressurePlan(observation),
    );

    expect(decision.actionID).toBe("attack:rival-1:10");
    expect(decision.blockedHostileAttackSummary).not.toContain(
      "attack:rival-1:10",
    );
  });

  it("escalates repeated low probes into a decisive finish-pressure attack", () => {
    const base = hardNationConversionObservation();
    const observation: AgentObservation = {
      ...base,
      turnNumber: 1_900,
      tick: 1_900,
      ownState: {
        ...base.ownState!,
        troops: 900_000,
        maxTroops: 1_300_000,
        troopRatio: 0.69,
        tilesOwned: 31_000,
        tileShare: 0.31,
      },
      combat: {
        ...base.combat,
        ownTroops: 900_000,
        maxTroops: 1_300_000,
        troopRatio: 0.69,
        outgoingAttackPlayerIDs: ["rival-1"],
      },
      memory: {
        ...base.memory,
        recentActions: [
          recentAttack(1, "attack:rival-1:10"),
          recentAttack(2, "attack:rival-1:10"),
          recentAttack(3, "attack:rival-1:10"),
        ],
        repeatedActionKind: "attack" as const,
        repeatedActionCount: 3,
        avoidActionIDs: ["attack:rival-1:10"],
      },
    };
    const legalActions: LegalAction[] = [
      hostileAttack("attack:rival-1:10", "rival-1", "Weak Rival", 10, 2.1),
      hostileAttack("attack:rival-1:25", "rival-1", "Weak Rival", 25, 2.1),
      hold(),
    ];

    const affordances = buildAgentTacticalAffordances({
      observation,
      legalActions,
    });
    const decision = new FrontierPolicyExecutor("opportunistic").decide(
      { observation, legalActions },
      pressurePlan(observation),
    );

    expect(affordances.frontierFinishPressure).toMatchObject({
      tacticID: "frontier_finish_pressure",
      recommended: true,
      repeatedLowCommitmentProbe: true,
      bestAttackID: "attack:rival-1:25",
    });
    expect(decision.actionID).toBe("attack:rival-1:25");
  });
});

function hardNationConversionObservation(): AgentObservation {
  const base = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: null,
    username: "Frontier",
    profile: "opportunistic",
    gameID: "CONVERT01",
    turnNumber: 900,
    phaseOverride: "active",
  });
  return {
    ...base,
    tick: 900,
    ownState: {
      playerID: "agent-1",
      clientID: null,
      smallID: 1,
      name: "Frontier",
      type: PlayerType.Human,
      isAlive: true,
      isDisconnected: false,
      isTraitor: false,
      hasSpawned: true,
      troops: 430_000,
      maxTroops: 1_000_000,
      troopRatio: 0.45,
      gold: "0",
      tilesOwned: 14_000,
      tileShare: 0.12,
      borderTiles: 800,
      outgoingAttacks: 0,
      incomingAttacks: 0,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
    },
    combat: {
      ...base.combat,
      ownTroops: 430_000,
      maxTroops: 1_000_000,
      troopRatio: 0.39,
      borderedPlayerIDs: ["rival-1"],
      attackablePlayerIDs: ["rival-1"],
      canExpandIntoNeutral: true,
      neutralExpansionLegalReason: "neutral still legal",
      incomingAttackPlayerIDs: [],
      outgoingAttackPlayerIDs: [],
    },
    visiblePlayers: [
      nation("rival-1", 2, "Weak Rival", 190_000, 7_000, 0.07, 2.2),
      nation("rival-2", 3, "Leader", 520_000, 23_000, 0.2, 0.82),
      nation("rival-3", 4, "North", 410_000, 15_000, 0.13, 1.05),
      nation("rival-4", 5, "South", 380_000, 12_000, 0.1, 1.13),
      nation("rival-5", 6, "West", 360_000, 11_000, 0.09, 1.19),
    ],
    endgame: {
      winner: null,
      ownTileShare: 0.12,
      leaderID: "rival-2",
      leaderName: "Leader",
      leaderTileShare: 0.2,
      turnsToTimer: null,
    },
    strategic: {
      ...base.strategic,
      priority: "attack",
      urgency: "medium",
    },
    memory: {
      ...base.memory,
      recentExpansionCount: 3,
      recentHoldCount: 1,
      recentActions: [],
      avoidActionIDs: [],
    },
  };
}

function nation(
  playerID: string,
  smallID: number,
  name: string,
  troops: number,
  tilesOwned: number,
  tileShare: number,
  relativeTroopRatio: number,
): AgentVisiblePlayer {
  return {
    playerID,
    clientID: playerID,
    smallID,
    name,
    type: PlayerType.Nation,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops,
    maxTroops: troops * 2,
    troopRatio: 0.5,
    gold: "0",
    tilesOwned,
    tileShare,
    sharesBorder: playerID === "rival-1",
    isAllied: false,
    isFriendly: false,
    relation: Relation.Hostile,
    canAttack: playerID === "rival-1",
    canRequestAlliance: false,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: true,
    hasEmbargoAgainst: false,
    outgoingAttack: false,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    relativeTroopRatio,
  };
}

function hostileAttack(
  id: string,
  targetID: string,
  targetName: string,
  troopPercent: number,
  relativeTroopRatio: number,
): LegalAction {
  return {
    id,
    kind: "attack",
    label: `Attack ${targetName} with ${troopPercent}% troops`,
    intent: { type: "attack", targetID, troops: 43_000 },
    risk: { level: "medium", score: 0.3 },
    metadata: {
      targetID,
      targetName,
      targetTroops: 190_000,
      targetTiles: 7_000,
      targetTileShare: 0.07,
      troopPercentage: troopPercent / 100,
      troopPercent,
      relativeTroopRatio,
    },
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

function recentAttack(sequence: number, actionID: string) {
  return {
    sequence,
    actionID,
    actionKind: "attack" as const,
    reason: "recent probe",
    accepted: true,
    targetID: "rival-1",
    targetName: "Weak Rival",
    expansion: false,
  };
}

function pressurePlan(observation: AgentObservation): StrategicPlan {
  return {
    planID: "agent-1:pressure",
    objective: "pressure_rival",
    targetPlayerId: "rival-1",
    rationale: "convert weak rival",
    startedAtTick: observation.tick,
    maxDecisionCycles: 3,
    successCriteria: ["gain land from weak rival"],
    failureCriteria: ["target becomes unsafe"],
    preferredActionKinds: ["attack", "hold"],
    forbiddenActionKinds: [],
    enabledModules: ["combat", "utility_social"],
    plannerSource: "mock-llm",
  };
}
