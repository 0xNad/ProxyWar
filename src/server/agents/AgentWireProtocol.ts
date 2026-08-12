/**
 * Wire-level protocol bounds for external agent decisions.
 *
 * A `decision_response` may carry an optional `selectedLegalActionIds` batch
 * alongside the required scalar `selectedLegalActionId`. This module is the
 * single authority on the batch's shape so every parser and the runner agree:
 *
 * - The scalar is the authoritative PRIMARY and is normalized to element 0.
 * - Ids are deduplicated preserving order.
 * - At most MAX_WIRE_ACTIONS_PER_DECISION ids cross the wire, primary
 *   included.
 *
 * Deliberately NOT here: menu membership (the runner's decision validator is
 * the recording authority — see AgentDecisionValidator), and the in-process
 * planner/executor's own cascade bound (AgentPlannerExecutor's
 * MAX_ACTIONS_PER_DECISION clamp), which governs how many actions a HOUSE
 * brain schedules, not what the wire accepts.
 *
 * The Coworld adapter (coworld-adapter/src/coworld-decision-wire.ts) mirrors
 * MAX_WIRE_ACTIONS_PER_DECISION as a literal because the deployed image
 * cannot value-import from src/ at runtime; an adapter test pins the mirror
 * to this constant.
 */
export const MAX_WIRE_ACTIONS_PER_DECISION = 5;

/**
 * Normalize a wire batch: scalar-first, trimmed, empties dropped, deduped
 * preserving order. Does NOT cap — strict parsing rejects oversized batches
 * with a coaching error while robust parsing truncates, so the cap decision
 * belongs to the caller.
 */
export function normalizeWireActionIds(
  primary: string,
  requested: readonly string[],
): string[] {
  const normalized: string[] = [];
  const push = (value: string): void => {
    const id = value.trim();
    if (id.length > 0 && !normalized.includes(id)) {
      normalized.push(id);
    }
  };
  push(primary);
  for (const id of requested) {
    push(id);
  }
  return normalized;
}
