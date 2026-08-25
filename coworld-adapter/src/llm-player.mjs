// Proxy War Coworld LLM policy (competitive).
//
// Thin Coworld transport around the EXISTING Proxy War starter agent. It does
// not reimplement decision logic: it reuses createStarterAgent() from the
// starter SDK (starter-framework.mjs), which already provides the prompt
// (buildLlmPrompt), strict legal-id validation (validateDecisionOutput),
// cross-decision memory, anti-stall guidance, action ranking, and a safe
// fallback. The only policy-specific code here is:
//   1. websocket transport (Coworld /player) instead of HTTP/relay, and
//   2. a Bedrock-backed llmComplete provider (the SDK supports
//      codex-cli/claude/command/openrouter but not Bedrock yet).
//
// Safety is unchanged: the agent can only return one offered LegalAction.id
// (the SDK validator enforces it), and the game re-validates through Proxy
// War's AgentDecisionValidator. No raw intents, no second validator.
//
// Bedrock creds are provided by the platform (USE_BEDROCK + AWS_* via the
// default chain): hosted `upload-policy --use-bedrock` runs the pod under the
// Bedrock service account; local `--use-bedrock` passes host creds. None are
// baked into the image or manifest.
//
// Env (all optional): PROXYWAR_LLM_MODEL_ID, AWS_REGION,
//   PROXYWAR_LLM_TIMEOUT_MS, PROXYWAR_LLM_MOCK=1 (local plumbing test).

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { redactCoworldPlayerUrl } from "./coworld-url.mjs";

const proxyWarRepo = process.env.PROXYWAR_REPO ?? "/app/proxywar";
// Bedrock model-id CANDIDATES, tried in order until one answers. The previous
// single pin (anthropic.claude-3-5-sonnet-20240620-v1:0) reached end-of-life
// on Bedrock and the seat silently failed every call for 60+ hosted rounds —
// autodetect makes a retired/disabled id self-healing instead of fatal.
// PROXYWAR_LLM_MODEL_ID (when set) is always tried first. The list covers the
// current prefix format, a cheap fallback, and legacy ARN/inference-profile
// formats in case the service account predates the new ids.
const MODEL_ID_CANDIDATES = [
  ...(process.env.PROXYWAR_LLM_MODEL_ID
    ? [process.env.PROXYWAR_LLM_MODEL_ID]
    : []),
  // Confirmed enabled on the Softmax Bedrock account 2026-06-23 (us-east-1, us-west-2,
  // us-east-2). Haiku MUST be the full date-suffixed inference-profile id — the bare
  // "us.anthropic.claude-haiku-4-5" is not a valid inference-profile id and fails validation;
  // sonnet-4-5 is the bare model id (us-west-2), not a us.-prefixed profile.
  "us.anthropic.claude-sonnet-4-6",
  "global.anthropic.claude-sonnet-4-6",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
];
const MODEL_ID = MODEL_ID_CANDIDATES[0];

// True when the error means "this model id is unusable on this account" —
// retired, unknown, disabled, or needs an inference profile. Anything else
// (auth, throttle, timeout) is NOT a reason to switch models.
export function isModelUnavailableError(message) {
  const text = String(message ?? "").toLowerCase();
  return (
    text.includes("end of its life") ||
    text.includes("model identifier is invalid") ||
    text.includes("provided model identifier") ||
    text.includes("on-demand throughput") ||
    text.includes("not found") ||
    text.includes("not_found") ||
    text.includes("access to the model") ||
    text.includes("not authorized to invoke this model") ||
    text.includes("model is not supported") ||
    text.includes("use case details")
  );
}
const REGION =
  process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";
export function boundedLlmTimeoutMs(value) {
  const parsed = Number(value ?? 12_000);
  if (!Number.isSafeInteger(parsed)) return 12_000;
  return Math.min(12_000, Math.max(250, parsed));
}
const TIMEOUT_MS = boundedLlmTimeoutMs(process.env.PROXYWAR_LLM_TIMEOUT_MS);
// Use Bedrock only when the platform provisioned it; otherwise mock so local
// runs and certification never need real AWS credentials.
const USE_BEDROCK =
  process.env.USE_BEDROCK === "true" && process.env.PROXYWAR_LLM_MOCK !== "1";

function boundedProviderEvidenceLabel(value, maxLength) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9._:/-]+$/.test(value)
    ? value
    : undefined;
}

function boundedProviderTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000
    ? value
    : undefined;
}

export function isProviderTimeoutError(error) {
  const name = String(error?.name ?? "").toUpperCase();
  const code = String(error?.code ?? "").toUpperCase();
  const message = String(error?.message ?? error);
  return (
    name === "ABORTERROR" ||
    name === "TIMEOUTERROR" ||
    code === "ABORT_ERR" ||
    code === "ETIMEDOUT" ||
    /timed?\s*out|timeout/i.test(message)
  );
}

export function strictBedrockSidecarEndpoint(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length === 0) return undefined;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("bedrock-sidecar-endpoint-invalid");
  }
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
    parsed.port.length === 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error("bedrock-sidecar-endpoint-invalid");
  }
  return parsed.origin;
}

/** One decision-scoped aggregate; a no-call decision remains absent. */
export function createActionProviderEvidenceRecorder() {
  let group;
  let decisionSequence = 0;
  const totals = {
    decisionsWithProviderCalls: 0,
    attemptCount: 0,
    completedAttemptCount: 0,
    failedAttemptCount: 0,
    timedOutAttemptCount: 0,
  };
  return {
    beginDecision() {
      group = undefined;
      decisionSequence += 1;
    },
    decisionID() {
      return decisionSequence;
    },
    start(descriptor) {
      const provider = boundedProviderEvidenceLabel(descriptor?.provider, 64);
      const requestedModel = boundedProviderEvidenceLabel(
        descriptor?.requestedModel,
        160,
      );
      if (group === undefined) {
        group = {
          provider: provider ?? "invalid-attribution",
          requestedModel: requestedModel ?? "invalid-attribution",
          attemptedModels: [],
          attemptCount: 0,
          completedAttemptCount: 0,
          failedAttemptCount: 0,
          timedOutAttemptCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          inputTokensObserved: false,
          outputTokensObserved: false,
          rawOutputPresent: false,
          invalidAttribution:
            provider === undefined || requestedModel === undefined,
        };
      }
      if (group.attemptCount >= 8) {
        group.attemptOverflow = true;
        return null;
      }
      group.attemptCount += 1;
      group.attemptedModels.push(requestedModel ?? "invalid-attribution");
      return group.attemptCount - 1;
    },
    complete(attempt, value = {}) {
      if (group === undefined || attempt === null) return;
      group.completedAttemptCount += 1;
      const responseModel = boundedProviderEvidenceLabel(
        value.responseModel,
        160,
      );
      const requestID = boundedProviderEvidenceLabel(value.requestID, 160);
      if (responseModel !== undefined) group.responseModel = responseModel;
      if (group.attemptCount === 1 && requestID !== undefined) {
        group.requestID = requestID;
      } else if (group.attemptCount > 1) {
        delete group.requestID;
      }
      const inputTokens = boundedProviderTokenCount(value.inputTokens);
      const outputTokens = boundedProviderTokenCount(value.outputTokens);
      if (
        Number.isSafeInteger(value.inputTokens) &&
        value.inputTokens > 1_000_000_000
      ) {
        group.inputTokensOverflow = true;
        group.inputTokensObserved = false;
      } else if (inputTokens !== undefined && !group.inputTokensOverflow) {
        if (group.inputTokens + inputTokens <= 1_000_000_000) {
          group.inputTokens += inputTokens;
          group.inputTokensObserved = true;
        } else {
          group.inputTokensOverflow = true;
          group.inputTokensObserved = false;
        }
      }
      if (
        Number.isSafeInteger(value.outputTokens) &&
        value.outputTokens > 1_000_000_000
      ) {
        group.outputTokensOverflow = true;
        group.outputTokensObserved = false;
      } else if (outputTokens !== undefined && !group.outputTokensOverflow) {
        if (group.outputTokens + outputTokens <= 1_000_000_000) {
          group.outputTokens += outputTokens;
          group.outputTokensObserved = true;
        } else {
          group.outputTokensOverflow = true;
          group.outputTokensObserved = false;
        }
      }
      group.rawOutputPresent ||= value.rawOutputPresent === true;
    },
    fail(attempt, error) {
      if (group === undefined || attempt === null) return;
      if (isProviderTimeoutError(error)) {
        group.timedOutAttemptCount += 1;
      } else {
        group.failedAttemptCount += 1;
      }
    },
    take() {
      if (group === undefined || group.attemptCount === 0) return undefined;
      const result = {
        callKind: "action",
        provider: group.provider,
        requestedModel: group.requestedModel,
        attemptedModels: group.attemptedModels,
        attemptCount: group.attemptCount,
        completedAttemptCount: group.completedAttemptCount,
        failedAttemptCount: group.failedAttemptCount,
        timedOutAttemptCount: group.timedOutAttemptCount,
        ...(group.responseModel !== undefined
          ? { responseModel: group.responseModel }
          : {}),
        ...(group.requestID !== undefined
          ? { requestID: group.requestID }
          : {}),
        ...(group.inputTokensObserved
          ? { inputTokens: group.inputTokens }
          : {}),
        ...(group.outputTokensObserved
          ? { outputTokens: group.outputTokens }
          : {}),
        rawOutputPresent: group.rawOutputPresent,
        // Preserve a bounded explicit invalid shape: an actual provider call
        // with bad attribution must not disappear as a clean no-call frame.
        ...(group.invalidAttribution ? { invalidAttribution: true } : {}),
        ...(group.attemptOverflow ? { attemptOverflow: true } : {}),
      };
      totals.decisionsWithProviderCalls += 1;
      totals.attemptCount += group.attemptCount;
      totals.completedAttemptCount += group.completedAttemptCount;
      totals.failedAttemptCount += group.failedAttemptCount;
      totals.timedOutAttemptCount += group.timedOutAttemptCount;
      group = undefined;
      return result;
    },
    summary(reason) {
      return {
        schemaVersion: 1,
        event: "summary",
        reason,
        ...totals,
        inFlightRequests: 0,
      };
    },
  };
}

/** Track an actual direct completion attempt without changing its text API. */
export function trackActionComplete(complete, descriptor, recorder) {
  return async (prompt) => {
    const attempt = recorder.start(descriptor);
    if (attempt === null) {
      throw new Error("provider attempt cap reached before invocation");
    }
    try {
      const output = await complete(prompt);
      recorder.complete(attempt, {
        rawOutputPresent: String(output ?? "").length > 0,
      });
      return output;
    } catch (error) {
      recorder.fail(attempt, error);
      throw error;
    }
  };
}

/** Exact hosted-sidecar routing options, kept pure for release verification. */
export function bedrockClientOptions(region = REGION, env = process.env) {
  const sidecarEndpoint = strictBedrockSidecarEndpoint(
    env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME,
  );
  return sidecarEndpoint
    ? { awsRegion: region, baseURL: sidecarEndpoint }
    : { awsRegion: region };
}

function providerDeadlineError(timeoutMs) {
  const error = new Error(`provider timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  error.code = "ETIMEDOUT";
  return error;
}

async function invokeBedrockAttempt(client, request, remainingMs) {
  const controller = new AbortController();
  const timeoutError = providerDeadlineError(remainingMs);
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, remainingMs);
  });
  let invocation;
  try {
    invocation = client.messages.create(request, {
      timeout: remainingMs,
      maxRetries: 0,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutHandle);
    throw error;
  }
  return Promise.race([invocation, timeout]).finally(() =>
    clearTimeout(timeoutHandle),
  );
}

// The ONLY provider-specific code: an llmComplete (prompt) => text on Bedrock,
// with model-id autodetect across MODEL_ID_CANDIDATES (locks onto the first
// id that answers; loud log either way).
export function createBedrockCompleteForClient(
  client,
  recorder,
  {
    modelCandidates = MODEL_ID_CANDIDATES,
    timeoutMs = TIMEOUT_MS,
    provider = strictBedrockSidecarEndpoint(
      process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME,
    )
      ? "bedrock-sidecar"
      : "aws-bedrock",
  } = {},
) {
  let lockedIndex = null;
  let deadlineDecisionID;
  let deadlineAt = 0;
  return async (prompt) => {
    const boundedTimeoutMs = boundedLlmTimeoutMs(timeoutMs);
    const decisionID =
      typeof recorder.decisionID === "function"
        ? recorder.decisionID()
        : undefined;
    if (deadlineAt === 0 || decisionID !== deadlineDecisionID) {
      deadlineDecisionID = decisionID;
      deadlineAt = Date.now() + boundedTimeoutMs;
    }
    const startIndex = lockedIndex ?? 0;
    let lastError = null;
    for (let i = startIndex; i < modelCandidates.length; i += 1) {
      const candidate = modelCandidates[i];
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        lastError = providerDeadlineError(boundedTimeoutMs);
        break;
      }
      const attempt = recorder.start({
        provider,
        requestedModel: candidate,
      });
      if (attempt === null) break;
      try {
        const response = await invokeBedrockAttempt(
          client,
          {
            model: candidate,
            max_tokens: 512,
            messages: [{ role: "user", content: prompt }],
          },
          remainingMs,
        );
        if (lockedIndex !== i) {
          lockedIndex = i;
          console.log(`bedrock model locked: ${candidate}`);
        }
        const output = (response?.content ?? [])
          .map((block) => (typeof block?.text === "string" ? block.text : ""))
          .join("")
          .trim();
        recorder.complete(attempt, {
          responseModel: response?.model,
          requestID: response?.id,
          inputTokens:
            response?.usage?.input_tokens ?? response?.usage?.inputTokens,
          outputTokens:
            response?.usage?.output_tokens ?? response?.usage?.outputTokens,
          rawOutputPresent: output.length > 0,
        });
        return output;
      } catch (error) {
        recorder.fail(attempt, error);
        lastError = error;
        if (isModelUnavailableError(error?.message)) {
          console.error(
            `bedrock model unavailable, trying next candidate: ${candidate} -> ${String(error?.message).slice(0, 160)}`,
          );
          continue;
        }
        throw error;
      }
    }
    throw new Error(
      `No Bedrock model candidate is usable on this account (tried ${modelCandidates.join(", ")}): ${String(lastError?.message ?? lastError).slice(0, 200)}`,
    );
  };
}

function createBedrockComplete(recorder) {
  let complete = null;
  return async (prompt) => {
    if (!complete) {
      const mod = await import("@anthropic-ai/bedrock-sdk");
      const AnthropicBedrock = mod.default ?? mod.AnthropicBedrock;
      // Hosted pods proxy Bedrock through a credential-free loopback sidecar.
      // Builders copy this file as their starter, so the strict endpoint and
      // aggregate deadline belong here rather than in platform-only wrapping.
      const client = new AnthropicBedrock(bedrockClientOptions());
      complete = createBedrockCompleteForClient(client, recorder);
    }
    return complete(prompt);
  };
}

function envProviderEvidenceDescriptor() {
  const configured = String(
    process.env.PROXYWAR_AGENT_LLM_PROVIDER ??
      (process.env.OPENROUTER_API_KEY ? "openrouter" : "command"),
  )
    .trim()
    .toLowerCase();
  const provider =
    configured === "" || configured === "command"
      ? "local-command"
      : configured.replaceAll("_", "-");
  const requestedModel =
    process.env.OPENROUTER_MODEL ??
    process.env.PROXYWAR_AGENT_LLM_MODEL ??
    (provider === "openrouter"
      ? "google/gemini-2.5-flash-lite"
      : "provider-default");
  return { provider, requestedModel };
}

// Local-only mock provider: returns the strict JSON the SDK validator expects,
// naming the first legal id found in the SDK-built prompt. Lets the full
// decide() path (prompt + validation + memory + fallback) run without Bedrock.
function createMockComplete() {
  return async (prompt) => {
    const match = String(prompt).match(/"id"\s*:\s*"([^"]+)"/);
    if (!match) return "{}";
    return JSON.stringify({
      selectedLegalActionId: match[1],
      reason: "mock provider",
      confidence: 0.6,
    });
  };
}

function spawnPreferenceRanking(message, actions) {
  const advertised = message?.protocol?.maxSpawnPreferences;
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    !actions.every((action) => action?.kind === "spawn") ||
    typeof advertised !== "number" ||
    !Number.isFinite(advertised) ||
    advertised < 1
  ) {
    return null;
  }
  const limit = Math.min(16, Math.floor(advertised));
  return actions
    .map((action, index) => ({
      action,
      index,
      score: spawnPreferenceScore(action),
      tile:
        typeof action?.metadata?.tile === "number" &&
        Number.isFinite(action.metadata.tile)
          ? action.metadata.tile
          : Number.POSITIVE_INFINITY,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.tile - right.tile ||
        String(left.action.id).localeCompare(String(right.action.id)) ||
        left.index - right.index,
    )
    .slice(0, limit)
    .map(({ action }) => action);
}

function spawnPreferenceScore(action) {
  const score = (key) => {
    const value = action?.metadata?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const opportunity = score("opportunityScore");
  const pressure = score("pressureScore");
  const safety = score("safetyScore");
  const diplomacy = score("diplomacyScore");
  const localLand = score("localLandScore");
  const middleSafetyBand = Math.max(0, 1 - Math.abs(safety - 0.32) / 0.24);
  const lowSafetyPenalty =
    safety < 0.18
      ? (0.18 - safety) * 2.4 + 0.16
      : safety < 0.23
        ? (0.23 - safety) * 1.1
        : 0;
  return (
    opportunity * 0.32 +
    pressure * 0.18 +
    middleSafetyBand * 0.03 +
    localLand * 0.5 +
    safety * 0.25 +
    diplomacy * 0.28 -
    lowSafetyPenalty
  );
}

export async function decisionResponseForLlmRequest({
  message,
  agent,
  providerEvidenceRecorder,
}) {
  const actions = message.request?.legalActions ?? [];
  const spawnPreferences = spawnPreferenceRanking(message, actions);
  if (spawnPreferences !== null) {
    // Spawn allocation is a sealed preference round, not strategic play:
    // bypass the starter SDK so it creates no provider call or ordinary
    // decision-history entry for this request.
    return {
      type: "decision_response",
      requestID: message.requestID,
      selectedLegalActionId: spawnPreferences[0].id,
      runtimeMode: "llm-action-selector",
      spawnPreferenceLegalActionIds: spawnPreferences.map(
        (preference) => preference.id,
      ),
      reason: `starter ranked ${spawnPreferences.length} offered spawn actions from metadata`,
      confidence: 0.7,
    };
  }

  providerEvidenceRecorder.beginDecision();
  let decision;
  let degraded = false;
  try {
    // The full starter brain: prompt, memory, anti-stall, ranking,
    // strict legal-id validation, and safe fallback all live in here.
    decision = await agent.decide(message.request);
  } catch (error) {
    console.error(`decide failed: ${error?.message ?? error}`);
    // Last-resort: never stall the match — pick any offered legal action.
    // This is a DEGRADED decision and must be loud: the flags below travel
    // on the wire so game-side artifacts record it (the v1 seat played 60+
    // hosted rounds in this branch while replays reported 0 fallbacks).
    degraded = true;
    decision = {
      selectedLegalActionId: actions[0]?.id,
      reason: `transport fallback: ${String(error?.message ?? error).slice(0, 200)}`,
      confidence: 0.3,
    };
  }
  const providerEvidence = providerEvidenceRecorder.take();
  return {
    type: "decision_response",
    requestID: message.requestID,
    selectedLegalActionId: decision.selectedLegalActionId,
    runtimeMode: "llm-action-selector",
    reason: decision.reason ?? "starter-agent",
    confidence: decision.confidence ?? 0.7,
    ...(degraded ? { fallbackUsed: true, llmPlannerDegraded: true } : {}),
    ...(providerEvidence ? { providerEvidence } : {}),
  };
}

/**
 * Attach the direct selector transport to one socket. WebSocket/EventEmitter
 * does not await async listeners, so an explicit promise tail is the ownership
 * boundary for the agent memory and the decision-scoped provider recorder.
 */
export function attachDirectLlmSocketHandlers({
  socket,
  agent,
  providerEvidenceRecorder,
}) {
  let acceptingDecisions = true;
  let finalReceived = false;
  let decisionTail = Promise.resolve();

  const sendAcceptedDecision = async (message) => {
    let response;
    try {
      response = await decisionResponseForLlmRequest({
        message,
        agent,
        providerEvidenceRecorder,
      });
    } catch (error) {
      // An accepted request must have a terminal response even if an
      // unexpected transport-layer exception escapes the starter SDK.
      console.error(
        `serialized decide failed for ${String(message.requestID)}: ${error?.message ?? error}`,
      );
      const fallbackID = message.request?.legalActions?.find(
        (action) => typeof action?.id === "string",
      )?.id;
      const providerEvidence = providerEvidenceRecorder.take();
      response = {
        type: "decision_response",
        requestID: message.requestID,
        selectedLegalActionId: fallbackID,
        runtimeMode: "llm-action-selector",
        reason: `serialized transport fallback: ${String(error?.message ?? error).slice(0, 160)}`,
        confidence: 0.3,
        fallbackUsed: true,
        llmPlannerDegraded: true,
        ...(providerEvidence ? { providerEvidence } : {}),
      };
    }
    socket.send(JSON.stringify(response));
  };

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type === "final") {
      if (finalReceived) return;
      finalReceived = true;
      acceptingDecisions = false;
      decisionTail = decisionTail
        .then(() => {
          try {
            if (typeof providerEvidenceRecorder.summary === "function") {
              console.log(
                `PROXYWAR_LLM_ACTION_USAGE ${JSON.stringify(
                  providerEvidenceRecorder.summary("final_message"),
                )}`,
              );
            }
          } finally {
            socket.close();
          }
        })
        .catch((error) => {
          console.error(`finalization failed: ${error?.message ?? error}`);
          socket.close();
        });
      return;
    }
    if (message.type !== "decision_request" || !acceptingDecisions) return;

    // Promise callbacks run immediately after this synchronous message turn,
    // preserving ordinary single-request latency while ordering overlaps.
    decisionTail = decisionTail
      .then(() => sendAcceptedDecision(message))
      .catch((error) => {
        console.error(
          `serialized response failed for ${String(message.requestID)}: ${error?.message ?? error}`,
        );
      });
  });

  return { settled: () => decisionTail };
}

async function main() {
  const require = createRequire(import.meta.url);
  const { WebSocket } = require(`${proxyWarRepo}/node_modules/ws`);
  const { createStarterAgent, createLlmCompleteFromEnv } = await import(
    `${proxyWarRepo}/examples/external-agent/starter-framework.mjs`
  );

  const url = process.env.COWORLD_PLAYER_WS_URL;
  if (!url) {
    throw new Error("COWORLD_PLAYER_WS_URL is required");
  }

  const providerEvidenceRecorder = createActionProviderEvidenceRecorder();
  // Provider precedence: explicit mock > Bedrock (platform creds) > any starter
  // SDK provider configured via env (openrouter/codex/claude/command) > mock.
  let llmComplete;
  let providerLabel;
  if (process.env.PROXYWAR_LLM_MOCK === "1") {
    // The explicit local mock is deterministic plumbing, not a model call.
    llmComplete = createMockComplete();
    providerLabel = "mock";
  } else if (USE_BEDROCK) {
    llmComplete = createBedrockComplete(providerEvidenceRecorder);
    providerLabel = `bedrock:${MODEL_ID}@${REGION}`;
  } else {
    const envComplete = createLlmCompleteFromEnv();
    if (envComplete === null) {
      // Fail loud, never silently mock: a seat without a working LLM provider
      // is not an agent (operator rule 2026-06-10 — the hosted bedrock seat
      // spent 60+ rounds on silent fallbacks before this was enforced).
      throw new Error(
        "No LLM provider configured. Set USE_BEDROCK=true (hosted), a starter-SDK " +
          "provider env (PROXYWAR_AGENT_LLM_PROVIDER/PROXYWAR_AGENT_LLM_COMMAND/" +
          "OPENROUTER_API_KEY), or PROXYWAR_LLM_MOCK=1 for explicit plumbing tests.",
      );
    }
    llmComplete = trackActionComplete(
      envComplete,
      envProviderEvidenceDescriptor(),
      providerEvidenceRecorder,
    );
    providerLabel = process.env.PROXYWAR_AGENT_LLM_PROVIDER || "env-provider";
  }
  const agent = createStarterAgent({ llmComplete, modelName: MODEL_ID });

  const socket = new WebSocket(url);

  socket.on("open", () => {
    console.log(
      `connected ${redactCoworldPlayerUrl(url)} (provider=${providerLabel})`,
    );
  });

  attachDirectLlmSocketHandlers({
    socket,
    agent,
    providerEvidenceRecorder,
  });

  socket.on("close", () => process.exit(0));
  socket.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
