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
  const externalCallRecords = input.records.filter(
    (record) => externalCallCount(record) > 0,
  );
  const cleanExternalCallRecords = externalCallRecords.filter(
    (record) =>
      record.decisionMetadata?.parseSuccess !== false &&
      record.decisionMetadata?.plannerParseOk !== false &&
      record.decisionMetadata?.fallbackUsed !== true &&
      record.decisionMetadata?.plannerFallbackUsed !== true,
  );
  const allowHousePlannerFallbacks =
    input.brainMode === "planner-codex-cli" &&
    cleanExternalCallRecords.length > 0;
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
  const externalCalls = externalCallRecords.reduce(
    (count, record) => count + externalCallCount(record),
    0,
  );
  const cleanExternalCalls = cleanExternalCallRecords.reduce(
    (count, record) => count + externalCallCount(record),
    0,
  );

  return {
    ok:
      cleanExternalCalls > 0 &&
      parserFailures.length === 0 &&
      fallbacks.length === 0 &&
      rejected.length === 0,
    externalCalls,
    cleanExternalCalls,
    parserFailures: parserFailures.length,
    fallbacks: fallbacks.length,
    rejectedIntents: rejected.length,
    firstFailureReason: String(firstFailureReason),
  };
}

function externalCallCount(record: AgentDecisionRecord): number {
  return (
    metadataCallCount(
      record,
      "externalPlannerCallCount",
      "externalPlannerCall",
    ) +
    metadataCallCount(
      record,
      "externalActionCallCount",
      "externalActionCall",
    )
  );
}

function metadataCallCount(
  record: AgentDecisionRecord,
  countKey: string,
  booleanKey: string,
): number {
  const count = record.decisionMetadata?.[countKey];
  if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
    return Math.floor(count);
  }
  return record.decisionMetadata?.[booleanKey] === true ? 1 : 0;
}
