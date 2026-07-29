/**
 * "Sign in with GitHub" on the platform — `app.proxywar.xyz` is the sole
 * account and session authority, so this is the ONLY place in the whole
 * system GitHub OAuth happens (see the platform build's contract; betting
 * no longer does this directly — it goes through the handoff instead, see
 * `src/server/replay-premiere/BettingIdentityHandoff.ts`).
 *
 * Three routes, all under `/api/auth/github/` (ungated by wagering — see
 * `PROXYWAR_WAGERING_ENABLED`'s absence from every check below — the
 * platform runs with wagering off and still serves accounts, which is the
 * entire point of the re-scope):
 *
 * - `GET .../start` — mints the link-intent cookie, redirects to GitHub.
 * - `GET .../callback` — GitHub redirects back here. A deliberate
 *   cross-site top-level navigation: security comes from the
 *   SameSite=Lax platform cookie (still sent on a top-level cross-site
 *   GET) plus the short-lived, HMAC-signed link-intent cookie + `state=`
 *   nonce minted by `start`.
 * - `GET .../status` — "who am I signed in as", for the client control.
 *
 * Callers MUST only mount this when `resolveGithubOAuthConfig` returned
 * non-null — there is no internal disabled-state 404 here, matching
 * "unset env means the route doesn't exist" rather than "exists but
 * always fails" (see the contract: "GitHub OAuth stays dormant — no
 * credentials configured, routes absent").
 */
import express, { type Request, type Response, type Router } from "express";
import type { GithubOAuthClient, GithubOAuthUser } from "../GithubOAuthClient";
import { requestSecurityHeaders } from "../replay-premiere/ReplayPremiereHttp";
import type { PlatformAccountSecurity } from "./PlatformAccountSecurity";
import type {
  PlatformGithubIdentityLinkStore,
  PlatformGithubLinkResult,
} from "./PlatformGithubIdentityLinkStore";

export const PLATFORM_GITHUB_AUTH_START_PATH = "/api/auth/github/start" as const;
export const PLATFORM_GITHUB_AUTH_CALLBACK_PATH = "/api/auth/github/callback" as const;
export const PLATFORM_GITHUB_AUTH_STATUS_PATH = "/api/auth/github/status" as const;

export interface PlatformGithubAuthRouterOptions {
  readonly security: PlatformAccountSecurity;
  readonly identityLinkStore: PlatformGithubIdentityLinkStore;
  readonly oauthClient: GithubOAuthClient;
  /** Origin the callback redirect_uri is built against — MUST equal the OAuth app's registered callback host. */
  readonly publicOrigin: string;
  /** Where a completed (or failed) flow lands the browser. */
  readonly returnPath?: string;
  readonly onOperatorError?: (operatorCode: string, error: unknown) => void;
}

export function createPlatformGithubAuthRouter(
  options: PlatformGithubAuthRouterOptions,
): Router {
  const router = express.Router();
  const redirectUri = `${options.publicOrigin}${PLATFORM_GITHUB_AUTH_CALLBACK_PATH}`;
  const returnPath = options.returnPath ?? "/account";
  const logError = options.onOperatorError ?? ((): void => {});

  router.get(PLATFORM_GITHUB_AUTH_START_PATH, (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    try {
      const bootstrap = options.security.bootstrapRead(requestSecurityHeaders(req));
      const { cookie: linkIntentCookie, nonce } = options.security.mintLinkIntentCookie(
        bootstrap.account.accountId,
      );
      const setCookies =
        bootstrap.setCookie === null
          ? [linkIntentCookie]
          : [linkIntentCookie, bootstrap.setCookie];
      res.setHeader("Set-Cookie", setCookies);
      const authorizeUrl = options.oauthClient.buildAuthorizeUrl({
        redirectUri,
        state: nonce,
      });
      res.redirect(302, authorizeUrl);
    } catch (error) {
      logError("platform_github_auth_start_failed", error);
      res.redirect(302, `${returnPath}?github=error`);
    }
  });

  router.get(
    PLATFORM_GITHUB_AUTH_CALLBACK_PATH,
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      const failClosed = (operatorCode: string, error?: unknown): void => {
        logError(operatorCode, error ?? new Error(operatorCode));
        res.setHeader("Set-Cookie", options.security.clearLinkIntentCookieHeader());
        res.redirect(302, `${returnPath}?github=error`);
      };
      try {
        const account = options.security.identifyAccount(req.headers.cookie);
        if (account === null) {
          failClosed("platform_github_auth_no_account_cookie");
          return;
        }
        const linkIntent = options.security.verifyLinkIntentCookie(
          req.headers.cookie,
          account.accountId,
        );
        const state = typeof req.query.state === "string" ? req.query.state : null;
        const code = typeof req.query.code === "string" ? req.query.code : null;
        if (linkIntent === null) {
          failClosed("platform_github_auth_link_intent_missing_or_expired");
          return;
        }
        if (state === null || state !== linkIntent.nonce) {
          failClosed("platform_github_auth_state_mismatch");
          return;
        }
        if (code === null) {
          failClosed("platform_github_auth_code_missing");
          return;
        }
        let accessToken: string;
        try {
          accessToken = await options.oauthClient.exchangeCodeForToken(code, redirectUri);
        } catch (error) {
          failClosed("platform_github_auth_code_exchange_failed", error);
          return;
        }
        let githubUser: GithubOAuthUser;
        try {
          githubUser = await options.oauthClient.fetchUser(accessToken);
        } catch (error) {
          failClosed("platform_github_auth_user_fetch_failed", error);
          return;
        }
        let result: PlatformGithubLinkResult;
        try {
          result = await options.identityLinkStore.linkOrMerge(
            account.accountId,
            githubUser,
          );
        } catch (error) {
          failClosed("platform_github_auth_link_failed", error);
          return;
        }
        res.setHeader("Set-Cookie", [
          options.security.clearLinkIntentCookieHeader(),
          options.security.mintCookieForAccount(result.canonicalAccountId),
        ]);
        res.redirect(
          302,
          result.claimReplaced
            ? `${returnPath}?github=linked&claim=replaced`
            : `${returnPath}?github=linked`,
        );
      } catch (error) {
        failClosed("platform_github_auth_callback_failed", error);
      }
    },
  );

  router.get(
    PLATFORM_GITHUB_AUTH_STATUS_PATH,
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const bootstrap = options.security.bootstrapRead(requestSecurityHeaders(req));
        if (bootstrap.setCookie !== null) res.setHeader("Set-Cookie", bootstrap.setCookie);
        const identity = await options.identityLinkStore.getStatus(
          bootstrap.account.accountId,
        );
        res
          .status(200)
          .json({ schemaVersion: 1, csrfToken: bootstrap.csrfToken, identity });
      } catch (error) {
        logError("platform_github_auth_status_failed", error);
        res.status(503).json({ error: { code: "PLATFORM_UNAVAILABLE" } });
      }
    },
  );

  return router;
}
