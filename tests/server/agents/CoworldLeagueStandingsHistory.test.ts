import { describe, expect, test } from "vitest";
import {
  appendStandingsHistorySnapshot,
  EMPTY_STANDINGS_HISTORY_STORE,
  parseStandingsHistoryStore,
  snapshotFromMirrorData,
  type StandingsHistorySnapshot,
} from "../../../src/server/agents/CoworldLeagueStandingsHistory";
import type { CoworldLeagueMirrorData } from "../../../src/server/agents/CoworldLeagueSiteWriter";

function sampleMirrorData(
  overrides: Partial<CoworldLeagueMirrorData> = {},
): CoworldLeagueMirrorData {
  return {
    generatedAt: "2026-07-31T12:00:00.000Z",
    lastGoodSyncAt: "2026-07-31T12:00:00.000Z",
    stale: false,
    league: {
      id: "league_test",
      name: "Proxywar",
      description: null,
      divisionName: "Competition",
      roundIntervalMinutes: 30,
      episodesPerRound: 8,
      currentRoundNumber: 268,
      currentRoundStatus: "running",
      scoreLabel: "Score",
    },
    standings: [
      {
        rank: 1,
        playerName: "odin free",
        ratingPolicyLabel: "qd1n:v2",
        activeChampionPolicyLabel: "qd1n:v2",
        policyLabel: "qd1n:v2",
        score: 31.05,
        roundsPlayed: 27,
        isHouse: false,
      },
      {
        rank: 2,
        playerName: "Auri",
        ratingPolicyLabel: "proxywar-keystone:v7",
        activeChampionPolicyLabel: null,
        policyLabel: "proxywar-keystone:v7",
        score: 9.04,
        roundsPlayed: 2,
        isHouse: true,
      },
    ],
    rounds: [],
    episodes: [],
    links: { enterTheLeagueUrl: "https://example.com/enter", platformLabel: "Proxy War" },
    ...overrides,
  };
}

describe("snapshotFromMirrorData", () => {
  test("builds a sorted, per-agent snapshot from fresh standings", () => {
    const snapshot = snapshotFromMirrorData(sampleMirrorData());
    expect(snapshot).not.toBeNull();
    expect(snapshot?.recordedAt).toBe("2026-07-31T12:00:00.000Z");
    expect(snapshot?.roundNumber).toBe(268);
    expect(snapshot?.agents.map((a) => a.playerName)).toEqual([
      "Auri",
      "odin free",
    ]);
    expect(snapshot?.agents[1]).toEqual({
      playerName: "odin free",
      score: 31.05,
      rank: 1,
      activeVersionLabel: "qd1n:v2",
    });
    // No active champion label -> falls back to the rating label, matching
    // CoworldLeagueStandingRow's own fallback order.
    expect(snapshot?.agents[0].activeVersionLabel).toBe(
      "proxywar-keystone:v7",
    );
  });

  test("returns null for a stale republish — never records a duplicate point under a new timestamp", () => {
    expect(snapshotFromMirrorData(sampleMirrorData({ stale: true }))).toBeNull();
  });

  test("returns null with no standings to snapshot yet", () => {
    expect(
      snapshotFromMirrorData(sampleMirrorData({ standings: [] })),
    ).toBeNull();
  });
});

describe("appendStandingsHistorySnapshot", () => {
  const snapshotA: StandingsHistorySnapshot = {
    recordedAt: "2026-07-31T12:00:00.000Z",
    roundNumber: 268,
    agents: [
      { playerName: "Auri", score: 9.04, rank: 2, activeVersionLabel: "v7" },
    ],
  };

  test("appends a genuinely new snapshot", () => {
    const store = appendStandingsHistorySnapshot(
      EMPTY_STANDINGS_HISTORY_STORE,
      snapshotA,
    );
    expect(store.snapshots).toEqual([snapshotA]);
  });

  test("dedupes an identical snapshot for the same round — no growth on a no-op poll", () => {
    const store = appendStandingsHistorySnapshot(
      EMPTY_STANDINGS_HISTORY_STORE,
      snapshotA,
    );
    const again = appendStandingsHistorySnapshot(store, {
      ...snapshotA,
      recordedAt: "2026-07-31T12:00:30.000Z",
    });
    expect(again).toBe(store);
    expect(again.snapshots).toHaveLength(1);
  });

  test("appends when score changes mid-round, even with the same round number", () => {
    const store = appendStandingsHistorySnapshot(
      EMPTY_STANDINGS_HISTORY_STORE,
      snapshotA,
    );
    const moved = appendStandingsHistorySnapshot(store, {
      ...snapshotA,
      recordedAt: "2026-07-31T12:05:00.000Z",
      agents: [
        { playerName: "Auri", score: 10.5, rank: 1, activeVersionLabel: "v7" },
      ],
    });
    expect(moved.snapshots).toHaveLength(2);
    expect(moved).not.toBe(store);
  });

  test("appends when the round number advances even with identical scores", () => {
    const store = appendStandingsHistorySnapshot(
      EMPTY_STANDINGS_HISTORY_STORE,
      snapshotA,
    );
    const nextRound = appendStandingsHistorySnapshot(store, {
      ...snapshotA,
      recordedAt: "2026-07-31T12:30:00.000Z",
      roundNumber: 269,
    });
    expect(nextRound.snapshots).toHaveLength(2);
  });
});

describe("parseStandingsHistoryStore", () => {
  test("parses a well-formed store", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      snapshots: [
        {
          recordedAt: "2026-07-31T12:00:00.000Z",
          roundNumber: 1,
          agents: [],
        },
      ],
    });
    const parsed = parseStandingsHistoryStore(raw);
    expect(parsed).not.toBe("corrupt");
    if (parsed !== "corrupt") {
      expect(parsed.snapshots).toHaveLength(1);
    }
  });

  test("returns \"corrupt\" for invalid JSON — never throws", () => {
    expect(parseStandingsHistoryStore("{not json")).toBe("corrupt");
  });

  test("returns \"corrupt\" for a well-formed but wrong-shaped JSON value", () => {
    expect(parseStandingsHistoryStore(JSON.stringify({ foo: "bar" }))).toBe(
      "corrupt",
    );
    expect(
      parseStandingsHistoryStore(
        JSON.stringify({ schemaVersion: 2, snapshots: [] }),
      ),
    ).toBe("corrupt");
  });
});
