import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  IdentityRegistryError,
  loadAgentRegistry,
  loadAgentVersionRegistry,
  loadBuilderRegistry,
  loadIdentityRegistrySnapshot,
  saveAgentRegistry,
  saveAgentVersionRegistry,
  saveBuilderRegistry,
} from "../../../src/server/identity/IdentityRegistry";
import type { AgentProfile, AgentVersion } from "../../../src/server/identity/IdentitySchemas";

let dir: string;

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
  }
});

const sampleAgent: AgentProfile = {
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
};

describe("registry save/load round trip", () => {
  test("saves and reloads an agent registry byte-identically in structure", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pw-identity-registry-"));
    const filePath = path.join(dir, "agents.json");
    await saveAgentRegistry([sampleAgent], filePath);
    const loaded = await loadAgentRegistry(filePath);
    expect(loaded).toEqual([sampleAgent]);
  });

  test("an empty builder registry round-trips to an empty array", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pw-identity-registry-"));
    const filePath = path.join(dir, "builders.json");
    await saveBuilderRegistry([], filePath);
    expect(await loadBuilderRegistry(filePath)).toEqual([]);
  });

  test("versions round-trip too", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pw-identity-registry-"));
    const filePath = path.join(dir, "versions.json");
    const version: AgentVersion = {
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
    };
    await saveAgentVersionRegistry([version], filePath);
    expect(await loadAgentVersionRegistry(filePath)).toEqual([version]);
  });
});

describe("load failure modes", () => {
  test("throws IdentityRegistryError, naming the file, when it doesn't exist", async () => {
    await expect(
      loadAgentRegistry("/nonexistent/path/agents.json"),
    ).rejects.toThrow(IdentityRegistryError);
  });

  test("throws IdentityRegistryError on malformed JSON", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pw-identity-registry-"));
    const filePath = path.join(dir, "agents.json");
    await writeFile(filePath, "{not json", "utf8");
    await expect(loadAgentRegistry(filePath)).rejects.toThrow(
      IdentityRegistryError,
    );
  });

  test("throws IdentityRegistryError when the schema doesn't parse (a stray unknown field)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pw-identity-registry-"));
    const filePath = path.join(dir, "agents.json");
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        agents: [{ ...sampleAgent, secretToken: "leaked" }],
      }),
      "utf8",
    );
    await expect(loadAgentRegistry(filePath)).rejects.toThrow(
      IdentityRegistryError,
    );
  });
});

describe("loadIdentityRegistrySnapshot against the real tracked registry", () => {
  test("the committed resources/identity/* files parse and validate cleanly", async () => {
    const snapshot = await loadIdentityRegistrySnapshot();
    expect(snapshot.agents.length).toBe(17);
    expect(snapshot.builders.length).toBe(0);
    expect(snapshot.versions.length).toBe(17);
  });
});
