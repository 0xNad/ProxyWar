import { createHash } from "node:crypto";
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
  sha256Canonical,
  type CommanderXpPlanInput,
  type CommanderXpPreRegistrationV2,
} from "../../src/server/agents/CommanderXpProtocol";
import {
  dispatchCommanderXpConfirmatoryWaves,
  dispatchCommanderXpRequests,
  selectCommanderXpRecoveryCandidate,
} from "./commander-xp-dispatch";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Commander XP protected dispatcher", () => {
  it("adopts exactly one authoritative lost-ack candidate and rejects ambiguity", async () => {
    const root = await temporaryDirectory();
    const preregistrationPath = await writePreRegistration(root);
    const preregistration = JSON.parse(
      await fs.readFile(preregistrationPath, "utf8"),
    ) as CommanderXpPreRegistrationV2;
    const planned = preregistration.providerPreflightRequests[0]!;
    const candidate = {
      id: "xreq_recovered-1",
      created_at: new Date().toISOString(),
      status: "submitted",
      requested: planned.requestBody,
      rawReadback: "{}\n",
    };
    expect(selectCommanderXpRecoveryCandidate(planned, [candidate])).toEqual(
      candidate,
    );
    expect(() => selectCommanderXpRecoveryCandidate(planned, [])).toThrow(
      /ambiguous or missing/,
    );
    expect(() =>
      selectCommanderXpRecoveryCandidate(planned, [candidate, candidate]),
    ).toThrow(/ambiguous or missing/);
    expect(() =>
      selectCommanderXpRecoveryCandidate(planned, [
        {
          ...candidate,
          requested: { ...planned.requestBody, num_episodes: 2 },
        },
      ]),
    ).toThrow(/does not match/);
  });

  it("submits 48 first arms, waits for terminality, then submits 48 second arms", async () => {
    const root = await temporaryDirectory();
    const preregistrationPath = await writePreRegistration(root);
    const preregistration = JSON.parse(
      await fs.readFile(preregistrationPath, "utf8"),
    ) as CommanderXpPreRegistrationV2;
    const planned = preregistration.requests.filter(
      (request) => request.phase === "confirmatory",
    );
    const events: Array<{
      kind: "create" | "terminal";
      replicaIndex: number;
      orderIndex: number;
      at: number;
    }> = [];
    await dispatchCommanderXpConfirmatoryWaves(
      planned,
      async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        events.push({
          kind: "create",
          replicaIndex: request.replicaIndex,
          orderIndex: request.orderIndex,
          at: Date.now(),
        });
        return request.runKey;
      },
      async (submitted) => {
        expect(submitted).toHaveLength(48);
        for (const { request } of submitted) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          events.push({
            kind: "terminal",
            replicaIndex: request.replicaIndex,
            orderIndex: request.orderIndex,
            at: Date.now(),
          });
        }
      },
    );
    expect(events).toHaveLength(144);
    expect(events.slice(0, 48).every((entry) => entry.kind === "create")).toBe(
      true,
    );
    expect(
      events.slice(48, 96).every((entry) => entry.kind === "terminal"),
    ).toBe(true);
    expect(
      events
        .slice(96)
        .every((entry) => entry.kind === "create" && entry.orderIndex === 1),
    ).toBe(true);
    for (let replicaIndex = 0; replicaIndex < 48; replicaIndex += 1) {
      const terminal = events.find(
        (entry) =>
          entry.kind === "terminal" && entry.replicaIndex === replicaIndex,
      )!;
      const second = events.find(
        (entry) =>
          entry.kind === "create" &&
          entry.replicaIndex === replicaIndex &&
          entry.orderIndex === 1,
      )!;
      expect(terminal.at).toBeLessThanOrEqual(second.at);
    }
  });

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
    const progress = JSON.parse(
      await fs.readFile(
        path.join(outputDirectory, "commander-xp-dispatch-progress-v2.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(progress.status).toBe("completed");
    expect(progress.requests).toHaveLength(3);
    expect(
      (progress.requests as Array<Record<string, unknown>>).every(
        (entry) =>
          entry.status === "submitted" &&
          typeof entry.xpRequestID === "string" &&
          !Object.hasOwn(entry, "rawResponse"),
      ),
    ).toBe(true);
  });

  it("retains runner times as observations and accepts a skewed server created_at", async () => {
    const root = await temporaryDirectory();
    const preregistrationPath = await writePreRegistration(root);
    const capturePath = path.join(root, "capture.jsonl");
    const serverCreatedAt = "2026-08-22T12:00:00.000Z";
    const commandPath = await fakeCoworld(root, capturePath, null, {
      createdAt: serverCreatedAt,
    });
    const authority = await writeDispatchAuthority(root, preregistrationPath);
    const outputDirectory = path.join(root, "dispatch");
    await dispatchCommanderXpRequests({
      schemaVersion: 2,
      phase: "provider-preflight",
      preRegistrationPath: preregistrationPath,
      ...authority,
      coworldCommandPath: commandPath,
      outputDirectory,
    });
    const response = JSON.parse(
      await fs.readFile(
        path.join(
          outputDirectory,
          "runs/provider-preflight/r00/A/create-response.json",
        ),
        "utf8",
      ),
    ) as { createdAt: string; receivedAt: string };
    expect(response.createdAt).toBe(serverCreatedAt);
    expect(Date.parse(response.receivedAt)).toBeGreaterThan(
      Date.parse(serverCreatedAt),
    );
  });

  it("accepts and raw-binds the documented pending create response", async () => {
    const root = await temporaryDirectory();
    const preregistrationPath = await writePreRegistration(root);
    const capturePath = path.join(root, "capture.jsonl");
    const commandPath = await fakeCoworld(root, capturePath, null, {
      initialStatus: "pending",
    });
    const outputDirectory = path.join(root, "pending-dispatch");
    const authority = await writeDispatchAuthority(root, preregistrationPath);
    await dispatchCommanderXpRequests({
      schemaVersion: 2,
      phase: "provider-preflight",
      preRegistrationPath: preregistrationPath,
      ...authority,
      coworldCommandPath: commandPath,
      outputDirectory,
    });
    const runRoot = path.join(outputDirectory, "runs/provider-preflight/r00/A");
    const projected = JSON.parse(
      await fs.readFile(path.join(runRoot, "create-response.json"), "utf8"),
    ) as Record<string, unknown>;
    const raw = JSON.parse(
      await fs.readFile(path.join(runRoot, "create-response-raw.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(projected.status).toBe("pending");
    expect(raw.status).toBe("pending");
    expect(projected.rawResponseSha256).toBe(
      createHash("sha256")
        .update(`${JSON.stringify(raw)}\n`)
        .digest("hex"),
    );
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
    const progress = JSON.parse(
      await fs.readFile(
        path.join(root, "dispatch/commander-xp-dispatch-progress-v2.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(progress.status).toBe("failed");
    expect(progress.requests).toHaveLength(2);
    expect(
      (progress.requests as Array<Record<string, unknown>>)[1]?.failureCode,
    ).toBe("COMMAND_EXIT_NONZERO");
    expect(JSON.stringify(progress)).not.toContain("private model response");
  });

  it("recovers a lost acknowledgement by exact authoritative adoption and advances only unseen slots", async () => {
    const root = await temporaryDirectory();
    const preregistrationPath = await writePreRegistration(root);
    const authority = await writeDispatchAuthority(root, preregistrationPath);
    const firstCapture = path.join(root, "initial-capture.jsonl");
    const initialCommand = await fakeCoworld(root, firstCapture, 2);
    const priorDirectory = path.join(root, "prior-dispatch");
    await expect(
      dispatchCommanderXpRequests({
        schemaVersion: 2,
        phase: "provider-preflight",
        preRegistrationPath: preregistrationPath,
        ...authority,
        coworldCommandPath: initialCommand,
        outputDirectory: priorDirectory,
      }),
    ).rejects.toThrow(/dispatch failed/);

    const preregistration = JSON.parse(
      await fs.readFile(preregistrationPath, "utf8"),
    ) as CommanderXpPreRegistrationV2;
    const recoveryCapture = path.join(root, "recovery-capture.jsonl");
    const recoveryCommand = await fakeRecoveryCoworld(
      root,
      recoveryCapture,
      preregistration,
      priorDirectory,
    );
    const outputDirectory = path.join(root, "recovered-dispatch");
    const recovered = await dispatchCommanderXpRequests({
      schemaVersion: 2,
      phase: "provider-preflight",
      preRegistrationPath: preregistrationPath,
      ...authority,
      coworldCommandPath: recoveryCommand,
      outputDirectory,
      recoveryDirectory: await fs.realpath(priorDirectory),
    });
    expect(recovered.requests.map((request) => request.xpRequestID)).toEqual([
      "xreq_fixture-1",
      "xreq_recovered-2",
      "xreq_recovery-new-3",
    ]);
    const modes = await Promise.all(
      (["A", "B", "C"] as const).map(async (arm) => {
        const response = JSON.parse(
          await fs.readFile(
            path.join(
              outputDirectory,
              `runs/provider-preflight/r00/${arm}/create-response.json`,
            ),
            "utf8",
          ),
        ) as { mode: string };
        return response.mode;
      }),
    );
    expect(modes).toEqual([
      "authoritative-adoption",
      "authoritative-adoption",
      "direct-response",
    ]);
    const recoveryEvents = (await fs.readFile(recoveryCapture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { command: string });
    expect(
      recoveryEvents.filter((event) => event.command === "create"),
    ).toHaveLength(1);
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
    coworldHostedManifestSha256: "6".repeat(64),
    coworldGameImageID: "img_commander_fixture",
    coworldGameImageDigest: `sha256:${"8".repeat(64)}`,
    canonicalLeagueBindingSnapshotSha256: "9".repeat(64),
    imageDigest: `sha256:${"a".repeat(64)}`,
    bedrockModel: COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT.modelID,
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
    platformRefetchSha256: "0".repeat(64),
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
    event: "workflow_run" as const,
    ref: "refs/heads/main" as const,
    experimentID: preregistration.experimentID,
    preRegistrationSha256: preregistration.preRegistrationSha256,
    runId: "88",
    attempt: 1,
    signerSourceSha: preregistration.identities.adapterSourceSha,
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
    confirmatoryAnalysis: null,
    evidenceArtifact,
    receiptArtifact,
    integrityVerified: true as const,
    experimentUsable: false,
    performanceClaimAuthorized: false,
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
    fenceGitRef: `refs/tags/commander-xp-dispatch-fence-v2/${createHash(
      "sha256",
    )
      .update(
        `${preregistration.experimentID}\nprovider-preflight\n${preregistration.identities.adapterSourceSha}\n`,
      )
      .digest("hex")}`,
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
  options: {
    failedStatusAt?: number;
    duplicateIDs?: boolean;
    createdAt?: string;
    initialStatus?: "submitted" | "pending";
  } = {},
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
console.log(JSON.stringify({id: "xreq_fixture-" + (${options.duplicateIDs === true ? "1" : "count"}), created_at: ${options.createdAt === undefined ? "new Date().toISOString()" : JSON.stringify(options.createdAt)}, status: count === ${options.failedStatusAt ?? -1} ? "failed" : ${JSON.stringify(options.initialStatus ?? "submitted")}}));
`,
    { mode: 0o700 },
  );
  return target;
}

async function fakeRecoveryCoworld(
  root: string,
  capturePath: string,
  preregistration: CommanderXpPreRegistrationV2,
  priorDirectory: string,
): Promise<string> {
  const submittedAt = async (arm: "A" | "B"): Promise<string> => {
    const submitted = JSON.parse(
      await fs.readFile(
        path.join(
          priorDirectory,
          `runs/provider-preflight/r00/${arm}/submitted-request.json`,
        ),
        "utf8",
      ),
    ) as { submittedAt: string };
    return submitted.submittedAt;
  };
  const database = [
    {
      id: "xreq_fixture-1",
      created_at: await submittedAt("A"),
      status: "completed",
      requested: preregistration.providerPreflightRequests[0]!.requestBody,
    },
    {
      id: "xreq_recovered-2",
      created_at: await submittedAt("B"),
      status: "completed",
      requested: preregistration.providerPreflightRequests[1]!.requestBody,
    },
  ];
  const databasePath = path.join(root, "recovery-database.json");
  const target = path.join(root, "fake-recovery-coworld.mjs");
  await fs.writeFile(databasePath, JSON.stringify(database));
  await fs.writeFile(
    target,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const database = JSON.parse(fs.readFileSync(${JSON.stringify(databasePath)}, "utf8"));
const command = args[1];
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({command,args}) + "\\n");
if (command === "list") {
  console.log(JSON.stringify({entries:database.map(({requested,...entry}) => entry),total_count:database.length,limit:1000,offset:Number(args[6])}));
} else if (command === "get") {
  const entry = database.find((candidate) => candidate.id === args[2]);
  if (!entry) process.exit(4);
  console.log(JSON.stringify(entry));
} else if (command === "create") {
  console.log(JSON.stringify({id:"xreq_recovery-new-3",created_at:new Date().toISOString(),status:"submitted"}));
} else {
  process.exit(5);
}
`,
    { mode: 0o700 },
  );
  return target;
}
