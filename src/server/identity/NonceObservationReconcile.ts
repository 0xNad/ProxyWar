/**
 * The observation side of the nonce-in-policy-label challenge —
 * `PolicyLabelNonceChallenge.ts`'s doc explains why this is inert by
 * default. This module is the ONLY intended caller of
 * `applySystemAutoVerify` (`PlatformBuilderClaimStore.ts`), and it checks
 * {@link isNonceAutoVerifyEnabled} before doing anything else: with the
 * gate off (the default, everywhere), {@link reconcileNonceObservations}
 * returns its input completely unchanged and `changed: false` — never
 * mutates a claim, never calls the store.
 *
 * A future mirror-sync pass (see `sync-version-registry.ts`) is the
 * intended real caller once the gate is ever turned on: it would collect
 * every currently-observed policy label from the league mirror and pass
 * them here alongside every claim sitting in `challenge_issued` or
 * `proof_pending` with a live `nonceChallenge`. Nothing in this codebase
 * wires that call today — flipping the gate on is a product decision that
 * requires RUNBOOK.md §16.3's two preconditions to be re-verified first,
 * not a wiring task.
 */
import type { BuilderClaimRecord } from "../platform/PlatformBuilderClaimStore";
import {
  extractNonceFromLabel,
  isNonceAutoVerifyEnabled,
} from "./PolicyLabelNonceChallenge";

export interface NonceObservationMatch {
  readonly claimId: string;
  readonly observedPolicyLabel: string;
}

export interface NonceObservationReconcileResult {
  readonly matches: readonly NonceObservationMatch[];
  readonly enabled: boolean;
}

/**
 * Pure matching: for every claim with a live `nonceChallenge`, find an
 * observed label that contains that claim's exact nonce. Runs the
 * matching logic UNCONDITIONALLY (so it stays exercised by tests and
 * verifiably correct) but reports `enabled: false` and an empty
 * `matches` list whenever the gate is off — callers MUST check `enabled`
 * before acting on `matches`, and {@link reconcileNonceObservations} below
 * is the only sanctioned way to actually apply a match, precisely so no
 * caller can accidentally skip that check.
 */
export function findNonceObservationMatches(
  claims: readonly BuilderClaimRecord[],
  observedPolicyLabels: readonly string[],
  environment: Record<string, string | undefined> = process.env,
): NonceObservationReconcileResult {
  const enabled = isNonceAutoVerifyEnabled(environment);
  const matches: NonceObservationMatch[] = [];
  for (const claim of claims) {
    if (claim.state !== "challenge_issued" && claim.state !== "proof_pending") {
      continue;
    }
    if (claim.nonceChallenge === null) continue;
    for (const label of observedPolicyLabels) {
      if (extractNonceFromLabel(label) === claim.nonceChallenge.nonce) {
        matches.push({ claimId: claim.id, observedPolicyLabel: label });
        break;
      }
    }
  }
  return { matches, enabled };
}

/**
 * The gated apply step: runs {@link findNonceObservationMatches}, and only
 * when `enabled` is true, walks every match through `applySystemAutoVerify`
 * (valid directly from both `challenge_issued` and `proof_pending` — see
 * `BuilderClaimStateMachine.ts`'s transition table). Returns the updated
 * store file and `changed: false` when the gate was off or nothing
 * matched, so a caller never needs to separately check `enabled`.
 */
export function reconcileNonceObservations<
  File extends { readonly claims: readonly BuilderClaimRecord[] },
>(
  file: File,
  observedPolicyLabels: readonly string[],
  now: Date,
  applySystemAutoVerify: (file: File, claimId: string, now: Date) => File,
  environment: Record<string, string | undefined> = process.env,
): { readonly file: File; readonly changed: boolean } {
  const { matches, enabled } = findNonceObservationMatches(
    file.claims,
    observedPolicyLabels,
    environment,
  );
  if (!enabled || matches.length === 0) {
    return { file, changed: false };
  }
  let next = file;
  for (const match of matches) {
    next = applySystemAutoVerify(next, match.claimId, now);
  }
  return { file: next, changed: true };
}
