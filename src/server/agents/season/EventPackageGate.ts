import type { FeaturedMatch } from "../FeaturedMatch";
import type { EventPackage } from "./EventPackage";

/**
 * Season Zero activation prompt Phase 4 ("No anonymous public Premiere",
 * spec §2) — THE single authority every public promotion surface (hero,
 * watch programme, schedule) must consult before treating a
 * `FeaturedMatch` as a complete Featured Event. An anonymous System-B
 * premiere (`replay-premiere-loop.ts`'s continuous roll, surfaced only as
 * `CoworldLeaguePremiereCard`'s five spoiler-safe fields — map/round/time,
 * no title, no reason to watch) NEVER has a backing `EventPackage` at all
 * and therefore never passes this gate — it keeps running, stays
 * reachable by its own direct `/premiere/:id` URL (honest content), but
 * `ProxyWarPublicReadModel.ts`'s projection must never let it masquerade
 * as the promoted hero/flagship. See that module's `publicFeaturedMatch`
 * for the one wiring point this function feeds.
 *
 * Pure and synchronous by design: every fact it checks either lives on
 * `FeaturedMatch` itself (participants already resolved to
 * `agentId`/`agentVersionId` by whichever CLI built the record — see
 * `feature-candidates.ts`'s `buildParticipants`) or on the `EventPackage`
 * passed in — no registry/mirror I/O here, so callers control exactly
 * when a package lookup happens (see `EventPackage.findEventPackage`).
 */
export interface PublicPromotionCheck {
  ok: boolean;
  /** Named, stable reasons — one entry per missing/inconsistent field, `participant_*` entries carry the offending `playerName` so an operator can act on the message directly. Empty iff `ok`. */
  missing: string[];
}

/**
 * A premiere-lane record's outcome is public only once the runtime has
 * actually revealed it — same rule `ProxyWarPublicReadModel.ts`'s own
 * `isFeaturedMatchRevealed` enforces for `result`; duplicated here (not
 * imported) because that function is not exported and this module
 * intentionally has zero dependency on the read-model file to avoid a
 * cycle (the read model is this gate's own consumer). Exported so
 * `premiere-package.ts` can compute the SAME default `embargoState`
 * rather than re-deriving a third copy.
 */
export function isFeaturedEventRevealed(match: FeaturedMatch): boolean {
  return match.lane === "archive" || match.state === "revealed" || match.state === "archived";
}

export function isPubliclyPromotable(
  match: FeaturedMatch,
  pkg: EventPackage | null,
): PublicPromotionCheck {
  if (pkg === null) {
    return { ok: false, missing: ["event_package_missing"] };
  }
  if (pkg.featuredMatchId !== match.matchId) {
    return { ok: false, missing: ["event_package_mismatched_featured_match_id"] };
  }

  const missing: string[] = [];

  if (match.title.trim().length === 0 || pkg.title.trim().length === 0) {
    missing.push("title");
  }
  if (pkg.subtitle.trim().length === 0) {
    missing.push("subtitle");
  }
  if (pkg.reasonToWatch.claims.length === 0) {
    missing.push("reason_to_watch");
  }
  if (match.lane === "premiere" && match.episodeRequestId === null) {
    missing.push("canonical_episode_reference");
  }
  if (match.participants.length === 0) {
    missing.push("participants");
  }
  for (const participant of match.participants) {
    if (participant.agentId === null) {
      missing.push(`participant_identity_unresolved:${participant.playerName}`);
    }
    if (participant.agentVersionId === null) {
      missing.push(`participant_version_unresolved:${participant.playerName}`);
    }
  }
  if (match.map.trim().length === 0 || pkg.mapLabel.trim().length === 0) {
    missing.push("map");
  }
  if (match.format.trim().length === 0 || pkg.format.trim().length === 0) {
    missing.push("format");
  }
  if (match.lane === "premiere" && (match.scheduledAt === null || pkg.scheduledAt === null)) {
    missing.push("scheduled_time");
  }
  if (pkg.directorCutEstimateSeconds === null) {
    missing.push("director_cut_estimate");
  }
  if (pkg.canonicalMatchUrl.trim().length === 0) {
    missing.push("canonical_match_url");
  }
  if (
    match.lane === "premiere" &&
    (pkg.canonicalPremiereUrl === null || pkg.canonicalPremiereUrl.trim().length === 0)
  ) {
    missing.push("canonical_premiere_url");
  }
  if (pkg.embargoState === "revealed" && !isFeaturedEventRevealed(match)) {
    missing.push("embargo_state_inconsistent");
  }

  return { ok: missing.length === 0, missing };
}
