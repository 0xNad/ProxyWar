import type {
  CoworldLeagueEpisodeRow,
  CoworldLeagueStandingRow,
} from "../CoworldLeagueSiteWriter";
import type { IdentityRegistrySnapshot } from "../../identity/IdentityRegistry";
import type { FeaturedMatchParticipant } from "../FeaturedMatch";
import type { AgentVersion } from "../../identity/IdentitySchemas";
import type { EventPackageClaim } from "./EventPackage";

/**
 * Season Zero activation prompt Phase 4 item 3 ("Featured Event
 * selection" / "Candidate evidence upgrade"): "The candidate system
 * should emit evidence, not merely a score" — good: "Auri v43 debuts
 * after v42 won four of its last five retained matches. It faces
 * Sefirot, whose Pangaea record is stronger over a sufficient sample.";
 * bad: "Exciting match on Pangaea."
 *
 * Every claim this module emits is grounded in ONE of three real,
 * already-computed data sources — never a generated adjective:
 *
 * 1. `standings_rank` — the participant's CURRENT rank/score in
 *    `CoworldLeagueStandingRow[]` (the live Coworld standings mirror).
 * 2. `version_debut` — `AgentVersion.firstObservedAt` (registry
 *    provenance, "the mirror's own observation date" — see that field's
 *    own doc) recent enough to call a debut, paired with the AGENT's
 *    (not the specific prior version's — see note below) recent
 *    win/loss record across retained episodes.
 * 3. `head_to_head` — win counts between exactly two participants across
 *    every retained episode where both played, preferring a MAP-specific
 *    sample (matching the doc's own "Pangaea record" example) when one
 *    exists, falling back to the all-map sample otherwise.
 *
 * Honesty note on `version_debut`: `CoworldLeagueEpisodeRow` records a
 * participant by `playerName` only, never by exact policy version — there
 * is no way to isolate "wins specifically attributed to the PRIOR
 * version" from retained history without inventing per-episode version
 * tagging this codebase does not have. The claim below therefore
 * attributes recent form to the AGENT across its retained episodes, not
 * to one specific prior version — a real, checkable number, just a
 * coarser one than the doc's own illustrative example. Never widened
 * into a version-specific claim the data can't actually support.
 */

/** A version counts as a notable debut when first observed within this many days of "now" — matches the spec's own "one flagship Featured Event per week" cadence: a version more than two cycles old is no longer fresh news. */
const RECENT_DEBUT_WINDOW_DAYS = 14;
/** Sample size for a participant's own "recent form" claim. */
const RECENT_FORM_SAMPLE = 5;
/** Minimum retained meetings before a head-to-head claim is worth stating at all — below this a "record" is not a meaningful sample. */
const MIN_HEAD_TO_HEAD_SAMPLE = 2;
/** A standings rank at or above this position is notable enough to cite on its own. */
const TOP_RANK_THRESHOLD = 8;

function daysBetween(laterIso: string, earlierIso: string): number {
  return (Date.parse(laterIso) - Date.parse(earlierIso)) / (24 * 60 * 60 * 1000);
}

function retainedEpisodesForPlayer(
  episodes: readonly CoworldLeagueEpisodeRow[],
  playerName: string,
): CoworldLeagueEpisodeRow[] {
  return episodes
    .filter(
      (episode) =>
        episode.completedAt !== null &&
        episode.players.some((player) => player.name === playerName),
    )
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
}

function winCountFor(episodes: readonly CoworldLeagueEpisodeRow[], playerName: string): number {
  return episodes.filter((episode) =>
    episode.players.some((player) => player.name === playerName && player.isWinner),
  ).length;
}

function versionDebutClaim(
  participant: FeaturedMatchParticipant,
  version: AgentVersion,
  displayName: string,
  episodes: readonly CoworldLeagueEpisodeRow[],
  now: Date,
): EventPackageClaim | null {
  if (version.firstObservedAt === null) return null;
  if (daysBetween(now.toISOString(), version.firstObservedAt) > RECENT_DEBUT_WINDOW_DAYS) {
    return null;
  }
  const recent = retainedEpisodesForPlayer(episodes, participant.playerName).slice(
    0,
    RECENT_FORM_SAMPLE,
  );
  const wins = winCountFor(recent, participant.playerName);
  const formClause =
    recent.length > 0
      ? ` after winning ${wins} of its last ${recent.length} retained match${recent.length === 1 ? "" : "es"}`
      : "";
  return {
    text: `${displayName} debuts ${version.publicVersionLabel} (first observed ${version.firstObservedAt})${formClause}.`,
    source: "version_debut",
    reference: `version:${version.id}:firstObservedAt=${version.firstObservedAt}`,
  };
}

function standingsRankClaim(
  playerName: string,
  displayName: string,
  standings: readonly CoworldLeagueStandingRow[],
): EventPackageClaim | null {
  const row = standings.find((entry) => entry.playerName === playerName);
  if (row === undefined || row.rank > TOP_RANK_THRESHOLD) return null;
  return {
    text: `${displayName} enters ranked #${row.rank} in the current Coworld standings${row.score === null ? "" : ` (score ${row.score})`}.`,
    source: "standings_rank",
    reference: `standings:${playerName}:rank=${row.rank}`,
  };
}

function headToHeadClaim(
  participants: readonly FeaturedMatchParticipant[],
  displayNameByPlayerName: ReadonlyMap<string, string>,
  episodes: readonly CoworldLeagueEpisodeRow[],
  currentMap: string,
): EventPackageClaim | null {
  if (participants.length !== 2) return null;
  const [a, b] = participants;
  const bothPlayed = (episode: CoworldLeagueEpisodeRow): boolean =>
    episode.completedAt !== null &&
    episode.players.some((player) => player.name === a.playerName) &&
    episode.players.some((player) => player.name === b.playerName);

  const allMeetings = episodes.filter(bothPlayed);
  const mapMeetings = allMeetings.filter((episode) => episode.map === currentMap);
  const useMapSample = mapMeetings.length >= MIN_HEAD_TO_HEAD_SAMPLE;
  const sample = useMapSample ? mapMeetings : allMeetings;
  if (sample.length < MIN_HEAD_TO_HEAD_SAMPLE) return null;

  const winsA = winCountFor(sample, a.playerName);
  const winsB = winCountFor(sample, b.playerName);
  const nameA = displayNameByPlayerName.get(a.playerName) ?? a.playerName;
  const nameB = displayNameByPlayerName.get(b.playerName) ?? b.playerName;
  const sampleLabel = useMapSample ? `on ${currentMap}` : "across all retained maps";
  const episodeIds = sample.map((episode) => episode.episodeRequestId).join(",");
  return {
    text: `${nameA} leads the head-to-head ${winsA}-${winsB} against ${nameB} ${sampleLabel} across ${sample.length} retained meeting${sample.length === 1 ? "" : "s"}.`,
    source: "head_to_head",
    reference: `head_to_head:${a.playerName}_vs_${b.playerName}:episodes=${episodeIds}`,
  };
}

/**
 * Builds every evidence-backed claim this pass can honestly support for
 * one candidate `FeaturedMatch`'s participant set. Returns `[]` (never a
 * fabricated filler claim) when participants are unresolved (e.g. the
 * sealed premiere-queue lane, which never opens `bundle.source.json` —
 * see `premiere-candidates.ts`'s own doc) or when no signal clears its
 * sample-size floor.
 */
export function buildReasonToWatchClaims(
  participants: readonly FeaturedMatchParticipant[],
  currentMap: string,
  identity: IdentityRegistrySnapshot,
  standings: readonly CoworldLeagueStandingRow[],
  episodes: readonly CoworldLeagueEpisodeRow[],
  now: Date = new Date(),
): EventPackageClaim[] {
  const claims: EventPackageClaim[] = [];
  const displayNameByPlayerName = new Map<string, string>();
  for (const participant of participants) {
    const agent = identity.agents.find((entry) => entry.id === participant.agentId);
    displayNameByPlayerName.set(participant.playerName, agent?.displayName ?? participant.playerName);
  }

  for (const participant of participants) {
    const displayName = displayNameByPlayerName.get(participant.playerName) ?? participant.playerName;
    const rankClaim = standingsRankClaim(participant.playerName, displayName, standings);
    if (rankClaim !== null) claims.push(rankClaim);

    if (participant.agentVersionId !== null) {
      const version = identity.versions.find((entry) => entry.id === participant.agentVersionId);
      if (version !== undefined) {
        const debutClaim = versionDebutClaim(participant, version, displayName, episodes, now);
        if (debutClaim !== null) claims.push(debutClaim);
      }
    }
  }

  const h2h = headToHeadClaim(participants, displayNameByPlayerName, episodes, currentMap);
  if (h2h !== null) claims.push(h2h);

  return claims;
}
