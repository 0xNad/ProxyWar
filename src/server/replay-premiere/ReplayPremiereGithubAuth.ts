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
 * handler fails closed with a redirect/JSON error, never a thrown 500 —
 * including a GitHub that accepts a connection and then never answers,
 * bounded by `fetchTimeoutMs` on both the token exchange and the `/user`
 * fetch (see `createReplayPremiereGithubOAuthClient`). GitHub being
 * unreachable, slow, or hung degrades ONLY sign-in.
 */
import express, { type Request, type Response, type Router } from "express";
import { promises as fs } from "node:fs";
import { z } from "zod";
import type {
  ReplayPremiereGithubLinkResult,
  ReplayPremiereGithubUser,
  ReplayPremiereIdentityLinkStore,
} from "./points/ReplayPremiereIdentityLinkStore";
import type { ReplayPremiereGuestSecurity } from "./ReplayPremiereGuestSecurity";
import { requestSecurityHeaders } from "./ReplayPremiereHttp";

export const GITHUB_OAUTH_CLIENT_ID_ENV =
  "PROXYWAR_GITHUB_OAUTH_CLIENT_ID" as const;
export const GITHUB_OAUTH_CLIENT_SECRET_ENV =
  "PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET" as const;
/** Preferred over `GITHUB_OAUTH_CLIENT_SECRET_ENV` when set: a path to a file holding the secret, kept at rest with `0600` permissions instead of sitting in the process environment (`ps eww <pid>` dumps env vars to anyone with an account on the host). See `resolveGithubOAuthClientSecret`. */
export const GITHUB_OAUTH_CLIENT_SECRET_FILE_ENV =
  "PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET_FILE" as const;
/** Dev/test-only override for GitHub's own web host (`/login/oauth/...`) — points at a faithful local stub instead of github.com. Never changes where the real client secret is sent in production; unset defaults to the real host. */
const GITHUB_WEB_BASE_URL_ENV = "PROXYWAR_GITHUB_OAUTH_WEB_BASE_URL" as const;
/** Dev/test-only override for the GitHub REST API host (`/user`) — see {@link GITHUB_WEB_BASE_URL_ENV}. */
const GITHUB_API_BASE_URL_ENV = "PROXYWAR_GITHUB_OAUTH_API_BASE_URL" as const;
const DEFAULT_GITHUB_WEB_BASE_URL = "https://github.com";
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
/** Bounded wait for the token exchange and `/user` fetch — see `createReplayPremiereGithubOAuthClient`'s `fetchTimeoutMs` param. GitHub accepting a connection and then never answering is a more common real failure than an immediate rejection; without this, the callback (and the browser's tab) would hang indefinitely. */
const DEFAULT_GITHUB_FETCH_TIMEOUT_MS = 10_000;

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

/**
 * `_SECRET_FILE` wins when set: reads the file, trims trailing whitespace
 * and newlines (a secret written with `echo` instead of `printf` gains a
 * trailing `\n`, which GitHub rejects with an opaque error that looks
 * nothing like "your secret has a newline in it" — see `RUNBOOK.md`).
 * Falls back to the inline `_SECRET_ENV` only when `_SECRET_FILE` is
 * unset, so local development stays convenient. An unreadable file is
 * treated EXACTLY like an unset secret — sign-in cleanly does not exist —
 * never a thrown error; only a fixed, path-only, content-free line is
 * logged (never the file's contents, never a raw fs error that could
 * embed unrelated data).
 */
async function resolveGithubOAuthClientSecret(
  environment: Record<string, string | undefined>,
): Promise<string | null> {
  const secretFilePath =
    environment[GITHUB_OAUTH_CLIENT_SECRET_FILE_ENV]?.trim();
  if (secretFilePath !== undefined && secretFilePath !== "") {
    try {
      // Fail closed unless the file is genuinely private. The whole reason the
      // secret is passed by path rather than value is to keep it away from
      // other local accounts; silently accepting a 0644 secret would give that
      // up while still looking secure. lstat, not stat, so a symlink pointing
      // at a world-readable file cannot launder the check.
      const stats = await fs.lstat(secretFilePath);
      if (!stats.isFile()) {
        console.error(
          `GitHub OAuth client secret path is not a regular file: ${secretFilePath}`,
        );
        return null;
      }
      if (stats.uid !== process.getuid?.()) {
        console.error(
          `GitHub OAuth client secret file is not owned by this process: ${secretFilePath}`,
        );
        return null;
      }
      if ((stats.mode & 0o077) !== 0) {
        console.error(
          `GitHub OAuth client secret file is group/world accessible (need 0600): ${secretFilePath}`,
        );
        return null;
      }
      const raw = await fs.readFile(secretFilePath, "utf8");
      const trimmed = raw.trim();
      return trimmed === "" ? null : trimmed;
    } catch {
      console.error(
        `GitHub OAuth client secret file unreadable at ${secretFilePath}`,
      );
      return null;
    }
  }
  const inline = environment[GITHUB_OAUTH_CLIENT_SECRET_ENV]?.trim();
  return inline === undefined || inline === "" ? null : inline;
}

/** Reads the required secrets from the environment (see {@link resolveGithubOAuthClientSecret} for the client secret's file-vs-inline precedence). Returns `null` — never a partial config — when either half is unset/unreadable, so the caller can cleanly not build the feature at all. Secrets never logged, never sent to the browser. */
export async function resolveReplayPremiereGithubOAuthConfig(
  environment: Record<string, string | undefined> = process.env,
): Promise<ReplayPremiereGithubOAuthConfig | null> {
  const clientId = environment[GITHUB_OAUTH_CLIENT_ID_ENV]?.trim();
  if (clientId === undefined || clientId === "") return null;
  const clientSecret = await resolveGithubOAuthClientSecret(environment);
  if (clientSecret === null) return null;
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
  /** Injectable so a test can use a few milliseconds instead of stalling the suite for the real default. */
  fetchTimeoutMs: number = DEFAULT_GITHUB_FETCH_TIMEOUT_MS,
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
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`github_token_exchange_failed_${response.status}`);
      }
      const parsed: unknown = await response.json();
      const result = githubTokenResponseSchema.safeParse(parsed);
      if (!result.success)
        throw new Error("github_token_exchange_response_invalid");
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
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
      if (!response.ok)
        throw new Error(`github_user_fetch_failed_${response.status}`);
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

/**
 * Narrow, duck-typed slice of `ReplayPremiereInteractions` (never imported
 * directly — no import cycle) the GitHub callback needs to close the
 * two-tab Sybil race: linking canonicalises identity, but if the browser's
 * OLD guest id already has its own live market account in the currently
 * open premiere, swapping its cookie for a canonical one would strand
 * that account — a live balance nobody can reach, and a second
 * 1,000-credit grant on the next trade under the new id. See
 * `ReplayPremiereInteractions.retireForIdentityLinkIfSafe`.
 */
export interface ReplayPremiereCurrentMarketIdentityGuard {
  retireForIdentityLinkIfSafe(
    participantId: string,
  ): Promise<{ safe: boolean }>;
  releaseIdentityLinkRetirement(participantId: string): Promise<void>;
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
  /**
   * Resolved fresh on every callback (never cached): the currently live
   * premiere's market-identity guard, or `null` when no premiere is
   * currently registered — nothing to strand, always safe. See
   * `ReplayPremiereCurrentMarketIdentityGuard`.
   */
  readonly resolveCurrentMarketIdentityGuard: () => ReplayPremiereCurrentMarketIdentityGuard | null;
}

/** Creates the three GitHub sign-in routes. Callers MUST only mount this when {@link resolveReplayPremiereGithubOAuthConfig} returned non-null — there is no internal disabled-state 404 here, matching "unset env means the route doesn't exist" rather than "exists but always fails". */
export function createReplayPremiereGithubAuthRouter(
  options: ReplayPremiereGithubAuthRouterOptions,
): Router {
  const router = express.Router();
  const redirectUri = `${options.publicOrigin}${REPLAY_PREMIERE_GITHUB_AUTH_CALLBACK_PATH}`;
  const returnPath = options.returnPath ?? "/bet";
  const logError = options.onOperatorError ?? ((): void => {});

  router.get(
    REPLAY_PREMIERE_GITHUB_AUTH_START_PATH,
    (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const guest = options.security.bootstrapRead(
          requestSecurityHeaders(req),
        );
        const { cookie: linkIntentCookie, nonce } =
          options.security.mintLinkIntentCookie(
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
    },
  );

  router.get(
    REPLAY_PREMIERE_GITHUB_AUTH_CALLBACK_PATH,
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      const failClosed = (operatorCode: string, error?: unknown): void => {
        if (error !== undefined) logError(operatorCode, error);
        else logError(operatorCode, new Error(operatorCode));
        res.setHeader(
          "Set-Cookie",
          options.security.clearLinkIntentCookieHeader(),
        );
        res.redirect(302, `${returnPath}?github=error`);
      };
      // Distinct from failClosed's generic `?github=error`: this is not a
      // bug or an outage, it is a deliberate refusal — the client shows a
      // different, specific message (see GithubSignIn.ts's `active_trade`
      // banner) so a tester reads it as "come back later", not "broken".
      const failActiveTrade = (): void => {
        logError(
          "github_auth_active_market_participation",
          new Error("github_auth_active_market_participation"),
        );
        res.setHeader(
          "Set-Cookie",
          options.security.clearLinkIntentCookieHeader(),
        );
        res.redirect(302, `${returnPath}?github=active_trade`);
      };
      let marketGuard: ReplayPremiereCurrentMarketIdentityGuard | null = null;
      let retiredParticipantId: string | null = null;
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
        const state =
          typeof req.query.state === "string" ? req.query.state : null;
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
        // Closes the two-tab Sybil race BEFORE any GitHub round trip: this
        // runs inside the live premiere's own mutation queue, atomically
        // with every order, so a concurrent trade under this exact id can
        // never land after we have decided linking is safe. See
        // `ReplayPremiereInteractions.retireForIdentityLinkIfSafe`.
        marketGuard = options.resolveCurrentMarketIdentityGuard();
        if (marketGuard !== null) {
          const { safe } = await marketGuard.retireForIdentityLinkIfSafe(
            guest.participantId,
          );
          if (!safe) {
            failActiveTrade();
            return;
          }
          retiredParticipantId = guest.participantId;
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
        let result: ReplayPremiereGithubLinkResult;
        try {
          result = await options.identityLinkStore.linkOrMerge(
            guest.participantId,
            githubUser,
          );
        } catch (error) {
          failClosed("github_auth_link_failed", error);
          return;
        }
        if (result.canonicalParticipantId === guest.participantId) {
          // First-ever link for this browser's own id, becoming its own
          // canonical: no identity actually changes hands, so the hold
          // taken above must not stick — this id keeps trading as itself.
          if (marketGuard !== null && retiredParticipantId !== null) {
            await marketGuard.releaseIdentityLinkRetirement(
              retiredParticipantId,
            );
          }
        }
        // Either way, tracking is done: a real swap must stay retired (do
        // NOT release it below), and a same-id resolution was just
        // released above. Clearing this here — success from this point
        // on — is what tells the `finally` below there is nothing left to
        // undo.
        retiredParticipantId = null;
        res.setHeader("Set-Cookie", [
          options.security.clearLinkIntentCookieHeader(),
          options.security.mintGuestCookieForParticipant(
            result.canonicalParticipantId,
          ),
        ]);
        res.redirect(
          302,
          result.leagueClaimReplaced
            ? `${returnPath}?github=linked&claim=replaced`
            : `${returnPath}?github=linked`,
        );
      } catch (error) {
        failClosed("github_auth_callback_failed", error);
      } finally {
        // Any exit above that did NOT explicitly clear this (every
        // failure path after retirement) leaves it set — release so this
        // browser's own id stays tradeable; the link never happened.
        if (marketGuard !== null && retiredParticipantId !== null) {
          try {
            await marketGuard.releaseIdentityLinkRetirement(
              retiredParticipantId,
            );
          } catch (releaseError) {
            logError("github_auth_retirement_release_failed", releaseError);
          }
        }
      }
    },
  );

  router.get(
    REPLAY_PREMIERE_GITHUB_AUTH_STATUS_PATH,
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const guest = options.security.bootstrapRead(
          requestSecurityHeaders(req),
        );
        if (guest.setCookie !== null)
          res.setHeader("Set-Cookie", guest.setCookie);
        const identity = await options.identityLinkStore.getStatus(
          guest.participant.participantId,
        );
        res
          .status(200)
          .json({ schemaVersion: 1, csrfToken: guest.csrfToken, identity });
      } catch (error) {
        logError("github_auth_status_failed", error);
        res.status(503).json({ error: { code: "PREMIERE_UNAVAILABLE" } });
      }
    },
  );

  return router;
}
