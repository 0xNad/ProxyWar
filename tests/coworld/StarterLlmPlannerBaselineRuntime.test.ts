import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = {
  calls: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
  socket: null as null | FakeWebSocket,
};

class FakeWebSocket {
  private handlers = new Map<string, Array<(value?: unknown) => void>>();
  closed = false;

  constructor() {
    runtime.socket = this;
  }

  on(event: string, handler: (value?: unknown) => void) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  emit(event: string, value?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }

  send(payload: string) {
    runtime.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {
    this.closed = true;
  }
}

const fakeBedrock = {
  messages: {
    create: async (request: Record<string, unknown>) => {
      runtime.calls.push(request);
      return {
        model: "test.sonnet-full",
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: '{"focus":"attack","preferKinds":["attack"],"target":"Auri","avoidTargets":[],"dealPolicies":[{"playerID":"P_A","acceptTemplates":["non_aggression_pact"],"proposeTemplates":[]}],"breakDealIDs":[],"reason":"Press the border."}',
          },
        ],
        usage: { input_tokens: 3500, output_tokens: 40 },
      };
    },
  },
};

const previousEnv = {
  wsUrl: process.env.COWORLD_PLAYER_WS_URL,
  model: process.env.BEDROCK_MODEL,
  hardening: process.env.PROXYWAR_PROMPT_HARDENING,
  promptCache: process.env.PROXYWAR_PROMPT_CACHE,
  planEvery: process.env.PLAN_EVERY,
};

function decisionRequest(requestID: string) {
  return Buffer.from(
    JSON.stringify({
      type: "decision_request",
      requestID,
      request: {
        observation: {
          phase: "active",
          ownState: {
            name: "Me",
            tileShare: 0.2,
            troops: 100_000,
            troopRatio: 0.5,
            gold: "1000000",
            borderTiles: 12,
            incomingAttacks: 0,
            units: {},
          },
          visiblePlayers: [
            {
              name: "Auri",
              isAlive: true,
              tileShare: 0.1,
              relativeTroopRatio: 2,
              sharesBorder: true,
              isAllied: false,
              relation: 0,
              canAttack: true,
            },
          ],
        },
        legalActions: [
          {
            id: "attack:auri:40",
            kind: "attack",
            label: "Attack Auri with 40% troops",
            risk: { level: "low" },
          },
          { id: "hold", kind: "hold", label: "Hold" },
        ],
      },
    }),
  );
}

describe("tester-starter-llm baseline runtime arm", () => {
  const logLines: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    process.env.COWORLD_PLAYER_WS_URL = "ws://baseline-runtime-test.invalid";
    process.env.BEDROCK_MODEL = "test.sonnet-full";
    process.env.PROXYWAR_PROMPT_HARDENING = "0";
    process.env.PROXYWAR_PROMPT_CACHE = "0";
    process.env.PLAN_EVERY = "3";
    logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logLines.push(args.map(String).join(" "));
    });
    const starterModulePath =
      "../../coworld-adapter/tester-starter-llm/llm-player.mjs";
    const { startLlmPlayer } = await import(starterModulePath);
    startLlmPlayer({
      bedrockClient: fakeBedrock,
      WebSocketCtor: FakeWebSocket,
    });
  });

  afterAll(() => {
    logSpy.mockRestore();
    if (previousEnv.wsUrl === undefined)
      delete process.env.COWORLD_PLAYER_WS_URL;
    else process.env.COWORLD_PLAYER_WS_URL = previousEnv.wsUrl;
    if (previousEnv.model === undefined) delete process.env.BEDROCK_MODEL;
    else process.env.BEDROCK_MODEL = previousEnv.model;
    if (previousEnv.hardening === undefined)
      delete process.env.PROXYWAR_PROMPT_HARDENING;
    else process.env.PROXYWAR_PROMPT_HARDENING = previousEnv.hardening;
    if (previousEnv.promptCache === undefined)
      delete process.env.PROXYWAR_PROMPT_CACHE;
    else process.env.PROXYWAR_PROMPT_CACHE = previousEnv.promptCache;
    if (previousEnv.planEvery === undefined) delete process.env.PLAN_EVERY;
    else process.env.PLAN_EVERY = previousEnv.planEvery;
  });

  it("preserves the full current request behavior and applies an offered action", async () => {
    runtime.socket!.emit("message", decisionRequest("baseline-1"));
    await vi.waitFor(() => expect(runtime.calls).toHaveLength(1));
    await vi.waitFor(() =>
      expect(
        logLines.some(
          (line) =>
            line.includes("PROXYWAR_LLM_USAGE") &&
            line.includes('"status":"applied"'),
        ),
      ).toBe(true),
    );

    expect(runtime.calls[0]).toMatchObject({
      model: "test.sonnet-full",
      max_tokens: 300,
      messages: [
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining('"legalActions"'),
        }),
      ],
    });
    expect(
      (runtime.calls[0].messages as Array<Record<string, unknown>>).length,
    ).toBe(1);

    runtime.socket!.emit("message", decisionRequest("baseline-2"));
    expect(runtime.sent.at(-1)).toMatchObject({
      requestID: "baseline-2",
      selectedLegalActionId: "attack:auri:40",
      fallbackUsed: false,
      llmPlannerDegraded: false,
    });

    runtime.socket!.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "final" })),
    );
    expect(runtime.socket!.closed).toBe(true);
    expect(
      logLines.some(
        (line) =>
          line.includes('"promptVariant":"full-baseline-telemetry-v1"') &&
          line.includes('"spatialSchemaVersion":0') &&
          line.includes('"spatialMinimap":false') &&
          line.includes('"usageComplete":true'),
      ),
    ).toBe(true);
  });
});
