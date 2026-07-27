/**
 * "Sign in with GitHub" — claims a guest identity with a verified,
 * un-spoofable name. Three routes, all under `/api/premieres/auth/github/`
 * (mandatory: `serializeGuestCookie` hardcodes `Path=/api/premieres`, so a
 * route outside that prefix would never receive the guest cookie and would
 * force a fresh anonymous identity on every call — see
 * `ReplayPremiereGuestSecurity`).
 *
 * - `GET .../start` — mints the link-intent cookie, redirects to GitHub.
 * - `GET .../callback` — GitHub redirects back here. A deliberate
 *   cross-site top-level navigation: no Origin/Sec-Fetch-Site proof is
 *   possible or expected. Security instead comes from the SameSite=Lax
 *   guest cookie (still sent on a top-level cross-site GET) plus the
 *   short-lived, HMAC-signed link-intent cookie + `state=` nonce minted by
 *   `start` — see `ReplayPremiereGuestSecurity.mintLinkIntentCookie`.
 * - `GET .../status` — "who am I signed in as", for the client control.
 *
 * GitHub is never in the path of a trade: nothing here is on the
 * order/settlement path (see `ReplayPremiereInteractions`), and every
 * handler fails closed with a redirect/JSON error, never a thrown 500,
 * never a hang — GitHub being unreachable degrades ONLY sign-in.
 */
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import type {
  ReplayPremiereGithubUser,
  ReplayPremiereIdentityLinkStore,
} from "./points/ReplayPremiereIdentityLinkStore";
import { requestSecurityHeaders } from "./ReplayPremiereHttp";
import type { ReplayPremiereGuestSecurity } from "./ReplayPremiereGuestSecurity";

export const GITHUB_OAUTH_CLIENT_ID_ENV = "PROXYWAR_GITHUB_OAUTH_CLIENT_ID" as const;
export const GITHUB_OAUTH_CLIENT_SECRET_ENV =
  "PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET" as const;
/** Dev/test-only override for GitHub's own web host (`/login/oauth/...`) — points at a faithful local stub instead of github.com. Never changes where the real client secret is sent in production; unset defaults to the real host. */
const GITHUB_WEB_BASE_URL_ENV = "PROXYWAR_GITHUB_OAUTH_WEB_BASE_URL" as const;
/** Dev/test-only override for the GitHub REST API host (`/user`) — see {@link GITHUB_WEB_BASE_URL_ENV}. */
const GITHUB_API_BASE_URL_ENV = "PROXYWAR_GITHUB_OAUTH_API_BASE_URL" as const;
const DEFAULT_GITHUB_WEB_BASE_URL = "https://github.com";
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

export const REPLAY_PREMIERE_GITHUB_AUTH_START_PATH =
  "/api/premieres/auth/github/start" as const;
export const REPLAY_PREMIERE_GITHUB_AUTH_CALLBACK_PATH =
  "/api/premieres/auth/github/callback" as const;
export const REPLAY_PREMIERE_GITHUB_AUTH_STATUS_PATH =
  "/api/premieres/auth/github/status" as const;

export interface ReplayPremiereGithubOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Reads both required secrets from the environment. Returns `null` — never a partial config — when either is unset, so the caller can cleanly not build the feature at all. Secrets never logged, never sent to the browser. */
export function resolveReplayPremiereGithubOAuthConfig(
  environment: Record<string, string | undefined> = process.env,
): ReplayPremiereGithubOAuthConfig | null {
  const clientId = environment[GITHUB_OAUTH_CLIENT_ID_ENV]?.trim();
  const clientSecret = environment[GITHUB_OAUTH_CLIENT_SECRET_ENV]?.trim();
  if (
    clientId === undefined ||
    clientId === "" ||
    clientSecret === undefined ||
    clientSecret === ""
  ) {
    return null;
  }
  return { clientId, clientSecret };
}

/** Injectable so tests can stub GitHub's endpoints without real credentials or network access. */
export interface ReplayPremiereGithubOAuthClient {
  buildAuthorizeUrl(options: { redirectUri: string; state: string }): string;
  exchangeCodeForToken(code: string, redirectUri: string): Promise<string>;
  fetchUser(accessToken: string): Promise<ReplayPremiereGithubUser>;
}

const githubTokenResponseSchema = z.union([
  z.object({ access_token: z.string().min(1) }),
  z.object({ error: z.string() }),
]);

const githubUserResponseSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(64),
  avatar_url: z.string().url().nullable().optional(),
});

/** Real implementation, talking to github.com / api.github.com (or a stub via {@link GITHUB_WEB_BASE_URL_ENV}/{@link GITHUB_API_BASE_URL_ENV}). No scope requested beyond the default (public profile: id/login/avatar) — see `RUNBOOK.md` for why. */
export function createReplayPremiereGithubOAuthClient(
  config: ReplayPremiereGithubOAuthConfig,
  environment: Record<string, string | undefined> = process.env,
): ReplayPremiereGithubOAuthClient {
  const webBaseUrl = (
    environment[GITHUB_WEB_BASE_URL_ENV]?.trim() || DEFAULT_GITHUB_WEB_BASE_URL
  ).replace(/\/+$/, "");
  const apiBaseUrl = (
    environment[GITHUB_API_BASE_URL_ENV]?.trim() || DEFAULT_GITHUB_API_BASE_URL
  ).replace(/\/+$/, "");
  return {
    buildAuthorizeUrl({ redirectUri, state }) {
      const url = new URL(`${webBaseUrl}/login/oauth/authorize`);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("allow_signup", "false");
      return url.toString();
    },
    async exchangeCodeForToken(code, redirectUri) {
      const response = await fetch(`${webBaseUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!response.ok) {
        throw new Error(`github_token_exchange_failed_${response.status}`);
      }
      const parsed: unknown = await response.json();
      const result = githubTokenResponseSchema.safeParse(parsed);
      if (!result.success) throw new Error("github_token_exchange_response_invalid");
      if ("error" in result.data) {
        throw new Error(`github_token_exchange_rejected_${result.data.error}`);
      }
      return result.data.access_token;
    },
    async fetchUser(accessToken) {
      const response = await fetch(`${apiBaseUrl}/user`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "proxywar-betting",
        },
      });
      if (!response.ok) throw new Error(`github_user_fetch_failed_${response.status}`);
      const parsed: unknown = await response.json();
      const result = githubUserResponseSchema.safeParse(parsed);
      if (!result.success) throw new Error("github_user_response_invalid");
      return {
        githubUserId: result.data.id,
        login: result.data.login,
        avatarUrl: result.data.avatar_url ?? null,
      };
    },
  };
}

export interface ReplayPremiereGithubAuthRouterOptions {
  readonly security: ReplayPremiereGuestSecurity;
  readonly identityLinkStore: ReplayPremiereIdentityLinkStore;
  readonly oauthClient: ReplayPremiereGithubOAuthClient;
  /** Origin the callback redirect_uri is built against, e.g. `https://bet.proxywar.xyz` — MUST equal the app's registered callback host. */
  readonly publicOrigin: string;
  /** Where a completed (or failed) flow lands the browser — the stable `/bet` entry point by default. */
  readonly returnPath?: string;
  readonly onOperatorError?: (operatorCode: string, error: unknown) => void;
}

/** Creates the three GitHub sign-in routes. Callers MUST only mount this when {@link resolveReplayPremiereGithubOAuthConfig} returned non-null — there is no internal disabled-state 404 here, matching "unset env means the route doesn't exist" rather than "exists but always fails". */
export function createReplayPremiereGithubAuthRouter(
  options: ReplayPremiereGithubAuthRouterOptions,
): Router {
  const router = express.Router();
  const redirectUri = `${options.publicOrigin}${REPLAY_PREMIERE_GITHUB_AUTH_CALLBACK_PATH}`;
  const returnPath = options.returnPath ?? "/bet";
  const logError = options.onOperatorError ?? ((): void => {});

  router.get(REPLAY_PREMIERE_GITHUB_AUTH_START_PATH, (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    try {
      const guest = options.security.bootstrapRead(requestSecurityHeaders(req));
      const { cookie: linkIntentCookie, nonce } = options.security.mintLinkIntentCookie(
        guest.participant.participantId,
      );
      const setCookies =
        guest.setCookie === null
          ? [linkIntentCookie]
          : [linkIntentCookie, guest.setCookie];
      res.setHeader("Set-Cookie", setCookies);
      const authorizeUrl = options.oauthClient.buildAuthorizeUrl({
        redirectUri,
        state: nonce,
      });
      res.redirect(302, authorizeUrl);
    } catch (error) {
      logError("github_auth_start_failed", error);
      res.redirect(302, `${returnPath}?github=error`);
    }
  });

  router.get(
    REPLAY_PREMIERE_GITHUB_AUTH_CALLBACK_PATH,
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      const failClosed = (operatorCode: string, error?: unknown): void => {
        if (error !== undefined) logError(operatorCode, error);
        else logError(operatorCode, new Error(operatorCode));
        res.setHeader("Set-Cookie", options.security.clearLinkIntentCookieHeader());
        res.redirect(302, `${returnPath}?github=error`);
      };
      try {
        const guest = options.security.identifyGuest(req.headers.cookie);
        if (guest === null) {
          failClosed("github_auth_no_guest_cookie");
          return;
        }
        const linkIntent = options.security.verifyLinkIntentCookie(
          req.headers.cookie,
          guest.participantId,
        );
        const state = typeof req.query.state === "string" ? req.query.state : null;
        const code = typeof req.query.code === "string" ? req.query.code : null;
        if (linkIntent === null) {
          failClosed("github_auth_link_intent_missing_or_expired");
          return;
        }
        if (state === null || state !== linkIntent.nonce) {
          failClosed("github_auth_state_mismatch");
          return;
        }
        if (code === null) {
          failClosed("github_auth_code_missing");
          return;
        }
        let accessToken: string;
        try {
          accessToken = await options.oauthClient.exchangeCodeForToken(
            code,
            redirectUri,
          );
        } catch (error) {
          failClosed("github_auth_code_exchange_failed", error);
          return;
        }
        let githubUser: ReplayPremiereGithubUser;
        try {
          githubUser = await options.oauthClient.fetchUser(accessToken);
        } catch (error) {
          failClosed("github_auth_user_fetch_failed", error);
          return;
        }
        await options.identityLinkStore.linkOrMerge(guest.participantId, githubUser);
        res.setHeader("Set-Cookie", options.security.clearLinkIntentCookieHeader());
        res.redirect(302, `${returnPath}?github=linked`);
      } catch (error) {
        failClosed("github_auth_callback_failed", error);
      }
    },
  );

  router.get(
    REPLAY_PREMIERE_GITHUB_AUTH_STATUS_PATH,
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const guest = options.security.bootstrapRead(requestSecurityHeaders(req));
        if (guest.setCookie !== null) res.setHeader("Set-Cookie", guest.setCookie);
        const identity = await options.identityLinkStore.getStatus(
          guest.participant.participantId,
        );
        res.status(200).json({ schemaVersion: 1, csrfToken: guest.csrfToken, identity });
      } catch (error) {
        logError("github_auth_status_failed", error);
        res.status(503).json({ error: { code: "PREMIERE_UNAVAILABLE" } });
      }
    },
  );

  return router;
}
