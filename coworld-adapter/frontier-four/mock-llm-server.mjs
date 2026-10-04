/**
 * A stand-in for the Softmax LLM sidecar, for local smoke tests only: it
 * serves the two wire formats the player speaks (`/v1/messages` and
 * `/v1/chat/completions`), answers every plan request with one canned plan,
 * reports usage and spend headers the way the sidecar does, and logs each
 * request so a test can check the model slug and prompt shape. No model is
 * called and nothing is spent.
 *
 *   node mock-llm-server.mjs [port]   (default 9199)
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] || process.env.PORT || 9199);
const plan = {
  focus: "expand",
  preferKinds: ["spawn", "attack", "build", "donate_troops", "hold"],
  target: null,
  avoidTargets: [],
  dealPolicies: {},
  breakDealIDs: [],
  reason: "mock sidecar: expand first",
};
let calls = 0;
let spendUsd = 0;

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

const server = createServer(async (request, response) => {
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
        spend_limit_usd: 2,
        remaining_usd: 2 - spendUsd,
        rate_limited_requests: 0,
        request_limit_per_minute: 30,
        system_one_request_limit_per_minute: 120,
      }),
    );
    return;
  }
  const raw = await readBody(request);
  const body = parseJsonOr(raw, {});
  calls += 1;
  spendUsd += 0.01;
  const anthropic = request.url === "/v1/messages";
  const chat = request.url === "/v1/chat/completions";
  console.log(
    `MOCK_LLM ${JSON.stringify({
      call: calls,
      path: request.url,
      model: body.model,
      maxTokens: body.max_tokens,
      systemChars: anthropic
        ? String(body.system || "").length
        : String(body.messages?.[0]?.content || "").length,
      userChars: anthropic
        ? String(body.messages?.[0]?.content || "").length
        : String(body.messages?.[1]?.content || "").length,
      hasTeamFraming: JSON.stringify(body).includes("TEAM GAME"),
    })}`,
  );
  if (!anthropic && !chat) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unknown path" } }));
    return;
  }
  const text = JSON.stringify(plan);
  const headers = {
    "content-type": "application/json",
    "x-coworld-spend-usd": spendUsd.toFixed(4),
    "x-coworld-spend-limit-usd": "2",
  };
  response.writeHead(200, headers);
  response.end(
    JSON.stringify(
      anthropic
        ? {
            id: `msg_mock_${calls}`,
            model: body.model,
            stop_reason: "end_turn",
            content: [{ type: "text", text }],
            usage: {
              input_tokens: 900,
              output_tokens: 80,
              cache_read_input_tokens: 600,
            },
          }
        : {
            id: `chatcmpl_mock_${calls}`,
            model: body.model,
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: text },
              },
            ],
            usage: {
              prompt_tokens: 900,
              completion_tokens: 80,
              prompt_tokens_details: { cached_tokens: 600 },
            },
          },
    ),
  );
});

server.listen(port, "0.0.0.0", () => {
  console.log(`mock LLM sidecar listening on http://0.0.0.0:${port}`);
});
