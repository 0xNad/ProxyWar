import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildLeaguePlayerSection,
  readLeagueMirrorData,
} from "../../../src/server/agents/LeaguePlayerProfile";

function sampleMirrorFile() {
  return {
    generatedAt: "2026-07-27T00:00:00.000Z",
    lastGoodSyncAt: "2026-07-27T00:00:00.000Z",
    stale: false,
    standings: [
      {
        rank: 3,
        playerName: "daveey-proxywar",
        ratingPolicyLabel: "daveey-proxywar:v23",
        activeChampionPolicyLabel: "daveey-proxywar:v24",
        policyLabel: "daveey-proxywar:v23",
        score: 24.5,
        roundsPlayed: 40,
        isHouse: false,
      },
      {
        rank: 1,
        playerName: "house-warlord",
        ratingPolicyLabel: "house:v1",
        activeChampionPolicyLabel: "house:v1",
        policyLabel: "house:v1",
        score: 40.1,
        roundsPlayed: 40,
        isHouse: true,
      },
    ],
    episodes: [
      {
        roundNumber: 268,
        completedAt: "2026-07-27T02:00:00.000Z",
        map: "Pangaea",
        turnCount: 900,
        winnerName: "daveey-proxywar",
        watchHref: "/ai-league-runs/league-x/watch.html",
        fullRenderHref: "/ai-league-replay/league-x",
        players: [
          { name: "daveey-proxywar", tilesOwned: 5000, isAlive: true, isWinner: true },
          { name: "house-warlord", tilesOwned: 100, isAlive: false, isWinner: false },
        ],
      },
      {
        roundNumber: 267,
        completedAt: "2026-07-26T02:00:00.000Z",
        map: "Britannia",
        turnCount: 700,
        winnerName: "house-warlord",
        watchHref: null,
        fullRenderHref: "/ai-league-replay/league-y",
        players: [
          { name: "daveey-proxywar", tilesOwned: 800, isAlive: false, isWinner: false },
          { name: "house-warlord", tilesOwned: 6000, isAlive: true, isWinner: true },
        ],
      },
    ],
  };
}

describe("readLeagueMirrorData", () => {
  let dir = "";

  afterEach(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  test("parses a well-formed mirror file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "league-player-profile-"));
    const filePath = path.join(dir, "data.json");
    await writeFile(filePath, JSON.stringify(sampleMirrorFile()), "utf8");
    const parsed = await readLeagueMirrorData(filePath);
    expect(parsed).not.toBeNull();
    expect(parsed?.standings).toHaveLength(2);
    expect(parsed?.episodes).toHaveLength(2);
  });

  test("degrades to null for a missing file instead of throwing", async () => {
    const parsed = await readLeagueMirrorData(
      "/nonexistent/path/data.json",
    );
    expect(parsed).toBeNull();
  });

  test("degrades to null for malformed JSON instead of throwing", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "league-player-profile-"));
    const filePath = path.join(dir, "data.json");
    await writeFile(filePath, "{not json", "utf8");
    const parsed = await readLeagueMirrorData(filePath);
    expect(parsed).toBeNull();
  });

  test("drops individually malformed rows rather than discarding the whole file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "league-player-profile-"));
    const filePath = path.join(dir, "data.json");
    const file = sampleMirrorFile();
    // @ts-expect-error deliberately malformed for the test
    file.standings.push({ rank: "not a number" });
    await writeFile(filePath, JSON.stringify(file), "utf8");
    const parsed = await readLeagueMirrorData(filePath);
    expect(parsed?.standings).toHaveLength(2);
  });
});

describe("buildLeaguePlayerSection", () => {
  test("returns rank/rating now plus the retained episode window, newest first", async () => {
    const data = await readLeagueMirrorDataFromObject(sampleMirrorFile());
    const section = buildLeaguePlayerSection(data, "daveey-proxywar");
    expect(section).not.toBeNull();
    expect(section?.standing?.rank).toBe(3);
    expect(section?.episodes.map((e) => e.roundNumber)).toEqual([268, 267]);
    expect(section?.recentRecord).toEqual({ wins: 1, played: 2 });
  });

  test("carries the SAME career/currentVersion stats object /agent/:slug uses, when the stats artifact has a row for this player", async () => {
    const data = await readLeagueMirrorDataFromObject(sampleMirrorFile());
    const emptySlice = {
      episodeCount: 5,
      fingerprint: {
        aggression: { value: 0.4, sampleSize: 60, threshold: 50, methodology: "m" },
        diplomacyInitiated: null,
        economicFocus: null,
        territory: { share: null, absoluteTiles: null, meanRank: null },
        armyStrength: null,
        reliability: null,
      },
      social: {
        alliancesInitiated: null,
        allianceAcceptanceRate: null,
        betrayalCount: null,
        frequentAllies: [],
        primaryAdversaries: [],
        treatyDuration: null,
      },
    };
    const statsArtifact = {
      schemaVersion: 1 as const,
      generatedAt: "2026-07-31T00:00:00.000Z",
      episodesScanned: 5,
      players: [
        {
          playerName: "daveey-proxywar",
          career: emptySlice,
          currentVersion: null,
        },
      ],
    };
    const section = buildLeaguePlayerSection(
      data,
      "daveey-proxywar",
      statsArtifact,
    );
    expect(section?.stats?.career.fingerprint.aggression?.value).toBe(0.4);
    expect(section?.stats?.currentVersion).toBeNull();
  });

  test("returns stats: null when no stats artifact is passed, or no row matches this player", async () => {
    const data = await readLeagueMirrorDataFromObject(sampleMirrorFile());
    expect(
      buildLeaguePlayerSection(data, "daveey-proxywar")?.stats,
    ).toBeNull();
    expect(
      buildLeaguePlayerSection(data, "daveey-proxywar", {
        schemaVersion: 1,
        generatedAt: "2026-07-31T00:00:00.000Z",
        episodesScanned: 0,
        players: [],
      })?.stats,
    ).toBeNull();
  });

  test("names the policy-lineage moment when the champion has shipped past the rating", async () => {
    const data = await readLeagueMirrorDataFromObject(sampleMirrorFile());
    const section = buildLeaguePlayerSection(data, "daveey-proxywar");
    expect(section?.policyLineageNote).toContain("daveey-proxywar:v24");
    expect(section?.policyLineageNote).toContain("daveey-proxywar:v23");
  });

  test("omits the lineage note when the rating and active champion already match", async () => {
    const data = await readLeagueMirrorDataFromObject(sampleMirrorFile());
    const section = buildLeaguePlayerSection(data, "house-warlord");
    expect(section?.policyLineageNote).toBeNull();
  });

  test("returns null for a name absent from both standings and every episode roster", async () => {
    const data = await readLeagueMirrorDataFromObject(sampleMirrorFile());
    const section = buildLeaguePlayerSection(data, "nobody-plays-this-name");
    expect(section).toBeNull();
  });

  test("still returns episode history for a name with no current standings row", async () => {
    const file = sampleMirrorFile();
    file.standings = file.standings.filter(
      (row) => row.playerName !== "daveey-proxywar",
    );
    const data = await readLeagueMirrorDataFromObject(file);
    const section = buildLeaguePlayerSection(data, "daveey-proxywar");
    expect(section).not.toBeNull();
    expect(section?.standing).toBeNull();
    expect(section?.episodes).toHaveLength(2);
  });

  test("propagates staleness through to the player section", async () => {
    const file = sampleMirrorFile();
    file.stale = true;
    const data = await readLeagueMirrorDataFromObject(file);
    const section = buildLeaguePlayerSection(data, "house-warlord");
    expect(section?.stale).toBe(true);
  });

  test("timeSeries defaults to both series null when no standings-history store is passed", async () => {
    const data = await readLeagueMirrorDataFromObject(sampleMirrorFile());
    const section = buildLeaguePlayerSection(data, "daveey-proxywar");
    expect(section?.timeSeries).toEqual({ winrate: null, score: null });
  });

  test("timeSeries.score is populated per-player from the standings-history store passed in, matching /agent/:slug's own computation", async () => {
    const data = await readLeagueMirrorDataFromObject(sampleMirrorFile());
    const section = buildLeaguePlayerSection(data, "daveey-proxywar", null, {
      schemaVersion: 1,
      snapshots: [
        {
          recordedAt: "2026-07-26T00:00:00.000Z",
          roundNumber: 267,
          agents: [
            { playerName: "daveey-proxywar", score: 20, rank: 4, activeVersionLabel: "daveey-proxywar:v23" },
          ],
        },
        {
          recordedAt: "2026-07-27T00:00:00.000Z",
          roundNumber: 268,
          agents: [
            { playerName: "daveey-proxywar", score: 24.5, rank: 3, activeVersionLabel: "daveey-proxywar:v24" },
          ],
        },
      ],
    });
    expect(section?.timeSeries.score?.points).toHaveLength(2);
    expect(section?.timeSeries.score?.points[1]).toMatchObject({
      score: 24.5,
      rank: 3,
      versionFirstObserved: true,
    });
  });
});

/** Round-trips a plain object through the real disk reader, so tests exercise the actual parser instead of hand-building the internal shape. */
async function readLeagueMirrorDataFromObject(file: unknown) {
  const dir = await mkdtemp(path.join(tmpdir(), "league-player-profile-obj-"));
  const filePath = path.join(dir, "data.json");
  await writeFile(filePath, JSON.stringify(file), "utf8");
  try {
    const data = await readLeagueMirrorData(filePath);
    if (data === null) throw new Error("expected parseable fixture");
    return data;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
