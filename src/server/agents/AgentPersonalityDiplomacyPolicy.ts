import type {
  AgentHomeDangerLevel,
  AgentPersonalityDiplomacyMode,
  AgentStrategyProfile,
  AgentVisiblePlayer,
  LegalAction,
  LegalActionKind,
} from "./AgentTypes";

export type AgentPersonalityDiplomacyKindGroup =
  | "pressure"
  | "alliance"
  | "support"
  | "communication";

export interface PersonalityDiplomacyScoreInput {
  action: LegalAction;
  profile: AgentStrategyProfile;
  visiblePlayers: AgentVisiblePlayer[];
  leaderID?: string | null;
  recentExpansionCount?: number;
  recentSocialActionCount?: number;
  homeDanger?: AgentHomeDangerLevel;
}

const personalityDiplomacyBaseScores: Partial<
  Record<LegalActionKind, number>
> = {
  target_player: 72,
  embargo: 64,
  embargo_all: 58,
  alliance_reject: 52,
  break_alliance: 68,
  alliance_request: 62,
  alliance_extend: 66,
  donate_gold: 54,
  donate_troops: 42,
  embargo_stop: 44,
  quick_chat: 30,
  emoji: 26,
};

export function isPersonalityDiplomacyActionKind(
  kind: LegalActionKind,
): boolean {
  return personalityDiplomacyKindGroup(kind) !== null;
}

export function personalityDiplomacyKindGroup(
  kind: LegalActionKind,
): AgentPersonalityDiplomacyKindGroup | null {
  if (
    kind === "target_player" ||
    kind === "embargo" ||
    kind === "embargo_all" ||
    kind === "break_alliance" ||
    kind === "alliance_reject"
  ) {
    return "pressure";
  }
  if (kind === "alliance_request" || kind === "alliance_extend") {
    return "alliance";
  }
  if (
    kind === "donate_gold" ||
    kind === "donate_troops" ||
    kind === "embargo_stop"
  ) {
    return "support";
  }
  if (kind === "quick_chat" || kind === "emoji") {
    return "communication";
  }
  return null;
}

export function isPersonalityPressureActionKind(
  kind: LegalActionKind,
): boolean {
  return personalityDiplomacyKindGroup(kind) === "pressure";
}

export function isPersonalitySupportActionKind(kind: LegalActionKind): boolean {
  const group = personalityDiplomacyKindGroup(kind);
  return group === "alliance" || group === "support";
}

export function personalityDiplomacyModeForAction(
  profile: AgentStrategyProfile,
  action: LegalAction,
): AgentPersonalityDiplomacyMode {
  const group = personalityDiplomacyKindGroup(action.kind);
  if (group === "communication") {
    return "showmanship";
  }
  if (group === "pressure") {
    return profile === "opportunistic"
      ? "opportunistic_pressure"
      : "aggressive_pressure";
  }
  if (profile === "defensive") {
    return "defensive_alliance";
  }
  if (profile === "diplomatic" || group === "support") {
    return "diplomatic_support";
  }
  return "defensive_alliance";
}

export function personalityDiplomacyActionScore(
  input: PersonalityDiplomacyScoreInput,
): number {
  const { action, profile } = input;
  const group = personalityDiplomacyKindGroup(action.kind);
  if (group === null) {
    return 0;
  }

  const targetID = personalityDiplomacyActionPlayerID(action);
  const target =
    targetID === null
      ? null
      : (input.visiblePlayers.find(
          (player) => player.playerID === targetID || player.clientID === targetID,
        ) ?? null);
  const targetIsLeader =
    targetID !== null && input.leaderID !== undefined && targetID === input.leaderID;
  const targetLooksWeak =
    (target?.relativeTroopRatio ?? 0) >= 1.18 ||
    (target?.tileShare ?? 1) <= 0.08;
  const targetIsBorderedOrAttackable =
    target?.sharesBorder === true || target?.canAttack === true;
  const targetIsIncomingAttacker = target?.incomingAttack === true;

  let score = personalityDiplomacyBaseScores[action.kind] ?? 0;
  if (group === "pressure" && profile === "aggressive") {
    score += 26;
  } else if (group === "pressure" && profile === "opportunistic") {
    score += 18;
  } else if (group === "pressure" && profile === "defensive") {
    score += targetIsIncomingAttacker ? 20 : -8;
  } else if (group === "pressure" && profile === "diplomatic") {
    score += targetIsLeader || targetIsIncomingAttacker ? 8 : -10;
  }

  if ((group === "alliance" || group === "support") && profile === "diplomatic") {
    score += 30;
  } else if (
    (group === "alliance" || group === "support") &&
    profile === "defensive"
  ) {
    score += input.homeDanger === "high" ? 30 : 16;
  } else if (
    (group === "alliance" || group === "support") &&
    profile === "aggressive"
  ) {
    score -= 10;
  }

  if (group === "communication") {
    score += profile === "diplomatic" ? 24 : profile === "aggressive" ? 10 : 6;
  }
  if (group === "pressure" && targetIsLeader) {
    score += 20;
  }
  if (group === "pressure" && targetLooksWeak) {
    score += 14;
  }
  if (group === "pressure" && targetIsBorderedOrAttackable) {
    score += 10;
  }
  if (group === "pressure" && targetIsIncomingAttacker) {
    score += 18;
  }
  if ((group === "alliance" || group === "support") && targetIsLeader) {
    score -= input.homeDanger === "high" ? 4 : 24;
  }
  if ((input.recentExpansionCount ?? 0) >= 2) {
    score += group === "communication" ? 8 : 14;
  }
  if ((input.recentSocialActionCount ?? 0) > 0) {
    score -= Math.min(38, (input.recentSocialActionCount ?? 0) * 14);
  }
  if (input.homeDanger === "high" && group === "pressure" && !targetIsIncomingAttacker) {
    score -= 38;
  }

  if (action.risk.level === "none") {
    score += 8;
  } else if (action.risk.level === "low") {
    score += 4;
  } else if (action.risk.level === "medium") {
    score -= 8;
  } else {
    score -= 34;
  }
  return Math.round(score);
}

export function personalityDiplomacyActionPlayerID(
  action: LegalAction,
): string | null {
  const targetID = action.metadata?.targetID;
  if (typeof targetID === "string" && targetID.length > 0) {
    return targetID;
  }
  const recipientID = action.metadata?.recipientID;
  if (typeof recipientID === "string" && recipientID.length > 0) {
    return recipientID;
  }
  const playerID = action.metadata?.playerID;
  if (typeof playerID === "string" && playerID.length > 0) {
    return playerID;
  }
  return null;
}
