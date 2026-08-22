import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCommanderXpPreRegistration,
  COMMANDER_XP_BEHAVIOR_SOURCE_SHA,
  COMMANDER_XP_BEHAVIOR_SOURCE_TREE_SHA,
  COMMANDER_XP_OPENAPI_SHA256,
  type CommanderXpPlanInput,
} from "../../src/server/agents/CommanderXpProtocol";
import { dispatchCommanderXpRequests } from "./commander-xp-dispatch";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Commander XP protected dispatcher", () => {
  it("submits the three preregistered preflights once in exact A/B/C order", async () => {
    const root = await temporaryDirectory();
    const preregistrationPath = await writePreRegistration(root);
    const capturePath = path.join(root, "capture.jsonl");
    const commandPath = await fakeCoworld(root, capturePath, null);
    const outputDirectory = path.join(root, "dispatch");

    const result = await dispatchCommanderXpRequests({
      schemaVersion: 2,
      phase: "provider-preflight",
      preRegistrationPath: preregistrationPath,
      coworldCommandPath: commandPath,
      outputDirectory,
    });

    expect(result.requestCount).toBe(3);
    expect(result.requests.map((request) => request.arm)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(
      new Set(result.requests.map((request) => request.xpRequestID)).size,
    ).toBe(3);
    const captured = (await fs.readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(captured.map((entry) => entry.phase)).toEqual([
      "provider-preflight",
      "provider-preflight",
      "provider-preflight",
    ]);
    expect(captured.map((entry) => entry.notes.slice(-1))).toEqual([
      "A",
      "B",
      "C",
    ]);
    await expect(
      fs.readFile(
        path.join(outputDirectory, "commander-xp-dispatch-receipt-v2.json"),
        "utf8",
      ),
    ).resolves.toContain('"requestCount": 3');
  });

  it("does not retry or advance after one create fails", async () => {
    const root = await temporaryDirectory();
    const preregistrationPath = await writePreRegistration(root);
    const capturePath = path.join(root, "capture.jsonl");
    const commandPath = await fakeCoworld(root, capturePath, 2);

    await expect(
      dispatchCommanderXpRequests({
        schemaVersion: 2,
        phase: "provider-preflight",
        preRegistrationPath: preregistrationPath,
        coworldCommandPath: commandPath,
        outputDirectory: path.join(root, "dispatch"),
      }),
    ).rejects.toThrow("dispatch failed at runs/provider-preflight/r00/B");
    const captured = (await fs.readFile(capturePath, "utf8"))
      .trim()
      .split("\n");
    expect(captured).toHaveLength(2);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "commander-xp-dispatch-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function writePreRegistration(root: string): Promise<string> {
  const planInput: CommanderXpPlanInput = {
    experimentID: "dispatch-fixture-v2",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    behaviorSourceSha: COMMANDER_XP_BEHAVIOR_SOURCE_SHA,
    behaviorSourceTreeSha: COMMANDER_XP_BEHAVIOR_SOURCE_TREE_SHA,
    adapterSourceSha: "1".repeat(40),
    adapterSourceTreeSha: "2".repeat(40),
    sourceDiffManifestSha256: "3".repeat(64),
    sourceProvenanceSha256: "4".repeat(64),
    policyBuildProvenanceDigest: `sha256:${"5".repeat(64)}`,
    gameBuildProvenanceDigest: `sha256:${"6".repeat(64)}`,
    coworldID: "cow_commander_fixture",
    coworldVersion: "0.1.0",
    coworldManifestSha256: "7".repeat(64),
    coworldGameImageID: "img_commander_fixture",
    coworldGameImageDigest: `sha256:${"8".repeat(64)}`,
    canonicalLeagueBindingSnapshotSha256: "9".repeat(64),
    imageDigest: `sha256:${"a".repeat(64)}`,
    bedrockModel: "bedrock-fixture-model",
    xpOpenApiSha256: COMMANDER_XP_OPENAPI_SHA256,
    armPolicyVersionIDs: {
      A: "pvid_arm_a",
      B: "pvid_arm_b",
      C: "pvid_arm_c",
    },
    opponentPolicyVersionIDs: [
      "pvid_opponent_1",
      "pvid_opponent_2",
      "pvid_opponent_3",
    ],
  };
  const target = path.join(root, "preregistration.json");
  await fs.writeFile(
    target,
    `${JSON.stringify(buildCommanderXpPreRegistration(planInput))}\n`,
  );
  return target;
}

async function fakeCoworld(
  root: string,
  capturePath: string,
  failAt: number | null,
): Promise<string> {
  const counterPath = path.join(root, "counter.txt");
  const target = path.join(root, "fake-coworld.mjs");
  await fs.writeFile(
    target,
    `#!/usr/bin/env node
import fs from "node:fs";
const bodyPath = process.argv[4];
const count = fs.existsSync(${JSON.stringify(counterPath)}) ? Number(fs.readFileSync(${JSON.stringify(counterPath)}, "utf8")) + 1 : 1;
fs.writeFileSync(${JSON.stringify(counterPath)}, String(count));
const body = JSON.parse(fs.readFileSync(bodyPath, "utf8"));
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({phase: body.game_config_overrides.commander_xp_phase, notes: body.notes}) + "\\n");
${failAt === null ? "" : `if (count === ${failAt}) process.exit(9);`}
console.log(JSON.stringify({id: "xreq_fixture-" + count, created_at: new Date().toISOString(), status: "submitted"}));
`,
    { mode: 0o700 },
  );
  return target;
}
