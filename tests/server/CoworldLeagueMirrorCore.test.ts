import { describe, expect, test } from "vitest";
import {
  activeChampionPolicyLabelsByPlayerId,
  buildCoworldReplayUiArtifact,
  buildEpisodeRow,
  buildRoundRows,
  buildStandingRows,
  mapNameFromVariant,
  mergeEpisodeRows,
  parseCompletedEpisodeMetaList,
  parseHostedReplayPayload,
  parseLeagueSummary,
  pickCompetitionDivision,
  premiereHrefForEpisode,
  resolveLatestRevealedPremiere,
  revealedPremiereIdsFromArchiveIndex,
  roundNumberByRoundId,
  scoreLabelFromStandings,
  selectServingLatestPremiere,
  shortEpisodeId,
  summarizePremiereArchiveIndex,
} from "../../src/server/agents/CoworldLeagueMirrorCore";
import type { LatestPremierePointer } from "../../src/server/agents/CoworldLeaguePremiereSuppression";
import { derivePremiereId } from "../../src/server/replay-premiere/ReplayPremiereLoopCore";

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
    policy_label: "proxywar-keystone:v7",
  },
];

const championMembershipsFixture = [
  {
    status: "competing",
    substatus: "active",
    is_champion: true,
    end_time: null,
    start_time: "2026-07-15T18:00:00Z",
    policy_version: {
      player_id: "ply_a",
      label: "qd1n:v2",
    },
  },
  {
    status: "competing",
    substatus: "active",
    is_champion: true,
    end_time: null,
    start_time: "2026-07-15T19:00:00Z",
    policy_version: {
      player_id: "ply_house",
      label: "proxywar-keystone:v40",
    },
  },
  {
    status: "competing",
    substatus: "benched",
    is_champion: false,
    end_time: null,
    policy_version: {
      player_id: "ply_house",
      label: "proxywar-keystone:v39",
    },
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
  // The hosted replay payload carries the authoritative runner config
  // (snake_case), even though the replays-list `game_config` is now empty.
  config: { map: "Britannia", map_size: "Normal", difficulty: "Easy" },
  results: {
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

  test("maps only active competing champion memberships by player", () => {
    const labels = activeChampionPolicyLabelsByPlayerId([
      ...championMembershipsFixture,
      {
        status: "competing",
        substatus: "active",
        is_champion: true,
        end_time: null,
        start_time: "2026-07-15T17:00:00Z",
        player: { id: "ply_house" },
        policy_version: {
          player_id: "ply_house",
          label: "proxywar-keystone:v39",
        },
      },
      {
        status: "competing",
        substatus: "inactive",
        is_champion: true,
        end_time: "2026-07-15T16:00:00Z",
        player: { id: "ply_b" },
        policy_version: { label: "retired:v1" },
      },
    ]);
    expect(Object.fromEntries(labels)).toEqual({
      ply_a: "qd1n:v2",
      ply_house: "proxywar-keystone:v40",
    });
  });

  test("buildStandingRows keeps rating provenance and adds the active champion", () => {
    const rows = buildStandingRows(
      standingsFixture,
      championMembershipsFixture,
    );
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(rows[0].playerName).toBe("odin free");
    expect(rows[0].ratingPolicyLabel).toBe("qd1n:v2");
    expect(rows[0].activeChampionPolicyLabel).toBe("qd1n:v2");
    const house = rows.find((row) => row.isHouse);
    expect(house?.playerName).toBe("Auri");
    expect(house?.ratingPolicyLabel).toBe("proxywar-keystone:v7");
    expect(house?.activeChampionPolicyLabel).toBe("proxywar-keystone:v40");
    expect(house?.policyLabel).toBe("proxywar-keystone:v7");
    expect(rows.filter((row) => row.isHouse)).toHaveLength(1);
  });

  test("buildStandingRows reports an absent rating policy as null, not jargon", () => {
    // A missing policy_label used to become the literal "unknown policy",
    // which shipped that internal string onto the public standings and made
    // the site writer's own "Not yet rated" fallback unreachable.
    const rows = buildStandingRows(
      [{ rank: 1, player_name: "newcomer", player_id: "p-new" }],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ratingPolicyLabel).toBeNull();
    expect(rows[0].policyLabel).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("unknown policy");
  });

  test("keeps publishing rating provenance when champion memberships are unavailable", () => {
    const rows = buildStandingRows(standingsFixture);
    const ratingRow = rows.find((row) => row.playerName === "Auri");
    expect(ratingRow).toMatchObject({
      ratingPolicyLabel: "proxywar-keystone:v7",
      activeChampionPolicyLabel: null,
      policyLabel: "proxywar-keystone:v7",
      isHouse: false,
    });
  });

  test("does not treat a Keystone lookalike prefix as the house policy", () => {
    const rows = buildStandingRows(standingsFixture, [
      {
        status: "competing",
        substatus: "active",
        is_champion: true,
        end_time: null,
        player: { id: "ply_house" },
        policy_version: {
          player_id: "ply_house",
          label: "proxywar-keystone-copy:v1",
        },
      },
    ]);
    expect(rows.find((row) => row.playerName === "Auri")?.isHouse).toBe(false);
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

  test("parseCompletedEpisodeMetaList rejects unsafe episode request ids", () => {
    const episodes = parseCompletedEpisodeMetaList([
      ...replayMetaFixture,
      {
        ...replayMetaFixture[0],
        id: "ereq_../../victim",
        completed_at: "2026-07-13T12:00:00Z",
      },
    ]);

    expect(episodes.map((entry) => entry.episodeRequestId)).toEqual([
      "ereq_bbbb1111-2222",
      "ereq_aaaa1111-2222",
    ]);
  });

  test("parseHostedReplayPayload extracts results and filters artifact names", () => {
    const replay = parseHostedReplayPayload(replayPayloadFixture);
    expect(replay).not.toBeNull();
    expect(replay?.turnCount).toBe(6000);
    expect(replay?.degradedCount).toBe(33);
    expect(replay?.winnerSlot).toBe(2);
    expect(replay?.players).toHaveLength(4);
    expect(Object.keys(replay?.inlineRunArtifacts ?? {})).toEqual([
      "game-record.json",
      "decisions.jsonl",
    ]);
    expect(replay?.spectatorReplay).not.toBeNull();
  });

  test("buildCoworldReplayUiArtifact keeps bounded recent decisions and artifact truth", () => {
    const decisions = Array.from({ length: 65 }, (_, index) =>
      JSON.stringify({
        sequence: index + 1,
        turnNumber: (index + 1) * 100,
        username: `Agent ${index % 3}`,
        profile: "opportunistic",
        brainType: "external-http",
        selectedActionKind: index % 2 === 0 ? "attack" : "hold",
        selectedLegalActionId: `action:${index + 1}`,
        selectedActionMetadata: {
          targetName: "Rival",
          expansion: index % 2 === 0,
          ignoredLargeField: "x".repeat(5_000),
        },
        reason: `reason ${index + 1}`,
        decisionLatencyMs: 10,
        fallbackUsed: index % 10 === 0,
        parseSuccess: true,
        result: {
          accepted: index % 7 !== 0,
          reason: "accepted",
        },
        rawProviderOutput: `private-debug-${index}`,
      }),
    ).join("\n");

    const artifact = buildCoworldReplayUiArtifact({
      "decisions.jsonl": `${decisions}\nnot-json\n`,
      "match-summary.json": "{}",
      "spectator-telemetry.json": "{}",
    });

    expect(artifact.version).toBe(1);
    expect(artifact.decisionCount).toBe(65);
    expect(artifact.recentDecisions).toHaveLength(60);
    expect(artifact.recentDecisions[0]?.sequence).toBe(6);
    expect(artifact.recentDecisions.at(-1)?.sequence).toBe(65);
    expect(artifact.fallbackCount).toBe(7);
    expect(artifact.rejectedCount).toBe(10);
    expect(artifact.actionCounts).toEqual({ attack: 33, hold: 32 });
    expect(artifact.artifacts).toEqual({
      visualReport: false,
      spectatorTelemetry: true,
      decisions: true,
      summary: true,
    });
    expect(JSON.stringify(artifact)).not.toContain("rawProviderOutput");
    expect(JSON.stringify(artifact)).not.toContain("private-debug");
    expect(
      artifact.recentDecisions[0]?.selectedActionMetadata,
    ).not.toHaveProperty("ignoredLargeField");
  });

  test.each([
    "../../victim",
    "/tmp/victim",
    "coworld-../victim",
    "coworld-..\\victim",
    "coworld-%2Fvictim",
    ".",
    "..",
  ])("rejects unsafe hosted replay run id %s", (runID) => {
    expect(
      parseHostedReplayPayload({ ...replayPayloadFixture, runID }),
    ).toBeNull();
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
    const boggs = row.players.find((player) => player.name === "James Boggs");
    expect(boggs?.isAlive).toBe(false);
    expect(boggs?.color).toBe("#2563eb");
    expect(row.degradedCount).toBe(33);
    expect(row.roundNumber).toBe(267);
  });

  test("fills replay gaps chronologically while preferring fresh duplicate rows", () => {
    const replay = parseHostedReplayPayload(replayPayloadFixture);
    expect(replay).not.toBeNull();
    if (replay === null) {
      return;
    }
    const base = buildEpisodeRow({
      meta: parseCompletedEpisodeMetaList(replayMetaFixture)[1],
      replay,
      roundNumber: 267,
      watchHref: "../coworld-run/spectator.html",
      fullRenderHref: "/ai-league-replay/coworld-run",
    });
    const freshNewest = {
      ...base,
      episodeRequestId: "newest",
      completedAt: "2026-07-13T12:00:00Z",
    };
    const freshOlder = {
      ...base,
      episodeRequestId: "older",
      completedAt: "2026-07-13T10:00:00Z",
    };
    const previousDuplicate = {
      ...base,
      episodeRequestId: "newest",
      completedAt: "2026-07-13T12:00:00Z",
      map: "stale duplicate",
    };
    const previousFallback = {
      ...base,
      episodeRequestId: "middle",
      completedAt: "2026-07-13T11:00:00Z",
    };

    const rows = mergeEpisodeRows(
      [freshNewest, freshOlder],
      [previousDuplicate, previousFallback],
      3,
    );

    expect(rows.map((row) => row.episodeRequestId)).toEqual([
      "newest",
      "middle",
      "older",
    ]);
    expect(rows[0].map).toBe(freshNewest.map);
  });

  test("shortEpisodeId strips the prefix and sanitizes", () => {
    expect(shortEpisodeId("ereq_c2c89bdc-28ac")).toBe("c2c89bdc");
    expect(shortEpisodeId("ereq_<evil>!!")).toBe("evil");
  });

  test("mapNameFromVariant reads the map after the last hyphen segment", () => {
    expect(mapNameFromVariant("Tournament 12P - Pangaea")).toBe("Pangaea");
    expect(mapNameFromVariant("Tournament 12P - World")).toBe("World");
    expect(mapNameFromVariant("Qualifier 2P - Black Sea")).toBe("Black Sea");
    expect(mapNameFromVariant("Tournament 12P -    ")).toBeNull();
    expect(mapNameFromVariant("NoSeparatorHere")).toBeNull();
    expect(mapNameFromVariant(null)).toBeNull();
    expect(mapNameFromVariant(42)).toBeNull();
  });

  test("parseCompletedEpisodeMetaList derives the map from variant_name when game_config is empty", () => {
    const episodes = parseCompletedEpisodeMetaList([
      {
        id: "ereq_variant-empty",
        status: "completed",
        round_id: "round_1",
        completed_at: "2026-07-21T23:43:00Z",
        replay_url: "https://example.com/replays/v.replay",
        game_config: {},
        variant_name: "Tournament 12P - World",
      },
      {
        id: "ereq_variant-null",
        status: "completed",
        round_id: "round_1",
        completed_at: "2026-07-21T23:13:00Z",
        replay_url: "https://example.com/replays/w.replay",
        game_config: null,
        variant_name: "Tournament 12P - Pangaea",
      },
    ]);
    expect(episodes.map((entry) => entry.map)).toEqual(["World", "Pangaea"]);
    expect(episodes[0].variantName).toBe("Tournament 12P - World");
    expect(episodes[0].mapSize).toBe("");
    expect(episodes[0].legacyConfigMap).toBeNull();
  });

  test("parseCompletedEpisodeMetaList prefers variant_name over a legacy game_config.map", () => {
    const [episode] = parseCompletedEpisodeMetaList([
      {
        id: "ereq_variant-wins",
        status: "completed",
        round_id: "round_1",
        completed_at: "2026-07-21T23:43:00Z",
        replay_url: "https://example.com/replays/x.replay",
        game_config: { map: "LegacyIsland", map_size: "Compact" },
        variant_name: "Tournament 12P - World",
      },
    ]);
    expect(episode.map).toBe("World");
    expect(episode.legacyConfigMap).toBe("LegacyIsland");
    expect(episode.mapSize).toBe("Compact");
  });

  test("parseCompletedEpisodeMetaList still reads a legacy game_config.map with no variant", () => {
    const [episode] = parseCompletedEpisodeMetaList([
      {
        id: "ereq_legacy-only",
        status: "completed",
        round_id: "round_1",
        completed_at: "2026-07-21T23:43:00Z",
        replay_url: "https://example.com/replays/y.replay",
        game_config: { map: "Africa", map_size: "Large" },
      },
    ]);
    expect(episode.map).toBe("Africa");
    expect(episode.mapSize).toBe("Large");
  });

  test("parseCompletedEpisodeMetaList falls back to Unknown map with neither source", () => {
    const [episode] = parseCompletedEpisodeMetaList([
      {
        id: "ereq_no-map",
        status: "completed",
        round_id: "round_1",
        completed_at: "2026-07-21T23:43:00Z",
        replay_url: "https://example.com/replays/z.replay",
        game_config: {},
      },
    ]);
    expect(episode.map).toBe("Unknown map");
    expect(episode.mapSize).toBe("");
    expect(episode.variantName).toBeNull();
  });

  test("parseHostedReplayPayload reads map and size from the replay config", () => {
    const replay = parseHostedReplayPayload(replayPayloadFixture);
    expect(replay?.map).toBe("Britannia");
    expect(replay?.mapSize).toBe("Normal");
  });

  test("parseHostedReplayPayload reads a raw game-record config as a fallback", () => {
    const replay = parseHostedReplayPayload({
      ...replayPayloadFixture,
      config: undefined,
      gameRecord: {
        info: { config: { gameMap: "Asia", gameMapSize: "Huge" } },
      },
    });
    expect(replay?.map).toBe("Asia");
    expect(replay?.mapSize).toBe("Huge");
  });

  test("buildEpisodeRow keeps the variant map, enriches size, and drops difficulty", () => {
    const replay = parseHostedReplayPayload(replayPayloadFixture);
    expect(replay).not.toBeNull();
    if (replay === null) {
      return;
    }
    const [meta] = parseCompletedEpisodeMetaList([
      {
        id: "ereq_variant-row",
        status: "completed",
        round_id: "round_1",
        completed_at: "2026-07-21T23:43:00Z",
        replay_url: "https://example.com/replays/r.replay",
        game_config: {},
        variant_name: "Tournament 12P - World",
      },
    ]);
    const row = buildEpisodeRow({
      meta,
      replay,
      roundNumber: 1,
      watchHref: null,
      fullRenderHref: null,
    });
    // The variant label wins over the replay config's "Britannia".
    expect(row.map).toBe("World");
    // Map size comes from the authoritative replay config.
    expect(row.mapSize).toBe("Normal");
    expect(row).not.toHaveProperty("difficulty");
  });

  test("buildEpisodeRow recovers the map from the replay config when the list has none", () => {
    const replay = parseHostedReplayPayload(replayPayloadFixture);
    expect(replay).not.toBeNull();
    if (replay === null) {
      return;
    }
    const [meta] = parseCompletedEpisodeMetaList([
      {
        id: "ereq_no-list-map",
        status: "completed",
        round_id: "round_1",
        completed_at: "2026-07-21T23:43:00Z",
        replay_url: "https://example.com/replays/n.replay",
        game_config: {},
      },
    ]);
    // The list alone cannot resolve the map for this row.
    expect(meta.map).toBe("Unknown map");
    const row = buildEpisodeRow({
      meta,
      replay,
      roundNumber: 1,
      watchHref: null,
      fullRenderHref: null,
    });
    // Recovered from the authoritative replay config.
    expect(row.map).toBe("Britannia");
    expect(row.mapSize).toBe("Normal");
  });
});

describe("revealed-premiere battle-card links (every round premieres, 2026-07-22)", () => {
  const revealedEpisodeId = "ereq_00000000-0000-0000-0000-0000000000aa";
  const revealedPremiereId = derivePremiereId(revealedEpisodeId);
  // A production-shaped archive pointer line (see ReplayPremiereArchiveIndex).
  const pointerLine = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      schemaVersion: 1,
      premiereId: revealedPremiereId,
      sourceRunId: "coworld-2026-07-22T04-44-01-038Z-55ad38ae",
      sourceKind: "rated_coworld",
      terminalState: "revealed",
      revealedAt: "2026-07-22T04:51:41.304Z",
      publicationCommitmentHash: "a".repeat(64),
      sourceReplaySha256: "b".repeat(64),
      summaryHash: "c".repeat(64),
      summaryRelPath: `summaries/${revealedPremiereId}.summary.json`,
      reclaimedAt: "2026-07-22T05:22:20.478Z",
      ...overrides,
    });

  test("collects revealed pointers and filters failed/cancelled/reveal-less ones", () => {
    const raw = [
      pointerLine(),
      pointerLine({
        premiereId: "prem_failedfailedfailed1",
        terminalState: "failed",
        revealedAt: null,
      }),
      pointerLine({
        premiereId: "prem_cancelledcancelled1",
        terminalState: "cancelled",
        revealedAt: null,
      }),
      // Defensive: a "revealed" pointer without a reveal timestamp is not
      // linkable — reveal time is what proves the outcome went public.
      pointerLine({
        premiereId: "prem_norevealtimestamp1",
        revealedAt: null,
      }),
      // Defensive: "archived" is a distinct terminal state; the directive
      // links terminalState === "revealed" only.
      pointerLine({
        premiereId: "prem_archivedarchived11",
        terminalState: "archived",
      }),
    ].join("\n");
    expect(revealedPremiereIdsFromArchiveIndex(raw)).toEqual(
      new Set([revealedPremiereId]),
    );
  });

  test("tolerates torn lines, junk, blank lines, and invalid premiere ids", () => {
    const raw = [
      "",
      "not json at all",
      '["an", "array"]',
      '{"premiereId": 42}',
      '{"premiereId": "prem_UPPERCASE-invalid", "terminalState": "revealed", "revealedAt": "2026-07-22T04:51:41.304Z"}',
      pointerLine(),
      '{"premiereId": "prem_short", "terminalState": "revealed", "revealedAt": "2026-07-22T04:51:41.304Z"}',
      pointerLine().slice(0, 40), // torn final line (crash mid-append)
    ].join("\n");
    expect(revealedPremiereIdsFromArchiveIndex(raw)).toEqual(
      new Set([revealedPremiereId]),
    );
    expect(revealedPremiereIdsFromArchiveIndex("")).toEqual(new Set());
  });

  test("a repeated premiere id keeps the LAST record (append-only semantics)", () => {
    const flippedOff = [
      pointerLine(),
      pointerLine({ terminalState: "failed", revealedAt: null }),
    ].join("\n");
    expect(revealedPremiereIdsFromArchiveIndex(flippedOff)).toEqual(new Set());
    const flippedOn = [
      pointerLine({ terminalState: "failed", revealedAt: null }),
      pointerLine(),
    ].join("\n");
    expect(revealedPremiereIdsFromArchiveIndex(flippedOn)).toEqual(
      new Set([revealedPremiereId]),
    );
  });

  test("premiereHrefForEpisode joins by the loop's own derived premiere id", () => {
    const revealed = new Set([revealedPremiereId]);
    expect(premiereHrefForEpisode(revealedEpisodeId, revealed)).toBe(
      `/premiere/${revealedPremiereId}`,
    );
    // A different episode derives a different id: no link.
    expect(
      premiereHrefForEpisode(
        "ereq_ffffffff-0000-0000-0000-000000000000",
        revealed,
      ),
    ).toBeNull();
    expect(premiereHrefForEpisode(revealedEpisodeId, new Set())).toBeNull();
  });

  test("buildEpisodeRow carries premiereHref only when one is attached (additive data.json)", () => {
    const replay = parseHostedReplayPayload(replayPayloadFixture);
    expect(replay).not.toBeNull();
    if (replay === null) {
      return;
    }
    const meta = parseCompletedEpisodeMetaList(replayMetaFixture)[1];
    const base = {
      meta,
      replay,
      roundNumber: 267,
      watchHref: null,
      fullRenderHref: "/ai-league-replay/coworld-run",
    };
    const linked = buildEpisodeRow({
      ...base,
      premiereHref: `/premiere/${revealedPremiereId}`,
    });
    expect(linked.premiereHref).toBe(`/premiere/${revealedPremiereId}`);
    // Absent, null, or empty input leaves the field entirely OFF the row, so
    // rows without a revealed premiere serialize byte-identically to before.
    for (const row of [
      buildEpisodeRow(base),
      buildEpisodeRow({ ...base, premiereHref: null }),
      buildEpisodeRow({ ...base, premiereHref: "" }),
    ]) {
      expect(row).not.toHaveProperty("premiereHref");
      expect(JSON.stringify(row)).not.toContain("premiere");
    }
  });
});

describe("latest-premiere resolution (the persistent premiere slot's revealed state)", () => {
  const revealedEpisodeId = "ereq_00000000-0000-0000-0000-0000000000aa";
  const revealedPremiereId = derivePremiereId(revealedEpisodeId);
  const indexLine = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      schemaVersion: 1,
      premiereId: revealedPremiereId,
      sourceRunId: "coworld-2026-07-22T04-44-01-038Z-55ad38ae",
      sourceKind: "rated_coworld",
      terminalState: "revealed",
      revealedAt: "2026-07-22T04:51:41.304Z",
      publicationCommitmentHash: "a".repeat(64),
      sourceReplaySha256: "b".repeat(64),
      summaryHash: "c".repeat(64),
      summaryRelPath: `summaries/${revealedPremiereId}.summary.json`,
      reclaimedAt: "2026-07-22T05:22:20.478Z",
      ...overrides,
    });

  function pointer(
    overrides: Partial<LatestPremierePointer> = {},
  ): LatestPremierePointer {
    return {
      schemaVersion: 1,
      premiereId: "prem_54d299b874f0adc7654fd1cc",
      roundNumber: 651,
      mapLabel: "Pangaea",
      revealedAt: "2026-07-22T08:45:13.000Z",
      ...overrides,
    };
  }

  test("summarizePremiereArchiveIndex projects revealed/known ids and the newest revealed entry", () => {
    const raw = [
      indexLine({
        premiereId: "prem_older00000000older",
        revealedAt: "2026-07-21T10:00:00.000Z",
      }),
      indexLine(),
      indexLine({
        premiereId: "prem_failed0000000failed",
        terminalState: "failed",
        revealedAt: null,
      }),
      "torn { line",
    ].join("\n");
    const summary = summarizePremiereArchiveIndex(raw);
    expect(summary.revealedIds).toEqual(
      new Set([revealedPremiereId, "prem_older00000000older"]),
    );
    expect(summary.knownIds).toEqual(
      new Set([
        revealedPremiereId,
        "prem_older00000000older",
        "prem_failed0000000failed",
      ]),
    );
    expect(summary.newestRevealed).toEqual({
      premiereId: revealedPremiereId,
      revealedAt: "2026-07-22T04:51:41.304Z",
    });
  });

  test("summarize keeps the LAST record per id and matches the legacy revealed-id set", () => {
    const flippedOff = [
      indexLine(),
      indexLine({ terminalState: "failed", revealedAt: null }),
    ].join("\n");
    const summary = summarizePremiereArchiveIndex(flippedOff);
    expect(summary.revealedIds).toEqual(new Set());
    expect(summary.knownIds).toEqual(new Set([revealedPremiereId]));
    expect(summary.newestRevealed).toBeNull();
    expect(revealedPremiereIdsFromArchiveIndex(flippedOff)).toEqual(
      summary.revealedIds,
    );
  });

  test("an unparseable revealedAt keeps the id linkable but never elects it newest", () => {
    const raw = indexLine({ revealedAt: "not a timestamp" });
    const summary = summarizePremiereArchiveIndex(raw);
    expect(summary.revealedIds).toEqual(new Set([revealedPremiereId]));
    expect(summary.newestRevealed).toBeNull();
  });

  test("the pointer wins outright when no archive index is wired", () => {
    expect(resolveLatestRevealedPremiere(pointer(), null)).toEqual({
      premiereId: "prem_54d299b874f0adc7654fd1cc",
      roundNumber: 651,
      mapLabel: "Pangaea",
      revealedAt: "2026-07-22T08:45:13.000Z",
      href: "/premiere/prem_54d299b874f0adc7654fd1cc",
    });
  });

  test("a pointer the index does not know yet is kept (the index lags reveal by design)", () => {
    const summary = summarizePremiereArchiveIndex(indexLine());
    const resolved = resolveLatestRevealedPremiere(pointer(), summary);
    expect(resolved?.premiereId).toBe("prem_54d299b874f0adc7654fd1cc");
    expect(resolved?.roundNumber).toBe(651);
  });

  test("a pointer the index knows as revealed is kept with its richer fields", () => {
    const summary = summarizePremiereArchiveIndex(indexLine());
    const resolved = resolveLatestRevealedPremiere(
      pointer({ premiereId: revealedPremiereId }),
      summary,
    );
    expect(resolved).toEqual({
      premiereId: revealedPremiereId,
      roundNumber: 651,
      mapLabel: "Pangaea",
      revealedAt: "2026-07-22T08:45:13.000Z",
      href: `/premiere/${revealedPremiereId}`,
    });
  });

  test("a pointer the index contradicts (non-revealed) is dropped, falling back to newest revealed", () => {
    const raw = [
      indexLine({
        premiereId: "prem_contradicted0000001",
        terminalState: "failed",
        revealedAt: null,
      }),
      indexLine(),
    ].join("\n");
    const summary = summarizePremiereArchiveIndex(raw);
    const resolved = resolveLatestRevealedPremiere(
      pointer({ premiereId: "prem_contradicted0000001" }),
      summary,
    );
    // Fallback carries no round/map (the index does not know them).
    expect(resolved).toEqual({
      premiereId: revealedPremiereId,
      roundNumber: null,
      mapLabel: "",
      revealedAt: "2026-07-22T04:51:41.304Z",
      href: `/premiere/${revealedPremiereId}`,
    });
  });

  test("slot never empty once anything revealed exists: pointer OR archive entry resolves a card", () => {
    const summary = summarizePremiereArchiveIndex(indexLine());
    // Pointer alone.
    expect(resolveLatestRevealedPremiere(pointer(), null)).not.toBeNull();
    // Archive alone (pointer missing or invalid).
    expect(resolveLatestRevealedPremiere(null, summary)).toEqual({
      premiereId: revealedPremiereId,
      roundNumber: null,
      mapLabel: "",
      revealedAt: "2026-07-22T04:51:41.304Z",
      href: `/premiere/${revealedPremiereId}`,
    });
    // Nothing revealed anywhere: the only case the slot may be empty.
    expect(resolveLatestRevealedPremiere(null, null)).toBeNull();
    expect(
      resolveLatestRevealedPremiere(
        null,
        summarizePremiereArchiveIndex(
          indexLine({ terminalState: "failed", revealedAt: null }),
        ),
      ),
    ).toBeNull();
  });
});

describe("selectServingLatestPremiere (probe belt — never link a dead page)", () => {
  const pointerId = "prem_54d299b874f0adc7654fd1cc";
  const indexEpisode = "ereq_00000000-0000-0000-0000-0000000000aa";
  const indexId = derivePremiereId(indexEpisode);
  const ptr: LatestPremierePointer = {
    schemaVersion: 1,
    premiereId: pointerId,
    roundNumber: 651,
    mapLabel: "Pangaea",
    revealedAt: "2026-07-22T08:45:13.000Z",
  };
  const index = summarizePremiereArchiveIndex(
    JSON.stringify({
      schemaVersion: 1,
      premiereId: indexId,
      sourceRunId: "coworld-2026-07-22T04-44-01-038Z-55ad38ae",
      sourceKind: "rated_coworld",
      terminalState: "revealed",
      revealedAt: "2026-07-22T04:51:41.304Z",
      publicationCommitmentHash: "a".repeat(64),
      sourceReplaySha256: "b".repeat(64),
      summaryHash: "c".repeat(64),
      summaryRelPath: `summaries/${indexId}.summary.json`,
      reclaimedAt: "2026-07-22T05:22:20.478Z",
    }),
  );
  const probeAllowing =
    (...serving: string[]) =>
    async (id: string) =>
      serving.includes(id);

  test("pointer candidate serves -> pointer card", async () => {
    const card = await selectServingLatestPremiere(
      ptr,
      index,
      probeAllowing(pointerId),
    );
    expect(card?.premiereId).toBe(pointerId);
    expect(card?.roundNumber).toBe(651);
  });

  test("pointer 404s -> falls back to the archive-index newest revealed", async () => {
    const card = await selectServingLatestPremiere(
      ptr,
      index,
      probeAllowing(indexId),
    );
    expect(card?.premiereId).toBe(indexId);
    expect(card?.roundNumber).toBeNull();
  });

  test("pointer and fallback both dead -> no card (2026-07-22 orphan incident)", async () => {
    const card = await selectServingLatestPremiere(
      ptr,
      index,
      async () => false,
    );
    expect(card).toBeNull();
  });

  test("index-sourced candidate that 404s -> no card, no re-probe loop", async () => {
    let calls = 0;
    const card = await selectServingLatestPremiere(null, index, async () => {
      calls += 1;
      return false;
    });
    expect(card).toBeNull();
    expect(calls).toBe(1);
  });

  test("always-true probe preserves legacy behavior exactly", async () => {
    const card = await selectServingLatestPremiere(
      ptr,
      index,
      async () => true,
    );
    expect(card).toEqual(resolveLatestRevealedPremiere(ptr, index));
  });
});
