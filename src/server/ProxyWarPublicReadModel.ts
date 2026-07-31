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
  CoworldLeagueEpisodeRow,
  CoworldLeagueLatestPremiereCard,
  CoworldLeagueMirrorData,
  CoworldLeaguePremiereCard,
  CoworldLeagueRoundRow,
  CoworldLeagueStandingRow,
} from "./agents/CoworldLeagueSiteWriter";

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
  /** Empty until Stage 3's FeaturedMatch model ships — never fabricated ahead of it. */
  featuredMatches: [];
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

function publicAgentFromView(
  playerName: string,
  standing: CoworldLeagueStandingRow | null,
  view: AgentIdentityView,
): PublicAgent {
  const provenance = {
    ratingPolicyLabel: standing?.ratingPolicyLabel ?? standing?.policyLabel ?? null,
    activeChampionPolicyLabel: standing?.activeChampionPolicyLabel ?? null,
  };
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
          },
    provenance,
  };
}

/** Every league participant, standings first, then any registered Agent the live standings didn't mention this cycle (kept visible rather than disappearing the moment a participant misses one round). */
function publicAgents(
  standings: readonly CoworldLeagueStandingRow[],
  identity: IdentityRegistrySnapshot,
): PublicAgent[] {
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
    return publicAgentFromView(row.playerName, row, view);
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
      return publicAgentFromView(agent.policyMatchRule.playerName, null, view);
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
  };
}

export function buildProxyWarPublicReadModel(
  mirror: CoworldLeagueMirrorData,
  identity: IdentityRegistrySnapshot,
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
    agents: publicAgents(mirror.standings, identity),
    versions: [...identity.versions],
    rounds: mirror.rounds,
    matches: mirror.episodes.map((episode) =>
      publicMatch(episode, agentSlugByPlayerName),
    ),
    featuredMatches: [],
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
