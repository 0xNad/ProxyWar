/**
 * Component coverage for `/builder-dashboard`: an unrecognized session
 * (401/403 from the not-yet-built `GET /api/account/builder-dashboard`)
 * must render an honest sign-in state, never a blank page; a recognized
 * session with `isVerifiedBuilder: false` must render the "not yet a
 * verified builder" state with a link to `/claim`; a verified builder's
 * agent cards must render a `degradedRate: null` as "not enough data",
 * never a fabricated 0%; and the pending-releases/claims sections render
 * only when their arrays are non-empty. Follows the mount-into-jsdom
 * convention in `tests/client/publicapp/BuilderProfilePage.test.ts`.
 *
 * The backend route this page calls does not exist yet (see
 * `BuilderDashboardPage.ts`'s own module doc) — this suite pins the
 * client's behavior against the assumed response shape so the integrator
 * has a regression net once the real route lands.
 */
vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/publicapp/BuilderDashboardPage";
import type { BuilderDashboardPage } from "../../../src/client/publicapp/BuilderDashboardPage";

function mount(): BuilderDashboardPage {
  const el = document.createElement(
    "builder-dashboard-page",
  ) as BuilderDashboardPage;
  document.body.append(el);
  return el;
}

/** Drains pending microtasks — deterministic, not a real-time wait. */
async function flushMicrotasks(times = 15): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function readModelBody() {
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

function accountBody() {
  return {
    schemaVersion: 1,
    csrfToken: "csrf-token-1",
    identity: {
      accountId: "acct_1",
      displayName: "Daveey",
      githubLogin: "daveey",
      githubAvatarUrl: null,
    },
    claims: [],
  };
}

function dashboardAgent(overrides: {
  agentId: string;
  displayName: string;
  rank?: number | null;
  score?: number | null;
  degradedRate?: number | null;
}) {
  return {
    agentId: overrides.agentId,
    slug: overrides.agentId,
    displayName: overrides.displayName,
    rank: overrides.rank ?? null,
    score: overrides.score ?? null,
    activeVersionLabel: null,
    degradedRate: overrides.degradedRate ?? null,
    latestMatch: null,
    nextScheduledEvent: null,
  };
}

function dashboardBody(overrides: {
  isVerifiedBuilder: boolean;
  agents?: unknown[];
  pendingReleases?: unknown[];
  claims?: unknown[];
}) {
  return {
    schemaVersion: 1,
    isVerifiedBuilder: overrides.isVerifiedBuilder,
    builder: overrides.isVerifiedBuilder
      ? { id: "builder-1", slug: "daveey", displayName: "Daveey" }
      : null,
    agents: overrides.agents ?? [],
    pendingReleases: overrides.pendingReleases ?? [],
    claims: overrides.claims ?? [],
  };
}

/** Routes a stubbed `fetch` by URL + status, same "one router per test" shape `BuilderClaimPage.test.ts` uses. */
function stubFetch(routes: {
  dashboardStatus?: number;
  dashboard?: unknown;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/ai-league-runs/league/read-model.json") {
        return Response.json(readModelBody());
      }
      if (url === "/api/account") {
        return Response.json(accountBody());
      }
      if (url === "/api/account/builder-dashboard") {
        const status = routes.dashboardStatus ?? 200;
        if (status === 401 || status === 403) {
          return new Response(null, { status });
        }
        return Response.json(
          routes.dashboard ?? dashboardBody({ isVerifiedBuilder: false }),
          { status },
        );
      }
      return new Response(null, { status: 404 });
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("builder-dashboard-page", () => {
  it("renders an honest sign-in state on a 401, never a blank page", async () => {
    stubFetch({ dashboardStatus: 401 });
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("builder_dashboard.auth_required_heading");
    expect(el.querySelector('a[href="https://coworld.example/account"]')).not.toBeNull();
  });

  it("renders the not-yet-verified state with a link to /claim", async () => {
    stubFetch({ dashboard: dashboardBody({ isVerifiedBuilder: false }) });
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("builder_dashboard.not_verified_heading");
    expect(el.querySelector('a[href="/claim"]')).not.toBeNull();
  });

  it("renders an honest generic error state on a malformed response", async () => {
    stubFetch({ dashboardStatus: 500 });
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("builder_dashboard.load_error");
  });

  it("renders a null degradedRate as 'not enough data', never a fabricated 0%", async () => {
    stubFetch({
      dashboard: dashboardBody({
        isVerifiedBuilder: true,
        agents: [
          dashboardAgent({ agentId: "agent-1", displayName: "Odin", degradedRate: null }),
        ],
      }),
    });
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("builder_dashboard.degraded_rate_unknown");
    expect(el.textContent).not.toContain("0.0%");
  });

  it("renders a numeric degradedRate as a percentage", async () => {
    stubFetch({
      dashboard: dashboardBody({
        isVerifiedBuilder: true,
        agents: [
          dashboardAgent({ agentId: "agent-1", displayName: "Odin", degradedRate: 0.125 }),
        ],
      }),
    });
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("12.5%");
  });

  it("always shows the releases section (with its start-a-release form) but hides the claims section when empty", async () => {
    stubFetch({ dashboard: dashboardBody({ isVerifiedBuilder: true }) });
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("builder_dashboard.releases_heading");
    expect(el.textContent).toContain("builder_dashboard.no_releases");
    expect(el.textContent).not.toContain("builder_dashboard.claims_heading");
  });

  it("renders pending release rows and claim rows when present", async () => {
    stubFetch({
      dashboard: dashboardBody({
        isVerifiedBuilder: true,
        agents: [dashboardAgent({ agentId: "agent-1", displayName: "Odin" })],
        pendingReleases: [
          {
            id: "rel_1",
            agentId: "agent-1",
            versionLabel: "v3",
            status: "pending",
            createdAt: "2026-07-30T00:00:00.000Z",
          },
        ],
        claims: [
          {
            id: "clm_1",
            agentId: "agent-1",
            state: "verified",
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
        ],
      }),
    });
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("v3");
    expect(el.textContent).toContain("builder_dashboard.release_status_pending");
    expect(el.textContent).toContain("builder_dashboard.claim_state_verified");
  });
});
