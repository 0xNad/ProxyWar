#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDecisionOutput } from "./starter-framework.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFileIfPresent(path.join(__dirname, ".env"));

const endpointUrl =
  process.argv[2] ??
  process.env.OPEN_FRONTIER_AGENT_TEST_ENDPOINT_URL ??
  "http://127.0.0.1:7777/open-frontier/decide";
const timeoutMs = normalizeTimeoutMs(
  process.env.OPEN_FRONTIER_AGENT_TEST_TIMEOUT_MS ?? "30000",
);
const legalActions = [
  {
    id: "health-check:expand",
    kind: "attack",
    label: "Health-check expansion action",
    risk: { level: "low", score: 0.2 },
    metadata: { expansion: true, healthCheck: true },
  },
  {
    id: "health-check:hold",
    kind: "hold",
    label: "Health-check hold action",
    risk: { level: "none", score: 0 },
    metadata: { healthCheck: true },
  },
];

try {
  const result = await testEndpoint(endpointUrl);
  console.log("Open Frontier starter self-test passed.");
  console.log(`Endpoint: ${endpointUrl}`);
  console.log(`selectedLegalActionId: ${result.selectedLegalActionId}`);
  console.log(`reason: ${result.reason}`);
  console.log(
    "Next: expose /agent-card.md and paste that Agent Card URL into Connect With One Link.",
  );
} catch (error) {
  console.error("Open Frontier starter self-test failed.");
  console.error(`Endpoint: ${endpointUrl}`);
  console.error(`Fix: ${fixHint(error)}`);
  console.error(`Details: ${errorMessage(error)}`);
  process.exitCode = 1;
}

async function testEndpoint(url) {
  validateEndpointUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-open-frontier-agent-protocol": "open-frontier-agent-v1",
      },
      body: JSON.stringify(healthCheckPayload()),
      signal: controller.signal,
      redirect: "manual",
    });
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${truncate(raw, 600)}`);
    }
    const normalizedContentType = contentType.toLowerCase();
    if (
      normalizedContentType !== "" &&
      !normalizedContentType.includes("json") &&
      !normalizedContentType.startsWith("text/plain")
    ) {
      throw new Error(
        `content-type is not JSON (${contentType || "missing"}): ${truncate(raw, 300)}`,
      );
    }
    const parsed = validateDecisionOutput(raw, legalActions);
    if (!parsed.ok) {
      throw new Error(parsed.error ?? "invalid decision response");
    }
    return {
      selectedLegalActionId: parsed.action.id,
      reason: parsed.reason,
      confidence: parsed.confidence,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function healthCheckPayload() {
  return {
    protocolVersion: "open-frontier-agent-v1",
    agent: {
      agentID: "starter-self-test",
      username: "Starter Self Test",
      profile: "opportunistic",
    },
    match: {
      gameID: "STARTER-SELF-TEST",
      phase: "active",
      turnNumber: 1,
      tick: 1,
    },
    observation: {
      profile: "opportunistic",
      phase: "active",
      summary:
        "Starter self-test: choose exactly one offered LegalAction.id. This is not a real match.",
      strategic: {
        priority: "expand",
        urgency: "medium",
        summary: "synthetic starter health check",
        recommendedActionKinds: ["attack", "hold"],
        scores: {
          expansion: 0.8,
          economy: 0.3,
          defense: 0.1,
          offense: 0.2,
          diplomacy: 0,
          threat: 0,
          idleTroops: 0.7,
        },
      },
      memory: {
        recentActions: [],
        recentActionCountsByKind: {},
        recentNonHoldCount: 0,
        recentExpansionCount: 0,
        recentBuildCount: 0,
        repeatedActionKind: null,
        repeatedActionCount: 0,
        avoidActionIDs: [],
        summary: "no recent self-test decisions",
      },
      notes: [
        "Return strict JSON only.",
        "Use selectedLegalActionId, not actionId.",
        "Never return raw OpenFront intents.",
      ],
    },
    legalActions,
    responseContract: {
      selectedLegalActionId:
        "must exactly match one offered legalActions[].id",
      reason: "short human-readable string",
      confidence: "optional number from 0 to 1",
    },
  };
}

function validateEndpointUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("endpoint URL is not a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("endpoint URL must start with http:// or https://");
  }
  if (parsed.pathname.endsWith(".md") || parsed.pathname.includes("agent-card")) {
    throw new Error(
      "self-test expects the POST decision endpoint, not /agent-card.md",
    );
  }
  if (parsed.pathname.endsWith("/health")) {
    throw new Error("self-test expects the POST decision endpoint, not /health");
  }
}

function fixHint(error) {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("not /agent-card")) {
    return "Use http://127.0.0.1:7777/open-frontier/decide for self-test. Paste /agent-card.md only into Connect With One Link.";
  }
  if (message.includes("not /health")) {
    return "Use the decision endpoint, usually /open-frontier/decide. /health is only liveness metadata.";
  }
  if (message.includes("unknown json field: actionid")) {
    return "Return selectedLegalActionId, reason, and optional confidence. Do not return actionId.";
  }
  if (message.includes("unknown selectedlegalactionid")) {
    return "Choose exactly one id from the offered legalActions array: health-check:expand or health-check:hold.";
  }
  if (
    message.includes("unknown json field: intent") ||
    message.includes("raw openfront") ||
    message.includes("unknown json field: type")
  ) {
    return "Do not return raw OpenFront intent JSON. Return only selectedLegalActionId, reason, and optional confidence.";
  }
  if (message.includes("content-type")) {
    return "The decision endpoint must return application/json with the strict decision object.";
  }
  if (message.includes("invalid json") || message.includes("json")) {
    return "Return strict JSON only, with no markdown fence, prose wrapper, tool call, or code.";
  }
  if (
    message.includes("llm provider required") ||
    message.includes("open_frontier_agent_llm_provider") ||
    message.includes("openrouter_api_key") ||
    message.includes("open_frontier_agent_llm_command")
  ) {
    return "Configure a backend first: OPEN_FRONTIER_AGENT_LLM_PROVIDER=codex-cli, claude-cowork, command, or openrouter.";
  }
  if (message.includes("timed out") || message.includes("aborted")) {
    return "Make the model command return faster or raise OPEN_FRONTIER_AGENT_TEST_TIMEOUT_MS while developing.";
  }
  if (
    message.includes("econnrefused") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("did not resolve")
  ) {
    return "Start the starter server in another terminal with npm start, then run npm run self-test again.";
  }
  if (message.includes("http 404") || message.includes("not found")) {
    return "Check the endpoint path. The starter decision path is /open-frontier/decide.";
  }
  return "The endpoint must accept POST JSON and return selectedLegalActionId, reason, and optional confidence.";
}

function normalizeTimeoutMs(value) {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 250 || timeout > 180000) {
    throw new Error("OPEN_FRONTIER_AGENT_TEST_TIMEOUT_MS must be 250-180000");
  }
  return timeout;
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.name === "AbortError" ? `timed out after ${timeoutMs}ms` : error.message;
  }
  return String(error);
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
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
