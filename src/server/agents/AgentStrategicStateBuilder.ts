import { tunedNumber } from "./AgentTunables";
import {
  AgentCombatState,
  AgentGamePhase,
  AgentNonCombatState,
  AgentOwnState,
  AgentStrategicPriority,
  AgentStrategicState,
  AgentStrategyProfile,
  AgentVisiblePlayer,
  LegalActionKind,
} from "./AgentTypes";

export interface BuildAgentStrategicStateInput {
  profile: AgentStrategyProfile;
  phase: AgentGamePhase;
  ownState: AgentOwnState | null;
  visiblePlayers: AgentVisiblePlayer[];
  combat: AgentCombatState;
  nonCombat: AgentNonCombatState;
}

export class AgentStrategicStateBuilder {
  build(input: BuildAgentStrategicStateInput): AgentStrategicState {
    const scores = strategicScores(input);
    const priority = strategicPriority(input, scores);
    const recommendedActionKinds = actionKindsForPriority(priority);
    const urgency = strategicUrgency(scores, priority);
    const targetPlayerIDs = strategicTargets(input, priority);
    const notes = strategicNotes(input);

    return {
      priority,
      urgency,
      summary: strategicSummary(priority, urgency, scores),
      scores,
      recommendedActionKinds,
      targetPlayerIDs,
      notes,
    };
  }
}

function strategicScores(input: BuildAgentStrategicStateInput) {
  const own = input.ownState;
  const attackable = input.visiblePlayers.filter(
    (player) => player.canAttack && !player.isFriendly,
  );
  const bordered = input.visiblePlayers.filter((player) => player.sharesBorder);
  const strongerBorderThreats = bordered.filter(
    (player) =>
      !player.isFriendly &&
      player.isAlive &&
      player.troops >
        (own?.troops ?? 0) * tunedNumber("THREAT_BORDER_TROOP_RATIO", 1.15),
  );
  const weakAttackable = attackable.filter(
    (player) =>
      player.relativeTroopRatio !== undefined && player.relativeTroopRatio >= 1,
  );
  const economicBuilds = input.nonCombat.buildOptions.filter(
    (build) => build.role === "economic",
  );
  const defensiveBuilds = input.nonCombat.buildOptions.filter(
    (build) => build.role === "defensive",
  );
  const playerBoatOptions =
    input.nonCombat.boatOptions?.filter((option) => option.targetID !== null)
      .length ?? 0;
  const neutralBoatOptions =
    input.nonCombat.boatOptions?.filter((option) => option.targetID === null)
      .length ?? 0;
  const navalOptions =
    playerBoatOptions +
    neutralBoatOptions +
    (input.nonCombat.warshipMoveOptions?.length ?? 0) +
    input.nonCombat.buildOptions.filter((build) => build.unit === "Warship")
      .length;
  const nuclearOptions = input.nonCombat.buildOptions.filter(
    (build) =>
      build.unit === "Atom Bomb" ||
      build.unit === "Hydrogen Bomb" ||
      build.unit === "MIRV",
  ).length;
  const troops = own?.troops ?? 0;
  const tiles = Math.max(own?.tilesOwned ?? 0, 1);
  const idleTroops = clamp01(troops / Math.max(50_000, tiles * 250));

  return {
    expansion: input.combat.canExpandIntoNeutral ? 0.9 : 0,
    economy: economicBuilds.length > 0 ? (tiles < 200 ? 0.85 : 0.65) : 0,
    defense:
      input.combat.incomingAttackPlayerIDs.length > 0
        ? 1
        : defensiveBuilds.length > 0 && strongerBorderThreats.length > 0
          ? 0.85
          : defensiveBuilds.length > 0 && bordered.length > 0
            ? 0.65
            : 0,
    offense:
      weakAttackable.length > 0
        ? Math.min(1, 0.55 + weakAttackable.length * 0.1)
        : attackable.length > 0
          ? 0.45
          : 0,
    diplomacy:
      input.visiblePlayers.some((player) => player.canRequestAlliance)
        ? 0.7
        : input.nonCombat.supportOptions.length > 0
          ? 0.6
          : 0,
    naval:
      playerBoatOptions > 0 &&
      attackable.length === 0 &&
      (own?.tileShare ?? 0) >= 0.45
        ? 0.9
        : navalOptions > 0
          ? 0.65
          : 0,
    nuclear: nuclearOptions > 0 ? 0.75 : 0,
    threat:
      input.combat.incomingAttackPlayerIDs.length > 0
        ? 1
        : strongerBorderThreats.length > 0
          ? 0.75
          : bordered.length > 0
            ? 0.45
            : 0,
    idleTroops,
  };
}

function strategicPriority(
  input: BuildAgentStrategicStateInput,
  scores: ReturnType<typeof strategicScores>,
): AgentStrategicPriority {
  if (input.phase === "spawn") {
    return "spawn";
  }
  if (
    scores.threat >= tunedNumber("THREAT_FLIP_SCORE", 0.85) ||
    scores.defense >= tunedNumber("DEFENSE_FLIP_SCORE", 0.85)
  ) {
    return "build_defense";
  }
  if (input.profile === "defensive" && scores.defense >= 0.6) {
    return "build_defense";
  }
  if (
    scores.offense >= tunedNumber("OFFENSE_TRIGGER_SCORE", 0.55) &&
    (input.profile === "aggressive" || input.profile === "opportunistic")
  ) {
    return "attack";
  }
  if (input.profile === "diplomatic" && scores.diplomacy >= 0.6) {
    return input.nonCombat.supportOptions.length > 0 ? "support" : "ally";
  }
  if (
    scores.nuclear >= 0.7 &&
    input.visiblePlayers.some((player) => (player.tileShare ?? 0) > 0.35)
  ) {
    return "nuclear";
  }
  if (scores.naval >= 0.6 && input.profile !== "defensive") {
    return "naval";
  }
  if (
    scores.expansion >= tunedNumber("EXPANSION_SCORE_GATE", 0.8) &&
    (scores.idleTroops >= tunedNumber("EXPAND_IDLE_TROOPS_GATE", 0.4) ||
      input.profile === "aggressive" ||
      input.profile === "opportunistic")
  ) {
    return "expand";
  }
  if (scores.economy >= 0.6) {
    return "build_economy";
  }
  if (scores.offense >= 0.45) {
    return "attack";
  }
  if (input.nonCombat.embargoOptions.length > 0) {
    return "pressure";
  }
  return "hold";
}

function strategicUrgency(
  scores: ReturnType<typeof strategicScores>,
  priority: AgentStrategicPriority,
): AgentStrategicState["urgency"] {
  if (priority === "spawn" || scores.threat >= 0.85) {
    return "high";
  }
  if (
    priority === "attack" ||
    priority === "expand" ||
    priority === "build_defense"
  ) {
    return "medium";
  }
  return "low";
}

function actionKindsForPriority(
  priority: AgentStrategicPriority,
): LegalActionKind[] {
  switch (priority) {
    case "spawn":
      return ["spawn", "hold"];
    case "expand":
    case "attack":
      return ["attack", "build", "embargo", "hold"];
    case "build_economy":
      return ["build", "attack", "alliance_request", "hold"];
    case "build_defense":
      return ["build", "alliance_request", "attack", "hold"];
    case "ally":
      return ["alliance_request", "build", "hold"];
    case "support":
      return ["donate_troops", "donate_gold", "build", "hold"];
    case "pressure":
      return ["embargo", "attack", "build", "hold"];
    case "naval":
      return ["boat", "warship", "move_warship", "attack", "hold"];
    case "nuclear":
      return ["nuke", "upgrade_structure", "build", "target_player", "hold"];
    case "hold":
      return ["hold"];
  }
}

function strategicTargets(
  input: BuildAgentStrategicStateInput,
  priority: AgentStrategicPriority,
): string[] {
  if (priority === "attack") {
    return [...input.visiblePlayers]
      .filter((player) => player.canAttack && !player.isFriendly)
      .sort((a, b) => a.troops - b.troops)
      .map((player) => player.playerID)
      .slice(0, 3);
  }
  if (priority === "ally" || priority === "support") {
    return input.visiblePlayers
      .filter(
        (player) =>
          player.canRequestAlliance ||
          player.canDonateGold ||
          player.canDonateTroops,
      )
      .map((player) => player.playerID)
      .slice(0, 3);
  }
  if (priority === "pressure") {
    return input.nonCombat.embargoOptions
      .map((option) => option.targetID)
      .slice(0, 3);
  }
  if (priority === "naval") {
    return (input.nonCombat.boatOptions ?? [])
      .map((option) => option.targetID)
      .filter((targetID): targetID is string => targetID !== null)
      .slice(0, 3);
  }
  if (priority === "nuclear") {
    return input.visiblePlayers
      .filter((player) => !player.isFriendly)
      .sort((a, b) => b.tilesOwned - a.tilesOwned)
      .map((player) => player.playerID)
      .slice(0, 3);
  }
  return [];
}

function strategicNotes(input: BuildAgentStrategicStateInput): string[] {
  const notes: string[] = [];
  if (input.ownState === null) {
    notes.push("own state unavailable");
  }
  if (input.combat.canExpandIntoNeutral) {
    notes.push("neutral expansion is available");
  }
  if (input.combat.attackablePlayerIDs.length === 0) {
    notes.push("no bordered player attack is currently legal");
  }
  if (input.nonCombat.buildOptions.length === 0) {
    notes.push("no proven build action is currently legal");
  }
  return notes;
}

function strategicSummary(
  priority: AgentStrategicPriority,
  urgency: AgentStrategicState["urgency"],
  scores: ReturnType<typeof strategicScores>,
): string {
  return [
    `priority=${priority}`,
    `urgency=${urgency}`,
    `expand=${scores.expansion}`,
    `economy=${scores.economy}`,
    `offense=${scores.offense}`,
    `defense=${scores.defense}`,
    `naval=${scores.naval}`,
    `nuclear=${scores.nuclear}`,
    `threat=${scores.threat}`,
  ].join(", ");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}
