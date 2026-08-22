import { UnitType } from "../../core/game/Game";
import type { AgentObservation, LegalAction } from "./AgentTypes";
import type { ActiveCommanderPlan } from "./CommanderPlanLifecycle";
export { compareCommanderStrings } from "./CommanderPrimitives";

const economicUnits = new Set<string>([
  UnitType.City,
  UnitType.Factory,
  UnitType.Port,
]);
const defensiveUnits = new Set<string>([
  UnitType.DefensePost,
  UnitType.SAMLauncher,
]);
const economyExcludedUnits = new Set<string>([
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
]);

export function isLandExpansionAction(action: LegalAction): boolean {
  return (
    action.kind === "attack" &&
    action.metadata?.expansion === true &&
    action.metadata?.targetID === null &&
    action.intent?.type === "attack" &&
    action.intent.targetID === null
  );
}

export function isNeutralBoatAction(
  action: LegalAction,
  observation?: AgentObservation,
): boolean {
  if (
    action.kind !== "boat" ||
    action.metadata?.targetID !== null ||
    action.metadata?.navalInvasion === true ||
    action.intent?.type !== "boat" ||
    action.metadata?.targetTile !== action.intent.dst
  ) {
    return false;
  }
  const destination = action.intent.dst;
  const boatOptions = observation?.nonCombat.boatOptions;
  return (
    boatOptions === undefined ||
    boatOptions.length === 0 ||
    boatOptions.some(
      (option) => option.targetID === null && option.targetTile === destination,
    )
  );
}

export function isEconomicBuildAction(action: LegalAction): boolean {
  if (action.kind !== "build" || action.intent?.type !== "build_unit") {
    return false;
  }
  const unit = action.intent.unit;
  if (action.metadata?.unit !== unit) return false;
  if (economyExcludedUnits.has(unit)) return false;
  return action.metadata?.role === "economic" || economicUnits.has(unit);
}

export function isEconomicUpgradeAction(action: LegalAction): boolean {
  return (
    action.kind === "upgrade_structure" &&
    action.intent?.type === "upgrade_structure" &&
    action.metadata?.unit === action.intent.unit &&
    economicUnits.has(action.intent.unit)
  );
}

export function isPressurePrimaryAction(
  action: LegalAction,
  targetPlayerID: string,
  observation?: AgentObservation,
): boolean {
  const targetsRival = action.metadata?.targetID === targetPlayerID;
  if (
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    targetsRival
  ) {
    return (
      action.intent?.type === "attack" &&
      action.intent.targetID === targetPlayerID
    );
  }
  if (
    action.kind !== "boat" ||
    action.metadata?.navalInvasion !== true ||
    action.metadata?.expansion === true ||
    !targetsRival ||
    action.intent?.type !== "boat" ||
    action.metadata?.targetTile !== action.intent.dst
  ) {
    return false;
  }
  const destination = action.intent.dst;
  const boatOptions = observation?.nonCombat.boatOptions;
  return (
    boatOptions === undefined ||
    boatOptions.length === 0 ||
    boatOptions.some(
      (option) =>
        option.targetID === targetPlayerID && option.targetTile === destination,
    )
  );
}

export function isPressureSupportAction(
  action: LegalAction,
  targetPlayerID: string,
): boolean {
  if (action.metadata?.targetID !== targetPlayerID) return false;
  if (action.kind === "embargo") {
    return (
      action.metadata.action === "start" &&
      action.intent?.type === "embargo" &&
      action.intent.action === "start" &&
      action.intent.targetID === targetPlayerID
    );
  }
  return (
    action.kind === "target_player" &&
    action.intent?.type === "targetPlayer" &&
    action.intent.target === targetPlayerID
  );
}

export function isSurvivalPrimaryAction(action: LegalAction): boolean {
  if (action.kind === "hold") return action.intent === null;
  if (action.kind === "retreat") {
    return (
      action.intent?.type === "cancel_attack" &&
      action.metadata?.attackID === action.intent.attackID
    );
  }
  if (action.kind === "build" && action.intent?.type === "build_unit") {
    return (
      action.metadata?.unit === action.intent.unit &&
      (action.metadata?.role === "defensive" ||
        defensiveUnits.has(action.intent.unit))
    );
  }
  return (
    action.kind === "upgrade_structure" &&
    action.intent?.type === "upgrade_structure" &&
    action.metadata?.unit === action.intent.unit &&
    (action.metadata?.role === "defensive" ||
      defensiveUnits.has(action.intent.unit))
  );
}

export function isPlanPrimaryCompatible(
  action: LegalAction,
  plan: ActiveCommanderPlan,
  observation: AgentObservation,
): boolean {
  switch (plan.family) {
    case "expand":
      return (
        isLandExpansionAction(action) ||
        isNeutralBoatAction(action, observation)
      );
    case "develop_economy":
      return isEconomicBuildAction(action) || isEconomicUpgradeAction(action);
    case "pressure_rival": {
      const target = plan.targetPlayerID;
      if (target === null) return false;
      const rival = observation.visiblePlayers.find(
        (player) => player.playerID === target,
      );
      if (
        rival === undefined ||
        !rival.isAlive ||
        rival.isDisconnected ||
        rival.isAllied ||
        rival.isFriendly ||
        rival.isTeammate === true
      ) {
        return false;
      }
      return isPressurePrimaryAction(action, target, observation);
    }
    case "survive":
      return isSurvivalPrimaryAction(action);
  }
}

export function isPlanSupportCompatible(
  action: LegalAction,
  plan: ActiveCommanderPlan,
): boolean {
  return (
    plan.family === "pressure_rival" &&
    plan.targetPlayerID !== null &&
    isPressureSupportAction(action, plan.targetPlayerID)
  );
}
