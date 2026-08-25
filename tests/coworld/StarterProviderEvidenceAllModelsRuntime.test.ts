import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = {
  calls: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
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
    runtime.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {}
}

const fakeBedrock = {
  messages: {
    create: async (request: Record<string, unknown>) => {
      runtime.calls.push(request);
      throw new Error("model unavailable");
    },
  },
};

const previousEnv = {
  wsUrl: process.env.COWORLD_PLAYER_WS_URL,
  model: process.env.BEDROCK_MODEL,
  planEvery: process.env.PLAN_EVERY,
};

function request(requestID: string, spawn = false) {
  return Buffer.from(
    JSON.stringify({
      type: "decision_request",
      requestID,
      protocol: { maxSpawnPreferences: 16 },
      request: {
        observation: {
          phase: spawn ? "spawn" : "active",
          ownState: { playerID: "P_ME", unitCounts: {} },
          visiblePlayers: [],
        },
        legalActions: spawn
          ? [
              {
                id: "spawn:one",
                kind: "spawn",
                label: "Spawn one",
                risk: { level: "none" },
                metadata: { opportunityScore: 0.8, tile: 1 },
              },
            ]
          : [
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

describe("tester planner all-model provider evidence", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    process.env.COWORLD_PLAYER_WS_URL = "ws://all-models.invalid";
    process.env.BEDROCK_MODEL = "test.first-model";
    process.env.PLAN_EVERY = "1";
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const playerModulePath =
      "../../coworld-adapter/tester-starter-llm/llm-player.mjs";
    const { startLlmPlayer } = await import(playerModulePath);
    startLlmPlayer({ bedrockClient: fakeBedrock, WebSocketCtor: FakeWebSocket });
  });

  afterAll(() => {
    errorSpy.mockRestore();
    if (previousEnv.wsUrl === undefined)
      delete process.env.COWORLD_PLAYER_WS_URL;
    else process.env.COWORLD_PLAYER_WS_URL = previousEnv.wsUrl;
    if (previousEnv.model === undefined) delete process.env.BEDROCK_MODEL;
    else process.env.BEDROCK_MODEL = previousEnv.model;
    if (previousEnv.planEvery === undefined) delete process.env.PLAN_EVERY;
    else process.env.PLAN_EVERY = previousEnv.planEvery;
  });

  it("returns one bounded terminal group and never leaks a tail onto no-call spawn", async () => {
    runtime.socket!.emit("message", request("all-fail-1"));
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1));
    const response = runtime.sent[0];
    expect(runtime.calls).toHaveLength(5);
    expect(response).toMatchObject({
      requestID: "all-fail-1",
      fallbackUsed: true,
      llmPlannerDegraded: true,
      providerEvidence: {
        callKind: "planner",
        provider: "aws-bedrock",
        requestedModel: "test.first-model",
        attemptCount: 5,
        completedAttemptCount: 0,
        failedAttemptCount: 5,
        timedOutAttemptCount: 0,
        rawOutputPresent: false,
      },
    });
    expect(
      (response.providerEvidence as { attemptedModels: string[] })
        .attemptedModels,
    ).toHaveLength(5);

    runtime.socket!.emit("message", request("spawn-after-fail", true));
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(2));
    expect(runtime.sent[1]).not.toHaveProperty("providerEvidence");
    expect(runtime.calls).toHaveLength(5);
  });
});
