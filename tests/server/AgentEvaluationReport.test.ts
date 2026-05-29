import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { UnitType } from "../../src/core/game/Game";
import { writeAgentEvaluationArtifacts } from "../../src/server/agents/AgentEvaluationReport";
import { writeAgentLeagueRunArtifacts } from "../../src/server/agents/AgentDecisionLogWriter";
import { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";

describe("AgentEvaluationReport", () => {
  it("summarizes league run artifacts into evaluation JSON and Markdown", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-eval-"));
    const intent = {
      type: "build_unit" as const,
      unit: UnitType.DefensePost,
      tile: 10,
    };
    const record: AgentDecisionRecord = {
      sequence: 1,
      gameID: "AGENTEVAL",
      agentID: "agent-1",
      clientID: "CLIENT01",
      username: "Builder Agent",
      profile: "defensive",
      brainType: "mock-llm",
      turnNumber: 4,
      decidedAt: Date.UTC(2026, 0, 1),
      decisionLatencyMs: 50,
      observationSummary: "defensive Builder Agent: builds=1",
      legalActionIDs: ["build:Defense Post:10", "hold"],
      legalActionIDsByKind: {
        build: ["build:Defense Post:10"],
        hold: ["hold"],
      },
      attackActionIDs: [],
      chosenActionID: "build:Defense Post:10",
      chosenActionKind: "build",
      reason: "Selected a defensive structure.",
      decisionMetadata: {
        brain: "llm",
        brainType: "mock-llm",
        llmRawOutput:
          '{"selectedLegalActionId":"build:Defense Post:10","reason":"Build."}',
        llmParseOk: true,
        llmConfidence: 0.8,
        fallbackUsed: false,
      },
      chosenActionMetadata: {
        unit: UnitType.DefensePost,
        buildTile: 10,
      },
      intent,
      result: {
        accepted: true,
        reason: "accepted",
        submittedIntent: intent,
      },
    };

    try {
      const run = await writeAgentLeagueRunArtifacts({
        rootDir: path.join(rootDir, "runs"),
        runID: "run-1",
        matchID: "AGENTEVAL",
        scenario: "actions",
        brainMode: "mock-llm",
        runnerMode: "step-locked",
        startedAt: Date.UTC(2026, 0, 1),
        completedAt: Date.UTC(2026, 0, 1, 0, 0, 1),
        records: [record],
        roster: [
          {
            agentID: "agent-1",
            username: "Builder Agent",
            profile: "defensive",
            clientID: "CLIENT01",
            brainType: "mock-llm",
          },
        ],
      });
      const paths = await writeAgentEvaluationArtifacts({
        rootDir: path.join(rootDir, "evals"),
        evalID: "eval-1",
        brain: "mock-llm",
        scenario: "actions",
        startedAt: Date.UTC(2026, 0, 1),
        completedAt: Date.UTC(2026, 0, 1, 0, 0, 2),
        runs: [run],
      });

      const summary = JSON.parse(await fs.readFile(paths.summaryPath, "utf8"));
      expect(summary).toMatchObject({
        evalID: "eval-1",
        runCount: 1,
        decisionCount: 1,
        acceptedRate: 1,
        fallbackRate: 0,
        parserFailureRate: 0,
        visualReportCount: 1,
        actionCounts: { build: 1 },
        auditStats: {
          confirmed: 0,
          unknown: 1,
          failed: 0,
          notApplicable: 0,
        },
        objectiveScoreStats: {
          min: expect.any(Number),
          avg: expect.any(Number),
          max: expect.any(Number),
        },
      });
      expect(summary.runs[0]).toMatchObject({
        scorecardExists: true,
        objectiveScore: expect.any(Number),
      });

      const report = await fs.readFile(paths.reportPath, "utf8");
      expect(report).toContain("# Open Frontier Evaluation eval-1");
      expect(report).toContain("build:Defense Post:10");
      expect(report).toContain("Objective score");
      expect(report).toContain("run-1");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
