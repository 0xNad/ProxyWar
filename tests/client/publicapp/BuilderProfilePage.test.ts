/**
 * Component coverage for `/builder/:slug`: with 0 seeded `BuilderProfile`s
 * (today's real read-model state) any slug must render an honest
 * not-found state, never throw or blank-screen. Once a builder exists it
 * must be found by slug and its "Agents" section must come SOLELY from
 * cross-referencing `ReadModel.agents` by `builderId` — never from a field
 * on the builder record itself. Follows the mount-into-jsdom convention in
 * `tests/client/publicapp/AboutPage.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/client/Utils")>()),
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));
import "../../../src/client/publicapp/BuilderProfilePage";
import type { BuilderProfilePage } from "../../../src/client/publicapp/BuilderProfilePage";

function mount(slug: string): BuilderProfilePage {
  const el = document.createElement(
    "builder-profile-page",
  ) as BuilderProfilePage;
  el.slug = slug;
  document.body.append(el);
  return el;
}

/** Drains pending microtasks — deterministic, not a real-time wait. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function minimalBuilder(overrides: {
  id: string;
  slug: string;
  displayName: string | null;
  shortBio: string | null;
  status: "verified" | "house" | "unclaimed";
}) {
  return { avatarUrl: null, ...overrides };
}

function minimalAgent(overrides: {
  id: string;
  slug: string | null;
  playerName: string;
  displayName: string;
  shortCode: string | null;
  builderId: string | null;
  registered: boolean;
  rank: number | null;
}) {
  return {
    registered: overrides.registered,
    id: overrides.id,
    slug: overrides.slug,
    playerName: overrides.playerName,
    displayName: overrides.displayName,
    shortCode: overrides.shortCode,
    emblemSvg: null,
    primaryColor: null,
    secondaryColor: null,
    tagline: null,
    builderId: overrides.builderId,
    builderDisplayName: null,
    status: overrides.registered ? "verified" : "unregistered",
    standing:
      overrides.rank === null
        ? null
        : {
            rank: overrides.rank,
            score: null,
            roundsPlayed: null,
            isHouse: false,
          },
    activeVersion: null,
    provenance: { ratingPolicyLabel: null, activeChampionPolicyLabel: null },
    stats: null,
  };
}

function readModelBody(builders: unknown[], agents: unknown[]) {
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
    builders,
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

describe("builder-profile-page", () => {
  it("renders an honest not-found state when 0 builders are seeded, with a Browse builders recovery CTA to /builders (P2 2026-08-02)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(readModelBody([], []))),
    );
    const el = mount("daveey");
    await flushMicrotasks();

    expect(el.querySelector("h1")?.textContent).toBe("daveey");
    expect(el.textContent).toContain("builder_profile.not_found_body");
    const cta = el.querySelector<HTMLAnchorElement>('main a[href="/builders"]');
    expect(cta).not.toBeNull();
    expect(cta!.textContent).toContain("builder_profile.not_found_cta");
  });

  it("renders not-found when the slug matches no builder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody(
            [
              minimalBuilder({
                id: "builder-1",
                slug: "daveey",
                displayName: "Daveey",
                shortBio: null,
                status: "verified",
              }),
            ],
            [],
          ),
        ),
      ),
    );
    const el = mount("no-such-builder");
    await flushMicrotasks();

    expect(el.textContent).toContain("builder_profile.not_found_body");
  });

  it("finds the builder by slug and lists only agents cross-referenced by builderId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody(
            [
              minimalBuilder({
                id: "builder-1",
                slug: "daveey",
                displayName: "Daveey",
                shortBio: "Runs the reference agent.",
                status: "verified",
              }),
            ],
            [
              minimalAgent({
                id: "agent-1",
                slug: "odin-free",
                playerName: "odin-free",
                displayName: "Odin",
                shortCode: "ODN",
                builderId: "builder-1",
                registered: true,
                rank: 3,
              }),
              minimalAgent({
                id: "agent-2",
                slug: "other-agent",
                playerName: "other-agent",
                displayName: "Other",
                shortCode: "OTH",
                builderId: "builder-2",
                registered: true,
                rank: 1,
              }),
            ],
          ),
        ),
      ),
    );
    const el = mount("daveey");
    await flushMicrotasks();

    expect(el.querySelector("h1")?.textContent).toContain("Daveey");
    expect(el.textContent).toContain("Runs the reference agent.");

    const agentLink = el.querySelector('a[href="/agent/odin-free"]');
    expect(agentLink).not.toBeNull();
    expect(agentLink?.textContent).toContain("Odin");
    expect(agentLink?.textContent).toContain("ODN");
    expect(agentLink?.textContent).toContain("#3");

    // Different builderId must never leak into this builder's list.
    expect(el.querySelector('a[href="/agent/other-agent"]')).toBeNull();
    expect(el.textContent).not.toContain("Other");
  });

  it("shows a builder-dashboard 'manage' link only for a verified builder, never for an unclaimed one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody(
            [
              minimalBuilder({
                id: "builder-1",
                slug: "daveey",
                displayName: "Daveey",
                shortBio: null,
                status: "verified",
              }),
            ],
            [],
          ),
        ),
      ),
    );
    const el = mount("daveey");
    await flushMicrotasks();
    const manageLink = el.querySelector<HTMLAnchorElement>(
      'a[href="/builder-dashboard"]',
    );
    expect(manageLink?.textContent).toContain("builder_profile.manage_link");

    document.body.innerHTML = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody(
            [
              minimalBuilder({
                id: "builder-2",
                slug: "unclaimed-team",
                displayName: null,
                shortBio: null,
                status: "unclaimed",
              }),
            ],
            [],
          ),
        ),
      ),
    );
    const unclaimedEl = mount("unclaimed-team");
    await flushMicrotasks();
    expect(
      unclaimedEl.querySelector('a[href="/builder-dashboard"]'),
    ).toBeNull();
  });

  it("shows an honest empty-agents message when no agent cross-references this builder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody(
            [
              minimalBuilder({
                id: "builder-1",
                slug: "daveey",
                displayName: "Daveey",
                shortBio: null,
                status: "verified",
              }),
            ],
            [],
          ),
        ),
      ),
    );
    const el = mount("daveey");
    await flushMicrotasks();

    expect(el.textContent).toContain(
      "builder_profile.no_agents",
    );
  });

  it("includes the app-shell header (active builders) and footer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(readModelBody([], []))),
    );
    const el = mount("daveey");
    await flushMicrotasks();

    expect(el.querySelector("header")).not.toBeNull();
    expect(el.querySelector("footer")).not.toBeNull();
    expect(
      el.querySelector('a[href="/builders"][aria-current="page"]'),
    ).not.toBeNull();
  });
});
