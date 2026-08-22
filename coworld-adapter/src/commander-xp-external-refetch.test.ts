import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCommanderXpPreRegistration,
  COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT,
  COMMANDER_XP_BEHAVIOR_SOURCE_SHA,
  COMMANDER_XP_BEHAVIOR_SOURCE_TREE_SHA,
  COMMANDER_XP_OPENAPI_SHA256,
  type CommanderXpPlanInput,
} from "../../src/server/agents/CommanderXpProtocol";
import { verifyCommanderXpPlatformRefetch } from "./commander-xp-external-refetch";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Commander XP independent Coworld refetch", () => {
  it("emits a self-hashed empty authority receipt for preregistration", async () => {
    const root = await fixtureRoot();
    const output = path.join(root, "refetch.json");
    const command = path.join(root, "unused-command");
    await fs.writeFile(command, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    const result = await verifyCommanderXpPlatformRefetch(
      root,
      command,
      output,
    );
    expect(result).toMatchObject({
      schemaVersion: 2,
      authority: "independent-coworld-0.1.42-refetch-v2",
      phase: "preregistration",
      runCount: 0,
      runs: [],
    });
    expect(String(result.refetchSha256)).toMatch(/^[0-9a-f]{64}$/);
    await expect(fs.readFile(output, "utf8")).resolves.not.toContain("private");
  });

  it("rejects an evidence index that is detached from the preregistration", async () => {
    const root = await fixtureRoot();
    const indexPath = path.join(root, "commander-xp-evidence-index-v2.json");
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    index.experimentID = "substituted-experiment";
    await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`);
    const command = path.join(root, "unused-command");
    await fs.writeFile(command, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    await expect(
      verifyCommanderXpPlatformRefetch(
        root,
        command,
        path.join(root, "refetch.json"),
      ),
    ).rejects.toThrow("refetch evidence index identity mismatch");
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "commander-xp-refetch-test-"),
  );
  temporaryDirectories.push(root);
  const input: CommanderXpPlanInput = {
    experimentID: "refetch-fixture-v2",
    createdAt: "2026-08-22T13:00:00.000Z",
    behaviorSourceSha: COMMANDER_XP_BEHAVIOR_SOURCE_SHA,
    behaviorSourceTreeSha: COMMANDER_XP_BEHAVIOR_SOURCE_TREE_SHA,
    adapterSourceSha: "1".repeat(40),
    adapterSourceTreeSha: "2".repeat(40),
    sourceDiffManifestSha256: "3".repeat(64),
    sourceProvenanceSha256: "4".repeat(64),
    policyBuildProvenanceDigest: `sha256:${"5".repeat(64)}`,
    gameBuildProvenanceDigest: `sha256:${"6".repeat(64)}`,
    coworldID: "cow_refetch-fixture",
    coworldVersion: "0.1.0",
    coworldManifestSha256: "7".repeat(64),
    coworldHostedManifestSha256: "6".repeat(64),
    coworldGameImageID: "img_refetch-fixture",
    coworldGameImageDigest: `sha256:${"8".repeat(64)}`,
    canonicalLeagueBindingSnapshotSha256: "9".repeat(64),
    imageDigest: `sha256:${"a".repeat(64)}`,
    bedrockModel: COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT.modelID,
    xpOpenApiSha256: COMMANDER_XP_OPENAPI_SHA256,
    armPolicyVersionIDs: {
      A: "pvid_refetch_a",
      B: "pvid_refetch_b",
      C: "pvid_refetch_c",
    },
    opponentPolicyVersionIDs: [
      "pvid_refetch_opponent_1",
      "pvid_refetch_opponent_2",
      "pvid_refetch_opponent_3",
    ],
  };
  const preregistration = buildCommanderXpPreRegistration(input);
  await fs.writeFile(
    path.join(root, "commander-xp-preregistration-v2.json"),
    `${JSON.stringify(preregistration)}\n`,
  );
  await fs.writeFile(
    path.join(root, "commander-xp-evidence-index-v2.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      experimentID: preregistration.experimentID,
      phase: "preregistration",
      preRegistrationSha256: preregistration.preRegistrationSha256,
    })}\n`,
  );
  return root;
}
