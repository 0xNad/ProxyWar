/**
 * Component coverage for the `/about` page: the static safe-claims copy
 * always renders (h1, how-it-works, credits, entry section) regardless of
 * the optional read-model fetch outcome, and the entry CTA / participant
 * count only ever come from a successfully parsed read model — never
 * hardcoded or invented on fetch failure. Follows the mount-into-jsdom
 * convention in `tests/client/prediction/wagering/page/AccountPage.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));
import "../../../src/client/publicapp/AboutPage";
import type { AboutPage } from "../../../src/client/publicapp/AboutPage";

function mount(): AboutPage {
  const el = document.createElement("about-page") as AboutPage;
  document.body.append(el);
  return el;
}

/** Drains pending microtasks — deterministic, not a real-time wait. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Collapses rendered whitespace/newlines so multi-line template text can be matched with a single substring check. */
function normalizedText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function minimalAgent(playerName: string) {
  return {
    registered: false,
    id: null,
    slug: null,
    playerName,
    displayName: playerName,
    shortCode: null,
    emblemSvg: null,
    primaryColor: null,
    secondaryColor: null,
    tagline: null,
    builderId: null,
    builderDisplayName: null,
    status: "unregistered",
    standing: null,
    activeVersion: null,
    provenance: { ratingPolicyLabel: null, activeChampionPolicyLabel: null },
  };
}

function readModelBody(enterTheLeagueUrl: string) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-30T00:00:00.000Z",
    lastGoodSyncAt: "2026-07-30T00:00:00.000Z",
    stale: false,
    feedStates: { championFeedStale: false, replayFeedStale: false },
    league: {
      id: "league-1",
      name: "Proxy War",
      description: null,
      divisionName: "Open",
      roundIntervalMinutes: 30,
      episodesPerRound: 1,
      currentRoundNumber: 12,
      currentRoundStatus: "active",
      scoreLabel: "Score",
    },
    builders: [],
    agents: [minimalAgent("daveey-proxywar"), minimalAgent("odin-free")],
    versions: [],
    rounds: [],
    matches: [],
    featuredMatches: [],
    premieres: { live: null, latest: null },
    links: {
      enterTheLeagueUrl,
      platformLabel: "Coworld",
      accountUrl: "https://coworld.example/account",
    },
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 500 })),
  );
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("about-page", () => {
  it("renders the safe-claims static copy independent of the read-model fetch", async () => {
    const el = mount();
    await flushMicrotasks();

    expect(el.querySelector("h1")?.textContent?.trim()).toBe("about.title");
    expect(normalizedText(el)).toContain("about.how_it_works_heading");
    expect(normalizedText(el)).toContain("about.credits_heading");
    expect(normalizedText(el)).toContain("about.credit_coworld");
    expect(normalizedText(el)).toContain("about.credit_openfront");
    expect(normalizedText(el)).toContain("daveey-proxywar:v24");
    expect(
      el.querySelector('a[href="https://github.com/0xNad/ProxyWar"]'),
    ).not.toBeNull();

    // Disallowed claims must never appear, even when the fetch fails.
    for (const banned of [
      "measures deception",
      "directly observable",
      "longest horizon",
      "most agents",
      "only persistent multi-agent",
      "revolutionary",
      "sentient",
      "AGI",
    ]) {
      expect(normalizedText(el).toLowerCase()).not.toContain(
        banned.toLowerCase(),
      );
    }
  });

  it("falls back to a no-URL entry note and omits the participant count when the read model fetch fails", async () => {
    const el = mount();
    await flushMicrotasks();

    expect(el.querySelector("a.inline-flex")).toBeNull();
    expect(normalizedText(el)).toContain("about.entry_fallback_note");
    expect(normalizedText(el)).not.toContain("about.participant_note");
  });

  it("links the entry CTA to the read model's enterTheLeagueUrl and shows the live agent count once loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody("https://github.com/example/proxywar-starter"),
        ),
      ),
    );
    const el = mount();
    await flushMicrotasks();

    const cta = el.querySelector("a.inline-flex");
    expect(cta?.getAttribute("href")).toBe(
      "https://github.com/example/proxywar-starter",
    );
    expect(normalizedText(el)).toContain(
      `about.participant_note:${JSON.stringify({ count: 2 })}`,
    );
  });

  it("includes the app-shell header and footer", async () => {
    const el = mount();
    await flushMicrotasks();

    expect(el.querySelector("header")).not.toBeNull();
    expect(el.querySelector("footer")).not.toBeNull();
    expect(el.querySelector('footer a[href="/about"]')).not.toBeNull();
  });
});
