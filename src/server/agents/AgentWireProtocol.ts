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
 * MAX_WIRE_ACTIONS_PER_DECISION and AGENT_DEGRADATION_CAUSES as literals because the deployed image
 * cannot value-import from src/ at runtime; an adapter test pins both mirrors
 * to these constants.
 */
export const MAX_WIRE_ACTIONS_PER_DECISION = 5;
/**
 * The bounded vocabulary for WHY a decision was degraded, carried as the
 * OPTIONAL `degradedCause` field on `decision_response`.
 *
 * Why it exists: `llmPlannerDegraded` is a boolean, so the league's largest live
 * number - about a third of all decisions - is unattributable. The cause is known
 * at the moment of failure and then discarded. League seats are `external-http`,
 * which `AgentLeagueMatch`'s LLM_DEGRADABLE_BRAIN_TYPES deliberately excludes, so
 * the degraded flag on a league decision is ALWAYS the policy's own word - and
 * therefore so is the only cause that can explain it.
 *
 * Two families in one vocabulary:
 *
 * - `plan-*` are SELF-REPORTED. Only the deciding policy knows whether its
 *   planner was still warming up or had actually failed, and that is the entire
 *   ambiguity: today a seat playing rule logic during its first plan is
 *   indistinguishable, in every artifact, from a seat whose brain is dead.
 * - `brain-*` are SERVER-OBSERVED (we timed the seat out, or its brain threw).
 *   These reuse the exact words the spawn-ballot path already uses for the same
 *   three facts (`forcedDefaultReason`: brain-timeout / brain-error), because a
 *   second vocabulary for one concept is worse than none.
 *
 * Bounds, not manners: a broken or hostile policy can send anything, so
 * `asAgentDegradationCause` is a strict equality parse - no trimming, no case
 * folding, no prefix matching. An almost-right value is not evidence.
 */
export const AGENT_DEGRADATION_CAUSES = [
  /** Self-reported: no plan yet, first refresh still in flight. Benign. */
  "plan-warmup",
  /** Self-reported: a plan exists but the latest refresh failed; acting on stale intent. */
  "plan-stale",
  /** Self-reported: no plan at all and the refresh failed. The dead-brain shape. */
  "plan-unavailable",
  /** Self-reported: the planner's provider call exceeded the policy's own budget. */
  "plan-timeout",
  /** Self-reported: the planner answered, but its output could not be parsed. */
  "plan-parse",
  /**
   * Self-reported: the policy's own code failed before it could decide - a
   * reconstruction error, a transport failure to its provider, an unexpected
   * exception. Deliberately vague about WHICH: the catch that reports it does not
   * establish more than "our side threw", and a narrower label would be invented.
   */
  "policy-error",
  /** Server-observed: no decision arrived within the decision budget. */
  "brain-timeout",
  /** Server-observed: the brain threw, or returned something that was not a decision. */
  "brain-error",
] as const;

export type AgentDegradationCause = (typeof AGENT_DEGRADATION_CAUSES)[number];

const DEGRADATION_CAUSE_LOOKUP: ReadonlySet<string> = new Set(
  AGENT_DEGRADATION_CAUSES,
);

/**
 * Parses an untrusted value into a cause, or `undefined`.
 *
 * `undefined` is the honest answer for anything unrecognized: the degradation
 * boolean still stands by itself and we simply do not know why. There is
 * deliberately no catch-all bucket - inventing a value in the one field whose
 * purpose is attribution would defeat the field.
 */
export function asAgentDegradationCause(
  value: unknown,
): AgentDegradationCause | undefined {
  return typeof value === "string" && DEGRADATION_CAUSE_LOOKUP.has(value)
    ? (value as AgentDegradationCause)
    : undefined;
}

/**
 * The causes only the deciding policy can know first-hand.
 *
 * An EXPLICIT set, not a name prefix. Trust is the one thing in this module that
 * must not depend on spelling: the first version tested `startsWith("plan-")`, and
 * the moment a truthful non-`plan` self-reported cause was needed
 * (`policy-error`), a prefix rule would have silently classified it as a server
 * observation and let a policy forge server evidence.
 */
const SELF_REPORTED_CAUSES: ReadonlySet<AgentDegradationCause> = new Set([
  "plan-warmup",
  "plan-stale",
  "plan-unavailable",
  "plan-timeout",
  "plan-parse",
  "policy-error",
]);

/** True for the causes only the deciding policy can know first-hand. */
export function isSelfReportedDegradationCause(
  cause: AgentDegradationCause,
): boolean {
  return SELF_REPORTED_CAUSES.has(cause);
}

/**
 * Parses a cause arriving from an UNTRUSTED player frame.
 *
 * `brain-timeout` and `brain-error` are the server's OWN observations - we timed
 * the seat out, or its brain threw. A policy able to send those would be forging
 * provenance in an evidence field: a seat that answered perfectly well could stamp
 * its record `brain-timeout` and the artifact would read as though the server had
 * failed to hear from it. Only `SELF_REPORTED_CAUSES` cross this boundary; the
 * server-observed pair is stamped exclusively by `AgentLeagueMatch`.
 */
export function asPlayerReportedDegradationCause(
  value: unknown,
): AgentDegradationCause | undefined {
  const cause = asAgentDegradationCause(value);
  return cause !== undefined && isSelfReportedDegradationCause(cause)
    ? cause
    : undefined;
}

/**
 * Independent cap for the spawn-only ranked ballot. These ids describe
 * preferences for ONE eventual spawn assignment; they are never executable
 * action batching and must not share MAX_WIRE_ACTIONS_PER_DECISION's width.
 */
export const MAX_SPAWN_PREFERENCE_ACTION_IDS = 16;

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
