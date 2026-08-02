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
  firstObservedAt?: string | null;
  tagline?: string | null;
  stats?: unknown;
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
            firstObservedAt: overrides.firstObservedAt ?? null,
          },
    provenance: { ratingPolicyLabel: null, activeChampionPolicyLabel: null },
    stats: overrides.stats ?? null,
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
    dramaEvidence: null,
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

describe("agent-profile-page", () => {
  it("renders an honest not-found state when the slug matches no agent, with a Browse agents recovery CTA to /agents (P2 2026-08-02)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(readModelBody([]))),
    );
    const el = mount("no-such-agent");
    await flushMicrotasks();
    expect(el.querySelector("h1")?.textContent).toBe("no-such-agent");
    expect(el.textContent).toContain("agent_profile.not_found_body");
    const cta = el.querySelector<HTMLAnchorElement>('main a[href="/agents"]');
    expect(cta).not.toBeNull();
    expect(cta!.textContent).toContain("agent_profile.not_found_cta");
  });

  it("resolves a provisional identity by provisionalSlug when no registered agent matches — never the anonymous not-found state (2026-08-01 P0 regression: 'James Botts'-style unregistered participant)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody([
            {
              registered: false,
              id: null,
              slug: null,
              playerName: "James Botts",
              displayName: "James Botts",
              shortCode: null,
              emblemSvg: null,
              primaryColor: null,
              secondaryColor: null,
              provisionalSlug: "james-botts",
              provisionalEmblemSvg: '<svg data-testid="provisional-emblem"></svg>',
              provisionalPrimaryColor: "#112233",
              provisionalSecondaryColor: "#445566",
              tagline: null,
              builderId: null,
              builderDisplayName: null,
              status: "unregistered",
              standing: { rank: 16, score: 0.01, roundsPlayed: 908, isHouse: false },
              activeVersion: null,
              provenance: {
                ratingPolicyLabel: "jamesboggs-warlord:v1",
                activeChampionPolicyLabel: "jamesboggs-warlord:v1",
              },
              stats: null,
            },
          ]),
        ),
      ),
    );
    const el = mount("james-botts");
    await flushMicrotasks();

    // Never the not-found/anonymous state — the whole point of the fix.
    expect(el.textContent).not.toContain("agent_profile.not_found_body");
    expect(el.querySelector("h1")?.textContent).toContain("James Botts");
    // A generated provisional emblem renders, closing the "no emblem
    // anywhere" complaint.
    expect(el.querySelector('[data-testid="provisional-emblem"]')).not.toBeNull();
    // Standing (rank/score/rounds) still renders for a provisional agent —
    // it is a real, currently-competing participant, not a placeholder.
    expect(el.textContent).toContain("#16");
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

  it("shows a 'first observed' marker next to the active version when the registry has recorded one, and omits it when null", async () => {
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
              activeVersionLabel: "v24",
              firstObservedAt: "2026-07-01T00:00:00.000Z",
            }),
          ]),
        ),
      ),
    );
    const withDate = mount("odin-free");
    await flushMicrotasks();
    expect(withDate.textContent).toContain("agent_profile.first_observed");

    document.body.innerHTML = "";
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
              activeVersionLabel: "v24",
            }),
          ]),
        ),
      ),
    );
    const withoutDate = mount("odin-free");
    await flushMicrotasks();
    expect(withoutDate.textContent).not.toContain(
      "agent_profile.first_observed",
    );
  });

  it("renders the strategic fingerprint from a real stats payload, hiding metrics below their own threshold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody([
            minimalAgent({
              slug: "daveey",
              playerName: "daveey",
              displayName: "daveey",
              shortCode: "DAV",
              status: "verified",
              builderDisplayName: null,
              rank: 1,
              stats: {
                career: {
                  episodeCount: 118,
                  fingerprint: {
                    aggression: {
                      value: 0.311,
                      sampleSize: 11089,
                      threshold: 50,
                      methodology: "attack_count / total_event_count",
                    },
                    diplomacyInitiated: null,
                    economicFocus: null,
                    territory: {
                      share: {
                        value: 0.293,
                        sampleSize: 118,
                        threshold: 1,
                        methodology: "real map tiles",
                      },
                      absoluteTiles: null,
                      meanRank: null,
                    },
                    armyStrength: null,
                    reliability: {
                      value: 0.975,
                      sampleSize: 14143,
                      threshold: 30,
                      methodology: "1 - (fallbackCount / decisionCount)",
                    },
                  },
                  social: {
                    alliancesInitiated: {
                      value: 90,
                      sampleSize: 90,
                      threshold: 1,
                      methodology: "count",
                    },
                    allianceAcceptanceRate: null,
                    betrayalCount: null,
                    frequentAllies: [{ name: "Ron SWGY", count: 20 }],
                    primaryAdversaries: [],
                    treatyDuration: null,
                  },
                },
                currentVersion: null,
              },
            }),
          ]),
        ),
      ),
    );
    const el = mount("daveey");
    await flushMicrotasks();

    expect(el.textContent).toContain("agent_stats.fingerprint_heading");
    expect(el.textContent).toContain("98%"); // reliability, rounded
    expect(el.textContent).toContain("31%");
    expect(el.textContent).toContain("29%");
    expect(el.textContent).toContain("Ron SWGY");
    // Below-threshold metrics never render, on the real page, not just the
    // isolated render function.
    expect(el.textContent).not.toContain("agent_stats.diplomacy_initiated");
    expect(el.textContent).not.toContain(
      "agent_stats.alliance_acceptance_rate",
    );
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

  it("renders a 'start a verified claim' CTA linking to /claim/:slug only for an unclaimed, registered agent", async () => {
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
    expect(el.textContent).toContain("agent_profile.claim_cta");
    expect(
      el.querySelector('a[href="/claim/unclaimed-agent"]'),
    ).not.toBeNull();

    document.body.innerHTML = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          readModelBody([
            minimalAgent({
              slug: "verified-agent",
              playerName: "verified-agent",
              displayName: "Verified Agent",
              shortCode: "VER",
              status: "verified",
              builderDisplayName: "Ada Builder",
              rank: 1,
            }),
          ]),
        ),
      ),
    );
    const verifiedEl = mount("verified-agent");
    await flushMicrotasks();
    expect(verifiedEl.textContent).not.toContain("agent_profile.claim_cta");
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
