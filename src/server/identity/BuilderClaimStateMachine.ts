/**
 * The claim state machine for Phase 3's "activate Builder/Agent/Version
 * identity with a REAL claim workflow" — Season Zero activation prompt,
 * "Secure claim workflow" section, and RUNBOOK.md §16.3's ownership-
 * verification analysis.
 *
 * Deliberately a PURE, framework-free module: no filesystem, no HTTP, no
 * Zod I/O. {@link PlatformBuilderClaimStore} is the only caller that
 * persists a {@link BuilderClaimRecord}; this module only knows how one
 * legally moves between states and how that move gets appended to an
 * append-only audit trail. Kept separate so the transition table itself —
 * the actual safety property RUNBOOK.md §16.3 cares about — is trivially
 * unit-testable without a temp directory or a file lock.
 *
 * States, in the exact order the activation prompt specifies:
 * draft -> challenge_issued -> proof_pending -> verified | rejected | revoked.
 *
 * Two verification PATHS share this one state machine (activation prompt,
 * "If Softmax exposes no safe programmatic proof, implement an
 * operator-mediated approval queue" — which RUNBOOK.md §16.3 confirms is
 * exactly today's situation: no GitHub join, no sanctioned Softmax sign-in
 * send record yet):
 *
 * - The REAL path for Season Zero: operator-mediated review. A claimant
 *   submits (`draft`), evidence accumulates, and an operator explicitly
 *   `approve`s (`proof_pending` -> `verified`) or `reject`s. This path
 *   never depends on `challenge_issued`/the nonce below at all — an
 *   operator may move a claim straight from `draft` to `proof_pending`
 *   once they consider the submitted evidence sufficient to review.
 * - The SCAFFOLDED nonce-in-policy-label path (`draft` -> `challenge_issued`
 *   -> `proof_pending`): issuing a nonce and instructions is safe to expose
 *   today (it discloses nothing and proves nothing by itself). What must
 *   NEVER happen automatically is the `proof_pending` -> `verified` step
 *   firing off a mirror-observed label match — see
 *   `PolicyLabelNonceChallenge.ts`'s `isNonceAutoVerifyEnabled` gate,
 *   which defaults off and stays off until both of RUNBOOK.md §16.3's
 *   preconditions are independently verified true. Until then, EVERY
 *   `verified` transition in this codebase is `approve`, run by a human
 *   operator via the `identity:claims` CLI.
 *
 * `rejected` and `revoked` are both terminal: neither has an outgoing
 * transition. A claimant who wants to try again submits a brand-new claim
 * (a fresh `id`) rather than resurrecting an old one — the audit trail on
 * a rejected/revoked claim must never be mutated again, "immutable audit
 * record" being one of the activation prompt's explicit requirements.
 */

export const BUILDER_CLAIM_STATES = [
  "draft",
  "challenge_issued",
  "proof_pending",
  "verified",
  "rejected",
  "revoked",
] as const;
export type BuilderClaimState = (typeof BUILDER_CLAIM_STATES)[number];

export const BUILDER_CLAIM_ACTIONS = [
  "submit",
  "issue_challenge",
  "mark_proof_pending",
  "approve",
  "reject",
  "revoke",
  "withdraw",
  "auto_verify_from_observation",
] as const;
export type BuilderClaimAction = (typeof BUILDER_CLAIM_ACTIONS)[number];

export type BuilderClaimActorKind = "claimant" | "operator" | "system";

/**
 * `id` is the platform `accountId` for `"claimant"`, an operator-supplied
 * free-text handle (e.g. an operator's name, or the CLI invocation) for
 * `"operator"`, and a fixed constant identifying the reconciliation job
 * for `"system"` — see `NonceObservationReconcile.ts`.
 */
export interface BuilderClaimActor {
  readonly kind: BuilderClaimActorKind;
  readonly id: string;
}

/** One append-only audit row. Never edited or removed once written — see this module's doc. */
export interface BuilderClaimAuditEntry {
  readonly at: string;
  readonly actor: BuilderClaimActor;
  readonly action: BuilderClaimAction;
  /** `null` only for the `"submit"` row that creates the claim — every other row has a real prior state. */
  readonly fromState: BuilderClaimState | null;
  readonly toState: BuilderClaimState;
  readonly note: string | null;
}

export class InvalidClaimTransitionError extends Error {
  constructor(
    public readonly fromState: BuilderClaimState,
    public readonly action: BuilderClaimAction,
  ) {
    super(
      `invalid_claim_transition: cannot apply "${action}" from state "${fromState}"`,
    );
    this.name = "InvalidClaimTransitionError";
  }
}

/**
 * The full legal transition table. `submit` is deliberately absent — it is
 * how a {@link BuilderClaimRecord} is CREATED (see the store's `submitClaim`),
 * never a transition applied to an existing record, so it has no "from"
 * row here.
 *
 * `auto_verify_from_observation` is listed as a real edge from
 * `proof_pending` so the transition table itself documents that the wire
 * exists — {@link isNonceAutoVerifyEnabled} in `PolicyLabelNonceChallenge.ts`
 * is what keeps any caller from actually invoking it today. This module
 * has no opinion on the gate; it only refuses an illegal STATE move.
 */
const TRANSITIONS: Readonly<
  Record<BuilderClaimState, Readonly<Partial<Record<BuilderClaimAction, BuilderClaimState>>>>
> = {
  draft: {
    issue_challenge: "challenge_issued",
    mark_proof_pending: "proof_pending",
    reject: "rejected",
    withdraw: "rejected",
  },
  challenge_issued: {
    mark_proof_pending: "proof_pending",
    // A nonce observation match is itself sufficient proof once the gate
    // is on (see `PolicyLabelNonceChallenge.ts`) — it does not require the
    // claimant to have separately clicked "mark proof pending" first, so
    // `NonceObservationReconcile.ts` can apply this straight from
    // `challenge_issued`, not only from `proof_pending`.
    auto_verify_from_observation: "verified",
    reject: "rejected",
    withdraw: "rejected",
  },
  proof_pending: {
    approve: "verified",
    auto_verify_from_observation: "verified",
    reject: "rejected",
    withdraw: "rejected",
  },
  verified: {
    revoke: "revoked",
  },
  rejected: {},
  revoked: {},
};

/** Throws {@link InvalidClaimTransitionError} rather than returning `null` — an operator CLI or HTTP route bug (attempting a nonsensical transition) must fail loudly, matching `mutateFeaturedMatchStore`'s "throws, never swallows" discipline. */
export function applyClaimTransition(
  fromState: BuilderClaimState,
  action: BuilderClaimAction,
): BuilderClaimState {
  const next = TRANSITIONS[fromState][action];
  if (next === undefined) {
    throw new InvalidClaimTransitionError(fromState, action);
  }
  return next;
}

/** `true` iff `action` has a legal edge out of `fromState` — for callers (HTTP routes) that want to report a 409 instead of catching an exception. */
export function isClaimTransitionAllowed(
  fromState: BuilderClaimState,
  action: BuilderClaimAction,
): boolean {
  return TRANSITIONS[fromState][action] !== undefined;
}

export function buildAuditEntry(
  fromState: BuilderClaimState | null,
  toState: BuilderClaimState,
  action: BuilderClaimAction,
  actor: BuilderClaimActor,
  note: string | null,
  now: Date,
): BuilderClaimAuditEntry {
  return { at: now.toISOString(), actor, action, fromState, toState, note };
}

/** A claim is in a terminal state once rejected or revoked — see this module's doc for why neither ever transitions again. */
export function isClaimTerminal(state: BuilderClaimState): boolean {
  return state === "rejected" || state === "revoked";
}
