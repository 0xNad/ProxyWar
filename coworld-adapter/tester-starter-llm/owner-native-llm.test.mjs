import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createLlmClient } from "./llm-player.mjs";

test("native Messages transport uses the injected endpoint and preserves provider output", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      path: request.url,
      headers: request.headers,
      body: JSON.parse(body),
    });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        content: [{ type: "text", text: "plan" }],
        usage: { input_tokens: 9, output_tokens: 1 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const client = createLlmClient(`http://127.0.0.1:${server.address().port}`);
    const request = {
      model: "anthropic/claude-haiku-4.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "plan" }],
    };
    const result = await client.messages.create(request, {
      signal: AbortSignal.timeout(1000),
    });
    assert.deepEqual(requests[0].body, request);
    assert.equal(requests[0].path, "/v1/messages");
    assert.equal(requests[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(requests[0].headers.authorization, undefined);
    assert.equal(result.content[0].text, "plan");
    assert.equal(result.usage.input_tokens, 9);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("native transport surfaces HTTP failure and honors the planner abort signal", async () => {
  const server = createServer((request, response) => {
    if (request.headers["content-type"] === "application/json") {
      response.writeHead(429);
      response.end("private provider diagnostic");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const client = createLlmClient(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(
      client.messages.create({}, { signal: AbortSignal.timeout(1000) }),
      { message: "Coworld LLM HTTP 429", status: 429 },
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      client.messages.create({}, { signal: controller.signal }),
      { name: "AbortError" },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.throws(() => createLlmClient(""), /COWORLD_LLM_ENDPOINT is required/);
});
