import { z } from "zod";
import { GameEvent } from "../../core/EventBus";
import { GameView, PlayerView } from "../../core/game/GameView";
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

// Both origins' claim payloads carry the same shape at the point this
// reads it — a person claims a whole model LINEAGE (e.g.
// "daveey-proxywar"), not one exact version. `label` is the specific
// policy build last associated with the claim (e.g.
// "daveey-proxywar:v24") but is informational only here; matching
// against a running game uses `lineageSlug` (see
// `findPlayerForClaimedLineage`).
const claimSchema = z
  .object({ lineageSlug: z.string(), label: z.string() })
  .nullable();

// `/api/account` (platform origin) returns the claim at the top level.
const platformClaimResponseSchema = z.object({ claim: claimSchema });

// `/api/premieres/account` (betting origin) nests it under `identity` —
// same last-handoff-snapshot claim, surfaced beside the rest of that
// route's authenticated identity read.
const bettingClaimResponseSchema = z.object({
  identity: z.object({ claim: claimSchema }),
});

async function fetchClaimLineageSlug(
  fetchImpl: typeof fetch,
  endpoint: string,
  extractClaim: (body: unknown) => { lineageSlug: string } | null,
): Promise<string | null> {
  try {
    const response = await fetchImpl(endpoint, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return extractClaim(body)?.lineageSlug ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the signed-in viewer's private, self-asserted "this league
 * lineage is mine" claim, if any — the ONLY signal available for a
 * default PoV (GitHub proves a handle, never agent ownership). Both
 * account origins carry it behind a host-only cookie, so this dispatches
 * on which origin the replay is actually running on rather than probing:
 *
 * - `app.*` (platform): same-origin `GET /api/account`, claim at the
 *   top level.
 * - `bet.*` (betting): same-origin `GET /api/premieres/account`, claim
 *   under `identity.claim` — a snapshot copied at the last platform
 *   handoff, not a live read; it goes stale until the viewer signs in
 *   again, by design, and this deliberately doesn't add a refresh path
 *   or a cache of its own on top of it.
 * - Everything else, including `beta.*` (the league origin): no
 *   cross-origin handoff integration exists there yet, so a request is
 *   guaranteed to fail. Returns `null` WITHOUT attempting one — no
 *   request, no console noise, for what is also the common case (most
 *   viewers have linked nothing).
 *
 * Resolves to `null` on the app./bet. branches too on any network/parse
 * failure — a missing claim is exactly the "no account or no claim" case
 * the picker already has a neutral default for, never an error surfaced
 * to the viewer.
 *
 * Deliberately plain, injectable, stateless functions rather than a
 * class: a future verified owned-policy id can replace the self-asserted
 * claim here (or widen which origins can reach it) without any caller
 * changing.
 */
export async function resolveClaimedLineageSlug(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const hostname = window.location.hostname;
  if (hostname.startsWith("app.")) {
    return fetchClaimLineageSlug(
      fetchImpl,
      PLATFORM_ACCOUNT_CLAIM_ENDPOINT,
      (body) => platformClaimResponseSchema.safeParse(body).data?.claim ?? null,
    );
  }
  if (hostname.startsWith("bet.")) {
    return fetchClaimLineageSlug(
      fetchImpl,
      BETTING_ACCOUNT_CLAIM_ENDPOINT,
      (body) =>
        bettingClaimResponseSchema.safeParse(body).data?.identity.claim ??
        null,
    );
  }
  return null;
}

/**
 * Joins a claimed lineage to a live participant in the CURRENT game, via
 * the public league mirror. A claim names a lineage (e.g.
 * "daveey-proxywar"), never one exact build, so this matches any
 * standings row whose policy label (rating, active-champion, or the
 * plain `policyLabel` alias) starts with `<lineageSlug>:v` — then joins
 * that row's `playerName` to a `PlayerView.displayName()` in `game`,
 * mirroring the `playerName === displayName` convention already used
 * elsewhere to correlate the league mirror with a running match (see
 * `resolveSeatStanding`). Returns `null` when the claimed lineage has no
 * standings row, or isn't a participant in this particular game — an
 * unmatched claim is not an error, just nothing to follow by default.
 */
export function findPlayerForClaimedLineage(
  game: GameView,
  standings: readonly LeagueStandingRow[],
  lineageSlug: string,
): PlayerView | null {
  const prefix = `${lineageSlug}:v`;
  const matchesLineage = (label: string | null): boolean =>
    label !== null && label.startsWith(prefix);
  const standing = standings.find(
    (s) =>
      matchesLineage(s.policyLabel) ||
      matchesLineage(s.ratingPolicyLabel) ||
      matchesLineage(s.activeChampionPolicyLabel),
  );
  if (standing === undefined) return null;
  return (
    game.playerViews().find((p) => p.displayName() === standing.playerName) ??
    null
  );
}
