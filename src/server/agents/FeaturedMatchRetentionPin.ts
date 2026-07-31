import { promises as fs } from "node:fs";
import path from "node:path";
import {
  addRetentionPinOwner,
  readCoworldLeagueRetentionPinManifest,
  removeRetentionPinOwner,
  retentionReferencesFromEpisodes,
} from "./CoworldLeagueArtifactRetention";
import type { CoworldLeagueEpisodeRow } from "./CoworldLeagueSiteWriter";
import type { FeaturedMatch } from "./FeaturedMatch";

/**
 * Retention pins for Featured Matches (product overhaul spec Stage 3 item
 * 7): a Featured Match's underlying PUBLIC artifacts (the rendered league
 * run bundle + cached `.replay`) must survive `coworld-league-prune.ts`'s
 * LRU cleanup for as long as its `/match/:matchId` page is live. This
 * module is the ONLY place that adds or removes a Featured Match's claim —
 * no second pinning system, no direct artifact deletion, ever: it
 * exclusively reads/writes `deploy/coworld-league-retention-pins.json` (or
 * `PROXYWAR_LEAGUE_RETENTION_PINS`) via
 * `CoworldLeagueArtifactRetention.ts`'s shared
 * `addRetentionPinOwner`/`removeRetentionPinOwner` — the SAME atomic,
 * multi-owner-safe primitive `replay-premiere-loop.ts`'s own
 * `pinHoldArtifacts`/`unpinHoldArtifacts` use for the live premiere hold's
 * own (shorter, hold-duration) claim on the identical file. See that
 * module's own doc for exactly why a bespoke per-caller read-modify-write
 * is unsafe here (two real, opposite-direction bugs were found and fixed
 * in this session before this module reached its current form) — this
 * module now carries NO manifest-mutation logic of its own, only the
 * "what is my own owner tag" and "what publicRunKey does this episode
 * resolve to" concerns.
 *
 * --- Scope traced before writing this: what actually consumes a pin ---
 *
 * `deploy/coworld-league-retention-pins.json` (this module) protects PUBLIC
 * artifacts only — the rendered run bundle under `runsRootDir` (keyed by
 * `publicRunKey`) and the cached `.replay` under `cacheDir` (keyed by
 * `episodeRequestId`), both consumed by `pruneCoworldLeagueMirrorArtifacts`
 * (`coworld-league-prune.ts` / `ai-league-runs-retention.ts`). This is a
 * COMPLETELY SEPARATE mechanism from `<replayPremierePrivateStateRoot>/
 * reclaim-exclude.txt` (`ReplayPremiereTerminalReclamation.ts`'s
 * `loadReplayPremiereReclamationExclusions`), which protects the PRIVATE
 * sealed premiere source and is never touched here — the sealed source
 * keeps its existing delete-on-reveal lifecycle exactly as before. Pinning
 * a Featured Match's public artifacts must never extend the private
 * source's lifetime; it doesn't, because this module writes to a different
 * file consumed by a different reclaimer entirely.
 */

const FEATURED_MATCH_REASON_PREFIX = "featured-match";

function featuredMatchOwnerTag(matchId: string): string {
  return `${FEATURED_MATCH_REASON_PREFIX}:${matchId}`;
}

export interface FeaturedMatchRetentionPinOptions {
  pinManifestPath?: string;
  /** The league mirror's own artifacts root — `resolveDefaultArtifactsRoot()`'s own default when omitted. */
  artifactsRoot?: string;
}

export function resolvePinManifestPath(
  environment: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = environment.PROXYWAR_LEAGUE_RETENTION_PINS?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : path.join(cwd, "deploy", "coworld-league-retention-pins.json");
}

/** Mirrors `feature-candidates.ts`'s own `readLiveMirrorData`: fail open to `null` on any missing/corrupt file — a Featured Match's artifacts simply aren't derivable yet, not an error worth failing an operator CLI over. */
async function readLiveMirrorEpisodes(
  artifactsRoot: string,
): Promise<readonly CoworldLeagueEpisodeRow[] | null> {
  try {
    const raw = await fs.readFile(
      path.join(artifactsRoot, "ai-league-runs", "league", "data.json"),
      "utf8",
    );
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("episodes" in value) ||
      !Array.isArray((value as { episodes: unknown }).episodes)
    ) {
      return null;
    }
    return (value as { episodes: CoworldLeagueEpisodeRow[] }).episodes;
  } catch {
    return null;
  }
}

/**
 * Emits or extends a Featured Match's retention pin. Best-effort by design
 * (never throws) — called from `premiere:publish`'s success path (where a
 * pin failure must never fail the publish itself) AND opportunistically
 * from `FeaturedMatchReconcile.ts`'s reconcile-on-read pass (the "extend"
 * half of the requirement: a premiere-lane record published before its
 * episode has reached the league mirror has no derivable `publicRunKey`
 * yet — see this module's own architecture note — so the very next
 * reconcile pass after the mirror catches up is what actually completes
 * the pin).
 *
 * No-ops (returns `false`) when:
 *  - the record's `episodeRequestId` is null (nothing to key a pin on), or
 *  - no matching episode exists in the live mirror yet — the run bundle
 *    this pin would protect doesn't exist on disk yet either, so there is
 *    nothing at risk of being pruned in the meantime, or
 *  - this match already owns the pin (idempotent).
 */
export async function syncFeaturedMatchRetentionPin(
  match: Pick<FeaturedMatch, "matchId" | "episodeRequestId">,
  options: FeaturedMatchRetentionPinOptions = {},
): Promise<boolean> {
  if (match.episodeRequestId === null) return false;
  try {
    const pinManifestPath =
      options.pinManifestPath ?? resolvePinManifestPath();
    const artifactsRoot =
      options.artifactsRoot ?? path.join(process.cwd(), "artifacts");
    const episodes = await readLiveMirrorEpisodes(artifactsRoot);
    if (episodes === null) return false;
    const references = retentionReferencesFromEpisodes([...episodes]);
    const publicRunKey = references.publicRunKeyByEpisodeRequestId.get(
      match.episodeRequestId,
    );
    if (publicRunKey === undefined) return false;

    return await addRetentionPinOwner(pinManifestPath, {
      episodeRequestId: match.episodeRequestId,
      publicRunKey,
      ownerTag: featuredMatchOwnerTag(match.matchId),
    });
  } catch {
    // Best-effort: a broken pin write must never fail the caller (an
    // operator publish action, or a spectator-facing reconcile-on-read).
    return false;
  }
}

/**
 * Removes a Featured Match's retention tag. Never deletes an artifact
 * directly — only strips this module's own owner tag from the shared
 * pin's `reason`, leaving any other owner's tag (e.g. a still-live
 * premiere hold) fully intact. Best-effort: never throws.
 */
export async function removeFeaturedMatchRetentionPin(
  matchId: string,
  options: FeaturedMatchRetentionPinOptions = {},
): Promise<boolean> {
  try {
    const pinManifestPath =
      options.pinManifestPath ?? resolvePinManifestPath();
    // episodeRequestId isn't known at this call site (premiere:cancel only
    // has matchId), so this needs to find the pin owning this tag rather
    // than address it by episodeRequestId directly — but
    // removeRetentionPinOwner is keyed by episodeRequestId. Resolve it by
    // scanning the manifest for the entry carrying this owner tag.
    const manifest = await readCoworldLeagueRetentionPinManifest(
      pinManifestPath,
    );
    const tag = featuredMatchOwnerTag(matchId);
    const owning = manifest.pins.find((pin) =>
      pin.reason
        .split(";")
        .map((entry) => entry.trim())
        .includes(tag),
    );
    if (owning === undefined) return false;
    return await removeRetentionPinOwner(pinManifestPath, {
      episodeRequestId: owning.episodeRequestId,
      ownerTag: tag,
    });
  } catch {
    return false;
  }
}
