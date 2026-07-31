/**
 * Component coverage for the `/builders` directory (Stage 6 item 3
 * redesign): with 0 seeded `BuilderProfile`s (today's real read-model
 * state) it must render honest empty copy — never a blank screen or a
 * fabricated placeholder builder — REAL claimed builders link to
 * `/builder/:slug`, and every REGISTERED agent with no claim yet (never
 * house agents) gets an honest "Unclaimed" slot card linking to its own
 * `/agent/:slug` profile, alongside a verification explainer pointing at
 * the real onboarding entry (`links.enterTheLeagueUrl` — no `/build`
 * route exists). Follows the mount-into-jsdom convention in
 * `tests/client/publicapp/AboutPage.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));
import "../../../src/client/publicapp/BuildersDirectoryPage";
import type { BuildersDirectoryPage } from "../../../src/client/publicapp/BuildersDirectoryPage";

function mount(): BuildersDirectoryPage {
  const el = document.createElement(
    "builders-directory-page",
  ) as BuildersDirectoryPage;
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
  slug: string | null;
  displayName: string;
  status: "verified" | "house" | "unclaimed" | "unregistered";
  builderId?: string | null;
  builderDisplayName?: string | null;
}) {
  return {
    registered: true,
    id: overrides.slug === null ? null : `agt_${overrides.slug}`,
    slug: overrides.slug,
    playerName: overrides.slug ?? overrides.displayName,
    displayName: overrides.displayName,
    shortCode: null,
    emblemSvg: null,
    primaryColor: null,
    secondaryColor: null,
    tagline: null,
    builderId: overrides.builderId ?? null,
    builderDisplayName: overrides.builderDisplayName ?? null,
    status: overrides.status,
    standing: null,
    activeVersion: null,
    provenance: { ratingPolicyLabel: null, activeChampionPolicyLabel: null },
    stats: null,
  };
}

function readModelBody(builders: unknown[], agents: unknown[] = []) {
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

describe("builders-directory-page", () => {
  it("renders honest empty copy and no builder links when 0 builders are seeded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(readModelBody([]))),
    );
    const el = mount();
    await flushMicrotasks();

    expect(el.querySelector("h1")?.textContent?.trim()).toBe(
      "builders_directory.title",
    );
    expect(el.textContent).toContain("builders_directory.empty");
    expect(el.querySelectorAll('a[href^="/builder/"]')).toHaveLength(0);
  });

  it("lists each builder linking to /builder/:slug with a displayName-or-slug label and status badge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody([
            minimalBuilder({
              id: "builder-1",
              slug: "daveey",
              displayName: "Daveey",
              shortBio: "Runs the reference agent.",
              status: "verified",
            }),
            minimalBuilder({
              id: "builder-2",
              slug: "unclaimed-team",
              displayName: null,
              shortBio: null,
              status: "unclaimed",
            }),
          ]),
        ),
      ),
    );
    const el = mount();
    await flushMicrotasks();

    const verifiedLink = el.querySelector('a[href="/builder/daveey"]');
    expect(verifiedLink).not.toBeNull();
    expect(verifiedLink?.textContent).toContain("Daveey");
    expect(verifiedLink?.textContent).toContain(
      "builders_directory.status_verified",
    );
    expect(verifiedLink?.textContent).toContain("Runs the reference agent.");

    const unclaimedLink = el.querySelector('a[href="/builder/unclaimed-team"]');
    expect(unclaimedLink).not.toBeNull();
    // No displayName -> falls back to the slug, never a blank label.
    expect(unclaimedLink?.textContent).toContain("unclaimed-team");
    expect(unclaimedLink?.textContent).toContain(
      "builders_directory.status_unclaimed",
    );
  });

  it("includes the app-shell header (active builders) and footer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(readModelBody([]))),
    );
    const el = mount();
    await flushMicrotasks();

    expect(el.querySelector("header")).not.toBeNull();
    expect(el.querySelector("footer")).not.toBeNull();
    expect(
      el.querySelector('a[href="/builders"][aria-current="page"]'),
    ).not.toBeNull();
  });

  it("shows an honest 'Unclaimed' slot card linking to /agent/:slug for every registered agent with no builder claim, never a fabricated builder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody(
            [],
            [
              minimalAgent({
                slug: "daveey",
                displayName: "daveey",
                status: "unclaimed",
              }),
            ],
          ),
        ),
      ),
    );
    const el = mount();
    await flushMicrotasks();

    const slotLink = el.querySelector('a[href="/agent/daveey"]');
    expect(slotLink).not.toBeNull();
    expect(slotLink?.textContent).toContain("daveey");
    expect(slotLink?.textContent).toContain("builders_directory.status_unclaimed");
    // Never a fabricated /builder/:slug for an unclaimed agent.
    expect(el.querySelectorAll('a[href^="/builder/"]')).toHaveLength(0);
    expect(el.textContent).toContain(
      "builders_directory.verification_explainer",
    );
    const cta = el.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/example/proxywar-starter"]',
    );
    expect(cta?.textContent).toContain("builders_directory.verification_cta");
  });

  it("excludes house agents from the unclaimed list entirely, and never shows an unclaimed slot for an agent that already has a claimed builder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody(
            [],
            [
              minimalAgent({
                slug: "house-agent",
                displayName: "House Agent",
                status: "house",
              }),
              minimalAgent({
                slug: "claimed-agent",
                displayName: "Claimed Agent",
                status: "verified",
                builderId: "bld_someone",
                builderDisplayName: "Someone",
              }),
              minimalAgent({
                slug: "genuinely-unclaimed",
                displayName: "Genuinely Unclaimed",
                status: "unclaimed",
              }),
            ],
          ),
        ),
      ),
    );
    const el = mount();
    await flushMicrotasks();

    expect(
      el.querySelector('a[href="/agent/house-agent"]'),
    ).toBeNull();
    expect(
      el.querySelector('a[href="/agent/claimed-agent"]'),
    ).toBeNull();
    expect(
      el.querySelector('a[href="/agent/genuinely-unclaimed"]'),
    ).not.toBeNull();
  });

  it("shows BOTH real claimed builders and honest unclaimed slots together, under separate headings, when both exist", async () => {
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
            [
              minimalAgent({
                slug: "still-unclaimed",
                displayName: "Still Unclaimed",
                status: "unclaimed",
              }),
            ],
          ),
        ),
      ),
    );
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("builders_directory.claimed_heading");
    expect(el.textContent).toContain("builders_directory.unclaimed_heading");
    expect(el.querySelector('a[href="/builder/daveey"]')).not.toBeNull();
    expect(
      el.querySelector('a[href="/agent/still-unclaimed"]'),
    ).not.toBeNull();
  });
});
