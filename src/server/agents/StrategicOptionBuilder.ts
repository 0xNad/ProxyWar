import { UnitType } from "../../core/game/Game";
import type { AgentBrainInput, LegalAction } from "./AgentTypes";
import { sanitizeUntrustedDisplayString } from "./PromptSanitizer";
import {
  strategicOptionFamilies,
  type BuiltStrategicOptions,
  type ExposedStrategicOption,
  type StrategicOptionCandidate,
  type StrategicOptionFamily,
  type StrategicOptionOmission,
} from "./StrategicCommanderTypes";

export const MAX_EXPOSED_STRATEGIC_OPTIONS = 8;
export const MAX_EXPOSED_PRESSURE_TARGETS = 2;

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

/** Pure Stage 1 construction. Calling it has no effect on any existing brain. */
export function buildStrategicOptions(
  input: AgentBrainInput,
): BuiltStrategicOptions {
  if (
    input.observation.phase !== "active" ||
    input.observation.ownState?.isAlive !== true
  ) {
    return emptyStrategicOptions();
  }
  const legalActions = [...input.legalActions].sort(compareActionsById);
  const visiblePlayers = [...input.observation.visiblePlayers].sort((a, b) =>
    compareStrings(a.playerID, b.playerID),
  );
  const ownState = input.observation.ownState;
  const ownTroops = ownState?.troops ?? input.observation.combat.ownTroops ?? 0;
  const ownTiles = ownState?.tilesOwned ?? 0;
  const candidates: StrategicOptionCandidate[] = [];

  const landExpansionActions = legalActions.filter(isLandExpansionAction);
  const neutralBoatActions = legalActions.filter(isNeutralBoatAction);
  if (landExpansionActions.length > 0 || neutralBoatActions.length > 0) {
    candidates.push({
      id: "expand",
      family: "expand",
      targetPlayerID: null,
      targetName: null,
      binding: binding([...landExpansionActions, ...neutralBoatActions], []),
      evidence: {
        neutralLandReachable: landExpansionActions.length > 0,
        neutralBoatReachable: neutralBoatActions.length > 0,
        ownTroops,
        ownTiles,
      },
    });
  }

  const economicBuildActions = legalActions.filter(isEconomicBuildAction);
  const economicUpgradeActions = legalActions.filter(isEconomicUpgradeAction);
  if (economicBuildActions.length > 0 || economicUpgradeActions.length > 0) {
    candidates.push({
      id: "develop_economy",
      family: "develop_economy",
      targetPlayerID: null,
      targetName: null,
      binding: binding(
        [...economicBuildActions, ...economicUpgradeActions],
        [],
      ),
      evidence: {
        economicBuildAvailable: economicBuildActions.length > 0,
        economicUpgradeAvailable: economicUpgradeActions.length > 0,
        gold: ownState?.gold ?? "0",
        ownTiles,
      },
    });
  }

  const incomingAttackers = new Set(
    input.observation.combat.incomingAttackPlayerIDs,
  );
  for (const rival of visiblePlayers) {
    if (
      !rival.isAlive ||
      rival.isAllied ||
      rival.isFriendly ||
      rival.isTeammate === true
    ) {
      continue;
    }
    const pressurePrimaryActions = legalActions.filter((action) =>
      isPressurePrimaryAction(action, rival.playerID),
    );
    if (pressurePrimaryActions.length === 0) {
      continue;
    }
    const pressureSupportActions = legalActions.filter((action) =>
      isPressureSupportAction(action, rival.playerID),
    );
    candidates.push({
      id: `pressure_rival:${rival.playerID}`,
      family: "pressure_rival",
      targetPlayerID: rival.playerID,
      targetName: sanitizeUntrustedDisplayString(rival.name),
      binding: binding(pressurePrimaryActions, pressureSupportActions),
      evidence: {
        sharesBorder: rival.sharesBorder,
        targetTroops: rival.troops,
        targetTiles: rival.tilesOwned,
        ownTroops,
        targetIsAllied: rival.isAllied,
        targetAttackedMeRecently: incomingAttackers.has(rival.playerID),
      },
    });
  }

  if (ownState?.isAlive === true) {
    const survivalPrimaryActions = legalActions.filter(isSurvivalPrimaryAction);
    if (survivalPrimaryActions.length > 0) {
      candidates.push({
        id: "survive",
        family: "survive",
        targetPlayerID: null,
        targetName: null,
        binding: binding(survivalPrimaryActions, []),
        evidence: {
          incomingAttackCount: ownState.incomingAttacks,
          strongerBorderRivalCount: visiblePlayers.filter(
            (rival) =>
              rival.isAlive &&
              rival.sharesBorder &&
              !rival.isAllied &&
              !rival.isFriendly &&
              rival.isTeammate !== true &&
              rival.troops > ownTroops,
          ).length,
          ownTroops,
          borderTiles: ownState.borderTiles,
        },
      });
    }
  }

  const canonicalCandidates = orderCandidates(candidates);
  const { retained, omitted: pressureOmissions } =
    capPressureTargets(canonicalCandidates);
  const { exposedCandidates, omitted: exposureOmissions } =
    boundStrategicOptionExposure(retained);
  const exposed = exposedCandidates.map(toExposedStrategicOption);
  const omitted = [...pressureOmissions, ...exposureOmissions].sort((a, b) =>
    compareStrings(a.id, b.id),
  );

  return {
    candidates: canonicalCandidates,
    exposed,
    record: {
      eligibleOptionIds: canonicalCandidates
        .map((candidate) => candidate.id)
        .sort(compareStrings),
      exposedOptionIds: exposed.map((option) => option.id),
      omitted,
    },
  };
}

function isLandExpansionAction(action: LegalAction): boolean {
  return action.kind === "attack" && action.metadata?.expansion === true;
}

function isNeutralBoatAction(action: LegalAction): boolean {
  return action.kind === "boat" && action.metadata?.targetID === null;
}

function isEconomicBuildAction(action: LegalAction): boolean {
  if (action.kind !== "build") {
    return false;
  }
  const unit = String(action.metadata?.unit ?? "");
  if (economyExcludedUnits.has(unit)) {
    return false;
  }
  return action.metadata?.role === "economic" || economicUnits.has(unit);
}

function isEconomicUpgradeAction(action: LegalAction): boolean {
  return (
    action.kind === "upgrade_structure" &&
    economicUnits.has(String(action.metadata?.unit ?? ""))
  );
}

function isPressurePrimaryAction(
  action: LegalAction,
  targetPlayerID: string,
): boolean {
  const targetsRival = action.metadata?.targetID === targetPlayerID;
  return (
    (action.kind === "attack" &&
      action.metadata?.expansion !== true &&
      targetsRival) ||
    (action.kind === "boat" &&
      action.metadata?.navalInvasion === true &&
      targetsRival)
  );
}

function isPressureSupportAction(
  action: LegalAction,
  targetPlayerID: string,
): boolean {
  return (
    (action.kind === "embargo" || action.kind === "target_player") &&
    action.metadata?.targetID === targetPlayerID
  );
}

function isSurvivalPrimaryAction(action: LegalAction): boolean {
  return (
    action.kind === "hold" ||
    action.kind === "retreat" ||
    ((action.kind === "build" || action.kind === "upgrade_structure") &&
      (action.metadata?.role === "defensive" ||
        defensiveUnits.has(String(action.metadata?.unit ?? ""))))
  );
}

function emptyStrategicOptions(): BuiltStrategicOptions {
  return {
    candidates: [],
    exposed: [],
    record: {
      eligibleOptionIds: [],
      exposedOptionIds: [],
      omitted: [],
    },
  };
}

function binding(
  primaryActions: readonly LegalAction[],
  supportActions: readonly LegalAction[],
): StrategicOptionCandidate["binding"] {
  return {
    alignedPrimaryActionIDs: stableUniqueActionIds(primaryActions),
    alignedSupportActionIDs: stableUniqueActionIds(supportActions),
  };
}

function stableUniqueActionIds(actions: readonly LegalAction[]): string[] {
  return [...new Set(actions.map((action) => action.id))].sort(compareStrings);
}

function orderCandidates(
  candidates: readonly StrategicOptionCandidate[],
): StrategicOptionCandidate[] {
  const familyOrder = new Map<StrategicOptionFamily, number>(
    strategicOptionFamilies.map((family, index) => [family, index]),
  );
  return [...candidates].sort(
    (a, b) =>
      (familyOrder.get(a.family) ?? Number.MAX_SAFE_INTEGER) -
        (familyOrder.get(b.family) ?? Number.MAX_SAFE_INTEGER) ||
      compareStrings(a.id, b.id),
  );
}

function capPressureTargets(candidates: readonly StrategicOptionCandidate[]): {
  retained: StrategicOptionCandidate[];
  omitted: StrategicOptionOmission[];
} {
  const pressureCandidates = candidates.filter(
    (candidate) => candidate.family === "pressure_rival",
  );
  const landReachable = pressureCandidates.filter((candidate) =>
    pressureSharesBorder(candidate),
  );
  const boatOnlyReachable = pressureCandidates.filter(
    (candidate) => !pressureSharesBorder(candidate),
  );
  const selectedPressure =
    landReachable.length > 0 && boatOnlyReachable.length > 0
      ? [landReachable[0]!, boatOnlyReachable[0]!]
      : (landReachable.length > 0 ? landReachable : boatOnlyReachable).slice(
          0,
          MAX_EXPOSED_PRESSURE_TARGETS,
        );
  const retainedIds = new Set(
    selectedPressure.map((candidate) => candidate.id),
  );

  return {
    retained: strategicOptionFamilies.flatMap((family) =>
      family === "pressure_rival"
        ? selectedPressure
        : candidates.filter((candidate) => candidate.family === family),
    ),
    omitted: pressureCandidates
      .filter((candidate) => !retainedIds.has(candidate.id))
      .map((candidate) => ({
        id: candidate.id,
        reason: "pressure_target_cap" as const,
      })),
  };
}

/**
 * Pure coverage-first exposure bound over canonically ordered candidates.
 * Exported so the otherwise unreachable eight-option guard can be verified
 * independently of V0's two-pressure cap.
 */
export function boundStrategicOptionExposure(
  candidates: readonly StrategicOptionCandidate[],
): {
  exposedCandidates: StrategicOptionCandidate[];
  omitted: StrategicOptionOmission[];
} {
  const queues = new Map<StrategicOptionFamily, StrategicOptionCandidate[]>(
    strategicOptionFamilies.map((family) => [
      family,
      candidates.filter((candidate) => candidate.family === family),
    ]),
  );
  const exposedCandidates: StrategicOptionCandidate[] = [];

  for (
    let depth = 0;
    exposedCandidates.length < MAX_EXPOSED_STRATEGIC_OPTIONS;
    depth++
  ) {
    let addedAtDepth = false;
    for (const family of strategicOptionFamilies) {
      const candidate = queues.get(family)?.[depth];
      if (candidate === undefined) {
        continue;
      }
      exposedCandidates.push(candidate);
      addedAtDepth = true;
      if (exposedCandidates.length === MAX_EXPOSED_STRATEGIC_OPTIONS) {
        break;
      }
    }
    if (!addedAtDepth) {
      break;
    }
  }

  const exposedIds = new Set(
    exposedCandidates.map((candidate) => candidate.id),
  );
  return {
    exposedCandidates,
    omitted: candidates
      .filter((candidate) => !exposedIds.has(candidate.id))
      .map((candidate) => ({
        id: candidate.id,
        reason: "exposure_cap" as const,
      })),
  };
}

function pressureSharesBorder(candidate: StrategicOptionCandidate): boolean {
  return (
    candidate.family === "pressure_rival" &&
    "sharesBorder" in candidate.evidence &&
    candidate.evidence.sharesBorder
  );
}

function toExposedStrategicOption(
  candidate: StrategicOptionCandidate,
): ExposedStrategicOption {
  return {
    id: candidate.id,
    family: candidate.family,
    targetPlayerID: candidate.targetPlayerID,
    targetName: candidate.targetName,
    evidence: candidate.evidence,
  };
}

function compareActionsById(a: LegalAction, b: LegalAction): number {
  return compareStrings(a.id, b.id);
}

function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
