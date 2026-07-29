/**
 * Shared helper for linking a leaderboard row to its player profile page —
 * used by BOTH leaderboards that lead there: the public league standings
 * (`CoworldLeagueSiteWriter`'s static site, server-rendered, its own
 * matching constant) and the betting points leaderboard
 * (`PointsLeaderboard.ts`, this one).
 *
 * The profile page lives on the platform origin, not wherever the linking
 * leaderboard happens to be served from (bet.proxywar.xyz today,
 * beta.proxywar.xyz for the league site) — so this is always an ABSOLUTE
 * cross-origin URL, never a relative path. `app.proxywar.xyz` is the sole
 * platform/account origin per the identity re-scope; there is exactly one
 * of these per deployment, so a literal constant (matching how
 * `LEAGUE_DATA_URL` is a literal in `leagueData.ts`) is simpler than
 * threading a build-time env var through the client bundle for a value
 * that never varies within an environment.
 */
export const PLAYER_PROFILE_ORIGIN = "https://app.proxywar.xyz";

/** `name` is a raw display name / league player name — never pre-encoded. */
export function playerProfileUrl(name: string): string {
  return `${PLAYER_PROFILE_ORIGIN}/player/${encodeURIComponent(name)}`;
}
