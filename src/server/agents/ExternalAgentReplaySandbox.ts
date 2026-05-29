import fs from "fs/promises";
import path from "path";
import {
  AgentStrategyProfile,
  LegalAction,
  LegalActionKind,
  legalActionKinds,
} from "./AgentTypes";
import {
  assertExternalAgentEndpointAllowed,
  fetchExternalAgentWithPolicy,
  normalizeExternalAgentEndpointUrl,
  readExternalAgentResponseText,
} from "./ExternalAgentNetworkPolicy";
import {
  normalizeExternalAgentTokenInput,
  resolveExternalAgentToken,
} from "./ExternalAgentSecrets";
import { isSafeOpenFrontierArtifactSegment } from "./OpenFrontierPublicArtifacts";
import { LlmDecisionParser } from "./LlmDecisionParser";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ExternalAgentReplaySandboxInput {
  endpointUrl: unknown;
  token?: unknown;
  timeoutMs?: unknown;
  runID: unknown;
  sequence: unknown;
  runsRootDir?: string;
  fetchFn?: FetchLike;
  allowTokenReferences?: boolean;
}

export interface NormalizedExternalAgentReplaySandboxInput {
  endpointUrl: string;
  token?: string;
  timeoutMs: number;
  runID: string;
  sequence: number;
  runsRootDir: string;
  fetchFn?: FetchLike;
}

export interface ExternalAgentReplaySandboxResult {
  ok: boolean;
  endpoint: string;
  runID: string;
  sequence: number;
  latencyMs: number;
  offeredLegalActionIDs: string[];
  originalSelectedLegalActionId?: string;
  originalActionKind?: LegalActionKind;
  selectedLegalActionId?: string;
  selectedActionKind?: LegalActionKind;
  changedSelection?: boolean;
  reason?: string;
  confidence?: number;
  failureReason?: string;
  rawOutput?: string;
  observationSummary?: string;
  coaching?: string;
}

interface DecisionLogReplayEntry {
  runID?: string;
  matchID?: string;
  sequence?: number;
  turnNumber?: number;
  agentID?: string;
  username?: string;
  profile?: AgentStrategyProfile;
  observationSummary?: string;
  strategicSummary?: string;
  memorySummary?: string;
  objectiveSummary?: string;
  legalActionIDsByKind?: Partial<Record<LegalActionKind, string[]>>;
  selectedLegalActionId?: string;
  selectedActionKind?: LegalActionKind;
}

export function normalizeExternalAgentReplaySandboxInput(
  input: ExternalAgentReplaySandboxInput,
): NormalizedExternalAgentReplaySandboxInput {
  if (typeof input.endpointUrl !== "string") {
    throw new Error("Endpoint URL must be text");
  }
  if (typeof input.runID !== "string" || input.runID.trim() === "") {
    throw new Error("Run id is required");
  }
  const runID = input.runID.trim();
  if (!isSafeOpenFrontierArtifactSegment(runID)) {
    throw new Error("Run id is invalid");
  }
  const sequence = normalizeSequence(input.sequence);
  const tokenReference = normalizeExternalAgentTokenInput(
    input.token,
    "Endpoint bearer token",
  );
  if (
    input.allowTokenReferences !== true &&
    (tokenReference.tokenEnv !== undefined ||
      tokenReference.tokenSecret !== undefined)
  ) {
    throw new Error(
      "Endpoint token references are operator-only. Paste a beta-only token here or leave the token blank.",
    );
  }
  const token = resolveExternalAgentToken(tokenReference);
  return {
    endpointUrl: normalizeExternalAgentEndpointUrl(input.endpointUrl).url,
    ...(token !== undefined ? { token } : {}),
    timeoutMs: normalizeTimeoutMs(input.timeoutMs),
    runID,
    sequence,
    runsRootDir:
      input.runsRootDir ?? path.join(process.cwd(), "artifacts", "ai-league-runs"),
    ...(input.fetchFn !== undefined ? { fetchFn: input.fetchFn } : {}),
  };
}

export async function replayExternalAgentDecision(
  input: NormalizedExternalAgentReplaySandboxInput,
): Promise<ExternalAgentReplaySandboxResult> {
  const startedAt = Date.now();
  const endpoint = endpointLabel(input.endpointUrl);
  const record = await readDecisionLogEntry(input);
  const legalActions = legalActionsFromRecord(record);
  const offeredLegalActionIDs = legalActions.map((action) => action.id);
  if (legalActions.length === 0) {
    return {
      ok: false,
      endpoint,
      runID: input.runID,
      sequence: input.sequence,
      latencyMs: Date.now() - startedAt,
      offeredLegalActionIDs,
      originalSelectedLegalActionId: record.selectedLegalActionId,
      originalActionKind: record.selectedActionKind,
      failureReason: "Saved decision did not include legal action ids.",
      observationSummary: record.observationSummary,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const policyOptions = {
      allowPrivateNetwork:
        process.env.OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS === "true",
    };
    await assertExternalAgentEndpointAllowed(input.endpointUrl, policyOptions);
    const init: RequestInit = {
      method: "POST",
      headers: headers(input.token),
      body: JSON.stringify(replayPayload(record, legalActions, input.runID)),
      signal: controller.signal,
      redirect: "manual",
    };
    const fetchFn = input.fetchFn ?? fetch;
    const response =
      input.fetchFn === undefined
        ? await fetchExternalAgentWithPolicy(input.endpointUrl, init, policyOptions)
        : await fetchFn(input.endpointUrl, init);
    const rawOutput = await readExternalAgentResponseText(response);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return failureResult(input, record, endpoint, latencyMs, offeredLegalActionIDs, {
        failureReason: `HTTP ${response.status}: ${truncate(rawOutput, 240)}`,
        rawOutput,
      });
    }
    const parsed = new LlmDecisionParser({ maxReasonLength: 500 }).parse(
      rawOutput,
      legalActions,
    );
    if (!parsed.ok) {
      return failureResult(input, record, endpoint, latencyMs, offeredLegalActionIDs, {
        failureReason: parsed.reason,
        rawOutput,
      });
    }
    const selected = legalActions.find(
      (action) => action.id === parsed.selectedLegalActionId,
    );
    return {
      ok: true,
      endpoint,
      runID: input.runID,
      sequence: input.sequence,
      latencyMs,
      offeredLegalActionIDs,
      originalSelectedLegalActionId: record.selectedLegalActionId,
      originalActionKind: record.selectedActionKind,
      selectedLegalActionId: parsed.selectedLegalActionId,
      selectedActionKind: selected?.kind,
      changedSelection:
        record.selectedLegalActionId !== undefined &&
        parsed.selectedLegalActionId !== record.selectedLegalActionId,
      reason: parsed.reason,
      ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
      rawOutput: truncate(rawOutput, 1_000),
      observationSummary: record.observationSummary,
      coaching: coachingFor(record, parsed.selectedLegalActionId, selected?.kind),
    };
  } catch (error) {
    return failureResult(
      input,
      record,
      endpoint,
      Date.now() - startedAt,
      offeredLegalActionIDs,
      {
        failureReason: isAbortError(error)
          ? `timed out after ${input.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error),
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function readDecisionLogEntry(
  input: NormalizedExternalAgentReplaySandboxInput,
): Promise<DecisionLogReplayEntry> {
  const decisionsPath = path.join(input.runsRootDir, input.runID, "decisions.jsonl");
  const text = await fs.readFile(decisionsPath, "utf8");
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = JSON.parse(line) as unknown;
    if (!isReplayEntry(parsed)) continue;
    if (parsed.sequence === input.sequence) {
      return parsed;
    }
  }
  throw new Error(`Decision sequence ${input.sequence} was not found in ${input.runID}`);
}

function isReplayEntry(value: unknown): value is DecisionLogReplayEntry {
  return value !== null && typeof value === "object";
}

function legalActionsFromRecord(record: DecisionLogReplayEntry): LegalAction[] {
  const actions: LegalAction[] = [];
  const seen = new Set<string>();
  const grouped = record.legalActionIDsByKind ?? {};
  for (const kind of legalActionKinds) {
    for (const id of grouped[kind] ?? []) {
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      actions.push({
        id,
        kind,
        label: labelFor(id, kind),
        intent: null,
        risk: { level: kind === "hold" ? "none" : "medium" },
        metadata: {
          replaySandbox: true,
          originalDecisionSequence: record.sequence ?? null,
        },
      });
    }
  }
  return actions;
}

function replayPayload(
  record: DecisionLogReplayEntry,
  legalActions: LegalAction[],
  runID: string,
) {
  return {
    protocolVersion: "open-frontier-agent-v1",
    agent: {
      agentID: record.agentID ?? "replay-agent",
      username: record.username ?? "Replay Agent",
      profile: record.profile ?? "opportunistic",
    },
    match: {
      gameID: record.matchID ?? "REPLAY",
      phase: (record.turnNumber ?? 0) <= 0 ? "spawn" : "active",
      turnNumber: record.turnNumber ?? 0,
      tick: null,
    },
    observation: {
      summary: record.observationSummary ?? "Saved replay decision.",
      strategicSummary: record.strategicSummary,
      memorySummary: record.memorySummary,
      objectiveSummary: record.objectiveSummary,
      originalSelectedLegalActionId: record.selectedLegalActionId,
      originalSelectedActionKind: record.selectedActionKind,
      notes: [
        "Replay sandbox: this request replays a saved decision menu and does not submit a game intent.",
      ],
    },
    legalActions: legalActions.map((action) => ({
      id: action.id,
      kind: action.kind,
      label: action.label,
      risk: action.risk,
      metadata: action.metadata,
    })),
    responseContract: {
      selectedLegalActionId:
        "must exactly match one offered legalActions[].id",
      reason: "short human-readable string",
      confidence: "optional number from 0 to 1",
    },
    replaySandbox: {
      runID,
      sequence: record.sequence,
      originalSelectedLegalActionId: record.selectedLegalActionId,
      originalSelectedActionKind: record.selectedActionKind,
    },
  };
}

function failureResult(
  input: NormalizedExternalAgentReplaySandboxInput,
  record: DecisionLogReplayEntry,
  endpoint: string,
  latencyMs: number,
  offeredLegalActionIDs: string[],
  failure: { failureReason: string; rawOutput?: string },
): ExternalAgentReplaySandboxResult {
  return {
    ok: false,
    endpoint,
    runID: input.runID,
    sequence: input.sequence,
    latencyMs,
    offeredLegalActionIDs,
    originalSelectedLegalActionId: record.selectedLegalActionId,
    originalActionKind: record.selectedActionKind,
    failureReason: failure.failureReason,
    ...(failure.rawOutput !== undefined
      ? { rawOutput: truncate(failure.rawOutput, 1_000) }
      : {}),
    observationSummary: record.observationSummary,
    coaching: "Fix this sandbox response before rerunning a full match.",
  };
}

function labelFor(id: string, kind: LegalActionKind): string {
  if (kind === "hold") return "Hold";
  if (id.startsWith("expand:terra-nullius")) {
    const parts = id.split(":");
    return `Replay option: neutral expansion (${parts[parts.length - 1] ?? "bounded"}%)`;
  }
  if (kind === "build") {
    return `Replay option: build ${id.split(":")[1] ?? "structure"}`;
  }
  return `Replay option: ${kind} ${id}`;
}

function coachingFor(
  record: DecisionLogReplayEntry,
  selectedID: string,
  selectedKind: LegalActionKind | undefined,
): string {
  if (selectedID === record.selectedLegalActionId) {
    return "The endpoint chose the same LegalAction.id as the saved match. If the original turn was weak, adjust the policy prompt or scoring.";
  }
  return `The endpoint changed from ${record.selectedActionKind ?? "unknown"} to ${selectedKind ?? "unknown"}. Run a full match to see whether the new policy improves real outcomes.`;
}

function headers(token: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "x-open-frontier-agent-protocol": "open-frontier-agent-v1",
    "x-open-frontier-replay-sandbox": "true",
  };
  if (token !== undefined && token.trim() !== "") {
    headers.authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

function normalizeSequence(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
    throw new Error("Decision sequence must be a positive integer");
  }
  return parsed;
}

function normalizeTimeoutMs(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : 5_000;
  if (!Number.isFinite(parsed)) return 5_000;
  return Math.max(250, Math.min(180_000, Math.floor(parsed)));
}

function endpointLabel(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message.includes("aborted");
  }
  if (error !== null && typeof error === "object") {
    return (error as { name?: unknown }).name === "AbortError";
  }
  return false;
}
