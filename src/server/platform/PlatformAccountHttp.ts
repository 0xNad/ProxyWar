/**
 * The platform's account and identity API. GitHub OAuth is mounted by the
 * platform server; this router owns account reads, claims, and identity status.
 */
import express, { type Request, type Response, type Router } from "express";
import { emitServerAnalyticsEvent } from "../analytics/AnalyticsServerEmit";
import { requestSecurityHeaders } from "../replay-premiere/ReplayPremiereHttp";
import type { PlatformAccountSecurity } from "./PlatformAccountSecurity";
import type { PlatformAccountStore } from "./PlatformAccountStore";
import type { PlatformGithubIdentityLinkStore } from "./PlatformGithubIdentityLinkStore";
import type { PlatformPolicyClaimStore } from "./PlatformPolicyClaimStore";

const MAX_DISPLAY_NAME_REQUEST_BYTES = 512;
const MAX_CLAIM_LABEL_REQUEST_BYTES = 512;

export interface PlatformAccountHttpOptions {
  readonly security: PlatformAccountSecurity;
  readonly accounts: PlatformAccountStore;
  readonly claims: PlatformPolicyClaimStore;
  readonly identityLinkStore: PlatformGithubIdentityLinkStore;
  readonly githubSignInAvailable: boolean;
  /** Threaded through only for the `returning_authenticated_visitor` emission below — see that route handler's own doc for why GET /api/account is the right hook. */
  readonly artifactsRootDir: string;
  readonly onOperatorError?: (operatorCode: string, error: unknown) => void;
}

function sendFailure(res: Response, status: number, code: string): void {
  res.status(status).json({ error: { code } });
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

export function createPlatformAccountRouter(
  options: PlatformAccountHttpOptions,
): Router {
  const router = express.Router();
  const logError = options.onOperatorError ?? ((): void => {});

  // `returning_authenticated_visitor` dedup: bounded, in-memory, reset on
  // UTC day rollover — mirrors the day-bucketing `AnalyticsAggregateStore.ts`
  // itself already uses, so "once per accountId per day" here lines up with
  // the aggregate's own day boundary. Best-effort only (a process restart
  // resets it, and the `MAX_DEDUP_ACCOUNT_IDS` bound means a pathologically
  // busy day could under-dedup past the cap) — acceptable for a retention
  // signal that's explicitly raw-counts-not-precision per the Season Zero
  // overinterpretation rule, and correct in the overwhelmingly common case.
  const MAX_DEDUP_ACCOUNT_IDS = 5_000;
  let dedupDayKey = new Date().toISOString().slice(0, 10);
  let dedupSeenAccountIds = new Set<string>();

  router.get("/api/account", async (req: Request, res: Response) => {
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
      // `setCookie === null` means `bootstrapRead` found an ALREADY-
      // established account cookie rather than minting a fresh one (see
      // `PlatformAccountSecurity.bootstrap`'s doc) — but that alone is NOT
      // "authenticated": every platform visitor, signed in or not, gets an
      // auto-minted GUEST account cookie on first touch, so a plain
      // returning GUEST would also satisfy `setCookie === null` on their
      // second visit. If this fired `returning_authenticated_visitor` for
      // that guest, the SAME visit would be double-counted against the
      // report's return metric — once here, once client-side via
      // `returning_anonymous_visitor` (the localStorage visitor id already
      // existed too). `returning_authenticated_visitor` therefore requires
      // BOTH signals: an already-established cookie AND a genuinely
      // GitHub-linked identity (`githubStatus.login !== null`) — "carries
      // an established, GitHub-linked platform identity", not merely "has
      // ever loaded a page here before". This is an authenticated
      // visit-DAY count, not strict per-session counting; see
      // docs/SEASON_ZERO_ANALYTICS.md.
      const [account, claims, githubStatus] = await Promise.all([
        options.accounts.getAccount(canonicalAccountId),
        options.claims.getClaims(canonicalAccountId),
        options.identityLinkStore.getStatus(canonicalAccountId),
      ]);
      if (bootstrap.setCookie === null && githubStatus.login !== null) {
        const dayKey = new Date().toISOString().slice(0, 10);
        if (dayKey !== dedupDayKey) {
          dedupDayKey = dayKey;
          dedupSeenAccountIds = new Set();
        }
        if (!dedupSeenAccountIds.has(canonicalAccountId)) {
          if (dedupSeenAccountIds.size < MAX_DEDUP_ACCOUNT_IDS) {
            dedupSeenAccountIds.add(canonicalAccountId);
          }
          void emitServerAnalyticsEvent(
            options.artifactsRootDir,
            "returning_authenticated_visitor",
          );
        }
      }
      res.status(200).json({
        schemaVersion: 1,
        csrfToken: bootstrap.csrfToken,
        identity: {
          accountId: canonicalAccountId,
          displayName: account?.displayName ?? null,
          githubLogin: githubStatus.login,
          githubAvatarUrl: githubStatus.avatarUrl,
        },
        claims,
      });
    } catch (error) {
      sendPlatformSecurityFailure(
        res,
        logError,
        "platform_account_read_failed",
        error,
      );
    }
  });

  router.post(
    "/api/account/display-name",
    express.json({ limit: "8kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const authorization = options.security.authorizeWrite(
          requestSecurityHeaders(req),
        );
        const displayName = stringField(
          req.body,
          "displayName",
          MAX_DISPLAY_NAME_REQUEST_BYTES,
        );
        if (displayName === null) {
          sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
          return;
        }
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            authorization.account.accountId,
          );
        const account = await options.accounts.setDisplayName(
          canonicalAccountId,
          displayName,
        );
        res.status(200).json({ schemaVersion: 1, account });
      } catch (error) {
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_display_name_failed",
          error,
        );
      }
    },
  );

  /** Adds (or updates, for an already-claimed lineage) one claim — never clears the whole set; see `PlatformPolicyClaimStore.addClaim`'s doc. Returns the account's full, resulting claim set. */
  router.post(
    "/api/account/claim",
    express.json({ limit: "4kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const authorization = options.security.authorizeWrite(
          requestSecurityHeaders(req),
        );
        const label = stringField(
          req.body,
          "label",
          MAX_CLAIM_LABEL_REQUEST_BYTES,
        );
        if (label === null || label.trim().length === 0) {
          sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
          return;
        }
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            authorization.account.accountId,
          );
        const claims = await options.claims.addClaim(canonicalAccountId, label);
        res.status(200).json({ schemaVersion: 1, claims });
      } catch (error) {
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_claim_failed",
          error,
        );
      }
    },
  );

  /** Removes one lineage from the caller's claim set — a no-op, not an error, if it was never claimed. Returns the account's full, resulting claim set. */
  router.post(
    "/api/account/claim/remove",
    express.json({ limit: "4kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const authorization = options.security.authorizeWrite(
          requestSecurityHeaders(req),
        );
        const lineageSlug = stringField(
          req.body,
          "lineageSlug",
          MAX_CLAIM_LABEL_REQUEST_BYTES,
        );
        if (lineageSlug === null || lineageSlug.trim().length === 0) {
          sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
          return;
        }
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            authorization.account.accountId,
          );
        const claims = await options.claims.removeClaim(
          canonicalAccountId,
          lineageSlug,
        );
        res.status(200).json({ schemaVersion: 1, claims });
      } catch (error) {
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_claim_remove_failed",
          error,
        );
      }
    },
  );

  /** "Who am I, where do I sign in" read for the platform account page. */
  router.get("/api/identity/status", async (req: Request, res: Response) => {
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
      const [account, githubStatus] = await Promise.all([
        options.accounts.getAccount(canonicalAccountId),
        options.identityLinkStore.getStatus(canonicalAccountId),
      ]);
      res.status(200).json({
        schemaVersion: 1,
        identity: {
          signedIn: githubStatus.signedIn,
          displayName: account?.displayName ?? null,
          githubLogin: githubStatus.login,
          githubAvatarUrl: githubStatus.avatarUrl,
        },
        signInUrl: options.githubSignInAvailable
          ? "/api/auth/github/start"
          : null,
      });
    } catch (error) {
      logError("platform_identity_status_failed", error);
      sendFailure(res, 503, "PLATFORM_UNAVAILABLE");
    }
  });

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
