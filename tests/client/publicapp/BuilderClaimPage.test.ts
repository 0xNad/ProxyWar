/**
 * Component coverage for `/claim` and `/claim/:agentSlug`: a signed-out
 * visitor (no `identity.githubLogin`) must see an honest sign-in gate and
 * never the claim form; a signed-in visitor sees the form pre-populated
 * with only agents the read model marks unclaimed
 * (`builderId === null && status !== "house"`, same filter
 * `BuildersDirectoryPage.ts` already uses); a successful submission POSTs
 * `x-csrf-token` and renders a confirmation with the claim's `state` and a
 * link to the agent's profile; distinct submit-time error codes render
 * distinct honest messages; and the account's own non-terminal claims
 * render proof/withdraw actions. Follows the mount-into-jsdom convention
 * in `tests/client/publicapp/BuilderProfilePage.test.ts`.
 */
vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));
vi.mock("../../../src/client/analytics/AnalyticsClient", () => ({
  analytics: { track: vi.fn(), trackVisitStart: vi.fn() },
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/publicapp/BuilderClaimPage";
import type { BuilderClaimPage } from "../../../src/client/publicapp/BuilderClaimPage";
import { analytics } from "../../../src/client/analytics/AnalyticsClient";

function mount(agentSlug = ""): BuilderClaimPage {
  const el = document.createElement("builder-claim-page") as BuilderClaimPage;
  if (agentSlug !== "") el.agentSlug = agentSlug;
  document.body.append(el);
  return el;
}

/** Drains pending microtasks — deterministic, not a real-time wait. */
async function flushMicrotasks(times = 15): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function minimalAgent(overrides: {
  id: string;
  slug: string;
  displayName: string;
  builderId: string | null;
  status?: "verified" | "house" | "unclaimed" | "unregistered";
}) {
  return {
    registered: true,
    id: overrides.id,
    slug: overrides.slug,
    playerName: overrides.displayName,
    displayName: overrides.displayName,
    shortCode: null,
    emblemSvg: null,
    primaryColor: null,
    secondaryColor: null,
    tagline: null,
    builderId: overrides.builderId,
    builderDisplayName: null,
    status: overrides.status ?? (overrides.builderId === null ? "unclaimed" : "verified"),
    standing: null,
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

function accountBody(githubLogin: string | null) {
  return {
    schemaVersion: 1,
    csrfToken: "csrf-token-1",
    identity: {
      accountId: "acct_1",
      displayName: "Daveey",
      githubLogin,
      githubAvatarUrl: null,
    },
    claims: [],
  };
}

function claimRecord(overrides: {
  id: string;
  agentId: string;
  state: "draft" | "challenge_issued" | "proof_pending" | "verified" | "rejected" | "revoked";
}) {
  return {
    id: overrides.id,
    accountId: "acct_1",
    githubLogin: "daveey",
    agentId: overrides.agentId,
    claimedCoworldPlayerName: "odin-free",
    builderProfileDraft: {
      displayName: "Daveey",
      shortBio: null,
      links: [],
      teamMembers: [],
    },
    evidence: [],
    state: overrides.state,
    nonceChallenge: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

/** Routes a stubbed `fetch` by URL + method, same "one router per test" shape as `AccountPage.ts`'s own client tests use. */
function stubFetch(routes: {
  readModel?: unknown;
  account?: unknown | "unauthenticated";
  claims?: unknown;
  submitClaim?: { status: number; body: unknown };
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/ai-league-runs/league/read-model.json") {
        return Response.json(routes.readModel ?? readModelBody([]));
      }
      if (url === "/api/account" && method === "GET") {
        if (routes.account === "unauthenticated") {
          return new Response(null, { status: 401 });
        }
        return Response.json(routes.account ?? accountBody(null));
      }
      if (url === "/api/account/builder-claims" && method === "GET") {
        return Response.json(
          routes.claims ?? { schemaVersion: 1, claims: [] },
        );
      }
      if (url === "/api/account/builder-claims" && method === "POST") {
        const result = routes.submitClaim ?? {
          status: 200,
          body: { schemaVersion: 1, claim: claimRecord({ id: "clm_1", agentId: "agent-1", state: "draft" }) },
        };
        return Response.json(result.body, { status: result.status });
      }
      return new Response(null, { status: 404 });
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
  vi.mocked(analytics.track).mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("builder-claim-page", () => {
  it("renders an honest sign-in gate and never the form when not GitHub signed in", async () => {
    stubFetch({ account: accountBody(null) });
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("builder_claim.signin_required_heading");
    expect(el.querySelector("form")).toBeNull();
    expect(el.querySelector('a[href="https://coworld.example/account"]')).not.toBeNull();
  });

  it("lists only unclaimed, non-house agents in the picker when signed in", async () => {
    stubFetch({
      account: accountBody("daveey"),
      readModel: readModelBody([
        minimalAgent({ id: "agent-1", slug: "odin-free", displayName: "Odin", builderId: null }),
        minimalAgent({ id: "agent-2", slug: "claimed-agent", displayName: "Claimed", builderId: "builder-1" }),
        minimalAgent({ id: "agent-3", slug: "house-agent", displayName: "House", builderId: null, status: "house" }),
      ]),
    });
    const el = mount();
    await flushMicrotasks();

    const options = Array.from(el.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("Odin");
    expect(options).not.toContain("Claimed");
    expect(options).not.toContain("House");
  });

  it("preselects the agent named by the agentSlug attribute and hides the picker", async () => {
    stubFetch({
      account: accountBody("daveey"),
      readModel: readModelBody([
        minimalAgent({ id: "agent-1", slug: "odin-free", displayName: "Odin", builderId: null }),
      ]),
    });
    const el = mount("odin-free");
    await flushMicrotasks();

    expect(el.querySelector("select")).toBeNull();
    expect(el.textContent).toContain("Odin");
  });

  it("submits with the CSRF header and renders a confirmation linking to the agent's profile", async () => {
    stubFetch({
      account: accountBody("daveey"),
      readModel: readModelBody([
        minimalAgent({ id: "agent-1", slug: "odin-free", displayName: "Odin", builderId: null }),
      ]),
      submitClaim: {
        status: 200,
        body: {
          schemaVersion: 1,
          claim: claimRecord({ id: "clm_1", agentId: "agent-1", state: "draft" }),
        },
      },
    });
    const el = mount("odin-free");
    await flushMicrotasks();

    (el.querySelector('input[type="text"]') as HTMLInputElement).value = "odin-free";
    el.querySelector('input[type="text"]')?.dispatchEvent(new Event("input"));
    const textareas = el.querySelectorAll("textarea");
    (textareas[textareas.length - 2] as HTMLTextAreaElement).value = "Evidence note";
    textareas[textareas.length - 2].dispatchEvent(new Event("input"));
    const displayNameInputs = el.querySelectorAll("input[type=text]");
    (displayNameInputs[1] as HTMLInputElement).value = "Daveey";
    displayNameInputs[1].dispatchEvent(new Event("input"));

    const form = el.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flushMicrotasks();

    const postCall = vi.mocked(fetch).mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const headers = postCall?.[1]?.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBe("csrf-token-1");

    expect(el.textContent).toContain("builder_claim.confirmation_heading");
    expect(el.textContent).toContain("builder_claim.state_draft");
    expect(el.querySelector('a[href="/agent/odin-free"]')).not.toBeNull();
    expect(analytics.track).toHaveBeenCalledWith("claim_started", {
      claimId: "clm_1",
      agentSlug: "odin-free",
    });
  });

  it("renders a distinct message for an already-verified submit rejection", async () => {
    stubFetch({
      account: accountBody("daveey"),
      readModel: readModelBody([
        minimalAgent({ id: "agent-1", slug: "odin-free", displayName: "Odin", builderId: null }),
      ]),
      submitClaim: {
        status: 409,
        body: { error: { code: "PLATFORM_ALREADY_VERIFIED" } },
      },
    });
    const el = mount("odin-free");
    await flushMicrotasks();

    const textareas = el.querySelectorAll("textarea");
    (textareas[textareas.length - 2] as HTMLTextAreaElement).value = "Evidence note";
    textareas[textareas.length - 2].dispatchEvent(new Event("input"));
    const inputs = el.querySelectorAll("input[type=text]");
    (inputs[0] as HTMLInputElement).value = "odin-free";
    inputs[0].dispatchEvent(new Event("input"));
    (inputs[1] as HTMLInputElement).value = "Daveey";
    inputs[1].dispatchEvent(new Event("input"));

    const form = el.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flushMicrotasks();

    expect(el.textContent).toContain("builder_claim.error_already_verified");
    expect(analytics.track).not.toHaveBeenCalledWith(
      "claim_started",
      expect.anything(),
    );
  });

  it("does not emit claim_started when client-side form validation fails", async () => {
    stubFetch({
      account: accountBody("daveey"),
      readModel: readModelBody([
        minimalAgent({ id: "agent-1", slug: "odin-free", displayName: "Odin", builderId: null }),
      ]),
    });
    const el = mount("odin-free");
    await flushMicrotasks();

    // Required fields (player name, display name, evidence note) are left blank.
    const form = el.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flushMicrotasks();

    expect(el.textContent).toContain("builder_claim.validation_error");
    expect(
      vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST"),
    ).toBeUndefined();
    expect(analytics.track).not.toHaveBeenCalledWith(
      "claim_started",
      expect.anything(),
    );
  });

  it("renders the account's own claims with a state badge and withdraw action for a non-terminal claim", async () => {
    stubFetch({
      account: accountBody("daveey"),
      readModel: readModelBody([
        minimalAgent({ id: "agent-1", slug: "odin-free", displayName: "Odin", builderId: null }),
      ]),
      claims: {
        schemaVersion: 1,
        claims: [claimRecord({ id: "clm_1", agentId: "agent-1", state: "proof_pending" })],
      },
    });
    const el = mount();
    await flushMicrotasks();

    expect(el.textContent).toContain("builder_claim.state_proof_pending");
    expect(el.textContent).toContain("builder_claim.withdraw_button");
  });
});
