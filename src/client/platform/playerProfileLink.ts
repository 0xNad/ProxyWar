/**
 * Shared helper for linking a league row to its player profile.
 *
 * - `playerProfileUrl(name)` — the PUBLIC league standings link to a
 *   league player's profile by their league player name, which is
 *   genuinely unique within the league (`CoworldLeagueSiteWriter`'s
 *   static site, server-rendered, which reads the same
 *   `PROXYWAR_PLATFORM_ORIGIN`).
 * The profile lives on the platform origin, so the result is always an
 * absolute cross-origin URL rather than a path relative to the league host.
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
