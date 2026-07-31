import { describe, expect, test } from "vitest";
import { buildProxyWarPublicReadModel } from "../../src/server/ProxyWarPublicReadModel";
import type { CoworldLeagueMirrorData } from "../../src/server/agents/CoworldLeagueSiteWriter";
import type { IdentityRegistrySnapshot } from "../../src/server/identity/IdentityRegistry";
import type { AgentProfile } from "../../src/server/identity/IdentitySchemas";
import {
  FeaturedMatchSchema,
  type FeaturedMatch,
  type FeaturedMatchStoreFile,
} from "../../src/server/agents/FeaturedMatch";

function agent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agt_daveey",
    slug: "daveey",
    displayName: "daveey",
    shortCode: "DAV",
    builderId: null,
    tagline: null,
    description: null,
    emblem: {
      style: "geometric-svg-v1",
      seed: "agt_daveey",
      assetPath: "resources/identity/emblems/agt_daveey.svg",
    },
    primaryColor: "#c62f39",
    secondaryColor: "#689e2e",
    debutDate: null,
    policyMatchRule: { playerName: "daveey", policyFamily: "daveey-proxywar" },
    status: "unclaimed",
    publicStrategyDescription: null,
    ...overrides,
  };
}

function baseMirror(overrides: Partial<CoworldLeagueMirrorData> = {}): CoworldLeagueMirrorData {
  return {
    generatedAt: "2026-07-31T00:00:00.000Z",
    lastGoodSyncAt: "2026-07-31T00:00:00.000Z",
    stale: false,
    championFeedStale: false,
    replayFeedStale: false,
    lastGoodReplaySyncAt: "2026-07-31T00:00:00.000Z",
    league: {
      id: "league_test",
      name: "Proxywar",
      description: "Test",
      divisionName: "Competition",
      roundIntervalMinutes: 30,
      episodesPerRound: 8,
      currentRoundNumber: 100,
      currentRoundStatus: "running",
      scoreLabel: "Score",
    },
    standings: [
      {
        rank: 1,
        playerName: "daveey",
        ratingPolicyLabel: "daveey-proxywar:v24",
        activeChampionPolicyLabel: "daveey-proxywar:v24",
        policyLabel: "daveey-proxywar:v24",
        score: 22.66,
        roundsPlayed: 748,
        isHouse: false,
      },
      {
        rank: 2,
        playerName: "unregistered-player",
        ratingPolicyLabel: null,
        activeChampionPolicyLabel: "some-family:v1",
        policyLabel: null,
        score: 1,
        roundsPlayed: 5,
        isHouse: false,
      },
    ],
    rounds: [{ roundNumber: 100, status: "running", startedAt: null, completedAt: null }],
    episodes: [
      {
        episodeRequestId: "ereq_1",
        shortId: "1",
        roundNumber: 99,
        completedAt: "2026-07-30T00:00:00.000Z",
        map: "Pangaea",
        mapSize: "Compact",
        turnCount: 5000,
        decisionCount: 200,
        degradedCount: 5,
        winnerName: "daveey",
        players: [
          { slot: 0, name: "daveey", tilesOwned: 900, isAlive: true, isWinner: true, color: "#f00" },
          { slot: 1, name: "unregistered-player", tilesOwned: 100, isAlive: false, isWinner: false, color: "#00f" },
        ],
        watchHref: "/watch-href",
        fullRenderHref: "/ai-league-replay/ereq_1",
      },
    ],
    links: {
      enterTheLeagueUrl: "https://github.com/example/starter",
      platformLabel: "Softmax Coworld",
    },
    ...overrides,
  };
}

function identitySnapshot(): IdentityRegistrySnapshot {
  return { builders: [], agents: [agent()], versions: [] };
}

function featuredMatch(overrides: Partial<FeaturedMatch> = {}): FeaturedMatch {
  return {
    schemaVersion: 1,
    matchId: "feat_0000000000000000abcd",
    lane: "premiere",
    episodeRequestId: null,
    queueItemName: "20260731T000000Z-run1",
    title: "Round 100: Pangaea",
    description: "A tense four-way standoff.",
    participants: [
      {
        playerName: "daveey",
        agentId: "agt_daveey",
        agentVersionId: null,
        builderId: null,
      },
    ],
    map: "Pangaea",
    format: "4p FFA",
    provenance: {
      source: "premiere-queue",
      sourceRef: "20260731T000000Z-run1",
      capturedAt: "2026-07-31T00:00:00.000Z",
    },
    state: "scheduled",
    category: "top_four",
    scheduledAt: "2026-07-31T00:10:00.000Z",
    revealAt: null,
    evidence: {
      dramaScore: null,
      dramaGrade: null,
      entertainmentScore: null,
      storyGrade: null,
      turnCount: 8000,
      decisionCount: null,
      degradedCount: 0,
      seatCount: 4,
      replayComplete: true,
      notes: [],
    },
    postMatchSummary: null,
    result: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

function featuredMatchStoreOf(
  ...matches: FeaturedMatch[]
): FeaturedMatchStoreFile {
  return { schemaVersion: 1, matches };
}

describe("buildProxyWarPublicReadModel", () => {
  test("preserves generatedAt, lastGoodSyncAt, and stale exactly from the mirror", () => {
    const model = buildProxyWarPublicReadModel(baseMirror(), identitySnapshot(), featuredMatchStoreOf());
    expect(model.generatedAt).toBe("2026-07-31T00:00:00.000Z");
    expect(model.lastGoodSyncAt).toBe("2026-07-31T00:00:00.000Z");
    expect(model.stale).toBe(false);
  });

  test("a stale mirror snapshot with an older lastGoodSyncAt round-trips both timestamps distinctly (the last-good fixture)", () => {
    const mirror = baseMirror({
      stale: true,
      generatedAt: "2026-07-31T01:00:00.000Z",
      lastGoodSyncAt: "2026-07-30T20:00:00.000Z",
    });
    const model = buildProxyWarPublicReadModel(mirror, identitySnapshot(), featuredMatchStoreOf());
    expect(model.stale).toBe(true);
    expect(model.generatedAt).toBe("2026-07-31T01:00:00.000Z");
    expect(model.lastGoodSyncAt).toBe("2026-07-30T20:00:00.000Z");
  });

  test("feedStates default to false when the mirror omits championFeedStale/replayFeedStale", () => {
    const mirror = baseMirror({ championFeedStale: undefined, replayFeedStale: undefined });
    const model = buildProxyWarPublicReadModel(mirror, identitySnapshot(), featuredMatchStoreOf());
    expect(model.feedStates).toEqual({
      championFeedStale: false,
      replayFeedStale: false,
    });
  });

  test("a stale champion feed is carried through feedStates without touching the overall stale flag", () => {
    const mirror = baseMirror({ stale: false, championFeedStale: true });
    const model = buildProxyWarPublicReadModel(mirror, identitySnapshot(), featuredMatchStoreOf());
    expect(model.stale).toBe(false);
    expect(model.feedStates.championFeedStale).toBe(true);
  });

  test("a registered agent resolves full identity: slug, displayName, emblem, short code, standing, active version", () => {
    const model = buildProxyWarPublicReadModel(baseMirror(), identitySnapshot(), featuredMatchStoreOf());
    const daveey = model.agents.find((a) => a.playerName === "daveey");
    expect(daveey?.registered).toBe(true);
    expect(daveey?.slug).toBe("daveey");
    expect(daveey?.displayName).toBe("daveey");
    expect(daveey?.shortCode).toBe("DAV");
    expect(daveey?.emblemSvg).toContain("<svg");
    expect(daveey?.standing).toEqual({
      rank: 1,
      score: 22.66,
      roundsPlayed: 748,
      isHouse: false,
    });
    expect(daveey?.activeVersion).toEqual({
      publicVersionLabel: "v24",
      source: "champion",
      familyMismatch: false,
      firstObservedAt: null,
    });
    // Raw label still present as provenance, never as the primary identity.
    expect(daveey?.provenance.activeChampionPolicyLabel).toBe(
      "daveey-proxywar:v24",
    );
  });

  test("an unregistered live participant falls back to player-name-only, every identity field null", () => {
    const model = buildProxyWarPublicReadModel(baseMirror(), identitySnapshot(), featuredMatchStoreOf());
    const unregistered = model.agents.find(
      (a) => a.playerName === "unregistered-player",
    );
    expect(unregistered?.registered).toBe(false);
    expect(unregistered?.id).toBeNull();
    expect(unregistered?.slug).toBeNull();
    expect(unregistered?.displayName).toBe("unregistered-player");
    expect(unregistered?.shortCode).toBeNull();
    expect(unregistered?.emblemSvg).toBeNull();
    expect(unregistered?.status).toBe("unregistered");
  });

  test("a registered agent absent from this cycle's live standings still appears (never disappears on a missed round)", () => {
    const mirror = baseMirror({ standings: [] });
    const model = buildProxyWarPublicReadModel(mirror, identitySnapshot(), featuredMatchStoreOf());
    const daveey = model.agents.find((a) => a.playerName === "daveey");
    expect(daveey?.registered).toBe(true);
    expect(daveey?.standing).toBeNull();
    expect(daveey?.activeVersion).toBeNull();
  });

  test("matches normalize episode participants and resolve winnerAgentSlug through the registry", () => {
    const model = buildProxyWarPublicReadModel(baseMirror(), identitySnapshot(), featuredMatchStoreOf());
    expect(model.matches).toHaveLength(1);
    const match = model.matches[0];
    expect(match.matchId).toBe("ereq_1");
    expect(match.winnerAgentSlug).toBe("daveey");
    expect(match.participants).toHaveLength(2);
    expect(match.participants[0]).toEqual({
      slot: 0,
      agentSlug: "daveey",
      displayName: "daveey",
      tilesOwned: 900,
      isAlive: true,
      isWinner: true,
      color: "#f00",
    });
    // The unregistered participant's agentSlug is null, never fabricated.
    expect(match.participants[1].agentSlug).toBeNull();
  });

  test("candidate records are filtered out entirely — operator-only, never public", () => {
    const store = featuredMatchStoreOf(
      featuredMatch({ matchId: "feat_1111111111111111cccc", state: "candidate" }),
      featuredMatch({ matchId: "feat_2222222222222222dddd", state: "scheduled" }),
    );
    const model = buildProxyWarPublicReadModel(baseMirror(), identitySnapshot(), store);
    expect(model.featuredMatches).toHaveLength(1);
    expect(model.featuredMatches[0].matchId).toBe("feat_2222222222222222dddd");
  });

  test("maps the public-safe field subset for a scheduled premiere-lane record, never leaking participants", () => {
    const record = featuredMatch({
      matchId: "feat_3333333333333333eeee",
      state: "scheduled",
      title: "Round 100: Pangaea",
      description: "A tense four-way standoff.",
      map: "Pangaea",
      format: "4p FFA",
      category: "top_four",
      scheduledAt: "2026-07-31T00:10:00.000Z",
      revealAt: "2026-07-31T01:00:00.000Z",
    });
    const model = buildProxyWarPublicReadModel(
      baseMirror(),
      identitySnapshot(),
      featuredMatchStoreOf(record),
    );
    expect(model.featuredMatches[0]).toEqual({
      matchId: "feat_3333333333333333eeee",
      lane: "premiere",
      title: "Round 100: Pangaea",
      description: "A tense four-way standoff.",
      map: "Pangaea",
      format: "4p FFA",
      category: "top_four",
      state: "scheduled",
      scheduledAt: "2026-07-31T00:10:00.000Z",
      revealAt: "2026-07-31T01:00:00.000Z",
      postMatchSummary: null,
      result: null,
    });
    // The participant's own player name must never reach the wire through this projection.
    expect(JSON.stringify(model.featuredMatches)).not.toContain("daveey");
  });

  test("EMBARGO: a scheduled premiere-lane record smuggling a populated result (schema-illegal, cast to simulate an upstream bug) still projects result: null", () => {
    const illegal = {
      ...featuredMatch({ state: "scheduled" }),
      result: { winnerAgentId: "agt_daveey", placements: [{ agentId: "agt_daveey", placement: 1 }] },
      postMatchSummary: "daveey dominated the board.",
    } as FeaturedMatch;
    const model = buildProxyWarPublicReadModel(
      baseMirror(),
      identitySnapshot(),
      featuredMatchStoreOf(illegal),
    );
    expect(model.featuredMatches[0].result).toBeNull();
    expect(model.featuredMatches[0].postMatchSummary).toBeNull();
  });

  test("EMBARGO: a published (but not yet revealed) premiere-lane record — schema-legal, since the store's own superRefine only forbids result on candidate/scheduled — is still embargoed by the projection itself", () => {
    const record = FeaturedMatchSchema.parse(
      featuredMatch({
        state: "published",
        result: { winnerAgentId: "agt_daveey", placements: [{ agentId: "agt_daveey", placement: 1 }] },
        postMatchSummary: "daveey dominated the board.",
      }),
    );
    const model = buildProxyWarPublicReadModel(
      baseMirror(),
      identitySnapshot(),
      featuredMatchStoreOf(record),
    );
    expect(model.featuredMatches[0].result).toBeNull();
    expect(model.featuredMatches[0].postMatchSummary).toBeNull();
  });

  test("a revealed premiere-lane record exposes its result and postMatchSummary unchanged", () => {
    const result = { winnerAgentId: "agt_daveey", placements: [{ agentId: "agt_daveey", placement: 1 }] };
    const record = featuredMatch({
      state: "revealed",
      result,
      postMatchSummary: "daveey dominated the board.",
    });
    const model = buildProxyWarPublicReadModel(
      baseMirror(),
      identitySnapshot(),
      featuredMatchStoreOf(record),
    );
    expect(model.featuredMatches[0].result).toEqual(result);
    expect(model.featuredMatches[0].postMatchSummary).toBe("daveey dominated the board.");
  });

  test("an archived premiere-lane record (terminal, past reveal) stays exposed", () => {
    const result = { winnerAgentId: "agt_daveey", placements: [{ agentId: "agt_daveey", placement: 1 }] };
    const record = featuredMatch({ state: "archived", result });
    const model = buildProxyWarPublicReadModel(
      baseMirror(),
      identitySnapshot(),
      featuredMatchStoreOf(record),
    );
    expect(model.featuredMatches[0].result).toEqual(result);
  });

  test("archive-lane records are never embargoed regardless of state — the match was already public before this record existed", () => {
    const result = { winnerAgentId: "agt_daveey", placements: [{ agentId: "agt_daveey", placement: 1 }] };
    const record = featuredMatch({
      lane: "archive",
      episodeRequestId: "ereq_9",
      queueItemName: null,
      state: "published",
      scheduledAt: null,
      revealAt: null,
      result,
      postMatchSummary: "A decisive win.",
    });
    const model = buildProxyWarPublicReadModel(
      baseMirror(),
      identitySnapshot(),
      featuredMatchStoreOf(record),
    );
    expect(model.featuredMatches[0].result).toEqual(result);
    expect(model.featuredMatches[0].postMatchSummary).toBe("A decisive win.");
  });

  test("an empty featured match store still yields an empty (never fabricated) featuredMatches array", () => {
    const model = buildProxyWarPublicReadModel(baseMirror(), identitySnapshot(), featuredMatchStoreOf());
    expect(model.featuredMatches).toEqual([]);
  });

  test("premieres.live reflects an active premiere card and suppresses latest", () => {
    const mirror = baseMirror({
      premiere: {
        premiereId: "prem_1",
        roundNumber: 100,
        mapLabel: "Pangaea",
        scheduledAt: "2026-07-31T00:10:00.000Z",
        premierePageLive: true,
      },
      latestPremiere: {
        premiereId: "prem_0",
        roundNumber: 99,
        mapLabel: "Britannia",
        revealedAt: "2026-07-30T00:00:00.000Z",
        href: "/premiere/prem_0",
      },
    });
    const model = buildProxyWarPublicReadModel(mirror, identitySnapshot(), featuredMatchStoreOf());
    expect(model.premieres.live?.premiereId).toBe("prem_1");
    expect(model.premieres.live?.premierePageLive).toBe(true);
    // The live card always takes precedence — latest never co-renders with it.
    expect(model.premieres.latest).toBeNull();
  });

  test("premieres.latest fills the slot only when no premiere is currently live", () => {
    const mirror = baseMirror({
      latestPremiere: {
        premiereId: "prem_0",
        roundNumber: 99,
        mapLabel: "Britannia",
        revealedAt: "2026-07-30T00:00:00.000Z",
        href: "/premiere/prem_0",
      },
    });
    const model = buildProxyWarPublicReadModel(mirror, identitySnapshot(), featuredMatchStoreOf());
    expect(model.premieres.live).toBeNull();
    expect(model.premieres.latest?.premiereId).toBe("prem_0");
  });

  test("premieres are both null when neither is present", () => {
    const model = buildProxyWarPublicReadModel(baseMirror(), identitySnapshot(), featuredMatchStoreOf());
    expect(model.premieres).toEqual({ live: null, latest: null });
  });

  test("accountUrl is absolute and cross-origin to the platform, never a relative path", () => {
    const model = buildProxyWarPublicReadModel(baseMirror(), identitySnapshot(), featuredMatchStoreOf());
    expect(model.links.accountUrl).toMatch(/^https:\/\//);
    expect(model.links.accountUrl.endsWith("/account")).toBe(true);
  });

  test("versions and builders pass through the identity snapshot verbatim", () => {
    const snapshot = identitySnapshot();
    const model = buildProxyWarPublicReadModel(baseMirror(), snapshot, featuredMatchStoreOf());
    expect(model.versions).toEqual(snapshot.versions);
    expect(model.builders).toEqual([]);
  });
});
