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
  frontierFourBattle,
  frontierFourEpisodeRow,
  frontierFourWinnerLabel,
  parseFrontierFourGameRecord,
  publishFrontierFourWorld,
  restoreLeagueWorldSource,
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
