/**
 * Generic "talk to GitHub's OAuth + REST API" client — deliberately not
 * owned by betting or the platform: it is pure protocol plumbing (token
 * exchange, `/user` fetch, secret resolution) with no opinion about who
 * calls it or what they do with the resulting `{id, login, avatarUrl}`.
 * `proxywar.xyz` is the only caller today (see
 * `src/server/platform/PlatformGithubAuth.ts`) — GitHub sign-in on the
 * betting/league origins was removed when the platform became the sole
 * account authority.
 */
import { promises as fs } from "node:fs";
import { z } from "zod";

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
/** Bounded wait for the token exchange and `/user` fetch. GitHub accepting a connection and then never answering is a more common real failure than an immediate rejection; without this, the callback (and the browser's tab) would hang indefinitely. */
const DEFAULT_GITHUB_FETCH_TIMEOUT_MS = 10_000;

export interface GithubOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface GithubOAuthUser {
  readonly githubUserId: number;
  readonly login: string;
  readonly avatarUrl: string | null;
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
export async function resolveGithubOAuthConfig(
  environment: Record<string, string | undefined> = process.env,
): Promise<GithubOAuthConfig | null> {
  const clientId = environment[GITHUB_OAUTH_CLIENT_ID_ENV]?.trim();
  if (clientId === undefined || clientId === "") return null;
  const clientSecret = await resolveGithubOAuthClientSecret(environment);
  if (clientSecret === null) return null;
  return { clientId, clientSecret };
}

/** Injectable so tests can stub GitHub's endpoints without real credentials or network access. */
export interface GithubOAuthClient {
  buildAuthorizeUrl(options: { redirectUri: string; state: string }): string;
  exchangeCodeForToken(code: string, redirectUri: string): Promise<string>;
  fetchUser(accessToken: string): Promise<GithubOAuthUser>;
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

/** Real implementation, talking to github.com / api.github.com (or a stub via {@link GITHUB_WEB_BASE_URL_ENV}/{@link GITHUB_API_BASE_URL_ENV}). No scope requested beyond the default (public profile: id/login/avatar). */
export function createGithubOAuthClient(
  config: GithubOAuthConfig,
  environment: Record<string, string | undefined> = process.env,
  /** Injectable so a test can use a few milliseconds instead of stalling the suite for the real default. */
  fetchTimeoutMs: number = DEFAULT_GITHUB_FETCH_TIMEOUT_MS,
): GithubOAuthClient {
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
          "User-Agent": "proxywar-platform",
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
