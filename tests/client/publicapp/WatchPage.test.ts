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
