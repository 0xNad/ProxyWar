/**
 * Coverage for `/watch`'s three headline branches (live premiere / archived
 * premiere / no premiere), the replay archive's most-recent-first ordering
 * and spoiler-safe reveal, and the pure helpers backing the degraded-turns
 * note and winner-name resolution. Follows the mount-into-jsdom + stubbed
 * global fetch convention in
 * `tests/client/prediction/wagering/page/AccountPage.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/publicapp/WatchPage";
import type { WatchPage } from "../../../src/client/publicapp/WatchPage";
import {
  computeDegradedShare,
  describeSchedule,
  filterArchiveMatches,
  resolveWinnerName,
} from "../../../src/client/publicapp/WatchPage";
import type {
  PublicAgent,
  PublicMatch,
  ReadModel,
} from "../../../src/client/publicapp/ReadModelSchema";
import type * as UtilsModule from "../../../src/client/Utils";

vi.mock("../../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof UtilsModule>()),
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));

function agent(overrides: Partial<PublicAgent>): PublicAgent {
  return {
    registered: true,
    id: "agent_1",
    slug: "agent-one",
    playerName: "agent-one",
    displayName: "Agent One",
    shortCode: "AG1",
    emblemSvg: null,
    primaryColor: null,
    secondaryColor: null,
    tagline: null,
    builderId: null,
    builderDisplayName: null,
    status: "unclaimed",
    standing: null,
    activeVersion: null,
    provenance: { ratingPolicyLabel: null, activeChampionPolicyLabel: null },
    stats: null,
    timeSeries: { winrate: null, score: null },
    ...overrides,
  };
}

function match(overrides: Partial<PublicMatch>): PublicMatch {
  return {
    matchId: "match_1",
    shortId: "m1",
    roundNumber: 3,
    completedAt: "2026-07-01T00:00:00.000Z",
    map: "Frostfall",
    mapSize: "medium",
    turnCount: 120,
    decisionCount: 100,
    degradedCount: null,
    winnerAgentSlug: null,
    participants: [],
    watchHref: null,
    fullRenderHref: null,
    premiereHref: null,
    directorCut: null,
    ...overrides,
  };
}

function readModel(overrides: Partial<ReadModel>): ReadModel {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    lastGoodSyncAt: "2026-07-01T00:00:00.000Z",
    stale: false,
    feedStates: { championFeedStale: false, replayFeedStale: false },
    league: {
      id: "league_1",
      name: "Proxy War",
      description: null,
      divisionName: "Open",
      roundIntervalMinutes: null,
      episodesPerRound: null,
      currentRoundNumber: null,
      currentRoundStatus: null,
      scoreLabel: "Rating",
    },
    builders: [],
    agents: [],
    versions: [],
    rounds: [],
    matches: [],
    featuredMatches: [],
    premieres: { live: null, latest: null },
    links: {
      enterTheLeagueUrl: "https://example.test/enter",
      platformLabel: "Coworld",
      accountUrl: "https://example.test/account",
    },
    ...overrides,
  };
}

function stubReadModelFetch(model: ReadModel): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => model }) as Response),
  );
}

function mount(): WatchPage {
  const el = document.createElement("watch-page") as WatchPage;
  document.body.append(el);
  return el;
}

/** Drains pending microtasks — deterministic, not a real-time wait. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("watch-page premiere section", () => {
  it("shows a Live Premiere section with a manually-built watch link when premieres.live is set", async () => {
    stubReadModelFetch(
      readModel({
        premieres: {
          live: {
            premiereId: "pre mier/1",
            roundNumber: 5,
            mapLabel: "Ashfields",
            scheduledAt: new Date(Date.now() + 60_000).toISOString(),
            premierePageLive: true,
          },
          latest: null,
        },
      }),
    );
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("watch.live_premiere_badge");
    expect(el.textContent).toContain("Ashfields");
    expect(el.textContent).toContain(
      `watch.round_label:${JSON.stringify({ round: 5 })}`,
    );
    const link = el.querySelector<HTMLAnchorElement>("a[href^='/premiere/']");
    expect(link?.getAttribute("href")).toBe(
      `/premiere/${encodeURIComponent("pre mier/1")}`,
    );
  });

  it("falls back to an Archived premiere section when there is no live premiere", async () => {
    stubReadModelFetch(
      readModel({
        premieres: {
          live: null,
          latest: {
            premiereId: "pre_2",
            roundNumber: 4,
            mapLabel: "Coldharbor",
            revealedAt: "2026-06-30T00:00:00.000Z",
            href: "/premiere/pre_2",
          },
        },
      }),
    );
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("watch.archived_premiere_badge");
    expect(el.textContent).toContain("Coldharbor");
    expect(el.textContent).not.toContain("watch.live_premiere_badge");
    const link = el.querySelector<HTMLAnchorElement>("a[href='/premiere/pre_2']");
    expect(link).not.toBeNull();
  });

  it("shows an honest empty note when there is neither a live nor a latest premiere", async () => {
    stubReadModelFetch(readModel({}));
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("watch.no_premiere");
    expect(el.textContent).not.toContain("watch.live_premiere_badge");
    expect(el.textContent).not.toContain("watch.archived_premiere_badge");
  });
});

describe("watch-page replay archive", () => {
  it("lists only completed matches, most recently completed first, and keeps the result behind a closed disclosure", async () => {
    stubReadModelFetch(
      readModel({
        agents: [agent({ slug: "winner-agent", displayName: "Winner Co" })],
        matches: [
          match({
            matchId: "older",
            completedAt: "2026-06-01T00:00:00.000Z",
            map: "Older Map",
          }),
          match({
            matchId: "in-progress",
            completedAt: null,
            map: "Should Not Appear",
          }),
          match({
            matchId: "newer",
            completedAt: "2026-06-15T00:00:00.000Z",
            map: "Newer Map",
            winnerAgentSlug: "winner-agent",
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).not.toContain("Should Not Appear");
    const cards = Array.from(el.querySelectorAll("li"));
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain("Newer Map");
    expect(cards[1]?.textContent).toContain("Older Map");

    const details = cards[0]?.querySelector("details");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("summary")?.textContent?.trim()).toBe(
      "watch.reveal_result",
    );
    // Resolved from ReadModel.agents by slug, not the raw participant name.
    expect(details?.textContent).toContain("Winner Co");
  });

  it("shows a Director Cut duration badge when the match carries one, and omits it otherwise", async () => {
    stubReadModelFetch(
      readModel({
        matches: [
          match({
            matchId: "with-cut",
            completedAt: "2026-06-15T00:00:00.000Z",
            map: "Cut Map",
            directorCut: { durationEstimateSeconds: 700, segmentCount: 9 },
          }),
          match({
            matchId: "without-cut",
            completedAt: "2026-06-14T00:00:00.000Z",
            map: "No Cut Map",
            directorCut: null,
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();

    const cards = Array.from(el.querySelectorAll("li"));
    expect(cards).toHaveLength(2);
    // 700 seconds rounds to 12 minutes.
    expect(cards[0]?.textContent).toContain("watch.director_cut_duration");
    expect(cards[1]?.textContent).not.toContain(
      "watch.director_cut_duration",
    );
  });

  it("resolves the winner via the participant's own displayName when the slug isn't a known agent", () => {
    const m = match({
      winnerAgentSlug: "ghost-slug",
      participants: [
        {
          slot: 0,
          agentSlug: "ghost-slug",
          displayName: "raw-coworld-name",
          tilesOwned: 10,
          isAlive: true,
          isWinner: true,
          color: "#fff",
        },
      ],
    });
    expect(resolveWinnerName(m, [])).toBe("raw-coworld-name");
  });

  it("returns null when the match has no winner", () => {
    expect(resolveWinnerName(match({ winnerAgentSlug: null }), [])).toBeNull();
  });

  it("renders a Featured badge for a match present in featuredMatches, and never for one that isn't", async () => {
    stubReadModelFetch(
      readModel({
        matches: [
          match({
            matchId: "feat",
            completedAt: "2026-06-15T00:00:00.000Z",
            map: "Feat Map",
          }),
          match({
            matchId: "plain",
            completedAt: "2026-06-14T00:00:00.000Z",
            map: "Plain Map",
          }),
        ],
        featuredMatches: [
          {
            matchId: "feat",
            lane: "archive",
            title: "Feature",
            description: "",
            map: "Feat Map",
            format: "1v1",
            category: null,
            state: "archived",
            scheduledAt: null,
            revealAt: null,
            postMatchSummary: null,
            result: null,
          },
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();

    const cards = Array.from(el.querySelectorAll("li"));
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain("watch.featured_badge");
    expect(cards[1]?.textContent).not.toContain("watch.featured_badge");
  });

  it("filters the visible list live as the Agent select changes", async () => {
    stubReadModelFetch(
      readModel({
        agents: [
          agent({ slug: "alpha", displayName: "Alpha" }),
          agent({ slug: "beta", displayName: "Beta" }),
        ],
        matches: [
          match({
            matchId: "m-alpha",
            completedAt: "2026-06-15T00:00:00.000Z",
            map: "Alpha Map",
            participants: [
              {
                slot: 0,
                agentSlug: "alpha",
                displayName: "Alpha",
                tilesOwned: 10,
                isAlive: true,
                isWinner: true,
                color: "#fff",
              },
            ],
          }),
          match({
            matchId: "m-beta",
            completedAt: "2026-06-14T00:00:00.000Z",
            map: "Beta Map",
            participants: [
              {
                slot: 0,
                agentSlug: "beta",
                displayName: "Beta",
                tilesOwned: 10,
                isAlive: true,
                isWinner: true,
                color: "#fff",
              },
            ],
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.querySelectorAll("li")).toHaveLength(2);

    // Select the agent-filter <select> by its option set (first select
    // whose options include an "Alpha" entry) — the filter fieldset's
    // select elements have no distinguishing id/name of their own.
    const selects = Array.from(el.querySelectorAll("select"));
    const filterAgentSelect = selects.find((select) =>
      Array.from(select.options).some((o) => o.textContent === "Alpha"),
    );
    expect(filterAgentSelect).toBeDefined();
    filterAgentSelect!.value = "alpha";
    filterAgentSelect!.dispatchEvent(new Event("change"));
    await flushMicrotasks();

    const filtered = Array.from(el.querySelectorAll("li"));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.textContent).toContain("Alpha Map");

    // Back to "all" restores both — proof the SAME dropdown drives both
    // directions, not a one-way filter.
    filterAgentSelect!.value = "all";
    filterAgentSelect!.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(el.querySelectorAll("li")).toHaveLength(2);
  });

  it("shows an honest 'no matches match the filters' note when a filter combination excludes every match, without falling back to the unfiltered 'no completed matches' copy", async () => {
    stubReadModelFetch(
      readModel({
        matches: [
          match({
            matchId: "m-1",
            completedAt: "2026-06-15T00:00:00.000Z",
            map: "Only Map",
            mapSize: "Normal",
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.querySelectorAll("li")).toHaveLength(1);

    const selects = Array.from(el.querySelectorAll("select"));
    const filterMapSizeSelect = selects.find((select) =>
      Array.from(select.options).some((o) => o.value === "Normal"),
    );
    expect(filterMapSizeSelect).toBeDefined();
    filterMapSizeSelect!.value = "Normal";
    filterMapSizeSelect!.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(el.querySelectorAll("li")).toHaveLength(1);

    const filterCleanlinessSelect = selects.find((select) =>
      Array.from(select.options).some((o) => o.value === "degraded"),
    );
    expect(filterCleanlinessSelect).toBeDefined();
    filterCleanlinessSelect!.value = "degraded";
    filterCleanlinessSelect!.dispatchEvent(new Event("change"));
    await flushMicrotasks();

    // The single match is clean (degradedCount null), so "degraded only"
    // excludes it — the honest empty-FILTER note, distinct from the
    // unfiltered "no completed matches at all" copy.
    expect(el.querySelectorAll("li")).toHaveLength(0);
    expect(el.textContent).toContain("watch.no_filtered_matches");
    expect(el.textContent).not.toContain("watch.no_completed_matches");
  });

  it("only renders filter options that actually appear in the archive — never a static/guessed list", async () => {
    stubReadModelFetch(
      readModel({
        agents: [
          agent({ slug: "alpha", displayName: "Alpha" }),
          agent({ slug: "never-played", displayName: "Never Played" }),
        ],
        matches: [
          match({
            matchId: "m-alpha",
            completedAt: "2026-06-15T00:00:00.000Z",
            map: "Alpha Map",
            participants: [
              {
                slot: 0,
                agentSlug: "alpha",
                displayName: "Alpha",
                tilesOwned: 10,
                isAlive: true,
                isWinner: true,
                color: "#fff",
              },
            ],
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("Alpha");
    expect(el.textContent).not.toContain("Never Played");
  });
});

describe("computeDegradedShare", () => {
  it("stays unelevated below the 15% threshold", () => {
    expect(computeDegradedShare(10, 100)).toEqual({ share: 10, elevated: false });
  });

  it("elevates at and above the 15% threshold", () => {
    expect(computeDegradedShare(15, 100)).toEqual({ share: 15, elevated: true });
    expect(computeDegradedShare(30, 100)).toEqual({ share: 30, elevated: true });
  });

  it("has no percentage when decisionCount is unknown", () => {
    expect(computeDegradedShare(5, null)).toEqual({ share: null, elevated: false });
  });
});

describe("describeSchedule", () => {
  it("reports a countdown for a future scheduledAt without implying it is already live", () => {
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    const note = describeSchedule("2026-07-01T01:00:00.000Z", now);
    expect(note).toContain("watch.starts_in");
    expect(note).toContain(`"duration":"1h 0m"`);
    expect(note).not.toContain("watch.started_ago");
  });

  it("reports elapsed time for a past scheduledAt without implying it is currently playing", () => {
    const now = Date.parse("2026-07-01T01:00:00.000Z");
    const note = describeSchedule("2026-07-01T00:00:00.000Z", now);
    expect(note).toContain("watch.started_ago");
    expect(note).toContain(`"duration":"1h 0m"`);
    expect(note).not.toContain("watch.starts_in");
  });
});

describe("filterArchiveMatches", () => {
  function completedMatch(overrides: Partial<PublicMatch>) {
    return match({
      completedAt: "2026-06-15T00:00:00.000Z",
      ...overrides,
    }) as PublicMatch & { completedAt: string };
  }
  const noFilter = {
    agentSlug: "all",
    map: "all",
    mapSize: "all",
    featured: "all" as const,
    cleanliness: "all" as const,
    dateFrom: null,
    dateTo: null,
  };

  it("filters by participant agentSlug", () => {
    const alpha = completedMatch({
      matchId: "a",
      participants: [
        {
          slot: 0,
          agentSlug: "alpha",
          displayName: "Alpha",
          tilesOwned: 0,
          isAlive: true,
          isWinner: false,
          color: "#000",
        },
      ],
    });
    const beta = completedMatch({ matchId: "b", participants: [] });
    const result = filterArchiveMatches([alpha, beta], new Set(), {
      ...noFilter,
      agentSlug: "alpha",
    });
    expect(result.map((m) => m.matchId)).toEqual(["a"]);
  });

  it("filters by map and mapSize independently", () => {
    const m1 = completedMatch({ matchId: "1", map: "Frost", mapSize: "Normal" });
    const m2 = completedMatch({ matchId: "2", map: "Sand", mapSize: "Compact" });
    expect(
      filterArchiveMatches([m1, m2], new Set(), { ...noFilter, map: "Frost" })
        .map((m) => m.matchId),
    ).toEqual(["1"]);
    expect(
      filterArchiveMatches([m1, m2], new Set(), {
        ...noFilter,
        mapSize: "Compact",
      }).map((m) => m.matchId),
    ).toEqual(["2"]);
  });

  it("filters to featured-only via the matchId set, leaving 'all' unaffected", () => {
    const featured = completedMatch({ matchId: "f" });
    const plain = completedMatch({ matchId: "p" });
    const featuredIds = new Set(["f"]);
    expect(
      filterArchiveMatches([featured, plain], featuredIds, {
        ...noFilter,
        featured: "featured",
      }).map((m) => m.matchId),
    ).toEqual(["f"]);
    expect(
      filterArchiveMatches([featured, plain], featuredIds, noFilter).map(
        (m) => m.matchId,
      ),
    ).toEqual(["f", "p"]);
  });

  it("filters clean/degraded using the SAME elevated threshold renderDegradedNote uses (>= 15%)", () => {
    const clean = completedMatch({
      matchId: "clean",
      degradedCount: 10,
      decisionCount: 100,
    }); // 10%, below threshold
    const degraded = completedMatch({
      matchId: "degraded",
      degradedCount: 20,
      decisionCount: 100,
    }); // 20%, above threshold
    expect(
      filterArchiveMatches([clean, degraded], new Set(), {
        ...noFilter,
        cleanliness: "clean",
      }).map((m) => m.matchId),
    ).toEqual(["clean"]);
    expect(
      filterArchiveMatches([clean, degraded], new Set(), {
        ...noFilter,
        cleanliness: "degraded",
      }).map((m) => m.matchId),
    ).toEqual(["degraded"]);
  });

  it("filters by inclusive date range against completedAt's UTC date segment", () => {
    const early = completedMatch({
      matchId: "early",
      completedAt: "2026-06-01T23:00:00.000Z",
    });
    const mid = completedMatch({
      matchId: "mid",
      completedAt: "2026-06-15T00:00:00.000Z",
    });
    const late = completedMatch({
      matchId: "late",
      completedAt: "2026-06-30T00:00:00.000Z",
    });
    const result = filterArchiveMatches([early, mid, late], new Set(), {
      ...noFilter,
      dateFrom: "2026-06-10",
      dateTo: "2026-06-20",
    });
    expect(result.map((m) => m.matchId)).toEqual(["mid"]);
  });

  it("combines multiple filters with AND semantics, never OR", () => {
    const matches = [
      completedMatch({ matchId: "wrong-map", map: "Frost", mapSize: "Normal" }),
      completedMatch({ matchId: "wrong-size", map: "Sand", mapSize: "Compact" }),
      completedMatch({ matchId: "both-match", map: "Sand", mapSize: "Normal" }),
    ];
    const result = filterArchiveMatches(matches, new Set(), {
      ...noFilter,
      map: "Sand",
      mapSize: "Normal",
    });
    expect(result.map((m) => m.matchId)).toEqual(["both-match"]);
  });
});
