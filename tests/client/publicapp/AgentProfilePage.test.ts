/**
 * Component coverage for `/agent/:slug`: a slug matching no `PublicAgent`
 * must render an honest not-found state (never throw, never blank-screen),
 * a matching slug must render its header/builder-line/standing/active
 * version, and the "Recent matches" section must be built solely from
 * `ReadModel.matches` filtered by `participant.agentSlug`, most recent
 * `completedAt` first. Follows the mount-into-jsdom convention in
 * `tests/client/publicapp/BuilderProfilePage.test.ts`.
 */
vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/publicapp/AgentProfilePage";
import type { AgentProfilePage } from "../../../src/client/publicapp/AgentProfilePage";

function mount(slug: string): AgentProfilePage {
  const el = document.createElement("agent-profile-page") as AgentProfilePage;
  el.slug = slug;
  document.body.append(el);
  return el;
}

/** Drains pending microtasks — deterministic, not a real-time wait. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function minimalAgent(overrides: {
  slug: string;
  playerName: string;
  displayName: string;
  shortCode: string | null;
  status: "verified" | "house" | "unclaimed";
  builderDisplayName: string | null;
  rank: number | null;
  score?: number | null;
  roundsPlayed?: number | null;
  activeVersionLabel?: string | null;
  tagline?: string | null;
}) {
  return {
    registered: true,
    id: `agt_${overrides.slug}`,
    slug: overrides.slug,
    playerName: overrides.playerName,
    displayName: overrides.displayName,
    shortCode: overrides.shortCode,
    emblemSvg: null,
    primaryColor: null,
    secondaryColor: null,
    tagline: overrides.tagline ?? null,
    builderId: null,
    builderDisplayName: overrides.builderDisplayName,
    status: overrides.status,
    standing:
      overrides.rank === null
        ? null
        : {
            rank: overrides.rank,
            score: overrides.score ?? null,
            roundsPlayed: overrides.roundsPlayed ?? null,
            isHouse: overrides.status === "house",
          },
    activeVersion:
      overrides.activeVersionLabel === undefined ||
      overrides.activeVersionLabel === null
        ? null
        : {
            publicVersionLabel: overrides.activeVersionLabel,
            source: "champion" as const,
            familyMismatch: false,
          },
    provenance: { ratingPolicyLabel: null, activeChampionPolicyLabel: null },
  };
}

function minimalMatch(overrides: {
  matchId: string;
  completedAt: string | null;
  map: string;
  participants: ReadonlyArray<{
    agentSlug: string | null;
    displayName: string;
    isAlive: boolean;
    isWinner: boolean;
  }>;
  watchHref?: string | null;
  fullRenderHref?: string | null;
}) {
  return {
    matchId: overrides.matchId,
    shortId: overrides.matchId,
    roundNumber: null,
    completedAt: overrides.completedAt,
    map: overrides.map,
    mapSize: "medium",
    turnCount: null,
    decisionCount: null,
    degradedCount: null,
    winnerAgentSlug:
      overrides.participants.find((p) => p.isWinner)?.agentSlug ?? null,
    participants: overrides.participants.map((p, i) => ({
      slot: i,
      agentSlug: p.agentSlug,
      displayName: p.displayName,
      tilesOwned: 0,
      isAlive: p.isAlive,
      isWinner: p.isWinner,
      color: "#000000",
    })),
    watchHref: overrides.watchHref ?? null,
    fullRenderHref: overrides.fullRenderHref ?? null,
    premiereHref: null,
    directorCut: null,
  };
}

function readModelBody(agents: unknown[], matches: unknown[] = []) {
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
    agents,
    versions: [],
    rounds: [],
    matches,
    featuredMatches: [],
    premieres: { live: null, latest: null },
    links: {
      enterTheLeagueUrl: "https://github.com/example/proxywar-starter",
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

describe("agent-profile-page", () => {
  it("renders an honest not-found state when the slug matches no agent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(readModelBody([]))),
    );
    const el = mount("no-such-agent");
    await flushMicrotasks();

    expect(el.querySelector("h1")?.textContent).toBe("no-such-agent");
    expect(el.textContent).toContain("agent_profile.not_found_body");
  });

  it("finds the agent by slug and renders its header, builder line, and standing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody([
            minimalAgent({
              slug: "odin-free",
              playerName: "odin-free",
              displayName: "Odin",
              shortCode: "ODN",
              status: "verified",
              builderDisplayName: "Ada",
              rank: 3,
              score: 1234.5,
              roundsPlayed: 10,
              activeVersionLabel: "v24",
            }),
          ]),
        ),
      ),
    );
    const el = mount("odin-free");
    await flushMicrotasks();

    expect(el.querySelector("h1")?.textContent).toContain("Odin");
    expect(el.textContent).toContain("ODN");
    expect(el.textContent).toContain("Ada");
    expect(el.textContent).toContain("#3");
    expect(el.textContent).toContain("1234.50");
    expect(el.textContent).toContain("v24");
  });

  it("renders 'Unclaimed' for a registered non-house agent with no builder claim, and skips the builder line for a house agent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody([
            minimalAgent({
              slug: "unclaimed-agent",
              playerName: "unclaimed-agent",
              displayName: "Unclaimed Agent",
              shortCode: "UNC",
              status: "unclaimed",
              builderDisplayName: null,
              rank: null,
            }),
          ]),
        ),
      ),
    );
    const el = mount("unclaimed-agent");
    await flushMicrotasks();
    expect(el.textContent).toContain("agent_profile.builder_unclaimed");

    document.body.innerHTML = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody([
            minimalAgent({
              slug: "house-agent",
              playerName: "house-agent",
              displayName: "House Agent",
              shortCode: "HSE",
              status: "house",
              builderDisplayName: null,
              rank: null,
            }),
          ]),
        ),
      ),
    );
    const houseEl = mount("house-agent");
    await flushMicrotasks();
    expect(houseEl.textContent).not.toContain("agent_profile.builder_label");
  });

  it("shows up to 10 recent matches filtered by participant.agentSlug, most recent completedAt first, with outcome and a watch link", async () => {
    const matches = [
      minimalMatch({
        matchId: "m-old",
        completedAt: "2026-07-01T00:00:00.000Z",
        map: "Old Map",
        participants: [
          {
            agentSlug: "odin-free",
            displayName: "Odin",
            isAlive: false,
            isWinner: false,
          },
        ],
        watchHref: "/watch/m-old",
      }),
      minimalMatch({
        matchId: "m-new",
        completedAt: "2026-07-15T00:00:00.000Z",
        map: "New Map",
        participants: [
          {
            agentSlug: "odin-free",
            displayName: "Odin",
            isAlive: true,
            isWinner: true,
          },
        ],
        fullRenderHref: "/render/m-new",
      }),
      minimalMatch({
        matchId: "m-unrelated",
        completedAt: "2026-07-20T00:00:00.000Z",
        map: "Unrelated Map",
        participants: [
          {
            agentSlug: "someone-else",
            displayName: "Someone Else",
            isAlive: true,
            isWinner: true,
          },
        ],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody(
            [
              minimalAgent({
                slug: "odin-free",
                playerName: "odin-free",
                displayName: "Odin",
                shortCode: "ODN",
                status: "verified",
                builderDisplayName: "Ada",
                rank: 1,
              }),
            ],
            matches,
          ),
        ),
      ),
    );
    const el = mount("odin-free");
    await flushMicrotasks();

    // The unrelated match (a different agent's slug) must never appear.
    expect(el.textContent).not.toContain("Unrelated Map");

    const rows = [...el.querySelectorAll("li")].filter((li) =>
      li.textContent?.includes("Map"),
    );
    expect(rows).toHaveLength(2);
    // Most recent completedAt first.
    expect(rows[0].textContent).toContain("New Map");
    expect(rows[0].textContent).toContain("agent_profile.outcome_won");
    expect(rows[0].querySelector('a[href="/render/m-new"]')).not.toBeNull();
    expect(rows[1].textContent).toContain("Old Map");
    expect(rows[1].textContent).toContain("agent_profile.outcome_eliminated");
    expect(rows[1].querySelector('a[href="/watch/m-old"]')).not.toBeNull();
  });

  it("includes the app-shell header (active agents) and footer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(readModelBody([]))),
    );
    const el = mount("no-such-agent");
    await flushMicrotasks();

    expect(el.querySelector("header")).not.toBeNull();
    expect(el.querySelector("footer")).not.toBeNull();
    expect(
      el.querySelector('a[href="/agents"][aria-current="page"]'),
    ).not.toBeNull();
  });
});
