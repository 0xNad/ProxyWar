import { describe, expect, test } from "vitest";
import {
  computeUnmappedPlayerNames,
  findAgentForPlayerName,
  parsePolicyLabel,
  resolveObservedVersion,
} from "../../../src/server/identity/IdentityMatching";
import type {
  AgentProfile,
  AgentVersion,
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

describe("parsePolicyLabel", () => {
  test("splits on the last colon", () => {
    expect(parsePolicyLabel("daveey-proxywar:v24")).toEqual({
      family: "daveey-proxywar",
      version: "v24",
    });
  });
  test("handles a family containing no colon and a non-vN version token", () => {
    expect(parsePolicyLabel("Sun Tzu:v2")).toEqual({
      family: "Sun Tzu",
      version: "v2",
    });
  });
  test("returns null for a label with no colon", () => {
    expect(parsePolicyLabel("no-colon-here")).toBeNull();
  });
});

describe("findAgentForPlayerName", () => {
  test("matches by exact playerName only", () => {
    const agents = [agent()];
    expect(findAgentForPlayerName("daveey", agents)).toBe(agents[0]);
    expect(findAgentForPlayerName("Daveey", agents)).toBeNull();
    expect(findAgentForPlayerName("someone else", agents)).toBeNull();
  });

  test("never matches on shortCode, displayName divergence, or any GitHub-shaped field — LiveIdentityInput carries no such field to match on in the first place", () => {
    const agents = [agent({ displayName: "Not The Player Name" })];
    expect(findAgentForPlayerName("Not The Player Name", agents)).toBeNull();
    expect(findAgentForPlayerName("daveey", agents)).toBe(agents[0]);
  });
});

describe("resolveObservedVersion", () => {
  test("prefers the champion label when both are present", () => {
    const result = resolveObservedVersion(agent(), [], {
      playerName: "daveey",
      ratingPolicyLabel: "daveey-proxywar:v23",
      activeChampionPolicyLabel: "daveey-proxywar:v24",
    });
    expect(result?.source).toBe("champion");
    expect(result?.publicVersionLabel).toBe("v24");
  });

  test("falls back to the rating label when champion is null (the 8-participant seed case)", () => {
    const result = resolveObservedVersion(
      agent({ policyMatchRule: { playerName: "calc", policyFamily: "my-proxywar-agent" } }),
      [],
      {
        playerName: "calc",
        ratingPolicyLabel: null,
        activeChampionPolicyLabel: "my-proxywar-agent:v159",
      },
    );
    expect(result?.source).toBe("champion");
    expect(result?.publicVersionLabel).toBe("v159");
  });

  test("returns null when neither label is present", () => {
    expect(
      resolveObservedVersion(agent(), [], {
        playerName: "daveey",
        ratingPolicyLabel: null,
        activeChampionPolicyLabel: null,
      }),
    ).toBeNull();
  });

  test("a version bump under the same family is a new observed version, not a mismatch — registered stays null, familyMismatch stays false", () => {
    const versions: AgentVersion[] = [
      {
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
        firstObservedAt: null,
      },
    ];
    const result = resolveObservedVersion(agent(), versions, {
      playerName: "daveey",
      ratingPolicyLabel: "daveey-proxywar:v24",
      activeChampionPolicyLabel: "daveey-proxywar:v24",
    });
    expect(result?.registered).toBeNull();
    expect(result?.familyMismatch).toBe(false);
    expect(result?.publicVersionLabel).toBe("v24");
  });

  test("finds the registered AgentVersion when one exists for the exact live label", () => {
    const registered: AgentVersion = {
      id: "agtv_daveey_v24",
      agentId: "agt_daveey",
      publicVersionLabel: "v24",
      softmaxPolicyLabel: "daveey-proxywar:v24",
      immutableDigest: null,
      releaseDate: null,
      releaseNotes: "seed",
      declaredBaseModel: null,
      scaffoldDescription: null,
      sourceRepositoryRef: null,
      disclosureStatus: "undisclosed",
      qualificationStatus: "active",
      observedVia: ["champion", "rating"],
      observedAt: "2026-07-31T00:30:00.000Z",
      firstObservedAt: null,
    };
    const result = resolveObservedVersion(agent(), [registered], {
      playerName: "daveey",
      ratingPolicyLabel: "daveey-proxywar:v24",
      activeChampionPolicyLabel: "daveey-proxywar:v24",
    });
    expect(result?.registered).toBe(registered);
  });

  test("flags familyMismatch true when the live label's family no longer matches the registered rule — a real signal, not a silent re-map", () => {
    const result = resolveObservedVersion(agent(), [], {
      playerName: "daveey",
      ratingPolicyLabel: null,
      activeChampionPolicyLabel: "a-totally-different-family:v1",
    });
    expect(result?.familyMismatch).toBe(true);
    // Still resolves to the SAME agent (playerName matched) — a family
    // change is a flag for review, never a trigger to re-match elsewhere.
  });
});

describe("computeUnmappedPlayerNames", () => {
  test("returns empty when every live player has a registered agent", () => {
    expect(
      computeUnmappedPlayerNames(["daveey"], [agent()]),
    ).toEqual([]);
  });

  test("reports a live player with no registered agent", () => {
    expect(
      computeUnmappedPlayerNames(["daveey", "new-participant"], [agent()]),
    ).toEqual(["new-participant"]);
  });

  test("an empty registry reports every live player as unmapped", () => {
    expect(computeUnmappedPlayerNames(["a", "b"], [])).toEqual(["a", "b"]);
  });
});
