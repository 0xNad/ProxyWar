import type { AgentDecisionRecord } from "./AgentTypes";

export type ExternalBrainCleanlinessMode =
  | "rule"
  | "mock-llm"
  | "real-llm"
  | "codex-cli"
  | "planner"
  | "planner-codex-cli";

export interface ExternalBrainCleanlinessReport {
  ok: boolean;
  externalCalls: number;
  cleanExternalCalls: number;
  parserFailures: number;
  fallbacks: number;
  rejectedIntents: number;
  firstFailureReason: string;
}

export function externalBrainCleanlinessReport(input: {
  brainMode: ExternalBrainCleanlinessMode;
  records: AgentDecisionRecord[];
}): ExternalBrainCleanlinessReport {
  const externalCalls = input.records.filter(
    (record) =>
      record.decisionMetadata?.externalPlannerCall === true ||
      record.decisionMetadata?.externalActionCall === true,
  );
  const cleanExternalCalls = externalCalls.filter(
    (record) =>
      record.decisionMetadata?.parseSuccess !== false &&
      record.decisionMetadata?.plannerParseOk !== false &&
      record.decisionMetadata?.fallbackUsed !== true &&
      record.decisionMetadata?.plannerFallbackUsed !== true,
  );
  const allowHousePlannerFallbacks =
    input.brainMode === "planner-codex-cli" && cleanExternalCalls.length > 0;
  const parserFailures = input.records.filter(
    (record) =>
      record.decisionMetadata?.parseSuccess === false ||
      (record.decisionMetadata?.plannerParseOk === false &&
        !(
          allowHousePlannerFallbacks &&
          record.decisionMetadata?.externalPlannerCall === true &&
          record.decisionMetadata?.plannerFallbackUsed === true
        )),
  );
  const fallbacks = input.records.filter(
    (record) =>
      record.decisionMetadata?.fallbackUsed === true ||
      (record.decisionMetadata?.plannerFallbackUsed === true &&
        !(
          allowHousePlannerFallbacks &&
          record.decisionMetadata?.externalPlannerCall === true
        )),
  );
  const rejected = input.records.filter((record) => !record.result.accepted);
  const firstFailure =
    parserFailures[0] ?? fallbacks[0] ?? rejected[0] ?? input.records[0];
  const firstFailureReason =
    firstFailure?.decisionMetadata?.plannerParseFailureReason ??
    firstFailure?.decisionMetadata?.parseFailureReason ??
    firstFailure?.decisionMetadata?.brainErrorReason ??
    firstFailure?.result.reason ??
    "external brain did not produce a clean accepted decision";

  return {
    ok:
      cleanExternalCalls.length > 0 &&
      parserFailures.length === 0 &&
      fallbacks.length === 0 &&
      rejected.length === 0,
    externalCalls: externalCalls.length,
    cleanExternalCalls: cleanExternalCalls.length,
    parserFailures: parserFailures.length,
    fallbacks: fallbacks.length,
    rejectedIntents: rejected.length,
    firstFailureReason: String(firstFailureReason),
  };
}
