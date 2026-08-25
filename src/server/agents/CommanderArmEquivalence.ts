import type { AgentDecisionRecord } from "./AgentTypes";
import { sha256Canonical } from "./CommanderExperimentProtocol";

const SELECTOR_PROVENANCE_METADATA_KEYS = new Set([
  "commanderExperimentModel",
  "commanderExperimentPromptVersion",
  "commanderExperimentProvider",
  "commanderPrimarySelectorSource",
  "commanderPromptCharacters",
  "commanderPromptSha256",
  "commanderPromptVersion",
  "commanderRuntimeModel",
  "commanderRuntimePromptVersion",
  "commanderRuntimeProvider",
  "commanderSelectorModel",
  "commanderSelectorProvider",
  "commanderSelectorSource",
  "externalPlannerCall",
  "plannerLatencyMs",
  "plannerParseFailureReason",
  "plannerParseOk",
  "plannerRan",
  "plannerRawOutput",
  "plannerRawOutputLength",
  "providerAttemptCount",
  "providerAttemptedModels",
  "providerCallKind",
  "providerCompletedAttemptCount",
  "providerEvidenceInvalid",
  "providerEvidenceSource",
  "providerFailedAttemptCount",
  "providerInputTokens",
  "providerName",
  "providerOutputTokens",
  "providerRequestedModel",
  "providerRequestID",
  "providerResponseModel",
  "providerTimedOutAttemptCount",
  "rawProviderOutputPresent",
]);

export interface CommanderEquivalenceResult {
  activeCycles: number;
  installedPlans: number;
  normalizedStreamSha256: string;
}

/**
 * Full active decision records with only selector/provider provenance and
 * wall-clock measurements removed. Horizon, intent, rationale, plan identity,
 * age, lifecycle dispositions, failures, batch identity, action/result/audit,
 * and every other record field remain comparison-authoritative.
 */
export function normalizeCommanderEquivalenceRecord(
  record: AgentDecisionRecord,
): AgentDecisionRecord {
  const normalized = structuredClone(record);
  normalized.decidedAt = 0;
  normalized.decisionLatencyMs = 0;
  if (normalized.decisionMetadata !== undefined) {
    canonicalizeSelectedOptionEvidence(normalized.decisionMetadata);
    for (const key of SELECTOR_PROVENANCE_METADATA_KEYS) {
      delete normalized.decisionMetadata[key];
    }
    for (const key of ["planID", "commanderPreviousPlanID"] as const) {
      const value = normalized.decisionMetadata[key];
      if (typeof value === "string") {
        normalized.decisionMetadata[key] =
          normalizeSelectorDerivedPlanID(value);
      }
    }
  }
  return normalized;
}

function normalizeSelectorDerivedPlanID(value: string): string {
  return value.replace(
    /^(commander:\d+):[a-f0-9]{16}$/i,
    "$1:<selector-provenance>",
  );
}

export function normalizedCommanderActiveStream(input: {
  subjectAgentID: string;
  records: readonly AgentDecisionRecord[];
}): AgentDecisionRecord[] {
  return subjectActiveStream(input).map(normalizeCommanderEquivalenceRecord);
}

export function assertScriptedCommanderBCEquivalence(input: {
  bSubjectAgentID: string;
  bRecords: readonly AgentDecisionRecord[];
  cSubjectAgentID: string;
  cRecords: readonly AgentDecisionRecord[];
  minimumActiveCycles?: number;
  minimumInstalledPlans?: number;
}): CommanderEquivalenceResult {
  const bRaw = subjectActiveStream({
    subjectAgentID: input.bSubjectAgentID,
    records: input.bRecords,
  });
  const cRaw = subjectActiveStream({
    subjectAgentID: input.cSubjectAgentID,
    records: input.cRecords,
  });
  assertPlanIdentityConsistency(bRaw, "Arm B");
  assertPlanIdentityConsistency(cRaw, "Arm C");
  const b = bRaw.map(normalizeCommanderEquivalenceRecord);
  const c = cRaw.map(normalizeCommanderEquivalenceRecord);
  const minimumActiveCycles = input.minimumActiveCycles ?? 0;
  if (b.length < minimumActiveCycles || c.length < minimumActiveCycles) {
    throw new Error(
      `scripted B/C equivalence requires at least ${minimumActiveCycles} active cycles per arm`,
    );
  }
  const bInstalledPlans = installedPlanCount(b);
  const cInstalledPlans = installedPlanCount(c);
  const minimumInstalledPlans = input.minimumInstalledPlans ?? 0;
  if (
    bInstalledPlans < minimumInstalledPlans ||
    cInstalledPlans < minimumInstalledPlans
  ) {
    throw new Error(
      `scripted B/C equivalence requires at least ${minimumInstalledPlans} installed plans per arm`,
    );
  }
  const bHash = sha256Canonical(b);
  const cHash = sha256Canonical(c);
  if (bHash !== cHash) {
    const mismatch = firstMismatch(b, c);
    const difference = firstDifferencePath(b[mismatch - 1], c[mismatch - 1]);
    throw new Error(
      `scripted B/C full normalized records differ at active cycle ${mismatch} (${difference})`,
    );
  }
  return {
    activeCycles: b.length,
    installedPlans: bInstalledPlans,
    normalizedStreamSha256: bHash,
  };
}

function subjectActiveStream(input: {
  subjectAgentID: string;
  records: readonly AgentDecisionRecord[];
}): AgentDecisionRecord[] {
  return input.records.filter(
    (record) =>
      record.agentID === input.subjectAgentID &&
      record.chosenActionKind !== "spawn",
  );
}

function canonicalizeSelectedOptionEvidence(
  metadata: Record<string, string | number | boolean | null>,
): void {
  const sourceKeys = [
    "commanderSelectedStrategicOptionId",
    "commanderDeterministicSelectedStrategicOptionId",
    "commanderFallbackSelectedStrategicOptionId",
  ] as const;
  const values = sourceKeys.flatMap((key) => {
    const value = metadata[key];
    return typeof value === "string" ? [value] : [];
  });
  if (new Set(values).size > 1) {
    throw new Error(
      "Commander record carries conflicting selected-option evidence",
    );
  }
  for (const key of sourceKeys) delete metadata[key];
  if (values[0] !== undefined) {
    metadata.commanderSelectedStrategicOptionId = values[0];
  }
}

function assertPlanIdentityConsistency(
  records: readonly AgentDecisionRecord[],
  label: string,
): void {
  const identityBySequence = new Map<string, string>();
  for (const record of records) {
    for (const key of ["planID", "commanderPreviousPlanID"] as const) {
      const value = record.decisionMetadata?.[key];
      if (typeof value !== "string") continue;
      const matched = /^(commander:\d+):[a-f0-9]{16}$/i.exec(value);
      if (matched === null) continue;
      const sequence = matched[1]!;
      const previous = identityBySequence.get(sequence);
      if (previous !== undefined && previous !== value) {
        throw new Error(
          `${label} Commander plan ${sequence} changes identity within its active record stream`,
        );
      }
      identityBySequence.set(sequence, value);
    }
  }
}

function firstDifferencePath(
  left: unknown,
  right: unknown,
  prefix = "record",
): string {
  if (Object.is(left, right)) return prefix;
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      if (sha256Canonical(left[index]) !== sha256Canonical(right[index])) {
        return firstDifferencePath(
          left[index],
          right[index],
          `${prefix}[${index}]`,
        );
      }
    }
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    const keys = [
      ...new Set([
        ...Object.keys(left as Record<string, unknown>),
        ...Object.keys(right as Record<string, unknown>),
      ]),
    ].sort();
    for (const key of keys) {
      const leftValue = (left as Record<string, unknown>)[key];
      const rightValue = (right as Record<string, unknown>)[key];
      if (sha256Canonical(leftValue) !== sha256Canonical(rightValue)) {
        return firstDifferencePath(leftValue, rightValue, `${prefix}.${key}`);
      }
    }
  }
  return prefix;
}

function installedPlanCount(records: readonly AgentDecisionRecord[]): number {
  return records.filter(
    (record) => record.decisionMetadata?.commanderPlanInstalled === true,
  ).length;
}

function firstMismatch(
  left: readonly AgentDecisionRecord[],
  right: readonly AgentDecisionRecord[],
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (sha256Canonical(left[index]) !== sha256Canonical(right[index])) {
      return index + 1;
    }
  }
  return length + 1;
}
