/**
 * `/api/account/version-releases` — the builder-facing half of Season
 * Zero Phase 6's builder-improvement loop: a verified Builder tells the
 * platform "I shipped a new version of my agent", and that notice sits as
 * a `PendingVersionRelease` until `identity:releases reconcile` links it
 * to what the league mirror actually observed (see
 * `VersionReleaseReconcile.ts`'s doc for the matching rule).
 *
 * Same route style as `PlatformAccountHttp.ts` — read that file's doc
 * before touching this one: `security.bootstrapRead`/`authorizeWrite` for
 * who-is-this, `Cache-Control: no-store, max-age=0` on every response,
 * `{error:{code}}` on every failure, and a locally-copied
 * `sendPlatformSecurityFailure` (that helper isn't exported from
 * `PlatformAccountHttp.ts` either — every route module keeps its own).
 *
 * The one authorization rule unique to this router: submitting a release
 * notice for `agentId` requires the CALLER to hold a `verified` claim for
 * THAT SPECIFIC agent (`findVerifiedClaimForAgent`,
 * `PlatformBuilderClaimStore.ts`) — an account verified as the builder of
 * one agent gets no say over any other agent's release notices.
 */
import express, { type Request, type Response, type Router } from "express";
import { requestSecurityHeaders } from "../replay-premiere/ReplayPremiereHttp";
import {
  findVerifiedClaimForAgent,
  readBuilderClaimStore,
} from "./PlatformBuilderClaimStore";
import type { PlatformAccountSecurity } from "./PlatformAccountSecurity";
import type { PlatformGithubIdentityLinkStore } from "./PlatformGithubIdentityLinkStore";
import {
  createPendingRelease,
  findReleasesByAccount,
  mutateVersionReleaseStore,
  readVersionReleaseStore,
  VersionReleaseValidationError,
} from "./PlatformVersionReleaseStore";

const MAX_AGENT_ID_REQUEST_BYTES = 128;
const MAX_VERSION_LABEL_REQUEST_BYTES = 320;
const MAX_FREE_TEXT_REQUEST_BYTES = 8_000;

export interface PlatformBuilderVersionHttpOptions {
  readonly security: PlatformAccountSecurity;
  readonly releaseStore: { readonly stateRoot: string };
  readonly claimStore: { readonly stateRoot: string };
  readonly identityLinkStore: PlatformGithubIdentityLinkStore;
  readonly onOperatorError?: (operatorCode: string, error: unknown) => void;
}

function sendFailure(res: Response, status: number, code: string): void {
  res.status(status).json({ error: { code } });
}

/** A required string field — present, a string, within `maxBytes`. `null` on anything else (missing, wrong type, or oversized). */
function requiredStringField(
  body: unknown,
  field: string,
  maxBytes: number,
): string | null {
  if (typeof body !== "object" || body === null || !(field in body)) {
    return null;
  }
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : null;
}

/** An optional string field — missing or explicit `null` becomes `null`; a within-limit string passes through; anything else (wrong type, oversized) is `undefined` to signal "reject the request". */
function optionalStringField(
  body: unknown,
  field: string,
  maxBytes: number,
): string | null | undefined {
  if (typeof body !== "object" || body === null || !(field in body)) {
    return null;
  }
  const value = (body as Record<string, unknown>)[field];
  if (value === null) return null;
  return typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : undefined;
}

export function createPlatformBuilderVersionRouter(
  options: PlatformBuilderVersionHttpOptions,
): Router {
  const router = express.Router();
  const logError = options.onOperatorError ?? ((): void => {});

  router.get(
    "/api/account/version-releases",
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const bootstrap = options.security.bootstrapRead(
          requestSecurityHeaders(req),
        );
        if (bootstrap.setCookie !== null) {
          res.setHeader("Set-Cookie", bootstrap.setCookie);
        }
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            bootstrap.account.accountId,
          );
        const file = await readVersionReleaseStore(
          options.releaseStore.stateRoot,
        );
        const releases = findReleasesByAccount(file, canonicalAccountId);
        res.status(200).json({ schemaVersion: 1, releases });
      } catch (error) {
        logError("platform_version_releases_read_failed", error);
        sendFailure(res, 503, "PLATFORM_UNAVAILABLE");
      }
    },
  );

  router.post(
    "/api/account/version-releases",
    express.json({ limit: "64kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const authorization = options.security.authorizeWrite(
          requestSecurityHeaders(req),
        );
        const agentId = requiredStringField(
          req.body,
          "agentId",
          MAX_AGENT_ID_REQUEST_BYTES,
        );
        const versionLabel = requiredStringField(
          req.body,
          "versionLabel",
          MAX_VERSION_LABEL_REQUEST_BYTES,
        );
        const releaseNotes = optionalStringField(
          req.body,
          "releaseNotes",
          MAX_FREE_TEXT_REQUEST_BYTES,
        );
        const baseModel = optionalStringField(
          req.body,
          "baseModel",
          MAX_FREE_TEXT_REQUEST_BYTES,
        );
        const scaffoldDescription = optionalStringField(
          req.body,
          "scaffoldDescription",
          MAX_FREE_TEXT_REQUEST_BYTES,
        );
        const sourceDisclosure = optionalStringField(
          req.body,
          "sourceDisclosure",
          MAX_FREE_TEXT_REQUEST_BYTES,
        );
        const intendedChanges = optionalStringField(
          req.body,
          "intendedChanges",
          MAX_FREE_TEXT_REQUEST_BYTES,
        );
        if (
          agentId === null ||
          versionLabel === null ||
          releaseNotes === undefined ||
          baseModel === undefined ||
          scaffoldDescription === undefined ||
          sourceDisclosure === undefined ||
          intendedChanges === undefined
        ) {
          sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
          return;
        }
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            authorization.account.accountId,
          );
        const claimFile = await readBuilderClaimStore(
          options.claimStore.stateRoot,
        );
        const verifiedClaim = findVerifiedClaimForAgent(claimFile, agentId);
        if (
          verifiedClaim === null ||
          verifiedClaim.accountId !== canonicalAccountId
        ) {
          sendFailure(res, 403, "PLATFORM_NOT_YOUR_AGENT");
          return;
        }
        const file = await mutateVersionReleaseStore(
          options.releaseStore.stateRoot,
          (current) =>
            createPendingRelease(
              current,
              {
                accountId: canonicalAccountId,
                agentId,
                versionLabel,
                releaseNotes,
                baseModel,
                scaffoldDescription,
                sourceDisclosure,
                intendedChanges,
              },
              new Date(),
            ),
        );
        const release = file.releases[file.releases.length - 1];
        res.status(200).json({ schemaVersion: 1, release });
      } catch (error) {
        if (error instanceof VersionReleaseValidationError) {
          sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
          return;
        }
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_version_release_submit_failed",
          error,
        );
      }
    },
  );

  return router;
}

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
