/**
 * A stand-in for the Softmax LLM sidecar, for local runs and tests only. It
 * serves the sidecar's wire formats (`/v1/chat/completions`, plus
 * `/v1/messages` for older players), reads the rival names out of the
 * player's GAME block, and answers with VARIED v2 plans so a local game
 * exercises every executor path: targets by real rival names, build orders
 * that include MissileSilo and SAMLauncher, private `say` lines (now and then
 * one the player must drop), a public dispatch, and sometimes a betrayal or a
 * nuke. Each reply waits a little, like a model would. It reports usage and
 * spend headers the way the sidecar does and logs each request's shape (never
 * its prompt) as one `MOCK_LLM` line. No model is called and nothing is
 * spent.
 *
 *   node mock-llm-server.mjs [port]   (default 9199)
 *
 * Env: MOCK_LLM_LATENCY_MS="min-max" (default 150-600);
 * MOCK_LLM_REJECT_REASONING=<slug prefix> answers 400 routing_parameters to
 * any request for a matching model that carries `reasoning`.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const FOCI = ["expand", "economy", "attack", "defend", "ally"];
const BUILD_ORDERS = [
  ["City", "Port", "City", "Factory"],
  ["MissileSilo", "City", "SAMLauncher", "Port"],
  ["DefensePost", "City", "Port"],
  ["Factory", "City", "MissileSilo", "Warship"],
  ["City", "SAMLauncher", "City", "Port"],
];
const SAY_LINES = [
  (to, me) =>
    `${to}, ${me} has no quarrel with you. Keep your armies off my border and I keep mine off yours.`,
  (to) =>
    `${to}, the leader is getting too big. Strike them with me and we split what falls.`,
  (to) => `${to}, I saw what you did on our border. Do it again and I answer.`,
  (to) =>
    `${to}, an alliance would free both of us to grow. Say yes and I will ask too.`,
];
const DISPATCHES = [
  (me, target) =>
    target
      ? `${me} marches on ${target}. The border moves today.`
      : `${me} spreads across the open land while the others argue.`,
  (me) => `${me} builds. Cities first, then the rest of the map.`,
  (me, target) =>
    target
      ? `${me} has had enough of ${target}.`
      : `${me} watches, waits and counts the gold.`,
];

function parseJsonOr(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => resolve(raw));
  });
}

function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** The player's GAME block from either wire format, or null. */
function gameState(body, anthropic) {
  const user = anthropic
    ? body.messages?.[0]?.content
    : body.messages?.find?.((m) => m.role === "user")?.content;
  const text = String(user || "");
  const at = text.indexOf("GAME:");
  return at < 0 ? null : parseJsonOr(text.slice(at + 5).trim(), null);
}

/**
 * A v2 plan that varies with the call number and the model slug, built from
 * the rivals the player actually showed.
 */
export function mockPlan(state, call, model) {
  const seed = hash(model) + call;
  const rivals = [...(state?.rivals || []), ...(state?.otherRivals || [])]
    .map((r) => r?.name)
    .filter(Boolean);
  const allies = (state?.rivals || [])
    .filter((r) => r?.isAllied)
    .map((r) => r.name);
  const me = state?.self?.name || "We";
  const pick = (list, offset = 0) =>
    list.length ? list[(seed + offset) % list.length] : null;
  const focus = FOCI[seed % FOCI.length];
  const target = focus === "ally" ? null : pick(rivals);
  const friend = pick(
    rivals.filter((name) => name !== target),
    1,
  );
  const checkpoint = Number(state?.clock?.checkpoint) || call;
  const say = [];
  if (friend)
    say.push({
      to: friend,
      text: SAY_LINES[seed % SAY_LINES.length](friend, me),
    });
  if (target && seed % 2 === 0)
    say.push({
      to: target,
      text: SAY_LINES[(seed + 2) % SAY_LINES.length](target, me),
    });
  // Now and then a line the player must drop: no such rival, or too long.
  if (seed % 5 === 0) say.push({ to: "Nobody At All", text: "Hello?" });
  if (seed % 7 === 0 && friend) say.push({ to: friend, text: "x".repeat(300) });
  return {
    focus,
    target,
    avoidTargets: friend && focus === "ally" ? [friend] : [],
    build: BUILD_ORDERS[seed % BUILD_ORDERS.length],
    allies: friend ? [friend] : [],
    betray: allies.length && seed % 3 === 0 ? allies[0] : null,
    nuke: checkpoint >= 3 && seed % 2 === 0 ? target : null,
    dealPolicies: {},
    breakDealIDs: [],
    say: say.slice(0, 3),
    dispatch: DISPATCHES[seed % DISPATCHES.length](me, target),
    reason: `mock plan ${call}: ${focus}`,
  };
}

function latencyRange() {
  const [min, max] = String(process.env.MOCK_LLM_LATENCY_MS || "150-600")
    .split("-")
    .map(Number);
  const low = Number.isFinite(min) && min >= 0 ? min : 150;
  const high = Number.isFinite(max) && max >= low ? max : low;
  return [low, high];
}

export function createMockLlmServer({
  log = (line) => console.log(line),
  latencyMs = latencyRange(),
  rejectReasoningPrefix = process.env.MOCK_LLM_REJECT_REASONING || "",
} = {}) {
  let calls = 0;
  let spendUsd = 0;
  // Plans vary with each model's own call count: the seats call in step,
  // so a global count would give every model the same plan every time.
  const callsByModel = new Map();
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz/core-v1") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }
    if (request.method === "GET" && request.url === "/spend") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          spend_usd: spendUsd,
          spend_by_slot: { 0: spendUsd },
          spend_limit_usd: 8,
          remaining_usd: 8 - spendUsd,
          rate_limited_requests: 0,
          request_limit_per_minute: 30,
          system_one_request_limit_per_minute: 120,
        }),
      );
      return;
    }
    const raw = await readBody(request);
    const body = parseJsonOr(raw, {});
    const anthropic = request.url === "/v1/messages";
    const chat = request.url === "/v1/chat/completions";
    calls += 1;
    const call = calls;
    log(
      `MOCK_LLM ${JSON.stringify({
        call,
        path: request.url,
        model: body.model,
        keys: Object.keys(body).sort(),
        maxTokens: body.max_tokens,
        reasoning: body.reasoning ?? null,
        roles: Array.isArray(body.messages)
          ? body.messages.map((m) => m.role)
          : [],
      })}`,
    );
    if (!anthropic && !chat) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unknown path" } }));
      return;
    }
    if (
      rejectReasoningPrefix &&
      body.reasoning &&
      String(body.model || "").startsWith(rejectReasoningPrefix)
    ) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "routing_parameters",
            message: "No provider supports this model with reasoning.",
          },
          softmax_error: { category: "routing_parameters", retryable: false },
        }),
      );
      return;
    }
    const [low, high] = latencyMs;
    const wait = low + (hash(`${body.model}:${call}`) % (high - low + 1));
    await new Promise((resolve) => setTimeout(resolve, wait));
    spendUsd += 0.01;
    const modelCall = (callsByModel.get(body.model) || 0) + 1;
    callsByModel.set(body.model, modelCall);
    const text = JSON.stringify(
      mockPlan(gameState(body, anthropic), modelCall, body.model),
    );
    const promptChars = JSON.stringify(body.messages || "").length;
    const inputTokens = Math.round(promptChars / 4);
    response.writeHead(200, {
      "content-type": "application/json",
      "x-coworld-spend-usd": spendUsd.toFixed(4),
      "x-coworld-spend-limit-usd": "8",
    });
    response.end(
      JSON.stringify(
        anthropic
          ? {
              id: `msg_mock_${call}`,
              model: body.model,
              stop_reason: "end_turn",
              content: [{ type: "text", text }],
              usage: {
                input_tokens: inputTokens,
                output_tokens: Math.round(text.length / 4),
                cache_read_input_tokens: 0,
              },
            }
          : {
              id: `chatcmpl_mock_${call}`,
              model: body.model,
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant", content: text },
                },
              ],
              usage: {
                prompt_tokens: inputTokens,
                completion_tokens: Math.round(text.length / 4) + 120,
                completion_tokens_details: { reasoning_tokens: 120 },
                prompt_tokens_details: {
                  cached_tokens: Math.round(inputTokens / 3),
                },
              },
            },
      ),
    );
  });
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  const port = Number(process.argv[2] || process.env.PORT || 9199);
  createMockLlmServer().listen(port, "0.0.0.0", () => {
    console.log(`mock LLM sidecar listening on http://0.0.0.0:${port}`);
  });
}
