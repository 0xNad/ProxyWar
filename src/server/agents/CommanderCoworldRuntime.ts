import { createHash } from "node:crypto";

/**
 * Minimal hosted Commander runtime contract. This intentionally contains no
 * preregistration, sealing, workflow, or statistical-analysis machinery.
 */
export const COMMANDER_COWORLD_BEHAVIOR_SOURCE_SHA =
  "a69175a30577b3e516f09a2cb0960d4d129b3f33";
export const COMMANDER_COWORLD_BEHAVIOR_SOURCE_TREE_SHA =
  "b1b88e4a447acb885ed554592d3865af0178314f";
export const COMMANDER_COWORLD_PROMPT_VERSION = "strategic-commander-v0-stage2";
export const COMMANDER_COWORLD_PROMPT_VERSION_SHA256 =
  "00db34a7939d9d27a3370decf1e3f3f5895b0a3e3676c2e043ec426b5e199094";
export const COMMANDER_COWORLD_BEDROCK_PROVIDER = {
  provider: "bedrock-sidecar",
  routingAuthority: "coworld-injected-bedrock-sidecar-v1",
  endpointAuthority: "coworld-injected-loopback-bedrock-runtime-sidecar-v1",
  modelID: "us.anthropic.claude-sonnet-4-6",
  responseModelID: "claude-sonnet-4-6",
  region: "us-west-2",
  sdkPackage: "@anthropic-ai/bedrock-sdk",
  sdkVersion: "0.29.2",
  timeoutMs: 12_000,
  maxTokens: 1_024,
  backendRevision: "unattested-provider-residual",
} as const;

export const COMMANDER_COWORLD_METADATA_ALLOWLIST = [
  "runtimeMode",
  "plannerSource",
  "executorSource",
  "actionSelectionSource",
  "externalPlannerCall",
  "plannerRan",
  "plannerLatencyMs",
  "plannerFallbackUsed",
  "plannerParseOk",
  "llmPlannerDegraded",
  "degradedCause",
  "commanderSelectorSource",
  "commanderPrimarySelectorSource",
  "planID",
  "planObjective",
  "commanderSelectedOptionID",
  "commanderSelectedOptionFamily",
  "commanderPreviousPlanID",
  "commanderFingerprint",
  "commanderEligibleOptionIds",
  "commanderOptionSurfaceSha256",
  "commanderExposedOptionIds",
  "commanderOmittedOptions",
  "commanderFidelity",
  "commanderBatchFidelities",
  "commanderReplanReason",
  "commanderResponseDisposition",
  "commanderRejectionCode",
  "commanderPlanInstalled",
  "commanderHorizonDecisions",
  "commanderPlanAgeDecisions",
  "commanderEmergencyCondition",
  "commanderBlockedReason",
  "commanderImmediateReplan",
  "commanderDeterministicPreferredOptionId",
  "commanderDeterministicPreferredOptionAbsent",
  "commanderPromptCharacters",
  "commanderSelectionFailureKind",
  "commanderSelectorProvider",
  "commanderSelectorModel",
  "commanderPromptVersion",
  "commanderPromptSha256",
  "batchIndex",
  "batchSize",
  "batchActionIDs",
] as const;

export function commanderCoworldPreflightRequestID(runKey: string): string {
  if (
    !/^commander-xp-v2\/[A-Za-z0-9._-]+\/(?:provider-preflight|canary|confirmatory)\/r\d{2}\/(?:A|B|C)$/.test(
      runKey,
    )
  ) {
    throw new Error("Commander Coworld run key is invalid");
  }
  return `provider-preflight-${createHash("sha256")
    .update(runKey)
    .digest("hex")
    .slice(0, 24)}`;
}

export function commanderCoworldSha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
