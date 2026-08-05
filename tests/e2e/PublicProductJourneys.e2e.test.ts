/**
 * Stage 8 item 2's E2E suite. No Playwright/Puppeteer dependency exists in
 * this repo (`npm run inst` is `npm ci --ignore-scripts`, never
 * `npm install`), so this uses the minimal raw-CDP driver in
 * `support/CdpBrowser.ts` — the same underlying mechanism the
 * `browser-harness` skill's own doc describes ("Raw CDP for anything
 * helpers don't cover"), made into a reusable dependency-free library
 * instead of an interactive tool. One shared fixture server (real demo
 * server process, `PROXYWAR_LEAGUE_WRAPPER_ONLY=true`, matching the
 * showcase deployment's actual security posture) backs every case below,
 * EXCEPT the live-premiere describe block, which boots its own dedicated,
 * slower fixture server with a real admitted premiere — see that block's
 * own doc for why it can't share the fast fixture above.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CdpBrowser } from "./support/CdpBrowser";
import {
  startFixtureServer,
  startFixtureServerWithLivePremiere,
  type FixtureServerHandle,
} from "./support/FixtureServer";
import {
  DEGRADED_EPISODE,
  FIXTURE_AGENT_IDS,
  ORDINARY_EPISODE,
} from "../../src/server/fixtures/PublicProductFixtureData";

const PORT = 18788;

// The live-premiere block below (`startFixtureServerWithLivePremiere`)
// requires a clean committed git checkout — see that block's own doc.
// That's correct-by-design for CI/clean runs, but in multi-session local
// development it just means "this block never runs while you have
// uncommitted work", which `FixtureServer.ts` now fails fast and
// explains. Set this to genuinely SKIP (not fake-pass) the block instead
// of failing on a local dirty-tree run; CI/clean-tree runs are unaffected
// either way, since a clean tree never hits the gate at all.
const SKIP_PROVENANCE_BLOCK =
  process.env.PROXYWAR_E2E_SKIP_PROVENANCE_BLOCK === "1";

let fixture: FixtureServerHandle;
let browser: CdpBrowser;

beforeAll(async () => {
  fixture = await startFixtureServer(PORT);
  browser = await CdpBrowser.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await fixture?.stop();
}, 20_000);

describe("first visit -> a completed match in two clicks", () => {
  test("homepage -> Watch -> a match card's own watch link resolves", async () => {
    await browser.goto(fixture.origin);
    // Click 1: the homepage's nav link into the Watch archive.
    const watchHref = await browser.evaluate<string | null>(
      `(document.querySelector('a[href="/watch"]') || {}).getAttribute?.('href') ?? null`,
    );
    expect(watchHref).toBe("/watch");
    await browser.goto(`${fixture.origin}/watch`);
    // A match card's own watch link is one of three real shapes
    // (WatchPage.ts's `renderMatchCard`, `match.fullRenderHref ??
    // match.watchHref`): `/match/:matchId` for a genuinely featured
    // match, `/ai-league-runs/:runKey/spectator.html` for a
    // self-contained legacy replay, or `/ai-league-replay/:runId` for a
    // full-client render — never assume just the first shape (a fixed
    // archive episode with no real replay bytes can legitimately use
    // only the second; requiring `/match/` here previously masked a
    // real dead-link bug by never actually resolving the found link's
    // content, only its HTTP status, see PublicProductFixtureData.ts's
    // ORDINARY_EPISODE doc comment).
    const linkSelector =
      'a[href^="/match/"], a[href^="/ai-league-runs/"], a[href^="/ai-league-replay/"]';
    await browser.waitFor(
      `document.querySelectorAll('${linkSelector}').length > 0`,
    );
    // Click 2: a real completed match's own watch link.
    const matchLink = await browser.evaluate<string | null>(`
      (() => {
        const links = [...document.querySelectorAll('${linkSelector}')];
        return links.length > 0 ? links[0].getAttribute('href') : null;
      })()
    `);
    expect(typeof matchLink).toBe("string");
    const status = await browser.httpStatus(`${fixture.origin}${matchLink}`);
    expect(status).toBe(200);
  });
});

describe("league battle card -> match page -> replay", () => {
  test("a /league battle card's canonical /match/:episodeId link renders real episode content whose own replay action resolves", async () => {
    await browser.goto(`${fixture.origin}/league`);
    await browser.waitFor(
      `document.querySelectorAll('a[href^="/match/"]').length > 0`,
    );
    const matchHref = await browser.evaluate<string | null>(`
      (() => {
        const link = document.querySelector('a[href^="/match/"]');
        return link ? link.getAttribute('href') : null;
      })()
    `);
    expect(matchHref).toMatch(/^\/match\/ereq_/);
    await browser.goto(`${fixture.origin}${matchHref}`);
    await browser.waitFor(`document.querySelector('h1') !== null`);
    const text = await browser.textContent();
    // Real episode content, never the not-found/error placeholder.
    expect(text).not.toContain("Match not found");
    expect(text).not.toContain("Could not load this match");
    expect(text).toContain("Placements");
    // The match page's own replay action (full render or quick replay)
    // resolves — a genuine second hop, not just a syntactically-present
    // href.
    const replayHref = await browser.evaluate<string | null>(`
      (() => {
        const link = document.querySelector(
          'a[href^="/ai-league-replay/"], a[href^="/ai-league-runs/"]',
        );
        return link ? link.getAttribute('href') : null;
      })()
    `);
    expect(typeof replayHref).toBe("string");
    const status = await browser.httpStatus(`${fixture.origin}${replayHref}`);
    expect(status).toBe(200);
  });
});

describe("direct reload of a league-episode match page", () => {
  test("reloading /match/:episodeId directly renders the real episode (not a stale loading/not-found placeholder)", async () => {
    await browser.goto(
      `${fixture.origin}/match/${ORDINARY_EPISODE.episodeRequestId}`,
    );
    await browser.waitFor(`document.querySelector('h1') !== null`);
    const text = await browser.textContent();
    expect(text).not.toContain("Match not found");
    expect(text).not.toContain("Could not load this match");
    expect(text).toContain(ORDINARY_EPISODE.map);
    expect(text).toContain("Placements");
  });

  test("an unknown episode id still renders the honest not-found state, not a raw server error", async () => {
    await browser.goto(`${fixture.origin}/match/ereq_this-episode-does-not-exist`);
    await browser.waitFor(`document.querySelector('h1') !== null`);
    const text = await browser.textContent();
    expect(text).not.toContain("Cannot GET");
    expect(text.toLowerCase()).toContain("not found");
  });
});

describe("league -> agent profile", () => {
  test("a standings row's Agent link reaches a real /agent/:slug page", async () => {
    await browser.goto(`${fixture.origin}/league`);
    await browser.waitFor(
      `document.querySelectorAll('a[href*="/agent/"]').length > 0`,
    );
    // The static mirror page renders identity links via the platform
    // origin (`PROXYWAR_PLATFORM_ORIGIN`, set same-origin for this suite —
    // see package.json's test:e2e script), so the href can be a full URL,
    // not just a relative path: match on the anchor's resolved `.href`
    // (always absolute) rather than the raw attribute.
    const agentUrl = await browser.evaluate<string | null>(`
      (() => {
        const link = document.querySelector('a[href*="/agent/"]');
        return link ? link.href : null;
      })()
    `);
    expect(agentUrl).toMatch(/\/agent\//);
    await browser.goto(agentUrl!);
    const text = await browser.textContent();
    expect(text).toContain("Cyan Hellstar");
  });
});

describe("builder -> agent", () => {
  test("/builders -> a Builder page -> its Agent link", async () => {
    await browser.goto(`${fixture.origin}/builders`);
    await browser.waitFor(
      `document.querySelectorAll('a[href^="/builder/"]').length > 0`,
    );
    const builderHref = await browser.evaluate<string | null>(`
      (() => {
        const link = document.querySelector('a[href^="/builder/"]');
        return link ? link.getAttribute('href') : null;
      })()
    `);
    expect(builderHref).toMatch(/^\/builder\//);
    await browser.goto(`${fixture.origin}${builderHref}`);
    await browser.waitFor(
      `document.querySelectorAll('a[href*="/agent/"]').length > 0`,
    );
    const agentUrl = await browser.evaluate<string | null>(`
      (() => {
        const link = document.querySelector('a[href*="/agent/"]');
        return link ? link.href : null;
      })()
    `);
    expect(agentUrl).toMatch(/\/agent\//);
    const status = await browser.httpStatus(agentUrl!);
    expect(status).toBe(200);
  });
});

describe("/build flow through a registration draft", () => {
  test("stepping to Identity, filling the form, and submitting produces a real draft + GitHub issue link", async () => {
    await browser.goto(`${fixture.origin}/build`);
    const h1 = await browser.evaluate<string>(
      `document.querySelector('h1')?.textContent?.trim() ?? ""`,
    );
    expect(h1).toBe("Build your Agent");
    // Step to "3. Identity".
    await browser.evaluate(`
      (() => {
        const buttons = [...document.querySelectorAll('button[aria-current]')];
        buttons[2]?.click();
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await browser.evaluate(`
      (() => {
        const form = document.querySelector('form');
        const inputs = form.querySelectorAll('input');
        const setValue = (el, value) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setValue(inputs[0], 'E2E Test Agent');
        setValue(inputs[1], 'E2E');
      })()
    `);
    await browser.evaluate(`
      (() => {
        const builderInput = [...document.querySelectorAll('form input')].find(
          (el) => el.closest('label')?.textContent?.includes('Your Builder name'),
        );
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(builderInput, 'E2E Builder');
        builderInput.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await browser.evaluate(
      `document.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }))`,
    );
    await browser.waitFor(
      `document.body.textContent.includes('Your registration draft')`,
      5000,
    );
    const issueLinkHref = await browser.evaluate<string | null>(`
      (() => {
        const link = document.querySelector('a[href^="https://github.com/0xNad/ProxyWar/issues/new"]');
        return link ? link.getAttribute('href') : null;
      })()
    `);
    expect(issueLinkHref).toContain("Agent+registration");
  });
});

describe("old replay URL compat", () => {
  test("the legacy /openfront-replay/:runID alias applies the SAME not-found contract as the canonical path", async () => {
    const canonicalStatus = await browser.httpStatus(
      `${fixture.origin}/ai-league-replay/nonexistent-run-id`,
    );
    const legacyStatus = await browser.httpStatus(
      `${fixture.origin}/openfront-replay/nonexistent-run-id`,
    );
    // Proves the alias is wired to the same not-found logic, not just
    // syntactically present, for a run that genuinely does not exist.
    expect(legacyStatus).toBe(canonicalStatus);
    expect([200, 302, 404]).toContain(legacyStatus);
  });
});

describe("direct reloads on every public route", () => {
  test.each([
    "/",
    "/watch",
    "/league",
    "/agents",
    "/builders",
    "/build",
    "/about",
    `/agent/${FIXTURE_AGENT_IDS.cyan.replace("agt_", "")}`,
    "/match/ereq_fixture-ordinary-0001",
  ])("a direct navigation to %s never falls back to a raw path-echo error", async (route) => {
    await browser.goto(`${fixture.origin}${route}`);
    const text = await browser.textContent();
    // The Express default 404 handler echoes the raw request path back —
    // exactly the failure mode a stale-cache/route-removal regression
    // would produce. A real page never contains its own request path as
    // literal body text this way.
    expect(text).not.toContain("Cannot GET");
  });
});

describe("mobile viewport", () => {
  test("the homepage and /build render without horizontal overflow at 390px", async () => {
    await browser.setViewport(390, 844);
    for (const route of ["/", "/build"]) {
      await browser.goto(`${fixture.origin}${route}`);
      const overflow = await browser.evaluate<boolean>(
        `document.documentElement.scrollWidth > window.innerWidth + 1`,
      );
      expect(overflow).toBe(false);
    }
    await browser.setViewport(1280, 900);
  });
});

describe("stale-feed fallback", () => {
  test("the league page surfaces the partial-staleness banner from the fixture's replayFeedStale flag", async () => {
    await browser.goto(`${fixture.origin}/league`);
    const text = await browser.textContent();
    expect(text.toLowerCase()).toContain("delayed");
  });

  test("the degraded fixture match still shows its recovered-turns warning", async () => {
    const dataResponse = await fetch(
      `${fixture.origin}/ai-league-runs/league/data.json`,
    );
    const data = (await dataResponse.json()) as {
      episodes: Array<{ episodeRequestId: string; degradedCount: number }>;
    };
    const degraded = data.episodes.find(
      (episode) => episode.episodeRequestId === DEGRADED_EPISODE.episodeRequestId,
    );
    expect(degraded?.degradedCount).toBeGreaterThan(0);
    const ordinary = data.episodes.find(
      (episode) => episode.episodeRequestId === ORDINARY_EPISODE.episodeRequestId,
    );
    expect(ordinary?.degradedCount).toBeLessThan(degraded!.degradedCount);
  });
});

describe("private-route denial (browser-level, mirrors the HTTP security suite)", () => {
  test("navigating a real browser to /tester-dashboard never lands on real dashboard content", async () => {
    await browser.goto(`${fixture.origin}/tester-dashboard`);
    const text = await browser.textContent();
    expect(text).not.toContain("Tester Dashboard");
  });

  test("submitting a job POST from within the page context never succeeds", async () => {
    const status = await browser.evaluate<number>(`
      fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
        .then((r) => r.status)
    `);
    expect(status).toBe(404);
  });
});

describe("premiere: upcoming state (does not require live admission)", () => {
  test("the league page's premiere card shows the scheduled fixture premiere, not a live one", async () => {
    await browser.goto(`${fixture.origin}/league`);
    const dataResponse = await fetch(
      `${fixture.origin}/ai-league-runs/league/data.json`,
    );
    const data = (await dataResponse.json()) as {
      premiere?: { premiereId: string; premierePageLive: boolean };
    };
    expect(data.premiere?.premiereId).toBe("prem_fixture0upcoming01");
    expect(data.premiere?.premierePageLive).toBe(false);
  });
});

describe.skipIf(SKIP_PROVENANCE_BLOCK)(
  "premiere: active / late-join sync / no seek past edge / reveal after end",
  () => {
  // Boots a SEPARATE, dedicated fixture server with a real admitted live
  // premiere (`startFixtureServerWithLivePremiere`) rather than reusing
  // the shared `fixture` above — this path is real but slow (~1 minute
  // to boot, plus two ~60s REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS prediction
  // windows before reveal) and requires a CLEAN git checkout (the
  // exhibition's build-provenance check), so it must not slow down or
  // gate every other case in this file.
  //
  // LIVE_PREMIERE_BOOT_TIMEOUT_MS below covers this beforeAll ONLY — the
  // test/assertion timeouts and afterAll's cleanup timeout are unchanged.
  // Evidence for raising it from the prior 90_000ms: PR #16 shard 1/4 (a
  // genuinely clean GH Actions checkout, 2026-08-04) failed with "Hook
  // timed out in 90000ms" on this exact beforeAll, while the other
  // 1223/1227 tests in that same shard passed. This session independently
  // measured the GH Actions coverage runner running ~3x local CPU/IO on
  // other tests (SpawnCandidatePipelineEquivalence.test.ts's
  // production-12P case: 67s standalone locally vs 875-1073s on GH;
  // AgentLeagueMatch.test.ts: ~44m on GH), so a ~1-minute-local boot
  // plausibly exceeds a 90s budget on the real runner despite fitting
  // comfortably locally. 5 minutes gives >3x headroom over the
  // ~1-minute local estimate without masking a genuine hang.
  const LIVE_PORT = 18789;
  const LIVE_PREMIERE_BOOT_TIMEOUT_MS = 5 * 60_000;
  let live: FixtureServerHandle;
  let liveBrowser: CdpBrowser;

  beforeAll(async () => {
    live = await startFixtureServerWithLivePremiere(LIVE_PORT);
    liveBrowser = await CdpBrowser.launch();
  }, LIVE_PREMIERE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await liveBrowser?.close();
    await live?.stop();
  }, 20_000);

  const PREMIERE_ID = "prem_fixture0premiere01";

  async function bootstrap(): Promise<{
    integrityScope: { authoritativeResult: string };
    gameStartInfo: { players: Array<{ username: string }> };
  }> {
    const response = await fetch(
      `${live.origin}/api/premieres/${PREMIERE_ID}/bootstrap`,
    );
    expect(response.status).toBe(200);
    return response.json();
  }

  async function liveProjection(
    after: number,
  ): Promise<{ liveVisibleSequence: number; records: unknown[] }> {
    const response = await fetch(
      `${live.origin}/api/premieres/${PREMIERE_ID}/live-projection?after=${after}`,
    );
    expect(response.status).toBe(200);
    return response.json();
  }

  test("premiere transitions from scheduled to playing and is watchable live", async () => {
    // `httpStatus` fetches from the browser's CURRENT page — a freshly
    // launched browser starts on `about:blank`, an opaque origin that
    // cannot cross-origin `fetch` at all. Navigate first so the check
    // runs same-origin, same as every other case in this file (which all
    // run after the shared browser has already navigated once).
    await liveBrowser.goto(`${live.origin}/premiere/${PREMIERE_ID}`);
    const status = await liveBrowser.httpStatus(
      `${live.origin}/premiere/${PREMIERE_ID}`,
    );
    expect(status).toBe(200);
    const boot = await bootstrap();
    // Real two-seat roster from the admitted exhibition, not a placeholder.
    const usernames = boot.gameStartInfo.players.map((p) => p.username);
    expect(usernames).toContain("Fixture aggressive");
    expect(usernames).toContain("Fixture aggressive2");
    // The match is genuinely progressing turn-by-turn, not a static shell.
    const first = await liveProjection(0);
    expect(first.liveVisibleSequence).toBeGreaterThan(0);
    expect(first.records.length).toBeGreaterThan(0);
  });

  test("a late-joining client reads the current live position, never paced from turn 0", async () => {
    // By the time this test runs, real playback time has already elapsed
    // since admission (the previous test alone took several seconds) —
    // this IS the late-join scenario: a fresh client arriving after the
    // premiere has been airing for a while. A client paced from turn 0
    // would report a near-zero position; the real one must already be
    // well into the match.
    const status = await liveBrowser.httpStatus(
      `${live.origin}/premiere/${PREMIERE_ID}`,
    );
    expect(status).toBe(200);
    const snapshot = await liveProjection(0);
    expect(snapshot.liveVisibleSequence).toBeGreaterThan(100);
  });

  test("seeking past the live edge is rejected server-side", async () => {
    const beyondEdge = await liveProjection(999_999_999);
    // Never fabricates turns that haven't happened yet — records for an
    // out-of-range request come back empty, and the reported live
    // position is the server's real current position, not the client's
    // requested (impossible) one.
    expect(beyondEdge.records).toEqual([]);
    expect(beyondEdge.liveVisibleSequence).toBeLessThan(999_999_999);
    expect(beyondEdge.liveVisibleSequence).toBeGreaterThan(0);
  });

  // Root-caused 2026-08-01. NOT a runtime bug — `bootstrap()`'s
  // `integrityScope.authoritativeResult` can never observe a reveal: it is
  // a hardcoded `z.literal("not_revealed")` in
  // `ReplayPremiereWire.ts`'s `createPremierePublicBootstrap` (enforced by
  // `ReplayPremierePublicPage.ts`'s `spoilerNeutralModel`, which THROWS if
  // that field is ever anything else — the bootstrap payload is
  // deliberately spoiler-neutral so it is safe to cache/embed pre-reveal).
  // The three earlier cases' `bootstrap()` polling was only ever exercising
  // the pre-reveal payload shape, never the actual reveal signal.
  //
  // Direct reproduction against a real admitted premiere (isolated clean
  // clone at HEAD `09aeba224`, `FIXTURE_ADMIT_LIVE_PREMIERE=1`, temporary
  // instrumentation in `synchronizeUnlocked()`, reverted after use) proved
  // the release/reveal pipeline itself is correct: `nextDraftIndex`
  // advanced through all 24 drafts, the terminal draft's
  // `presentationOffsetMs` (21399) cleared the elapsed-time gate the moment
  // real playback caught up, and `commitTerminalReveal()` committed on the
  // first attempt with no retry/error. `GET
  // /api/premieres/:id/reveal` (the same endpoint
  // `ReplayPremiereNetwork.ts`'s real client polls via its own
  // `revealPath()`, never `bootstrap()`) returned HTTP 200 with the full
  // authoritative result (Fixture aggressive won, turnCount 21400)
  // immediately once real elapsed time cleared the two checkpoint pauses
  // plus 1ms/turn playback. Production pacing is unaffected either way —
  // this was a test-only assertion-target mistake, not a fixture-pacing
  // artifact and not a runtime defect.
  test(
    "the premiere page shows the real result once revealed",
    async () => {
      // Checkpoints pause the release clock for
      // REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS (60s) each and this fixture has
      // two (10%/20% of the 21,400-turn match), so real wall-clock
      // time-to-reveal is roughly 2*60s of pause plus ~21s of 1ms/turn
      // playback — comfortably inside this generous deadline with margin
      // for whatever real time the earlier cases in this block already
      // consumed.
      const deadline = Date.now() + 240_000;
      let revealStatus = 0;
      let revealBody: {
        authoritativeResult: { bytes: string; sha256: string };
      } | null = null;
      while (Date.now() < deadline) {
        const response = await fetch(
          `${live.origin}/api/premieres/${PREMIERE_ID}/reveal`,
        );
        revealStatus = response.status;
        if (revealStatus === 200) {
          revealBody = await response.json();
          break;
        }
        // Exception to the no-real-timers rule: this polls a real running
        // server process advancing on the real system clock (a separate
        // premiere-runtime `setTimeout` scheduler in another process) —
        // there is no fake-timer boundary to control here, matching this
        // file's existing real-delay precedent (`FixtureServer.ts`,
        // `CdpBrowser.ts`). `Promise.withResolvers()` is unavailable under
        // this repo's ES2022 `lib` target (tsconfig.json), so this matches
        // the plain-executor pattern already used throughout this file.
        expect(revealStatus).toBe(404);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      expect(revealStatus).toBe(200);
      expect(revealBody).not.toBeNull();
      expect(revealBody!.authoritativeResult.bytes.length).toBeGreaterThan(0);
      expect(revealBody!.authoritativeResult.sha256).toMatch(/^[0-9a-f]{64}$/);
      // The live-projection tap and the reveal agree on the same final
      // sequence: nothing is fabricated or diverges between the two.
      const final = await liveProjection(0);
      expect(final.liveVisibleSequence).toBe(21_399);
      // bootstrap()'s pre-reveal field is unaffected by the real reveal —
      // this is the deliberate spoiler-neutral contract, not a stale-read
      // bug. Documented here so a future reader doesn't reintroduce the
      // exact confusion this test replaces.
      const boot = await bootstrap();
      expect(boot.integrityScope.authoritativeResult).toBe("not_revealed");
    },
    260_000,
  );
  },
);
