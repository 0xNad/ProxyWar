import { describe, expect, it } from "vitest";
import { buildReasonToWatchClaims } from "../../../../src/server/agents/season/CandidateReasonToWatch";
import type { FeaturedMatchParticipant } from "../../../../src/server/agents/FeaturedMatch";
import type { IdentityRegistrySnapshot } from "../../../../src/server/identity/IdentityRegistry";
import type { AgentProfile, AgentVersion } from "../../../../src/server/identity/IdentitySchemas";
import type {
  CoworldLeagueEpisodePlayerRow,
  CoworldLeagueEpisodeRow,
  CoworldLeagueStandingRow,
} from "../../../../src/server/agents/CoworldLeagueSiteWriter";

const NOW = new Date("2026-08-08T00:00:00.000Z");

function agent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agt_auri",
    slug: "auri",
    displayName: "Auri",
    shortCode: "AUR",
    builderId: null,
    tagline: null,
    description: null,
    emblem: { style: "geometric-svg-v1", seed: "agt_auri", assetPath: "x.svg" },
    primaryColor: "#111111",
    secondaryColor: "#222222",
    debutDate: null,
    policyMatchRule: { playerName: "Auri", policyFamily: "auri-family" },
    status: "unclaimed",
    publicStrategyDescription: null,
    ...overrides,
  };
}

function version(overrides: Partial<AgentVersion> = {}): AgentVersion {
  return {
    id: "agtv_auri_v43",
    agentId: "agt_auri",
    publicVersionLabel: "v43",
    softmaxPolicyLabel: "auri:v43",
    immutableDigest: null,
    releaseDate: null,
    releaseNotes: null,
    declaredBaseModel: null,
    scaffoldDescription: null,
    sourceRepositoryRef: null,
    disclosureStatus: "undisclosed",
    qualificationStatus: "active",
    observedVia: ["champion"],
    observedAt: "2026-08-01T00:00:00.000Z",
    firstObservedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function participant(overrides: Partial<FeaturedMatchParticipant> = {}): FeaturedMatchParticipant {
  return { playerName: "Auri", agentId: "agt_auri", agentVersionId: "agtv_auri_v43", builderId: null, ...overrides };
}

function player(overrides: Partial<CoworldLeagueEpisodePlayerRow>): CoworldLeagueEpisodePlayerRow {
  return { slot: 0, name: "Auri", tilesOwned: 0, isAlive: false, isWinner: false, color: "#000", ...overrides };
}

function episode(overrides: Partial<CoworldLeagueEpisodeRow>): CoworldLeagueEpisodeRow {
  return {
    episodeRequestId: "ereq_x",
    shortId: "x",
    roundNumber: 1,
    completedAt: "2026-08-01T00:00:00.000Z",
    map: "Pangaea",
    mapSize: "Normal",
    turnCount: 10000,
    decisionCount: null,
    degradedCount: null,
    winnerName: null,
    players: [],
    watchHref: null,
    fullRenderHref: null,
    ...overrides,
  };
}

function identitySnapshot(overrides: Partial<IdentityRegistrySnapshot> = {}): IdentityRegistrySnapshot {
  return { builders: [], agents: [agent()], versions: [version()], ...overrides };
}

describe("buildReasonToWatchClaims", () => {
  it("returns [] when participants carry no resolved identity", () => {
    const claims = buildReasonToWatchClaims([], "Pangaea", identitySnapshot(), [], [], NOW);
    expect(claims).toEqual([]);
  });

  it("emits a version_debut claim for a recently first-observed version, referencing the version id", () => {
    const claims = buildReasonToWatchClaims(
      [participant()],
      "Pangaea",
      identitySnapshot(),
      [],
      [],
      NOW,
    );
    const debut = claims.find((claim) => claim.source === "version_debut");
    expect(debut).toBeDefined();
    expect(debut!.reference).toContain("agtv_auri_v43");
    expect(debut!.text).toContain("v43");
  });

  it("does not emit a version_debut claim once firstObservedAt is outside the recent window", () => {
    const staleVersion = version({ firstObservedAt: "2026-01-01T00:00:00.000Z" });
    const claims = buildReasonToWatchClaims(
      [participant()],
      "Pangaea",
      identitySnapshot({ versions: [staleVersion] }),
      [],
      [],
      NOW,
    );
    expect(claims.some((claim) => claim.source === "version_debut")).toBe(false);
  });

  it("attaches recent-form context to the debut claim from retained episodes", () => {
    const episodes = [
      episode({ episodeRequestId: "e1", players: [player({ name: "Auri", isWinner: true })] }),
      episode({ episodeRequestId: "e2", players: [player({ name: "Auri", isWinner: true })] }),
      episode({ episodeRequestId: "e3", players: [player({ name: "Auri", isWinner: false })] }),
    ];
    const claims = buildReasonToWatchClaims([participant()], "Pangaea", identitySnapshot(), [], episodes, NOW);
    const debut = claims.find((claim) => claim.source === "version_debut");
    expect(debut!.text).toContain("winning 2 of its last 3");
  });

  it("emits a standings_rank claim only when the participant ranks within the top threshold", () => {
    const standings: CoworldLeagueStandingRow[] = [
      { rank: 1, playerName: "Auri", ratingPolicyLabel: null, activeChampionPolicyLabel: null, policyLabel: null, score: 1500, roundsPlayed: 20, isHouse: false },
    ];
    const claims = buildReasonToWatchClaims([participant()], "Pangaea", identitySnapshot({ versions: [] }), standings, [], NOW);
    const rankClaim = claims.find((claim) => claim.source === "standings_rank");
    expect(rankClaim).toBeDefined();
    expect(rankClaim!.reference).toBe("standings:Auri:rank=1");
  });

  it("does not emit a standings_rank claim for a rank outside the top threshold", () => {
    const standings: CoworldLeagueStandingRow[] = [
      { rank: 50, playerName: "Auri", ratingPolicyLabel: null, activeChampionPolicyLabel: null, policyLabel: null, score: 10, roundsPlayed: 20, isHouse: false },
    ];
    const claims = buildReasonToWatchClaims([participant()], "Pangaea", identitySnapshot({ versions: [] }), standings, [], NOW);
    expect(claims.some((claim) => claim.source === "standings_rank")).toBe(false);
  });

  it("emits a map-specific head-to-head claim when enough same-map meetings exist", () => {
    const a = participant({ playerName: "Auri", agentId: "agt_auri" });
    const b = participant({ playerName: "Sefirot", agentId: "agt_sefirot", agentVersionId: null });
    const episodes = [
      episode({
        episodeRequestId: "e1",
        map: "Pangaea",
        players: [player({ name: "Auri", isWinner: true }), player({ name: "Sefirot", slot: 1, isWinner: false })],
      }),
      episode({
        episodeRequestId: "e2",
        map: "Pangaea",
        players: [player({ name: "Auri", isWinner: false }), player({ name: "Sefirot", slot: 1, isWinner: true })],
      }),
    ];
    const claims = buildReasonToWatchClaims([a, b], "Pangaea", identitySnapshot({ versions: [] }), [], episodes, NOW);
    const h2h = claims.find((claim) => claim.source === "head_to_head");
    expect(h2h).toBeDefined();
    expect(h2h!.text).toContain("on Pangaea");
    expect(h2h!.text).toContain("1-1");
  });

  it("falls back to an all-map head-to-head sample when the current map has too few meetings", () => {
    const a = participant({ playerName: "Auri", agentId: "agt_auri" });
    const b = participant({ playerName: "Sefirot", agentId: "agt_sefirot", agentVersionId: null });
    const episodes = [
      episode({
        episodeRequestId: "e1",
        map: "OtherMap",
        players: [player({ name: "Auri", isWinner: true }), player({ name: "Sefirot", slot: 1, isWinner: false })],
      }),
      episode({
        episodeRequestId: "e2",
        map: "OtherMap",
        players: [player({ name: "Auri", isWinner: true }), player({ name: "Sefirot", slot: 1, isWinner: false })],
      }),
    ];
    const claims = buildReasonToWatchClaims([a, b], "Pangaea", identitySnapshot({ versions: [] }), [], episodes, NOW);
    const h2h = claims.find((claim) => claim.source === "head_to_head");
    expect(h2h).toBeDefined();
    expect(h2h!.text).toContain("across all retained maps");
  });

  it("emits no head-to-head claim below the minimum sample size", () => {
    const a = participant({ playerName: "Auri", agentId: "agt_auri" });
    const b = participant({ playerName: "Sefirot", agentId: "agt_sefirot", agentVersionId: null });
    const claims = buildReasonToWatchClaims([a, b], "Pangaea", identitySnapshot({ versions: [] }), [], [], NOW);
    expect(claims.some((claim) => claim.source === "head_to_head")).toBe(false);
  });

  it("emits no head-to-head claim when there are not exactly two participants", () => {
    const claims = buildReasonToWatchClaims([participant()], "Pangaea", identitySnapshot(), [], [], NOW);
    expect(claims.some((claim) => claim.source === "head_to_head")).toBe(false);
  });
});
