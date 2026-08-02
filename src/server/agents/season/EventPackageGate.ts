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

/**
 * Resolves the winning participant's `playerName` from `match.result` +
 * `match.participants` — `null` when there's no result yet, no winner
 * (a draw/void placement), or the winner's `agentId` doesn't match any
 * current participant (should not happen, but never guessed at).
 */
function winnerPlayerName(match: FeaturedMatch): string | null {
  if (match.result === null || match.result.winnerAgentId === null) return null;
  const winnerAgentId = match.result.winnerAgentId;
  return (
    match.participants.find((participant) => participant.agentId === winnerAgentId)
      ?.playerName ?? null
  );
}

/**
 * 2026-08-01 P0 production review: a title/subtitle containing the
 * winner's name defeats every "Reveal result" disclosure gate anywhere
 * that text renders pre-reveal-click (the Season Zero schedule strip
 * chief among them — it links straight to package prose with no gate of
 * its own). CONSERVATIVE, case-insensitive substring check — Coworld
 * `playerName`s are free text (e.g. "K1Z Mickey Mouse"), so exact-case
 * matching alone would miss trivial re-casing. This deliberately does
 * NOT try to catch a PARAPHRASED spoiler ("the reigning champion just
 * extended..."); it is the same narrow, no-false-negative-on-the-exact-
 * name class of signal `EventPackageProseClaims.ts`'s own checks already
 * are, and is reused there (via `printCompleteness`) for the SAME
 * non-blocking operator warning, not just this gate's hard block.
 */
export function containsWinnerName(text: string, match: FeaturedMatch): boolean {
  const name = winnerPlayerName(match);
  if (name === null || name.trim().length === 0) return false;
  return text.toLowerCase().includes(name.toLowerCase());
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

  // Same state-gate `FeaturedMatchParticipants.ts`'s own
  // `resolveFeaturedMatchParticipantCards` already enforces for
  // participant CARDS ("a record the operator hasn't explicitly
  // published yet never exposes who is in it"): a `candidate`/`scheduled`
  // premiere-lane record must never be publicly promotable, no matter how
  // complete its EventPackage draft is — `premiere:publish`'s state flip
  // is the operator's own "yes, commit to running this" signal, and Phase
  // 5's hero/watch surfaces embed the SAME participant identity + prose
  // this gate guards, so the two embargoes must never disagree.
  if (match.lane === "premiere" && (match.state === "candidate" || match.state === "scheduled")) {
    missing.push("not_yet_published");
  }

  if (match.title.trim().length === 0 || pkg.title.trim().length === 0) {
    missing.push("title");
  }
  if (pkg.subtitle.trim().length === 0) {
    missing.push("subtitle");
  }
  // 2026-08-01 P0: a title/subtitle naming the winner defeats the
  // Reveal-result gate everywhere it renders — see `containsWinnerName`'s
  // own doc. `match.title` is checked alongside `pkg.title` since
  // `ProxyWarPublicReadModel.ts`'s `publicFeaturedMatch` projects
  // `match.title` directly, not `pkg.title`.
  if (containsWinnerName(match.title, match) || containsWinnerName(pkg.title, match)) {
    missing.push("title_spoils_result");
  }
  if (containsWinnerName(pkg.subtitle, match)) {
    missing.push("subtitle_spoils_result");
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
