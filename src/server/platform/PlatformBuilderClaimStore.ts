/**
 * Durable store for REAL Builder/Agent ownership claims — Season Zero
 * activation prompt Phase 3's "Secure claim workflow", distinct from
 * `PlatformPolicyClaimStore`'s self-asserted, never-surfaced-publicly
 * lineage picks (see that module's doc: "NOT an identity link ... there
 * is no cryptographic or platform-verified proof").
 *
 * A record here is the thing that eventually sets `AgentProfile.builderId`
 * and `BuilderProfile.verifiedGithub` in the TRACKED identity registry —
 * see `identity-claims.ts`'s `approve` action. That is exactly why this
 * store needs a stronger concurrency contract than `PlatformAccountStore`/
 * `PlatformPolicyClaimStore` (an in-process write queue only): those two
 * are mutated ONLY by the running HTTP server, but this one is also
 * mutated by an operator running `identity:claims approve/reject/revoke`
 * as a SEPARATE OS process while the server keeps accepting claimant
 * submissions. That is the identical "premiere:schedule CLI, separate OS
 * processes, NOT covered by any in-process mutex" situation
 * `FeaturedMatch.ts` documents — so this store copies its exact shape:
 * free functions (not a class holding an in-memory queue), one JSON file,
 * one cross-process `FileMutex` lock (keyed on this store's OWN state
 * root, never shared with `FeaturedMatch`'s or any other store's lock so
 * an unrelated store's hold can never block a claim review) held for the
 * full read -> mutate -> write cycle via {@link mutateBuilderClaimStore}.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { withFileMutex } from "../agents/FileMutex";
import {
  applyClaimTransition,
  buildAuditEntry,
  BUILDER_CLAIM_ACTIONS,
  BUILDER_CLAIM_STATES,
  type BuilderClaimAction,
  type BuilderClaimActor,
  type BuilderClaimState,
  isClaimTerminal,
} from "../identity/BuilderClaimStateMachine";
import {
  buildNonceInstructions,
  generateChallengeNonce,
} from "../identity/PolicyLabelNonceChallenge";
import { resolvePlatformPrivateStateRoot } from "./PlatformSecrets";

export const BUILDER_CLAIM_STATE_ROOT_ENV =
  "PROXYWAR_BUILDER_CLAIM_STATE_ROOT" as const;
const STORE_FILE_NAME = "builder-claims.json";
const MAX_FREE_TEXT_CODEPOINTS = 2_000;
const MAX_PLAYER_NAME_CODEPOINTS = 120;
const MAX_LINKS = 10;
const MAX_TEAM_MEMBERS = 20;

/** Same override-with-safe-default shape as `resolveFeaturedMatchStateRoot`/`resolvePlatformPrivateStateRoot` — nested one directory below the platform's own private root, in its own subdirectory so its `FileMutex` lock file never collides with a sibling store's. */
export function resolveBuilderClaimStateRoot(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configured = environment[BUILDER_CLAIM_STATE_ROOT_ENV]?.trim();
  if (configured !== undefined && configured !== "") {
    return path.resolve(configured);
  }
  return path.join(
    resolvePlatformPrivateStateRoot(environment, homeDirectory),
    "builder-claims",
  );
}

export const defaultBuilderClaimStateRoot = resolveBuilderClaimStateRoot();

const builderClaimActorSchema = z
  .object({
    kind: z.enum(["claimant", "operator", "system"]),
    id: z.string().min(1).max(256),
  })
  .strict();

const builderClaimAuditEntrySchema = z
  .object({
    at: z.string(),
    actor: builderClaimActorSchema,
    action: z.enum(BUILDER_CLAIM_ACTIONS),
    fromState: z.enum(BUILDER_CLAIM_STATES).nullable(),
    toState: z.enum(BUILDER_CLAIM_STATES),
    note: z.string().max(MAX_FREE_TEXT_CODEPOINTS).nullable(),
  })
  .strict();

const builderClaimEvidenceEntrySchema = z
  .object({
    note: z.string().max(MAX_FREE_TEXT_CODEPOINTS),
    links: z.array(z.string().url()).max(MAX_LINKS),
    submittedAt: z.string(),
  })
  .strict();

const builderClaimNonceChallengeSchema = z
  .object({
    nonce: z.string().min(1).max(64),
    instructions: z.string().min(1).max(MAX_FREE_TEXT_CODEPOINTS),
    issuedAt: z.string(),
  })
  .strict();

const builderProfileDraftSchema = z
  .object({
    displayName: z.string().min(1).max(80),
    shortBio: z.string().max(280).nullable(),
    links: z.array(z.string().url()).max(MAX_LINKS),
    teamMembers: z.array(z.string().min(1).max(80)).max(MAX_TEAM_MEMBERS),
  })
  .strict();

const builderClaimRecordSchema = z
  .object({
    id: z.string().regex(/^clm_[a-f0-9]{24}$/),
    accountId: z.string().regex(/^acct_[a-f0-9]{32}$/),
    /** Captured at submission time from `PlatformGithubIdentityLinkStore.getStatus` — see the store's `submitClaim` doc for why a claim requires GitHub sign-in. Never re-derived later: a claim record is a snapshot of what was true when submitted. */
    githubLogin: z.string().min(1),
    agentId: z.string().regex(/^agt_[a-z0-9-]+$/),
    /** Self-asserted, free text, NEVER auto-matched against anything — see `IdentityMatching.ts`'s and RUNBOOK.md §16.3's shared invariant. */
    claimedCoworldPlayerName: z.string().min(1).max(MAX_PLAYER_NAME_CODEPOINTS),
    builderProfileDraft: builderProfileDraftSchema,
    evidence: z.array(builderClaimEvidenceEntrySchema).max(50),
    state: z.enum(BUILDER_CLAIM_STATES),
    nonceChallenge: builderClaimNonceChallengeSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    audit: z.array(builderClaimAuditEntrySchema).min(1),
  })
  .strict();
export type BuilderClaimRecord = z.infer<typeof builderClaimRecordSchema>;

const builderClaimStoreFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    claims: z.array(builderClaimRecordSchema),
  })
  .strict();
export type BuilderClaimStoreFile = z.infer<typeof builderClaimStoreFileSchema>;

export function newBuilderClaimId(): string {
  return `clm_${randomBytes(12).toString("hex")}`;
}

/** Same discipline as `PlatformPolicyClaimStore`'s `sanitizeLabel`: collapse whitespace, drop invisible control/format characters, trim, cap length. `null` means "blank — reject the submission". */
function sanitizeFreeText(raw: string, maxCodepoints: number): string | null {
  const collapsed = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length === 0) return null;
  const codepoints = Array.from(collapsed);
  return codepoints.length > maxCodepoints
    ? codepoints.slice(0, maxCodepoints).join("")
    : collapsed;
}

function sanitizeLinks(raw: readonly string[]): string[] {
  const cleaned: string[] = [];
  for (const candidate of raw.slice(0, MAX_LINKS)) {
    const trimmed = candidate.trim();
    if (trimmed === "") continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol === "http:" || url.protocol === "https:") {
        cleaned.push(url.toString());
      }
    } catch {
      // Not a valid absolute URL — dropped rather than stored malformed.
    }
  }
  return cleaned;
}

/** Input for a brand-new claim submission — see `submitClaim`'s doc for the authenticated-GitHub-account requirement this deliberately cannot bypass (the caller passes `githubLogin`, never derives it from anything client-supplied). */
export interface BuilderClaimSubmission {
  readonly accountId: string;
  readonly githubLogin: string;
  readonly agentId: string;
  readonly claimedCoworldPlayerName: string;
  readonly builderDisplayName: string;
  readonly builderShortBio: string | null;
  readonly builderLinks: readonly string[];
  readonly teamMembers: readonly string[];
  readonly evidenceNote: string;
  readonly evidenceLinks: readonly string[];
}

export class BuilderClaimValidationError extends Error {
  constructor(public readonly field: string) {
    super(`builder_claim_invalid_field: ${field}`);
    this.name = "BuilderClaimValidationError";
  }
}

export class BuilderClaimNotFoundError extends Error {
  constructor(public readonly claimId: string) {
    super(`builder_claim_not_found: ${claimId}`);
    this.name = "BuilderClaimNotFoundError";
  }
}

export class BuilderClaimOwnershipError extends Error {
  constructor(public readonly claimId: string) {
    super(`builder_claim_ownership_mismatch: ${claimId}`);
    this.name = "BuilderClaimOwnershipError";
  }
}

// ---------------------------------------------------------------------
// Storage — identical atomic-write shape to `FeaturedMatch.ts`'s own
// `writeFileAtomic` (kept local here too, same reasoning: three lines,
// not worth extracting a shared util for).
// ---------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function writeFileAtomic(
  destinationPath: string,
  contents: string,
): Promise<void> {
  const temporaryPath = `${destinationPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, destinationPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Never throws on a cold start (returns an empty, schema-valid store); throws on a corrupt file — a bad store is a loud failure, never a silent reset. */
export async function readBuilderClaimStore(
  stateRoot: string,
): Promise<BuilderClaimStoreFile> {
  const filePath = path.join(stateRoot, STORE_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { schemaVersion: 1, claims: [] };
    }
    throw error;
  }
  return builderClaimStoreFileSchema.parse(JSON.parse(raw));
}

async function writeBuilderClaimStoreUnlocked(
  stateRoot: string,
  file: BuilderClaimStoreFile,
): Promise<void> {
  const validated = builderClaimStoreFileSchema.parse(file);
  await fs.mkdir(stateRoot, { recursive: true });
  await writeFileAtomic(
    path.join(stateRoot, STORE_FILE_NAME),
    `${JSON.stringify(validated, null, 2)}\n`,
  );
}

/**
 * The canonical read-modify-write primitive — see this module's doc for
 * why every mutation (server routes AND the `identity:claims` CLI) MUST
 * go through this function rather than a separate read followed by a
 * separate write. Throws if `mutate` returns a store that fails schema
 * validation.
 */
export async function mutateBuilderClaimStore(
  stateRoot: string,
  mutate: (file: BuilderClaimStoreFile) => BuilderClaimStoreFile,
): Promise<BuilderClaimStoreFile> {
  return withFileMutex(stateRoot, async () => {
    const current = await readBuilderClaimStore(stateRoot);
    const next = mutate(current);
    await writeBuilderClaimStoreUnlocked(stateRoot, next);
    return next;
  });
}

// ---------------------------------------------------------------------
// Query helpers — pure, operate on an already-loaded store file. Kept
// free-standing (not store methods) so both HTTP routes and CLIs share
// one implementation without instantiating anything.
// ---------------------------------------------------------------------

export function findClaimsByAccount(
  file: BuilderClaimStoreFile,
  accountId: string,
): readonly BuilderClaimRecord[] {
  return file.claims.filter((claim) => claim.accountId === accountId);
}

export function findClaimById(
  file: BuilderClaimStoreFile,
  claimId: string,
): BuilderClaimRecord | null {
  return file.claims.find((claim) => claim.id === claimId) ?? null;
}

/** The verified claim (if any) that currently owns `agentId` — at most one should ever exist at a time by construction (`identity:claims approve` is the only writer of `verified`, and always checks this first), but this returns the FIRST match rather than asserting uniqueness so a data anomaly surfaces as an operator-visible list, never a thrown exception mid-request. */
export function findVerifiedClaimForAgent(
  file: BuilderClaimStoreFile,
  agentId: string,
): BuilderClaimRecord | null {
  return (
    file.claims.find(
      (claim) => claim.agentId === agentId && claim.state === "verified",
    ) ?? null
  );
}

/** Every `accountId` with at least one `verified` claim — the authorization set for "is this platform account a verified Builder at all" (self-service edits, the dashboard, and version-release creation all gate on membership here first, then narrow to which specific agent/builder). */
export function findVerifiedBuilderAccountIds(
  file: BuilderClaimStoreFile,
): ReadonlySet<string> {
  return new Set(
    file.claims
      .filter((claim) => claim.state === "verified")
      .map((claim) => claim.accountId),
  );
}

// ---------------------------------------------------------------------
// Mutations — each one applies exactly one state-machine transition (or
// creates the initial `draft`) and appends exactly one audit row. None of
// these touch the filesystem directly; callers wrap them in
// `mutateBuilderClaimStore`.
// ---------------------------------------------------------------------

/**
 * Creates a brand-new `draft` claim. Requires `githubLogin` from the
 * CALLER (an HTTP route that has already checked
 * `PlatformGithubIdentityLinkStore.getStatus(accountId).signedIn`) —
 * this function does not and cannot verify GitHub sign-in itself, exactly
 * the same division of duty `PlatformAccountHttp.ts` routes keep between
 * `PlatformAccountSecurity` (who is this request) and the store (what do
 * we do once we know).
 *
 * One agent may accumulate multiple non-terminal claims from DIFFERENT
 * accounts (two people can each believe they built the same agent — the
 * operator resolves that at review time, this store does not pre-empt
 * it), but never auto-approves; only `identity:claims approve` ever
 * writes `verified`.
 */
export function submitClaim(
  file: BuilderClaimStoreFile,
  submission: BuilderClaimSubmission,
  now: Date,
): BuilderClaimStoreFile {
  const displayName = sanitizeFreeText(submission.builderDisplayName, 80);
  const playerName = sanitizeFreeText(
    submission.claimedCoworldPlayerName,
    MAX_PLAYER_NAME_CODEPOINTS,
  );
  const evidenceNote = sanitizeFreeText(
    submission.evidenceNote,
    MAX_FREE_TEXT_CODEPOINTS,
  );
  if (displayName === null) throw new BuilderClaimValidationError("builderDisplayName");
  if (playerName === null) throw new BuilderClaimValidationError("claimedCoworldPlayerName");
  if (evidenceNote === null) throw new BuilderClaimValidationError("evidenceNote");
  const shortBio =
    submission.builderShortBio === null
      ? null
      : sanitizeFreeText(submission.builderShortBio, 280);
  const record: BuilderClaimRecord = {
    id: newBuilderClaimId(),
    accountId: submission.accountId,
    githubLogin: submission.githubLogin,
    agentId: submission.agentId,
    claimedCoworldPlayerName: playerName,
    builderProfileDraft: {
      displayName,
      shortBio,
      links: sanitizeLinks(submission.builderLinks),
      teamMembers: submission.teamMembers
        .map((member) => sanitizeFreeText(member, 80))
        .filter((member): member is string => member !== null)
        .slice(0, MAX_TEAM_MEMBERS),
    },
    evidence: [
      {
        note: evidenceNote,
        links: sanitizeLinks(submission.evidenceLinks),
        submittedAt: now.toISOString(),
      },
    ],
    state: "draft",
    nonceChallenge: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    audit: [
      buildAuditEntry(
        null,
        "draft",
        "submit",
        { kind: "claimant", id: submission.accountId },
        null,
        now,
      ),
    ],
  };
  return { ...file, claims: [...file.claims, record] };
}

function requireOwnedClaim(
  file: BuilderClaimStoreFile,
  claimId: string,
  accountId: string,
): BuilderClaimRecord {
  const claim = findClaimById(file, claimId);
  if (claim === null) throw new BuilderClaimNotFoundError(claimId);
  if (claim.accountId !== accountId) throw new BuilderClaimOwnershipError(claimId);
  return claim;
}

function replaceClaim(
  file: BuilderClaimStoreFile,
  updated: BuilderClaimRecord,
): BuilderClaimStoreFile {
  return {
    ...file,
    claims: file.claims.map((claim) => (claim.id === updated.id ? updated : claim)),
  };
}

function withTransition(
  claim: BuilderClaimRecord,
  action: BuilderClaimAction,
  actor: BuilderClaimActor,
  note: string | null,
  now: Date,
): BuilderClaimRecord {
  if (isClaimTerminal(claim.state)) {
    throw new InvalidClaimOnTerminalClaimError(claim.id, claim.state, action);
  }
  const toState = applyClaimTransition(claim.state, action);
  return {
    ...claim,
    state: toState,
    updatedAt: now.toISOString(),
    audit: [
      ...claim.audit,
      buildAuditEntry(claim.state, toState, action, actor, note, now),
    ],
  };
}

export class InvalidClaimOnTerminalClaimError extends Error {
  constructor(
    public readonly claimId: string,
    public readonly state: BuilderClaimState,
    public readonly action: BuilderClaimAction,
  ) {
    super(
      `builder_claim_terminal: cannot apply "${action}" to claim ${claimId} already in terminal state "${state}"`,
    );
    this.name = "InvalidClaimOnTerminalClaimError";
  }
}

/** Claimant-triggered: `draft` -> `challenge_issued`, minting a fresh nonce + instructions — see `PolicyLabelNonceChallenge.ts` for why this step is safe to expose even while auto-verification stays gated off. */
export function issueChallenge(
  file: BuilderClaimStoreFile,
  claimId: string,
  accountId: string,
  agentDisplayName: string,
  now: Date,
): BuilderClaimStoreFile {
  const claim = requireOwnedClaim(file, claimId, accountId);
  const nonce = generateChallengeNonce();
  const transitioned = withTransition(
    claim,
    "issue_challenge",
    { kind: "claimant", id: accountId },
    null,
    now,
  );
  const updated: BuilderClaimRecord = {
    ...transitioned,
    nonceChallenge: {
      nonce,
      instructions: buildNonceInstructions(nonce, agentDisplayName),
      issuedAt: now.toISOString(),
    },
  };
  return replaceClaim(file, updated);
}

/** Claimant-triggered: `draft`|`challenge_issued` -> `proof_pending`, appending one more evidence entry (the claimant's own account for "I did the thing" — e.g. "submitted a new policy version with the nonce" or, for the plain evidence path, additional supporting links). */
export function markProofPending(
  file: BuilderClaimStoreFile,
  claimId: string,
  accountId: string,
  evidenceNote: string,
  evidenceLinks: readonly string[],
  now: Date,
): BuilderClaimStoreFile {
  const claim = requireOwnedClaim(file, claimId, accountId);
  const sanitizedNote = sanitizeFreeText(evidenceNote, MAX_FREE_TEXT_CODEPOINTS);
  if (sanitizedNote === null) throw new BuilderClaimValidationError("evidenceNote");
  const transitioned = withTransition(
    claim,
    "mark_proof_pending",
    { kind: "claimant", id: accountId },
    null,
    now,
  );
  const updated: BuilderClaimRecord = {
    ...transitioned,
    evidence: [
      ...transitioned.evidence,
      {
        note: sanitizedNote,
        links: sanitizeLinks(evidenceLinks),
        submittedAt: now.toISOString(),
      },
    ],
  };
  return replaceClaim(file, updated);
}

/** Claimant-triggered self-cancel — any non-terminal claim moves to `rejected` with an audit trail that reads "withdrawn", distinct from an operator `reject` even though the destination state is the same. */
export function withdrawClaim(
  file: BuilderClaimStoreFile,
  claimId: string,
  accountId: string,
  now: Date,
): BuilderClaimStoreFile {
  const claim = requireOwnedClaim(file, claimId, accountId);
  const updated = withTransition(
    claim,
    "withdraw",
    { kind: "claimant", id: accountId },
    "withdrawn by claimant",
    now,
  );
  return replaceClaim(file, updated);
}

/** Operator-triggered: `draft`|`challenge_issued`|`proof_pending` -> `proof_pending`|`verified`|`rejected` — the three actions an operator may take via `identity:claims`. Deliberately NOT ownership-checked (an operator is not the claim's account). */
export function applyOperatorAction(
  file: BuilderClaimStoreFile,
  claimId: string,
  action: Extract<BuilderClaimAction, "mark_proof_pending" | "approve" | "reject" | "revoke">,
  operatorId: string,
  note: string | null,
  now: Date,
): BuilderClaimStoreFile {
  const claim = findClaimById(file, claimId);
  if (claim === null) throw new BuilderClaimNotFoundError(claimId);
  const updated = withTransition(
    claim,
    action,
    { kind: "operator", id: operatorId },
    note,
    now,
  );
  return replaceClaim(file, updated);
}

/** System-triggered (gated) — see `NonceObservationReconcile.ts`. Never called from an HTTP route. */
export function applySystemAutoVerify(
  file: BuilderClaimStoreFile,
  claimId: string,
  now: Date,
): BuilderClaimStoreFile {
  const claim = findClaimById(file, claimId);
  if (claim === null) throw new BuilderClaimNotFoundError(claimId);
  const updated = withTransition(
    claim,
    "auto_verify_from_observation",
    { kind: "system", id: "nonce-observation-reconciler" },
    "auto-verified: observed policy label carried the issued nonce",
    now,
  );
  return replaceClaim(file, updated);
}
