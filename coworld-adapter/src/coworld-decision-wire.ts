/**
 * Pure wire logic for the Coworld player protocol's decision exchange —
 * extracted from no-docker-coworld-episode.ts (whose top-level `await main()`
 * and runtime `ws` require make it un-importable by tests).
 *
 * Envelope (game -> player):
 *   { type: "decision_request", requestID, slot,
 *     protocol: { maxActionsPerDecision, maxSpawnPreferences }, request }
 * `protocol` is the capability advertisement for the OPTIONAL action batch
 * and the independent spawn-only preference ballot:
 * emitters must send `selectedLegalActionIds` ONLY when it is present, so a
 * new player against an old image degrades to primary-only instead of relying
 * on the old parser's tolerance. The inner `request` payload is untouched.
 *
 * Reply (player -> game):
 *   selectedLegalActionId  — REQUIRED scalar primary (unchanged contract)
 *   selectedLegalActionIds — OPTIONAL batch; normalized here to scalar-first,
 *     deduped, capped, each id trimmed and length-bounded
 *   spawnPreferenceLegalActionIds — OPTIONAL spawn-only ballot, forwarded as
 *     spawnPreferenceActionIDs with malformed/overflow evidence preserved for
 *     whole-ballot backend rejection
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
 * Mirror of AgentWireProtocol.MAX_SPAWN_PREFERENCE_ACTION_IDS. This is
 * deliberately independent from executable action batching.
 */
export const MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS = 16;

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
  /**
   * Untrusted wire shape carried verbatim enough for the backend's runtime
   * whole-ballot validator. It may deliberately be null or contain non-string
   * entries as bounded evidence of a malformed authored ballot.
   */
  spawnPreferenceActionIDs?: unknown;
  dealActionID?: string;
  reason: string;
}

export interface DecisionResponseNormalizationContext {
  /** True only when the pending request offered a non-empty all-spawn menu. */
  allSpawnMenu?: boolean;
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
    protocol: {
      maxActionsPerDecision: MAX_WIRE_ACTIONS_PER_DECISION,
      maxSpawnPreferences: MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS,
    },
    request: input.request,
  };
}

export function normalizeDecisionResponse(
  message: Record<string, unknown>,
  context: DecisionResponseNormalizationContext = {},
): NormalizedDecisionResponse {
  // Scalar cap included: previously unbounded, and it flows into the same
  // decisions.jsonl surfaces as the batch ids. A >200-char string can never
  // be a legal id, so this only bounds what a hostile/buggy seat can stamp.
  const actionID = String(message.selectedLegalActionId ?? "")
    .trim()
    .slice(0, MAX_WIRE_ACTION_ID_LENGTH);

  const executableBatchOnSpawnMenu =
    context.allSpawnMenu === true &&
    message.selectedLegalActionIds !== undefined;
  let actionIDs: string[] | undefined;
  if (
    !executableBatchOnSpawnMenu &&
    Array.isArray(message.selectedLegalActionIds)
  ) {
    const normalized: string[] = [];
    // Stops once the cap is held: an inbound frame may carry thousands of
    // agent-controlled ids, and every extra one would cost a full linear
    // `includes` scan. Ids past the cap can never survive it, so the early
    // exit changes no output.
    const push = (value: string): boolean => {
      const id = value.trim().slice(0, MAX_WIRE_ACTION_ID_LENGTH);
      if (id.length > 0 && !normalized.includes(id)) {
        normalized.push(id);
      }
      return normalized.length < MAX_WIRE_ACTIONS_PER_DECISION;
    };
    const hasRoom = actionID.length === 0 || push(actionID);
    if (hasRoom) {
      for (const entry of message.selectedLegalActionIds) {
        if (typeof entry === "string" && !push(entry)) {
          break;
        }
      }
    }
    const capped = normalized.slice(0, MAX_WIRE_ACTIONS_PER_DECISION);
    // A one-element batch IS the scalar: omit it so single-action replies
    // resolve byte-identically to a reply that never sent the key.
    actionIDs = capped.length >= 2 ? capped : undefined;
  }

  let spawnPreferenceActionIDs: unknown;
  if (executableBatchOnSpawnMenu) {
    // Executable batching has no meaning during the one-spawn allocation
    // ballot. Preserve an explicit invalid sentinel so backend validation
    // defaults the whole ballot; never silently reinterpret the response as a
    // valid scalar-only or ranked spawn reply.
    spawnPreferenceActionIDs = null;
  } else if (message.spawnPreferenceLegalActionIds !== undefined) {
    const raw = message.spawnPreferenceLegalActionIds;
    if (!Array.isArray(raw)) {
      // Presence matters: omitting this would silently reinterpret a malformed
      // explicit ballot as a valid legacy scalar-only reply. A bounded null
      // sentinel preserves the non-array shape for the backend's specific
      // whole-ballot rejection without retaining arbitrary agent data.
      spawnPreferenceActionIDs = null;
    } else {
      // Retain at most cap+1 entries: the extra entry proves overflow without
      // walking or retaining an unbounded agent-controlled array. Do not trim,
      // dedupe, prepend the scalar, or truncate overlong ids into potentially
      // valid offered ids; overlong strings become an empty sentinel while
      // bounded non-string types remain visible to backend validation.
      spawnPreferenceActionIDs = raw
        .slice(0, MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS + 1)
        .map((entry) =>
          typeof entry === "string" && entry.length > MAX_WIRE_ACTION_ID_LENGTH
            ? ""
            : entry,
        );
    }
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
    ...(spawnPreferenceActionIDs !== undefined
      ? { spawnPreferenceActionIDs }
      : {}),
    ...(dealActionID !== undefined ? { dealActionID } : {}),
    reason:
      typeof message.reason === "string"
        ? message.reason.slice(0, 500)
        : "Coworld player returned no reason.",
  };
}
