import { AgentDecision, LegalAction } from "./AgentTypes";

export type AgentDecisionValidation =
  | { ok: true; action: LegalAction }
  | { ok: false; reason: string; fallback: LegalAction | null };

export interface AgentDecisionBatchValidation {
  ok: boolean;
  actions: LegalAction[];
  rejectedActionIDs: string[];
  fallback: LegalAction | null;
  reason: string;
}

export function validateAgentDecision(
  decision: AgentDecision,
  legalActions: LegalAction[],
): AgentDecisionValidation {
  const action = legalActions.find(
    (candidate) => candidate.id === decision.actionID,
  );
  if (action !== undefined) {
    return { ok: true, action };
  }

  const fallback =
    legalActions.find((candidate) => candidate.kind === "hold") ?? null;
  return {
    ok: false,
    reason: `decision selected unknown action id: ${decision.actionID}`,
    fallback,
  };
}

export function validateAgentDecisionBatch(
  decision: AgentDecision,
  legalActions: LegalAction[],
): AgentDecisionBatchValidation {
  const requestedActionIDs = requestedBatchActionIDs(decision);
  const actions: LegalAction[] = [];
  const rejectedActionIDs: string[] = [];

  for (const actionID of requestedActionIDs) {
    const action = legalActions.find((candidate) => candidate.id === actionID);
    if (action !== undefined) {
      actions.push(action);
    } else {
      rejectedActionIDs.push(actionID);
    }
  }

  if (actions.length > 0) {
    return {
      ok: rejectedActionIDs.length === 0,
      actions,
      rejectedActionIDs,
      fallback: null,
      reason:
        rejectedActionIDs.length === 0
          ? "all requested action ids are legal"
          : `ignored unknown action ids: ${rejectedActionIDs.join(",")}`,
    };
  }

  const fallback =
    legalActions.find((candidate) => candidate.kind === "hold") ?? null;
  return {
    ok: false,
    actions: fallback ? [fallback] : [],
    rejectedActionIDs,
    fallback,
    reason:
      rejectedActionIDs.length > 0
        ? `decision selected no known action ids: ${rejectedActionIDs.join(",")}`
        : "decision selected no action ids",
  };
}

function requestedBatchActionIDs(decision: AgentDecision): string[] {
  const raw =
    decision.actionIDs !== undefined && decision.actionIDs.length > 0
      ? decision.actionIDs
      : [decision.actionID];
  const deduplicated: string[] = [];
  for (const id of raw) {
    if (id.trim().length > 0 && !deduplicated.includes(id)) {
      deduplicated.push(id);
    }
  }
  return deduplicated;
}
