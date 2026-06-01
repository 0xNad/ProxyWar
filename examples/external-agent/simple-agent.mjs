#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentCardMarkdown,
  createHealthResponse,
  createStarterAgent,
  describeLlmProviderFromEnv,
  publicBaseUrlFromRequest,
} from "./starter-framework.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFileIfPresent(path.join(__dirname, ".env"));

const host = process.env.PROXYWAR_AGENT_HOST ?? "127.0.0.1";
const port = Number(process.env.PROXYWAR_AGENT_PORT ?? "7777");
const decisionPath =
  process.env.PROXYWAR_AGENT_ENDPOINT_PATH ?? "/proxywar/decide";
const cardPath = process.env.PROXYWAR_AGENT_CARD_PATH ?? "/agent-card.md";
const endpointToken = (process.env.PROXYWAR_AGENT_ENDPOINT_TOKEN ?? "").trim();
const llmProvider = describeLlmProviderFromEnv();
let agent;
try {
  agent = createStarterAgent();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

http
  .createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      const publicBaseUrl =
        process.env.PROXYWAR_AGENT_PUBLIC_URL ??
        publicBaseUrlFromRequest(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          createHealthResponse({
            publicBaseUrl,
            decisionPath,
            cardPath,
            endpointTokenRequired: endpointToken !== "",
            agentName:
              process.env.PROXYWAR_AGENT_NAME ?? "Frontier SDK Agent",
          }),
        ),
      );
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/") {
      const publicBaseUrl =
        process.env.PROXYWAR_AGENT_PUBLIC_URL ??
        publicBaseUrlFromRequest(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...createHealthResponse({
            publicBaseUrl,
            decisionPath,
            cardPath,
            endpointTokenRequired: endpointToken !== "",
            agentName:
              process.env.PROXYWAR_AGENT_NAME ?? "Frontier SDK Agent",
          }),
          message: "Paste agentCardUrl into ProxyWar Connect With One Link.",
        }),
      );
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === cardPath) {
      const publicBaseUrl =
        process.env.PROXYWAR_AGENT_PUBLIC_URL ??
        publicBaseUrlFromRequest(request);
      response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      response.end(
        createAgentCardMarkdown({
          publicBaseUrl,
          endpointPath: decisionPath,
        }),
      );
      return;
    }

    if (request.method !== "POST" || requestUrl.pathname !== decisionPath) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (!isAuthorized(request, endpointToken)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: "missing or invalid bearer token",
          fix: "Paste the same beta-only token into ProxyWar's endpoint token field. Do not put it in the Agent Card.",
        }),
      );
      return;
    }

    try {
      const body = await readJson(request);
      const decision = await agent.decide(body);
      if (decision === null) {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "no legal actions offered" }));
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(decision));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "invalid request",
        }),
      );
    }
  })
  .listen(port, host, () => {
    console.log(
      `ProxyWar LLM starter agent listening at http://${host}:${port}${decisionPath}`,
    );
    console.log(`Agent Card: http://${host}:${port}${cardPath}`);
    console.log(`LLM brain: ${llmProvider.label}`);
  });

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 128 * 1024) {
      throw new Error("request too large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function loadEnvFileIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    const rawValue = trimmed.slice(equals + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isAuthorized(request, requiredToken) {
  if (requiredToken === "") return true;
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return false;
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (match === null) return false;
  return timingSafeTextEqual(match[1].trim(), requiredToken);
}

function timingSafeTextEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
