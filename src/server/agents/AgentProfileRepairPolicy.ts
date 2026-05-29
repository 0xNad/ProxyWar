import type { FrontierPolicyModule } from "./AgentPlannerExecutor";
import {
  AgentObservation,
  AgentStrategyProfile,
  LegalAction,
} from "./AgentTypes";

export interface AgentProfileRepairRerankInput {
  profile: AgentStrategyProfile;
  observation: AgentObservation;
  legalActions: readonly LegalAction[];
  action: LegalAction;
}

export interface AgentProfileRepairRerankScore {
  module: FrontierPolicyModule;
  score: number;
  reason: string;
  penaltyScore?: number;
  penaltyReason?: string;
}

export function scoreProfileRepairRerankAction(
  input: AgentProfileRepairRerankInput,
): AgentProfileRepairRerankScore | null {
  const context = profileRepairContext(input.observation, input.legalActions);
  if (!context.repairWindow) {
    return null;
  }
  if (input.action.kind === "hold" && context.profileAlternativeAvailable) {
    return {
      module: "utility_social",
      score: 0,
      reason: "profile repair keeps hold available but discourages stalled profile loops",
      penaltyScore: 46,
      penaltyReason: "profile repair found a legal profile-specific alternative to hold",
    };
  }
  if (
    isNeutralGrowthAction(input.action) &&
    context.repeatedNeutralExpansion &&
    context.profileAlternativeAvailable
  ) {
    return {
      module: "expansion",
      score: 0,
      reason: "profile repair keeps expansion legal but rotates away from repeated neutral farming",
      penaltyScore: 24,
      penaltyReason:
        "profile repair rotates repeated neutral expansion toward profile-specific alternatives",
    };
  }
  return profileRepairAlternativeScore(input, context);
}

function profileRepairAlternativeScore(
  input: AgentProfileRepairRerankInput,
  context: AgentProfileRepairContext,
): AgentProfileRepairRerankScore | null {
  switch (input.profile) {
    case "aggressive":
      return aggressiveRepairScore(input, context);
    case "defensive":
      return defensiveRepairScore(input, context);
    case "diplomatic":
      return diplomaticRepairScore(input, context);
    case "opportunistic":
      return opportunisticRepairScore(input, context);
  }
}

interface AgentProfileRepairContext {
  repeatedNeutralExpansion: boolean;
  holdLoop: boolean;
  repairWindow: boolean;
  profileAlternativeAvailable: boolean;
}

function profileRepairContext(
  observation: AgentObservation,
  legalActions: readonly LegalAction[],
): AgentProfileRepairContext {
  const repeatedNeutralExpansion =
    observation.memory.recentExpansionCount >= 2 ||
    (observation.memory.repeatedActionKind === "attack" &&
      observation.memory.repeatedActionCount >= 3 &&
      legalActions.some(isNeutralGrowthAction));
  const holdLoop =
    (observation.memory.recentHoldCount ?? 0) >= 2 ||
    (observation.memory.turnsSinceLastProductiveAction ?? 0) >= 2;
  const earlyOpening =
    observation.turnNumber < 900 &&
    (observation.ownState?.tileShare ??
      observation.endgame?.ownTileShare ??
      0) < 0.04;
  const repairWindow =
    observation.phase !== "spawn" &&
    (holdLoop || (repeatedNeutralExpansion && !earlyOpening));
  const profileAlternativeAvailable = legalActions.some(
    (action) =>
      action.kind !== "hold" &&
      !isNeutralGrowthAction(action) &&
      action.risk?.level !== "high" &&
      isProfileExpressionAction(observation.profile, action),
  );
  return {
    repeatedNeutralExpansion,
    holdLoop,
    repairWindow,
    profileAlternativeAvailable,
  };
}

function aggressiveRepairScore(
  input: AgentProfileRepairRerankInput,
  _context: AgentProfileRepairContext,
): AgentProfileRepairRerankScore | null {
  if (isHostileAttackAction(input.action) && attackLooksFavorable(input)) {
    return {
      module: "combat",
      score: 58,
      reason:
        "profile repair boosts aggressive weak-border pressure over collapsed neutral expansion",
    };
  }
  if (isPressureSignalAction(input.action)) {
    return {
      module: "combat",
      score: 34,
      reason:
        "profile repair gives aggressive profile a visible pressure signal",
    };
  }
  if (input.action.kind === "nuke") {
    return {
      module: "nuclear_endgame",
      score: 30,
      reason: "profile repair lets aggressive profile express late-game force",
    };
  }
  return null;
}

function defensiveRepairScore(
  input: AgentProfileRepairRerankInput,
  _context: AgentProfileRepairContext,
): AgentProfileRepairRerankScore | null {
  if (isDefenseBuildAction(input.action)) {
    return {
      module: "defense",
      score: 56,
      reason:
        "profile repair boosts defensive structure timing over bland loops",
    };
  }
  if (isEconomyBuildAction(input.action)) {
    return {
      module: "economy",
      score: 42,
      reason:
        "profile repair lets defensive profile convert stable land into economy",
    };
  }
  if (isNavalControlAction(input.action)) {
    return {
      module: "naval",
      score: 34,
      reason: "profile repair gives defensive profile a sea-control outlet",
    };
  }
  if (input.action.kind === "alliance_request") {
    return {
      module: "diplomacy",
      score: 24,
      reason: "profile repair lets defensive profile secure a flank",
    };
  }
  return null;
}

function diplomaticRepairScore(
  input: AgentProfileRepairRerankInput,
  _context: AgentProfileRepairContext,
): AgentProfileRepairRerankScore | null {
  if (isFriendlyDiplomacyAction(input.action)) {
    return {
      module: "diplomacy",
      score: 58,
      reason:
        "profile repair boosts diplomatic support or alliance expression",
    };
  }
  if (isCommunicationAction(input.action)) {
    return {
      module: "utility_social",
      score: 38,
      reason: "profile repair gives diplomatic profile a visible communication beat",
    };
  }
  if (isPressureSignalAction(input.action)) {
    return {
      module: "diplomacy",
      score: 24,
      reason: "profile repair uses diplomacy pressure when support is unavailable",
    };
  }
  return null;
}

function opportunisticRepairScore(
  input: AgentProfileRepairRerankInput,
  context: AgentProfileRepairContext,
): AgentProfileRepairRerankScore | null {
  if (isHostileAttackAction(input.action) && attackLooksFavorable(input)) {
    return {
      module: "combat",
      score: 48,
      reason: "profile repair lets opportunistic profile pivot into a weak rival",
    };
  }
  if (isEconomyBuildAction(input.action)) {
    return {
      module: "economy",
      score: context.repeatedNeutralExpansion ? 42 : 32,
      reason: "profile repair lets opportunistic profile cash in expansion",
    };
  }
  if (isNavalControlAction(input.action)) {
    return {
      module: "naval",
      score: 38,
      reason: "profile repair gives opportunistic profile a naval pivot",
    };
  }
  if (isPressureSignalAction(input.action)) {
    return {
      module: "combat",
      score: 28,
      reason: "profile repair adds opportunistic pressure variety",
    };
  }
  if (input.action.kind === "nuke") {
    return {
      module: "nuclear_endgame",
      score: 34,
      reason: "profile repair lets opportunistic profile use a high-value strike",
    };
  }
  return null;
}

function isProfileExpressionAction(
  profile: AgentStrategyProfile,
  action: LegalAction,
): boolean {
  switch (profile) {
    case "aggressive":
      return (
        isHostileAttackAction(action) ||
        isPressureSignalAction(action) ||
        action.kind === "nuke"
      );
    case "defensive":
      return (
        isDefenseBuildAction(action) ||
        isEconomyBuildAction(action) ||
        isNavalControlAction(action) ||
        action.kind === "alliance_request"
      );
    case "diplomatic":
      return (
        isFriendlyDiplomacyAction(action) ||
        isCommunicationAction(action) ||
        isPressureSignalAction(action)
      );
    case "opportunistic":
      return (
        isHostileAttackAction(action) ||
        isEconomyBuildAction(action) ||
        isNavalControlAction(action) ||
        isPressureSignalAction(action) ||
        action.kind === "nuke"
      );
  }
}

function attackLooksFavorable(input: AgentProfileRepairRerankInput): boolean {
  const targetID = metadataString(input.action, "targetID");
  const target =
    targetID === null
      ? null
      : (input.observation.visiblePlayers.find(
          (player) => player.playerID === targetID,
        ) ?? null);
  const relativeTroopRatio =
    metadataNumber(input.action, "relativeTroopRatio") ??
    target?.relativeTroopRatio ??
    0;
  return (
    input.action.risk?.level !== "high" &&
    (relativeTroopRatio === 0 || relativeTroopRatio >= 1.08)
  );
}

function isNeutralGrowthAction(action: LegalAction): boolean {
  return (
    (action.kind === "attack" &&
      (action.metadata?.expansion === true ||
        action.metadata?.targetID === null ||
        action.id.startsWith("expand:"))) ||
    (action.kind === "boat" && metadataString(action, "targetID") === null)
  );
}

function isHostileAttackAction(action: LegalAction): boolean {
  return (
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    metadataString(action, "targetID") !== null
  );
}

function isEconomyBuildAction(action: LegalAction): boolean {
  if (action.kind !== "build" && action.kind !== "upgrade_structure") {
    return false;
  }
  return /economic|city|factory|port|trade|income|market/i.test(
    metadataText(action),
  );
}

function isDefenseBuildAction(action: LegalAction): boolean {
  if (action.kind !== "build" && action.kind !== "upgrade_structure") {
    return false;
  }
  return /defense|defence|sam|silo|missile|shield|fort/i.test(
    metadataText(action),
  );
}

function isNavalControlAction(action: LegalAction): boolean {
  return (
    action.kind === "boat" ||
    action.kind === "boat_retreat" ||
    action.kind === "warship" ||
    action.kind === "move_warship" ||
    action.metadata?.navalInvasion === true
  );
}

function isPressureSignalAction(action: LegalAction): boolean {
  return [
    "target_player",
    "embargo",
    "embargo_all",
    "break_alliance",
    "alliance_reject",
  ].includes(action.kind);
}

function isFriendlyDiplomacyAction(action: LegalAction): boolean {
  return [
    "alliance_request",
    "alliance_extend",
    "donate_gold",
    "donate_troops",
    "embargo_stop",
  ].includes(action.kind);
}

function isCommunicationAction(action: LegalAction): boolean {
  return action.kind === "quick_chat" || action.kind === "emoji";
}

function metadataNumber(action: LegalAction, key: string): number | null {
  const value = action.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataString(action: LegalAction, key: string): string | null {
  const value = action.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metadataText(action: LegalAction): string {
  return JSON.stringify(action.metadata ?? {});
}
