import type {
  AgentVisiblePlayer,
  LegalAction,
  LegalActionKind,
} from "../../../src/server/agents/AgentTypes";

import type {
  KeystoneActionClassification,
  KeystoneActionFacts,
  KeystoneActionOwner,
  KeystoneBuildRole,
  KeystoneStructureUnitType,
} from "./types";

export interface ClassifyKeystoneActionsInput {
  legalActions: readonly LegalAction[];
  visiblePlayers: readonly AgentVisiblePlayer[];
  ownPlayerID: string | null;
  ownTeam: string | null;
  forbiddenActionKinds: readonly LegalActionKind[];
  planAlignedActionIDs: readonly string[];
  incomingAggressorIDs: readonly string[];
}

const hostileTargetKinds = new Set<LegalActionKind>([
  "attack",
  "boat",
  "nuke",
  "embargo",
  "target_player",
]);

const economyKinds = new Set<LegalActionKind>([
  "build",
  "upgrade_structure",
  "delete_unit",
]);

const conquestKinds = new Set<LegalActionKind>(["warship", "move_warship"]);

const politicsKinds = new Set<LegalActionKind>([
  "alliance_request",
  "alliance_reject",
  "alliance_extend",
  "break_alliance",
  "target_player",
  "embargo",
  "embargo_stop",
  "embargo_all",
  "donate_gold",
  "donate_troops",
  "quick_chat",
  "emoji",
]);

const structureUnitByMetadata = Object.freeze<
  Record<string, KeystoneStructureUnitType>
>({
  city: "city",
  port: "port",
  factory: "factory",
  "defense post": "defense_post",
  "sam launcher": "sam_launcher",
  "missile silo": "missile_silo",
});

const buildRoleByMetadata = Object.freeze<Record<string, KeystoneBuildRole>>({
  economic: "economic",
  defensive: "defensive",
  infrastructure: "infrastructure",
});

export function classifyKeystoneActions(
  input: ClassifyKeystoneActionsInput,
): KeystoneActionClassification {
  const offeredIDCounts = new Map<string, number>();
  for (const action of input.legalActions) {
    if (action.id.trim().length === 0) {
      throw new Error(
        "Keystone expert council received an empty offered action id",
      );
    }
    offeredIDCounts.set(action.id, (offeredIDCounts.get(action.id) ?? 0) + 1);
  }

  const ambiguousOfferedActionIDs = Object.freeze(
    Array.from(offeredIDCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
      .sort(compareText),
  );
  const ambiguousIDSet = new Set(ambiguousOfferedActionIDs);

  const forbiddenKinds = new Set(input.forbiddenActionKinds);
  const planAlignedIDs = new Set(input.planAlignedActionIDs);
  const incomingAggressorIDs = new Set(input.incomingAggressorIDs);
  const playerByID = new Map(
    input.visiblePlayers.map((player) => [player.playerID, player]),
  );

  const actions = Object.freeze(
    input.legalActions
      .filter((action) => !ambiguousIDSet.has(action.id))
      .map((action): KeystoneActionFacts => {
        const targetPlayerID = actionTargetPlayerID(action);
        const target =
          targetPlayerID === null ? undefined : playerByID.get(targetPlayerID);
        const sameTeam =
          input.ownTeam !== null &&
          target?.team !== null &&
          target?.team !== undefined &&
          target.team === input.ownTeam;
        const targetsSelf =
          targetPlayerID !== null && targetPlayerID === input.ownPlayerID;
        const targetsFriendlyOrTeam =
          targetsSelf ||
          target?.isAllied === true ||
          target?.isFriendly === true ||
          target?.isTeammate === true ||
          sameTeam;
        const neutralExpansion = isNeutralExpansion(action);
        const hostileTargetAction =
          hostileTargetKinds.has(action.kind) && !neutralExpansion;
        const unitType = actionStructureUnitType(action);
        const buildRole = actionBuildRole(action);

        return Object.freeze({
          id: action.id,
          kind: action.kind,
          unitType,
          buildRole,
          targetPlayerID,
          isSpawn: action.kind === "spawn",
          isHold: action.kind === "hold",
          isNeutralExpansion: neutralExpansion,
          isHostileTargetAction: hostileTargetAction,
          targetsSelf,
          targetsFriendlyOrTeam,
          safetyBlocked: hostileTargetAction && targetsFriendlyOrTeam,
          forbidden: forbiddenKinds.has(action.kind),
          planAligned: planAlignedIDs.has(action.id),
          actionRiskBP: actionRiskBasisPoints(action),
          troopCommitmentBP: troopCommitmentBasisPoints(action),
          actionOwner: actionOwner({
            action,
            targetPlayerID,
            neutralExpansion,
            incomingAggressorIDs,
          }),
        });
      })
      .sort((a, b) => compareText(a.id, b.id)),
  );
  return Object.freeze({ actions, ambiguousOfferedActionIDs });
}

export function actionOwner(input: {
  action: LegalAction;
  targetPlayerID: string | null;
  neutralExpansion: boolean;
  incomingAggressorIDs: ReadonlySet<string>;
}): KeystoneActionOwner {
  if (input.action.kind === "spawn" || input.action.kind === "hold") {
    return "arbiter";
  }
  if (input.action.kind === "retreat" || input.action.kind === "boat_retreat") {
    return "survival";
  }
  if (input.neutralExpansion) {
    return "expansion";
  }
  if (
    input.action.kind === "attack" ||
    input.action.kind === "boat" ||
    input.action.kind === "nuke"
  ) {
    if (input.targetPlayerID === null) {
      return null;
    }
    return input.incomingAggressorIDs.has(input.targetPlayerID)
      ? "survival"
      : "conquest";
  }
  if (economyKinds.has(input.action.kind)) {
    return "economy";
  }
  if (conquestKinds.has(input.action.kind)) {
    return "conquest";
  }
  if (politicsKinds.has(input.action.kind)) {
    return "politics";
  }
  return null;
}

export function actionTargetPlayerID(action: LegalAction): string | null {
  const targetID = action.metadata?.targetID;
  if (typeof targetID === "string" && targetID.length > 0) {
    return targetID;
  }
  const recipientID = action.metadata?.recipientID;
  return typeof recipientID === "string" && recipientID.length > 0
    ? recipientID
    : null;
}

export function isNeutralExpansion(action: LegalAction): boolean {
  const targetName = String(action.metadata?.targetName ?? "")
    .trim()
    .toLowerCase();
  return (
    (action.kind === "attack" || action.kind === "boat") &&
    actionTargetPlayerID(action) === null &&
    (action.metadata?.expansion === true ||
      action.metadata?.isNeutral === true ||
      action.metadata?.targetType === "neutral" ||
      targetName === "terra nullius")
  );
}

export function actionRiskBasisPoints(action: LegalAction): number {
  const score = action.risk.score;
  if (typeof score === "number" && Number.isFinite(score)) {
    return Math.round(Math.min(1, Math.max(0, score)) * 10_000);
  }
  switch (action.risk.level) {
    case "none":
      return 0;
    case "low":
      return 2_500;
    case "medium":
      return 5_000;
    case "high":
      return 7_500;
  }
}

function actionStructureUnitType(
  action: LegalAction,
): KeystoneStructureUnitType | null {
  if (action.kind !== "build" && action.kind !== "upgrade_structure") {
    return null;
  }
  const unit = normalizeMetadataLabel(action.metadata?.unit);
  return unit === null ? null : (structureUnitByMetadata[unit] ?? null);
}

function actionBuildRole(action: LegalAction): KeystoneBuildRole | null {
  if (action.kind !== "build") {
    return null;
  }
  const role = normalizeMetadataLabel(action.metadata?.role);
  return role === null ? null : (buildRoleByMetadata[role] ?? null);
}

function normalizeMetadataLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

/**
 * Reads only canonical metadata fields. If either present field is malformed,
 * or the two canonical representations disagree, the commitment is unknown.
 */
export function troopCommitmentBasisPoints(action: LegalAction): number | null {
  const metadata = action.metadata;
  if (metadata === undefined) {
    return null;
  }
  const hasPercent = Object.prototype.hasOwnProperty.call(
    metadata,
    "troopPercent",
  );
  const hasPercentage = Object.prototype.hasOwnProperty.call(
    metadata,
    "troopPercentage",
  );
  if (!hasPercent && !hasPercentage) {
    return null;
  }

  const percentBP = hasPercent
    ? normalizedCommitmentBP(metadata.troopPercent, 100)
    : null;
  const percentageBP = hasPercentage
    ? normalizedCommitmentBP(metadata.troopPercentage, 10_000)
    : null;
  if (
    (hasPercent && percentBP === null) ||
    (hasPercentage && percentageBP === null)
  ) {
    return null;
  }
  if (
    percentBP !== null &&
    percentageBP !== null &&
    percentBP !== percentageBP
  ) {
    return null;
  }
  return percentBP ?? percentageBP;
}

function normalizedCommitmentBP(
  value: string | number | boolean | null | undefined,
  scale: number,
): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value * scale > 10_000
  ) {
    return null;
  }
  return Math.round(value * scale);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
