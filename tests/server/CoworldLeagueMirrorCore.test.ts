import { describe, expect, test } from "vitest";
import {
  buildEpisodeRow,
  buildRoundRows,
  buildStandingRows,
  parseCompletedEpisodeMetaList,
  parseHostedReplayPayload,
  parseLeagueSummary,
  pickCompetitionDivision,
  roundNumberByRoundId,
  scoreLabelFromStandings,
  shortEpisodeId,
} from "../../src/server/agents/CoworldLeagueMirrorCore";

const leagueFixture = {
  id: "league_test",
  name: "Proxywar",
  description: "Test league",
  commissioner_config: {
    stages: [{ label: "Round", num_episodes: 8 }],
    schedule_interval_minutes: 30,
  },
};

const divisionsFixture = [
  { id: "div_qualifiers", name: "Qualifiers", level: -99, member_count: 0 },
  { id: "div_competition", name: "Competition", level: 1, member_count: 6 },
];

const standingsFixture = [
  {
    rank: 2,
    player_id: "ply_b",
    player_name: "RelhAlpha",
    score: 24.13,
    rounds_played: 40,
    score_label: "Score",
    policy_label: "co-gas-proxywar-relhalpha:v1",
  },
  {
    rank: 1,
    player_id: "ply_a",
    player_name: "odin free",
    score: 31.05,
    rounds_played: 27,
    score_label: "Score",
    policy_label: "qd1n:v2",
  },
  {
    rank: 3,
    player_id: "ply_house",
    player_name: "Auri",
    score: 9.04,
    rounds_played: 2,
    score_label: "Score",
    policy_label: "proxywar-keystone:v14",
  },
];

const roundsFixture = [
  {
    id: "round_1",
    round_number: 267,
    status: "completed",
    started_at: "2026-07-13T10:00:00Z",
    completed_at: "2026-07-13T10:20:00Z",
  },
  {
    id: "round_2",
    round_number: 268,
    status: "running",
    started_at: "2026-07-13T10:36:00Z",
    completed_at: null,
  },
];

const replayMetaFixture = [
  {
    id: "ereq_aaaa1111-2222",
    status: "completed",
    round_id: "round_1",
    completed_at: "2026-07-13T10:15:00Z",
    replay_url: "https://example.com/replays/a.replay",
    game_config: { map: "Pangaea", map_size: "Compact", difficulty: "Easy" },
  },
  {
    id: "ereq_bbbb1111-2222",
    status: "completed",
    round_id: "round_2",
    completed_at: "2026-07-13T11:15:00Z",
    replay_url: "https://example.com/replays/b.replay",
    game_config: { map: "Britannia", map_size: "Compact", difficulty: "Easy" },
  },
  {
    id: "ereq_running",
    status: "running",
    round_id: "round_2",
    completed_at: null,
    replay_url: null,
    game_config: { map: "Pangaea" },
  },
];

const replayPayloadFixture = {
  schemaVersion: 1,
  replayKind: "proxywar-coworld-local-poc",
  runID: "coworld-2026-07-13T10-40-45-699Z-9ed769ef",
  results: {
    scores: [0, 0, 1, 0],
    winner_slot: 2,
    turn_count: 6000,
    decision_count: 236,
    degraded_count: 33,
    players: [
      { slot: 0, name: "odin free", tiles_owned: 597, is_alive: true },
      { slot: 1, name: "James Boggs", tiles_owned: 537, is_alive: false },
      { slot: 2, name: "daveey", tiles_owned: 89692, is_alive: true },
      { slot: 3, name: "Auri", tiles_owned: 11385, is_alive: true },
    ],
  },
  inlineRunArtifacts: {
    "game-record.json": "{}",
    "decisions.jsonl": "{}",
    "../escape.json": "{}",
    "bad/name.json": "{}",
  },
  spectatorReplay: {
    schemaVersion: 1,
    runID: "coworld-2026-07-13T10-40-45-699Z-9ed769ef",
    map: { width: 10, height: 10, gameMap: "Pangaea", gameMapSize: "Compact" },
    roster: [],
    snapshots: [
      {
        label: "final",
        turnNumber: 6000,
        tick: 6000,
        phase: "post-spawn",
        decisions: [],
        players: [
          { username: "daveey", color: "#16a34a" },
          { username: "Auri", color: "#d97706" },
        ],
      },
    ],
    notes: [],
  },
};

describe("CoworldLeagueMirrorCore", () => {
  test("parseLeagueSummary extracts cadence and episode counts", () => {
    const league = parseLeagueSummary(leagueFixture);
    expect(league).not.toBeNull();
    expect(league?.roundIntervalMinutes).toBe(30);
    expect(league?.episodesPerRound).toBe(8);
    expect(league?.name).toBe("Proxywar");
  });

  test("pickCompetitionDivision prefers the populated top-level division", () => {
    const division = pickCompetitionDivision(divisionsFixture);
    expect(division?.id).toBe("div_competition");
    expect(division?.name).toBe("Competition");
  });

  test("buildStandingRows sorts by rank and flags the house seat", () => {
    const rows = buildStandingRows(standingsFixture);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(rows[0].playerName).toBe("odin free");
    const house = rows.find((row) => row.isHouse);
    expect(house?.playerName).toBe("Auri");
    expect(rows.filter((row) => row.isHouse)).toHaveLength(1);
  });

  test("scoreLabelFromStandings falls back to Score", () => {
    expect(scoreLabelFromStandings(standingsFixture)).toBe("Score");
    expect(scoreLabelFromStandings([])).toBe("Score");
  });

  test("buildRoundRows sorts newest first and honors the limit", () => {
    const rows = buildRoundRows(roundsFixture, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].roundNumber).toBe(268);
    expect(rows[0].status).toBe("running");
  });

  test("roundNumberByRoundId maps ids", () => {
    const byId = roundNumberByRoundId(roundsFixture);
    expect(byId.get("round_1")).toBe(267);
    expect(byId.get("round_2")).toBe(268);
  });

  test("parseCompletedEpisodeMetaList keeps completed episodes, newest first", () => {
    const episodes = parseCompletedEpisodeMetaList(replayMetaFixture);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].episodeRequestId).toBe("ereq_bbbb1111-2222");
    expect(episodes[0].map).toBe("Britannia");
    expect(episodes[1].replayUrl).toBe("https://example.com/replays/a.replay");
  });

  test("parseHostedReplayPayload extracts results and filters artifact names", () => {
    const replay = parseHostedReplayPayload(replayPayloadFixture);
    expect(replay).not.toBeNull();
    expect(replay?.turnCount).toBe(6000);
    expect(replay?.degradedCount).toBe(33);
    expect(replay?.scores).toEqual([0, 0, 1, 0]);
    expect(replay?.commissionerWinnerSlots).toEqual([2]);
    expect(replay?.outrightWinnerSlot).toBe(2);
    expect(replay?.winnerSlot).toBe(2);
    expect(replay?.players).toHaveLength(4);
    expect(Object.keys(replay?.inlineRunArtifacts ?? {})).toEqual([
      "game-record.json",
      "decisions.jsonl",
    ]);
    expect(replay?.spectatorReplay).not.toBeNull();
  });

  test("buildEpisodeRow marks the winner, uses snapshot colors, sorts by tiles", () => {
    const replay = parseHostedReplayPayload(replayPayloadFixture);
    expect(replay).not.toBeNull();
    if (replay === null) {
      return;
    }
    const row = buildEpisodeRow({
      meta: parseCompletedEpisodeMetaList(replayMetaFixture)[1],
      replay,
      roundNumber: 267,
      watchHref: "../coworld-run/spectator.html",
      fullRenderHref: "/ai-league-replay/coworld-run",
    });
    expect(row.winnerName).toBe("daveey");
    expect(row.players[0].name).toBe("daveey");
    expect(row.players[0].color).toBe("#16a34a");
    expect(row.players[0].isWinner).toBe(true);
    expect(row.players[0].isCommissionerWinner).toBe(true);
    expect(row.players[0].isOutrightWinner).toBe(true);
    expect(row.players[0].score).toBe(1);
    expect(row.commissionerWinnerNames).toEqual(["daveey"]);
    expect(row.outrightWinnerName).toBe("daveey");
    const boggs = row.players.find((player) => player.name === "James Boggs");
    expect(boggs?.isAlive).toBe(false);
    expect(boggs?.color).toBe("#2563eb");
    expect(row.degradedCount).toBe(33);
    expect(row.roundNumber).toBe(267);
  });

  test("shows a fractional timeout leader without inventing an outright winner", () => {
    const timeoutReplay = parseHostedReplayPayload({
      ...replayPayloadFixture,
      results: {
        ...replayPayloadFixture.results,
        scores: [0.667169, 0.1, 0.132831, 0.1],
        winner_slot: null,
      },
    });
    expect(timeoutReplay).not.toBeNull();
    if (timeoutReplay === null) {
      return;
    }
    expect(timeoutReplay.commissionerWinnerSlots).toEqual([0]);
    expect(timeoutReplay.outrightWinnerSlot).toBeNull();
    expect(timeoutReplay.winnerSlot).toBeNull();

    const row = buildEpisodeRow({
      meta: parseCompletedEpisodeMetaList(replayMetaFixture)[1],
      replay: timeoutReplay,
      roundNumber: 267,
      watchHref: null,
      fullRenderHref: null,
    });
    const timeoutLeader = row.players.find((player) => player.slot === 0);
    expect(row.winnerName).toBeNull();
    expect(row.commissionerWinnerNames).toEqual(["odin free"]);
    expect(row.outrightWinnerName).toBeNull();
    expect(timeoutLeader?.isWinner).toBe(false);
    expect(timeoutLeader?.isCommissionerWinner).toBe(true);
    expect(timeoutLeader?.isOutrightWinner).toBe(false);
    expect(timeoutLeader?.score).toBe(0.667169);
  });

  test("keeps winner_slot display compatibility for older payloads without scores", () => {
    const legacyReplay = parseHostedReplayPayload({
      ...replayPayloadFixture,
      results: {
        ...replayPayloadFixture.results,
        scores: undefined,
      },
    });
    expect(legacyReplay).not.toBeNull();
    if (legacyReplay === null) {
      return;
    }
    expect(legacyReplay.scores).toEqual([]);
    expect(legacyReplay.commissionerWinnerSlots).toEqual([]);
    expect(legacyReplay.winnerSlot).toBe(2);

    const row = buildEpisodeRow({
      meta: parseCompletedEpisodeMetaList(replayMetaFixture)[1],
      replay: legacyReplay,
      roundNumber: 267,
      watchHref: null,
      fullRenderHref: null,
    });
    expect(row.winnerName).toBe("daveey");
    expect(row.outrightWinnerName).toBe("daveey");
    expect(row.players.find((player) => player.slot === 2)?.isWinner).toBe(
      true,
    );
  });

  test("shortEpisodeId strips the prefix and sanitizes", () => {
    expect(shortEpisodeId("ereq_c2c89bdc-28ac")).toBe("c2c89bdc");
    expect(shortEpisodeId("ereq_<evil>!!")).toBe("evil");
  });
});
