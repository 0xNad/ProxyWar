import { describe, expect, test } from "vitest";
import {
  AgentProfileSchema,
  AgentVersionSchema,
  BuilderProfileSchema,
  HexColorSchema,
  ShortCodeSchema,
  SlugSchema,
} from "../../../src/server/identity/IdentitySchemas";

const validAgent = {
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
  status: "unclaimed" as const,
  publicStrategyDescription: null,
};

describe("SlugSchema", () => {
  test("accepts lowercase hyphenated slugs", () => {
    expect(SlugSchema.safeParse("k1z-mickey-mouse").success).toBe(true);
  });
  test("rejects the un-encoded @ that made ron-@-swgy unsafe", () => {
    expect(SlugSchema.safeParse("ron-@-swgy").success).toBe(false);
  });
  test("rejects uppercase, spaces, and double hyphens", () => {
    expect(SlugSchema.safeParse("Daveey").success).toBe(false);
    expect(SlugSchema.safeParse("ron swgy").success).toBe(false);
    expect(SlugSchema.safeParse("ron--swgy").success).toBe(false);
  });
});

describe("ShortCodeSchema", () => {
  test("accepts 2-4 uppercase alphanumeric characters", () => {
    expect(ShortCodeSchema.safeParse("K1Z").success).toBe(true);
    expect(ShortCodeSchema.safeParse("CALC").success).toBe(true);
    expect(ShortCodeSchema.safeParse("AU").success).toBe(true);
  });
  test("rejects lowercase, 1 char, 5+ chars", () => {
    expect(ShortCodeSchema.safeParse("dav").success).toBe(false);
    expect(ShortCodeSchema.safeParse("A").success).toBe(false);
    expect(ShortCodeSchema.safeParse("ABCDE").success).toBe(false);
  });
});

describe("HexColorSchema", () => {
  test("accepts lowercase #rrggbb only", () => {
    expect(HexColorSchema.safeParse("#c62f39").success).toBe(true);
    expect(HexColorSchema.safeParse("#C62F39").success).toBe(false);
    expect(HexColorSchema.safeParse("c62f39").success).toBe(false);
  });
});

describe("AgentProfileSchema", () => {
  test("accepts a fully-formed unclaimed agent", () => {
    expect(AgentProfileSchema.safeParse(validAgent).success).toBe(true);
  });

  test("rejects an unknown field — the .strict() secret-smuggling defense", () => {
    const parsed = AgentProfileSchema.safeParse({
      ...validAgent,
      githubToken: "ghp_shouldNeverBeHere",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects status \"verified\" is not itself schema-enforced against builderId (that's IdentityValidation's job), but rejects an unknown status value", () => {
    expect(
      AgentProfileSchema.safeParse({ ...validAgent, status: "trusted" })
        .success,
    ).toBe(false);
  });

  test("rejects a display name over 80 chars, an empty slug, and a malformed id", () => {
    expect(
      AgentProfileSchema.safeParse({
        ...validAgent,
        displayName: "x".repeat(81),
      }).success,
    ).toBe(false);
    expect(
      AgentProfileSchema.safeParse({ ...validAgent, id: "daveey" }).success,
    ).toBe(false);
  });
});

describe("BuilderProfileSchema", () => {
  test("accepts an unclaimed builder shape with every optional field null/empty", () => {
    const builder = {
      id: "bld_example",
      slug: "example",
      displayName: null,
      shortBio: null,
      avatarUrl: null,
      verifiedGithub: null,
      links: [],
      teamMembers: [],
      softmaxPlayerIdentities: [],
      status: "unclaimed" as const,
    };
    expect(BuilderProfileSchema.safeParse(builder).success).toBe(true);
  });
});

describe("AgentVersionSchema", () => {
  const validVersion = {
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
    disclosureStatus: "undisclosed" as const,
    qualificationStatus: "active" as const,
    observedVia: ["champion", "rating"] as const,
    observedAt: "2026-07-31T00:30:00.000Z",
  };

  test("accepts a fully-formed undisclosed version", () => {
    expect(AgentVersionSchema.safeParse(validVersion).success).toBe(true);
  });

  test("rejects an empty observedVia — the champion/rating distinction must always be present", () => {
    expect(
      AgentVersionSchema.safeParse({ ...validVersion, observedVia: [] })
        .success,
    ).toBe(false);
  });

  test("rejects a non-ISO observedAt", () => {
    expect(
      AgentVersionSchema.safeParse({
        ...validVersion,
        observedAt: "yesterday",
      }).success,
    ).toBe(false);
  });
});
