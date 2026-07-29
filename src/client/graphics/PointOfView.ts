import { z } from "zod";
import { GameEvent } from "../../core/EventBus";
import { GameView, PlayerView } from "../../core/game/GameView";
import { LeagueStandingRow } from "../prediction/wagering/leagueData";
import { PLAYER_PROFILE_ORIGIN } from "../platform/playerProfileLink";

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

async function fetchClaimLineageSlugs(
  fetchImpl: typeof fetch,
  endpoint: string,
  extractClaims: (body: unknown) => readonly { lineageSlug: string }[],
): Promise<readonly string[]> {
  try {
    const response = await fetchImpl(endpoint, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    return extractClaims(body).map((claim) => claim.lineageSlug);
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
 * see `playerProfileLink.ts`'s doc): `app.proxywar.xyz` is a stand-in
 * only until the operator drops the apex's Cloudflare redirect, at which
 * point `proxywar.xyz` itself becomes the platform root and this must
 * keep working WITHOUT a code change — a hostname-prefix check
 * (`startsWith("app.")`) would silently stop matching the day that
 * happens, with no error and nothing to notice. `platformOrigin` is an
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
 * - Everything else, including `beta.*` (the league origin): no
 *   cross-origin handoff integration exists there yet, so a request is
 *   guaranteed to fail. Returns `[]` WITHOUT attempting one — no
 *   request, no console noise, for what is also the common case (most
 *   viewers have linked nothing).
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
      (body) => platformClaimResponseSchema.safeParse(body).data?.claims ?? [],
    );
  }
  if (window.location.hostname.startsWith("bet.")) {
    return fetchClaimLineageSlugs(
      fetchImpl,
      BETTING_ACCOUNT_CLAIM_ENDPOINT,
      (body) =>
        bettingClaimResponseSchema.safeParse(body).data?.identity.claims ?? [],
    );
  }
  return [];
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
