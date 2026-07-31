/**
 * Component coverage for the `/builders` directory: with 0 seeded
 * `BuilderProfile`s (today's real read-model state, per the identity
 * registry work landed so far) it must render honest empty copy — never a
 * blank screen or a fabricated placeholder builder — and once builders
 * exist each renders a labeled, status-badged link to `/builder/:slug`.
 * Follows the mount-into-jsdom convention in
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

function readModelBody(builders: unknown[]) {
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
    agents: [],
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
});
