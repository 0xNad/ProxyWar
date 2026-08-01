/**
 * Coverage for `/`'s event-first hero (Season Zero activation prompt
 * Phase 5): a promotable Featured Event (live/upcoming), the best-recent-
 * Director-Cut fallback, and the honest empty state — plus the below-hero
 * modules (Season schedule, League movement, Agents to know, Recent
 * Director Cuts, Builder band) and the "no game bundle on the homepage"
 * invariant. Follows the mount-into-jsdom + stubbed global fetch
 * convention already established in `WatchPage.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import "../../../src/client/publicapp/LobbyPage";
import type { LobbyPage } from "../../../src/client/publicapp/LobbyPage";
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
      roundIntervalMinutes: 30,
      episodesPerRound: null,
      currentRoundNumber: 42,
      currentRoundStatus: "running",
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

type FeaturedEventParticipantFixture = {
  playerName: string;
  displayName: string;
  agentSlug: string | null;
  emblemSvg: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  versionLabel: string | null;
  builderId: string | null;
  builderDisplayName: string | null;
};

function participantCard(
  overrides: Partial<FeaturedEventParticipantFixture> = {},
): FeaturedEventParticipantFixture {
  return {
    playerName: "player-one",
    displayName: "Agent One",
    agentSlug: "agent-one",
    emblemSvg: null,
    primaryColor: null,
    secondaryColor: null,
    versionLabel: null,
    builderId: null,
    builderDisplayName: null,
    ...overrides,
  };
}

function stubReadModelFetch(model: ReadModel): Mock {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => model,
  }) as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Routes the global `fetch` mock by URL: the read model for
 * `read-model.json`, and a scriptable response for the narrow
 * `/api/featured-matches/:matchId` participant-identity channel —
 * `"network-error"` rejects the fetch outright, `"malformed"` resolves a
 * body that fails the client's own schema validation, and an array
 * resolves the real `{schemaVersion, participants}` shape.
 */
function stubReadModelAndFeaturedMatchFetch(
  model: ReadModel,
  participants: FeaturedEventParticipantFixture[] | "network-error" | "malformed",
): Mock {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/featured-matches/")) {
      if (participants === "network-error") {
        throw new Error("network down");
      }
      if (participants === "malformed") {
        return { ok: true, json: async () => ({ nonsense: true }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({ schemaVersion: 1, participants }),
      } as Response;
    }
    return { ok: true, json: async () => model } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mount(): LobbyPage {
  const el = document.createElement("lobby-page") as LobbyPage;
  document.body.append(el);
  return el;
}

async function flushMicrotasks(times = 15): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.mocked(analytics.track).mockClear();
});

describe("lobby-page hero: promotable event", () => {
  it("upcoming: renders the real title/subtitle/reason-to-watch, never a bare map+round card", async () => {
    stubReadModelAndFeaturedMatchFetch(
      readModel({ featuredMatches: [featuredMatch()] }),
      [],
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("Auri vs Sefirot");
    expect(el.textContent).toContain("A duel worth watching");
    expect(el.textContent).toContain("Auri debuts v43 after a strong run.");
    expect(el.textContent).toContain("lobby.upcoming_premiere_badge");
    expect(el.querySelector('a[href="/premiere/prem_abc"]')).not.toBeNull();
  });

  it("live: scheduledAt in the past flips the badge to live and the CTA to the live variant", async () => {
    stubReadModelAndFeaturedMatchFetch(
      readModel({
        featuredMatches: [
          featuredMatch({ scheduledAt: new Date(Date.now() - 60_000).toISOString() }),
        ],
      }),
      [],
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.live_premiere_badge");
    expect(el.textContent).toContain("lobby.event_stage_watch_live_cta");
    expect(el.textContent).not.toContain("lobby.upcoming_premiere_badge");
  });

  it("ignores a non-promotable featured match — never treats an incomplete package as the hero", async () => {
    stubReadModelFetch(
      readModel({
        featuredMatches: [featuredMatch({ isPubliclyPromotable: false })],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).not.toContain("Auri vs Sefirot");
  });

  it("ignores a promotable featured match not yet published (scheduled state)", async () => {
    stubReadModelFetch(
      readModel({
        featuredMatches: [featuredMatch({ state: "scheduled" })],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).not.toContain("Auri vs Sefirot");
  });

  it("ignores an archive-lane featured match for the hero spotlight (archive belongs to Recent Director Cuts)", async () => {
    stubReadModelFetch(
      readModel({
        featuredMatches: [featuredMatch({ lane: "archive", scheduledAt: null })],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).not.toContain("Auri vs Sefirot");
  });

  it("renders the Director Cut runtime once known", async () => {
    stubReadModelAndFeaturedMatchFetch(
      readModel({ featuredMatches: [featuredMatch({ directorCutEstimateSeconds: 420 })] }),
      [],
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.event_stage_director_cut_runtime:{\"minutes\":7}");
  });

  it("renders participant lineup once the narrow route resolves a non-empty roster", async () => {
    stubReadModelAndFeaturedMatchFetch(
      readModel({ featuredMatches: [featuredMatch()] }),
      [
        participantCard({
          displayName: "Auri",
          emblemSvg: '<svg data-test-emblem="auri"></svg>',
          versionLabel: "v43",
        }),
        participantCard({ displayName: "Sefirot", agentSlug: "sefirot" }),
      ],
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.hero_participants_heading");
    expect(el.textContent).toContain("Auri");
    expect(el.innerHTML).toContain('data-test-emblem="auri"');
    expect(el.textContent).toContain("v43");
    expect(el.textContent).toContain("Sefirot");
  });

  it("a network failure on the participant fetch degrades gracefully — event stage still renders, no crash", async () => {
    stubReadModelAndFeaturedMatchFetch(
      readModel({ featuredMatches: [featuredMatch()] }),
      "network-error",
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("Auri vs Sefirot");
    expect(el.textContent).not.toContain("lobby.hero_participants_heading");
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("a malformed participant response degrades the same as a network failure", async () => {
    stubReadModelAndFeaturedMatchFetch(
      readModel({ featuredMatches: [featuredMatch()] }),
      "malformed",
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("Auri vs Sefirot");
    expect(el.textContent).not.toContain("lobby.hero_participants_heading");
  });
});

describe("lobby-page hero analytics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires featured_event_impression once for the hero's matchId, not again on a later re-render of the same event", async () => {
    stubReadModelAndFeaturedMatchFetch(
      readModel({ featuredMatches: [featuredMatch({ matchId: "feat_impr" })] }),
      [],
    );
    mount();
    await flushMicrotasks();
    expect(analytics.track).toHaveBeenCalledWith("featured_event_impression", {
      eventSlug: "feat_impr",
    });
    expect(
      vi.mocked(analytics.track).mock.calls.filter(
        (call) => call[0] === "featured_event_impression",
      ),
    ).toHaveLength(1);
    // The 1s tick re-renders the hero (countdown/elapsed note) without
    // changing the hero's matchId — the impression must not re-fire.
    vi.advanceTimersByTime(3000);
    await flushMicrotasks();
    expect(
      vi.mocked(analytics.track).mock.calls.filter(
        (call) => call[0] === "featured_event_impression",
      ),
    ).toHaveLength(1);
  });

  it("clicking the hero watch CTA fires event_cta_clicked with the hero's matchId", async () => {
    stubReadModelAndFeaturedMatchFetch(
      readModel({ featuredMatches: [featuredMatch({ matchId: "feat_cta" })] }),
      [],
    );
    const el = mount();
    await flushMicrotasks();
    const cta = el.querySelector('a[href="/premiere/prem_abc"]') as HTMLAnchorElement | null;
    expect(cta).not.toBeNull();
    cta!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(analytics.track).toHaveBeenCalledWith("event_cta_clicked", {
      eventSlug: "feat_cta",
    });
  });
});

describe("lobby-page hero: Director Cut fallback (no promotable event)", () => {
  it("leads with the best recent Director Cut, showing competitors, runtime, and reason to watch — never a bare map+round card", async () => {
    stubReadModelFetch(
      readModel({
        matches: [
          match({
            matchId: "m_high_drama",
            map: "Ashfields",
            completedAt: "2026-07-01T00:00:00.000Z",
            fullRenderHref: "/render/m_high_drama",
            directorCut: { durationEstimateSeconds: 300, segmentCount: 5 },
            dramaEvidence: { curatedDramaScore: 88, entertainmentGrade: "dramatic" },
            participants: [
              { slot: 0, agentSlug: "agent-one", displayName: "Agent One", tilesOwned: 10, isAlive: true, isWinner: true, color: "#111" },
            ],
          }),
        ],
        agents: [agent({ slug: "agent-one", displayName: "Agent One", emblemSvg: "<svg data-test-emblem=\"fallback\"></svg>" })],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.recent_battle_badge");
    expect(el.textContent).toContain("lobby.high_drama_badge");
    expect(el.textContent).toContain("Ashfields");
    expect(el.textContent).toContain("lobby.event_stage_director_cut_runtime:{\"minutes\":5}");
    expect(el.textContent).toContain("Agent One");
    expect(el.innerHTML).toContain('data-test-emblem="fallback"');
    expect(el.textContent).toContain("lobby.event_stage_director_cut_cta:{\"minutes\":5}");
  });

  it("shows the next expected schedule window from the active season when one exists", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    stubReadModelFetch(
      readModel({
        matches: [match({ fullRenderHref: "/render/m1" })],
        seasons: [
          season({ eventSlots: [{ featuredMatchId: "feat_zzz", scheduledAt: future }] }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.next_expected_window");
  });

  it("omits the next-expected-window line when no future slot exists", async () => {
    stubReadModelFetch(
      readModel({ matches: [match({ fullRenderHref: "/render/m1" })] }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).not.toContain("lobby.next_expected_window");
  });

  it("falls back to the honest empty state when there is no watchable match at all", async () => {
    stubReadModelFetch(readModel({}));
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.no_premiere_title");
  });
});

describe("lobby-page season schedule module", () => {
  it("renders the active season's title, dates, and upcoming slots, resolving titles against featuredMatches", async () => {
    stubReadModelFetch(
      readModel({
        featuredMatches: [featuredMatch({ matchId: "feat_slot1" })],
        seasons: [
          season({
            eventSlots: [
              { featuredMatchId: "feat_slot1", scheduledAt: "2026-08-08T18:00:00.000Z" },
            ],
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.season_schedule_heading");
    expect(el.textContent).toContain("Auri vs Sefirot");
  });

  it("2026-08-01 P0: a premiere-lane slot shows a 'Premieres' label, never a bare date", async () => {
    stubReadModelFetch(
      readModel({
        featuredMatches: [featuredMatch({ matchId: "feat_slot1", lane: "premiere" })],
        seasons: [
          season({
            eventSlots: [
              { featuredMatchId: "feat_slot1", scheduledAt: "2026-08-08T18:00:00.000Z" },
            ],
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.season_schedule_premiere_label");
    expect(el.textContent).not.toContain("lobby.season_schedule_spotlight_label");
    expect(el.textContent).not.toContain("lobby.season_schedule_played_note");
  });

  it("2026-08-01 P0: an archive-lane slot shows a 'Featured spotlight' label plus the honest played-on date, never implying a future contest", async () => {
    stubReadModelFetch(
      readModel({
        featuredMatches: [
          featuredMatch({
            matchId: "feat_slot1",
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
              // exact real-world scenario the P0 review flagged.
              { featuredMatchId: "feat_slot1", scheduledAt: "2026-08-03T18:00:00.000Z" },
            ],
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.season_schedule_spotlight_label");
    expect(el.textContent).toContain("lobby.season_schedule_played_note");
    expect(el.textContent).not.toContain("lobby.season_schedule_premiere_label");
  });

  it("shows a TBD placeholder for a slot whose featuredMatchId doesn't resolve", async () => {
    stubReadModelFetch(
      readModel({
        seasons: [
          season({
            eventSlots: [{ featuredMatchId: "feat_unresolved", scheduledAt: "2026-08-08T18:00:00.000Z" }],
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.season_schedule_tbd");
  });

  it("renders nothing when no season is active", async () => {
    stubReadModelFetch(readModel({ seasons: [season({ state: "completed" })] }));
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).not.toContain("lobby.season_schedule_heading");
  });
});

describe("lobby-page league movement module", () => {
  it("flags a rank improvement with an up arrow and a version debut badge", async () => {
    stubReadModelFetch(
      readModel({
        agents: [
          agent({
            slug: "mover",
            displayName: "Mover",
            standing: { rank: 1, score: 10, roundsPlayed: 5, isHouse: false },
            timeSeries: {
              winrate: null,
              score: {
                points: [
                  { recordedAt: "t1", score: 5, rank: 3, activeVersionLabel: "v1", versionFirstObserved: false },
                  { recordedAt: "t2", score: 10, rank: 1, activeVersionLabel: "v2", versionFirstObserved: true },
                ],
                recordedSince: "t1",
                methodology: "x",
              },
            },
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.league_movement_heading");
    expect(el.textContent).toContain("lobby.rank_change_up:{\"delta\":2}");
    expect(el.textContent).toContain("lobby.version_debut_badge");
  });

  it("shows no delta badge for an agent with fewer than two recorded score points", async () => {
    stubReadModelFetch(
      readModel({
        agents: [
          agent({
            slug: "steady",
            standing: { rank: 2, score: 8, roundsPlayed: 3, isHouse: false },
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).not.toContain("lobby.rank_change_up");
    expect(el.textContent).not.toContain("lobby.rank_change_down");
  });
});

describe("lobby-page agents-to-know module", () => {
  it("prioritizes a real tagline over a bare win count", async () => {
    stubReadModelFetch(
      readModel({
        agents: [
          agent({
            slug: "stylist",
            displayName: "Stylist",
            tagline: "Aggressive early-game expansion, ruthless alliances.",
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("Aggressive early-game expansion, ruthless alliances.");
    expect(el.textContent).not.toContain("lobby.recent_wins");
  });

  it("falls back to win count for an agent with no tagline", async () => {
    stubReadModelFetch(
      readModel({
        matches: [
          match({ matchId: "m1", winnerAgentSlug: "grinder" }),
          match({ matchId: "m2", winnerAgentSlug: "grinder" }),
        ],
        agents: [agent({ slug: "grinder", displayName: "Grinder", tagline: null })],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.recent_wins:{\"count\":2}");
  });
});

describe("lobby-page recent Director Cuts module", () => {
  it("renders participant chips on each card, joined against agents[] for emblems", async () => {
    stubReadModelFetch(
      readModel({
        matches: [
          match({
            matchId: "m_recent",
            completedAt: "2026-07-05T00:00:00.000Z",
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
    expect(el.textContent).toContain("lobby.recent_broadcasts_heading");
    expect(el.textContent).toContain("Agent One");
  });
});

describe("lobby-page loads no game bundle", () => {
  it("only ever fetches the read model JSON and the narrow participant route — never a replay/game asset", async () => {
    const fetchMock = stubReadModelAndFeaturedMatchFetch(
      readModel({ featuredMatches: [featuredMatch()] }),
      [],
    );
    mount();
    await flushMicrotasks();
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toMatch(/\.js$|assets\/|ai-league-replay|\/game\//);
    }
    expect(fetchMock).toHaveBeenCalledWith(
      "/ai-league-runs/league/read-model.json",
      expect.anything(),
    );
  });
});

describe("lobby-page hero live timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("live: the elapsed-time note ticks upward every ~1s", async () => {
    vi.setSystemTime(new Date("2026-07-31T00:00:10.000Z"));
    stubReadModelAndFeaturedMatchFetch(
      readModel({
        featuredMatches: [
          featuredMatch({ scheduledAt: "2026-07-31T00:00:00.000Z" }),
        ],
      }),
      [],
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain('lobby.live_elapsed:{"duration":"10s"}');
    vi.advanceTimersByTime(3000);
    await flushMicrotasks();
    expect(el.textContent).toContain('lobby.live_elapsed:{"duration":"13s"}');
  });

  it("upcoming: the countdown ticks downward every ~1s", async () => {
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    stubReadModelAndFeaturedMatchFetch(
      readModel({
        featuredMatches: [
          featuredMatch({ scheduledAt: "2026-07-31T00:01:00.000Z" }),
        ],
      }),
      [],
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain('lobby.countdown_value:{"duration":"1m 0s"}');
    vi.advanceTimersByTime(5000);
    await flushMicrotasks();
    expect(el.textContent).toContain('lobby.countdown_value:{"duration":"55s"}');
  });

  it("upcoming: an armed reminder fires at scheduled time — flashes the tab title, shows the live cue, marks itself fired", async () => {
    localStorage.clear();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    localStorage.setItem("proxywar:premiere-reminder:feat_fire", "armed");
    stubReadModelAndFeaturedMatchFetch(
      readModel({
        featuredMatches: [
          featuredMatch({ matchId: "feat_fire", scheduledAt: "2026-07-31T00:00:05.000Z" }),
        ],
      }),
      [],
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).not.toContain("lobby.remind_me_live_cue");
    vi.setSystemTime(new Date("2026-07-31T00:00:06.000Z"));
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(document.title.startsWith("LIVE:")).toBe(true);
    expect(el.textContent).toContain("lobby.remind_me_live_cue");
    expect(localStorage.getItem("proxywar:premiere-reminder:feat_fire")).toBe("fired");
  });
});

describe("lobby-page: Add to calendar and Remind me", () => {
  afterEach(() => {
    localStorage.clear();
  });

  function upcomingReadModel(): ReadModel {
    return readModel({
      featuredMatches: [
        featuredMatch({
          matchId: "feat_ics",
          scheduledAt: new Date(Date.now() + 600_000).toISOString(),
        }),
      ],
    });
  }

  it("Add to calendar downloads a valid ICS blob built from the event's own title", async () => {
    stubReadModelAndFeaturedMatchFetch(upcomingReadModel(), []);
    const el = mount();
    await flushMicrotasks();
    const link = el.querySelector('a[href="#"]') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    let capturedBlob: Blob | null = null;
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((obj: Blob | MediaSource) => {
        capturedBlob = obj as Blob;
        return "blob:mock-url";
      });
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(capturedBlob).not.toBeNull();
    const text = await capturedBlob!.text();
    expect(text).toContain("BEGIN:VCALENDAR");
    expect(text).toContain("SUMMARY:Auri vs Sefirot");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it("Remind me arms a localStorage flag keyed by matchId, disables re-arming, and survives a remount", async () => {
    stubReadModelAndFeaturedMatchFetch(upcomingReadModel(), []);
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.remind_me_button");
    const button = el.querySelector("button") as HTMLButtonElement;
    button.click();
    await flushMicrotasks();
    expect(localStorage.getItem("proxywar:premiere-reminder:feat_ics")).toBe("armed");
    expect(el.textContent).toContain("lobby.remind_me_armed");
    expect((el.querySelector("button") as HTMLButtonElement).disabled).toBe(true);

    document.body.innerHTML = "";
    stubReadModelAndFeaturedMatchFetch(upcomingReadModel(), []);
    const remounted = mount();
    await flushMicrotasks();
    expect(remounted.textContent).toContain("lobby.remind_me_armed");
    expect(remounted.textContent).not.toContain("lobby.remind_me_button");
  });
});
