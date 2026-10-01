import { describe, expect, test } from "vitest";
import type { PublicAgent } from "../../src/server/ProxyWarPublicReadModel";
import type { CoworldLeagueMirrorData } from "../../src/server/agents/CoworldLeagueSiteWriter";
import {
  battleFromArchivedReplaySummary,
  battlesFromMirrorData,
  buildPublicWorldModel,
  EMPTY_WORLD_LEDGER,
  mergeWorldLedger,
  normaliseWorldMapKey,
  parseWorldLedgerStore,
  reduceWorld,
  serialiseWorldLedgerStore,
  timestampFromRunKey,
  worldTheatreForMap,
  type WorldLedgerBattle,
  type WorldLedgerStore,
} from "../../src/server/agents/CoworldLeagueWorld";

let sequence = 0;
function battle(
  map: string,
  winnerName: string | null,
  battleAt: string,
  overrides: Partial<WorldLedgerBattle> = {},
): WorldLedgerBattle {
  sequence += 1;
  return {
    episodeRequestId: `ereq_test${String(sequence).padStart(5, "0")}`,
    map,
    winnerName,
    playerCount: 16,
    roundNumber: null,
    battleAt,
    ...overrides,
  };
}

/** One battle per minute from a fixed start, in order. */
function series(
  map: string,
  winners: ReadonlyArray<string | null>,
  start = "2026-09-01T00:00:00.000Z",
): WorldLedgerBattle[] {
  const base = Date.parse(start);
  return winners.map((winner, index) =>
    battle(map, winner, new Date(base + index * 60_000).toISOString()),
  );
}

function ledger(battles: WorldLedgerBattle[]): WorldLedgerStore {
  return mergeWorldLedger(EMPTY_WORLD_LEDGER, battles);
}

function mirrorData(
  overrides: Partial<CoworldLeagueMirrorData> = {},
): CoworldLeagueMirrorData {
  return {
    generatedAt: "2026-09-29T22:05:00.000Z",
    lastGoodSyncAt: "2026-09-29T22:05:00.000Z",
    stale: false,
    league: {
      id: "league_test",
      name: "Proxywar",
      description: null,
      divisionName: "Competition",
      roundIntervalMinutes: 40,
      episodesPerRound: 25,
      currentRoundNumber: 2353,
      currentRoundStatus: "pending",
      scoreLabel: "Score",
    },
    standings: [],
    rounds: [],
    episodes: [],
    links: { enterTheLeagueUrl: "https://example.test", platformLabel: "Test" },
    ...overrides,
  };
}

function episode(
  episodeRequestId: string,
  map: string,
  winnerName: string | null,
  extra: Partial<CoworldLeagueMirrorData["episodes"][number]> = {},
): CoworldLeagueMirrorData["episodes"][number] {
  return {
    episodeRequestId,
    shortId: episodeRequestId.slice(5, 13),
    roundNumber: 2352,
    completedAt: null,
    map,
    mapSize: "Normal",
    turnCount: null,
    decisionCount: null,
    degradedCount: null,
    winnerName,
    players: [],
    watchHref: null,
    fullRenderHref: null,
    ...extra,
  };
}

describe("theatre catalog", () => {
  test("normalises battlefield names the way the league reports them", () => {
    expect(normaliseWorldMapKey("Black Sea")).toBe("blacksea");
    expect(normaliseWorldMapKey("EastAsia")).toBe("eastasia");
    expect(worldTheatreForMap("Black Sea")).toBe("black_sea");
    expect(worldTheatreForMap("BlackSea")).toBe("black_sea");
    expect(worldTheatreForMap("Oceania")).toBe("oceania");
    expect(worldTheatreForMap("NorthAmerica")).toBe("north_america");
  });

  test("whole-world maps decide the Crown, and unknown maps decide nothing", () => {
    expect(worldTheatreForMap("Pangaea")).toBe("crown");
    expect(worldTheatreForMap("World")).toBe("crown");
    expect(worldTheatreForMap("Giant World Map")).toBe("crown");
    expect(worldTheatreForMap("Mars")).toBeNull();
    expect(worldTheatreForMap("Unknown map")).toBeNull();
  });
});

describe("ledger ingestion", () => {
  test("reads the completion instant out of a mirror run key", () => {
    expect(
      timestampFromRunKey(
        "/ai-league-replay/league-coworld-2026-09-29T21-32-22-101Z-db392769",
      ),
    ).toBe("2026-09-29T21:32:22.101Z");
    expect(
      timestampFromRunKey("/ai-league-runs/run/spectator.html"),
    ).toBeNull();
    expect(timestampFromRunKey(null)).toBeNull();
  });

  test("a stale republish contributes no battles", () => {
    const data = mirrorData({
      stale: true,
      episodes: [episode("ereq_a1", "Oceania", "Alpha")],
    });
    expect(battlesFromMirrorData(data)).toEqual([]);
  });

  test("takes completion time from completedAt, then the run key, then the sync instant", () => {
    const data = mirrorData({
      episodes: [
        episode("ereq_a1", "Oceania", "Alpha", {
          completedAt: "2026-09-29T20:00:00Z",
        }),
        episode("ereq_a2", "EastAsia", "Beta", {
          fullRenderHref:
            "/ai-league-replay/league-coworld-2026-09-29T21-32-22-101Z-db392769",
        }),
        episode("ereq_a3", "Asia", null),
        episode("not-an-episode-id", "Asia", "Gamma"),
        episode("ereq_a4", "  ", "Gamma"),
      ],
    });
    expect(battlesFromMirrorData(data)).toEqual([
      expect.objectContaining({
        episodeRequestId: "ereq_a1",
        battleAt: "2026-09-29T20:00:00.000Z",
        winnerName: "Alpha",
        roundNumber: 2352,
      }),
      expect.objectContaining({
        episodeRequestId: "ereq_a2",
        battleAt: "2026-09-29T21:32:22.101Z",
      }),
      expect.objectContaining({
        episodeRequestId: "ereq_a3",
        battleAt: "2026-09-29T22:05:00.000Z",
        winnerName: null,
      }),
    ]);
  });

  test("merging is idempotent and returns the same store when nothing is new", () => {
    const first = ledger(series("Oceania", ["Alpha", "Beta"]));
    expect(mergeWorldLedger(first, first.battles)).toBe(first);
    expect(mergeWorldLedger(first, [])).toBe(first);
  });

  test("a re-seen battle only gains facts it was missing and never loses a winner", () => {
    const [known] = series("Oceania", [null]);
    const store = ledger([known]);
    const withWinner = mergeWorldLedger(store, [
      { ...known, winnerName: "Alpha", roundNumber: 7 },
    ]);
    expect(withWinner.battles[0]).toMatchObject({
      winnerName: "Alpha",
      roundNumber: 7,
    });
    const overwriteAttempt = mergeWorldLedger(withWinner, [
      { ...known, winnerName: "Mallory" },
    ]);
    expect(overwriteAttempt).toBe(withWinner);
  });

  test("keeps battles in completion order regardless of arrival order", () => {
    const [early, late] = series("Asia", ["Alpha", "Beta"]);
    const store = mergeWorldLedger(ledger([late]), [early]);
    expect(store.battles.map((entry) => entry.winnerName)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  test("round-trips through its own serialisation and flags corruption", () => {
    const store = ledger(series("Oceania", ["Alpha", null, "Beta"]));
    expect(parseWorldLedgerStore(serialiseWorldLedgerStore(store))).toEqual(
      store,
    );
    expect(
      parseWorldLedgerStore(serialiseWorldLedgerStore(EMPTY_WORLD_LEDGER)),
    ).toEqual(EMPTY_WORLD_LEDGER);
    expect(parseWorldLedgerStore("{")).toBe("corrupt");
    expect(parseWorldLedgerStore('{"schemaVersion":2,"battles":[]}')).toBe(
      "corrupt",
    );
    expect(
      parseWorldLedgerStore(
        JSON.stringify({
          schemaVersion: 1,
          battles: [{ episodeRequestId: "x" }],
        }),
      ),
    ).toBe("corrupt");
  });

  test("parses an archived compact replay summary", () => {
    const summary = {
      episodeRequestId: "ereq_00072840-6898-49e2-b77d-c346b4a97e45",
      runID: "coworld-2026-08-24T23-16-35-744Z-05c9a770",
      config: { map: "Pangaea" },
      results: {
        winner_slot: 1,
        players: [
          { slot: 0, name: "Matt Van" },
          { slot: 1, name: "docxology" },
        ],
      },
      finalState: { phase: "winner:docxology" },
    };
    expect(battleFromArchivedReplaySummary(summary)).toEqual({
      episodeRequestId: "ereq_00072840-6898-49e2-b77d-c346b4a97e45",
      map: "Pangaea",
      winnerName: "docxology",
      playerCount: 2,
      roundNumber: null,
      battleAt: "2026-08-24T23:16:35.744Z",
    });
    expect(
      battleFromArchivedReplaySummary({
        ...summary,
        results: { winner_slot: null, players: [] },
      })?.winnerName,
    ).toBe("docxology");
    expect(
      battleFromArchivedReplaySummary({
        ...summary,
        results: { winner_slot: null, players: [] },
        finalState: { phase: "active" },
      })?.winnerName,
    ).toBeNull();
    expect(
      battleFromArchivedReplaySummary({ ...summary, runID: "x" }),
    ).toBeNull();
    expect(
      battleFromArchivedReplaySummary({ ...summary, config: {} }),
    ).toBeNull();
    expect(battleFromArchivedReplaySummary(null)).toBeNull();
  });
});

describe("reduceWorld", () => {
  const theatreOf = (world: ReturnType<typeof reduceWorld>, id: string) =>
    world.theatres.find((theatre) => theatre.id === id);

  test("the first winner claims an unclaimed front", () => {
    const world = reduceWorld(ledger(series("Oceania", ["Alpha"])), 4);
    expect(theatreOf(world, "oceania")).toMatchObject({
      status: "held",
      holder: "Alpha",
      holderWins: 1,
    });
    expect(world.events[0]).toMatchObject({ kind: "claim", agent: "Alpha" });
    expect(theatreOf(world, "asia")).toMatchObject({
      status: "unclaimed",
      holder: null,
      battleCount: 0,
    });
  });

  test("a tie keeps the holder and lays a siege; strictly more wins conquers", () => {
    const tied = reduceWorld(ledger(series("Asia", ["Alpha", "Beta"])), 4);
    expect(theatreOf(tied, "asia")).toMatchObject({
      status: "contested",
      holder: "Alpha",
      challenger: "Beta",
      holderWins: 1,
      challengerWins: 1,
    });
    expect(tied.events[0]).toMatchObject({
      kind: "siege",
      agent: "Beta",
      rival: "Alpha",
      agentWins: 1,
      rivalWins: 1,
    });

    const conquered = reduceWorld(
      ledger(series("Asia", ["Alpha", "Beta", "Beta"])),
      4,
    );
    expect(theatreOf(conquered, "asia")).toMatchObject({
      holder: "Beta",
      holderWins: 2,
      challenger: "Alpha",
      challengerWins: 1,
      status: "held",
    });
    expect(conquered.events[0]).toMatchObject({
      kind: "conquest",
      agent: "Beta",
      rival: "Alpha",
      agentWins: 2,
      rivalWins: 1,
    });
    expect(theatreOf(conquered, "asia")?.reigns).toEqual([
      expect.objectContaining({ holder: "Beta", to: null }),
      expect.objectContaining({ holder: "Alpha", battles: 2, wins: 1 }),
    ]);
    expect(conquered.agents[0]).toMatchObject({
      name: "Beta",
      theatres: ["asia"],
      conquests: 1,
      battlesWon: 2,
    });
  });

  test("a holder who breaks the tie by winning holds the line", () => {
    const world = reduceWorld(
      ledger(series("Oceania", ["Alpha", "Beta", "Alpha"])),
      4,
    );
    expect(theatreOf(world, "oceania")).toMatchObject({
      status: "held",
      holder: "Alpha",
      holderWins: 2,
    });
    expect(world.events[0]).toMatchObject({
      kind: "held",
      agent: "Alpha",
      rival: "Beta",
      agentWins: 2,
      rivalWins: 1,
    });
  });

  test("names the most recent of tied challengers and lists the tallies in that same order", () => {
    // Alpha holds; Beta, Gamma and Delta have one win each, Delta most recently.
    const world = reduceWorld(
      ledger(series("Oceania", ["Alpha", "Alpha", "Beta", "Gamma", "Delta"])),
      12,
    );
    const oceania = theatreOf(world, "oceania");
    expect(oceania).toMatchObject({ holder: "Alpha", challenger: "Delta" });
    expect(oceania?.tallies.map((tally) => tally.name)).toEqual([
      "Alpha",
      "Delta",
      "Gamma",
      "Beta",
    ]);

    // On a tie the holder is listed first, ahead of the fresher challenger.
    const tied = reduceWorld(ledger(series("Asia", ["Alpha", "Beta"])), 4);
    expect(theatreOf(tied, "asia")?.tallies.map((tally) => tally.name)).toEqual(
      ["Alpha", "Beta"],
    );
  });

  test("old battles age out of the window, so a holder's lead can expire", () => {
    // Window 3: Alpha's two early wins age out while Beta keeps winning.
    const world = reduceWorld(
      ledger(series("EastAsia", ["Alpha", "Alpha", "Beta", "Beta", "Beta"])),
      3,
    );
    expect(theatreOf(world, "east_asia")).toMatchObject({
      holder: "Beta",
      holderWins: 3,
      challenger: null,
    });
    expect(theatreOf(world, "east_asia")?.window).toHaveLength(3);
  });

  test("battles without a winner age the window but never claim", () => {
    const world = reduceWorld(ledger(series("Asia", [null, null])), 4);
    expect(theatreOf(world, "asia")).toMatchObject({
      status: "unclaimed",
      battleCount: 2,
    });
    expect(world.events).toEqual([]);
  });

  test("the Crown is fought separately from every region, on both whole-world maps", () => {
    const world = reduceWorld(
      ledger([
        ...series("Pangaea", ["Alpha"], "2026-09-01T00:00:00.000Z"),
        ...series("World", ["Beta", "Beta"], "2026-09-01T01:00:00.000Z"),
        ...series("Mars", ["Gamma"], "2026-09-01T02:00:00.000Z"),
      ]),
      4,
    );
    expect(theatreOf(world, "crown")).toMatchObject({
      holder: "Beta",
      maps: [
        { map: "World", battles: 2 },
        { map: "Pangaea", battles: 1 },
      ],
    });
    expect(world.battleCount).toBe(3);
    expect(
      world.agents.find((agent) => agent.name === "Gamma"),
    ).toBeUndefined();
  });

  test("records one end-of-day snapshot per day, filling quiet days", () => {
    const world = reduceWorld(
      ledger([
        battle("Oceania", "Alpha", "2026-09-01T10:00:00.000Z"),
        battle("Oceania", "Beta", "2026-09-03T10:00:00.000Z"),
        battle("Oceania", "Beta", "2026-09-03T11:00:00.000Z"),
      ]),
      4,
    );
    expect(world.timeline.map((day) => [day.day, day.holders.oceania])).toEqual(
      [
        ["2026-09-01", "Alpha"],
        ["2026-09-02", "Alpha"],
        ["2026-09-03", "Beta"],
      ],
    );
  });

  test("is deterministic: the same ledger always yields the same world", () => {
    const store = ledger([
      ...series("Asia", ["Alpha", "Beta", "Beta", null, "Gamma"]),
      ...series("Pangaea", ["Gamma", "Alpha"], "2026-09-02T00:00:00.000Z"),
    ]);
    expect(reduceWorld(store)).toEqual(reduceWorld(store));
  });
});

describe("buildPublicWorldModel", () => {
  function agent(overrides: Partial<PublicAgent>): PublicAgent {
    return {
      registered: false,
      id: null,
      slug: null,
      playerName: "x",
      displayName: "x",
      shortCode: null,
      emblemSvg: null,
      primaryColor: null,
      secondaryColor: null,
      provisionalSlug: null,
      provisionalEmblemSvg: null,
      provisionalPrimaryColor: null,
      provisionalSecondaryColor: null,
      tagline: null,
      builderId: null,
      builderDisplayName: null,
      status: "unregistered",
      standing: null,
      activeVersion: null,
      provenance: { ratingPolicyLabel: null, activeChampionPolicyLabel: null },
      stats: null,
      timeSeries: { score: null, winrate: null },
      ...overrides,
    } as PublicAgent;
  }

  test("resolves registered, listed-provisional and long-gone agents, and links every battle", () => {
    const store = ledger([
      battle("Oceania", "Registered One", "2026-09-29T20:00:00.000Z"),
      battle("Oceania", "Listed Two", "2026-09-29T20:10:00.000Z"),
      battle("Asia", "Gone Three", "2026-09-29T21:00:00.000Z"),
      battle("Asia", "Gone Three", "2026-09-27T21:00:00.000Z"),
    ]);
    const model = buildPublicWorldModel({
      state: reduceWorld(store, 4),
      ledger: store,
      data: mirrorData(),
      readModelAgents: [
        agent({
          registered: true,
          playerName: "Registered One",
          displayName: "Registered",
          slug: "registered-one",
          primaryColor: "#112233",
          secondaryColor: "#445566",
          emblemSvg: "<svg/>",
          status: "verified",
        }),
        agent({
          playerName: "Listed Two",
          displayName: "Listed Two",
          provisionalSlug: "listed-two",
          provisionalPrimaryColor: "#778899",
          provisionalSecondaryColor: "#000000",
          provisionalEmblemSvg: "<svg/>",
        }),
      ],
    });
    const byName = new Map(model.agents.map((entry) => [entry.name, entry]));
    expect(byName.get("Registered One")).toMatchObject({
      label: "Registered",
      slug: "registered-one",
      color: "#112233",
    });
    expect(byName.get("Listed Two")).toMatchObject({
      label: "Listed Two",
      slug: "listed-two",
      color: "#778899",
    });
    expect(byName.get("Gone Three")).toMatchObject({
      slug: null,
      label: "Gone Three",
    });
    expect(byName.get("Gone Three")?.color).toMatch(/^#[0-9a-f]{6}$/i);

    const oceania = model.theatres.find((theatre) => theatre.id === "oceania");
    expect(oceania?.battlefields).toEqual([
      "oceania",
      "australia",
      "straitofmalacca",
    ]);
    expect(oceania?.window[0].href).toMatch(/^\/match\/ereq_test\d+$/);
    expect(
      model.events.every((event) => event.href.startsWith("/match/")),
    ).toBe(true);
    expect(model.battlesLast24h).toBe(3);
    expect(model.feed).toEqual({
      stale: false,
      lastGoodSyncAt: "2026-09-29T22:05:00.000Z",
      currentRoundNumber: 2353,
      roundIntervalMinutes: 40,
    });
  });
});
