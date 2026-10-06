/**
 * Shared harness for the Frontier player tests: a fake match socket, a fresh
 * player module per test (the player keeps its plan in module state), an
 * in-process sidecar stand-in, a stdout capture for the PROXYWAR_* lines, and
 * a five-nation observation built from Season 1 ids.
 *
 * The player and rival ids below are real: they are the twelve seats of
 * Season 1 game ereq_0033fafb (East Asia), reused here as the five Season 2
 * nations.
 */
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";

export const PLAYER = path.resolve("coworld-adapter/frontier-four/player.mjs");
export const MOCK_SIDECAR = path.resolve(
  "coworld-adapter/frontier-four/mock-llm-server.mjs",
);

export const IDS = {
  me: "28k1hctz", // Astra 1
  fable: "xbt2wt14", // Fable 1
  gemini: "c4o8gv6v", // Gemini 1 (allied)
  grok: "r5o3pta1", // Grok 1
  opus: "x262ww19", // Opus 1
};

export type Json = Record<string, unknown>;

export class FakeSocket extends EventEmitter {
  readonly sent: Json[] = [];
  constructor() {
    super();
    setTimeout(() => this.emit("open"), 0);
  }
  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }
  // Never emit "close": the player exits the process on close.
  close() {}
}

export interface Captured {
  path: string;
  body: Json;
  at: number;
}

export interface StubOptions {
  /** The plan text for call `n` (1-based); a string is sent verbatim. */
  plan?: (call: number, body: Json) => Json | string;
  latencyMs?: (call: number) => number;
  /** Answer 400 routing_parameters to any request that carries reasoning. */
  rejectReasoning?: boolean;
  /** Answer every request 429 spend_limit. */
  spendLimit?: boolean;
  /**
   * An error answer for request `n` (1-based, counting every request), or
   * null to answer normally.
   */
  refuse?: (
    request: number,
    body: Json,
  ) => { status: number; category: string } | null;
}

/** A sidecar stand-in that records each request body and answers a plan. */
export function startStubSidecar(options: StubOptions = {}): Promise<{
  server: Server;
  url: string;
  calls: Captured[];
}> {
  const calls: Captured[] = [];
  let answered = 0;
  let requests = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = raw === "" ? {} : (JSON.parse(raw) as Json);
      calls.push({ path: request.url ?? "", body, at: Date.now() });
      const json = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (options.spendLimit) {
        json(429, {
          error: { type: "rate_limit_error", message: "spend limit" },
          softmax_error: { category: "spend_limit", retryable: false },
        });
        return;
      }
      requests += 1;
      const refusal = options.refuse?.(requests, body);
      if (refusal) {
        json(refusal.status, {
          error: { type: "invalid_request_error", message: "refused" },
          softmax_error: { category: refusal.category, retryable: false },
        });
        return;
      }
      if (options.rejectReasoning && body.reasoning !== undefined) {
        json(400, {
          error: {
            type: "invalid_request_error",
            code: "routing_parameters",
            message: "No provider supports this model with reasoning.",
          },
          softmax_error: { category: "routing_parameters", retryable: false },
        });
        return;
      }
      answered += 1;
      const call = answered;
      const plan = options.plan?.(call, body) ?? defaultPlan;
      const text = typeof plan === "string" ? plan : JSON.stringify(plan);
      setTimeout(
        () =>
          json(200, {
            model: body.model,
            choices: [{ finish_reason: "stop", message: { content: text } }],
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 300,
              completion_tokens_details: { reasoning_tokens: 90 },
              prompt_tokens_details: { cached_tokens: 400 },
            },
          }),
        options.latencyMs?.(call) ?? 5,
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

export const defaultPlan = {
  focus: "attack",
  target: "Grok 1",
  avoidTargets: [],
  build: ["City", "Port"],
  allies: [],
  betray: null,
  nuke: null,
  dealPolicies: {},
  breakDealIDs: [],
  say: [],
  dispatch: "Astra marches on Grok.",
  reason: "Grok is weaker",
};

const PLAYER_ENV = [
  "COWORLD_PLAYER_WS_URL",
  "COWORLD_LLM_ENDPOINT",
  "COWORLD_LLM_MODEL",
  "OPENROUTER_API_KEY",
  "PLAN_EVERY",
  "MAX_PLANS",
  "PLAN_TIMEOUT_MS",
  "PLAN_MAX_OUTPUT_TOKENS",
  "PLAN_REASONING_EFFORT",
];

/** A fresh player module wired to a fake socket and the given env. */
export async function loadPlayer(
  env: Record<string, string | undefined>,
): Promise<FakeSocket> {
  for (const key of PLAYER_ENV) delete process.env[key];
  process.env.COWORLD_PLAYER_WS_URL = "ws://fake";
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  const href = `${pathToFileURL(PLAYER).href}?t=${Date.now()}-${Math.random()}`;
  const module = (await import(href)) as {
    startFrontierPlayer: (options: { WebSocketCtor: unknown }) => FakeSocket;
  };
  return module.startFrontierPlayer({ WebSocketCtor: FakeSocket });
}

let requestCounter = 0;

/** Sends one decision request and waits for the player's answer to it. */
export async function decide(
  socket: FakeSocket,
  observation: Json,
  legalActions: Json[],
  protocol: Json = { maxActionsPerDecision: 5, maxSpawnPreferences: 16 },
  timeoutMs = 5000,
): Promise<Json> {
  const requestID = `req_${++requestCounter}`;
  socket.emit(
    "message",
    JSON.stringify({
      type: "decision_request",
      requestID,
      slot: 0,
      protocol,
      request: {
        protocolVersion: "proxywar-agent-v1",
        observation,
        legalActions,
        responseContract: {},
      },
    }),
  );
  const started = Date.now();
  for (;;) {
    const response = socket.sent.find(
      (message) =>
        message.type === "decision_response" && message.requestID === requestID,
    );
    if (response) return response;
    if (Date.now() - started > timeoutMs)
      throw new Error(`no decision_response for ${requestID}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Captures console.log; `tagged(tag)` parses that tag's JSON lines. */
export function captureStdout() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    lines,
    tagged(tag: string): Json[] {
      return lines
        .filter((line) => line.startsWith(`${tag} `))
        .map((line) => JSON.parse(line.slice(tag.length + 1)) as Json);
    },
    restore() {
      spy.mockRestore();
      vi.restoreAllMocks();
    },
  };
}

/** The GAME block the player sent with a captured request. */
export function gameOf(call: Captured): Json {
  const messages = call.body.messages as Array<{
    role: string;
    content: string;
  }>;
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  return JSON.parse(user.slice(user.indexOf("GAME:") + 5)) as Json;
}

/** Removes the exit handlers each player module installs. */
export function signalListenerGuard() {
  const before = {
    SIGTERM: process.listeners("SIGTERM"),
    SIGINT: process.listeners("SIGINT"),
  };
  return () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) {
          process.removeListener(signal, listener);
        }
      }
    }
  };
}

function rival(
  name: string,
  playerID: string,
  extra: Json = {},
): Record<string, unknown> {
  return {
    playerID,
    name,
    isAlive: true,
    isTeammate: false,
    tileShare: 0.12,
    relativeTroopRatio: 1,
    sharesBorder: true,
    isAllied: false,
    isFriendly: false,
    relation: "neutral",
    canAttack: true,
    gold: "300000",
    ...extra,
  };
}

/** Astra 1's view of a five-nation battle, with the spatial block on. */
export function ffaObservation(overrides: Json = {}): Json {
  return {
    phase: "active",
    gameMode: "Team",
    turnNumber: 1100,
    ownState: {
      playerID: IDS.me,
      name: "Astra 1",
      tileShare: 0.14,
      troops: 52000,
      troopRatio: 0.8,
      gold: "1600000",
      incomingAttacks: 0,
      isTraitor: false,
      unitCounts: { City: 2, Port: 1 },
    },
    visiblePlayers: [
      rival("Fable 1", IDS.fable, {
        relativeTroopRatio: 1.3,
        hasIncomingAllianceRequest: true,
        bearing: "east",
        distanceClass: "adjacent",
        borderWithYou: {
          tiles: 40,
          shareOfYourBorder: 35,
          terrain: "land",
          defensePostsCovering: 1,
          underAttackHere: false,
        },
      }),
      rival("Gemini 1", IDS.gemini, {
        isAllied: true,
        isFriendly: true,
        relation: "friendly",
        canAttack: false,
        relativeTroopRatio: 0.9,
        underSiege: true,
      }),
      rival("Grok 1", IDS.grok, {
        relativeTroopRatio: 2.1,
        gold: "2000000",
      }),
      rival("Opus 1", IDS.opus, {
        sharesBorder: false,
        canAttack: false,
        relativeTroopRatio: 0.7,
        tileShare: 0.2,
      }),
    ],
    spatial: {
      schemaVersion: 5,
      visibilityModel: "global-lockstep-public-map-v1",
      ownShape: {
        quadrant: "west",
        compactness: "compact",
        regionAnalysis: "complete",
        centroidBasis: "largest_region_border",
        coastShare: 22,
        centroid: { xPct: 20, yPct: 50 },
      },
      positionedAssets: {},
    },
    combat: { incomingAttackPlayerIDs: [] },
    nonCombat: { inboundMessages: [] },
    notes: ["Spatial: Fable 1 holds most of your eastern front."],
    ...overrides,
  };
}

function act(
  id: string,
  kind: string,
  metadata: Json = {},
  risk = "low",
): Record<string, unknown> {
  return { id, kind, label: id, risk: { level: risk }, metadata };
}

/** The offered menu, in the server's own id formats and order. */
export function ffaActions(): Json[] {
  const attacks = [IDS.fable, IDS.grok].flatMap((targetID) =>
    [10, 25, 40].map((pct) =>
      act(`attack:${targetID}:${pct}`, "attack", {
        targetID,
        targetName: targetID === IDS.fable ? "Fable 1" : "Grok 1",
        troopPercentage: pct / 100,
        troopPercent: pct,
      }),
    ),
  );
  return [
    ...attacks,
    ...[10, 20, 35].map((pct) =>
      act(`expand:terra-nullius:${pct}`, "attack", {
        targetID: null,
        targetName: "Terra Nullius",
        troopPercentage: pct / 100,
        troopPercent: pct,
        expansion: true,
      }),
    ),
    act("boat:482272:16", "boat", {
      targetID: IDS.opus,
      targetName: "Opus 1",
      troopPercentage: 0.16,
      navalInvasion: true,
    }),
    // The menu lists a Defense Post first, as the Season 1 executor saw it.
    act("build:Defense Post:111", "build", {
      unit: "Defense Post",
      cost: "50000",
      defensiveValue: 0.4,
      hostileBorderDistance: 3,
      nearbyEnemyCount: 1,
    }),
    act("build:City:222", "build", {
      unit: "City",
      cost: "250000",
      economicValue: 0.7,
      hostileBorderDistance: 20,
    }),
    act("build:Port:482273", "build", {
      unit: "Port",
      cost: "250000",
      economicValue: 0.5,
    }),
    act("build:Missile Silo:333", "build", {
      unit: "Missile Silo",
      cost: "1000000",
      hostileBorderDistance: 30,
    }),
    act("build:SAM Launcher:444", "build", {
      unit: "SAM Launcher",
      cost: "1500000",
      defensiveValue: 0.6,
    }),
    act("upgrade:City:17", "upgrade_structure", {
      unit: "City",
      unitID: 17,
      cost: "500000",
    }),
    act(`alliance:${IDS.fable}`, "alliance_request", {
      recipientID: IDS.fable,
      recipientName: "Fable 1",
    }),
    act(
      `break_alliance:${IDS.gemini}`,
      "break_alliance",
      { targetID: IDS.gemini, targetName: "Gemini 1", action: "break" },
      "high",
    ),
    act(`donate_troops:${IDS.grok}`, "donate_troops", {
      recipientID: IDS.grok,
      recipientName: "Grok 1",
      troops: 5000,
    }),
    act(`donate_troops:${IDS.gemini}`, "donate_troops", {
      recipientID: IDS.gemini,
      recipientName: "Gemini 1",
      troops: 5000,
    }),
    act(`quick_chat:${IDS.grok}:help.troops`, "quick_chat", {
      recipientID: IDS.grok,
    }),
    act(`emoji:${IDS.grok}:25`, "emoji", { recipientID: IDS.grok }),
    ...[
      [IDS.fable, "Fable 1"],
      [IDS.gemini, "Gemini 1"],
      [IDS.grok, "Grok 1"],
      [IDS.opus, "Opus 1"],
    ].map(([recipientID, recipientName]) =>
      act(`message:${recipientID}`, "message", { recipientID, recipientName }),
    ),
    act("hold", "hold", { reason: "no game no-op intent exists" }, "none"),
  ];
}

/** A nuke offered on `targetID` (kind "nuke", as LegalActionBuilder emits). */
export function nukeAction(targetID: string, targetName: string): Json {
  return act(
    `build:Atom Bomb:555`,
    "nuke",
    { unit: "Atom Bomb", targetID, targetName, cost: "750000" },
    "high",
  );
}
