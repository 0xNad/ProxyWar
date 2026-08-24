import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CommanderXpConfirmatoryAnalysisEvidence,
  CommanderXpVerifiedOutcome,
} from "../../src/server/agents/CommanderXpAnalysis";
import {
  sha256Canonical,
  type CommanderXpPlannedRequest,
} from "../../src/server/agents/CommanderXpProtocol";
import { verifyCommanderXpConfirmatoryAnalysisArtifacts } from "../../src/server/agents/CommanderXpVerifier";
import {
  buildCollectorNamespaceRegistry,
  collectorPriorLedgerFilename,
  commanderXpNormalizedRequestReadback,
  commanderXpReplayEvidenceProjection,
  copyCollectorPhaseAuthority,
  createCollectorEvidenceOutput,
  exactCollectorRequestMapping,
  writeCommanderXpConfirmatoryAnalysisArtifacts,
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
  it("projects the real Coworld 0.1.42 requested roster shape as non-authoritative", () => {
    expect(
      commanderXpNormalizedRequestReadback({
        notes: "commander-xp-v2/fixture/canary/r00/A",
        num_episodes: 1,
        roster: [0, 1, 2, 3].map((slot) => ({
          slot,
          player: { policy_ref: `pvid_${slot}` },
        })),
      }),
    ).toEqual({
      schemaVersion: 2,
      authority: "coworld-xp-request-readback-non-authoritative-v1",
      source: "xp-request-get.requested",
      available: true,
      notes: "commander-xp-v2/fixture/canary/r00/A",
      numEpisodes: 1,
      roster: [0, 1, 2, 3].map((slot) => ({
        slot,
        policyRef: `pvid_${slot}`,
      })),
    });
  });

  it("does not promote missing or arbitrary requested echoes to authority", () => {
    const unavailable = {
      schemaVersion: 2,
      authority: "coworld-xp-request-readback-non-authoritative-v1",
      source: "xp-request-get.requested",
      available: false,
      notes: null,
      numEpisodes: null,
      roster: null,
    };
    expect(commanderXpNormalizedRequestReadback(undefined)).toEqual(
      unavailable,
    );
    expect(
      commanderXpNormalizedRequestReadback({
        notes: "attacker",
        num_episodes: 1,
        roster: [{ slot: 0, policy: "attacker-policy" }],
      }),
    ).toEqual(unavailable);
  });

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
          players: [
            { name: "A", rawPrompt: "must-not-survive" },
            { name: "B" },
            { name: "C" },
            { name: "D" },
          ],
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
        players: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
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
      createResponseRawPath: "/created-raw.json",
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

  it("writes deterministic exact 48-pair confirmatory JSON and Markdown artifacts", async () => {
    const preregistration = confirmatoryAnalysisPreregistration();
    const planned = confirmatoryAnalysisRequests();
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    let firstOutcomes: CommanderXpVerifiedOutcome[] = [];
    for (const root of [first, second]) {
      const outcomes = await writeConfirmatoryResults(root, planned);
      if (root === first) firstOutcomes = outcomes;
      await writeCommanderXpConfirmatoryAnalysisArtifacts(
        root,
        preregistration,
        root === first ? outcomes : structuredClone(outcomes).reverse(),
      );
    }
    const firstJson = await fs.readFile(
      path.join(first, "commander-xp-confirmatory-analysis-v2.json"),
      "utf8",
    );
    const secondJson = await fs.readFile(
      path.join(second, "commander-xp-confirmatory-analysis-v2.json"),
      "utf8",
    );
    const firstMarkdown = await fs.readFile(
      path.join(first, "commander-xp-confirmatory-analysis-v2.md"),
      "utf8",
    );
    expect(secondJson).toBe(firstJson);
    expect(
      await fs.readFile(
        path.join(second, "commander-xp-confirmatory-analysis-v2.md"),
        "utf8",
      ),
    ).toBe(firstMarkdown);
    const analysis = JSON.parse(
      firstJson,
    ) as CommanderXpConfirmatoryAnalysisEvidence;
    const { analysisSha256, ...body } = analysis;
    expect(analysis.completePairCount).toBe(48);
    expect(analysis.pairs).toHaveLength(48);
    expect(analysisSha256).toBe(sha256Canonical(body));
    expect(firstMarkdown).toContain("Performance claim authorized: false");
    expect(firstJson).toBe(`${JSON.stringify(analysis, null, 2)}\n`);
    expect(() =>
      verifyCommanderXpConfirmatoryAnalysisArtifacts(
        preregistration,
        firstOutcomes,
        analysis,
        firstMarkdown,
      ),
    ).not.toThrow();
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

function confirmatoryAnalysisPreregistration() {
  return {
    experimentID: "commander-xp-collector-analysis",
    preRegistrationSha256: "1".repeat(64),
    analysis: {
      analysisID: "strategic-commander-xp-b-vs-c-paired-v3",
      population: "48-complete-preregistered-bc-pairs",
      alternative: "C-superior-to-B",
      alpha: 0.05,
      confidenceLevel: 0.95,
      missingnessPolicy: "no-missing-pairs",
      primaryEndpoint: "subject-win",
      scoreRole: "redundant-descriptive-only",
      multiplicityPolicy: "single-primary-no-adjustment",
      minimumWinRateEffectCMinusB: 0.1,
      winMethod: "exact-two-sided-mcnemar",
      intervalMethod: "seeded-paired-bootstrap-percentile",
      resamplingSeed: "strategic-commander-xp-b-vs-c-analysis-v3",
      bootstrapIterations: 4096,
      decisionRule:
        "all-48-complete-and-integrity-green-and-win-estimate-gt-minimum-and-p-lte-alpha-and-ci-lower-gt-minimum",
      canaryClaimGate: "never",
      performanceClaimGate: "external-seal-independent-review-required",
    },
  } as const;
}

function confirmatoryAnalysisRequests(): CommanderXpPlannedRequest[] {
  return Array.from({ length: 48 }, (_unused, replicaIndex) =>
    (["B", "C"] as const).map(
      (arm) =>
        ({
          phase: "confirmatory",
          replicaIndex,
          orderIndex: arm === "B" ? 0 : 1,
          arm,
          seed: 20_000 + replicaIndex,
          subjectSeat: replicaIndex % 4,
        }) as CommanderXpPlannedRequest,
    ),
  ).flat();
}

async function writeConfirmatoryResults(
  root: string,
  planned: readonly CommanderXpPlannedRequest[],
): Promise<CommanderXpVerifiedOutcome[]> {
  const outcomes: CommanderXpVerifiedOutcome[] = [];
  for (const request of planned) {
    const subjectWon =
      request.arm === "B"
        ? request.replicaIndex % 4 === 0
        : request.replicaIndex % 3 === 0;
    const scores = [0, 0, 0, 0];
    scores[request.subjectSeat] = subjectWon ? 1 : 0;
    const directory = path.join(
      root,
      `runs/confirmatory/r${String(request.replicaIndex).padStart(2, "0")}/${request.arm}`,
    );
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "episode-results.json"),
      JSON.stringify({
        xpRequestID: `xreq_collect-${request.arm}-${request.replicaIndex}`,
        episodeRequestID: `ereq_collect-${request.arm}-${request.replicaIndex}`,
        jobID: `job_collect-${request.arm}-${request.replicaIndex}`,
        episodeID: `episode_collect-${request.arm}-${request.replicaIndex}`,
        winnerSlot: subjectWon
          ? request.subjectSeat
          : (request.subjectSeat + 1) % 4,
        subjectWon,
        scores,
      }),
    );
    outcomes.push({
      replicaIndex: request.replicaIndex,
      arm: request.arm,
      seed: request.seed,
      xpRequestID: `xreq_collect-${request.arm}-${request.replicaIndex}`,
      episodeRequestID: `ereq_collect-${request.arm}-${request.replicaIndex}`,
      jobID: `job_collect-${request.arm}-${request.replicaIndex}`,
      episodeID: `episode_collect-${request.arm}-${request.replicaIndex}`,
      subjectSeat: request.subjectSeat,
      winnerSlot: subjectWon
        ? request.subjectSeat
        : (request.subjectSeat + 1) % 4,
      subjectWon,
      score: scores[request.subjectSeat]!,
      selectorAudit: selectorAuditFixture(request.arm),
    });
  }
  return outcomes;
}

function selectorAuditFixture(arm: "A" | "B" | "C") {
  return {
    installedPlanCount: 1,
    selectedOptionDistribution: { survive: 1 },
    selectedOptionFamilyDistribution: { survive: 1 },
    deterministicPreferredAbsent: { count: 0, opportunities: 1 },
    selectorDisagreement: {
      count: 0,
      opportunities: arm === "C" ? 1 : 0,
    },
  };
}
