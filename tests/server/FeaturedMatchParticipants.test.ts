import { describe, expect, it } from "vitest";
import { resolveFeaturedMatchParticipantCards } from "../../src/server/agents/FeaturedMatchParticipants";
import type { FeaturedMatch } from "../../src/server/agents/FeaturedMatch";
import type { IdentityRegistrySnapshot } from "../../src/server/identity/IdentityRegistry";

function baseMatch(overrides: Partial<FeaturedMatch> = {}): FeaturedMatch {
  return {
    schemaVersion: 1,
    matchId: `feat_${"a".repeat(20)}`,
    lane: "premiere",
    episodeRequestId: "ereq_x",
    queueItemName: "item",
    title: "Title",
    description: "",
    participants: [
      { playerName: "Auri", agentId: "agt_auri", agentVersionId: "agtv_auri_v3", builderId: null },
      { playerName: "GhostRaider", agentId: null, agentVersionId: null, builderId: null },
    ],
    map: "map",
    format: "1v1",
    provenance: { source: "premiere-queue", sourceRef: "item", capturedAt: "2026-07-31T00:00:00.000Z" },
    state: "published",
    category: null,
    scheduledAt: null,
    revealAt: null,
    evidence: {
      dramaScore: null,
      dramaGrade: null,
      entertainmentScore: null,
      storyGrade: null,
      turnCount: null,
      decisionCount: null,
      degradedCount: null,
      seatCount: null,
      replayComplete: false,
      notes: [],
    },
    postMatchSummary: null,
    result: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

const identity: IdentityRegistrySnapshot = {
  builders: [
    {
      id: "bld_daveey",
      slug: "daveey",
      displayName: "Daveey",
      shortBio: null,
      avatarUrl: null,
      verifiedGithub: null,
      links: [],
      teamMembers: [],
      softmaxPlayerIdentities: [],
      status: "verified",
    },
  ],
  agents: [
    {
      id: "agt_auri",
      slug: "auri",
      displayName: "Auri",
      shortCode: "AUR",
      builderId: "bld_daveey",
      tagline: null,
      description: null,
      emblem: { style: "geometric-svg-v1", seed: "agt_auri", assetPath: "resources/identity/emblems/agt_auri.svg" },
      primaryColor: "#112233",
      secondaryColor: "#445566",
      debutDate: null,
      policyMatchRule: { playerName: "Auri", policyFamily: "daveey-proxywar" },
      status: "verified",
      publicStrategyDescription: null,
    },
  ],
  versions: [
    {
      id: "agtv_auri_v3",
      agentId: "agt_auri",
      publicVersionLabel: "v3",
      softmaxPolicyLabel: "daveey-proxywar:v3",
      immutableDigest: null,
      releaseDate: null,
      releaseNotes: null,
      declaredBaseModel: null,
      scaffoldDescription: null,
      sourceRepositoryRef: null,
      disclosureStatus: "undisclosed",
      qualificationStatus: "active",
      observedVia: ["rating"],
      observedAt: "2026-07-31T00:00:00.000Z",
      firstObservedAt: null,
    },
  ],
};

describe("resolveFeaturedMatchParticipantCards", () => {
  it("resolves a registered participant to full identity, and gives an unregistered one a provisional identity derived from its raw playerName", () => {
    const cards = resolveFeaturedMatchParticipantCards(baseMatch(), identity);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toEqual({
      playerName: "Auri",
      displayName: "Auri",
      agentSlug: "auri",
      emblemSvg: expect.stringContaining("<svg"),
      primaryColor: "#112233",
      secondaryColor: "#445566",
      versionLabel: "v3",
      builderId: "bld_daveey",
      builderDisplayName: "Daveey",
    });
    expect(cards[1]).toEqual({
      playerName: "GhostRaider",
      displayName: "GhostRaider",
      // Never null anymore (2026-08-01 P0 fix) — a cosmetic, deterministic
      // provisional identity derived solely from `playerName`, never a
      // registered id/short code/builder/version.
      agentSlug: "ghostraider",
      emblemSvg: expect.stringContaining("<svg"),
      primaryColor: expect.stringMatching(/^#[0-9a-f]{6}$/),
      secondaryColor: expect.stringMatching(/^#[0-9a-f]{6}$/),
      versionLabel: null,
      builderId: null,
      builderDisplayName: null,
    });
  });

  it("never lets an unregistered participant's provisional slug collide with a real registered agent's slug", () => {
    const match = baseMatch({
      participants: [
        { playerName: "auri", agentId: null, agentVersionId: null, builderId: null },
      ],
    });
    const cards = resolveFeaturedMatchParticipantCards(match, identity);
    expect(cards[0].agentSlug).not.toBe("auri");
    expect(cards[0].agentSlug).toMatch(/^auri-[a-f0-9]{6}$/);
  });

  it("returns [] for a merely 'scheduled' record — never exposes participants before the operator's publish signal", () => {
    expect(resolveFeaturedMatchParticipantCards(baseMatch({ state: "scheduled" }), identity)).toEqual([]);
  });

  it("returns [] for a 'candidate' record", () => {
    expect(resolveFeaturedMatchParticipantCards(baseMatch({ state: "candidate" }), identity)).toEqual([]);
  });

  it("resolves for 'revealed' and 'archived' states too", () => {
    expect(resolveFeaturedMatchParticipantCards(baseMatch({ state: "revealed" }), identity)).toHaveLength(2);
    expect(resolveFeaturedMatchParticipantCards(baseMatch({ state: "archived" }), identity)).toHaveLength(2);
  });

  it("never includes the match result — identity-only, orthogonal to the outcome embargo", () => {
    const revealed = baseMatch({
      state: "revealed",
      result: { winnerAgentId: "agt_auri", placements: [{ agentId: "agt_auri", placement: 1 }] },
    });
    const cards = resolveFeaturedMatchParticipantCards(revealed, identity);
    expect(JSON.stringify(cards)).not.toContain("winnerAgentId");
    expect(JSON.stringify(cards)).not.toContain("placement");
  });
});
