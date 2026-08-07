import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AGENT_MATCH_RECAP_SCHEMA_VERSION } from "../../../src/server/agents/AgentMatchRecap";
import type { CoworldLeagueEpisodeRow } from "../../../src/server/agents/CoworldLeagueSiteWriter";
import {
  buildLeagueEpisodeMatchPageModel,
  buildLeagueEpisodeParticipantCards,
  findLeagueEpisodeByRequestId,
  findLeagueEpisodeRunDir,
  leagueEpisodeRunKey,
  leagueEpisodeSpoilerSafeDescription,
  leagueEpisodeSpoilerSafeTitle,
  parseMatchRecapArtifact,
  readCoworldLeagueEpisodesFromDataJson,
  readLeagueEpisodeRecap,
} from "../../../src/server/agents/LeagueEpisodeMatchPage";
import {
  FIXTURE_AGENTS,
  FIXTURE_BUILDERS,
  FIXTURE_VERSIONS,
} from "../../../src/server/fixtures/PublicProductFixtureData";
import type { IdentityRegistrySnapshot } from "../../../src/server/identity/IdentityRegistry";

const identity: IdentityRegistrySnapshot = {
  agents: FIXTURE_AGENTS,
  builders: FIXTURE_BUILDERS,
  versions: FIXTURE_VERSIONS,
};

function episode(
  overrides: Partial<CoworldLeagueEpisodeRow> = {},
): CoworldLeagueEpisodeRow {
  return {
    episodeRequestId: "ereq_test-episode-0001",
    shortId: "testepisode1",
    roundNumber: 42,
    completedAt: "2026-08-01T12:00:00.000Z",
    map: "Pangaea",
    mapSize: "Compact",
    turnCount: 4000,
    decisionCount: 400,
    degradedCount: 10,
    winnerName: "FixtureFrostfall",
    players: [
      {
        slot: 0,
        name: "FixtureFrostfall",
        tilesOwned: 200_000,
        isAlive: true,
        isWinner: true,
        color: "#6fa8dc",
      },
      {
        slot: 1,
        name: "FixtureGhostRaider",
        tilesOwned: 20_000,
        isAlive: false,
        isWinner: false,
        color: "#e06666",
      },
    ],
    watchHref:
      "/ai-league-runs/league-coworld-test-episode-0001/spectator.html",
    fullRenderHref: "/ai-league-replay/league-coworld-test-episode-0001",
    ...overrides,
  };
}

const AGENT_MATCH_RECAP_JSON = JSON.stringify({
  schemaVersion: AGENT_MATCH_RECAP_SCHEMA_VERSION,
  runID: "league-coworld-test-episode-0001",
  generatedAt: "2026-08-01T12:00:00.000Z",
  summary: "This match featured 1 first strike and 1 betrayal.",
  beats: [
    {
      turnNumber: 812,
      kind: "first_strike",
      message: "Frostfall strikes first against Ghost Raider.",
    },
    {
      turnNumber: 1930,
      kind: "betrayal",
      message: "Ghost Raider breaks alliance with Frostfall.",
    },
  ],
});

describe("parseMatchRecapArtifact", () => {
  test("extracts the summary and formats each beat as 'Turn N: message' from the real AgentMatchRecap shape", () => {
    const recap = parseMatchRecapArtifact(AGENT_MATCH_RECAP_JSON);
    expect(recap).not.toBeNull();
    expect(recap?.summary).toBe(
      "This match featured 1 first strike and 1 betrayal.",
    );
    expect(recap?.beats).toEqual([
      "Turn 812: Frostfall strikes first against Ghost Raider.",
      "Turn 1930: Ghost Raider breaks alliance with Frostfall.",
    ]);
  });

  test("returns null for malformed JSON", () => {
    expect(parseMatchRecapArtifact("not valid json at all")).toBeNull();
  });

  test("returns null for the wrong schemaVersion", () => {
    const wrongVersion = JSON.stringify({
      schemaVersion: AGENT_MATCH_RECAP_SCHEMA_VERSION + 1,
      summary: "x",
      beats: [
        { turnNumber: 1, kind: "elimination", message: "x is eliminated." },
      ],
    });
    expect(parseMatchRecapArtifact(wrongVersion)).toBeNull();
  });

  test("returns null when both the summary and every beat are absent — never a fabricated placeholder", () => {
    const empty = JSON.stringify({
      schemaVersion: AGENT_MATCH_RECAP_SCHEMA_VERSION,
      summary: "",
      beats: [],
    });
    expect(parseMatchRecapArtifact(empty)).toBeNull();
  });

  test("drops individual malformed beat entries rather than casting garbage through", () => {
    const partiallyMalformed = JSON.stringify({
      schemaVersion: AGENT_MATCH_RECAP_SCHEMA_VERSION,
      summary: "",
      beats: [
        {
          turnNumber: 5,
          kind: "elimination",
          message: "Frostfall is eliminated.",
        },
        {
          turnNumber: "not a number",
          kind: "elimination",
          message: "bad turn",
        },
        { turnNumber: 6, kind: "elimination", message: "" },
        { turnNumber: 7 },
      ],
    });
    const recap = parseMatchRecapArtifact(partiallyMalformed);
    expect(recap?.beats).toEqual(["Turn 5: Frostfall is eliminated."]);
  });
});

describe("readLeagueEpisodeRecap", () => {
  let scratch: string;

  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  test("null when runDir itself is null (no derivable managed run key)", async () => {
    expect(await readLeagueEpisodeRecap(null)).toBeNull();
  });

  test("null when match-recap.json does not exist on disk (a genuinely quiet match, or not yet backfilled)", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "league-episode-recap-"));
    expect(await readLeagueEpisodeRecap(scratch)).toBeNull();
  });

  test("parses a real match-recap.json when present", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "league-episode-recap-"));
    await writeFile(
      path.join(scratch, "match-recap.json"),
      AGENT_MATCH_RECAP_JSON,
    );
    const recap = await readLeagueEpisodeRecap(scratch);
    expect(recap).not.toBeNull();
    expect(recap?.beats.length).toBe(2);
  });

  test("never reads match-story.md as a recap source, even when present", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "league-episode-recap-"));
    await writeFile(
      path.join(scratch, "match-story.md"),
      "## Spectator Summary\n\nEntertainment diagnostics only.\n",
    );
    expect(await readLeagueEpisodeRecap(scratch)).toBeNull();
  });

  test("null (never thrown) for an oversized match-recap.json, exceeding the read ceiling", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "league-episode-recap-"));
    // One byte over the module's 2 MiB ceiling.
    await writeFile(
      path.join(scratch, "match-recap.json"),
      "x".repeat(2 * 1024 * 1024 + 1),
    );
    await expect(readLeagueEpisodeRecap(scratch)).resolves.toBeNull();
  });
});

describe("leagueEpisodeRunKey / findLeagueEpisodeRunDir", () => {
  test("derives the managed run key from fullRenderHref first", () => {
    expect(leagueEpisodeRunKey(episode())).toBe(
      "league-coworld-test-episode-0001",
    );
  });

  test("falls back to watchHref when fullRenderHref is absent", () => {
    const row = episode({ fullRenderHref: null });
    expect(leagueEpisodeRunKey(row)).toBe("league-coworld-test-episode-0001");
  });

  test("null when neither href is a well-formed managed run link", () => {
    const row = episode({ watchHref: null, fullRenderHref: null });
    expect(leagueEpisodeRunKey(row)).toBeNull();
    expect(findLeagueEpisodeRunDir(row, "/tmp/runs")).toBeNull();
  });

  test("null when the href doesn't match the managed league-coworld- run-key shape (e.g. a fixture id)", () => {
    const row = episode({
      watchHref: "/ai-league-runs/league-fixture-ordinary-0001/spectator.html",
      fullRenderHref: null,
    });
    expect(leagueEpisodeRunKey(row)).toBeNull();
  });

  test("joins the derived run key onto runsRootDir", () => {
    expect(findLeagueEpisodeRunDir(episode(), "/tmp/runs")).toBe(
      path.join("/tmp/runs", "league-coworld-test-episode-0001"),
    );
  });
});

describe("readCoworldLeagueEpisodesFromDataJson / findLeagueEpisodeByRequestId", () => {
  let scratch: string;

  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  test("null for a missing file", async () => {
    expect(
      await readCoworldLeagueEpisodesFromDataJson(
        "/tmp/does-not-exist-data.json",
      ),
    ).toBeNull();
  });

  test("null for malformed JSON", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "league-episode-data-"));
    const file = path.join(scratch, "data.json");
    await writeFile(file, "{ not valid json");
    expect(await readCoworldLeagueEpisodesFromDataJson(file)).toBeNull();
  });

  test("null when the JSON has no episodes array", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "league-episode-data-"));
    const file = path.join(scratch, "data.json");
    await writeFile(file, JSON.stringify({ standings: [] }));
    expect(await readCoworldLeagueEpisodesFromDataJson(file)).toBeNull();
  });

  test("returns the episodes array for a well-formed file, and lookup finds the matching row", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "league-episode-data-"));
    const file = path.join(scratch, "data.json");
    const row = episode();
    await writeFile(file, JSON.stringify({ episodes: [row] }));
    const episodes = await readCoworldLeagueEpisodesFromDataJson(file);
    expect(episodes).not.toBeNull();
    expect(
      findLeagueEpisodeByRequestId(episodes!, row.episodeRequestId),
    ).toEqual(row);
  });

  test("lookup for an unknown episodeRequestId returns null (the route's 404 case)", () => {
    expect(
      findLeagueEpisodeByRequestId([episode()], "ereq_totally-unknown"),
    ).toBeNull();
  });
});

describe("buildLeagueEpisodeMatchPageModel — placement ordering", () => {
  test("winner sorts first regardless of slot order", () => {
    const row = episode({
      players: [
        {
          slot: 0,
          name: "A",
          tilesOwned: 1000,
          isAlive: true,
          isWinner: false,
          color: "#111111",
        },
        {
          slot: 1,
          name: "B",
          tilesOwned: 500,
          isAlive: true,
          isWinner: true,
          color: "#222222",
        },
      ],
    });
    const model = buildLeagueEpisodeMatchPageModel(row, null, null);
    expect(model.players.map((p) => p.name)).toEqual(["B", "A"]);
    expect(model.players[0].placement).toBe(1);
    expect(model.players[1].placement).toBe(2);
  });

  test("ties break by tilesOwned descending among non-winners", () => {
    const row = episode({
      players: [
        {
          slot: 0,
          name: "Low",
          tilesOwned: 100,
          isAlive: true,
          isWinner: false,
          color: "#111111",
        },
        {
          slot: 1,
          name: "Winner",
          tilesOwned: 900,
          isAlive: true,
          isWinner: true,
          color: "#222222",
        },
        {
          slot: 2,
          name: "High",
          tilesOwned: 300,
          isAlive: false,
          isWinner: false,
          color: "#333333",
        },
      ],
    });
    const model = buildLeagueEpisodeMatchPageModel(row, null, null);
    expect(model.players.map((p) => p.name)).toEqual(["Winner", "High", "Low"]);
  });

  test("a final tilesOwned tie breaks by slot ascending", () => {
    const row = episode({
      players: [
        {
          slot: 2,
          name: "SlotTwo",
          tilesOwned: 500,
          isAlive: true,
          isWinner: false,
          color: "#111111",
        },
        {
          slot: 0,
          name: "SlotZero",
          tilesOwned: 500,
          isAlive: true,
          isWinner: false,
          color: "#222222",
        },
      ],
    });
    const model = buildLeagueEpisodeMatchPageModel(row, null, null);
    expect(model.players.map((p) => p.name)).toEqual(["SlotZero", "SlotTwo"]);
  });

  test("carries recap through unchanged and defaults optional fields honestly", () => {
    const row = episode({ premiereHref: undefined });
    const model = buildLeagueEpisodeMatchPageModel(
      row,
      { summary: "x", beats: ["y"] },
      null,
    );
    expect(model.recap).toEqual({ summary: "x", beats: ["y"] });
    expect(model.premiereHref).toBeNull();
    expect(model.episodeRequestId).toBe(row.episodeRequestId);
    expect(model.runKey).toBe("league-coworld-test-episode-0001");
  });
});

describe("leagueEpisodeSpoilerSafeTitle / leagueEpisodeSpoilerSafeDescription", () => {
  test("never contains the winner's name even when winnerName is set", () => {
    const row = episode({ winnerName: "FixtureFrostfall" });
    const title = leagueEpisodeSpoilerSafeTitle(row);
    const description = leagueEpisodeSpoilerSafeDescription(row);
    expect(title).not.toContain("wins");
    expect(title).not.toContain("Winner");
    expect(description).not.toContain("winner");
    // Participants and map/round context ARE expected — this isn't a blank
    // card, just a spoiler-neutral one.
    expect(title).toContain("FixtureFrostfall");
    expect(title).toContain("FixtureGhostRaider");
    expect(title).toContain("Pangaea");
    expect(title).toContain("Round 42");
    expect(title).toContain("| Proxy War");
  });

  test("orders the roster by SLOT, never by final placement — a link preview must not leak the winner (live P0, 2026-08-02)", () => {
    // The winner ("PeePee7") sits in slot 1, NOT slot 0. Before this fix,
    // the title/description used `row.players`' own order, which upstream
    // sources can (and did, live) deliver in final-placement order — so
    // "Captain Underpants vs PeePee7 +10 more" told a viewer who won
    // before they ever opened the page. Slot order carries no outcome
    // signal, so this must always read "Captain Underpants vs PeePee7",
    // never "PeePee7 vs Captain Underpants" or any placement-derived order.
    const row = episode({
      winnerName: "PeePee7",
      players: [
        {
          slot: 0,
          name: "Captain Underpants",
          tilesOwned: 1,
          isAlive: false,
          isWinner: false,
          color: "#111",
        },
        {
          slot: 1,
          name: "PeePee7",
          tilesOwned: 999_999,
          isAlive: true,
          isWinner: true,
          color: "#222",
        },
      ],
    });
    const title = leagueEpisodeSpoilerSafeTitle(row);
    const description = leagueEpisodeSpoilerSafeDescription(row);
    expect(title).toContain("Captain Underpants vs PeePee7");
    expect(title).not.toContain("PeePee7 vs Captain Underpants");
    expect(description).toContain("Captain Underpants, PeePee7");
    expect(description).not.toContain("PeePee7, Captain Underpants");
  });

  test("caps the roster at two names plus a '+N more' suffix for larger matches", () => {
    const row = episode({
      players: [
        {
          slot: 0,
          name: "A",
          tilesOwned: 1,
          isAlive: true,
          isWinner: false,
          color: "#111",
        },
        {
          slot: 1,
          name: "B",
          tilesOwned: 1,
          isAlive: true,
          isWinner: false,
          color: "#222",
        },
        {
          slot: 2,
          name: "C",
          tilesOwned: 1,
          isAlive: true,
          isWinner: false,
          color: "#333",
        },
        {
          slot: 3,
          name: "D",
          tilesOwned: 1,
          isAlive: true,
          isWinner: false,
          color: "#444",
        },
      ],
    });
    const title = leagueEpisodeSpoilerSafeTitle(row);
    expect(title).toContain("A vs B +2 more");
  });

  test("handles a null roundNumber without claiming a round it doesn't have", () => {
    const row = episode({ roundNumber: null });
    expect(leagueEpisodeSpoilerSafeTitle(row)).not.toContain("Round");
    expect(leagueEpisodeSpoilerSafeDescription(row)).toContain(
      "an unnumbered round",
    );
  });
});

describe("buildLeagueEpisodeParticipantCards", () => {
  test("a registered player name resolves full identity (emblem/slug/version/builder)", () => {
    const cards = buildLeagueEpisodeParticipantCards(episode(), identity);
    const frostfall = cards.find(
      (card) => card.playerName === "FixtureFrostfall",
    );
    expect(frostfall).toBeDefined();
    expect(frostfall?.agentSlug).not.toBeNull();
    expect(frostfall?.emblemSvg).not.toBeNull();
    expect(frostfall?.displayName).not.toBe("FixtureFrostfall");
  });

  test("an unmapped player name falls back to a provisional card (generated emblem/slug/colors), never a fabricated builder/version", () => {
    const row = episode({
      players: [
        {
          slot: 0,
          name: "TotallyUnregisteredPlayer",
          tilesOwned: 1,
          isAlive: true,
          isWinner: true,
          color: "#111111",
        },
      ],
    });
    const cards = buildLeagueEpisodeParticipantCards(row, identity);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual({
      playerName: "TotallyUnregisteredPlayer",
      displayName: "TotallyUnregisteredPlayer",
      agentSlug: "totallyunregisteredplayer",
      emblemSvg: expect.stringContaining("<svg"),
      primaryColor: expect.stringMatching(/^#[0-9a-f]{6}$/),
      secondaryColor: expect.stringMatching(/^#[0-9a-f]{6}$/),
      versionLabel: null,
      builderId: null,
      builderDisplayName: null,
    });
  });
});
