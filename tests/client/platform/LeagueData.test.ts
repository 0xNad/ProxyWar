/**
 * Coverage for the public league-data join layer: defensive parsing of the
 * externally-generated `data.json` snapshot and its viewer-facing derivations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchLeagueData,
  headToHead,
  parseLeagueData,
  recentForm,
  resetLeagueDataCacheForTests,
  resolveSeatStanding,
  type LeagueDataSnapshot,
} from "../../../src/client/platform/LeagueData";

function rawSnapshot(overrides: Record<string, unknown> = {}): unknown {
  return {
    generatedAt: "2026-07-27T13:00:00.000Z",
    lastGoodSyncAt: "2026-07-27T13:00:00.000Z",
    stale: false,
    standings: [
      {
        rank: 1,
        playerName: "daveey",
        ratingPolicyLabel: "daveey-proxywar:v24",
        activeChampionPolicyLabel: "daveey-proxywar:v24",
        policyLabel: "daveey-proxywar:v24",
        score: 20.5,
        roundsPlayed: 626,
        isHouse: false,
      },
      {
        rank: 2,
        playerName: "relh",
        ratingPolicyLabel: "relh-proxywar:v9",
        activeChampionPolicyLabel: "relh-proxywar:v9",
        policyLabel: "relh-proxywar:v9",
        score: 15.2,
        roundsPlayed: 272,
        isHouse: false,
      },
    ],
    episodes: [
      {
        episodeRequestId: "ereq_1",
        roundNumber: 887,
        completedAt: "2026-07-27T12:00:00.000Z",
        winnerName: "daveey",
        players: [
          { name: "daveey", isAlive: true, isWinner: true },
          { name: "relh", isAlive: false, isWinner: false },
        ],
      },
      {
        episodeRequestId: "ereq_0_older",
        roundNumber: 886,
        completedAt: "2026-07-27T10:00:00.000Z",
        winnerName: "relh",
        players: [
          { name: "daveey", isAlive: false, isWinner: false },
          { name: "relh", isAlive: true, isWinner: true },
        ],
      },
    ],
    ...overrides,
  };
}

describe("parseLeagueData", () => {
  it("parses a well-formed snapshot", () => {
    const data = parseLeagueData(rawSnapshot());
    expect(data).not.toBeNull();
    expect(data?.standings).toHaveLength(2);
    expect(data?.episodes).toHaveLength(2);
    expect(data?.stale).toBe(false);
  });

  it("sorts episodes newest-first regardless of input order", () => {
    const data = parseLeagueData(
      rawSnapshot({
        episodes: [
          {
            episodeRequestId: "ereq_0_older",
            roundNumber: 886,
            completedAt: "2026-07-27T10:00:00.000Z",
            winnerName: "relh",
            players: [
              { name: "daveey", isAlive: false, isWinner: false },
              { name: "relh", isAlive: true, isWinner: true },
            ],
          },
          {
            episodeRequestId: "ereq_1",
            roundNumber: 887,
            completedAt: "2026-07-27T12:00:00.000Z",
            winnerName: "daveey",
            players: [
              { name: "daveey", isAlive: true, isWinner: true },
              { name: "relh", isAlive: false, isWinner: false },
            ],
          },
        ],
      }),
    );
    expect(data?.episodes.map((e) => e.episodeRequestId)).toEqual([
      "ereq_1",
      "ereq_0_older",
    ]);
  });

  it("returns null for an unusable top-level shape", () => {
    expect(parseLeagueData(null)).toBeNull();
    expect(parseLeagueData({})).toBeNull();
    expect(
      parseLeagueData({ standings: [], episodes: "not-an-array" }),
    ).toBeNull();
  });

  it("drops individually malformed rows instead of throwing", () => {
    const raw = rawSnapshot({
      standings: [
        {
          rank: 1,
          playerName: "daveey",
          score: 20.5,
          roundsPlayed: 626,
          isHouse: false,
        },
        { rank: "not-a-number", playerName: "broken" },
        null,
      ],
      episodes: [
        {
          episodeRequestId: "ereq_ok",
          players: [{ name: "daveey", isAlive: true, isWinner: true }],
        },
        { episodeRequestId: "ereq_no_players", players: [] },
        { episodeRequestId: "ereq_bad_players", players: "nope" },
      ],
    });
    const data = parseLeagueData(raw);
    expect(data?.standings).toHaveLength(1);
    expect(data?.standings[0]?.playerName).toBe("daveey");
    expect(data?.episodes).toHaveLength(1);
    expect(data?.episodes[0]?.episodeRequestId).toBe("ereq_ok");
  });

  it("normalizes missing optional fields to null/false without fabricating values", () => {
    const data = parseLeagueData(
      rawSnapshot({
        stale: undefined,
        standings: [
          {
            rank: 5,
            playerName: "newcomer",
            ratingPolicyLabel: null,
            activeChampionPolicyLabel: null,
            policyLabel: null,
            score: null,
            roundsPlayed: null,
            isHouse: false,
          },
        ],
      }),
    );
    expect(data?.stale).toBe(false);
    expect(data?.standings[0]).toEqual({
      rank: 5,
      playerName: "newcomer",
      ratingPolicyLabel: null,
      activeChampionPolicyLabel: null,
      policyLabel: null,
      score: null,
      roundsPlayed: null,
      isHouse: false,
    });
  });
});

describe("fetchLeagueData", () => {
  beforeEach(() => {
    resetLeagueDataCacheForTests();
  });

  it("fetches and parses the public league mirror", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => rawSnapshot(),
    })) as unknown as typeof fetch;
    const data = await fetchLeagueData(fetchImpl);
    expect(data?.standings).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledWith("/ai-league-runs/league/data.json", {
      headers: { accept: "application/json" },
    });
  });

  it("resolves null on a non-200 response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const data = await fetchLeagueData(fetchImpl);
    expect(data).toBeNull();
  });

  it("resolves null instead of rejecting on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(fetchLeagueData(fetchImpl)).resolves.toBeNull();
  });

  it("caches across calls within a page load — one request per process", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => rawSnapshot(),
    })) as unknown as typeof fetch;
    await fetchLeagueData(fetchImpl);
    await fetchLeagueData(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("resolveSeatStanding", () => {
  let data: LeagueDataSnapshot;
  beforeEach(() => {
    data = parseLeagueData(rawSnapshot())!;
  });

  it("maps a real league seat (softmax_policy_version) by policy label", () => {
    const standing = resolveSeatStanding(data, {
      displayName: "daveey",
      policyIdentity: {
        namespace: "softmax_policy_version",
        policyVersionId: "v24-id",
        policyName: "daveey-proxywar:v24",
        serverAssignedVersion: "24",
      },
    });
    expect(standing?.playerName).toBe("daveey");
    expect(standing?.rank).toBe(1);
  });

  it("falls back to player-name match when the policy label has moved on", () => {
    const standing = resolveSeatStanding(data, {
      displayName: "relh",
      policyIdentity: {
        namespace: "softmax_policy_version",
        policyVersionId: "stale-id",
        policyName: "relh-proxywar:v1-retired",
        serverAssignedVersion: "1",
      },
    });
    expect(standing?.playerName).toBe("relh");
  });

  it("never maps a synthetic exhibition persona (local_manifest)", () => {
    const standing = resolveSeatStanding(data, {
      displayName: "Diplomat",
      policyIdentity: {
        namespace: "local_manifest",
        manifestName: "diplomat",
        declaredVersion: "1",
        manifestSha256: "abc",
        contentSha256: "def",
      },
    });
    expect(standing).toBeNull();
  });

  it("returns null when the seat carries no identity at all", () => {
    expect(resolveSeatStanding(data, { displayName: "Nobody" })).toBeNull();
  });

  it("returns null for a real-namespace seat absent from current standings", () => {
    const standing = resolveSeatStanding(data, {
      displayName: "unknown-player",
      policyIdentity: {
        namespace: "softmax_policy_version",
        policyVersionId: "x",
        policyName: "unknown-policy:v1",
        serverAssignedVersion: "1",
      },
    });
    expect(standing).toBeNull();
  });
});

describe("recentForm", () => {
  it("returns newest-first outcomes for a player, capped at the limit", () => {
    const data = parseLeagueData(rawSnapshot())!;
    const form = recentForm(data, "daveey", 5);
    expect(form.map((f) => f.outcome)).toEqual(["won", "eliminated"]);
  });

  it("returns an empty list for a player absent from every episode", () => {
    const data = parseLeagueData(rawSnapshot())!;
    expect(recentForm(data, "nobody", 5)).toEqual([]);
  });

  it("respects the limit", () => {
    const data = parseLeagueData(rawSnapshot())!;
    expect(recentForm(data, "daveey", 1)).toHaveLength(1);
  });
});

describe("headToHead", () => {
  it("counts shared episodes and each side's wins within them", () => {
    const data = parseLeagueData(rawSnapshot())!;
    const record = headToHead(data, "daveey", "relh");
    expect(record.meetings).toBe(2);
    expect(record.subjectWins).toBe(1);
    expect(record.opponentWins).toBe(1);
  });

  it("is zero for two players who have never shared an episode", () => {
    const data = parseLeagueData(
      rawSnapshot({
        episodes: [
          {
            episodeRequestId: "ereq_solo",
            roundNumber: 900,
            completedAt: "2026-07-27T14:00:00.000Z",
            players: [{ name: "daveey", isAlive: true, isWinner: true }],
          },
        ],
      }),
    )!;
    expect(headToHead(data, "daveey", "relh")).toEqual({
      meetings: 0,
      subjectWins: 0,
      opponentWins: 0,
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
