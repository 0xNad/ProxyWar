import { createHash } from "node:crypto";

import JSZip from "jszip";

import {
  COMMANDER_COWORLD_BEDROCK_PROVIDER,
  COMMANDER_COWORLD_METADATA_ALLOWLIST,
  COMMANDER_COWORLD_PROMPT_VERSION,
  COMMANDER_COWORLD_PROMPT_VERSION_SHA256,
} from "../../src/server/agents/CommanderCoworldRuntime";
import { normalizeCommanderExecutionEnvelope } from "./coworld-decision-wire";

export const COMMANDER_XP_PLAYER_ARTIFACT_SCHEMA_VERSION = 2;
export const COMMANDER_XP_PLAYER_ARTIFACT_MAX_BYTES = 200 * 1024 * 1024;

export type CommanderXpArm = "A" | "B" | "C";

export interface CommanderXpProviderTrace {
  recordType: "provider";
  schemaVersion: 2;
  requestID: string;
  stage: "preflight" | "planner" | "selector";
  sequence: number;
  provider: "bedrock-sidecar";
  providerContractSha256: string;
  promptVersion: typeof COMMANDER_COWORLD_PROMPT_VERSION | null;
  promptVersionSha256: typeof COMMANDER_COWORLD_PROMPT_VERSION_SHA256 | null;
  requestedModel: string;
  responseModel: string | null;
  promptSha256: string;
  promptCharacters: number;
  outputSha256: string | null;
  outputCharacters: number | null;
  succeeded: boolean;
  failureKind: "transport" | "timeout" | "model-mismatch" | null;
}

export interface CommanderXpDecisionTrace {
  recordType: "decision";
  schemaVersion: 2;
  requestID: string;
  sequence: number;
  arm: CommanderXpArm;
  preSelectorObservationSha256: string;
  preSelectorLegalActionSurfaceSha256: string;
  commanderExecutionSha256: string | null;
  offeredLegalActions: Array<{ id: string; kind: string }>;
  offeredLegalActionSetSha256: string;
  selectedLegalActionID: string;
  selectedLegalActionIDs: string[];
  selectedDealActionID: string | null;
  selectedMessageActionID: string | null;
  spawnPreferenceLegalActionIDs: string[];
  runtimeMode: string | null;
  fallbackUsed: boolean;
  llmPlannerDegraded: boolean;
  degradedCause: string | null;
  commander: Record<string, string | number | boolean | null>;
}

export type CommanderXpPlayerTrace =
  | CommanderXpProviderTrace
  | CommanderXpDecisionTrace;

export interface CommanderXpRuntimeManifest {
  schemaVersion: 2;
  artifactKind: "commander-xp-policy-evidence";
  arm: CommanderXpArm;
  gameID: string;
  runKey: string;
  behaviorSourceSha: string;
  behaviorSourceTreeSha: string;
  adapterSourceSha: string;
  adapterSourceTreeSha: string;
  sourceProvenanceSha256: string;
  /** External authority: XP participant/policy-artifact metadata. */
  imageDigest: string | null;
  /** External authority: XP participant/policy-artifact metadata. */
  policyVersionID: string | null;
  policyIdentityAuthority: "external-policy-inspect-and-xp-participant-metadata";
  requestedModel: string;
  providerContract: typeof COMMANDER_COWORLD_BEDROCK_PROVIDER;
  commanderPromptVersion: typeof COMMANDER_COWORLD_PROMPT_VERSION;
  commanderPromptVersionSha256: typeof COMMANDER_COWORLD_PROMPT_VERSION_SHA256;
  runArgv: string[];
  flags: {
    STRUCTURED_DEALS: "0";
    FREETEXT_MESSAGES: "0";
    SPATIAL_OBSERVATION: "0";
    SPATIAL_MINIMAP: "0";
    KEYSTONE_PROFILE: "aggressive";
    LLM_TIMEOUT_MS: "20000";
  };
  providerPreflight: {
    required: true;
    status: "succeeded";
    requestID: string;
    requestedModel: string;
    responseModel: string;
    succeeded: true;
  };
}

export class CommanderXpTraceCollector {
  private readonly trace: CommanderXpPlayerTrace[] = [];
  private nextSequence = 0;

  provider(
    input: Omit<
      CommanderXpProviderTrace,
      "recordType" | "schemaVersion" | "sequence"
    >,
  ): void {
    this.trace.push({
      recordType: "provider",
      schemaVersion: COMMANDER_XP_PLAYER_ARTIFACT_SCHEMA_VERSION,
      sequence: this.nextSequence++,
      ...input,
    });
  }

  decision(input: {
    requestID: string;
    arm: CommanderXpArm;
    preSelectorObservationSha256: string;
    preSelectorLegalActionSurfaceSha256: string;
    legalActions: Array<{ id: string; kind: string }>;
    decision: {
      actionID: string;
      actionIDs?: string[];
      dealActionID?: string | null;
      messageActionID?: string | null;
      messageText?: string | null;
      spawnPreferenceActionIDs?: string[];
      metadata?: Record<string, unknown>;
    };
    /** Exact object serialized to the Coworld websocket. */
    response: Record<string, unknown>;
  }): void {
    const metadata = input.decision.metadata ?? {};
    const authoredCommander = Object.fromEntries(
      COMMANDER_COWORLD_METADATA_ALLOWLIST.flatMap((key) => {
        const value = metadata[key];
        return value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
          ? [[key, value] as const]
          : [];
      }),
    );
    const commanderExecution = normalizeCommanderExecutionEnvelope(
      input.response.commanderExecution,
    );
    if (
      input.response.commanderExecution !== undefined &&
      commanderExecution === null
    ) {
      throw new Error("Commander XP wire execution envelope is malformed");
    }
    const commander = commanderExecution?.metadata ?? authoredCommander;
    if (
      commanderExecution !== null &&
      COMMANDER_COWORLD_METADATA_ALLOWLIST.some(
        (key) =>
          (authoredCommander[key] ?? null) !== commanderExecution.metadata[key],
      )
    ) {
      throw new Error("Commander XP wire execution envelope diverged");
    }
    const offeredLegalActions = input.legalActions.map(({ id, kind }) => ({
      id,
      kind,
    }));
    const selectedLegalActionID = stringField(
      input.response,
      "selectedLegalActionId",
    );
    if (selectedLegalActionID === null) {
      throw new Error("Commander XP wire response omitted its primary action");
    }
    const responseBatch = input.response.selectedLegalActionIds;
    const selectedLegalActionIDs =
      responseBatch !== undefined
        ? exactWireStringArray(responseBatch, "selectedLegalActionIds", false)
        : [selectedLegalActionID];
    const responseSpawn = input.response.spawnPreferenceLegalActionIds;
    const spawnPreferenceLegalActionIDs =
      responseSpawn !== undefined
        ? exactWireStringArray(
            responseSpawn,
            "spawnPreferenceLegalActionIds",
            true,
          )
        : [];
    this.trace.push({
      recordType: "decision",
      schemaVersion: COMMANDER_XP_PLAYER_ARTIFACT_SCHEMA_VERSION,
      requestID: input.requestID,
      sequence: this.nextSequence++,
      arm: input.arm,
      preSelectorObservationSha256: requiredSha256(
        input.preSelectorObservationSha256,
        "preSelectorObservationSha256",
      ),
      preSelectorLegalActionSurfaceSha256: requiredSha256(
        input.preSelectorLegalActionSurfaceSha256,
        "preSelectorLegalActionSurfaceSha256",
      ),
      commanderExecutionSha256: commanderExecution?.metadataSha256 ?? null,
      offeredLegalActions,
      offeredLegalActionSetSha256: sha256Canonical(offeredLegalActions),
      selectedLegalActionID,
      selectedLegalActionIDs,
      selectedDealActionID: nullableWireStringField(
        input.response,
        "selectedDealActionId",
      ),
      selectedMessageActionID: nullableWireStringField(
        input.response,
        "selectedMessageActionId",
      ),
      spawnPreferenceLegalActionIDs,
      runtimeMode:
        typeof input.response.runtimeMode === "string"
          ? input.response.runtimeMode
          : null,
      fallbackUsed: input.response.fallbackUsed === true,
      llmPlannerDegraded: input.response.llmPlannerDegraded === true,
      degradedCause:
        typeof metadata.degradedCause === "string"
          ? metadata.degradedCause
          : null,
      commander,
    });
  }

  records(): readonly CommanderXpPlayerTrace[] {
    return this.trace;
  }
}

function requiredSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Commander XP ${field} is invalid`);
  }
  return value;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableWireStringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  if (!(key in record) || record[key] === null) return null;
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Commander XP wire response ${key} is malformed`);
  }
  return value;
}

function exactWireStringArray(
  value: unknown,
  key: string,
  allowEmpty: boolean,
): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`Commander XP wire response ${key} is malformed`);
  }
  return [...value] as string[];
}

export async function uploadCommanderXpPlayerArtifact(input: {
  uploadURL: string;
  manifest: CommanderXpRuntimeManifest;
  trace: readonly CommanderXpPlayerTrace[];
}): Promise<{ bytes: number; sha256: string }> {
  if (!/^https?:\/\//.test(input.uploadURL)) {
    throw new Error("Commander XP player artifact upload URL is missing");
  }
  assertRuntimeManifest(input.manifest);
  const traceText = `${input.trace.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  assertTracePrivacy(traceText);
  const manifestText = `${JSON.stringify(input.manifest, null, 2)}\n`;
  const hashes = {
    schemaVersion: 2,
    runtimeManifestSha256: sha256(manifestText),
    traceSha256: sha256(traceText),
    traceRecords: input.trace.length,
  };
  const zip = new JSZip();
  const fixedDate = new Date("1980-01-01T00:00:00.000Z");
  zip.file("runtime-manifest.json", manifestText, { date: fixedDate });
  zip.file("trace.jsonl", traceText, { date: fixedDate });
  zip.file("hashes.json", `${JSON.stringify(hashes, null, 2)}\n`, {
    date: fixedDate,
  });
  const body = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (body.byteLength > COMMANDER_XP_PLAYER_ARTIFACT_MAX_BYTES) {
    throw new Error("Commander XP player artifact exceeds 200 MiB");
  }
  const response = await fetch(input.uploadURL, {
    method: "PUT",
    headers: { "content-type": "application/zip" },
    body: body as BodyInit,
  });
  if (!response.ok) {
    throw new Error(
      `Commander XP player artifact upload returned HTTP ${response.status}`,
    );
  }
  return { bytes: body.byteLength, sha256: sha256(body) };
}

export function sha256Canonical(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertRuntimeManifest(manifest: CommanderXpRuntimeManifest): void {
  if (
    manifest.schemaVersion !== 2 ||
    manifest.artifactKind !== "commander-xp-policy-evidence" ||
    !["A", "B", "C"].includes(manifest.arm) ||
    !/^PWS[A-Z]{5}$/.test(manifest.gameID) ||
    !/^commander-xp-v2\/[A-Za-z0-9._-]+\/(?:provider-preflight|canary|confirmatory)\/r\d{2}\/(?:A|B|C)$/.test(
      manifest.runKey,
    ) ||
    !manifest.runKey.endsWith(`/${manifest.arm}`) ||
    manifest.flags.STRUCTURED_DEALS !== "0" ||
    manifest.flags.FREETEXT_MESSAGES !== "0" ||
    manifest.flags.SPATIAL_OBSERVATION !== "0" ||
    manifest.flags.SPATIAL_MINIMAP !== "0" ||
    manifest.flags.KEYSTONE_PROFILE !== "aggressive" ||
    manifest.flags.LLM_TIMEOUT_MS !== "20000" ||
    (manifest.imageDigest !== null &&
      !/^sha256:[0-9a-f]{64}$/.test(manifest.imageDigest)) ||
    manifest.policyIdentityAuthority !==
      "external-policy-inspect-and-xp-participant-metadata" ||
    JSON.stringify(manifest.providerContract) !==
      JSON.stringify(COMMANDER_COWORLD_BEDROCK_PROVIDER) ||
    manifest.commanderPromptVersion !== COMMANDER_COWORLD_PROMPT_VERSION ||
    manifest.commanderPromptVersionSha256 !==
      COMMANDER_COWORLD_PROMPT_VERSION_SHA256 ||
    manifest.providerPreflight.required !== true ||
    manifest.providerPreflight.status !== "succeeded" ||
    !/^provider-preflight-[0-9a-f]{24}$/.test(
      manifest.providerPreflight.requestID,
    ) ||
    manifest.providerPreflight.succeeded !== true ||
    manifest.providerPreflight.requestedModel !==
      COMMANDER_COWORLD_BEDROCK_PROVIDER.modelID ||
    manifest.providerPreflight.responseModel !==
      COMMANDER_COWORLD_BEDROCK_PROVIDER.responseModelID
  ) {
    throw new Error("Commander XP runtime manifest is invalid");
  }
}

function assertTracePrivacy(traceText: string): void {
  for (const forbidden of [
    "messageText",
    "commsSlotText",
    "rawProviderOutput",
    "externalRawOutput",
    "rawPrompt",
    "presigned",
    "AWS_",
    "COWORLD_PLAYER_ARTIFACT_UPLOAD_URL",
  ]) {
    if (traceText.includes(forbidden)) {
      throw new Error(
        `Commander XP trace contains forbidden field ${forbidden}`,
      );
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
