import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CommanderXpPlannedRequest } from "../../src/server/agents/CommanderXpProtocol";
import {
  buildCollectorNamespaceRegistry,
  collectorPriorLedgerFilename,
  commanderXpReplayEvidenceProjection,
  copyCollectorPhaseAuthority,
  createCollectorEvidenceOutput,
  exactCollectorRequestMapping,
} from "./commander-xp-collect";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Commander XP collector namespace registry", () => {
  it("projects replay identity without retaining embedded private artifacts", () => {
    const raw = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        replayKind: "proxywar-coworld-local-poc",
        runID: "run-public",
        matchID: "PWSABCDE",
        config: {
          commander_xp_phase: "canary",
          commander_xp_run_key: "commander-xp-v2/fixture/canary/r00/A",
          seed: 123,
          privateProviderTranscript: "must-not-survive",
        },
        inlineRunArtifacts: {
          "match-summary.json": JSON.stringify({
            rawProviderOutput: "must-not-survive",
          }),
        },
        proxyWarArtifacts: { providerTranscript: "must-not-survive" },
        spectatorReplay: "must-not-survive",
      }),
    );
    const projection = commanderXpReplayEvidenceProjection(
      "https://example.invalid/replays/job.replay",
      {
        xpRequestID: "xreq_fixture",
        episodeRequestID: "ereq_fixture",
        jobID: "job_fixture",
        episodeID: "episode_fixture",
        replayPath: "/replays/job.replay",
        replayURLSha256: "a".repeat(64),
      },
      null,
      raw,
    );
    expect(projection).toMatchObject({
      sourceSchemaVersion: 1,
      replayKind: "proxywar-coworld-local-poc",
      runID: "run-public",
      matchID: "PWSABCDE",
      config: {
        commander_xp_phase: "canary",
        commander_xp_run_key: "commander-xp-v2/fixture/canary/r00/A",
        seed: 123,
      },
      results: null,
    });
    expect(JSON.stringify(projection)).not.toContain("must-not-survive");
  });

  it("creates only an evidence tree before the post-upload authority request exists", async () => {
    const parent = await temporaryDirectory();
    const output = path.join(parent, "collector-output");
    await expect(createCollectorEvidenceOutput(output)).resolves.toBe(
      path.join(output, "evidence"),
    );
    await expect(fs.readdir(output)).resolves.toEqual(["evidence"]);
  });

  it("selects the exact retained predecessor for every evidence phase", () => {
    expect(collectorPriorLedgerFilename("preregistration")).toBeNull();
    expect(collectorPriorLedgerFilename("provider-preflight")).toBe(
      "commander-xp-prereg-ledger-v2.json",
    );
    expect(collectorPriorLedgerFilename("canary")).toBe(
      "commander-xp-provider-preflight-ledger-v2.json",
    );
    expect(collectorPriorLedgerFilename("confirmatory")).toBe(
      "commander-xp-canary-ledger-v2.json",
    );
  });

  it("copies and indexes every confirmatory authority input", async () => {
    const root = await temporaryDirectory();
    const sources = path.join(root, "sources");
    const output = path.join(root, "evidence");
    await fs.mkdir(sources);
    await fs.mkdir(output);
    const preregistrationLedgerPath = await sourceFile(sources, "prereg.json");
    const providerPreflightLedgerPath = await sourceFile(
      sources,
      "provider.json",
    );
    const canaryLedgerPath = await sourceFile(sources, "canary.json");
    const confirmatoryActivationPath = await sourceFile(
      sources,
      "activation.json",
    );
    await expect(
      copyCollectorPhaseAuthority(
        {
          phase: "confirmatory",
          preregistrationLedgerPath,
          providerPreflightLedgerPath,
          canaryLedgerPath,
          confirmatoryActivationPath,
        },
        output,
      ),
    ).resolves.toEqual([
      "commander-xp-prereg-ledger-v2.json",
      "commander-xp-provider-preflight-ledger-v2.json",
      "commander-xp-canary-ledger-v2.json",
      "commander-xp-confirmatory-activation-v2.json",
    ]);
    await expect(
      fs.readFile(
        path.join(output, "commander-xp-confirmatory-activation-v2.json"),
        "utf8",
      ),
    ).resolves.toBe("activation.json\n");
  });

  it("requires activation only for confirmatory collection", async () => {
    const root = await temporaryDirectory();
    await expect(
      copyCollectorPhaseAuthority(
        {
          phase: "preregistration",
          confirmatoryActivationPath: "/not/accepted",
        },
        root,
      ),
    ).rejects.toThrow("preregistration must not accept phase ledgers");
    await expect(
      copyCollectorPhaseAuthority(
        {
          phase: "confirmatory",
          preregistrationLedgerPath: await sourceFile(root, "prereg.json"),
          providerPreflightLedgerPath: await sourceFile(root, "provider.json"),
          canaryLedgerPath: await sourceFile(root, "canary.json"),
        },
        await temporaryDirectory(),
      ),
    ).rejects.toThrow("collector confirmatory activation is required");
  });

  it("rejects duplicate mappings that collapse one preregistered slot", () => {
    const first = plannedRequest("A", "run-a");
    const second = plannedRequest("B", "run-b");
    const mapped = (
      request: CommanderXpPlannedRequest,
      xpRequestID: string,
    ) => ({
      phase: request.phase,
      replicaIndex: request.replicaIndex,
      arm: request.arm,
      xpRequestID,
      submittedRequestPath: "/submitted.json",
      createResponsePath: "/created.json",
    });
    expect(() =>
      exactCollectorRequestMapping(
        [mapped(first, "xreq_one"), mapped(first, "xreq_replacement")],
        [first, second],
      ),
    ).toThrow("collector mapping does not exactly cover the sealed phase");
  });

  it("creates the empty preregistration registry without a prior ledger", async () => {
    const root = await temporaryDirectory();
    await expect(
      buildCollectorNamespaceRegistry(root, [], null),
    ).resolves.toMatchObject({
      schemaVersion: 2,
      mode: "cumulative-per-namespace",
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
    });
  });

  it("registers provider request IDs and rejects reuse across run owners", async () => {
    const root = await temporaryDirectory();
    const first = plannedRequest("A", "run-a");
    const second = plannedRequest("B", "run-b");
    await writeRun(root, first, "provider-shared");
    const firstRegistry = await buildCollectorNamespaceRegistry(
      root,
      [first],
      null,
    );
    expect(firstRegistry.namespaces.providerRequestID).toEqual([
      "provider-shared",
    ]);

    await writeRun(root, second, "provider-shared");
    await expect(
      buildCollectorNamespaceRegistry(root, [first, second], null),
    ).rejects.toThrow("collector namespace providerRequestID is reused");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "commander-xp-collect-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function sourceFile(directory: string, name: string): Promise<string> {
  const target = path.join(directory, name);
  await fs.writeFile(target, `${name}\n`);
  return target;
}

function plannedRequest(
  arm: "A" | "B" | "C",
  runKey: string,
): CommanderXpPlannedRequest {
  return {
    phase: "provider-preflight",
    replicaIndex: 0,
    arm,
    runKey,
  } as CommanderXpPlannedRequest;
}

async function writeRun(
  root: string,
  request: CommanderXpPlannedRequest,
  providerRequestID: string,
): Promise<void> {
  const owner = `runs/${request.phase}/r00/${request.arm}`;
  const playerDirectory = path.join(root, owner, "player-artifact");
  await fs.mkdir(playerDirectory, { recursive: true });
  await fs.writeFile(
    path.join(root, owner, "xp-evidence.json"),
    JSON.stringify({
      xpRequestID: `xreq-${request.arm}`,
      episodeRequestID: `ereq-${request.arm}`,
      jobID: `job-${request.arm}`,
      episodeID: `episode-${request.arm}`,
      replayPath: `/replays/${request.arm}`,
      replayURLSha256: request.arm.toLowerCase().repeat(64),
    }),
  );
  await fs.writeFile(
    path.join(playerDirectory, "trace.jsonl"),
    `${JSON.stringify({
      recordType: "provider",
      requestID: providerRequestID,
      stage: "preflight",
      sequence: 0,
    })}\n`,
  );
}
