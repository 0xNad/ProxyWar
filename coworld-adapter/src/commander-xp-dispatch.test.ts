import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCommanderXpPreRegistration,
  COMMANDER_XP_BEHAVIOR_SOURCE_SHA,
  COMMANDER_XP_BEHAVIOR_SOURCE_TREE_SHA,
  COMMANDER_XP_OPENAPI_SHA256,
  sha256Canonical,
  type CommanderXpPlanInput,
  type CommanderXpPreRegistrationV2,
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
    const authority = await writeDispatchAuthority(root, preregistrationPath);

    const result = await dispatchCommanderXpRequests({
      schemaVersion: 2,
      phase: "provider-preflight",
      preRegistrationPath: preregistrationPath,
      ...authority,
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
    const firstCreate = JSON.parse(
      await fs.readFile(
        path.join(
          outputDirectory,
          "runs/provider-preflight/r00/A/create-response.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const firstRaw = await fs.readFile(
      path.join(
        outputDirectory,
        "runs/provider-preflight/r00/A/create-response-raw.json",
      ),
      "utf8",
    );
    expect(firstCreate.rawResponseSha256).toBe(
      createHash("sha256").update(firstRaw).digest("hex"),
    );
    expect(firstCreate.rawResponseByteLength).toBe(Buffer.byteLength(firstRaw));
  });

  it("does not retry or advance after one create fails", async () => {
    const root = await temporaryDirectory();
    const preregistrationPath = await writePreRegistration(root);
    const capturePath = path.join(root, "capture.jsonl");
    const commandPath = await fakeCoworld(root, capturePath, 2);
    const authority = await writeDispatchAuthority(root, preregistrationPath);

    await expect(
      dispatchCommanderXpRequests({
        schemaVersion: 2,
        phase: "provider-preflight",
        preRegistrationPath: preregistrationPath,
        ...authority,
        coworldCommandPath: commandPath,
        outputDirectory: path.join(root, "dispatch"),
      }),
    ).rejects.toThrow("dispatch failed at runs/provider-preflight/r00/B");
    const captured = (await fs.readFile(capturePath, "utf8"))
      .trim()
      .split("\n");
    expect(captured).toHaveLength(2);
    await expect(
      fs.readFile(
        path.join(
          root,
          "dispatch/runs/provider-preflight/r00/B/create-failure.json",
        ),
        "utf8",
      ),
    ).resolves.toContain("COMMAND_EXIT_NONZERO");
  });

  it("rejects a tampered preregistration before invoking Coworld", async () => {
    const root = await temporaryDirectory();
    const preregistrationPath = await writePreRegistration(root);
    const preregistration = JSON.parse(
      await fs.readFile(preregistrationPath, "utf8"),
    ) as CommanderXpPreRegistrationV2;
    preregistration.schedule.preflightRequestCount = 2 as 3;
    await fs.writeFile(
      preregistrationPath,
      `${JSON.stringify(preregistration)}\n`,
    );
    const capturePath = path.join(root, "capture.jsonl");
    const commandPath = await fakeCoworld(root, capturePath, null);
    await expect(
      dispatchCommanderXpRequests({
        schemaVersion: 2,
        phase: "provider-preflight",
        preRegistrationPath: preregistrationPath,
        preregistrationReceiptPath: path.join(root, "unused.json"),
        dispatchAuthorizationPath: path.join(root, "unused-auth.json"),
        coworldCommandPath: commandPath,
        outputDirectory: path.join(root, "dispatch"),
      }),
    ).rejects.toThrow();
    await expect(fs.stat(capturePath)).rejects.toThrow();
  });

  it("requires the provider-preflight ledger before canary dispatch", async () => {
    const root = await temporaryDirectory();
    const preregistrationPath = await writePreRegistration(root);
    const authority = await writeDispatchAuthority(root, preregistrationPath);
    const capturePath = path.join(root, "capture.jsonl");
    const commandPath = await fakeCoworld(root, capturePath, null);
    await expect(
      dispatchCommanderXpRequests({
        schemaVersion: 2,
        phase: "canary",
        preRegistrationPath: preregistrationPath,
        ...authority,
        coworldCommandPath: commandPath,
        outputDirectory: path.join(root, "dispatch"),
      }),
    ).rejects.toThrow("provider-preflight receipt is required");
    await expect(fs.stat(capturePath)).rejects.toThrow();
  });

  it("stops on rejected status and retains the exact response hash", async () => {
    const root = await temporaryDirectory();
    const preregistrationPath = await writePreRegistration(root);
    const authority = await writeDispatchAuthority(root, preregistrationPath);
    const capturePath = path.join(root, "capture.jsonl");
    const commandPath = await fakeCoworld(root, capturePath, null, {
      failedStatusAt: 1,
    });
    await expect(
      dispatchCommanderXpRequests({
        schemaVersion: 2,
        phase: "provider-preflight",
        preRegistrationPath: preregistrationPath,
        ...authority,
        coworldCommandPath: commandPath,
        outputDirectory: path.join(root, "dispatch"),
      }),
    ).rejects.toThrow("dispatch response invalid");
    const failure = await fs.readFile(
      path.join(
        root,
        "dispatch/runs/provider-preflight/r00/A/create-failure.json",
      ),
      "utf8",
    );
    expect(failure).toContain("RESPONSE_IDENTITY_INVALID");
    expect(
      (await fs.readFile(capturePath, "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  });

  it("rejects a duplicate XP request ID before advancing to the third arm", async () => {
    const root = await temporaryDirectory();
    const preregistrationPath = await writePreRegistration(root);
    const authority = await writeDispatchAuthority(root, preregistrationPath);
    const capturePath = path.join(root, "capture.jsonl");
    const commandPath = await fakeCoworld(root, capturePath, null, {
      duplicateIDs: true,
    });
    await expect(
      dispatchCommanderXpRequests({
        schemaVersion: 2,
        phase: "provider-preflight",
        preRegistrationPath: preregistrationPath,
        ...authority,
        coworldCommandPath: commandPath,
        outputDirectory: path.join(root, "dispatch"),
      }),
    ).rejects.toThrow("dispatch response invalid");
    expect(
      (await fs.readFile(capturePath, "utf8")).trim().split("\n"),
    ).toHaveLength(2);
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

async function writeDispatchAuthority(
  root: string,
  preregistrationPath: string,
): Promise<{
  preregistrationReceiptPath: string;
  dispatchAuthorizationPath: string;
}> {
  const preregistration = JSON.parse(
    await fs.readFile(preregistrationPath, "utf8"),
  ) as CommanderXpPreRegistrationV2;
  const completedAt = new Date(
    Date.parse(preregistration.createdAt) + 1_000,
  ).toISOString();
  const namespaceBody = {
    schemaVersion: 2 as const,
    mode: "cumulative-per-namespace" as const,
    priorRegistrySha256: null,
    namespaces: {
      decisionRequestID: [],
      episodeID: [],
      episodeRequestID: [],
      jobID: [],
      providerRequestID: [],
      replayPath: [],
      replayURLSha256: [],
      runKey: [],
      xpRequestID: [],
    },
  };
  const namespaceRegistry = {
    ...namespaceBody,
    registrySha256: externalCanonicalSha256(namespaceBody),
  };
  const evidenceArtifact = {
    id: "101",
    digest: `sha256:${"1".repeat(64)}`,
    aggregateSha256: "2".repeat(64),
    attestedSubjectDigest: "3".repeat(64),
    localSealSha256: "4".repeat(64),
  };
  const receiptArtifact = {
    id: "102",
    digest: `sha256:${"5".repeat(64)}`,
    receiptSha256: "6".repeat(64),
    attestedSubjectDigest: "7".repeat(64),
  };
  const receiptBody = {
    schemaVersion: 2 as const,
    authority: "github-actions-attested-ledger-v1" as const,
    repository: "0xNad/ProxyWar" as const,
    workflowPath: ".github/workflows/commander-xp-external-seal.yml",
    workflowID: "77",
    workflowName: "Commander XP external seal",
    actor: "0xNad" as const,
    triggeringActor: "0xNad" as const,
    event: "workflow_dispatch" as const,
    ref: "refs/heads/main" as const,
    experimentID: preregistration.experimentID,
    preRegistrationSha256: preregistration.preRegistrationSha256,
    runId: "88",
    attempt: 1,
    headSha: preregistration.identities.adapterSourceSha,
    treeSha: preregistration.identities.adapterSourceTreeSha,
    behaviorBaseSha: preregistration.identities.behaviorSourceSha,
    behaviorBaseTreeSha: preregistration.identities.behaviorSourceTreeSha,
    runnerEnvironment: "github-hosted" as const,
    attestationPolicy: {
      repository: "0xNad/ProxyWar" as const,
      signerWorkflow:
        "0xNad/ProxyWar/.github/workflows/commander-xp-external-seal.yml" as const,
      sourceRef: "refs/heads/main" as const,
      sourceDigest: preregistration.identities.adapterSourceSha,
      signerDigest: preregistration.identities.adapterSourceSha,
      denySelfHostedRunners: true as const,
    },
    collector: {
      artifactID: 91,
      artifactName: "commander-xp-evidence-fixture",
      artifactDigest: `sha256:${"8".repeat(64)}`,
      workflowRunID: 90,
      workflowRunAttempt: 1,
      workflowID: 89,
      workflowPath: ".github/workflows/commander-xp-evidence.yml" as const,
      workflowName: "Commander XP protected experiment evidence" as const,
      actor: "0xNad" as const,
      triggeringActor: "0xNad" as const,
      headRepository: "0xNad/ProxyWar" as const,
      event: "workflow_dispatch" as const,
      ref: "refs/heads/main" as const,
      headSha: preregistration.identities.adapterSourceSha,
    },
    phase: "preregistration" as const,
    completedAt,
    preregistrationReceipt: null,
    providerPreflightReceipt: null,
    priorPhaseReceipt: null,
    canaryReceipt: null,
    namespaceRegistry,
    evidenceArtifact,
    receiptArtifact,
  };
  const receipt = {
    ...receiptBody,
    ledgerSha256: externalCanonicalSha256(receiptBody),
  };
  const preregistrationReceiptPath = path.join(root, "prereg-ledger.json");
  await fs.writeFile(
    preregistrationReceiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  const authorizationBody = {
    schemaVersion: 2 as const,
    authority: "github-actions-pre-dispatch-fence-v1" as const,
    experimentID: preregistration.experimentID,
    phase: "provider-preflight" as const,
    preRegistrationSha256: preregistration.preRegistrationSha256,
    workflowSourceSha: preregistration.identities.adapterSourceSha,
    workflowSourceTreeSha: preregistration.identities.adapterSourceTreeSha,
    authorizedAt: completedAt,
    priorLedgerSha256: receipt.ledgerSha256,
    activationSha256: null,
    fenceArtifact: {
      id: 92,
      name: `commander-xp-dispatch-fence-${preregistration.experimentID}-provider-preflight-${preregistration.identities.adapterSourceSha}`,
      digest: `sha256:${"9".repeat(64)}`,
      workflowRunID: 90,
      workflowRunAttempt: 1,
    },
    createdAt: new Date(Date.parse(completedAt) + 1_000).toISOString(),
  };
  const dispatchAuthorizationPath = path.join(
    root,
    "dispatch-authorization.json",
  );
  await fs.writeFile(
    dispatchAuthorizationPath,
    `${JSON.stringify({
      ...authorizationBody,
      dispatchAuthorizationSha256: sha256Canonical(authorizationBody),
    })}\n`,
  );
  return { preregistrationReceiptPath, dispatchAuthorizationPath };
}

function externalCanonicalSha256(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, sort(record[key])]),
      );
    }
    return entry;
  };
  return createHash("sha256")
    .update(`${JSON.stringify(sort(value))}\n`)
    .digest("hex");
}

async function fakeCoworld(
  root: string,
  capturePath: string,
  failAt: number | null,
  options: { failedStatusAt?: number; duplicateIDs?: boolean } = {},
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
console.log(JSON.stringify({id: "xreq_fixture-" + (${options.duplicateIDs === true ? "1" : "count"}), created_at: new Date().toISOString(), status: count === ${options.failedStatusAt ?? -1} ? "failed" : "submitted"}));
`,
    { mode: 0o700 },
  );
  return target;
}
