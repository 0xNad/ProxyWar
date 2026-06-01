import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildExternalAgentFeedback,
  writeExternalAgentFeedbackArtifacts,
} from "../../src/server/agents/ExternalAgentFeedback";
import {
  AgentActionAuditStatus,
  AgentDecisionRecord,
} from "../../src/server/agents/AgentTypes";

describe("ExternalAgentFeedback", () => {
  it("summarizes external-agent quality and produces concrete suggestions", () => {
    const records = [
      record(1, "spawn:100", "spawn", {
        turnNumber: 0,
        auditStatus: "confirmed",
      }),
      record(2, "expand:terra-nullius:10", "attack", {
        auditStatus: "unknown",
      }),
      record(3, "expand:terra-nullius:10", "attack", {
        auditStatus: "unknown",
      }),
      record(4, "expand:terra-nullius:20", "attack", {
        auditStatus: "unknown",
      }),
      record(5, "expand:terra-nullius:20", "attack", {
        auditStatus: "unknown",
      }),
    ];

    const feedback = buildExternalAgentFeedback({
      runID: "external-run",
      matchID: "AGENTEXT",
      scenario: "actions",
      brainMode: "external-http",
      records,
    });

    expect(feedback.aggregate).toMatchObject({
      externalAgentCount: 1,
      decisionCount: 5,
      acceptedCount: 5,
      rejectedCount: 0,
      fallbackCount: 0,
      parserFailureCount: 0,
      readyForDeveloperReview: true,
    });
    expect(feedback.agents[0]).toMatchObject({
      username: "External Nation",
      actionCounts: { spawn: 1, attack: 4 },
      repeatedActionKindCount: 3,
      repeatedExactActionCount: 2,
    });
    expect(feedback.agents[0]!.improvementSuggestions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("City or Factory"),
        expect.stringContaining("break repeated"),
      ]),
    );
    expect(feedback.agents[0]!.strengths).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Every selected action was accepted"),
      ]),
    );
    expect(feedback.agents[0]!.iterationCoach).toMatchObject({
      status: "needs_strategy_iteration",
    });
    expect(feedback.agents[0]!.iterationCoach.exampleTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issue: expect.stringContaining("Repeated attack"),
          policyHint: expect.stringContaining("repetition penalty"),
        }),
      ]),
    );
    expect(feedback.aggregate.iterationCoach.practicePrompts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("recent action kind"),
      ]),
    );
  });

  it("flags parser failures, fallbacks, and rejected decisions", () => {
    const feedback = buildExternalAgentFeedback({
      runID: "external-bad-run",
      matchID: "AGENTEXT",
      scenario: "actions",
      brainMode: "external-http",
      records: [
        record(1, "hold", "hold", {
          accepted: false,
          parseSuccess: false,
          fallbackUsed: true,
          resultReason: "unknown selectedLegalActionId",
        }),
      ],
    });

    expect(feedback.aggregate).toMatchObject({
      readyForDeveloperReview: false,
      rejectedCount: 1,
      fallbackCount: 1,
      parserFailureCount: 1,
    });
    expect(feedback.aggregate.topSuggestions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("strict JSON"),
        expect.stringContaining("Only choose ids"),
      ]),
    );
    expect(feedback.aggregate.iterationCoach.status).toBe("needs_contract_fix");
    expect(feedback.aggregate.iterationCoach.priorityFixes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("strict JSON"),
      ]),
    );
  });

  it("coaches bad interior Defense Post placement", () => {
    const feedback = buildExternalAgentFeedback({
      runID: "external-build-run",
      matchID: "AGENTEXT",
      scenario: "actions",
      brainMode: "external-http",
      records: [
        record(1, "spawn:100", "spawn", { turnNumber: 0 }),
        record(2, "build:DefensePost:100", "build", {
          chosenActionMetadata: {
            unit: "DefensePost",
            isBorderBuild: false,
            nearbyEnemyCount: 0,
            defensiveValue: 0.1,
          },
        }),
      ],
    });

    expect(feedback.agents[0]!.iterationCoach.exampleTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issue: expect.stringContaining("Defense Post"),
          policyHint: expect.stringContaining("near hostile borders"),
        }),
      ]),
    );
  });

  it("writes JSON and Markdown feedback artifacts", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "external-feedback-"));
    try {
      const feedback = buildExternalAgentFeedback({
        runID: "external-run",
        matchID: "AGENTEXT",
        scenario: "actions",
        brainMode: "external-http",
        records: [record(1, "spawn:100", "spawn", { turnNumber: 0 })],
      });
      const paths = await writeExternalAgentFeedbackArtifacts({
        feedback,
        directory: rootDir,
      });

      await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toContain(
        '"externalAgentCount": 1',
      );
      await expect(fs.readFile(paths.markdownPath, "utf8")).resolves.toContain(
        "External Agent Feedback",
      );
      await expect(fs.readFile(paths.markdownPath, "utf8")).resolves.toContain(
        "Iteration Coach",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

function record(
  sequence: number,
  actionID: string,
  actionKind: AgentDecisionRecord["chosenActionKind"],
  options: {
    turnNumber?: number;
    accepted?: boolean;
    parseSuccess?: boolean;
    fallbackUsed?: boolean;
    auditStatus?: AgentActionAuditStatus;
    resultReason?: string;
    chosenActionMetadata?: AgentDecisionRecord["chosenActionMetadata"];
  } = {},
): AgentDecisionRecord {
  const accepted = options.accepted ?? true;
  return {
    sequence,
    gameID: "AGENTEXT",
    agentID: "external-1",
    clientID: "CLIENTEXT",
    username: "External Nation",
    profile: "opportunistic",
    brainType: "external-http",
    turnNumber: options.turnNumber ?? sequence,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 42,
    observationSummary: "external observation summary",
    legalActionIDs: [actionID, "hold"],
    legalActionIDsByKind: { [actionKind]: [actionID], hold: ["hold"] },
    attackActionIDs: actionKind === "attack" ? [actionID] : [],
    chosenActionID: actionID,
    chosenActionKind: actionKind,
    chosenActionMetadata: options.chosenActionMetadata,
    reason: `Selected ${actionKind}`,
    decisionMetadata: {
      brain: "external-http",
      externalActionCall: true,
      parseSuccess: options.parseSuccess ?? true,
      fallbackUsed: options.fallbackUsed ?? false,
      rawProviderOutputPresent: true,
      externalRawOutput: JSON.stringify({
        selectedLegalActionId: actionID,
        reason: `Selected ${actionKind}`,
      }),
    },
    intent: null,
    result: {
      accepted,
      reason: options.resultReason ?? (accepted ? "accepted" : "rejected"),
      submittedIntent: null,
    },
    audit: {
      auditStatus:
        options.auditStatus ??
        (actionKind === "hold" ? "not_applicable" : "confirmed"),
      auditReason: "test audit",
    },
  };
}
