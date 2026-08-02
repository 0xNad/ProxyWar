/**
 * Component coverage for `/agents`: the roster must sort by
 * `standing.rank` ascending with unranked/unregistered agents pushed
 * after (never re-sorted alphabetically), a registered agent must link to
 * `/agent/<slug>` with the slug `encodeURIComponent`-escaped, and an
 * unregistered participant with NO computed provisional identity renders
 * its raw `playerName` with no profile link. An unregistered participant
 * WITH a computed provisional identity (`provisionalSlug`/
 * `provisionalEmblemSvg` — see server `ProvisionalIdentity.ts`) instead
 * gets a working `/agent/<provisionalSlug>` link and a generated emblem
 * (2026-08-01 P0 fix) — a real, currently-competing participant is never
 * an anonymous, unclickable card. Follows the mount-into-jsdom convention
 * in `tests/client/publicapp/BuilderProfilePage.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/publicapp/AgentsDirectoryPage";
import type { AgentsDirectoryPage } from "../../../src/client/publicapp/AgentsDirectoryPage";

function mount(): AgentsDirectoryPage {
  const el = document.createElement(
    "agents-directory-page",
  ) as AgentsDirectoryPage;
  document.body.append(el);
  return el;
}

/** Drains pending microtasks — deterministic, not a real-time wait. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function minimalAgent(overrides: {
  slug: string | null;
  playerName: string;
  displayName: string;
  shortCode: string | null;
  registered: boolean;
  status: "verified" | "house" | "unclaimed" | "unregistered";
  builderDisplayName: string | null;
  rank: number | null;
  score?: number | null;
}) {
  return {
    registered: overrides.registered,
    id: overrides.registered ? `agt_${overrides.slug ?? "x"}` : null,
    slug: overrides.slug,
    playerName: overrides.playerName,
    displayName: overrides.displayName,
    shortCode: overrides.shortCode,
    emblemSvg: null,
    primaryColor: null,
    secondaryColor: null,
    tagline: null,
    builderId: null,
    builderDisplayName: overrides.builderDisplayName,
    status: overrides.status,
    standing:
      overrides.rank === null
        ? null
        : {
            rank: overrides.rank,
            score: overrides.score ?? null,
            roundsPlayed: null,
            isHouse: overrides.status === "house",
          },
    activeVersion: null,
    provenance: { ratingPolicyLabel: null, activeChampionPolicyLabel: null },
    stats: null,
  };
}

function readModelBody(agents: unknown[]) {
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
    matches: [],
    featuredMatches: [],
    seasons: [],
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

describe("agents-directory-page", () => {
  it("sorts by standing.rank ascending and pushes unranked/unregistered agents after", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody([
            minimalAgent({
              slug: "second-place",
              playerName: "second-place",
              displayName: "Second Place",
              shortCode: "SEC",
              registered: true,
              status: "verified",
              builderDisplayName: "Ada",
              rank: 2,
            }),
            minimalAgent({
              slug: null,
              playerName: "raw-player",
              displayName: "raw-player",
              shortCode: null,
              registered: false,
              status: "unregistered",
              builderDisplayName: null,
              rank: null,
            }),
            minimalAgent({
              slug: "first-place",
              playerName: "first-place",
              displayName: "First Place",
              shortCode: "FIR",
              registered: true,
              status: "verified",
              builderDisplayName: "Grace",
              rank: 1,
            }),
          ]),
        ),
      ),
    );
    const el = mount();
    await flushMicrotasks();

    const names = [...el.querySelectorAll("li")].map(
      (li) => li.textContent ?? "",
    );
    expect(names).toHaveLength(3);
    expect(names[0]).toContain("First Place");
    expect(names[1]).toContain("Second Place");
    expect(names[2]).toContain("raw-player");
  });

  it("links a registered agent to /agent/<slug> with the slug escaped, and never links an unregistered participant with no computed provisional identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody([
            minimalAgent({
              slug: "odin free",
              playerName: "odin free",
              displayName: "Odin",
              shortCode: "ODN",
              registered: true,
              status: "verified",
              builderDisplayName: "Ada",
              rank: 1,
            }),
            minimalAgent({
              slug: null,
              playerName: "Raw Player",
              displayName: "Raw Player",
              shortCode: null,
              registered: false,
              status: "unregistered",
              builderDisplayName: null,
              rank: null,
            }),
          ]),
        ),
      ),
    );
    const el = mount();
    await flushMicrotasks();

    const link = el.querySelector('a[href="/agent/odin%20free"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Odin");

    const rawItem = [...el.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("Raw Player"),
    );
    expect(rawItem).toBeDefined();
    expect(rawItem?.querySelector("a")).toBeNull();
  });

  it("links an unregistered participant WITH a computed provisional identity to /agent/<provisionalSlug>, with a generated emblem — never an anonymous broken card (2026-08-01 P0 regression)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody([
            {
              ...minimalAgent({
                slug: null,
                playerName: "James Botts",
                displayName: "James Botts",
                shortCode: null,
                registered: false,
                status: "unregistered",
                builderDisplayName: null,
                rank: 16,
              }),
              provisionalSlug: "james-botts",
              provisionalEmblemSvg: '<svg data-testid="provisional-emblem"></svg>',
              provisionalPrimaryColor: "#112233",
              provisionalSecondaryColor: "#445566",
            },
          ]),
        ),
      ),
    );
    const el = mount();
    await flushMicrotasks();

    const link = el.querySelector('a[href="/agent/james-botts"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("James Botts");
    expect(
      link?.querySelector('[data-testid="provisional-emblem"]'),
    ).not.toBeNull();
    // Clearly marked as not a full registered identity — an "Unregistered"
    // badge, never confused with a claimed/verified brand.
    expect(link?.textContent).toContain(
      "agents_directory.unregistered_badge",
    );
  });

  it("shows a House badge only for a house-status agent", async () => {
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
              registered: true,
              status: "house",
              builderDisplayName: null,
              rank: 1,
            }),
            minimalAgent({
              slug: "unclaimed-agent",
              playerName: "unclaimed-agent",
              displayName: "Unclaimed Agent",
              shortCode: "UNC",
              registered: true,
              status: "unclaimed",
              builderDisplayName: null,
              rank: 2,
            }),
          ]),
        ),
      ),
    );
    const el = mount();
    await flushMicrotasks();

    const items = [...el.querySelectorAll("li")];
    const houseItem = items.find((li) =>
      li.textContent?.includes("House Agent"),
    );
    const unclaimedItem = items.find((li) =>
      li.textContent?.includes("Unclaimed Agent"),
    );
    expect(houseItem?.textContent).toContain("House");
    expect(unclaimedItem?.textContent).toContain("Unclaimed");
    // The house badge text must not leak onto the unclaimed agent's row.
    expect(
      unclaimedItem?.querySelector('span[title*="exhibition seat"]'),
    ).toBeNull();
  });

  it("includes the app-shell header (active agents) and footer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(readModelBody([]))),
    );
    const el = mount();
    await flushMicrotasks();

    expect(el.querySelector("header")).not.toBeNull();
    expect(el.querySelector("footer")).not.toBeNull();
    expect(
      el.querySelector('a[href="/agents"][aria-current="page"]'),
    ).not.toBeNull();
  });
});
