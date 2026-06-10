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
  "us.anthropic.claude-sonnet-4-6",
  "global.anthropic.claude-sonnet-4-6",
  "us.anthropic.claude-haiku-4-5",
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
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
const TIMEOUT_MS = Number(process.env.PROXYWAR_LLM_TIMEOUT_MS ?? 12000);
// Use Bedrock only when the platform provisioned it; otherwise mock so local
// runs and certification never need real AWS credentials.
const USE_BEDROCK =
  process.env.USE_BEDROCK === "true" && process.env.PROXYWAR_LLM_MOCK !== "1";

// The ONLY provider-specific code: an llmComplete (prompt) => text on Bedrock,
// with model-id autodetect across MODEL_ID_CANDIDATES (locks onto the first
// id that answers; loud log either way).
function createBedrockComplete() {
  let client = null;
  let lockedIndex = null;
  return async (prompt) => {
    if (!client) {
      const mod = await import("@anthropic-ai/bedrock-sdk");
      const AnthropicBedrock = mod.default ?? mod.AnthropicBedrock;
      client = new AnthropicBedrock({ awsRegion: REGION });
    }
    const startIndex = lockedIndex ?? 0;
    let lastError = null;
    for (let i = startIndex; i < MODEL_ID_CANDIDATES.length; i += 1) {
      const candidate = MODEL_ID_CANDIDATES[i];
      try {
        const response = await client.messages.create(
          {
            model: candidate,
            max_tokens: 512,
            messages: [{ role: "user", content: prompt }],
          },
          { timeout: TIMEOUT_MS },
        );
        if (lockedIndex !== i) {
          lockedIndex = i;
          console.log(`bedrock model locked: ${candidate}`);
        }
        return (response?.content ?? [])
          .map((block) => (typeof block?.text === "string" ? block.text : ""))
          .join("")
          .trim();
      } catch (error) {
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
      `No Bedrock model candidate is usable on this account (tried ${MODEL_ID_CANDIDATES.join(", ")}): ${String(lastError?.message ?? lastError).slice(0, 200)}`,
    );
  };
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

  // Provider precedence: explicit mock > Bedrock (platform creds) > any starter
  // SDK provider configured via env (openrouter/codex/claude/command) > mock.
  let llmComplete;
  let providerLabel;
  if (process.env.PROXYWAR_LLM_MOCK === "1") {
    llmComplete = createMockComplete();
    providerLabel = "mock";
  } else if (USE_BEDROCK) {
    llmComplete = createBedrockComplete();
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
    llmComplete = envComplete;
    providerLabel = process.env.PROXYWAR_AGENT_LLM_PROVIDER || "env-provider";
  }
  const agent = createStarterAgent({ llmComplete, modelName: MODEL_ID });

  const socket = new WebSocket(url);

  socket.on("open", () => {
    console.log(
      `connected ${redactCoworldPlayerUrl(url)} (provider=${providerLabel})`,
    );
  });

  socket.on("message", async (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type === "final") {
      socket.close();
      return;
    }
    if (message.type !== "decision_request") {
      return;
    }

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
      const actions = message.request?.legalActions ?? [];
      decision = {
        selectedLegalActionId: actions[0]?.id,
        reason: `transport fallback: ${String(error?.message ?? error).slice(0, 200)}`,
        confidence: 0.3,
      };
    }

    socket.send(
      JSON.stringify({
        type: "decision_response",
        requestID: message.requestID,
        selectedLegalActionId: decision.selectedLegalActionId,
        reason: decision.reason ?? "starter-agent",
        confidence: decision.confidence ?? 0.7,
        ...(degraded ? { fallbackUsed: true, llmPlannerDegraded: true } : {}),
      }),
    );
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
