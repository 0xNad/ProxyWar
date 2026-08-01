import { DEFAULT_PLATFORM_ORIGIN } from "../core/PlatformOrigin";
import {
  AgentIdentityView,
  resolveAgentIdentityView,
} from "./identity/IdentityMatching";
import { IdentityRegistrySnapshot } from "./identity/IdentityRegistry";
import type {
  AgentProfile,
  AgentVersion,
  BuilderProfile,
} from "./identity/IdentitySchemas";
import { generateEmblemSvg } from "./identity/IdentityEmblems";
import type {
  AgentStatsArtifact,
  PlayerAgentStats,
} from "./agents/AgentStatsArtifact";
import type { AgentStatsSlice } from "./agents/AgentStatsPipeline";
import {
  computeAgentTimeSeries,
  type AgentTimeSeries,
} from "./agents/AgentTimeSeries";
import {
  EMPTY_STANDINGS_HISTORY_STORE,
  type StandingsHistoryStore,
} from "./agents/CoworldLeagueStandingsHistory";
import type {
  CoworldLeagueEpisodeRow,
  CoworldLeagueLatestPremiereCard,
  CoworldLeagueMirrorData,
  CoworldLeaguePremiereCard,
  CoworldLeagueRoundRow,
  CoworldLeagueStandingRow,
} from "./agents/CoworldLeagueSiteWriter";
import type {
  FeaturedMatch,
  FeaturedMatchCategory,
  FeaturedMatchLane,
  FeaturedMatchState,
  FeaturedMatchStoreFile,
} from "./agents/FeaturedMatch";

/**
 * The typed, already-normalized public data model every Stage 2+ page
 * consumes (spec Stage 2 item 1). Built ONCE per mirror publish
 * (`buildProxyWarPublicReadModel`, pure, no I/O) from the mirror's own
 * `data.json` plus the identity registry — the same two inputs
 * `CoworldLeagueSiteWriter` already resolves per row. The browser only ever
 * reads the published JSON (`GET /ai-league-runs/league/read-model.json`);
 * it never calls Coworld, the registry files, or any other private source
 * directly. Preserves every mirror invariant this repo already depends on:
 * atomic publication, last-good snapshots, stale banners, and the
 * champion-vs-rating provenance distinction (carried on `PublicAgent`, not
 * collapsed).
 */

export interface PublicBuilder {
  id: string;
  slug: string;
  displayName: string | null;
  shortBio: string | null;
  avatarUrl: string | null;
  status: BuilderProfile["status"];
}

export interface PublicAgentStanding {
  rank: number;
  score: number | null;
  roundsPlayed: number | null;
  isHouse: boolean;
}

export interface PublicAgentActiveVersion {
  /** Humanized label, e.g. "v24" — never the full raw policy label. */
  publicVersionLabel: string;
  /** "champion" unless only a rating label exists — same distinction the mirror preserves today. */
  source: "champion" | "rating";
  /** True when the live label's family no longer matches this Agent's registered rule — an operator-review signal, never auto-remapped. */
  familyMismatch: boolean;
  /**
   * When the mirror FIRST recorded this exact policy label (spec Stage 6
   * item 2) — `sync-version-registry.ts`'s own provenance field on the
   * matching `AgentVersion` registry record, `null` for a live label that
   * either has no registered record yet or predates that script's
   * introduction. A "first observed" marker, deliberately never labeled
   * "released" — this is the mirror's own observation date, not a
   * builder's disclosed release date (`releaseDate`, a separate,
   * still-usually-null field this read model never surfaces).
   */
  firstObservedAt: string | null;
}

/**
 * One league participant, normalized. `registered` is the load-bearing
 * field every consumer must check before trusting `slug`/`emblemSvg`/
 * `shortCode`/`builderId`: an UNREGISTERED participant (not yet in
 * `identity:list-unmapped`'s target-zero registry) still gets a row here —
 * `displayName` falls back to the raw Coworld `playerName`, every other
 * identity field is `null`. Never fabricated, never silently dropped.
 */
export interface PublicAgent {
  registered: boolean;
  /** Stable registry id (`agt_<slug>`), or `null` when unregistered. */
  id: string | null;
  slug: string | null;
  /** Raw Coworld player name — the only thing an unregistered participant is publicly known by. Always present. */
  playerName: string;
  displayName: string;
  shortCode: string | null;
  emblemSvg: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  tagline: string | null;
  builderId: string | null;
  builderDisplayName: string | null;
  status: AgentProfile["status"] | "unregistered";
  standing: PublicAgentStanding | null;
  activeVersion: PublicAgentActiveVersion | null;
  /** Raw, exact policy label(s) — provenance only, never the primary identity. Mirrors CoworldLeagueStandingRow's own fields verbatim. */
  provenance: {
    ratingPolicyLabel: string | null;
    activeChampionPolicyLabel: string | null;
  };
  /**
   * Product overhaul spec Stage 6: strategic fingerprint + social record,
   * computed by `compute-agent-stats.ts` from every retained episode this
   * `playerName` appears in — the SAME computed object `/api/players/:name`
   * serves for the same player (see `AgentStatsArtifact.ts`'s own doc).
   * `null` when the stats batch job hasn't produced a row for this
   * player yet (cold start, or a brand-new participant with zero
   * retained episodes) — never a zeroed-out fake stats block.
   */
  stats: PublicAgentStats | null;
  /**
   * Product overhaul spec: winrate-over-time (from retained episodes) and
   * score/rank-over-time (from the standings-history store) — see
   * `AgentTimeSeries.ts`'s own doc for the "one computation source, two
   * views" invariant this shares with `stats` above. Each sub-series is
   * independently `null` below its own documented sample threshold; the
   * container itself is always present (never `null`) so a page never has
   * to special-case "no time series object at all" separately from "both
   * series are below threshold".
   */
  timeSeries: AgentTimeSeries;
}

export interface PublicAgentStats {
  career: AgentStatsSlice;
  /** Best-effort, date-inferred (see `PlayerAgentStats.currentVersion`'s own doc) — `null` until the identity registry records a real `releaseDate` for this player's active version. */
  currentVersion: (AgentStatsSlice & { versionLabel: string }) | null;
}

export type PublicAgentVersion = AgentVersion;

export interface PublicMatchParticipant {
  slot: number;
  agentSlug: string | null;
  displayName: string;
  tilesOwned: number;
  isAlive: boolean;
  isWinner: boolean;
  color: string;
}

export interface PublicDirectorCutSummary {
  durationEstimateSeconds: number;
  segmentCount: number;
}

/**
 * "Drama recaps" gap closure, then the 2026-08-01 "best battles" ranking
 * fix — a compact ranking/evidence signal, never recap prose (the recap
 * itself is `LeagueEpisodeMatchPage.ts`'s separate `match-recap.json`-
 * backed `LeagueEpisodeRecap`). `curatedDramaScore` is `AgentMatchRecap`'s
 * deduped 0-100 score (see that module's doc) — the PUBLIC ranking/badge
 * input; `null` only when the recap hasn't (re)generated to the current
 * schema for this run yet (a transition/backfill-lag state, degrades to
 * "unscored" on every consumer, same as `dramaEvidence` itself being
 * `null`). The legacy `AgentDramaReport.dramaScore` composite is
 * deliberately NOT projected here — nothing on a public surface still
 * reads it after this fix; it remains on the `drama-report.json` artifact
 * and `AgentDramaReport`'s own type for any consumer that legitimately
 * needs the raw generator output. `entertainmentGrade` is
 * `AgentMatchStory`'s `grade` — unrelated to and unaffected by this fix.
 */
export interface PublicDramaEvidence {
  curatedDramaScore: number | null;
  entertainmentGrade: string;
}

export interface PublicMatch {
  matchId: string;
  shortId: string;
  roundNumber: number | null;
  completedAt: string | null;
  map: string;
  mapSize: string;
  turnCount: number | null;
  decisionCount: number | null;
  degradedCount: number | null;
  winnerAgentSlug: string | null;
  participants: PublicMatchParticipant[];
  watchHref: string | null;
  fullRenderHref: string | null;
  premiereHref: string | null;
  /** Product overhaul spec Stage 5. `null` when no `director-cut-plan.json` artifact exists for this match yet (e.g. an older match generated before this feature shipped) — never fabricated. */
  directorCut: PublicDirectorCutSummary | null;
  /** `null` until `CoworldLeagueMatchNarrativeBackfill.ts` has generated evidence for this run (budgeted, gradual — same convergence characteristic as `directorCut`) — never fabricated. */
  dramaEvidence: PublicDramaEvidence | null;
}

export interface PublicFeaturedMatchResult {
  winnerAgentId: string | null;
  placements: { agentId: string | null; placement: number }[];
}

/**
 * The PUBLIC-SAFE subset of `FeaturedMatch` (spec Stage 3 item 5). Never
 * carries `participants` — even anonymized-by-id, that field would let a
 * client read the read-model JSON directly (bypassing every hero/UI
 * spoiler guard) and learn who is in an unrevealed premiere-lane record.
 * `result`/`postMatchSummary` are only ever populated once
 * `publicFeaturedMatches` below decides the record is actually revealed —
 * see that function's doc for the embargo rule this type exists to carry.
 */
export interface PublicFeaturedMatch {
  matchId: string;
  lane: FeaturedMatchLane;
  title: string;
  description: string;
  map: string;
  format: string;
  category: FeaturedMatchCategory | null;
  state: FeaturedMatchState;
  scheduledAt: string | null;
  revealAt: string | null;
  postMatchSummary: string | null;
  result: PublicFeaturedMatchResult | null;
}

export interface PublicPremiereState {
  live: CoworldLeaguePremiereCard | null;
  latest: CoworldLeagueLatestPremiereCard | null;
}

export interface ProxyWarPublicReadModel {
  schemaVersion: 1;
  generatedAt: string;
  lastGoodSyncAt: string;
  stale: boolean;
  feedStates: {
    championFeedStale: boolean;
    replayFeedStale: boolean;
  };
  league: CoworldLeagueMirrorData["league"];
  builders: PublicBuilder[];
  agents: PublicAgent[];
  versions: PublicAgentVersion[];
  rounds: CoworldLeagueRoundRow[];
  matches: PublicMatch[];
  /** The public, embargo-correct projection of the `FeaturedMatch` store (spec Stage 3 items 1/5) — see `publicFeaturedMatches`' doc for the embargo rule. Excludes `state: "candidate"` records (operator-only, never public) and never carries `participants`. */
  featuredMatches: PublicFeaturedMatch[];
  premieres: PublicPremiereState;
  links: {
    enterTheLeagueUrl: string;
    platformLabel: string;
    accountUrl: string;
  };
}

function publicBuilder(builder: BuilderProfile): PublicBuilder {
  return {
    id: builder.id,
    slug: builder.slug,
    displayName: builder.displayName,
    shortBio: builder.shortBio,
    avatarUrl: builder.avatarUrl,
    status: builder.status,
  };
}

function publicAgentStats(
  playerName: string,
  statsArtifact: AgentStatsArtifact | null,
): PublicAgentStats | null {
  const row: PlayerAgentStats | undefined = statsArtifact?.players.find(
    (player) => player.playerName === playerName,
  );
  if (row === undefined) return null;
  return { career: row.career, currentVersion: row.currentVersion };
}

function publicAgentFromView(
  playerName: string,
  standing: CoworldLeagueStandingRow | null,
  view: AgentIdentityView,
  statsArtifact: AgentStatsArtifact | null,
  episodesForPlayer: readonly { completedAt: string | null; isWinner: boolean }[],
  standingsHistory: StandingsHistoryStore,
): PublicAgent {
  const provenance = {
    ratingPolicyLabel: standing?.ratingPolicyLabel ?? standing?.policyLabel ?? null,
    activeChampionPolicyLabel: standing?.activeChampionPolicyLabel ?? null,
  };
  const stats = publicAgentStats(playerName, statsArtifact);
  const timeSeries = computeAgentTimeSeries(
    episodesForPlayer,
    standingsHistory.snapshots,
    playerName,
  );
  if (view.agent === null) {
    return {
      registered: false,
      id: null,
      slug: null,
      playerName,
      displayName: playerName,
      shortCode: null,
      emblemSvg: null,
      primaryColor: null,
      secondaryColor: null,
      tagline: null,
      builderId: null,
      builderDisplayName: null,
      status: "unregistered",
      standing:
        standing === null
          ? null
          : {
              rank: standing.rank,
              score: standing.score,
              roundsPlayed: standing.roundsPlayed,
              isHouse: standing.isHouse,
            },
      activeVersion: null,
      provenance,
      stats,
      timeSeries,
    };
  }
  return {
    registered: true,
    id: view.agent.id,
    slug: view.agent.slug,
    playerName,
    displayName: view.agent.displayName,
    shortCode: view.agent.shortCode,
    emblemSvg: generateEmblemSvg(view.agent.id),
    primaryColor: view.agent.primaryColor,
    secondaryColor: view.agent.secondaryColor,
    tagline: view.agent.tagline,
    builderId: view.agent.builderId,
    builderDisplayName: view.builder?.displayName ?? view.builder?.slug ?? null,
    status: view.agent.status,
    standing:
      standing === null
        ? null
        : {
            rank: standing.rank,
            score: standing.score,
            roundsPlayed: standing.roundsPlayed,
            isHouse: standing.isHouse,
          },
    activeVersion:
      view.version === null || view.version.publicVersionLabel === null
        ? null
        : {
            publicVersionLabel: view.version.publicVersionLabel,
            source: view.version.source,
            familyMismatch: view.version.familyMismatch,
            firstObservedAt: view.version.registered?.firstObservedAt ?? null,
          },
    provenance,
    stats,
    timeSeries,
  };
}

/** Every league participant, standings first, then any registered Agent the live standings didn't mention this cycle (kept visible rather than disappearing the moment a participant misses one round). */
function publicAgents(
  standings: readonly CoworldLeagueStandingRow[],
  identity: IdentityRegistrySnapshot,
  statsArtifact: AgentStatsArtifact | null,
  episodes: readonly CoworldLeagueEpisodeRow[],
  standingsHistory: StandingsHistoryStore,
): PublicAgent[] {
  const episodesByPlayer = new Map<
    string,
    { completedAt: string | null; isWinner: boolean }[]
  >();
  for (const episode of episodes) {
    for (const player of episode.players) {
      const list = episodesByPlayer.get(player.name) ?? [];
      list.push({ completedAt: episode.completedAt, isWinner: player.isWinner });
      episodesByPlayer.set(player.name, list);
    }
  }
  const fromStandings = standings.map((row) => {
    const view = resolveAgentIdentityView(
      {
        playerName: row.playerName,
        ratingPolicyLabel: row.ratingPolicyLabel ?? row.policyLabel ?? null,
        activeChampionPolicyLabel: row.activeChampionPolicyLabel,
      },
      identity.agents,
      identity.builders,
      identity.versions,
    );
    return publicAgentFromView(
      row.playerName,
      row,
      view,
      statsArtifact,
      episodesByPlayer.get(row.playerName) ?? [],
      standingsHistory,
    );
  });
  const standingsPlayerNames = new Set(
    standings.map((row) => row.playerName),
  );
  const registeredNotInStandings = identity.agents
    .filter(
      (agent) => !standingsPlayerNames.has(agent.policyMatchRule.playerName),
    )
    .map((agent) => {
      const view = resolveAgentIdentityView(
        {
          playerName: agent.policyMatchRule.playerName,
          ratingPolicyLabel: null,
          activeChampionPolicyLabel: null,
        },
        identity.agents,
        identity.builders,
        identity.versions,
      );
      return publicAgentFromView(
        agent.policyMatchRule.playerName,
        null,
        view,
        statsArtifact,
        episodesByPlayer.get(agent.policyMatchRule.playerName) ?? [],
        standingsHistory,
      );
    });
  return [...fromStandings, ...registeredNotInStandings];
}

function publicMatch(
  episode: CoworldLeagueEpisodeRow,
  agentBySlugPlayerName: ReadonlyMap<string, string>,
): PublicMatch {
  const participants: PublicMatchParticipant[] = episode.players.map(
    (player) => ({
      slot: player.slot,
      agentSlug: agentBySlugPlayerName.get(player.name) ?? null,
      displayName: player.name,
      tilesOwned: player.tilesOwned,
      isAlive: player.isAlive,
      isWinner: player.isWinner,
      color: player.color,
    }),
  );
  const winner = participants.find((participant) => participant.isWinner);
  return {
    matchId: episode.episodeRequestId,
    shortId: episode.shortId,
    roundNumber: episode.roundNumber,
    completedAt: episode.completedAt,
    map: episode.map,
    mapSize: episode.mapSize,
    turnCount: episode.turnCount,
    decisionCount: episode.decisionCount,
    degradedCount: episode.degradedCount,
    winnerAgentSlug: winner?.agentSlug ?? null,
    participants,
    watchHref: episode.watchHref,
    fullRenderHref: episode.fullRenderHref,
    premiereHref: episode.premiereHref ?? null,
    directorCut: episode.directorCut
      ? {
          durationEstimateSeconds: episode.directorCut.durationEstimateSeconds,
          segmentCount: episode.directorCut.segmentCount,
        }
      : null,
    dramaEvidence: episode.dramaEvidence
      ? {
          curatedDramaScore: episode.dramaEvidence.curatedDramaScore,
          entertainmentGrade: episode.dramaEvidence.entertainmentGrade,
        }
      : null,
  };
}

/**
 * Whether a `FeaturedMatch` record's outcome is safe to project publicly.
 * Archive-lane records were already public before the record existed (see
 * `FeaturedMatch.ts`'s class doc — "Results are UI-gated ... never
 * embargoed"), so they're always revealed. Premiere-lane records are only
 * revealed once `state` has actually walked to `"revealed"`/`"archived"`.
 *
 * This intentionally does NOT trust the store's own `superRefine` embargo
 * (which only forbids a `result` on `"candidate"`/`"scheduled"` — it does
 * NOT forbid one on `"published"`, the state a premiere-lane record sits in
 * for the entire window between scheduling and reveal). This function is
 * the second, independent embargo layer the read-model projection owns for
 * itself, per spec item 5.
 */
function isFeaturedMatchRevealed(match: FeaturedMatch): boolean {
  if (match.lane === "archive") return true;
  return match.state === "revealed" || match.state === "archived";
}

function publicFeaturedMatchResult(
  match: FeaturedMatch,
): PublicFeaturedMatchResult | null {
  if (!isFeaturedMatchRevealed(match) || match.result === null) return null;
  return {
    winnerAgentId: match.result.winnerAgentId,
    placements: match.result.placements.map((placement) => ({
      agentId: placement.agentId,
      placement: placement.placement,
    })),
  };
}

/** Exported for reuse by the narrow, per-match `/api/featured-matches/:matchId` route (never the bulk read model — see `PublicFeaturedMatch`'s own doc) so both share the exact same embargo projection rather than a parallel reimplementation that could drift. */
export function publicFeaturedMatch(match: FeaturedMatch): PublicFeaturedMatch {
  const revealed = isFeaturedMatchRevealed(match);
  return {
    matchId: match.matchId,
    lane: match.lane,
    title: match.title,
    description: match.description,
    map: match.map,
    format: match.format,
    category: match.category,
    state: match.state,
    scheduledAt: match.scheduledAt,
    revealAt: match.revealAt,
    // EMBARGO: never copy prose that could describe an unrevealed outcome —
    // see `isFeaturedMatchRevealed`'s doc for why this can't trust the
    // store's own validation alone.
    postMatchSummary: revealed ? match.postMatchSummary : null,
    result: publicFeaturedMatchResult(match),
  };
}

/**
 * Projects the `FeaturedMatch` store into the public read model (spec
 * Stage 3 items 1/5). `"candidate"` records are operator-only ranked
 * drafts from `premiere:candidates`/`feature:candidates` — never public —
 * so they're filtered out entirely, not just embargoed.
 */
function publicFeaturedMatches(
  store: FeaturedMatchStoreFile,
): PublicFeaturedMatch[] {
  return store.matches
    .filter((match) => match.state !== "candidate")
    .map(publicFeaturedMatch);
}

export function buildProxyWarPublicReadModel(
  mirror: CoworldLeagueMirrorData,
  identity: IdentityRegistrySnapshot,
  featuredMatchStore: FeaturedMatchStoreFile,
  /**
   * Product overhaul spec Stage 6. `null` when the stats batch job
   * (`compute-agent-stats.ts`) hasn't produced an artifact yet — every
   * `PublicAgent.stats` then reads `null` too, an honest cold-start state
   * rather than a build failure.
   */
  statsArtifact: AgentStatsArtifact | null = null,
  /**
   * Product overhaul spec: the standings-history store backing
   * `PublicAgent.timeSeries.score` — see `CoworldLeagueStandingsHistory.ts`'s
   * own doc. Defaults to the empty store so every existing test/caller that
   * doesn't pass one gets an honest "no score history yet" rather than a
   * required-argument break.
   */
  standingsHistory: StandingsHistoryStore = EMPTY_STANDINGS_HISTORY_STORE,
): ProxyWarPublicReadModel {
  const agentSlugByPlayerName = new Map(
    identity.agents.map((agent) => [
      agent.policyMatchRule.playerName,
      agent.slug,
    ]),
  );
  return {
    schemaVersion: 1,
    generatedAt: mirror.generatedAt,
    lastGoodSyncAt: mirror.lastGoodSyncAt,
    stale: mirror.stale,
    feedStates: {
      championFeedStale: mirror.championFeedStale ?? false,
      replayFeedStale: mirror.replayFeedStale ?? false,
    },
    league: mirror.league,
    builders: identity.builders.map(publicBuilder),
    agents: publicAgents(
      mirror.standings,
      identity,
      statsArtifact,
      mirror.episodes,
      standingsHistory,
    ),
    versions: [...identity.versions],
    rounds: mirror.rounds,
    matches: mirror.episodes.map((episode) =>
      publicMatch(episode, agentSlugByPlayerName),
    ),
    featuredMatches: publicFeaturedMatches(featuredMatchStore),
    premieres: {
      live: mirror.premiere ?? null,
      latest: mirror.premiere === undefined ? (mirror.latestPremiere ?? null) : null,
    },
    links: {
      enterTheLeagueUrl: mirror.links.enterTheLeagueUrl,
      platformLabel: mirror.links.platformLabel,
      accountUrl: `${process.env.PROXYWAR_PLATFORM_ORIGIN ?? DEFAULT_PLATFORM_ORIGIN}/account`,
    },
  };
}
