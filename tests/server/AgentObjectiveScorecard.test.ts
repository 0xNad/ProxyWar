import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildAgentObjectiveScorecard,
  writeAgentObjectiveScorecardArtifacts,
} from "../../src/server/agents/AgentObjectiveScorecard";
import { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";

describe("AgentObjectiveScorecard", () => {
  it("scores objective alignment, repetition, fallback, parser, and audit uncertainty", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-scorecard-"));
    const records: AgentDecisionRecord[] = [
      record(1, {
        actionID: "expand:terra-nullius:10",
        kind: "attack",
        objectiveAligned: true,
        accepted: true,
        auditStatus: "confirmed",
      }),
      record(2, {
        actionID: "expand:terra-nullius:10",
        kind: "attack",
        objectiveAligned: true,
        accepted: true,
        auditStatus: "unknown",
      }),
      record(3, {
        actionID: "hold",
        kind: "hold",
        objectiveAligned: false,
        accepted: true,
        auditStatus: "not_applicable",
        fallbackUsed: true,
      }),
      record(4, {
        actionID: "bad-action",
        kind: "embargo",
        objectiveAligned: false,
        accepted: false,
        auditStatus: "not_applicable",
        parserFailed: true,
      }),
      record(5, {
        actionID: "build:City:10",
        kind: "build",
        objectiveAligned: false,
        accepted: true,
        auditStatus: "unknown",
        plannerFallbackUsed: true,
        plannerParserFailed: true,
      }),
    ];

    try {
      const scorecard = buildAgentObjectiveScorecard({
        runID: "score-run",
        matchID: "SCORE",
        scenario: "actions",
        brainMode: "mock-llm",
        records,
      });
      const agent = scorecard.agents[0]!;

      expect(agent).toMatchObject({
        decisionCount: 5,
        postSpawnDecisionCount: 5,
        nonHoldCount: 4,
        objectiveAlignedCount: 2,
        acceptedCount: 4,
        rejectedCount: 1,
        confirmedAuditCount: 1,
        unknownAuditCount: 2,
        fallbackCount: 2,
        parserFailureCount: 2,
        repeatedActionCount: 2,
      });
      expect(agent.repeatedActionPenalty).toBeGreaterThan(0);
      expect(agent.unknownAuditPenalty).toBeGreaterThan(0);
      expect(agent.totalObjectiveScore).toBeLessThan(80);
      expect(agent.warnings.join(" ")).toContain("audit-unknown");

      const paths = await writeAgentObjectiveScorecardArtifacts({
        scorecard,
        directory: rootDir,
      });
      await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toContain(
        '"totalObjectiveScore"',
      );
      await expect(fs.readFile(paths.markdownPath, "utf8")).resolves.toContain(
        "Objective Scorecard",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

function record(
  sequence: number,
  input: {
    actionID: string;
    kind: AgentDecisionRecord["chosenActionKind"];
    objectiveAligned: boolean;
    accepted: boolean;
    auditStatus: NonNullable<AgentDecisionRecord["audit"]>["auditStatus"];
    fallbackUsed?: boolean;
    parserFailed?: boolean;
    plannerFallbackUsed?: boolean;
    plannerParserFailed?: boolean;
  },
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "SCORE",
    agentID: "agent-1",
    clientID: "CLIENT01",
    username: "Score Agent",
    profile: "aggressive",
    brainType: "mock-llm",
    turnNumber: sequence,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 10,
    observationSummary: "score observation",
    objectiveKind: "expand_territory",
    objectiveSummary: "Expand territory (active)",
    objectiveAligned: input.objectiveAligned,
    legalActionIDs: [input.actionID, "hold"],
    legalActionIDsByKind: { [input.kind]: [input.actionID], hold: ["hold"] },
    attackActionIDs: input.kind === "attack" ? [input.actionID] : [],
    chosenActionID: input.actionID,
    chosenActionKind: input.kind,
    reason: "score test",
    decisionMetadata: {
      fallbackUsed: input.fallbackUsed ?? false,
      ...(input.parserFailed ? { llmParseOk: false } : { llmParseOk: true }),
      plannerFallbackUsed: input.plannerFallbackUsed ?? false,
      ...(input.plannerParserFailed
        ? { plannerParseOk: false }
        : { plannerParseOk: true }),
    },
    intent:
      input.kind === "hold"
        ? null
        : { type: "attack", targetID: null, troops: 10 },
    result: {
      accepted: input.accepted,
      reason: input.accepted ? "accepted" : "rejected",
      submittedIntent:
        input.kind === "hold"
          ? null
          : { type: "attack", targetID: null, troops: 10 },
    },
    audit: {
      auditStatus: input.auditStatus,
      auditReason: `${input.auditStatus} for test`,
    },
  };
}
