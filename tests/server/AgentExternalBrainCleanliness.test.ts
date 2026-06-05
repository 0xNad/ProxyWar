import { describe, expect, it } from "vitest";
import {
  externalBrainCleanlinessReport,
  type ExternalBrainCleanlinessMode,
} from "../../src/server/agents/AgentExternalBrainCleanliness";
import type { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";

describe("externalBrainCleanlinessReport", () => {
  it("requires at least one clean external planner call", () => {
    const report = externalBrainCleanlinessReport({
      brainMode: "planner-codex-cli",
      records: [
        record({
          externalPlannerCall: true,
          plannerFallbackUsed: true,
          plannerParseOk: false,
          plannerParseFailureReason: "Codex app-server timed out.",
        }),
      ],
    });

    expect(report).toMatchObject({
      ok: false,
      externalCalls: 1,
      cleanExternalCalls: 0,
      parserFailures: 1,
      fallbacks: 1,
    });
  });

  it("allows a later house planner fallback after clean Codex planner control", () => {
    const report = externalBrainCleanlinessReport({
      brainMode: "planner-codex-cli",
      records: [
        record({
          externalPlannerCall: true,
          plannerParseOk: true,
          plannerFallbackUsed: false,
        }),
        record({
          externalPlannerCall: true,
          plannerFallbackUsed: true,
          plannerParseOk: false,
          plannerParseFailureReason: "Codex app-server timed out.",
        }),
      ],
    });

    expect(report).toMatchObject({
      ok: true,
      externalCalls: 2,
      cleanExternalCalls: 1,
      parserFailures: 0,
      fallbacks: 0,
    });
  });

  it("does not allow tester relay fallbacks to look clean", () => {
    const report = externalBrainCleanlinessReport({
      brainMode: "planner-codex-cli",
      records: [
        record({
          externalPlannerCall: true,
          plannerParseOk: true,
          plannerFallbackUsed: false,
        }),
        record({
          externalActionCall: true,
          fallbackUsed: true,
          parseSuccess: false,
          parseFailureReason: "relay worker failed",
        }),
      ],
    });

    expect(report).toMatchObject({
      ok: false,
      externalCalls: 2,
      cleanExternalCalls: 1,
      parserFailures: 1,
      fallbacks: 1,
    });
  });

  it("keeps direct Codex action fallbacks fatal", () => {
    const report = externalBrainCleanlinessReport({
      brainMode: "codex-cli",
      records: [
        record({
          externalActionCall: true,
          parseSuccess: true,
          fallbackUsed: false,
        }),
        record({
          externalActionCall: true,
          parseSuccess: false,
          fallbackUsed: true,
        }),
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.fallbacks).toBe(1);
  });
});

function record(
  metadata: Record<string, string | number | boolean | null>,
  options: {
    accepted?: boolean;
    brainMode?: ExternalBrainCleanlinessMode;
  } = {},
): AgentDecisionRecord {
  return {
    sequence: 1,
    gameID: "game",
    agentID: "agent",
    clientID: null,
    username: "Agent",
    profile: "opportunistic",
    brainType:
      options.brainMode === "codex-cli" ? "llm" : "planner-executor",
    turnNumber: 1,
    decidedAt: 1,
    decisionLatencyMs: 1,
    observationSummary: "summary",
    legalActionIDs: ["hold"],
    legalActionIDsByKind: { hold: ["hold"] },
    attackActionIDs: [],
    chosenActionID: "hold",
    chosenActionKind: "hold",
    reason: "reason",
    decisionMetadata: metadata,
    intent: null,
    result: {
      accepted: options.accepted ?? true,
      reason: "accepted",
      submittedIntent: null,
    },
  } as AgentDecisionRecord;
}
