import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AGENT_MATCH_RECAP_SCHEMA_VERSION } from "../../src/server/agents/AgentMatchRecap";
import { agentRuntimeModes } from "../../src/server/agents/AgentTypes";
import {
  activeChampionPolicyLabelsByPlayerId,
  agentDecisionRecordsFromMirroredDecisionsLog,
  buildCoworldReplayUiArtifact,
  buildEpisodeRow,
  buildRoundRows,
  buildStandingRows,
  deriveSpectatorTelemetryFromDecisionsLog,
  mapNameFromVariant,
  mergeEpisodeRows,
  parseCompletedEpisodeMetaList,
  parseCuratedDramaScore,
  parseHostedReplayPayload,
  parseLeagueSummary,
  parseMatchNarrativeSummary,
  parseMirroredSpectatorTelemetry,
  pickCompetitionDivision,
  premiereHrefForEpisode,
  resolveLatestRevealedPremiere,
  resolveMirroredMatchEvidence,
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
    // Coworld currently emits this explicit substatus for a valid champion.
    // The mirror must not require the older `active` spelling.
    substatus: "champion",
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
    "deal-ledger.json": '{"schemaVersion":1,"deals":[],"events":[]}',
    "match-summary.json": JSON.stringify({
      decisionCount: 236,
      rejectedCount: 4,
      fallbackCount: 33,
      actionCounts: { attack: 140, hold: 96 },
    }),
    "spectator-telemetry.json": JSON.stringify({
      version: 1,
      agents: [],
      events: [],
    }),
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
    expect(league?.roundsPausedAt).toBeNull();
  });

  test("parseLeagueSummary publishes a canonical hosted pause instant", () => {
    expect(
      parseLeagueSummary({
        ...leagueFixture,
        rounds_paused_at: "2026-08-22T07:20:08.448114Z",
      })?.roundsPausedAt,
    ).toBe("2026-08-22T07:20:08.448114Z");
    expect(
      parseLeagueSummary({
        ...leagueFixture,
        rounds_paused_at: "not-a-timestamp",
      })?.roundsPausedAt,
    ).toBeNull();
    expect(
      parseLeagueSummary({
        ...leagueFixture,
        rounds_paused_at: "2026-08-22T07:20:08+00:00",
      })?.roundsPausedAt,
    ).toBeNull();
    expect(
      parseLeagueSummary({
        ...leagueFixture,
        rounds_paused_at: "2026-02-31T07:20:08Z",
      })?.roundsPausedAt,
    ).toBeNull();
  });

  test("parseLeagueSummary prefers current settings.ladder truth over legacy commissioner fields", () => {
    const league = parseLeagueSummary({
      ...leagueFixture,
      settings: {
        round_interval_minutes: 25,
        ladder: {
          scheduler: { num_episodes: 25 },
          fulfillment: { allowed_failures: 0.05 },
        },
      },
    });
    expect(league?.roundIntervalMinutes).toBe(25);
    expect(league?.episodesPerRound).toBe(25);
  });

  test("pickCompetitionDivision prefers the populated top-level division", () => {
    const division = pickCompetitionDivision(divisionsFixture);
    expect(division?.id).toBe("div_competition");
    expect(division?.name).toBe("Competition");
  });

  test("maps active and champion competing memberships by player", () => {
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

  test("treats the new Commander lineage as the current house policy", () => {
    const rows = buildStandingRows(standingsFixture, [
      {
        status: "competing",
        substatus: "active",
        is_champion: true,
        end_time: null,
        player: { id: "ply_house" },
        policy_version: {
          player_id: "ply_house",
          label: "Commander:v1",
        },
      },
    ]);
    const house = rows.find((row) => row.playerName === "Auri");
    expect(house?.isHouse).toBe(true);
    expect(house?.ratingPolicyLabel).toBe("proxywar-keystone:v7");
    expect(house?.activeChampionPolicyLabel).toBe("Commander:v1");
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
      "deal-ledger.json",
      "match-summary.json",
      "spectator-telemetry.json",
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
    expect(artifact.aggregateSource).toBe("decisions");
    expect(artifact.decisionCount).toBe(65);
    // The window spans the whole match, not just its tail. It used to be
    // decisions.slice(-60), so agents eliminated early never appeared and the
    // replay panel had nothing to show until playback reached the final
    // minutes. Same payload budget, but coverage from the first decision on.
    expect(artifact.recentDecisions).toHaveLength(60);
    expect(artifact.recentDecisions[0]?.sequence).toBe(1);
    expect(artifact.recentDecisions.at(-1)?.sequence).toBe(65);
    const sequences = artifact.recentDecisions.map((d) => d.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    // Every notable decision is retained. The fixture marks fallbackUsed on
    // every 10th index and rejects every 7th, so the notable sequences are
    // fully determined (sequence = index + 1).
    const notable = Array.from({ length: 65 }, (_, index) => index)
      .filter((index) => index % 10 === 0 || index % 7 === 0)
      .map((index) => index + 1);
    expect(notable.filter((seq) => !sequences.includes(seq))).toEqual([]);
    expect(artifact.fallbackCount).toBe(7);
    expect(artifact.rejectedCount).toBe(10);
    expect(artifact.actionCounts).toEqual({ attack: 33, hold: 32 });
    expect(artifact.artifacts).toEqual({
      visualReport: false,
      spectatorTelemetry: true,
      decisions: false,
      summary: true,
    });
    expect(JSON.stringify(artifact)).not.toContain("rawProviderOutput");
    expect(JSON.stringify(artifact)).not.toContain("private-debug");
    expect(
      artifact.recentDecisions[0]?.selectedActionMetadata,
    ).not.toHaveProperty("ignoredLargeField");
  });

  test("buildCoworldReplayUiArtifact preserves truthful public summary aggregates when private decisions are absent", () => {
    const artifact = buildCoworldReplayUiArtifact({
      "match-summary.json": JSON.stringify({
        decisionCount: 6,
        rejectedCount: 1,
        fallbackCount: 2,
        actionCounts: { spawn: 2, attack: 4 },
      }),
      "spectator-telemetry.json": "{}",
      "deal-ledger.json": '{"schemaVersion":1,"deals":[],"events":[]}',
    });

    expect(artifact).toMatchObject({
      version: 1,
      aggregateSource: "match-summary",
      decisionCount: 6,
      rejectedCount: 1,
      fallbackCount: 2,
      actionCounts: { spawn: 2, attack: 4 },
      recentDecisions: [],
      artifacts: {
        decisions: false,
        summary: true,
        spectatorTelemetry: true,
      },
    });
  });

  test("buildCoworldReplayUiArtifact marks missing aggregate evidence unavailable instead of claiming observed zeros", () => {
    expect(buildCoworldReplayUiArtifact({})).toMatchObject({
      aggregateSource: "unavailable",
      decisionCount: 0,
      rejectedCount: 0,
      fallbackCount: 0,
      actionCounts: {},
      recentDecisions: [],
    });
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

  test("buildEpisodeRow carries dramaEvidence only when it's resolved (additive data.json)", () => {
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
    const withEvidence = buildEpisodeRow({
      ...base,
      dramaEvidence: {
        dramaScore: 62,
        entertainmentGrade: "lively",
        curatedDramaScore: 40,
      },
    });
    expect(withEvidence.dramaEvidence).toEqual({
      dramaScore: 62,
      entertainmentGrade: "lively",
      curatedDramaScore: 40,
    });
    // Absent or null input leaves the field entirely OFF the row — the
    // common case until the budgeted backfill has reached a given run.
    for (const row of [
      buildEpisodeRow(base),
      buildEpisodeRow({ ...base, dramaEvidence: null }),
    ]) {
      expect(row).not.toHaveProperty("dramaEvidence");
      expect(JSON.stringify(row)).not.toContain("dramaEvidence");
    }
  });
});

describe("parseMatchNarrativeSummary (drama recaps gap closure)", () => {
  const validDramaReport = () =>
    JSON.stringify({
      schemaVersion: 1,
      reportKind: "drama-and-tom-scorer",
      runID: "run-1",
      dramaScore: 62,
    });
  const validMatchStory = () =>
    JSON.stringify({
      schemaVersion: 1,
      runID: "run-1",
      entertainmentScore: 81,
      grade: "lively",
    });

  test("extracts dramaScore and entertainmentGrade from a well-formed pair", () => {
    expect(
      parseMatchNarrativeSummary(validDramaReport(), validMatchStory()),
    ).toEqual({ dramaScore: 62, entertainmentGrade: "lively" });
  });

  test("rejects malformed JSON on either side", () => {
    expect(
      parseMatchNarrativeSummary("not json", validMatchStory()),
    ).toBeNull();
    expect(
      parseMatchNarrativeSummary(validDramaReport(), "not json"),
    ).toBeNull();
  });

  test("rejects the wrong drama-report reportKind", () => {
    expect(
      parseMatchNarrativeSummary(
        JSON.stringify({ reportKind: "something-else", dramaScore: 10 }),
        validMatchStory(),
      ),
    ).toBeNull();
  });

  test("rejects a missing/negative dramaScore or a missing grade", () => {
    expect(
      parseMatchNarrativeSummary(
        JSON.stringify({ reportKind: "drama-and-tom-scorer" }),
        validMatchStory(),
      ),
    ).toBeNull();
    expect(
      parseMatchNarrativeSummary(
        JSON.stringify({ reportKind: "drama-and-tom-scorer", dramaScore: -1 }),
        validMatchStory(),
      ),
    ).toBeNull();
    expect(
      parseMatchNarrativeSummary(
        validDramaReport(),
        JSON.stringify({ entertainmentScore: 40 }),
      ),
    ).toBeNull();
  });
});

describe("parseCuratedDramaScore (best-battles ranking fix)", () => {
  const validRecap = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: AGENT_MATCH_RECAP_SCHEMA_VERSION,
      runID: "run-1",
      generatedAt: "2026-08-01T00:00:00.000Z",
      summary: "This match featured 1 betrayal.",
      beats: [{ turnNumber: 5, kind: "betrayal", message: "x betrays y." }],
      curatedDramaScore: 42,
      curatedDramaScoreMethodology: "betrayal beats x20 ...",
      ...overrides,
    });

  test("extracts curatedDramaScore from a current-schema recap", () => {
    expect(parseCuratedDramaScore(validRecap())).toBe(42);
  });

  test("rejects malformed JSON", () => {
    expect(parseCuratedDramaScore("not json")).toBeNull();
  });

  test("rejects a stale schemaVersion — the exact upgrade-transition case", () => {
    expect(
      parseCuratedDramaScore(
        validRecap({ schemaVersion: AGENT_MATCH_RECAP_SCHEMA_VERSION - 1 }),
      ),
    ).toBeNull();
  });

  test("rejects a missing or negative curatedDramaScore", () => {
    expect(
      parseCuratedDramaScore(validRecap({ curatedDramaScore: undefined })),
    ).toBeNull();
    expect(
      parseCuratedDramaScore(validRecap({ curatedDramaScore: -1 })),
    ).toBeNull();
  });
});

/**
 * Product overhaul spec Stage 5 mirror gap closure. Fixtures are REAL data
 * excerpted from an actual retained mirrored run in production
 * (`artifacts/ai-league-runs/league-coworld-2026-07-31T19-22-21-473Z-9243b6cf/`
 * on the deployed beta host) — every field present is a genuine value from
 * that match, not fabricated. Trimmed for fixture size: the telemetry sample
 * keeps all 12 real agents and a representative real-event subset (every
 * elimination/nuke/alliance_formed plus an even stride across the match);
 * the decisions sample keeps every agent's first spawn, up to two of each
 * rarer action kind, and an even stride for the rest, with each real line
 * projected down to only the fields `deriveSpectatorTelemetryFromDecisionsLog`
 * actually reads (dropping the large `legalActionIDs`/observation-text
 * fields it never touches).
 */
const realTelemetryFixtureRaw = readFileSync(
  path.join(
    __dirname,
    "fixtures",
    "coworld-mirror-director-cut-telemetry.sample.json",
  ),
  "utf8",
);
const realDecisionsFixtureRaw = readFileSync(
  path.join(
    __dirname,
    "fixtures",
    "coworld-mirror-director-cut-decisions.sample.jsonl",
  ),
  "utf8",
);

describe("parseMirroredSpectatorTelemetry (product overhaul spec Stage 5 mirror gap closure)", () => {
  test("accepts a real retained mirrored run's spectator-telemetry.json", () => {
    const telemetry = parseMirroredSpectatorTelemetry(realTelemetryFixtureRaw);
    expect(telemetry).not.toBeNull();
    expect(telemetry?.agents.length).toBe(12);
    expect(telemetry?.events.length).toBeGreaterThan(0);
    expect(telemetry?.agents.map((agent) => agent.username)).toContain(
      "richard",
    );
  });

  test("rejects malformed JSON, wrong version, no agents, and a malshaped event", () => {
    expect(parseMirroredSpectatorTelemetry("not json")).toBeNull();
    expect(
      parseMirroredSpectatorTelemetry(
        JSON.stringify({ version: 2, agents: [], events: [] }),
      ),
    ).toBeNull();
    expect(
      parseMirroredSpectatorTelemetry(
        JSON.stringify({ version: 1, agents: [], events: [] }),
      ),
    ).toBeNull();
    expect(
      parseMirroredSpectatorTelemetry(
        JSON.stringify({
          version: 1,
          agents: [{ agentID: "a1", username: "Alice" }],
          events: [{ turnNumber: "not a number" }],
        }),
      ),
    ).toBeNull();
  });
});

describe("deriveSpectatorTelemetryFromDecisionsLog (product overhaul spec Stage 5 mirror gap closure)", () => {
  test("rebuilds an equivalent telemetry from a real retained mirrored run's decisions.jsonl", () => {
    const telemetry = deriveSpectatorTelemetryFromDecisionsLog(
      realDecisionsFixtureRaw,
      "coworld-derived-run",
    );
    expect(telemetry).not.toBeNull();
    expect(telemetry?.agents.length).toBe(12);
    expect(telemetry?.events.length).toBeGreaterThan(0);
    // Every event's actor traces back to a real roster agent — no
    // fabricated participant.
    const agentIDs = new Set(telemetry?.agents.map((agent) => agent.agentID));
    for (const event of telemetry?.events ?? []) {
      expect(agentIDs.has(event.actorAgentID)).toBe(true);
    }
  });

  test("skips torn/malformed lines instead of failing the whole derivation", () => {
    const withGarbage = `not json\n${realDecisionsFixtureRaw}\n{"agentID":"only-partial"}\n`;
    const telemetry = deriveSpectatorTelemetryFromDecisionsLog(
      withGarbage,
      "coworld-derived-run",
    );
    expect(telemetry).not.toBeNull();
    expect(telemetry?.events.length).toBeGreaterThan(0);
  });

  test("resolves null when every line is unusable", () => {
    expect(
      deriveSpectatorTelemetryFromDecisionsLog("not json\n\n", "run-1"),
    ).toBeNull();
    expect(deriveSpectatorTelemetryFromDecisionsLog("", "run-1")).toBeNull();
  });
});

describe("mirrored decisions.jsonl economy/deal stamp projection (economy-negotiation parity)", () => {
  // Minimal line shaped like `decisionLogEntry` output before economy/deals
  // existed — exactly the keys the projection reads. Serves as the pinned
  // "today" baseline AND the base for the stamped variant.
  const bareLine = {
    sequence: 7,
    turnNumber: 42,
    agentID: "opportunistic-agent-1",
    username: "Ext One",
    profile: "opportunistic",
    brainType: "external-http",
    selectedLegalActionId: "attack:P_B",
    selectedActionKind: "attack",
    selectedActionMetadata: { targetID: "P_B", troops: 100 },
    generatedIntent: { type: "attack", targetID: "P_B", troops: 100 },
    result: { accepted: true, reason: "accepted", submittedIntent: null },
    auditAfter: { playerID: "P_A" },
  };

  // Mirrors the writer-side parity fixture in AgentDecisionLogWriter.test.ts
  // ("decisions.jsonl external-seat stamps") — same stamp values the real
  // deal manager produces, hoisted onto top-level entry keys by
  // `decisionLogEntry`.
  const dealStamps = {
    dealAction: "propose",
    dealID: "deal:P_A:P_B:non_aggression_pact:0",
    dealTemplate: "non_aggression_pact",
    dealCounterpartyID: "P_B",
    dealCounterpartyName: "Ext Two",
    dealPublicText:
      "Ext One proposed a non-aggression pact to Ext Two (12 decisions).",
    dealStatedReason: "Pact buys me the western flank for twelve decisions",
    dealApplyAccepted: true,
    dealSeparateSlot: true,
    dealComplianceEvent: JSON.stringify([
      {
        event: "deal_expired",
        dealID: "deal:P_A:P_B:non_aggression_pact:0",
        template: "non_aggression_pact",
        actorPlayerID: "P_B",
        actorName: "Ext Two",
        targetPlayerID: "P_A",
        targetName: "Ext One",
        tone: "info",
        importance: 38,
        publicText:
          "Ext Two let Ext One's non-aggression pact offer expire unanswered.",
        step: 5,
      },
    ]),
  };

  const economyFacts = {
    factoryCount: 2,
    operationalFactoryCount: 1,
    idleFactoryCount: 1,
    blockedFactoryCount: 0,
    eligibleDestinationCount: 3,
    embargoBlockedDestinationCount: 1,
    counterparties: [
      {
        playerID: "P_B",
        name: "Ext Two",
        isAllied: true,
        myEligibleDestinationsTheyOwn: 2,
        eligibleDestinationSharePct: 67,
        embargoOursOnThem: false,
        embargoTheirsOnUs: false,
      },
    ],
    pairLinks: [
      {
        playerID: "P_B",
        name: "Ext Two",
        links: 2,
        embargoOursOnThem: false,
        embargoTheirsOnUs: false,
      },
    ],
    bottleneckKind: "missing_trade_destination",
  };

  test("a line carrying economyFacts and all ten deal stamps round-trips them onto the record", () => {
    const { records } = agentDecisionRecordsFromMirroredDecisionsLog(
      `${JSON.stringify({ ...bareLine, economyFacts, ...dealStamps })}\n`,
    );
    expect(records).toHaveLength(1);
    // economyFacts rides back verbatim, nested arrays included — the exact
    // object addEconomyEvents reads off record.economyFacts.
    expect(records[0].economyFacts).toEqual(economyFacts);
    // The ten top-level entry stamps re-nest under decisionMetadata — the
    // exact keys addDealEvents reads, dealStatedReason and dealSeparateSlot
    // included (the writer withheld both until the stamps were hoisted).
    expect(records[0].decisionMetadata).toEqual(dealStamps);
  });

  test("a mirrored line preserves fallback, degradation, reason, and audit provenance", () => {
    const { records } = agentDecisionRecordsFromMirroredDecisionsLog(
      `${JSON.stringify({
        ...bareLine,
        reason: "Attack follows the accepted pact.",
        fallbackUsed: true,
        llmPlannerDegraded: true,
        auditStatus: "confirmed",
        auditReason: "outgoing attack was visible after execution",
      })}\n`,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      reason: "Attack follows the accepted pact.",
      decisionMetadata: {
        fallbackUsed: true,
        llmPlannerDegraded: true,
      },
      audit: {
        auditStatus: "confirmed",
        auditReason: "outgoing attack was visible after execution",
      },
    });
  });

  test("a mirrored line preserves only a bounded runtime mode", () => {
    for (const runtimeMode of agentRuntimeModes) {
      const { records } = agentDecisionRecordsFromMirroredDecisionsLog(
        `${JSON.stringify({ ...bareLine, runtimeMode })}\n`,
      );
      expect(records[0].decisionMetadata).toMatchObject({ runtimeMode });
    }

    for (const runtimeMode of [
      "untrusted-mode",
      "",
      7,
      null,
      { forged: true },
    ]) {
      const { records } = agentDecisionRecordsFromMirroredDecisionsLog(
        `${JSON.stringify({ ...bareLine, runtimeMode })}\n`,
      );
      expect(records[0].decisionMetadata).toBeUndefined();
    }
  });

  test("a mirrored line round-trips a bounded degradedCause and rejects an unrecognized one", () => {
    // This projection is the last hop to the only league-wide feed a census can
    // read: other builders' decision logs are 403, so a cause that does not survive
    // here leaves the mirrored artifact with exactly the ambiguity the field exists
    // to remove — warmup and a dead planner both reading as plain "degraded".
    const { records } = agentDecisionRecordsFromMirroredDecisionsLog(
      `${JSON.stringify({
        ...bareLine,
        fallbackUsed: true,
        llmPlannerDegraded: true,
        degradedCause: "plan-unavailable",
      })}\n`,
    );
    expect(records).toHaveLength(1);
    expect(records[0].decisionMetadata).toMatchObject({
      llmPlannerDegraded: true,
      degradedCause: "plan-unavailable",
    });

    // A mirrored line is not a trusted source either: it is rebuilt from published
    // bytes anyone can serve, so the vocabulary is enforced here too.
    const { records: forged } = agentDecisionRecordsFromMirroredDecisionsLog(
      `${JSON.stringify({
        ...bareLine,
        fallbackUsed: true,
        llmPlannerDegraded: true,
        degradedCause: "plan-unavailable-ish",
      })}\n`,
    );
    expect(forged[0].decisionMetadata).toMatchObject({
      llmPlannerDegraded: true,
    });
    expect(forged[0].decisionMetadata).not.toHaveProperty("degradedCause");
  });

  test("a line without the stamps still projects byte-identically to the pre-economy shape", () => {
    const { records } = agentDecisionRecordsFromMirroredDecisionsLog(
      `${JSON.stringify(bareLine)}\n`,
    );
    expect(records).toHaveLength(1);
    expect(records[0].economyFacts).toBeUndefined();
    expect(records[0].decisionMetadata).toBeUndefined();
    // Full serialized pin of the pre-economy projection, in the exact key
    // order the parser emits — any accidental new key, dropped key, or
    // changed placeholder on unstamped lines fails here.
    expect(JSON.stringify(records[0])).toBe(
      JSON.stringify({
        sequence: 7,
        gameID: "",
        agentID: "opportunistic-agent-1",
        clientID: null,
        username: "Ext One",
        profile: "opportunistic",
        brainType: "external-http",
        turnNumber: 42,
        decidedAt: 0,
        decisionLatencyMs: 0,
        observationSummary: "",
        legalActionIDs: [],
        legalActionIDsByKind: {},
        attackActionIDs: [],
        chosenActionID: "attack:P_B",
        chosenActionKind: "attack",
        reason: "",
        chosenActionMetadata: { targetID: "P_B", troops: 100 },
        intent: { type: "attack", targetID: "P_B", troops: 100 },
        result: { accepted: true, reason: "accepted", submittedIntent: null },
        audit: {
          auditStatus: "unknown",
          auditReason: "",
          after: {
            tick: null,
            playerID: "P_A",
            isAlive: null,
            hasSpawned: null,
            tilesOwned: null,
            troops: null,
            gold: null,
            unitCounts: {},
            outgoingAttackTargetIDs: [],
            outgoingAllianceRequestRecipientIDs: [],
            outgoingEmbargoTargetIDs: [],
          },
        },
      }),
    );
  });

  test("wrong-typed stamps are dropped, never mis-projected", () => {
    const { records } = agentDecisionRecordsFromMirroredDecisionsLog(
      `${JSON.stringify({
        ...bareLine,
        economyFacts: "torn",
        dealAction: "propose",
        dealID: 7,
        dealApplyAccepted: "yes",
        dealStatedReason: 12,
        dealSeparateSlot: "true",
      })}\n`,
    );
    expect(records).toHaveLength(1);
    expect(records[0].economyFacts).toBeUndefined();
    expect(records[0].decisionMetadata).toEqual({ dealAction: "propose" });
  });

  // The whole point of persisting the two stamps: what the REBUILT replay
  // shows. Both assertions below fail on the pre-fix writer, because the
  // mirror can only project what the log line carries.
  describe("rebuilt telemetry (the consequence the stamps exist for)", () => {
    // addDealEvents is itself gated on PROXYWAR_TUNE_STRUCTURED_DEALS, read
    // from the REBUILDING process's env — so the mirror host needs the flag
    // for any deal beat (all ten stamps), not just these two.
    beforeEach(() => {
      process.env.PROXYWAR_TUNE_STRUCTURED_DEALS = "1";
    });
    afterEach(() => {
      delete process.env.PROXYWAR_TUNE_STRUCTURED_DEALS;
    });

    // A deal applied through the diplomacy slot while the decision's GAME
    // action was rejected — the case addDealEvents gates on dealSeparateSlot.
    const separateSlotLine = {
      ...bareLine,
      result: { accepted: false, reason: "rejected", submittedIntent: null },
      ...dealStamps,
    };

    test("a separate-slot deal beat survives a rejected game action and keeps the agent's stated reason", () => {
      const telemetry = deriveSpectatorTelemetryFromDecisionsLog(
        `${JSON.stringify(separateSlotLine)}\n`,
        "run-deal",
      );
      const proposed = telemetry?.events.find(
        (event) => event.kind === "deal_proposed",
      );
      expect(proposed).toBeDefined();
      expect(proposed!.actorName).toBe("Ext One");
      expect(proposed!.statedReason).toBe(dealStamps.dealStatedReason);
      // The claim stays OUT of the server-authored publicText.
      expect(proposed!.publicText).toBe(dealStamps.dealPublicText);
      expect(proposed!.publicText).not.toContain(dealStamps.dealStatedReason);
    });

    test("without the two stamps the same line loses the beat entirely — the gap this closes", () => {
      const { dealStatedReason, dealSeparateSlot, ...legacyStamps } =
        dealStamps;
      expect(dealStatedReason).toBeDefined();
      expect(dealSeparateSlot).toBe(true);
      const telemetry = deriveSpectatorTelemetryFromDecisionsLog(
        `${JSON.stringify({ ...separateSlotLine, ...legacyStamps, dealStatedReason: undefined, dealSeparateSlot: undefined })}\n`,
        "run-deal",
      );
      expect(
        telemetry?.events.some((event) => event.kind === "deal_proposed"),
      ).toBe(false);
    });
  });
});

describe("resolveMirroredMatchEvidence (shared two-tier resolver, drama recaps gap closure)", () => {
  test("tier 1 + records: telemetry from spectator-telemetry.json, records reconstructed from decisions.jsonl independently", () => {
    const evidence = resolveMirroredMatchEvidence({
      runID: "league-coworld-real-run",
      spectatorTelemetryRaw: realTelemetryFixtureRaw,
      decisionsJsonlRaw: realDecisionsFixtureRaw,
      finalTurnCount: null,
    });
    expect(evidence).not.toBeNull();
    expect(evidence?.source).toBe("spectator-telemetry");
    expect(evidence?.telemetry.agents.length).toBe(12);
    // Records are reconstructed from decisions.jsonl regardless of which
    // telemetry tier won — buildAgentDramaReport/buildAgentMatchStory need
    // them verbatim.
    expect(evidence?.records.length).toBeGreaterThan(0);
  });

  test("tier 1 only: telemetry resolves but records stay empty when decisions.jsonl is absent — a real, distinct evidence gap", () => {
    const evidence = resolveMirroredMatchEvidence({
      runID: "league-coworld-real-run",
      spectatorTelemetryRaw: realTelemetryFixtureRaw,
      decisionsJsonlRaw: null,
      finalTurnCount: null,
    });
    expect(evidence).not.toBeNull();
    expect(evidence?.source).toBe("spectator-telemetry");
    expect(evidence?.records).toEqual([]);
  });

  test("tier 2 fallback: telemetry AND records both derive from decisions.jsonl when spectator-telemetry.json is absent/unusable", () => {
    const evidence = resolveMirroredMatchEvidence({
      runID: "league-coworld-fallback-run",
      spectatorTelemetryRaw: "not json",
      decisionsJsonlRaw: realDecisionsFixtureRaw,
      finalTurnCount: null,
    });
    expect(evidence).not.toBeNull();
    expect(evidence?.source).toBe("decisions-log");
    expect(evidence?.records.length).toBeGreaterThan(0);
    expect(evidence?.telemetry.agents.length).toBeGreaterThan(0);
  });

  test("resolves null (never throws) when neither input is usable", () => {
    expect(
      resolveMirroredMatchEvidence({
        runID: "run-1",
        spectatorTelemetryRaw: "not json",
        decisionsJsonlRaw: "also not json",
        finalTurnCount: null,
      }),
    ).toBeNull();
  });

  test("finalState is built from finalTurnCount and passed through unconditionally", () => {
    const evidence = resolveMirroredMatchEvidence({
      runID: "league-coworld-real-run",
      spectatorTelemetryRaw: realTelemetryFixtureRaw,
      decisionsJsonlRaw: null,
      finalTurnCount: 6300,
    });
    expect(evidence?.finalState).toEqual({
      phase: "final",
      tick: null,
      turnCount: 6300,
      players: [],
    });
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
