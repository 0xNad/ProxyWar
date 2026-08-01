import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildLeagueEpisodeMatchPageModel,
  buildLeagueEpisodeParticipantCards,
  findLeagueEpisodeByRequestId,
  findLeagueEpisodeRunDir,
  leagueEpisodeRunKey,
  leagueEpisodeSpoilerSafeDescription,
  leagueEpisodeSpoilerSafeTitle,
  parseMatchStoryMarkdown,
  readCoworldLeagueEpisodesFromDataJson,
  readLeagueEpisodeRecap,
} from "../../../src/server/agents/LeagueEpisodeMatchPage";
import type { CoworldLeagueEpisodeRow } from "../../../src/server/agents/CoworldLeagueSiteWriter";
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

function episode(overrides: Partial<CoworldLeagueEpisodeRow> = {}): CoworldLeagueEpisodeRow {
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
      { slot: 0, name: "FixtureFrostfall", tilesOwned: 200_000, isAlive: true, isWinner: true, color: "#6fa8dc" },
      { slot: 1, name: "FixtureGhostRaider", tilesOwned: 20_000, isAlive: false, isWinner: false, color: "#e06666" },
    ],
    watchHref: "/ai-league-runs/league-coworld-test-episode-0001/spectator.html",
    fullRenderHref: "/ai-league-replay/league-coworld-test-episode-0001",
    ...overrides,
  };
}

const AGENT_MATCH_STORY_MARKDOWN = [
  "# Match Story league-coworld-test-episode-0001",
  "",
  "## Spectator Summary",
  "",
  "- Entertainment score: 82/100 (lively)",
  "- Decisions: 400",
  "- Post-spawn non-hold actions: 300/380 (79%)",
  "- Transport-wait holds: 2",
  "- Attack-safety holds: 1",
  "- Support-cooldown holds: 0",
  "- Unexplained holds: 0",
  "- Action diversity: 6 action categories",
  "- Accepted rate: 98%",
  "- Repetition: 1 repeated kind(s), 0 exact repeat(s)",
  "",
  "Frostfall opened with an aggressive naval push, forcing an early alliance collapse.",
  "",
  "## Highlights",
  "",
  "- Turn 812: Frostfall launches a surprise naval assault.",
  "- Turn 1930: Ghost Raider's alliance partner defects mid-battle.",
  "",
  "## Boringness Warnings",
  "",
  "- No major boringness warnings were detected.",
  "",
  "## Suggested Improvements",
  "",
  "- Keep running longer matches and inspect the rendered replay.",
  "",
].join("\n");

describe("parseMatchStoryMarkdown", () => {
  test("extracts the spectator-summary paragraph and highlight bullets from the real agentMatchStoryMarkdown format", () => {
    const recap = parseMatchStoryMarkdown(AGENT_MATCH_STORY_MARKDOWN);
    expect(recap).not.toBeNull();
    expect(recap?.summary).toBe(
      "Frostfall opened with an aggressive naval push, forcing an early alliance collapse.",
    );
    expect(recap?.beats).toEqual([
      "Turn 812: Frostfall launches a surprise naval assault.",
      "Turn 1930: Ghost Raider's alliance partner defects mid-battle.",
    ]);
  });

  test("filters out the 'no highlights generated' placeholder rather than surfacing it as a fabricated beat", () => {
    const markdown = AGENT_MATCH_STORY_MARKDOWN.replace(
      "- Turn 812: Frostfall launches a surprise naval assault.\n- Turn 1930: Ghost Raider's alliance partner defects mid-battle.\n",
      "- No spectator highlights were generated.\n",
    );
    const recap = parseMatchStoryMarkdown(markdown);
    expect(recap).not.toBeNull();
    expect(recap?.beats).toEqual([]);
    // The summary paragraph still carries real content, so the recap as a
    // whole is still worth showing (never entirely discarded just because
    // highlights were empty).
    expect(recap?.summary.length).toBeGreaterThan(0);
  });

  test("returns null for malformed markdown with none of the expected headings", () => {
    expect(parseMatchStoryMarkdown("# Just a title\n\nSome unrelated prose.\n")).toBeNull();
  });

  test("returns null when both the summary and every highlight are empty/placeholder", () => {
    const markdown = [
      "# Match Story x",
      "",
      "## Spectator Summary",
      "",
      "- Entertainment score: 10/100 (stalled)",
      "",
      "",
      "",
      "## Highlights",
      "",
      "- No spectator highlights were generated.",
      "",
      "## Boringness Warnings",
      "",
      "- none",
      "",
    ].join("\n");
    expect(parseMatchStoryMarkdown(markdown)).toBeNull();
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

  test("null when match-story.md does not exist on disk (the common hosted-mirror case)", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "league-episode-recap-"));
    expect(await readLeagueEpisodeRecap(scratch)).toBeNull();
  });

  test("parses a real match-story.md when present", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "league-episode-recap-"));
    await writeFile(path.join(scratch, "match-story.md"), AGENT_MATCH_STORY_MARKDOWN);
    const recap = await readLeagueEpisodeRecap(scratch);
    expect(recap).not.toBeNull();
    expect(recap?.beats.length).toBe(2);
  });

  test("null (never thrown) for an oversized match-story.md, exceeding the read ceiling", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "league-episode-recap-"));
    // One byte over the module's 2 MiB ceiling.
    await writeFile(
      path.join(scratch, "match-story.md"),
      "x".repeat(2 * 1024 * 1024 + 1),
    );
    await expect(readLeagueEpisodeRecap(scratch)).resolves.toBeNull();
  });
});

describe("leagueEpisodeRunKey / findLeagueEpisodeRunDir", () => {
  test("derives the managed run key from fullRenderHref first", () => {
    expect(leagueEpisodeRunKey(episode())).toBe("league-coworld-test-episode-0001");
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
      await readCoworldLeagueEpisodesFromDataJson("/tmp/does-not-exist-data.json"),
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
    expect(findLeagueEpisodeByRequestId(episodes!, row.episodeRequestId)).toEqual(row);
  });

  test("lookup for an unknown episodeRequestId returns null (the route's 404 case)", () => {
    expect(findLeagueEpisodeByRequestId([episode()], "ereq_totally-unknown")).toBeNull();
  });
});

describe("buildLeagueEpisodeMatchPageModel — placement ordering", () => {
  test("winner sorts first regardless of slot order", () => {
    const row = episode({
      players: [
        { slot: 0, name: "A", tilesOwned: 1000, isAlive: true, isWinner: false, color: "#111111" },
        { slot: 1, name: "B", tilesOwned: 500, isAlive: true, isWinner: true, color: "#222222" },
      ],
    });
    const model = buildLeagueEpisodeMatchPageModel(row, null);
    expect(model.players.map((p) => p.name)).toEqual(["B", "A"]);
    expect(model.players[0].placement).toBe(1);
    expect(model.players[1].placement).toBe(2);
  });

  test("ties break by tilesOwned descending among non-winners", () => {
    const row = episode({
      players: [
        { slot: 0, name: "Low", tilesOwned: 100, isAlive: true, isWinner: false, color: "#111111" },
        { slot: 1, name: "Winner", tilesOwned: 900, isAlive: true, isWinner: true, color: "#222222" },
        { slot: 2, name: "High", tilesOwned: 300, isAlive: false, isWinner: false, color: "#333333" },
      ],
    });
    const model = buildLeagueEpisodeMatchPageModel(row, null);
    expect(model.players.map((p) => p.name)).toEqual(["Winner", "High", "Low"]);
  });

  test("a final tilesOwned tie breaks by slot ascending", () => {
    const row = episode({
      players: [
        { slot: 2, name: "SlotTwo", tilesOwned: 500, isAlive: true, isWinner: false, color: "#111111" },
        { slot: 0, name: "SlotZero", tilesOwned: 500, isAlive: true, isWinner: false, color: "#222222" },
      ],
    });
    const model = buildLeagueEpisodeMatchPageModel(row, null);
    expect(model.players.map((p) => p.name)).toEqual(["SlotZero", "SlotTwo"]);
  });

  test("carries recap through unchanged and defaults optional fields honestly", () => {
    const row = episode({ premiereHref: undefined, directorCut: undefined });
    const model = buildLeagueEpisodeMatchPageModel(row, { summary: "x", beats: ["y"] });
    expect(model.recap).toEqual({ summary: "x", beats: ["y"] });
    expect(model.premiereHref).toBeNull();
    expect(model.directorCut).toBeNull();
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

  test("caps the roster at two names plus a '+N more' suffix for larger matches", () => {
    const row = episode({
      players: [
        { slot: 0, name: "A", tilesOwned: 1, isAlive: true, isWinner: false, color: "#111" },
        { slot: 1, name: "B", tilesOwned: 1, isAlive: true, isWinner: false, color: "#222" },
        { slot: 2, name: "C", tilesOwned: 1, isAlive: true, isWinner: false, color: "#333" },
        { slot: 3, name: "D", tilesOwned: 1, isAlive: true, isWinner: false, color: "#444" },
      ],
    });
    const title = leagueEpisodeSpoilerSafeTitle(row);
    expect(title).toContain("A vs B +2 more");
  });

  test("handles a null roundNumber without claiming a round it doesn't have", () => {
    const row = episode({ roundNumber: null });
    expect(leagueEpisodeSpoilerSafeTitle(row)).not.toContain("Round");
    expect(leagueEpisodeSpoilerSafeDescription(row)).toContain("an unnumbered round");
  });
});

describe("buildLeagueEpisodeParticipantCards", () => {
  test("a registered player name resolves full identity (emblem/slug/version/builder)", () => {
    const cards = buildLeagueEpisodeParticipantCards(episode(), identity);
    const frostfall = cards.find((card) => card.playerName === "FixtureFrostfall");
    expect(frostfall).toBeDefined();
    expect(frostfall?.agentSlug).not.toBeNull();
    expect(frostfall?.emblemSvg).not.toBeNull();
    expect(frostfall?.displayName).not.toBe("FixtureFrostfall");
  });

  test("an unmapped player name falls back to a provisional card, never a fabricated identity", () => {
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
      agentSlug: null,
      emblemSvg: null,
      primaryColor: null,
      secondaryColor: null,
      versionLabel: null,
      builderId: null,
      builderDisplayName: null,
    });
  });
});
