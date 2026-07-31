import type {
  AgentProfile,
  AgentVersion,
  BuilderProfile,
} from "../identity/IdentitySchemas";
import { deriveEmblemPalette } from "../identity/IdentityEmblems";
import type {
  CoworldLeagueEpisodeRow,
  CoworldLeagueMirrorData,
  CoworldLeagueStandingRow,
} from "../agents/CoworldLeagueSiteWriter";

/**
 * Deterministic, hand-curated Builders/Agents/Versions/standings/episodes
 * for the Stage 8 public-product fixture set — spec item 1: "≥4
 * Builders/Agents, multiple versions, standings, ... completed match with
 * alliance/first-strike/betrayal/elimination, a version debut, one
 * degraded match, one stale feed." Every fake identity here has a
 * `fixture-` slug prefix specifically so `IdentityRegistryFixtureGuard`
 * (and any future audit) can grep for accidental fixture leakage into a
 * real registry file at a glance.
 *
 * This module intentionally does NOT invent the alliance/first-strike/
 * betrayal/elimination match — that data comes from the game engine's own
 * event log, which only a REAL simulated match produces (see
 * `proxywar-public-product-fixtures.ts`'s orchestration: it runs one real
 * local match via the existing `ai-agent-league-smoke.ts` pipeline and
 * splices the resulting episode row in here). Fabricating engine event
 * data by hand would risk drifting from the real event schema silently.
 */

const NOW = new Date("2026-07-31T12:00:00.000Z");

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}
function isoDateDaysAgo(days: number): string {
  return isoDaysAgo(days).slice(0, 10);
}

export const FIXTURE_BUILDERS: readonly BuilderProfile[] = [
  {
    id: "bld_fixture-ada",
    slug: "fixture-ada",
    displayName: "Ada Kestrel",
    shortBio: "Solo hobbyist, tuned for early aggression.",
    avatarUrl: null,
    verifiedGithub: null,
    links: ["https://example.com/ada"],
    teamMembers: [],
    softmaxPlayerIdentities: [],
    status: "verified",
  },
  {
    id: "bld_fixture-solstice",
    slug: "fixture-solstice",
    displayName: "Solstice Labs",
    shortBio: "Small team, diplomacy-first strategy.",
    avatarUrl: null,
    verifiedGithub: null,
    links: ["https://example.com/solstice"],
    teamMembers: ["Mika", "Theo"],
    softmaxPlayerIdentities: [],
    status: "verified",
  },
  {
    id: "bld_fixture-relh",
    slug: "fixture-relh",
    displayName: "relh",
    shortBio: null,
    avatarUrl: null,
    verifiedGithub: null,
    links: [],
    teamMembers: [],
    softmaxPlayerIdentities: [],
    status: "verified",
  },
  {
    id: "bld_fixture-frost",
    slug: "fixture-frost",
    displayName: "Frost Systems",
    shortBio: "Rule-based policy, no LLM.",
    avatarUrl: null,
    verifiedGithub: null,
    links: [],
    teamMembers: [],
    softmaxPlayerIdentities: [],
    status: "verified",
  },
] as const;

function emblem(agentId: string) {
  const palette = deriveEmblemPalette(agentId);
  return {
    ref: {
      style: "geometric-svg-v1" as const,
      seed: agentId,
      assetPath: `resources/identity/emblems/${agentId}.svg`,
    },
    primaryColor: palette.primary,
    secondaryColor: palette.secondary,
  };
}

// Player names deliberately distinct from anything a real Coworld league
// would ever produce, so a fixture-booted process can never be confused
// with the live mirror even if pointed at the wrong artifacts root by
// accident.
const CYAN_AGENT_ID = "agt_fixture-cyan-hellstar";
const CYAN_PLAYER = "FixtureCyanHellstar";
const GHOST_AGENT_ID = "agt_fixture-ghost-raider";
const GHOST_PLAYER = "FixtureGhostRaider";
const IRON_AGENT_ID = "agt_fixture-iron-vanguard";
const IRON_PLAYER = "FixtureIronVanguard";
const FROST_AGENT_ID = "agt_fixture-frostfall";
const FROST_PLAYER = "FixtureFrostfall";
const HOUSE_AGENT_ID = "agt_fixture-house-keystone";
const HOUSE_PLAYER = "FixtureHouseKeystone";

export const FIXTURE_AGENTS: readonly AgentProfile[] = [
  {
    id: CYAN_AGENT_ID,
    slug: "fixture-cyan-hellstar",
    displayName: "Cyan Hellstar",
    shortCode: "CHS",
    builderId: "bld_fixture-ada",
    tagline: "Fast expansion, faster betrayal.",
    description: null,
    emblem: emblem(CYAN_AGENT_ID).ref,
    primaryColor: emblem(CYAN_AGENT_ID).primaryColor,
    secondaryColor: emblem(CYAN_AGENT_ID).secondaryColor,
    debutDate: isoDateDaysAgo(120),
    policyMatchRule: {
      playerName: CYAN_PLAYER,
      policyFamily: "fixture-cyan-hellstar-proxywar",
    },
    status: "verified",
    publicStrategyDescription: "Rushes the nearest neutral tile.",
  },
  {
    id: GHOST_AGENT_ID,
    slug: "fixture-ghost-raider",
    displayName: "Ghost Raider",
    shortCode: "GHR",
    builderId: "bld_fixture-solstice",
    tagline: "Alliances first, betrayal when it counts.",
    description: null,
    emblem: emblem(GHOST_AGENT_ID).ref,
    primaryColor: emblem(GHOST_AGENT_ID).primaryColor,
    secondaryColor: emblem(GHOST_AGENT_ID).secondaryColor,
    debutDate: isoDateDaysAgo(90),
    policyMatchRule: {
      playerName: GHOST_PLAYER,
      policyFamily: "fixture-ghost-raider-proxywar",
    },
    status: "verified",
    publicStrategyDescription: null,
  },
  {
    id: IRON_AGENT_ID,
    slug: "fixture-iron-vanguard",
    displayName: "Iron Vanguard",
    shortCode: "IVG",
    builderId: "bld_fixture-relh",
    tagline: null,
    description: null,
    emblem: emblem(IRON_AGENT_ID).ref,
    primaryColor: emblem(IRON_AGENT_ID).primaryColor,
    secondaryColor: emblem(IRON_AGENT_ID).secondaryColor,
    debutDate: isoDateDaysAgo(200),
    policyMatchRule: {
      playerName: IRON_PLAYER,
      policyFamily: "fixture-iron-vanguard-proxywar",
    },
    status: "verified",
    publicStrategyDescription: null,
  },
  {
    id: FROST_AGENT_ID,
    slug: "fixture-frostfall",
    displayName: "Frostfall",
    shortCode: "FRF",
    builderId: "bld_fixture-frost",
    tagline: "Turtles, then overwhelms.",
    description: null,
    emblem: emblem(FROST_AGENT_ID).ref,
    primaryColor: emblem(FROST_AGENT_ID).primaryColor,
    secondaryColor: emblem(FROST_AGENT_ID).secondaryColor,
    debutDate: isoDateDaysAgo(60),
    policyMatchRule: {
      playerName: FROST_PLAYER,
      policyFamily: "fixture-frostfall-proxywar",
    },
    status: "verified",
    publicStrategyDescription: null,
  },
  {
    id: HOUSE_AGENT_ID,
    slug: "fixture-house-keystone",
    displayName: "House Keystone",
    shortCode: "HKS",
    builderId: null,
    tagline: "Operator baseline.",
    description: null,
    emblem: emblem(HOUSE_AGENT_ID).ref,
    primaryColor: emblem(HOUSE_AGENT_ID).primaryColor,
    secondaryColor: emblem(HOUSE_AGENT_ID).secondaryColor,
    debutDate: isoDateDaysAgo(365),
    policyMatchRule: {
      playerName: HOUSE_PLAYER,
      policyFamily: "fixture-house-keystone-proxywar",
    },
    status: "house",
    publicStrategyDescription: null,
  },
] as const;

/** `agt_fixture-cyan-hellstar` carries TWO versions — v23 (long-running) and the brand-new v24, whose `firstObservedAt` is within the fixture's own retained window: the "version debut" spec item 1 asks for. */
export const FIXTURE_VERSIONS: readonly AgentVersion[] = [
  {
    id: "agtv_fixture-cyan-hellstar_v23",
    agentId: CYAN_AGENT_ID,
    publicVersionLabel: "v23",
    softmaxPolicyLabel: "fixture-cyan-hellstar-proxywar:v23",
    immutableDigest: null,
    releaseDate: isoDateDaysAgo(45),
    releaseNotes: "Tuned early-game land grabs.",
    declaredBaseModel: null,
    scaffoldDescription: null,
    sourceRepositoryRef: null,
    disclosureStatus: "undisclosed",
    qualificationStatus: "retired",
    observedVia: ["rating"],
    observedAt: isoDaysAgo(2),
    firstObservedAt: isoDaysAgo(45),
  },
  {
    id: "agtv_fixture-cyan-hellstar_v24",
    agentId: CYAN_AGENT_ID,
    publicVersionLabel: "v24",
    softmaxPolicyLabel: "fixture-cyan-hellstar-proxywar:v24",
    immutableDigest: null,
    releaseDate: isoDateDaysAgo(1),
    releaseNotes: "Debut: alliance timing rework.",
    declaredBaseModel: null,
    scaffoldDescription: null,
    sourceRepositoryRef: null,
    disclosureStatus: "undisclosed",
    qualificationStatus: "active",
    observedVia: ["champion", "rating"],
    observedAt: isoDaysAgo(0.1),
    firstObservedAt: isoDaysAgo(1),
  },
  {
    id: "agtv_fixture-ghost-raider_v7",
    agentId: GHOST_AGENT_ID,
    publicVersionLabel: "v7",
    softmaxPolicyLabel: "fixture-ghost-raider-proxywar:v7",
    immutableDigest: null,
    releaseDate: isoDateDaysAgo(30),
    releaseNotes: null,
    declaredBaseModel: null,
    scaffoldDescription: null,
    sourceRepositoryRef: null,
    disclosureStatus: "undisclosed",
    qualificationStatus: "active",
    observedVia: ["champion", "rating"],
    observedAt: isoDaysAgo(0.2),
    firstObservedAt: isoDaysAgo(30),
  },
  {
    id: "agtv_fixture-iron-vanguard_v41",
    agentId: IRON_AGENT_ID,
    publicVersionLabel: "v41",
    softmaxPolicyLabel: "fixture-iron-vanguard-proxywar:v41",
    immutableDigest: null,
    releaseDate: isoDateDaysAgo(80),
    releaseNotes: null,
    declaredBaseModel: null,
    scaffoldDescription: null,
    sourceRepositoryRef: null,
    disclosureStatus: "undisclosed",
    qualificationStatus: "active",
    observedVia: ["champion", "rating"],
    observedAt: isoDaysAgo(0.3),
    firstObservedAt: isoDaysAgo(80),
  },
  {
    id: "agtv_fixture-frostfall_v3",
    agentId: FROST_AGENT_ID,
    publicVersionLabel: "v3",
    softmaxPolicyLabel: "fixture-frostfall-proxywar:v3",
    immutableDigest: null,
    releaseDate: isoDateDaysAgo(20),
    releaseNotes: null,
    declaredBaseModel: null,
    scaffoldDescription: null,
    sourceRepositoryRef: null,
    disclosureStatus: "undisclosed",
    qualificationStatus: "active",
    observedVia: ["rating"],
    observedAt: isoDaysAgo(0.4),
    firstObservedAt: isoDaysAgo(20),
  },
  {
    id: "agtv_fixture-house-keystone_v42",
    agentId: HOUSE_AGENT_ID,
    publicVersionLabel: "v42",
    softmaxPolicyLabel: "fixture-house-keystone-proxywar:v42",
    immutableDigest: null,
    releaseDate: isoDateDaysAgo(365),
    releaseNotes: null,
    declaredBaseModel: null,
    scaffoldDescription: null,
    sourceRepositoryRef: null,
    disclosureStatus: "undisclosed",
    qualificationStatus: "active",
    observedVia: ["champion", "rating"],
    observedAt: isoDaysAgo(0.1),
    firstObservedAt: isoDaysAgo(365),
  },
] as const;

export const FIXTURE_STANDINGS: readonly CoworldLeagueStandingRow[] = [
  {
    rank: 1,
    playerName: CYAN_PLAYER,
    ratingPolicyLabel: "fixture-cyan-hellstar-proxywar:v24",
    activeChampionPolicyLabel: "fixture-cyan-hellstar-proxywar:v24",
    policyLabel: "fixture-cyan-hellstar-proxywar:v24",
    score: 24.5,
    roundsPlayed: 120,
    isHouse: false,
  },
  {
    rank: 2,
    playerName: HOUSE_PLAYER,
    ratingPolicyLabel: "fixture-house-keystone-proxywar:v42",
    activeChampionPolicyLabel: "fixture-house-keystone-proxywar:v42",
    policyLabel: "fixture-house-keystone-proxywar:v42",
    score: 22.1,
    roundsPlayed: 340,
    isHouse: true,
  },
  {
    rank: 3,
    playerName: GHOST_PLAYER,
    ratingPolicyLabel: "fixture-ghost-raider-proxywar:v7",
    activeChampionPolicyLabel: "fixture-ghost-raider-proxywar:v7",
    policyLabel: "fixture-ghost-raider-proxywar:v7",
    score: 15.3,
    roundsPlayed: 88,
    isHouse: false,
  },
  {
    rank: 4,
    playerName: IRON_PLAYER,
    ratingPolicyLabel: "fixture-iron-vanguard-proxywar:v41",
    activeChampionPolicyLabel: "fixture-iron-vanguard-proxywar:v41",
    policyLabel: "fixture-iron-vanguard-proxywar:v41",
    score: 9.7,
    roundsPlayed: 150,
    isHouse: false,
  },
  {
    rank: 5,
    playerName: FROST_PLAYER,
    // Unrated: exercises the "not yet rated" render path (`ratingPolicyLabel: null`).
    ratingPolicyLabel: null,
    activeChampionPolicyLabel: "fixture-frostfall-proxywar:v3",
    policyLabel: null,
    score: null,
    roundsPlayed: null,
    isHouse: false,
  },
];

/** A clean win — Frostfall over Ghost Raider — with a HIGH degraded-decision share, exercising the ⚠ recovered-turns warning path (`DEGRADED_WARNING_PERCENT` = 15% in `CoworldLeagueSiteWriter.ts`). */
export const DEGRADED_EPISODE: CoworldLeagueEpisodeRow = {
  episodeRequestId: "ereq_fixture-degraded-0001",
  shortId: "fixturedegrade01",
  roundNumber: 501,
  completedAt: isoDaysAgo(0.5),
  map: "Pangaea",
  mapSize: "Compact",
  turnCount: 4200,
  decisionCount: 360,
  degradedCount: 130,
  winnerName: FROST_PLAYER,
  players: [
    {
      slot: 0,
      name: FROST_PLAYER,
      tilesOwned: 210_000,
      isAlive: true,
      isWinner: true,
      color: "#6fa8dc",
    },
    {
      slot: 1,
      name: GHOST_PLAYER,
      tilesOwned: 40_000,
      isAlive: false,
      isWinner: false,
      color: "#e06666",
    },
  ],
  watchHref: null,
  fullRenderHref: null,
};

/** A recent, ordinary completed match — Iron Vanguard over House Keystone — for the "second most recent" archive slot and for episode-count filters. */
export const ORDINARY_EPISODE: CoworldLeagueEpisodeRow = {
  episodeRequestId: "ereq_fixture-ordinary-0001",
  shortId: "fixtureordinary1",
  roundNumber: 502,
  completedAt: isoDaysAgo(0.2),
  map: "World",
  mapSize: "Normal",
  turnCount: 8800,
  decisionCount: 720,
  degradedCount: 12,
  winnerName: IRON_PLAYER,
  players: [
    {
      slot: 0,
      name: IRON_PLAYER,
      tilesOwned: 330_000,
      isAlive: true,
      isWinner: true,
      color: "#93c47d",
    },
    {
      slot: 1,
      name: HOUSE_PLAYER,
      tilesOwned: 95_000,
      isAlive: true,
      isWinner: false,
      color: "#f6b26b",
    },
  ],
  watchHref: null,
  fullRenderHref: null,
};

/**
 * Base league container the orchestrator splices the real drama match's
 * episode row into (see `proxywar-public-product-fixtures.ts`). ONE
 * coherent fixture instance carries every state spec item 1 asks for at
 * once — including "one stale feed": `replayFeedStale: true` here models a
 * mirror sync whose STANDINGS are current but whose optional replay feed
 * has fallen behind (`CoworldLeagueMirrorData.replayFeedStale`'s own
 * doc), the more interesting and more testable partial-staleness case,
 * distinct from `stale: true` (the whole-mirror kill switch, which would
 * gray out standings too and leave nothing else to test alongside it).
 */
export function fixtureLeagueMirrorData(options: {
  episodes: readonly CoworldLeagueEpisodeRow[];
  premiere?: CoworldLeagueMirrorData["premiere"];
  latestPremiere?: CoworldLeagueMirrorData["latestPremiere"];
}): CoworldLeagueMirrorData {
  return {
    generatedAt: NOW.toISOString(),
    lastGoodSyncAt: NOW.toISOString(),
    stale: false,
    replayFeedStale: true,
    lastGoodReplaySyncAt: isoDaysAgo(3),
    league: {
      id: "fixture-league-1",
      name: "Proxy War (Fixtures)",
      description: null,
      divisionName: "Open",
      roundIntervalMinutes: 30,
      episodesPerRound: 1,
      currentRoundNumber: 502,
      currentRoundStatus: "completed",
      scoreLabel: "Score",
    },
    standings: [...FIXTURE_STANDINGS],
    rounds: [
      {
        roundNumber: 502,
        status: "completed",
        startedAt: isoDaysAgo(0.21),
        completedAt: isoDaysAgo(0.2),
      },
      {
        roundNumber: 501,
        status: "completed",
        startedAt: isoDaysAgo(0.51),
        completedAt: isoDaysAgo(0.5),
      },
    ],
    episodes: [...options.episodes],
    premiere: options.premiere,
    latestPremiere: options.latestPremiere,
    links: {
      enterTheLeagueUrl: "https://example.com/enter-the-fixture-league",
      platformLabel: "Coworld (fixture)",
    },
  };
}

export const FIXTURE_PLAYER_NAMES = {
  cyan: CYAN_PLAYER,
  ghost: GHOST_PLAYER,
  iron: IRON_PLAYER,
  frost: FROST_PLAYER,
  house: HOUSE_PLAYER,
} as const;
export const FIXTURE_AGENT_IDS = {
  cyan: CYAN_AGENT_ID,
  ghost: GHOST_AGENT_ID,
  iron: IRON_AGENT_ID,
  frost: FROST_AGENT_ID,
  house: HOUSE_AGENT_ID,
} as const;
