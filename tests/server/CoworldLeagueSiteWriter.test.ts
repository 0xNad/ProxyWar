import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  COWORLD_LEAGUE_POLL_INTERVAL_MS,
  coworldLeagueClientAssetPath,
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
    championFeedStale: false,
    replayFeedStale: false,
    lastGoodReplaySyncAt: "2026-07-13T12:00:00.000Z",
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
          {
            slot: 4,
            name: "Loki",
            tilesOwned: 8300,
            isAlive: false,
            isWinner: false,
            color: "#2563eb",
          },
          {
            slot: 5,
            name: "Athena",
            tilesOwned: 4200,
            isAlive: false,
            isWinner: false,
            color: "#9333ea",
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
    expect(html).toContain(
      '<span class="policy rating"><span class="policy-kind">Rating row</span> evil:v1</span>',
    );
    expect(html).not.toContain('class="badge champion"');
    expect(html.match(/Active champion/g)).toHaveLength(1);
  });

  test("binds score and rounds to rating provenance", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain("Rated rounds");
    expect(html).toContain(
      "Rank, score, and rated rounds come from Coworld&#39;s rating row; the active champion is shown separately when it differs.",
    );
    expect(html).toContain('aria-describedby="standings-provenance"');
  });

  test("preserves the compact policy row when champion and rating labels match", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain('<span class="policy">qd1n:v2</span>');
  });

  test("renders degraded chip only for degraded battles", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain("⚠ 33 degraded");
    expect(html).not.toContain("⚠ 0 degraded");
  });

  test("renders compact mobile rosters with an accessible disclosure", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain('data-roster-expanded="false"');
    expect(html).toContain('class="combatant-extra-group"');
    expect(html).toContain("data-roster-toggle");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/aria-controls="battle-roster-[a-f0-9]{12}"/);
    expect(html).toContain("Show full roster");
    expect(html).toContain("Show top three");
    expect(html).toContain(
      '.roster-disclosure-ready .battle[data-roster-expanded="false"] .combatant-extra-group { display:none; }',
    );

    const client = coworldLeagueClientJavaScript();
    expect(client).toContain("[data-roster-toggle]");
    expect(client).toContain(
      'document.documentElement.classList.add("roster-disclosure-ready")',
    );
    expect(client).toContain(
      'toggle.setAttribute("aria-expanded", String(expanded))',
    );
  });

  test("exposes winner and elimination states to screen readers", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain('<span class="win" aria-hidden="true">★</span>');
    expect(html).toContain('<span class="sr-only"> (Winner)</span>');
    expect(html).toContain('<span class="sr-only"> (Eliminated)</span>');
    expect(html).toContain('class="bar" aria-hidden="true"');
  });

  test("provides a main landmark, skip link, and scrollable standings", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain(
      '<a class="skip-link" href="#league-main">Skip to league content</a>',
    );
    expect(html).toContain(
      '<main id="league-main" class="shell" tabindex="-1">',
    );
    expect(html).toContain(
      'class="standings-scroll" role="region" aria-describedby="standings-provenance"',
    );
    expect(html).toContain(
      'aria-label="Scrollable league standings" tabindex="0"',
    );
    expect(html).toContain("min-width:600px");
  });

  test("renders the map name and never leaks a difficulty label", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain("Pangaea");
    expect(html).toContain("Britannia");
    expect(html.toLowerCase()).not.toContain("difficulty");
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

  test("qualifies a delayed replay feed without marking standings stale", () => {
    const html = coworldLeagueIndexHtml({
      ...sampleData(),
      replayFeedStale: true,
    });
    expect(html).toContain(
      "Replay feed delayed — standings and rounds are current; showing the last available battles.",
    );
    expect(html).not.toContain("Live sync degraded");
  });

  test("qualifies rating rows when current champion status is unavailable", () => {
    const data = sampleData();
    const html = coworldLeagueIndexHtml({
      ...data,
      championFeedStale: true,
      standings: data.standings.map((row) => ({
        ...row,
        activeChampionPolicyLabel: null,
        isHouse: false,
      })),
    });
    expect(html).toContain(
      "Champion status delayed — standings show rating rows only.",
    );
    expect(html).toContain(
      '<span class="policy rating"><span class="policy-kind">Rating row</span> proxywar-keystone:v7</span>',
    );
    expect(html).not.toContain("HOUSE");
  });

  test("shows live round chip and cadence", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain("ROUND 268 · LIVE");
    expect(html).toContain("every 30 minutes");
  });

  test("loads the same-origin update client and keeps a timed fallback", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain(
      'data-generated-at="2026-07-13T12:00:00.000Z" data-stale="false" data-league-id="league_test"',
    );
    expect(html).toContain(
      '<meta id="league-refresh-fallback" http-equiv="refresh" content="300">',
    );
    const clientAssetPath = coworldLeagueClientAssetPath();
    expect(clientAssetPath).toMatch(
      /^\/ai-league-runs\/league\/client\.js\?v=[a-f0-9]{16}$/,
    );
    expect(html).toContain(`<script src="${clientAssetPath}"></script>`);
    expect(html).not.toContain("async function checkForUpdates");
    expect(html).toContain(
      "Update check unavailable — showing this snapshot; retrying automatically.",
    );
    expect(html).toContain("Checks for updates every 30 seconds");

    const client = coworldLeagueClientJavaScript();
    expect(client).toContain('fetch("/ai-league-runs/league/data.json", {');
    expect(client).toContain('cache: "no-cache"');
    expect(client).toContain(
      '(currentLeagueId !== "" && nextLeague.id !== currentLeagueId)',
    );
    expect(client).toContain("!Array.isArray(next.standings)");
    expect(client).toContain("!Array.isArray(next.rounds)");
    expect(client).toContain("!Array.isArray(next.episodes)");
    expect(client.indexOf("fallbackRefresh?.remove()")).toBeGreaterThan(
      client.indexOf('currentLeagueId !== ""'),
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
    expect(roundTrip.episodes[0].map).toBe("Pangaea");
    // Map size is retained in the data model; difficulty is gone end-to-end.
    expect(roundTrip.episodes[0].mapSize).toBe("Compact");
    expect(roundTrip.episodes[0]).not.toHaveProperty("difficulty");
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

    await markCoworldLeagueSiteStale(siteDir, "2026-07-13T12:10:00.000Z");
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
    await expect(
      stat(`${path.resolve(siteDir)}.write-lock`),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
