#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStarterAgent, validateDecisionOutput } from "./starter-framework.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFileIfPresent(path.join(__dirname, ".env"));

const args = new Set(process.argv.slice(2));

if (args.has("--self-test")) {
  await runSelfTest();
  process.exit(0);
}

const betaUrl = normalizeBaseUrl(
  process.env.PROXYWAR_BETA_URL ?? "https://beta.proxywar.xyz",
);
const sessionID = requiredEnv("PROXYWAR_AGENT_RELAY_SESSION_ID");
const sessionToken = requiredEnv("PROXYWAR_AGENT_RELAY_TOKEN");
const pollWaitMs = normalizeInt(
  process.env.PROXYWAR_AGENT_RELAY_POLL_WAIT_MS ?? "25000",
  0,
  30000,
);
const pollUrl =
  process.env.PROXYWAR_AGENT_RELAY_POLL_URL ??
  `${betaUrl}/api/agent-relay/sessions/${encodeURIComponent(sessionID)}/poll`;
const decisionsUrl =
  process.env.PROXYWAR_AGENT_RELAY_DECISIONS_URL ??
  `${betaUrl}/api/agent-relay/sessions/${encodeURIComponent(sessionID)}/decisions`;

const agent = createStarterAgent();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
  });
}

console.log(`Proxy War relay worker connected to ${betaUrl}`);
console.log("Waiting for outbound decision requests. Press Ctrl-C to stop.");

while (!stopping) {
  const poll = await relayFetch(`${pollUrl}?waitMs=${pollWaitMs}`, {
    method: "GET",
  });
  if (poll.status === "idle") {
    continue;
  }
  if (poll.status !== "request" || typeof poll.requestID !== "string") {
    throw new Error(`Unexpected relay poll response: ${JSON.stringify(poll)}`);
  }
  try {
    const decision = await agent.decide(poll.request);
    if (decision === null) {
      throw new Error("No legal actions were offered by Proxy War.");
    }
    await relayFetch(decisionsUrl, {
      method: "POST",
      body: JSON.stringify({
        requestID: poll.requestID,
        decision,
      }),
    });
    console.log(
      `Answered ${poll.requestID}: ${decision.selectedLegalActionId}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Relay decision failed for ${poll.requestID}: ${message}`);
    await relayFetch(decisionsUrl, {
      method: "POST",
      body: JSON.stringify({
        requestID: poll.requestID,
        error: message.slice(0, 500),
      }),
    }).catch(() => {});
    process.exitCode = 1;
    break;
  }
}

async function runSelfTest() {
  const agent = createStarterAgent();
  const payload = healthCheckPayload();
  const decision = await agent.decide(payload);
  if (decision === null) {
    throw new Error("Relay self-test failed: no decision was returned.");
  }
  const parsed = validateDecisionOutput(JSON.stringify(decision), payload.legalActions);
  if (!parsed.ok) {
    throw new Error(
      `Relay self-test failed: ${parsed.error ?? "invalid decision"}`,
    );
  }
  console.log("Proxy War relay worker self-test passed.");
  console.log(`selectedLegalActionId: ${parsed.action.id}`);
  console.log(`reason: ${parsed.reason}`);
}

async function relayFetch(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${sessionToken}`,
      ...(init.headers ?? {}),
    },
    redirect: "manual",
  });
  const text = await response.text();
  let json = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    throw new Error(`Relay returned non-JSON HTTP ${response.status}: ${text.slice(0, 400)}`);
  }
  if (!response.ok) {
    const fix = json?.fix ? ` Fix: ${json.fix}` : "";
    throw new Error(
      `Relay HTTP ${response.status}: ${json?.error ?? text}${fix}`,
    );
  }
  return json;
}

function healthCheckPayload() {
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
  return {
    protocolVersion: "proxywar-agent-v1",
    agent: {
      agentID: "relay-self-test",
      username: "Relay Self Test",
      profile: "opportunistic",
    },
    match: {
      gameID: "RELAY-SELF-TEST",
      phase: "active",
      turnNumber: 1,
      tick: 1,
    },
    observation: {
      profile: "opportunistic",
      phase: "active",
      summary:
        "Relay self-test: choose exactly one offered LegalAction.id. This is not a real match.",
      strategic: {
        priority: "expand",
        urgency: "medium",
        summary: "synthetic relay health check",
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

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for relay mode.`);
  }
  return value;
}

function normalizeBaseUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

function normalizeInt(value, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected integer ${min}-${max}, got ${value}`);
  }
  return parsed;
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
