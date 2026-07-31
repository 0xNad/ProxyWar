import { promises as fs } from "node:fs";
import path from "node:path";
import {
  readCoworldLeagueRetentionPinManifest,
  retentionReferencesFromEpisodes,
  writeCoworldLeagueRetentionPinManifest,
  type CoworldLeagueRetentionPin,
} from "./CoworldLeagueArtifactRetention";
import type { CoworldLeagueEpisodeRow } from "./CoworldLeagueSiteWriter";
import type { FeaturedMatch } from "./FeaturedMatch";

/**
 * Retention pins for Featured Matches (product overhaul spec Stage 3 item
 * 7): a Featured Match's underlying PUBLIC artifacts (the rendered league
 * run bundle + cached `.replay`) must survive `coworld-league-prune.ts`'s
 * LRU cleanup for as long as its `/match/:matchId` page is live. This
 * module is the ONLY place that adds or removes a Featured Match's claim —
 * no second pinning system, no direct artifact deletion, ever: it exclusively
 * reads/writes `deploy/coworld-league-retention-pins.json` (or
 * `PROXYWAR_LEAGUE_RETENTION_PINS`) via `CoworldLeagueArtifactRetention.ts`'s
 * shared manifest I/O — the SAME file `replay-premiere-loop.ts`'s own
 * `pinHoldArtifacts`/`unpinHoldArtifacts` already write for the live
 * premiere hold's own (shorter, hold-duration) claim.
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
 *
 * --- Cooperative ownership: why pins carry a `;`-joined reason list ---
 *
 * `parseCoworldLeagueRetentionPins` (the schema's own validator, reused by
 * this module's writer) REJECTS a manifest with two pins sharing the same
 * `episodeRequestId` or `publicRunKey` — one entry per artifact, always.
 * But an episode can legitimately need protection from TWO independent,
 * differently-timed owners: `pinHoldArtifacts`'s own premiere-hold claim
 * (alive only for the admission's own duration — released the moment the
 * premiere reveals) and this module's Featured Match claim (alive for as
 * long as the operator keeps the record featured, independent of the
 * premiere hold's own release timing). Rather than a second file, this
 * module makes ONE pin entry cooperatively owned: `reason` is a `;`-joined
 * list of owner tags (`"premiere-hold:<premiereId>;featured-match:<matchId>"`).
 * `syncFeaturedMatchRetentionPin` APPENDS its own tag to an existing pin's
 * reason (never overwriting another owner's tag), and
 * `removeFeaturedMatchRetentionPin` only strips ITS OWN tag, deleting the
 * pin entry entirely only once no tag remains. This also means
 * `pinHoldArtifacts`'s existing `unpinHoldArtifacts` (which only strips a
 * pin whose reason STARTS WITH its own `"premiere-hold"` prefix) correctly
 * no-ops once a Featured Match tag has been appended — the reason string no
 * longer starts with "premiere-hold" alone, so the hold's own release can
 * never prematurely evict a still-featured match's protection.
 */

const FEATURED_MATCH_REASON_PREFIX = "featured-match";

function featuredMatchTag(matchId: string): string {
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
 * PREPENDS the tag (not appends). This matters: `unpinHoldArtifacts` in
 * `replay-premiere-loop.ts` checks `pin.reason.startsWith("premiere-hold")`
 * — a plain prefix test that does not care what comes AFTER the prefix.
 * Appending `;featured-match:...` after an existing `"premiere-hold:..."`
 * reason would leave the combined string still starting with
 * "premiere-hold", so the hold's own release would still evict it — the
 * exact bug this module exists to avoid. Prepending guarantees the
 * combined reason starts with THIS module's own tag instead, so only
 * `removeFeaturedMatchRetentionPin`'s own targeted removal can strip it;
 * `withRemovedTag` below restores the exact original single-owner string
 * once this module's tag is removed, so the other owner's own prefix
 * check works normally again the moment this claim ends.
 */
function withAppendedTag(reason: string, tag: string): string {
  const tags = reason.split(";").map((entry) => entry.trim());
  return tags.includes(tag) ? reason : [tag, ...tags].join(";");
}

function withRemovedTag(reason: string, tag: string): string | null {
  const remaining = reason
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== tag);
  return remaining.length === 0 ? null : remaining.join(";");
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
 *    nothing at risk of being pruned in the meantime.
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

    const tag = featuredMatchTag(match.matchId);
    const manifest = await readCoworldLeagueRetentionPinManifest(
      pinManifestPath,
    );
    const existing = manifest.pins.find(
      (pin) => pin.episodeRequestId === match.episodeRequestId,
    );
    if (existing !== undefined) {
      const nextReason = withAppendedTag(existing.reason, tag);
      if (nextReason === existing.reason) return false; // already owns it
      const nextPins = manifest.pins.map((pin) =>
        pin === existing ? { ...pin, reason: nextReason } : pin,
      );
      await writeCoworldLeagueRetentionPinManifest(pinManifestPath, {
        schemaVersion: 1,
        pins: nextPins,
      });
      return true;
    }
    const newPin: CoworldLeagueRetentionPin = {
      episodeRequestId: match.episodeRequestId,
      publicRunKey,
      reason: tag,
    };
    await writeCoworldLeagueRetentionPinManifest(pinManifestPath, {
      schemaVersion: 1,
      pins: [...manifest.pins, newPin],
    });
    return true;
  } catch {
    // Best-effort: a broken pin write must never fail the caller (an
    // operator publish action, or a spectator-facing reconcile-on-read).
    return false;
  }
}

/**
 * Removes a Featured Match's retention tag. Never deletes an artifact
 * directly — only strips this module's own tag from the shared pin's
 * `reason`, leaving any other owner's tag (e.g. a still-live premiere
 * hold) fully intact. Best-effort: never throws.
 */
export async function removeFeaturedMatchRetentionPin(
  matchId: string,
  options: FeaturedMatchRetentionPinOptions = {},
): Promise<boolean> {
  try {
    const pinManifestPath =
      options.pinManifestPath ?? resolvePinManifestPath();
    const tag = featuredMatchTag(matchId);
    const manifest = await readCoworldLeagueRetentionPinManifest(
      pinManifestPath,
    );
    let changed = false;
    const nextPins: CoworldLeagueRetentionPin[] = [];
    for (const pin of manifest.pins) {
      if (!pin.reason.split(";").map((entry) => entry.trim()).includes(tag)) {
        nextPins.push(pin);
        continue;
      }
      changed = true;
      const nextReason = withRemovedTag(pin.reason, tag);
      if (nextReason !== null) nextPins.push({ ...pin, reason: nextReason });
    }
    if (!changed) return false;
    await writeCoworldLeagueRetentionPinManifest(pinManifestPath, {
      schemaVersion: 1,
      pins: nextPins,
    });
    return true;
  } catch {
    return false;
  }
}
