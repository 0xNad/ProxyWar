/**
 * Shared helper for linking a leaderboard row to its player profile page —
 * used by BOTH leaderboards that lead there: the public league standings
 * (`CoworldLeagueSiteWriter`'s static site, server-rendered, which reads the
 * same `PROXYWAR_PLATFORM_ORIGIN`) and the betting points leaderboard
 * (`PointsLeaderboard.ts`, this one).
 *
 * The profile page lives on the platform origin, not wherever the linking
 * leaderboard happens to be served from (bet.proxywar.xyz today,
 * beta.proxywar.xyz for the league site) — so this is always an ABSOLUTE
 * cross-origin URL, never a relative path.
 *
 * Injected at build time rather than hardcoded, because the platform origin
 * IS going to move: `app.proxywar.xyz` is a stand-in while a Cloudflare
 * redirect rule still owns the apex, and the intent is for `proxywar.xyz`
 * itself to become the platform root. A literal here would have meant every
 * shipped bundle and every server-rendered league anchor kept pointing at
 * `app.` forever, turning a one-line ingress change into a code change —
 * which is exactly the trap this comment used to argue for.
 */
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
    : "https://app.proxywar.xyz";

/** `name` is a raw display name / league player name — never pre-encoded. */
export function playerProfileUrl(name: string): string {
  return `${PLAYER_PROFILE_ORIGIN}/player/${encodeURIComponent(name)}`;
}
