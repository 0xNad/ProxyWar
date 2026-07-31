import { describe, expect, test } from "vitest";
import { validateIdentityRegistrySnapshot } from "../../../src/server/identity/IdentityValidation";
import type {
  AgentProfile,
  AgentVersion,
  BuilderProfile,
} from "../../../src/server/identity/IdentitySchemas";

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

function builder(overrides: Partial<BuilderProfile> = {}): BuilderProfile {
  return {
    id: "bld_someone",
    slug: "someone",
    displayName: "Someone",
    shortBio: null,
    avatarUrl: null,
    verifiedGithub: null,
    links: [],
    teamMembers: [],
    softmaxPlayerIdentities: [],
    status: "verified",
    ...overrides,
  };
}

function version(overrides: Partial<AgentVersion> = {}): AgentVersion {
  return {
    id: "agtv_daveey_v24",
    agentId: "agt_daveey",
    publicVersionLabel: "v24",
    softmaxPolicyLabel: "daveey-proxywar:v24",
    immutableDigest: null,
    releaseDate: null,
    releaseNotes: null,
    declaredBaseModel: null,
    scaffoldDescription: null,
    sourceRepositoryRef: null,
    disclosureStatus: "undisclosed",
    qualificationStatus: "active",
    observedVia: ["champion", "rating"],
    observedAt: "2026-07-31T00:30:00.000Z",
    firstObservedAt: null,
    ...overrides,
  };
}

describe("validateIdentityRegistrySnapshot", () => {
  test("passes on a single well-formed agent + version, no builders", () => {
    const result = validateIdentityRegistrySnapshot({
      builders: [],
      agents: [agent()],
      versions: [version()],
    });
    expect(result.errors).toEqual([]);
  });

  test("rejects a duplicate slug across two agents", () => {
    const result = validateIdentityRegistrySnapshot({
      builders: [],
      agents: [
        agent(),
        agent({ id: "agt_daveey-2", displayName: "Also Daveey", policyMatchRule: { playerName: "someone else", policyFamily: "x" } }),
      ],
      versions: [],
    });
    expect(result.errors.some((e) => e.includes("slug"))).toBe(true);
  });

  test("rejects two agents matching the same live playerName", () => {
    const result = validateIdentityRegistrySnapshot({
      builders: [],
      agents: [
        agent(),
        agent({ id: "agt_second", slug: "second", shortCode: "SEC" }),
      ],
      versions: [],
    });
    expect(
      result.errors.some((e) => e.includes('"daveey" is matched by both')),
    ).toBe(true);
  });

  test("rejects a short-code collision", () => {
    const result = validateIdentityRegistrySnapshot({
      builders: [],
      agents: [
        agent(),
        agent({
          id: "agt_second",
          slug: "second",
          policyMatchRule: { playerName: "second", policyFamily: "x" },
        }),
      ],
      versions: [],
    });
    expect(result.errors.some((e) => e.includes("collides"))).toBe(true);
  });

  test("warns (does not error) when one short code is a prefix of another — the CA/CAL confusability class", () => {
    const result = validateIdentityRegistrySnapshot({
      builders: [],
      agents: [
        agent({ shortCode: "CA", policyMatchRule: { playerName: "p1", policyFamily: "x" } }),
        agent({
          id: "agt_second",
          slug: "second",
          shortCode: "CAL",
          emblem: {
            style: "geometric-svg-v1",
            seed: "agt_second",
            assetPath: "resources/identity/emblems/agt_second.svg",
          },
          policyMatchRule: { playerName: "p2", policyFamily: "y" },
        }),
      ],
      versions: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("prefix"))).toBe(true);
  });

  test("rejects an agent whose builderId has no matching BuilderProfile", () => {
    const result = validateIdentityRegistrySnapshot({
      builders: [],
      agents: [agent({ builderId: "bld_ghost", status: "verified" })],
      versions: [],
    });
    expect(
      result.errors.some((e) => e.includes("no matching BuilderProfile")),
    ).toBe(true);
  });

  test("rejects status \"verified\" with a null builderId — the no-auto-attribution invariant at the schema-integrity layer", () => {
    const result = validateIdentityRegistrySnapshot({
      builders: [],
      agents: [agent({ builderId: null, status: "verified" })],
      versions: [],
    });
    expect(
      result.errors.some((e) => e.includes('status is "verified" but builderId is null')),
    ).toBe(true);
  });

  test("accepts a verified agent once its builderId resolves", () => {
    const result = validateIdentityRegistrySnapshot({
      builders: [builder()],
      agents: [agent({ builderId: "bld_someone", status: "verified" })],
      versions: [],
    });
    expect(result.errors).toEqual([]);
  });

  test("rejects a version whose agentId has no matching AgentProfile", () => {
    const result = validateIdentityRegistrySnapshot({
      builders: [],
      agents: [],
      versions: [version()],
    });
    expect(
      result.errors.some((e) => e.includes("no matching AgentProfile")),
    ).toBe(true);
  });

  test("rejects a version id whose agent-slug segment doesn't match the owning agent", () => {
    const result = validateIdentityRegistrySnapshot({
      builders: [],
      agents: [agent()],
      versions: [version({ id: "agtv_wrongslug_v24" })],
    });
    expect(
      result.errors.some((e) => e.includes("agent-slug segment")),
    ).toBe(true);
  });

  test("rejects an emblem.seed that doesn't equal the agent's own id", () => {
    const result = validateIdentityRegistrySnapshot({
      builders: [],
      agents: [
        agent({
          emblem: {
            style: "geometric-svg-v1",
            seed: "agt_someone-else",
            assetPath: "resources/identity/emblems/agt_daveey.svg",
          },
        }),
      ],
      versions: [],
    });
    expect(result.errors.some((e) => e.includes("emblem.seed"))).toBe(true);
  });

  test("flags a GitHub-token-shaped string anywhere in the snapshot", () => {
    const result = validateIdentityRegistrySnapshot({
      builders: [
        builder({ shortBio: "reach me at ghp_abcdefghijklmnopqrst1234" }),
      ],
      agents: [],
      versions: [],
    });
    expect(
      result.errors.some((e) => e.includes("secret-shaped pattern")),
    ).toBe(true);
  });
});
