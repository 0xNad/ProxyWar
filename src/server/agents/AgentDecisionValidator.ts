import { isDealActionKind } from "./AgentDealManager";
import { AgentDecision, LegalAction } from "./AgentTypes";

export type AgentDecisionValidation =
  | { ok: true; action: LegalAction }
  | { ok: false; reason: string; fallback: LegalAction | null };

export type AgentDealDecisionValidation =
  | { ok: true; action: LegalAction }
  | { ok: false; reason: string };

/**
 * Validates the OPTIONAL second selection, `AgentDecision.dealActionID` (the
 * diplomacy slot). Returns null when the field is absent/blank — the shipped
 * single-action path is then completely untouched.
 *
 * Two gates, both mandatory:
 * 1. exact-id match against the SAME offered menu as `actionID` (no off-menu
 *    ids, exactly like every other selection);
 * 2. the action's kind must be one of the four deal meta-action kinds.
 *
 * Gate 2 is the raw-intent-bypass boundary: without it a policy could name an
 * attack/nuke/build id here and get a second game action per decision. There
 * is NO fallback — an invalid deal selection is reported and dropped, never
 * substituted, so a rejected deal selection can never change what reaches the
 * game.
 */
export function validateAgentDealDecision(
  decision: AgentDecision,
  legalActions: LegalAction[],
): AgentDealDecisionValidation | null {
  if (typeof decision.dealActionID !== "string") {
    return null;
  }
  // Trim ONCE and use the trimmed value for the lookup too — the websocket
  // adapter and the response parser both trim before this point, so the
  // untrimmed value was only ever reachable in-process.
  const requestedID = decision.dealActionID.trim();
  if (requestedID.length === 0) {
    return null;
  }
  const action = legalActions.find((candidate) => candidate.id === requestedID);
  if (action === undefined) {
    return {
      ok: false,
      reason: `deal selection named unknown action id: ${loggableActionID(requestedID)}`,
    };
  }
  if (!isDealActionKind(action.kind)) {
    return {
      ok: false,
      reason: `deal selection named a non-deal action kind (${action.kind}): ${loggableActionID(requestedID)}`,
    };
  }
  return { ok: true, action };
}

/**
 * The rejection reason is stamped into decisions.jsonl by the league runner,
 * so the agent-controlled id it quotes is bounded here (the lookup above
 * still uses the full id, so a long-but-legal id can never be mismatched).
 */
const MAX_QUOTED_DEAL_ACTION_ID = 120;

function loggableActionID(requestedID: string): string {
  return requestedID.length <= MAX_QUOTED_DEAL_ACTION_ID
    ? requestedID
    : `${requestedID.slice(0, MAX_QUOTED_DEAL_ACTION_ID)}... (${requestedID.length} chars)`;
}

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
