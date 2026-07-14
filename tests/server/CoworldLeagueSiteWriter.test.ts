import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  coworldLeagueIndexHtml,
  writeCoworldLeagueSite,
  type CoworldLeagueMirrorData,
} from "../../src/server/agents/CoworldLeagueSiteWriter";

function sampleData(): CoworldLeagueMirrorData {
  return {
    generatedAt: "2026-07-13T12:00:00.000Z",
    lastGoodSyncAt: "2026-07-13T12:00:00.000Z",
    stale: false,
    league: {
      id: "league_test",
      name: "Proxywar",
      description: "Test league",
      divisionName: "Competition",
      roundIntervalMinutes: 30,
      episodesPerRound: 8,
      currentRoundNumber: 268,
      currentRoundStatus: "running",
      scoreLabel: "Score",
    },
    standings: [
      {
        rank: 1,
        playerName: "odin free",
        policyLabel: "qd1n:v2",
        score: 31.05,
        roundsPlayed: 27,
        isHouse: false,
      },
      {
        rank: 2,
        playerName: '<script>alert("x")</script>',
        policyLabel: "evil:v1",
        score: 24.13,
        roundsPlayed: 40,
        isHouse: false,
      },
      {
        rank: 3,
        playerName: "Auri",
        policyLabel: "proxywar-keystone:v14",
        score: 9.04,
        roundsPlayed: 2,
        isHouse: true,
      },
    ],
    rounds: [
      {
        roundNumber: 268,
        status: "running",
        startedAt: "2026-07-13T10:36:00Z",
        completedAt: null,
      },
    ],
    episodes: [
      {
        episodeRequestId: "ereq_aaaa",
        shortId: "aaaa",
        roundNumber: 267,
        completedAt: "2026-07-13T10:15:00Z",
        map: "Pangaea",
        mapSize: "Compact",
        difficulty: "Easy",
        turnCount: 6000,
        decisionCount: 236,
        degradedCount: 33,
        winnerName: "daveey",
        players: [
          {
            slot: 2,
            name: "daveey",
            tilesOwned: 89692,
            isAlive: true,
            isWinner: true,
            color: "#16a34a",
          },
          {
            slot: 3,
            name: "Auri",
            tilesOwned: 11385,
            isAlive: true,
            isWinner: false,
            color: "#d97706",
          },
        ],
        watchHref: "/ai-league-runs/coworld-run/spectator.html",
        fullRenderHref: "/ai-league-replay/coworld-run",
      },
      {
        episodeRequestId: "ereq_bbbb",
        shortId: "bbbb",
        roundNumber: null,
        completedAt: null,
        map: "Britannia",
        mapSize: "Compact",
        difficulty: "Easy",
        turnCount: null,
        decisionCount: null,
        degradedCount: 0,
        winnerName: null,
        players: [],
        watchHref: null,
        fullRenderHref: null,
      },
    ],
    links: {
      enterTheLeagueUrl: "https://github.com/0xNad/proxywar-coworld-starter",
      platformLabel: "Softmax Coworld",
    },
  };
}

describe("coworldLeagueIndexHtml", () => {
  test("escapes hostile player names", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders standings badges and house highlight", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain('class="house"');
    expect(html).toContain("HOUSE");
    expect(html).toContain("proxywar-keystone:v14");
  });

  test("renders degraded chip only for degraded battles", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain("⚠ 33 degraded");
    expect(html).not.toContain("⚠ 0 degraded");
  });

  test("marks commissioner timeout leaders without claiming an outright win", () => {
    const data = sampleData();
    const leader = data.episodes[0].players[0];
    leader.isWinner = false;
    leader.isCommissionerWinner = true;
    data.episodes[0].winnerName = null;
    data.episodes[0].commissionerWinnerNames = [leader.name];
    const html = coworldLeagueIndexHtml(data);
    expect(html).toContain('daveey <span class="win">★</span>');
  });

  test("links the full render as the single replay button", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain('href="/ai-league-replay/coworld-run"');
    expect(html).toContain("▶ Watch replay");
    expect(html).toContain("replay pending");
    // The spectator page is no longer linked from battle cards.
    expect(html).not.toContain("spectator.html");
  });

  test("shows the stale banner only when stale", () => {
    const fresh = coworldLeagueIndexHtml(sampleData());
    expect(fresh).not.toContain("Live sync degraded");
    const stale = coworldLeagueIndexHtml({ ...sampleData(), stale: true });
    expect(stale).toContain("Live sync degraded");
  });

  test("shows live round chip and cadence", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain("ROUND 268 · LIVE");
    expect(html).toContain("every 30 minutes");
  });
});

describe("writeCoworldLeagueSite", () => {
  let siteDir: string | null = null;

  afterEach(async () => {
    if (siteDir !== null) {
      await rm(siteDir, { recursive: true, force: true });
      siteDir = null;
    }
  });

  test("writes index.html and data.json", async () => {
    siteDir = await mkdtemp(path.join(tmpdir(), "league-site-"));
    const data = sampleData();
    const paths = await writeCoworldLeagueSite(siteDir, data);
    const html = await readFile(paths.indexPath, "utf8");
    expect(html).toContain("PROXY WAR");
    const roundTrip = JSON.parse(await readFile(paths.dataPath, "utf8"));
    expect(roundTrip.league.id).toBe("league_test");
    expect(roundTrip.standings).toHaveLength(3);
  });
});
