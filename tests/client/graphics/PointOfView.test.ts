/**
 * Coverage for the two pure, injectable halves of the replay PoV default:
 * `resolveClaimedLineageSlugs` (origin-based dispatch, zero requests on
 * an unintegrated origin) and `findPlayerForClaimedLineages`
 * (deterministic pick among several owned lineages present in a match).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findPlayerForClaimedLineages,
  resolveClaimedLineageSlugs,
} from "../../../src/client/graphics/PointOfView";
import { GameView, PlayerView } from "../../../src/core/game/GameView";
import type { LeagueStandingRow } from "../../../src/client/prediction/wagering/leagueData";

const PLATFORM_ORIGIN = "https://app.proxywar.xyz";
const APEX_PLATFORM_ORIGIN = "https://proxywar.xyz";

function setLocation(origin: string, hostname: string): void {
  Object.defineProperty(window, "location", {
    value: { origin, hostname },
    writable: true,
    configurable: true,
  });
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveClaimedLineageSlugs", () => {
  it("app.proxywar.xyz (today's platform origin): fetches /api/account and reads the top-level claim set", async () => {
    setLocation(PLATFORM_ORIGIN, "app.proxywar.xyz");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        claims: [
          { lineageSlug: "daveey-proxywar", label: "daveey-proxywar:v24" },
          { lineageSlug: "second-lineage", label: "second-lineage:v3" },
        ],
      }),
    );
    const slugs = await resolveClaimedLineageSlugs(fetchImpl, PLATFORM_ORIGIN);
    expect(slugs).toEqual(["daveey-proxywar", "second-lineage"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/account",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("proxywar.xyz (the post-cutover apex, once configured as the platform origin): resolves the SAME way — origin-configured, not hostname-prefix-matched", async () => {
    setLocation(APEX_PLATFORM_ORIGIN, "proxywar.xyz");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        claims: [{ lineageSlug: "daveey-proxywar", label: "daveey-proxywar:v24" }],
      }),
    );
    const slugs = await resolveClaimedLineageSlugs(fetchImpl, APEX_PLATFORM_ORIGIN);
    expect(slugs).toEqual(["daveey-proxywar"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/account",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("an origin that does NOT match the configured platform origin (and isn't bet.) never hits the platform endpoint — no accidental cross-deployment match", async () => {
    // Deployment is configured for the apex, but this viewer is on app. —
    // must NOT be treated as the platform origin just because it once was.
    setLocation(PLATFORM_ORIGIN, "app.proxywar.xyz");
    const fetchImpl = vi.fn(async () => jsonResponse({ claims: [] }));
    const slugs = await resolveClaimedLineageSlugs(fetchImpl, APEX_PLATFORM_ORIGIN);
    expect(slugs).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bet.proxywar.xyz: fetches /api/premieres/account and reads identity.claims, independent of the configured platform origin", async () => {
    setLocation("https://bet.proxywar.xyz", "bet.proxywar.xyz");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        identity: {
          claims: [{ lineageSlug: "daveey-proxywar", label: "daveey-proxywar:v24" }],
        },
      }),
    );
    const slugs = await resolveClaimedLineageSlugs(fetchImpl, PLATFORM_ORIGIN);
    expect(slugs).toEqual(["daveey-proxywar"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/premieres/account",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("beta.proxywar.xyz (no integration): resolves to [] with ZERO requests", async () => {
    setLocation("https://beta.proxywar.xyz", "beta.proxywar.xyz");
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const slugs = await resolveClaimedLineageSlugs(fetchImpl, PLATFORM_ORIGIN);
    expect(slugs).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an unlinked guest on the platform origin costs nothing but the one fetch — an empty claim set resolves to []", async () => {
    setLocation(PLATFORM_ORIGIN, "app.proxywar.xyz");
    const fetchImpl = vi.fn(async () => jsonResponse({ claims: [] }));
    expect(await resolveClaimedLineageSlugs(fetchImpl, PLATFORM_ORIGIN)).toEqual([]);
  });

  it("degrades to [] on a network failure, never throws", async () => {
    setLocation(PLATFORM_ORIGIN, "app.proxywar.xyz");
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      resolveClaimedLineageSlugs(fetchImpl, PLATFORM_ORIGIN),
    ).resolves.toEqual([]);
  });

  it("degrades to [] on a non-ok response, never throws", async () => {
    setLocation(PLATFORM_ORIGIN, "app.proxywar.xyz");
    const fetchImpl = vi.fn(async () => ({ ok: false }) as unknown as Response);
    expect(await resolveClaimedLineageSlugs(fetchImpl, PLATFORM_ORIGIN)).toEqual([]);
  });

  it("degrades to [] on a malformed body, never throws", async () => {
    setLocation(PLATFORM_ORIGIN, "app.proxywar.xyz");
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));
    expect(await resolveClaimedLineageSlugs(fetchImpl, PLATFORM_ORIGIN)).toEqual([]);
  });
});

describe("findPlayerForClaimedLineages", () => {
  function standing(overrides: Partial<LeagueStandingRow> = {}): LeagueStandingRow {
    return {
      rank: 1,
      playerName: "Agent A",
      ratingPolicyLabel: null,
      activeChampionPolicyLabel: null,
      policyLabel: "lineage-a:v10",
      score: 1200,
      roundsPlayed: 50,
      isHouse: false,
      ...overrides,
    };
  }

  function player(displayName: string): PlayerView {
    return { displayName: () => displayName } as unknown as PlayerView;
  }

  function game(players: readonly PlayerView[]): GameView {
    return { playerViews: () => players } as unknown as GameView;
  }

  it("exactly one owned lineage in the match: follows it", () => {
    const agentA = player("Agent A");
    const result = findPlayerForClaimedLineages(
      game([agentA, player("Agent B")]),
      [standing({ playerName: "Agent A", policyLabel: "lineage-a:v10" })],
      ["lineage-a"],
    );
    expect(result).toBe(agentA);
  });

  it("several owned lineages, only one present in this match: follows the one that's present", () => {
    const agentB = player("Agent B");
    const result = findPlayerForClaimedLineages(
      game([player("Agent A"), agentB]),
      [standing({ playerName: "Agent B", policyLabel: "lineage-b:v3" })],
      ["lineage-a", "lineage-b"],
    );
    expect(result).toBe(agentB);
  });

  it("several owned lineages ALL present: picks deterministically — the first in the (server-ordered) list, not standings order", () => {
    const agentA = player("Agent A");
    const agentB = player("Agent B");
    const result = findPlayerForClaimedLineages(
      game([agentB, agentA]),
      [
        standing({ playerName: "Agent B", policyLabel: "lineage-b:v3" }),
        standing({ playerName: "Agent A", policyLabel: "lineage-a:v10" }),
      ],
      // Server order (oldest-claimed first) names lineage-b before
      // lineage-a — the pick must follow THIS order, not standings order.
      ["lineage-b", "lineage-a"],
    );
    expect(result).toBe(agentB);
  });

  it("none of the owned lineages are present in this match: returns null (neutral default)", () => {
    const result = findPlayerForClaimedLineages(
      game([player("Agent A")]),
      [standing({ playerName: "Agent A", policyLabel: "lineage-a:v10" })],
      ["never-in-this-match"],
    );
    expect(result).toBeNull();
  });

  it("no owned lineages at all: returns null", () => {
    const result = findPlayerForClaimedLineages(
      game([player("Agent A")]),
      [standing()],
      [],
    );
    expect(result).toBeNull();
  });

  it("a lineage with a standings row but no matching player in THIS game falls through to the next owned lineage", () => {
    const agentB = player("Agent B");
    const result = findPlayerForClaimedLineages(
      game([agentB]),
      [
        // lineage-a has a standings row, but "Agent A" isn't in this game.
        standing({ playerName: "Agent A", policyLabel: "lineage-a:v10" }),
        standing({ playerName: "Agent B", policyLabel: "lineage-b:v3" }),
      ],
      ["lineage-a", "lineage-b"],
    );
    expect(result).toBe(agentB);
  });
});
