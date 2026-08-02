/**
 * `/api/account/builder-claims*` — the claimant-facing half of Season
 * Zero Phase 3's REAL Builder/Agent identity claim workflow. The
 * OPERATOR-facing half (`approve`/`reject`/`revoke`, the only path that
 * ever writes the tracked identity registry) is `identity-claims.ts`, a
 * local CLI — see that file's doc for why approval is deliberately never
 * reachable over HTTP.
 *
 * Every route here does exactly one of:
 *  - read the caller's OWN claims (`GET`), or
 *  - apply one claimant-triggered state-machine transition to a claim the
 *    caller owns (`POST .../challenge`, `.../proof`, `.../withdraw`), or
 *  - create a brand-new `draft` claim (`POST /api/account/builder-claims`).
 *
 * None of these ever set `state: "verified"` — see
 * `BuilderClaimStateMachine.ts`'s doc for why only `identity:claims
 * approve` (an operator, not this server) may do that, and
 * `PolicyLabelNonceChallenge.ts`'s `isNonceAutoVerifyEnabled` for the one
 * gated exception this file never touches either.
 *
 * Route style, security division of duty (`PlatformAccountSecurity` decides
 * WHO, this file decides WHAT), and the `{error:{code}}`/`no-store`
 * response shape all copy `PlatformAccountHttp.ts` verbatim — see that
 * file's doc for the reasoning.
 */
import express, { type Request, type Response, type Router } from "express";
import { InvalidClaimTransitionError } from "../identity/BuilderClaimStateMachine";
import { loadIdentityRegistrySnapshot } from "../identity/IdentityRegistry";
import { requestSecurityHeaders } from "../replay-premiere/ReplayPremiereHttp";
import type { PlatformAccountSecurity } from "./PlatformAccountSecurity";
import type { PlatformGithubIdentityLinkStore } from "./PlatformGithubIdentityLinkStore";
import {
  BuilderClaimNotFoundError,
  BuilderClaimOwnershipError,
  BuilderClaimValidationError,
  InvalidClaimOnTerminalClaimError,
  findClaimById,
  findClaimsByAccount,
  findVerifiedClaimForAgent,
  issueChallenge,
  markProofPending,
  mutateBuilderClaimStore,
  readBuilderClaimStore,
  submitClaim,
  withdrawClaim,
} from "./PlatformBuilderClaimStore";

const MAX_AGENT_ID_BYTES = 128;
const MAX_PLAYER_NAME_BYTES = 1_024;
const MAX_DISPLAY_NAME_BYTES = 1_024;
const MAX_SHORT_BIO_BYTES = 4_096;
const MAX_EVIDENCE_NOTE_BYTES = 8_192;
const MAX_LINK_BYTES = 2_048;
const MAX_LINKS = 10;
const MAX_TEAM_MEMBERS = 20;
const MAX_TEAM_MEMBER_BYTES = 200;

export interface PlatformBuilderClaimHttpOptions {
  readonly security: PlatformAccountSecurity;
  /** Deliberately a plain `{stateRoot}` bag, not a class instance — the store is a set of free functions over a state root, see `PlatformBuilderClaimStore.ts`'s doc for why (the same store is mutated by this server AND a separate `identity:claims` CLI process). */
  readonly claimStore: { readonly stateRoot: string };
  readonly identityLinkStore: PlatformGithubIdentityLinkStore;
  /** Defaults to `defaultIdentityRegistryDir` when omitted — overridable so tests never touch the tracked `resources/identity/*.json`. */
  readonly identityRegistryDir?: string;
  readonly onOperatorError?: (operatorCode: string, error: unknown) => void;
}

function sendFailure(res: Response, status: number, code: string): void {
  res.status(status).json({ error: { code } });
}

/** Express's typed `req.params` values are `string | string[]` (a repeated path segment could in principle produce an array) — same normalization `ai-agent-demo-server.ts`'s own `stringParam` does; a `:claimId` route segment is always a single string in practice. */
function stringParam(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

function stringField(
  body: unknown,
  field: string,
  maxBytes: number,
): string | null {
  if (typeof body !== "object" || body === null || !(field in body))
    return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : null;
}

function stringArrayField(
  body: unknown,
  field: string,
  maxItems: number,
  maxItemBytes: number,
): string[] | null {
  if (typeof body !== "object" || body === null || !(field in body))
    return null;
  const value = (body as Record<string, unknown>)[field];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || Buffer.byteLength(item, "utf8") > maxItemBytes)
      return null;
    items.push(item);
  }
  return items;
}

interface ParsedClaimSubmission {
  readonly agentId: string;
  readonly claimedCoworldPlayerName: string;
  readonly builderDisplayName: string;
  readonly builderShortBio: string | null;
  readonly builderLinks: readonly string[];
  readonly teamMembers: readonly string[];
  readonly evidenceNote: string;
  readonly evidenceLinks: readonly string[];
}

function parseSubmissionBody(body: unknown): ParsedClaimSubmission | null {
  const agentId = stringField(body, "agentId", MAX_AGENT_ID_BYTES);
  const claimedCoworldPlayerName = stringField(
    body,
    "claimedCoworldPlayerName",
    MAX_PLAYER_NAME_BYTES,
  );
  const builderDisplayName = stringField(
    body,
    "builderDisplayName",
    MAX_DISPLAY_NAME_BYTES,
  );
  const evidenceNote = stringField(body, "evidenceNote", MAX_EVIDENCE_NOTE_BYTES);
  const builderLinks = stringArrayField(body, "builderLinks", MAX_LINKS, MAX_LINK_BYTES);
  const teamMembers = stringArrayField(
    body,
    "teamMembers",
    MAX_TEAM_MEMBERS,
    MAX_TEAM_MEMBER_BYTES,
  );
  const evidenceLinks = stringArrayField(
    body,
    "evidenceLinks",
    MAX_LINKS,
    MAX_LINK_BYTES,
  );
  if (
    agentId === null ||
    claimedCoworldPlayerName === null ||
    builderDisplayName === null ||
    evidenceNote === null ||
    builderLinks === null ||
    teamMembers === null ||
    evidenceLinks === null
  ) {
    return null;
  }
  const rawShortBio =
    typeof body === "object" && body !== null && "builderShortBio" in body
      ? (body as Record<string, unknown>).builderShortBio
      : undefined;
  let builderShortBio: string | null;
  if (rawShortBio === null || rawShortBio === undefined) {
    builderShortBio = null;
  } else {
    const parsedShortBio = stringField(body, "builderShortBio", MAX_SHORT_BIO_BYTES);
    if (parsedShortBio === null) return null;
    builderShortBio = parsedShortBio;
  }
  return {
    agentId,
    claimedCoworldPlayerName,
    builderDisplayName,
    builderShortBio,
    builderLinks,
    teamMembers,
    evidenceNote,
    evidenceLinks,
  };
}

/** Maps the claim-store/state-machine's own error classes to this route's public error codes — never a generic 503 for a condition the caller can actually correct. `null` means "not one of ours", falling through to `sendPlatformSecurityFailure`. */
function mapClaimError(error: unknown): { status: number; code: string } | null {
  if (
    error instanceof BuilderClaimNotFoundError ||
    error instanceof BuilderClaimOwnershipError
  ) {
    // Deliberately the SAME code/status for "does not exist" and "exists
    // but you don't own it" — see this module's doc: never confirm a
    // claim's existence to a non-owner via a different status code.
    return { status: 404, code: "PLATFORM_BUILDER_CLAIM_NOT_FOUND" };
  }
  if (
    error instanceof InvalidClaimOnTerminalClaimError ||
    error instanceof InvalidClaimTransitionError
  ) {
    return { status: 409, code: "PLATFORM_BUILDER_CLAIM_INVALID_TRANSITION" };
  }
  if (error instanceof BuilderClaimValidationError) {
    return { status: 400, code: "PLATFORM_INVALID_REQUEST" };
  }
  return null;
}

/** Same shape as `PlatformAccountHttp.ts`'s private helper of the same name — not exported there, so copied here rather than reaching across a module boundary for three lines. */
function sendPlatformSecurityFailure(
  res: Response,
  logError: (operatorCode: string, error: unknown) => void,
  operatorCode: string,
  error: unknown,
): void {
  const status =
    typeof error === "object" &&
    error !== null &&
    "httpStatus" in error &&
    (error.httpStatus === 401 || error.httpStatus === 403)
      ? error.httpStatus
      : 503;
  logError(operatorCode, error);
  sendFailure(
    res,
    status,
    status === 503 ? "PLATFORM_UNAVAILABLE" : "PLATFORM_UNAUTHORIZED",
  );
}

export function createPlatformBuilderClaimRouter(
  options: PlatformBuilderClaimHttpOptions,
): Router {
  const router = express.Router();
  const logError = options.onOperatorError ?? ((): void => {});
  const stateRoot = options.claimStore.stateRoot;

  router.get(
    "/api/account/builder-claims",
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const bootstrap = options.security.bootstrapRead(
          requestSecurityHeaders(req),
        );
        if (bootstrap.setCookie !== null)
          res.setHeader("Set-Cookie", bootstrap.setCookie);
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            bootstrap.account.accountId,
          );
        const file = await readBuilderClaimStore(stateRoot);
        const claims = findClaimsByAccount(file, canonicalAccountId);
        res.status(200).json({ schemaVersion: 1, claims });
      } catch (error) {
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_builder_claims_read_failed",
          error,
        );
      }
    },
  );

  router.post(
    "/api/account/builder-claims",
    express.json({ limit: "8kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const authorization = options.security.authorizeWrite(
          requestSecurityHeaders(req),
        );
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            authorization.account.accountId,
          );
        const parsed = parseSubmissionBody(req.body);
        if (parsed === null) {
          sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
          return;
        }
        const githubStatus =
          await options.identityLinkStore.getStatus(canonicalAccountId);
        if (!githubStatus.signedIn || githubStatus.login === null) {
          sendFailure(res, 403, "PLATFORM_GITHUB_SIGNIN_REQUIRED");
          return;
        }
        const snapshot = await loadIdentityRegistrySnapshot(
          options.identityRegistryDir,
        );
        const agent = snapshot.agents.find((entry) => entry.id === parsed.agentId);
        if (agent === undefined) {
          sendFailure(res, 404, "PLATFORM_AGENT_NOT_FOUND");
          return;
        }
        const existingFile = await readBuilderClaimStore(stateRoot);
        const verifiedClaim = findVerifiedClaimForAgent(existingFile, parsed.agentId);
        if (verifiedClaim !== null && verifiedClaim.accountId !== canonicalAccountId) {
          sendFailure(res, 409, "PLATFORM_ALREADY_VERIFIED");
          return;
        }
        const now = new Date();
        const githubLogin = githubStatus.login;
        let newClaimId = "";
        const updated = await mutateBuilderClaimStore(stateRoot, (file) => {
          const next = submitClaim(
            file,
            {
              accountId: canonicalAccountId,
              githubLogin,
              agentId: parsed.agentId,
              claimedCoworldPlayerName: parsed.claimedCoworldPlayerName,
              builderDisplayName: parsed.builderDisplayName,
              builderShortBio: parsed.builderShortBio,
              builderLinks: parsed.builderLinks,
              teamMembers: parsed.teamMembers,
              evidenceNote: parsed.evidenceNote,
              evidenceLinks: parsed.evidenceLinks,
            },
            now,
          );
          newClaimId = next.claims[next.claims.length - 1].id;
          return next;
        });
        const claim = findClaimById(updated, newClaimId);
        res.status(200).json({ schemaVersion: 1, claim });
      } catch (error) {
        const mapped = mapClaimError(error);
        if (mapped !== null) {
          sendFailure(res, mapped.status, mapped.code);
          return;
        }
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_builder_claim_submit_failed",
          error,
        );
      }
    },
  );

  router.post(
    "/api/account/builder-claims/:claimId/challenge",
    express.json({ limit: "1kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const authorization = options.security.authorizeWrite(
          requestSecurityHeaders(req),
        );
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            authorization.account.accountId,
          );
        const claimId = stringParam(req.params.claimId);
        const before = await readBuilderClaimStore(stateRoot);
        const existingClaim = findClaimById(before, claimId);
        if (existingClaim === null) {
          sendFailure(res, 404, "PLATFORM_BUILDER_CLAIM_NOT_FOUND");
          return;
        }
        const snapshot = await loadIdentityRegistrySnapshot(
          options.identityRegistryDir,
        );
        const agent = snapshot.agents.find(
          (entry) => entry.id === existingClaim.agentId,
        );
        const agentDisplayName = agent?.displayName ?? existingClaim.claimedCoworldPlayerName;
        const now = new Date();
        const updated = await mutateBuilderClaimStore(stateRoot, (file) =>
          issueChallenge(file, claimId, canonicalAccountId, agentDisplayName, now),
        );
        const claim = findClaimById(updated, claimId);
        res.status(200).json({ schemaVersion: 1, claim });
      } catch (error) {
        const mapped = mapClaimError(error);
        if (mapped !== null) {
          sendFailure(res, mapped.status, mapped.code);
          return;
        }
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_builder_claim_challenge_failed",
          error,
        );
      }
    },
  );

  router.post(
    "/api/account/builder-claims/:claimId/proof",
    express.json({ limit: "8kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const authorization = options.security.authorizeWrite(
          requestSecurityHeaders(req),
        );
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            authorization.account.accountId,
          );
        const claimId = stringParam(req.params.claimId);
        const evidenceNote = stringField(
          req.body,
          "evidenceNote",
          MAX_EVIDENCE_NOTE_BYTES,
        );
        const evidenceLinks = stringArrayField(
          req.body,
          "evidenceLinks",
          MAX_LINKS,
          MAX_LINK_BYTES,
        );
        if (evidenceNote === null || evidenceLinks === null) {
          sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
          return;
        }
        const now = new Date();
        const updated = await mutateBuilderClaimStore(stateRoot, (file) =>
          markProofPending(file, claimId, canonicalAccountId, evidenceNote, evidenceLinks, now),
        );
        const claim = findClaimById(updated, claimId);
        res.status(200).json({ schemaVersion: 1, claim });
      } catch (error) {
        const mapped = mapClaimError(error);
        if (mapped !== null) {
          sendFailure(res, mapped.status, mapped.code);
          return;
        }
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_builder_claim_proof_failed",
          error,
        );
      }
    },
  );

  router.post(
    "/api/account/builder-claims/:claimId/withdraw",
    express.json({ limit: "1kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const authorization = options.security.authorizeWrite(
          requestSecurityHeaders(req),
        );
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            authorization.account.accountId,
          );
        const claimId = stringParam(req.params.claimId);
        const now = new Date();
        const updated = await mutateBuilderClaimStore(stateRoot, (file) =>
          withdrawClaim(file, claimId, canonicalAccountId, now),
        );
        const claim = findClaimById(updated, claimId);
        res.status(200).json({ schemaVersion: 1, claim });
      } catch (error) {
        const mapped = mapClaimError(error);
        if (mapped !== null) {
          sendFailure(res, mapped.status, mapped.code);
          return;
        }
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_builder_claim_withdraw_failed",
          error,
        );
      }
    },
  );

  return router;
}
