/**
 * Component coverage for the "who are these four" scouting panel: seat join
 * to league standings, degraded rendering when data/seats/mappings are
 * missing or stale, and keyboard/accessibility shape of the native
 * `<details>` disclosure. Follows the mount-into-jsdom convention in
 * components.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../src/client/prediction/wagering/components/LeagueContextPanel";
import type { PremiereLeagueContextPanel } from "../../../../src/client/prediction/wagering/components/LeagueContextPanel";
import { resetLeagueDataCacheForTests } from "../../../../src/client/prediction/wagering/leagueData";
import type { MarketSeatOption } from "../../../../src/client/prediction/wagering/types";

function mount(): PremiereLeagueContextPanel {
  const el = document.createElement(
    "premiere-league-context-panel",
  ) as PremiereLeagueContextPanel;
  document.body.append(el);
  return el;
}

function realSeat(displayName: string, policyLabel: string): MarketSeatOption {
  return {
    seatId: displayName,
    displayName,
    policyIdentity: {
      namespace: "softmax_policy_version",
      policyVersionId: `${policyLabel}-id`,
      policyName: policyLabel,
      serverAssignedVersion: "1",
    },
  };
}

function stubFetchOk(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body })),
  );
}

function snapshot() {
  return {
    generatedAt: "2026-07-27T13:00:00.000Z",
    lastGoodSyncAt: "2026-07-27T13:00:00.000Z",
    stale: false,
    standings: [
      {
        rank: 1,
        playerName: "daveey",
        ratingPolicyLabel: "daveey-proxywar:v24",
        activeChampionPolicyLabel: "daveey-proxywar:v24",
        policyLabel: "daveey-proxywar:v24",
        score: 20.5,
        roundsPlayed: 626,
        isHouse: false,
      },
      {
        rank: 2,
        playerName: "relh",
        ratingPolicyLabel: "relh-proxywar:v9",
        activeChampionPolicyLabel: "relh-proxywar:v9",
        policyLabel: "relh-proxywar:v9",
        score: 15.2,
        roundsPlayed: 272,
        isHouse: false,
      },
    ],
    episodes: [
      {
        episodeRequestId: "ereq_1",
        roundNumber: 887,
        completedAt: "2026-07-27T12:00:00.000Z",
        winnerName: "daveey",
        players: [
          { name: "daveey", isAlive: true, isWinner: true },
          { name: "relh", isAlive: false, isWinner: false },
        ],
      },
    ],
  };
}

beforeEach(() => {
  resetLeagueDataCacheForTests();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("premiere-league-context-panel", () => {
  it("renders nothing when there are no seats", async () => {
    stubFetchOk(snapshot());
    const el = mount();
    el.seats = [];
    await el.updateComplete;
    expect(el.querySelector("details")).toBeNull();
  });

  it("is a collapsed-by-default native disclosure (keyboard reachable, no aria-live)", async () => {
    stubFetchOk(snapshot());
    const el = mount();
    el.seats = [realSeat("daveey", "daveey-proxywar:v24")];
    await el.updateComplete;

    const details = el.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(el.querySelector("summary")).not.toBeNull();
    expect(el.querySelector("[aria-live]")).toBeNull();
  });

  it("shows rank, rating, rounds played, and recent form for a mapped seat", async () => {
    stubFetchOk(snapshot());
    const el = mount();
    el.seats = [
      realSeat("daveey", "daveey-proxywar:v24"),
      realSeat("relh", "relh-proxywar:v9"),
    ];
    await el.updateComplete;
    await vi.waitFor(() => {
      expect(el.textContent).toContain("Rank 1");
    });

    expect(el.textContent).toContain("Rating 20.5");
    expect(el.textContent).toContain("626 league rounds played");
    // Recent form glyphs are aria-hidden; the accessible summary carries the words.
    expect(el.textContent).toContain("Recent form, most recent first: won.");
  });

  it("shows shared match history between two mapped seats in this premiere", async () => {
    stubFetchOk(snapshot());
    const el = mount();
    el.seats = [
      realSeat("daveey", "daveey-proxywar:v24"),
      realSeat("relh", "relh-proxywar:v9"),
    ];
    await el.updateComplete;
    await vi.waitFor(() => {
      expect(el.textContent).toContain("Met before");
    });

    expect(el.textContent).toContain("vs relh: 1 shared round (1–0 wins)");
  });

  it("never applies a favorite badge or recommendation affordance", async () => {
    stubFetchOk(snapshot());
    const el = mount();
    el.seats = [
      realSeat("daveey", "daveey-proxywar:v24"),
      realSeat("relh", "relh-proxywar:v9"),
    ];
    await el.updateComplete;
    await vi.waitFor(() => {
      expect(el.textContent).toContain("Rank 1");
    });

    const text = el.textContent ?? "";
    // The disclaimer itself legitimately says "never a favorite" — so this
    // asserts there is no separate badge/label element and no imperative
    // recommendation copy, not that the word never appears anywhere.
    expect(el.querySelectorAll("[data-favorite], .favorite, .pick").length).toBe(0);
    expect(text.toLowerCase()).not.toContain("back this");
    expect(text.toLowerCase()).not.toContain("our pick");
    expect(text.toLowerCase()).not.toContain("you should");
    expect(text).toContain("Evidence, not advice");
    expect(text).toContain("never a favorite");
  });

  it("degrades a seat with no league mapping without breaking the others", async () => {
    stubFetchOk(snapshot());
    const el = mount();
    el.seats = [
      realSeat("daveey", "daveey-proxywar:v24"),
      {
        seatId: "exhibition-seat",
        displayName: "Diplomat",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "diplomat",
          declaredVersion: "1",
          manifestSha256: "abc",
          contentSha256: "def",
        },
      },
    ];
    await el.updateComplete;
    await vi.waitFor(() => {
      expect(el.textContent).toContain("Rank 1");
    });

    expect(el.textContent).toContain("Not yet linked to league standings.");
  });

  it("shows an unavailable state, never fabricated numbers, when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const el = mount();
    el.seats = [realSeat("daveey", "daveey-proxywar:v24")];
    await el.updateComplete;
    await vi.waitFor(() => {
      expect(el.textContent).toContain("unavailable");
    });

    expect(el.textContent).not.toContain("Rank");
    expect(el.querySelector('[role="status"]')).toBeNull();
  });

  it("flags stale league data instead of presenting it as current", async () => {
    stubFetchOk({ ...snapshot(), stale: true, lastGoodSyncAt: "2026-07-27T09:00:00.000Z" });
    const el = mount();
    el.seats = [realSeat("daveey", "daveey-proxywar:v24")];
    await el.updateComplete;
    await vi.waitFor(() => {
      expect(el.querySelector('[role="status"]')).not.toBeNull();
    });

    expect(el.textContent).toContain("League data is stale");
    // Numbers still render alongside the warning — degraded, not blanked.
    expect(el.textContent).toContain("Rank 1");
  });

  it("degrades to an empty-league state when league data is missing entirely", async () => {
    stubFetchOk({});
    const el = mount();
    el.seats = [realSeat("daveey", "daveey-proxywar:v24")];
    await el.updateComplete;
    await vi.waitFor(() => {
      expect(el.textContent).toContain("unavailable");
    });
  });
});
