import { describe, expect, it } from "vitest";
import { detectNewlyObservedVersions } from "../../src/scripts/sync-version-registry";
import type {
  AgentProfile,
  AgentVersion,
} from "../../src/server/identity/IdentitySchemas";

const NOW = "2026-08-01T00:00:00.000Z";

function agent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agt_daveey",
    slug: "daveey",
    displayName: "daveey",
    shortCode: "DAV",
    builderId: null,
    tagline: null,
    description: null,
    emblem: {
      style: "geometric-svg-v1",
      seed: "agt_daveey",
      assetPath: "resources/identity/emblems/agt_daveey.svg",
    },
    primaryColor: "#c62f39",
    secondaryColor: "#689e2e",
    debutDate: null,
    policyMatchRule: { playerName: "daveey", policyFamily: "daveey-proxywar" },
    status: "unclaimed",
    publicStrategyDescription: null,
    ...overrides,
  };
}

function version(overrides: Partial<AgentVersion> = {}): AgentVersion {
  return {
    id: "agtv_daveey_v23",
    agentId: "agt_daveey",
    publicVersionLabel: "v23",
    softmaxPolicyLabel: "daveey-proxywar:v23",
    immutableDigest: null,
    releaseDate: null,
    releaseNotes: null,
    declaredBaseModel: null,
    scaffoldDescription: null,
    sourceRepositoryRef: null,
    disclosureStatus: "undisclosed",
    qualificationStatus: "retired",
    observedVia: ["champion"],
    observedAt: "2026-07-01T00:00:00.000Z",
    firstObservedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("detectNewlyObservedVersions", () => {
  it("creates a new AgentVersion, timestamped now, for a same-family version bump with no registered record", () => {
    const created = detectNewlyObservedVersions(
      [
        {
          playerName: "daveey",
          ratingPolicyLabel: "daveey-proxywar:v24",
          activeChampionPolicyLabel: "daveey-proxywar:v24",
        },
      ],
      [agent()],
      [version()],
      NOW,
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: "agtv_daveey_v24",
      agentId: "agt_daveey",
      publicVersionLabel: "v24",
      softmaxPolicyLabel: "daveey-proxywar:v24",
      observedVia: ["champion"],
      observedAt: NOW,
      firstObservedAt: NOW,
      releaseDate: null,
    });
  });

  it("creates nothing for a label that's already registered", () => {
    const created = detectNewlyObservedVersions(
      [
        {
          playerName: "daveey",
          ratingPolicyLabel: "daveey-proxywar:v23",
          activeChampionPolicyLabel: "daveey-proxywar:v23",
        },
      ],
      [agent()],
      [version()],
      NOW,
    );
    expect(created).toEqual([]);
  });

  it("creates nothing for a familyMismatch — a lineage change is an operator-review signal, never an auto-created version", () => {
    const created = detectNewlyObservedVersions(
      [
        {
          playerName: "daveey",
          ratingPolicyLabel: null,
          activeChampionPolicyLabel: "a-totally-different-family:v1",
        },
      ],
      [agent()],
      [version()],
      NOW,
    );
    expect(created).toEqual([]);
  });

  it("creates nothing for a live player with no registered AgentProfile — playerName match only, never a fuzzy/inferred one", () => {
    const created = detectNewlyObservedVersions(
      [
        {
          playerName: "someone-unregistered",
          ratingPolicyLabel: "someone-unregistered:v1",
          activeChampionPolicyLabel: "someone-unregistered:v1",
        },
      ],
      [agent()],
      [],
      NOW,
    );
    expect(created).toEqual([]);
  });

  it("never creates a second record for the same bump within one call, even with duplicate rows", () => {
    const row = {
      playerName: "daveey",
      ratingPolicyLabel: "daveey-proxywar:v24",
      activeChampionPolicyLabel: "daveey-proxywar:v24",
    };
    const created = detectNewlyObservedVersions(
      [row, row],
      [agent()],
      [version()],
      NOW,
    );
    expect(created).toHaveLength(1);
  });

  it("creates independent version-bump records for two different agents in the same pass", () => {
    const created = detectNewlyObservedVersions(
      [
        {
          playerName: "daveey",
          ratingPolicyLabel: "daveey-proxywar:v24",
          activeChampionPolicyLabel: "daveey-proxywar:v24",
        },
        {
          playerName: "auri",
          ratingPolicyLabel: "proxywar-keystone:v43",
          activeChampionPolicyLabel: "proxywar-keystone:v43",
        },
      ],
      [
        agent(),
        agent({
          id: "agt_auri",
          slug: "auri",
          policyMatchRule: { playerName: "auri", policyFamily: "proxywar-keystone" },
        }),
      ],
      [
        version(),
        version({
          id: "agtv_auri_v42",
          agentId: "agt_auri",
          publicVersionLabel: "v42",
          softmaxPolicyLabel: "proxywar-keystone:v42",
        }),
      ],
      NOW,
    );
    expect(created.map((v) => v.id).sort()).toEqual([
      "agtv_auri_v43",
      "agtv_daveey_v24",
    ]);
  });
});
