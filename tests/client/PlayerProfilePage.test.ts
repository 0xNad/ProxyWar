/**
 * Component coverage for `/player/:name`. Previously untested; added
 * alongside the Stage 6 stats wiring (`buildLeaguePlayerSection`'s new
 * `stats` field) to prove parity with `/agent/:slug`: the SAME
 * `renderAgentStatsSections` function, so the SAME numbers must render
 * identically on both pages — verified here with the exact fixture used
 * in `AgentProfilePage.test.ts`'s stats test.
 */
vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/client/platform/PlayerProfilePage";
import type { PlayerProfilePage } from "../../src/client/platform/PlayerProfilePage";

function mount(name: string): PlayerProfilePage {
  const el = document.createElement(
    "player-profile-page",
  ) as PlayerProfilePage;
  el.name = name;
  document.body.append(el);
  return el;
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function profileResponse(overrides: {
  name: string;
  stats?: unknown;
}): Response {
  return Response.json({
    schemaVersion: 1,
    name: overrides.name,
    league: {
      generatedAt: "2026-07-31T00:00:00.000Z",
      lastGoodSyncAt: "2026-07-31T00:00:00.000Z",
      stale: false,
      standing: { rank: 1, ratingPolicyLabel: null, activeChampionPolicyLabel: null, score: null, roundsPlayed: null, isHouse: false },
      policyLineageNote: null,
      episodes: [],
      recentRecord: null,
      stats: overrides.stats ?? null,
    },
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("player-profile-page", () => {
  it("renders standing and an honest empty note when there is no stats artifact yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => profileResponse({ name: "daveey" })),
    );
    const el = mount("daveey");
    await flushMicrotasks();

    expect(el.querySelector("h1")?.textContent).toContain("daveey");
    expect(el.textContent).toContain("#1");
    expect(el.textContent).not.toContain("agent_stats.fingerprint_heading");
  });

  it("renders the SAME fingerprint numbers AgentProfilePage.test.ts's stats test proves for /agent/:slug — same computation source, same rendering function", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        profileResponse({
          name: "daveey",
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
                reliability: null,
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
      ),
    );
    const el = mount("daveey");
    await flushMicrotasks();

    expect(el.textContent).toContain("agent_stats.fingerprint_heading");
    expect(el.textContent).toContain("31%");
    expect(el.textContent).toContain("29%");
    expect(el.textContent).toContain("Ron SWGY");
    expect(el.textContent).not.toContain("agent_stats.diplomacy_initiated");
    expect(el.textContent).not.toContain(
      "agent_stats.alliance_acceptance_rate",
    );
  });

  it("rejects a stats payload the shared schema doesn't recognize, degrading to the load-error state rather than rendering garbage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          schemaVersion: 1,
          name: "daveey",
          league: {
            generatedAt: null,
            lastGoodSyncAt: null,
            stale: false,
            standing: null,
            policyLineageNote: null,
            episodes: [],
            recentRecord: null,
            stats: { career: "not-an-object" },
          },
        }),
      ),
    );
    const el = mount("daveey");
    await flushMicrotasks();

    expect(el.textContent).toContain("Could not load this player.");
  });
});
