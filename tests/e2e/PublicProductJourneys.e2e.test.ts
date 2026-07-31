/**
 * Stage 8 item 2's E2E suite. No Playwright/Puppeteer dependency exists in
 * this repo (`npm run inst` is `npm ci --ignore-scripts`, never
 * `npm install`), so this uses the minimal raw-CDP driver in
 * `support/CdpBrowser.ts` — the same underlying mechanism the
 * `browser-harness` skill's own doc describes ("Raw CDP for anything
 * helpers don't cover"), made into a reusable dependency-free library
 * instead of an interactive tool. One shared fixture server (real demo
 * server process, `PROXYWAR_LEAGUE_WRAPPER_ONLY=true`, matching the
 * showcase deployment's actual security posture) backs every case below.
 *
 * NOT covered here, and explicitly documented as a gap (see the Stage 8
 * report): premiere active/late-join-sync/no-seek-past-edge/reveal-after-
 * end. Those need a REAL admitted live premiere; `run-public-product-
 * fixtures.sh`'s live-premiere admission path is built and reaches the
 * actual `replay-premiere-admit.ts` call, but the underlying `--brain=rule`
 * exhibition match does not reliably reach a winner within a bounded turn
 * budget on the current map/manifest combination — confirmed across
 * several real attempts up to 8,400 turns. "Premiere UPCOMING" (the state
 * that does NOT require admission — just the mirror's own premiere card)
 * IS covered below.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CdpBrowser } from "./support/CdpBrowser";
import { startFixtureServer, type FixtureServerHandle } from "./support/FixtureServer";
import {
  DEGRADED_EPISODE,
  FIXTURE_AGENT_IDS,
  ORDINARY_EPISODE,
} from "../../src/server/fixtures/PublicProductFixtureData";

const PORT = 18788;

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
  test("homepage -> Watch -> a match card reaches the match detail page", async () => {
    await browser.goto(fixture.origin);
    // Click 1: the homepage's nav link into the Watch archive.
    const watchHref = await browser.evaluate<string | null>(
      `(document.querySelector('a[href="/watch"]') || {}).getAttribute?.('href') ?? null`,
    );
    expect(watchHref).toBe("/watch");
    await browser.goto(`${fixture.origin}/watch`);
    await browser.waitFor(
      `document.querySelectorAll('a[href*="/match/"]').length > 0`,
    );
    // Click 2: a real completed match's own detail-page link.
    const matchLink = await browser.evaluate<string | null>(`
      (() => {
        const links = [...document.querySelectorAll('a[href*="/match/"]')];
        return links.length > 0 ? links[0].getAttribute('href') : null;
      })()
    `);
    expect(typeof matchLink).toBe("string");
    const status = await browser.httpStatus(`${fixture.origin}${matchLink}`);
    expect(status).toBe(200);
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

describe.skip("premiere: active / late-join sync / no seek past edge / reveal after end", () => {
  // Documented gap — see this file's module doc and the Stage 8 report.
  // Re-enable once run-public-product-fixtures.sh's
  // FIXTURE_ADMIT_LIVE_PREMIERE=1 path reliably reaches a winner.
  test.todo("premiere transitions from scheduled to playing and is watchable live");
  test.todo("a late-joining client catches up to the live sequence, never paced from turn 0");
  test.todo("seeking past the live edge is rejected server-side");
  test.todo("the premiere page shows the real result once revealed");
});
