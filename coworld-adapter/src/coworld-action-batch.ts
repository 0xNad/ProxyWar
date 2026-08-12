export const COWORLD_MAX_ACTIONS_PER_DECISION = 5;

const MAX_ACTION_ID_LENGTH = 200;

export interface CoworldActionBatch {
  actionIDs: string[];
  wireIssue: string | null;
}

export const COWORLD_ACTION_BATCH_CONTRACT =
  "optional ordered array of 1-5 offered legalActions[].id values; first must equal selectedLegalActionId";

/** Adds the Coworld-only batch extension to the canonical external request. */
export function withCoworldActionBatchContract(request: unknown): unknown {
  if (request === null || typeof request !== "object") {
    return request;
  }
  const record = request as Record<string, unknown>;
  const responseContract =
    record.responseContract !== null &&
    typeof record.responseContract === "object"
      ? (record.responseContract as Record<string, unknown>)
      : {};
  return {
    ...record,
    responseContract: {
      ...responseContract,
      selectedLegalActionIds: COWORLD_ACTION_BATCH_CONTRACT,
    },
  };
}

/**
 * Parses the additive Coworld batch field while preserving the original
 * scalar selection as the canonical primary and safe compatibility fallback.
 * Offered-menu validation deliberately remains in AgentDecisionValidator.
 */
export function parseCoworldActionBatch(
  selectedLegalActionId: unknown,
  selectedLegalActionIds: unknown,
): CoworldActionBatch {
  const primary = String(selectedLegalActionId ?? "");
  if (selectedLegalActionIds === undefined) {
    return { actionIDs: [primary], wireIssue: null };
  }
  if (!Array.isArray(selectedLegalActionIds)) {
    return {
      actionIDs: [primary],
      wireIssue: "selectedLegalActionIds must be an array",
    };
  }
  if (
    selectedLegalActionIds.some(
      (id) => typeof id !== "string" || id.length === 0,
    )
  ) {
    return {
      actionIDs: [primary],
      wireIssue: "selectedLegalActionIds must contain only non-empty strings",
    };
  }
  if (
    selectedLegalActionIds.some(
      (id) => (id as string).length > MAX_ACTION_ID_LENGTH,
    )
  ) {
    return {
      actionIDs: [primary],
      wireIssue: `selectedLegalActionIds entries must be at most ${MAX_ACTION_ID_LENGTH} characters`,
    };
  }
  if (selectedLegalActionIds[0] !== primary) {
    return {
      actionIDs: [primary],
      wireIssue: "selectedLegalActionIds[0] must equal selectedLegalActionId",
    };
  }

  const actionIDs: string[] = [];
  for (const rawID of selectedLegalActionIds as string[]) {
    if (!actionIDs.includes(rawID)) {
      actionIDs.push(rawID);
    }
    if (actionIDs.length >= COWORLD_MAX_ACTIONS_PER_DECISION) {
      break;
    }
  }
  const cappedOrDeduplicated =
    actionIDs.length !== selectedLegalActionIds.length;
  return {
    actionIDs,
    wireIssue: cappedOrDeduplicated
      ? `selectedLegalActionIds was deduplicated and capped at ${COWORLD_MAX_ACTIONS_PER_DECISION}`
      : null,
  };
}
