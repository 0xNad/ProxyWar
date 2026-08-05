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
vi.mock("../../../src/client/analytics/AnalyticsClient", () => ({
  analytics: { track: vi.fn(), trackVisitStart: vi.fn() },
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import "../../../src/client/publicapp/MatchDetailPage";
import type { MatchDetailPage } from "../../../src/client/publicapp/MatchDetailPage";
import { analytics } from "../../../src/client/analytics/AnalyticsClient";
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
    seasons: [],
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
    stats: null,
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
    dramaEvidence: null,
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
  watchHref?: string | null;
  fullRenderHref?: string | null;
  directorCutEstimateSeconds?: number | null;
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
      completedAt: null,
      watchHref: "watchHref" in overrides ? overrides.watchHref : null,
      fullRenderHref:
        "fullRenderHref" in overrides ? overrides.fullRenderHref : null,
      postMatchSummary: null,
      result: overrides.result ?? null,
      isPubliclyPromotable: false,
      subtitle: null,
      reasonToWatch: null,
      directorCutEstimateSeconds: overrides.directorCutEstimateSeconds ?? null,
      canonicalMatchUrl: null,
      canonicalPremiereUrl: null,
    },
    derivedPremiereId: overrides.derivedPremiereId ?? null,
    participants: overrides.participants ?? [],
  };
}

/** `GET /api/matches/:episodeId`'s response shape — see `LeagueEpisodeMatchPage.ts`. */
function episodeMatchBody(overrides: {
  episodeRequestId: string;
  players?: {
    slot: number;
    name: string;
    tilesOwned: number;
    isAlive: boolean;
    isWinner: boolean;
    color: string;
    placement: number;
  }[];
  winnerName?: string | null;
  directorCut?: { durationEstimateSeconds: number; segmentCount: number } | null;
  recap?: { summary: string; beats: string[] } | null;
  decisiveMoments?:
    | {
        turn: number;
        type: string;
        headline: string;
        involvedAgents: string[];
        beforeState: unknown;
        afterState: unknown;
        jumpToReplayTurn: number;
        statedReason: string | null;
      }[]
    | null;
  watchHref?: string | null;
  fullRenderHref?: string | null;
  participants?: unknown[];
}) {
  const players = overrides.players ?? [
    {
      slot: 0,
      name: "Frostfall",
      tilesOwned: 200_000,
      isAlive: true,
      isWinner: true,
      color: "#6fa8dc",
      placement: 1,
    },
    {
      slot: 1,
      name: "GhostRaider",
      tilesOwned: 20_000,
      isAlive: false,
      isWinner: false,
      color: "#e06666",
      placement: 2,
    },
  ];
  return {
    schemaVersion: 1,
    match: {
      episodeRequestId: overrides.episodeRequestId,
      shortId: overrides.episodeRequestId,
      runKey: "league-coworld-test-episode",
      roundNumber: 42,
      completedAt: "2026-08-01T12:00:00.000Z",
      map: "Pangaea",
      mapSize: "Compact",
      turnCount: 4000,
      decisionCount: 400,
      degradedCount: 10,
      winnerName: overrides.winnerName ?? players.find((p) => p.isWinner)?.name ?? null,
      players,
      watchHref:
        "watchHref" in overrides
          ? overrides.watchHref
          : "/ai-league-runs/league-coworld-test-episode/spectator.html",
      fullRenderHref:
        "fullRenderHref" in overrides
          ? overrides.fullRenderHref
          : "/ai-league-replay/league-coworld-test-episode",
      premiereHref: null,
      directorCut: overrides.directorCut ?? null,
      recap: overrides.recap ?? null,
      decisiveMoments:
        "decisiveMoments" in overrides ? overrides.decisiveMoments : null,
    },
    participants:
      overrides.participants ??
      players.map((player) => participantCard({ playerName: player.name })),
  };
}

/** Dispatches by URL — MatchDetailPage fetches the read model AND the per-match route concurrently. Returns the mock so a test can inspect which URLs were actually requested. */
function stubFetch(handlers: {
  readModel?: unknown;
  detail?: { status: number; body?: unknown };
  episodeDetail?: { status: number; body?: unknown };
}): Mock {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
    if (url.includes("/api/matches/")) {
      const detail = handlers.episodeDetail ?? { status: 500 };
      return detail.body === undefined
        ? new Response(null, { status: detail.status })
        : Response.json(detail.body, { status: detail.status });
    }
    throw new Error(`unexpected fetch url in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  stubFetch({});
  vi.mocked(analytics.track).mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("match-detail-page", () => {
  it("renders an honest not-found state on a 404, with a Browse matches recovery CTA to /watch (P2 2026-08-02)", async () => {
    stubFetch({ readModel: readModelBody({}), detail: { status: 404 } });
    const el = mount("feat_missing");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.not_found_title");
    const cta = el.querySelector<HTMLAnchorElement>('main a[href="/watch"]');
    expect(cta).not.toBeNull();
    expect(cta!.textContent).toContain("match_detail.not_found_cta");
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
    const agentLink = el.querySelector<HTMLAnchorElement>('a[href="/agent/auri"]');
    expect(agentLink).not.toBeNull();
    agentLink!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(analytics.track).toHaveBeenCalledWith("agent_profile_opened_from_match", {
      matchId: "feat_pre",
      agentSlug: "auri",
    });
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

  it("full-replay-access bugfix (2026-08-05): post-match state renders the primary Director Cut/Full Replay CTA pointing at fullRenderHref — realistic, non-colliding feat_/ereq_ ids (the archive row this featured match spotlights is keyed by its OWN real ereq_ episodeRequestId, never the feat_ id itself)", async () => {
    stubFetch({
      readModel: readModelBody({
        // The real underlying episode this FeaturedMatch spotlights — kept
        // under its own real ereq_ id, exactly like `publicMatch()`
        // (ProxyWarPublicReadModel.ts) produces in production. The
        // FeaturedMatch's `watchHref`/`fullRenderHref` below come from the
        // server's OWN episodeRequestId resolution, never from a client-side
        // lookup against this array — so this row deliberately does NOT
        // share the FeaturedMatch's matchId.
        matches: [
          minimalMatch({
            matchId: "ereq_real_episode_42",
            completedAt: "2026-07-29T00:00:00.000Z",
            winnerAgentSlug: null,
            agentSlugs: [],
          }),
        ],
      }),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_0000000000000000cafe",
          state: "archived",
          result: { winnerAgentId: null, placements: [] },
          watchHref: "/ai-league-runs/league-real-episode-42/spectator.html",
          fullRenderHref: "/ai-league-replay/league-real-episode-42",
          directorCutEstimateSeconds: 300,
        }),
      },
    });
    const el = mount("feat_0000000000000000cafe");
    await flushMicrotasks();
    const primaryLink = el.querySelector(
      'a[href="/ai-league-replay/league-real-episode-42"]',
    );
    expect(primaryLink).not.toBeNull();
    expect(primaryLink?.textContent).toContain("watch.director_cut_duration");
    // The lightweight spectator schematic is a SEPARATE, secondary link —
    // never the only replay affordance on the page.
    const secondaryLink = el.querySelector(
      'a[href="/ai-league-runs/league-real-episode-42/spectator.html"]',
    );
    expect(secondaryLink).not.toBeNull();
    expect(secondaryLink?.textContent).toContain(
      "match_detail.quick_replay_link",
    );
  });

  it("post-match: plain 'Watch Replay' label (no Director Cut wording) when directorCutEstimateSeconds is absent, and no secondary link when watchHref equals fullRenderHref", async () => {
    stubFetch({
      readModel: readModelBody({}),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_00000000000000001eaf",
          state: "revealed",
          result: { winnerAgentId: null, placements: [] },
          watchHref: "/ai-league-replay/league-same-link",
          fullRenderHref: "/ai-league-replay/league-same-link",
          directorCutEstimateSeconds: null,
        }),
      },
    });
    const el = mount("feat_00000000000000001eaf");
    await flushMicrotasks();
    expect(el.textContent).toContain("watch.watch_replay");
    expect(el.textContent).not.toContain("watch.director_cut_duration");
    // Only ONE anchor to the shared href — no redundant secondary link.
    expect(
      el.querySelectorAll('a[href="/ai-league-replay/league-same-link"]'),
    ).toHaveLength(1);
  });

  it("post-match: renders an honest 'replay pending' note, never a broken link, when fullRenderHref hasn't reached the mirror yet", async () => {
    stubFetch({
      readModel: readModelBody({}),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_00000000000000002eaf",
          state: "archived",
          result: { winnerAgentId: null, placements: [] },
          watchHref: null,
          fullRenderHref: null,
        }),
      },
    });
    const el = mount("feat_00000000000000002eaf");
    await flushMicrotasks();
    expect(el.textContent).toContain("watch.replay_pending");
    expect(el.querySelector('a[href*="/ai-league-replay/"]')).toBeNull();
  });

  it("shows the Analysis section with turn/decision/degraded composition and last-updated, when the FeaturedMatch's matchId resolves to an archive record", async () => {
    stubFetch({
      readModel: readModelBody({
        matches: [
          minimalMatch({
            matchId: "feat_analysis",
            completedAt: "2026-07-30T00:00:00.000Z",
            winnerAgentSlug: null,
            agentSlugs: [],
          }),
        ],
      }),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_analysis",
          state: "revealed",
          result: { winnerAgentId: null, placements: [] },
        }),
      },
    });
    const el = mount("feat_analysis");
    await flushMicrotasks();

    expect(el.textContent).toContain("match_detail.analysis_heading");
    expect(el.textContent).toContain("match_detail.analysis_last_updated");
    expect(el.textContent).toContain("match_detail.analysis_turn_count");
    // minimalMatch's default turnCount=100, decisionCount=50.
    expect(el.textContent).toContain("100");
    expect(el.textContent).toContain("50");
  });

  it("omits the Analysis section entirely when the archive record doesn't exist yet for this matchId — never a fabricated 0", async () => {
    stubFetch({
      readModel: readModelBody({}), // no matches at all
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_no_archive",
          state: "revealed",
          result: { winnerAgentId: null, placements: [] },
        }),
      },
    });
    const el = mount("feat_no_archive");
    await flushMicrotasks();

    expect(el.textContent).not.toContain("match_detail.analysis_heading");
  });

  it("flags degraded turns above the elevated threshold in the analysis breakdown, using the SAME >= 15% definition WatchPage's archive already uses", async () => {
    stubFetch({
      readModel: readModelBody({
        matches: [
          {
            ...minimalMatch({
              matchId: "feat_degraded",
              completedAt: "2026-07-30T00:00:00.000Z",
              winnerAgentSlug: null,
              agentSlugs: [],
            }),
            decisionCount: 100,
            degradedCount: 30,
          },
        ],
      }),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_degraded",
          state: "revealed",
          result: { winnerAgentId: null, placements: [] },
        }),
      },
    });
    const el = mount("feat_degraded");
    await flushMicrotasks();

    expect(el.textContent).toContain("match_detail.analysis_degraded_count");
    expect(el.textContent).toContain("30%");
    // F7: the degraded/recovered-turns count carries an explanatory tooltip
    // (same convention LobbyPage's hero badge already established) so a
    // visitor unfamiliar with the term isn't left guessing.
    expect(
      el.querySelector("dt[title='match_detail.analysis_degraded_count_tooltip']"),
    ).not.toBeNull();
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

  it("storylines: head-to-head is capped at HEAD_TO_HEAD_LIMIT (5), sorted by rivalry depth, with a '+N more' note for the rest (F8: an uncapped pairwise dump for a large FFA)", async () => {
    // 4 registered participants => 6 candidate pairs (4*3/2). Auri/Bolt have
    // played twice (the deepest rivalry); every other pair has played
    // exactly once. All 6 qualify (count > 0), so the cap must hide exactly
    // one — and it must be a count=1 pair, never the count=2 one.
    const matches = [
      minimalMatch({ matchId: "m1", completedAt: "2026-07-01T00:00:00.000Z", winnerAgentSlug: "auri", agentSlugs: ["auri", "bolt"] }),
      minimalMatch({ matchId: "m2", completedAt: "2026-07-02T00:00:00.000Z", winnerAgentSlug: "bolt", agentSlugs: ["auri", "bolt"] }),
      minimalMatch({ matchId: "m3", completedAt: "2026-07-03T00:00:00.000Z", winnerAgentSlug: "auri", agentSlugs: ["auri", "cobalt"] }),
      minimalMatch({ matchId: "m4", completedAt: "2026-07-04T00:00:00.000Z", winnerAgentSlug: "auri", agentSlugs: ["auri", "delta"] }),
      minimalMatch({ matchId: "m5", completedAt: "2026-07-05T00:00:00.000Z", winnerAgentSlug: "bolt", agentSlugs: ["bolt", "cobalt"] }),
      minimalMatch({ matchId: "m6", completedAt: "2026-07-06T00:00:00.000Z", winnerAgentSlug: "bolt", agentSlugs: ["bolt", "delta"] }),
      minimalMatch({ matchId: "m7", completedAt: "2026-07-07T00:00:00.000Z", winnerAgentSlug: "cobalt", agentSlugs: ["cobalt", "delta"] }),
    ];
    stubFetch({
      readModel: readModelBody({ matches }),
      detail: {
        status: 200,
        body: featuredMatchDetailBody({
          matchId: "feat_story_cap",
          state: "published",
          scheduledAt: "2026-08-01T00:00:00.000Z",
          participants: [
            participantCard({ playerName: "Auri", agentSlug: "auri" }),
            participantCard({ playerName: "Bolt", agentSlug: "bolt" }),
            participantCard({ playerName: "Cobalt", agentSlug: "cobalt" }),
            participantCard({ playerName: "Delta", agentSlug: "delta" }),
          ],
        }),
      },
    });
    const el = mount("feat_story_cap");
    await flushMicrotasks();

    const headToHeadLines = [...el.textContent!.matchAll(/match_detail\.head_to_head:(\{[^}]*\})/g)]
      .map((match) => JSON.parse(match[1]!) as { a: string; b: string; count: number });
    // Capped to 5, never all 6 candidate pairs.
    expect(headToHeadLines).toHaveLength(5);
    // The deepest rivalry (count 2) must survive the cap.
    expect(
      headToHeadLines.some(
        (line) => line.count === 2 && new Set([line.a, line.b]).size === 2 &&
          [line.a, line.b].sort().join() === ["Auri", "Bolt"].sort().join(),
      ),
    ).toBe(true);
    // Exactly one qualifying pair is hidden behind the "+N more" note.
    expect(el.textContent).toContain('match_detail.head_to_head_more:{"count":1}');
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

  // ---- League episode branch (ereq_... ids, GET /api/matches/:episodeId) --

  it("an ereq_ id resolves via /api/matches/, never /api/featured-matches/", async () => {
    const fetchMock = stubFetch({
      readModel: readModelBody({}),
      episodeDetail: { status: 200, body: episodeMatchBody({ episodeRequestId: "ereq_dispatch" }) },
    });
    mount("ereq_dispatch");
    await flushMicrotasks();
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/api/matches/ereq_dispatch"))).toBe(true);
    expect(urls.some((url) => url.includes("/api/featured-matches/"))).toBe(false);
  });

  it("an unknown episode id renders the same honest not-found state as a featured match", async () => {
    stubFetch({ readModel: readModelBody({}), episodeDetail: { status: 404 } });
    const el = mount("ereq_unknown");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.not_found_title");
  });

  it("renders header, winner, placements, and the recovered-turns integrity chip from the episode model alone (no bulk-agents correlation needed)", async () => {
    stubFetch({
      readModel: readModelBody({}),
      episodeDetail: {
        status: 200,
        body: episodeMatchBody({ episodeRequestId: "ereq_render" }),
      },
    });
    const el = mount("ereq_render");
    await flushMicrotasks();
    expect(el.textContent).toContain("Pangaea");
    expect(el.textContent).toContain("match_detail.winner_heading");
    expect(el.textContent).toContain("Frostfall");
    expect(el.textContent).toContain("match_detail.placements_heading");
    expect(el.textContent).toContain("#1");
    expect(el.textContent).toContain("#2");
    expect(el.textContent).toContain("coworld_league.eliminated");
    expect(el.textContent).toContain("watch.recovered_share");
  });

  it("league episode winner and placement agent links track agent_profile_opened_from_match on click", async () => {
    stubFetch({
      readModel: readModelBody({}),
      episodeDetail: {
        status: 200,
        body: episodeMatchBody({
          episodeRequestId: "ereq_result_click",
          participants: [
            participantCard({ playerName: "Frostfall", agentSlug: "frostfall" }),
            participantCard({ playerName: "GhostRaider", agentSlug: "ghostraider" }),
          ],
        }),
      },
    });
    const el = mount("ereq_result_click");
    await flushMicrotasks();
    const winnerLink = el.querySelector<HTMLAnchorElement>('a[href="/agent/frostfall"]');
    expect(winnerLink).not.toBeNull();
    winnerLink!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(analytics.track).toHaveBeenCalledWith("agent_profile_opened_from_match", {
      matchId: "ereq_result_click",
      agentSlug: "frostfall",
    });
    const placementLink = el.querySelector<HTMLAnchorElement>('a[href="/agent/ghostraider"]');
    expect(placementLink).not.toBeNull();
    placementLink!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(analytics.track).toHaveBeenCalledWith("agent_profile_opened_from_match", {
      matchId: "ereq_result_click",
      agentSlug: "ghostraider",
    });
  });

  it("actions: Director Cut label + minutes when directorCut is present", async () => {
    stubFetch({
      readModel: readModelBody({}),
      episodeDetail: {
        status: 200,
        body: episodeMatchBody({
          episodeRequestId: "ereq_dcut",
          directorCut: { durationEstimateSeconds: 300, segmentCount: 5 },
        }),
      },
    });
    const el = mount("ereq_dcut");
    await flushMicrotasks();
    expect(el.textContent).toContain("watch.director_cut_duration");
    expect(el.textContent).toContain('"minutes":5');
    const primaryLink = el.querySelector('a[href="/ai-league-replay/league-coworld-test-episode"]');
    expect(primaryLink).not.toBeNull();
  });

  it("actions: plain Watch Replay label (no Director Cut wording) when directorCut is absent", async () => {
    stubFetch({
      readModel: readModelBody({}),
      episodeDetail: {
        status: 200,
        body: episodeMatchBody({ episodeRequestId: "ereq_noreplaycut", directorCut: null }),
      },
    });
    const el = mount("ereq_noreplaycut");
    await flushMicrotasks();
    expect(el.textContent).not.toContain("watch.director_cut_duration");
    expect(el.textContent).toContain("watch.watch_replay");
  });

  it("actions: honest 'replay pending' when fullRenderHref is null, never a broken link", async () => {
    stubFetch({
      readModel: readModelBody({}),
      episodeDetail: {
        status: 200,
        body: episodeMatchBody({
          episodeRequestId: "ereq_pending",
          fullRenderHref: null,
          watchHref: null,
        }),
      },
    });
    const el = mount("ereq_pending");
    await flushMicrotasks();
    expect(el.textContent).toContain("watch.replay_pending");
  });

  it("recap section renders the summary and beats when the server provides a real recap", async () => {
    stubFetch({
      readModel: readModelBody({}),
      episodeDetail: {
        status: 200,
        body: episodeMatchBody({
          episodeRequestId: "ereq_recap",
          recap: {
            summary: "A cascading three-front war decided the match.",
            beats: ["Turn 812: a surprise naval assault.", "Turn 1930: an alliance partner defects."],
          },
        }),
      },
    });
    const el = mount("ereq_recap");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.episode_recap_heading");
    expect(el.textContent).toContain("A cascading three-front war decided the match.");
    expect(el.textContent).toContain("Turn 812: a surprise naval assault.");
  });

  it("recap section is entirely absent (no heading, no placeholder) when the server provides no recap", async () => {
    stubFetch({
      readModel: readModelBody({}),
      episodeDetail: {
        status: 200,
        body: episodeMatchBody({ episodeRequestId: "ereq_norecap", recap: null }),
      },
    });
    const el = mount("ereq_norecap");
    await flushMicrotasks();
    expect(el.textContent).not.toContain("match_detail.episode_recap_heading");
  });

  it("decisive moments section renders 3 cards with type, headline, agent links, stated reason, and a turn-anchored jump link", async () => {
    stubFetch({
      readModel: readModelBody({}),
      episodeDetail: {
        status: 200,
        body: episodeMatchBody({
          episodeRequestId: "ereq_decisive",
          fullRenderHref: "/ai-league-replay/league-coworld-test-episode",
          participants: [
            participantCard({ playerName: "Frostfall", agentSlug: "frostfall" }),
            participantCard({ playerName: "GhostRaider", agentSlug: "ghostraider" }),
          ],
          decisiveMoments: [
            {
              turn: 20,
              type: "lead_change",
              headline: "GhostRaider overtakes Frostfall for the territory lead.",
              involvedAgents: ["Frostfall", "GhostRaider"],
              beforeState: null,
              afterState: null,
              jumpToReplayTurn: 20,
              statedReason: null,
            },
            {
              turn: 30,
              type: "elimination",
              headline: "GhostRaider is eliminated.",
              involvedAgents: ["GhostRaider"],
              beforeState: null,
              afterState: null,
              jumpToReplayTurn: 30,
              statedReason: "GhostRaider pressed a doomed final offensive.",
            },
            {
              turn: 40,
              type: "final_confrontation",
              headline: "Final clash: Frostfall strikes GhostRaider.",
              involvedAgents: ["Frostfall"],
              beforeState: null,
              afterState: null,
              jumpToReplayTurn: 40,
              statedReason: null,
            },
          ],
        }),
      },
    });
    const el = mount("ereq_decisive");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.decisive_moments_heading");
    expect(el.textContent).toContain("match_detail.decisive_moment_type_lead_change");
    expect(el.textContent).toContain("match_detail.decisive_moment_type_elimination");
    expect(el.textContent).toContain("match_detail.decisive_moment_type_final_confrontation");
    expect(el.textContent).toContain("GhostRaider overtakes Frostfall for the territory lead.");
    expect(el.textContent).toContain("match_detail.decisive_moment_stated_reason_label");
    expect(el.textContent).toContain("GhostRaider pressed a doomed final offensive.");
    const frostfallLink = el.querySelector<HTMLAnchorElement>('a[href="/agent/frostfall"]');
    expect(frostfallLink).not.toBeNull();
    frostfallLink!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(analytics.track).toHaveBeenCalledWith("agent_profile_opened_from_match", {
      matchId: "ereq_decisive",
      agentSlug: "frostfall",
    });
    expect(el.querySelector('a[href="/agent/ghostraider"]')).not.toBeNull();
    const jumpLinks = [...el.querySelectorAll<HTMLAnchorElement>("a")].filter((a) =>
      a.getAttribute("href")?.includes("turn=20"),
    );
    expect(jumpLinks.length).toBeGreaterThan(0);
    jumpLinks[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(analytics.track).toHaveBeenCalledWith("decisive_moment_opened", {
      matchId: "ereq_decisive",
    });
  });

  it("decisive moments section is entirely absent (no heading, no placeholder) when the server provides none", async () => {
    stubFetch({
      readModel: readModelBody({}),
      episodeDetail: {
        status: 200,
        body: episodeMatchBody({
          episodeRequestId: "ereq_nodecisive",
          decisiveMoments: null,
        }),
      },
    });
    const el = mount("ereq_nodecisive");
    await flushMicrotasks();
    expect(el.textContent).not.toContain("match_detail.decisive_moments_heading");
  });

  it("technical drawer carries episodeRequestId, run key, and raw participant labels", async () => {
    stubFetch({
      readModel: readModelBody({}),
      episodeDetail: {
        status: 200,
        body: episodeMatchBody({ episodeRequestId: "ereq_technical_details" }),
      },
    });
    const el = mount("ereq_technical_details");
    await flushMicrotasks();
    expect(el.textContent).toContain("match_detail.episode_technical_heading");
    expect(el.textContent).toContain("ereq_technical_details");
    expect(el.textContent).toContain("league-coworld-test-episode");
    expect(el.textContent).toContain("Frostfall, GhostRaider");
    expect(el.textContent).toContain("match_detail.episode_provenance_note");
  });

  it("never renders pre-match/countdown/live-redirect UI for a league episode (always post-match)", async () => {
    stubFetch({
      readModel: readModelBody({
        live: { premiereId: "prem_live0000000000000000" },
      }),
      episodeDetail: {
        status: 200,
        body: episodeMatchBody({ episodeRequestId: "ereq_alwayspost" }),
      },
    });
    const el = mount("ereq_alwayspost");
    await flushMicrotasks();
    expect(el.textContent).not.toContain("match_detail.countdown_value");
    expect(el.textContent).not.toContain("match_detail.scheduled_for");
    expect(window.location.pathname).not.toContain("/premiere/");
  });
});
