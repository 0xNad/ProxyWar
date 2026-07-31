/**
 * Component coverage for `/match/:matchId` (product overhaul spec Stage 3
 * item 6): the not-found/error/live-redirect/pre-match/post-match state
 * machine, the placements-correlation lookup against the bulk read
 * model's `agents` array, and the pure recent-form/head-to-head helpers.
 * Follows the mount-into-jsdom + fetch-dispatch convention already used in
 * `AgentProfilePage.test.ts`/`BuilderProfilePage.test.ts`.
 */
vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/publicapp/MatchDetailPage";
import type { MatchDetailPage } from "../../../src/client/publicapp/MatchDetailPage";
import { READ_MODEL_PATH } from "../../../src/client/publicapp/ReadModelSchema";

function mount(matchId: string): MatchDetailPage {
  const el = document.createElement("match-detail-page") as MatchDetailPage;
  el.matchId = matchId;
  document.body.append(el);
  return el;
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function readModelBody(overrides: {
  agents?: unknown[];
  matches?: unknown[];
  live?: unknown;
}) {
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
    agents: overrides.agents ?? [],
    versions: [],
    rounds: [],
    matches: overrides.matches ?? [],
    featuredMatches: [],
    premieres: { live: overrides.live ?? null, latest: null },
    links: {
      enterTheLeagueUrl: "https://github.com/example/proxywar-starter",
      platformLabel: "Coworld",
      accountUrl: "https://coworld.example/account",
    },
  };
}

function minimalAgent(overrides: {
  id: string;
  slug: string;
  displayName: string;
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
    builderId: null,
    builderDisplayName: null,
    status: "verified",
    standing: null,
    activeVersion: null,
    provenance: { ratingPolicyLabel: null, activeChampionPolicyLabel: null },
  };
}

function minimalMatch(overrides: {
  matchId: string;
  completedAt: string | null;
  winnerAgentSlug: string | null;
  agentSlugs: string[];
}) {
  return {
    matchId: overrides.matchId,
    shortId: overrides.matchId,
    roundNumber: 1,
    completedAt: overrides.completedAt,
    map: "map1",
    mapSize: "medium",
    turnCount: 100,
    decisionCount: 50,
    degradedCount: 0,
    winnerAgentSlug: overrides.winnerAgentSlug,
    participants: overrides.agentSlugs.map((slug, index) => ({
      slot: index,
      agentSlug: slug,
      displayName: slug,
      tilesOwned: 0,
      isAlive: true,
      isWinner: slug === overrides.winnerAgentSlug,
      color: "#000000",
    })),
    watchHref: null,
    fullRenderHref: null,
    premiereHref: null,
    directorCut: null,
  };
}

function participantCard(overrides: {
  playerName: string;
  displayName?: string;
  agentSlug?: string | null;
  emblemSvg?: string | null;
  versionLabel?: string | null;
  builderDisplayName?: string | null;
}) {
  return {
    playerName: overrides.playerName,
    displayName: overrides.displayName ?? overrides.playerName,
    agentSlug: overrides.agentSlug ?? null,
    emblemSvg: overrides.emblemSvg ?? null,
    primaryColor: null,
    secondaryColor: null,
    versionLabel: overrides.versionLabel ?? null,
    builderId: null,
    builderDisplayName: overrides.builderDisplayName ?? null,
  };
}

function featuredMatchDetailBody(overrides: {
  matchId: string;
  state?: "scheduled" | "published" | "revealed" | "archived" | "cancelled";
  scheduledAt?: string | null;
  result?: { winnerAgentId: string | null; placements: { agentId: string | null; placement: number }[] } | null;
  participants?: unknown[];
  derivedPremiereId?: string | null;
  title?: string;
}) {
  return {
    schemaVersion: 1,
    match: {
      matchId: overrides.matchId,
      lane: "premiere",
      title: overrides.title ?? "Featured Test Match",
      description: "",
      map: "map1",
      format: "1v1",
      category: null,
      state: overrides.state ?? "published",
      scheduledAt: overrides.scheduledAt ?? null,
      revealAt: null,
      postMatchSummary: null,
      result: overrides.result ?? null,
    },
    derivedPremiereId: overrides.derivedPremiereId ?? null,
    participants: overrides.participants ?? [],
  };
}

/** Dispatches by URL — MatchDetailPage fetches the read model AND the per-match route concurrently. */
function stubFetch(handlers: {
  readModel?: unknown;
  detail?: { status: number; body?: unknown };
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(READ_MODEL_PATH)) {
        return handlers.readModel === undefined
          ? new Response(null, { status: 500 })
          : Response.json(handlers.readModel);
      }
      if (url.includes("/api/featured-matches/")) {
        const detail = handlers.detail ?? { status: 500 };
        return detail.body === undefined
          ? new Response(null, { status: detail.status })
          : Response.json(detail.body, { status: detail.status });
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    }),
  );
}

beforeEach(() => {
  stubFetch({});
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("match-detail-page", () => {
  it("renders an honest not-found state on a 404", async () => {
    stubFetch({ readModel: readModelBody({}), detail: { status: 404 } });
    const el = mount("feat_missing");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.not_found_title");
  });

  it("renders an error state (with retry) on a network/schema failure, never throwing", async () => {
    stubFetch({ readModel: readModelBody({}), detail: { status: 500 } });
    const el = mount("feat_broken");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.load_error");
    expect(el.querySelector("button")).not.toBeNull();
  });

  it("live-redirects instead of rendering when derivedPremiereId matches the read model's live premiere", async () => {
    const replaceSpy = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace: replaceSpy });
    stubFetch({
      readModel: readModelBody({
        live: {
          premiereId: "prem_live123",
          roundNumber: 1,
          mapLabel: "map1",
          scheduledAt: "2026-07-31T00:00:00.000Z",
          premierePageLive: true,
        },
      }),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_live",
          derivedPremiereId: "prem_live123",
        }),
      },
    });
    const el = mount("feat_live");
    await flushMicrotasks();
    expect(replaceSpy).toHaveBeenCalledWith("/premiere/prem_live123");
    // Never renders the match content itself — Stage 4 owns that layout.
    expect(el.textContent).not.toContain("Featured Test Match");
  });

  it("does NOT redirect when derivedPremiereId is present but doesn't match the current live premiere", async () => {
    stubFetch({
      readModel: readModelBody({
        live: {
          premiereId: "prem_other",
          roundNumber: 1,
          mapLabel: "map1",
          scheduledAt: "2026-07-31T00:00:00.000Z",
          premierePageLive: true,
        },
      }),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_x",
          state: "published",
          scheduledAt: "2026-08-01T00:00:00.000Z",
          derivedPremiereId: "prem_mine",
        }),
      },
    });
    const el = mount("feat_x");
    await flushMicrotasks();
    expect(el.textContent).toContain("Featured Test Match");
  });

  it("pre-match state renders scheduled time, countdown, participant cards, and NO result", async () => {
    stubFetch({
      readModel: readModelBody({}),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_pre",
          state: "published",
          scheduledAt: "2026-08-01T00:00:00.000Z",
          participants: [
            participantCard({
              playerName: "Auri",
              agentSlug: "auri",
              versionLabel: "v3",
              builderDisplayName: "Daveey",
            }),
          ],
        }),
      },
    });
    const el = mount("feat_pre");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.scheduled_for");
    expect(el.textContent).toContain("match_detail.countdown_value");
    expect(el.textContent).toContain("Auri");
    expect(el.textContent).toContain("v3");
    expect(el.textContent).toContain("Daveey");
    expect(el.textContent).not.toContain("match_detail.winner_heading");
  });

  it("pre-match with no scheduled time yet renders honestly without a fabricated countdown", async () => {
    stubFetch({
      readModel: readModelBody({}),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_pre2",
          state: "published",
          scheduledAt: null,
        }),
      },
    });
    const el = mount("feat_pre2");
    await flushMicrotasks();
    expect(el.textContent).not.toContain("match_detail.countdown_value");
    expect(el.textContent).toContain("match_detail.schedule_unavailable");
  });

  it("pre-match participants-pending placeholder when the roster isn't public yet (empty participants)", async () => {
    stubFetch({
      readModel: readModelBody({}),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_pre3",
          state: "scheduled",
          scheduledAt: "2026-08-01T00:00:00.000Z",
          participants: [],
        }),
      },
    });
    const el = mount("feat_pre3");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.participants_pending");
  });

  it("revealed state with result still null renders an honest 'result pending' state, never the pre-match countdown", async () => {
    stubFetch({
      readModel: readModelBody({}),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_revealed_pending",
          state: "revealed",
          scheduledAt: "2026-08-01T00:00:00.000Z",
          result: null,
          participants: [participantCard({ playerName: "Auri", agentSlug: "auri" })],
        }),
      },
    });
    const el = mount("feat_revealed_pending");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.result_pending");
    expect(el.textContent).toContain("match_detail.state_revealed");
    expect(el.textContent).toContain("Auri");
    expect(el.textContent).not.toContain("match_detail.countdown_value");
    expect(el.textContent).not.toContain("match_detail.scheduled_for");
    expect(el.textContent).not.toContain("match_detail.winner_heading");
  });

  it("archived state with result still null ALSO renders 'result pending', not post-match", async () => {
    stubFetch({
      readModel: readModelBody({}),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_archived_pending",
          state: "archived",
          result: null,
        }),
      },
    });
    const el = mount("feat_archived_pending");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.result_pending");
    expect(el.textContent).toContain("match_detail.state_archived");
  });

  it("cancelled state renders the cancelled note, not a countdown", async () => {
    stubFetch({
      readModel: readModelBody({}),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_cancelled",
          state: "cancelled",
          scheduledAt: "2026-08-01T00:00:00.000Z",
        }),
      },
    });
    const el = mount("feat_cancelled");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.cancelled_note");
    expect(el.textContent).not.toContain("match_detail.countdown_value");
  });

  it("post-match state resolves winner/placements by agentId against the read model's agents array", async () => {
    stubFetch({
      readModel: readModelBody({
        agents: [
          minimalAgent({ id: "agt_auri", slug: "auri", displayName: "Auri" }),
          minimalAgent({ id: "agt_ghost", slug: "ghost", displayName: "GhostRaider" }),
        ],
      }),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_post",
          state: "revealed",
          result: {
            winnerAgentId: "agt_auri",
            placements: [
              { agentId: "agt_auri", placement: 1 },
              { agentId: "agt_ghost", placement: 2 },
            ],
          },
        }),
      },
    });
    const el = mount("feat_post");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.winner_heading");
    expect(el.textContent).toContain("Auri");
    expect(el.textContent).toContain("GhostRaider");
    expect(el.textContent).toContain("#1");
    expect(el.textContent).toContain("#2");
    expect(el.textContent).not.toContain("match_detail.winner_unknown");
    const winnerLink = el.querySelector('a[href="/agent/auri"]');
    expect(winnerLink).not.toBeNull();
  });

  it("post-match: an unresolvable agentId (removed/unregistered) renders an honest 'unknown' label, never a fabricated name", async () => {
    stubFetch({
      readModel: readModelBody({ agents: [] }),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_post2",
          state: "revealed",
          result: {
            winnerAgentId: "agt_nolongerregistered",
            placements: [{ agentId: null, placement: 1 }],
          },
        }),
      },
    });
    const el = mount("feat_post2");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.winner_unknown");
    expect(el.textContent).toContain("match_detail.placement_unknown");
  });

  it("never renders result content while the state is not yet revealed — the embargo the server enforces is trusted, not re-guessed, but the client still never shows result markup when result is null", async () => {
    stubFetch({
      readModel: readModelBody({}),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_embargoed",
          state: "published",
          scheduledAt: "2026-08-01T00:00:00.000Z",
          result: null,
        }),
      },
    });
    const el = mount("feat_embargoed");
    await flushMicrotasks();
    expect(el.textContent).not.toContain("match_detail.winner_heading");
    expect(el.textContent).not.toContain("match_detail.placements_heading");
  });

  it("storylines section is skipped entirely (not a fabricated 'no history' claim) when no participant has a registered agentSlug", async () => {
    stubFetch({
      readModel: readModelBody({ matches: [] }),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_story1",
          state: "published",
          scheduledAt: "2026-08-01T00:00:00.000Z",
          participants: [participantCard({ playerName: "Unclaimed", agentSlug: null })],
        }),
      },
    });
    const el = mount("feat_story1");
    await flushMicrotasks();
    expect(el.textContent).not.toContain("match_detail.storylines_heading");
  });

  it("storylines: renders recent form and head-to-head purely from the read model's matches array", async () => {
    stubFetch({
      readModel: readModelBody({
        matches: [
          minimalMatch({
            matchId: "m1",
            completedAt: "2026-07-01T00:00:00.000Z",
            winnerAgentSlug: "auri",
            agentSlugs: ["auri", "ghost"],
          }),
          minimalMatch({
            matchId: "m2",
            completedAt: "2026-07-15T00:00:00.000Z",
            winnerAgentSlug: "ghost",
            agentSlugs: ["auri", "ghost"],
          }),
        ],
      }),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_story2",
          state: "published",
          scheduledAt: "2026-08-01T00:00:00.000Z",
          participants: [
            participantCard({ playerName: "Auri", agentSlug: "auri" }),
            participantCard({ playerName: "GhostRaider", agentSlug: "ghost" }),
          ],
        }),
      },
    });
    const el = mount("feat_story2");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.storylines_heading");
    expect(el.textContent).toContain("match_detail.recent_form");
    expect(el.textContent).toContain("match_detail.head_to_head");
  });

  it("an unregistered participant (agentSlug null) falls back to raw displayName with a placeholder glyph, no agent link", async () => {
    stubFetch({
      readModel: readModelBody({}),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_unreg",
          state: "published",
          scheduledAt: "2026-08-01T00:00:00.000Z",
          participants: [
            participantCard({ playerName: "RawPlayerName", agentSlug: null }),
          ],
        }),
      },
    });
    const el = mount("feat_unreg");
    await flushMicrotasks();
    expect(el.textContent).toContain("RawPlayerName");
    expect(el.querySelector('a[href^="/agent/"]')).toBeNull();
  });

  it("includes the app-shell header and footer", async () => {
    stubFetch({ readModel: readModelBody({}), detail: { status: 404 } });
    const el = mount("feat_shell");
    await flushMicrotasks();
    expect(el.querySelector("header")).not.toBeNull();
    expect(el.querySelector("footer")).not.toBeNull();
  });
});
