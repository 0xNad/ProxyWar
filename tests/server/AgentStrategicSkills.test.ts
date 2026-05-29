import { describe, expect, it } from "vitest";
import { UnitType } from "../../src/core/game/Game";
import { AgentMemoryBuilder } from "../../src/server/agents/AgentMemoryBuilder";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import { StrategicSkillEvaluator } from "../../src/server/agents/AgentStrategicSkills";
import {
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";

describe("StrategicSkillEvaluator", () => {
  it("scores economic builds above hold for secure economy objectives", () => {
    const observation = observationWithObjective("secure_economy");
    const evaluation = new StrategicSkillEvaluator().evaluate({
      observation,
      legalActions: [economicBuild(), hold()],
    });

    expect(evaluation.topAction).toMatchObject({
      actionID: "build:City:100",
      topSkill: "economy_building",
      objectiveAligned: true,
    });
  });

  it("scores low-risk hostile attacks for pressure and attack timing", () => {
    const observation = observationWithObjective("pressure_rival");
    const attack: LegalAction = {
      id: "attack:PLAYER2:25",
      kind: "attack",
      label: "Attack Player Two with 25%",
      intent: { type: "attack", targetID: "PLAYER2", troops: 250 },
      risk: { level: "low", score: 0.2 },
      metadata: {
        targetID: "PLAYER2",
        targetName: "Player Two",
        troopPercent: 25,
        relativeTroopRatio: 1.5,
      },
    };

    const evaluation = new StrategicSkillEvaluator().evaluate({
      observation,
      legalActions: [attack, hold()],
    });

    expect(evaluation.topAction?.actionID).toBe("attack:PLAYER2:25");
    expect(evaluation.topAction?.scores.map((score) => score.skill)).toContain(
      "attack_timing",
    );
  });

  it("penalizes repeated low-value actions", () => {
    const base = observationWithObjective("expand_territory");
    const observation: AgentObservation = {
      ...base,
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "expand:terra-nullius:100",
            actionKind: "attack",
            accepted: true,
            reason: "expand",
            expansion: true,
          },
          {
            sequence: 2,
            actionID: "expand:terra-nullius:100",
            actionKind: "attack",
            accepted: true,
            reason: "expand again",
            expansion: true,
          },
        ],
      }),
    };
    const repeated: LegalAction = {
      id: "expand:terra-nullius:100",
      kind: "attack",
      label: "Expand again",
      intent: { type: "attack", targetID: null, troops: 100 },
      risk: { level: "low", score: 0.1 },
      metadata: { expansion: true },
    };

    const evaluation = new StrategicSkillEvaluator().evaluate({
      observation,
      legalActions: [repeated, economicBuild(), hold()],
    });
    const repeatedScore = evaluation.actions.find(
      (action) => action.actionID === repeated.id,
    );

    expect(repeatedScore?.penalties).toContain("recent repetition penalty");
    expect(repeatedScore?.penalties).toContain(
      "exact action was recently repeated",
    );
    expect(evaluation.topAction?.actionID).not.toBe(repeated.id);
  });

  it("diversifies repeated neutral expansion into economy when possible", () => {
    const base = observationWithObjective("expand_territory");
    const observation: AgentObservation = {
      ...base,
      memory: new AgentMemoryBuilder().build({
        recentDecisions: [
          {
            sequence: 1,
            actionID: "expand:terra-nullius:10",
            actionKind: "attack",
            accepted: true,
            reason: "expanded",
            expansion: true,
          },
          {
            sequence: 2,
            actionID: "expand:terra-nullius:20",
            actionKind: "attack",
            accepted: true,
            reason: "expanded again",
            expansion: true,
          },
        ],
      }),
    };
    const expansion: LegalAction = {
      id: "expand:terra-nullius:40",
      kind: "attack",
      label: "Expand with 40%",
      intent: { type: "attack", targetID: null, troops: 400 },
      risk: { level: "low", score: 0.1 },
      metadata: { expansion: true, troopPercent: 40 },
    };

    const evaluation = new StrategicSkillEvaluator().evaluate({
      observation,
      legalActions: [expansion, economicBuild(), hold()],
    });
    const expansionScore = evaluation.actions.find(
      (action) => action.actionID === expansion.id,
    );

    expect(expansionScore?.penalties).toContain(
      "neutral expansion streak should diversify",
    );
    expect(evaluation.topAction?.actionID).toBe("build:City:100");
  });

  it("uses economy cadence to explain safe infrastructure over more neutral expansion", () => {
    const base = observationWithObjective("expand_territory");
    const economy = economicBuild();
    const observation: AgentObservation = {
      ...base,
      tacticalAffordances: {
        transportTroopBanking: base.tacticalAffordances!.transportTroopBanking,
        openingExpansionTempo: base.tacticalAffordances!.openingExpansionTempo,
        frontierConversionTiming:
          base.tacticalAffordances!.frontierConversionTiming,
        frontierFinishPressure:
          base.tacticalAffordances!.frontierFinishPressure,
        notes: base.tacticalAffordances!.notes,
        economyCadence: {
          tacticID: "economy_cadence",
          recommended: true,
          turnNumber: 800,
          ownTiles: 8_000,
          ownTileShare: 0.08,
          troopRatio: 0.5,
          homeDanger: "low",
          recentExpansionCount: 2,
          recentBuildCount: 0,
          cityCount: 0,
          factoryCount: 0,
          portCount: 0,
          coreEconomyCount: 0,
          firstCityMissing: true,
          firstFactoryMissing: true,
          firstPortMissing: false,
          enoughLandBase: true,
          economyBuildActionCount: 1,
          safeEconomyBuildActionCount: 1,
          cityBuildActionCount: 1,
          factoryBuildActionCount: 0,
          portBuildActionCount: 0,
          bestBuildID: economy.id,
          bestBuildUnit: "City",
          bestBuildEconomicValue: 0.8,
          reasons: [
            "recommended: turn stable expansion into City, Factory, or Port infrastructure",
          ],
        },
      },
    };
    const expansion: LegalAction = {
      id: "expand:terra-nullius:20",
      kind: "attack",
      label: "Expand with 20%",
      intent: { type: "attack", targetID: null, troops: 200 },
      risk: { level: "low", score: 0.1 },
      metadata: { expansion: true, troopPercent: 20 },
    };

    const evaluation = new StrategicSkillEvaluator().evaluate({
      observation,
      legalActions: [expansion, economy, hold()],
    });
    const expansionScore = evaluation.actions.find(
      (action) => action.actionID === expansion.id,
    );
    const economyScore = evaluation.actions.find(
      (action) => action.actionID === economy.id,
    );

    expect(economyScore?.scores.map((score) => score.reason)).toContain(
      "economy cadence recommends converting stable expansion into infrastructure",
    );
    expect(expansionScore?.penalties).toContain(
      "economy cadence recommends infrastructure before more neutral expansion",
    );
    expect(evaluation.topAction?.actionID).toBe(economy.id);
  });

  it("uses frontier finish pressure to prefer a decisive weak-rival attack", () => {
    const base = observationWithObjective("expand_territory");
    const finishAttack: LegalAction = {
      id: "attack:rival-1:25",
      kind: "attack",
      label: "Attack Weak Rival with 25%",
      intent: { type: "attack", targetID: "rival-1", troops: 250 },
      risk: { level: "low", score: 0.12 },
      metadata: {
        targetID: "rival-1",
        targetName: "Weak Rival",
        troopPercent: 25,
        relativeTroopRatio: 1.7,
      },
    };
    const expansion: LegalAction = {
      id: "expand:terra-nullius:20",
      kind: "attack",
      label: "Expand with 20%",
      intent: { type: "attack", targetID: null, troops: 200 },
      risk: { level: "low", score: 0.1 },
      metadata: { expansion: true, troopPercent: 20 },
    };
    const observation: AgentObservation = {
      ...base,
      tacticalAffordances: {
        transportTroopBanking: base.tacticalAffordances!.transportTroopBanking,
        openingExpansionTempo: base.tacticalAffordances!.openingExpansionTempo,
        frontierConversionTiming:
          base.tacticalAffordances!.frontierConversionTiming,
        economyCadence: base.tacticalAffordances!.economyCadence,
        notes: base.tacticalAffordances!.notes,
        frontierFinishPressure: {
          tacticID: "frontier_finish_pressure",
          recommended: true,
          turnNumber: 1_200,
          ownTileShare: 0.12,
          troopRatio: 0.68,
          homeDanger: "low",
          activeTargetID: "rival-1",
          activeTargetName: "Weak Rival",
          recentTargetAttackCount: 4,
          recentLowCommitmentAttackCount: 3,
          repeatedLowCommitmentProbe: true,
          finishingAttackActionCount: 1,
          decisiveAttackActionCount: 1,
          bestTargetID: "rival-1",
          bestTargetName: "Weak Rival",
          bestTargetRelativeTroopRatio: 1.7,
          bestTargetTileShare: 0.045,
          bestTargetTroops: 120_000,
          bestAttackTroopPercent: 25,
          bestAttackID: finishAttack.id,
          reasons: [
            "recommended: escalate repeated probes into a decisive finish attack",
          ],
        },
      },
    };

    const evaluation = new StrategicSkillEvaluator().evaluate({
      observation,
      legalActions: [expansion, finishAttack, hold()],
    });
    const attackScore = evaluation.actions.find(
      (action) => action.actionID === finishAttack.id,
    );
    const expansionScore = evaluation.actions.find(
      (action) => action.actionID === expansion.id,
    );

    expect(attackScore?.scores.map((score) => score.reason)).toContain(
      "frontier finish pressure recommends ending repeated probes",
    );
    expect(expansionScore?.penalties).toContain(
      "frontier finish pressure recommends converting the weak rival before more neutral expansion",
    );
    expect(evaluation.topAction?.actionID).toBe(finishAttack.id);
  });

  it("uses naval control to prefer first warship coverage over hold", () => {
    const base = observationWithObjective("fortify_border");
    const warship: LegalAction = {
      id: "warship:Port:777",
      kind: "warship",
      label: "Build Warship",
      intent: { type: "build_unit", unit: UnitType.Warship, tile: 777 },
      risk: { level: "low", score: 0.2 },
      metadata: {
        unit: UnitType.Warship,
        role: "defensive",
      },
    };
    const observation: AgentObservation = {
      ...base,
      tacticalAffordances: {
        transportTroopBanking: base.tacticalAffordances!.transportTroopBanking,
        openingExpansionTempo: base.tacticalAffordances!.openingExpansionTempo,
        frontierConversionTiming:
          base.tacticalAffordances!.frontierConversionTiming,
        frontierFinishPressure:
          base.tacticalAffordances!.frontierFinishPressure,
        economyCadence: base.tacticalAffordances!.economyCadence,
        notes: base.tacticalAffordances!.notes,
        navalControl: {
          tacticID: "naval_control",
          recommended: true,
          turnNumber: 1_800,
          ownTileShare: 0.12,
          troopRatio: 0.7,
          homeDanger: "low",
          portCount: 1,
          warshipCount: 0,
          activeTransportCount: 0,
          activeTransportTroops: 0,
          boatLaunchActionCount: 0,
          neutralBoatActionCount: 0,
          navalInvasionActionCount: 0,
          warshipBuildActionCount: 1,
          warshipMoveActionCount: 0,
          safeNavalActionCount: 1,
          bestNavalActionID: warship.id,
          bestNavalActionKind: "warship",
          bestNavalTargetID: null,
          bestNavalTargetName: null,
          bestNavalTroopPercent: null,
          reasons: [
            "recommended: use the best transport, warship, or patrol action before naval options stall",
          ],
        },
      },
    };

    const evaluation = new StrategicSkillEvaluator().evaluate({
      observation,
      legalActions: [warship, hold()],
    });
    const warshipScore = evaluation.actions.find(
      (action) => action.actionID === warship.id,
    );
    const holdScore = evaluation.actions.find(
      (action) => action.actionID === "hold",
    );

    expect(warshipScore?.scores.map((score) => score.reason)).toContain(
      "naval control recommends warship coverage",
    );
    expect(holdScore?.penalties).toContain(
      "hold while naval control action is available",
    );
    expect(evaluation.topAction?.actionID).toBe(warship.id);
  });

  it("uses late-game strike targeting to prefer a leader silo nuke over hold", () => {
    const base = observationWithObjective("pressure_rival");
    const nuke: LegalAction = {
      id: "nuke:Hydrogen Bomb:leader-1:777",
      kind: "nuke",
      label: "Launch Hydrogen Bomb at leader silo",
      intent: { type: "build_unit", unit: UnitType.HydrogenBomb, tile: 777 },
      risk: { level: "high", score: 0.75 },
      metadata: {
        unit: UnitType.HydrogenBomb,
        targetID: "leader-1",
        targetName: "Hard Leader",
        targetStructureUnit: UnitType.MissileSilo,
        targetStructurePriority: 120,
        nuclearTargetPriority: 210,
        targetTileShare: 0.36,
      },
    };
    const observation: AgentObservation = {
      ...base,
      tacticalAffordances: {
        transportTroopBanking: base.tacticalAffordances!.transportTroopBanking,
        openingExpansionTempo: base.tacticalAffordances!.openingExpansionTempo,
        frontierConversionTiming:
          base.tacticalAffordances!.frontierConversionTiming,
        frontierFinishPressure:
          base.tacticalAffordances!.frontierFinishPressure,
        economyCadence: base.tacticalAffordances!.economyCadence,
        navalControl: base.tacticalAffordances!.navalControl,
        notes: base.tacticalAffordances!.notes,
        lateGameStrikeTargeting: {
          tacticID: "late_game_strike_targeting",
          recommended: true,
          turnNumber: 2_200,
          ownTileShare: 0.24,
          troopRatio: 0.75,
          homeDanger: "low",
          legalStrikeActionCount: 1,
          highValueStrikeActionCount: 1,
          siloTargetActionCount: 1,
          samTargetActionCount: 0,
          economyTargetActionCount: 0,
          coveredNonSamTargetActionCount: 0,
          recentNukeCount: 0,
          bestStrikeActionID: nuke.id,
          bestStrikeWeapon: UnitType.HydrogenBomb,
          bestStrikeTargetID: "leader-1",
          bestStrikeTargetName: "Hard Leader",
          bestStrikeTargetTileShare: 0.36,
          bestStrikeTargetStructureUnit: UnitType.MissileSilo,
          bestStrikeTargetStructurePriority: 120,
          bestStrikeTargetSamCoverage: 0,
          bestStrikeNuclearTargetPriority: 210,
          bestStrikeScore: 210,
          reasons: [
            "recommended: use the best legal nuke against a strategic target before late-game pressure stalls",
          ],
        },
      },
    };

    const evaluation = new StrategicSkillEvaluator().evaluate({
      observation,
      legalActions: [nuke, hold()],
    });
    const nukeScore = evaluation.actions.find(
      (action) => action.actionID === nuke.id,
    );
    const holdScore = evaluation.actions.find(
      (action) => action.actionID === "hold",
    );

    expect(nukeScore?.scores.map((score) => score.reason)).toContain(
      "late-game strike targeting recommends this strategic target",
    );
    expect(holdScore?.penalties).toContain(
      "hold while late-game strike target is available",
    );
    expect(evaluation.topAction?.actionID).toBe(nuke.id);
  });

  it("uses personality diplomacy pressure to prefer a profile-specific social action over hold", () => {
    const base = observationWithObjective("pressure_rival");
    const target: LegalAction = {
      id: "target:rival-1",
      kind: "target_player",
      label: "Mark Weak Rival as target",
      intent: { type: "targetPlayer", target: "rival-1" },
      risk: { level: "medium", score: 0.45 },
      metadata: {
        targetID: "rival-1",
        targetName: "Weak Rival",
      },
    };
    const observation: AgentObservation = {
      ...base,
      profile: "aggressive",
      tacticalAffordances: {
        transportTroopBanking: base.tacticalAffordances!.transportTroopBanking,
        openingExpansionTempo: base.tacticalAffordances!.openingExpansionTempo,
        frontierConversionTiming:
          base.tacticalAffordances!.frontierConversionTiming,
        frontierFinishPressure:
          base.tacticalAffordances!.frontierFinishPressure,
        economyCadence: base.tacticalAffordances!.economyCadence,
        navalControl: base.tacticalAffordances!.navalControl,
        lateGameStrikeTargeting:
          base.tacticalAffordances!.lateGameStrikeTargeting,
        notes: base.tacticalAffordances!.notes,
        personalityDiplomacyPressure: {
          tacticID: "personality_diplomacy_pressure",
          recommended: true,
          turnNumber: 1_200,
          profile: "aggressive",
          homeDanger: "low",
          recentSocialActionCount: 0,
          recentPressureActionCount: 0,
          socialActionCount: 2,
          pressureActionCount: 1,
          allianceActionCount: 0,
          supportActionCount: 0,
          communicationActionCount: 1,
          targetActionCount: 1,
          embargoActionCount: 0,
          bestSocialActionID: target.id,
          bestSocialActionKind: "target_player",
          bestSocialTargetID: "rival-1",
          bestSocialTargetName: "Weak Rival",
          bestSocialScore: 112,
          personalityMode: "aggressive_pressure",
          reasons: [
            "recommended: use the best profile-specific social action",
          ],
        },
      },
    };

    const evaluation = new StrategicSkillEvaluator().evaluate({
      observation,
      legalActions: [target, hold()],
    });
    const targetScore = evaluation.actions.find(
      (action) => action.actionID === target.id,
    );
    const holdScore = evaluation.actions.find(
      (action) => action.actionID === "hold",
    );

    expect(targetScore?.scores.map((score) => score.reason)).toContain(
      "personality diplomacy pressure recommends this profile-specific social action",
    );
    expect(holdScore?.penalties).toContain(
      "hold while personality diplomacy pressure is available",
    );
    expect(evaluation.topAction?.actionID).toBe(target.id);
  });

  it("penalizes Defense Posts without proven frontier value", () => {
    const observation = observationWithObjective("fortify_border");
    const interiorDefense: LegalAction = {
      id: "build:Defense Post:200",
      kind: "build",
      label: "Build Defense Post",
      intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 200 },
      risk: { level: "low", score: 0.1 },
      metadata: {
        role: "defensive",
        unit: UnitType.DefensePost,
        defensiveValue: 0.02,
        frontierValue: 0,
        hostileBorderDistance: null,
        nearbyEnemyCount: 0,
        nearbyIncomingAttack: false,
        buildPlacementReason:
          "Defense Post has no proven hostile frontier coverage.",
      },
    };

    const evaluation = new StrategicSkillEvaluator().evaluate({
      observation,
      legalActions: [interiorDefense, economicBuild(), hold()],
    });
    const defenseScore = evaluation.actions.find(
      (action) => action.actionID === interiorDefense.id,
    );

    expect(defenseScore?.penalties).toContain(
      "Defense Post lacks proven frontier value",
    );
    expect(evaluation.topAction?.actionID).not.toBe(interiorDefense.id);
  });

  it("rewards Defense Posts near hostile frontiers", () => {
    const observation = observationWithObjective("fortify_border");
    const borderDefense: LegalAction = {
      id: "build:Defense Post:201",
      kind: "build",
      label: "Build Defense Post",
      intent: { type: "build_unit", unit: UnitType.DefensePost, tile: 201 },
      risk: { level: "low", score: 0.1 },
      metadata: {
        role: "defensive",
        unit: UnitType.DefensePost,
        defensiveValue: 0.82,
        frontierValue: 0.76,
        hostileBorderDistance: 18,
        nearbyEnemyCount: 1,
        nearbyIncomingAttack: true,
        buildPlacementReason:
          "Defense Post covers an active land-attack frontier.",
      },
    };

    const evaluation = new StrategicSkillEvaluator().evaluate({
      observation,
      legalActions: [borderDefense, economicBuild(), hold()],
    });

    expect(evaluation.topAction).toMatchObject({
      actionID: borderDefense.id,
      topSkill: "defense_building",
    });
  });
});

function observationWithObjective(
  kind: NonNullable<AgentObservation["objective"]>["kind"],
): AgentObservation {
  const observation = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: null,
    username: "Skill Agent",
    profile: "opportunistic",
    gameID: "SKILL",
    turnNumber: 10,
    phaseOverride: "active",
  });
  return {
    ...observation,
    objective: {
      objectiveID: `agent-1:${kind}`,
      kind,
      label: kind,
      status: "active",
      createdTurn: 10,
      updatedTurn: 10,
      preferredActionKinds:
        kind === "secure_economy" ? ["build", "hold"] : ["attack", "hold"],
      progress: {
        recentDecisionCount: 0,
        alignedRecentDecisionCount: 0,
        consecutiveAlignedDecisionCount: 0,
      },
      summary: `${kind} active`,
      notes: [],
    },
  };
}

function economicBuild(): LegalAction {
  return {
    id: "build:City:100",
    kind: "build",
    label: "Build City",
    intent: { type: "build_unit", unit: UnitType.City, tile: 100 },
    risk: { level: "medium", score: 0.3 },
    metadata: { role: "economic", unit: "City" },
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
