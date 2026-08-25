import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = {
  calls: [] as Array<Record<string, unknown>>,
  callOptions: [] as Array<Record<string, unknown>>,
  abortedProviderCalls: 0,
  settledProviderCalls: 0,
  sent: [] as Array<Record<string, unknown>>,
  events: [] as string[],
  closeCount: 0,
  socket: null as null | FakeWebSocket,
};

class FakeWebSocket {
  private handlers = new Map<string, Array<(value?: unknown) => void>>();

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
    const response = JSON.parse(payload) as Record<string, unknown>;
    runtime.sent.push(response);
    runtime.events.push(`send:${String(response.requestID)}`);
  }

  close() {
    runtime.closeCount += 1;
    runtime.events.push("close");
  }
}

const fakeBedrock = {
  messages: {
    create: async (
      request: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      runtime.calls.push(request);
      runtime.callOptions.push(options);
      if (runtime.calls.length === 1) {
        throw new Error("first model unavailable");
      }
      if (runtime.calls.length === 2) {
        return {
          id: "msg_provider_success_1",
          model: "test.sonnet-response",
          stop_reason: "end_turn",
          content: [
            {
              type: "text",
              text: '{"focus":"attack","preferKinds":["attack"],"target":"Auri","avoidTargets":[],"dealPolicies":{},"breakDealIDs":[],"reason":"Press the border."}',
            },
          ],
          usage: { input_tokens: 1250, output_tokens: 41 },
        };
      }
      const signal = options.signal as AbortSignal;
      return new Promise((_, reject) => {
        const abort = () => {
          runtime.abortedProviderCalls += 1;
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : Object.assign(new Error("aborted"), { name: "AbortError" }),
          );
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }).finally(() => {
        runtime.settledProviderCalls += 1;
      });
    },
  },
};

const previousEnv = {
  wsUrl: process.env.COWORLD_PLAYER_WS_URL,
  model: process.env.BEDROCK_MODEL,
  planEvery: process.env.PLAN_EVERY,
  sidecar: process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME,
  refreshTimeout: process.env.PLANNER_REFRESH_TIMEOUT_MS,
};
let strictBedrockSidecarEndpoint: (value: unknown) => string | undefined;
let createPlannerProviderEvidenceGroup: () => {
  start: (model: string) => number | null;
  complete: (attempt: number | null, response: Record<string, unknown>) => void;
  finish: () => void;
  evidence: () => Record<string, unknown> | undefined;
};

function decisionRequest(requestID: string, kind = "attack") {
  const legalActions =
    kind === "spawn"
      ? [
          {
            id: "spawn:1",
            kind: "spawn",
            label: "Spawn west",
            risk: { level: "none" },
            metadata: { opportunityScore: 0.8, tile: 12 },
          },
        ]
      : [
          {
            id: "attack:auri:40",
            kind: "attack",
            label: "Attack Auri with 40% troops",
            risk: { level: "low" },
          },
          { id: "hold", kind: "hold", label: "Hold" },
        ];
  return Buffer.from(
    JSON.stringify({
      type: "decision_request",
      requestID,
      protocol: { maxSpawnPreferences: 16 },
      request: {
        observation: {
          phase: kind === "spawn" ? "spawn" : "active",
          ownState: {
            playerID: "P_ME",
            name: "Me",
            tileShare: 0.2,
            troops: 100_000,
            troopRatio: 0.5,
            gold: "1000000",
            borderTiles: 12,
            incomingAttacks: 0,
            unitCounts: {},
          },
          visiblePlayers: [],
        },
        legalActions,
      },
    }),
  );
}

describe("tester planner provider evidence runtime", () => {
  const logs: string[] = [];
  const errors: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    process.env.COWORLD_PLAYER_WS_URL = "ws://provider-runtime.invalid";
    process.env.BEDROCK_MODEL = "test.sonnet-provider";
    process.env.PLAN_EVERY = "1";
    process.env.PLANNER_REFRESH_TIMEOUT_MS = "12000";
    delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
    logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      const line = args.map(String).join(" ");
      logs.push(line);
      if (line.includes('"event":"summary"')) {
        runtime.events.push("summary");
      }
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.map(String).join(" "));
    });
    const playerModulePath =
      "../../coworld-adapter/tester-starter-llm/llm-player.mjs";
    const player = await import(playerModulePath);
    const { startLlmPlayer } = player;
    strictBedrockSidecarEndpoint = player.strictBedrockSidecarEndpoint;
    createPlannerProviderEvidenceGroup =
      player.createPlannerProviderEvidenceGroup;
    startLlmPlayer({
      bedrockClient: fakeBedrock,
      WebSocketCtor: FakeWebSocket,
    });
  });

  it("accepts only credential-free loopback HTTP sidecars", () => {
    expect(strictBedrockSidecarEndpoint("http://127.0.0.1:9100")).toBe(
      "http://127.0.0.1:9100",
    );
    expect(strictBedrockSidecarEndpoint(" http://localhost:9100 ")).toBe(
      "http://localhost:9100",
    );
    for (const invalid of [
      "https://127.0.0.1:9100",
      "http://bedrock-sidecar:9100",
      "http://127.0.0.1",
      "http://user:pass@127.0.0.1:9100",
      "http://127.0.0.1:9100/path",
      "http://127.0.0.1:9100/?query=1",
    ]) {
      expect(() => strictBedrockSidecarEndpoint(invalid)).toThrow(
        "bedrock-sidecar-endpoint-invalid",
      );
    }
  });

  it("omits overflowed aggregate tokens while retaining terminal counts", () => {
    const group = createPlannerProviderEvidenceGroup();
    const first = group.start("test.sonnet-provider");
    group.complete(first, {
      content: [{ text: "first" }],
      usage: { input_tokens: 600_000_000, output_tokens: 10 },
    });
    const second = group.start("test.sonnet-provider");
    group.complete(second, {
      content: [{ text: "second" }],
      usage: { input_tokens: 600_000_001, output_tokens: 20 },
    });
    group.finish();
    const evidence = group.evidence();
    expect(evidence).toMatchObject({
      attemptCount: 2,
      completedAttemptCount: 2,
      outputTokens: 30,
      rawOutputPresent: true,
    });
    expect(evidence).not.toHaveProperty("inputTokens");
  });

  afterAll(() => {
    vi.useRealTimers();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    for (const [key, value] of Object.entries(previousEnv)) {
      const envKey =
        key === "wsUrl"
          ? "COWORLD_PLAYER_WS_URL"
          : key === "model"
            ? "BEDROCK_MODEL"
            : key === "planEvery"
              ? "PLAN_EVERY"
              : key === "sidecar"
                ? "AWS_ENDPOINT_URL_BEDROCK_RUNTIME"
                : "PLANNER_REFRESH_TIMEOUT_MS";
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  });

  it("emits one terminal mixed-attempt aggregate, then a bounded timeout, with no tail", async () => {
    runtime.socket!.emit("message", decisionRequest("req-1"));
    await vi.waitFor(() =>
      expect(logs.some((line) => line.includes('"status":"applied"'))).toBe(
        true,
      ),
    );
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1));
    expect(runtime.sent.at(-1)).toMatchObject({
      requestID: "req-1",
      providerEvidence: {
        callKind: "planner",
        provider: "aws-bedrock",
        requestedModel: "test.sonnet-provider",
        attemptedModels: [
          "test.sonnet-provider",
          "us.anthropic.claude-sonnet-4-6",
        ],
        attemptCount: 2,
        completedAttemptCount: 1,
        failedAttemptCount: 1,
        timedOutAttemptCount: 0,
        responseModel: "test.sonnet-response",
        inputTokens: 1250,
        outputTokens: 41,
        rawOutputPresent: true,
      },
    });

    vi.useFakeTimers();
    const startedAt = Date.now();
    runtime.socket!.emit("message", decisionRequest("req-2"));
    await vi.waitFor(() => expect(runtime.calls).toHaveLength(3));
    await vi.advanceTimersByTimeAsync(12_000);
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(2));
    expect(runtime.sent.at(-1)).toMatchObject({
      requestID: "req-2",
      providerEvidence: {
        callKind: "planner",
        provider: "aws-bedrock",
        requestedModel: "us.anthropic.claude-sonnet-4-6",
        attemptedModels: ["us.anthropic.claude-sonnet-4-6"],
        attemptCount: 1,
        completedAttemptCount: 0,
        failedAttemptCount: 0,
        timedOutAttemptCount: 1,
        rawOutputPresent: false,
      },
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(12_000);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(
      (runtime.sent.at(-1)?.providerEvidence as Record<string, unknown>)
        .responseModel,
    ).toBeUndefined();
    expect(errors.some((line) => line.includes("timeout"))).toBe(true);
    expect(runtime.callOptions[2]).toMatchObject({ maxRetries: 0 });
    expect(Number(runtime.callOptions[2].timeout)).toBeGreaterThan(0);
    expect(Number(runtime.callOptions[2].timeout)).toBeLessThanOrEqual(12_000);
    expect(runtime.callOptions[2].signal).toBeInstanceOf(AbortSignal);
    expect((runtime.callOptions[2].signal as AbortSignal).aborted).toBe(true);
    expect(runtime.abortedProviderCalls).toBe(1);
    expect(runtime.settledProviderCalls).toBe(1);

    runtime.socket!.emit("message", decisionRequest("spawn-1", "spawn"));
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(3));
    expect(runtime.sent.at(-1)).toMatchObject({
      requestID: "spawn-1",
      selectedLegalActionId: "spawn:1",
    });
    expect(runtime.sent.at(-1)).not.toHaveProperty("providerEvidence");

    runtime.socket!.emit("message", decisionRequest("overlap-1"));
    runtime.socket!.emit("message", decisionRequest("overlap-2"));
    runtime.socket!.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "final" })),
    );
    runtime.socket!.emit("message", decisionRequest("after-final"));

    await vi.waitFor(() => expect(runtime.calls).toHaveLength(4));
    expect(runtime.sent).toHaveLength(3);
    expect(runtime.closeCount).toBe(0);

    await vi.advanceTimersByTimeAsync(12_000);
    await vi.waitFor(() => {
      expect(runtime.sent).toHaveLength(4);
      expect(runtime.calls).toHaveLength(5);
    });
    expect(runtime.sent[3]).toMatchObject({
      requestID: "overlap-1",
      providerEvidence: {
        callKind: "planner",
        attemptedModels: ["us.anthropic.claude-sonnet-4-6"],
        attemptCount: 1,
        completedAttemptCount: 0,
        failedAttemptCount: 0,
        timedOutAttemptCount: 1,
        rawOutputPresent: false,
      },
    });
    expect(runtime.closeCount).toBe(0);

    await vi.advanceTimersByTimeAsync(12_000);
    await vi.waitFor(() => expect(runtime.closeCount).toBe(1));
    expect(
      runtime.sent.map((response) => response.requestID).slice(-2),
    ).toEqual(["overlap-1", "overlap-2"]);
    expect(runtime.sent[4]).toMatchObject({
      requestID: "overlap-2",
      providerEvidence: {
        callKind: "planner",
        attemptedModels: ["us.anthropic.claude-sonnet-4-6"],
        attemptCount: 1,
        completedAttemptCount: 0,
        failedAttemptCount: 0,
        timedOutAttemptCount: 1,
        rawOutputPresent: false,
      },
    });
    expect(runtime.sent[3].providerEvidence).not.toBe(
      runtime.sent[4].providerEvidence,
    );
    expect(runtime.calls).toHaveLength(5);
    expect(runtime.sent).toHaveLength(5);
    expect(runtime.abortedProviderCalls).toBe(3);
    expect(runtime.settledProviderCalls).toBe(3);
    expect(runtime.events.slice(-4)).toEqual([
      "send:overlap-1",
      "send:overlap-2",
      "summary",
      "close",
    ]);
    expect(logs.some((line) => line.includes('"reason":"final_message"'))).toBe(
      true,
    );
    expect(logs.some((line) => line.includes('"usageComplete":true'))).toBe(
      true,
    );
  });
});
