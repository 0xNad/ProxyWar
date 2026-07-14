import type {
  KeystoneActionFacts,
  KeystoneCommanderBinding,
  KeystoneDirectiveProposal,
  KeystoneWorldModel,
} from "./types";

export type KeystoneBindingDirectiveStatus =
  | "absent"
  | "proposed"
  | "unavailable";

export interface KeystoneBindingDirectiveResolution {
  readonly status: KeystoneBindingDirectiveStatus;
  readonly kind: KeystoneCommanderBinding["kind"] | null;
  readonly proposal: KeystoneDirectiveProposal<"binding_directive"> | null;
}

/** Maps one Commander order to at most one exact, currently offered action id. */
export function resolveKeystoneBindingDirective(
  world: KeystoneWorldModel,
): KeystoneBindingDirectiveResolution {
  const binding = world.commander.binding;
  if (binding === null) {
    return freezeResolution("absent", null, null);
  }

  const action = actionForBinding(world, binding);
  if (action === null) {
    return freezeResolution("unavailable", binding.kind, null);
  }
  const proposal: KeystoneDirectiveProposal<"binding_directive"> =
    Object.freeze({
      proposalID: `binding:${binding.kind}:${action.id}`,
      actionID: action.id,
      source: "binding_directive",
      rationale: `execute current Commander ${binding.kind.replaceAll("_", " ")} through an exact offered action`,
      expectedValueBP: 10_000,
      urgencyBP: 10_000,
      confidenceBP: 10_000,
      riskBP: action.actionRiskBP,
      opportunityCostBP: 0,
    });
  return freezeResolution("proposed", binding.kind, proposal);
}

function actionForBinding(
  world: KeystoneWorldModel,
  binding: KeystoneCommanderBinding,
): KeystoneActionFacts | null {
  const ambiguous = new Set(world.ambiguousOfferedActionIDs);
  const common = world.actions.filter(
    (action) =>
      !ambiguous.has(action.id) &&
      !action.forbidden &&
      !action.safetyBlocked &&
      !action.isSpawn &&
      !action.isHold,
  );
  switch (binding.kind) {
    case "attack_target":
      return attackBindingAction(world, common, binding);
    case "alliance":
      return allianceBindingAction(world, common, binding);
    case "build":
      return buildBindingAction(common, binding);
  }
}

function attackBindingAction(
  world: KeystoneWorldModel,
  actions: readonly KeystoneActionFacts[],
  binding: Extract<
    KeystoneCommanderBinding,
    { readonly kind: "attack_target" }
  >,
): KeystoneActionFacts | null {
  const target = uniquePlayer(world, binding.targetPlayerID);
  if (target === null || !target.isAlive || target.friendlyOrTeam) {
    return null;
  }
  const targeted = actions.filter(
    (action) =>
      action.actionOwner === "conquest" &&
      action.targetPlayerID === binding.targetPlayerID &&
      !action.targetsSelf &&
      !action.targetsFriendlyOrTeam &&
      !action.isNeutralExpansion,
  );
  const land = targeted
    .filter(
      (action) =>
        action.kind === "attack" &&
        action.troopCommitmentBP !== null &&
        action.troopCommitmentBP !== undefined &&
        action.troopCommitmentBP >= binding.minCommitmentBP,
    )
    .sort(
      (a, b) =>
        a.troopCommitmentBP! - b.troopCommitmentBP! ||
        a.actionRiskBP - b.actionRiskBP ||
        compareText(a.id, b.id),
    );
  if (land[0] !== undefined) {
    return land[0];
  }
  return (
    targeted
      .filter((action) => action.kind === "boat")
      .sort(
        (a, b) => a.actionRiskBP - b.actionRiskBP || compareText(a.id, b.id),
      )[0] ?? null
  );
}

function allianceBindingAction(
  world: KeystoneWorldModel,
  actions: readonly KeystoneActionFacts[],
  binding: Extract<KeystoneCommanderBinding, { readonly kind: "alliance" }>,
): KeystoneActionFacts | null {
  const qualifying = actions.filter((action) => {
    if (
      action.actionOwner !== "politics" ||
      (action.kind !== "alliance_request" &&
        action.kind !== "alliance_extend") ||
      action.targetsSelf ||
      action.targetPlayerID === null ||
      (binding.targetPlayerID !== null &&
        action.targetPlayerID !== binding.targetPlayerID)
    ) {
      return false;
    }
    const target = uniquePlayer(world, action.targetPlayerID);
    return target !== null && target.isAlive;
  });
  const preferredKind =
    binding.stance === "hold_alliance" ? "alliance_extend" : "alliance_request";
  return (
    [...qualifying].sort((a, b) => {
      const preferredDifference =
        Number(a.kind !== preferredKind) - Number(b.kind !== preferredKind);
      return (
        preferredDifference ||
        a.actionRiskBP - b.actionRiskBP ||
        compareText(a.id, b.id)
      );
    })[0] ?? null
  );
}

function buildBindingAction(
  actions: readonly KeystoneActionFacts[],
  binding: Extract<KeystoneCommanderBinding, { readonly kind: "build" }>,
): KeystoneActionFacts | null {
  return (
    actions
      .filter((action) => {
        if (
          action.actionOwner !== "economy" ||
          action.kind !== "build" ||
          action.targetsSelf ||
          action.targetPlayerID !== null
        ) {
          return false;
        }
        if (binding.unit === "any") {
          return (
            action.buildRole === "economic" &&
            (action.unitType === "city" ||
              action.unitType === "factory" ||
              action.unitType === "port")
          );
        }
        if (action.unitType !== binding.unit) {
          return false;
        }
        return binding.unit === "missile_silo" ||
          binding.unit === "sam_launcher"
          ? true
          : action.buildRole === "economic";
      })
      .sort(
        (a, b) => a.actionRiskBP - b.actionRiskBP || compareText(a.id, b.id),
      )[0] ?? null
  );
}

function uniquePlayer(
  world: KeystoneWorldModel,
  playerID: string,
): KeystoneWorldModel["players"][number] | null {
  const matching = world.players.filter(
    (player) => player.playerID === playerID,
  );
  return matching.length === 1 ? matching[0]! : null;
}

function freezeResolution(
  status: KeystoneBindingDirectiveStatus,
  kind: KeystoneCommanderBinding["kind"] | null,
  proposal: KeystoneDirectiveProposal<"binding_directive"> | null,
): KeystoneBindingDirectiveResolution {
  return Object.freeze({ status, kind, proposal });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
