/**
 * The Frontier Four team agent is the public LLM starter's executor behind
 * Softmax's LLM sidecar. These tests drive it over a fake socket against an
 * in-process stand-in for the sidecar and check the three things the port
 * changed: the wire format follows the model slug (Anthropic Messages for
 * `anthropic/*`, Chat Completions for everything else), a team observation
 * reaches the model as team framing with teammates kept out of `rivals`, and
 * a spend cutoff stops the planner for the rest of the episode while the
 * seat keeps answering legally.
 */
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PLAYER = path.resolve("coworld-adapter/frontier-four/player.mjs");

interface Captured {
  path: string;
  body: Record<string, unknown>;
}

class FakeSocket extends EventEmitter {
  readonly sent: Array<Record<string, unknown>> = [];
  constructor() {
    super();
    setTimeout(() => this.emit("open"), 0);
  }
  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }
  close() {
    this.emit("close");
  }
}

const plan = {
  focus: "attack",
  preferKinds: ["attack", "donate_troops", "hold"],
  target: "Fable",
  avoidTargets: [],
  dealPolicies: {},
  breakDealIDs: [],
  reason: "press the weaker rival",
};

/** A sidecar stand-in: records requests, answers with the plan, or 429s. */
function startSidecar(mode: "ok" | "spend_limit"): Promise<{
  server: Server;
  url: string;
  calls: Captured[];
}> {
  const calls: Captured[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = raw === "" ? {} : JSON.parse(raw);
      calls.push({ path: request.url ?? "", body });
      if (mode === "spend_limit") {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { type: "rate_limit_error", message: "spend limit" },
            softmax_error: { category: "spend_limit", retryable: false },
          }),
        );
        return;
      }
      const text = JSON.stringify(plan);
      response.writeHead(200, {
        "content-type": "application/json",
        "x-coworld-spend-usd": "0.0123",
      });
      response.end(
        JSON.stringify(
          request.url === "/v1/messages"
            ? {
                model: body.model,
                stop_reason: "end_turn",
                content: [{ type: "text", text }],
                usage: { input_tokens: 900, output_tokens: 60 },
              }
            : {
                model: body.model,
                choices: [
                  { finish_reason: "stop", message: { content: text } },
                ],
                usage: { prompt_tokens: 900, completion_tokens: 60 },
              },
        ),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, calls });
    });
  });
}

const observation = {
  phase: "active",
  gameMode: "Team",
  ownState: {
    playerID: "P_ME",
    name: "Astra",
    team: "Red",
    tileShare: 12,
    troops: 4000,
    troopRatio: 1.1,
    gold: 20000,
    borderTiles: 40,
    incomingAttacks: 0,
    units: {},
  },
  visiblePlayers: [
    {
      playerID: "P_MATE",
      name: "Astra 2",
      team: "Red",
      isTeammate: true,
      isAlive: true,
      tileShare: 9,
      relativeTroopRatio: 1.0,
      sharesBorder: true,
    },
    {
      playerID: "P_ENEMY",
      name: "Fable",
      team: "Blue",
      isTeammate: false,
      isAlive: true,
      tileShare: 15,
      relativeTroopRatio: 0.8,
      sharesBorder: true,
      isAllied: false,
      relation: "neutral",
      canAttack: true,
    },
  ],
};
const legalActions = [
  {
    id: "act_attack_fable",
    kind: "attack",
    label: "Attack Fable",
    risk: { level: "medium" },
    metadata: { targetID: "P_ENEMY", targetName: "Fable" },
  },
  {
    id: "act_donate_mate",
    kind: "donate_troops",
    label: "Donate troops to Astra 2",
    risk: { level: "low" },
    metadata: { targetID: "P_MATE", targetName: "Astra 2" },
  },
  { id: "act_hold", kind: "hold", label: "Hold", risk: { level: "low" } },
];
const legalIds = new Set(legalActions.map((action) => action.id));

async function playSteps(
  socket: FakeSocket,
  steps: number,
): Promise<Array<Record<string, unknown>>> {
  for (let step = 1; step <= steps; step++) {
    socket.emit(
      "message",
      JSON.stringify({
        type: "decision_request",
        requestID: `req_${step}`,
        protocol: { maxActionsPerDecision: 1, maxSpawnPreferences: 16 },
        request: {
          protocolVersion: "proxywar-agent-v1",
          observation,
          legalActions,
          responseContract: {},
        },
      }),
    );
    // The plan refresh is asynchronous; give it a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return socket.sent.filter((message) => message.type === "decision_response");
}

/** A fresh module instance per test: the player keeps its plan in module state. */
async function loadPlayer(endpoint: string, model: string) {
  process.env.COWORLD_PLAYER_WS_URL = "ws://fake";
  process.env.COWORLD_LLM_ENDPOINT = endpoint;
  process.env.COWORLD_LLM_MODEL = model;
  process.env.PLAN_EVERY = "1";
  const href = `${pathToFileURL(PLAYER).href}?t=${Date.now()}-${Math.random()}`;
  const module = (await import(href)) as {
    startFrontierPlayer: (options: { WebSocketCtor: unknown }) => FakeSocket;
  };
  return module.startFrontierPlayer({ WebSocketCtor: FakeSocket });
}

describe("Frontier Four player", () => {
  const sidecars: Server[] = [];
  const signalListeners = {
    SIGTERM: process.listeners("SIGTERM"),
    SIGINT: process.listeners("SIGINT"),
  };
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(async () => {
    for (const server of sidecars.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }
    // The player installs exit handlers; keep the test runner's own.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signalListeners[signal].includes(listener)) {
          process.removeListener(signal, listener);
        }
      }
    }
  });

  it("speaks Anthropic Messages to an anthropic/ slug, with the team framing", async () => {
    const sidecar = await startSidecar("ok");
    sidecars.push(sidecar.server);
    const socket = await loadPlayer(sidecar.url, "anthropic/claude-fable-5.1");
    const responses = await playSteps(socket, 2);

    expect(responses).toHaveLength(2);
    expect(
      responses.every((r) => legalIds.has(r.selectedLegalActionId as string)),
    ).toBe(true);
    expect(sidecar.calls.length).toBeGreaterThan(0);
    const call = sidecar.calls[0];
    expect(call.path).toBe("/v1/messages");
    expect(call.body.model).toBe("anthropic/claude-fable-5.1");
    expect(call.body.max_tokens).toBe(1500);
    // Stable text in one cached `system` block, the volatile GAME block in
    // the user turn.
    const systemBlocks = call.body.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(systemBlocks).toHaveLength(1);
    expect(systemBlocks[0].cache_control).toEqual({ type: "ephemeral" });
    const system = systemBlocks[0].text;
    expect(system).toContain("TEAM GAME");
    const user = (call.body.messages as Array<{ content: string }>)[0].content;
    expect(user.startsWith("GAME:")).toBe(true);
    const state = JSON.parse(user.slice("GAME:".length));
    expect(state.self.team).toBe("Red");
    expect(state.teammates.map((p: { name: string }) => p.name)).toEqual([
      "Astra 2",
    ]);
    expect(state.rivals.map((p: { name: string }) => p.name)).toEqual([
      "Fable",
    ]);
    // Once the plan landed, the model's target steers the executor.
    expect(responses[1].selectedLegalActionId).toBe("act_attack_fable");
    expect(responses[1].llmPlannerDegraded).toBe(false);
  });

  it("speaks Chat Completions to every other slug", async () => {
    const sidecar = await startSidecar("ok");
    sidecars.push(sidecar.server);
    const socket = await loadPlayer(sidecar.url, "openai/gpt-6-astra");
    const responses = await playSteps(socket, 2);

    expect(responses).toHaveLength(2);
    const call = sidecar.calls[0];
    expect(call.path).toBe("/v1/chat/completions");
    expect(call.body.model).toBe("openai/gpt-6-astra");
    expect(call.body.max_tokens).toBe(4000);
    expect(call.body.reasoning).toEqual({ effort: "low" });
    const messages = call.body.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0].content).toContain("TEAM GAME");
    expect(responses[1].selectedLegalActionId).toBe("act_attack_fable");
  });

  it("stops planning after a spend cutoff and keeps playing, loudly degraded", async () => {
    const sidecar = await startSidecar("spend_limit");
    sidecars.push(sidecar.server);
    const socket = await loadPlayer(sidecar.url, "x-ai/grok-4.7");
    const responses = await playSteps(socket, 4);

    expect(responses).toHaveLength(4);
    expect(
      responses.every((r) => legalIds.has(r.selectedLegalActionId as string)),
    ).toBe(true);
    // One request reached the sidecar; after the 429 the planner never asks again.
    expect(sidecar.calls).toHaveLength(1);
    const last = responses[3];
    expect(last.llmPlannerDegraded).toBe(true);
    expect(last.fallbackUsed).toBe(true);
    expect(String(last.reason)).toContain("spend limit");
  });
});
