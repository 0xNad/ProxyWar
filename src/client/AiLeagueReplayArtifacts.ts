export interface AiLeagueReplayUiDecision {
  sequence: number;
  turnNumber: number;
  username: string;
  profile: string;
  brainType: string;
  selectedActionKind: string;
  selectedLegalActionId: string;
  selectedActionMetadata?: Record<string, unknown>;
  socialText?: string;
  socialTargetName?: string;
  reason: string;
  planObjective?: string;
  decisionLatencyMs: number;
  fallbackUsed: boolean;
  parseSuccess?: boolean;
  result: {
    accepted: boolean;
    reason: string;
  };
  auditStatus?: string;
}

export interface AiLeagueReplayArtifactAvailability {
  visualReport: boolean;
  spectatorTelemetry: boolean;
  decisions: boolean;
  summary: boolean;
}

export interface AiLeagueReplayDetails {
  recentDecisions: AiLeagueReplayUiDecision[];
  summary: Record<string, unknown> | null;
  spectatorTelemetry: unknown;
  artifactAvailability: AiLeagueReplayArtifactAvailability;
}

interface ReplayUiArtifact {
  version: 1;
  decisionCount: number;
  rejectedCount: number;
  fallbackCount: number;
  actionCounts: Record<string, number>;
  recentDecisions: AiLeagueReplayUiDecision[];
  artifacts: AiLeagueReplayArtifactAvailability;
}

/**
 * Loads non-critical replay evidence after the renderer has produced its first
 * frame. The raw decisions.jsonl is deliberately never fetched here: Coworld
 * logs can be tens of megabytes and replay-ui.json already contains bounded UI
 * data plus aggregate counts.
 */
export async function loadAiLeagueReplayDetails(
  artifactBasePath: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    onPartial?: (details: AiLeagueReplayDetails) => void;
  } = {},
): Promise<AiLeagueReplayDetails> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = (name: string, init?: RequestInit) =>
    fetchImpl(`${artifactBasePath}/${name}`, {
      ...init,
      signal: options.signal,
    });
  const coreResultsPromise = Promise.allSettled([
    request("replay-ui.json"),
    request("match-summary.json"),
  ]);
  // Start telemetry concurrently, but keep it out of the core-details gate.
  // Large or slow telemetry must not suppress the already-bounded replay UI.
  const telemetryResultPromise = Promise.allSettled([
    request("spectator-telemetry.json"),
  ]);
  const [uiResult, summaryResult] = await coreResultsPromise;

  const replayUi = await parsedReplayUi(uiResult);
  const summaryResponse = fulfilledOk(summaryResult);
  const summaryValue = await parsedRecord(summaryResponse);

  let visualReport = replayUi?.artifacts.visualReport ?? false;
  let decisions = replayUi?.artifacts.decisions ?? false;
  if (replayUi === null && !options.signal?.aborted) {
    const [visualResult, decisionsResult] = await Promise.allSettled([
      request("visual-report.html", { method: "HEAD" }),
      request("decisions.jsonl", { method: "HEAD" }),
    ]);
    visualReport = fulfilledOk(visualResult) !== null;
    decisions = fulfilledOk(decisionsResult) !== null;
  }

  const summary = {
    ...(summaryValue ?? {}),
    ...(replayUi === null
      ? {}
      : {
          decisionCount: replayUi.decisionCount,
          rejectedCount: replayUi.rejectedCount,
          fallbackCount: replayUi.fallbackCount,
          actionCounts: replayUi.actionCounts,
        }),
  };

  const partialDetails: AiLeagueReplayDetails = {
    recentDecisions: replayUi?.recentDecisions ?? [],
    summary: Object.keys(summary).length > 0 ? summary : null,
    spectatorTelemetry: null,
    artifactAvailability: {
      visualReport,
      spectatorTelemetry: false,
      decisions,
      summary: summaryResponse !== null,
    },
  };
  options.onPartial?.(partialDetails);

  const [telemetryResult] = await telemetryResultPromise;
  const telemetryResponse = fulfilledOk(telemetryResult);
  const spectatorTelemetry = await parsedJson(telemetryResponse);
  return {
    ...partialDetails,
    spectatorTelemetry,
    artifactAvailability: {
      ...partialDetails.artifactAvailability,
      spectatorTelemetry: telemetryResponse !== null,
    },
  };
}

function fulfilledOk(result: PromiseSettledResult<Response>): Response | null {
  return result.status === "fulfilled" && result.value.ok ? result.value : null;
}

async function parsedReplayUi(
  result: PromiseSettledResult<Response>,
): Promise<ReplayUiArtifact | null> {
  return normalizeReplayUi(await parsedJson(fulfilledOk(result)));
}

async function parsedJson(response: Response | null): Promise<unknown> {
  if (response === null) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function parsedRecord(
  response: Response | null,
): Promise<Record<string, unknown> | null> {
  const value = await parsedJson(response);
  return isRecord(value) ? value : null;
}

function normalizeReplayUi(value: unknown): ReplayUiArtifact | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    !isFiniteNumber(value.decisionCount) ||
    !isFiniteNumber(value.rejectedCount) ||
    !isFiniteNumber(value.fallbackCount) ||
    !isRecord(value.actionCounts) ||
    !Array.isArray(value.recentDecisions) ||
    !isArtifactAvailability(value.artifacts)
  ) {
    return null;
  }
  const actionCounts: Record<string, number> = {};
  for (const [kind, count] of Object.entries(value.actionCounts)) {
    if (isFiniteNumber(count) && count >= 0) actionCounts[kind] = count;
  }
  const recentDecisions = value.recentDecisions.filter(isReplayUiDecision);
  return {
    version: 1,
    decisionCount: value.decisionCount,
    rejectedCount: value.rejectedCount,
    fallbackCount: value.fallbackCount,
    actionCounts,
    recentDecisions,
    artifacts: value.artifacts,
  };
}

function isReplayUiDecision(value: unknown): value is AiLeagueReplayUiDecision {
  if (!isRecord(value) || !isRecord(value.result)) return false;
  return (
    isFiniteNumber(value.sequence) &&
    isFiniteNumber(value.turnNumber) &&
    typeof value.username === "string" &&
    typeof value.profile === "string" &&
    typeof value.brainType === "string" &&
    typeof value.selectedActionKind === "string" &&
    typeof value.selectedLegalActionId === "string" &&
    typeof value.reason === "string" &&
    isFiniteNumber(value.decisionLatencyMs) &&
    typeof value.fallbackUsed === "boolean" &&
    typeof value.result.accepted === "boolean" &&
    typeof value.result.reason === "string"
  );
}

function isArtifactAvailability(
  value: unknown,
): value is AiLeagueReplayArtifactAvailability {
  return (
    isRecord(value) &&
    typeof value.visualReport === "boolean" &&
    typeof value.spectatorTelemetry === "boolean" &&
    typeof value.decisions === "boolean" &&
    typeof value.summary === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
