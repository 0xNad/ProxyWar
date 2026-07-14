import type {
  KeystoneActionFacts,
  KeystoneExpertProposal,
  KeystoneStructureUnitType,
  KeystoneWorldModel,
} from "./types";

const ECONOMY_START_TURN = 1_800;
const CAP_PRESSURE_BP = 8_500;

const economicUnitPriority: Readonly<
  Record<
    Extract<KeystoneStructureUnitType, "city" | "port" | "factory">,
    number
  >
> = Object.freeze({
  city: 0,
  port: 1,
  factory: 2,
});

type EconomicUnit = keyof typeof economicUnitPriority;
type EconomyActionClass = "city" | "port" | "factory" | "upgrade";
type EconomyOpportunity = "cap_pressure" | "frontier_exhausted" | "mature";

export type KeystoneEconomyProposal = KeystoneExpertProposal & {
  readonly source: "economy";
};

interface EconomyScorecard {
  readonly expectedValueBP: number;
  readonly urgencyBP: number;
  readonly confidenceBP: number;
  readonly opportunityCostBP: number;
}

const actionScores: Readonly<Record<EconomyActionClass, EconomyScorecard>> =
  Object.freeze({
    city: Object.freeze({
      expectedValueBP: 8_400,
      urgencyBP: 6_800,
      confidenceBP: 9_000,
      opportunityCostBP: 1_800,
    }),
    port: Object.freeze({
      expectedValueBP: 7_300,
      urgencyBP: 5_200,
      confidenceBP: 8_200,
      opportunityCostBP: 2_200,
    }),
    factory: Object.freeze({
      expectedValueBP: 7_000,
      urgencyBP: 4_800,
      confidenceBP: 8_200,
      opportunityCostBP: 2_400,
    }),
    upgrade: Object.freeze({
      expectedValueBP: 6_200,
      urgencyBP: 4_000,
      confidenceBP: 7_800,
      opportunityCostBP: 3_000,
    }),
  });

/**
 * Proposes one economy-owned action without interpreting ids or prices.
 * Being offered is the affordability proof; malformed or non-economic action
 * metadata makes this shadow expert abstain instead of guessing.
 */
export function proposeKeystoneEconomy(
  world: KeystoneWorldModel,
): KeystoneEconomyProposal | null {
  if (
    world.phase !== "active" ||
    world.own === null ||
    hasVerifiedIncomingAggression(world)
  ) {
    return null;
  }

  const capPressure =
    world.own.troopRatioBP !== null &&
    world.own.troopRatioBP >= CAP_PRESSURE_BP;
  const frontierAvailable = hasAvailableNeutralExpansion(world);
  if (
    world.turnNumber < ECONOMY_START_TURN &&
    frontierAvailable &&
    !capPressure
  ) {
    return null;
  }

  const ambiguousIDs = new Set(world.ambiguousOfferedActionIDs);
  const eligible = world.actions.filter(
    (action) =>
      action.actionOwner === "economy" &&
      !action.isSpawn &&
      !action.isHold &&
      !action.forbidden &&
      !action.safetyBlocked &&
      !ambiguousIDs.has(action.id) &&
      economyActionClass(action) !== null,
  );
  const selected = chooseEconomyAction(eligible);
  if (selected === null) {
    return null;
  }

  const actionClass = economyActionClass(selected)!;
  const opportunity: EconomyOpportunity = capPressure
    ? "cap_pressure"
    : frontierAvailable
      ? "mature"
      : "frontier_exhausted";
  const score = economyScore(actionClass, opportunity);
  const unit = selected.unitType!;

  return Object.freeze({
    proposalID: `economy:${opportunity}:${actionClass}:${selected.id}`,
    actionID: selected.id,
    source: "economy",
    rationale: `${opportunity.replaceAll("_", " ")} economy: ${unit.replaceAll("_", " ")} ${selected.kind === "build" ? "build" : "upgrade"}; offered legality proves affordability`,
    expectedValueBP: score.expectedValueBP,
    urgencyBP: score.urgencyBP,
    confidenceBP: score.confidenceBP,
    riskBP: basisPoints(selected.actionRiskBP),
    opportunityCostBP: score.opportunityCostBP,
    commitmentKey:
      selected.kind === "build"
        ? `economy:${unit}-foundation`
        : `economy:${unit}-upgrade`,
    horizonDecisions: selected.kind === "build" ? 2 : 1,
  });
}

function hasVerifiedIncomingAggression(world: KeystoneWorldModel): boolean {
  return (
    world.incomingAggressorIDs.length > 0 ||
    world.players.some((player) => player.incomingAttack)
  );
}

function hasAvailableNeutralExpansion(world: KeystoneWorldModel): boolean {
  if (world.canExpandIntoNeutral) {
    return true;
  }
  const ambiguousIDs = new Set(world.ambiguousOfferedActionIDs);
  return world.actions.some(
    (action) =>
      action.actionOwner === "expansion" &&
      action.isNeutralExpansion &&
      !action.forbidden &&
      !action.safetyBlocked &&
      !ambiguousIDs.has(action.id),
  );
}

function chooseEconomyAction(
  actions: readonly KeystoneActionFacts[],
): KeystoneActionFacts | null {
  let selected: KeystoneActionFacts | null = null;
  for (const action of actions) {
    if (selected === null || compareEconomyActions(action, selected) < 0) {
      selected = action;
    }
  }
  return selected;
}

function compareEconomyActions(
  a: KeystoneActionFacts,
  b: KeystoneActionFacts,
): number {
  return (
    economyActionPriority(a) - economyActionPriority(b) ||
    basisPoints(a.actionRiskBP) - basisPoints(b.actionRiskBP) ||
    compareText(a.id, b.id)
  );
}

function economyActionPriority(action: KeystoneActionFacts): number {
  if (action.kind === "build" && isEconomicUnit(action.unitType)) {
    return economicUnitPriority[action.unitType];
  }
  if (action.kind === "upgrade_structure" && isEconomicUnit(action.unitType)) {
    return 3 + economicUnitPriority[action.unitType];
  }
  return Number.MAX_SAFE_INTEGER;
}

function economyActionClass(
  action: KeystoneActionFacts,
): EconomyActionClass | null {
  if (!isEconomicUnit(action.unitType)) {
    return null;
  }
  if (action.kind === "build") {
    return action.buildRole === "economic" ? action.unitType : null;
  }
  return action.kind === "upgrade_structure" ? "upgrade" : null;
}

function isEconomicUnit(
  unitType: KeystoneActionFacts["unitType"],
): unitType is EconomicUnit {
  return unitType === "city" || unitType === "port" || unitType === "factory";
}

function economyScore(
  actionClass: EconomyActionClass,
  opportunity: EconomyOpportunity,
): EconomyScorecard {
  const base = actionScores[actionClass];
  if (opportunity === "mature") {
    return base;
  }
  return Object.freeze({
    expectedValueBP: base.expectedValueBP,
    urgencyBP: basisPoints(
      base.urgencyBP + (opportunity === "cap_pressure" ? 1_500 : 1_000),
    ),
    confidenceBP: base.confidenceBP,
    opportunityCostBP: basisPoints(
      base.opportunityCostBP - (opportunity === "cap_pressure" ? 800 : 1_000),
    ),
  });
}

function basisPoints(value: number): number {
  if (!Number.isFinite(value)) {
    return 10_000;
  }
  return Math.round(Math.min(10_000, Math.max(0, value)));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
