import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

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
  commanderSocialExperimentFlags,
  runCommanderArmGate,
} from "../../src/scripts/ai-agent-commander-arm-gate";
import type { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";
import { createClaudeCliLlmProviderFromEnv } from "../../src/server/agents/ClaudeCliLlmProvider";

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
    await expect(
      runCommanderArmGate({
        providerMode: "claude-cli",
        runs: 1,
        requireWinner: true,
        sourceTreeDirty: false,
        writeReport: false,
      }),
    ).rejects.toThrow(
      "real-provider Commander experiments require at least 2 matched triplets",
    );
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
          runs: 2,
          requireWinner: true,
          sourceSha: "not-the-actual-git-head",
          sourceTreeDirty: true,
          writeReport: false,
        }),
      ).rejects.toThrow(
        "real-provider Commander sourceSha override disagrees with git HEAD",
      );
      await expect(
        runCommanderArmGate({
          providerMode: "claude-cli",
          runs: 2,
          requireWinner: true,
          sourceTreeDirty: false,
          writeReport: false,
        }),
      ).rejects.toThrow(
        "real-provider Commander sourceTreeDirty override disagrees with git status",
      );
    } finally {
      unlinkSync(dirtyCanaryPath);
    }
    expect(providerFactory).not.toHaveBeenCalled();
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
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["agent:commander:three-arm-real"]).toContain(
      "--provider-mode=claude-cli --runs=2",
    );
    expect(packageJson.scripts["agent:commander:three-arm-real"]).toContain(
      "--require-winner",
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
    expect(result.report.status).toBe("plumbing-only");
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
  }, 600_000);

  it("runs real step-locked A/B/C trajectories with selector-only B/C behavior", async () => {
    const result = await runCommanderArmGate({
      sourceSha: "b".repeat(40),
      sourceTreeDirty: false,
      maxSteps: 3,
      writeReport: false,
    });

    expect(result.report.status).toBe("plumbing-only");
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
    expect(
      a.metrics.effectAudit.delayedPending +
        a.metrics.effectAudit.delayedConfirmed,
    ).toBeGreaterThan(0);
    expect(a.metrics.effectAudit.delayedExpired).toBe(0);
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
