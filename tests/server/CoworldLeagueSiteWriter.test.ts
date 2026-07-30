import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_PLATFORM_ORIGIN } from "../../src/core/PlatformOrigin";
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

  test("links each standings row to the shared platform player profile", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    // Asserted against the shared constant, not a literal: this process does
    // not set PROXYWAR_PLATFORM_ORIGIN, so this IS the fallback path, and a
    // literal here is what let the origin move without the league site
    // noticing (see `core/PlatformOrigin.ts`).
    expect(html).toContain(
      `<a class="player-profile-link" href="${DEFAULT_PLATFORM_ORIGIN}/player/odin%20free">odin free</a>`,
    );
  });

  test("offers one link off the mirror to the account authority", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    // The league page is a read-only mirror with no session of its own — it
    // cannot show WHO you are, so the honest affordance is a link to the one
    // origin that can. Absolute and cross-origin on purpose: this same HTML is
    // served from beta.proxywar.xyz, where a relative /account is a 404.
    expect(html).toContain(
      `<a class="chip account-link" href="${DEFAULT_PLATFORM_ORIGIN}/account">`,
    );
    expect(html).toContain("Your account");
  });

  test("separates the active champion from its historical rating row", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain("Active champion");
    expect(html).toContain("proxywar-keystone:v40");
    expect(html).toContain("Rating row");
    expect(html).toContain("proxywar-keystone:v7");
    expect(html).toContain(">Rating row</span> evil:v1</span>");
    expect(html).not.toContain('class="badge champion"');
    expect(html.match(/>Active champion</g)).toHaveLength(1);
  });

  test("binds score and rounds to rating provenance", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain("Rated rounds");
    // The note now says what the numbers MEAN, not just where they come from:
    // "SCORE 25.65 — out of what?" was the single most common newcomer question.
    expect(html).toContain("Score is a rolling rating from recent finishing");
    expect(html).toContain("it is not a percentage");
    expect(html).toContain("a low number means a provisional score");
    expect(html).toContain("Coworld&#39;s rating row");
    expect(html).toContain('aria-describedby="standings-provenance"');
  });

  test("preserves the compact policy row when champion and rating labels match", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).toContain('<span class="policy">qd1n:v2</span>');
  });

  test("names the recovered-turn chip and only warns above the threshold", () => {
    // Every card used to read "⚠ N degraded", which simulated newcomers read as
    // "this site is broken". Same number, named the way the replay panel names
    // it, with a denominator, and the warning colour reserved for elevated runs.
    const html = coworldLeagueIndexHtml(sampleData());
    // 33 of 236 decisions = 14%, below the 15% warning threshold.
    expect(html).toContain("33 recovered turns (14%)");
    expect(html).not.toContain("degraded<");
    expect(html).not.toContain("⚠ 33");
    expect(html).not.toContain('class="degraded elevated"');

    const elevated = sampleData();
    elevated.episodes[0].degradedCount = 120;
    elevated.episodes[0].decisionCount = 236;
    const elevatedHtml = coworldLeagueIndexHtml(elevated);
    expect(elevatedHtml).toContain("⚠ 120 recovered turns (51%)");
    expect(elevatedHtml).toContain('class="degraded elevated"');
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

  test("a revealed premiere adds a Watch-the-premiere link beside the replay link", () => {
    const data = sampleData();
    data.episodes[0].premiereHref = "/premiere/prem_54d299b874f0adc7654fd1cc";
    const html = coworldLeagueIndexHtml(data);
    expect(html).toContain(
      '<a href="/premiere/prem_54d299b874f0adc7654fd1cc">▶ Watch the premiere</a>',
    );
    // Both links render on the same card, premiere first, dot-separated.
    expect(html).toContain(
      '▶ Watch the premiere</a><span class="link-sep"> · </span><a href="/ai-league-replay/coworld-run">▶ Watch replay</a>',
    );
    // The second (linkless) card still reads "replay pending".
    expect(html).toContain("replay pending");
  });

  test("without a premiereHref no premiere link or separator is emitted", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).not.toContain("Watch the premiere");
    expect(html).not.toContain('class="link-sep"');
  });

  test("a premiere link renders even when the replay bundle is still pending", () => {
    const data = sampleData();
    data.episodes[1].premiereHref = "/premiere/prem_0579c9b1e839847e2a50f216";
    const html = coworldLeagueIndexHtml(data);
    expect(html).toContain(
      '<a href="/premiere/prem_0579c9b1e839847e2a50f216">▶ Watch the premiere</a>',
    );
    // The premiere link replaces "replay pending" on that card (the first
    // card keeps its replay link and the page has no pending placeholder).
    expect(html).not.toContain("replay pending");
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
    expect(html).toContain(">Rating row</span> proxywar-keystone:v7</span>");
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

  test("premiereHref round-trips through data.json additively (absent rows stay unchanged)", async () => {
    siteDir = await mkdtemp(path.join(tmpdir(), "league-site-"));
    const data = sampleData();
    data.episodes[0].premiereHref = "/premiere/prem_54d299b874f0adc7654fd1cc";
    const paths = await writeCoworldLeagueSite(siteDir, data);
    const roundTrip = JSON.parse(await readFile(paths.dataPath, "utf8"));
    expect(roundTrip.episodes[0].premiereHref).toBe(
      "/premiere/prem_54d299b874f0adc7654fd1cc",
    );
    // Additive-only: the field is entirely absent on rows without a revealed
    // premiere (never null), and the old polling-client contract fields the
    // deployed client validates are untouched.
    expect(roundTrip.episodes[1]).not.toHaveProperty("premiereHref");
    expect(Array.isArray(roundTrip.standings)).toBe(true);
    expect(Array.isArray(roundTrip.rounds)).toBe(true);
    expect(Array.isArray(roundTrip.episodes)).toBe(true);
    expect(typeof roundTrip.stale).toBe("boolean");
    expect(typeof roundTrip.generatedAt).toBe("string");
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

    // social.png is published alongside the page so og:image resolves to a
    // stable URL the mirror controls (the app shell's copy is content-hashed
    // by the client build, which this writer cannot know).
    expect((await readdir(siteDir)).sort()).toEqual([
      "client.js",
      "data.json",
      "index.html",
      "social.png",
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

describe("persistent premiere slot — latest revealed card", () => {
  function latestPremiereSample() {
    return {
      premiereId: "prem_54d299b874f0adc7654fd1cc",
      roundNumber: 651,
      mapLabel: "Pangaea",
      revealedAt: "2026-07-22T08:45:13.000Z",
      href: "/premiere/prem_54d299b874f0adc7654fd1cc",
    };
  }

  function livePremiereSample() {
    return {
      premiereId: "prem_0579c9b1e839847e2a50f216",
      roundNumber: 652,
      mapLabel: "World",
      scheduledAt: "2026-07-22T09:06:00.000Z",
      premierePageLive: true,
    };
  }

  test("renders the latest revealed card as a first-class watchable card when nothing is premiering", () => {
    const html = coworldLeagueIndexHtml({
      ...sampleData(),
      latestPremiere: latestPremiereSample(),
    });
    expect(html).toContain(
      '<article class="premiere-card latest-premiere-card">',
    );
    expect(html).toContain(
      '<div class="premiere-eyebrow">Latest premiere</div>',
    );
    expect(html).toContain("<span>Round 651</span>");
    expect(html).toContain("<span>Pangaea</span>");
    expect(html).toContain(
      'Revealed <span data-utc="2026-07-22T08:45:13.000Z">2026-07-22 08:45Z</span>',
    );
    expect(html).toContain(
      '<a class="button primary premiere-link" href="/premiere/prem_54d299b874f0adc7654fd1cc">Watch now</a>',
    );
    // The full premiere-card visual language ships with the latest-only state.
    expect(html).toContain(".premiere-card {");
    // …minus every live-state signal: no red pill, no pulsing dot, no live
    // variant attribute on the article. (Scoped CSS selector names still
    // appear in <style>; assert on rendered markup.)
    expect(html).not.toContain('class="premiere-badge live"');
    expect(html).not.toContain('<span class="premiere-badge-dot"');
    expect(html).not.toContain(
      '<article class="premiere-card" data-premiere-live',
    );
    // And no winner/outcome text can exist on the card by construction.
    expect(html).not.toContain("Sealed premiere");
  });

  test("the LIVE card always wins the slot; the two never co-render", () => {
    const html = coworldLeagueIndexHtml({
      ...sampleData(),
      premiere: livePremiereSample(),
      latestPremiere: latestPremiereSample(),
    });
    expect(html).toContain('class="premiere-badge live"');
    expect(html).toContain('href="/premiere/prem_0579c9b1e839847e2a50f216"');
    expect(html).not.toContain("latest-premiere-card");
    expect(html).not.toContain("Latest premiere");
    expect(html).not.toContain("prem_54d299b874f0adc7654fd1cc");
  });

  test("slot never empty once a latest revealed exists: exactly one premiere card in every state", () => {
    const latestOnly = coworldLeagueIndexHtml({
      ...sampleData(),
      latestPremiere: latestPremiereSample(),
    });
    expect(latestOnly.match(/<article class="premiere-card/g)).toHaveLength(1);
    const liveAndLatest = coworldLeagueIndexHtml({
      ...sampleData(),
      premiere: livePremiereSample(),
      latestPremiere: latestPremiereSample(),
    });
    expect(liveAndLatest.match(/<article class="premiere-card/g)).toHaveLength(
      1,
    );
    const liveOnly = coworldLeagueIndexHtml({
      ...sampleData(),
      premiere: livePremiereSample(),
    });
    expect(liveOnly.match(/<article class="premiere-card/g)).toHaveLength(1);
  });

  test("before any premiere has revealed the page carries no premiere bytes at all (flag-off byte-identical)", () => {
    const html = coworldLeagueIndexHtml(sampleData());
    expect(html).not.toContain("premiere");
    expect(html).not.toContain("premiere-section");
    expect(html).toContain(
      '</div>\n    <section>\n      <h2 id="standings-title">Standings',
    );
  });

  test("archive-fallback shape (round and map unknown) renders the reveal time and link only", () => {
    const html = coworldLeagueIndexHtml({
      ...sampleData(),
      latestPremiere: {
        ...latestPremiereSample(),
        roundNumber: null,
        mapLabel: "",
      },
    });
    expect(html).toContain("latest-premiere-card");
    // The first (and only) meta pill is the Revealed pill: no Round pill, no
    // map pill, no empty pill.
    expect(html).toContain('<div class="premiere-meta"><span>Revealed ');
    expect(html).not.toContain("<span>Round 651</span>");
    expect(html).not.toContain("<span></span>");
    expect(html).toContain(
      'Revealed <span data-utc="2026-07-22T08:45:13.000Z">',
    );
    expect(html).toContain('href="/premiere/prem_54d299b874f0adc7654fd1cc"');
  });

  test("escapes hostile latest-premiere fields", () => {
    const html = coworldLeagueIndexHtml({
      ...sampleData(),
      latestPremiere: {
        ...latestPremiereSample(),
        mapLabel: '<script>alert("map")</script>',
        href: '/premiere/prem_54d299b874f0adc7654fd1cc" onclick="x',
      },
    });
    expect(html).not.toContain('<script>alert("map")</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('" onclick="');
  });
});

describe("latestPremiere data.json round-trip", () => {
  let siteDir: string | null = null;

  afterEach(async () => {
    if (siteDir !== null) {
      await rm(siteDir, { recursive: true, force: true });
      siteDir = null;
    }
  });

  test("latestPremiere round-trips additively and is absent when unset", async () => {
    siteDir = await mkdtemp(path.join(tmpdir(), "league-site-latest-"));
    const latestPremiere = {
      premiereId: "prem_54d299b874f0adc7654fd1cc",
      roundNumber: 651,
      mapLabel: "Pangaea",
      revealedAt: "2026-07-22T08:45:13.000Z",
      href: "/premiere/prem_54d299b874f0adc7654fd1cc",
    };
    const paths = await writeCoworldLeagueSite(siteDir, {
      ...sampleData(),
      latestPremiere,
    });
    const roundTrip = JSON.parse(await readFile(paths.dataPath, "utf8"));
    expect(roundTrip.latestPremiere).toEqual(latestPremiere);
    // The polling-client contract fields the deployed client validates are
    // untouched (the client only compares generatedAt and reloads).
    expect(Array.isArray(roundTrip.standings)).toBe(true);
    expect(Array.isArray(roundTrip.rounds)).toBe(true);
    expect(Array.isArray(roundTrip.episodes)).toBe(true);
    expect(typeof roundTrip.stale).toBe("boolean");
    expect(typeof roundTrip.generatedAt).toBe("string");

    const plainPaths = await writeCoworldLeagueSite(siteDir, sampleData());
    const plain = JSON.parse(await readFile(plainPaths.dataPath, "utf8"));
    expect(plain).not.toHaveProperty("latestPremiere");
    expect(JSON.stringify(plain)).not.toContain("premiere");
  });
});
