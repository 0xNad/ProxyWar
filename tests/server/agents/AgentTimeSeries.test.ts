import { describe, expect, test } from "vitest";
import {
  computeAgentTimeSeries,
  computeScoreSeries,
  computeWinrateSeries,
  type WinLossEpisode,
} from "../../../src/server/agents/AgentTimeSeries";
import type { StandingsHistorySnapshot } from "../../../src/server/agents/CoworldLeagueStandingsHistory";

function episode(completedAt: string | null, isWinner: boolean): WinLossEpisode {
  return { completedAt, isWinner };
}

describe("computeWinrateSeries", () => {
  test("hides the whole series below the documented episode minimum", () => {
    const episodes = [
      episode("2026-07-01T00:00:00.000Z", true),
      episode("2026-07-02T00:00:00.000Z", false),
      episode("2026-07-03T00:00:00.000Z", true),
      episode("2026-07-04T00:00:00.000Z", false),
    ];
    expect(computeWinrateSeries(episodes)).toBeNull();
  });

  test("computes a chronological cumulative winrate once the threshold is met", () => {
    const episodes = [
      episode("2026-07-05T00:00:00.000Z", true),
      episode("2026-07-01T00:00:00.000Z", true),
      episode("2026-07-03T00:00:00.000Z", false),
      episode("2026-07-02T00:00:00.000Z", false),
      episode("2026-07-04T00:00:00.000Z", true),
    ];
    const series = computeWinrateSeries(episodes);
    expect(series).not.toBeNull();
    expect(series?.points.map((p) => p.completedAt)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T00:00:00.000Z",
      "2026-07-04T00:00:00.000Z",
      "2026-07-05T00:00:00.000Z",
    ]);
    // Win, loss, loss, win, win -> cumulative winRate: 1/1, 1/2, 1/3, 2/4, 3/5
    expect(series?.points.map((p) => p.winRate)).toEqual([
      1,
      0.5,
      1 / 3,
      0.5,
      0.6,
    ]);
    expect(series?.points.map((p) => p.episodesSoFar)).toEqual([1, 2, 3, 4, 5]);
    expect(series?.threshold).toBe(5);
  });

  test("never counts an episode with no timestamp — undated outcomes cannot be plotted honestly", () => {
    const episodes = [
      episode("2026-07-01T00:00:00.000Z", true),
      episode("2026-07-02T00:00:00.000Z", true),
      episode("2026-07-03T00:00:00.000Z", true),
      episode("2026-07-04T00:00:00.000Z", true),
      episode(null, false),
      episode(null, false),
    ];
    // Only 4 dated episodes -> below the threshold of 5, series hidden even
    // though 6 episodes exist in total.
    expect(computeWinrateSeries(episodes)).toBeNull();
  });

  test("is deterministic across repeated calls on the same input", () => {
    const episodes = [
      episode("2026-07-01T00:00:00.000Z", true),
      episode("2026-07-02T00:00:00.000Z", false),
      episode("2026-07-03T00:00:00.000Z", true),
      episode("2026-07-04T00:00:00.000Z", false),
      episode("2026-07-05T00:00:00.000Z", true),
    ];
    expect(computeWinrateSeries(episodes)).toEqual(
      computeWinrateSeries(episodes.slice().reverse()),
    );
  });
});

function snapshot(
  recordedAt: string,
  agents: readonly {
    playerName: string;
    score: number | null;
    rank: number;
    activeVersionLabel: string | null;
  }[],
  roundNumber: number | null = 1,
): StandingsHistorySnapshot {
  return { recordedAt, roundNumber, agents };
}

describe("computeScoreSeries", () => {
  test("hides the series below the 2-snapshot minimum", () => {
    const snapshots = [
      snapshot("2026-07-31T12:00:00.000Z", [
        { playerName: "Auri", score: 9.0, rank: 2, activeVersionLabel: "v7" },
      ]),
    ];
    expect(computeScoreSeries(snapshots, "Auri")).toBeNull();
  });

  test("skips a snapshot where this agent has no rated score yet, without fabricating a zero", () => {
    const snapshots = [
      snapshot("2026-07-31T11:00:00.000Z", [
        { playerName: "Auri", score: null, rank: 5, activeVersionLabel: "v7" },
      ]),
      snapshot("2026-07-31T12:00:00.000Z", [
        { playerName: "Auri", score: 9.0, rank: 2, activeVersionLabel: "v7" },
      ]),
      snapshot("2026-07-31T13:00:00.000Z", [
        { playerName: "Auri", score: 10.0, rank: 1, activeVersionLabel: "v7" },
      ]),
    ];
    const series = computeScoreSeries(snapshots, "Auri");
    expect(series).not.toBeNull();
    expect(series?.points).toHaveLength(2);
    expect(series?.recordedSince).toBe("2026-07-31T12:00:00.000Z");
  });

  test("marks the first snapshot carrying a version label, and each later change, as versionFirstObserved", () => {
    const snapshots = [
      snapshot("2026-07-31T10:00:00.000Z", [
        { playerName: "Auri", score: 9.0, rank: 2, activeVersionLabel: "v7" },
      ]),
      snapshot("2026-07-31T11:00:00.000Z", [
        { playerName: "Auri", score: 9.5, rank: 2, activeVersionLabel: "v7" },
      ]),
      snapshot("2026-07-31T12:00:00.000Z", [
        { playerName: "Auri", score: 10.0, rank: 1, activeVersionLabel: "v8" },
      ]),
    ];
    const series = computeScoreSeries(snapshots, "Auri");
    expect(series?.points.map((p) => p.versionFirstObserved)).toEqual([
      true,
      false,
      true,
    ]);
  });

  test("only tracks the requested player among multiple agents in each snapshot", () => {
    const snapshots = [
      snapshot("2026-07-31T10:00:00.000Z", [
        { playerName: "Auri", score: 9.0, rank: 2, activeVersionLabel: "v7" },
        { playerName: "odin free", score: 31.0, rank: 1, activeVersionLabel: "v2" },
      ]),
      snapshot("2026-07-31T11:00:00.000Z", [
        { playerName: "Auri", score: 9.5, rank: 2, activeVersionLabel: "v7" },
        { playerName: "odin free", score: 32.0, rank: 1, activeVersionLabel: "v2" },
      ]),
    ];
    const series = computeScoreSeries(snapshots, "Auri");
    expect(series?.points.map((p) => p.score)).toEqual([9.0, 9.5]);
  });
});

describe("computeAgentTimeSeries", () => {
  test("computes both series independently and never throws when both are below threshold", () => {
    const result = computeAgentTimeSeries([], [], "Nobody");
    expect(result).toEqual({ winrate: null, score: null });
  });
});
