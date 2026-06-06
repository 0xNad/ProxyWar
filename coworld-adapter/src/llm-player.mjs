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
const MODEL_ID =
  process.env.PROXYWAR_LLM_MODEL_ID ??
  "anthropic.claude-3-5-sonnet-20240620-v1:0";
const REGION =
  process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";
const TIMEOUT_MS = Number(process.env.PROXYWAR_LLM_TIMEOUT_MS ?? 12000);
// Use Bedrock only when the platform provisioned it; otherwise mock so local
// runs and certification never need real AWS credentials.
const USE_BEDROCK =
  process.env.USE_BEDROCK === "true" && process.env.PROXYWAR_LLM_MOCK !== "1";

// The ONLY provider-specific code: an llmComplete (prompt) => text on Bedrock.
function createBedrockComplete() {
  let client = null;
  return async (prompt) => {
    if (!client) {
      const mod = await import("@anthropic-ai/bedrock-sdk");
      const AnthropicBedrock = mod.default ?? mod.AnthropicBedrock;
      client = new AnthropicBedrock({ awsRegion: REGION });
    }
    const response = await client.messages.create(
      {
        model: MODEL_ID,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: TIMEOUT_MS },
    );
    return (response?.content ?? [])
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join("")
      .trim();
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
    llmComplete = envComplete ?? createMockComplete();
    providerLabel = envComplete
      ? process.env.PROXYWAR_AGENT_LLM_PROVIDER || "env-provider"
      : "mock";
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
    try {
      // The full starter brain: prompt, memory, anti-stall, ranking,
      // strict legal-id validation, and safe fallback all live in here.
      decision = await agent.decide(message.request);
    } catch (error) {
      console.error(`decide failed: ${error?.message ?? error}`);
      // Last-resort: never stall the match — pick any offered legal action.
      const actions = message.request?.legalActions ?? [];
      decision = {
        selectedLegalActionId: actions[0]?.id,
        reason: "transport fallback",
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
