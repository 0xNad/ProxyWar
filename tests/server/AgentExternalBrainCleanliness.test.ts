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
          plannerParseFailureReason: "Codex planner returned unparseable JSON.",
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

  it("counts a provider that never answered as a provider failure, not a parser failure", () => {
    // `parserFailures` keys on `plannerParseOk === false`. The house planner used to
    // stamp that on EVERY fallback, including a provider timeout or transport throw, so
    // an outage was tallied against the parser - and the fixtures in this very file
    // still describe a timeout that way ("Codex app-server timed out." next to
    // `plannerParseOk: false`). Nothing was parsed on those paths, so the field is now
    // absent and the failure lands where it belongs.
    const timedOut = externalBrainCleanlinessReport({
      brainMode: "planner-codex-cli",
      records: [
        record({
          externalPlannerCall: true,
          plannerFallbackUsed: true,
          llmPlannerDegraded: true,
          degradedCause: "plan-timeout",
        }),
      ],
    });

    expect(timedOut).toMatchObject({
      ok: false,
      externalCalls: 1,
      cleanExternalCalls: 0,
      // The point of the test: an outage is not a parser failure.
      parserFailures: 0,
      fallbacks: 1,
    });

    // Contrast, so this cannot pass by the report ignoring the field: the SAME record
    // with the pre-fix shape is still counted as a parser failure.
    const preFixShape = externalBrainCleanlinessReport({
      brainMode: "planner-codex-cli",
      records: [
        record({
          externalPlannerCall: true,
          plannerFallbackUsed: true,
          llmPlannerDegraded: true,
          degradedCause: "plan-timeout",
          plannerParseOk: false,
        }),
      ],
    });
    expect(preFixShape).toMatchObject({ parserFailures: 1 });
  });

  it("does not count a refused-but-parseable planner answer as a parser failure", () => {
    // The house planner's control validation can refuse an answer that PARSED fine
    // (a must-follow violation surviving repair). That is a content decision, so the
    // record carries `plannerParseOk: true` with a repair reason - and this report must
    // count it as a fallback only. Stamping `plannerParseOk: false` there, as the
    // planner used to, inflated `parserFailures` with content rejections.
    const report = externalBrainCleanlinessReport({
      brainMode: "planner-codex-cli",
      records: [
        record({
          externalPlannerCall: true,
          plannerFallbackUsed: true,
          llmPlannerDegraded: true,
          plannerParseOk: true,
          plannerRepairUsed: true,
          plannerRepairReason:
            "planner repair still contradicted must-follow control: objective expand_territory did not match choose_spawn",
        }),
      ],
    });

    expect(report).toMatchObject({
      ok: false,
      externalCalls: 1,
      cleanExternalCalls: 0,
      parserFailures: 0,
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
          plannerParseFailureReason: "Codex planner returned unparseable JSON.",
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
    brainType: options.brainMode === "codex-cli" ? "llm" : "planner-executor",
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
