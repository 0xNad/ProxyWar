import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock(
  "../../src/server/agents/ClaudeCliLlmProvider",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/server/agents/ClaudeCliLlmProvider")
      >();
    return {
      ...actual,
      createClaudeCliLlmProviderFromEnv: vi.fn(
        actual.createClaudeCliLlmProviderFromEnv,
      ),
    };
  },
);

import {
  assertCommanderGateSourceRoot,
  COMMANDER_LOCAL_SMOKE_DEFAULT_RUN_ID,
  commanderSocialExperimentFlags,
  runCommanderArmGate,
} from "../../src/scripts/ai-agent-commander-arm-gate";
import type { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";
import { createClaudeCliLlmProviderFromEnv } from "../../src/server/agents/ClaudeCliLlmProvider";
import { commanderArmTripletPathSegment } from "../../src/server/agents/CommanderArmArtifacts";
import { assertScriptedCommanderBCEquivalence } from "../../src/server/agents/CommanderArmEquivalence";
import {
  captureCommanderSourceIdentity,
  resolveScriptedCommanderRuntime,
} from "../../src/server/agents/CommanderExperimentProtocol";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

function subjectActiveStream(input: {
  subjectAgentID: string;
  records: AgentDecisionRecord[];
}) {
  return input.records
    .filter(
      (record) =>
        record.agentID === input.subjectAgentID &&
        record.chosenActionKind !== "spawn",
    )
    .map((record) => ({
      actionID: record.chosenActionID,
      actionKind: record.chosenActionKind,
      selectedOption: record.decisionMetadata?.planObjective,
      fidelity: record.decisionMetadata?.commanderFidelity,
      eligible: record.decisionMetadata?.commanderEligibleOptionIds,
      exposed: record.decisionMetadata?.commanderExposedOptionIds,
      fingerprint: record.decisionMetadata?.commanderFingerprint,
      fallback: record.decisionMetadata?.plannerFallbackUsed,
      resultAccepted: record.result.accepted,
      submittedIntent: record.result.submittedIntent,
    }));
}

function subjectCommanderProvenance(input: {
  subjectAgentID: string;
  records: AgentDecisionRecord[];
}) {
  return input.records
    .filter(
      (record) =>
        record.agentID === input.subjectAgentID &&
        record.chosenActionKind !== "spawn",
    )
    .map((record) => ({
      primary: record.decisionMetadata?.commanderPrimarySelectorSource,
      installed: record.decisionMetadata?.commanderSelectorSource,
      fallback: record.decisionMetadata?.plannerFallbackUsed,
    }));
}

describe("StrategicCommander Stage 5 matched three-arm gate", () => {
  it("rejects a working directory that is not the executed gate module checkout", async () => {
    const foreignRoot = await mkdtemp(
      path.join(os.tmpdir(), "commander-foreign-cwd-"),
    );
    temporaryRoots.push(foreignRoot);
    expect(() => assertCommanderGateSourceRoot(foreignRoot)).toThrow(
      /exact checkout that owns the executed module/,
    );
  });

  it("uses the production numeric social flags and fails before any run when either is enabled", async () => {
    const names = [
      "PROXYWAR_TUNE_STRUCTURED_DEALS",
      "PROXYWAR_TUNE_FREETEXT_MESSAGES",
    ] as const;
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    const providerFactory = vi.mocked(createClaudeCliLlmProviderFromEnv);
    providerFactory.mockClear();
    try {
      for (const name of names) {
        for (const value of ["1", "2", "1.5", "1e3"]) {
          delete process.env[names[0]];
          delete process.env[names[1]];
          process.env[name] = value;
          const flags = commanderSocialExperimentFlags();
          expect(
            name === names[0] ? flags.structuredDeals : flags.freeTextMessages,
            `${name}=${value}`,
          ).toBe(true);
          await expect(
            runCommanderArmGate({
              providerMode: "claude-cli",
              runs: 2,
              requireWinner: true,
              sourceTreeDirty: false,
              writeReport: false,
            }),
          ).rejects.toThrow(
            "Commander arm gate requires social experiment flags OFF",
          );
        }
        for (const value of [undefined, "0", "-1"]) {
          delete process.env[names[0]];
          delete process.env[names[1]];
          if (value !== undefined) process.env[name] = value;
          const flags = commanderSocialExperimentFlags();
          expect(
            name === names[0] ? flags.structuredDeals : flags.freeTextMessages,
            `${name}=${String(value)}`,
          ).toBe(false);
        }
      }
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("fails before construction when a real-provider request lacks replication, winner, or clean-source gates", async () => {
    const providerFactory = vi.mocked(createClaudeCliLlmProviderFromEnv);
    providerFactory.mockClear();
    const rejectedPlumbingOutput = path.join(
      os.tmpdir(),
      `commander-real-plumbing-${process.pid}-${Date.now()}`,
    );
    await expect(
      runCommanderArmGate({
        providerMode: "claude-cli",
        protocol: "plumbing",
        runs: 4,
        requireWinner: true,
        maxSteps: 60,
        turnsPerDecisionStep: 100,
        outputDirectory: rejectedPlumbingOutput,
      }),
    ).rejects.toThrow(
      "real-provider Commander gates require technical-canary or confirmatory protocol",
    );
    expect(existsSync(rejectedPlumbingOutput)).toBe(false);
    await expect(
      runCommanderArmGate({
        providerMode: "claude-cli",
        runs: 1,
        requireWinner: true,
        sourceTreeDirty: false,
        writeReport: false,
      }),
    ).rejects.toThrow("real technical canary requires runs=4");
    await expect(
      runCommanderArmGate({
        providerMode: "claude-cli",
        runs: 2,
        sourceTreeDirty: false,
        writeReport: false,
      }),
    ).rejects.toThrow(
      "real-provider Commander experiments require --require-winner",
    );
    const dirtyCanaryPath = path.join(
      process.cwd(),
      `commander-source-dirty-canary-${process.pid}-${Date.now()}.txt`,
    );
    writeFileSync(dirtyCanaryPath, "dirty source provenance canary\n", "utf8");
    try {
      await expect(
        runCommanderArmGate({
          providerMode: "claude-cli",
          runs: 4,
          requireWinner: true,
          maxSteps: 60,
          turnsPerDecisionStep: 100,
          sourceSha: "not-the-actual-git-head",
          sourceTreeDirty: true,
          writeReport: true,
        }),
      ).rejects.toThrow(
        "real-provider Commander sourceSha override disagrees with git HEAD",
      );
      await expect(
        runCommanderArmGate({
          providerMode: "claude-cli",
          runs: 4,
          requireWinner: true,
          maxSteps: 60,
          turnsPerDecisionStep: 100,
          sourceTreeDirty: false,
          writeReport: true,
        }),
      ).rejects.toThrow(
        "real-provider Commander sourceTreeDirty override disagrees with git status",
      );
    } finally {
      unlinkSync(dirtyCanaryPath);
    }
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("rejects real-provider runtime substitution and noncanonical UUID output roots", async () => {
    const experimentID = "323e4567-e89b-42d3-a456-426614174000";
    await expect(
      runCommanderArmGate({
        providerMode: "claude-cli",
        runs: 4,
        requireWinner: true,
        maxSteps: 60,
        turnsPerDecisionStep: 100,
        experimentID,
        verificationHooks: {
          resolveRuntime: () => resolveScriptedCommanderRuntime(),
        },
      }),
    ).rejects.toThrow(/reject verification-hook runtime substitution/);
    await expect(
      runCommanderArmGate({
        providerMode: "claude-cli",
        runs: 4,
        requireWinner: true,
        maxSteps: 60,
        turnsPerDecisionStep: 100,
        experimentID,
        outputDirectory: path.join(os.tmpdir(), "relocated-commander-evidence"),
      }),
    ).rejects.toThrow(/canonical UUID output root/);
  });

  it("wires both accepted Commander arms into the frontier benchmark without a random arm", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/scripts/ai-agent-frontier-benchmark.ts"),
      "utf8",
    );
    expect(source).toContain('"commander-v0-det"');
    expect(source).toContain('"commander-v0-llm"');
    expect(source).toContain("new DeterministicOptionSelector()");
    expect(source).toContain("new LlmOptionSelector({");
    expect(source).toContain("createClaudeCliLlmProviderFromEnv()");
    expect(source).toContain('return "commander-v0-selector"');
    expect(source).not.toContain('"commander-v0-random"');
    for (const relativePath of [
      "coworld-adapter/src/coworld-decision-wire.ts",
      "coworld-adapter/docs/player-protocol.md",
    ]) {
      expect(
        readFileSync(path.join(process.cwd(), relativePath), "utf8"),
        `${relativePath} must not expose the local-only Commander mode`,
      ).not.toContain("commander-v0-selector");
    }
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["agent:commander:three-arm-canary"]).toContain(
      "--provider-mode=claude-cli --protocol=technical-canary --runs=4",
    );
    expect(packageJson.scripts["agent:commander:three-arm-canary"]).toContain(
      "--require-winner --max-steps=60 --turns-per-decision-step=100",
    );
    expect(
      packageJson.scripts["agent:commander:three-arm-confirmatory"],
    ).toContain("--protocol=confirmatory --runs=48");
    expect(
      packageJson.scripts["agent:commander:three-arm-confirmatory"],
    ).toContain(
      "--require-winner --max-steps=60 --turns-per-decision-step=100",
    );
  });

  it("assembles two independently seeded matched triplets with distinct executed identities", async () => {
    const result = await runCommanderArmGate({
      sourceSha: "d".repeat(40),
      sourceTreeDirty: false,
      runs: 2,
      startIndex: 7,
      maxSteps: 1,
      writeReport: false,
    });

    expect(result.replicas).toHaveLength(2);
    expect(result.report.tripletCount).toBe(2);
    expect(result.report.status).toBe("mechanically-valid");
    expect(result.armExecutionOrders).toEqual([
      {
        replicaIndex: 7,
        preregistered: ["A", "C", "B"],
        executed: ["A", "C", "B"],
      },
      {
        replicaIndex: 8,
        preregistered: ["B", "A", "C"],
        executed: ["B", "A", "C"],
      },
    ]);
    const identities = result.replicas.map((replica) => {
      const arms = Object.values(replica);
      expect(new Set(arms.map((arm) => arm.artifactInput.runID)).size).toBe(1);
      expect(new Set(arms.map((arm) => arm.artifactInput.matchID)).size).toBe(
        1,
      );
      expect(
        new Set(
          arms.map((arm) => arm.artifactInput.runnerConfig?.executionSeed),
        ).size,
      ).toBe(1);
      expect(
        new Set(
          arms.map((arm) => arm.artifactInput.runnerConfig?.executionGameID),
        ).size,
      ).toBe(1);
      return {
        runID: arms[0]!.artifactInput.runID,
        gameID: arms[0]!.artifactInput.matchID,
        seed: arms[0]!.artifactInput.runnerConfig?.executionSeed,
      };
    });
    expect(new Set(identities.map((entry) => entry.runID)).size).toBe(2);
    expect(new Set(identities.map((entry) => entry.gameID)).size).toBe(2);
    expect(new Set(identities.map((entry) => entry.seed)).size).toBe(2);
    expect(
      new Set(
        result.report.triplets.map(
          (triplet) => triplet.arms.A.gameConfigurationFingerprint,
        ),
      ).size,
    ).toBe(1);
    expect(result.report.performanceEligibility.reasons).not.toContain(
      "replicated triplets do not share one game configuration",
    );
  }, 600_000);

  it("runs real step-locked A/B/C trajectories with selector-only B/C behavior", async () => {
    const result = await runCommanderArmGate({
      sourceSha: "b".repeat(40),
      sourceTreeDirty: false,
      maxSteps: 3,
      writeReport: false,
    });

    expect(result.report.status).toBe("mechanically-valid");
    expect(result.report.integrity).toEqual({
      valid: true,
      invalidationReasons: [],
    });
    expect(result.report.performanceClaimsAllowed).toBe(false);
    expect(result.report.primaryCausalComparison).toBe("B_vs_C");
    expect(result.runs.A.artifactInput.roster[0]?.brainType).toBe(
      "planner-executor",
    );
    expect(result.runs.B.artifactInput.roster[0]?.brainType).toBe(
      "strategic-commander",
    );
    expect(result.runs.C.artifactInput.roster[0]?.brainType).toBe(
      "strategic-commander",
    );

    const triplet = result.report.triplets[0]!;
    const b = triplet.arms.B;
    const c = triplet.arms.C;
    const a = triplet.arms.A;
    const delayedBoatRows = result.runs.A.artifactInput.records.filter(
      (record) =>
        record.agentID === a.subjectAgentID &&
        record.chosenActionKind === "boat" &&
        record.audit?.auditStatus === "unknown",
    );
    expect(delayedBoatRows.length).toBeGreaterThan(0);
    expect(a.metrics.canonicalPathViolations).toBe(0);
    expect(a.metrics.effectAudit.causalInferenceSupported).toBe(false);
    expect(a.metrics.effectAudit.explicitFailures).toBe(0);
    expect(b.gameConfigurationFingerprint).toBe(c.gameConfigurationFingerprint);
    expect(triplet.arms.A.spawnAssignments).toEqual(b.spawnAssignments);
    expect(b.spawnAssignments).toEqual(c.spawnAssignments);
    expect(Object.keys(b.spawnAssignments).sort()).toEqual(
      b.roster.map((entry) => entry.agentID).sort(),
    );
    expect(b.metrics.fallbackAuthoredPlans).toBe(0);
    expect(c.metrics.fallbackAuthoredPlans).toBe(0);
    expect(c.metrics.modelCalls).toBeGreaterThan(0);
    for (const arm of ["A", "B", "C"] as const) {
      expect(triplet.arms[arm].experimentFlags).toMatchObject({
        structuredDeals: false,
        freeTextMessages: false,
      });
      expect(result.runs[arm].artifactInput.runnerConfig).toMatchObject({
        structuredDealsEnabled: false,
        freeTextMessagesEnabled: false,
      });
    }
    expect(
      subjectCommanderProvenance({
        subjectAgentID: b.subjectAgentID,
        records: result.runs.B.artifactInput.records,
      }),
    ).toEqual(
      expect.arrayContaining([
        {
          primary: "deterministic",
          installed: "deterministic",
          fallback: false,
        },
      ]),
    );
    expect(
      subjectCommanderProvenance({
        subjectAgentID: c.subjectAgentID,
        records: result.runs.C.artifactInput.records,
      }),
    ).toEqual(
      expect.arrayContaining([
        { primary: "llm", installed: "llm", fallback: false },
      ]),
    );

    expect(
      subjectActiveStream({
        subjectAgentID: b.subjectAgentID,
        records: result.runs.B.artifactInput.records,
      }),
    ).toEqual(
      subjectActiveStream({
        subjectAgentID: c.subjectAgentID,
        records: result.runs.C.artifactInput.records,
      }),
    );
  }, 600_000);

  it("compares complete normalized B/C records through seven cycles and three plan installs", async () => {
    const result = await runCommanderArmGate({
      sourceSha: "9".repeat(40),
      sourceTreeDirty: false,
      maxSteps: 7,
      writeReport: false,
      seed: "stage5-full-record-equivalence",
      runID: "stage5-full-record-equivalence",
    });
    const triplet = result.report.triplets[0]!;
    expect(result.report.integrity).toEqual({
      valid: true,
      invalidationReasons: [],
    });
    for (const arm of ["A", "B", "C"] as const) {
      expect(triplet.arms[arm].metrics.effectAudit).toMatchObject({
        causalInferenceSupported: false,
        explicitFailures: 0,
      });
    }

    expect(
      assertScriptedCommanderBCEquivalence({
        bSubjectAgentID: triplet.arms.B.subjectAgentID,
        bRecords: result.runs.B.artifactInput.records,
        cSubjectAgentID: triplet.arms.C.subjectAgentID,
        cRecords: result.runs.C.artifactInput.records,
        minimumActiveCycles: 7,
        minimumInstalledPlans: 3,
      }),
    ).toMatchObject({ activeCycles: 7, installedPlans: 3 });

    const assertMetadataMutationRejected = (
      key: string,
      value: string,
    ): void => {
      const mutated = structuredClone(result.runs.C.artifactInput.records);
      const record = mutated.find(
        (entry) =>
          entry.agentID === triplet.arms.C.subjectAgentID &&
          entry.chosenActionKind !== "spawn" &&
          entry.decisionMetadata?.[key] !== undefined,
      );
      expect(record, `missing mutation target ${key}`).toBeDefined();
      record!.decisionMetadata![key] = value;
      expect(() =>
        assertScriptedCommanderBCEquivalence({
          bSubjectAgentID: triplet.arms.B.subjectAgentID,
          bRecords: result.runs.B.artifactInput.records,
          cSubjectAgentID: triplet.arms.C.subjectAgentID,
          cRecords: mutated,
          minimumActiveCycles: 7,
          minimumInstalledPlans: 3,
        }),
      ).toThrow(/full normalized records differ/);
    };
    assertMetadataMutationRejected(
      "commanderDeterministicPreferredOptionId",
      "mutated-preferred-option",
    );
    assertMetadataMutationRejected("plannerSource", "mutated-planner-source");
    assertMetadataMutationRejected(
      "commanderSelectedStrategicOptionId",
      "mutated-selected-option",
    );
    assertMetadataMutationRejected("planObjective", "mutated objective");
    assertMetadataMutationRejected(
      "commanderFingerprint",
      "mutated-fingerprint",
    );

    const planMutation = structuredClone(result.runs.C.artifactInput.records);
    const planRecord = planMutation.find(
      (entry) =>
        entry.agentID === triplet.arms.C.subjectAgentID &&
        typeof entry.decisionMetadata?.planID === "string",
    );
    expect(planRecord).toBeDefined();
    const originalPlanID = String(planRecord!.decisionMetadata!.planID);
    planRecord!.decisionMetadata!.planID = originalPlanID.replace(
      /[a-f0-9]{16}$/i,
      "0000000000000000",
    );
    expect(() =>
      assertScriptedCommanderBCEquivalence({
        bSubjectAgentID: triplet.arms.B.subjectAgentID,
        bRecords: result.runs.B.artifactInput.records,
        cSubjectAgentID: triplet.arms.C.subjectAgentID,
        cRecords: planMutation,
        minimumActiveCycles: 7,
        minimumInstalledPlans: 3,
      }),
    ).toThrow(/changes identity within its active record stream/);
  }, 600_000);

  it("rotates the fixed subject seat and sealed spawn priority across four seeded replicas", async () => {
    const result = await runCommanderArmGate({
      sourceSha: "a".repeat(40),
      sourceTreeDirty: false,
      runs: 4,
      maxSteps: 1,
      writeReport: false,
      seed: "stage5-seat-priority-rotation",
      runID: "stage5-seat-priority-rotation",
    });

    const subjectPriorityRanks: number[] = [];
    result.replicas.forEach((replica, replicaOffset) => {
      const expectedSeat = replicaOffset % 4;
      const armSubjects = (["A", "B", "C"] as const).map((arm) => {
        const input = replica[arm].artifactInput;
        expect(replica[arm].executionConfig).toMatchObject({
          subjectSeatIndex: expectedSeat,
          episodeIndex: expectedSeat,
        });
        expect(input.runnerConfig).toMatchObject({
          subjectSeatIndex: expectedSeat,
          episodeIndex: expectedSeat,
          rosterPolicy: "rotating-subject-vs-starter-bot",
        });
        const subject = input.roster[expectedSeat]!;
        expect(subject).toMatchObject({
          username: "Aggressive Agent 1",
          profile: "aggressive",
        });
        const spawn = input.records.find(
          (record) =>
            record.agentID === subject.agentID &&
            record.chosenActionKind === "spawn",
        );
        expect(spawn?.spawnSelectionEvidence?.priorityRank).toBeTypeOf(
          "number",
        );
        return {
          username: subject.username,
          profile: subject.profile,
          priorityRank: spawn!.spawnSelectionEvidence!.priorityRank,
          assignedActionID: spawn!.spawnSelectionEvidence!.assignedActionID,
        };
      });
      expect(armSubjects[0]).toEqual(armSubjects[1]);
      expect(armSubjects[1]).toEqual(armSubjects[2]);
      subjectPriorityRanks.push(armSubjects[1]!.priorityRank);
    });
    expect(subjectPriorityRanks.sort()).toEqual([1, 2, 3, 4]);
  }, 600_000);

  it("invalidates on mid-run source drift after preserving the completed arm", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "commander-gate-drift-"));
    temporaryRoots.push(root);
    const outputDirectory = path.join(root, "evidence");
    const originalSource = await captureCommanderSourceIdentity();
    let drifted = false;

    await expect(
      runCommanderArmGate({
        outputDirectory,
        sourceSha: "e".repeat(40),
        sourceTreeDirty: false,
        maxSteps: 1,
        experimentID: "123e4567-e89b-42d3-a456-426614174000",
        verificationHooks: {
          captureSourceIdentity: async () =>
            drifted
              ? { ...originalSource, identitySha256: "f".repeat(64) }
              : originalSource,
          resolveRuntime: () => resolveScriptedCommanderRuntime(),
          afterArmPersisted: () => {
            drifted = true;
          },
        },
      }),
    ).rejects.toThrow(/source identity drifted mid-run/);

    const preManifestPath = path.join(
      outputDirectory,
      "commander-experiment-manifest.json",
    );
    const armManifestPath = path.join(
      outputDirectory,
      "inputs",
      commanderArmTripletPathSegment(COMMANDER_LOCAL_SMOKE_DEFAULT_RUN_ID),
      "A",
      "commander-arm-manifest.json",
    );
    const sealPath = path.join(
      outputDirectory,
      "commander-experiment-seal.json",
    );
    expect(existsSync(preManifestPath)).toBe(true);
    expect(existsSync(armManifestPath)).toBe(true);
    expect(existsSync(sealPath)).toBe(true);
    const sealed = JSON.parse(await readFile(sealPath, "utf8")) as {
      seal: {
        status: string;
        reasons: string[];
        artifacts: { path: string }[];
      };
    };
    expect(sealed.seal.status).toBe("invalid");
    expect(sealed.seal.reasons).toHaveLength(1);
    expect(sealed.seal.reasons[0]).toMatch(
      /^category=source_identity_drift .*diagnosticSha256=[a-f0-9]{64}$/,
    );
    expect(sealed.seal.artifacts.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "commander-experiment-manifest.json",
        `inputs/${commanderArmTripletPathSegment(COMMANDER_LOCAL_SMOKE_DEFAULT_RUN_ID)}/A/commander-arm-manifest.json`,
      ]),
    );
  }, 600_000);

  it("withholds reports and records unavailable final recapture without leaking the failure", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "commander-gate-recapture-failure-"),
    );
    temporaryRoots.push(root);
    const outputDirectory = path.join(root, "evidence");
    const originalSource = await captureCommanderSourceIdentity();
    const sentinel = "PRIVATE_FINAL_RECAPTURE_SENTINEL_4af1";
    let captureCount = 0;

    await expect(
      runCommanderArmGate({
        outputDirectory,
        sourceSha: "6".repeat(40),
        sourceTreeDirty: false,
        maxSteps: 1,
        experimentID: "723e4567-e89b-42d3-a456-426614174000",
        verificationHooks: {
          captureSourceIdentity: async () => {
            captureCount += 1;
            if (captureCount >= 5) throw new Error(sentinel);
            return originalSource;
          },
          resolveRuntime: () => resolveScriptedCommanderRuntime(),
        },
      }),
    ).rejects.toThrow(sentinel);

    expect(
      existsSync(path.join(outputDirectory, "commander-three-arm.json")),
    ).toBe(false);
    expect(
      existsSync(path.join(outputDirectory, "commander-three-arm.md")),
    ).toBe(false);
    const sealed = JSON.parse(
      await readFile(
        path.join(outputDirectory, "commander-experiment-seal.json"),
        "utf8",
      ),
    ) as {
      seal: {
        reasons: string[];
        finalSource: unknown;
        finalRuntime: unknown;
        recapture: {
          source: string;
          runtime: string;
          sourceFailure: string;
        };
        artifacts: Array<{ path: string }>;
      };
    };
    expect(sealed.seal.finalSource).toBeNull();
    expect(sealed.seal.finalRuntime).not.toBeNull();
    expect(sealed.seal.recapture).toMatchObject({
      source: "unavailable",
      runtime: "captured",
    });
    expect(JSON.stringify(sealed)).not.toContain(sentinel);
    expect(sealed.seal.artifacts.map((entry) => entry.path)).not.toContain(
      "commander-three-arm.json",
    );
  }, 600_000);

  it("seals every surviving report file when paired report publication fails", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "commander-gate-partial-report-"),
    );
    temporaryRoots.push(root);
    const outputDirectory = path.join(root, "evidence");
    let planted = false;

    await expect(
      runCommanderArmGate({
        outputDirectory,
        sourceSha: "5".repeat(40),
        sourceTreeDirty: false,
        maxSteps: 1,
        experimentID: "823e4567-e89b-42d3-a456-426614174000",
        verificationHooks: {
          afterArmPersisted: ({ arm }) => {
            if (arm === "C" && !planted) {
              planted = true;
              writeFileSync(
                path.join(outputDirectory, "commander-three-arm.md"),
                "preexisting report collision\n",
                "utf8",
              );
            }
          },
        },
      }),
    ).rejects.toThrow();

    const sealed = JSON.parse(
      await readFile(
        path.join(outputDirectory, "commander-experiment-seal.json"),
        "utf8",
      ),
    ) as { seal: { status: string; artifacts: Array<{ path: string }> } };
    expect(sealed.seal.status).toBe("invalid");
    expect(sealed.seal.artifacts.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "commander-three-arm.json",
        "commander-three-arm.md",
      ]),
    );
  }, 600_000);

  it("pre-registers and seals a complete unique evidence root", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "commander-gate-complete-"),
    );
    temporaryRoots.push(root);
    const outputDirectory = path.join(root, "evidence");
    const experimentID = "223e4567-e89b-42d3-a456-426614174000";
    const result = await runCommanderArmGate({
      outputDirectory,
      sourceSha: "8".repeat(40),
      sourceTreeDirty: false,
      maxSteps: 1,
      experimentID,
    });

    expect(result.experimentID).toBe(experimentID);
    expect(result.preRegistrationManifestPath).toBe(
      path.join(outputDirectory, "commander-experiment-manifest.json"),
    );
    expect(result.sealPath).toBe(
      path.join(outputDirectory, "commander-experiment-seal.json"),
    );
    const preRegistration = JSON.parse(
      await readFile(result.preRegistrationManifestPath!, "utf8"),
    ) as {
      manifest: {
        experimentID: string;
        runtime: {
          outerDecisionTimeoutMs: number;
          commanderSelectorTimeoutMs: number;
          identitySha256: string;
        };
        source: {
          componentHashes: Record<string, string>;
          ignoredLoadBearingFiles: string[];
          componentFiles: Record<
            string,
            Array<{ path: string; sha256: string }>
          >;
        };
        seeds: unknown[];
        expectedArmManifestPaths: string[];
      };
    };
    expect(preRegistration.manifest).toMatchObject({
      experimentID,
      runtime: {
        outerDecisionTimeoutMs: 120_000,
        commanderSelectorTimeoutMs: 12_000,
      },
    });
    expect(preRegistration.manifest.source.componentHashes).toHaveProperty(
      "runtimeAssets",
    );
    expect(preRegistration.manifest.source.ignoredLoadBearingFiles).toEqual([]);
    expect(
      preRegistration.manifest.source.componentFiles.runtimeAssets.map(
        (entry) => entry.path,
      ),
    ).toEqual(
      expect.arrayContaining([
        "resources/maps/asia/map.bin",
        "resources/maps/asia/manifest.json",
        "resources/QuickChat.json",
        "resources/countries.json",
      ]),
    );
    expect(preRegistration.manifest.seeds).toHaveLength(1);
    expect(preRegistration.manifest.expectedArmManifestPaths).toHaveLength(3);
    expect(
      Object.values(result.report.triplets[0]!.arms).map(
        (arm) => arm.runtimeIdentitySha256,
      ),
    ).toEqual([
      preRegistration.manifest.runtime.identitySha256,
      preRegistration.manifest.runtime.identitySha256,
      preRegistration.manifest.runtime.identitySha256,
    ]);
    const seal = JSON.parse(await readFile(result.sealPath!, "utf8")) as {
      seal: {
        experimentID: string;
        status: string;
        artifacts: { path: string; sha256: string }[];
      };
      sealSha256: string;
    };
    expect(seal.seal).toMatchObject({ experimentID, status: "complete" });
    expect(seal.seal).toMatchObject({
      recapture: {
        source: "captured",
        runtime: "captured",
        sourceFailure: null,
        runtimeFailure: null,
      },
    });
    expect(seal.seal.artifacts).toHaveLength(6);
    expect(
      seal.seal.artifacts.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)),
    ).toBe(true);
    expect(seal.sealSha256).toMatch(/^[a-f0-9]{64}$/);
  }, 600_000);

  it("keeps long replicated run IDs on distinct preregistered artifact paths", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "commander-gate-long-run-id-"),
    );
    temporaryRoots.push(root);
    const outputDirectory = path.join(root, "evidence");
    const result = await runCommanderArmGate({
      outputDirectory,
      sourceSha: "7".repeat(40),
      sourceTreeDirty: false,
      maxSteps: 1,
      runs: 2,
      runID: `long-${"x".repeat(140)}`,
      experimentID: "423e4567-e89b-42d3-a456-426614174000",
    });
    const preRegistration = JSON.parse(
      await readFile(result.preRegistrationManifestPath!, "utf8"),
    ) as {
      manifest: { expectedArmManifestPaths: string[] };
    };
    const expected = preRegistration.manifest.expectedArmManifestPaths;
    expect(expected).toHaveLength(6);
    expect(new Set(expected).size).toBe(6);
    expect(new Set(expected.map((entry) => entry.split("/")[1])).size).toBe(2);
    for (const relativePath of expected) {
      expect(existsSync(path.join(outputDirectory, relativePath))).toBe(true);
    }
  }, 600_000);

  it("repeats the deterministic Arm B action stream exactly", async () => {
    const options = {
      sourceSha: "c".repeat(40),
      sourceTreeDirty: false,
      maxSteps: 1,
      writeReport: false,
      seed: "stage5-reproducibility",
      runID: "stage5-reproducibility",
    } as const;
    const first = await runCommanderArmGate(options);
    const second = await runCommanderArmGate(options);
    const firstB = first.report.triplets[0]!.arms.B;
    const secondB = second.report.triplets[0]!.arms.B;

    expect(firstB.spawnAssignments).toEqual(secondB.spawnAssignments);
    expect(
      subjectActiveStream({
        subjectAgentID: firstB.subjectAgentID,
        records: first.runs.B.artifactInput.records,
      }),
    ).toEqual(
      subjectActiveStream({
        subjectAgentID: secondB.subjectAgentID,
        records: second.runs.B.artifactInput.records,
      }),
    );
  }, 600_000);
});
