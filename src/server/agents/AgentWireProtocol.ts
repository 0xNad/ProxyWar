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
 * belongs to the caller. It DOES stop collecting at `stopAt` (default cap+1),
 * which bounds the scan without changing any result the caller can observe.
 */
export function normalizeWireActionIds(
  primary: string,
  requested: readonly string[],
  stopAt: number = MAX_WIRE_ACTIONS_PER_DECISION + 1,
): string[] {
  const normalized: string[] = [];
  // Returns false once `stopAt` ids are held, so callers stop walking an
  // agent-controlled array. Default is cap+1: enough for a strict parser to
  // detect "more than the cap" while bounding the quadratic `includes` scan
  // (an inbound frame may carry thousands of ids). Ids past that point can
  // never survive the cap, so stopping early changes no output.
  const push = (value: string): boolean => {
    const id = value.trim();
    if (id.length > 0 && !normalized.includes(id)) {
      normalized.push(id);
    }
    return normalized.length < stopAt;
  };
  if (!push(primary)) {
    return normalized;
  }
  for (const id of requested) {
    if (!push(id)) {
      break;
    }
  }
  return normalized;
}

/**
 * Deduplicate then cap — the order the league runner uses
 * (`requestedDecisionActionIDs`), so a duplicated id never consumes batch
 * capacity. Shared so the sim rollout stages exactly the ids live play would
 * submit; capping before deduping would let a forecast execute a duplicate
 * intent the real match drops.
 */
export function dedupeAndCapActionIDs(
  ids: readonly string[],
  cap: number = MAX_WIRE_ACTIONS_PER_DECISION,
): string[] {
  const deduplicated: string[] = [];
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0 && !deduplicated.includes(id)) {
      deduplicated.push(id);
      if (deduplicated.length === cap) {
        break;
      }
    }
  }
  return deduplicated;
}

/**
 * Batch-layer round-robin: one element per list per layer, fixed list order
 * within every layer (A1,B1,…,A2,B2,…). This is the submission/staging order
 * for batched decisions everywhere — the league runner's driver and the sim
 * rollout's intent staging — so "earlier participant wins" holds within each
 * layer instead of one seat's whole batch preempting the next seat's first
 * action.
 */
export function interleaveLayers<T>(layers: readonly (readonly T[])[]): T[] {
  const interleaved: T[] = [];
  const maxLayer = layers.reduce((max, list) => Math.max(max, list.length), 0);
  for (let layer = 0; layer < maxLayer; layer += 1) {
    for (const list of layers) {
      if (layer < list.length) {
        interleaved.push(list[layer]);
      }
    }
  }
  return interleaved;
}
