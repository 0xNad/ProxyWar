/**
 * Pure wire logic for the Coworld player protocol's decision exchange —
 * extracted from no-docker-coworld-episode.ts (whose top-level `await main()`
 * and runtime `ws` require make it un-importable by tests).
 *
 * Envelope (game -> player):
 *   { type: "decision_request", requestID, slot,
 *     protocol: { maxActionsPerDecision }, request }
 * `protocol` is the capability advertisement for the OPTIONAL action batch:
 * emitters must send `selectedLegalActionIds` ONLY when it is present, so a
 * new player against an old image degrades to primary-only instead of relying
 * on the old parser's tolerance. The inner `request` payload is untouched.
 *
 * Reply (player -> game):
 *   selectedLegalActionId  — REQUIRED scalar primary (unchanged contract)
 *   selectedLegalActionIds — OPTIONAL batch; normalized here to scalar-first,
 *     deduped, capped, each id trimmed and length-bounded
 *   selectedDealActionId   — deal side channel (unchanged)
 *
 * Bounds-only discipline: menu membership is deliberately NOT checked here.
 * The league runner's decision validator is the recording authority — dropping
 * ids at the adapter would hide rejections from batchRejectedActionIDs.
 */

/**
 * Mirror of src/server/agents/AgentWireProtocol.ts's
 * MAX_WIRE_ACTIONS_PER_DECISION. A literal, not an import: the deployed image
 * copies coworld-adapter to /app/integration with the engine at /app/proxywar,
 * so a static value-import from src/ would break at runtime. The parity test
 * beside this file pins the two constants to each other.
 */
export const MAX_WIRE_ACTIONS_PER_DECISION = 5;

/**
 * Per-id length bound, matching the existing selectedDealActionId discipline:
 * a real action id is ~60 chars, and every id here can land in
 * decisions.jsonl (batchActionIDs / batchRejectedActionIDs / validator
 * reasons) — unbounded agent-controlled text per decision is the long-episode
 * memory class the 0.1.19 work closed.
 */
export const MAX_WIRE_ACTION_ID_LENGTH = 200;

export interface NormalizedDecisionResponse {
  actionID: string;
  actionIDs?: string[];
  dealActionID?: string;
  reason: string;
}

export function decisionRequestEnvelope(input: {
  requestID: string;
  slot: number;
  request: unknown;
}): Record<string, unknown> {
  return {
    type: "decision_request",
    requestID: input.requestID,
    slot: input.slot,
    protocol: { maxActionsPerDecision: MAX_WIRE_ACTIONS_PER_DECISION },
    request: input.request,
  };
}

export function normalizeDecisionResponse(
  message: Record<string, unknown>,
): NormalizedDecisionResponse {
  // Scalar cap included: previously unbounded, and it flows into the same
  // decisions.jsonl surfaces as the batch ids. A >200-char string can never
  // be a legal id, so this only bounds what a hostile/buggy seat can stamp.
  const actionID = String(message.selectedLegalActionId ?? "")
    .trim()
    .slice(0, MAX_WIRE_ACTION_ID_LENGTH);

  let actionIDs: string[] | undefined;
  if (Array.isArray(message.selectedLegalActionIds)) {
    const normalized: string[] = [];
    const push = (value: string): void => {
      const id = value.trim().slice(0, MAX_WIRE_ACTION_ID_LENGTH);
      if (id.length > 0 && !normalized.includes(id)) {
        normalized.push(id);
      }
    };
    if (actionID.length > 0) {
      push(actionID);
    }
    for (const entry of message.selectedLegalActionIds) {
      if (typeof entry === "string") {
        push(entry);
      }
    }
    const capped = normalized.slice(0, MAX_WIRE_ACTIONS_PER_DECISION);
    // A one-element batch IS the scalar: omit it so single-action replies
    // resolve byte-identically to a reply that never sent the key.
    actionIDs = capped.length >= 2 ? capped : undefined;
  }

  // Optional second selection (the diplomacy slot). Forwarded only when the
  // player actually sent a non-empty string; the league runner's
  // AgentDecisionValidator is the sole authority on whether it is a legal
  // deal action id.
  const dealActionID =
    typeof message.selectedDealActionId === "string" &&
    message.selectedDealActionId.trim().length > 0
      ? message.selectedDealActionId.trim().slice(0, MAX_WIRE_ACTION_ID_LENGTH)
      : undefined;

  return {
    actionID,
    ...(actionIDs !== undefined ? { actionIDs } : {}),
    ...(dealActionID !== undefined ? { dealActionID } : {}),
    reason:
      typeof message.reason === "string"
        ? message.reason.slice(0, 500)
        : "Coworld player returned no reason.",
  };
}
