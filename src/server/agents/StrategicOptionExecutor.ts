import type { AgentBrainInput, LegalAction } from "./AgentTypes";
import type { ActiveCommanderPlan } from "./CommanderPlanLifecycle";
import type { StrategicOptionCandidate } from "./StrategicCommanderTypes";
import {
  compareCommanderStrings,
  isLandExpansionAction,
  isPlanPrimaryCompatible,
  isPlanSupportCompatible,
} from "./StrategicOptionCompatibility";

export const commanderFidelityClasses = [
  "aligned_primary",
  "aligned_support",
  "hard_emergency_override",
  "hold_plan_blocked",
] as const;
export type CommanderFidelityClass = (typeof commanderFidelityClasses)[number];

/** V0 deliberately has no hard emergency escape hatch. */
export const commanderHardEmergencyConditions = [] as const;
export type CommanderHardEmergencyCondition = never;

export const commanderBlockedReasons = [
  "candidate_missing",
  "primary_binding_empty",
  "primary_action_unavailable",
  "outer_brain_timeout",
  "outer_brain_error",
  "validator_fallback",
  "engine_rejected",
  "support_blocked",
] as const;
export type CommanderBlockedReason = (typeof commanderBlockedReasons)[number];

export interface CommanderExecutedAction {
  actionID: string;
  fidelity: CommanderFidelityClass;
  emergencyCondition: null;
}

export interface StrategicOptionExecution {
  actionID: string;
  actionIDs?: string[];
  actions: CommanderExecutedAction[];
  blockedReason: CommanderBlockedReason | null;
  immediateReplan: boolean;
  reason: string;
}

export interface ExecuteStrategicOptionInput {
  brainInput: AgentBrainInput;
  plan: ActiveCommanderPlan;
  candidate: StrategicOptionCandidate | null;
  planAgeDecisions: number;
}

/**
 * Executes an already-selected strategy. The binding is the universe: global
 * scorers and the tactical brain never see the unfiltered menu on active play.
 */
export function executeStrategicOption(
  input: ExecuteStrategicOptionInput,
): StrategicOptionExecution {
  const { brainInput, plan, candidate } = input;
  if (candidate === null || candidate.id !== plan.selectedStrategicOptionId) {
    return blockedExecution(brainInput.legalActions, "candidate_missing");
  }

  const offered = firstOfferedActionsByID(brainInput.legalActions);
  const primary = candidate.binding.alignedPrimaryActionIDs
    .map((id) => offered.get(id))
    .filter((action): action is LegalAction => action !== undefined)
    .filter((action) =>
      isPlanPrimaryCompatible(action, plan, brainInput.observation),
    );
  if (candidate.binding.alignedPrimaryActionIDs.length === 0) {
    return blockedExecution(brainInput.legalActions, "primary_binding_empty");
  }
  if (primary.length === 0) {
    return blockedExecution(
      brainInput.legalActions,
      "primary_action_unavailable",
    );
  }

  const selectedPrimary = selectPrimary(primary, input);
  const actions: CommanderExecutedAction[] = [
    executed(selectedPrimary.id, "aligned_primary"),
  ];
  if (plan.family === "pressure_rival" && input.planAgeDecisions === 0) {
    const support = candidate.binding.alignedSupportActionIDs
      .map((id) => offered.get(id))
      .filter((action): action is LegalAction => action !== undefined)
      .filter((action) => isPlanSupportCompatible(action, plan))
      .sort(supportCompare)[0];
    if (support !== undefined && support.id !== selectedPrimary.id) {
      actions.push(executed(support.id, "aligned_support"));
    }
  }

  const actionIDs = actions.map((action) => action.actionID);
  return {
    actionID: actionIDs[0]!,
    ...(actionIDs.length > 1 ? { actionIDs } : {}),
    actions,
    blockedReason: null,
    immediateReplan: false,
    reason: `execute ${plan.selectedStrategicOptionId}`,
  };
}

export function commanderBatchFidelityStamp(
  actions: readonly CommanderExecutedAction[],
): string {
  return JSON.stringify(
    Object.fromEntries(
      actions.map((action) => [action.actionID, action.fidelity]),
    ),
  );
}

function selectPrimary(
  actions: readonly LegalAction[],
  input: ExecuteStrategicOptionInput,
): LegalAction {
  switch (input.plan.family) {
    case "expand":
      return selectExpansion(actions, input);
    case "develop_economy":
      return [...actions].sort(economyCompare)[0]!;
    case "pressure_rival":
      return selectPressure(actions, input);
    case "survive":
      return [...actions].sort(survivalCompare)[0]!;
  }
}

function selectExpansion(
  actions: readonly LegalAction[],
  input: ExecuteStrategicOptionInput,
): LegalAction {
  const land = actions.filter(isLandExpansionAction);
  const universe = land.length > 0 ? land : actions;
  const ownTroops = input.brainInput.observation.ownState?.troops ?? 0;
  const finiteCosts = universe
    .map(intentTroops)
    .filter((value): value is number => value !== null);
  const smallestCost =
    finiteCosts.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.min(...finiteCosts);
  const base = ownTroops >= 3 * smallestCost ? 0.2 : 0.1;
  const target = escalatedTarget(universe, base, input.planAgeDecisions > 0);
  return chooseRatio(universe, target);
}

function selectPressure(
  actions: readonly LegalAction[],
  input: ExecuteStrategicOptionInput,
): LegalAction {
  const land = actions.filter((action) => action.kind === "attack");
  const universe = land.length > 0 ? land : actions;
  const ownTroops = input.brainInput.observation.ownState?.troops ?? 0;
  const rival = input.brainInput.observation.visiblePlayers.find(
    (player) => player.playerID === input.plan.targetPlayerID,
  );
  const base = rival !== undefined && ownTroops > rival.troops ? 0.25 : 0.1;
  const target = escalatedTarget(universe, base, input.planAgeDecisions > 0);
  return chooseRatio(universe, target);
}

function escalatedTarget(
  actions: readonly LegalAction[],
  base: number,
  escalate: boolean,
): number {
  if (!escalate) return base;
  const above = actions
    .map(actionRatio)
    .filter((value): value is number => value !== null && value > base)
    .sort((a, b) => a - b)[0];
  return above ?? base;
}

function chooseRatio(
  actions: readonly LegalAction[],
  target: number,
): LegalAction {
  return [...actions].sort((left, right) => {
    const leftRatio = actionRatio(left) ?? Number.POSITIVE_INFINITY;
    const rightRatio = actionRatio(right) ?? Number.POSITIVE_INFINITY;
    const leftAbove = leftRatio >= target;
    const rightAbove = rightRatio >= target;
    if (leftAbove !== rightAbove) return leftAbove ? -1 : 1;
    const distance =
      Math.abs(leftRatio - target) - Math.abs(rightRatio - target);
    return distance || compareCommanderStrings(left.id, right.id);
  })[0]!;
}

function economyCompare(left: LegalAction, right: LegalAction): number {
  const leftBuild = left.kind === "build" ? 0 : 1;
  const rightBuild = right.kind === "build" ? 0 : 1;
  const leftRole = left.metadata?.role === "economic" ? 0 : 1;
  const rightRole = right.metadata?.role === "economic" ? 0 : 1;
  return (
    leftBuild - rightBuild ||
    leftRole - rightRole ||
    numericMetadata(right, "economicValue") -
      numericMetadata(left, "economicValue") ||
    compareCommanderStrings(left.id, right.id)
  );
}

function survivalCompare(left: LegalAction, right: LegalAction): number {
  const priority = (action: LegalAction): number =>
    action.kind === "retreat"
      ? 0
      : action.kind === "build" || action.kind === "upgrade_structure"
        ? 1
        : 2;
  const leftPriority = priority(left);
  const rightPriority = priority(right);
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  const valueKey = leftPriority === 0 ? "troops" : "defensiveValue";
  return (
    numericMetadata(right, valueKey) - numericMetadata(left, valueKey) ||
    compareCommanderStrings(left.id, right.id)
  );
}

function supportCompare(left: LegalAction, right: LegalAction): number {
  const leftPriority = left.kind === "embargo" ? 0 : 1;
  const rightPriority = right.kind === "embargo" ? 0 : 1;
  return (
    leftPriority - rightPriority || compareCommanderStrings(left.id, right.id)
  );
}

function blockedExecution(
  legalActions: readonly LegalAction[],
  blockedReason: CommanderBlockedReason,
): StrategicOptionExecution {
  const hold = legalActions.find((action) => action.kind === "hold");
  if (hold === undefined) {
    throw new Error(
      "Commander blocked execution requires an offered hold action",
    );
  }
  const actions = [executed(hold.id, "hold_plan_blocked")];
  return {
    actionID: hold.id,
    actions,
    blockedReason,
    immediateReplan: true,
    reason: `hold: ${blockedReason}`,
  };
}

function executed(
  actionID: string,
  fidelity: CommanderFidelityClass,
): CommanderExecutedAction {
  return { actionID, fidelity, emergencyCondition: null };
}

function numericMetadata(action: LegalAction, key: string): number {
  const value = action.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function actionRatio(action: LegalAction): number | null {
  const value = action.metadata?.troopPercentage;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function intentTroops(action: LegalAction): number | null {
  const value =
    action.intent !== null && "troops" in action.intent
      ? action.intent.troops
      : null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** Match AgentDecisionValidator's Array.find() authority for duplicate ids. */
function firstOfferedActionsByID(
  actions: readonly LegalAction[],
): ReadonlyMap<string, LegalAction> {
  const offered = new Map<string, LegalAction>();
  for (const action of actions) {
    if (!offered.has(action.id)) offered.set(action.id, action);
  }
  return offered;
}
