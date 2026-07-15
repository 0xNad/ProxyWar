import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  COWORLD_LEAGUE_CLIENT_PATH,
  COWORLD_LEAGUE_POLL_INTERVAL_MS,
  coworldLeagueClientJavaScript,
  coworldLeagueIndexHtml,
  markCoworldLeagueSiteStale,
  withCoworldLeagueSiteWriteLock,
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
        ratingPolicyLabel: "qd1n:v2",
        activeChampionPolicyLabel: "qd1n:v2",
        policyLabel: "qd1n:v2",
        score: 31.05,
        roundsPlayed: 27,
        isHouse: false,
      },
      {
        rank: 2,
        playerName: '<script>alert("x")</script>',
        ratingPolicyLabel: "evil:v1",
        activeChampionPolicyLabel: null,
        policyLabel: "evil:v1",
        score: 24.13,
        roundsPlayed: 40,
        isHouse: false,
      },
      {
        rank: 3,
        playerName: "Auri",
        ratingPolicyLabel: "proxywar-keystone:v7",
        activeChampionPolicyLabel: "proxywar-keystone:v40",
        policyLabel: "proxywar-keystone:v7",
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
    expect(html).toContain("proxywar-keystone:v40");
  });

  test("separates the active champion from its historical rating row", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain("Active champion");
    expect(html).toContain("proxywar-keystone:v40");
    expect(html).toContain("Rating row");
    expect(html).toContain("proxywar-keystone:v7");
    expect(html).toContain('class="badge champion">Champion</span>');
  });

  test("renders degraded chip only for degraded battles", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain("⚠ 33 degraded");
    expect(html).not.toContain("⚠ 0 degraded");
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

  test("loads the same-origin update client and keeps a timed fallback", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain(
      'data-generated-at="2026-07-13T12:00:00.000Z" data-stale="false"',
    );
    expect(html).toContain(
      '<meta id="league-refresh-fallback" http-equiv="refresh" content="300">',
    );
    expect(html).toContain(
      `<script src="${COWORLD_LEAGUE_CLIENT_PATH}"></script>`,
    );
    expect(html).not.toContain("async function checkForUpdates");
    expect(html).toContain(
      "Update check unavailable — showing this snapshot; retrying automatically.",
    );
    expect(html).toContain("Checks for updates every 30 seconds");

    const client = coworldLeagueClientJavaScript();
    expect(client).toContain('fetch("/ai-league-runs/league/data.json", {');
    expect(client).toContain('cache: "no-cache"');
    expect(client).toContain(
      "fallbackRefresh?.remove()",
    );
    expect(client).toContain(`${COWORLD_LEAGUE_POLL_INTERVAL_MS},`);
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

  test("marks both artifacts stale while retaining the last good sync", async () => {
    siteDir = await mkdtemp(path.join(tmpdir(), "league-site-"));
    const data = sampleData();
    await writeCoworldLeagueSite(siteDir, data);

    const paths = await markCoworldLeagueSiteStale(
      siteDir,
      "2026-07-13T12:05:00.000Z",
    );
    const staleHtml = await readFile(paths.indexPath, "utf8");
    const staleData = JSON.parse(await readFile(paths.dataPath, "utf8"));

    expect(staleHtml).toContain("Live sync degraded");
    expect(staleHtml).toContain('data-stale="true"');
    expect(staleData.generatedAt).toBe("2026-07-13T12:05:00.000Z");
    expect(staleData.lastGoodSyncAt).toBe(data.lastGoodSyncAt);
    expect(staleData.stale).toBe(true);

    const inodeBefore = (await stat(paths.dataPath)).ino;

    await markCoworldLeagueSiteStale(
      siteDir,
      "2026-07-13T12:10:00.000Z",
    );
    const stillStaleData = JSON.parse(await readFile(paths.dataPath, "utf8"));
    expect(stillStaleData.generatedAt).toBe("2026-07-13T12:05:00.000Z");
    expect((await stat(paths.dataPath)).ino).toBe(inodeBefore);

    expect((await readdir(siteDir)).sort()).toEqual([
      "client.js",
      "data.json",
      "index.html",
    ]);
  });

  test("serializes complete publications through a filesystem lock", async () => {
    siteDir = await mkdtemp(path.join(tmpdir(), "league-site-"));
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withCoworldLeagueSiteWriteLock(siteDir, async () => {
      order.push("first-entered");
      firstEntered?.();
      await held;
      order.push("first-released");
    });
    await entered;
    const second = withCoworldLeagueSiteWriteLock(siteDir, async () => {
      order.push("second-entered");
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(order).toEqual(["first-entered"]);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual([
      "first-entered",
      "first-released",
      "second-entered",
    ]);
    await expect(stat(`${path.resolve(siteDir)}.write-lock`)).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
});
