import { UnitType } from "../../core/game/Game";
import {
  isNuclearWeaponUnit,
  nuclearStrikePriorityScore,
  nuclearTargetStructurePriority,
} from "./AgentNuclearPolicy";
import {
  isPersonalityDiplomacyActionKind,
  isPersonalityPressureActionKind,
  personalityDiplomacyActionPlayerID,
  personalityDiplomacyActionScore,
  personalityDiplomacyKindGroup,
  personalityDiplomacyModeForAction,
} from "./AgentPersonalityDiplomacyPolicy";
import type {
  AgentEconomyCadenceAffordance,
  AgentFrontierConversionTimingAffordance,
  AgentFrontierFinishPressureAffordance,
  AgentHomeDangerLevel,
  AgentLateGameStrikeTargetingAffordance,
  AgentNavalControlAffordance,
  AgentObservation,
  AgentOpeningExpansionTempoAffordance,
  AgentPersonalityDiplomacyPressureAffordance,
  AgentTacticalAffordances,
  AgentTransportTroopBankingAffordance,
  LegalAction,
} from "./AgentTypes";

const OPENING_TEMPO_TURN_LIMIT = 3_000;
const OPENING_TEMPO_LEADER_GAP_DANGER = 0.04;
const CONVERSION_MIN_TILE_SHARE = 0.055;
const CONVERSION_MIN_TILES = 8_000;
const CONVERSION_MIN_RELATIVE_TROOP_RATIO = 1.12;
const CONVERSION_PROBE_READY_TROOP_RATIO = 0.42;
const CONVERSION_STRIKE_READY_TROOP_RATIO = 0.55;
const FINISH_PRESSURE_MIN_RELATIVE_TROOP_RATIO = 1.28;
const FINISH_PRESSURE_MIN_DECISIVE_TROOP_RATIO = 1.35;
const ECONOMY_CADENCE_MIN_TILE_SHARE = 0.045;
const ECONOMY_CADENCE_MIN_TILES = 4_000;
const ECONOMY_CADENCE_FACTORY_TILES = 6_000;
const TROOP_BANKING_NEAR_CAP_RATIO = 0.86;
const TROOP_BANKING_HIGH_DANGER_RATIO = 0.28;
const TROOP_BANKING_MEDIUM_DANGER_RATIO = 0.1;
const TROOP_BANKING_MAX_ACTIVE_BANK_RATIO = 0.8;
const LATE_GAME_STRIKE_MIN_PRIORITY = 118;
const PERSONALITY_DIPLOMACY_MIN_SCORE = 74;

export function buildAgentTacticalAffordances(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): AgentTacticalAffordances {
  const transportTroopBanking = transportTroopBankingAffordance(input);
  const openingExpansionTempo = openingExpansionTempoAffordance(input);
  const frontierConversionTiming = frontierConversionTimingAffordance(input);
  const frontierFinishPressure = frontierFinishPressureAffordance(input);
  const economyCadence = economyCadenceAffordance(input);
  const navalControl = navalControlAffordance(input);
  const lateGameStrikeTargeting = lateGameStrikeTargetingAffordance(input);
  const personalityDiplomacyPressure =
    personalityDiplomacyPressureAffordance(input);
  const notes: string[] = [];
  if (openingExpansionTempo.recommended) {
    notes.push(
      "opening_expansion_tempo is behind target; evaluator should watch whether the agent spends early legal expansion",
    );
  }
  if (frontierConversionTiming.recommended) {
    notes.push(
      "frontier_conversion_timing is open; evaluator should watch whether the agent converts a favorable rival instead of farming neutral land",
    );
  }
  if (frontierFinishPressure.recommended) {
    notes.push(
      "frontier_finish_pressure is open; evaluator should watch whether the agent escalates repeated probes into decisive finish attacks",
    );
  }
  if (transportTroopBanking.recommended) {
    notes.push(
      "transport_troop_banking is available; evaluator should watch whether the agent converts capped troops into active transports",
    );
  }
  if (economyCadence.recommended) {
    notes.push(
      "economy_cadence is available; evaluator should watch whether the agent converts stable expansion into City, Factory, or Port infrastructure",
    );
  }
  if (navalControl.recommended) {
    notes.push(
      "naval_control is available; evaluator should watch whether the agent uses transports, warships, or patrol moves instead of stalling land loops",
    );
  }
  if (lateGameStrikeTargeting.recommended) {
    notes.push(
      "late_game_strike_targeting is available; evaluator should watch whether the agent uses legal nukes against strategic targets instead of low-impact loops",
    );
  }
  if (personalityDiplomacyPressure.recommended) {
    notes.push(
      "personality_diplomacy_pressure is available; evaluator should watch whether profile-specific social pressure, alliance, support, or communication creates visible match story beats",
    );
  }
  return {
    transportTroopBanking,
    openingExpansionTempo,
    frontierConversionTiming,
    frontierFinishPressure,
    economyCadence,
    navalControl,
    lateGameStrikeTargeting,
    personalityDiplomacyPressure,
    notes,
  };
}

function personalityDiplomacyPressureAffordance(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): AgentPersonalityDiplomacyPressureAffordance {
  const { observation } = input;
  const ownTroops =
    observation.ownState?.troops ?? observation.combat.ownTroops ?? null;
  const incomingThreatTroops = sumNumbers(
    observation.combat.incomingAttacks
      ?.filter((attack) => !attack.retreating)
      .map((attack) => attack.troops) ?? [],
  );
  const homeDanger = homeDangerLevel({
    incomingThreatRatio: ratioOrNull(incomingThreatTroops, ownTroops),
    incomingAttackCount: observation.combat.incomingAttackPlayerIDs.length,
  });
  const socialActions = personalityDiplomacyActions(input);
  const recentSocialActionCount = observation.recentDecisions.filter(
    (decision) =>
      decision.accepted && isPersonalityDiplomacyActionKind(decision.actionKind),
  ).length;
  const recentPressureActionCount = observation.recentDecisions.filter(
    (decision) =>
      decision.accepted && isPersonalityPressureActionKind(decision.actionKind),
  ).length;
  const scoredActions = socialActions
    .map((action) => ({
      action,
      score: personalityDiplomacyActionScore({
        action,
        profile: observation.profile,
        visiblePlayers: observation.visiblePlayers,
        leaderID: observation.endgame?.leaderID ?? null,
        recentExpansionCount: observation.memory.recentExpansionCount,
        recentSocialActionCount,
        homeDanger,
      }),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.action.id.localeCompare(right.action.id),
    );
  const best = scoredActions[0];
  const bestTargetID =
    best === undefined ? null : personalityDiplomacyActionPlayerID(best.action);
  const bestTarget = observation.visiblePlayers.find(
    (player) =>
      bestTargetID !== null &&
      (player.playerID === bestTargetID || player.clientID === bestTargetID),
  );
  const bestKindGroup =
    best === undefined ? null : personalityDiplomacyKindGroup(best.action.kind);
  const recentSocialThrottle =
    recentSocialActionCount >= 2 ||
    (observation.memory.repeatedActionKind !== null &&
      isPersonalityDiplomacyActionKind(observation.memory.repeatedActionKind) &&
      observation.memory.repeatedActionCount >= 2);
  const recommended =
    best !== undefined &&
    best.score >= PERSONALITY_DIPLOMACY_MIN_SCORE &&
    !recentSocialThrottle &&
    (homeDanger !== "high" ||
      bestKindGroup === "alliance" ||
      bestKindGroup === "support");

  return {
    tacticID: "personality_diplomacy_pressure",
    recommended,
    turnNumber: observation.turnNumber,
    profile: observation.profile,
    homeDanger,
    recentSocialActionCount,
    recentPressureActionCount,
    socialActionCount: socialActions.length,
    pressureActionCount: socialActions.filter(
      (action) => personalityDiplomacyKindGroup(action.kind) === "pressure",
    ).length,
    allianceActionCount: socialActions.filter(
      (action) => personalityDiplomacyKindGroup(action.kind) === "alliance",
    ).length,
    supportActionCount: socialActions.filter(
      (action) => personalityDiplomacyKindGroup(action.kind) === "support",
    ).length,
    communicationActionCount: socialActions.filter(
      (action) => personalityDiplomacyKindGroup(action.kind) === "communication",
    ).length,
    targetActionCount: socialActions.filter(
      (action) => action.kind === "target_player",
    ).length,
    embargoActionCount: socialActions.filter(
      (action) => action.kind === "embargo" || action.kind === "embargo_all",
    ).length,
    bestSocialActionID: best?.action.id ?? null,
    bestSocialActionKind: best?.action.kind ?? null,
    bestSocialTargetID: bestTargetID,
    bestSocialTargetName:
      stringMetadata(best?.action.metadata?.targetName) ??
      stringMetadata(best?.action.metadata?.recipientName) ??
      bestTarget?.name ??
      null,
    bestSocialScore: best?.score ?? null,
    personalityMode:
      best === undefined
        ? null
        : personalityDiplomacyModeForAction(observation.profile, best.action),
    reasons: personalityDiplomacyPressureReasons({
      recommended,
      profile: observation.profile,
      socialActionCount: socialActions.length,
      pressureActionCount: socialActions.filter((action) =>
        isPersonalityPressureActionKind(action.kind),
      ).length,
      communicationActionCount: socialActions.filter(
        (action) =>
          personalityDiplomacyKindGroup(action.kind) === "communication",
      ).length,
      recentSocialActionCount,
      recentSocialThrottle,
      bestActionID: best?.action.id ?? null,
      bestActionKind: best?.action.kind ?? null,
      bestTargetName:
        stringMetadata(best?.action.metadata?.targetName) ??
        stringMetadata(best?.action.metadata?.recipientName) ??
        bestTarget?.name ??
        null,
      bestScore: best?.score ?? null,
      homeDanger,
    }),
  };
}

function lateGameStrikeTargetingAffordance(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): AgentLateGameStrikeTargetingAffordance {
  const { observation } = input;
  const ownTroops =
    observation.ownState?.troops ?? observation.combat.ownTroops ?? null;
  const ownTileShare =
    observation.ownState?.tileShare ??
    observation.endgame?.ownTileShare ??
    null;
  const troopRatio =
    observation.ownState?.troopRatio ??
    observation.combat.troopRatio ??
    ratioOrNull(ownTroops, observation.ownState?.maxTroops ?? null);
  const incomingThreatTroops = sumNumbers(
    observation.combat.incomingAttacks
      ?.filter((attack) => !attack.retreating)
      .map((attack) => attack.troops) ?? [],
  );
  const homeDanger = homeDangerLevel({
    incomingThreatRatio: ratioOrNull(incomingThreatTroops, ownTroops),
    incomingAttackCount: observation.combat.incomingAttackPlayerIDs.length,
  });
  const strikeActions = lateGameStrikeActions(input);
  const scoredStrikes = strikeActions
    .map((action) => ({
      action,
      score: lateGameStrikePriority(observation, action),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.action.id.localeCompare(right.action.id),
    );
  const bestStrike = scoredStrikes[0];
  const recentNukeCount = observation.recentDecisions.filter(
    (decision) => decision.accepted && decision.actionKind === "nuke",
  ).length;
  const highValueStrikeActionCount = scoredStrikes.filter(
    (strike) => strike.score >= LATE_GAME_STRIKE_MIN_PRIORITY,
  ).length;
  const siloTargetActionCount = strikeActions.filter((action) =>
    isMissileSiloStructure(
      stringMetadata(action.metadata?.targetStructureUnit),
    ),
  ).length;
  const samTargetActionCount = strikeActions.filter((action) =>
    isSamStructure(stringMetadata(action.metadata?.targetStructureUnit)),
  ).length;
  const economyTargetActionCount = strikeActions.filter((action) =>
    isEconomyStrikeStructure(
      stringMetadata(action.metadata?.targetStructureUnit),
    ),
  ).length;
  const coveredNonSamTargetActionCount = strikeActions.filter((action) => {
    const structure = stringMetadata(action.metadata?.targetStructureUnit);
    return (
      (numberMetadata(action.metadata?.targetSamCoverage) ?? 0) > 0 &&
      !isSamStructure(structure)
    );
  }).length;
  const recommended =
    bestStrike !== undefined &&
    bestStrike.score >= LATE_GAME_STRIKE_MIN_PRIORITY &&
    observation.turnNumber >= 1_550 &&
    recentNukeCount === 0 &&
    homeDanger !== "high";

  return {
    tacticID: "late_game_strike_targeting",
    recommended,
    turnNumber: observation.turnNumber,
    ownTileShare: roundRatioOrNull(ownTileShare),
    troopRatio: roundRatioOrNull(troopRatio),
    homeDanger,
    legalStrikeActionCount: strikeActions.length,
    highValueStrikeActionCount,
    siloTargetActionCount,
    samTargetActionCount,
    economyTargetActionCount,
    coveredNonSamTargetActionCount,
    recentNukeCount,
    bestStrikeActionID: bestStrike?.action.id ?? null,
    bestStrikeWeapon: stringMetadata(bestStrike?.action.metadata?.unit),
    bestStrikeTargetID: stringMetadata(bestStrike?.action.metadata?.targetID),
    bestStrikeTargetName: stringMetadata(
      bestStrike?.action.metadata?.targetName,
    ),
    bestStrikeTargetTileShare: roundRatioOrNull(
      numberMetadata(bestStrike?.action.metadata?.targetTileShare),
    ),
    bestStrikeTargetStructureUnit: stringMetadata(
      bestStrike?.action.metadata?.targetStructureUnit,
    ),
    bestStrikeTargetStructurePriority:
      numberMetadata(bestStrike?.action.metadata?.targetStructurePriority) ??
      (bestStrike === undefined
        ? null
        : nuclearTargetStructurePriority(
            stringMetadata(bestStrike.action.metadata?.targetStructureUnit),
          )),
    bestStrikeTargetSamCoverage: numberMetadata(
      bestStrike?.action.metadata?.targetSamCoverage,
    ),
    bestStrikeNuclearTargetPriority: numberMetadata(
      bestStrike?.action.metadata?.nuclearTargetPriority,
    ),
    bestStrikeScore: bestStrike?.score ?? null,
    reasons: lateGameStrikeTargetingReasons({
      recommended,
      legalStrikeActionCount: strikeActions.length,
      highValueStrikeActionCount,
      siloTargetActionCount,
      samTargetActionCount,
      economyTargetActionCount,
      coveredNonSamTargetActionCount,
      recentNukeCount,
      bestStrikeActionID: bestStrike?.action.id ?? null,
      bestStrikeWeapon: stringMetadata(bestStrike?.action.metadata?.unit),
      bestStrikeTargetName: stringMetadata(
        bestStrike?.action.metadata?.targetName,
      ),
      bestStrikeTargetStructureUnit: stringMetadata(
        bestStrike?.action.metadata?.targetStructureUnit,
      ),
      bestStrikeScore: bestStrike?.score ?? null,
      homeDanger,
    }),
  };
}

function navalControlAffordance(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): AgentNavalControlAffordance {
  const { observation } = input;
  const ownTroops =
    observation.ownState?.troops ?? observation.combat.ownTroops ?? null;
  const ownTileShare =
    observation.ownState?.tileShare ??
    observation.endgame?.ownTileShare ??
    null;
  const troopRatio =
    observation.ownState?.troopRatio ??
    observation.combat.troopRatio ??
    ratioOrNull(ownTroops, observation.ownState?.maxTroops ?? null);
  const incomingThreatTroops = sumNumbers(
    observation.combat.incomingAttacks
      ?.filter((attack) => !attack.retreating)
      .map((attack) => attack.troops) ?? [],
  );
  const homeDanger = homeDangerLevel({
    incomingThreatRatio: ratioOrNull(incomingThreatTroops, ownTroops),
    incomingAttackCount: observation.combat.incomingAttackPlayerIDs.length,
  });
  const portCount = unitCount(observation, UnitType.Port);
  const warshipCount = unitCount(observation, UnitType.Warship);
  const activeTransportCount =
    observation.nonCombat.boatRetreatOptions?.length ?? 0;
  const activeTransportTroops = sumNumbers(
    observation.nonCombat.boatRetreatOptions?.map((option) => option.troops) ??
      [],
  );
  const navalActions = navalControlActions(input);
  const safeNavalActions = navalActions.filter(
    (action) => action.risk.level !== "high",
  );
  const boatLaunchActionCount = navalActions.filter(
    (action) => action.kind === "boat",
  ).length;
  const neutralBoatActionCount =
    navalActions.filter(isNeutralBoatAction).length;
  const navalInvasionActionCount = navalActions.filter(
    (action) =>
      action.kind === "boat" && action.metadata?.navalInvasion === true,
  ).length;
  const warshipBuildActionCount = navalActions.filter(
    (action) => action.kind === "warship",
  ).length;
  const warshipMoveActionCount = navalActions.filter(
    (action) => action.kind === "move_warship",
  ).length;
  const bestNaval = bestNavalControlAction(safeNavalActions, observation);
  const recommended =
    safeNavalActions.length > 0 &&
    homeDanger !== "high" &&
    (activeTransportCount > 0 ||
      observation.strategic.priority === "naval" ||
      observation.objective?.kind === "expand_territory" ||
      observation.memory.recentExpansionCount >= 2 ||
      (portCount > 0 && warshipCount === 0 && warshipBuildActionCount > 0) ||
      (warshipCount > 0 && warshipMoveActionCount > 0) ||
      navalInvasionActionCount > 0);

  return {
    tacticID: "naval_control",
    recommended,
    turnNumber: observation.turnNumber,
    ownTileShare: roundRatioOrNull(ownTileShare),
    troopRatio: roundRatioOrNull(troopRatio),
    homeDanger,
    portCount,
    warshipCount,
    activeTransportCount,
    activeTransportTroops,
    boatLaunchActionCount,
    neutralBoatActionCount,
    navalInvasionActionCount,
    warshipBuildActionCount,
    warshipMoveActionCount,
    safeNavalActionCount: safeNavalActions.length,
    bestNavalActionID: bestNaval?.id ?? null,
    bestNavalActionKind: bestNaval?.kind ?? null,
    bestNavalTargetID: stringMetadata(bestNaval?.metadata?.targetID),
    bestNavalTargetName: stringMetadata(bestNaval?.metadata?.targetName),
    bestNavalTroopPercent:
      numberMetadata(bestNaval?.metadata?.troopPercent) ??
      percentageMetadata(bestNaval?.metadata?.troopPercentage),
    reasons: navalControlReasons({
      recommended,
      portCount,
      warshipCount,
      activeTransportCount,
      activeTransportTroops,
      boatLaunchActionCount,
      neutralBoatActionCount,
      navalInvasionActionCount,
      warshipBuildActionCount,
      warshipMoveActionCount,
      safeNavalActionCount: safeNavalActions.length,
      bestNavalActionID: bestNaval?.id ?? null,
      bestNavalActionKind: bestNaval?.kind ?? null,
      homeDanger,
    }),
  };
}

function economyCadenceAffordance(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): AgentEconomyCadenceAffordance {
  const { observation } = input;
  const ownTiles = observation.ownState?.tilesOwned ?? null;
  const ownTileShare =
    observation.ownState?.tileShare ??
    observation.endgame?.ownTileShare ??
    null;
  const ownTroops =
    observation.ownState?.troops ?? observation.combat.ownTroops ?? null;
  const troopRatio =
    observation.ownState?.troopRatio ??
    observation.combat.troopRatio ??
    ratioOrNull(ownTroops, observation.ownState?.maxTroops ?? null);
  const incomingThreatTroops = sumNumbers(
    observation.combat.incomingAttacks
      ?.filter((attack) => !attack.retreating)
      .map((attack) => attack.troops) ?? [],
  );
  const incomingThreatRatio = ratioOrNull(incomingThreatTroops, ownTroops);
  const homeDanger = homeDangerLevel({
    incomingThreatRatio,
    incomingAttackCount: observation.combat.incomingAttackPlayerIDs.length,
  });
  const cityCount = unitCount(observation, UnitType.City);
  const factoryCount = unitCount(observation, UnitType.Factory);
  const portCount = unitCount(observation, UnitType.Port);
  const coreEconomyCount = cityCount + factoryCount + portCount;
  const economyBuilds = economyBuildCandidates(input);
  const safeEconomyBuilds = economyBuilds.filter(
    (action) => action.risk.level !== "high",
  );
  const cityBuildActionCount = economyBuilds.filter(
    (action) => economyBuildUnit(action) === UnitType.City,
  ).length;
  const factoryBuildActionCount = economyBuilds.filter(
    (action) => economyBuildUnit(action) === UnitType.Factory,
  ).length;
  const portBuildActionCount = economyBuilds.filter(
    (action) => economyBuildUnit(action) === UnitType.Port,
  ).length;
  const firstCityMissing = cityCount === 0;
  const firstFactoryMissing =
    factoryCount === 0 &&
    ((ownTiles ?? 0) >= ECONOMY_CADENCE_FACTORY_TILES ||
      cityCount > 0 ||
      observation.memory.recentExpansionCount >= 2);
  const firstPortMissing = portCount === 0 && portBuildActionCount > 0;
  const enoughLandBase =
    (ownTileShare ?? 0) >= ECONOMY_CADENCE_MIN_TILE_SHARE ||
    (ownTiles ?? 0) >= ECONOMY_CADENCE_MIN_TILES ||
    observation.memory.recentExpansionCount >= 1;
  const bestBuild = bestEconomyBuild(safeEconomyBuilds, observation);
  const recommended =
    safeEconomyBuilds.length > 0 &&
    homeDanger !== "high" &&
    enoughLandBase &&
    (firstCityMissing ||
      firstFactoryMissing ||
      firstPortMissing ||
      observation.memory.recentExpansionCount >= 2 ||
      observation.strategic.priority === "build_economy" ||
      observation.objective?.kind === "secure_economy");

  return {
    tacticID: "economy_cadence",
    recommended,
    turnNumber: observation.turnNumber,
    ownTiles,
    ownTileShare: roundRatioOrNull(ownTileShare),
    troopRatio: roundRatioOrNull(troopRatio),
    homeDanger,
    recentExpansionCount: observation.memory.recentExpansionCount,
    recentBuildCount: observation.memory.recentBuildCount,
    cityCount,
    factoryCount,
    portCount,
    coreEconomyCount,
    firstCityMissing,
    firstFactoryMissing,
    firstPortMissing,
    enoughLandBase,
    economyBuildActionCount: economyBuilds.length,
    safeEconomyBuildActionCount: safeEconomyBuilds.length,
    cityBuildActionCount,
    factoryBuildActionCount,
    portBuildActionCount,
    bestBuildID: bestBuild?.id ?? null,
    bestBuildUnit: economyBuildUnit(bestBuild) ?? null,
    bestBuildEconomicValue:
      bestBuild === undefined
        ? null
        : numberMetadata(bestBuild.metadata?.economicValue),
    reasons: economyCadenceReasons({
      recommended,
      ownTiles,
      ownTileShare,
      recentExpansionCount: observation.memory.recentExpansionCount,
      recentBuildCount: observation.memory.recentBuildCount,
      cityCount,
      factoryCount,
      portCount,
      firstCityMissing,
      firstFactoryMissing,
      firstPortMissing,
      enoughLandBase,
      economyBuildActionCount: economyBuilds.length,
      safeEconomyBuildActionCount: safeEconomyBuilds.length,
      bestBuildUnit: economyBuildUnit(bestBuild) ?? null,
      bestBuildEconomicValue:
        bestBuild === undefined
          ? null
          : numberMetadata(bestBuild.metadata?.economicValue),
      homeDanger,
    }),
  };
}

function frontierFinishPressureAffordance(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): AgentFrontierFinishPressureAffordance {
  const { observation } = input;
  const ownTroops =
    observation.ownState?.troops ?? observation.combat.ownTroops ?? null;
  const ownTileShare =
    observation.ownState?.tileShare ??
    observation.endgame?.ownTileShare ??
    null;
  const troopRatio =
    observation.ownState?.troopRatio ??
    observation.combat.troopRatio ??
    ratioOrNull(ownTroops, observation.ownState?.maxTroops ?? null);
  const incomingThreatTroops = sumNumbers(
    observation.combat.incomingAttacks
      ?.filter((attack) => !attack.retreating)
      .map((attack) => attack.troops) ?? [],
  );
  const incomingThreatRatio = ratioOrNull(incomingThreatTroops, ownTroops);
  const homeDanger = homeDangerLevel({
    incomingThreatRatio,
    incomingAttackCount: observation.combat.incomingAttackPlayerIDs.length,
  });
  const activeTargetID =
    currentHostileTargetID(observation) ?? recentHostileTargetID(observation);
  const activeTarget =
    activeTargetID === null
      ? null
      : (observation.visiblePlayers.find(
          (player) => player.playerID === activeTargetID,
        ) ?? null);
  const recentTargetAttackCount =
    activeTargetID === null
      ? 0
      : recentHostileAttackCount(observation, activeTargetID);
  const recentLowCommitmentAttackCount =
    activeTargetID === null
      ? 0
      : recentLowCommitmentHostileAttackCount(observation, activeTargetID);
  const repeatedLowCommitmentProbe = recentLowCommitmentAttackCount >= 3;
  const finishingAttacks = hostileAttackActions(input).filter((action) =>
    isFinishPressureAttack(action, observation, activeTargetID),
  );
  const decisiveAttacks = finishingAttacks.filter((action) =>
    isDecisiveFinishPressureAttack(action, observation),
  );
  const bestAttack = bestFinishPressureAttack(decisiveAttacks, observation);
  const bestTargetID = stringMetadata(bestAttack?.metadata?.targetID) ?? null;
  const bestTarget =
    bestTargetID === null
      ? null
      : (observation.visiblePlayers.find(
          (player) => player.playerID === bestTargetID,
        ) ?? null);
  const recommended =
    homeDanger !== "high" &&
    repeatedLowCommitmentProbe &&
    bestAttack !== undefined;

  return {
    tacticID: "frontier_finish_pressure",
    recommended,
    turnNumber: observation.turnNumber,
    ownTileShare: roundRatioOrNull(ownTileShare),
    troopRatio: roundRatioOrNull(troopRatio),
    homeDanger,
    activeTargetID,
    activeTargetName: activeTarget?.name ?? null,
    recentTargetAttackCount,
    recentLowCommitmentAttackCount,
    repeatedLowCommitmentProbe,
    finishingAttackActionCount: finishingAttacks.length,
    decisiveAttackActionCount: decisiveAttacks.length,
    bestTargetID,
    bestTargetName:
      stringMetadata(bestAttack?.metadata?.targetName) ??
      bestTarget?.name ??
      null,
    bestTargetRelativeTroopRatio:
      bestAttack === undefined
        ? null
        : roundRatioOrNull(relativeTroopRatio(bestAttack, observation)),
    bestTargetTileShare:
      bestAttack === undefined
        ? null
        : roundRatioOrNull(targetTileShare(bestAttack, observation)),
    bestTargetTroops:
      bestAttack === undefined
        ? null
        : (numberMetadata(bestAttack.metadata?.targetTroops) ??
          bestTarget?.troops ??
          null),
    bestAttackTroopPercent:
      bestAttack === undefined ? null : actionTroopPercent(bestAttack),
    bestAttackID: bestAttack?.id ?? null,
    reasons: frontierFinishPressureReasons({
      recommended,
      activeTargetName: activeTarget?.name ?? null,
      recentTargetAttackCount,
      recentLowCommitmentAttackCount,
      finishingAttackActionCount: finishingAttacks.length,
      decisiveAttackActionCount: decisiveAttacks.length,
      bestTargetName:
        stringMetadata(bestAttack?.metadata?.targetName) ??
        bestTarget?.name ??
        null,
      bestTargetRelativeTroopRatio:
        bestAttack === undefined
          ? null
          : relativeTroopRatio(bestAttack, observation),
      bestAttackTroopPercent:
        bestAttack === undefined ? null : actionTroopPercent(bestAttack),
      homeDanger,
    }),
  };
}

function frontierConversionTimingAffordance(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): AgentFrontierConversionTimingAffordance {
  const { observation } = input;
  const ownTiles = observation.ownState?.tilesOwned ?? null;
  const ownTileShare =
    observation.ownState?.tileShare ??
    observation.endgame?.ownTileShare ??
    null;
  const ownTroops =
    observation.ownState?.troops ?? observation.combat.ownTroops ?? null;
  const troopRatio =
    observation.ownState?.troopRatio ??
    observation.combat.troopRatio ??
    ratioOrNull(ownTroops, observation.ownState?.maxTroops ?? null);
  const leaderTileShare = visibleLeaderTileShare(observation, ownTileShare);
  const leaderTileShareGap =
    ownTileShare === null || leaderTileShare === null
      ? null
      : roundRatio(Math.max(0, leaderTileShare - ownTileShare));
  const neutralExpansionActionCount =
    neutralLandExpansionCount(input) + neutralBoatExpansionCount(input);
  const neutralExpansionAvailable =
    neutralExpansionActionCount > 0 || observation.combat.canExpandIntoNeutral;
  const hostileAttacks = hostileAttackActions(input);
  const favorableHostileAttacks = hostileAttacks.filter((action) =>
    isFavorableConversionAttack(action, observation),
  );
  const bestAttack = bestConversionAttack(favorableHostileAttacks, observation);
  const executorReadyHostileAttacks = favorableHostileAttacks.filter((action) =>
    isExecutorReadyConversionAttack(action, observation),
  );
  const bestExecutorReadyAttack = bestConversionAttack(
    executorReadyHostileAttacks,
    observation,
  );
  const bestTargetID = stringMetadata(bestAttack?.metadata?.targetID) ?? null;
  const bestTarget =
    bestTargetID === null
      ? null
      : (observation.visiblePlayers.find(
          (player) => player.playerID === bestTargetID,
        ) ?? null);
  const bestExecutorReadyTargetID =
    stringMetadata(bestExecutorReadyAttack?.metadata?.targetID) ?? null;
  const bestExecutorReadyTarget =
    bestExecutorReadyTargetID === null
      ? null
      : (observation.visiblePlayers.find(
          (player) => player.playerID === bestExecutorReadyTargetID,
        ) ?? null);
  const incomingThreatTroops = sumNumbers(
    observation.combat.incomingAttacks
      ?.filter((attack) => !attack.retreating)
      .map((attack) => attack.troops) ?? [],
  );
  const incomingThreatRatio = ratioOrNull(incomingThreatTroops, ownTroops);
  const homeDanger = homeDangerLevel({
    incomingThreatRatio,
    incomingAttackCount: observation.combat.incomingAttackPlayerIDs.length,
  });
  const enoughLandBase =
    (ownTileShare ?? 0) >= CONVERSION_MIN_TILE_SHARE ||
    (ownTiles ?? 0) >= CONVERSION_MIN_TILES ||
    observation.memory.recentExpansionCount >= 3;
  const strategicWindow =
    enoughLandBase &&
    favorableHostileAttacks.length > 0 &&
    homeDanger !== "high" &&
    (!neutralExpansionAvailable ||
      observation.memory.recentExpansionCount >= 2 ||
      (leaderTileShareGap ?? 0) >= 0.035 ||
      (ownTileShare ?? 0) >= CONVERSION_MIN_TILE_SHARE);
  const neutralGrowthHandoffMature =
    !neutralExpansionAvailable ||
    neutralExpansionActionCount <= 3 ||
    observation.memory.recentExpansionCount <= 1 ||
    (ownTileShare ?? 0) >= 0.18 ||
    (leaderTileShareGap ?? 0) >= 0.06;
  const executorReady =
    strategicWindow &&
    neutralGrowthHandoffMature &&
    executorReadyHostileAttacks.length > 0;
  const recommended = executorReady;

  return {
    tacticID: "frontier_conversion_timing",
    recommended,
    strategicWindow,
    executorReady,
    turnNumber: observation.turnNumber,
    ownTiles,
    ownTileShare: roundRatioOrNull(ownTileShare),
    troopRatio: roundRatioOrNull(troopRatio),
    enoughLandBase,
    recentExpansionCount: observation.memory.recentExpansionCount,
    neutralExpansionAvailable,
    neutralExpansionActionCount,
    hostileAttackActionCount: hostileAttacks.length,
    favorableHostileAttackActionCount: favorableHostileAttacks.length,
    executorReadyHostileAttackActionCount: executorReadyHostileAttacks.length,
    bestTargetID,
    bestTargetName:
      stringMetadata(bestAttack?.metadata?.targetName) ??
      bestTarget?.name ??
      null,
    bestTargetRelativeTroopRatio:
      bestAttack === undefined
        ? null
        : roundRatioOrNull(relativeTroopRatio(bestAttack, observation)),
    bestTargetTileShare:
      bestAttack === undefined
        ? null
        : roundRatioOrNull(targetTileShare(bestAttack, observation)),
    bestAttackTroopPercent:
      bestAttack === undefined ? null : actionTroopPercent(bestAttack),
    bestExecutorReadyTargetID,
    bestExecutorReadyTargetName:
      stringMetadata(bestExecutorReadyAttack?.metadata?.targetName) ??
      bestExecutorReadyTarget?.name ??
      null,
    bestExecutorReadyRelativeTroopRatio:
      bestExecutorReadyAttack === undefined
        ? null
        : roundRatioOrNull(
            relativeTroopRatio(bestExecutorReadyAttack, observation),
          ),
    bestExecutorReadyTileShare:
      bestExecutorReadyAttack === undefined
        ? null
        : roundRatioOrNull(
            targetTileShare(bestExecutorReadyAttack, observation),
          ),
    bestExecutorReadyAttackTroopPercent:
      bestExecutorReadyAttack === undefined
        ? null
        : actionTroopPercent(bestExecutorReadyAttack),
    leaderTileShare: roundRatioOrNull(leaderTileShare),
    leaderTileShareGap,
    incomingThreatRatio: roundRatioOrNull(incomingThreatRatio),
    homeDanger,
    reasons: frontierConversionTimingReasons({
      recommended,
      enoughLandBase,
      ownTileShare,
      ownTiles,
      recentExpansionCount: observation.memory.recentExpansionCount,
      neutralExpansionAvailable,
      neutralExpansionActionCount,
      hostileAttackActionCount: hostileAttacks.length,
      favorableHostileAttackActionCount: favorableHostileAttacks.length,
      executorReadyHostileAttackActionCount: executorReadyHostileAttacks.length,
      bestTargetName:
        stringMetadata(bestAttack?.metadata?.targetName) ??
        bestTarget?.name ??
        null,
      bestTargetRelativeTroopRatio:
        bestAttack === undefined
          ? null
          : relativeTroopRatio(bestAttack, observation),
      bestExecutorReadyTargetName:
        stringMetadata(bestExecutorReadyAttack?.metadata?.targetName) ??
        bestExecutorReadyTarget?.name ??
        null,
      bestExecutorReadyRelativeTroopRatio:
        bestExecutorReadyAttack === undefined
          ? null
          : relativeTroopRatio(bestExecutorReadyAttack, observation),
      homeDanger,
      neutralGrowthHandoffMature,
    }),
  };
}

function openingExpansionTempoAffordance(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): AgentOpeningExpansionTempoAffordance {
  const { observation } = input;
  const ownTiles = observation.ownState?.tilesOwned ?? null;
  const ownTileShare =
    observation.ownState?.tileShare ??
    observation.endgame?.ownTileShare ??
    null;
  const expectedTileShare = expectedOpeningTileShare(observation.turnNumber);
  const leaderTileShare = visibleLeaderTileShare(observation, ownTileShare);
  const leaderTileShareGap =
    ownTileShare === null || leaderTileShare === null
      ? null
      : roundRatio(Math.max(0, leaderTileShare - ownTileShare));
  const neutralLandExpansionActionCount = neutralLandExpansionCount(input);
  const neutralBoatExpansionActionCount = neutralBoatExpansionCount(input);
  const hasLegalActionSnapshot = input.legalActions !== undefined;
  const neutralExpansionAvailable =
    neutralLandExpansionActionCount + neutralBoatExpansionActionCount > 0 ||
    (!hasLegalActionSnapshot && observation.combat.canExpandIntoNeutral);
  const incomingThreatTroops = sumNumbers(
    observation.combat.incomingAttacks
      ?.filter((attack) => !attack.retreating)
      .map((attack) => attack.troops) ?? [],
  );
  const ownTroops =
    observation.ownState?.troops ?? observation.combat.ownTroops ?? null;
  const incomingThreatRatio = ratioOrNull(incomingThreatTroops, ownTroops);
  const homeDanger = homeDangerLevel({
    incomingThreatRatio,
    incomingAttackCount: observation.combat.incomingAttackPlayerIDs.length,
  });
  const openingWindow = observation.turnNumber <= OPENING_TEMPO_TURN_LIMIT;
  const behindExpectedTempo =
    expectedTileShare !== null &&
    ownTileShare !== null &&
    ownTileShare + 0.005 < expectedTileShare;
  const leaderGapDanger =
    leaderTileShareGap !== null &&
    leaderTileShareGap >= OPENING_TEMPO_LEADER_GAP_DANGER;
  const recommended =
    openingWindow &&
    neutralExpansionAvailable &&
    homeDanger !== "high" &&
    behindExpectedTempo;

  return {
    tacticID: "opening_expansion_tempo",
    openingWindow,
    recommended,
    turnNumber: observation.turnNumber,
    ownTiles,
    ownTileShare: roundRatioOrNull(ownTileShare),
    expectedTileShare,
    leaderTileShare: roundRatioOrNull(leaderTileShare),
    leaderTileShareGap,
    neutralExpansionAvailable,
    neutralLandExpansionActionCount,
    neutralBoatExpansionActionCount,
    largestExpansionTroopPercent: largestExpansionTroopPercent(input),
    economicBuildActionCount: economicBuildActionCount(input.legalActions),
    incomingThreatRatio: roundRatioOrNull(incomingThreatRatio),
    homeDanger,
    behindExpectedTempo,
    leaderGapDanger,
    reasons: openingExpansionTempoReasons({
      openingWindow,
      recommended,
      ownTileShare,
      expectedTileShare,
      leaderTileShareGap,
      neutralLandExpansionActionCount,
      neutralBoatExpansionActionCount,
      neutralExpansionAvailable,
      homeDanger,
    }),
  };
}

function transportTroopBankingAffordance(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): AgentTransportTroopBankingAffordance {
  const { observation } = input;
  const ownTroops =
    observation.ownState?.troops ?? observation.combat.ownTroops ?? null;
  const maxTroops =
    observation.ownState?.maxTroops ?? observation.combat.maxTroops ?? null;
  const troopRatio =
    observation.ownState?.troopRatio ??
    observation.combat.troopRatio ??
    ratioOrNull(ownTroops, maxTroops);
  const activeTransportTroops = sumNumbers(
    observation.nonCombat.boatRetreatOptions?.map((option) => option.troops) ??
      [],
  );
  const largestActiveTransportTroops = maxNumber(
    observation.nonCombat.boatRetreatOptions?.map((option) => option.troops) ??
      [],
  );
  const incomingThreatTroops = sumNumbers(
    observation.combat.incomingAttacks
      ?.filter((attack) => !attack.retreating)
      .map((attack) => attack.troops) ?? [],
  );
  const incomingThreatRatio = ratioOrNull(incomingThreatTroops, ownTroops);
  const homeDanger = homeDangerLevel({
    incomingThreatRatio,
    incomingAttackCount: observation.combat.incomingAttackPlayerIDs.length,
  });
  const availableBoatLaunchTroops = availableBoatTroops(input);
  const largestAvailableBoatLaunchTroops = maxNumber(availableBoatLaunchTroops);
  const nearCap =
    troopRatio !== null && troopRatio >= TROOP_BANKING_NEAR_CAP_RATIO;
  const usefulLaunchSize =
    maxTroops === null ? 1_000 : Math.max(1_000, Math.floor(maxTroops * 0.04));
  const activeBankRatio = ratioOrNull(activeTransportTroops, maxTroops) ?? 0;
  const continuationReady =
    (observation.nonCombat.boatRetreatOptions?.length ?? 0) > 0 &&
    activeBankRatio < TROOP_BANKING_MAX_ACTIVE_BANK_RATIO;
  const recommended =
    nearCap &&
    availableBoatLaunchTroops.length > 0 &&
    largestAvailableBoatLaunchTroops >= usefulLaunchSize &&
    homeDanger !== "high" &&
    activeBankRatio < TROOP_BANKING_MAX_ACTIVE_BANK_RATIO;
  const effectiveFutureTroops =
    maxTroops === null
      ? null
      : maxTroops +
        activeTransportTroops +
        (nearCap ? largestAvailableBoatLaunchTroops : 0);

  return {
    tacticID: "transport_troop_banking",
    nearCap,
    recommended,
    ownTroops,
    maxTroops,
    troopRatio: roundRatioOrNull(troopRatio),
    activeTransportCount: observation.nonCombat.boatRetreatOptions?.length ?? 0,
    activeTransportTroops,
    largestActiveTransportTroops,
    activeBankRatio: roundRatioOrNull(activeBankRatio),
    continuationReady,
    availableBoatLaunchActionCount: availableBoatLaunchTroops.length,
    availableBoatLaunchTroops,
    largestAvailableBoatLaunchTroops,
    incomingThreatTroops,
    incomingThreatRatio: roundRatioOrNull(incomingThreatRatio),
    homeDanger,
    effectiveFutureTroops,
    effectiveFutureTroopRatio: roundRatioOrNull(
      ratioOrNull(effectiveFutureTroops, maxTroops),
    ),
    reasons: transportTroopBankingReasons({
      nearCap,
      troopRatio,
      availableBoatLaunchTroops,
      largestAvailableBoatLaunchTroops,
      usefulLaunchSize,
      activeTransportTroops,
      activeBankRatio,
      continuationReady,
      homeDanger,
      recommended,
    }),
  };
}

function availableBoatTroops(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): number[] {
  const legalActionTroops =
    input.legalActions
      ?.filter((action) => action.kind === "boat")
      .map((action) => numberMetadata(action.metadata?.troops))
      .filter((troops): troops is number => troops !== null) ?? [];
  const observedOptionTroops =
    input.observation.nonCombat.boatOptions?.map((option) => option.troops) ??
    [];
  return uniqueDescending(
    legalActionTroops.length > 0 ? legalActionTroops : observedOptionTroops,
  ).slice(0, 12);
}

function economyBuildCandidates(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): LegalAction[] {
  if (input.legalActions !== undefined) {
    return input.legalActions.filter(isEconomyBuildAction);
  }
  return input.observation.nonCombat.buildOptions
    .filter(
      (option) => isEconomyUnit(option.unit) || option.role === "economic",
    )
    .map((option) => ({
      id: "",
      kind: "build" as const,
      label: `Build ${option.unit}`,
      intent: null,
      risk: { level: "low" as const, score: 0.1 },
      metadata: {
        unit: option.unit,
        role: option.role,
        economicValue: option.economicValue ?? null,
        buildPlacementReason: option.buildPlacementReason ?? null,
      },
    }));
}

function isEconomyBuildAction(action: LegalAction): boolean {
  if (action.kind !== "build") {
    return false;
  }
  return (
    isEconomyUnit(action.metadata?.unit) || action.metadata?.role === "economic"
  );
}

function isEconomyUnit(unit: unknown): boolean {
  return (
    unit === UnitType.City ||
    unit === UnitType.Factory ||
    unit === UnitType.Port ||
    unit === "City" ||
    unit === "Factory" ||
    unit === "Port"
  );
}

function economyBuildUnit(action: LegalAction | undefined): string | null {
  const unit = action?.metadata?.unit;
  if (isEconomyUnit(unit)) {
    return String(unit);
  }
  return action?.metadata?.role === "economic" ? "economic" : null;
}

function personalityDiplomacyActions(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): LegalAction[] {
  if (input.legalActions !== undefined) {
    return input.legalActions.filter((action) =>
      isPersonalityDiplomacyActionKind(action.kind),
    );
  }
  const { observation } = input;
  return [
    ...observation.nonCombat.supportOptions.flatMap((support) => {
      const actions: LegalAction[] = [];
      if (support.canDonateTroops && support.suggestedTroops !== null) {
        actions.push({
          id: `donate_troops:${support.recipientID}`,
          kind: "donate_troops",
          label: `Donate troops to ${support.recipientName}`,
          intent: null,
          risk: { level: "medium", score: 0.4 },
          metadata: {
            recipientID: support.recipientID,
            recipientName: support.recipientName,
            troops: support.suggestedTroops,
          },
        });
      }
      if (support.canDonateGold && support.suggestedGold !== null) {
        actions.push({
          id: `donate_gold:${support.recipientID}`,
          kind: "donate_gold",
          label: `Donate gold to ${support.recipientName}`,
          intent: null,
          risk: { level: "low", score: 0.25 },
          metadata: {
            recipientID: support.recipientID,
            recipientName: support.recipientName,
            gold: support.suggestedGold,
          },
        });
      }
      return actions;
    }),
    ...(observation.nonCombat.allianceOptions ?? []).map((alliance) => {
      const kind =
        alliance.action === "reject"
          ? "alliance_reject"
          : alliance.action === "extend"
            ? "alliance_extend"
            : "break_alliance";
      return {
        id: `${kind}:${alliance.playerID}`,
        kind,
        label: `${alliance.action} alliance with ${alliance.playerName}`,
        intent: null,
        risk: {
          level: alliance.action === "break" ? "high" : "low",
          score: alliance.action === "break" ? 0.7 : 0.2,
        },
        metadata: {
          targetID: alliance.playerID,
          targetName: alliance.playerName,
          action: alliance.action,
          legalReason: alliance.legalReason,
        },
      } satisfies LegalAction;
    }),
    ...observation.visiblePlayers
      .filter((player) => player.canRequestAlliance)
      .map(
        (player): LegalAction => ({
          id: `alliance:${player.playerID}`,
          kind: "alliance_request",
          label: `Request alliance with ${player.name}`,
          intent: null,
          risk: { level: "low", score: 0.2 },
          metadata: {
            recipientID: player.playerID,
            recipientName: player.name,
            relation: String(player.relation),
          },
        }),
      ),
    ...observation.nonCombat.embargoOptions.map((embargo) => ({
      id: `embargo:${embargo.targetID}:${embargo.action}`,
      kind: embargo.action === "stop" ? "embargo_stop" : "embargo",
      label:
        embargo.action === "stop"
          ? `Stop embargo on ${embargo.targetName}`
          : `Embargo ${embargo.targetName}`,
      intent: null,
      risk: { level: "medium", score: 0.5 },
      metadata: {
        targetID: embargo.targetID,
        targetName: embargo.targetName,
        action: embargo.action,
        legalReason: embargo.legalReason,
      },
    }) satisfies LegalAction),
    ...(observation.nonCombat.canEmbargoAll
      ? [
          {
            id: "embargo_all:start",
            kind: "embargo_all" as const,
            label: "Embargo all eligible rivals",
            intent: null,
            risk: { level: "medium" as const, score: 0.55 },
            metadata: {
              action: "start",
              legalReason: "canEmbargoAll was available",
            },
          },
        ]
      : []),
    ...(observation.nonCombat.targetOptions ?? []).map(
      (target): LegalAction => ({
        id: `target:${target.targetID}`,
        kind: "target_player",
        label: `Mark ${target.targetName} as target`,
        intent: null,
        risk: { level: "medium", score: 0.45 },
        metadata: {
          targetID: target.targetID,
          targetName: target.targetName,
          legalReason: target.legalReason,
        },
      }),
    ),
    ...(observation.nonCombat.quickChatOptions ?? []).map(
      (chat): LegalAction => ({
        id: `quick_chat:${chat.recipientID}:${chat.quickChatKey}`,
        kind: "quick_chat",
        label: `Public chat: ${chat.message ?? chat.quickChatKey}`,
        intent: null,
        risk: { level: "none", score: 0 },
        metadata: {
          recipientID: chat.recipientID,
          recipientName: chat.recipientName,
          targetID: chat.targetID ?? null,
          targetName: chat.targetName ?? null,
          quickChatKey: chat.quickChatKey,
          message: chat.message ?? null,
          nuclearThreat: chat.nuclearThreat ?? null,
        },
      }),
    ),
    ...(observation.nonCombat.emojiOptions ?? []).map(
      (emoji): LegalAction => ({
        id: `emoji:${emoji.recipientID}:${emoji.emoji}`,
        kind: "emoji",
        label: `Send emoji to ${emoji.recipientName}`,
        intent: null,
        risk: { level: "none", score: 0 },
        metadata: {
          recipientID: emoji.recipientID,
          recipientName: emoji.recipientName,
          emoji: emoji.emoji,
          emojiText: emoji.emojiText ?? null,
          emojiContext: emoji.emojiContext ?? null,
        },
      }),
    ),
  ];
}

function bestEconomyBuild(
  actions: LegalAction[],
  observation: AgentObservation,
): LegalAction | undefined {
  return actions
    .slice()
    .sort(
      (left, right) =>
        economyBuildPriority(right, observation) -
          economyBuildPriority(left, observation) ||
        left.id.localeCompare(right.id),
    )[0];
}

function economyBuildPriority(
  action: LegalAction,
  observation: AgentObservation,
): number {
  const unit = economyBuildUnit(action);
  const ownTiles = observation.ownState?.tilesOwned ?? 0;
  const cityCount = unitCount(observation, UnitType.City);
  const factoryCount = unitCount(observation, UnitType.Factory);
  const portCount = unitCount(observation, UnitType.Port);
  let priority =
    40 + (numberMetadata(action.metadata?.economicValue) ?? 0) * 35;
  if (unit === UnitType.City) {
    priority += cityCount === 0 ? 110 : 24;
  } else if (unit === UnitType.Factory) {
    priority +=
      factoryCount === 0 &&
      (cityCount > 0 || ownTiles >= ECONOMY_CADENCE_FACTORY_TILES)
        ? 98
        : 28;
  } else if (unit === UnitType.Port) {
    priority += portCount === 0 && cityCount > 0 ? 88 : 30;
  } else if (action.metadata?.role === "economic") {
    priority += 24;
  }
  if (action.risk.level === "none") {
    priority += 14;
  } else if (action.risk.level === "low") {
    priority += 8;
  } else if (action.risk.level === "medium") {
    priority -= 10;
  } else {
    priority -= 80;
  }
  return priority;
}

function lateGameStrikeActions(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): LegalAction[] {
  if (input.legalActions !== undefined) {
    return input.legalActions.filter((action) => action.kind === "nuke");
  }
  return input.observation.nonCombat.buildOptions
    .filter((option) => isNuclearWeaponUnit(option.unit))
    .map((option) => ({
      id: `nuke:${option.unit}:${option.nukeTargetID ?? "unknown"}:${option.targetTile}`,
      kind: "nuke" as const,
      label: `Launch ${option.unit} at ${option.nukeTargetName ?? "target"}`,
      intent: null,
      risk: { level: "high" as const, score: 0.75 },
      metadata: {
        unit: option.unit,
        role: option.role,
        targetID: option.nukeTargetID ?? null,
        targetName: option.nukeTargetName ?? null,
        targetTiles: option.nukeTargetTiles ?? null,
        targetTileShare: option.nukeTargetTileShare ?? null,
        targetStructureUnit: option.nukeTargetStructureUnit ?? null,
        targetStructureLevel: option.nukeTargetStructureLevel ?? null,
        targetStructurePriority: option.nukeTargetStructurePriority ?? null,
        targetStructureDensity: option.nukeTargetStructureDensity ?? null,
        targetSamCoverage: option.nukeTargetSamCoverage ?? null,
        nuclearTargetPriority: option.nukeTargetPriority ?? null,
        targetTile: option.targetTile,
        buildTile: option.buildTile,
        cost: option.cost,
        legalReason: option.legalReason,
      },
    }));
}

function lateGameStrikePriority(
  observation: AgentObservation,
  action: LegalAction,
): number {
  if (action.kind !== "nuke") {
    return 0;
  }
  const targetID = stringMetadata(action.metadata?.targetID);
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const target = observation.visiblePlayers.find(
    (player) => player.playerID === targetID || player.clientID === targetID,
  );
  return nuclearStrikePriorityScore({
    weaponUnit: stringMetadata(action.metadata?.unit),
    targetID,
    targetIsLeader:
      targetID !== null && targetID === observation.endgame?.leaderID,
    incomingAttacker:
      targetID !== null &&
      observation.combat.incomingAttackPlayerIDs.includes(targetID),
    turnNumber: observation.turnNumber,
    ownTileShare,
    targetTileShare:
      numberMetadata(action.metadata?.targetTileShare) ??
      target?.tileShare ??
      null,
    targetStructureUnit: stringMetadata(action.metadata?.targetStructureUnit),
    targetStructurePriority: numberMetadata(
      action.metadata?.targetStructurePriority,
    ),
    targetSamCoverage: numberMetadata(action.metadata?.targetSamCoverage),
    nuclearTargetPriority: numberMetadata(
      action.metadata?.nuclearTargetPriority,
    ),
    leaderTileShareGap:
      observation.endgame === undefined
        ? null
        : observation.endgame.leaderTileShare -
          (observation.endgame.ownTileShare ?? ownTileShare),
  });
}

function navalControlActions(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): LegalAction[] {
  if (input.legalActions !== undefined) {
    return input.legalActions.filter(isNavalControlAction);
  }
  return [
    ...(input.observation.nonCombat.boatOptions ?? []).map((option) => ({
      id: `boat:${option.targetTile}:25`,
      kind: "boat" as const,
      label: `Send transport to ${option.targetName}`,
      intent: null,
      risk: { level: "medium" as const, score: 0.25 },
      metadata: {
        targetTile: option.targetTile,
        sourceTile: option.sourceTile,
        targetID: option.targetID,
        targetName: option.targetName,
        troops: option.troops,
        troopPercent: 25,
        navalInvasion: option.targetID !== null,
        expansion: option.targetID === null,
        legalReason: option.legalReason,
      },
    })),
    ...(input.observation.nonCombat.warshipMoveOptions ?? []).map((option) => ({
      id: `move_warship:${option.unitIDs.join("-")}:${option.targetTile}`,
      kind: "move_warship" as const,
      label: `Move warship patrol to tile ${option.targetTile}`,
      intent: null,
      risk: { level: "low" as const, score: 0.25 },
      metadata: {
        unitCount: option.unitIDs.length,
        targetTile: option.targetTile,
        legalReason: option.legalReason,
      },
    })),
  ];
}

function isNavalControlAction(action: LegalAction): boolean {
  return (
    action.kind === "boat" ||
    action.kind === "boat_retreat" ||
    action.kind === "warship" ||
    action.kind === "move_warship"
  );
}

function isMissileSiloStructure(unit: string | null): boolean {
  return (
    unit === UnitType.MissileSilo ||
    unit === "MissileSilo" ||
    unit === "Missile Silo"
  );
}

function isSamStructure(unit: string | null): boolean {
  return (
    unit === UnitType.SAMLauncher ||
    unit === "SAMLauncher" ||
    unit === "SAM Launcher"
  );
}

function isEconomyStrikeStructure(unit: string | null): boolean {
  return (
    unit === UnitType.City ||
    unit === UnitType.Factory ||
    unit === UnitType.Port
  );
}

function bestNavalControlAction(
  actions: LegalAction[],
  observation: AgentObservation,
): LegalAction | undefined {
  return actions
    .slice()
    .sort(
      (left, right) =>
        navalControlPriority(right, observation) -
          navalControlPriority(left, observation) ||
        left.id.localeCompare(right.id),
    )[0];
}

function navalControlPriority(
  action: LegalAction,
  observation: AgentObservation,
): number {
  const activeTransportCount =
    observation.nonCombat.boatRetreatOptions?.length ?? 0;
  const portCount = unitCount(observation, UnitType.Port);
  const warshipCount = unitCount(observation, UnitType.Warship);
  let priority = 20;
  if (action.kind === "move_warship") {
    priority += warshipCount > 0 ? 96 : 54;
    if (activeTransportCount > 0) priority += 22;
  } else if (action.kind === "warship") {
    priority += portCount > 0 && warshipCount === 0 ? 90 : 48;
  } else if (action.kind === "boat") {
    priority += action.metadata?.navalInvasion === true ? 62 : 52;
    priority += Math.min(
      20,
      numberMetadata(action.metadata?.relativeTroopRatio) === null
        ? 0
        : (numberMetadata(action.metadata?.relativeTroopRatio) ?? 0) * 8,
    );
    priority += Math.min(
      18,
      numberMetadata(action.metadata?.troopPercent) ??
        percentageMetadata(action.metadata?.troopPercentage) ??
        0,
    );
  } else if (action.kind === "boat_retreat") {
    priority += activeTransportCount > 0 ? 46 : 18;
  }
  if (action.risk.level === "none") {
    priority += 10;
  } else if (action.risk.level === "low") {
    priority += 8;
  } else if (action.risk.level === "medium") {
    priority -= 4;
  } else {
    priority -= 80;
  }
  return priority;
}

function unitCount(observation: AgentObservation, unit: UnitType): number {
  return observation.ownState?.unitCounts?.[unit] ?? 0;
}

function neutralLandExpansionCount(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): number {
  const legalCount =
    input.legalActions?.filter(
      (action) =>
        action.kind === "attack" && action.metadata?.expansion === true,
    ).length ?? null;
  return legalCount ?? (input.observation.combat.canExpandIntoNeutral ? 1 : 0);
}

function neutralBoatExpansionCount(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): number {
  const legalCount =
    input.legalActions?.filter((action) => isNeutralBoatAction(action))
      .length ?? null;
  return (
    legalCount ??
    input.observation.nonCombat.boatOptions?.filter(
      (option) =>
        stringMetadata(option.targetID) === null ||
        option.targetName === "Terra Nullius",
    ).length ??
    0
  );
}

function largestExpansionTroopPercent(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): number | null {
  const legalPercents =
    input.legalActions
      ?.filter(
        (action) =>
          (action.kind === "attack" && action.metadata?.expansion === true) ||
          isNeutralBoatAction(action),
      )
      .map(
        (action) =>
          numberMetadata(action.metadata?.troopPercent) ??
          numberMetadata(action.metadata?.troopPercentage),
      )
      .filter((percent): percent is number => percent !== null) ?? [];
  if (legalPercents.length > 0) {
    return Math.max(...legalPercents);
  }
  return null;
}

function economicBuildActionCount(legalActions?: LegalAction[]): number {
  return (
    legalActions?.filter(
      (action) =>
        action.kind === "build" &&
        (action.metadata?.role === "economic" ||
          action.metadata?.unit === "City" ||
          action.metadata?.unit === "Factory"),
    ).length ?? 0
  );
}

function hostileAttackActions(input: {
  observation: AgentObservation;
  legalActions?: LegalAction[];
}): LegalAction[] {
  return (
    input.legalActions?.filter(
      (action) =>
        action.kind === "attack" && action.metadata?.expansion !== true,
    ) ?? []
  );
}

function isFinishPressureAttack(
  action: LegalAction,
  observation: AgentObservation,
  activeTargetID: string | null,
): boolean {
  if (action.kind !== "attack" || action.metadata?.expansion === true) {
    return false;
  }
  const targetID = stringMetadata(action.metadata?.targetID);
  if (targetID === null || targetID !== activeTargetID) {
    return false;
  }
  const target = observation.visiblePlayers.find(
    (player) => player.playerID === targetID,
  );
  if (target === undefined || target.isAllied || target.isFriendly) {
    return false;
  }
  const ownTroops =
    observation.ownState?.troops ?? observation.combat.ownTroops ?? 0;
  const ownShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const targetShare =
    targetTileShare(action, observation) ?? target.tileShare ?? 0;
  const targetTroops =
    numberMetadata(action.metadata?.targetTroops) ?? target.troops;
  const ratio =
    relativeTroopRatio(action, observation) ?? target.relativeTroopRatio ?? 0;
  const recentAttacks = recentHostileAttackCount(observation, targetID);
  return (
    recentAttacks >= 2 &&
    targetShare > 0 &&
    targetShare <= Math.min(0.18, Math.max(0.08, ownShare * 0.85)) &&
    targetTroops <= ownTroops * 0.95 &&
    (ratio === 0 || ratio >= FINISH_PRESSURE_MIN_RELATIVE_TROOP_RATIO)
  );
}

function isDecisiveFinishPressureAttack(
  action: LegalAction,
  observation: AgentObservation,
): boolean {
  const percent = actionTroopPercent(action) ?? 0;
  const ratio = relativeTroopRatio(action, observation) ?? 0;
  return (
    percent >= 25 &&
    percent <= 40 &&
    (ratio === 0 || ratio >= FINISH_PRESSURE_MIN_DECISIVE_TROOP_RATIO)
  );
}

function bestFinishPressureAttack(
  actions: LegalAction[],
  observation: AgentObservation,
): LegalAction | undefined {
  return actions.slice().sort((a, b) => {
    const aPercent = actionTroopPercent(a) ?? 0;
    const bPercent = actionTroopPercent(b) ?? 0;
    const aRatio = relativeTroopRatio(a, observation) ?? 0;
    const bRatio = relativeTroopRatio(b, observation) ?? 0;
    const aShare = targetTileShare(a, observation) ?? 0;
    const bShare = targetTileShare(b, observation) ?? 0;
    return (
      Math.abs(aPercent - 25) - Math.abs(bPercent - 25) ||
      bRatio - aRatio ||
      bShare - aShare ||
      a.id.localeCompare(b.id)
    );
  })[0];
}

function isFavorableConversionAttack(
  action: LegalAction,
  observation: AgentObservation,
): boolean {
  const ratio = relativeTroopRatio(action, observation) ?? 0;
  const targetShare = targetTileShare(action, observation) ?? 0;
  const ownShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const troopPercent = actionTroopPercent(action) ?? 100;
  return (
    ratio >= CONVERSION_MIN_RELATIVE_TROOP_RATIO &&
    troopPercent <= 35 &&
    (targetShare === 0 || ownShare === 0 || targetShare <= ownShare * 1.6)
  );
}

function isExecutorReadyConversionAttack(
  action: LegalAction,
  observation: AgentObservation,
): boolean {
  if (!isFavorableConversionAttack(action, observation)) {
    return false;
  }
  const ratio = relativeTroopRatio(action, observation) ?? 0;
  const ownTroopRatio =
    observation.ownState?.troopRatio ??
    observation.combat.troopRatio ??
    ratioOrNull(
      observation.ownState?.troops ?? observation.combat.ownTroops ?? null,
      observation.ownState?.maxTroops ?? observation.combat.maxTroops ?? null,
    ) ??
    0;
  const troopPercent = actionTroopPercent(action) ?? 100;
  const ownShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const targetShare = targetTileShare(action, observation) ?? 0;
  const leaderTileShare = visibleLeaderTileShare(observation, ownShare);
  const leaderGap =
    leaderTileShare === null ? 0 : Math.max(0, leaderTileShare - ownShare);
  const targetIsLeader =
    leaderTileShare !== null &&
    targetShare > 0 &&
    targetShare >= leaderTileShare - 0.005;
  const probeReady =
    troopPercent <= 10 &&
    ratio >= 1.25 &&
    ownTroopRatio >= CONVERSION_PROBE_READY_TROOP_RATIO;
  const strikeReady =
    troopPercent <= 25 &&
    ratio >= 1.45 &&
    ownTroopRatio >= CONVERSION_STRIKE_READY_TROOP_RATIO;
  const decisiveReady = troopPercent <= 35 && ratio >= 1.9;
  const leaderPressureException =
    targetIsLeader &&
    leaderGap >= 0.04 &&
    troopPercent <= 25 &&
    ratio >= 1.8 &&
    ownTroopRatio >= CONVERSION_STRIKE_READY_TROOP_RATIO;
  const targetShareLimit = ownShare * (leaderPressureException ? 1.6 : 1.35);
  const oversizedTarget =
    targetShare > 0 && ownShare > 0 && targetShare > targetShareLimit;
  return (probeReady || strikeReady || decisiveReady) && !oversizedTarget;
}

function bestConversionAttack(
  actions: LegalAction[],
  observation: AgentObservation,
): LegalAction | undefined {
  return actions
    .slice()
    .sort(
      (a, b) =>
        (relativeTroopRatio(b, observation) ?? 0) -
          (relativeTroopRatio(a, observation) ?? 0) ||
        (targetTileShare(a, observation) ?? 1) -
          (targetTileShare(b, observation) ?? 1) ||
        (actionTroopPercent(a) ?? 100) - (actionTroopPercent(b) ?? 100) ||
        a.id.localeCompare(b.id),
    )[0];
}

function relativeTroopRatio(
  action: LegalAction,
  observation: AgentObservation,
): number | null {
  const metadataRatio = numberMetadata(action.metadata?.relativeTroopRatio);
  if (metadataRatio !== null) {
    return metadataRatio;
  }
  const targetID = stringMetadata(action.metadata?.targetID);
  if (targetID === null) {
    return null;
  }
  return (
    observation.visiblePlayers.find((player) => player.playerID === targetID)
      ?.relativeTroopRatio ?? null
  );
}

function targetTileShare(
  action: LegalAction,
  observation: AgentObservation,
): number | null {
  const metadataShare = numberMetadata(action.metadata?.targetTileShare);
  if (metadataShare !== null) {
    return metadataShare;
  }
  const targetID = stringMetadata(action.metadata?.targetID);
  if (targetID === null) {
    return null;
  }
  return (
    observation.visiblePlayers.find((player) => player.playerID === targetID)
      ?.tileShare ?? null
  );
}

function actionTroopPercent(action: LegalAction): number | null {
  const raw =
    numberMetadata(action.metadata?.troopPercent) ??
    numberMetadata(action.metadata?.troopPercentage);
  if (raw === null) {
    return null;
  }
  return raw <= 1 ? raw * 100 : raw;
}

function visibleLeaderTileShare(
  observation: AgentObservation,
  ownTileShare: number | null,
): number | null {
  const visibleShares = observation.visiblePlayers
    .map((player) => player.tileShare)
    .filter((share): share is number => share !== undefined);
  const candidates = [
    ...(ownTileShare === null ? [] : [ownTileShare]),
    ...visibleShares,
    observation.endgame?.leaderTileShare,
  ].filter((share): share is number => share !== undefined);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

function currentHostileTargetID(observation: AgentObservation): string | null {
  const outgoingIDs = observation.combat.outgoingAttackPlayerIDs.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  return outgoingIDs[0] ?? null;
}

function recentHostileTargetID(observation: AgentObservation): string | null {
  for (
    let index = observation.memory.recentActions.length - 1;
    index >= 0;
    index -= 1
  ) {
    const decision = observation.memory.recentActions[index];
    if (
      decision?.accepted === true &&
      decision.actionKind === "attack" &&
      decision.expansion !== true
    ) {
      return decision.targetID ?? targetIDFromActionID(decision.actionID);
    }
  }
  return null;
}

function recentHostileAttackCount(
  observation: AgentObservation,
  targetID: string,
): number {
  return observation.memory.recentActions.filter(
    (decision) =>
      decision.accepted === true &&
      decision.actionKind === "attack" &&
      decision.expansion !== true &&
      (decision.targetID ?? targetIDFromActionID(decision.actionID)) ===
        targetID,
  ).length;
}

function recentLowCommitmentHostileAttackCount(
  observation: AgentObservation,
  targetID: string,
): number {
  return observation.memory.recentActions.filter(
    (decision) =>
      decision.accepted === true &&
      decision.actionKind === "attack" &&
      decision.expansion !== true &&
      (decision.targetID ?? targetIDFromActionID(decision.actionID)) ===
        targetID &&
      troopPercentFromActionID(decision.actionID) <= 10,
  ).length;
}

function targetIDFromActionID(actionID: string | undefined): string | null {
  if (typeof actionID !== "string") {
    return null;
  }
  const match = actionID.match(/^attack:([^:]+):(?:10|25|40)$/);
  return match?.[1] ?? null;
}

function troopPercentFromActionID(actionID: string | undefined): number {
  if (typeof actionID !== "string") {
    return 0;
  }
  const match = actionID.match(/:(10|25|40)$/);
  return match === null ? 0 : Number(match[1]);
}

function expectedOpeningTileShare(turnNumber: number): number | null {
  if (turnNumber > OPENING_TEMPO_TURN_LIMIT) {
    return null;
  }
  if (turnNumber <= 300) {
    return 0.01;
  }
  if (turnNumber <= 700) {
    return 0.025;
  }
  if (turnNumber <= 1_200) {
    return 0.045;
  }
  if (turnNumber <= 1_800) {
    return 0.065;
  }
  if (turnNumber <= 2_400) {
    return 0.085;
  }
  return 0.1;
}

function homeDangerLevel(input: {
  incomingThreatRatio: number | null;
  incomingAttackCount: number;
}): AgentHomeDangerLevel {
  if (
    (input.incomingThreatRatio ?? 0) >= TROOP_BANKING_HIGH_DANGER_RATIO ||
    input.incomingAttackCount >= 3
  ) {
    return "high";
  }
  if (
    (input.incomingThreatRatio ?? 0) >= TROOP_BANKING_MEDIUM_DANGER_RATIO ||
    input.incomingAttackCount > 0
  ) {
    return "medium";
  }
  return "low";
}

function transportTroopBankingReasons(input: {
  nearCap: boolean;
  troopRatio: number | null;
  availableBoatLaunchTroops: number[];
  largestAvailableBoatLaunchTroops: number;
  usefulLaunchSize: number;
  activeTransportTroops: number;
  activeBankRatio: number;
  continuationReady: boolean;
  homeDanger: AgentHomeDangerLevel;
  recommended: boolean;
}): string[] {
  const reasons: string[] = [];
  reasons.push(
    input.nearCap
      ? `near cap at ${percent(input.troopRatio)}`
      : `not near cap at ${percent(input.troopRatio)}`,
  );
  reasons.push(
    input.availableBoatLaunchTroops.length > 0
      ? `${input.availableBoatLaunchTroops.length} boat launch size(s) visible; largest=${input.largestAvailableBoatLaunchTroops}`
      : "no boat launch action visible",
  );
  if (
    input.availableBoatLaunchTroops.length > 0 &&
    input.largestAvailableBoatLaunchTroops < input.usefulLaunchSize
  ) {
    reasons.push(
      `largest launch is below useful banking size ${input.usefulLaunchSize}`,
    );
  }
  if (input.activeTransportTroops > 0) {
    reasons.push(
      `already banking ${input.activeTransportTroops} troops in active transports`,
    );
    if (input.continuationReady) {
      reasons.push("active transport bank has room for another launch");
    }
  }
  if (input.activeBankRatio >= TROOP_BANKING_MAX_ACTIVE_BANK_RATIO) {
    reasons.push("active transport bank is already saturated");
  }
  reasons.push(`home danger is ${input.homeDanger}`);
  if (input.recommended) {
    reasons.push(
      "recommended: bank a transport before capped growth is wasted",
    );
  }
  return reasons;
}

function economyCadenceReasons(input: {
  recommended: boolean;
  ownTiles: number | null;
  ownTileShare: number | null;
  recentExpansionCount: number;
  recentBuildCount: number;
  cityCount: number;
  factoryCount: number;
  portCount: number;
  firstCityMissing: boolean;
  firstFactoryMissing: boolean;
  firstPortMissing: boolean;
  enoughLandBase: boolean;
  economyBuildActionCount: number;
  safeEconomyBuildActionCount: number;
  bestBuildUnit: string | null;
  bestBuildEconomicValue: number | null;
  homeDanger: AgentHomeDangerLevel;
}): string[] {
  const reasons: string[] = [];
  reasons.push(
    input.enoughLandBase
      ? `land base can support economy at ${input.ownTiles ?? "unknown"} tiles / ${percent(input.ownTileShare)} share`
      : `land base is still small at ${input.ownTiles ?? "unknown"} tiles / ${percent(input.ownTileShare)} share`,
  );
  reasons.push(
    `core economy counts City/Factory/Port=${input.cityCount}/${input.factoryCount}/${input.portCount}`,
  );
  reasons.push(
    `recent expansion/build counts=${input.recentExpansionCount}/${input.recentBuildCount}`,
  );
  const missing = [
    input.firstCityMissing ? "City" : null,
    input.firstFactoryMissing ? "Factory" : null,
    input.firstPortMissing ? "Port" : null,
  ].filter((unit): unit is string => unit !== null);
  reasons.push(
    missing.length === 0
      ? "first economy foundation is present"
      : `missing first ${missing.join("/")}`,
  );
  reasons.push(
    `${input.safeEconomyBuildActionCount}/${input.economyBuildActionCount} economy build action(s) are not high risk`,
  );
  if (input.bestBuildUnit !== null) {
    reasons.push(
      `best economy build is ${input.bestBuildUnit} with economic value ${roundRatioOrNull(input.bestBuildEconomicValue) ?? "unknown"}`,
    );
  }
  reasons.push(`home danger is ${input.homeDanger}`);
  if (input.recommended) {
    reasons.push(
      "recommended: turn stable expansion into City, Factory, or Port infrastructure",
    );
  }
  return reasons;
}

function navalControlReasons(input: {
  recommended: boolean;
  portCount: number;
  warshipCount: number;
  activeTransportCount: number;
  activeTransportTroops: number;
  boatLaunchActionCount: number;
  neutralBoatActionCount: number;
  navalInvasionActionCount: number;
  warshipBuildActionCount: number;
  warshipMoveActionCount: number;
  safeNavalActionCount: number;
  bestNavalActionID: string | null;
  bestNavalActionKind: string | null;
  homeDanger: AgentHomeDangerLevel;
}): string[] {
  const reasons: string[] = [];
  reasons.push(
    `naval assets Port/Warship=${input.portCount}/${input.warshipCount}`,
  );
  reasons.push(
    `active transports=${input.activeTransportCount} carrying ${input.activeTransportTroops} troops`,
  );
  reasons.push(
    `naval actions boat/neutral/invasion/warship/move=${input.boatLaunchActionCount}/${input.neutralBoatActionCount}/${input.navalInvasionActionCount}/${input.warshipBuildActionCount}/${input.warshipMoveActionCount}`,
  );
  reasons.push(
    `${input.safeNavalActionCount} naval action(s) are not high risk`,
  );
  if (input.bestNavalActionID !== null) {
    reasons.push(
      `best naval action is ${input.bestNavalActionID} (${input.bestNavalActionKind ?? "unknown"})`,
    );
  }
  reasons.push(`home danger is ${input.homeDanger}`);
  if (input.recommended) {
    reasons.push(
      "recommended: use the best transport, warship, or patrol action before naval options stall",
    );
  }
  return reasons;
}

function personalityDiplomacyPressureReasons(input: {
  recommended: boolean;
  profile: string;
  socialActionCount: number;
  pressureActionCount: number;
  communicationActionCount: number;
  recentSocialActionCount: number;
  recentSocialThrottle: boolean;
  bestActionID: string | null;
  bestActionKind: string | null;
  bestTargetName: string | null;
  bestScore: number | null;
  homeDanger: AgentHomeDangerLevel;
}): string[] {
  const reasons: string[] = [];
  reasons.push(
    `${input.socialActionCount} social action(s), ${input.pressureActionCount} pressure action(s), ${input.communicationActionCount} communication action(s)`,
  );
  reasons.push(
    `profile ${input.profile} is selecting visible diplomacy or pressure with home danger ${input.homeDanger}`,
  );
  reasons.push(`recent social action count is ${input.recentSocialActionCount}`);
  if (input.bestActionID !== null) {
    reasons.push(
      `best social action is ${input.bestActionID} (${input.bestActionKind ?? "unknown"}) toward ${input.bestTargetName ?? "the table"} score=${input.bestScore ?? "unknown"}`,
    );
  }
  if (input.recentSocialThrottle) {
    reasons.push("recent social actions throttle another social beat");
  }
  if (input.recommended) {
    reasons.push(
      "recommended: use the best profile-specific social action to create pressure, alliance, support, or communication instead of a bland loop",
    );
  }
  return reasons;
}

function lateGameStrikeTargetingReasons(input: {
  recommended: boolean;
  legalStrikeActionCount: number;
  highValueStrikeActionCount: number;
  siloTargetActionCount: number;
  samTargetActionCount: number;
  economyTargetActionCount: number;
  coveredNonSamTargetActionCount: number;
  recentNukeCount: number;
  bestStrikeActionID: string | null;
  bestStrikeWeapon: string | null;
  bestStrikeTargetName: string | null;
  bestStrikeTargetStructureUnit: string | null;
  bestStrikeScore: number | null;
  homeDanger: AgentHomeDangerLevel;
}): string[] {
  const reasons: string[] = [];
  reasons.push(
    `${input.legalStrikeActionCount} legal strike action(s), ${input.highValueStrikeActionCount} above priority threshold`,
  );
  reasons.push(
    `target mix silo/SAM/economy/covered=${input.siloTargetActionCount}/${input.samTargetActionCount}/${input.economyTargetActionCount}/${input.coveredNonSamTargetActionCount}`,
  );
  if (input.bestStrikeActionID !== null) {
    reasons.push(
      `best strike is ${input.bestStrikeActionID} (${input.bestStrikeWeapon ?? "unknown weapon"}) against ${input.bestStrikeTargetName ?? "unknown target"} ${input.bestStrikeTargetStructureUnit ?? "unknown structure"} score=${input.bestStrikeScore ?? "unknown"}`,
    );
  }
  reasons.push(`recent nuke count is ${input.recentNukeCount}`);
  reasons.push(`home danger is ${input.homeDanger}`);
  if (input.recommended) {
    reasons.push(
      "recommended: use the best legal nuke against a strategic target before late-game pressure stalls",
    );
  }
  return reasons;
}

function openingExpansionTempoReasons(input: {
  openingWindow: boolean;
  recommended: boolean;
  ownTileShare: number | null;
  expectedTileShare: number | null;
  leaderTileShareGap: number | null;
  neutralLandExpansionActionCount: number;
  neutralBoatExpansionActionCount: number;
  neutralExpansionAvailable: boolean;
  homeDanger: AgentHomeDangerLevel;
}): string[] {
  const reasons: string[] = [];
  reasons.push(
    input.openingWindow
      ? "inside opening tempo window"
      : "outside opening tempo window",
  );
  reasons.push(
    input.expectedTileShare === null
      ? `tile share ${percent(input.ownTileShare)} has no opening target`
      : `tile share ${percent(input.ownTileShare)} vs expected ${percent(input.expectedTileShare)}`,
  );
  reasons.push(`leader gap is ${percent(input.leaderTileShareGap)}`);
  reasons.push(
    input.neutralExpansionAvailable
      ? `${input.neutralLandExpansionActionCount} land and ${input.neutralBoatExpansionActionCount} neutral boat expansion action(s) visible`
      : "no neutral expansion action visible",
  );
  reasons.push(`home danger is ${input.homeDanger}`);
  if (input.recommended) {
    reasons.push("recommended: spend early expansion before the map closes");
  }
  return reasons;
}

function frontierConversionTimingReasons(input: {
  recommended: boolean;
  enoughLandBase: boolean;
  ownTileShare: number | null;
  ownTiles: number | null;
  recentExpansionCount: number;
  neutralExpansionAvailable: boolean;
  neutralExpansionActionCount: number;
  hostileAttackActionCount: number;
  favorableHostileAttackActionCount: number;
  executorReadyHostileAttackActionCount: number;
  bestTargetName: string | null;
  bestTargetRelativeTroopRatio: number | null;
  bestExecutorReadyTargetName: string | null;
  bestExecutorReadyRelativeTroopRatio: number | null;
  homeDanger: AgentHomeDangerLevel;
  neutralGrowthHandoffMature: boolean;
}): string[] {
  const reasons: string[] = [];
  reasons.push(
    input.enoughLandBase
      ? `land base is ready at ${input.ownTiles ?? "unknown"} tiles / ${percent(input.ownTileShare)} share`
      : `land base still small at ${input.ownTiles ?? "unknown"} tiles / ${percent(input.ownTileShare)} share`,
  );
  reasons.push(`recent expansion count is ${input.recentExpansionCount}`);
  reasons.push(
    input.neutralExpansionAvailable
      ? `${input.neutralExpansionActionCount} neutral growth action(s) still visible`
      : "neutral growth is not currently visible",
  );
  reasons.push(
    `${input.favorableHostileAttackActionCount}/${input.hostileAttackActionCount} hostile attack action(s) look favorable`,
  );
  reasons.push(
    `${input.executorReadyHostileAttackActionCount} hostile attack action(s) look executor-ready`,
  );
  if (input.bestTargetName !== null) {
    reasons.push(
      `best conversion target is ${input.bestTargetName} at ${roundRatioOrNull(input.bestTargetRelativeTroopRatio) ?? "unknown"}x troops`,
    );
  }
  if (input.bestExecutorReadyTargetName !== null) {
    reasons.push(
      `best executor-ready conversion is ${input.bestExecutorReadyTargetName} at ${roundRatioOrNull(input.bestExecutorReadyRelativeTroopRatio) ?? "unknown"}x troops`,
    );
  }
  reasons.push(`home danger is ${input.homeDanger}`);
  reasons.push(
    input.neutralGrowthHandoffMature
      ? "neutral-growth handoff is mature"
      : "neutral-growth handoff is still early",
  );
  if (input.recommended) {
    reasons.push(
      "recommended: convert a favorable rival before neutral farming goes stale",
    );
  }
  return reasons;
}

function frontierFinishPressureReasons(input: {
  recommended: boolean;
  activeTargetName: string | null;
  recentTargetAttackCount: number;
  recentLowCommitmentAttackCount: number;
  finishingAttackActionCount: number;
  decisiveAttackActionCount: number;
  bestTargetName: string | null;
  bestTargetRelativeTroopRatio: number | null;
  bestAttackTroopPercent: number | null;
  homeDanger: AgentHomeDangerLevel;
}): string[] {
  const reasons: string[] = [];
  reasons.push(
    input.activeTargetName === null
      ? "no recent hostile target"
      : `active hostile target is ${input.activeTargetName}`,
  );
  reasons.push(
    `${input.recentTargetAttackCount} recent attack(s), ${input.recentLowCommitmentAttackCount} low-commitment probe(s) on active target`,
  );
  reasons.push(
    `${input.finishingAttackActionCount} finish attack(s), ${input.decisiveAttackActionCount} decisive finish attack(s) visible`,
  );
  if (input.bestTargetName !== null) {
    reasons.push(
      `best finish attack is ${input.bestAttackTroopPercent ?? "unknown"}% into ${input.bestTargetName} at ${roundRatioOrNull(input.bestTargetRelativeTroopRatio) ?? "unknown"}x troops`,
    );
  }
  reasons.push(`home danger is ${input.homeDanger}`);
  if (input.recommended) {
    reasons.push(
      "recommended: escalate repeated probes into a decisive finish attack",
    );
  }
  return reasons;
}

function numberMetadata(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentageMetadata(value: unknown): number | null {
  const number = numberMetadata(value);
  if (number === null) {
    return null;
  }
  return number <= 1 ? number * 100 : number;
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isNeutralBoatAction(action: LegalAction): boolean {
  if (action.kind !== "boat" || action.metadata?.navalInvasion === true) {
    return false;
  }
  return (
    stringMetadata(action.metadata?.targetID) === null ||
    stringMetadata(action.metadata?.targetName) === "Terra Nullius" ||
    action.metadata?.expansion === true
  );
}

function sumNumbers(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function maxNumber(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function uniqueDescending(values: number[]): number[] {
  return Array.from(new Set(values.filter((value) => value > 0))).sort(
    (a, b) => b - a,
  );
}

function ratioOrNull(numerator: number | null, denominator: number | null) {
  if (numerator === null || denominator === null || denominator <= 0) {
    return null;
  }
  return numerator / denominator;
}

function roundRatioOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1_000) / 1_000;
}

function roundRatio(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percent(value: number | null): string {
  return value === null ? "unknown" : `${Math.round(value * 100)}%`;
}
