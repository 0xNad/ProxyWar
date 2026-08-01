import { promises as fs } from "node:fs";
import path from "node:path";
import {
  publicRunKeyFromFullRenderHref,
  publicRunKeyFromWatchHref,
} from "./CoworldLeagueArtifactRetention";
import type { FeaturedMatchParticipantCard } from "./FeaturedMatchParticipants";
import type {
  CoworldLeagueEpisodePlayerRow,
  CoworldLeagueEpisodeRow,
} from "./CoworldLeagueSiteWriter";
import { generateEmblemSvg } from "../identity/IdentityEmblems";
import { resolveAgentIdentityView } from "../identity/IdentityMatching";
import type { IdentityRegistrySnapshot } from "../identity/IdentityRegistry";

/**
 * Product overhaul: canonical match pages for ORDINARY league episodes
 * (the `CoworldLeagueEpisodeRow[]` the hosted Coworld mirror downloads —
 * see `CoworldLeagueMirrorCore.ts`'s `buildEpisodeRow`), not just
 * `FeaturedMatch` records. Backs the narrow `GET /api/matches/:episodeId`
 * route in `ai-agent-demo-server.ts`, exactly parallel to
 * `FeaturedMatchParticipants.ts`/`loadFeaturedMatchDetail` for the
 * `feat_...`-namespaced store: one record, resolved by its own stable
 * public id (`episodeRequestId`, Coworld's own `ereq_...` id — already
 * the same value `ProxyWarPublicReadModel.ts`'s `publicMatch()` uses as
 * `PublicMatch.matchId`, so no new id space is introduced).
 *
 * Every field below is either already public on `data.json`/
 * `read-model.json` (participants, placements, map, turn/decision/
 * degraded counts, hrefs, Director Cut summary) or derived from
 * `match-story.md` — the ONE recap artifact on the public run-artifact
 * allowlist (`ProxyWarPublicArtifacts.ts`; `match-story.json`,
 * `drama-report.json`, and `decisions.jsonl` are NOT, so this module never
 * reads them). See `readLeagueEpisodeRecap`'s own doc for why hosted
 * league episodes almost never have one.
 */

export interface LeagueEpisodeMatchPagePlayer {
  slot: number;
  name: string;
  tilesOwned: number;
  isAlive: boolean;
  isWinner: boolean;
  color: string;
  /** 1-based finish order: winner first, then tiles owned desc, then slot asc — same comparator `feature-candidates.ts`'s `buildResult` and `CoworldLeagueSiteWriter.ts`'s `battleCard` already sort by. */
  placement: number;
}

/** Excerpted verbatim from `match-story.md` — see that file's own doc. `null` whenever no real artifact backs it (never a placeholder). */
export interface LeagueEpisodeRecap {
  summary: string;
  beats: string[];
}

export interface LeagueEpisodeMatchPageModel {
  episodeRequestId: string;
  shortId: string;
  /** The mirror's internal `league-<runID>` (or fixture) run key, when derivable from `watchHref`/`fullRenderHref` — the same key the technical drawer and `findArtifactDirectory`-style lookups use. */
  runKey: string | null;
  roundNumber: number | null;
  completedAt: string | null;
  map: string;
  mapSize: string;
  turnCount: number | null;
  decisionCount: number | null;
  degradedCount: number | null;
  winnerName: string | null;
  players: LeagueEpisodeMatchPagePlayer[];
  watchHref: string | null;
  fullRenderHref: string | null;
  premiereHref: string | null;
  directorCut: { durationEstimateSeconds: number; segmentCount: number } | null;
  recap: LeagueEpisodeRecap | null;
}

/** Reads `data.json`'s `episodes` array with the same tolerant, cast-after-shape-check pattern `FeaturedMatchRetentionPin.ts`/`coworld-league-mirror.ts` already use for this exact file — `null` for anything short of "a JSON object with an `episodes` array" (missing mirror cycle, corrupt write, etc.), never a thrown error. */
export async function readCoworldLeagueEpisodesFromDataJson(
  dataJsonPath: string,
): Promise<readonly CoworldLeagueEpisodeRow[] | null> {
  try {
    const raw = await fs.readFile(dataJsonPath, "utf8");
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("episodes" in value) ||
      !Array.isArray(value.episodes)
    ) {
      return null;
    }
    // `data.json` is written exclusively by this same process's own
    // `CoworldLeagueSiteWriter.ts` from `CoworldLeagueEpisodeRow[]` — same
    // tolerant, shape-checked-then-trusted cast `FeaturedMatchRetentionPin.ts`
    // and `coworld-league-mirror.ts`'s `readPreviousMirrorData` already use
    // for this exact file; a full runtime schema is unwarranted for a
    // same-process artifact this narrowly consumed.
    const episodes = value.episodes as CoworldLeagueEpisodeRow[];
    return episodes;
  } catch {
    return null;
  }
}

export function findLeagueEpisodeByRequestId(
  episodes: readonly CoworldLeagueEpisodeRow[],
  episodeRequestId: string,
): CoworldLeagueEpisodeRow | null {
  return (
    episodes.find(
      (episode) => episode.episodeRequestId === episodeRequestId,
    ) ?? null
  );
}

/** Same derivation `feature-candidates.ts`'s `findArtifactDirectory` already uses: the mirror's own managed run key, recovered from whichever href is present. `null` when neither href is a well-formed managed run link (replay never downloaded). */
export function leagueEpisodeRunKey(row: CoworldLeagueEpisodeRow): string | null {
  return (
    publicRunKeyFromFullRenderHref(row.fullRenderHref) ??
    publicRunKeyFromWatchHref(row.watchHref)
  );
}

export function findLeagueEpisodeRunDir(
  row: CoworldLeagueEpisodeRow,
  runsRootDir: string,
): string | null {
  const runKey = leagueEpisodeRunKey(row);
  return runKey === null ? null : path.join(runsRootDir, runKey);
}

function episodeParticipantCard(
  player: CoworldLeagueEpisodePlayerRow,
  identity: IdentityRegistrySnapshot,
): FeaturedMatchParticipantCard {
  const view = resolveAgentIdentityView(
    {
      playerName: player.name,
      ratingPolicyLabel: null,
      activeChampionPolicyLabel: null,
    },
    identity.agents,
    identity.builders,
    identity.versions,
  );
  return {
    playerName: player.name,
    displayName: view.agent?.displayName ?? player.name,
    agentSlug: view.agent?.slug ?? null,
    emblemSvg: view.agent === null ? null : generateEmblemSvg(view.agent.id),
    primaryColor: view.agent?.primaryColor ?? null,
    secondaryColor: view.agent?.secondaryColor ?? null,
    versionLabel: view.version?.publicVersionLabel ?? null,
    builderId: view.builder?.id ?? null,
    builderDisplayName: view.builder?.displayName ?? null,
  };
}

/**
 * Resolves every episode participant to the SAME `FeaturedMatchParticipantCard`
 * shape `/api/featured-matches/:matchId` already returns (playerName-based
 * lookup via `resolveAgentIdentityView`, exactly like `battleCard()` in
 * `CoworldLeagueSiteWriter.ts` and `buildParticipants()` in
 * `feature-candidates.ts`) — a registered agent gets emblem/slug/version/
 * builder; an unmapped player name falls back to a provisional card
 * (`displayName` = raw `playerName`, every identity field `null`), never
 * fabricated. Order matches `row.players` (slot order), so the client can
 * zip this array against `LeagueEpisodeMatchPageModel.players` by
 * `playerName`/`name`.
 */
export function buildLeagueEpisodeParticipantCards(
  row: CoworldLeagueEpisodeRow,
  identity: IdentityRegistrySnapshot,
): FeaturedMatchParticipantCard[] {
  return row.players.map((player) => episodeParticipantCard(player, identity));
}

function placementOrderedPlayers(
  row: CoworldLeagueEpisodeRow,
): LeagueEpisodeMatchPagePlayer[] {
  return [...row.players]
    .sort(
      (left, right) =>
        Number(right.isWinner) - Number(left.isWinner) ||
        right.tilesOwned - left.tilesOwned ||
        left.slot - right.slot,
    )
    .map((player, index) => ({ ...player, placement: index + 1 }));
}

export function buildLeagueEpisodeMatchPageModel(
  row: CoworldLeagueEpisodeRow,
  recap: LeagueEpisodeRecap | null,
): LeagueEpisodeMatchPageModel {
  return {
    episodeRequestId: row.episodeRequestId,
    shortId: row.shortId,
    runKey: leagueEpisodeRunKey(row),
    roundNumber: row.roundNumber,
    completedAt: row.completedAt,
    map: row.map,
    mapSize: row.mapSize,
    turnCount: row.turnCount,
    decisionCount: row.decisionCount,
    degradedCount: row.degradedCount,
    winnerName: row.winnerName,
    players: placementOrderedPlayers(row),
    watchHref: row.watchHref,
    fullRenderHref: row.fullRenderHref,
    premiereHref: row.premiereHref ?? null,
    directorCut: row.directorCut ?? null,
    recap,
  };
}

const maximumMatchStoryMarkdownBytes = 2 * 1024 * 1024;
const NO_HIGHLIGHTS_PLACEHOLDER = "No spectator highlights were generated.";

function extractMarkdownSection(
  markdown: string,
  heading: string,
  nextHeading: string,
): string | null {
  const pattern = new RegExp(
    `## ${heading}\\n\\n([\\s\\S]*?)\\n\\n## ${nextHeading}`,
  );
  return pattern.exec(markdown)?.[1] ?? null;
}

/**
 * Parses the EXACT structure `agentMatchStoryMarkdown` (`AgentMatchStory.ts`)
 * writes — the "Spectator Summary" paragraph (after its stat-bullet block)
 * and the "Highlights" bullet list — never reaches into `match-story.json`'s
 * internal fields (`AgentMatchStoryBeat.reason` etc. are NOT audited for
 * public re-exposure; `match-story.json` isn't even on
 * `ProxyWarPublicArtifacts.ts`'s allowlist). Every excerpted string is byte-
 * identical to content this repo already serves anonymously over HTTP as
 * `match-story.md`. Returns `null` when the summary paragraph is empty AND
 * every highlight is the "none generated" placeholder — an artifact that
 * technically exists but carries no real recap content, same "never a
 * fabricated placeholder" rule the rest of this codebase follows.
 */
export function parseMatchStoryMarkdown(raw: string): LeagueEpisodeRecap | null {
  const summarySection = extractMarkdownSection(
    raw,
    "Spectator Summary",
    "Highlights",
  );
  const summaryParagraphs = (summarySection ?? "")
    .split("\n\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("-"));
  const summary = summaryParagraphs[summaryParagraphs.length - 1] ?? "";
  const highlightsSection = extractMarkdownSection(
    raw,
    "Highlights",
    "Boringness Warnings",
  );
  const beats = (highlightsSection ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0 && line !== NO_HIGHLIGHTS_PLACEHOLDER);
  if (summary.length === 0 && beats.length === 0) return null;
  return { summary, beats };
}

/**
 * Reads and parses `match-story.md` from an episode's mirrored run
 * directory, when one exists. `null` for a missing/oversized/unreadable
 * file — expected for the overwhelming majority of hosted league episodes:
 * `feature-candidates.ts`'s own module doc verifies the hosted Coworld
 * mirror NEVER calls `buildAgentMatchStory`/`writeAgentMatchStoryArtifacts`
 * (that pipeline only runs for LOCALLY-produced matches via
 * `ai-agent-league-smoke.ts` and friends, which never publish into the
 * hosted league this reads from). This still checks the filesystem rather
 * than assuming absence, so a future pipeline change picks up recaps with
 * no code change here.
 */
export async function readLeagueEpisodeRecap(
  runDir: string | null,
): Promise<LeagueEpisodeRecap | null> {
  if (runDir === null) return null;
  try {
    const filePath = path.join(runDir, "match-story.md");
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > maximumMatchStoryMarkdownBytes) {
      return null;
    }
    const raw = await fs.readFile(filePath, "utf8");
    return parseMatchStoryMarkdown(raw);
  } catch {
    return null;
  }
}

/**
 * Spoiler-safe title for the match page's OG/social card and `<title>` —
 * participants and context, NEVER the winner/result (product overhaul
 * spec: "no winner/result in title/description per the spoiler-safe card
 * convention"). Distinct from `feature-candidates.ts`'s `buildTitle`,
 * which DOES name the winner — that title is archive-lane FeaturedMatch
 * editorial metadata for an operator, for an outcome that was already
 * public well before being curated; this one is the canonical share card
 * for the raw episode page, always spoiler-neutral regardless of lane.
 */
export function leagueEpisodeSpoilerSafeTitle(row: CoworldLeagueEpisodeRow): string {
  const names = row.players.map((player) => player.name);
  const roster =
    names.length === 0
      ? "Unknown participants"
      : names.length <= 2
        ? names.join(" vs ")
        : `${names.slice(0, 2).join(" vs ")} +${names.length - 2} more`;
  const roundSuffix =
    row.roundNumber !== null ? `, Round ${row.roundNumber}` : "";
  return `${roster} — ${row.map}${roundSuffix} | Proxy War`;
}

export function leagueEpisodeSpoilerSafeDescription(
  row: CoworldLeagueEpisodeRow,
): string {
  const names = row.players.map((player) => player.name);
  const roster = names.length === 0 ? "Unknown participants" : names.join(", ");
  const roundLabel =
    row.roundNumber !== null ? `Round ${row.roundNumber}` : "an unnumbered round";
  return `Watch this Proxy War league battle: ${roster} on ${row.map}, ${roundLabel}.`;
}
