import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COWORLD_LEAGUE_WORLD_FILE,
  COWORLD_LEAGUE_WORLD_SOURCE_FILE,
  publishCoworldLeagueWorldUnlocked,
  readWorldSource,
  type CoworldLeagueMirrorData,
} from "../../src/server/agents/CoworldLeagueSiteWriter";
import {
  FRONTIER_FOUR_EPISODES_FILE,
  FRONTIER_FOUR_GAMES_FILE,
  FRONTIER_FOUR_TEAMS,
  FRONTIER_SEASON_ONE_NOTE,
  FRONTIER_SEASON_TWO_TEAMS,
  frontierFourBattle,
  frontierFourEpisodeRow,
  frontierFourWinnerLabel,
  frontierNextBattleAt,
  frontierRosterMismatches,
  frontierSchedule,
  frontierSchedulerFacts,
  frontierSeasonOneRecap,
  frontierTeamsFor,
  parseFrontierBattleTimes,
  parseFrontierFourGameRecord,
  parseFrontierGameRecord,
  parseFrontierGameRecordV2,
  parseFrontierRoster,
  publishFrontierFourWorld,
  publishFrontierWorld,
  readFrontierGames,
  restoreLeagueWorldSource,
  sanitizeFrontierPublicText,
  selectFrontierLatestVoices,
  type FrontierVoice,
} from "../../src/server/agents/FrontierFourWorld";

/**
 * The Frontier Four world: a scheduler's game records become world battles
 * held by TEAMS, publish as the same `world.json` the league feeds, and
 * take the world over from the league mirror cleanly, marker first.
 */

const TEAMS = [
  {
    label: "Astra",
    model: "openai/gpt-6-astra",
    team: "Red",
    slots: [0, 10, 11],
  },
  {
    label: "Fable",
    model: "anthropic/claude-fable-5.1",
    team: "Blue",
    slots: [1, 6, 8],
  },
  {
    label: "Gemini",
    model: "google/gemini-3.1-pro-preview",
    team: "Teal",
    slots: [2, 5, 9],
  },
  { label: "Grok", model: "x-ai/grok-4.7", team: "Purple", slots: [3, 4, 7] },
];

function game(
  id: string,
  map: string,
  winnerTeam: string | null,
  completedAt: string,
  cycle = 1,
) {
  const teamOf = (slot: number) =>
    TEAMS.find((team) => team.slots.includes(slot))!;
  return {
    schemaVersion: 1,
    experienceRequestId: `xreq_${id}`,
    episodeRequestId: `ereq_${id}`,
    variantId: `teams-4x3-${map.toLowerCase()}`,
    map,
    mapSize: "Normal",
    completedAt,
    replayUrl: `https://softmax.com/observatory/replays/${id}`,
    viewerUrl: null,
    costUsd: 9.5,
    cycle,
    teams: TEAMS,
    winnerTeam,
    scores: Array.from({ length: 12 }, (_, slot) =>
      winnerTeam !== null && teamOf(slot).team === winnerTeam ? 1 / 3 : 0,
    ),
    players: Array.from({ length: 12 }, (_, slot) => ({
      slot,
      name: `${teamOf(slot).label}${slot > 3 ? ` ${slot}` : ""}`,
      team: teamOf(slot).team,
      tilesOwned: 1000 + slot,
      isAlive: true,
    })),
    turnCount: 9000,
    decisionCount: 2400,
    degradedCount: 12,
  };
}

describe("Frontier Four world", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true });
  });

  it("names the winning TEAM, by engine side or by the winning seats", () => {
    const won = parseFrontierFourGameRecord(
      game("a1", "Asia", "Blue", "2026-10-05T10:00:00.000Z"),
    );
    expect(won).not.toBeNull();
    expect(frontierFourWinnerLabel(won!)).toBe("Fable");
    expect(frontierFourBattle(won!)).toEqual({
      episodeRequestId: "ereq_a1",
      map: "Asia",
      winnerName: "Fable",
      playerCount: 12,
      roundNumber: 1,
      battleAt: "2026-10-05T10:00:00.000Z",
    });
    // The engine side unknown on the team entry: the winning seats decide.
    const raw = game("a2", "Asia", "Purple", "2026-10-05T11:00:00.000Z");
    const sideless = parseFrontierFourGameRecord({
      ...raw,
      teams: raw.teams.map((team) => ({ ...team, team: null })),
    });
    expect(frontierFourWinnerLabel(sideless!)).toBe("Grok");
    // No winner: the battle still ages the front's window.
    const drawn = parseFrontierFourGameRecord(
      game("a3", "Asia", null, "2026-10-05T12:00:00.000Z"),
    );
    expect(frontierFourBattle(drawn!).winnerName).toBeNull();
  });

  it("rejects records that cannot place a battle", () => {
    const base = game("b1", "Asia", "Red", "2026-10-05T10:00:00.000Z");
    expect(
      parseFrontierFourGameRecord({ ...base, episodeRequestId: "nope" }),
    ).toBeNull();
    expect(
      parseFrontierFourGameRecord({ ...base, completedAt: "yesterday" }),
    ).toBeNull();
    expect(parseFrontierFourGameRecord({ ...base, cycle: 0 })).toBeNull();
    expect(
      parseFrontierFourGameRecord({ ...base, teams: [TEAMS[0]] }),
    ).toBeNull();
    expect(parseFrontierFourGameRecord("not a record")).toBeNull();
  });

  it("writes a /match row with team colours and the hosted replay as the watch link", () => {
    const record = parseFrontierFourGameRecord(
      game("c1", "Oceania", "Red", "2026-10-05T10:00:00.000Z", 3),
    )!;
    const row = frontierFourEpisodeRow(record);
    expect(row.shortId).toBe("c1");
    expect(row.roundNumber).toBe(3);
    expect(row.winnerName).toBe("Astra");
    expect(row.watchHref).toBe("https://softmax.com/observatory/replays/c1");
    // A known viewer page beats the raw replay file.
    const viewed = parseFrontierFourGameRecord({
      ...game("c2", "Oceania", "Red", "2026-10-05T10:00:00.000Z", 3),
      viewerUrl: "https://viewer.test/index.html#replay=c2",
    })!;
    expect(frontierFourEpisodeRow(viewed).watchHref).toBe(
      "https://viewer.test/index.html#replay=c2",
    );
    expect(row.players).toHaveLength(12);
    const astraSeats = row.players.filter((player) => player.isWinner);
    expect(astraSeats.map((player) => player.slot)).toEqual([0, 10, 11]);
    expect(new Set(astraSeats.map((player) => player.color)).size).toBe(1);
    expect(row.players.find((player) => player.slot === 1)?.isWinner).toBe(
      false,
    );
  });

  it("publishes the world from the games file and takes it over from the mirror", async () => {
    const siteDir = await mkdtemp(path.join(tmpdir(), "frontier-four-"));
    dirs.push(siteDir);
    const lines = [
      game("d1", "Asia", "Blue", "2026-10-05T10:00:00.000Z", 1),
      game("d2", "Pangaea", "Red", "2026-10-05T10:30:00.000Z", 1),
      game("d3", "Asia", "Red", "2026-10-05T22:00:00.000Z", 2),
      "{ not json",
      { schemaVersion: 2 },
    ];
    await writeFile(
      path.join(siteDir, FRONTIER_FOUR_GAMES_FILE),
      lines
        .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
        .join("\n") + "\n",
    );

    const publication = await publishFrontierFourWorld({
      siteDir,
      now: "2026-10-05T23:00:00.000Z",
    });
    expect(publication).toMatchObject({ games: 3, battles: 3 });

    const world = JSON.parse(
      await readFile(path.join(siteDir, COWORLD_LEAGUE_WORLD_FILE), "utf8"),
    );
    const asia = world.theatres.find(
      (theatre: { id: string }) => theatre.id === "asia",
    );
    // Fable claimed Asia, then Astra won there: one win each keeps the holder.
    expect(asia.holder).toBe("Fable");
    expect(asia.challenger).toBe("Astra");
    expect(asia.status).toBe("contested");
    const crown = world.theatres.find(
      (theatre: { id: string }) => theatre.id === "crown",
    );
    expect(crown.holder).toBe("Astra");
    const names = world.agents
      .map((agent: { name: string }) => agent.name)
      .sort();
    expect(names).toEqual(["Astra", "Fable"]);
    const astra = world.agents.find(
      (agent: { name: string }) => agent.name === "Astra",
    );
    expect(astra.color).toBe("#60a5fa");
    expect(astra.emblemSvg).toContain("<svg");
    expect(astra.slug).toBeNull();
    expect(world.feed.currentRoundNumber).toBe(2);
    expect(world.events[0].href).toBe("/match/ereq_d3");

    const episodes = JSON.parse(
      await readFile(path.join(siteDir, FRONTIER_FOUR_EPISODES_FILE), "utf8"),
    );
    expect(
      episodes.episodes.map(
        (row: { episodeRequestId: string }) => row.episodeRequestId,
      ),
    ).toEqual(["ereq_d1", "ereq_d2", "ereq_d3"]);

    // The marker holds the mirror off the world files.
    expect(await readWorldSource(siteDir)).toBe("frontier-four");
    const before = await readFile(
      path.join(siteDir, COWORLD_LEAGUE_WORLD_FILE),
      "utf8",
    );
    const mirrorData: CoworldLeagueMirrorData = {
      generatedAt: "2026-10-05T23:05:00.000Z",
      lastGoodSyncAt: "2026-10-05T23:05:00.000Z",
      stale: false,
      league: {
        id: "league_test",
        name: "Proxywar",
        description: null,
        divisionName: "Competition",
        roundIntervalMinutes: 40,
        episodesPerRound: 25,
        currentRoundNumber: 2400,
        currentRoundStatus: "pending",
        scoreLabel: "Score",
      },
      standings: [],
      rounds: [],
      episodes: [],
      links: {
        enterTheLeagueUrl: "https://example.test",
        platformLabel: "Softmax",
      },
    };
    const skipped = await publishCoworldLeagueWorldUnlocked({
      siteDir,
      data: mirrorData,
      readModelAgents: [],
    });
    expect(skipped.published).toBe(false);
    expect(
      await readFile(path.join(siteDir, COWORLD_LEAGUE_WORLD_FILE), "utf8"),
    ).toBe(before);

    // Handing the world back lets the mirror publish again.
    await restoreLeagueWorldSource(siteDir);
    expect(await readWorldSource(siteDir)).toBe("league");
    expect(
      JSON.parse(
        await readFile(
          path.join(siteDir, COWORLD_LEAGUE_WORLD_SOURCE_FILE),
          "utf8",
        ),
      ),
    ).toEqual({ source: "league" });
    const resumed = await publishCoworldLeagueWorldUnlocked({
      siteDir,
      data: mirrorData,
      readModelAgents: [],
    });
    expect(resumed.published).toBe(true);
  });
});

/**
 * Season 2: one nation per model. The fixtures are real Season 1 games
 * (Oct 4-5) converted to contract-B records: each team becomes one seat
 * holding the team's land, with the planner figures from that seat's log.
 */

const MODELS: Record<string, string> = {
  Astra: "openai/gpt-6-astra",
  Fable: "anthropic/claude-fable-5.1",
  Opus: "anthropic/claude-opus-5.5",
  Gemini: "google/gemini-3.1-pro-preview",
  Grok: "x-ai/grok-4.7",
};

const VIEWER =
  "https://api.observatory.softmax-research.net/v2/coworlds/replays/static/cow_02f4462d-454d-48f0-b71f-2c1f302bdfab/sha256%3A999255f29db22b8cf40d7e98141a8c0f6dd128fe6d7c9b26ac378a3c40b3d0db/index.html?v=2#replay=";

/** [label, slot, landShare, tilesOwned, isAlive, rank, plans, latencyMsMedian, outputTokensMedian] */
type Seat = [
  string,
  number,
  number,
  number,
  boolean,
  number,
  number,
  number,
  number,
];

function ffaGame(args: {
  id: string;
  map: string;
  frontLabel: string;
  completedAt: string;
  cycle: number;
  winner: string | null;
  winType: "conquest" | "points" | "none";
  replay: string;
  seats: readonly Seat[];
  voices?: unknown[];
  season?: number;
}) {
  return {
    schemaVersion: 2,
    season: args.season ?? 2,
    format: "ffa",
    experienceRequestId: `xreq_${args.id}`,
    episodeRequestId: `ereq_${args.id}`,
    variantId: `ffa5-${args.map.toLowerCase()}`,
    map: args.map,
    mapSize: "Compact",
    frontLabel: args.frontLabel,
    completedAt: args.completedAt,
    replayUrl: `https://softmax-public.s3.amazonaws.com/replays/${args.replay}.replay`,
    viewerUrl: `${VIEWER}${encodeURIComponent(`https://softmax-public.s3.amazonaws.com/replays/${args.replay}.replay`)}`,
    costUsd: 0.06,
    cycle: args.cycle,
    gameIndex: args.cycle,
    episodeIndex: args.cycle,
    sides: args.seats.map(([label, slot], index) => ({
      label,
      model: MODELS[label],
      team: null,
      slots: [slot],
      pickOrder: index + 1,
    })),
    winnerLabel: args.winner,
    winType: args.winType,
    standings: args.seats.map(
      ([label, , landShare, tilesOwned, isAlive, rank]) => ({
        label,
        landShare,
        tilesOwned,
        isAlive,
        eliminatedAtTurn: isAlive ? null : 20000,
        rank,
      }),
    ),
    turnCount: 36400,
    decisionCount: 2714,
    degradedCount: 352,
    telemetry: Object.fromEntries(
      args.seats.map(([label, , , , , , plans, latency, output]) => [
        label,
        {
          plans,
          planFailures: 0,
          timeouts: 0,
          latencyMsMedian: latency,
          latencyMsP90: latency * 1.3,
          outputTokensMedian: output,
          inputTokensMedian: 6000,
          reasoningTokensMedian: null,
          usd: 0.4,
          capped: false,
        },
      ]),
    ),
    voices: args.voices ?? [],
    moments: [],
    harness: {
      playerVersion: "2.0.0",
      planEvery: 15,
      plansPerSeat: 17,
      reasoning: "low",
      maxOutputTokens: 3000,
    },
  };
}

// Asia, 2026-10-04 15:23 (Season 1 cycle 1): Grok took 95% of the land.
const ASIA_CLAIM = ffaGame({
  id: "1b1c1dbe-087c-40c2-b55a-653570f84937",
  map: "Asia",
  frontLabel: "Asia",
  completedAt: "2026-10-04T15:23:54.346910Z",
  cycle: 1,
  winner: "Grok",
  winType: "conquest",
  replay: "26d4381e-4a4f-4079-8b79-c47e83d8df73",
  seats: [
    ["Astra", 3, 0.0197, 21256, true, 3, 7, 3342, 140],
    ["Fable", 0, 0.0007, 722, true, 4, 19, 13911, 820],
    ["Gemini", 1, 0.0268, 28926, true, 2, 20, 6838, 628],
    ["Grok", 2, 0.9529, 1028951, true, 1, 19, 13788, 1327],
  ],
});
// Asia, 2026-10-04 17:50, with its winner removed: nobody won, Grok keeps Asia.
const ASIA_NO_WINNER = ffaGame({
  id: "303812ad-a7e4-4203-a929-336e6ece8ca7",
  map: "Asia",
  frontLabel: "Asia",
  completedAt: "2026-10-04T17:50:13.862143Z",
  cycle: 2,
  winner: null,
  winType: "none",
  replay: "e1dbc877-e8ac-4279-ada0-076e8df3b3e8",
  seats: [
    ["Astra", 0, 0.0318, 34370, true, 2, 21, 3240, 129],
    ["Fable", 2, 0.003, 3276, true, 3, 14, 13506, 828],
    ["Gemini", 3, 0.0015, 1670, true, 4, 13, 5952, 577],
    ["Grok", 1, 0.9636, 1040539, true, 1, 13, 10344, 965],
  ],
});
// East Asia, 2026-10-05 05:57: Grok on points.
const EAST_ASIA_GROK = ffaGame({
  id: "48e962b6-4056-4d7a-8451-e164e7f419b2",
  map: "EastAsia",
  frontLabel: "East Asia",
  completedAt: "2026-10-05T05:57:16.855371Z",
  cycle: 3,
  winner: "Grok",
  winType: "points",
  replay: "93a9df2b-e879-41a1-8a66-e9d39374a3e9",
  seats: [
    ["Astra", 0, 0.2304, 202598, true, 3, 6, 3036, 122],
    ["Fable", 3, 0, 0, false, 4, 10, 13068, 768],
    ["Gemini", 1, 0.3545, 311665, true, 2, 40, 5854, 568],
    ["Grok", 2, 0.4151, 365001, true, 1, 23, 16261, 1327],
  ],
});
// East Asia, 2026-10-05 17:06: Fable on points, here with Opus as a fifth seat.
const EAST_ASIA_FABLE = ffaGame({
  id: "14f5f5fc-4a5a-40ba-bb43-2a5b0e2f7bc6",
  map: "EastAsia",
  frontLabel: "East Asia",
  completedAt: "2026-10-05T17:06:32.859501Z",
  cycle: 4,
  winner: "Fable",
  winType: "points",
  replay: "2bbf4111-0153-423c-a53a-c55224ae154f",
  seats: [
    ["Astra", 2, 0.2411, 212015, true, 3, 34, 3502, 124],
    ["Fable", 3, 0.4143, 364275, true, 1, 19, 13425, 835],
    ["Gemini", 1, 0, 0, false, 4, 8, 5493, 509],
    ["Grok", 0, 0.3446, 302974, true, 2, 23, 20906, 1311],
    ["Opus", 4, 0, 0, false, 5, 9, 11000, 900],
  ],
  voices: [
    {
      label: "Gemini",
      kind: "dispatch",
      to: null,
      turn: 1000,
      text: "Building cities first.",
    },
    {
      label: "Fable",
      kind: "dispatch",
      to: null,
      turn: 1200,
      text: "East Asia is a garden. I intend to tend it.",
    },
    {
      label: "Gemini",
      kind: "message",
      to: "Nobody",
      turn: 1500,
      text: "Hello?",
    },
    {
      label: "Grok",
      kind: "message",
      to: "Fable",
      turn: 3000,
      text: "Truce on the river? I have no quarrel with you yet.",
    },
    {
      label: "Fable",
      kind: "message",
      to: "Grok",
      turn: 3100,
      text: "Agreed until the coast is settled. Terms at https://evil.example/phish @grok_fan",
    },
    {
      label: "Opus",
      kind: "dispatch",
      to: null,
      turn: 4000,
      text: "@everyone https://x.test",
    },
    {
      label: "Astra",
      kind: "message",
      to: "Opus",
      turn: 5000,
      text: "Opus, your border is thin. Join me against Fable.",
    },
    {
      label: "Astra",
      kind: "message",
      to: "Opus",
      turn: 5200,
      text: "Last offer.",
    },
    {
      label: "Grok",
      kind: "dispatch",
      to: null,
      turn: 9000,
      text: "Gemini\u0007 is gone.‮   The north\nis mine.",
    },
    {
      label: "Astra",
      kind: "dispatch",
      to: null,
      turn: 20000,
      text: "x".repeat(141),
    },
    {
      label: "Fable",
      kind: "dispatch",
      to: null,
      turn: 30000,
      text: "Points, not conquest. I will take it.",
    },
  ],
});

describe("Frontier Season 2 records", () => {
  it("parses a contract-B record with any number of single-seat sides", () => {
    const record = parseFrontierGameRecordV2(EAST_ASIA_FABLE);
    expect(record).not.toBeNull();
    expect(record!.season).toBe(2);
    expect(record!.sides.map((side) => side.label)).toEqual([
      "Astra",
      "Fable",
      "Gemini",
      "Grok",
      "Opus",
    ]);
    expect(record!.sides[4]).toMatchObject({ slots: [4], pickOrder: 5 });
    expect(record!.winnerLabel).toBe("Fable");
    expect(record!.winType).toBe("points");
    expect(record!.completedAt).toBe("2026-10-05T17:06:32.859Z");
    // Best rank first.
    expect(record!.standings.map((standing) => standing.label)).toEqual([
      "Fable",
      "Grok",
      "Astra",
      "Gemini",
      "Opus",
    ]);
    expect(record!.telemetry.Grok).toMatchObject({
      plans: 23,
      latencyMsMedian: 20906,
      outputTokensMedian: 1311,
    });
    expect(record!.harness).toEqual({
      playerVersion: "2.0.0",
      planEvery: 15,
      plansPerSeat: 17,
      reasoning: "low",
      maxOutputTokens: 3000,
    });
    // The winner comes from winnerLabel, as a world battle and a match row.
    expect(frontierFourWinnerLabel(record!)).toBe("Fable");
    expect(frontierFourBattle(record!)).toEqual({
      episodeRequestId: "ereq_14f5f5fc-4a5a-40ba-bb43-2a5b0e2f7bc6",
      map: "EastAsia",
      winnerName: "Fable",
      playerCount: 5,
      roundNumber: 4,
      battleAt: "2026-10-05T17:06:32.859Z",
    });
    const row = frontierFourEpisodeRow(record!);
    expect(row.players.map((player) => player.name)).toEqual([
      "Grok",
      "Gemini",
      "Astra",
      "Fable",
      "Opus",
    ]);
    expect(row.players.find((player) => player.isWinner)?.name).toBe("Fable");
    expect(row.players.find((player) => player.name === "Opus")?.color).toBe(
      "#f472b6",
    );
    expect(row.watchHref).toContain("index.html?v=2#replay=");
    // Both seasons read through one parser.
    expect(parseFrontierGameRecord(EAST_ASIA_FABLE)?.schemaVersion).toBe(2);
    expect(
      parseFrontierGameRecord(
        game("v1", "Asia", "Blue", "2026-10-05T10:00:00.000Z"),
      )?.schemaVersion,
    ).toBe(1);
  });

  it("rejects records that would put a wrong result on the map", () => {
    const base = ASIA_CLAIM;
    expect(parseFrontierGameRecordV2(base)).not.toBeNull();
    // A winner the game did not field.
    expect(
      parseFrontierGameRecordV2({ ...base, winnerLabel: "Opus" }),
    ).toBeNull();
    // A win with no way of winning.
    expect(parseFrontierGameRecordV2({ ...base, winType: "none" })).toBeNull();
    expect(
      parseFrontierGameRecordV2({ ...base, winType: undefined }),
    ).toBeNull();
    // Two sides with one name, or fewer than two sides.
    expect(
      parseFrontierGameRecordV2({
        ...base,
        sides: [base.sides[0], base.sides[0]],
      }),
    ).toBeNull();
    expect(
      parseFrontierGameRecordV2({ ...base, sides: [base.sides[0]] }),
    ).toBeNull();
    expect(
      parseFrontierGameRecordV2({
        ...base,
        sides: base.sides.map((side, index) =>
          index === 0 ? { ...side, label: "<b>Astra</b>" } : side,
        ),
      }),
    ).toBeNull();
    expect(parseFrontierGameRecordV2({ ...base, map: "../etc" })).toBeNull();
    expect(
      parseFrontierGameRecordV2({ ...base, completedAt: "soon" }),
    ).toBeNull();
    expect(
      parseFrontierGameRecordV2({ ...base, episodeRequestId: "xreq_1" }),
    ).toBeNull();
    // No winner is a valid result, whatever winType says.
    const drawn = parseFrontierGameRecordV2({
      ...base,
      winnerLabel: null,
      winType: "points",
    });
    expect(drawn?.winType).toBe("none");
    // Missing telemetry, voices and harness are allowed.
    const bare = parseFrontierGameRecordV2({
      ...base,
      telemetry: undefined,
      voices: undefined,
      harness: undefined,
      standings: [{ label: "Grok", landShare: 1.5, rank: 1 }, "junk"],
      viewerUrl: "javascript:alert(1)",
    });
    expect(bare).toMatchObject({
      telemetry: {},
      voices: [],
      harness: null,
      standings: [],
      viewerUrl: null,
    });
  });

  it("sanitizes public text: links, handles, control characters, length", () => {
    expect(
      sanitizeFrontierPublicText(
        "Join me https://t.co/x or www.evil.test, ask @someone_1 at evil.example.com/path!",
        280,
      ),
    ).toBe("Join me or ask at");
    // A path makes it a link whatever the ending; an address loses its
    // domain with its handle.
    expect(sanitizeFrontierPublicText("see evil.ru/x now", 140)).toBe(
      "see now",
    );
    expect(sanitizeFrontierPublicText("mail me a@b.com", 140)).toBe(
      "mail me a",
    );
    expect(
      sanitizeFrontierPublicText("Line one\nline\ttwo\u0000‮​ end", 140),
    ).toBe("Line one line two end");
    expect(sanitizeFrontierPublicText("   ", 140)).toBeNull();
    expect(sanitizeFrontierPublicText("@all https://x.test", 140)).toBeNull();
    expect(sanitizeFrontierPublicText("a".repeat(141), 140)).toBeNull();
    expect(sanitizeFrontierPublicText("a".repeat(140), 140)).toHaveLength(140);
    expect(sanitizeFrontierPublicText(42, 140)).toBeNull();
    // Model names and plain numbers survive.
    expect(
      sanitizeFrontierPublicText("Grok 4.7 holds 41.5% of East Asia.", 140),
    ).toBe("Grok 4.7 holds 41.5% of East Asia.");

    const record = parseFrontierGameRecordV2(EAST_ASIA_FABLE)!;
    const texts = record.voices.map((voice) => voice.text);
    // The emptied and the over-long dispatches are dropped, never cut.
    expect(texts).not.toContain("x".repeat(140));
    expect(record.voices.some((voice) => voice.label === "Opus")).toBe(false);
    expect(texts).toContain("Agreed until the coast is settled. Terms at");
    expect(texts).toContain("Gemini is gone. The north is mine.");
    // A message to a side the game did not field has no recipient.
    expect(
      record.voices.find((voice) => voice.text === "Hello?")?.to,
    ).toBeNull();
  });

  it("picks at most six voices for the latest battle, every side's last dispatch first", () => {
    const record = parseFrontierGameRecordV2(EAST_ASIA_FABLE)!;
    const chosen = selectFrontierLatestVoices(record.voices);
    expect(
      chosen.map((voice) => [voice.label, voice.kind, voice.turn]),
    ).toEqual([
      ["Gemini", "dispatch", 1000],
      ["Gemini", "message", 1500],
      ["Grok", "message", 3000],
      ["Fable", "message", 3100],
      ["Grok", "dispatch", 9000],
      ["Fable", "dispatch", 30000],
    ]);
    const many: FrontierVoice[] = Array.from({ length: 30 }, (_, index) => ({
      label: index % 2 === 0 ? "Astra" : "Grok",
      kind: "message",
      to: null,
      turn: index,
      text: `line ${index}`,
    }));
    const fair = selectFrontierLatestVoices(many, 4);
    expect(fair.map((voice) => voice.text)).toEqual([
      "line 0",
      "line 1",
      "line 2",
      "line 3",
    ]);
    expect(selectFrontierLatestVoices([])).toEqual([]);
  });

  it("works out the next battle time from the daily UTC times", () => {
    expect(parseFrontierBattleTimes("19:00, 13:00,13:00")).toEqual([
      "13:00",
      "19:00",
    ]);
    // Read the way the scheduler reads its config: "9:00" is 09:00.
    expect(parseFrontierBattleTimes("18:30,9:00")).toEqual(["09:00", "18:30"]);
    expect(() => parseFrontierBattleTimes("25:00")).toThrow();
    expect(() => parseFrontierBattleTimes("12:60")).toThrow();
    expect(() => parseFrontierBattleTimes("9:5")).toThrow();
    expect(() => parseFrontierBattleTimes("")).toThrow();
    const times = ["13:00", "19:00"];
    expect(frontierNextBattleAt(times, "2026-10-06T09:30:00.000Z")).toBe(
      "2026-10-06T13:00:00.000Z",
    );
    expect(frontierNextBattleAt(times, "2026-10-06T13:00:00.000Z")).toBe(
      "2026-10-06T19:00:00.000Z",
    );
    expect(frontierNextBattleAt(times, "2026-10-06T21:00:00.000Z")).toBe(
      "2026-10-07T13:00:00.000Z",
    );
    expect(frontierNextBattleAt([], "2026-10-06T21:00:00.000Z")).toBeNull();

    // While the scheduler waits for a credits refill, no earlier battle is promised.
    expect(
      frontierSchedule({
        timesUtc: times,
        now: "2026-10-06T09:30:00.000Z",
        holdUntil: "2026-10-07T00:00:00Z",
      }),
    ).toEqual({ timesUtc: times, nextBattleAt: "2026-10-07T13:00:00.000Z" });
    // A refill exactly at a battle time keeps that battle.
    expect(
      frontierSchedule({
        timesUtc: times,
        now: "2026-10-06T09:30:00.000Z",
        holdUntil: "2026-10-06T19:00:00.000Z",
      }).nextBattleAt,
    ).toBe("2026-10-06T19:00:00.000Z");
    // A hold that has passed changes nothing.
    expect(
      frontierSchedule({
        timesUtc: times,
        now: "2026-10-06T09:30:00.000Z",
        holdUntil: "2026-10-06T00:00:00.000Z",
      }).nextBattleAt,
    ).toBe("2026-10-06T13:00:00.000Z");

    // The scheduler's own files, read as far as they make sense.
    expect(
      frontierSchedulerFacts({
        config: { schedule: { times_utc: ["19:00", "13:00"] } },
        state: { credits_hold_until: "2026-10-07T00:00:00+00:00" },
      }),
    ).toEqual({
      timesUtc: ["13:00", "19:00"],
      holdUntil: "2026-10-07T00:00:00.000Z",
      warnings: [],
    });
    // The scheduler accepts and zero-pads a one-digit hour; so does this.
    expect(
      frontierSchedulerFacts({
        config: { schedule: { times_utc: ["9:00", "18:00"] } },
        state: null,
      }),
    ).toEqual({ timesUtc: ["09:00", "18:00"], holdUntil: null, warnings: [] });
    // Times the scheduler would refuse are said out loud, not swallowed.
    const noon = frontierSchedulerFacts({
      config: { schedule: { times_utc: ["noon"] } },
      state: { credits_hold_until: null },
    });
    expect(noon).toMatchObject({ timesUtc: null, holdUntil: null });
    expect(noon.warnings).toHaveLength(1);
    expect(noon.warnings[0]).toMatch(/schedule\.times_utc.*"noon"/);
    // The scheduler's own default applies to a missing or empty list.
    for (const config of [null, {}, { schedule: { times_utc: [] } }]) {
      expect(frontierSchedulerFacts({ config, state: "junk" })).toEqual({
        timesUtc: null,
        holdUntil: null,
        warnings: [],
      });
    }
  });

  it("recaps Season 1 with an honest note", () => {
    const records = [
      game("r1", "Asia", "Purple", "2026-10-04T15:00:00.000Z"),
      game("r2", "Oceania", "Blue", "2026-10-04T16:00:00.000Z"),
      game("r3", "Africa", "Purple", "2026-10-04T17:00:00.000Z"),
      game("r4", "World", null, "2026-10-04T18:00:00.000Z"),
    ].map((raw) => parseFrontierFourGameRecord(raw)!);
    const recap = frontierSeasonOneRecap(records);
    expect(recap.battles).toBe(4);
    expect(recap.winsByLabel).toEqual({
      Grok: 2,
      Fable: 1,
      Astra: 0,
      Gemini: 0,
    });
    expect(Object.keys(recap.winsByLabel)).toEqual([
      "Grok",
      "Fable",
      "Astra",
      "Gemini",
    ]);
    expect(recap.note).toBe(FRONTIER_SEASON_ONE_NOTE);
    expect(recap.note).toMatch(/Grok always picked its starting spot last/);
    expect(recap.note).toMatch(/ran out of budget to think/);
    expect(recap.note.length).toBeLessThan(320);
    expect(sanitizeFrontierPublicText(recap.note, 320)).toBe(recap.note);
  });

  it("keeps the Season 1 colours and gives Opus and unknown sides colours of their own", () => {
    const byLabel = new Map(
      FRONTIER_SEASON_TWO_TEAMS.map((team) => [team.label, team]),
    );
    for (const team of FRONTIER_FOUR_TEAMS) {
      expect(byLabel.get(team.label)?.color).toBe(team.color);
    }
    expect(byLabel.get("Opus")).toMatchObject({
      model: "anthropic/claude-opus-5.5",
      displayName: "Claude Opus 5.5",
      provider: "Anthropic",
      color: "#f472b6",
    });
    const colors = FRONTIER_SEASON_TWO_TEAMS.map((team) => team.color);
    expect(new Set(colors).size).toBe(colors.length);

    const stranger = parseFrontierGameRecordV2({
      ...ASIA_CLAIM,
      sides: [
        ...ASIA_CLAIM.sides,
        {
          label: "Kimi",
          model: "moonshotai/kimi-k3",
          team: null,
          slots: [4],
          pickOrder: 5,
        },
      ],
    })!;
    const teams = frontierTeamsFor(FRONTIER_SEASON_TWO_TEAMS, [stranger]);
    expect(teams.map((team) => team.label)).toEqual([
      "Astra",
      "Fable",
      "Opus",
      "Gemini",
      "Grok",
      "Kimi",
    ]);
    expect(teams[5]).toMatchObject({
      displayName: "Kimi",
      provider: "Moonshot AI",
    });
    expect(colors).not.toContain(teams[5].color);

    // A config roster that leaves out a known model: it keeps its usual
    // identity, unless its colour is taken.
    const partial = frontierTeamsFor(
      parseFrontierRoster([
        { label: "Opus", model: "anthropic/claude-opus-5.5", color: "#f472b6" },
        { label: "Kimi", model: "moonshotai/kimi-k3", color: "#60a5fa" },
      ]),
      [parseFrontierGameRecordV2(ASIA_CLAIM)!],
    );
    expect(partial.map((team) => [team.label, team.color])).toEqual([
      ["Opus", "#f472b6"],
      ["Kimi", "#60a5fa"],
      ["Astra", "#fb923c"],
      ["Fable", "#f59e0b"],
      ["Gemini", "#a78bfa"],
      ["Grok", "#34d399"],
    ]);
    expect(partial[3].displayName).toBe("Claude Fable 5.1");
  });

  it("reads a roster from config and refuses a bad one", () => {
    const roster = parseFrontierRoster([
      {
        label: "Opus",
        model: "anthropic/claude-opus-5.5",
        displayName: "Claude Opus 5.5",
        provider: "Anthropic",
        color: "#F472B6",
      },
      { label: "Grok", model: "x-ai/grok-4.7", displayName: "Grok 4.7" },
    ]);
    expect(
      roster.map((team) => [team.label, team.provider, team.color]),
    ).toEqual([
      ["Opus", "Anthropic", "#f472b6"],
      // No colour given: a known label keeps its usual one.
      ["Grok", "xAI", "#34d399"],
    ]);
    expect(roster[0].emblemSvg).toContain(">O<");
    expect(roster[1].emblemSvg).toContain(">X<");
    expect(() => parseFrontierRoster([])).toThrow();
    expect(() =>
      parseFrontierRoster([{ label: "Opus", model: "a/b", color: "pink" }]),
    ).toThrow();
    expect(() =>
      parseFrontierRoster([
        { label: "Opus", model: "a/b" },
        { label: "Opus", model: "a/c" },
      ]),
    ).toThrow();
  });

  it("takes the scheduler config's teams as the roster without recolouring anyone", () => {
    // The shape of frontier-ffa.example.json's teams: no colours, extra keys.
    const configTeams = FRONTIER_SEASON_TWO_TEAMS.map((team) => ({
      label: team.label,
      model: team.model,
      displayName: team.displayName,
      provider: team.provider,
      policy_ref: "REPLACE_policy_version_uuid",
    }));
    const roster = parseFrontierRoster(configTeams);
    expect(
      roster.map((team) => [team.label, team.color, team.secondaryColor]),
    ).toEqual(
      FRONTIER_SEASON_TWO_TEAMS.map((team) => [
        team.label,
        team.color,
        team.secondaryColor,
      ]),
    );
    // A colour another entry asked for is not taken twice; an unknown
    // label gets a spare; a known slug brings its public name.
    const crowded = parseFrontierRoster([
      { label: "Grok", model: "x-ai/grok-4.7" },
      { label: "Kimi", model: "moonshotai/kimi-k3", color: "#34d399" },
      { label: "Deep_Seek", model: "deepseek/deepseek-v4" },
    ]);
    expect(
      crowded.map((team) => [
        team.label,
        team.displayName,
        team.provider,
        team.color,
      ]),
    ).toEqual([
      ["Grok", "Grok 4.7", "xAI", "#fb923c"],
      ["Kimi", "Kimi", "Moonshot AI", "#34d399"],
      ["Deep_Seek", "Deep_Seek", "DeepSeek", "#22d3ee"],
    ]);
  });

  it("names the model a side last played, not a stale roster's", () => {
    const onModel = (raw: ReturnType<typeof ffaGame>, grokModel: string) =>
      parseFrontierGameRecordV2({
        ...raw,
        sides: raw.sides.map((side) =>
          side.label === "Grok" ? { ...side, model: grokModel } : side,
        ),
      })!;
    // The operator moved Grok to a new slug and it has played on it.
    const swapped = [
      onModel(ASIA_CLAIM, "x-ai/grok-4.7"),
      onModel(EAST_ASIA_GROK, "x-ai/grok-5-fast"),
    ];
    const teams = frontierTeamsFor(FRONTIER_SEASON_TWO_TEAMS, swapped);
    expect(teams.find((team) => team.label === "Grok")).toMatchObject({
      model: "x-ai/grok-5-fast",
      // An unknown slug is not given the old model's name.
      displayName: "Grok",
      provider: "xAI",
      color: "#34d399",
    });
    expect(frontierRosterMismatches(FRONTIER_SEASON_TWO_TEAMS, teams)).toEqual([
      "Grok: the roster names x-ai/grok-4.7 but its latest game ran x-ai/grok-5-fast; showing x-ai/grok-5-fast until it plays on the roster's model",
    ]);
    // The config already says the new slug, but no game has run on it yet:
    // the page names the model that actually fought.
    const roster = parseFrontierRoster([
      {
        label: "Grok",
        model: "x-ai/grok-5-fast",
        displayName: "Grok 5 Fast",
      },
    ]);
    const before = frontierTeamsFor(roster, [
      onModel(ASIA_CLAIM, "x-ai/grok-4.7"),
    ]);
    expect(before[0]).toMatchObject({
      model: "x-ai/grok-4.7",
      displayName: "Grok 4.7",
    });
    const after = frontierTeamsFor(roster, swapped);
    expect(after[0]).toMatchObject({
      model: "x-ai/grok-5-fast",
      displayName: "Grok 5 Fast",
    });
    expect(frontierRosterMismatches(roster, after)).toEqual([]);
  });

  it("reads every label the scheduler accepts, underscores included", () => {
    const record = parseFrontierGameRecordV2({
      ...ASIA_CLAIM,
      sides: ASIA_CLAIM.sides.map((side) =>
        side.label === "Astra" ? { ...side, label: "GPT_6" } : side,
      ),
      standings: ASIA_CLAIM.standings.map((standing) =>
        standing.label === "Astra" ? { ...standing, label: "GPT_6" } : standing,
      ),
    });
    expect(record?.sides.map((side) => side.label)).toContain("GPT_6");
  });
});

describe("Frontier Season 2 world", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true });
  });

  it("publishes the world from Season 2 games only, the latest battle deciding each front", async () => {
    const siteDir = await mkdtemp(path.join(tmpdir(), "frontier-ffa-"));
    dirs.push(siteDir);
    const gamesPath = path.join(siteDir, "frontier-ffa-games.jsonl");
    const seasonOnePath = path.join(siteDir, "games.jsonl");
    await writeFile(
      gamesPath,
      [
        JSON.stringify(ASIA_CLAIM),
        JSON.stringify(ASIA_NO_WINNER),
        "{ not json",
        // A Season 1 record in the Season 2 file never moves a front.
        JSON.stringify(
          game("stray", "World", "Red", "2026-10-05T12:00:00.000Z"),
        ),
        // Nor does a record from another season.
        JSON.stringify(
          ffaGame({
            id: "season3",
            map: "Pangaea",
            frontLabel: "Pangaea",
            completedAt: "2026-10-05T12:30:00.000Z",
            cycle: 1,
            winner: "Astra",
            winType: "conquest",
            replay: "season3",
            seats: [
              ["Astra", 0, 1, 10, true, 1, 9, 3000, 100],
              ["Grok", 1, 0, 0, false, 2, 9, 9000, 900],
            ],
            season: 3,
          }),
        ),
        JSON.stringify(EAST_ASIA_GROK),
        JSON.stringify(EAST_ASIA_FABLE),
      ].join("\n") + "\n",
    );
    await writeFile(
      seasonOnePath,
      [
        game("s1a", "Asia", "Purple", "2026-10-04T15:00:00.000Z"),
        game("s1b", "Oceania", "Blue", "2026-10-04T16:00:00.000Z", 1),
        game("s1c", "Africa", "Purple", "2026-10-04T17:00:00.000Z", 1),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );

    const publication = await publishFrontierWorld({
      siteDir,
      gamesPath,
      seasonOneGamesPath: seasonOnePath,
      now: "2026-10-05T18:00:00.000Z",
    });
    expect(publication).toMatchObject({ season: 2, games: 4, battles: 4 });

    const world = JSON.parse(
      await readFile(path.join(siteDir, COWORLD_LEAGUE_WORLD_FILE), "utf8"),
    );
    expect(world.mode).toBe("frontier");
    expect(world.season).toBe(2);
    expect(world.windowSize).toBe(1);
    expect(world.battleCount).toBe(4);
    const theatre = (id: string) =>
      world.theatres.find((entry: { id: string }) => entry.id === id);
    // A battle nobody won leaves the holder in place.
    expect(theatre("asia")).toMatchObject({
      holder: "Grok",
      status: "held",
      battleCount: 2,
    });
    // One later win takes a front: no 12-battle window in Season 2.
    expect(theatre("east_asia")).toMatchObject({
      holder: "Fable",
      status: "held",
      heldSince: "2026-10-05T17:06:32.859Z",
    });
    expect(theatre("crown").holder).toBeNull();
    expect(
      world.events.map((event: { kind: string; agent: string }) => [
        event.kind,
        event.agent,
      ]),
    ).toEqual([
      ["conquest", "Fable"],
      ["claim", "Grok"],
      ["claim", "Grok"],
    ]);
    const fable = world.agents.find(
      (agent: { name: string }) => agent.name === "Fable",
    );
    expect(fable).toMatchObject({
      label: "Claude Fable 5.1",
      color: "#f59e0b",
    });

    expect(world.teams).toEqual([
      {
        label: "Astra",
        model: "openai/gpt-6-astra",
        displayName: "GPT-6 Astra",
        provider: "OpenAI",
        color: "#60a5fa",
      },
      {
        label: "Fable",
        model: "anthropic/claude-fable-5.1",
        displayName: "Claude Fable 5.1",
        provider: "Anthropic",
        color: "#f59e0b",
      },
      {
        label: "Opus",
        model: "anthropic/claude-opus-5.5",
        displayName: "Claude Opus 5.5",
        provider: "Anthropic",
        color: "#f472b6",
      },
      {
        label: "Gemini",
        model: "google/gemini-3.1-pro-preview",
        displayName: "Gemini 3.1 Pro",
        provider: "Google",
        color: "#a78bfa",
      },
      {
        label: "Grok",
        model: "x-ai/grok-4.7",
        displayName: "Grok 4.7",
        provider: "xAI",
        color: "#34d399",
      },
    ]);
    expect(world.schedule).toEqual({
      timesUtc: ["13:00", "19:00"],
      nextBattleAt: "2026-10-05T19:00:00.000Z",
    });
    expect(world.seasonOneRecap).toEqual({
      battles: 3,
      winsByLabel: { Grok: 2, Fable: 1, Astra: 0, Gemini: 0 },
      note: FRONTIER_SEASON_ONE_NOTE,
    });
    expect(world.latestBattle).toMatchObject({
      episodeRequestId: "ereq_14f5f5fc-4a5a-40ba-bb43-2a5b0e2f7bc6",
      map: "EastAsia",
      frontLabel: "East Asia",
      completedAt: "2026-10-05T17:06:32.859Z",
      winnerLabel: "Fable",
      winType: "points",
    });
    expect(world.latestBattle.watchHref).toBe(EAST_ASIA_FABLE.viewerUrl);
    expect(
      world.latestBattle.standings.map(
        (standing: { label: string; rank: number }) => [
          standing.label,
          standing.rank,
        ],
      ),
    ).toEqual([
      ["Fable", 1],
      ["Grok", 2],
      ["Astra", 3],
      ["Gemini", 4],
      ["Opus", 5],
    ]);
    expect(world.latestBattle.voices).toHaveLength(6);
    const published = JSON.stringify(world);
    expect(published).not.toContain("evil.example");
    expect(published).not.toContain("@grok_fan");
    expect(published).not.toContain("‮");

    // Season 1 rows stay, so links shared during Season 1 still resolve.
    const episodes = JSON.parse(
      await readFile(path.join(siteDir, FRONTIER_FOUR_EPISODES_FILE), "utf8"),
    );
    expect(
      episodes.episodes.map(
        (row: { episodeRequestId: string }) => row.episodeRequestId,
      ),
    ).toEqual([
      "ereq_s1a",
      "ereq_s1b",
      "ereq_s1c",
      "ereq_1b1c1dbe-087c-40c2-b55a-653570f84937",
      "ereq_303812ad-a7e4-4203-a929-336e6ece8ca7",
      "ereq_48e962b6-4056-4d7a-8451-e164e7f419b2",
      "ereq_14f5f5fc-4a5a-40ba-bb43-2a5b0e2f7bc6",
    ]);
    expect(await readWorldSource(siteDir)).toBe("frontier-four");
    expect(world.events[0].href).toBe(
      "/match/ereq_14f5f5fc-4a5a-40ba-bb43-2a5b0e2f7bc6",
    );

    // Republishing the same games changes nothing but the clock.
    const again = await publishFrontierWorld({
      siteDir,
      gamesPath,
      seasonOneGamesPath: seasonOnePath,
      now: "2026-10-05T18:00:00.000Z",
    });
    expect(again.battles).toBe(4);
    expect(
      JSON.parse(
        await readFile(path.join(siteDir, COWORLD_LEAGUE_WORLD_FILE), "utf8"),
      ),
    ).toEqual(world);

    // The world can still go back to the league.
    await restoreLeagueWorldSource(siteDir);
    expect(await readWorldSource(siteDir)).toBe("league");
  });

  it("counts a game appended twice once, and keeps Season 1-only sides off the Season 2 roster", async () => {
    const siteDir = await mkdtemp(path.join(tmpdir(), "frontier-ffa-dup-"));
    dirs.push(siteDir);
    const gamesPath = path.join(siteDir, "frontier-ffa-games.jsonl");
    const seasonOnePath = path.join(siteDir, "games.jsonl");
    // A crash between appending a game and saving the scheduler's state
    // appends it again on the next run.
    await writeFile(
      gamesPath,
      [ASIA_CLAIM, ASIA_CLAIM, EAST_ASIA_GROK, ASIA_CLAIM]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    await writeFile(
      seasonOnePath,
      [
        game("s1a", "Asia", "Teal", "2026-10-04T15:00:00.000Z"),
        game("s1a", "Asia", "Teal", "2026-10-04T15:00:00.000Z"),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    expect(
      (await readFrontierGames(gamesPath)).map(
        (record) => record.episodeRequestId,
      ),
    ).toEqual([ASIA_CLAIM.episodeRequestId, EAST_ASIA_GROK.episodeRequestId]);

    // A Season 2 roster without Gemini, and Season 2 games without it.
    const roster = FRONTIER_SEASON_TWO_TEAMS.filter(
      (team) => team.label !== "Gemini",
    );
    const withoutGemini = (raw: ReturnType<typeof ffaGame>) => ({
      ...raw,
      sides: raw.sides.filter((side) => side.label !== "Gemini"),
      standings: raw.standings.filter(
        (standing) => standing.label !== "Gemini",
      ),
    });
    await writeFile(
      gamesPath,
      [ASIA_CLAIM, ASIA_CLAIM, EAST_ASIA_GROK]
        .map((line) => JSON.stringify(withoutGemini(line)))
        .join("\n") + "\n",
    );
    const publication = await publishFrontierWorld({
      siteDir,
      gamesPath,
      seasonOneGamesPath: seasonOnePath,
      roster,
      now: "2026-10-05T18:00:00.000Z",
    });
    expect(publication).toMatchObject({ games: 2, battles: 2, warnings: [] });
    expect(publication.records).toHaveLength(2);
    expect(publication.teams.map((team) => team.label)).toEqual([
      "Astra",
      "Fable",
      "Opus",
      "Grok",
    ]);
    const world = JSON.parse(
      await readFile(path.join(siteDir, COWORLD_LEAGUE_WORLD_FILE), "utf8"),
    );
    expect(world.battleCount).toBe(2);
    expect(world.teams.map((team: { label: string }) => team.label)).toEqual([
      "Astra",
      "Fable",
      "Opus",
      "Grok",
    ]);
    expect(world.seasonOneRecap).toMatchObject({
      battles: 1,
      winsByLabel: { Gemini: 1 },
    });
    // Gemini still wears its own colour on its old Season 1 match page.
    const episodes = JSON.parse(
      await readFile(path.join(siteDir, FRONTIER_FOUR_EPISODES_FILE), "utf8"),
    );
    expect(
      episodes.episodes.map(
        (row: { episodeRequestId: string }) => row.episodeRequestId,
      ),
    ).toEqual([
      "ereq_s1a",
      ASIA_CLAIM.episodeRequestId,
      EAST_ASIA_GROK.episodeRequestId,
    ]);
    const geminiSeat = episodes.episodes[0].players.find(
      (player: { name: string }) => player.name.startsWith("Gemini"),
    );
    expect(geminiSeat).toMatchObject({ color: "#a78bfa", isWinner: true });
  });

  it("publishes an empty season with its schedule before the first battle", async () => {
    const siteDir = await mkdtemp(path.join(tmpdir(), "frontier-ffa-empty-"));
    dirs.push(siteDir);
    const publication = await publishFrontierWorld({
      siteDir,
      gamesPath: path.join(siteDir, "missing.jsonl"),
      now: "2026-10-06T21:00:00.000Z",
      timesUtc: ["13:00"],
      nextBattleAt: null,
    });
    expect(publication).toMatchObject({ games: 0, battles: 0 });
    const world = JSON.parse(
      await readFile(path.join(siteDir, COWORLD_LEAGUE_WORLD_FILE), "utf8"),
    );
    expect(world).toMatchObject({
      mode: "frontier",
      battleCount: 0,
      latestBattle: null,
      seasonOneRecap: null,
      schedule: { timesUtc: ["13:00"], nextBattleAt: null },
    });
    expect(world.teams).toHaveLength(5);
    expect(
      world.theatres.every(
        (theatre: { status: string }) => theatre.status === "unclaimed",
      ),
    ).toBe(true);
  });
});
