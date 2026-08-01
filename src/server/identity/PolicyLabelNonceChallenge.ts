/**
 * Scaffolding for the nonce-in-policy-label ownership proof —
 * RUNBOOK.md §16.3's "Nonce in a submitted policy label — a HYPOTHESIS,
 * not a design yet" — and Season Zero activation prompt Phase 3's
 * "generate the one-time nonce + exact instructions at challenge_issued;
 * ... MUST NOT auto-verify until its two preconditions are verified true."
 *
 * What this module is safe to do today: mint a nonce and tell a claimant
 * exactly what to put in a policy label. That discloses nothing and
 * proves nothing by itself, so `PlatformBuilderClaimStore.issueChallenge`
 * calls straight through to it unconditionally.
 *
 * What this module refuses to do until explicitly re-enabled: treat a
 * mirror row whose policy label carries a matching nonce as PROOF that the
 * claimant controls that Coworld identity. RUNBOOK.md §16.3 names the
 * exact two preconditions, and is explicit that if either is false, "a
 * label match proves only that SOMEONE submitted a policy, not that the
 * claimant owns the agent":
 *
 *   (a) a policy label is free text CHOSEN BY THE SUBMITTING PLAYER
 *       (never assigned by Softmax, a template, or another party); and
 *   (b) the mirror's `playerName` <-> `policyLabel` pairing in
 *       `standings[]` is a genuine SUBMITTER BINDING — i.e. the row
 *       carrying a label really is the row of the player who submitted
 *       that exact policy — not merely a display join Softmax could
 *       re-key without that guarantee.
 *
 * Neither has been independently verified as of this module's
 * introduction (RUNBOOK.md §16.3, dated 2026-07-30). `isNonceAutoVerifyEnabled`
 * is the single gate every auto-verification caller MUST check —
 * `NonceObservationReconcile.ts` is the only intended caller, and it
 * no-ops entirely when this returns `false`. The env var defaults unset
 * (disabled) in every environment, including production; enabling it is a
 * product decision that requires the two preconditions above to be
 * re-verified, not a deploy toggle to flip experimentally.
 */
import { randomBytes } from "node:crypto";

export const NONCE_AUTO_VERIFY_GATE_ENV =
  "PROXYWAR_ENABLE_NONCE_AUTO_VERIFY" as const;

/** `pwn-` (ProxyWar Nonce) prefix keeps a nonce visually identifiable inside an arbitrary policy label and gives {@link extractNonceFromLabel} an unambiguous marker to search for. */
const NONCE_PREFIX = "pwn-";
const NONCE_HEX_LENGTH = 12;
const NONCE_PATTERN = new RegExp(`${NONCE_PREFIX}([a-f0-9]{${NONCE_HEX_LENGTH}})`);

export function generateChallengeNonce(): string {
  return `${NONCE_PREFIX}${randomBytes(NONCE_HEX_LENGTH / 2).toString("hex")}`;
}

/**
 * Human instructions shown at `challenge_issued` — the exact wording a
 * claimant would follow when submitting their NEXT policy version to
 * Softmax. Deliberately describes an action the claimant takes on their
 * own lineage; never asks for a token, password, or anything that could
 * itself become a phishable secret.
 */
export function buildNonceInstructions(
  nonce: string,
  agentDisplayName: string,
): string {
  return (
    `To prove you control ${agentDisplayName}'s Coworld policy lineage, ` +
    `include "${nonce}" anywhere in the label of your NEXT submitted policy ` +
    `version (for example "your-lineage-${nonce}:v<N>"). Proxy War's league ` +
    `mirror will look for this exact text once it observes your new version. ` +
    `This does not require sharing any password, token, or API key.`
  );
}

/** Finds a `pwn-<hex>` token anywhere in an observed policy label — `null` if none is present. Used only by the (gated) observation-matching path; never by claim submission itself. */
export function extractNonceFromLabel(policyLabel: string): string | null {
  const match = NONCE_PATTERN.exec(policyLabel);
  return match === null ? null : `${NONCE_PREFIX}${match[1]}`;
}

/** See this module's doc — the ONLY gate governing whether an observed nonce match is allowed to auto-verify a claim. Defaults `false` (unset) everywhere. */
export function isNonceAutoVerifyEnabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment[NONCE_AUTO_VERIFY_GATE_ENV] === "1";
}
