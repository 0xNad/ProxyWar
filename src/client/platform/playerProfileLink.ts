/**
 * Shared helpers for linking a leaderboard row to its profile page. Two
 * DIFFERENT namespaces, deliberately never merged:
 *
 * - `playerProfileUrl(name)` — the PUBLIC league standings link to a
 *   league player's profile by their league player name, which is
 *   genuinely unique within the league (`CoworldLeagueSiteWriter`'s
 *   static site, server-rendered, which reads the same
 *   `PROXYWAR_PLATFORM_ORIGIN`).
 * - `accountProfileUrl(accountId)` — the betting points leaderboard
 *   (`PointsLeaderboard.ts`) links a genuinely LINKED row to that
 *   account's own profile by its stable, opaque platform `accountId`,
 *   NEVER by display name: `PlatformAccountStore.setDisplayName` never
 *   enforces uniqueness, so two linked accounts can share a display
 *   name, and a league player and an account are only the same person by
 *   a claim nobody here can verify. Matching on the free-text name used
 *   to be how this leaderboard linked out; that was unsound (see
 *   `BettingPlatformAccountLinkStore.getByPlatformAccountId`'s doc).
 *
 * Both profile pages live on the platform origin, not wherever the
 * linking leaderboard happens to be served from (bet.proxywar.xyz today,
 * beta.proxywar.xyz for the league site) — so both are always ABSOLUTE
 * cross-origin URLs, never relative paths.
 */
import { DEFAULT_PLATFORM_ORIGIN } from "../../core/PlatformOrigin";

// The expression must be EXACTLY `process.env.PROXYWAR_PLATFORM_ORIGIN` to
// match Vite's literal `define` key. Optional chaining (`process?.env?.X`)
// silently defeats the substitution and then throws ReferenceError in the
// browser, since `process` is not a global there — the same latent trap that
// exists in `Api.ts`, which only survives because its use sits inside a
// localhost-only branch.
const CONFIGURED_PLATFORM_ORIGIN = process.env.PROXYWAR_PLATFORM_ORIGIN;

export const PLAYER_PROFILE_ORIGIN =
  typeof CONFIGURED_PLATFORM_ORIGIN === "string" &&
  CONFIGURED_PLATFORM_ORIGIN !== ""
    ? CONFIGURED_PLATFORM_ORIGIN
    : DEFAULT_PLATFORM_ORIGIN;

/** `name` is a raw display name / league player name — never pre-encoded. */
export function playerProfileUrl(name: string): string {
  return `${PLAYER_PROFILE_ORIGIN}/player/${encodeURIComponent(name)}`;
}

/** `accountId` is the platform's opaque `acct_<hex>` id — never a display name. */
export function accountProfileUrl(accountId: string): string {
  return `${PLAYER_PROFILE_ORIGIN}/trader/${encodeURIComponent(accountId)}`;
}
