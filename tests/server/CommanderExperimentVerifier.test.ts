import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/configuration/ConfigLoader", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/core/configuration/ConfigLoader")
    >();
  return {
    ...actual,
    getServerConfigFromServer: () => ({
      otelEnabled: () => false,
      otelAuthHeader: () => "",
      otelEndpoint: () => "",
      env: () => 0,
    }),
    getServerConfig: () => ({ otelEnabled: () => false }),
  };
});

import { runCommanderArmGate } from "../../src/scripts/ai-agent-commander-arm-gate";
import { runCommanderExperimentVerifierCli } from "../../src/scripts/ai-agent-commander-experiment-verify";
import {
  commanderConfirmatoryAnalysisSpecification,
  sha256Canonical,
  sha256File,
  type CommanderExperimentPreRegistrationEnvelope,
  type CommanderExperimentSealEnvelope,
  type CommanderSourceIdentity,
} from "../../src/server/agents/CommanderExperimentProtocol";
import {
  verifyCommanderExperimentSeal,
  type CommanderExperimentSealVerification,
} from "../../src/server/agents/CommanderExperimentVerifier";

describe("Commander experiment post-hoc seal verifier", () => {
  let temporaryRoot = "";
  let sealedFixture = "";

  beforeAll(async () => {
    temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "proxywar-commander-verifier-"),
    );
    sealedFixture = path.join(temporaryRoot, "sealed-fixture");
    await runCommanderArmGate({
      outputDirectory: sealedFixture,
      maxSteps: 1,
      turnsPerDecisionStep: 25,
    });
  }, 60_000);

  afterAll(async () => {
    if (temporaryRoot !== "") {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  async function copyFixture(label: string): Promise<string> {
    const target = path.join(temporaryRoot, label);
    await fs.cp(sealedFixture, target, { recursive: true, errorOnExist: true });
    return target;
  }

  function codes(result: CommanderExperimentSealVerification): string[] {
    return result.diagnostics.map((entry) => entry.code);
  }

  it("verifies an intact transported root and exposes a root-only CLI", async () => {
    const transported = await copyFixture("renamed-transported-root");
    const verification = await verifyCommanderExperimentSeal(transported);
    expect(verification).toMatchObject({
      integrityVerified: true,
      experimentUsable: true,
      experimentStatus: "complete",
      sealedArtifactCount: 6,
      verifiedArtifactCount: 6,
      diagnostics: [],
      authenticity: {
        verified: false,
        status: "external-seal-receipt-required",
        sealSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        rootAloneAuthenticatesProducerOrTime: false,
      },
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      expect(await runCommanderExperimentVerifierCli([transported])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        integrityVerified: true,
        experimentUsable: true,
      });
      expect(await runCommanderExperimentVerifierCli([])).toBe(2);
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
        schemaVersion: 2,
        integrityVerified: false,
        experimentUsable: false,
        diagnostics: [{ code: "USAGE_INVALID" }],
        authenticity: {
          verified: false,
          status: "external-seal-receipt-required",
          sealSha256: null,
          rootAloneAuthenticatesProducerOrTime: false,
        },
      });
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("rejects direct, transitive, and envelope mutations without leaking bodies", async () => {
    const privateCanary = "PRIVATE_COMMANDER_VERIFIER_CANARY_71f4";

    const direct = await copyFixture("direct-mutation");
    await fs.appendFile(
      path.join(direct, "commander-three-arm.md"),
      privateCanary,
      "utf8",
    );
    const directResult = await verifyCommanderExperimentSeal(direct);
    expect(codes(directResult)).toContain("SEALED_ARTIFACT_HASH_MISMATCH");
    expect(JSON.stringify(directResult)).not.toContain(privateCanary);

    const transitive = await copyFixture("transitive-mutation");
    const seal = JSON.parse(
      await fs.readFile(
        path.join(transitive, "commander-experiment-seal.json"),
        "utf8",
      ),
    ) as CommanderExperimentSealEnvelope;
    const armManifestRelative = seal.seal.artifacts.find((entry) =>
      /\/A\/commander-arm-manifest\.json$/.test(entry.path),
    )!.path;
    const armManifestPath = path.join(transitive, armManifestRelative);
    const armManifest = JSON.parse(
      await fs.readFile(armManifestPath, "utf8"),
    ) as { artifacts: { decisionsPath: string } };
    const decisionsPath = path.resolve(
      path.dirname(armManifestPath),
      armManifest.artifacts.decisionsPath,
    );
    await fs.appendFile(decisionsPath, `\n${privateCanary}\n`, "utf8");
    const transitiveResult = await verifyCommanderExperimentSeal(transitive);
    expect(codes(transitiveResult)).toContain("ARM_ARTIFACT_GRAPH_INVALID");
    expect(JSON.stringify(transitiveResult)).not.toContain(privateCanary);

    const envelopeMutation = await copyFixture("envelope-mutation");
    const manifestPath = path.join(
      envelopeMutation,
      "commander-experiment-manifest.json",
    );
    const manifest = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as CommanderExperimentPreRegistrationEnvelope;
    manifest.manifest.configuration.privateCanary = privateCanary;
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const envelopeResult =
      await verifyCommanderExperimentSeal(envelopeMutation);
    expect(codes(envelopeResult)).toContain("MANIFEST_HASH_MISMATCH");
    expect(JSON.stringify(envelopeResult)).not.toContain(privateCanary);
  });

  it("rejects rehashed report and source-envelope attacks", async () => {
    const reportAttack = await copyFixture("rehashed-report-attack");
    const reportPath = path.join(reportAttack, "commander-three-arm.json");
    const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as Record<
      string,
      unknown
    >;
    report.forgedPerformanceClaim = true;
    await fs.writeFile(reportPath, `${JSON.stringify(report)}\n`, "utf8");
    await rehashSealArtifact(reportAttack, "commander-three-arm.json");
    const reportResult = await verifyCommanderExperimentSeal(reportAttack);
    expect(codes(reportResult)).toContain("REPORT_REBUILD_MISMATCH");

    const sourceAttack = await copyFixture("rehashed-source-attack");
    const manifestPath = path.join(
      sourceAttack,
      "commander-experiment-manifest.json",
    );
    const sealPath = path.join(sourceAttack, "commander-experiment-seal.json");
    const manifestEnvelope = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as CommanderExperimentPreRegistrationEnvelope;
    const sealEnvelope = JSON.parse(
      await fs.readFile(sealPath, "utf8"),
    ) as CommanderExperimentSealEnvelope;
    const corrupt = (
      identity: CommanderSourceIdentity,
    ): CommanderSourceIdentity => {
      const material = {
        ...identity,
        loadBearingTreeSha256: "0".repeat(64),
      };
      const { identitySha256: _old, ...withoutIdentity } = material;
      return {
        ...withoutIdentity,
        identitySha256: sha256Canonical(withoutIdentity),
      };
    };
    manifestEnvelope.manifest.source = corrupt(
      manifestEnvelope.manifest.source,
    );
    manifestEnvelope.manifestSha256 = sha256Canonical(
      manifestEnvelope.manifest,
    );
    sealEnvelope.seal.finalSource = corrupt(sealEnvelope.seal.finalSource!);
    sealEnvelope.seal.preRegistrationManifestSha256 =
      manifestEnvelope.manifestSha256;
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(manifestEnvelope, null, 2)}\n`,
      "utf8",
    );
    const manifestArtifact = sealEnvelope.seal.artifacts.find(
      (entry) => entry.path === "commander-experiment-manifest.json",
    )!;
    manifestArtifact.sha256 = await sha256File(manifestPath);
    sealEnvelope.sealSha256 = sha256Canonical(sealEnvelope.seal);
    await fs.writeFile(
      sealPath,
      `${JSON.stringify(sealEnvelope, null, 2)}\n`,
      "utf8",
    );
    const sourceResult = await verifyCommanderExperimentSeal(sourceAttack);
    expect(codes(sourceResult)).toContain("SOURCE_IDENTITY_INVALID");
  });

  it("recomputes the registered schedule and bounds malformed-input failures", async () => {
    const scheduleAttack = await copyFixture("rehashed-schedule-attack");
    await rewriteManifestAndSeal(scheduleAttack, (manifest) => {
      manifest.seeds[0]!.armOrder = ["C", "B", "A"];
    });
    expect(
      codes(await verifyCommanderExperimentSeal(scheduleAttack)),
    ).toContain("PREREGISTRATION_SCHEDULE_INVALID");

    const privateCanary = "PRIVATE_MALFORMED_MANIFEST_CANARY_2d8a";
    const malformed = await copyFixture("rehashed-malformed-body");
    await rewriteManifestAndSeal(malformed, (manifest) => {
      (manifest as unknown as Record<string, unknown>).seeds = privateCanary;
    });
    const malformedResult = await verifyCommanderExperimentSeal(malformed);
    expect(codes(malformedResult)).toContain("VERIFICATION_INPUT_INVALID");
    expect(JSON.stringify(malformedResult)).not.toContain(privateCanary);
  });

  it("rejects a fully rehashed durable arm whose mandatory disposition was removed", async () => {
    const root = await copyFixture("missing-disposition-attack");
    const experiment = await readExperimentManifest(root);
    const armPath = experiment.manifest.expectedArmManifestPaths.find((entry) =>
      /\/C\/commander-arm-manifest\.json$/.test(entry),
    )!;
    const armManifestPath = path.join(root, armPath);
    const armManifest = JSON.parse(
      await fs.readFile(armManifestPath, "utf8"),
    ) as {
      artifacts: { decisionsPath: string; decisionsSha256: string };
    };
    const decisionsPath = path.resolve(
      path.dirname(armManifestPath),
      armManifest.artifacts.decisionsPath,
    );
    const rows = (await fs.readFile(decisionsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const primary = rows.find(
      (row) =>
        row.selectedActionKind !== "spawn" &&
        "commanderResponseDisposition" in row,
    )!;
    delete primary.commanderResponseDisposition;
    await fs.writeFile(
      decisionsPath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    armManifest.artifacts.decisionsSha256 = await sha256File(decisionsPath);
    await fs.writeFile(
      armManifestPath,
      `${JSON.stringify(armManifest, null, 2)}\n`,
      "utf8",
    );
    await rehashAllSealArtifacts(root);
    const verification = await verifyCommanderExperimentSeal(root);
    expect(codes(verification)).toContain("ARM_EVIDENCE_INTEGRITY_INVALID");
    expect(verification.experimentUsable).toBe(false);
  });

  it("binds every preregistered treatment field to the canonical arm summaries", async () => {
    const mutations: Array<{
      label: string;
      expectedCode: string;
      mutate: (configuration: Record<string, unknown>) => void;
    }> = [
      {
        label: "max-steps",
        expectedCode: "ARM_GAME_TREATMENT_MISMATCH",
        mutate: (value) => (value.maxSteps = 2),
      },
      {
        label: "turns-per-step",
        expectedCode: "ARM_GAME_TREATMENT_MISMATCH",
        mutate: (value) => (value.turnsPerDecisionStep = 50),
      },
      {
        label: "require-winner",
        expectedCode: "ARM_GAME_TREATMENT_MISMATCH",
        mutate: (value) => (value.requireWinner = true),
      },
      {
        label: "planner-cadence",
        expectedCode: "ARM_GAME_TREATMENT_MISMATCH",
        mutate: (value) => (value.planEveryDecisionSteps = 9),
      },
      {
        label: "shared-args",
        expectedCode: "ARM_GAME_TREATMENT_MISMATCH",
        mutate: (value) =>
          ((value.sharedArgs as string[])[1] = "--turns-per-decision-step=99"),
      },
      {
        label: "selected-config",
        expectedCode: "ARM_GAME_TREATMENT_MISMATCH",
        mutate: (value) =>
          ((value.selectedGameConfig as Record<string, unknown>).startingGold =
            123),
      },
      {
        label: "social-flags",
        expectedCode: "ARM_SOCIAL_TREATMENT_MISMATCH",
        mutate: (value) =>
          ((value.socialFlags as Record<string, unknown>).structuredDeals =
            true),
      },
      {
        label: "arm-definition",
        expectedCode: "ARM_DEFINITION_MISMATCH",
        mutate: (value) =>
          ((
            (value.arms as Array<Record<string, unknown>>)[2]!
              .provenance as Record<string, unknown>
          ).model = "forged-model"),
      },
    ];
    for (const mutation of mutations) {
      const root = await copyFixture(`manifest-only-${mutation.label}`);
      await rewriteManifestArmReceiptsAndSeal(root, (manifest) => {
        mutation.mutate(manifest.configuration);
      });
      const verification = await verifyCommanderExperimentSeal(root);
      expect(verification.experimentUsable, mutation.label).toBe(false);
      expect(codes(verification), mutation.label).toContain(
        mutation.expectedCode,
      );
    }
  });

  it("rejects an arm artifact relabeled with a forged preregistration receipt", async () => {
    const root = await copyFixture("arm-preregistration-receipt-attack");
    const experiment = await readExperimentManifest(root);
    const armManifestPath = path.join(
      root,
      experiment.manifest.expectedArmManifestPaths[0]!,
    );
    const armManifest = JSON.parse(
      await fs.readFile(armManifestPath, "utf8"),
    ) as { run: { preRegistrationManifestSha256: string } };
    armManifest.run.preRegistrationManifestSha256 = "f".repeat(64);
    await fs.writeFile(
      armManifestPath,
      `${JSON.stringify(armManifest, null, 2)}\n`,
      "utf8",
    );
    await rehashAllSealArtifacts(root);

    const verification = await verifyCommanderExperimentSeal(root);
    expect(codes(verification)).toContain("ARM_PREREGISTRATION_MISMATCH");
    expect(verification.experimentUsable).toBe(false);
  });

  it("rejects artifact-only execution mutations for episode, max steps, and social treatment", async () => {
    const mutations = [
      {
        label: "episode-index",
        mutate: (runner: Record<string, unknown>) => (runner.episodeIndex = 3),
      },
      {
        label: "max-steps",
        mutate: (runner: Record<string, unknown>) => (runner.maxSteps = 2),
      },
      {
        label: "social-flag",
        mutate: (runner: Record<string, unknown>) =>
          (runner.structuredDealsEnabled = true),
      },
    ];
    for (const mutation of mutations) {
      const root = await copyFixture(`artifact-only-${mutation.label}`);
      await mutateFirstSummary(root, mutation.mutate);
      await rehashAllSealArtifacts(root);
      const verification = await verifyCommanderExperimentSeal(root);
      expect(codes(verification), mutation.label).toContain(
        "ARM_ARTIFACT_GRAPH_INVALID",
      );
      expect(verification.experimentUsable).toBe(false);
    }
  });

  it("rejects protocol relabels, zero component hashes, analysis-spec drift, and analysis-output drift", async () => {
    const relabeled = await copyFixture("protocol-relabel");
    await rewriteManifestAndSeal(relabeled, (manifest) => {
      manifest.configuration.protocol = "technical-canary";
    });
    expect(codes(await verifyCommanderExperimentSeal(relabeled))).toEqual(
      expect.arrayContaining([
        "PREREGISTRATION_TREATMENT_INVALID",
        "PREREGISTRATION_PROTOCOL_FLOOR_INVALID",
      ]),
    );

    const zeroComponent = await copyFixture("zero-component-hash");
    await rewriteManifestSealGraph(zeroComponent, (manifest, seal) => {
      for (const source of [manifest.source, seal.finalSource!]) {
        source.componentHashes.server = "0".repeat(64);
        const { identitySha256: _old, ...material } = source;
        source.identitySha256 = sha256Canonical(material);
      }
    });
    expect(codes(await verifyCommanderExperimentSeal(zeroComponent))).toEqual(
      expect.arrayContaining([
        "SOURCE_IDENTITY_INVALID",
        "SOURCE_COMPONENT_HASH_MISMATCH",
      ]),
    );

    for (const drift of ["method", "seed", "alpha"] as const) {
      const root = await copyFixture(`analysis-spec-${drift}`);
      await rewriteManifestAndSeal(root, (manifest) => {
        const spec =
          commanderConfirmatoryAnalysisSpecification() as unknown as Record<
            string,
            unknown
          >;
        if (drift === "method") {
          ((spec.primaryMetrics as Array<Record<string, unknown>>)[0]!
            .pValueMethod as unknown) = "post-hoc-method";
        } else if (drift === "seed") {
          (spec.resampling as Record<string, unknown>).seed = "post-hoc-seed";
        } else {
          spec.alpha = 0.1;
        }
        manifest.configuration.analysisSpecification = spec;
      });
      const verification = await verifyCommanderExperimentSeal(root);
      expect(codes(verification), drift).toEqual(
        expect.arrayContaining([
          "PREREGISTRATION_TREATMENT_INVALID",
          "ARM_ANALYSIS_SPECIFICATION_MISMATCH",
        ]),
      );
    }

    const outputDrift = await copyFixture("analysis-output-drift");
    const reportPath = path.join(outputDrift, "commander-three-arm.json");
    const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
      aggregate: { confirmatoryAnalysis: { completePairs: number } };
    };
    report.aggregate.confirmatoryAnalysis.completePairs = 48;
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await rehashAllSealArtifacts(outputDrift);
    expect(codes(await verifyCommanderExperimentSeal(outputDrift))).toContain(
      "REPORT_REBUILD_MISMATCH",
    );
  });

  async function rehashSealArtifact(
    experimentRoot: string,
    relativePath: string,
  ): Promise<void> {
    const sealPath = path.join(
      experimentRoot,
      "commander-experiment-seal.json",
    );
    const envelope = JSON.parse(
      await fs.readFile(sealPath, "utf8"),
    ) as CommanderExperimentSealEnvelope;
    const artifact = envelope.seal.artifacts.find(
      (entry) => entry.path === relativePath,
    )!;
    artifact.sha256 = await sha256File(path.join(experimentRoot, relativePath));
    envelope.sealSha256 = sha256Canonical(envelope.seal);
    await fs.writeFile(
      sealPath,
      `${JSON.stringify(envelope, null, 2)}\n`,
      "utf8",
    );
  }

  async function rewriteManifestAndSeal(
    experimentRoot: string,
    mutate: (
      manifest: CommanderExperimentPreRegistrationEnvelope["manifest"],
    ) => void,
  ): Promise<void> {
    const manifestPath = path.join(
      experimentRoot,
      "commander-experiment-manifest.json",
    );
    const sealPath = path.join(
      experimentRoot,
      "commander-experiment-seal.json",
    );
    const manifestEnvelope = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as CommanderExperimentPreRegistrationEnvelope;
    const sealEnvelope = JSON.parse(
      await fs.readFile(sealPath, "utf8"),
    ) as CommanderExperimentSealEnvelope;
    mutate(manifestEnvelope.manifest);
    manifestEnvelope.manifestSha256 = sha256Canonical(
      manifestEnvelope.manifest,
    );
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(manifestEnvelope, null, 2)}\n`,
      "utf8",
    );
    sealEnvelope.seal.preRegistrationManifestSha256 =
      manifestEnvelope.manifestSha256;
    sealEnvelope.seal.artifacts.find(
      (entry) => entry.path === "commander-experiment-manifest.json",
    )!.sha256 = await sha256File(manifestPath);
    sealEnvelope.sealSha256 = sha256Canonical(sealEnvelope.seal);
    await fs.writeFile(
      sealPath,
      `${JSON.stringify(sealEnvelope, null, 2)}\n`,
      "utf8",
    );
  }

  async function rewriteManifestArmReceiptsAndSeal(
    experimentRoot: string,
    mutate: (
      manifest: CommanderExperimentPreRegistrationEnvelope["manifest"],
    ) => void,
  ): Promise<void> {
    const manifestPath = path.join(
      experimentRoot,
      "commander-experiment-manifest.json",
    );
    const sealPath = path.join(
      experimentRoot,
      "commander-experiment-seal.json",
    );
    const manifestEnvelope = await readExperimentManifest(experimentRoot);
    const sealEnvelope = JSON.parse(
      await fs.readFile(sealPath, "utf8"),
    ) as CommanderExperimentSealEnvelope;
    mutate(manifestEnvelope.manifest);
    manifestEnvelope.manifestSha256 = sha256Canonical(
      manifestEnvelope.manifest,
    );
    for (const relativePath of manifestEnvelope.manifest
      .expectedArmManifestPaths) {
      const armManifestPath = path.join(experimentRoot, relativePath);
      const armManifest = JSON.parse(
        await fs.readFile(armManifestPath, "utf8"),
      ) as { run: { preRegistrationManifestSha256: string } };
      armManifest.run.preRegistrationManifestSha256 =
        manifestEnvelope.manifestSha256;
      await fs.writeFile(
        armManifestPath,
        `${JSON.stringify(armManifest, null, 2)}\n`,
        "utf8",
      );
    }
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(manifestEnvelope, null, 2)}\n`,
      "utf8",
    );
    sealEnvelope.seal.preRegistrationManifestSha256 =
      manifestEnvelope.manifestSha256;
    for (const artifact of sealEnvelope.seal.artifacts) {
      artifact.sha256 = await sha256File(
        path.join(experimentRoot, artifact.path),
      );
    }
    sealEnvelope.sealSha256 = sha256Canonical(sealEnvelope.seal);
    await fs.writeFile(
      sealPath,
      `${JSON.stringify(sealEnvelope, null, 2)}\n`,
      "utf8",
    );
  }

  async function readExperimentManifest(
    experimentRoot: string,
  ): Promise<CommanderExperimentPreRegistrationEnvelope> {
    return JSON.parse(
      await fs.readFile(
        path.join(experimentRoot, "commander-experiment-manifest.json"),
        "utf8",
      ),
    ) as CommanderExperimentPreRegistrationEnvelope;
  }

  async function rehashAllSealArtifacts(experimentRoot: string): Promise<void> {
    const sealPath = path.join(
      experimentRoot,
      "commander-experiment-seal.json",
    );
    const envelope = JSON.parse(
      await fs.readFile(sealPath, "utf8"),
    ) as CommanderExperimentSealEnvelope;
    for (const artifact of envelope.seal.artifacts) {
      artifact.sha256 = await sha256File(
        path.join(experimentRoot, artifact.path),
      );
    }
    envelope.sealSha256 = sha256Canonical(envelope.seal);
    await fs.writeFile(
      sealPath,
      `${JSON.stringify(envelope, null, 2)}\n`,
      "utf8",
    );
  }

  async function mutateFirstSummary(
    experimentRoot: string,
    mutate: (runnerConfig: Record<string, unknown>) => void,
  ): Promise<void> {
    const experiment = await readExperimentManifest(experimentRoot);
    const armManifestPath = path.join(
      experimentRoot,
      experiment.manifest.expectedArmManifestPaths[0]!,
    );
    const armManifest = JSON.parse(
      await fs.readFile(armManifestPath, "utf8"),
    ) as {
      artifacts: { summaryPath: string; summarySha256: string };
    };
    const summaryPath = path.resolve(
      path.dirname(armManifestPath),
      armManifest.artifacts.summaryPath,
    );
    const summary = JSON.parse(await fs.readFile(summaryPath, "utf8")) as {
      runnerConfig: Record<string, unknown>;
    };
    mutate(summary.runnerConfig);
    await fs.writeFile(
      summaryPath,
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
    armManifest.artifacts.summarySha256 = await sha256File(summaryPath);
    await fs.writeFile(
      armManifestPath,
      `${JSON.stringify(armManifest, null, 2)}\n`,
      "utf8",
    );
  }

  async function rewriteManifestSealGraph(
    experimentRoot: string,
    mutate: (
      manifest: CommanderExperimentPreRegistrationEnvelope["manifest"],
      seal: CommanderExperimentSealEnvelope["seal"],
    ) => void,
  ): Promise<void> {
    const manifestPath = path.join(
      experimentRoot,
      "commander-experiment-manifest.json",
    );
    const sealPath = path.join(
      experimentRoot,
      "commander-experiment-seal.json",
    );
    const manifestEnvelope = await readExperimentManifest(experimentRoot);
    const sealEnvelope = JSON.parse(
      await fs.readFile(sealPath, "utf8"),
    ) as CommanderExperimentSealEnvelope;
    mutate(manifestEnvelope.manifest, sealEnvelope.seal);
    manifestEnvelope.manifestSha256 = sha256Canonical(
      manifestEnvelope.manifest,
    );
    sealEnvelope.seal.preRegistrationManifestSha256 =
      manifestEnvelope.manifestSha256;
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(manifestEnvelope, null, 2)}\n`,
      "utf8",
    );
    for (const artifact of sealEnvelope.seal.artifacts) {
      artifact.sha256 = await sha256File(
        path.join(experimentRoot, artifact.path),
      );
    }
    sealEnvelope.sealSha256 = sha256Canonical(sealEnvelope.seal);
    await fs.writeFile(
      sealPath,
      `${JSON.stringify(sealEnvelope, null, 2)}\n`,
      "utf8",
    );
  }
});
