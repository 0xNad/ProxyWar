import type {
  AgentExecutionDecision,
  AgentExecutor,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrainInput,
  LegalAction,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";
import {
  activeKeystoneDiplomacyMacroTarget,
  classifyKeystoneAllianceRequest,
  completeKeystoneDiplomacyMacro,
  initialKeystoneDiplomacyLedger,
  reconcileKeystoneDiplomacyLedger,
  registerKeystonePendingBreak,
  type KeystoneAllianceRequestClassification,
  type KeystoneDiplomacyLedger,
} from "./keystone-diplomacy-transaction";
import {
  arbitrateKeystoneAction,
  buildKeystoneWorldModel,
  normalizeKeystoneCommanderContext,
  proposeKeystoneConquest,
  proposeKeystoneConquestForTarget,
  proposeKeystoneEconomy,
  proposeKeystoneExpansion,
  proposeKeystonePolitics,
  proposeKeystoneSpawn,
  proposeKeystoneSurvival,
  resolveKeystoneBindingDirective,
  type KeystoneActionSelection,
  type KeystoneExpertProposal,
  type KeystoneWorldModel,
} from "./keystone-experts";

export const KEYSTONE_DIPLOMACY_ADJUDICATOR_MARKER =
  "keystone-diplomacy-adjudicator:v1";

export type KeystoneDiplomacyAdjudication =
  | "request_reactive_allowed"
  | "request_first_allowed"
  | "request_pending_suppressed"
  | "request_repeat_suppressed"
  | "request_realliance_suppressed"
  | "request_ambiguous_unchanged"
  | "break_bound_pending"
  | "break_unbound_suppressed"
  | "macro_survival"
  | "macro_target_conquest"
  | "macro_productive_delegate"
  | "macro_council_fallback"
  | "macro_target_completed"
  | "infrastructure_error";

export interface KeystoneDiplomacyAdjudicatorExecutorOptions {
  readonly delegate: AgentExecutor;
  readonly actionFollowsCanonicalPlan: (args: {
    input: AgentBrainInput;
    plan: StrategicPlan;
    action: LegalAction;
  }) => boolean;
}

const productiveKinds = new Set<LegalActionKind>([
  "attack",
  "boat",
  "build",
  "upgrade_structure",
  "nuke",
  "warship",
  "move_warship",
  "retreat",
  "boat_retreat",
]);

/**
 * Narrow default-off treatment around v16. It does not replace ordinary v16
 * choices. It adjudicates only transactional diplomacy and the bounded
 * conquest commitment created by an accepted, evidence-backed break.
 */
export class KeystoneDiplomacyAdjudicatorExecutor implements AgentExecutor {
  private ledger: KeystoneDiplomacyLedger = initialKeystoneDiplomacyLedger();

  constructor(
    private readonly options: KeystoneDiplomacyAdjudicatorExecutorOptions,
  ) {}

  decide(input: AgentBrainInput, plan: StrategicPlan): AgentExecutionDecision {
    const authoritative = this.options.delegate.decide(input, plan);
    try {
      this.ledger = reconcileKeystoneDiplomacyLedger(this.ledger, {
        gameID: input.observation.gameID,
        turnNumber: input.observation.turnNumber,
        recentDecisions: input.observation.recentDecisions,
      }).ledger;
      const world = this.world(input, plan);

      const macroTarget = activeKeystoneDiplomacyMacroTarget(this.ledger);
      if (macroTarget !== null) {
        const target = world.players.find(
          (player) => player.playerID === macroTarget,
        );
        if (target === undefined || target.isAlive === false) {
          this.ledger = completeKeystoneDiplomacyMacro(
            this.ledger,
            world.turnNumber,
            macroTarget,
          ).ledger;
          return markedUnchanged(authoritative, "macro_target_completed");
        }
        const survival = proposeKeystoneSurvival(world);
        if (survival !== null) {
          return replacementDecision(
            world,
            survival.actionID,
            survival.source,
            "macro_survival",
          );
        }
        const targetConquest = proposeKeystoneConquestForTarget(
          world,
          macroTarget,
        );
        if (targetConquest !== null) {
          return replacementDecision(
            world,
            targetConquest.actionID,
            targetConquest.source,
            "macro_target_conquest",
          );
        }
        const authoritativeAction = exactOfferedAction(
          input,
          authoritative.actionID,
        );
        if (
          authoritativeAction !== null &&
          productiveKinds.has(authoritativeAction.kind)
        ) {
          return markedUnchanged(authoritative, "macro_productive_delegate");
        }
        const fallback = nonPoliticalCouncilSelection(world);
        if (fallback !== null) {
          return replacementDecision(
            world,
            fallback.actionID,
            fallback.source,
            "macro_council_fallback",
          );
        }
      }

      const authoritativeAction = exactOfferedAction(
        input,
        authoritative.actionID,
      );
      if (authoritativeAction === null) {
        return authoritative;
      }
      if (authoritativeAction.kind === "alliance_request") {
        return this.adjudicateRequest(
          input,
          world,
          authoritative,
          authoritativeAction,
        );
      }
      if (authoritativeAction.kind === "break_alliance") {
        return this.adjudicateBreak(
          input,
          world,
          authoritative,
          authoritativeAction,
        );
      }
      return authoritative;
    } catch {
      // The treatment never turns malformed state or an expert failure into a
      // missing Coworld response. Exact v16 remains the fail-closed authority,
      // while the marker makes a broken arm impossible to mistake for control.
      return markedUnchanged(authoritative, "infrastructure_error");
    }
  }

  ledgerSnapshot(): KeystoneDiplomacyLedger {
    return this.ledger;
  }

  private world(
    input: AgentBrainInput,
    plan: StrategicPlan,
  ): KeystoneWorldModel {
    const planAlignedActionIDs: string[] = [];
    for (const action of input.legalActions) {
      if (this.options.actionFollowsCanonicalPlan({ input, plan, action })) {
        planAlignedActionIDs.push(action.id);
      }
    }
    return buildKeystoneWorldModel(input, {
      forbiddenActionKinds: plan.forbiddenActionKinds,
      planAlignedActionIDs,
      commander: normalizeKeystoneCommanderContext(plan),
    });
  }

  private adjudicateRequest(
    input: AgentBrainInput,
    world: KeystoneWorldModel,
    authoritative: AgentExecutionDecision,
    action: LegalAction,
  ): AgentExecutionDecision {
    const targetPlayerID = politicsTargetID(action);
    const targets = world.players.filter(
      (player) => player.playerID === targetPlayerID,
    );
    const target = targets.length === 1 ? targets[0]! : null;
    const classification = classifyKeystoneAllianceRequest({
      ledger: this.ledger,
      targetPlayerID,
      hasIncomingAllianceRequest: target?.hasIncomingAllianceRequest,
      hasOutgoingAllianceRequest: target?.hasOutgoingAllianceRequest,
    });
    if (classification === "reactive_request") {
      return markedUnchanged(authoritative, "request_reactive_allowed");
    }
    if (classification === "first_request") {
      return markedUnchanged(authoritative, "request_first_allowed");
    }
    if (classification === "ambiguous_request_state") {
      return markedUnchanged(authoritative, "request_ambiguous_unchanged");
    }
    const fallback = nonPoliticalCouncilSelection(world);
    if (fallback === null) {
      return markedUnchanged(authoritative, "infrastructure_error");
    }
    return replacementDecision(
      world,
      fallback.actionID,
      fallback.source,
      requestSuppressionMarker(classification),
    );
  }

  private adjudicateBreak(
    input: AgentBrainInput,
    world: KeystoneWorldModel,
    authoritative: AgentExecutionDecision,
    action: LegalAction,
  ): AgentExecutionDecision {
    const targetPlayerID = politicsTargetID(action);
    const backed = proposeKeystonePolitics(world);
    if (
      targetPlayerID !== null &&
      backed !== null &&
      backed.actionID === action.id &&
      backed.proposalID.startsWith("politics:break_to_bound_conquest:")
    ) {
      const registration = registerKeystonePendingBreak(this.ledger, {
        gameID: input.observation.gameID,
        turnNumber: input.observation.turnNumber,
        actionID: action.id,
        targetPlayerID,
      });
      if (registration.reason === "pending_break_rejected") {
        const fallback = nonPoliticalCouncilSelection(world);
        if (fallback === null) {
          return markedUnchanged(authoritative, "infrastructure_error");
        }
        return replacementDecision(
          world,
          fallback.actionID,
          fallback.source,
          "break_unbound_suppressed",
        );
      }
      this.ledger = registration.ledger;
      return markedUnchanged(authoritative, "break_bound_pending");
    }
    const fallback = nonPoliticalCouncilSelection(world);
    if (fallback === null) {
      return markedUnchanged(authoritative, "infrastructure_error");
    }
    return replacementDecision(
      world,
      fallback.actionID,
      fallback.source,
      "break_unbound_suppressed",
    );
  }
}

function nonPoliticalCouncilSelection(
  world: KeystoneWorldModel,
): KeystoneActionSelection | null {
  const spawn = proposeKeystoneSpawn(world);
  const survival = proposeKeystoneSurvival(world);
  const bindingResolution = resolveKeystoneBindingDirective(world);
  const binding = bindingResolution.proposal;
  const bindingAction =
    binding === null
      ? null
      : (world.actions.find((action) => action.id === binding.actionID) ??
        null);
  const nonPoliticalBinding =
    bindingAction !== null && bindingAction.actionOwner !== "politics"
      ? binding
      : null;
  const expertAuction: KeystoneExpertProposal[] = [];
  for (const proposal of [
    proposeKeystoneExpansion(world),
    proposeKeystoneEconomy(world),
    proposeKeystoneConquest(world),
  ]) {
    if (proposal !== null) {
      expertAuction.push(proposal);
    }
  }
  return arbitrateKeystoneAction(world, {
    spawn: spawn === null ? [] : [spawn],
    survival: survival === null ? [] : [survival],
    bindingDirective: nonPoliticalBinding === null ? [] : [nonPoliticalBinding],
    expertAuction,
  }).selection;
}

function replacementDecision(
  world: KeystoneWorldModel,
  actionID: string,
  source: string,
  adjudication: KeystoneDiplomacyAdjudication,
): AgentExecutionDecision {
  const actions = world.actions.filter((action) => action.id === actionID);
  if (actions.length !== 1) {
    throw new Error(
      "Diplomacy adjudicator replacement is not uniquely offered",
    );
  }
  return Object.freeze({
    actionID,
    actionIDs: [actionID],
    reason: `[${KEYSTONE_DIPLOMACY_ADJUDICATOR_MARKER} ${adjudication}] selected ${source}`,
    planFollowed: actions[0]!.planAligned,
    executorSource: "keystone-diplomacy-adjudicator",
    actionSelectionSource: `keystone-diplomacy-adjudicator:${source}`,
  });
}

function markedUnchanged(
  authoritative: AgentExecutionDecision,
  adjudication: KeystoneDiplomacyAdjudication,
): AgentExecutionDecision {
  return Object.freeze({
    ...authoritative,
    reason: `[${KEYSTONE_DIPLOMACY_ADJUDICATOR_MARKER} ${adjudication}] ${authoritative.reason}`,
    executorSource: "keystone-diplomacy-adjudicator",
    actionSelectionSource: `keystone-diplomacy-adjudicator:${adjudication}`,
  });
}

function requestSuppressionMarker(
  classification: KeystoneAllianceRequestClassification,
): KeystoneDiplomacyAdjudication {
  switch (classification) {
    case "outgoing_request_pending":
      return "request_pending_suppressed";
    case "repeat_request":
      return "request_repeat_suppressed";
    case "realliance_after_break":
      return "request_realliance_suppressed";
    case "reactive_request":
    case "first_request":
    case "ambiguous_request_state":
      throw new Error("Allowed request cannot be mapped to suppression");
  }
}

function exactOfferedAction(
  input: AgentBrainInput,
  actionID: string,
): LegalAction | null {
  const actions = input.legalActions.filter((action) => action.id === actionID);
  return actions.length === 1 ? actions[0]! : null;
}

function politicsTargetID(action: LegalAction): string | null {
  const targetID = action.metadata?.targetID;
  const recipientID = action.metadata?.recipientID;
  const valid = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  if (targetID !== undefined && targetID !== null && !valid(targetID)) {
    return null;
  }
  if (
    recipientID !== undefined &&
    recipientID !== null &&
    !valid(recipientID)
  ) {
    return null;
  }
  if (valid(targetID) && valid(recipientID) && targetID !== recipientID) {
    return null;
  }
  return valid(targetID) ? targetID : valid(recipientID) ? recipientID : null;
}
