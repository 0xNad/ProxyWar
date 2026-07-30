import { z } from "zod";
import { GameEvent } from "../../core/EventBus";
import { GameView, PlayerView } from "../../core/game/GameView";
import { PLAYER_PROFILE_ORIGIN } from "../platform/playerProfileLink";
import { LeagueStandingRow } from "../prediction/wagering/leagueData";

/**
 * Broadcast whenever the replay/spectator "point of view" — the single
 * agent a viewer is following — changes. `player === null` means no PoV
 * (the ordinary whole-board view). Layers that want to emphasize the
 * followed agent (`TerritoryLayer`'s dim/highlight, `Leaderboard`'s
 * pinned row) subscribe to this on the shared `EventBus`. Deliberately
 * carries no camera intent — see `PointOfViewSelector`'s class doc for
 * why panning is opt-in, never automatic, here.
 */
export class PointOfViewChangeEvent implements GameEvent {
  constructor(public readonly player: PlayerView | null) {}
}

const POV_SESSION_STORAGE_KEY = "pw-pov-follow";
// Distinguishes "the viewer explicitly chose the whole board" (persisted,
// suppresses the claim default for the rest of this session) from "no
// manual choice yet" (absent key — defaults still apply). A plain empty
// string can't carry that distinction: it would be indistinguishable from
// "never set".
const WHOLE_BOARD_SENTINEL = "\0whole-board";

/**
 * The viewer's manual PoV pick for this browser session, if any —
 * `undefined` means no manual choice has been made yet (a default may
 * still apply), `null` means they explicitly chose the whole board
 * (defaults are suppressed for the rest of the session), and a string is
 * the display name of the agent they picked. Session-scoped by design
 * (`sessionStorage`, not `localStorage`): a fresh tab/incognito session
 * starts clean, matching `ReplayPremiereRuntime.ts`'s existing
 * session-persistence convention for viewer-local, non-identity state.
 */
export function readManualPovSelection(): string | null | undefined {
  try {
    const raw = window.sessionStorage.getItem(POV_SESSION_STORAGE_KEY);
    if (raw === null) return undefined;
    return raw === WHOLE_BOARD_SENTINEL ? null : raw;
  } catch {
    return undefined;
  }
}

export function writeManualPovSelection(playerName: string | null): void {
  try {
    window.sessionStorage.setItem(
      POV_SESSION_STORAGE_KEY,
      playerName ?? WHOLE_BOARD_SENTINEL,
    );
  } catch {
    // Best-effort — private browsing or a full storage quota just means
    // the pick doesn't survive a reload; the picker itself still works.
  }
}

const PLATFORM_ACCOUNT_CLAIM_ENDPOINT = "/api/account";
const BETTING_ACCOUNT_CLAIM_ENDPOINT = "/api/premieres/account";
/**
 * The platform's least-privilege, cross-origin-readable slug list — the only
 * account route any sibling origin may read (see `PlatformAccountHttp.ts`).
 * Absolute, because this is the one branch that is deliberately NOT
 * same-origin.
 */
const PLATFORM_POV_CLAIMS_PATH = "/api/account/pov-claims";

// Both origins' claim payloads carry the same shape at the point this
// reads it — an account claims a SET of model LINEAGEs (e.g.
// "daveey-proxywar"), not one exact version and not just one lineage
// ("accounts are for all model" — see `PlatformPolicyClaimStore`'s doc).
// `label` is the specific policy build last associated with each claim
// (e.g. "daveey-proxywar:v24") but is informational only here; matching
// against a running game uses `lineageSlug` (see
// `findPlayerForClaimedLineages`). Array order is already meaningful —
// the server returns claims oldest-claimed-first (see
// `PlatformPolicyClaimStore.getClaims`'s doc) — so picking a default
// among several matches is just "first match in this order", never a
// re-sort here.
const claimSchema = z.object({ lineageSlug: z.string(), label: z.string() });
const claimsSchema = z.array(claimSchema);

// `/api/account` (platform origin) returns the claim set at the top level.
const platformClaimResponseSchema = z.object({ claims: claimsSchema });

// `/api/premieres/account` (betting origin) nests it under `identity` —
// same last-handoff-snapshot claim set, surfaced beside the rest of that
// route's authenticated identity read.
const bettingClaimResponseSchema = z.object({
  identity: z.object({ claims: claimsSchema }),
});

// The cross-origin slug list, already reduced to `lineageSlug` strings
// server-side: no `label` (user-supplied free text) and no timestamps cross
// an origin boundary for a camera default.
const platformPovClaimsResponseSchema = z.object({
  lineageSlugs: z.array(z.string()),
});

async function fetchClaimLineageSlugs(
  fetchImpl: typeof fetch,
  endpoint: string,
  extractSlugs: (body: unknown) => readonly string[],
  // `"include"` ONLY for the deliberate cross-origin league branch. Every
  // same-origin caller stays `"same-origin"`, so a misconfigured endpoint can
  // never quietly start shipping this origin's cookies somewhere else.
  credentials: RequestCredentials = "same-origin",
): Promise<readonly string[]> {
  try {
    const response = await fetchImpl(endpoint, {
      credentials,
      // A GET whose only header is `Accept` is CORS-safelisted, so the
      // cross-origin branch triggers no preflight and the platform mounts no
      // OPTIONS handler. Adding a header here would need one added there.
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    return extractSlugs(body);
  } catch {
    return [];
  }
}

/**
 * Resolves the signed-in viewer's private, self-asserted "these league
 * lineages are mine" claim SET, if any — the ONLY signal available for a
 * default PoV (GitHub proves a handle, never agent ownership). Dispatches
 * on the CURRENT origin rather than a hostname prefix, comparing against
 * the same configured platform origin every other cross-origin platform
 * link uses (`PLAYER_PROFILE_ORIGIN`, from `PROXYWAR_PLATFORM_ORIGIN` —
 * see `playerProfileLink.ts`'s doc). That indirection is why the
 * 2026-07-30 apex cutover needed no change here: a hostname-prefix check
 * (`startsWith("app.")`) would have silently stopped matching the day
 * `proxywar.xyz` itself became the platform root, with no error and
 * nothing to notice. `platformOrigin` is an
 * injected parameter (default `PLAYER_PROFILE_ORIGIN`), exactly like
 * `fetchImpl`, so a test can exercise either origin without needing to
 * fake `process.env` at module-load time.
 *
 * - The platform's own origin: same-origin `GET /api/account`, claims at
 *   the top level.
 * - `bet.*` (betting): same-origin `GET /api/premieres/account`, claims
 *   under `identity.claims` — a snapshot copied at the last platform
 *   handoff, not a live read; it goes stale until the viewer signs in
 *   again, by design, and this deliberately doesn't add a refresh path
 *   or a cache of its own on top of it. Hostname-based, not
 *   origin-configured, because it reads a same-origin betting endpoint —
 *   it does not care what the platform origin is called.
 * - Every other origin, the league mirror (`beta.*`) included: a
 *   CREDENTIALED CROSS-ORIGIN `GET {platformOrigin}/api/account/pov-claims`
 *   — a live read of the platform's own claim set, not a stale local
 *   snapshot. This works without loosening anything because the league,
 *   market and platform origins are cross-ORIGIN but same-SITE (one
 *   registrable domain) and `SameSite` is a site-level control, so the
 *   platform's host-only `SameSite=Lax` session cookie is still sent. Three
 *   things must all hold or it silently yields nothing: the platform
 *   allowlists this exact origin for CORS (it reuses the handoff's
 *   `audience -> origin` map), the serving page's CSP permits the platform
 *   origin in `connect-src` (see `proxyWarLeagueContentSecurityPolicy`), and
 *   the viewer has an existing platform cookie. A viewer who has never
 *   touched the platform gets an empty set and is NOT issued an account.
 *   Unlike the `bet.` branch this needs no handoff on the reading origin at
 *   all — the league stores no session, no account link, and no claim copy.
 *
 * Resolves to `[]` on the platform/bet. branches too on any
 * network/parse failure — no claims is exactly the "no account or no
 * claim" case the picker already has a neutral default for, never an
 * error surfaced to the viewer.
 *
 * Deliberately plain, injectable, stateless functions rather than a
 * class: a future verified owned-policy id can replace the self-asserted
 * claim here (or widen which origins can reach it) without any caller
 * changing.
 */
export async function resolveClaimedLineageSlugs(
  fetchImpl: typeof fetch = fetch,
  platformOrigin: string = PLAYER_PROFILE_ORIGIN,
): Promise<readonly string[]> {
  if (window.location.origin === platformOrigin) {
    return fetchClaimLineageSlugs(
      fetchImpl,
      PLATFORM_ACCOUNT_CLAIM_ENDPOINT,
      (body) =>
        platformClaimResponseSchema
          .safeParse(body)
          .data?.claims.map((claim) => claim.lineageSlug) ?? [],
    );
  }
  if (window.location.hostname.startsWith("bet.")) {
    return fetchClaimLineageSlugs(
      fetchImpl,
      BETTING_ACCOUNT_CLAIM_ENDPOINT,
      (body) =>
        bettingClaimResponseSchema
          .safeParse(body)
          .data?.identity.claims.map((claim) => claim.lineageSlug) ?? [],
    );
  }
  return fetchClaimLineageSlugs(
    fetchImpl,
    `${platformOrigin}${PLATFORM_POV_CLAIMS_PATH}`,
    (body) =>
      platformPovClaimsResponseSchema.safeParse(body).data?.lineageSlugs ?? [],
    "include",
  );
}

/**
 * Joins the viewer's OWNED lineages (already ordered — see
 * `resolveClaimedLineageSlugs`'s doc on why array order is meaningful) to
 * a live participant in the CURRENT game. A claim names a lineage (e.g.
 * "daveey-proxywar"), never one exact build, so a lineage matches any
 * standings row whose policy label (rating, active-champion, or the
 * plain `policyLabel` alias) starts with `<lineageSlug>:v` — then joins
 * that row's `playerName` to a `PlayerView.displayName()` in `game`,
 * mirroring the `playerName === displayName` convention already used
 * elsewhere to correlate the league mirror with a running match (see
 * `resolveSeatStanding`).
 *
 * Returns the player for the FIRST owned lineage (in order) that both
 * has a standings row AND is actually playing in this game — exactly the
 * deterministic default the PoV selector promises: one owned lineage in
 * the match follows it outright; several present resolves to whichever
 * was claimed first (the picker can always override); none present
 * returns `null` — not an error, just nothing to follow by default.
 */
export function findPlayerForClaimedLineages(
  game: GameView,
  standings: readonly LeagueStandingRow[],
  lineageSlugs: readonly string[],
): PlayerView | null {
  for (const lineageSlug of lineageSlugs) {
    const prefix = `${lineageSlug}:v`;
    const matchesLineage = (label: string | null): boolean =>
      label !== null && label.startsWith(prefix);
    const standing = standings.find(
      (s) =>
        matchesLineage(s.policyLabel) ||
        matchesLineage(s.ratingPolicyLabel) ||
        matchesLineage(s.activeChampionPolicyLabel),
    );
    if (standing === undefined) continue;
    const player = game
      .playerViews()
      .find((p) => p.displayName() === standing.playerName);
    if (player !== undefined) return player;
  }
  return null;
}
