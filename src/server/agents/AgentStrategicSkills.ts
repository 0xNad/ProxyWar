import {
  AgentBrainInput,
  AgentObjectiveKind,
  AgentObservation,
  LegalAction,
  LegalActionKind,
} from "./AgentTypes";
import {
  isPersonalityDiplomacyActionKind,
  personalityDiplomacyActionPlayerID,
  personalityDiplomacyKindGroup,
} from "./AgentPersonalityDiplomacyPolicy";

export const strategicSkills = [
  "expansion",
  "troop_conservation",
  "economy_building",
  "defense_building",
  "diplomacy",
  "pressure",
  "attack_timing",
  "support_ally",
  "recovery",
  "opportunism",
] as const;

export type StrategicSkill = (typeof strategicSkills)[number];

export interface StrategicSkillScore {
  skill: StrategicSkill;
  score: number;
  reason: string;
}

export interface StrategicActionSkillEvaluation {
  actionID: string;
  actionKind: LegalActionKind;
  label: string;
  totalScore: number;
  topSkill: StrategicSkill;
  topSkillScore: number;
  scores: StrategicSkillScore[];
  penalties: string[];
  repeated: boolean;
  planAligned: boolean;
  objectiveAligned: boolean;
}

export interface StrategicSkillEvaluation {
  actions: StrategicActionSkillEvaluation[];
  topAction: StrategicActionSkillEvaluation | null;
  summary: string;
}

export interface StrategicSkillPlanView {
  objective?: AgentObjectiveKind;
  preferredActionKinds?: LegalActionKind[];
  forbiddenActionKinds?: LegalActionKind[];
  targetPlayerId?: string | null;
}

export interface StrategicSkillEvaluatorInput extends AgentBrainInput {
  plan?: StrategicSkillPlanView | null;
}

export class StrategicSkillEvaluator {
  evaluate(input: StrategicSkillEvaluatorInput): StrategicSkillEvaluation {
    const actions = input.legalActions
      .map((action) => this.evaluateAction(input, action))
      .sort(
        (a, b) =>
          b.totalScore - a.totalScore || a.actionID.localeCompare(b.actionID),
      );
    const topAction = actions[0] ?? null;
    return {
      actions,
      topAction,
      summary:
        topAction === null
          ? "no legal actions to score"
          : `${topAction.actionID} ${topAction.topSkill}=${topAction.topSkillScore} total=${topAction.totalScore}`,
    };
  }

  private evaluateAction(
    input: StrategicSkillEvaluatorInput,
    action: LegalAction,
  ): StrategicActionSkillEvaluation {
    const scores: StrategicSkillScore[] = [];
    const penalties: string[] = [];
    const observation = input.observation;

    const add = (skill: StrategicSkill, score: number, reason: string) => {
      if (score > 0) {
        scores.push({ skill, score, reason });
      }
    };

    switch (action.kind) {
      case "spawn":
        add("expansion", 90, "spawn starts territorial presence");
        add(
          "opportunism",
          metadataNumber(action, "opportunityScore") * 12,
          "spawn opportunity score",
        );
        break;
      case "attack":
        if (action.metadata?.expansion === true) {
          add("expansion", 78, "neutral expansion grows territory");
          add("opportunism", 22, "neutral expansion is usually low conflict");
        } else {
          add("pressure", 64, "hostile attack pressures a rival");
          add(
            "attack_timing",
            attackTimingScore(action),
            "attack risk and strength metadata",
          );
          if (frontierFinishPressureAttackRecommended(observation, action)) {
            add(
              "pressure",
              42,
              "frontier finish pressure recommends ending repeated probes",
            );
            add(
              "attack_timing",
              18,
              "decisive weak-rival finish window is visible",
            );
          }
        }
        add(
          "troop_conservation",
          conservationScore(action),
          "bounded troop commitment",
        );
        break;
      case "retreat":
      case "boat_retreat":
        add("recovery", 82, "retreat preserves committed troops");
        add(
          "troop_conservation",
          58,
          "canceling bad pressure protects reserves",
        );
        break;
      case "boat":
        add(
          "expansion",
          action.metadata?.targetID === null ? 64 : 28,
          "transport can reach distant land",
        );
        add(
          "opportunism",
          38,
          "naval access creates an angle unavailable by land",
        );
        add(
          "troop_conservation",
          conservationScore(action),
          "transport uses bounded troops",
        );
        if (navalControlActionRecommended(observation, action)) {
          add("opportunism", 34, "naval control recommends using sea access");
        }
        break;
      case "build":
      case "warship":
      case "nuke":
        if (action.kind === "warship") {
          add("defense_building", 62, "warship protects ports and transports");
          add("pressure", 24, "warship pressures enemy sea lanes");
          if (navalControlActionRecommended(observation, action)) {
            add("pressure", 30, "naval control recommends warship coverage");
          }
        } else if (action.metadata?.role === "defensive") {
          const defenseQuality = defensiveBuildQuality(action);
          add("defense_building", defenseQuality.score, defenseQuality.reason);
          add(
            "recovery",
            threatened(observation) ? 28 : defenseQuality.recoveryScore,
            "defense helps survival when it covers a real frontier",
          );
        } else if (action.kind === "nuke") {
          add(
            "pressure",
            84,
            "nuke can stop a leader or break dense structures",
          );
          add("opportunism", 18, "late-game weapon can convert saved gold");
          if (lateGameStrikeActionRecommended(observation, action)) {
            add(
              "pressure",
              action.id ===
                observation.tacticalAffordances?.lateGameStrikeTargeting
                  ?.bestStrikeActionID
                ? 52
                : 30,
              "late-game strike targeting recommends this strategic target",
            );
          }
        } else {
          add("economy_building", 76, "economic structure improves production");
          add("opportunism", 16, "safe non-combat investment");
          if (economyCadenceBuildRecommended(observation, action)) {
            add(
              "economy_building",
              action.id ===
                observation.tacticalAffordances?.economyCadence?.bestBuildID
                ? 34
                : 22,
              "economy cadence recommends converting stable expansion into infrastructure",
            );
          }
          if (
            shouldDiversifyAfterExpansion(
              observation,
              action,
              input.legalActions,
            )
          ) {
            add(
              "economy_building",
              26,
              "breaks a repeated expansion streak with useful economy",
            );
          }
        }
        break;
      case "upgrade_structure":
        add("economy_building", 48, "upgrade improves existing infrastructure");
        add("defense_building", 28, "upgrades preserve dense build sites");
        break;
      case "delete_unit":
        add("recovery", 36, "delete can remove doomed or misplaced structures");
        break;
      case "alliance_request":
      case "alliance_extend":
        add("diplomacy", 76, "alliance can reduce early risk");
        add(
          "recovery",
          threatened(observation) ? 22 : 4,
          "diplomacy can reduce threats",
        );
        if (
          shouldDiversifyAfterExpansion(observation, action, input.legalActions)
        ) {
          add(
            "diplomacy",
            18,
            "breaks a repeated expansion streak with diplomacy",
          );
        }
        break;
      case "alliance_reject":
      case "break_alliance":
        add("pressure", 44, "ending diplomacy can open necessary pressure");
        add("opportunism", 16, "diplomacy reset can prevent leader protection");
        break;
      case "donate_gold":
      case "donate_troops":
        add("support_ally", 78, "support action strengthens an ally");
        add("diplomacy", 34, "support reinforces alliance value");
        break;
      case "embargo":
      case "embargo_all":
        add("pressure", 70, "embargo applies non-combat pressure");
        add(
          "opportunism",
          12,
          "embargo is useful when attacks are unavailable",
        );
        if (
          shouldDiversifyAfterExpansion(observation, action, input.legalActions)
        ) {
          add(
            "pressure",
            16,
            "breaks a repeated expansion streak with pressure",
          );
        }
        break;
      case "embargo_stop":
        add("diplomacy", 34, "ending embargo can reopen useful relations");
        break;
      case "move_warship":
        add("defense_building", 44, "warship movement protects sea lanes");
        add("pressure", 28, "warship movement can hunt transports or trade");
        if (navalControlActionRecommended(observation, action)) {
          add("pressure", 30, "naval control recommends active patrols");
        }
        break;
      case "target_player":
        add("pressure", 46, "target marks a rival for coordinated pressure");
        break;
      case "quick_chat":
      case "emoji":
        add("diplomacy", 16, "communication can coordinate or signal intent");
        break;
      case "hold":
        add(
          "troop_conservation",
          42,
          "hold conserves troops and avoids unsafe action",
        );
        add(
          "recovery",
          threatened(observation) ? 18 : 2,
          "hold can be safe under uncertainty",
        );
        break;
    }

    if (personalityDiplomacyPressureActionRecommended(observation, action)) {
      add(
        skillForAction(action),
        action.id ===
          observation.tacticalAffordances?.personalityDiplomacyPressure
            ?.bestSocialActionID
          ? 36
          : 18,
        "personality diplomacy pressure recommends this profile-specific social action",
      );
    }

    this.addProfileScores(observation, action, add);
    this.addObjectiveScores(observation.objective?.kind ?? null, action, add);
    this.addPlanScores(input.plan ?? null, action, add, penalties);

    const repeated = isRepeated(observation, action);
    if (repeated) {
      penalties.push("recent repetition penalty");
    }
    if (observation.memory.avoidActionIDs.includes(action.id)) {
      penalties.push("exact action was recently repeated");
    }
    if (action.risk.level === "high") {
      penalties.push("high risk action");
    } else if (action.risk.level === "medium") {
      penalties.push("medium risk action");
    }
    if (isPoorDefensePost(action)) {
      penalties.push("Defense Post lacks proven frontier value");
    }
    if (action.kind === "hold" && hasUsefulNonHold(input.legalActions)) {
      penalties.push("hold while non-hold actions are available");
    }
    if (
      isNeutralExpansionAction(action) &&
      shouldDiversifyNeutralExpansion(observation, input.legalActions)
    ) {
      penalties.push("neutral expansion streak should diversify");
    }
    if (
      isNeutralExpansionAction(action) &&
      economyCadenceRecommended(observation)
    ) {
      penalties.push(
        "economy cadence recommends infrastructure before more neutral expansion",
      );
    }
    if (
      isNeutralExpansionAction(action) &&
      frontierFinishPressureRecommended(observation)
    ) {
      penalties.push(
        "frontier finish pressure recommends converting the weak rival before more neutral expansion",
      );
    }
    if (action.kind === "hold" && economyCadenceRecommended(observation)) {
      penalties.push("hold while economy cadence build is available");
    }
    if (action.kind === "hold" && navalControlRecommended(observation)) {
      penalties.push("hold while naval control action is available");
    }
    if (
      action.kind === "hold" &&
      lateGameStrikeTargetingRecommended(observation)
    ) {
      penalties.push("hold while late-game strike target is available");
    }
    if (
      action.kind === "hold" &&
      personalityDiplomacyPressureRecommended(observation)
    ) {
      penalties.push("hold while personality diplomacy pressure is available");
    }
    if (
      action.kind === "hold" &&
      frontierFinishPressureRecommended(observation)
    ) {
      penalties.push("hold while decisive finish pressure is available");
    }

    const exactRepeated = observation.memory.avoidActionIDs.includes(action.id);
    const penaltyScore =
      (repeated
        ? Math.min(30, observation.memory.repeatedActionCount * 10)
        : 0) +
      (exactRepeated ? 45 : 0) +
      (isNeutralExpansionAction(action) &&
      shouldDiversifyNeutralExpansion(observation, input.legalActions)
        ? 34
        : 0) +
      (isNeutralExpansionAction(action) &&
      economyCadenceRecommended(observation)
        ? 22
        : 0) +
      (isNeutralExpansionAction(action) &&
      frontierFinishPressureRecommended(observation)
        ? 26
        : 0) +
      riskPenalty(action) +
      (isPoorDefensePost(action) ? 70 : 0) +
      (action.kind === "hold" && economyCadenceRecommended(observation)
        ? 24
        : 0) +
      (action.kind === "hold" && navalControlRecommended(observation)
        ? 18
        : 0) +
      (action.kind === "hold" && lateGameStrikeTargetingRecommended(observation)
        ? 22
        : 0) +
      (action.kind === "hold" &&
      personalityDiplomacyPressureRecommended(observation)
        ? 16
        : 0) +
      (action.kind === "hold" && frontierFinishPressureRecommended(observation)
        ? 28
        : 0) +
      (action.kind === "hold" && hasUsefulNonHold(input.legalActions) ? 18 : 0);
    let totalScore = clampScore(
      scores.reduce((sum, score) => sum + score.score, 0) - penaltyScore,
    );
    if (exactRepeated) {
      totalScore = Math.min(totalScore, 58);
    } else if (
      isNeutralExpansionAction(action) &&
      shouldDiversifyNeutralExpansion(observation, input.legalActions)
    ) {
      totalScore = Math.min(totalScore, 54);
    } else if (repeated) {
      totalScore = Math.min(totalScore, 72);
    }
    const sortedScores = scores.sort((a, b) => b.score - a.score);
    const topScore = sortedScores[0] ?? {
      skill: "opportunism" as const,
      score: 0,
      reason: "no skill signal",
    };
    return {
      actionID: action.id,
      actionKind: action.kind,
      label: action.label,
      totalScore,
      topSkill: topScore.skill,
      topSkillScore: Math.round(topScore.score),
      scores: sortedScores.map((score) => ({
        ...score,
        score: Math.round(score.score),
      })),
      penalties,
      repeated,
      planAligned: planAligned(input.plan ?? null, action),
      objectiveAligned: objectiveAligned(
        observation.objective?.kind ?? null,
        action,
      ),
    };
  }

  private addProfileScores(
    observation: AgentObservation,
    action: LegalAction,
    add: (skill: StrategicSkill, score: number, reason: string) => void,
  ) {
    switch (observation.profile) {
      case "aggressive":
        if (action.kind === "attack")
          add("pressure", 18, "aggressive profile prefers attacks");
        if (action.kind === "embargo" || action.kind === "embargo_all")
          add("pressure", 10, "aggressive profile accepts pressure actions");
        if (action.kind === "target_player" || action.kind === "break_alliance")
          add("pressure", 14, "aggressive profile signals visible conflict");
        if (action.kind === "boat" || action.kind === "nuke")
          add("pressure", 12, "aggressive profile accepts escalation");
        break;
      case "defensive":
        if (
          (action.kind === "build" || action.kind === "warship") &&
          action.metadata?.role === "defensive"
        ) {
          add(
            "defense_building",
            22,
            "defensive profile prioritizes fortification",
          );
        }
        if (
          action.kind === "alliance_request" ||
          action.kind === "alliance_extend" ||
          action.kind === "embargo_stop"
        ) {
          add("diplomacy", 14, "defensive profile uses diplomacy to reduce risk");
        }
        if (action.kind === "hold")
          add("troop_conservation", 12, "defensive profile avoids waste");
        break;
      case "diplomatic":
        if (
          action.kind === "alliance_request" ||
          action.kind === "alliance_extend"
        )
          add("diplomacy", 24, "diplomatic profile prioritizes alliances");
        if (action.kind === "donate_gold" || action.kind === "donate_troops") {
          add("support_ally", 20, "diplomatic profile values support");
        }
        if (action.kind === "quick_chat" || action.kind === "emoji") {
          add("diplomacy", 14, "diplomatic profile keeps intent visible");
        }
        break;
      case "opportunistic":
        if (action.kind !== "hold" && action.risk.level !== "high") {
          add(
            "opportunism",
            18,
            "opportunistic profile prefers useful low-risk moves",
          );
        }
        break;
    }
  }

  private addObjectiveScores(
    objective: AgentObjectiveKind | null,
    action: LegalAction,
    add: (skill: StrategicSkill, score: number, reason: string) => void,
  ) {
    if (objective === null || !objectiveAligned(objective, action)) {
      return;
    }
    switch (objective) {
      case "choose_spawn":
      case "expand_territory":
        add("expansion", 32, `matches objective ${objective}`);
        break;
      case "secure_economy":
        add("economy_building", 34, "matches secure economy objective");
        break;
      case "fortify_border":
      case "survive":
        add("defense_building", 28, `matches objective ${objective}`);
        add("recovery", 12, `matches objective ${objective}`);
        break;
      case "pressure_rival":
        add("pressure", 34, "matches pressure objective");
        break;
      case "build_alliance":
        add("diplomacy", 34, "matches alliance objective");
        break;
    }
  }

  private addPlanScores(
    plan: StrategicSkillPlanView | null,
    action: LegalAction,
    add: (skill: StrategicSkill, score: number, reason: string) => void,
    penalties: string[],
  ) {
    if (plan === null) {
      return;
    }
    if (plan.forbiddenActionKinds?.includes(action.kind)) {
      penalties.push("current plan forbids this action kind");
      return;
    }
    if (plan.preferredActionKinds?.includes(action.kind)) {
      add(skillForAction(action), 30, "matches current strategic plan");
    }
    if (
      typeof action.metadata?.targetID === "string" &&
      action.metadata.targetID === plan.targetPlayerId
    ) {
      add("pressure", 18, "matches current plan target");
    }
    if (
      typeof action.metadata?.recipientID === "string" &&
      action.metadata.recipientID === plan.targetPlayerId
    ) {
      add("diplomacy", 18, "matches current plan target");
    }
  }
}

export function skillEvaluationForAction(
  evaluation: StrategicSkillEvaluation,
  actionID: string,
): StrategicActionSkillEvaluation | null {
  return (
    evaluation.actions.find((action) => action.actionID === actionID) ?? null
  );
}

export function compactSkillSummary(
  evaluation: StrategicSkillEvaluation,
  limit = 5,
): string {
  return evaluation.actions
    .slice(0, limit)
    .map(
      (action) =>
        `${action.actionID}:${action.totalScore}/${action.topSkill}${action.repeated ? "/repeated" : ""}`,
    )
    .join("; ");
}

function objectiveAligned(
  objective: AgentObjectiveKind | null,
  action: LegalAction,
): boolean {
  switch (objective) {
    case "choose_spawn":
      return action.kind === "spawn";
    case "expand_territory":
      return (
        (action.kind === "attack" && action.metadata?.expansion === true) ||
        (action.kind === "boat" && action.metadata?.targetID === null)
      );
    case "secure_economy":
      return (
        (action.kind === "build" || action.kind === "upgrade_structure") &&
        action.metadata?.role !== "defensive"
      );
    case "fortify_border":
      return (
        ((action.kind === "build" || action.kind === "warship") &&
          action.metadata?.role === "defensive") ||
        action.kind === "move_warship" ||
        action.kind === "alliance_request" ||
        action.kind === "alliance_extend" ||
        action.kind === "retreat" ||
        action.kind === "boat_retreat"
      );
    case "pressure_rival":
      return (
        action.kind === "embargo" ||
        action.kind === "embargo_all" ||
        action.kind === "target_player" ||
        action.kind === "nuke" ||
        action.kind === "warship" ||
        action.kind === "move_warship" ||
        action.kind === "break_alliance" ||
        (action.kind === "attack" && action.metadata?.expansion !== true)
      );
    case "build_alliance":
      return (
        action.kind === "alliance_request" ||
        action.kind === "alliance_extend" ||
        action.kind === "donate_gold" ||
        action.kind === "donate_troops" ||
        action.kind === "embargo_stop" ||
        action.kind === "quick_chat" ||
        action.kind === "emoji"
      );
    case "survive":
      return (
        action.kind === "hold" ||
        action.kind === "retreat" ||
        action.kind === "boat_retreat" ||
        ((action.kind === "build" || action.kind === "warship") &&
          action.metadata?.role === "defensive") ||
        action.kind === "move_warship" ||
        action.kind === "alliance_request" ||
        action.kind === "alliance_extend" ||
        action.kind === "embargo_stop"
      );
    case null:
      return false;
  }
}

function planAligned(
  plan: StrategicSkillPlanView | null,
  action: LegalAction,
): boolean {
  if (plan === null) {
    return false;
  }
  return (
    !plan.forbiddenActionKinds?.includes(action.kind) &&
    (plan.preferredActionKinds?.includes(action.kind) ?? false)
  );
}

function skillForAction(action: LegalAction): StrategicSkill {
  switch (action.kind) {
    case "spawn":
    case "attack":
    case "boat":
      return action.metadata?.expansion === true ||
        action.metadata?.targetID === null
        ? "expansion"
        : "pressure";
    case "retreat":
    case "boat_retreat":
      return "recovery";
    case "build":
    case "warship":
      return action.metadata?.role === "defensive"
        ? "defense_building"
        : "economy_building";
    case "upgrade_structure":
      return "economy_building";
    case "delete_unit":
      return "recovery";
    case "nuke":
    case "move_warship":
    case "target_player":
    case "break_alliance":
      return "pressure";
    case "alliance_request":
    case "alliance_reject":
    case "alliance_extend":
    case "embargo_stop":
    case "quick_chat":
    case "emoji":
      return "diplomacy";
    case "donate_gold":
    case "donate_troops":
      return "support_ally";
    case "embargo":
    case "embargo_all":
      return "pressure";
    case "hold":
      return "troop_conservation";
  }
}

function attackTimingScore(action: LegalAction): number {
  const ratio = metadataNumber(action, "relativeTroopRatio");
  const troopPercent = metadataNumber(action, "troopPercent");
  const riskFactor =
    action.risk.level === "low" ? 24 : action.risk.level === "medium" ? 10 : -8;
  const ratioBonus = ratio > 0 ? Math.min(30, ratio * 10) : 0;
  const troopBonus =
    troopPercent > 0 ? Math.max(0, 16 - Math.abs(troopPercent - 25) / 2) : 8;
  return Math.max(0, 28 + riskFactor + ratioBonus + troopBonus);
}

function conservationScore(action: LegalAction): number {
  const troopPercent = metadataNumber(action, "troopPercent");
  if (troopPercent <= 0) {
    return 8;
  }
  return Math.max(4, 30 - troopPercent / 2);
}

function riskPenalty(action: LegalAction): number {
  switch (action.risk.level) {
    case "high":
      return 35;
    case "medium":
      return 15;
    case "low":
      return 4;
    case "none":
      return 0;
  }
}

function isRepeated(
  observation: AgentObservation,
  action: LegalAction,
): boolean {
  return (
    observation.memory.repeatedActionKind === action.kind &&
    observation.memory.repeatedActionCount >= 2
  );
}

function hasUsefulNonHold(actions: LegalAction[]): boolean {
  return actions.some((action) => action.kind !== "hold");
}

function isNeutralExpansionAction(action: LegalAction): boolean {
  return (
    (action.kind === "attack" && action.metadata?.expansion === true) ||
    (action.kind === "boat" && action.metadata?.targetID === null)
  );
}

function shouldDiversifyNeutralExpansion(
  observation: AgentObservation,
  actions: LegalAction[],
): boolean {
  return (
    observation.memory.recentExpansionCount >= 2 &&
    actions.some(isExpansionDiversifier)
  );
}

function shouldDiversifyAfterExpansion(
  observation: AgentObservation,
  action: LegalAction,
  actions: LegalAction[],
): boolean {
  return (
    observation.memory.recentExpansionCount >= 2 &&
    isExpansionDiversifier(action) &&
    actions.some(isNeutralExpansionAction)
  );
}

function economyCadenceRecommended(observation: AgentObservation): boolean {
  return observation.tacticalAffordances?.economyCadence?.recommended === true;
}

function frontierFinishPressureRecommended(
  observation: AgentObservation,
): boolean {
  return (
    observation.tacticalAffordances?.frontierFinishPressure?.recommended ===
      true &&
    (observation.tacticalAffordances.frontierFinishPressure
      .decisiveAttackActionCount ?? 0) > 0
  );
}

function frontierFinishPressureAttackRecommended(
  observation: AgentObservation,
  action: LegalAction,
): boolean {
  if (
    !frontierFinishPressureRecommended(observation) ||
    action.kind !== "attack" ||
    action.metadata?.expansion === true
  ) {
    return false;
  }
  const finish = observation.tacticalAffordances?.frontierFinishPressure;
  return (
    finish?.bestTargetID !== null &&
    finish?.bestTargetID !== undefined &&
    actionTargetID(action) === finish.bestTargetID
  );
}

function navalControlRecommended(observation: AgentObservation): boolean {
  return observation.tacticalAffordances?.navalControl?.recommended === true;
}

function navalControlActionRecommended(
  observation: AgentObservation,
  action: LegalAction,
): boolean {
  if (!navalControlRecommended(observation)) {
    return false;
  }
  const naval = observation.tacticalAffordances?.navalControl;
  return (
    action.id === naval?.bestNavalActionID ||
    action.kind === "boat" ||
    action.kind === "warship" ||
    action.kind === "move_warship" ||
    action.kind === "boat_retreat"
  );
}

function lateGameStrikeTargetingRecommended(
  observation: AgentObservation,
): boolean {
  return (
    observation.tacticalAffordances?.lateGameStrikeTargeting?.recommended ===
    true
  );
}

function lateGameStrikeActionRecommended(
  observation: AgentObservation,
  action: LegalAction,
): boolean {
  if (
    !lateGameStrikeTargetingRecommended(observation) ||
    action.kind !== "nuke"
  ) {
    return false;
  }
  const strike = observation.tacticalAffordances?.lateGameStrikeTargeting;
  return (
    action.id === strike?.bestStrikeActionID ||
    (strike?.bestStrikeTargetID !== null &&
      strike?.bestStrikeTargetID !== undefined &&
      actionTargetID(action) === strike.bestStrikeTargetID)
  );
}

function personalityDiplomacyPressureRecommended(
  observation: AgentObservation,
): boolean {
  return (
    observation.tacticalAffordances?.personalityDiplomacyPressure
      ?.recommended === true
  );
}

function personalityDiplomacyPressureActionRecommended(
  observation: AgentObservation,
  action: LegalAction,
): boolean {
  if (
    !personalityDiplomacyPressureRecommended(observation) ||
    !isPersonalityDiplomacyActionKind(action.kind)
  ) {
    return false;
  }
  const pressure =
    observation.tacticalAffordances?.personalityDiplomacyPressure;
  if (action.id === pressure?.bestSocialActionID) {
    return true;
  }
  const actionTargetID = personalityDiplomacyActionPlayerID(action);
  return (
    pressure?.bestSocialTargetID !== null &&
    pressure?.bestSocialTargetID !== undefined &&
    actionTargetID === pressure.bestSocialTargetID &&
    personalityDiplomacyKindGroup(action.kind) ===
      personalityDiplomacyKindGroup(pressure.bestSocialActionKind ?? "hold")
  );
}

function economyCadenceBuildRecommended(
  observation: AgentObservation,
  action: LegalAction,
): boolean {
  if (!economyCadenceRecommended(observation) || action.kind !== "build") {
    return false;
  }
  const cadence = observation.tacticalAffordances?.economyCadence;
  return (
    action.id === cadence?.bestBuildID ||
    action.metadata?.role === "economic" ||
    action.metadata?.unit === "City" ||
    action.metadata?.unit === "Factory" ||
    action.metadata?.unit === "Port"
  );
}

function actionTargetID(action: LegalAction): string | null {
  if (typeof action.metadata?.targetID === "string") {
    return action.metadata.targetID;
  }
  const match = action.id.match(/^attack:([^:]+):/);
  return match?.[1] ?? null;
}

function isExpansionDiversifier(action: LegalAction): boolean {
  if (action.kind === "build") {
    return action.metadata?.role !== "defensive" || !isPoorDefensePost(action);
  }
  return (
    action.kind === "upgrade_structure" ||
    action.kind === "alliance_request" ||
    action.kind === "alliance_extend" ||
    action.kind === "embargo" ||
    action.kind === "embargo_all" ||
    action.kind === "target_player" ||
    (action.kind === "attack" && action.metadata?.expansion !== true)
  );
}

function threatened(observation: AgentObservation): boolean {
  return (
    observation.combat.incomingAttackPlayerIDs.length > 0 ||
    (observation.ownState?.incomingAttacks ?? 0) > 0
  );
}

function metadataNumber(action: LegalAction, key: string): number {
  const value = action.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function metadataBoolean(action: LegalAction, key: string): boolean {
  return action.metadata?.[key] === true;
}

function defensiveBuildQuality(action: LegalAction): {
  score: number;
  recoveryScore: number;
  reason: string;
} {
  if (!isDefensePost(action)) {
    return {
      score: 68,
      recoveryScore: 8,
      reason: "defensive structure improves survivability",
    };
  }
  const defensiveValue = metadataNumber(action, "defensiveValue");
  const frontierValue = metadataNumber(action, "frontierValue");
  const hostileBorderDistance = metadataNumber(action, "hostileBorderDistance");
  const incoming = metadataBoolean(action, "nearbyIncomingAttack");
  const nearbyEnemyCount = metadataNumber(action, "nearbyEnemyCount");
  const useful =
    incoming ||
    nearbyEnemyCount > 0 ||
    defensiveValue >= 0.28 ||
    (hostileBorderDistance > 0 && hostileBorderDistance <= 60);
  if (!useful) {
    return {
      score: 4,
      recoveryScore: 0,
      reason:
        "Defense Post is not near a hostile border or incoming land attack",
    };
  }
  return {
    score: Math.min(92, 42 + defensiveValue * 42 + frontierValue * 18),
    recoveryScore: incoming ? 22 : 8,
    reason:
      action.metadata?.buildPlacementReason?.toString() ??
      "Defense Post covers a useful frontier",
  };
}

function isPoorDefensePost(action: LegalAction): boolean {
  if (!isDefensePost(action)) {
    return false;
  }
  const defensiveValue = metadataNumber(action, "defensiveValue");
  const nearbyEnemyCount = metadataNumber(action, "nearbyEnemyCount");
  const hostileBorderDistance = metadataNumber(action, "hostileBorderDistance");
  return (
    !metadataBoolean(action, "nearbyIncomingAttack") &&
    nearbyEnemyCount === 0 &&
    defensiveValue < 0.28 &&
    (hostileBorderDistance === 0 || hostileBorderDistance > 60)
  );
}

function isDefensePost(action: LegalAction): boolean {
  return (
    action.metadata?.unit === "Defense Post" ||
    action.metadata?.unit === "DefensePost"
  );
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}
