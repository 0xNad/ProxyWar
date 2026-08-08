import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = {
  calls: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
  socket: null as null | {
    emit: (event: string, value?: unknown) => void;
    closed: boolean;
  },
  resolveSecond: null as null | ((value: unknown) => void),
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
    // Do not emit `close`: the real module deliberately exits the process
    // there, which belongs to the container lifecycle rather than this test.
    this.closed = true;
  }
}

const fakeBedrock = {
  messages: {
    create: async (request: Record<string, unknown>) => {
      runtime.calls.push(request);
      if (runtime.calls.length === 2) {
        return new Promise((resolve) => {
          runtime.resolveSecond = resolve;
        });
      }
      return {
        model: "test.sonnet-full",
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: '{"focus":"attack","preferKinds":["attack"],"target":"Auri","avoidTargets":[],"deal":null,"reason":"Press the exposed border."}',
          },
        ],
        usage: {
          input_tokens: 3525,
          output_tokens: 42,
          cache_creation_input_tokens: 1024,
          cache_read_input_tokens: 512,
        },
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
          {
            id: "hold",
            kind: "hold",
            label: "Hold",
            risk: { level: "none" },
          },
        ],
      },
    }),
  );
}

describe("tester-starter-llm hardened runtime arm", () => {
  const logLines: string[] = [];
  const errorLines: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    runtime.calls.length = 0;
    runtime.sent.length = 0;
    runtime.socket = null;
    runtime.resolveSecond = null;
    process.env.COWORLD_PLAYER_WS_URL = "ws://runtime-test.invalid";
    process.env.BEDROCK_MODEL = "test.sonnet-full";
    process.env.PROXYWAR_PROMPT_HARDENING = "1";
    process.env.PROXYWAR_PROMPT_CACHE = "0";
    process.env.PLAN_EVERY = "3";
    logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logLines.push(args.map(String).join(" "));
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errorLines.push(args.map(String).join(" "));
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
    vi.useRealTimers();
    logSpy.mockRestore();
    errorSpy.mockRestore();
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

  it("keeps the full menu, applies a prefixed JSON plan, and emits exact safe usage", async () => {
    expect(runtime.socket).not.toBeNull();
    runtime.socket!.emit("message", decisionRequest("req-1"));

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

    const call = runtime.calls[0] as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.model).toBe("test.sonnet-full");
    expect(call.max_tokens).toBe(500);
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].role).toBe("user");
    expect(call.messages[0].content).toContain('"legalActions"');
    expect(call.messages[0].content).toContain("Attack Auri with 40% troops");
    expect(call.messages[0].content).not.toContain('"legalKinds"');

    // The first response is immediate bootstrap while planning is in flight;
    // the next decision must use the completed full-menu plan.
    runtime.socket!.emit("message", decisionRequest("req-2"));
    expect(runtime.sent.at(-1)).toMatchObject({
      type: "decision_response",
      requestID: "req-2",
      selectedLegalActionId: "attack:auri:40",
      fallbackUsed: false,
      llmPlannerDegraded: false,
    });
    expect(String(runtime.sent.at(-1)?.reason)).toContain(
      "PLAN(attack -> Auri)",
    );

    // The next scheduled refresh remains in flight when the match final arrives.
    // The summary must say that its token totals are incomplete rather than
    // silently undercounting the request.
    vi.useFakeTimers();
    runtime.socket!.emit("message", decisionRequest("req-3"));
    runtime.socket!.emit("message", decisionRequest("req-4"));
    expect(runtime.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(errorLines).toContain("plan refresh failed: timeout");

    runtime.socket!.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "final" })),
    );
    expect(runtime.socket!.closed).toBe(true);

    const usageRecords = logLines
      .filter((line) => line.startsWith("PROXYWAR_LLM_USAGE "))
      .map(
        (line) =>
          JSON.parse(line.slice("PROXYWAR_LLM_USAGE ".length)) as Record<
            string,
            unknown
          >,
      );
    expect(usageRecords).toContainEqual(
      expect.objectContaining({
        event: "response",
        promptVariant: "full-hardened-telemetry-v2",
        planEvery: 3,
        promptCache: false,
        model: "test.sonnet-full",
        responseModel: "test.sonnet-full",
        stopReason: "end_turn",
        inputTokens: 3525,
        outputTokens: 42,
        cacheCreationInputTokens: 1024,
        cacheReadInputTokens: 512,
      }),
    );
    expect(usageRecords).toContainEqual(
      expect.objectContaining({
        event: "summary",
        attempts: 2,
        responses: 1,
        errors: 0,
        responsesWithUsage: 1,
        inFlightRequests: 1,
        usageComplete: false,
        usageAvailable: true,
        inputTokens: 3525,
        outputTokens: 42,
        cacheCreationInputTokens: 1024,
        cacheReadInputTokens: 512,
      }),
    );
    for (const record of usageRecords) {
      expect(record).not.toHaveProperty("prompt");
      expect(record).not.toHaveProperty("state");
      expect(record).not.toHaveProperty("text");
      expect(record).not.toHaveProperty("rivals");
    }

    runtime.resolveSecond?.({ content: [], usage: undefined });
    await Promise.resolve();
    vi.useRealTimers();
  });
});
