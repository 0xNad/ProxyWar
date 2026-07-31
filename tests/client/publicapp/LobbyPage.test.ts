/**
 * Coverage for `/`'s three hero states (Active / Upcoming / No premiere),
 * the below-hero modules (League pulse, Agents to watch, Recent broadcasts,
 * builder band), and the "no game bundle on the homepage" invariant.
 * Follows the mount-into-jsdom + stubbed global fetch convention already
 * established in `WatchPage.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import "../../../src/client/publicapp/LobbyPage";
import type { LobbyPage } from "../../../src/client/publicapp/LobbyPage";
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
    premieres: { live: null, latest: null },
    links: {
      enterTheLeagueUrl: "https://example.test/enter",
      platformLabel: "Coworld",
      accountUrl: "https://example.test/account",
    },
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

function mount(): LobbyPage {
  const el = document.createElement("lobby-page") as LobbyPage;
  document.body.append(el);
  return el;
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("lobby-page hero states", () => {
  it("state A: an active premiere shows the literal Live Premiere label and a manually-built watch link, no result leakage", async () => {
    stubReadModelFetch(
      readModel({
        premieres: {
          live: {
            premiereId: "prem_1",
            roundNumber: 7,
            mapLabel: "Ashfields",
            scheduledAt: new Date(Date.now() - 60_000).toISOString(),
            premierePageLive: true,
          },
          latest: null,
        },
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.live_premiere_badge");
    expect(el.querySelector('a[href="/premiere/prem_1"]')).not.toBeNull();
    expect(el.textContent).toContain("lobby.watch_now");
    // Never a "playing right now" / result-bearing claim beyond the label.
    expect(el.textContent).not.toContain("lobby.winner_announcement");
    expect(el.textContent).not.toContain("lobby.no_winner");
  });

  it("state B: an upcoming (not live) premiere shows View matchup, not Watch now", async () => {
    stubReadModelFetch(
      readModel({
        premieres: {
          live: {
            premiereId: "prem_2",
            roundNumber: 8,
            mapLabel: "Britannia",
            scheduledAt: new Date(Date.now() + 600_000).toISOString(),
            premierePageLive: false,
          },
          latest: null,
        },
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.upcoming_premiere_badge");
    expect(el.textContent).toContain("lobby.view_matchup");
    expect(el.textContent).not.toContain("lobby.watch_now");
    expect(el.textContent).not.toContain("lobby.live_premiere_badge");
  });

  it("state C (with a latest revealed premiere): falls back to the archived premiere, not a drama-score claim", async () => {
    stubReadModelFetch(
      readModel({
        premieres: {
          live: null,
          latest: {
            premiereId: "prem_0",
            roundNumber: 6,
            mapLabel: "Pangaea",
            revealedAt: "2026-06-30T00:00:00.000Z",
            href: "/premiere/prem_0",
          },
        },
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.latest_premiere_badge");
    expect(el.querySelector('a[href="/premiere/prem_0"]')).not.toBeNull();
  });

  it("state C (nothing at all): falls back to the most recent completed+renderable match, and never claims a drama score", async () => {
    stubReadModelFetch(
      readModel({
        matches: [
          match({
            matchId: "old",
            completedAt: "2026-06-01T00:00:00.000Z",
            fullRenderHref: "/ai-league-replay/old",
          }),
          match({
            matchId: "new",
            completedAt: "2026-06-15T00:00:00.000Z",
            fullRenderHref: "/ai-league-replay/new",
            map: "Iceland",
          }),
        ],
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.recent_battle_badge");
    expect(el.textContent).toContain("Iceland");
    expect(el.querySelector('a[href="/ai-league-replay/new"]')).not.toBeNull();
    expect(el.textContent?.toLowerCase()).not.toContain("drama");
  });

  it("state C with no matches at all: an honest empty note, never a fabricated hero", async () => {
    stubReadModelFetch(readModel({}));
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.no_premiere_title");
  });
});

describe("lobby-page below-hero modules", () => {
  it("League pulse shows only the top 5 ranked agents, sorted by rank", async () => {
    const agents = Array.from({ length: 7 }, (_, i) =>
      agent({
        slug: `agent-${i + 1}`,
        displayName: `Agent ${i + 1}`,
        standing: { rank: i + 1, score: 10 - i, roundsPlayed: 50, isHouse: false },
      }),
    );
    stubReadModelFetch(readModel({ agents }));
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("Agent 1");
    expect(el.textContent).toContain("Agent 5");
    expect(el.textContent).not.toContain("Agent 6");
    expect(el.textContent).not.toContain("Agent 7");
  });

  it("Agents to watch only lists agents with 2+ recent wins — evidence-based, not fabricated", async () => {
    const agents = [
      agent({ slug: "winner", displayName: "Big Winner" }),
      agent({ slug: "loner", displayName: "One Win Only" }),
    ];
    const matches = [
      match({ matchId: "m1", winnerAgentSlug: "winner" }),
      match({ matchId: "m2", winnerAgentSlug: "winner" }),
      match({ matchId: "m3", winnerAgentSlug: "loner" }),
    ];
    stubReadModelFetch(readModel({ agents, matches }));
    const el = mount();
    await flushMicrotasks();
    const agentsToWatch = el.querySelector(
      '[aria-labelledby="agents-to-watch-heading"]',
    );
    expect(agentsToWatch?.textContent).toContain("Big Winner");
    expect(agentsToWatch?.textContent).not.toContain("One Win Only");
  });

  it("Recent broadcasts render a closed-by-default Reveal result disclosure, spoiler-safe", async () => {
    const agents = [agent({ slug: "champ", displayName: "The Champ" })];
    const matches = [
      match({ matchId: "m1", winnerAgentSlug: "champ", fullRenderHref: "/r/m1" }),
    ];
    stubReadModelFetch(readModel({ agents, matches }));
    const el = mount();
    await flushMicrotasks();
    const details = el.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toContain(
      "lobby.reveal_result",
    );
    expect(details?.textContent).toContain(
      `lobby.winner_announcement:${JSON.stringify({ winner: "The Champ" })}`,
    );
  });

  it("the builder acquisition band links to the read model's own enterTheLeagueUrl, honestly labeled", async () => {
    stubReadModelFetch(
      readModel({
        links: {
          enterTheLeagueUrl: "https://github.com/example/starter",
          platformLabel: "Coworld",
          accountUrl: "https://example.test/account",
        },
      }),
    );
    const el = mount();
    await flushMicrotasks();
    const link = el.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/example/starter"]',
    );
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("lobby.starter_repo_link");
    expect(el.textContent).not.toContain("/build");
  });

  it("never mentions Battles rendered (removed vanity metric)", async () => {
    stubReadModelFetch(readModel({}));
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).not.toContain("Battles rendered");
  });
});

describe("lobby-page loads no game bundle", () => {
  it("only ever fetches the read model JSON — never a replay/game asset", async () => {
    const fetchMock = stubReadModelFetch(readModel({}));
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

  it("state A: the live elapsed-time note ticks upward every ~1s", async () => {
    vi.setSystemTime(new Date("2026-07-31T00:00:10.000Z"));
    stubReadModelFetch(
      readModel({
        premieres: {
          live: {
            premiereId: "prem_a",
            roundNumber: 1,
            mapLabel: "Ashfields",
            scheduledAt: "2026-07-31T00:00:00.000Z",
            premierePageLive: true,
          },
          latest: null,
        },
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain('lobby.live_elapsed:{"duration":"10s"}');
    vi.advanceTimersByTime(3000);
    await flushMicrotasks();
    expect(el.textContent).toContain('lobby.live_elapsed:{"duration":"13s"}');
  });

  it("state B: the live countdown ticks downward every ~1s", async () => {
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    stubReadModelFetch(
      readModel({
        premieres: {
          live: {
            premiereId: "prem_b",
            roundNumber: 2,
            mapLabel: "Britannia",
            scheduledAt: "2026-07-31T00:01:00.000Z",
            premierePageLive: false,
          },
          latest: null,
        },
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain(
      'lobby.countdown_value:{"duration":"1m 0s"}',
    );
    vi.advanceTimersByTime(5000);
    await flushMicrotasks();
    expect(el.textContent).toContain(
      'lobby.countdown_value:{"duration":"55s"}',
    );
  });

  it("state B: an armed reminder fires at scheduled time — flashes the tab title, shows the live cue, and marks itself fired (never re-prompts)", async () => {
    localStorage.clear();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    localStorage.setItem("proxywar:premiere-reminder:prem_fire", "armed");
    stubReadModelFetch(
      readModel({
        premieres: {
          live: {
            premiereId: "prem_fire",
            roundNumber: 4,
            mapLabel: "Iceland",
            scheduledAt: "2026-07-31T00:00:05.000Z",
            premierePageLive: false,
          },
          latest: null,
        },
      }),
    );
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).not.toContain("lobby.remind_me_live_cue");
    vi.setSystemTime(new Date("2026-07-31T00:00:06.000Z"));
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(document.title.startsWith("LIVE:")).toBe(true);
    expect(el.textContent).toContain("lobby.remind_me_live_cue");
    expect(el.textContent).toContain("lobby.remind_me_sent");
    expect(
      localStorage.getItem("proxywar:premiere-reminder:prem_fire"),
    ).toBe("fired");
  });
});

describe("lobby-page hero state B: Add to calendar and Remind me", () => {
  afterEach(() => {
    localStorage.clear();
  });

  function upcomingReadModel(): ReadModel {
    return readModel({
      premieres: {
        live: {
          premiereId: "prem_ics",
          roundNumber: 5,
          mapLabel: "Ashfields",
          scheduledAt: new Date(Date.now() + 600_000).toISOString(),
          premierePageLive: false,
        },
        latest: null,
      },
    });
  }

  it("Add to calendar downloads a valid ICS blob built only from round/map — never a participant name", async () => {
    stubReadModelFetch(upcomingReadModel());
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
    const revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    link!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(capturedBlob).not.toBeNull();
    const text = await capturedBlob!.text();
    expect(text).toContain("BEGIN:VCALENDAR");
    expect(text).toContain("SUMMARY:Proxy War Premiere");
    expect(text).not.toContain("daveey");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it("Remind me arms a localStorage flag, disables re-arming, and survives a remount without re-prompting", async () => {
    stubReadModelFetch(upcomingReadModel());
    const el = mount();
    await flushMicrotasks();
    expect(el.textContent).toContain("lobby.remind_me_button");
    const button = el.querySelector("button") as HTMLButtonElement;
    button.click();
    await flushMicrotasks();
    expect(
      localStorage.getItem("proxywar:premiere-reminder:prem_ics"),
    ).toBe("armed");
    expect(el.textContent).toContain("lobby.remind_me_armed");
    expect(
      (el.querySelector("button") as HTMLButtonElement).disabled,
    ).toBe(true);

    // Simulate a page reload: a fresh mount reads the same localStorage flag.
    document.body.innerHTML = "";
    stubReadModelFetch(upcomingReadModel());
    const remounted = mount();
    await flushMicrotasks();
    expect(remounted.textContent).toContain("lobby.remind_me_armed");
    expect(remounted.textContent).not.toContain("lobby.remind_me_button");
  });
});
