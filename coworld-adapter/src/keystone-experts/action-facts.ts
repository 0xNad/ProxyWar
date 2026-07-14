import type {
  AgentVisiblePlayer,
  LegalAction,
  LegalActionKind,
} from "../../../src/server/agents/AgentTypes";

import type { KeystoneActionFacts } from "./types";

export interface ClassifyKeystoneActionsInput {
  legalActions: readonly LegalAction[];
  visiblePlayers: readonly AgentVisiblePlayer[];
  ownPlayerID: string | null;
  ownTeam: string | null;
  forbiddenActionKinds: readonly LegalActionKind[];
  planAlignedActionIDs: readonly string[];
}

const hostileTargetKinds = new Set<LegalActionKind>([
  "attack",
  "boat",
  "nuke",
  "embargo",
  "target_player",
]);

export function classifyKeystoneActions(
  input: ClassifyKeystoneActionsInput,
): readonly KeystoneActionFacts[] {
  const offeredIDs = new Set<string>();
  for (const action of input.legalActions) {
    if (action.id.trim().length === 0) {
      throw new Error(
        "Keystone expert council received an empty offered action id",
      );
    }
    if (offeredIDs.has(action.id)) {
      throw new Error(
        `Keystone expert council received duplicate offered action id: ${action.id}`,
      );
    }
    offeredIDs.add(action.id);
  }

  const forbiddenKinds = new Set(input.forbiddenActionKinds);
  const planAlignedIDs = new Set(input.planAlignedActionIDs);
  const playerByID = new Map(
    input.visiblePlayers.map((player) => [player.playerID, player]),
  );

  return Object.freeze(
    input.legalActions
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

        return Object.freeze({
          id: action.id,
          kind: action.kind,
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
        });
      })
      .sort((a, b) => compareText(a.id, b.id)),
  );
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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
