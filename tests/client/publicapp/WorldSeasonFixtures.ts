import { worldFixture } from "./WorldFixtures";

/**
 * Season 2 wire fixtures for client tests: a `world.json` in the
 * `mode: "frontier"` shape (contract C of the Season 2 spec) and the
 * `frontier-form.json` beside it, shaped as the publisher writes them
 * (results over 30 days, speed and length over the 7 before, an English
 * `sentence` on every model). Plain JSON, not typed models, so the tests
 * exercise the page's own validation the way the wire does.
 * `WorldSeasonPublisher.test.ts` mounts the page on the real publisher's
 * output as well.
 *
 * Numbers are Season 1's where Season 1 measured them: 37 team battles,
 * Grok 25 / Gemini 7 / Fable 3 / Astra 2, and per-call planner medians of
 * Astra 3.3 s / 129 tokens, Gemini 6.2 s / 597, Fable 13.0 s / 802 and
 * Grok 16.2 s / 1,296. Opus is new in Season 2; its numbers are made up.
 */

/** 2 h 19 min after the fixture's latest battle, 3 h before the next. */
export const SEASON_TWO_NOW = new Date("2026-10-06T16:00:00.000Z");

export const SEASON_TWO_TEAMS = [
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
];

export const SEASON_TWO_VIEWER_URL =
  "https://api.observatory.softmax-research.net/v2/coworlds/replays/static/cow_ffa/index.html?v=2#replay=https%3A%2F%2Fsoftmax-public.s3.amazonaws.com%2Freplays%2Fea2.replay";

function battle(id: string, map: string, winner: string | null, at: string) {
  return { episodeRequestId: id, map, winner, at, href: `/match/${id}` };
}

/** One front decided by its latest battle (a window of one). */
function held(
  id: string,
  battlefields: string[],
  holder: string,
  latest: ReturnType<typeof battle>,
  heldSince: string,
) {
  return {
    id,
    battlefields,
    status: "held",
    holder,
    heldSince,
    holderWins: latest.winner === holder ? 1 : 0,
    challenger: null,
    challengerWins: 0,
    battleCount: 2,
    lastBattleAt: latest.at,
    window: [latest],
    tallies: latest.winner === null ? [] : [{ name: latest.winner, wins: 1 }],
    maps: [{ map: latest.map, battles: 2 }],
    reigns: [{ holder, from: heldSince, to: null, battles: 1, wins: 1 }],
  };
}

export function seasonTwoWorld(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = worldFixture();
  const theatres = base.theatres.map((theatre) => ({
    ...theatre,
    status: "unclaimed",
    holder: null,
    heldSince: null,
    holderWins: 0,
    challenger: null,
    challengerWins: 0,
    battleCount: 0,
    lastBattleAt: null,
    window: [],
    tallies: [],
    maps: [],
    reigns: [],
  })) as Array<Record<string, unknown>>;
  const set = (front: Record<string, unknown>) => {
    theatres[theatres.findIndex((entry) => entry.id === front.id)] = front;
  };
  set(
    held(
      "east_asia",
      ["eastasia", "japan"],
      "Grok",
      battle("ereq_ea2", "EastAsia", "Grok", "2026-10-06T13:41:00.000Z"),
      "2026-10-06T13:41:00.000Z",
    ),
  );
  set(
    held(
      "europe",
      ["europe", "europeclassic"],
      "Grok",
      battle("ereq_eu1", "Europe", "Grok", "2026-10-05T19:44:00.000Z"),
      "2026-10-05T19:44:00.000Z",
    ),
  );
  set(
    held(
      "oceania",
      ["oceania", "australia"],
      "Opus",
      battle("ereq_oc1", "Oceania", "Opus", "2026-10-05T13:38:00.000Z"),
      "2026-10-05T13:38:00.000Z",
    ),
  );
  // Its latest battle had no winner: the holder keeps it.
  set(
    held(
      "black_sea",
      ["blacksea"],
      "Gemini",
      battle("ereq_bs2", "BlackSea", null, "2026-10-04T19:40:00.000Z"),
      "2026-10-04T13:40:00.000Z",
    ),
  );
  const agent = (
    label: string,
    color: string,
    owned: string[],
    conquests: number,
    battlesWon: number,
  ) => ({
    name: label,
    label,
    slug: null,
    color,
    secondaryColor: "#0b1220",
    emblemSvg: null,
    isHouse: false,
    theatres: owned,
    conquests,
    battlesWon,
  });
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-06T13:45:00.000Z",
    windowSize: 1,
    battleCount: 7,
    battlesLast24h: 2,
    firstBattleAt: "2026-10-03T13:40:00.000Z",
    lastBattleAt: "2026-10-06T13:41:00.000Z",
    feed: {
      stale: false,
      lastGoodSyncAt: "2026-10-06T13:45:00.000Z",
      currentRoundNumber: 7,
      roundIntervalMinutes: null,
    },
    theatres,
    events: [
      {
        kind: "conquest",
        theatreId: "east_asia",
        at: "2026-10-06T13:41:00.000Z",
        episodeRequestId: "ereq_ea2",
        map: "EastAsia",
        agent: "Grok",
        rival: "Opus",
        agentWins: 1,
        rivalWins: 0,
        href: "/match/ereq_ea2",
      },
      {
        kind: "claim",
        theatreId: "oceania",
        at: "2026-10-05T13:38:00.000Z",
        episodeRequestId: "ereq_oc1",
        map: "Oceania",
        agent: "Opus",
        rival: null,
        agentWins: 1,
        rivalWins: 0,
        href: "/match/ereq_oc1",
      },
    ],
    timeline: [
      { day: "2026-10-05", holders: { oceania: "Opus", europe: "Grok" } },
      {
        day: "2026-10-06",
        holders: { oceania: "Opus", europe: "Grok", east_asia: "Grok" },
      },
    ],
    agents: [
      agent("Grok", "#34d399", ["east_asia", "europe"], 2, 3),
      agent("Opus", "#f472b6", ["oceania"], 1, 2),
      agent("Gemini", "#a78bfa", ["black_sea"], 1, 1),
      agent("Fable", "#f59e0b", [], 0, 1),
      agent("Astra", "#60a5fa", [], 0, 0),
    ],
    links: null,
    mode: "frontier",
    season: 2,
    teams: SEASON_TWO_TEAMS,
    schedule: {
      timesUtc: ["13:00", "19:00"],
      nextBattleAt: "2026-10-06T19:00:00.000Z",
    },
    seasonOneRecap: {
      battles: 37,
      winsByLabel: { Astra: 2, Fable: 3, Gemini: 7, Grok: 25 },
      note: "Spawn order and an equal-dollar budget tilted Season 1 toward Grok, so Season 2 changes both.",
    },
    latestBattle: {
      episodeRequestId: "ereq_ea2",
      map: "EastAsia",
      frontLabel: "east_asia",
      completedAt: "2026-10-06T13:41:00.000Z",
      winnerLabel: "Grok",
      winType: "points",
      standings: [
        {
          label: "Astra",
          landShare: 0,
          tilesOwned: 0,
          isAlive: false,
          eliminatedAtTurn: 9100,
          rank: 5,
        },
        {
          label: "Grok",
          landShare: 0.38,
          tilesOwned: 61210,
          isAlive: true,
          eliminatedAtTurn: null,
          rank: 1,
        },
        {
          label: "Opus",
          landShare: 0.24,
          tilesOwned: 38650,
          isAlive: true,
          eliminatedAtTurn: null,
          rank: 2,
        },
        {
          label: "Gemini",
          landShare: 0.19,
          tilesOwned: 30600,
          isAlive: true,
          eliminatedAtTurn: null,
          rank: 3,
        },
        {
          label: "Fable",
          landShare: 0.12,
          tilesOwned: 19320,
          isAlive: true,
          eliminatedAtTurn: null,
          rank: 4,
        },
      ],
      voices: [
        {
          label: "Grok",
          kind: "message",
          to: "Opus",
          turn: 2400,
          text: "Our border is quiet and I would like to keep it that way. Non-aggression until one of us reaches 30% of the land?",
        },
        {
          label: "Opus",
          kind: "dispatch",
          to: null,
          turn: 1200,
          text: "Holding the coast and building ports first. Whoever comes for Kyushu pays for every tile.",
        },
        {
          label: "Fable",
          kind: "message",
          to: "Astra",
          turn: 3000,
          text: "You have twice my troops on our border and none of my patience. Pull back or lose the ports.",
        },
        {
          label: "Gemini",
          kind: "dispatch",
          to: null,
          turn: 4000,
          text: "Quiet expansion in the south. No one has noticed yet.",
        },
        {
          label: "Grok",
          kind: "dispatch",
          to: null,
          turn: 6000,
          text: "Fields first, swords later. Now it is later. www.example.com",
        },
        {
          label: "Astra",
          kind: "dispatch",
          to: null,
          turn: 8800,
          text: "Out of land and out of time.",
        },
      ],
      watchHref: SEASON_TWO_VIEWER_URL,
    },
    ...overrides,
  };
}

function day(
  date: string,
  battles: number,
  wins: number,
  meanLandShare: number | null,
  plans: number,
  planFailures: number,
  latencyMsMedian: number,
  outputTokensMedian: number,
) {
  return {
    day: date,
    battles,
    wins,
    meanLandShare,
    ranks: [],
    plans,
    planFailures,
    latencyMsMedian,
    outputTokensMedian,
  };
}

export function frontierFormFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-06T13:45:00.000Z",
    harness: { planEvery: 15, plansPerSeat: 17, reasoning: "low" },
    models: [
      {
        label: "Grok",
        displayName: "Grok 4.7",
        provider: "xAI",
        days: [
          day("2026-10-05", 2, 1, 0.31, 34, 0, 16100, 1290),
          day("2026-10-06", 1, 1, 0.38, 17, 0, 15900, 1300),
        ],
        trailing: {
          days: 30,
          battles: 12,
          wins: 7,
          winRate: 0.58,
          latencyMsMedian: 16200,
          outputTokensMedian: 1296,
          speedDays: 7,
        },
        today: {
          verdictKind: "normal",
          chanceOfResult: 1,
          sentence:
            "Won 1 of 1 battle today, at or above its usual 58% win rate.",
        },
      },
      {
        label: "Astra",
        displayName: "GPT-6 Astra",
        provider: "OpenAI",
        days: [
          day("2026-10-05", 2, 0, 0.08, 34, 0, 3200, 128),
          day("2026-10-06", 1, 0, 0, 17, 0, 3300, 130),
        ],
        trailing: {
          days: 30,
          battles: 12,
          wins: 1,
          winRate: 0.08,
          latencyMsMedian: 3300,
          outputTokensMedian: 129,
          speedDays: 7,
        },
        today: {
          verdictKind: "normal",
          chanceOfResult: 0.92,
          sentence:
            "Won 0 of 1 battle today. At its usual 8% win rate, a day this bad or worse happens 92% of the time.",
        },
      },
      {
        label: "Fable",
        displayName: "Claude Fable 5.1",
        provider: "Anthropic",
        days: [
          day("2026-10-01", 2, 1, 0.24, 17, 1, 12900, 800),
          day("2026-10-02", 2, 0, 0.2, 17, 1, 13000, 805),
          day("2026-10-03", 2, 1, 0.22, 17, 1, 13100, 790),
          day("2026-10-04", 2, 1, 0.26, 17, 1, 12800, 802),
          day("2026-10-05", 2, 0, 0.15, 17, 1, 13000, 810),
          day("2026-10-06", 1, 0, 0.12, 17, 2, 13100, 810),
        ],
        trailing: {
          days: 30,
          battles: 12,
          wins: 3,
          winRate: 0.25,
          latencyMsMedian: 13000,
          outputTokensMedian: 802,
          speedDays: 7,
        },
        today: {
          verdictKind: "normal",
          chanceOfResult: 0.75,
          sentence:
            "Won 0 of 1 battle today. At its usual 25% win rate, a day this bad or worse happens 75% of the time.",
        },
      },
      {
        label: "Opus",
        displayName: "Claude Opus 5.5",
        provider: "Anthropic",
        days: [
          day("2026-10-05", 2, 1, 0.27, 34, 1, 11200, 690),
          day("2026-10-06", 1, 0, 0.24, 17, 0, 11000, 700),
        ],
        trailing: {
          days: 30,
          battles: 4,
          wins: 2,
          winRate: 0.5,
          latencyMsMedian: 11100,
          outputTokensMedian: 695,
          speedDays: 7,
        },
        today: {
          verdictKind: "too_few",
          chanceOfResult: null,
          sentence:
            "Won 0 of 1 battle today. Too few earlier battles to compare yet.",
        },
      },
      {
        label: "Gemini",
        displayName: "Gemini 3.1 Pro",
        provider: "Google",
        days: [
          day("2026-10-05", 2, 0, 0.18, 34, 1, 6100, 600),
          day("2026-10-06", 1, 0, 0.19, 17, 0, 9100, 590),
        ],
        trailing: {
          days: 30,
          battles: 12,
          wins: 2,
          winRate: 0.17,
          latencyMsMedian: 6100,
          outputTokensMedian: 597,
          speedDays: 7,
        },
        today: {
          verdictKind: "slower",
          chanceOfResult: 0.83,
          sentence:
            "Won 0 of 1 battle today. At its usual 17% win rate, a day this bad or worse happens 83% of the time. Speed: its answers took 49% longer than the week before.",
        },
      },
    ],
    ...overrides,
  };
}
