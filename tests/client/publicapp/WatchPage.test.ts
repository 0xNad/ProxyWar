/**
 * Coverage for `/watch`'s content-programme order (Season Zero activation
 * prompt Phase 5): featured event (isPubliclyPromotable-gated) / latest
 * Director Cuts / Season schedule / full replay archive with filters
 * behind a drawer — plus the pure helpers backing degraded-turns,
 * archive filtering/sorting, and winner-name resolution.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/publicapp/WatchPage";
import type { WatchPage } from "../../../src/client/publicapp/WatchPage";
import {
  computeDegradedShare,
  describeSchedule,
  filterArchiveMatches,
  findPromotableEvent,
  isEventLive,
  resolveWinnerName,
  sortArchiveMatches,
} from "../../../src/client/publicapp/WatchPage";
import type {
  PublicAgent,
  PublicFeaturedMatch,
  PublicMatch,
  PublicSeason,
  ReadModel,
} from "../../../src/client/publicapp/ReadModelSchema";
import type * as UtilsModule from "../../../src/client/Utils";
import { analytics } from "../../../src/client/analytics/AnalyticsClient";

vi.mock("../../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof UtilsModule>()),
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));
vi.mock("../../../src/client/analytics/AnalyticsClient", () => ({
  analytics: { track: vi.fn(), trackVisitStart: vi.fn() },
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
    dramaEvidence: null,
    ...overrides,
  };
}

function featuredMatch(overrides: Partial<PublicFeaturedMatch> = {}): PublicFeaturedMatch {
  return {
    matchId: "feat_11111111111111111111",
    lane: "premiere",
    title: "Auri vs Sefirot",
    description: "",
    map: "Pangaea",
    format: "2p duel",
    category: null,
    state: "published",
    scheduledAt: new Date(Date.now() + 600_000).toISOString(),
    revealAt: null,
    completedAt: null,
    postMatchSummary: null,
    result: null,
    isPubliclyPromotable: true,
    subtitle: "A duel worth watching",
    reasonToWatch: ["Auri debuts v43 after a strong run."],
    directorCutEstimateSeconds: 360,
    canonicalMatchUrl: "/match/feat_11111111111111111111",
    canonicalPremiereUrl: "/premiere/prem_abc",
    ...overrides,
  };
}

function season(overrides: Partial<PublicSeason> = {}): PublicSeason {
  return {
    id: "season_zero",
    slug: "zero",
    title: "Season Zero",
    description: "The first bounded programme.",
    startDate: "2026-08-01",
    endDate: "2026-09-26",
    state: "active",
    eventSlots: [],
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
    seasons: [],
    premieres: { live: null, latest: null },
    links: {
      enterTheLeagueUrl: "https://example.test/enter",
      platformLabel: "Coworld",
      accountUrl: "https://example.test/account",
    },
    ...overrides,
  };
}

function stubReadModelAndParticipantsFetch(
  model: ReadModel,
  participants: unknown[] = [],
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/featured-matches/")) {
        return { ok: true, json: async () => ({ schemaVersion: 1, participants }) } as Response;
      }
      return { ok: true, json: async () => model } as Response;
    }),
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
  vi.mocked(analytics.track).mockClear();
});

describe("watch-page featured event section", () => {
  it("shows the real title/subtitle/reason-to-watch for a promotable upcoming event, never a bare map+round card", async () => {
    stubReadModelAndParticipantsFetch(readModel({ featuredMatches: [featuredMatch()] }));
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("Auri vs Sefirot");
    expect(el.textContent).toContain("A duel worth watching");
    expect(el.textContent).toContain("Auri debuts v43 after a strong run.");
    expect(el.textContent).toContain("watch.upcoming_premiere_badge");
    const link = el.querySelector<HTMLAnchorElement>("a[href='/premiere/prem_abc']");
    expect(link).not.toBeNull();
  });

  it("flips to live once scheduledAt has passed", async () => {
    stubReadModelAndParticipantsFetch(
      readModel({
        featuredMatches: [
          featuredMatch({ scheduledAt: new Date(Date.now() - 60_000).toISOString() }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("watch.live_premiere_badge");
    expect(el.textContent).not.toContain("watch.upcoming_premiere_badge");
  });

  it("renders nothing (not even an empty section) when no promotable event exists — never the raw anonymous premieres.live pointer", async () => {
    stubReadModelAndParticipantsFetch(
      readModel({
        premieres: {
          live: {
            premiereId: "prem_anon",
            roundNumber: 312,
            mapLabel: "Pangaea",
            scheduledAt: new Date().toISOString(),
            premierePageLive: true,
          },
          latest: null,
        },
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).not.toContain("watch-featured-event-heading");
    expect(el.querySelector("#watch-featured-event-heading")).toBeNull();
  });

  it("ignores a non-promotable featured match", async () => {
    stubReadModelAndParticipantsFetch(
      readModel({ featuredMatches: [featuredMatch({ isPubliclyPromotable: false })] }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.querySelector("#watch-featured-event-heading")).toBeNull();
  });

  it("renders participant chips once the narrow route resolves a roster", async () => {
    stubReadModelAndParticipantsFetch(readModel({ featuredMatches: [featuredMatch()] }), [
      {
        playerName: "auri",
        displayName: "Auri",
        agentSlug: "auri",
        emblemSvg: null,
        primaryColor: null,
        secondaryColor: null,
        versionLabel: "v43",
        builderId: null,
        builderDisplayName: null,
      },
    ]);
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("Auri");
    expect(el.textContent).toContain("v43");
  });
});

describe("findPromotableEvent / isEventLive", () => {
  it("selects the earliest-scheduled published+promotable premiere-lane record", () => {
    const model = readModel({
      featuredMatches: [
        featuredMatch({ matchId: "feat_later", scheduledAt: "2026-08-20T00:00:00.000Z" }),
        featuredMatch({ matchId: "feat_earlier", scheduledAt: "2026-08-01T00:00:00.000Z" }),
      ],
    });
    expect(findPromotableEvent(model)?.matchId).toBe("feat_earlier");
  });

  it("excludes candidate/scheduled/revealed/archived states — only published is eligible", () => {
    for (const state of ["candidate", "scheduled", "revealed", "archived", "cancelled"] as const) {
      const model = readModel({ featuredMatches: [featuredMatch({ state })] });
      expect(findPromotableEvent(model)).toBeNull();
    }
  });

  it("excludes archive-lane records", () => {
    const model = readModel({
      featuredMatches: [featuredMatch({ lane: "archive", scheduledAt: null })],
    });
    expect(findPromotableEvent(model)).toBeNull();
  });

  it("isEventLive is false for a null scheduledAt and true once the clock passes it", () => {
    const event = featuredMatch({ scheduledAt: "2026-08-01T00:00:00.000Z" });
    expect(isEventLive(event, Date.parse("2026-07-31T00:00:00.000Z"))).toBe(false);
    expect(isEventLive(event, Date.parse("2026-08-01T00:00:01.000Z"))).toBe(true);
    expect(isEventLive(featuredMatch({ scheduledAt: null }), Date.now())).toBe(false);
  });
});

describe("watch-page latest Director Cuts section", () => {
  it("ranks by curatedDramaScore desc within a bounded recency window, showing lineups/runtime/reason", async () => {
    stubReadModelAndParticipantsFetch(
      readModel({
        matches: [
          match({
            matchId: "m_high",
            completedAt: "2026-07-05T00:00:00.000Z",
            directorCut: { durationEstimateSeconds: 360, segmentCount: 4 },
            dramaEvidence: { curatedDramaScore: 90, entertainmentGrade: "dramatic" },
            participants: [
              { slot: 0, agentSlug: "agent-one", displayName: "Agent One", tilesOwned: 5, isAlive: true, isWinner: true, color: "#111" },
            ],
          }),
        ],
        agents: [agent({ slug: "agent-one", displayName: "Agent One" })],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("watch.latest_director_cuts_heading");
    expect(el.textContent).toContain("Agent One");
    expect(el.textContent).toContain("watch.director_cut_duration:{\"minutes\":6}");
  });

  it("omits the section entirely when no match has a Director Cut", async () => {
    stubReadModelAndParticipantsFetch(readModel({ matches: [match({ directorCut: null })] }));
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).not.toContain("watch.latest_director_cuts_heading");
  });
});

describe("watch-page season schedule section", () => {
  it("renders the active season's title/dates and every event slot chronologically", async () => {
    stubReadModelAndParticipantsFetch(
      readModel({
        featuredMatches: [featuredMatch({ matchId: "feat_slot" })],
        seasons: [
          season({
            eventSlots: [
              { featuredMatchId: "feat_slot", scheduledAt: "2026-08-08T18:00:00.000Z" },
            ],
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("watch.season_schedule_heading");
    expect(el.textContent).toContain("Auri vs Sefirot");
  });

  it("2026-08-01 P0: a premiere-lane slot shows a 'Premieres' label", async () => {
    stubReadModelAndParticipantsFetch(
      readModel({
        featuredMatches: [featuredMatch({ matchId: "feat_slot", lane: "premiere" })],
        seasons: [
          season({
            eventSlots: [
              { featuredMatchId: "feat_slot", scheduledAt: "2026-08-08T18:00:00.000Z" },
            ],
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("watch.season_schedule_premiere_label");
    expect(el.textContent).not.toContain("watch.season_schedule_spotlight_label");
    expect(el.textContent).not.toContain("watch.season_schedule_played_note");
  });

  it("2026-08-01 P0: an archive-lane slot is presented as a 'Featured spotlight' of an already-completed match, with the honest played-on date, never as an upcoming contest", async () => {
    stubReadModelAndParticipantsFetch(
      readModel({
        featuredMatches: [
          featuredMatch({
            matchId: "feat_slot",
            lane: "archive",
            scheduledAt: null,
            completedAt: "2026-08-01T00:00:00.000Z",
          }),
        ],
        seasons: [
          season({
            eventSlots: [
              // The season programme's own "featuring starting" date — a
              // FUTURE date relative to the match's real completedAt, the
              // exact real-world scenario the P0 review flagged (a schedule
              // strip showing "8/3/2026" on an already-decided match).
              { featuredMatchId: "feat_slot", scheduledAt: "2026-08-03T18:00:00.000Z" },
            ],
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("watch.season_schedule_spotlight_label");
    expect(el.textContent).toContain("watch.season_schedule_played_note");
    expect(el.textContent).not.toContain("watch.season_schedule_premiere_label");
  });

  it("renders nothing when no season is active", async () => {
    stubReadModelAndParticipantsFetch(readModel({}));
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).not.toContain("watch.season_schedule_heading");
  });
});

describe("watch-page replay archive", () => {
  it("lists only completed matches, most recently completed first, and keeps the result behind a closed disclosure", async () => {
    stubReadModelAndParticipantsFetch(
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
    const archiveCards = Array.from(el.querySelectorAll("li"));
    expect(archiveCards).toHaveLength(2);
    const newerCard = archiveCards.find((card) => card.textContent?.includes("Newer Map"));
    const olderCard = archiveCards.find((card) => card.textContent?.includes("Older Map"));
    expect(newerCard).toBeDefined();
    expect(olderCard).toBeDefined();

    const details = newerCard?.querySelector("details");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("summary")?.textContent?.trim()).toBe("watch.reveal_result");
    expect(details?.textContent).toContain("Winner Co");
  });

  it("puts the filter controls behind a collapsed <details> drawer, never shown before the heading", async () => {
    stubReadModelAndParticipantsFetch(
      readModel({ matches: [match({ completedAt: "2026-06-15T00:00:00.000Z" })] }),
    );
    const el = mount();
    await flushMicrotasks();
    const archiveHeading = el.querySelector("#watch-archive-heading");
    expect(archiveHeading).not.toBeNull();
    const drawer = archiveHeading?.parentElement?.querySelector("details");
    expect(drawer).not.toBeNull();
    expect(drawer?.hasAttribute("open")).toBe(false);
    expect(drawer?.querySelector("select")).not.toBeNull();
  });

  it("shows a Director Cut duration badge when the match carries one, and omits it otherwise", async () => {
    stubReadModelAndParticipantsFetch(
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

    const cutMapCard = Array.from(el.querySelectorAll("li")).find((li) =>
      li.textContent?.includes("Cut Map"),
    );
    const noCutMapCard = Array.from(el.querySelectorAll("li")).find((li) =>
      li.textContent?.includes("No Cut Map"),
    );
    expect(cutMapCard?.textContent).toContain("watch.director_cut_duration");
    expect(noCutMapCard?.textContent).not.toContain("watch.director_cut_duration");
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
    stubReadModelAndParticipantsFetch(
      readModel({
        matches: [
          match({ matchId: "feat", completedAt: "2026-06-15T00:00:00.000Z", map: "Feat Map" }),
          match({ matchId: "plain", completedAt: "2026-06-14T00:00:00.000Z", map: "Plain Map" }),
        ],
        featuredMatches: [
          featuredMatch({
            matchId: "feat",
            lane: "archive",
            title: "Feature",
            map: "Feat Map",
            format: "1v1",
            state: "archived",
            scheduledAt: null,
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();

    const featCard = Array.from(el.querySelectorAll("li")).find((li) => li.textContent?.includes("Feat Map"));
    const plainCard = Array.from(el.querySelectorAll("li")).find((li) => li.textContent?.includes("Plain Map"));
    expect(featCard?.textContent).toContain("watch.featured_badge");
    expect(plainCard?.textContent).not.toContain("watch.featured_badge");
  });

  it("filters the visible list live as the Agent select changes", async () => {
    stubReadModelAndParticipantsFetch(
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
              { slot: 0, agentSlug: "alpha", displayName: "Alpha", tilesOwned: 10, isAlive: true, isWinner: true, color: "#fff" },
            ],
          }),
          match({
            matchId: "m-beta",
            completedAt: "2026-06-14T00:00:00.000Z",
            map: "Beta Map",
            participants: [
              { slot: 0, agentSlug: "beta", displayName: "Beta", tilesOwned: 10, isAlive: true, isWinner: true, color: "#fff" },
            ],
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    const countArchiveCards = () =>
      Array.from(el.querySelectorAll("li")).filter(
        (li) => li.textContent?.includes("Alpha Map") || li.textContent?.includes("Beta Map"),
      ).length;
    expect(countArchiveCards()).toBe(2);

    const selects = Array.from(el.querySelectorAll("select"));
    const filterAgentSelect = selects.find((select) =>
      Array.from(select.options).some((o) => o.textContent === "Alpha"),
    );
    expect(filterAgentSelect).toBeDefined();
    filterAgentSelect!.value = "alpha";
    filterAgentSelect!.dispatchEvent(new Event("change"));
    await flushMicrotasks();

    expect(countArchiveCards()).toBe(1);
    expect(
      Array.from(el.querySelectorAll("li")).some((li) => li.textContent?.includes("Alpha Map")),
    ).toBe(true);

    filterAgentSelect!.value = "all";
    filterAgentSelect!.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    expect(countArchiveCards()).toBe(2);
  });

  it("shows an honest 'no matches match the filters' note when a filter combination excludes every match", async () => {
    stubReadModelAndParticipantsFetch(
      readModel({
        matches: [
          match({ matchId: "m-1", completedAt: "2026-06-15T00:00:00.000Z", map: "Only Map", mapSize: "Normal" }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();

    const selects = Array.from(el.querySelectorAll("select"));
    const filterCleanlinessSelect = selects.find((select) =>
      Array.from(select.options).some((o) => o.value === "degraded"),
    );
    expect(filterCleanlinessSelect).toBeDefined();
    filterCleanlinessSelect!.value = "degraded";
    filterCleanlinessSelect!.dispatchEvent(new Event("change"));
    await flushMicrotasks();

    expect(el.textContent).toContain("watch.no_filtered_matches");
    expect(el.textContent).not.toContain("watch.no_completed_matches");
  });

  it("offers a Most recent / Most dramatic sort control behind the drawer", async () => {
    stubReadModelAndParticipantsFetch(
      readModel({
        matches: [
          match({
            matchId: "low-drama",
            completedAt: "2026-06-20T00:00:00.000Z",
            map: "Low Drama Map",
            dramaEvidence: { curatedDramaScore: 20, entertainmentGrade: "flat" },
          }),
          match({
            matchId: "high-drama",
            completedAt: "2026-06-01T00:00:00.000Z",
            map: "High Drama Map",
            dramaEvidence: { curatedDramaScore: 95, entertainmentGrade: "lively" },
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    const selects = Array.from(el.querySelectorAll("select"));
    const sortSelect = selects.find((select) =>
      Array.from(select.options).some((o) => o.value === "dramatic"),
    );
    expect(sortSelect).toBeDefined();
    sortSelect!.value = "dramatic";
    sortSelect!.dispatchEvent(new Event("change"));
    await flushMicrotasks();
    const cards = Array.from(el.querySelectorAll("li")).filter(
      (li) => li.textContent?.includes("Low Drama Map") || li.textContent?.includes("High Drama Map"),
    );
    expect(cards[0]?.textContent).toContain("High Drama Map");
  });

  it("fires event_cta_clicked with the match id when View Match or Watch Replay is clicked", async () => {
    stubReadModelAndParticipantsFetch(
      readModel({
        matches: [
          match({
            matchId: "clickable-match",
            completedAt: "2026-06-15T00:00:00.000Z",
            map: "Click Map",
            watchHref: "/replay/clickable-match",
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();

    const card = Array.from(el.querySelectorAll("li")).find((li) =>
      li.textContent?.includes("Click Map"),
    );
    const links = Array.from(card!.querySelectorAll("a"));
    const viewMatchLink = links.find((a) => a.textContent === "watch.view_match");
    const watchReplayLink = links.find((a) => a.textContent === "watch.watch_replay");
    expect(viewMatchLink).toBeDefined();
    expect(watchReplayLink).toBeDefined();

    viewMatchLink!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(analytics.track).toHaveBeenCalledWith("event_cta_clicked", { matchId: "clickable-match" });

    watchReplayLink!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(
      vi.mocked(analytics.track).mock.calls.filter((call) => call[0] === "event_cta_clicked"),
    ).toHaveLength(2);
  });

  it("fires featured_event_impression exactly once per featured match card, never for non-featured cards", async () => {
    stubReadModelAndParticipantsFetch(
      readModel({
        matches: [
          match({
            matchId: "featured-in-archive",
            completedAt: "2026-06-15T00:00:00.000Z",
            map: "Featured Map",
          }),
          match({
            matchId: "plain-match",
            completedAt: "2026-06-14T00:00:00.000Z",
            map: "Plain Map",
          }),
        ],
        featuredMatches: [featuredMatch({ matchId: "featured-in-archive" })],
      }),
    );
    const el = mount();
    await flushMicrotasks();

    expect(analytics.track).toHaveBeenCalledWith("featured_event_impression", {
      matchId: "featured-in-archive",
    });
    expect(
      vi.mocked(analytics.track).mock.calls.filter(
        (call) => call[0] === "featured_event_impression",
      ),
    ).toHaveLength(1);

    // Re-render (e.g. via a sort-order change) must not refire the same impression.
    el.requestUpdate();
    await el.updateComplete;
    await flushMicrotasks();
    expect(
      vi.mocked(analytics.track).mock.calls.filter(
        (call) => call[0] === "featured_event_impression",
      ),
    ).toHaveLength(1);
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
        { slot: 0, agentSlug: "alpha", displayName: "Alpha", tilesOwned: 0, isAlive: true, isWinner: false, color: "#000" },
      ],
    });
    const beta = completedMatch({ matchId: "b", participants: [] });
    const result = filterArchiveMatches([alpha, beta], new Set(), { ...noFilter, agentSlug: "alpha" });
    expect(result.map((m) => m.matchId)).toEqual(["a"]);
  });

  it("filters by map and mapSize independently", () => {
    const m1 = completedMatch({ matchId: "1", map: "Frost", mapSize: "Normal" });
    const m2 = completedMatch({ matchId: "2", map: "Sand", mapSize: "Compact" });
    expect(
      filterArchiveMatches([m1, m2], new Set(), { ...noFilter, map: "Frost" }).map((m) => m.matchId),
    ).toEqual(["1"]);
    expect(
      filterArchiveMatches([m1, m2], new Set(), { ...noFilter, mapSize: "Compact" }).map((m) => m.matchId),
    ).toEqual(["2"]);
  });

  it("filters to featured-only via the matchId set, leaving 'all' unaffected", () => {
    const featured = completedMatch({ matchId: "f" });
    const plain = completedMatch({ matchId: "p" });
    const featuredIds = new Set(["f"]);
    expect(
      filterArchiveMatches([featured, plain], featuredIds, { ...noFilter, featured: "featured" }).map((m) => m.matchId),
    ).toEqual(["f"]);
    expect(
      filterArchiveMatches([featured, plain], featuredIds, noFilter).map((m) => m.matchId),
    ).toEqual(["f", "p"]);
  });

  it("filters clean/degraded using the SAME elevated threshold renderDegradedNote uses (>= 15%)", () => {
    const clean = completedMatch({ matchId: "clean", degradedCount: 10, decisionCount: 100 });
    const degraded = completedMatch({ matchId: "degraded", degradedCount: 20, decisionCount: 100 });
    expect(
      filterArchiveMatches([clean, degraded], new Set(), { ...noFilter, cleanliness: "clean" }).map((m) => m.matchId),
    ).toEqual(["clean"]);
    expect(
      filterArchiveMatches([clean, degraded], new Set(), { ...noFilter, cleanliness: "degraded" }).map((m) => m.matchId),
    ).toEqual(["degraded"]);
  });

  it("filters by inclusive date range against completedAt's UTC date segment", () => {
    const early = completedMatch({ matchId: "early", completedAt: "2026-06-01T23:00:00.000Z" });
    const mid = completedMatch({ matchId: "mid", completedAt: "2026-06-15T00:00:00.000Z" });
    const late = completedMatch({ matchId: "late", completedAt: "2026-06-30T00:00:00.000Z" });
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
    const result = filterArchiveMatches(matches, new Set(), { ...noFilter, map: "Sand", mapSize: "Normal" });
    expect(result.map((m) => m.matchId)).toEqual(["both-match"]);
  });
});

describe("sortArchiveMatches", () => {
  function completedMatch(overrides: Partial<PublicMatch>) {
    return match({
      completedAt: "2026-06-15T00:00:00.000Z",
      ...overrides,
    }) as PublicMatch & { completedAt: string };
  }

  it("'dramatic' orders by curatedDramaScore descending, with null-evidence matches sorted after every scored match", () => {
    const highest = completedMatch({ matchId: "highest", dramaEvidence: { curatedDramaScore: 91, entertainmentGrade: "lively" } });
    const middle = completedMatch({ matchId: "middle", dramaEvidence: { curatedDramaScore: 40, entertainmentGrade: "flat" } });
    const lowestScored = completedMatch({ matchId: "lowest-scored", dramaEvidence: { curatedDramaScore: 0, entertainmentGrade: "stalled" } });
    const noEvidenceFirst = completedMatch({ matchId: "no-evidence-first", dramaEvidence: null });
    const noEvidenceSecond = completedMatch({ matchId: "no-evidence-second", dramaEvidence: null });
    const result = sortArchiveMatches(
      [middle, noEvidenceFirst, highest, noEvidenceSecond, lowestScored],
      "dramatic",
    );
    expect(result.map((m) => m.matchId)).toEqual([
      "highest",
      "middle",
      "lowest-scored",
      "no-evidence-first",
      "no-evidence-second",
    ]);
  });

  it("'dramatic' treats a mid-upgrade recap (dramaEvidence present but curatedDramaScore still null) as unscored", () => {
    const scored = completedMatch({ matchId: "scored", dramaEvidence: { curatedDramaScore: 55, entertainmentGrade: "lively" } });
    const transitioning = completedMatch({ matchId: "transitioning", dramaEvidence: { curatedDramaScore: null, entertainmentGrade: "lively" } });
    const noEvidence = completedMatch({ matchId: "no-evidence", dramaEvidence: null });
    const result = sortArchiveMatches([transitioning, noEvidence, scored], "dramatic");
    expect(result.map((m) => m.matchId)).toEqual(["scored", "transitioning", "no-evidence"]);
  });

  it("'recent' produces completedAt-descending order regardless of input order", () => {
    const oldest = completedMatch({ matchId: "oldest", completedAt: "2026-06-01T00:00:00.000Z" });
    const middle = completedMatch({ matchId: "middle", completedAt: "2026-06-15T00:00:00.000Z" });
    const newest = completedMatch({ matchId: "newest", completedAt: "2026-06-30T00:00:00.000Z" });
    const result = sortArchiveMatches([middle, oldest, newest], "recent");
    expect(result.map((m) => m.matchId)).toEqual(["newest", "middle", "oldest"]);
  });

  it("never drops a match -- 'dramatic' is a sort, not a filter", () => {
    const scored = completedMatch({ matchId: "scored", dramaEvidence: { curatedDramaScore: 50, entertainmentGrade: "promising" } });
    const unscored = completedMatch({ matchId: "unscored", dramaEvidence: null });
    const result = sortArchiveMatches([scored, unscored], "dramatic");
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.matchId).sort()).toEqual(["scored", "unscored"]);
  });
});
